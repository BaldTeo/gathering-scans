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

import copy
import io
import json
import os
import shutil
import struct
import subprocess
import tempfile
from typing import Dict, Any, List, Optional, Tuple

import numpy as np
from PIL import Image

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


def _downscale_glb_textures(raw_bytes: bytes, max_dim: int = 768, jpeg_quality: int = 80) -> bytes:
    """
    Replaces any embedded PNG/JPEG/WebP textures inside a GLB (standard or EXT_meshopt_compression)
    with a crisp, web-optimized JPEG (e.g. 768x768 or 1024x1024 @ quality 80-82) for fast preview streaming.
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
                    pil_im = Image.open(io.BytesIO(bytes(bin_data[off : off + ln]))).convert("RGB")
                    pil_im.thumbnail((max_dim, max_dim), Image.Resampling.LANCZOS)
                    out_buf = io.BytesIO()
                    pil_im.save(out_buf, format="JPEG", quality=jpeg_quality, optimize=True)
                    img_bv_map[bvi] = out_buf.getvalue()
                    im["mimeType"] = "image/jpeg"
                except Exception:
                    pass

        if not img_bv_map:
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


def build_low_quality_preview_glb(
    src_glb_path: str,
    dst_glb_path: str,
    target_triangles: int = 100000,
    max_tex_dim: int = 2048,
    jpeg_quality: int = 85,
    allow_aggressive: bool = False,
) -> bool:
    """
    Generates a clean, watertight preview GLB from src_glb_path into dst_glb_path.
    Preserves KHR_mesh_quantization (-vp 14 -vt 14) so large TWD97 coordinates stay in
    node.translation without float32 precision loss, locks border vertices (-slb), avoids
    -sa UV-island tearing, and embeds crisp textures (2048px for single-root, 1024px for octree).
    """
    if not os.path.isfile(src_glb_path):
        return False
    os.makedirs(os.path.dirname(dst_glb_path), exist_ok=True)

    try:
        with open(src_glb_path, "rb") as f:
            raw_in = f.read()
        orig_tris = _get_glb_triangle_count(raw_in)
        if orig_tris > 0:
            ratio = min(1.0, max(0.22, float(target_triangles) / float(orig_tris)))
        else:
            ratio = 1.0

        tmp_path = dst_glb_path + ".tmp.glb"
        ran_gltfpack = False
        if os.path.isfile(GLTFPACK_EXE) and ratio < 0.85:
            cmd = [
                GLTFPACK_EXE,
                "-i",
                src_glb_path,
                "-o",
                tmp_path,
                "-si",
                f"{ratio:.4f}",
                "-slb",
                "-sv",
                "-vp",
                "14",
                "-vt",
                "14",
                "-cc",
            ]
            if allow_aggressive:
                cmd.insert(-2, "-sa")
            res = subprocess.run(cmd, capture_output=True, timeout=60)
            if res.returncode == 0 and os.path.isfile(tmp_path) and os.path.getsize(tmp_path) > 128:
                ran_gltfpack = True

        if ran_gltfpack:
            with open(tmp_path, "rb") as tf:
                simplified_bytes = tf.read()
            try:
                os.remove(tmp_path)
            except Exception:
                pass
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
    generates `<base_dir>/preview_tileset.json` and watertight preview GLB files inside `<base_dir>/preview_low/`.
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
            tileset_path, preview_glb, target_triangles=100000, max_tex_dim=2048, jpeg_quality=85
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

    preview_ts = copy.deepcopy(ts)
    root = preview_ts.get("root") or {}
    if not root.get("transform"):
        preview_ts.setdefault("asset", {})["gltfUpAxis"] = "Z"

    r_content = root.get("content") or {}
    r_uri = r_content.get("uri") if isinstance(r_content, dict) else None

    os.makedirs(preview_low_dir, exist_ok=True)
    generated_count = 0

    if r_uri:
        # Single-root tileset (Quadtree or single root GLB): keep up to ~110k tris (no -sa seam tearing) and crisp 2048px texture
        clean_r_uri = r_uri.split("?")[0]
        src_glb = os.path.join(base_dir, clean_r_uri)
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
        # PIX4Dmatic Cesium octree: traverse up to depth <= 3 to capture every octant branch's first content node
        # and convert each octant GLB into a watertight preview tile (~24,000 tris, 1024px JPEG, no -sa)
        def _prune_and_convert(node: dict, depth: int = 0) -> bool:
            nonlocal generated_count
            c = node.get("content") or {}
            uri = c.get("uri") if isinstance(c, dict) else None
            if uri:
                clean_uri = uri.split("?")[0]
                src_glb = os.path.join(base_dir, clean_uri)
                rel_clean = clean_uri.replace("\\", "/").lstrip("/")
                dst_rel = f"preview_low/{rel_clean}"
                dst_glb = os.path.join(base_dir, dst_rel)
                if os.path.isfile(dst_glb) and not force and os.path.getsize(dst_glb) > 128:
                    v_ts = int(os.path.getmtime(dst_glb))
                    node["content"]["uri"] = f"{dst_rel}?v={v_ts}"
                    generated_count += 1
                elif build_low_quality_preview_glb(
                    src_glb,
                    dst_glb,
                    target_triangles=24000,
                    max_tex_dim=1024,
                    jpeg_quality=82,
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
            fd, tmp_glb = tempfile.mkstemp(suffix=".glb", prefix="gs_thumb_")
            os.close(fd)
            res = subprocess.run(
                [GLTFPACK_EXE, "-i", glb_path, "-o", tmp_glb, "-noq"],
                capture_output=True,
                timeout=45,
            )
            if res.returncode == 0 and os.path.isfile(tmp_glb) and os.path.getsize(tmp_glb) > 128:
                read_path = tmp_glb

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
                verts = np.frombuffer(bin_data[poff : poff + pcount * 12], dtype=np.float32).reshape(-1, 3)

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

    targets = [p for p in (proj_thumb, data_thumb) if p]
    if not force and all(os.path.isfile(p) and os.path.getsize(p) > 4096 for p in targets):
        return proj_thumb or data_thumb

    if generate_full_quality_zoomed_thumbnail(tileset_path, targets):
        return proj_thumb or data_thumb
    return None
