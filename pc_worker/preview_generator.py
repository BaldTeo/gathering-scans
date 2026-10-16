#!/usr/bin/env python3
"""
Ultra-Low-Quality 3D Scan Preview Generator for GatheringScans.
Generates a lightweight `preview_tileset.json` + `preview_low/*.glb` for each scan
so that the Site Menu 3D Preview loads in <150ms before the user clicks Enlarge
to open the full-resolution 3D Studio.
"""

import copy
import io
import json
import os
import shutil
import struct
import subprocess
from typing import Dict, Any, List, Optional

from pc_worker.config import GC_SCAN_OPTIMIZER_DIR

GLTFPACK_EXE = os.path.join(GC_SCAN_OPTIMIZER_DIR, "bin", "gltfpack.exe")


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


def _downscale_glb_textures(raw_bytes: bytes, max_dim: int = 256, jpeg_quality: int = 40) -> bytes:
    """
    Replaces any embedded PNG/JPEG/WebP textures inside a GLB (standard or EXT_meshopt_compression)
    with a tiny low-resolution JPEG (e.g. 256x256 @ quality 40, ~5-10 KB) for ultra-fast preview streaming.
    """
    if len(raw_bytes) < 28 or raw_bytes[:4] != b"glTF":
        return raw_bytes
    try:
        from PIL import Image

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
                    pil_im.thumbnail((max_dim, max_dim), Image.Resampling.BILINEAR)
                    out_buf = io.BytesIO()
                    pil_im.save(out_buf, format="JPEG", quality=jpeg_quality, optimize=True)
                    img_bv_map[bvi] = out_buf.getvalue()
                    im["mimeType"] = "image/jpeg"
                except Exception:
                    pass

        if not img_bv_map:
            return raw_bytes

        # Strip EXT_texture_webp extension references since we converted embedded textures to image/jpeg
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

        # Collect all binary slices backed by buffer 0 in original offset order
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
    target_triangles: int = 3200,
    max_tex_dim: int = 224,
    jpeg_quality: int = 38,
) -> bool:
    """
    Generates an ultra-low-quality preview GLB from src_glb_path into dst_glb_path.
    Uses gltfpack aggressive simplification (-sa -si <ratio> -noq -cc) + low-res JPEG texture downscaling.
    """
    if not os.path.isfile(src_glb_path):
        return False
    os.makedirs(os.path.dirname(dst_glb_path), exist_ok=True)

    try:
        with open(src_glb_path, "rb") as f:
            raw_in = f.read()
        orig_tris = _get_glb_triangle_count(raw_in)
        if orig_tris > 0:
            ratio = min(0.25, max(0.008, float(target_triangles) / float(orig_tris)))
        else:
            ratio = 0.04

        tmp_path = dst_glb_path + ".tmp.glb"
        ran_gltfpack = False
        if os.path.isfile(GLTFPACK_EXE):
            cmd = [
                GLTFPACK_EXE,
                "-i",
                src_glb_path,
                "-o",
                tmp_path,
                "-si",
                f"{ratio:.4f}",
                "-sa",
                "-sv",
                "-noq",
                "-cc",
            ]
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
    generates `<base_dir>/preview_tileset.json` and ultra-low-quality GLB files inside `<base_dir>/preview_low/`.
    Returns the path to `preview_tileset.json` (or low-quality `.glb` if standalone GLB).
    """
    if not tileset_path or not os.path.isfile(tileset_path):
        return None

    base_dir = os.path.dirname(tileset_path)
    if tileset_path.lower().endswith(".glb"):
        preview_glb = os.path.join(base_dir, "preview_low.glb")
        if not force and os.path.isfile(preview_glb) and os.path.getsize(preview_glb) > 256:
            return preview_glb
        if build_low_quality_preview_glb(tileset_path, preview_glb, target_triangles=3500, max_tex_dim=256, jpeg_quality=40):
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
        # Single-root tileset (Quadtree or single root GLB): only keep root node in preview_tileset.json
        src_glb = os.path.join(base_dir, r_uri)
        rel_clean = r_uri.replace("\\", "/").lstrip("/")
        dst_rel = f"preview_low/{rel_clean}"
        dst_glb = os.path.join(base_dir, dst_rel)
        if build_low_quality_preview_glb(
            src_glb,
            dst_glb,
            target_triangles=3600,
            max_tex_dim=256,
            jpeg_quality=40,
        ):
            root["content"]["uri"] = dst_rel
            generated_count += 1
        root["geometricError"] = 0.0
        root["children"] = []
    else:
        # PIX4Dmatic Cesium octree: prune each top-level branch at its first content node (depth <= 2)
        # and convert each coarsest octant GLB into an ultra-low-poly preview tile (~900 tris, 192px JPEG)
        def _prune_and_convert(node: dict, depth: int = 0) -> bool:
            nonlocal generated_count
            c = node.get("content") or {}
            uri = c.get("uri") if isinstance(c, dict) else None
            if uri:
                src_glb = os.path.join(base_dir, uri)
                rel_clean = uri.replace("\\", "/").lstrip("/")
                dst_rel = f"preview_low/{rel_clean}"
                dst_glb = os.path.join(base_dir, dst_rel)
                if os.path.isfile(dst_glb) and not force and os.path.getsize(dst_glb) > 128:
                    node["content"]["uri"] = dst_rel
                    generated_count += 1
                elif build_low_quality_preview_glb(
                    src_glb,
                    dst_glb,
                    target_triangles=950,
                    max_tex_dim=192,
                    jpeg_quality=36,
                ):
                    node["content"]["uri"] = dst_rel
                    generated_count += 1
                node["geometricError"] = 0.0
                node["children"] = []
                return True
            if depth >= 2:
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
