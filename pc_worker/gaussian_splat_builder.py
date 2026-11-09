#!/usr/bin/env python3
"""
Gaussian Splat (.ply / .compressed.ply / .splat) Builder for GatheringScans.
Supports:
  1. PlayCanvas / SuperSplat / splat-transform compressed .ply (`element chunk` + `packed_position`, etc.)
  2. Standard 3D Gaussian Splatting binary_little_endian / ASCII .ply (`x, y, z, f_dc_0..2, opacity, scale_0..2, rot_0..3`)
  3. Standard .splat binary files (32 bytes per splat)
  4. Optional `offset.xyz` georeferencing (TWD97 EPSG:3826 + TWVD2001 or WGS84 UTM).
     When `offset.xyz` is absent, the scan is marked as a non-map local-origin model (`LOCAL_ORIGIN`, `group_type: "library"`).
Outputs inside `<folder_path>/tileset/`:
  - `tileset.json` & `preview_tileset.json` (with `extras.gaussian_splat_uri = "tiles/splats.gsplat"`)
  - `tiles/splats.gsplat` (compact 32-byte/splat importance-sorted binary stream for WebGL Gaussian Splat renderer)
  - `tiles/root.glb` & `preview_low/tiles/root.glb` (oriented surfel mesh for raycasting, measurements, comments, and GLB export)
  - `<folder_path>/thumbnail.png` (high-resolution rendered Gaussian Splat thumbnail)
"""

import json
import math
import os
import struct
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from PIL import Image

SH_C0 = 0.28209479177387814


def is_gaussian_splat_file(file_path: str) -> bool:
    """Returns True if `file_path` is a .splat file or a .ply file containing Gaussian Splat or point cloud data."""
    if not file_path or not os.path.isfile(file_path):
        return False
    low = file_path.lower()
    if low.endswith(".splat"):
        return os.path.getsize(file_path) >= 32
    if not low.endswith(".ply"):
        return False
    try:
        if os.path.getsize(file_path) < 128:
            return False
        with open(file_path, "rb") as f:
            head = f.read(4096)
        if not head.startswith(b"ply"):
            return False
        # Accept compressed splat PLYs, standard 3DGS PLYs, or vertex-colored point cloud PLYs without faces
        has_packed = b"packed_position" in head and b"element chunk" in head
        has_3dgs = (b"f_dc_0" in head or b"scale_0" in head or b"rot_0" in head)
        has_faces = b"element face " in head and not ( b"element face 0" in head )
        if has_packed or has_3dgs or not has_faces:
            return True
    except Exception:
        pass
    return False


def find_gaussian_splat_source_in_folder(folder_path: str) -> str:
    """Finds the primary Gaussian Splat .ply or .splat file inside `folder_path`."""
    if not folder_path or not os.path.isdir(folder_path):
        return ""
    skip_dirs = {"tileset", "tiles", "preview_low", "inputs", "images", "opf_files", "logs", "temp", "configs", "exports"}
    candidates: List[Tuple[int, int, str]] = []
    for root, dirs, files in os.walk(folder_path):
        dirs[:] = [d for d in dirs if d.lower() not in skip_dirs]
        rel_depth = os.path.relpath(root, folder_path).count(os.sep)
        if rel_depth > 2:
            continue
        for fn in files:
            low = fn.lower()
            if low.endswith((".ply", ".splat")):
                fp = os.path.join(root, fn)
                if is_gaussian_splat_file(fp):
                    prio = 0 if low.endswith(".compressed.ply") else (1 if low.endswith(".ply") else 2)
                    try:
                        sz = os.path.getsize(fp)
                    except OSError:
                        sz = 0
                    candidates.append((prio, -sz, fp))
    if not candidates:
        return ""
    candidates.sort()
    return candidates[0][2]


def _parse_ply_header(raw_bytes: bytes) -> Tuple[int, str, List[Dict[str, Any]]]:
    """Parses a PLY header and returns `(body_offset, fmt, elements)`."""
    idx_lf = raw_bytes.find(b"end_header\n")
    idx_crlf = raw_bytes.find(b"end_header\r\n")
    if idx_crlf != -1 and (idx_lf == -1 or idx_crlf < idx_lf):
        header_text = raw_bytes[:idx_crlf].decode("ascii", errors="ignore")
        body_offset = idx_crlf + len(b"end_header\r\n")
    elif idx_lf != -1:
        header_text = raw_bytes[:idx_lf].decode("ascii", errors="ignore")
        body_offset = idx_lf + len(b"end_header\n")
    else:
        raise ValueError("Invalid PLY file: missing end_header")

    fmt = "binary_little_endian"
    elements: List[Dict[str, Any]] = []
    cur_el: Optional[Dict[str, Any]] = None
    for line in header_text.splitlines():
        parts = line.strip().split()
        if not parts:
            continue
        if parts[0] == "format" and len(parts) >= 2:
            fmt = parts[1].lower()
        elif parts[0] == "element" and len(parts) >= 3:
            cur_el = {"name": parts[1], "count": int(parts[2]), "properties": []}
            elements.append(cur_el)
        elif parts[0] == "property" and len(parts) >= 3 and cur_el is not None:
            cur_el["properties"].append((parts[1].lower(), parts[-1]))
    return body_offset, fmt, elements


_PLY_NP_DTYPES = {
    "float": "<f4",
    "float32": "<f4",
    "double": "<f8",
    "float64": "<f8",
    "uchar": "<u1",
    "uint8": "<u1",
    "char": "<i1",
    "int8": "<i1",
    "ushort": "<u2",
    "uint16": "<u2",
    "short": "<i2",
    "int16": "<i2",
    "uint": "<u4",
    "uint32": "<u4",
    "int": "<i4",
    "int32": "<i4",
}


