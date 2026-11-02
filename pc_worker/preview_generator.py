#!/usr/bin/env python3
"""
3D Scan Interactive Preview & Full-Quality Zoomed-to-Extents Screenshot Generator
for GatheringScans.

1. `ensure_scan_low_quality_preview(tileset_path)`:
   Generates a clean, watertight, fast-loading 3D preview (`preview_tileset.json` + `preview_low/*.glb`)
   for the Site Menu interactive 3D preview (before the user clicks Enlarge to enter the full 3D Studio).
   Retains ~45,000-120,000 triangles across the site with locked border vertices (-slb) and crisp
   768px-1024px JPEG textures (quality 80-82) so the interactive preview has zero holes and sharp visuals.

2. `ensure_scan_full_quality_thumbnail(tileset_path, scan_id, project_dir)`:
   Auto-generates a crisp 16:9 (800x450) 2D screenshot (`thumbnail.png`) directly from the
   FULL-QUALITY 3D scan tiles, zoomed tightly to the scan's 3D extents, for the Main Map right-hand
   scan tile cards and timeline cards whenever a scan is uploaded or discovered.
"""

from __future__ import annotations

import copy
import io
import json
import os
import shutil
import struct
import subprocess
import tempfile
import time
from typing import Dict, Any, List, Optional, Tuple

try:
    import numpy as np
except ImportError:
    np = None  # type: ignore

try:
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None
except ImportError:
    Image = None  # type: ignore

from pc_worker.config import GC_SCAN_OPTIMIZER_DIR, DATA_DIR

GLTFPACK_EXE = os.path.join(GC_SCAN_OPTIMIZER_DIR, "bin", "gltfpack.exe")

# Precompute a 28-point uniform barycentric grid (N=6) per triangle for dense, gap-free rasterization
_BARY_GRID: List[Tuple[float, float, float]] = []
_BARY_STEPS = 5
for _i in range(_BARY_STEPS + 1):
    for _j in range(_BARY_STEPS + 1 - _i):
        _k = _BARY_STEPS - _i - _j
        _BARY_GRID.append((_i / _BARY_STEPS, _j / _BARY_STEPS, _k / _BARY_STEPS))


def _get_glb_triangle_count(raw_bytes: bytes) -> int:
    if len(raw_bytes) < 28 or raw_bytes[:4] != b"glTF":
        return 0
    try:
        jl, _ = struct.unpack_from("<I4s", raw_bytes, 12)
        j = json.loads(raw_bytes[20 : 20 + jl].decode("utf-8"))
        accs = j.get("accessors") or []
        total_tris = 0
        for mesh in j.get("meshes") or []:
            for prim in mesh.get("primitives") or []:
                if "indices" in prim and 0 <= prim["indices"] < len(accs):
                    total_tris += int(accs[prim["indices"]].get("count", 0)) // 3
                elif "POSITION" in (prim.get("attributes") or {}):
                    p_idx = prim["attributes"]["POSITION"]
                    if 0 <= p_idx < len(accs):
                        total_tris += int(accs[p_idx].get("count", 0)) // 3
        return total_tris
    except Exception:
        return 0


def _downscale_glb_textures(raw_bytes: bytes, max_dim: int = 1536, jpeg_quality: int = 85) -> bytes:
    """
    Replaces any embedded PNG/JPEG/WebP textures inside a GLB (standard or EXT_meshopt_compression)
    with a crisp, web-optimized JPEG (e.g. 1536x1536 or 2048x2048 @ quality 85) for fast preview streaming.
    """
    if len(raw_bytes) < 28 or raw_bytes[:4] != b"glTF":
        return raw_bytes
    try:
        jl, jtype = struct.unpack_from("<I4s", raw_bytes, 12)
        if jtype != b"JSON":
            return raw_bytes
        boff = 20 + jl
        if boff + 8 > len(raw_bytes):
            return raw_bytes
        blen, btype = struct.unpack_from("<I4s", raw_bytes, boff)
        if btype != b"BIN\x00":
            return raw_bytes

        j = json.loads(raw_bytes[20 : 20 + jl].decode("utf-8"))
        bin_data = memoryview(raw_bytes)[boff + 8 : boff + 8 + blen]
        images = j.get("images") or []
        bvs = j.get("bufferViews") or []
        if not images or not bvs:
            return raw_bytes

        has_webp_ext = any(
            isinstance((t.get("extensions") or {}).get("EXT_texture_webp"), dict)
            for t in (j.get("textures") or [])
        )
        eff_max_dim = max(1280, int(round(max_dim / (len(images) ** 0.25)))) if len(images) > 1 else max_dim
        img_bv_map: Dict[int, bytes] = {}
        for im in images:
            bvi = im.get("bufferView")
            if bvi is not None and 0 <= bvi < len(bvs):
                bv = bvs[bvi]
                off = int(bv.get("byteOffset", 0))
                ln = int(bv.get("byteLength", 0))
                if ln <= 0 or off + ln > len(bin_data):
                    continue
                try:
                    raw_img_bytes = bytes(bin_data[off : off + ln])
                    pil_hdr = Image.open(io.BytesIO(raw_img_bytes))
                    orig_fmt = (pil_hdr.format or "").upper()
                    orig_w, orig_h = pil_hdr.size
                    if (
                        orig_fmt == "JPEG"
                        and im.get("mimeType") == "image/jpeg"
                        and orig_w <= eff_max_dim
                        and orig_h <= eff_max_dim
                        and len(raw_img_bytes) <= 850_000
                        and not has_webp_ext
                    ):
                        # Already compact JPEG within eff_max_dim -> preserve exact bytes
                        continue
                    pil_im = pil_hdr.convert("RGB")
                    if orig_w > eff_max_dim or orig_h > eff_max_dim:
                        pil_im.thumbnail((eff_max_dim, eff_max_dim), Image.Resampling.LANCZOS)
                    out_buf = io.BytesIO()
                    pil_im.save(out_buf, format="JPEG", quality=jpeg_quality, optimize=True)
                    img_bv_map[bvi] = out_buf.getvalue()
                    im["mimeType"] = "image/jpeg"
                except Exception:
                    pass

        if not img_bv_map and not has_webp_ext:
            return raw_bytes

        for tex in j.get("textures") or []:
            exts = tex.get("extensions")
            if isinstance(exts, dict) and "EXT_texture_webp" in exts:
                src_idx = exts["EXT_texture_webp"].get("source")
                if src_idx is not None:
                    tex["source"] = src_idx
                exts.pop("EXT_texture_webp", None)
                if not exts:
                    tex.pop("extensions", None)
        for ext_key in ("extensionsUsed", "extensionsRequired"):
            if ext_key in j and isinstance(j[ext_key], list):
                j[ext_key] = [x for x in j[ext_key] if x != "EXT_texture_webp"]
                if not j[ext_key]:
                    j.pop(ext_key, None)

        chunks = []
        for idx_bv, bv in enumerate(bvs):
            ext_mo = (bv.get("extensions") or {}).get("EXT_meshopt_compression")
            if isinstance(ext_mo, dict) and int(ext_mo.get("buffer", 0)) == 0:
                chunks.append(("mo", idx_bv, int(ext_mo.get("byteOffset", 0)), int(ext_mo["byteLength"])))
            elif int(bv.get("buffer", 0)) == 0:
                chunks.append(("bv", idx_bv, int(bv.get("byteOffset", 0)), int(bv["byteLength"])))

        chunks.sort(key=lambda x: x[2])
        new_bin = bytearray()
        for ctype, idx_bv, old_off, old_len in chunks:
            if ctype == "bv" and idx_bv in img_bv_map:
                data = img_bv_map[idx_bv]
            else:
                data = bytes(bin_data[old_off : old_off + old_len])
            new_off = len(new_bin)
            new_bin.extend(data)
            while len(new_bin) % 4:
                new_bin.append(0)
            if ctype == "bv":
                bvs[idx_bv]["byteOffset"] = new_off
                bvs[idx_bv]["byteLength"] = len(data)
            else:
                bvs[idx_bv]["extensions"]["EXT_meshopt_compression"]["byteOffset"] = new_off
                bvs[idx_bv]["extensions"]["EXT_meshopt_compression"]["byteLength"] = len(data)

        if j.get("buffers"):
            j["buffers"][0]["byteLength"] = len(new_bin)

        jb = json.dumps(j, separators=(",", ":")).encode("utf-8")
        while len(jb) % 4:
            jb += b" "
        total_len = 12 + 8 + len(jb) + 8 + len(new_bin)
        out = bytearray()
        out.extend(struct.pack("<4sII", b"glTF", 2, total_len))
        out.extend(struct.pack("<I4s", len(jb), b"JSON"))
        out.extend(jb)
        out.extend(struct.pack("<I4s", len(new_bin), b"BIN\x00"))
        out.extend(new_bin)
        return bytes(out)
    except Exception:
        return raw_bytes


