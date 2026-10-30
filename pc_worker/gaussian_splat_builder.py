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
        mat = np.loadtxt(lines[:n_verts], dtype=np.float32)
        if mat.ndim == 1:
            mat = mat.reshape(1, -1)
        data_dict = {name: mat[:, idx] for idx, name in enumerate(prop_names)}
    else:
        np_fields = [(p_name, _PLY_NP_DTYPES.get(p_type, "<f4")) for p_type, p_name in props]
        dt = np.dtype(np_fields)
        arr = np.frombuffer(raw, dtype=dt, count=n_verts, offset=body_offset)
        data_dict = {name: arr[name].astype(np.float32) for name in prop_names}

    xyz = np.column_stack([data_dict["x"], data_dict["y"], data_dict["z"]]).astype(np.float32)

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
    with open(gsplat_bin_path, "wb") as gf:
        gf.write(header_bytes)
        gf.write(recs.tobytes())

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
            "gaussian_splat_uri": f"tiles/splats.gsplat?v={gsplat_mtime}",
            "splat_count": int(n_total),
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
                "splat_count": int(n_total),
                "gaussian_splat_uri": f"tiles/splats.gsplat?v={gsplat_mtime}",
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