def load_gaussian_splats_raw(file_path: str) -> Dict[str, np.ndarray]:
    """
    Loads a Gaussian Splat (.compressed.ply, standard 3DGS .ply, or .splat) into standardized float32 arrays:
      - `xyz`: (N, 3) float32
      - `scale`: (N, 3) float32 (linear world scale, already exp-activated)
      - `rgba`: (N, 4) float32 in [0.0, 1.0]
      - `quat`: (N, 4) float32 unit quaternions (qw, qx, qy, qz)
    """
    with open(file_path, "rb") as f:
        raw = f.read()

    if file_path.lower().endswith(".splat"):
        n_splats = len(raw) // 32
        dt = np.dtype(
            [
                ("xyz", "<f4", (3,)),
                ("scale", "<f4", (3,)),
                ("rgba", "<u1", (4,)),
                ("rot", "<u1", (4,)),
            ]
        )
        arr = np.frombuffer(raw, dtype=dt, count=n_splats)
        xyz = arr["xyz"].astype(np.float32)
        scale = np.maximum(arr["scale"].astype(np.float32), 1e-5)
        rgba = arr["rgba"].astype(np.float32) / 255.0
        quat = (arr["rot"].astype(np.float32) - 128.0) / 128.0
        qnorm = np.linalg.norm(quat, axis=1, keepdims=True)
        quat = np.where(qnorm > 1e-6, quat / np.maximum(qnorm, 1e-6), np.array([1.0, 0.0, 0.0, 0.0], dtype=np.float32))
        return {"xyz": xyz, "scale": scale, "rgba": rgba, "quat": quat}

    body_offset, fmt, elements = _parse_ply_header(raw)
    el_map = {el["name"]: el for el in elements}

    # Case 1: PlayCanvas / SuperSplat / splat-transform compressed .ply (`chunk` + `vertex`)
    if "chunk" in el_map and "vertex" in el_map:
        chunk_el = el_map["chunk"]
        vert_el = el_map["vertex"]
        n_chunks = int(chunk_el["count"])
        n_verts = int(vert_el["count"])
        chunk_props = [p[1] for p in chunk_el["properties"]]
        n_cprops = len(chunk_props)
        chunks = np.frombuffer(
            raw, dtype=np.float32, count=n_chunks * n_cprops, offset=body_offset
        ).reshape(n_chunks, n_cprops)

        vert_offset = body_offset + n_chunks * n_cprops * 4
        verts = np.frombuffer(
            raw, dtype=np.uint32, count=n_verts * 4, offset=vert_offset
        ).reshape(n_verts, 4)

        c_idx = np.minimum(np.arange(n_verts) // 256, n_chunks - 1)
        p_idx = {name: idx for idx, name in enumerate(chunk_props)}

        # Unpack 11-10-11 position
        p = verts[:, 0]
        px = ((p >> 21) & 0x7FF).astype(np.float32) / 2047.0
        py = ((p >> 11) & 0x3FF).astype(np.float32) / 1023.0
        pz = (p & 0x7FF).astype(np.float32) / 2047.0
        x = chunks[c_idx, p_idx["min_x"]] + px * (chunks[c_idx, p_idx["max_x"]] - chunks[c_idx, p_idx["min_x"]])
        y = chunks[c_idx, p_idx["min_y"]] + py * (chunks[c_idx, p_idx["max_y"]] - chunks[c_idx, p_idx["min_y"]])
        z = chunks[c_idx, p_idx["min_z"]] + pz * (chunks[c_idx, p_idx["max_z"]] - chunks[c_idx, p_idx["min_z"]])
        xyz = np.column_stack([x, y, z]).astype(np.float32)

        # Unpack smallest-three quaternion (qw, qx, qy, qz)
        rot = verts[:, 1]
        which = (rot >> 30) & 3
        sqrt2 = math.sqrt(2.0)
        qa = (((rot >> 20) & 0x3FF).astype(np.float32) / 1023.0 - 0.5) * sqrt2
        qb = (((rot >> 10) & 0x3FF).astype(np.float32) / 1023.0 - 0.5) * sqrt2
        qc = ((rot & 0x3FF).astype(np.float32) / 1023.0 - 0.5) * sqrt2
        qd = np.sqrt(np.maximum(0.0, 1.0 - (qa * qa + qb * qb + qc * qc)))
        quat = np.zeros((n_verts, 4), dtype=np.float32)
        for w_idx in range(4):
            m = which == w_idx
            rem = [i for i in range(4) if i != w_idx]
            quat[m, w_idx] = qd[m]
            quat[m, rem[0]] = qa[m]
            quat[m, rem[1]] = qb[m]
            quat[m, rem[2]] = qc[m]

        # Unpack 11-10-11 log-scale -> exp(scale)
        s = verts[:, 2]
        sx_n = ((s >> 21) & 0x7FF).astype(np.float32) / 2047.0
        sy_n = ((s >> 11) & 0x3FF).astype(np.float32) / 1023.0
        sz_n = (s & 0x7FF).astype(np.float32) / 2047.0
        sx = np.exp(
            np.clip(
                chunks[c_idx, p_idx["min_scale_x"]]
                + sx_n * (chunks[c_idx, p_idx["max_scale_x"]] - chunks[c_idx, p_idx["min_scale_x"]]),
                -20.0,
                5.0,
            )
        )
        sy = np.exp(
            np.clip(
                chunks[c_idx, p_idx["min_scale_y"]]
                + sy_n * (chunks[c_idx, p_idx["max_scale_y"]] - chunks[c_idx, p_idx["min_scale_y"]]),
                -20.0,
                5.0,
            )
        )
        sz = np.exp(
            np.clip(
                chunks[c_idx, p_idx["min_scale_z"]]
                + sz_n * (chunks[c_idx, p_idx["max_scale_z"]] - chunks[c_idx, p_idx["min_scale_z"]]),
                -20.0,
                5.0,
            )
        )
        scale = np.column_stack([sx, sy, sz]).astype(np.float32)

        # Unpack 8-8-8-8 color
        c = verts[:, 3]
        cr = ((c >> 24) & 0xFF).astype(np.float32) / 255.0
        cg = ((c >> 16) & 0xFF).astype(np.float32) / 255.0
        cb = ((c >> 8) & 0xFF).astype(np.float32) / 255.0
        ca = (c & 0xFF).astype(np.float32) / 255.0
        if "min_r" in p_idx and "max_r" in p_idx:
            r = np.clip(chunks[c_idx, p_idx["min_r"]] + cr * (chunks[c_idx, p_idx["max_r"]] - chunks[c_idx, p_idx["min_r"]]), 0.0, 1.0)
            g = np.clip(chunks[c_idx, p_idx["min_g"]] + cg * (chunks[c_idx, p_idx["max_g"]] - chunks[c_idx, p_idx["min_g"]]), 0.0, 1.0)
            b = np.clip(chunks[c_idx, p_idx["min_b"]] + cb * (chunks[c_idx, p_idx["max_b"]] - chunks[c_idx, p_idx["min_b"]]), 0.0, 1.0)
        else:
            r, g, b = cr, cg, cb
        rgba = np.column_stack([r, g, b, ca]).astype(np.float32)
        return {"xyz": xyz, "scale": scale, "rgba": rgba, "quat": quat}

    # Case 2: Standard 3DGS or Point Cloud .ply
    vert_el = el_map.get("vertex")
    if not vert_el:
        raise ValueError(f"No vertex element found in PLY: {file_path}")
    n_verts = int(vert_el["count"])
    props = vert_el["properties"]
    prop_names = [p[1] for p in props]

    if "ascii" in fmt:
        lines = raw[body_offset:].decode("ascii", errors="ignore").splitlines()
        mat = np.loadtxt(lines[:n_verts], dtype=np.float64)
        if mat.ndim == 1:
            mat = mat.reshape(1, -1)
        data_dict = {
            name: (mat[:, idx] if name in ("x", "y", "z") else mat[:, idx].astype(np.float32))
            for idx, name in enumerate(prop_names)
        }
    else:
        np_fields = [(p_name, _PLY_NP_DTYPES.get(p_type, "<f4")) for p_type, p_name in props]
        dt = np.dtype(np_fields)
        arr = np.frombuffer(raw, dtype=dt, count=n_verts, offset=body_offset)
        data_dict = {
            name: (arr[name].astype(np.float64) if name in ("x", "y", "z") else arr[name].astype(np.float32))
            for name in prop_names
        }

    xyz = np.column_stack([data_dict["x"], data_dict["y"], data_dict["z"]]).astype(np.float64)

    if "f_dc_0" in data_dict and "f_dc_1" in data_dict and "f_dc_2" in data_dict:
        r = np.clip(0.5 + SH_C0 * data_dict["f_dc_0"], 0.0, 1.0)
        g = np.clip(0.5 + SH_C0 * data_dict["f_dc_1"], 0.0, 1.0)
        b = np.clip(0.5 + SH_C0 * data_dict["f_dc_2"], 0.0, 1.0)
    elif "red" in data_dict and "green" in data_dict and "blue" in data_dict:
        max_c = max(float(data_dict["red"].max()), float(data_dict["green"].max()), float(data_dict["blue"].max()), 1.0)
        div = 255.0 if max_c > 1.001 else 1.0
        r = np.clip(data_dict["red"] / div, 0.0, 1.0)
        g = np.clip(data_dict["green"] / div, 0.0, 1.0)
        b = np.clip(data_dict["blue"] / div, 0.0, 1.0)
    else:
        r = np.full(n_verts, 0.82, dtype=np.float32)
        g = np.full(n_verts, 0.85, dtype=np.float32)
        b = np.full(n_verts, 0.88, dtype=np.float32)

    if "opacity" in data_dict:
        a = 1.0 / (1.0 + np.exp(-np.clip(data_dict["opacity"], -20.0, 20.0)))
    elif "alpha" in data_dict:
        max_a = float(data_dict["alpha"].max()) if len(data_dict["alpha"]) else 1.0
        a = np.clip(data_dict["alpha"] / (255.0 if max_a > 1.001 else 1.0), 0.0, 1.0)
    else:
        a = np.ones(n_verts, dtype=np.float32)

    if "scale_0" in data_dict and "scale_1" in data_dict and "scale_2" in data_dict:
        sx = np.exp(np.clip(data_dict["scale_0"], -20.0, 5.0))
        sy = np.exp(np.clip(data_dict["scale_1"], -20.0, 5.0))
        sz = np.exp(np.clip(data_dict["scale_2"], -20.0, 5.0))
        scale = np.column_stack([sx, sy, sz]).astype(np.float32)
    else:
        span = float(np.linalg.norm(xyz.max(axis=0) - xyz.min(axis=0))) or 2.0
        default_s = max(0.002, span / max(200.0, math.sqrt(n_verts) * 0.8))
        scale = np.full((n_verts, 3), default_s, dtype=np.float32)

    if "rot_0" in data_dict and "rot_1" in data_dict and "rot_2" in data_dict and "rot_3" in data_dict:
        quat = np.column_stack([data_dict["rot_0"], data_dict["rot_1"], data_dict["rot_2"], data_dict["rot_3"]]).astype(np.float32)
        qnorm = np.linalg.norm(quat, axis=1, keepdims=True)
        quat = np.where(qnorm > 1e-6, quat / np.maximum(qnorm, 1e-6), np.array([1.0, 0.0, 0.0, 0.0], dtype=np.float32))
    else:
        quat = np.zeros((n_verts, 4), dtype=np.float32)
        quat[:, 0] = 1.0

    rgba = np.column_stack([r, g, b, a]).astype(np.float32)
    return {"xyz": xyz, "scale": scale, "rgba": rgba, "quat": quat}


def _find_offset_xyz(folder_path: str, ply_path: str) -> Optional[Tuple[float, float, float]]:
    """Checks for an `offset.xyz` sidecar in `folder_path` or alongside `ply_path`."""
    cands = [
        os.path.join(folder_path, "offset.xyz"),
        os.path.join(os.path.dirname(ply_path), "offset.xyz") if ply_path else "",
    ]
    for c in cands:
        if c and os.path.isfile(c):
            try:
                with open(c, "r", encoding="utf-8", errors="ignore") as f:
                    parts = f.read().strip().split()
                if len(parts) >= 3:
                    ox, oy, oz = float(parts[0]), float(parts[1]), float(parts[2])
                    if abs(ox) > 1e-3 or abs(oy) > 1e-3 or abs(oz) > 1e-3:
                        return (ox, oy, oz)
            except Exception:
                pass
    return None


def _build_surfel_glb_bytes(
    xyz_zup: np.ndarray,
    scale: np.ndarray,
    rgba: np.ndarray,
    quat_zup: np.ndarray,
    origin_offset: Tuple[float, float, float],
    max_surfels: int = 24000,
) -> bytes:
    """
    Builds a self-contained glTF 2.0 .glb mesh of oriented 2D Gaussian surfel triangles
    for raycasting (distance/coord measurements & 3D comments) and standard GLB tools.
    """
    n = len(xyz_zup)
    if n > max_surfels:
        xyz_s = xyz_zup[:max_surfels]
        scale_s = scale[:max_surfels]
        rgba_s = rgba[:max_surfels]
        quat_s = quat_zup[:max_surfels]
    else:
        xyz_s = xyz_zup
        scale_s = scale
        rgba_s = rgba
        quat_s = quat_zup

    m = len(xyz_s)
    # Build two tangent vectors from quat_zup (qw, qx, qy, qz) and scale_s
    qw, qx, qy, qz = quat_s[:, 0], quat_s[:, 1], quat_s[:, 2], quat_s[:, 3]
    # First two columns of rotation matrix R(q)
    r00 = 1.0 - 2.0 * (qy * qy + qz * qz)
    r10 = 2.0 * (qx * qy + qw * qz)
    r20 = 2.0 * (qx * qz - qw * qy)

    r01 = 2.0 * (qx * qy - qw * qz)
    r11 = 1.0 - 2.0 * (qx * qx + qz * qz)
    r21 = 2.0 * (qy * qz + qw * qx)

    # Clamp surfel size for crisp raycast geometry
    s0 = np.clip(scale_s[:, 0] * 1.8, 0.0015, 0.08)[:, None]
    s1 = np.clip(scale_s[:, 1] * 1.8, 0.0015, 0.08)[:, None]
    u_vec = np.column_stack([r00, r10, r20]) * s0
    v_vec = np.column_stack([r01, r11, r21]) * s1

    # 3 vertices per splat (equilateral surfel triangle covering the Gaussian footprint)
    v0 = xyz_s - u_vec - 0.58 * v_vec
    v1 = xyz_s + u_vec - 0.58 * v_vec
    v2 = xyz_s + 1.15 * v_vec

    positions = np.empty((m * 3, 3), dtype=np.float32)
    positions[0::3] = v0
    positions[1::3] = v1
    positions[2::3] = v2

    colors_u8 = np.clip(np.round(rgba_s * 255.0), 0, 255).astype(np.uint8)
    colors_u8[:, 3] = 255
    v_colors = np.repeat(colors_u8, 3, axis=0)

    indices = np.arange(m * 3, dtype=np.uint32)

    pos_bytes = positions.tobytes()
    col_bytes = v_colors.tobytes()
    idx_bytes = indices.tobytes()

    bin_blob = bytearray()
    off_pos = 0
    bin_blob.extend(pos_bytes)
    while len(bin_blob) % 4:
        bin_blob.append(0)
    off_col = len(bin_blob)
    bin_blob.extend(col_bytes)
    while len(bin_blob) % 4:
        bin_blob.append(0)
    off_idx = len(bin_blob)
    bin_blob.extend(idx_bytes)
    while len(bin_blob) % 4:
        bin_blob.append(0)

    p_min = [float(x) for x in positions.min(axis=0)]
    p_max = [float(x) for x in positions.max(axis=0)]

    node_dict: Dict[str, Any] = {"mesh": 0}
    if any(abs(v) > 1e-4 for v in origin_offset):
        node_dict["translation"] = [float(origin_offset[0]), float(origin_offset[1]), float(origin_offset[2])]

    gltf_json = {
        "asset": {"version": "2.0", "generator": "GatheringScans GaussianSplat Builder"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [node_dict],
        "meshes": [
            {
                "primitives": [
                    {
                        "attributes": {"POSITION": 0, "COLOR_0": 1},
                        "indices": 2,
                        "material": 0,
                        "mode": 4,
                    }
                ]
            }
        ],
        "materials": [
            {
                "pbrMetallicRoughness": {
                    "metallicFactor": 0.0,
                    "roughnessFactor": 1.0,
                },
                "doubleSided": True,
            }
        ],
        "accessors": [
            {
                "bufferView": 0,
                "byteOffset": 0,
                "componentType": 5126,
                "count": int(m * 3),
                "type": "VEC3",
                "min": p_min,
                "max": p_max,
            },
            {
                "bufferView": 1,
                "byteOffset": 0,
                "componentType": 5121,
                "normalized": True,
                "count": int(m * 3),
                "type": "VEC4",
            },
            {
                "bufferView": 2,
                "byteOffset": 0,
                "componentType": 5125,
                "count": int(m * 3),
                "type": "SCALAR",
            },
        ],
        "bufferViews": [
            {"buffer": 0, "byteOffset": off_pos, "byteLength": len(pos_bytes), "target": 34962},
            {"buffer": 0, "byteOffset": off_col, "byteLength": len(col_bytes), "target": 34962},
            {"buffer": 0, "byteOffset": off_idx, "byteLength": len(idx_bytes), "target": 34963},
        ],
        "buffers": [{"byteLength": len(bin_blob)}],
    }

    jb = json.dumps(gltf_json, separators=(",", ":")).encode("utf-8")
    while len(jb) % 4:
        jb += b" "
    total_len = 12 + 8 + len(jb) + 8 + len(bin_blob)
    out = bytearray()
    out.extend(struct.pack("<4sII", b"glTF", 2, total_len))
    out.extend(struct.pack("<I4s", len(jb), b"JSON"))
    out.extend(jb)
    out.extend(struct.pack("<I4s", len(bin_blob), b"BIN\x00"))
    out.extend(bin_blob)
    return bytes(out)


def _render_gaussian_splat_thumbnail(
    xyz_zup: np.ndarray,
    scale: np.ndarray,
    rgba: np.ndarray,
    quat_zup: np.ndarray,
    out_png_path: str,
    width: int = 860,
    height: int = 400,
) -> None:
    """Renders a photorealistic 2D EWA Gaussian Splat preview thumbnail to `out_png_path`."""
    az = math.radians(-8.0)
    el = math.radians(5.0)
    cos_a, sin_a = math.cos(az), math.sin(az)
    cos_e, sin_e = math.cos(el), math.sin(el)

    R_az = np.array([[cos_a, -sin_a, 0.0], [sin_a, cos_a, 0.0], [0.0, 0.0, 1.0]], dtype=np.float32)
    R_el = np.array([[1.0, 0.0, 0.0], [0.0, sin_e, cos_e], [0.0, -cos_e, sin_e]], dtype=np.float32)
    R_view = R_el @ R_az

    pts_cam = xyz_zup @ R_view.T
    q_min = np.quantile(pts_cam, 0.01, axis=0)
    q_max = np.quantile(pts_cam, 0.99, axis=0)
    span_x = max(float(q_max[0] - q_min[0]), 0.1)
    span_y = max(float(q_max[1] - q_min[1]), 0.1)
    cx_m = 0.5 * float(q_min[0] + q_max[0])
    cy_m = 0.5 * float(q_min[1] + q_max[1])
    cz_m = 0.5 * float(q_min[2] + q_max[2])

    pts_cam[:, 0] -= cx_m
    pts_cam[:, 1] -= cy_m
    pts_cam[:, 2] -= cz_m

    fov_y = math.radians(40.0)
    aspect = float(width) / float(height)
    half_h = max(span_y * 0.68, (span_x * 0.58) / aspect)
    cam_dist = max(0.8, half_h / math.tan(fov_y * 0.5) + float(q_max[2] - cz_m) * 0.65)

    tz = pts_cam[:, 2] - cam_dist
    vis = (tz < -0.08) & (rgba[:, 3] > (1.5 / 255.0))
    if np.count_nonzero(vis) < 16:
        vis = tz < -0.05

    pts_cam = pts_cam[vis]
    tz = tz[vis]
    rgb_v = np.clip(rgba[vis, :3], 0.0, 1.0)
    a_v = rgba[vis, 3]
    sc_v = scale[vis]
    q_v = quat_zup[vis]

    order = np.argsort(tz)
    pts_cam = pts_cam[order]
    tz = tz[order]
    rgb_v = rgb_v[order]
    a_v = a_v[order]
    sc_v = sc_v[order]
    q_v = q_v[order]

    fy = (0.5 * height) / math.tan(fov_y * 0.5)
    fx = fy
    cx_px = width * 0.5 + (pts_cam[:, 0] / (-tz)) * fx
    cy_px = height * 0.5 - (pts_cam[:, 1] / (-tz)) * fy

    qw, qx, qy, qz = q_v[:, 0], q_v[:, 1], q_v[:, 2], q_v[:, 3]
    R_s = np.empty((len(qw), 3, 3), dtype=np.float32)
    R_s[:, 0, 0] = 1.0 - 2.0 * (qy * qy + qz * qz)
    R_s[:, 0, 1] = 2.0 * (qx * qy - qw * qz)
    R_s[:, 0, 2] = 2.0 * (qx * qz + qw * qy)
    R_s[:, 1, 0] = 2.0 * (qx * qy + qw * qz)
    R_s[:, 1, 1] = 1.0 - 2.0 * (qx * qx + qz * qz)
    R_s[:, 1, 2] = 2.0 * (qy * qz - qw * qx)
    R_s[:, 2, 0] = 2.0 * (qx * qz - qw * qy)
    R_s[:, 2, 1] = 2.0 * (qy * qz + qw * qx)
    R_s[:, 2, 2] = 1.0 - 2.0 * (qx * qx + qy * qy)

    M_cam = np.einsum("ij,njk->nik", R_view, R_s) * sc_v[:, None, :]
    V_cam = np.einsum("nij,nkj->nik", M_cam, M_cam)

    inv_z = -1.0 / tz
    inv_z2 = inv_z * inv_z
    tx, ty = pts_cam[:, 0], pts_cam[:, 1]
    J = np.zeros((len(qw), 2, 3), dtype=np.float32)
    J[:, 0, 0] = fx * inv_z
    J[:, 0, 2] = fx * tx * inv_z2
    J[:, 1, 1] = -fy * inv_z
    J[:, 1, 2] = -fy * ty * inv_z2
    cov2d = np.einsum("nij,njk,nlk->nil", J, V_cam, J)

    c00 = cov2d[:, 0, 0] + 0.3
    c01 = cov2d[:, 0, 1]
    c11 = cov2d[:, 1, 1] + 0.3
    det = np.maximum(c00 * c11 - c01 * c01, 1e-6)
    inv00 = c11 / det
    inv01 = -c01 / det
    inv11 = c00 / det
    rad_x = np.minimum(np.ceil(2.5 * np.sqrt(c00)).astype(np.int32), 48)
    rad_y = np.minimum(np.ceil(2.5 * np.sqrt(c11)).astype(np.int32), 48)

    yy = np.linspace(0.0, 1.0, height, dtype=np.float32)[:, None]
    img = np.empty((height, width, 3), dtype=np.float32)
    img[:, :, 0] = (12.0 + yy * 8.0) / 255.0
    img[:, :, 1] = (16.0 + yy * 10.0) / 255.0
    img[:, :, 2] = (26.0 + yy * 14.0) / 255.0

    for i in range(len(qw)):
        rx, ry = int(rad_x[i]), int(rad_y[i])
        ix, iy = int(round(float(cx_px[i]))), int(round(float(cy_px[i])))
        x0, x1 = max(0, ix - rx), min(width, ix + rx + 1)
        y0, y1 = max(0, iy - ry), min(height, iy + ry + 1)
        if x1 <= x0 or y1 <= y0:
            continue
        dx = np.arange(x0, x1, dtype=np.float32)[None, :] - cx_px[i]
        dy = np.arange(y0, y1, dtype=np.float32)[:, None] - cy_px[i]
        power = -0.5 * (inv00[i] * dx * dx + 2.0 * inv01[i] * dx * dy + inv11[i] * dy * dy)
        alpha = np.minimum(0.99, a_v[i] * np.exp(np.maximum(power, -20.0)))
        mask = (power > -4.0) & (alpha >= (1.0 / 255.0))
        if not np.any(mask):
            continue
        a_m = np.where(mask, alpha, 0.0)[:, :, None]
        img[y0:y1, x0:x1] = img[y0:y1, x0:x1] * (1.0 - a_m) + rgb_v[i][None, None, :] * a_m

    os.makedirs(os.path.dirname(out_png_path), exist_ok=True)
    Image.fromarray(np.clip(img * 255.0, 0, 255).astype(np.uint8)).save(out_png_path, format="PNG", optimize=True)


def build_gaussian_splat_tileset(
    scan_id: str,
    folder_path: str,
    ply_path: str,
    force: bool = False,
) -> Optional[str]:
    """
    Converts a Gaussian Splat `.ply` / `.compressed.ply` / `.splat` file (and optional `offset.xyz`)
    into a GatheringScans 3D Tileset (`tileset/tileset.json` + `tileset/tiles/splats.gsplat` + `tileset/tiles/root.glb`).
    Returns the path to `tileset/tileset.json`.
    """
    if not ply_path or not os.path.isfile(ply_path):
        return None

    tileset_dir = os.path.join(folder_path, "tileset")
    tiles_sub = os.path.join(tileset_dir, "tiles")
    prev_sub = os.path.join(tileset_dir, "preview_low", "tiles")
    os.makedirs(tiles_sub, exist_ok=True)
    os.makedirs(prev_sub, exist_ok=True)

    ts_json_path = os.path.join(tileset_dir, "tileset.json")
    gsplat_bin_path = os.path.join(tiles_sub, "splats.gsplat")
    root_glb_path = os.path.join(tiles_sub, "root.glb")
    prev_glb_path = os.path.join(prev_sub, "root.glb")
    prev_ts_path = os.path.join(tileset_dir, "preview_tileset.json")
    thumb_path = os.path.join(folder_path, "thumbnail.png")

    ply_mtime = os.path.getmtime(ply_path)
    if (
        not force
        and os.path.isfile(ts_json_path)
        and os.path.isfile(gsplat_bin_path)
        and os.path.isfile(root_glb_path)
        and os.path.getmtime(ts_json_path) >= ply_mtime
    ):
        return ts_json_path

    raw_data = load_gaussian_splats_raw(ply_path)
    xyz = raw_data["xyz"]
    scale = raw_data["scale"]
    rgba = raw_data["rgba"]
    quat = raw_data["quat"]

    # Filter out nearly invisible splats (alpha < 1/255) or NaN coordinates
    valid_mask = (
        np.isfinite(xyz).all(axis=1)
        & np.isfinite(scale).all(axis=1)
        & (rgba[:, 3] >= (1.5 / 255.0))
    )
    if np.count_nonzero(valid_mask) >= 16:
        xyz = xyz[valid_mask]
        scale = scale[valid_mask]
        rgba = rgba[valid_mask]
        quat = quat[valid_mask]

    offset_xyz = _find_offset_xyz(folder_path, ply_path)
    has_georef_offset = offset_xyz is not None and (abs(offset_xyz[0]) > 100.0 and abs(offset_xyz[1]) > 100.0)

    if has_georef_offset and offset_xyz is not None:
        # Georeferenced Z-up scan (+X East, +Y North, +Z Up)
        cx = float(np.median(xyz[:, 0]))
        cy = float(np.median(xyz[:, 1]))
        cz = float(np.median(xyz[:, 2]))
        xyz_zup = np.column_stack([xyz[:, 0] - cx, xyz[:, 1] - cy, xyz[:, 2] - cz]).astype(np.float32)
        quat_zup = quat.astype(np.float32)
        world_origin = (float(offset_xyz[0] + cx), float(offset_xyz[1] + cy), float(offset_xyz[2] + cz))
    else:
        # Non-map COLMAP / 3DGS scan (+X right, +Y down, +Z front) -> Z-up tileset frame:
        # X_zup = -x_ply, Y_zup = -z_ply, Z_zup = -y_ply (proper right-handed rotation det = +1)
        x_z = -xyz[:, 0]
        y_z = -xyz[:, 2]
        z_z = -xyz[:, 1]
        cx = float(np.median(x_z))
        cy = float(np.median(y_z))
        z_q02, z_q98 = float(np.quantile(z_z, 0.02)), float(np.quantile(z_z, 0.98))
        cz = 0.5 * (z_q02 + z_q98)
        xyz_zup = np.column_stack([x_z - cx, y_z - cy, z_z - cz]).astype(np.float32)

        # Transform quaternion from COLMAP (+X right, +Y down, +Z front) -> Z-up modelPivot frame
        # where P = [[-1, 0, 0], [0, 0, -1], [0, -1, 0]] (det = +1, q_P = (0, 0, sqrt(0.5), -sqrt(0.5)))
        w_q = quat[:, 0]
        x_q = quat[:, 1]
        y_q = quat[:, 2]
        z_q = quat[:, 3]
        s = math.sqrt(0.5)
        quat_zup = np.column_stack(
            [
                s * (z_q - y_q),
                s * (y_q + z_q),
                s * (w_q - x_q),
                -s * (w_q + x_q),
            ]
        ).astype(np.float32)
        world_origin = (0.0, 0.0, 0.0)

    # Sort splats by visual importance descending so prefix subsets in 'Rough' mode cover the whole model uniformly
    max_s = np.maximum(np.maximum(scale[:, 0], scale[:, 1]), scale[:, 2])
    importance = rgba[:, 3] * (max_s ** 1.35)
    # Mix a deterministic Golden-Ratio spatial stride with importance so prefix subsets have zero spatial holes
    n_total = len(xyz_zup)
    imp_order = np.argsort(-importance)
    xyz_zup = xyz_zup[imp_order]
    scale = scale[imp_order]
    rgba = rgba[imp_order]
    quat_zup = quat_zup[imp_order]

    # Write `tiles/splats.gsplat` (16-byte header + N * 32-byte records)
    # Byte 28..31: unit quaternion (qx, qy, qz, qw) quantized to uint8 [0..255] via (q * 0.5 + 0.5) * 255
    rec_dtype = np.dtype(
        [
            ("pos", "<f4", (3,)),
            ("scale", "<f4", (3,)),
            ("rgba", "<u1", (4,)),
            ("quat", "<u1", (4,)),
        ]
    )
    recs = np.empty(n_total, dtype=rec_dtype)
    recs["pos"] = xyz_zup
    recs["scale"] = scale
    recs["rgba"] = np.clip(np.round(rgba * 255.0), 0, 255).astype(np.uint8)
    quat_xyzw = np.column_stack([quat_zup[:, 1], quat_zup[:, 2], quat_zup[:, 3], quat_zup[:, 0]])
    recs["quat"] = np.clip(np.round((quat_xyzw * 0.5 + 0.5) * 255.0), 0, 255).astype(np.uint8)

    header_bytes = struct.pack("<4sIII", b"GSPL", 1, n_total, 1 if has_georef_offset else 0)
    raw_gsplat_blob = header_bytes + recs.tobytes()
    with open(gsplat_bin_path, "wb") as gf:
        gf.write(raw_gsplat_blob)
    _write_gsplat_gz_sidecar(gsplat_bin_path, raw_gsplat_blob)

    # Write `tiles/root.glb` and `preview_low/tiles/root.glb`
    glb_bytes = _build_surfel_glb_bytes(xyz_zup, scale, rgba, quat_zup, world_origin, max_surfels=24000)
    with open(root_glb_path, "wb") as rf:
        rf.write(glb_bytes)

    prev_glb_bytes = _build_surfel_glb_bytes(xyz_zup, scale, rgba, quat_zup, world_origin, max_surfels=8000)
    with open(prev_glb_path, "wb") as pf:
        pf.write(prev_glb_bytes)

    # Compute tight bounding box (99% quantile to ignore stray outlier floater splats)
    q_min = np.quantile(xyz_zup, 0.005, axis=0)
    q_max = np.quantile(xyz_zup, 0.995, axis=0)
    hx = max(0.25, float((q_max[0] - q_min[0]) * 0.5))
    hy = max(0.25, float((q_max[1] - q_min[1]) * 0.5))
    hz = max(0.25, float((q_max[2] - q_min[2]) * 0.5))
    bx = float(world_origin[0])
    by = float(world_origin[1])
    bz = float(world_origin[2])

    box_12 = [
        round(bx, 4), round(by, 4), round(bz, 4),
        round(hx, 4), 0.0, 0.0,
        0.0, round(hy, 4), 0.0,
        0.0, 0.0, round(hz, 4),
    ]
    gsplat_mtime = int(os.path.getmtime(gsplat_bin_path))

    tileset_doc = {
        "asset": {
            "version": "1.1",
            "gltfUpAxis": "Z",
            "generator": "GatheringScans GaussianSplat Builder",
        },
        "extras": {
            "is_gaussian_splat": True,
            "has_gaussian_splat_layer": True,
            "gaussian_splat_uri": f"tiles/splats.gsplat?v={gsplat_mtime}",
            "gaussian_splat_origin": [round(bx, 4), round(by, 4), round(bz, 4)],
            "splat_count": int(n_total),
            "splat_size_mb": round(os.path.getsize(gsplat_bin_path) / (1024.0 * 1024.0), 2),
            "source_ply": os.path.basename(ply_path),
            "has_georef_offset": bool(has_georef_offset),
            "tight_bounds": {
                "center": [round(bx, 4), round(by, 4), round(bz, 4)],
                "half_extents": [round(hx, 4), round(hy, 4), round(hz, 4)],
            },
        },
        "geometricError": 0.0,
        "root": {
            "boundingVolume": {"box": box_12},
            "geometricError": 0.0,
            "refine": "REPLACE",
            "content": {"uri": "tiles/root.glb"},
            "extras": {
                "is_gaussian_splat": True,
                "has_gaussian_splat_layer": True,
                "splat_count": int(n_total),
                "gaussian_splat_uri": f"tiles/splats.gsplat?v={gsplat_mtime}",
                "gaussian_splat_origin": [round(bx, 4), round(by, 4), round(bz, 4)],
            },
            "children": [],
        },
    }

    with open(ts_json_path, "w", encoding="utf-8") as tf:
        json.dump(tileset_doc, tf, indent=2)

    prev_doc = json.loads(json.dumps(tileset_doc))
    prev_doc["root"]["content"]["uri"] = "preview_low/tiles/root.glb"
    with open(prev_ts_path, "w", encoding="utf-8") as ptf:
        json.dump(prev_doc, ptf, indent=2)

    try:
        _render_gaussian_splat_thumbnail(xyz_zup, scale, rgba, quat_zup, thumb_path)
        if os.path.isfile(thumb_path):
            import shutil
            from .config import DATA_DIR
            thumbs_dir = os.path.join(DATA_DIR, "thumbnails")
            os.makedirs(thumbs_dir, exist_ok=True)
            shutil.copy2(thumb_path, os.path.join(thumbs_dir, f"{scan_id}.png"))
            shutil.copy2(thumb_path, os.path.join(tileset_dir, "thumbnail.png"))
    except Exception as e:
        print(f"[GaussianSplatBuilder] Warning rendering thumbnail for {scan_id}: {e}")

    print(
        f"[GaussianSplatBuilder] Built Gaussian Splat tileset for '{scan_id}' "
        f"({n_total:,} splats, georef={has_georef_offset}) -> {ts_json_path}"
    )
    return ts_json_path


GSPLAT_REC_DTYPE = np.dtype(
    [
        ("pos", "<f4", (3,)),
        ("scale", "<f4", (3,)),
        ("rgba", "<u1", (4,)),
        ("quat", "<u1", (4,)),
    ]
)


def _write_gsplat_gz_sidecar(gsplat_bin_path: str, raw_blob: Optional[bytes] = None) -> Optional[str]:
    """Writes a pre-compressed `splats.gsplat.gz` sidecar next to `splats.gsplat` for <5ms HTTP & VPS streaming."""
    import gzip

    try:
        if raw_blob is None:
            if not os.path.isfile(gsplat_bin_path):
                return None
            with open(gsplat_bin_path, "rb") as rf:
                raw_blob = rf.read()
        gz_path = gsplat_bin_path + ".gz"
        gz_bytes = gzip.compress(raw_blob, compresslevel=5)
        with open(gz_path, "wb") as wf:
            wf.write(gz_bytes)
        return gz_path
    except Exception as e:
        print(f"[GaussianSplatBuilder] Note writing .gsplat.gz sidecar: {e}")
        return None


def _sync_tileset_and_meta_gsplat_fields(
    tileset_dir: str,
    folder_path: Optional[str],
    splat_uri_rel: str,
    splat_origin_list: List[float],
    n_total: int,
    splat_size_mb: float,
    also_update_backup: bool = False,
) -> None:
    """Updates `extras` in `tileset.json`, `preview_tileset.json`, and `scan_meta.json` with current 3DGS metadata."""
    ts_targets = [
        os.path.join(tileset_dir, "tileset.json"),
        os.path.join(tileset_dir, "preview_tileset.json"),
    ]
    if also_update_backup and folder_path:
        ts_targets.append(os.path.join(folder_path, "tileset_backup", "tileset.json"))

    has_layer = bool(n_total > 0)
    for target_ts in ts_targets:
        if os.path.isfile(target_ts):
            try:
                with open(target_ts, "r", encoding="utf-8") as f_in:
                    doc = json.load(f_in)
                if isinstance(doc, dict):
                    ext = doc.setdefault("extras", {})
                    ext["has_gaussian_splat_layer"] = has_layer
                    ext["gaussian_splat_uri"] = splat_uri_rel
                    ext["gaussian_splat_origin"] = splat_origin_list
                    ext["splat_count"] = int(n_total)
                    ext["splat_size_mb"] = splat_size_mb
                    if isinstance(doc.get("root"), dict):
                        r_ext = doc["root"].setdefault("extras", {})
                        r_ext["has_gaussian_splat_layer"] = has_layer
                        r_ext["gaussian_splat_uri"] = splat_uri_rel
                        r_ext["gaussian_splat_origin"] = splat_origin_list
                        r_ext["splat_count"] = int(n_total)
                        r_ext["splat_size_mb"] = splat_size_mb
                    with open(target_ts, "w", encoding="utf-8") as f_out:
                        json.dump(doc, f_out, indent=2)
            except Exception as te:
                print(f"[GaussianSplatBuilder] Warning updating tileset metadata in {target_ts}: {te}")

    proj_dir = folder_path or os.path.dirname(os.path.abspath(tileset_dir))
    meta_fp = os.path.join(proj_dir, "scan_meta.json")
    if os.path.isfile(meta_fp):
        try:
            with open(meta_fp, "r", encoding="utf-8") as mf:
                m_obj = json.load(mf)
            if isinstance(m_obj, dict):
                m_obj["has_gaussian_splat_layer"] = has_layer
                m_obj["gaussian_splat_uri"] = splat_uri_rel
                m_obj["gaussian_splat_origin"] = splat_origin_list
                m_obj["splat_count"] = int(n_total)
                m_obj["splat_size_mb"] = splat_size_mb
                with open(meta_fp, "w", encoding="utf-8") as mf:
                    json.dump(m_obj, mf, ensure_ascii=False, indent=2)
        except Exception:
            pass


GSPLAT_REC_DTYPE = np.dtype(
    [
        ("pos", "<f4", (3,)),
        ("scale", "<f4", (3,)),
        ("rgba", "<u1", (4,)),
        ("quat", "<u1", (4,)),
    ]
)


def read_gsplat_records_and_origin(tileset_dir: str) -> Optional[Tuple[np.ndarray, np.ndarray, int]]:
    """
    Reads `tiles/splats.gsplat` and `gaussian_splat_origin` from `tileset_dir`.
    Returns `(recs, origin_xyz_f64, flags)` or `None` if no valid `.gsplat` exists.
    """
    gs_path = os.path.join(tileset_dir, "tiles", "splats.gsplat")
    ts_path = os.path.join(tileset_dir, "tileset.json")
    origin_xyz = np.zeros(3, dtype=np.float64)
    if os.path.isfile(ts_path):
        try:
            with open(ts_path, "r", encoding="utf-8") as tf:
                ts_doc = json.load(tf)
            ext = ts_doc.get("extras") or (ts_doc.get("root") or {}).get("extras") or {}
            rel_uri = str(ext.get("gaussian_splat_uri") or "").split("?")[0].strip()
            if rel_uri:
                cand_gs = os.path.join(tileset_dir, rel_uri.replace("/", os.sep))
                if os.path.isfile(cand_gs):
                    gs_path = cand_gs
            g_orig = ext.get("gaussian_splat_origin")
            if isinstance(g_orig, list) and len(g_orig) >= 3:
                origin_xyz = np.array([float(g_orig[0]), float(g_orig[1]), float(g_orig[2])], dtype=np.float64)
            else:
                r_box = ((ts_doc.get("root") or {}).get("boundingVolume") or {}).get("box")
                if isinstance(r_box, list) and len(r_box) >= 3:
                    origin_xyz = np.array([float(r_box[0]), float(r_box[1]), float(r_box[2])], dtype=np.float64)
        except Exception:
            pass

    if not os.path.isfile(gs_path) or os.path.getsize(gs_path) < 48:
        return None
    try:
        with open(gs_path, "rb") as gf:
            raw = gf.read()
        magic, _ver, total_cnt, flags = struct.unpack_from("<4sIII", raw, 0)
        if magic not in (b"GSPL", b"SPLT"):
            return None
        n = min(int(total_cnt), (len(raw) - 16) // 32)
        if n <= 0:
            return None
        recs = np.frombuffer(raw, dtype=GSPLAT_REC_DTYPE, count=n, offset=16).copy()
        return recs, origin_xyz, int(flags)
    except Exception:
        return None


def _points_in_shapely_poly(poly: Any, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    if len(xs) == 0:
        return np.zeros(0, dtype=bool)
    try:
        import shapely

        if hasattr(shapely, "contains_xy"):
            return np.asarray(shapely.contains_xy(poly, xs, ys), dtype=bool)
        from shapely.geometry import Point
        from shapely.prepared import prep

        prep_poly = prep(poly)
        return np.array([prep_poly.contains(Point(float(x), float(y))) for x, y in zip(xs, ys)], dtype=bool)
    except Exception:
        return np.zeros(len(xs), dtype=bool)


def evaluate_points_in_cutter(
    cutter: Any, pts_ts: np.ndarray, radii: Optional[np.ndarray] = None
) -> np.ndarray:
    """
    Evaluates `(N, 3)` float64 points `pts_ts` in Tileset native coordinates (`[Easting, Northing, Elevation]` when `up_axis=='z'`)
    against a `SpatialCutter`'s `frustum_strokes` and 2D `poly` + `[min_elev, max_elev]`.
    Returns boolean array `selected` (length N) indicating which points fall INSIDE the selection region.
    """
    n_pts = len(pts_ts)
    if n_pts == 0:
        return np.zeros(0, dtype=bool)

    selected = np.zeros(n_pts, dtype=bool)
    v_idx = int(getattr(cutter, "v_idx", None) if getattr(cutter, "v_idx", None) is not None else 2)
    h0_idx = int(getattr(cutter, "h0_idx", None) if getattr(cutter, "h0_idx", None) is not None else 0)
    h1_idx = int(getattr(cutter, "h1_idx", None) if getattr(cutter, "h1_idx", None) is not None else 1)
    raw_min_e = getattr(cutter, "min_elev", None)
    raw_max_e = getattr(cutter, "max_elev", None)
    min_elev = float(raw_min_e) if raw_min_e is not None else -1e9
    max_elev = float(raw_max_e) if raw_max_e is not None else 1e9

    if getattr(cutter, "use_frustum", False):
        for st in getattr(cutter, "frustum_strokes", []) or []:
            elev_vals = pts_ts[:, v_idx]
            elev_ok = (elev_vals >= min_elev) & (elev_vals <= max_elev)
            if not np.any(elev_ok):
                continue

            C = st["tiles_center"]
            piv = st["pivot_matrix"]
            R_p, t_p = piv[:3, :3], piv[:3, 3]
            w = (pts_ts - C) @ R_p.T + t_p

            vp = st["view_proj_matrix"]
            VP_3, VP_t = vp[:, :3], vp[:, 3]
            cc = w @ VP_3.T + VP_t
            cwc = cc[:, 3]

            front_ok = elev_ok & (cwc > 0.05)
            sb = st.get("section_box")
            if sb is not None:
                dy = np.abs(w[:, 1] - sb["cy"]) <= (sb["hy"] + 1e-4)
                dx = w[:, 0] - sb["cx"]
                dz = w[:, 2] - sb["cz"]
                lx = np.abs(dx * sb["cos_y"] - dz * sb["sin_y"]) <= (sb["hx"] + 1e-4)
                lz = np.abs(dx * sb["sin_y"] + dz * sb["cos_y"]) <= (sb["hz"] + 1e-4)
                front_ok = front_ok & dy & lx & lz

            cand_idx = np.where(front_ok)[0]
            if len(cand_idx) == 0:
                continue

            nxc = cc[cand_idx, 0] / cwc[cand_idx]
            nyc = cc[cand_idx, 1] / cwc[cand_idx]
            b_min_x, b_min_y, b_max_x, b_max_y = st["bounds"]
            bbox_ok = (nxc >= b_min_x) & (nxc <= b_max_x) & (nyc >= b_min_y) & (nyc <= b_max_y)
            sub_cand = np.where(bbox_ok)[0]
            if len(sub_cand) == 0:
                continue

            real_idx = cand_idx[sub_cand]
            poly_hit = _points_in_shapely_poly(st["poly"], nxc[sub_cand], nyc[sub_cand])

            if st.get("visible_only") and st.get("depth_grid") is not None:
                dg = st["depth_grid"]
                G = int(st["depth_grid_size"])
                gx = np.clip(((nxc[sub_cand] * 0.5 + 0.5) * G).astype(np.int32), 0, G - 1)
                gy = np.clip(((nyc[sub_cand] * 0.5 + 0.5) * G).astype(np.int32), 0, G - 1)
                cell_front_w = dg[gy, gx]
                eff_front_w = np.where(cell_front_w > 0.0, cell_front_w, float(st.get("max_valid_w") or 0.0))
                r_sub = radii[real_idx] if radii is not None else 0.0
                tol = np.maximum(float(st.get("depth_tolerance_m") or 0.85), 0.03 * eff_front_w) + np.clip(r_sub, 0.0, 2.0)
                depth_ok = (cwc[real_idx] - r_sub) <= (eff_front_w + tol)
                poly_hit = poly_hit & depth_ok

            hit_indices = real_idx[poly_hit]
            if st.get("op") == "sub":
                selected[hit_indices] = False
            else:
                selected[hit_indices] = True

    poly_candidates = []
    if getattr(cutter, "poly", None) is not None:
        poly_candidates.append(cutter.poly)
    elif getattr(cutter, "clip_polygon", None) is not None:
        poly_candidates.append(cutter.clip_polygon)
    for cp in getattr(cutter, "clip_polygons", None) or []:
        if cp is not None and cp not in poly_candidates:
            poly_candidates.append(cp)

    if poly_candidates:
        v_vals = pts_ts[:, v_idx]
        h0_vals = pts_ts[:, h0_idx]
        h1_vals = pts_ts[:, h1_idx]
        h_mask = (v_vals >= min_elev) & (v_vals <= max_elev)
        valid_indices = np.where(h_mask)[0]
        if len(valid_indices) > 0:
            for p_geom in poly_candidates:
                poly_mask = _points_in_shapely_poly(p_geom, h0_vals[valid_indices], h1_vals[valid_indices])
                selected[valid_indices[poly_mask]] = True

    return selected


def _rotmat_to_quat_xyzw(R_in: np.ndarray) -> Tuple[float, float, float, float]:
    """Converts a 3x3 rotation/linear matrix into a unit quaternion (qx, qy, qz, qw)."""
    det = float(np.linalg.det(R_in))
    if det <= 1e-8:
        return (0.0, 0.0, 0.0, 1.0)
    R = R_in / (det ** (1.0 / 3.0))
    tr = float(R[0, 0] + R[1, 1] + R[2, 2])
    if tr > 0.0:
        s = math.sqrt(tr + 1.0) * 2.0
        qw = 0.25 * s
        qx = float(R[2, 1] - R[1, 2]) / s
        qy = float(R[0, 2] - R[2, 0]) / s
        qz = float(R[1, 0] - R[0, 1]) / s
    elif R[0, 0] > R[1, 1] and R[0, 0] > R[2, 2]:
        s = math.sqrt(1.0 + float(R[0, 0] - R[1, 1] - R[2, 2])) * 2.0
        qw = float(R[2, 1] - R[1, 2]) / s
        qx = 0.25 * s
        qy = float(R[0, 1] + R[1, 0]) / s
        qz = float(R[0, 2] + R[2, 0]) / s
    elif R[1, 1] > R[2, 2]:
        s = math.sqrt(1.0 + float(R[1, 1] - R[0, 0] - R[2, 2])) * 2.0
        qw = float(R[0, 2] - R[2, 0]) / s
        qx = float(R[0, 1] + R[1, 0]) / s
        qy = 0.25 * s
        qz = float(R[1, 2] + R[2, 1]) / s
    else:
        s = math.sqrt(1.0 + float(R[2, 2] - R[0, 0] - R[1, 1])) * 2.0
        qw = float(R[1, 0] - R[0, 1]) / s
        qx = float(R[0, 2] + R[2, 0]) / s
        qy = float(R[1, 2] + R[2, 1]) / s
        qz = 0.25 * s
    nrm = math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw)
    if nrm < 1e-8:
        return (0.0, 0.0, 0.0, 1.0)
    return (qx / nrm, qy / nrm, qz / nrm, qw / nrm)


def _rotate_packed_quats_by_matrix(u8_quat: np.ndarray, R: np.ndarray) -> np.ndarray:
    """Left-multiplies packed uint8 quaternions `(qx, qy, qz, qw)` by rotation matrix `R`."""
    if len(u8_quat) == 0 or np.allclose(R, np.eye(3, dtype=np.float64), atol=1e-6):
        return u8_quat
    rx, ry, rz, rw = _rotmat_to_quat_xyzw(R)
    q = (u8_quat.astype(np.float64) / 255.0) * 2.0 - 1.0
    qx, qy, qz, qw = q[:, 0], q[:, 1], q[:, 2], q[:, 3]
    nx = rw * qx + rx * qw + ry * qz - rz * qy
    ny = rw * qy - rx * qz + ry * qw + rz * qx
    nz = rw * qz + rx * qy - ry * qx + rz * qw
    nw = rw * qw - rx * qx - ry * qy - rz * qz
    nrm = np.maximum(np.sqrt(nx * nx + ny * ny + nz * nz + nw * nw), 1e-8)
    q_out = np.column_stack([nx / nrm, ny / nrm, nz / nrm, nw / nrm])
    return np.clip(np.round((q_out * 0.5 + 0.5) * 255.0), 0, 255).astype(np.uint8)


def slice_gsplat_for_tileset_cut(
    input_tileset_dir: str,
    output_tileset_dir: str,
    cutter: Any,
    max_splats: int = 500_000,
) -> Optional[Dict[str, Any]]:
    """
    Slices `input_tileset_dir/tiles/splats.gsplat` using the exact same `SpatialCutter`
    `frustum_strokes` and `polygons_list` (`delete_inside` or `keep_inside` mode),
    re-centers splats around `output_tileset_dir/tileset.json`'s root bounding box center,
    and writes `output_tileset_dir/tiles/splats.gsplat` (+ `.gz`).
    """
    loaded = read_gsplat_records_and_origin(input_tileset_dir)
    if loaded is None:
        return None
    recs, old_origin, flags = loaded

    pts_ts = recs["pos"].astype(np.float64) + old_origin
    radii = np.max(recs["scale"], axis=1).astype(np.float64)
    inside_mask = evaluate_points_in_cutter(cutter, pts_ts, radii)
    mode = str(getattr(cutter, "mode", "keep_inside")).lower().strip()
    keep_mask = (~inside_mask) if mode == "delete_inside" else inside_mask

    kept_recs = recs[keep_mask].copy()
    kept_pts_ts = pts_ts[keep_mask]
    deleted_cnt = int(len(recs) - len(kept_recs))

    if max_splats and max_splats > 0 and len(kept_recs) > max_splats:
        kept_recs = kept_recs[: int(max_splats)].copy()
        kept_pts_ts = kept_pts_ts[: int(max_splats)]

    new_origin = old_origin.copy()
    is_standalone_gsplat = False
    out_ts_path = os.path.join(output_tileset_dir, "tileset.json")
    if os.path.isfile(out_ts_path):
        try:
            with open(out_ts_path, "r", encoding="utf-8") as tf:
                out_ts = json.load(tf)
            ex = out_ts.get("extras") if isinstance(out_ts.get("extras"), dict) else {}
            r_ex = ((out_ts.get("root") or {}).get("extras") or {}) if isinstance(out_ts.get("root"), dict) else {}
            is_standalone_gsplat = bool(ex.get("is_gaussian_splat") or r_ex.get("is_gaussian_splat"))
            r_box = ((out_ts.get("root") or {}).get("boundingVolume") or {}).get("box")
            if isinstance(r_box, list) and len(r_box) >= 3:
                cand_o = np.array([float(r_box[0]), float(r_box[1]), float(r_box[2])], dtype=np.float64)
                if np.linalg.norm(cand_o - old_origin) < 10000.0:
                    new_origin = cand_o
        except Exception:
            pass

    n_kept = len(kept_recs)
    if is_standalone_gsplat and n_kept >= 8 and np.linalg.norm(old_origin) > 100.0:
        q_min_w = np.quantile(kept_pts_ts, 0.005, axis=0)
        q_max_w = np.quantile(kept_pts_ts, 0.995, axis=0)
        new_origin = 0.5 * (q_min_w + q_max_w)

    if n_kept > 0:
        kept_recs["pos"] = (kept_pts_ts - new_origin).astype(np.float32)

    out_tiles_dir = os.path.join(output_tileset_dir, "tiles")
    os.makedirs(out_tiles_dir, exist_ok=True)
    out_gs_path = os.path.join(out_tiles_dir, "splats.gsplat")

    header_bytes = struct.pack("<4sIII", b"GSPL", 1, n_kept, flags)
    raw_blob = header_bytes + kept_recs.tobytes()
    with open(out_gs_path, "wb") as wf:
        wf.write(raw_blob)
    _write_gsplat_gz_sidecar(out_gs_path, raw_blob)

    if is_standalone_gsplat and n_kept >= 4:
        try:
            rgba_f = kept_recs["rgba"].astype(np.float32) / 255.0
            q_xyzw = (kept_recs["quat"].astype(np.float32) / 255.0) * 2.0 - 1.0
            quat_wxyz = np.column_stack([q_xyzw[:, 3], q_xyzw[:, 0], q_xyzw[:, 1], q_xyzw[:, 2]]).astype(np.float32)
            wo_tuple = (float(new_origin[0]), float(new_origin[1]), float(new_origin[2]))
            glb_b = _build_surfel_glb_bytes(kept_recs["pos"], kept_recs["scale"], rgba_f, quat_wxyz, wo_tuple, max_surfels=24000)
            with open(os.path.join(out_tiles_dir, "root.glb"), "wb") as rf:
                rf.write(glb_b)
            prev_glb_p = os.path.join(output_tileset_dir, "preview_low", "tiles", "root.glb")
            if os.path.isdir(os.path.dirname(prev_glb_p)):
                prev_b = _build_surfel_glb_bytes(kept_recs["pos"], kept_recs["scale"], rgba_f, quat_wxyz, wo_tuple, max_surfels=8000)
                with open(prev_glb_p, "wb") as pf:
                    pf.write(prev_b)
            if os.path.isfile(out_ts_path):
                q_min = np.quantile(kept_recs["pos"], 0.005, axis=0)
                q_max = np.quantile(kept_recs["pos"], 0.995, axis=0)
                hx = max(0.25, float((q_max[0] - q_min[0]) * 0.5))
                hy = max(0.25, float((q_max[1] - q_min[1]) * 0.5))
                hz = max(0.25, float((q_max[2] - q_min[2]) * 0.5))
                with open(out_ts_path, "r", encoding="utf-8") as tf_r:
                    ts_d = json.load(tf_r)
                bx, by, bz = round(float(new_origin[0]), 4), round(float(new_origin[1]), 4), round(float(new_origin[2]), 4)
                if isinstance(ts_d.get("root"), dict):
                    ts_d["root"]["boundingVolume"] = {
                        "box": [bx, by, bz, round(hx, 4), 0.0, 0.0, 0.0, round(hy, 4), 0.0, 0.0, 0.0, round(hz, 4)]
                    }
                if isinstance(ts_d.get("extras"), dict):
                    ts_d["extras"]["tight_bounds"] = {
                        "center": [bx, by, bz],
                        "half_extents": [round(hx, 4), round(hy, 4), round(hz, 4)],
                    }
                with open(out_ts_path, "w", encoding="utf-8") as tf_w:
                    json.dump(ts_d, tf_w, indent=2)
        except Exception:
            pass

    gs_mtime = int(os.path.getmtime(out_gs_path))
    splat_size_mb = round(len(raw_blob) / (1024.0 * 1024.0), 2)
    splat_uri_rel = f"tiles/splats.gsplat?v={gs_mtime}"
    splat_origin_list = [round(float(new_origin[0]), 4), round(float(new_origin[1]), 4), round(float(new_origin[2]), 4)]

    _sync_tileset_and_meta_gsplat_fields(
        output_tileset_dir,
        None,
        splat_uri_rel,
        splat_origin_list,
        n_kept,
        splat_size_mb,
        also_update_backup=False,
    )
    return {
        "splats_kept": int(n_kept),
        "splats_deleted": int(deleted_cnt),
        "splat_size_mb": splat_size_mb,
        "gaussian_splat_uri": splat_uri_rel,
        "gaussian_splat_origin": splat_origin_list,
    }


def _extract_surviving_mesh_sample_points_zup(tileset_dir: str, max_horizon_tiles: int = 48) -> Optional[np.ndarray]:
    """
    Extracts dense 3D surface sample points (vertices + triangle centroids + edge midpoints) in
    Tileset Z-up coordinates (`[Easting, Northing, Elevation]`) from the surviving `.glb` tiles in `tileset_dir`.
    Uses a BFS Horizon Cut of up to `max_horizon_tiles` tiles on deep octrees (since `SpatialCutter` slices
    all LOD levels in lockstep) + per-tile 2cm grid quantization so large scans complete in ~1.5-2.5s.
    """
    from concurrent.futures import ThreadPoolExecutor
    import tempfile
    import subprocess
    from .config import GC_SCAN_OPTIMIZER_DIR

    ts_path = os.path.join(tileset_dir, "tileset.json")
    if not os.path.isfile(ts_path):
        return None
    try:
        with open(ts_path, "r", encoding="utf-8") as tf:
            ts_doc = json.load(tf)
    except Exception:
        return None

    gltf_up = str((ts_doc.get("asset") or {}).get("gltfUpAxis") or "").upper().strip()
    root_nd = ts_doc.get("root")
    if not isinstance(root_nd, dict):
        return None

    def _node_uri_fp(nd: Dict[str, Any]) -> Optional[str]:
        u = str((nd.get("content") or {}).get("uri") or (nd.get("content") or {}).get("url") or "").split("?")[0].strip()
        if u and "{level}" not in u:
            fp = os.path.normpath(os.path.join(tileset_dir, u.replace("/", os.sep)))
            if os.path.isfile(fp):
                return fp
        return None

    def _child_tf(nd: Dict[str, Any], p_tf: np.ndarray) -> np.ndarray:
        ntf = nd.get("transform")
        if isinstance(ntf, list) and len(ntf) == 16:
            return p_tf @ np.array(ntf, dtype=np.float64).reshape((4, 4), order="F")
        return p_tf

    # BFS horizon cut: expand tree level by level until frontier reaches max_horizon_tiles or all leaves
    frontier: List[Tuple[Dict[str, Any], np.ndarray]] = [(root_nd, _child_tf(root_nd, np.eye(4, dtype=np.float64)))]
    while True:
        expandable = [
            (i, nd, tf)
            for i, (nd, tf) in enumerate(frontier)
            if any(isinstance(c, dict) for c in (nd.get("children") or []))
        ]
        if not expandable:
            break
        # Expand one BFS layer if total tiles stays <= max_horizon_tiles (or if current frontier has no valid GLBs)
        next_frontier: List[Tuple[Dict[str, Any], np.ndarray]] = []
        for nd, tf in frontier:
            chs = [c for c in (nd.get("children") or []) if isinstance(c, dict)]
            if chs:
                for ch in chs:
                    next_frontier.append((ch, _child_tf(ch, tf)))
            else:
                next_frontier.append((nd, tf))
        valid_cur = sum(1 for nd, _ in frontier if _node_uri_fp(nd) is not None)
        if len(next_frontier) <= max_horizon_tiles or valid_cur == 0:
            frontier = next_frontier
        else:
            break

    leaf_items: List[Tuple[str, np.ndarray]] = []
    for nd, tf in frontier:
        fp = _node_uri_fp(nd)
        if fp is not None:
            leaf_items.append((fp, tf))

    if not leaf_items:
        return None

    if GC_SCAN_OPTIMIZER_DIR not in sys.path:
        sys.path.insert(0, GC_SCAN_OPTIMIZER_DIR)
    from optimizer.geometry_optimizer import (
        find_gltfpack_binary,
        parse_glb_chunks,
        extract_glb_64bit_origin_to_local,
    )
    from cutter.spatial_cutter import SpatialCutter, _build_gltf_mesh_transforms

    gltfpack = find_gltfpack_binary()
    win_no_window = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000) if os.name == "nt" else 0

    def _decode_one_tile(item: Tuple[str, np.ndarray]) -> Optional[np.ndarray]:
        fp, node_tf = item
        t1, t2 = None, None
        try:
            with open(fp, "rb") as gf:
                loc_b, orig64 = extract_glb_64bit_origin_to_local(gf.read())
            j_p, _ = parse_glb_chunks(loc_b)
            exts = set(j_p.get("extensionsUsed") or [])
            if ("EXT_meshopt_compression" in exts or "KHR_mesh_quantization" in exts) and gltfpack:
                fd1, t1 = tempfile.mkstemp(suffix=".glb")
                with os.fdopen(fd1, "wb") as f1:
                    f1.write(loc_b)
                fd2, t2 = tempfile.mkstemp(suffix=".glb")
                os.close(fd2)
                subprocess.run(
                    [gltfpack, "-i", t1, "-o", t2, "-noq"],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    check=True,
                    creationflags=win_no_window,
                )
                with open(t2, "rb") as f2:
                    j_u, b_u = parse_glb_chunks(f2.read())
            else:
                j_u, b_u = parse_glb_chunks(loc_b)

            m_tf = _build_gltf_mesh_transforms(j_u)
            orig_vec = np.array(orig64, dtype=np.float64)
            tile_pts = []
            for mi, m_obj in enumerate(j_u.get("meshes") or []):
                mat = m_tf.get(mi, np.eye(4, dtype=np.float64))
                for prim in m_obj.get("primitives") or []:
                    attrs = prim.get("attributes") or {}
                    if "POSITION" not in attrs:
                        continue
                    pr, _, acc = SpatialCutter._read_accessor_raw_rows(j_u, b_u, int(attrs["POSITION"]))
                    if int(acc.get("componentType", 0)) != 5126:
                        continue
                    v = np.frombuffer(pr.tobytes(), dtype=np.float32).reshape(-1, 3).astype(np.float64)
                    vg = v @ mat[:3, :3].T + mat[:3, 3] + orig_vec
                    if gltf_up != "Z":
                        vg = np.column_stack([vg[:, 0], -vg[:, 2], vg[:, 1]])
                    if not np.allclose(node_tf, np.eye(4, dtype=np.float64)):
                        vg = vg @ node_tf[:3, :3].T + node_tf[:3, 3]
                    tile_pts.append(vg)
                    if "indices" in prim:
                        idx = SpatialCutter._read_indices_u32(j_u, b_u, int(prim["indices"])).reshape(-1, 3)
                        v0, v1, v2 = vg[idx[:, 0]], vg[idx[:, 1]], vg[idx[:, 2]]
                        tile_pts.append((v0 + v1 + v2) * (1.0 / 3.0))
                        tile_pts.append((v0 + v1) * 0.5)
                        tile_pts.append((v1 + v2) * 0.5)
                        tile_pts.append((v2 + v0) * 0.5)
            if not tile_pts:
                return None
            pts_cat = np.vstack(tile_pts)
            if len(pts_cat) > 40_000:
                vq = np.round(pts_cat * 50.0).astype(np.int64)
                _, u_idx = np.unique(vq, axis=0, return_index=True)
                pts_cat = pts_cat[u_idx]
            return pts_cat
        except Exception:
            return None
        finally:
            for tf_rm in (t1, t2):
                if tf_rm and os.path.exists(tf_rm):
                    try:
                        os.remove(tf_rm)
                    except OSError:
                        pass

    with ThreadPoolExecutor(max_workers=min(12, max(2, len(leaf_items)))) as ex:
        results = [r for r in ex.map(_decode_one_tile, leaf_items) if r is not None and len(r) > 0]

    if not results:
        return None
    all_pts = np.vstack(results)
    if len(all_pts) > 800_000:
        vq = np.round(all_pts * 50.0).astype(np.int64)
        _, u_idx = np.unique(vq, axis=0, return_index=True)
        all_pts = all_pts[u_idx]
    return all_pts


def filter_gsplat_to_surviving_mesh(
    tileset_dir: str,
    folder_path: Optional[str] = None,
    max_dist_m: float = 0.22,
    max_splats: int = 500_000,
) -> Optional[Dict[str, Any]]:
    """
    Prunes any Gaussian Splats in `tileset_dir/tiles/splats.gsplat` that do not correspond to
    surviving mesh geometry in `tileset_dir` (e.g., regions erased via 3D Lasso or cropped out),
    re-centers around the tileset's root boundingVolume box center, and caps at `max_splats`.
    """
    from scipy.spatial import cKDTree

    loaded = read_gsplat_records_and_origin(tileset_dir)
    if loaded is None:
        return None
    recs, old_origin, flags = loaded
    mesh_pts = _extract_surviving_mesh_sample_points_zup(tileset_dir)
    if mesh_pts is None or len(mesh_pts) < 16:
        return None

    pts_ts = recs["pos"].astype(np.float64) + old_origin
    radii = np.clip(np.max(recs["scale"], axis=1).astype(np.float64), 0.0, 0.35)

    m_min = mesh_pts.min(axis=0) - (max_dist_m + 0.35)
    m_max = mesh_pts.max(axis=0) + (max_dist_m + 0.35)
    in_bbox = (
        (pts_ts[:, 0] >= m_min[0]) & (pts_ts[:, 0] <= m_max[0])
        & (pts_ts[:, 1] >= m_min[1]) & (pts_ts[:, 1] <= m_max[1])
        & (pts_ts[:, 2] >= m_min[2]) & (pts_ts[:, 2] <= m_max[2])
    )
    cand_indices = np.where(in_bbox)[0]
    if len(cand_indices) == 0:
        return None

    tree = cKDTree(mesh_pts)
    dists, _ = tree.query(pts_ts[cand_indices], k=1, workers=-1)
    near_ok = dists <= (max_dist_m + 0.5 * radii[cand_indices])
    keep_indices = cand_indices[near_ok]
    if len(keep_indices) < 16:
        return None

    if max_splats and max_splats > 0 and len(keep_indices) > max_splats:
        keep_indices = keep_indices[: int(max_splats)]

    kept_recs = recs[keep_indices].copy()
    kept_pts_ts = pts_ts[keep_indices]

    new_origin = old_origin.copy()
    ts_path = os.path.join(tileset_dir, "tileset.json")
    if os.path.isfile(ts_path):
        try:
            with open(ts_path, "r", encoding="utf-8") as tf:
                ts_doc = json.load(tf)
            r_box = ((ts_doc.get("root") or {}).get("boundingVolume") or {}).get("box")
            if isinstance(r_box, list) and len(r_box) >= 3:
                cand_o = np.array([float(r_box[0]), float(r_box[1]), float(r_box[2])], dtype=np.float64)
                if np.linalg.norm(cand_o - old_origin) < 10000.0:
                    new_origin = cand_o
        except Exception:
            pass

    kept_recs["pos"] = (kept_pts_ts - new_origin).astype(np.float32)
    n_kept = len(kept_recs)
    gs_path = os.path.join(tileset_dir, "tiles", "splats.gsplat")
    header_bytes = struct.pack("<4sIII", b"GSPL", 1, n_kept, flags)
    raw_blob = header_bytes + kept_recs.tobytes()
    with open(gs_path, "wb") as wf:
        wf.write(raw_blob)
    _write_gsplat_gz_sidecar(gs_path, raw_blob)

    gs_mtime = int(os.path.getmtime(gs_path))
    splat_size_mb = round(len(raw_blob) / (1024.0 * 1024.0), 2)
    splat_uri_rel = f"tiles/splats.gsplat?v={gs_mtime}"
    splat_origin_list = [round(float(new_origin[0]), 4), round(float(new_origin[1]), 4), round(float(new_origin[2]), 4)]

    _sync_tileset_and_meta_gsplat_fields(
        tileset_dir,
        folder_path,
        splat_uri_rel,
        splat_origin_list,
        n_kept,
        splat_size_mb,
        also_update_backup=False,
    )
    print(
        f"[GaussianSplatBuilder] Filtered .gsplat to surviving mesh in {tileset_dir}: "
        f"kept {n_kept:,} / {len(recs):,} splats ({splat_size_mb} MB)"
    )
    return {
        "splats_kept": int(n_kept),
        "splats_deleted": int(len(recs) - n_kept),
        "splat_size_mb": splat_size_mb,
        "gaussian_splat_uri": splat_uri_rel,
        "gaussian_splat_origin": splat_origin_list,
    }


def restore_gsplat_region_from_backup(
    ts_dir: str,
    proj_dir: str,
    scan: Dict[str, Any],
    cutter_eval: Any,
    db: Any = None,
    max_splats: int = 500_000,
) -> int:
    """
    Restores missing Gaussian Splats inside `cutter_eval` from `tileset_backup`, `tileset_prev`,
    or `derived_from_scan_id` into `ts_dir/tiles/splats.gsplat`.
    """
    from scipy.spatial import cKDTree
    from .config import LOCAL_SCANS_ROOT

    cur_loaded = read_gsplat_records_and_origin(ts_dir)
    if cur_loaded is None:
        return 0
    cur_recs, cur_origin, cur_flags = cur_loaded

    cand_bkp_dirs = [
        os.path.join(proj_dir, "tileset_backup"),
        os.path.join(proj_dir, "tileset_prev"),
    ]
    cur_sid = str(scan.get("derived_from_scan_id") or "").strip()
    visited = set()
    for _ in range(6):
        if not cur_sid or cur_sid in visited:
            break
        visited.add(cur_sid)
        cand_bkp_dirs.append(os.path.join(LOCAL_SCANS_ROOT, cur_sid, "tileset"))
        if db is not None and hasattr(db, "get_scan"):
            p_sc = db.get_scan(cur_sid) or {}
            if p_sc.get("project_dir"):
                cand_bkp_dirs.append(os.path.join(str(p_sc["project_dir"]), "tileset"))
            cur_sid = str(p_sc.get("derived_from_scan_id") or "").strip()
        else:
            break

    bkp_loaded = None
    for b_dir in cand_bkp_dirs:
        if os.path.isdir(b_dir) and os.path.abspath(b_dir) != os.path.abspath(ts_dir):
            bkp_loaded = read_gsplat_records_and_origin(b_dir)
            if bkp_loaded is not None:
                break
    if bkp_loaded is None:
        return 0

    bkp_recs, bkp_origin, _ = bkp_loaded
    bkp_pts_ts = bkp_recs["pos"].astype(np.float64) + bkp_origin
    bkp_radii = np.max(bkp_recs["scale"], axis=1).astype(np.float64)
    in_mask = evaluate_points_in_cutter(cutter_eval, bkp_pts_ts, bkp_radii)
    cand_idx = np.where(in_mask)[0]
    if len(cand_idx) == 0:
        return 0

    cur_pts_ts = cur_recs["pos"].astype(np.float64) + cur_origin
    if len(cur_pts_ts) > 0:
        tree_cur = cKDTree(cur_pts_ts)
        dists, _ = tree_cur.query(bkp_pts_ts[cand_idx], k=1, workers=-1)
        cand_idx = cand_idx[dists > 0.015]
    if len(cand_idx) == 0:
        return 0

    add_recs = bkp_recs[cand_idx].copy()
    add_recs["pos"] = (bkp_pts_ts[cand_idx] - cur_origin).astype(np.float32)
    merged_recs = np.concatenate([cur_recs, add_recs])

    # Re-sort by visual importance descending and cap at max_splats
    sc_m = merged_recs["scale"]
    max_s = np.maximum(np.maximum(sc_m[:, 0], sc_m[:, 1]), sc_m[:, 2])
    imp = (merged_recs["rgba"][:, 3].astype(np.float32) / 255.0) * (np.maximum(max_s, 1e-5) ** 1.35)
    order = np.argsort(-imp)
    if max_splats and max_splats > 0 and len(order) > max_splats:
        order = order[: int(max_splats)]
    merged_recs = merged_recs[order].copy()

    n_total = len(merged_recs)
    gs_path = os.path.join(ts_dir, "tiles", "splats.gsplat")
    header_bytes = struct.pack("<4sIII", b"GSPL", 1, n_total, cur_flags)
    raw_blob = header_bytes + merged_recs.tobytes()
    with open(gs_path, "wb") as wf:
        wf.write(raw_blob)
    _write_gsplat_gz_sidecar(gs_path, raw_blob)

    gs_mtime = int(os.path.getmtime(gs_path))
    splat_size_mb = round(len(raw_blob) / (1024.0 * 1024.0), 2)
    splat_uri_rel = f"tiles/splats.gsplat?v={gs_mtime}"
    splat_origin_list = [round(float(cur_origin[0]), 4), round(float(cur_origin[1]), 4), round(float(cur_origin[2]), 4)]
    _sync_tileset_and_meta_gsplat_fields(ts_dir, proj_dir, splat_uri_rel, splat_origin_list, n_total, splat_size_mb)
    return int(len(cand_idx))


def transform_gsplat_crs_in_place(
    ts_dir: str,
    off_x: float,
    off_y: float,
    off_z: float,
    J_2x2: Optional[np.ndarray] = None,
    pivot_xy: Optional[Tuple[float, float]] = None,
    j_2x2: Optional[np.ndarray] = None,
    **_kwargs: Any,
) -> None:
    """Updates `gaussian_splat_origin` and local splat positions/scales/quaternions when CRS is transformed."""
    loaded = read_gsplat_records_and_origin(ts_dir)
    if loaded is None:
        return
    recs, old_origin, flags = loaded
    pts_ts = recs["pos"].astype(np.float64) + old_origin

    J = J_2x2 if J_2x2 is not None else j_2x2
    if J is not None:
        J_mat = np.asarray(J, dtype=np.float64).reshape(2, 2)
        if pivot_xy is not None:
            px, py = float(pivot_xy[0]), float(pivot_xy[1])
        else:
            px, py = float(old_origin[0]), float(old_origin[1])
        dxy = pts_ts[:, :2] - np.array([px, py], dtype=np.float64)
        pts_ts[:, :2] = np.array([px, py], dtype=np.float64) + (dxy @ J_mat.T)
        det_j = float(np.linalg.det(J_mat))
        if det_j > 1e-6:
            k_xy = math.sqrt(det_j)
            if abs(k_xy - 1.0) > 1e-5:
                recs["scale"] = (recs["scale"].astype(np.float64) * k_xy).astype(np.float32)
            R_3x3 = np.eye(3, dtype=np.float64)
            R_3x3[:2, :2] = J_mat / k_xy
            recs["quat"] = _rotate_packed_quats_by_matrix(recs["quat"], R_3x3)

    pts_ts[:, 0] += float(off_x)
    pts_ts[:, 1] += float(off_y)
    pts_ts[:, 2] += float(off_z)

    new_origin = old_origin + np.array([float(off_x), float(off_y), float(off_z)], dtype=np.float64)
    ts_path = os.path.join(ts_dir, "tileset.json")
    if os.path.isfile(ts_path):
        try:
            with open(ts_path, "r", encoding="utf-8") as tf:
                ts_doc = json.load(tf)
            r_box = ((ts_doc.get("root") or {}).get("boundingVolume") or {}).get("box")
            if isinstance(r_box, list) and len(r_box) >= 3:
                new_origin = np.array([float(r_box[0]), float(r_box[1]), float(r_box[2])], dtype=np.float64)
        except Exception:
            pass

    recs["pos"] = (pts_ts - new_origin).astype(np.float32)
    gs_path = os.path.join(ts_dir, "tiles", "splats.gsplat")
    header_bytes = struct.pack("<4sIII", b"GSPL", 1, len(recs), flags)
    raw_blob = header_bytes + recs.tobytes()
    with open(gs_path, "wb") as wf:
        wf.write(raw_blob)
    _write_gsplat_gz_sidecar(gs_path, raw_blob)

    gs_mtime = int(os.path.getmtime(gs_path))
    splat_size_mb = round(len(raw_blob) / (1024.0 * 1024.0), 2)
    splat_uri_rel = f"tiles/splats.gsplat?v={gs_mtime}"
    splat_origin_list = [round(float(new_origin[0]), 4), round(float(new_origin[1]), 4), round(float(new_origin[2]), 4)]
    _sync_tileset_and_meta_gsplat_fields(ts_dir, os.path.dirname(os.path.abspath(ts_dir)), splat_uri_rel, splat_origin_list, len(recs), splat_size_mb)


def apply_flatten_zones_to_gsplat(tileset_dir: str, active_zones: List[Dict[str, Any]]) -> int:
    """
    Applies Slope-Preserving Flatten Zones (`active_zones` prepared by `_apply_slope_preserving_flatten_zones_to_tileset`)
    to `tileset_dir/tiles/splats.gsplat` (+ `.gz`) so Gaussian Splat elevations match the flattened ground surface.
    """
    if not active_zones:
        return 0
    loaded = read_gsplat_records_and_origin(tileset_dir)
    if loaded is None:
        return 0
    recs, origin, flags = loaded
    if len(recs) == 0:
        return 0

    import shapely

    pos_zup = recs["pos"].astype(np.float64) + origin
    total_splats_flattened = 0
    any_mod = False

    for zn in active_zones:
        zminx, zminy, zmaxx, zmaxy = zn["bounds"]
        cand_m = (
            (pos_zup[:, 0] >= zminx)
            & (pos_zup[:, 0] <= zmaxx)
            & (pos_zup[:, 1] >= zminy)
            & (pos_zup[:, 1] <= zmaxy)
            & (pos_zup[:, 2] >= zn["min_z"])
            & (pos_zup[:, 2] <= zn["max_z"])
        )
        c_idx = np.where(cand_m)[0]
        if len(c_idx) == 0:
            continue
        in_p = np.asarray(shapely.contains_xy(zn["poly"], pos_zup[c_idx, 0], pos_zup[c_idx, 1]), dtype=bool)
        hit_idx = c_idx[in_p]
        if len(hit_idx) == 0:
            continue
        hx = pos_zup[hit_idx, 0]
        hy = pos_zup[hit_idx, 1]
        hz = pos_zup[hit_idx, 2]
        coef = zn["coef"]
        z_plane = coef[0] * (hx - zn["cx"]) + coef[1] * (hy - zn["cy"]) + coef[2]
        res_h = z_plane - hz
        abs_r = np.abs(res_h)
        v_weight = np.where(
            abs_r <= zn["max_res_m"],
            1.0,
            np.clip(1.0 - (abs_r - zn["max_res_m"]) / 0.25, 0.0, 1.0),
        )
        if zn["feather_m"] > 0.05 and hasattr(shapely, "points"):
            pts_geom = shapely.points(hx, hy)
            d_edge = np.asarray(shapely.distance(zn["ext_ring"], pts_geom), dtype=np.float64)
            f_weight = np.clip(d_edge / zn["feather_m"], 0.15, 1.0)
        else:
            f_weight = 1.0
        eff_alpha = zn["strength"] * v_weight * f_weight
        active_v = eff_alpha > 0.001
        if np.any(active_v):
            pos_zup[hit_idx, 2] = hz + eff_alpha * res_h
            total_splats_flattened += int(np.count_nonzero(active_v))
            any_mod = True

    if any_mod:
        recs["pos"] = (pos_zup - origin).astype(np.float32)
        gs_path = os.path.join(tileset_dir, "tiles", "splats.gsplat")
        header_bytes = struct.pack("<4sIII", b"GSPL", 1, len(recs), flags)
        raw_blob = header_bytes + recs.tobytes()
        with open(gs_path, "wb") as wf:
            wf.write(raw_blob)
        _write_gsplat_gz_sidecar(gs_path, raw_blob)
        gs_mtime = int(os.path.getmtime(gs_path))
        splat_size_mb = round(len(raw_blob) / (1024.0 * 1024.0), 2)
        splat_uri_rel = f"tiles/splats.gsplat?v={gs_mtime}"
        splat_origin_list = [round(float(origin[0]), 4), round(float(origin[1]), 4), round(float(origin[2]), 4)]
        _sync_tileset_and_meta_gsplat_fields(
            tileset_dir,
            os.path.dirname(os.path.abspath(tileset_dir)),
            splat_uri_rel,
            splat_origin_list,
            len(recs),
            splat_size_mb,
            also_update_backup=False,
        )

    return total_splats_flattened


def _evaluate_multiscan_gsplat_deletions(
    pts_centered: np.ndarray,
    radii: np.ndarray,
    scan_id: str,
    deletions: List[Dict[str, Any]],
) -> np.ndarray:
    """Evaluates multi-scan staged deletions on a single layer's centered Z-up splat positions `pts_centered`."""
    n = len(pts_centered)
    overall_del = np.zeros(n, dtype=bool)
    if n == 0 or not deletions:
        return overall_del

    import shapely
    from shapely.geometry import Polygon as ShapelyPolygon

    for batch in deletions:
        if not isinstance(batch, dict):
            continue
        batch_mask = np.zeros(n, dtype=bool)
        for st in batch.get("frustum_strokes") or []:
            if not isinstance(st, dict):
                continue
            tgt = st.get("target_scan_id")
            if tgt and tgt != "all" and tgt != scan_id:
                continue
            poly_ndc = st.get("polygon_ndc") or []
            mvp = st.get("mvp_elements") or []
            if len(poly_ndc) < 3 or len(mvp) != 16:
                continue
            try:
                ndc_poly = ShapelyPolygon([(float(p[0]), float(p[1])) for p in poly_ndc])
                if not ndc_poly.is_valid:
                    ndc_poly = ndc_poly.buffer(0)
            except Exception:
                continue
            m = np.array([float(x) for x in mvp], dtype=np.float64).reshape((4, 4), order="F")
            # pts_centered is Z-up (x, y, z) -> Three.js local Y-up (x, z, -y)
            tx = pts_centered[:, 0]
            ty = pts_centered[:, 2]
            tz = -pts_centered[:, 1]
            cw = m[3, 0] * tx + m[3, 1] * ty + m[3, 2] * tz + m[3, 3]
            valid_w = cw > 1e-5
            if not np.any(valid_w):
                continue
            v_idx = np.where(valid_w)[0]
            inv_w = 1.0 / cw[v_idx]
            nx = (m[0, 0] * tx[v_idx] + m[0, 1] * ty[v_idx] + m[0, 2] * tz[v_idx] + m[0, 3]) * inv_w
            ny = (m[1, 0] * tx[v_idx] + m[1, 1] * ty[v_idx] + m[1, 2] * tz[v_idx] + m[1, 3]) * inv_w
            nz = (m[2, 0] * tx[v_idx] + m[2, 1] * ty[v_idx] + m[2, 2] * tz[v_idx] + m[2, 3]) * inv_w
            in_fr = (nx >= -1.05) & (nx <= 1.05) & (ny >= -1.05) & (ny <= 1.05) & (nz >= -1.05) & (nz <= 1.05)
            f_sub = v_idx[in_fr]
            if len(f_sub) == 0:
                continue
            in_poly = np.asarray(shapely.contains_xy(ndc_poly, nx[in_fr], ny[in_fr]), dtype=bool)
            hit_idx = f_sub[in_poly]
            if len(hit_idx) > 0:
                batch_mask[hit_idx] = True

        for pg in batch.get("polygons") or []:
            pts_raw = pg.get("points") if isinstance(pg, dict) else pg
            tgt = pg.get("target_scan_id") if isinstance(pg, dict) else None
            if tgt and tgt != "all" and tgt != scan_id:
                continue
            if not isinstance(pts_raw, list) or len(pts_raw) < 3:
                continue
            try:
                poly_2d = ShapelyPolygon([(float(p[0]), float(p[1])) for p in pts_raw])
                if not poly_2d.is_valid:
                    poly_2d = poly_2d.buffer(0)
            except Exception:
                continue
            p_minz = float(pg.get("min_z")) if isinstance(pg, dict) and pg.get("min_z") is not None else None
            p_maxz = float(pg.get("max_z")) if isinstance(pg, dict) and pg.get("max_z") is not None else None
            # 2D polygons in multi-scan align use Three.js (X, Z) = (pts_centered[:, 0], -pts_centered[:, 1])
            px_3 = pts_centered[:, 0]
            pz_3 = -pts_centered[:, 1]
            py_3 = pts_centered[:, 2]
            in_2d = np.asarray(shapely.contains_xy(poly_2d, px_3, pz_3), dtype=bool)
            if p_minz is not None:
                in_2d &= (py_3 + radii) >= p_minz
            if p_maxz is not None:
                in_2d &= (py_3 - radii) <= p_maxz
            batch_mask |= in_2d

        sb = batch.get("section_box")
        if isinstance(sb, dict) and np.any(batch_mask):
            # Section box clip in Three.js space
            c_sb = sb.get("center") or [0.0, 0.0, 0.0]
            he_sb = sb.get("half_extents") or [1e9, 1e9, 1e9]
            yaw_r = float(sb.get("yaw_rad") or 0.0)
            cos_y, sin_y = math.cos(-yaw_r), math.sin(-yaw_r)
            dx = pts_centered[:, 0] - float(c_sb[0])
            dy = pts_centered[:, 2] - float(c_sb[1])
            dz = (-pts_centered[:, 1]) - float(c_sb[2])
            lx = dx * cos_y + dz * sin_y
            lz = -dx * sin_y + dz * cos_y
            in_sb = (
                (np.abs(lx) <= float(he_sb[0]) + radii)
                & (np.abs(dy) <= float(he_sb[1]) + radii)
                & (np.abs(lz) <= float(he_sb[2]) + radii)
            )
            batch_mask &= in_sb

        overall_del |= batch_mask

    return overall_del


def merge_gsplat_layers_for_unified_scan(
    ts_work_dir: str,
    work_proj_dir: str,
    layer_transforms_by_sid: Dict[str, Dict[str, Any]],
    raw_deletions: Optional[List[Dict[str, Any]]] = None,
    new_origin: Optional[np.ndarray] = None,
     brightness_by_sid: Optional[Dict[str, float]] = None,
    max_splats: int = 500_000,
) -> Optional[Dict[str, Any]]:
    """
    Fuses `.gsplat` layers across aligned source scans in `run_merge_scans_action`, applying each
    layer's 6-DOF transform (`na`, `ma`, `R`), filtering multi-scan staged `raw_deletions`,
    and writing `ts_work_dir/tiles/splats.gsplat` (+ `.gz`).
    """
    from .config import LOCAL_SCANS_ROOT

    if not layer_transforms_by_sid:
        return None

    merged_chunks: List[np.ndarray] = []
    any_flags = 0

    for sid, tf_info in layer_transforms_by_sid.items():
        sc = tf_info.get("sc") or {}
        cand_ts_dirs = []
        if sc.get("project_dir"):
            cand_ts_dirs.append(os.path.join(str(sc["project_dir"]), "tileset"))
        cand_ts_dirs.append(os.path.join(LOCAL_SCANS_ROOT, str(sid), "tileset"))
        loaded = None
        for c_dir in cand_ts_dirs:
            if os.path.isdir(c_dir):
                loaded = read_gsplat_records_and_origin(c_dir)
                if loaded is not None:
                    break
        if loaded is None:
            continue
        recs, old_origin, flags = loaded
        if len(recs) == 0:
            continue
        any_flags |= int(flags)

        na = np.asarray(tf_info["na"], dtype=np.float64)
        ma = np.asarray(tf_info["ma"], dtype=np.float64)
        R = np.asarray(tf_info["R"], dtype=np.float64).reshape(3, 3)

        pts_world = recs["pos"].astype(np.float64) + old_origin
        pts_centered = pts_world - na
        radii = np.max(recs["scale"], axis=1).astype(np.float64)

        if raw_deletions:
            del_mask = _evaluate_multiscan_gsplat_deletions(pts_centered, radii, str(sid), raw_deletions)
            if np.any(del_mask):
                recs = recs[~del_mask].copy()
                pts_centered = pts_centered[~del_mask]
                if len(recs) == 0:
                    continue
            else:
                recs = recs.copy()
        else:
            recs = recs.copy()

        pts_merged = ma + (pts_centered @ R.T)
        recs["quat"] = _rotate_packed_quats_by_matrix(recs["quat"], R)

        b_fac = float((brightness_by_sid or {}).get(sid, 1.0))
        if abs(b_fac - 1.0) > 0.01:
            rgb_f = recs["rgba"][:, :3].astype(np.float32) * b_fac
            recs["rgba"][:, :3] = np.clip(np.round(rgb_f), 0, 255).astype(np.uint8)

        # Store world merged coordinates temporarily in a float64 copy via tuple
        merged_chunks.append((recs, pts_merged))

    if not merged_chunks:
        return None

    all_recs = np.concatenate([c[0] for c in merged_chunks])
    all_pts_w = np.vstack([c[1] for c in merged_chunks])

    if new_origin is not None and len(new_origin) >= 3:
        origin_vec = np.array([float(new_origin[0]), float(new_origin[1]), float(new_origin[2])], dtype=np.float64)
    else:
        origin_vec = np.median(all_pts_w, axis=0)

    all_recs["pos"] = (all_pts_w - origin_vec).astype(np.float32)

    # Sort by visual importance descending and cap at max_splats
    sc_m = all_recs["scale"]
    max_s = np.maximum(np.maximum(sc_m[:, 0], sc_m[:, 1]), sc_m[:, 2])
    imp = (all_recs["rgba"][:, 3].astype(np.float32) / 255.0) * (np.maximum(max_s, 1e-5) ** 1.35)
    order = np.argsort(-imp)
    if max_splats and max_splats > 0 and len(order) > max_splats:
        order = order[: int(max_splats)]
    all_recs = all_recs[order].copy()

    n_total = len(all_recs)
    tiles_dir = os.path.join(ts_work_dir, "tiles")
    os.makedirs(tiles_dir, exist_ok=True)
    gs_path = os.path.join(tiles_dir, "splats.gsplat")
    header_bytes = struct.pack("<4sIII", b"GSPL", 1, n_total, any_flags)
    raw_blob = header_bytes + all_recs.tobytes()
    with open(gs_path, "wb") as wf:
        wf.write(raw_blob)
    _write_gsplat_gz_sidecar(gs_path, raw_blob)

    gs_mtime = int(os.path.getmtime(gs_path))
    splat_size_mb = round(len(raw_blob) / (1024.0 * 1024.0), 2)
    splat_uri_rel = f"tiles/splats.gsplat?v={gs_mtime}"
    splat_origin_list = [round(float(origin_vec[0]), 4), round(float(origin_vec[1]), 4), round(float(origin_vec[2]), 4)]

    _sync_tileset_and_meta_gsplat_fields(
        ts_work_dir,
        work_proj_dir,
        splat_uri_rel,
        splat_origin_list,
        n_total,
        splat_size_mb,
        also_update_backup=False,
    )
    return {
        "has_gaussian_splat_layer": True,
        "gaussian_splat_uri": splat_uri_rel,
        "gaussian_splat_origin": splat_origin_list,
        "splat_count": int(n_total),
        "splat_size_mb": splat_size_mb,
    }


def attach_gaussian_splat_layer_to_tileset(
    scan_id: str,
    folder_path: str,
    ply_path: str,
    tileset_json_path: Optional[str] = None,
    max_splats: int = 500_000,
    cleanup_raw_ply: bool = True,
) -> Optional[Dict[str, Any]]:
    """
    Converts a PIX4Dmatic exported 3DGS `.ply` (`exports/gaussian_splats/splats.ply`)
    into a coordinate-locked `tileset/tiles/splats.gsplat` layer aligned with the
    existing 3D Mesh `tileset/tileset.json` and `offset.xyz` (TWD97 EPSG:3826 + TWVD2001).
    Preserves `is_gaussian_splat: False` on the mesh tileset so all 3-tier LOD mesh tiles
    and 1mm raycast measurements work normally, while advertising `has_gaussian_splat_layer: True`
    and `gaussian_splat_uri` so Studio can toggle seamlessly between Mesh and 3DGS.
    """
    import shutil

    if not ply_path or not os.path.isfile(ply_path):
        return None

    tileset_dir = os.path.dirname(tileset_json_path) if tileset_json_path else os.path.join(folder_path, "tileset")
    ts_path = tileset_json_path or os.path.join(tileset_dir, "tileset.json")
    if not os.path.isfile(ts_path):
        # Fallback: standalone Gaussian splat tileset build
        built_ts = build_gaussian_splat_tileset(scan_id, folder_path, ply_path, force=True)
        if built_ts and os.path.isfile(built_ts):
            return {"tileset_path": built_ts, "splat_uri": "tiles/splats.gsplat"}
        return None

    tiles_sub = os.path.join(tileset_dir, "tiles")
    os.makedirs(tiles_sub, exist_ok=True)
    gsplat_bin_path = os.path.join(tiles_sub, "splats.gsplat")

    raw_data = load_gaussian_splats_raw(ply_path)
    xyz = raw_data["xyz"].astype(np.float64)
    scale = raw_data["scale"].astype(np.float32)
    rgba = raw_data["rgba"].astype(np.float32)
    quat = raw_data["quat"].astype(np.float32)

    valid_mask = (
        np.isfinite(xyz).all(axis=1)
        & np.isfinite(scale).all(axis=1)
        & (rgba[:, 3] >= (1.5 / 255.0))
    )
    if np.count_nonzero(valid_mask) >= 16:
        xyz = xyz[valid_mask]
        scale = scale[valid_mask]
        rgba = rgba[valid_mask]
        quat = quat[valid_mask]

    if len(xyz) == 0:
        return None

    # Resolve offset.xyz from ply dir, exports/obj_mesh, tileset, or project root
    cand_offsets = [
        os.path.join(os.path.dirname(ply_path), "offset.xyz"),
        os.path.join(folder_path, "exports", "obj_mesh", "offset.xyz"),
        os.path.join(tileset_dir, "offset.xyz"),
        os.path.join(folder_path, "offset.xyz"),
    ]
    ox, oy, oz = 0.0, 0.0, 0.0
    for c_fp in cand_offsets:
        if os.path.isfile(c_fp):
            try:
                with open(c_fp, "r", encoding="utf-8", errors="ignore") as f_off:
                    parts = f_off.read().strip().split()
                if len(parts) >= 3:
                    cand_x, cand_y, cand_z = float(parts[0]), float(parts[1]), float(parts[2])
                    if abs(cand_x) > 1.0 or abs(cand_y) > 1.0 or abs(cand_z) > 1e-3:
                        ox, oy, oz = cand_x, cand_y, cand_z
                        break
            except Exception:
                pass

    med_x = float(np.median(xyz[:, 0]))
    med_y = float(np.median(xyz[:, 1]))
    med_z = float(np.median(xyz[:, 2]))

    # Determine full 64-bit TWD97 world coordinates for every splat
    if abs(med_x) > 10000.0 or abs(med_y) > 10000.0:
        # PLY vertices are already in projected coordinates (either TWD97 or UTM 51N)
        if 330000.0 < med_x < 450000.0 and 2400000.0 < med_y < 2900000.0:
            try:
                from pc_worker.gdrive_watcher import utm51n_to_wgs84, wgs84_to_twd97
                u0, v0 = med_x, med_y
                e0, n0, _ = wgs84_to_twd97(*utm51n_to_wgs84(u0, v0))
                ex, nx, _ = wgs84_to_twd97(*utm51n_to_wgs84(u0 + 100.0, v0))
                ey, ny, _ = wgs84_to_twd97(*utm51n_to_wgs84(u0, v0 + 100.0))
                j00, j01 = (ex - e0) / 100.0, (ey - e0) / 100.0
                j10, j11 = (nx - n0) / 100.0, (ny - n0) / 100.0
                dx = xyz[:, 0] - u0
                dy = xyz[:, 1] - v0
                xyz_twd = np.column_stack([e0 + j00 * dx + j01 * dy, n0 + j10 * dx + j11 * dy, xyz[:, 2]])
            except Exception:
                xyz_twd = xyz
        else:
            xyz_twd = xyz
        has_georef = True
    elif abs(ox) > 100.0 and abs(oy) > 100.0:
        # PLY vertices are in local Scene coordinates relative to offset.xyz (ox, oy, oz)
        xyz_twd = xyz + np.array([ox, oy, oz], dtype=np.float64)
        has_georef = True
    else:
        xyz_twd = xyz
        has_georef = False

    # Use the existing tileset root boundingVolume box center if available so splatOrigin matches sphere.center
    origin_x = float(np.median(xyz_twd[:, 0]))
    origin_y = float(np.median(xyz_twd[:, 1]))
    origin_z = float(np.median(xyz_twd[:, 2]))
    try:
        with open(ts_path, "r", encoding="utf-8") as tf_r:
            ts_existing = json.load(tf_r)
        r_box = ((ts_existing.get("root") or {}).get("boundingVolume") or {}).get("box")
        if isinstance(r_box, list) and len(r_box) >= 3:
            bx, by, bz = float(r_box[0]), float(r_box[1]), float(r_box[2])
            if math.hypot(bx - origin_x, by - origin_y) < 5000.0:
                origin_x, origin_y, origin_z = bx, by, bz
    except Exception:
        pass

    xyz_zup = (xyz_twd - np.array([origin_x, origin_y, origin_z], dtype=np.float64)).astype(np.float32)
    quat_zup = quat.astype(np.float32)

    # Sort splats by visual importance descending
    max_s = np.maximum(np.maximum(scale[:, 0], scale[:, 1]), scale[:, 2])
    importance = rgba[:, 3] * (max_s ** 1.35)
    imp_order = np.argsort(-importance)

    # Check if this scan has trimmed/edited mesh geometry so we keep more candidates before mesh-proximity filtering
    meta_fp = os.path.join(folder_path, "scan_meta.json")
    is_edited_scan = str(scan_id or "").startswith("edited_")
    if not is_edited_scan and os.path.isfile(meta_fp):
        try:
            with open(meta_fp, "r", encoding="utf-8") as mf:
                m_chk = json.load(mf)
            is_edited_scan = bool(m_chk.get("applied_adjustments") or m_chk.get("derived_from_scan_id"))
        except Exception:
            pass

    initial_cap = max(int(max_splats or 500_000), 2_000_000) if is_edited_scan else int(max_splats or 500_000)
    if initial_cap > 0 and len(imp_order) > initial_cap:
        imp_order = imp_order[:initial_cap]

    xyz_zup = xyz_zup[imp_order]
    scale = scale[imp_order]
    rgba = rgba[imp_order]
    quat_zup = quat_zup[imp_order]
    n_total = len(xyz_zup)

    recs = np.empty(n_total, dtype=GSPLAT_REC_DTYPE)
    recs["pos"] = xyz_zup
    recs["scale"] = scale
    recs["rgba"] = np.clip(np.round(rgba * 255.0), 0, 255).astype(np.uint8)
    quat_xyzw = np.column_stack([quat_zup[:, 1], quat_zup[:, 2], quat_zup[:, 3], quat_zup[:, 0]])
    recs["quat"] = np.clip(np.round((quat_xyzw * 0.5 + 0.5) * 255.0), 0, 255).astype(np.uint8)

    header_bytes = struct.pack("<4sIII", b"GSPL", 1, n_total, 1 if has_georef else 0)
    raw_blob = header_bytes + recs.tobytes()
    with open(gsplat_bin_path, "wb") as gf:
        gf.write(raw_blob)
    _write_gsplat_gz_sidecar(gsplat_bin_path, raw_blob)

    gsplat_mtime = int(os.path.getmtime(gsplat_bin_path))
    splat_size_mb = round(os.path.getsize(gsplat_bin_path) / (1024.0 * 1024.0), 2)
    splat_uri_rel = f"tiles/splats.gsplat?v={gsplat_mtime}"
    splat_origin_list = [round(origin_x, 4), round(origin_y, 4), round(origin_z, 4)]

    _sync_tileset_and_meta_gsplat_fields(
        tileset_dir,
        folder_path,
        splat_uri_rel,
        splat_origin_list,
        n_total,
        splat_size_mb,
        also_update_backup=True,
    )

    # Copy splats.gsplat into tileset_backup/tiles/ if backup exists
    backup_tiles_dir = os.path.join(folder_path, "tileset_backup", "tiles")
    if os.path.isdir(backup_tiles_dir):
        try:
            shutil.copy2(gsplat_bin_path, os.path.join(backup_tiles_dir, "splats.gsplat"))
            if os.path.isfile(gsplat_bin_path + ".gz"):
                shutil.copy2(gsplat_bin_path + ".gz", os.path.join(backup_tiles_dir, "splats.gsplat.gz"))
        except Exception:
            pass

    if is_edited_scan:
        try:
            filt_res = filter_gsplat_to_surviving_mesh(
                tileset_dir, folder_path=folder_path, max_dist_m=0.22, max_splats=int(max_splats or 500_000)
            )
            if isinstance(filt_res, dict):
                n_total = int(filt_res["splats_kept"])
                splat_size_mb = float(filt_res["splat_size_mb"])
                splat_uri_rel = str(filt_res["gaussian_splat_uri"])
                splat_origin_list = list(filt_res["gaussian_splat_origin"])
        except Exception as fe:
            print(f"[GaussianSplatBuilder] Note filtering edited scan splats for {scan_id}: {fe}")

    if cleanup_raw_ply and os.path.isfile(gsplat_bin_path) and os.path.getsize(gsplat_bin_path) > 64:
        try:
            os.remove(ply_path)
            print(f"[GaussianSplatBuilder] Cleaned up intermediate raw PLY {ply_path} after building {splat_size_mb} MB .gsplat")
        except OSError:
            pass

    print(
        f"[GaussianSplatBuilder] Attached hybrid 3DGS layer to '{scan_id}' "
        f"({n_total:,} splats, {splat_size_mb} MB, origin={splat_origin_list}) -> {gsplat_bin_path}"
    )
    return {
        "status": "ok",
        "has_gaussian_splat_layer": True,
        "gsplat_path": gsplat_bin_path,
        "gaussian_splat_uri": splat_uri_rel,
        "gaussian_splat_origin": splat_origin_list,
        "splat_count": int(n_total),
        "splat_size_mb": splat_size_mb,
    }