def replace_glb_single_image_bytes(
    raw_bytes: bytes,
    exact_img_bytes: bytes,
    mime_type: str = "image/jpeg",
) -> bytes:
    """
    Splices exact original JPEG/PNG image bytes into a single-texture GLB (standard or EXT_meshopt_compression)
    so zero JPEG re-encoding generation loss occurs when packing .obj -> .glb via gltfpack.
    """
    if not exact_img_bytes or len(raw_bytes) < 28 or raw_bytes[:4] != b"glTF":
        return raw_bytes
    try:
        jl, jtype = struct.unpack_from("<I4s", raw_bytes, 12)
        if jtype != b"JSON":
            return raw_bytes
        boff = 20 + jl
        if boff + 8 > len(raw_bytes):
            return raw_bytes
        blen, btype = struct.unpack_from("<I4s", raw_bytes, boff)
        if btype != b"BIN\x00":
            return raw_bytes

        j = json.loads(raw_bytes[20 : 20 + jl].decode("utf-8"))
        bin_data = memoryview(raw_bytes)[boff + 8 : boff + 8 + blen]
        images = j.get("images") or []
        bvs = j.get("bufferViews") or []
        if not images or not bvs:
            return raw_bytes

        target_bvi = images[0].get("bufferView")
        if target_bvi is None or not (0 <= int(target_bvi) < len(bvs)):
            return raw_bytes
        target_bvi = int(target_bvi)
        images[0]["mimeType"] = mime_type

        for tex in j.get("textures") or []:
            exts = tex.get("extensions")
            if isinstance(exts, dict) and "EXT_texture_webp" in exts:
                src_idx = exts["EXT_texture_webp"].get("source")
                if src_idx is not None:
                    tex["source"] = src_idx
                exts.pop("EXT_texture_webp", None)
                if not exts:
                    tex.pop("extensions", None)
        for ext_key in ("extensionsUsed", "extensionsRequired"):
            if ext_key in j and isinstance(j[ext_key], list):
                j[ext_key] = [x for x in j[ext_key] if x != "EXT_texture_webp"]
                if not j[ext_key]:
                    j.pop(ext_key, None)

        chunks = []
        for idx_bv, bv in enumerate(bvs):
            ext_mo = (bv.get("extensions") or {}).get("EXT_meshopt_compression")
            if isinstance(ext_mo, dict) and int(ext_mo.get("buffer", 0)) == 0:
                chunks.append(("mo", idx_bv, int(ext_mo.get("byteOffset", 0)), int(ext_mo["byteLength"])))
            elif int(bv.get("buffer", 0)) == 0:
                chunks.append(("bv", idx_bv, int(bv.get("byteOffset", 0)), int(bv["byteLength"])))

        chunks.sort(key=lambda x: x[2])
        new_bin = bytearray()
        for ctype, idx_bv, old_off, old_len in chunks:
            if ctype == "bv" and idx_bv == target_bvi:
                data = exact_img_bytes
            else:
                data = bytes(bin_data[old_off : old_off + old_len])
            new_off = len(new_bin)
            new_bin.extend(data)
            while len(new_bin) % 4:
                new_bin.append(0)
            if ctype == "bv":
                bvs[idx_bv]["byteOffset"] = new_off
                bvs[idx_bv]["byteLength"] = len(data)
            else:
                bvs[idx_bv]["extensions"]["EXT_meshopt_compression"]["byteOffset"] = new_off
                bvs[idx_bv]["extensions"]["EXT_meshopt_compression"]["byteLength"] = len(data)

        if j.get("buffers"):
            j["buffers"][0]["byteLength"] = len(new_bin)

        jb = json.dumps(j, separators=(",", ":")).encode("utf-8")
        while len(jb) % 4:
            jb += b" "
        total_len = 12 + 8 + len(jb) + 8 + len(new_bin)
        out = bytearray()
        out.extend(struct.pack("<4sII", b"glTF", 2, total_len))
        out.extend(struct.pack("<I4s", len(jb), b"JSON"))
        out.extend(jb)
        out.extend(struct.pack("<I4s", len(new_bin), b"BIN\x00"))
        out.extend(new_bin)
        return bytes(out)
    except Exception:
        return raw_bytes


def extract_glb_large_offset(raw_bytes: bytes) -> Tuple[float, float, float]:
    """
    Returns a rounded (ox, oy, oz) offset if a root/mesh node inside the GLB has large
    georeferenced coordinates (>1000m), so gltfpack can operate in local coordinates
    without float32 quantization loss.
    """
    if len(raw_bytes) < 28 or raw_bytes[:4] != b"glTF":
        return (0.0, 0.0, 0.0)
    try:
        jl, jtype = struct.unpack_from("<I4s", raw_bytes, 12)
        if jtype != b"JSON":
            return (0.0, 0.0, 0.0)
        j = json.loads(raw_bytes[20 : 20 + jl].decode("utf-8"))
        for node in j.get("nodes") or []:
            t = node.get("translation")
            if isinstance(t, list) and len(t) >= 3:
                tx, ty, tz = float(t[0]), float(t[1]), float(t[2])
                if abs(tx) > 1000.0 or abs(ty) > 1000.0:
                    return (round(tx), round(ty), round(tz))
    except Exception:
        pass
    return (0.0, 0.0, 0.0)


def shift_glb_node_translation(raw_bytes: bytes, dx: float, dy: float, dz: float) -> bytes:
    """
    Shifts the root/mesh node translation in the GLB JSON chunk by (dx, dy, dz) in 64-bit float
    without modifying the binary buffer, preserving sub-millimeter quantized vertex precision.
    """
    if (abs(dx) < 1e-6 and abs(dy) < 1e-6 and abs(dz) < 1e-6) or len(raw_bytes) < 28 or raw_bytes[:4] != b"glTF":
        return raw_bytes
    try:
        jl, jtype = struct.unpack_from("<I4s", raw_bytes, 12)
        if jtype != b"JSON":
            return raw_bytes
        boff = 20 + jl
        j = json.loads(raw_bytes[20 : 20 + jl].decode("utf-8"))
        nodes = j.get("nodes") or []
        if not nodes:
            return raw_bytes

        # Identify root scene nodes or nodes holding a mesh
        scene_roots = set()
        for sc in j.get("scenes") or []:
            for ni in sc.get("nodes") or []:
                scene_roots.add(int(ni))
        target_indices = [
            idx for idx, n in enumerate(nodes)
            if isinstance(n.get("translation"), list) and len(n["translation"]) >= 3
        ]
        if not target_indices:
            target_indices = [idx for idx in scene_roots if 0 <= idx < len(nodes)] or [0]

        for idx in target_indices:
            n = nodes[idx]
            t = n.get("translation") or [0.0, 0.0, 0.0]
            n["translation"] = [
                round(float(t[0]) + float(dx), 6),
                round(float(t[1]) + float(dy), 6),
                round(float(t[2]) + float(dz), 6),
            ]

        jb = json.dumps(j, separators=(",", ":")).encode("utf-8")
        while len(jb) % 4:
            jb += b" "
        rest = raw_bytes[boff:]
        total_len = 12 + 8 + len(jb) + len(rest)
        out = bytearray()
        out.extend(struct.pack("<4sII", b"glTF", 2, total_len))
        out.extend(struct.pack("<I4s", len(jb), b"JSON"))
        out.extend(jb)
        out.extend(rest)
        return bytes(out)
    except Exception:
        return raw_bytes


def simplify_glb_via_welded_qem(
    in_glb_path: str,
    out_glb_path: str,
    target_triangles: int,
    vp_bits: int = 14,
    vt_bits: int = 14,
) -> bool:
    """
    Simplifies single- or multi-primitive textured GLBs whose triangles have unwelded per-triangle
    UV islands (where standard `gltfpack -si` without `-sa` locks UV seams and cannot reduce triangle
    count, while `-sa` collapses disjoint UV islands and corrupts 70%+ of triangle UVs).

    Algorithm:
    1. Decodes the GLB into float32 local positions, UVs (applying any `KHR_texture_transform`
       scale/offset so UVs are normalized to [0, 1]), and triangle indices per primitive.
    2. Welds 3D vertex positions (ignoring UV seams) into a temporary position-only GLB and
       simplifies it with `gltfpack -si <ratio> -slb -noq` (pure Quadric Error Metric, NO `-sa`).
    3. Transfers UVs from the original mesh to each simplified triangle via `cKDTree` over
       inset original triangle corners (`0.85 * corner + 0.15 * centroid`), and snaps any
       seam-crossing (`span > 0.035`) or degenerate (`uv_area2 < 1e-10`) triangle to the nearest
       original triangle's UV island using the minimum-cost bijective corner permutation (`0.0%` stretched UVs).
    4. Compresses the resulting GLB with `gltfpack -vp <vp_bits> -vt <vt_bits> -cc`.
    """
    if np is None or not os.path.isfile(in_glb_path) or not os.path.isfile(GLTFPACK_EXE):
        return False
    try:
        from scipy.spatial import cKDTree
    except ImportError:
        return False

    win_flag = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000) if os.name == "nt" else 0
    tmp_files: List[str] = []
    try:
        fd_dec, tmp_dec = tempfile.mkstemp(suffix=".glb", prefix="gs_wqem_dec_")
        os.close(fd_dec)
        tmp_files.append(tmp_dec)

        res_dec = subprocess.run(
            [GLTFPACK_EXE, "-i", in_glb_path, "-o", tmp_dec, "-noq"],
            capture_output=True,
            timeout=90,
            creationflags=win_flag,
        )
        if res_dec.returncode != 0 or not os.path.isfile(tmp_dec) or os.path.getsize(tmp_dec) < 128:
            return False

        with open(tmp_dec, "rb") as f:
            dec_bytes = f.read()
        jl, _ = struct.unpack_from("<I4s", dec_bytes, 12)
        j_dec = json.loads(dec_bytes[20 : 20 + jl].decode("utf-8"))
        b_dec = memoryview(dec_bytes)[28 + jl :]

        meshes = j_dec.get("meshes") or []
        images = j_dec.get("images") or []
        mats = j_dec.get("materials") or []
        texs = j_dec.get("textures") or []
        bvs = j_dec.get("bufferViews") or []
        accs = j_dec.get("accessors") or []
        if not meshes or not images or len(images) > 16:
            return False

        def _read_acc(acc_idx: int) -> np.ndarray:
            acc = accs[acc_idx]
            bv = bvs[acc["bufferView"]]
            off = int(bv.get("byteOffset", 0)) + int(acc.get("byteOffset", 0))
            cnt = int(acc["count"])
            ctype = int(acc["componentType"])
            dt = {5126: np.float32, 5123: np.uint16, 5125: np.uint32, 5121: np.uint8}[ctype]
            ncomp = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[acc["type"]]
            stride = int(bv.get("byteStride") or (np.dtype(dt).itemsize * ncomp))
            raw_mv = b_dec[off : off + stride * cnt]
            if stride == np.dtype(dt).itemsize * ncomp:
                arr = np.frombuffer(raw_mv, dtype=dt, count=cnt * ncomp)
                return arr.reshape(cnt, ncomp) if ncomp > 1 else arr
            u8 = np.frombuffer(raw_mv, dtype=np.uint8).reshape(cnt, stride)
            part = u8[:, : np.dtype(dt).itemsize * ncomp].copy()
            arr = np.frombuffer(part, dtype=dt)
            return arr.reshape(cnt, ncomp) if ncomp > 1 else arr

        prim_items: List[Dict[str, Any]] = []
        for m in meshes:
            for prim in m.get("primitives") or []:
                attrs = prim.get("attributes") or {}
                if "POSITION" not in attrs or "TEXCOORD_0" not in attrs or "indices" not in prim:
                    return False
                pos_o = np.ascontiguousarray(_read_acc(int(attrs["POSITION"])), dtype=np.float32)
                raw_uv_o = np.ascontiguousarray(_read_acc(int(attrs["TEXCOORD_0"])), dtype=np.float32)
                idx_o = np.ascontiguousarray(_read_acc(int(prim["indices"])), dtype=np.uint32).reshape(-1, 3)
                if len(idx_o) == 0:
                    continue
                uv_scale = np.array([1.0, 1.0], dtype=np.float32)
                uv_offset = np.array([0.0, 0.0], dtype=np.float32)
                img_idx = min(len(prim_items), len(images) - 1)
                mat_idx = prim.get("material")
                if mat_idx is not None and 0 <= int(mat_idx) < len(mats):
                    pbr = mats[int(mat_idx)].get("pbrMetallicRoughness") or {}
                    bct = pbr.get("baseColorTexture") or {}
                    t_idx = bct.get("index")
                    if t_idx is not None and 0 <= int(t_idx) < len(texs):
                        tx_obj = texs[int(t_idx)]
                        src_i = tx_obj.get("source")
                        if src_i is None:
                            src_i = ((tx_obj.get("extensions") or {}).get("EXT_texture_webp") or {}).get("source")
                        if src_i is not None and 0 <= int(src_i) < len(images):
                            img_idx = int(src_i)
                    khr_tt = (bct.get("extensions") or {}).get("KHR_texture_transform") or {}
                    if "scale" in khr_tt and len(khr_tt["scale"]) >= 2:
                        uv_scale = np.array(khr_tt["scale"][:2], dtype=np.float32)
                    if "offset" in khr_tt and len(khr_tt["offset"]) >= 2:
                        uv_offset = np.array(khr_tt["offset"][:2], dtype=np.float32)
                uv_o = np.ascontiguousarray(raw_uv_o * uv_scale + uv_offset, dtype=np.float32)
                prim_items.append({"pos_o": pos_o, "uv_o": uv_o, "idx_o": idx_o, "img_idx": img_idx})

        if not prim_items or len(prim_items) > 16:
            return False
        total_orig_tris = sum(len(it["idx_o"]) for it in prim_items)
        if total_orig_tris <= target_triangles or total_orig_tris < 100:
            return False

        perms = ((0, 1, 2), (0, 2, 1), (1, 0, 2), (1, 2, 0), (2, 0, 1), (2, 1, 0))
        simplified_prims: List[Tuple[np.ndarray, np.ndarray, np.ndarray, int]] = []
        total_simp_tris = 0

        for it in prim_items:
            pos_o = it["pos_o"]
            uv_o = it["uv_o"]
            idx_o = it["idx_o"]
            img_idx = it["img_idx"]
            orig_tris_p = len(idx_o)
            prim_target = max(50, int(round(float(target_triangles) * (float(orig_tris_p) / float(total_orig_tris)))))

            if orig_tris_p <= max(80, int(prim_target * 1.08)):
                s_tris_p = pos_o[idx_o]
                s_uvs_p = uv_o[idx_o]
                out_pos_p = np.ascontiguousarray(s_tris_p.reshape(-1, 3), dtype=np.float32)
                out_uv_p = np.ascontiguousarray(s_uvs_p.reshape(-1, 2), dtype=np.float32)
                out_idx_p = np.arange(len(out_pos_p), dtype=np.uint32)
                simplified_prims.append((out_pos_p, out_uv_p, out_idx_p, img_idx))
                total_simp_tris += orig_tris_p
                continue

            # 1. Weld identical 3D positions so QEM simplification operates across UV island seams
            _, uniq_first, inv = np.unique(np.round(pos_o, 4), axis=0, return_index=True, return_inverse=True)
            pos_w = np.ascontiguousarray(pos_o[uniq_first], dtype=np.float32)
            idx_w = np.ascontiguousarray(inv[idx_o], dtype=np.uint32)

            b_idx_w = idx_w.tobytes()
            b_pos_w = pos_w.tobytes()
            bin_w = bytearray()
            off_idx_w = 0
            bin_w.extend(b_idx_w)
            while len(bin_w) % 4:
                bin_w.append(0)
            off_pos_w = len(bin_w)
            bin_w.extend(b_pos_w)
            while len(bin_w) % 4:
                bin_w.append(0)

            j_w = {
                "asset": {"version": "2.0"},
                "scene": 0,
                "scenes": [{"nodes": [0]}],
                "nodes": [{"mesh": 0}],
                "meshes": [{"primitives": [{"attributes": {"POSITION": 1}, "indices": 0, "mode": 4}]}],
                "bufferViews": [
                    {"buffer": 0, "byteOffset": off_idx_w, "byteLength": len(b_idx_w), "target": 34963},
                    {"buffer": 0, "byteOffset": off_pos_w, "byteLength": len(b_pos_w), "target": 34962},
                ],
                "accessors": [
                    {"bufferView": 0, "byteOffset": 0, "componentType": 5125, "count": int(idx_w.size), "type": "SCALAR"},
                    {
                        "bufferView": 1,
                        "byteOffset": 0,
                        "componentType": 5126,
                        "count": int(len(pos_w)),
                        "type": "VEC3",
                        "min": pos_w.min(axis=0).tolist(),
                        "max": pos_w.max(axis=0).tolist(),
                    },
                ],
                "buffers": [{"byteLength": len(bin_w)}],
            }
            jb_w = json.dumps(j_w, separators=(",", ":")).encode("utf-8")
            while len(jb_w) % 4:
                jb_w += b" "

            fd_pin, tmp_pos_in = tempfile.mkstemp(suffix=".glb", prefix="gs_wqem_pin_")
            os.close(fd_pin)
            tmp_files.append(tmp_pos_in)
            with open(tmp_pos_in, "wb") as wf:
                wf.write(struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(jb_w) + 8 + len(bin_w)))
                wf.write(struct.pack("<I4s", len(jb_w), b"JSON"))
                wf.write(jb_w)
                wf.write(struct.pack("<I4s", len(bin_w), b"BIN\x00"))
                wf.write(bin_w)

            fd_pout, tmp_pos_out = tempfile.mkstemp(suffix=".glb", prefix="gs_wqem_pout_")
            os.close(fd_pout)
            tmp_files.append(tmp_pos_out)
            ratio = max(0.015, min(0.95, float(prim_target) / float(orig_tris_p)))
            res_simp = subprocess.run(
                [GLTFPACK_EXE, "-i", tmp_pos_in, "-o", tmp_pos_out, "-si", f"{ratio:.4f}", "-slb", "-noq"],
                capture_output=True,
                timeout=90,
                creationflags=win_flag,
            )
            if res_simp.returncode != 0 or not os.path.isfile(tmp_pos_out) or os.path.getsize(tmp_pos_out) < 128:
                return False

            with open(tmp_pos_out, "rb") as rf:
                simp_bytes = rf.read()
            jl_s, _ = struct.unpack_from("<I4s", simp_bytes, 12)
            j_s = json.loads(simp_bytes[20 : 20 + jl_s].decode("utf-8"))
            b_s = memoryview(simp_bytes)[28 + jl_s :]
            accs_s = j_s.get("accessors") or []
            bvs_s = j_s.get("bufferViews") or []
            prim_s = j_s["meshes"][0]["primitives"][0]

            def _read_acc_s(acc_idx: int) -> np.ndarray:
                acc = accs_s[acc_idx]
                bv = bvs_s[acc["bufferView"]]
                off = int(bv.get("byteOffset", 0)) + int(acc.get("byteOffset", 0))
                cnt = int(acc["count"])
                ctype = int(acc["componentType"])
                dt = {5126: np.float32, 5123: np.uint16, 5125: np.uint32, 5121: np.uint8}[ctype]
                ncomp = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[acc["type"]]
                stride = int(bv.get("byteStride") or (np.dtype(dt).itemsize * ncomp))
                raw_mv = b_s[off : off + stride * cnt]
                if stride == np.dtype(dt).itemsize * ncomp:
                    arr = np.frombuffer(raw_mv, dtype=dt, count=cnt * ncomp)
                    return arr.reshape(cnt, ncomp) if ncomp > 1 else arr
                u8 = np.frombuffer(raw_mv, dtype=np.uint8).reshape(cnt, stride)
                part = u8[:, : np.dtype(dt).itemsize * ncomp].copy()
                arr = np.frombuffer(part, dtype=dt)
                return arr.reshape(cnt, ncomp) if ncomp > 1 else arr

            pos_s = np.ascontiguousarray(_read_acc_s(int(prim_s["attributes"]["POSITION"])), dtype=np.float32)
            idx_s = np.ascontiguousarray(_read_acc_s(int(prim_s["indices"])), dtype=np.uint32).reshape(-1, 3)
            n_simp = len(idx_s)
            if n_simp < 30:
                return False

            # 2. Transfer UVs via inset corner KDTree + bijective permutation snapping (0.0% stretched UVs)
            s_tris = pos_s[idx_s]  # (n_simp, 3, 3)
            s_cent = s_tris.mean(axis=1)  # (n_simp, 3)

            orig_tris_pos = pos_o[idx_o]
            orig_tris_uv = uv_o[idx_o]
            orig_cent = orig_tris_pos.mean(axis=1)

            orig_inset = np.ascontiguousarray(
                (orig_tris_pos * 0.85 + orig_cent[:, None, :] * 0.15).reshape(-1, 3),
                dtype=np.float32,
            )
            orig_inset_uv = np.ascontiguousarray(orig_tris_uv.reshape(-1, 2), dtype=np.float32)
            tree_inset = cKDTree(orig_inset)
            s_uvs = np.empty((n_simp, 3, 2), dtype=np.float32)
            for k in range(3):
                inset_pt = s_tris[:, k, :] * 0.85 + s_cent * 0.15
                _, vi = tree_inset.query(inset_pt)
                s_uvs[:, k, :] = orig_inset_uv[vi]

            d01 = np.abs(s_uvs[:, 0, :] - s_uvs[:, 1, :]).max(axis=1)
            d12 = np.abs(s_uvs[:, 1, :] - s_uvs[:, 2, :]).max(axis=1)
            d20 = np.abs(s_uvs[:, 2, :] - s_uvs[:, 0, :]).max(axis=1)
            span = np.maximum(np.maximum(d01, d12), d20)
            du1 = s_uvs[:, 1, :] - s_uvs[:, 0, :]
            du2 = s_uvs[:, 2, :] - s_uvs[:, 0, :]
            uv_area2 = np.abs(du1[:, 0] * du2[:, 1] - du1[:, 1] * du2[:, 0])
            bad_mask = (span > 0.035) | (uv_area2 < 1e-10)
            if np.any(bad_mask):
                tree_cent = cKDTree(orig_cent)
                _, near_ti = tree_cent.query(s_cent[bad_mask])
                cand_pos = orig_tris_pos[near_ti]  # (B, 3, 3)
                cand_uv = orig_tris_uv[near_ti]  # (B, 3, 2)
                bad_s_pos = s_tris[bad_mask]  # (B, 3, 3)
                cost_mat = np.empty((len(near_ti), 6), dtype=np.float32)
                for p_i, (c0, c1, c2) in enumerate(perms):
                    cost_mat[:, p_i] = (
                        np.sum((bad_s_pos[:, 0, :] - cand_pos[:, c0, :]) ** 2, axis=1)
                        + np.sum((bad_s_pos[:, 1, :] - cand_pos[:, c1, :]) ** 2, axis=1)
                        + np.sum((bad_s_pos[:, 2, :] - cand_pos[:, c2, :]) ** 2, axis=1)
                    )
                best_perm = np.argmin(cost_mat, axis=1)
                snapped_uv = np.empty_like(cand_uv)
                for p_i, (c0, c1, c2) in enumerate(perms):
                    m = best_perm == p_i
                    if np.any(m):
                        snapped_uv[m, 0, :] = cand_uv[m, c0, :]
                        snapped_uv[m, 1, :] = cand_uv[m, c1, :]
                        snapped_uv[m, 2, :] = cand_uv[m, c2, :]
                s_uvs[bad_mask] = snapped_uv

            out_pos_p = np.ascontiguousarray(s_tris.reshape(-1, 3), dtype=np.float32)
            out_uv_p = np.ascontiguousarray(s_uvs.reshape(-1, 2), dtype=np.float32)
            out_idx_p = np.arange(len(out_pos_p), dtype=np.uint32)
            simplified_prims.append((out_pos_p, out_uv_p, out_idx_p, img_idx))
            total_simp_tris += n_simp

        if total_simp_tris >= int(total_orig_tris * 0.90):
            return False

        bin_o = bytearray()
        out_bvs: List[Dict[str, Any]] = []
        out_accs: List[Dict[str, Any]] = []
        out_prims: List[Dict[str, Any]] = []
        out_mats: List[Dict[str, Any]] = []
        out_texs: List[Dict[str, Any]] = []
        out_imgs: List[Dict[str, Any]] = []

        img_remap: Dict[int, int] = {}
        for out_pos_p, out_uv_p, out_idx_p, img_idx in simplified_prims:
            if img_idx not in img_remap:
                img_remap[img_idx] = len(out_imgs)
                src_im = images[img_idx]
                img_bv_src = bvs[int(src_im["bufferView"])]
                img_off_src = int(img_bv_src.get("byteOffset", 0))
                img_len_src = int(img_bv_src.get("byteLength", 0))
                img_bytes_src = bytes(b_dec[img_off_src : img_off_src + img_len_src])
                img_mime_src = src_im.get("mimeType") or "image/jpeg"
                if img_mime_src == "image/webp" and Image is not None:
                    try:
                        pil_w = Image.open(io.BytesIO(img_bytes_src)).convert("RGB")
                        w_buf = io.BytesIO()
                        pil_w.save(w_buf, format="JPEG", quality=88, optimize=True)
                        img_bytes_src = w_buf.getvalue()
                        img_mime_src = "image/jpeg"
                    except Exception:
                        pass
                out_imgs.append({"_bytes": img_bytes_src, "mimeType": img_mime_src})

            mapped_im_idx = img_remap[img_idx]
            mat_out_idx = len(out_mats)
            out_texs.append({"sampler": 0, "source": mapped_im_idx})
            out_mats.append(
                {
                    "pbrMetallicRoughness": {
                        "baseColorTexture": {"index": mat_out_idx},
                        "metallicFactor": 0.0,
                        "roughnessFactor": 1.0,
                    },
                    "doubleSided": True,
                }
            )

            b_idx_p = out_idx_p.tobytes()
            b_pos_p = out_pos_p.tobytes()
            b_uv_p = out_uv_p.tobytes()

            off_idx_p = len(bin_o)
            bin_o.extend(b_idx_p)
            while len(bin_o) % 4:
                bin_o.append(0)
            bv_idx_i = len(out_bvs)
            out_bvs.append({"buffer": 0, "byteOffset": off_idx_p, "byteLength": len(b_idx_p), "target": 34963})
            acc_idx_i = len(out_accs)
            out_accs.append(
                {"bufferView": bv_idx_i, "byteOffset": 0, "componentType": 5125, "count": int(out_idx_p.size), "type": "SCALAR"}
            )

            off_pos_p = len(bin_o)
            bin_o.extend(b_pos_p)
            while len(bin_o) % 4:
                bin_o.append(0)
            bv_pos_i = len(out_bvs)
            out_bvs.append({"buffer": 0, "byteOffset": off_pos_p, "byteLength": len(b_pos_p), "target": 34962})
            acc_pos_i = len(out_accs)
            out_accs.append(
                {
                    "bufferView": bv_pos_i,
                    "byteOffset": 0,
                    "componentType": 5126,
                    "count": int(len(out_pos_p)),
                    "type": "VEC3",
                    "min": out_pos_p.min(axis=0).tolist(),
                    "max": out_pos_p.max(axis=0).tolist(),
                }
            )

            off_uv_p = len(bin_o)
            bin_o.extend(b_uv_p)
            while len(bin_o) % 4:
                bin_o.append(0)
            bv_uv_i = len(out_bvs)
            out_bvs.append({"buffer": 0, "byteOffset": off_uv_p, "byteLength": len(b_uv_p), "target": 34962})
            acc_uv_i = len(out_accs)
            out_accs.append(
                {"bufferView": bv_uv_i, "byteOffset": 0, "componentType": 5126, "count": int(len(out_uv_p)), "type": "VEC2"}
            )

            out_prims.append(
                {
                    "attributes": {"POSITION": acc_pos_i, "TEXCOORD_0": acc_uv_i},
                    "indices": acc_idx_i,
                    "material": mat_out_idx,
                    "mode": 4,
                }
            )

        final_imgs: List[Dict[str, Any]] = []
        for im_entry in out_imgs:
            ib = im_entry["_bytes"]
            off_im = len(bin_o)
            bin_o.extend(ib)
            while len(bin_o) % 4:
                bin_o.append(0)
            bv_im_i = len(out_bvs)
            out_bvs.append({"buffer": 0, "byteOffset": off_im, "byteLength": len(ib)})
            final_imgs.append({"bufferView": bv_im_i, "mimeType": im_entry["mimeType"]})

        j_out = {
            "asset": {"version": "2.0"},
            "scene": 0,
            "scenes": [{"nodes": [0]}],
            "nodes": [{"mesh": 0}],
            "meshes": [{"primitives": out_prims}],
            "materials": out_mats,
            "textures": out_texs,
            "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}],
            "images": final_imgs,
            "bufferViews": out_bvs,
            "accessors": out_accs,
            "buffers": [{"byteLength": len(bin_o)}],
        }
        jb_out = json.dumps(j_out, separators=(",", ":")).encode("utf-8")
        while len(jb_out) % 4:
            jb_out += b" "

        fd_m, tmp_merged = tempfile.mkstemp(suffix=".glb", prefix="gs_wqem_mrg_")
        os.close(fd_m)
        tmp_files.append(tmp_merged)
        with open(tmp_merged, "wb") as wf:
            wf.write(struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(jb_out) + 8 + len(bin_o)))
            wf.write(struct.pack("<I4s", len(jb_out), b"JSON"))
            wf.write(jb_out)
            wf.write(struct.pack("<I4s", len(bin_o), b"BIN\x00"))
            wf.write(bin_o)

        res_pack = subprocess.run(
            [GLTFPACK_EXE, "-i", tmp_merged, "-o", out_glb_path, "-vp", str(vp_bits), "-vt", str(vt_bits), "-cc"],
            capture_output=True,
            timeout=90,
            creationflags=win_flag,
        )
        return res_pack.returncode == 0 and os.path.isfile(out_glb_path) and os.path.getsize(out_glb_path) > 128
    except Exception:
        return False
    finally:
        for tf_p in tmp_files:
            if os.path.isfile(tf_p):
                try:
                    os.remove(tf_p)
                except OSError:
                    pass


def build_low_quality_preview_glb(
    src_glb_path: str,
    dst_glb_path: str,
    target_triangles: int = 110000,
    max_tex_dim: int = 2048,
    jpeg_quality: int = 85,
    allow_aggressive: bool = False,
) -> bool:
    """
    Generates a sharp, watertight, UV-intact preview GLB from src_glb_path into dst_glb_path.
    Shifts large TWD97 node.translation to local (0,0,0) before invoking gltfpack and restores
    the 64-bit offset afterward so C++ float32 never quantizes TWD97 coordinates to 25cm steps.
    Never uses `-sa` on textured meshes unless explicitly requested; when a mesh has unwelded
    per-triangle UV islands, falls back to `simplify_glb_via_welded_qem` (0.0% stretched UVs).
    """
    if not os.path.isfile(src_glb_path):
        return False
    os.makedirs(os.path.dirname(dst_glb_path), exist_ok=True)

    try:
        with open(src_glb_path, "rb") as f:
            raw_in = f.read()
        orig_tris = _get_glb_triangle_count(raw_in)
        if orig_tris > 0:
            ratio = min(1.0, max(0.01, float(target_triangles) / float(orig_tris)))
        else:
            ratio = 1.0

        tmp_path = dst_glb_path + ".tmp.glb"
        tmp_in_path = ""
        ox, oy, oz = extract_glb_large_offset(raw_in)
        ran_gltfpack = False
        if os.path.isfile(GLTFPACK_EXE):
            in_for_gltfpack = src_glb_path
            if abs(ox) > 1000.0 or abs(oy) > 1000.0:
                tmp_in_path = dst_glb_path + ".local_in.glb"
                with open(tmp_in_path, "wb") as lif:
                    lif.write(shift_glb_node_translation(raw_in, -ox, -oy, -oz))
                in_for_gltfpack = tmp_in_path
            cmd = [
                GLTFPACK_EXE,
                "-i",
                in_for_gltfpack,
                "-o",
                tmp_path,
            ]
            if ratio < 0.92:
                cmd.extend(["-si", f"{ratio:.4f}", "-slb", "-sv"])
                if allow_aggressive:
                    cmd.append("-sa")
            cmd.extend(["-vp", "14", "-vt", "14", "-cc"])
            res = subprocess.run(
                cmd,
                capture_output=True,
                timeout=60,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000) if os.name == "nt" else 0,
            )
            if res.returncode == 0 and os.path.isfile(tmp_path) and os.path.getsize(tmp_path) > 128:
                ran_gltfpack = True
                # If non-aggressive gltfpack could not simplify because triangles have unwelded UV islands,
                # run welded QEM simplification + UV island transfer (0.0% stretched UVs).
                if not allow_aggressive and ratio < 0.85:
                    with open(tmp_path, "rb") as rf_chk:
                        simp_tris = _get_glb_triangle_count(rf_chk.read())
                    if simp_tris > max(int(target_triangles * 1.65), int(target_triangles + 4000)):
                        tmp_wqem = dst_glb_path + ".wqem.glb"
                        if simplify_glb_via_welded_qem(
                            in_for_gltfpack,
                            tmp_wqem,
                            target_triangles=target_triangles,
                            vp_bits=14,
                            vt_bits=14,
                        ):
                            try:
                                os.replace(tmp_wqem, tmp_path)
                            except OSError:
                                pass
                        elif os.path.isfile(tmp_wqem):
                            try:
                                os.remove(tmp_wqem)
                            except OSError:
                                pass
            if tmp_in_path and os.path.isfile(tmp_in_path):
                try:
                    os.remove(tmp_in_path)
                except Exception:
                    pass

        if ran_gltfpack:
            with open(tmp_path, "rb") as tf:
                simplified_bytes = tf.read()
            try:
                os.remove(tmp_path)
            except Exception:
                pass
            if abs(ox) > 1000.0 or abs(oy) > 1000.0:
                simplified_bytes = shift_glb_node_translation(simplified_bytes, ox, oy, oz)
        else:
            simplified_bytes = raw_in

        final_bytes = _downscale_glb_textures(
            simplified_bytes,
            max_dim=max_tex_dim,
            jpeg_quality=jpeg_quality,
        )
        with open(dst_glb_path, "wb") as wf:
            wf.write(final_bytes)
        return True
    except Exception as e:
        print(f"[PreviewGenerator] Warning generating preview GLB for {src_glb_path}: {e}")
        try:
            shutil.copy2(src_glb_path, dst_glb_path)
            return True
        except Exception:
            return False


def ensure_scan_low_quality_preview(tileset_path: str, force: bool = False) -> Optional[str]:
    """
    Given a scan's `tileset_path` (e.g. `.../tileset.json` or `.../*-cesium_mesh.json`),
    generates `<base_dir>/preview_tileset.json` and sharp, UV-intact preview GLB files inside `<base_dir>/preview_low/`.
    Returns the path to `preview_tileset.json` (or `.glb` if standalone GLB).
    """
    if not tileset_path or not os.path.isfile(tileset_path):
        return None

    base_dir = os.path.dirname(tileset_path)
    if tileset_path.lower().endswith(".glb"):
        preview_glb = os.path.join(base_dir, "preview_low.glb")
        if not force and os.path.isfile(preview_glb) and os.path.getsize(preview_glb) > 256:
            return preview_glb
        if build_low_quality_preview_glb(
            tileset_path, preview_glb, target_triangles=110000, max_tex_dim=2048, jpeg_quality=85, allow_aggressive=False
        ):
            return preview_glb
        return tileset_path

    preview_ts_path = os.path.join(base_dir, "preview_tileset.json")
    preview_low_dir = os.path.join(base_dir, "preview_low")

    if not force and os.path.isfile(preview_ts_path) and os.path.isdir(preview_low_dir):
        try:
            if os.path.getmtime(preview_ts_path) >= os.path.getmtime(tileset_path):
                return preview_ts_path
        except Exception:
            return preview_ts_path

    try:
        with open(tileset_path, "r", encoding="utf-8") as f:
            ts = json.load(f)
    except Exception as e:
        print(f"[PreviewGenerator] Failed reading {tileset_path}: {e}")
        return None

    if (ts.get("extras") or {}).get("is_gaussian_splat"):
        if os.path.isfile(preview_ts_path):
            return preview_ts_path
        return tileset_path

    preview_ts = copy.deepcopy(ts)
    root = preview_ts.get("root") or {}
    if not root.get("transform"):
        preview_ts.setdefault("asset", {})["gltfUpAxis"] = "Z"

    r_content = root.get("content") or {}
    r_uri = r_content.get("uri") if isinstance(r_content, dict) else None

    if force and os.path.isdir(preview_low_dir):
        shutil.rmtree(preview_low_dir, ignore_errors=True)
    os.makedirs(preview_low_dir, exist_ok=True)
    generated_count = 0

    if r_uri:
        # Single-root tileset (Native Octree or Quadtree root GLB): ~110k tris and 2048px JPEG (~0.9-2.5 MB)
        clean_r_uri = r_uri.split("?")[0]
        src_glb = os.path.join(base_dir, clean_r_uri)
        if src_glb.lower().endswith("_l0.glb") and os.path.isfile(src_glb[:-7] + "_l1.glb"):
            src_glb = src_glb[:-7] + "_l1.glb"
        rel_clean = clean_r_uri.replace("\\", "/").lstrip("/")
        dst_rel = f"preview_low/{rel_clean}"
        dst_glb = os.path.join(base_dir, dst_rel)
        if build_low_quality_preview_glb(
            src_glb,
            dst_glb,
            target_triangles=110000,
            max_tex_dim=2048,
            jpeg_quality=85,
            allow_aggressive=False,
        ):
            v_ts = int(os.path.getmtime(dst_glb)) if os.path.isfile(dst_glb) else int(time.time())
            root["content"]["uri"] = f"{dst_rel}?v={v_ts}"
            generated_count += 1
        root["geometricError"] = 0.0
        root["children"] = []
    else:
        # Multi-tile Cesium octree or merged scan: preserve crisp geometry and textures without -sa corruption
        def _count_coarse_nodes(node: dict, depth: int = 0) -> int:
            c = node.get("content") or {}
            uri = c.get("uri") if isinstance(c, dict) else None
            if uri:
                return 1
            if depth >= 4:
                return 0
            return sum(_count_coarse_nodes(ch, depth + 1) for ch in (node.get("children") or []))

        total_coarse_tiles = max(1, _count_coarse_nodes(root, 0))
        per_tile_tris = max(4500, min(45000, 200000 // total_coarse_tiles))
        per_tile_tex = (
            2048
            if total_coarse_tiles <= 2
            else (1536 if total_coarse_tiles <= 6 else (1024 if total_coarse_tiles <= 18 else 768))
        )
        per_tile_q = 85 if total_coarse_tiles <= 8 else 82

        def _prune_and_convert(node: dict, depth: int = 0) -> bool:
            nonlocal generated_count
            c = node.get("content") or {}
            uri = c.get("uri") if isinstance(c, dict) else None
            if uri:
                clean_uri = uri.split("?")[0]
                src_glb = os.path.join(base_dir, clean_uri)
                if src_glb.lower().endswith("_l0.glb") and os.path.isfile(src_glb[:-7] + "_l1.glb"):
                    src_glb = src_glb[:-7] + "_l1.glb"
                rel_clean = clean_uri.replace("\\", "/").lstrip("/")
                dst_rel = f"preview_low/{rel_clean}"
                dst_glb = os.path.join(base_dir, dst_rel)
                is_multiscan_tile = os.path.basename(clean_uri).lower().startswith("tile_s")
                t_tris = 75000 if is_multiscan_tile else per_tile_tris
                t_tex = 2048 if is_multiscan_tile else per_tile_tex
                t_q = 85 if is_multiscan_tile else per_tile_q
                if os.path.isfile(dst_glb) and not force and os.path.getsize(dst_glb) > 128:
                    v_ts = int(os.path.getmtime(dst_glb))
                    node["content"]["uri"] = f"{dst_rel}?v={v_ts}"
                    generated_count += 1
                elif build_low_quality_preview_glb(
                    src_glb,
                    dst_glb,
                    target_triangles=t_tris,
                    max_tex_dim=t_tex,
                    jpeg_quality=t_q,
                    allow_aggressive=False,
                ):
                    v_ts = int(os.path.getmtime(dst_glb)) if os.path.isfile(dst_glb) else int(time.time())
                    node["content"]["uri"] = f"{dst_rel}?v={v_ts}"
                    generated_count += 1
                node["geometricError"] = 0.0
                node["children"] = []
                return True
            if depth >= 4:
                node["children"] = []
                return False
            kept = []
            for ch in node.get("children") or []:
                if _prune_and_convert(ch, depth + 1):
                    kept.append(ch)
            kept.sort(key=lambda x: 0 if isinstance(x.get("content"), dict) and x["content"].get("uri") else 1)
            node["children"] = kept
            return len(kept) > 0

        _prune_and_convert(root, 0)

    if generated_count == 0:
        return None

    try:
        with open(preview_ts_path, "w", encoding="utf-8") as wf:
            json.dump(preview_ts, wf, separators=(",", ":"))
        return preview_ts_path
    except Exception as e:
        print(f"[PreviewGenerator] Failed writing {preview_ts_path}: {e}")
        return None


# ==============================================================================
# Full-Quality 3D Scan Screenshot Generator (Zoomed to Extents)
# ==============================================================================

def _collect_full_quality_tile_uris(root_node: dict, target_depth: int = 2, max_depth: int = 5) -> List[str]:
    """
    Selects a complete, non-overlapping set of high-resolution GLB tiles from a 3D Tileset
    (at target_depth=2 for octrees, recursing up to max_depth=5 where branches only gain content deeper)
    to render a full-quality screenshot.
    """
    def _walk(node: dict, depth: int = 0) -> List[str]:
        c = node.get("content") or {}
        u = c.get("uri") if isinstance(c, dict) else None
        ch = node.get("children") or []
        if not ch:
            return [u] if u else []
        if depth >= target_depth and u:
            return [u]
        if depth >= max_depth:
            return [u] if u else []
        child_uris: List[str] = []
        all_covered = True
        for child in ch:
            cu = _walk(child, depth + 1)
            if not cu:
                all_covered = False
            child_uris.extend(cu)
        if child_uris and (all_covered or not u):
            return child_uris
        return [u] if u else child_uris

    uris = _walk(root_node, 0)
    seen = set()
    out = []
    for u in uris:
        if u and u not in seen:
            seen.add(u)
            out.append(u)
    return out


def _extract_glb_enh_points_and_colors(
    glb_path: str, has_root_transform: bool
) -> Optional[Tuple[np.ndarray, np.ndarray]]:
    """
    Decodes a full-quality GLB tile (including EXT_meshopt_compression or KHR_texture_transform)
    and samples dense 3D points in (Easting, Northing, Elevation) space along with RGB colors
    from its full-resolution 2K embedded texture.
    """
    if not os.path.isfile(glb_path):
        return None

    tmp_glb = None
    read_path = glb_path
    try:
        with open(glb_path, "rb") as f:
            header_peek = f.read(4096)
        if len(header_peek) < 28 or header_peek[:4] != b"glTF":
            return None
        jl, _ = struct.unpack_from("<I4s", header_peek, 12)
        with open(glb_path, "rb") as f:
            f.seek(20)
            j_peek = json.loads(f.read(jl).decode("utf-8"))

        exts_used = j_peek.get("extensionsUsed") or []
        nodes_peek = j_peek.get("nodes") or []
        needs_gltfpack_decode = (
            "EXT_meshopt_compression" in exts_used
            or "KHR_mesh_quantization" in exts_used
            or any(
                "matrix" in n or "translation" in n or "scale" in n or "rotation" in n
                for n in nodes_peek
                if isinstance(n, dict)
            )
        )
        if needs_gltfpack_decode and os.path.isfile(GLTFPACK_EXE):
            with open(glb_path, "rb") as f_raw:
                raw_src = f_raw.read()
            ox, oy, oz = extract_glb_large_offset(raw_src)
            in_for_decode = glb_path
            tmp_in_dec = None
            if abs(ox) > 1000.0 or abs(oy) > 1000.0:
                fd_in, tmp_in_dec = tempfile.mkstemp(suffix=".glb", prefix="gs_thumb_in_")
                os.close(fd_in)
                with open(tmp_in_dec, "wb") as f_in_dec:
                    f_in_dec.write(shift_glb_node_translation(raw_src, -ox, -oy, -oz))
                in_for_decode = tmp_in_dec
            fd, tmp_glb = tempfile.mkstemp(suffix=".glb", prefix="gs_thumb_")
            os.close(fd)
            res = subprocess.run(
                [GLTFPACK_EXE, "-i", in_for_decode, "-o", tmp_glb, "-noq"],
                capture_output=True,
                timeout=45,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000) if os.name == "nt" else 0,
            )
            if tmp_in_dec and os.path.isfile(tmp_in_dec):
                try:
                    os.remove(tmp_in_dec)
                except Exception:
                    pass
            if res.returncode == 0 and os.path.isfile(tmp_glb) and os.path.getsize(tmp_glb) > 128:
                read_path = tmp_glb
        else:
            ox, oy, oz = 0.0, 0.0, 0.0

        with open(read_path, "rb") as rf:
            raw = rf.read()
        jl, _ = struct.unpack_from("<I4s", raw, 12)
        j = json.loads(raw[20 : 20 + jl].decode("utf-8"))
        boff = 20 + jl
        blen, _ = struct.unpack_from("<I4s", raw, boff)
        bin_data = memoryview(raw)[boff + 8 : boff + 8 + blen]

        bvs = j.get("bufferViews") or []
        accs = j.get("accessors") or []
        imgs = j.get("images") or []
        mats = j.get("materials") or []
        texs = j.get("textures") or []

        decoded_images: Dict[int, np.ndarray] = {}
        for idx_im, im in enumerate(imgs):
            bvi = im.get("bufferView")
            if bvi is not None and 0 <= bvi < len(bvs):
                bv = bvs[bvi]
                off = int(bv.get("byteOffset", 0))
                ln = int(bv.get("byteLength", 0))
                if ln > 0 and off + ln <= len(bin_data):
                    try:
                        pil_img = Image.open(io.BytesIO(bytes(bin_data[off : off + ln]))).convert("RGB")
                        decoded_images[idx_im] = np.asarray(pil_img, dtype=np.uint8)
                    except Exception:
                        pass

        pts_list = []
        col_list = []

        for m in j.get("meshes") or []:
            for p in m.get("primitives") or []:
                attrs = p.get("attributes") or {}
                if "POSITION" not in attrs:
                    continue
                pa = accs[attrs["POSITION"]]
                if pa.get("componentType") != 5126:
                    continue
                pbv = bvs[pa["bufferView"]]
                poff = int(pbv.get("byteOffset", 0)) + int(pa.get("byteOffset", 0))
                pcount = int(pa["count"])
                verts = np.frombuffer(bin_data[poff : poff + pcount * 12], dtype=np.float32).reshape(-1, 3).astype(np.float64)
                if abs(ox) > 1000.0 or abs(oy) > 1000.0:
                    verts[:, 0] += ox
                    verts[:, 1] += oy
                    verts[:, 2] += oz

                tex_arr = decoded_images.get(0)
                uv_offset = np.array([0.0, 0.0], dtype=np.float32)
                uv_scale = np.array([1.0, 1.0], dtype=np.float32)
                has_khr_tt = False
                mat_idx = p.get("material")
                if mat_idx is not None and 0 <= mat_idx < len(mats):
                    pbr = (mats[mat_idx].get("pbrMetallicRoughness") or {})
                    bct = pbr.get("baseColorTexture") or {}
                    t_idx = bct.get("index")
                    if t_idx is not None and 0 <= t_idx < len(texs):
                        src_im = texs[t_idx].get("source")
                        if src_im is None:
                            src_im = ((texs[t_idx].get("extensions") or {}).get("EXT_texture_webp") or {}).get("source")
                        if src_im is not None and src_im in decoded_images:
                            tex_arr = decoded_images[src_im]
                    khr_tt = ((bct.get("extensions") or {}).get("KHR_texture_transform")) or {}
                    if "offset" in khr_tt or "scale" in khr_tt:
                        has_khr_tt = True
                    if "offset" in khr_tt:
                        uv_offset = np.array(khr_tt["offset"][:2], dtype=np.float32)
                    if "scale" in khr_tt:
                        uv_scale = np.array(khr_tt["scale"][:2], dtype=np.float32)

                uvs = None
                if "TEXCOORD_0" in attrs and tex_arr is not None:
                    ua = accs[attrs["TEXCOORD_0"]]
                    if ua.get("componentType") == 5126:
                        ubv = bvs[ua["bufferView"]]
                        uoff = int(ubv.get("byteOffset", 0)) + int(ua.get("byteOffset", 0))
                        ucount = int(ua["count"])
                        raw_uv = np.frombuffer(bin_data[uoff : uoff + ucount * 8], dtype=np.float32).reshape(-1, 2)
                        uvs = raw_uv * uv_scale + uv_offset

                if "indices" in p:
                    ia = accs[p["indices"]]
                    ibv = bvs[ia["bufferView"]]
                    ioff = int(ibv.get("byteOffset", 0)) + int(ia.get("byteOffset", 0))
                    icount = int(ia["count"])
                    ctype = ia.get("componentType")
                    if ctype == 5123:
                        idx = np.frombuffer(bin_data[ioff : ioff + icount * 2], dtype=np.uint16).reshape(-1, 3)
                    elif ctype == 5125:
                        idx = np.frombuffer(bin_data[ioff : ioff + icount * 4], dtype=np.uint32).reshape(-1, 3)
                    else:
                        continue
                else:
                    idx = np.arange(len(verts), dtype=np.uint32).reshape(-1, 3)

                if len(idx) == 0:
                    continue

                v0, v1, v2 = verts[idx[:, 0]], verts[idx[:, 1]], verts[idx[:, 2]]
                if uvs is not None and tex_arr is not None:
                    u0, u1, u2 = uvs[idx[:, 0]], uvs[idx[:, 1]], uvs[idx[:, 2]]
                    th, tw = tex_arr.shape[:2]
                    for w0, w1, w2 in _BARY_GRID:
                        pt = v0 * w0 + v1 * w1 + v2 * w2
                        uv = u0 * w0 + u1 * w1 + u2 * w2
                        if has_khr_tt:
                            u_norm = np.clip(uv[:, 0], 0.0, 1.0)
                            v_norm = np.clip(uv[:, 1], 0.0, 1.0)
                        else:
                            u_norm = np.mod(uv[:, 0], 1.0)
                            v_norm = np.mod(uv[:, 1], 1.0)
                        px = np.clip((u_norm * (tw - 1)).astype(np.int32), 0, tw - 1)
                        py = np.clip((v_norm * (th - 1)).astype(np.int32), 0, th - 1)
                        sampled_col = tex_arr[py, px]
                        # Exclude pure-black (0,0,0) empty atlas padding pixels
                        non_gutter = (sampled_col[:, 0] > 4) | (sampled_col[:, 1] > 4) | (sampled_col[:, 2] > 4)
                        if np.any(non_gutter):
                            pts_list.append(pt[non_gutter])
                            col_list.append(sampled_col[non_gutter])
                else:
                    for w0, w1, w2 in _BARY_GRID[::3]:
                        pt = v0 * w0 + v1 * w1 + v2 * w2
                        pts_list.append(pt)
                        col_list.append(np.full((len(pt), 3), 185, dtype=np.uint8))

        if not pts_list:
            return None

        P = np.vstack(pts_list)
        C = np.vstack(col_list)

        # Convert to (Easting, Northing, Elevation)
        if has_root_transform:
            # glTF Y-up space: X=Easting, Y=Elevation, Z=-Northing -> (X, -Z, Y)
            enh = np.column_stack((P[:, 0], -P[:, 2], P[:, 1]))
        else:
            # Z-up space: X=Easting, Y=Northing, Z=Elevation
            enh = P
        return enh, C
    except Exception as e:
        print(f"[PreviewGenerator] Warning extracting points from {glb_path}: {e}")
        return None
    finally:
        if tmp_glb and os.path.isfile(tmp_glb):
            try:
                os.remove(tmp_glb)
            except Exception:
                pass


def generate_full_quality_zoomed_thumbnail(
    tileset_path: str,
    out_png_paths: List[str],
    width: int = 800,
    height: int = 450,
) -> bool:
    """
    Renders a crisp, full-quality 2D screenshot of the scan zoomed tightly to its 3D extents
    (filling ~88% of the 16:9 frame) and writes it to all paths in `out_png_paths`.
    """
    if not tileset_path or not os.path.isfile(tileset_path) or not out_png_paths:
        return False

    base_dir = os.path.dirname(tileset_path)
    has_root_transform = False
    tile_uris: List[str] = []

    if tileset_path.lower().endswith(".glb"):
        tile_uris = [os.path.basename(tileset_path)]
    else:
        try:
            with open(tileset_path, "r", encoding="utf-8") as f:
                ts = json.load(f)
            root = ts.get("root") or {}
            has_root_transform = bool(root.get("transform"))
            r_uri = (root.get("content") or {}).get("uri")
            if r_uri:
                # For quadtrees, prefer depth-1 tiles (4 tiles, higher resolution) if all exist, else root.glb
                d1_uris = _collect_full_quality_tile_uris(root, target_depth=1, max_depth=1)
                if d1_uris and all(os.path.isfile(os.path.join(base_dir, u)) for u in d1_uris):
                    tile_uris = d1_uris
                else:
                    tile_uris = [r_uri]
            else:
                # For PIX4Dmatic Cesium octrees, collect complete coverage at target_depth=2 (up to depth 5)
                tile_uris = _collect_full_quality_tile_uris(root, target_depth=2, max_depth=5)
        except Exception as e:
            print(f"[PreviewGenerator] Failed reading {tileset_path} for thumbnail: {e}")
            return False

    if not tile_uris:
        return False

    all_pts = []
    all_cols = []
    for u in tile_uris:
        res = _extract_glb_enh_points_and_colors(os.path.join(base_dir, u), has_root_transform)
        if res is not None:
            all_pts.append(res[0])
            all_cols.append(res[1])

    if not all_pts:
        return False

    P = np.vstack(all_pts)
    C = np.vstack(all_cols)

    # Filter extreme 0.5% spatial outliers so stray floating points never shrink the zoom-to-extents framing
    p_lo, p_hi = np.percentile(P, [0.5, 99.5], axis=0)
    in_box = (
        (P[:, 0] >= p_lo[0]) & (P[:, 0] <= p_hi[0]) &
        (P[:, 1] >= p_lo[1]) & (P[:, 1] <= p_hi[1]) &
        (P[:, 2] >= p_lo[2]) & (P[:, 2] <= p_hi[2])
    )
    if np.count_nonzero(in_box) > 1000:
        P = P[in_box]
        C = C[in_box]

    center = (np.percentile(P, 2.0, axis=0) + np.percentile(P, 98.0, axis=0)) * 0.5
    P0 = P - center

    # Isometric 3D perspective/orthographic bird's-eye angle (azimuth -36 deg, elevation 38 deg)
    az = np.radians(-36.0)
    el = np.radians(38.0)
    ca, sa = np.cos(az), np.sin(az)
    ce, se = np.cos(el), np.sin(el)

    rx = P0[:, 0] * ca - P0[:, 1] * sa
    ry_plan = P0[:, 0] * sa + P0[:, 1] * ca
    sy = -ry_plan * se - P0[:, 2] * ce
    depth = -ry_plan * ce + P0[:, 2] * se

    # Tightly zoom to the 0.8th-99.2th percentile screen extents so the scan fills 88% of the 16:9 viewport
    x_lo, x_hi = np.percentile(rx, [0.8, 99.2])
    y_lo, y_hi = np.percentile(sy, [0.8, 99.2])
    span_x = max(1e-3, float(x_hi - x_lo))
    span_y = max(1e-3, float(y_hi - y_lo))

    scale = min((width * 0.88) / span_x, (height * 0.88) / span_y)
    cx_scr = float(x_lo + x_hi) * 0.5
    cy_scr = float(y_lo + y_hi) * 0.5

    px = ((rx - cx_scr) * scale + width * 0.5).astype(np.int32)
    py = ((sy - cy_scr) * scale + height * 0.5).astype(np.int32)

    valid = (px >= 2) & (px < width - 2) & (py >= 2) & (py < height - 2)
    if np.count_nonzero(valid) < 100:
        return False

    px = px[valid]
    py = py[valid]
    depth = depth[valid]
    C = C[valid]

    order = np.argsort(depth)
    px = px[order]
    py = py[order]
    C = C[order]

    C_boost = np.clip(C.astype(np.float32) * 1.12, 0, 255).astype(np.uint8)

    canvas = np.zeros((height, width, 3), dtype=np.uint8)
    y_grad = np.linspace(0.0, 1.0, height, dtype=np.float32)[:, None]
    canvas[:, :, 0] = (14 + y_grad * 10).astype(np.uint8)
    canvas[:, :, 1] = (21 + y_grad * 13).astype(np.uint8)
    canvas[:, :, 2] = (34 + y_grad * 18).astype(np.uint8)

    mask = np.zeros((height, width), dtype=bool)
    # 3x3 splat pass followed by 2x2 and 1x1 sharp center passes for watertight, gap-free surfaces
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            canvas[py + dy, px + dx] = C_boost
            mask[py + dy, px + dx] = True
    for dy in (0, 1):
        for dx in (0, 1):
            canvas[py + dy, px + dx] = C_boost
    canvas[py, px] = C_boost

    # Close any remaining 1-2px interior pinholes inside large triangles
    for _ in range(2):
        unfilled = ~mask[1:-1, 1:-1]
        nbr_h = mask[1:-1, :-2] & mask[1:-1, 2:]
        nbr_v = mask[:-2, 1:-1] & mask[2:, 1:-1]
        fill_h = unfilled & nbr_h
        fill_v = unfilled & (~fill_h) & nbr_v
        if np.any(fill_h):
            canvas[1:-1, 1:-1][fill_h] = (
                (canvas[1:-1, :-2][fill_h].astype(np.uint16) + canvas[1:-1, 2:][fill_h].astype(np.uint16)) // 2
            ).astype(np.uint8)
            mask[1:-1, 1:-1][fill_h] = True
        if np.any(fill_v):
            canvas[1:-1, 1:-1][fill_v] = (
                (canvas[:-2, 1:-1][fill_v].astype(np.uint16) + canvas[2:, 1:-1][fill_v].astype(np.uint16)) // 2
            ).astype(np.uint8)
            mask[1:-1, 1:-1][fill_v] = True

    img_out = Image.fromarray(canvas, mode="RGB")
    saved_any = False
    for out_p in out_png_paths:
        if not out_p:
            continue
        try:
            os.makedirs(os.path.dirname(out_p), exist_ok=True)
            img_out.save(out_p, format="PNG", optimize=True)
            saved_any = True
        except Exception as e:
            print(f"[PreviewGenerator] Warning saving thumbnail {out_p}: {e}")
    return saved_any


def ensure_scan_full_quality_thumbnail(
    tileset_path: str,
    scan_id: str,
    project_dir: Optional[str] = None,
    force: bool = False,
) -> Optional[str]:
    """
    Ensures a full-quality zoomed-to-extents screenshot exists at both:
    - `<project_dir>/thumbnail.png`
    - `<DATA_DIR>/thumbnails/<scan_id>.png`
    Automatically called whenever a scan is uploaded or discovered.
    """
    if not tileset_path or not os.path.isfile(tileset_path):
        return None

    thumbs_dir = os.path.join(DATA_DIR, "thumbnails")
    os.makedirs(thumbs_dir, exist_ok=True)
    data_thumb = os.path.join(thumbs_dir, f"{scan_id}.png")
    proj_thumb = os.path.join(project_dir, "thumbnail.png") if project_dir and os.path.isdir(project_dir) else None

    if not tileset_path.lower().endswith(".glb"):
        try:
            with open(tileset_path, "r", encoding="utf-8") as f:
                ts_check = json.load(f)
            if (ts_check.get("extras") or {}).get("is_gaussian_splat"):
                if proj_thumb and os.path.isfile(proj_thumb) and os.path.getsize(proj_thumb) > 2048:
                    if not os.path.isfile(data_thumb) or force:
                        try:
                            shutil.copy2(proj_thumb, data_thumb)
                        except Exception:
                            pass
                    return proj_thumb
                if os.path.isfile(data_thumb) and os.path.getsize(data_thumb) > 2048:
                    if proj_thumb and not os.path.isfile(proj_thumb):
                        try:
                            shutil.copy2(data_thumb, proj_thumb)
                        except Exception:
                            pass
                    return proj_thumb or data_thumb
                return None
        except Exception:
            pass

    targets = [p for p in (proj_thumb, data_thumb) if p]
    if not force and all(os.path.isfile(p) and os.path.getsize(p) > 4096 for p in targets):
        return proj_thumb or data_thumb

    if generate_full_quality_zoomed_thumbnail(tileset_path, targets):
        return proj_thumb or data_thumb
    return None
