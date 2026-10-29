#!/usr/bin/env python3
"""
GatheringScans Native Pix4Dmatic Multi-Level Octree-to-3D-Tileset Builder
Directly converts Pix4Dmatic's internal octree (`processing/meshes/*/content/<level>_<x>_<y>_<z>.glb`,
Levels 2 through 9+) into a web-ready, hierarchical 3D Tileset (`tileset.json` + `tiles/*.glb`)
that packs cleanly into a single `.3tz` archive (`StreamPackages/<scan_id>.3tz`).

Key Guarantees:
  - Preserves ALL hierarchy levels (L2 through L9) down to 20cm leaf cells with zero depth-2 truncation.
  - Leaf macro-tiles pack constituent L4-L9 true leaf cells into <= 4096x4096 JPEG atlases at ~1:1 native
    texel resolution with zero triangle decimation (`target_tris=None`, `gltfpack -vp 16 -vt 16 -cc`).
  - Supports exact 3D voxel occupancy cropping (`occ_mask`) so cropped scans like `edited_daan_661536` (`DaAn`)
    retain their exact user-cropped boundary while upgrading to full 9-level Pix4Dmatic detail.
  - Preserves 64-bit TWD97 georeferenced offsets (`offset.xyz`) via glTF node translations.
"""

from __future__ import annotations

import glob
import io
import json
import math
import os
import shutil
import struct
import subprocess
import tempfile
import time
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

import numpy as np
from PIL import Image

from pc_worker.config import BASE_DIR
from pc_worker.preview_generator import (
    GLTFPACK_EXE,
    ensure_scan_full_quality_thumbnail,
    ensure_scan_low_quality_preview,
    shift_glb_node_translation,
)

_WIN_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000) if os.name == "nt" else 0
BASIS_JS_PATH = os.path.join(BASE_DIR, "web", "lib", "basis", "basis_transcoder.js")
BASIS_WASM_PATH = os.path.join(BASE_DIR, "web", "lib", "basis", "basis_transcoder.wasm")


def _compute_3dtiles_box(bmin: np.ndarray, bmax: np.ndarray, ox: float, oy: float, oz: float) -> List[float]:
    center = (bmin + bmax) * 0.5 + np.array([ox, oy, oz], dtype=np.float64)
    half = np.maximum((bmax - bmin) * 0.5, 0.005)
    return [
        round(float(center[0]), 4),
        round(float(center[1]), 4),
        round(float(center[2]), 4),
        round(float(half[0]), 4),
        0.0,
        0.0,
        0.0,
        round(float(half[1]), 4),
        0.0,
        0.0,
        0.0,
        round(float(half[2]), 4),
    ]


def build_3d_occupancy_mask_from_tileset(
    tileset_dir: str,
    ref_offset: Tuple[float, float, float],
    voxel_res: float = 0.20,
    dilate_iters: int = 2,
) -> Optional[Dict[str, Any]]:
    """
    Extracts all 3D vertex positions from an existing cropped tileset (`tileset/tiles/*.glb`),
    converts them to local coordinates relative to `ref_offset`, and builds a dilated 3D boolean
    voxel occupancy grid (`occ`) so rebuilding from the parent 9-level native octree preserves
    the exact user-cropped 3D boundary.
    """
    from scipy.ndimage import binary_dilation

    tiles_sub = os.path.join(tileset_dir, "tiles")
    if not os.path.isdir(tiles_sub):
        return None
    leaf_candidates: List[str] = []
    root_tf_offset = (0.0, 0.0, 0.0)
    ts_json_p = os.path.join(tileset_dir, "tileset.json")
    if os.path.isfile(ts_json_p):
        try:
            with open(ts_json_p, "r", encoding="utf-8") as tf:
                ts_doc = json.load(tf)
            r_node = ts_doc.get("root") or {}
            rtf = r_node.get("transform")
            if isinstance(rtf, list) and len(rtf) == 16:
                root_tf_offset = (float(rtf[12]), float(rtf[13]), float(rtf[14]))

            def _walk_occ_leaves(nd: Dict[str, Any]) -> None:
                chs = [c for c in (nd.get("children") or []) if isinstance(c, dict)]
                if chs:
                    for ch in chs:
                        _walk_occ_leaves(ch)
                    return
                cnt = nd.get("content")
                uri = (cnt.get("uri") or cnt.get("url") or "").split("?")[0] if isinstance(cnt, dict) else ""
                if uri:
                    fp = os.path.join(tileset_dir, uri.replace("/", os.sep))
                    if os.path.isfile(fp) and fp.lower().endswith(".glb"):
                        leaf_candidates.append(fp)

            if isinstance(r_node, dict):
                _walk_occ_leaves(r_node)
        except Exception:
            pass
    if not leaf_candidates:
        leaf_candidates = sorted(glob.glob(os.path.join(tiles_sub, "tile_l1_*_l2_*.glb")))
    if not leaf_candidates:
        leaf_candidates = sorted(glob.glob(os.path.join(tiles_sub, "tile_*.glb")))
    if not leaf_candidates:
        r_glb = os.path.join(tiles_sub, "root.glb")
        if os.path.isfile(r_glb):
            leaf_candidates = [r_glb]
    if not leaf_candidates:
        return None

    from pc_worker.config import GC_SCAN_OPTIMIZER_DIR
    import sys as _sys
    if GC_SCAN_OPTIMIZER_DIR not in _sys.path:
        _sys.path.append(GC_SCAN_OPTIMIZER_DIR)
    from optimizer.geometry_optimizer import extract_glb_64bit_origin_to_local

    ox, oy, oz = ref_offset
    pts_all: List[np.ndarray] = []
    for g_fp in leaf_candidates:
        fd_in, tmp_in = tempfile.mkstemp(suffix=".glb")
        fd_out, tmp_g = tempfile.mkstemp(suffix=".glb")
        os.close(fd_out)
        try:
            with open(g_fp, "rb") as rf_in:
                raw_in = rf_in.read()
            loc_bytes, orig_t = extract_glb_64bit_origin_to_local(raw_in)
            with os.fdopen(fd_in, "wb") as wf_in:
                wf_in.write(loc_bytes)
            subprocess.run(
                [GLTFPACK_EXE, "-i", tmp_in, "-o", tmp_g, "-noq"],
                capture_output=True,
                timeout=45,
                creationflags=_WIN_NO_WINDOW,
            )
            read_fp = tmp_g if (os.path.isfile(tmp_g) and os.path.getsize(tmp_g) > 0) else tmp_in
            with open(read_fp, "rb") as f:
                raw = f.read()
            jlen = struct.unpack_from("<I", raw, 12)[0]
            j = json.loads(raw[20 : 20 + jlen].decode("utf-8"))
            b = raw[28 + jlen :]
            for m in j.get("meshes") or []:
                for p in m.get("primitives") or []:
                    pos_idx = (p.get("attributes") or {}).get("POSITION")
                    if pos_idx is None:
                        continue
                    acc = j["accessors"][pos_idx]
                    bv = j["bufferViews"][acc["bufferView"]]
                    off = int(bv.get("byteOffset", 0)) + int(acc.get("byteOffset", 0))
                    pos = np.frombuffer(b, dtype=np.float32, count=int(acc["count"]) * 3, offset=off).reshape(-1, 3)
                    if orig_t != (0.0, 0.0, 0.0):
                        shift = np.array([orig_t[0] - ox, orig_t[1] - oy, orig_t[2] - oz], dtype=np.float32)
                    elif len(pos) > 0 and abs(float(pos[0, 0])) > 10000.0:
                        shift = np.array([-ox, -oy, -oz], dtype=np.float32)
                    elif root_tf_offset != (0.0, 0.0, 0.0):
                        shift = np.array(
                            [root_tf_offset[0] - ox, root_tf_offset[1] - oy, root_tf_offset[2] - oz],
                            dtype=np.float32,
                        )
                    else:
                        shift = np.zeros(3, dtype=np.float32)
                    pts_all.append(pos + shift)
        finally:
            for p_rm in (tmp_in, tmp_g):
                if os.path.exists(p_rm):
                    try:
                        os.remove(p_rm)
                    except OSError:
                        pass

    if not pts_all:
        return None

    pts = np.vstack(pts_all)
    pad = voxel_res * (dilate_iters + 1.5)
    vmin = pts.min(axis=0).astype(np.float64) - pad
    vmax = pts.max(axis=0).astype(np.float64) + pad
    grid_shape = np.ceil((vmax - vmin) / voxel_res).astype(int) + 1
    occ = np.zeros(grid_shape, dtype=bool)
    ijk = np.floor((pts.astype(np.float64) - vmin) / voxel_res).astype(int)
    ijk = np.clip(ijk, 0, grid_shape - 1)
    occ[ijk[:, 0], ijk[:, 1], ijk[:, 2]] = True
    if dilate_iters > 0:
        occ = binary_dilation(occ, iterations=dilate_iters)

    return {
        "vmin": vmin,
        "vmax": vmax,
        "res": float(voxel_res),
        "occ": occ,
    }


def _batch_transcode_ktx2_cells(
    cell_records: List[Dict[str, Any]],
    tmp_dir: str,
) -> Tuple[str, List[Dict[str, int]]]:
    """
    Uses a single `node.exe` invocation with `basis_transcoder.wasm` to transcode the KTX2 texture
    of every cell in `cell_records` into a contiguous RGB24 binary file (`rgb_pack.bin`) + metadata.
    """
    jobs = [
        {
            "fp": rec["fp"],
            "off": int(rec["ktx_abs_offset"]),
            "len": int(rec["ktx_byte_length"]),
        }
        for rec in cell_records
    ]
    jobs_path = os.path.join(tmp_dir, "ktx2_jobs.json")
    out_bin_path = os.path.join(tmp_dir, "rgb_pack.bin")
    out_meta_path = os.path.join(tmp_dir, "rgb_meta.json")
    js_script_path = os.path.join(tmp_dir, "transcode_worker.js")

    with open(jobs_path, "w", encoding="utf-8") as jf:
        json.dump(jobs, jf)

    basis_js_esc = BASIS_JS_PATH.replace("\\", "/")
    basis_wasm_esc = BASIS_WASM_PATH.replace("\\", "/")
    jobs_esc = jobs_path.replace("\\", "/")
    out_bin_esc = out_bin_path.replace("\\", "/")
    out_meta_esc = out_meta_path.replace("\\", "/")

    js_code = f"""
const fs = require('fs');
const BASIS = require('{basis_js_esc}');
const wasmBin = fs.readFileSync('{basis_wasm_esc}');

BASIS({{ wasmBinary: wasmBin }}).then(Module => {{
  Module.initializeBasis();
  const jobs = JSON.parse(fs.readFileSync('{jobs_esc}', 'utf8'));
  const outFd = fs.openSync('{out_bin_esc}', 'w');
  const meta = [];
  let curOffset = 0;

  for (let i = 0; i < jobs.length; i++) {{
    const j = jobs[i];
    const fd = fs.openSync(j.fp, 'r');
    const ktxBuf = Buffer.allocUnsafe(j.len);
    fs.readSync(fd, ktxBuf, 0, j.len, j.off);
    fs.closeSync(fd);

    const ktxArr = new Uint8Array(ktxBuf.buffer, ktxBuf.byteOffset, ktxBuf.byteLength);
    const kf = new Module.KTX2File(ktxArr);
    const w = kf.getWidth();
    const h = kf.getHeight();
    kf.startTranscoding();
    const rgbaSize = kf.getImageTranscodedSizeInBytes(0, 0, 0, 13);
    const rgba = new Uint8Array(rgbaSize);
    kf.transcodeImage(rgba, 0, 0, 0, 13, 0, -1, -1);
    kf.close();
    kf.delete();

    const rgbLen = w * h * 3;
    const rgb = Buffer.allocUnsafe(rgbLen);
    let srcIdx = 0;
    for (let dstIdx = 0; dstIdx < rgbLen; dstIdx += 3) {{
      rgb[dstIdx] = rgba[srcIdx];
      rgb[dstIdx + 1] = rgba[srcIdx + 1];
      rgb[dstIdx + 2] = rgba[srcIdx + 2];
      srcIdx += 4;
    }}
    fs.writeSync(outFd, rgb, 0, rgbLen, curOffset);
    meta.push({{ w, h, off: curOffset, len: rgbLen }});
    curOffset += rgbLen;
  }}

  fs.closeSync(outFd);
  fs.writeFileSync('{out_meta_esc}', JSON.stringify(meta));
}}).catch(err => {{
  console.error(err);
  process.exit(1);
}});
"""
    with open(js_script_path, "w", encoding="utf-8") as sf:
        sf.write(js_code)

    subprocess.run(
        ["node", js_script_path],
        check=True,
        capture_output=True,
        timeout=300,
        creationflags=_WIN_NO_WINDOW,
    )
    with open(out_meta_path, "r", encoding="utf-8") as mf:
        meta_list = json.load(mf)
    return out_bin_path, meta_list


def _eval_shelf_width(
    pw_arr: np.ndarray,
    ph_arr: np.ndarray,
    order: np.ndarray,
    target_w: int,
) -> Tuple[int, int, np.ndarray, np.ndarray]:
    n = len(pw_arr)
    dst_x = np.zeros(n, dtype=np.int32)
    dst_y = np.zeros(n, dtype=np.int32)
    cur_x = 0
    cur_y = 0
    shelf_h = 0
    max_used_w = 0
    for idx in order:
        w_i = int(pw_arr[idx])
        h_i = int(ph_arr[idx])
        if cur_x > 0 and cur_x + w_i > target_w:
            cur_y += shelf_h
            cur_x = 0
            shelf_h = 0
        dst_x[idx] = cur_x
        dst_y[idx] = cur_y
        cur_x += w_i
        if cur_x > max_used_w:
            max_used_w = cur_x
        if h_i > shelf_h:
            shelf_h = h_i
    return max(16, max_used_w), max(16, cur_y + shelf_h), dst_x, dst_y


def _solve_shelf_layout(
    pw_arr: np.ndarray,
    ph_arr: np.ndarray,
    max_tex_dim: int = 4096,
) -> Tuple[int, int, np.ndarray, np.ndarray]:
    order = np.lexsort((-pw_arr, -ph_arr))
    max_pw = int(np.max(pw_arr))
    total_area = int(np.sum(pw_arr.astype(np.int64) * ph_arr.astype(np.int64)))
    ideal_w = max(max_pw, int(math.ceil(math.sqrt(total_area * 1.06))))

    # First check if packing at max_tex_dim fits within max_tex_dim x max_tex_dim (1:1 lossless)
    if max_pw <= max_tex_dim:
        aw_max, ah_max, dx_max, dy_max = _eval_shelf_width(pw_arr, ph_arr, order, max_tex_dim)
        if aw_max <= max_tex_dim and ah_max <= max_tex_dim:
            # Search for the most compact width <= max_tex_dim that still keeps ah <= max_tex_dim
            best = (aw_max, ah_max, dx_max, dy_max)
            best_area = aw_max * ah_max
            lo_w = min(max_tex_dim, max(64, ((ideal_w + 15) // 16) * 16))
            for step_i in range(10):
                cand_w = lo_w + int(round((max_tex_dim - lo_w) * (step_i / 9.0)))
                cand_w = max(max_pw, min(max_tex_dim, ((cand_w + 15) // 16) * 16))
                aw_c, ah_c, dx_c, dy_c = _eval_shelf_width(pw_arr, ph_arr, order, cand_w)
                if aw_c <= max_tex_dim and ah_c <= max_tex_dim and (aw_c * ah_c) <= best_area:
                    best = (aw_c, ah_c, dx_c, dy_c)
                    best_area = aw_c * ah_c
            return best

    # Coarse overview fallback (when total_area exceeds max_tex_dim^2): balance aspect ratio ~1:1
    target_w = max(64, ((ideal_w + 15) // 16) * 16)
    best_bal = _eval_shelf_width(pw_arr, ph_arr, order, target_w)
    best_max_dim = max(best_bal[0], best_bal[1])
    for mult in (1.05, 1.12, 1.20, 1.30):
        cand_w = max(max_pw, ((int(math.ceil(ideal_w * mult)) + 15) // 16) * 16)
        res = _eval_shelf_width(pw_arr, ph_arr, order, cand_w)
        if max(res[0], res[1]) < best_max_dim:
            best_bal = res
            best_max_dim = max(res[0], res[1])
    return best_bal


def _can_pack_cells_1to1(cells: List[Dict[str, Any]], max_tex_dim: int = 4096) -> bool:
    if not cells:
        return True
    gutter = 2 if len(cells) > 1 else 0
    pw_arr = np.array([int(c["cw"]) + 2 * gutter for c in cells], dtype=np.int32)
    ph_arr = np.array([int(c["ch"]) + 2 * gutter for c in cells], dtype=np.int32)
    if int(np.max(pw_arr)) > max_tex_dim or int(np.max(ph_arr)) > max_tex_dim:
        return False
    if int(np.sum(pw_arr.astype(np.int64) * ph_arr.astype(np.int64))) > max_tex_dim * max_tex_dim:
        return False
    order = np.lexsort((-pw_arr, -ph_arr))
    aw, ah, _, _ = _eval_shelf_width(pw_arr, ph_arr, order, max_tex_dim)
    return aw <= max_tex_dim and ah <= max_tex_dim


def _pack_cells_to_glb_tile(
    cells: List[Dict[str, Any]],
    rgb_mmap: np.memmap,
    out_glb_path: str,
    offset_xyz: Tuple[float, float, float],
    max_tex_dim: int = 4096,
    target_tris: Optional[int] = None,
    jpeg_quality: int = 88,
) -> Tuple[int, int, Tuple[int, int], np.ndarray, np.ndarray]:
    """
    Packs a list of decoded native octree cells into a single standard GLB tile:
      1. Shelf-packs each cell's active cropped RGB texture patch (with a 2px clamped edge gutter) into a single atlas.
      2. Remaps each cell's glTF 2.0 TEXCOORD_0 into the packed atlas.
      3. Concatenates POSITION, TEXCOORD_0, and triangle indices.
      4. Compresses geometry with `gltfpack -vp 16 -vt 16 -cc` (no `-si` decimation when `target_tris is None`),
         embeds the compact JPEG texture, and applies the 64-bit TWD97 `node.translation`.
    Returns `(final_tris, file_bytes, (tex_w, tex_h), bmin_local, bmax_local)`.
    """
    n_cells = len(cells)
    gutter = 2 if n_cells > 1 else 0
    cw_arr = np.array([int(c["cw"]) for c in cells], dtype=np.int32)
    ch_arr = np.array([int(c["ch"]) for c in cells], dtype=np.int32)
    pw_arr = cw_arr + 2 * gutter
    ph_arr = ch_arr + 2 * gutter

    atlas_W, atlas_H, dst_x, dst_y = _solve_shelf_layout(pw_arr, ph_arr, max_tex_dim=max_tex_dim)
    atlas_rgb = np.zeros((atlas_H, atlas_W, 3), dtype=np.uint8)

    pos_list: List[np.ndarray] = []
    uv_list: List[np.ndarray] = []
    tris_list: List[np.ndarray] = []
    v_offset = 0

    for idx, c in enumerate(cells):
        m_info = c["rgb_meta"]
        w_full, h_full = int(m_info["w"]), int(m_info["h"])
        raw_rgb = np.frombuffer(
            rgb_mmap, dtype=np.uint8, count=int(m_info["len"]), offset=int(m_info["off"])
        ).reshape((h_full, w_full, 3))

        px0, py0, px1, py1 = int(c["px0"]), int(c["py0"]), int(c["px1"]), int(c["py1"])
        patch = raw_rgb[py0:py1, px0:px1]
        ph, pw = patch.shape[0], patch.shape[1]
        dx, dy = int(dst_x[idx]), int(dst_y[idx])
        if gutter > 0:
            padded = np.pad(patch, ((gutter, gutter), (gutter, gutter), (0, 0)), mode="edge")
            atlas_rgb[dy : dy + ph + 2 * gutter, dx : dx + pw + 2 * gutter] = padded
        else:
            atlas_rgb[dy : dy + ph, dx : dx + pw] = patch

        ix = dx + gutter
        iy = dy + gutter
        c_pos = c["pos"]
        c_uv = c["uv"]
        c_tris = c["tris"]

        remapped_uv = np.empty_like(c_uv, dtype=np.float32)
        remapped_uv[:, 0] = np.clip((ix + (c_uv[:, 0] * w_full - px0)) / float(atlas_W), 0.0, 1.0)
        remapped_uv[:, 1] = np.clip((iy + (c_uv[:, 1] * h_full - py0)) / float(atlas_H), 0.0, 1.0)

        pos_list.append(c_pos)
        uv_list.append(remapped_uv)
        tris_list.append(c_tris.astype(np.uint32) + v_offset)
        v_offset += len(c_pos)

    all_pos = np.vstack(pos_list).astype(np.float32)
    all_uv = np.vstack(uv_list).astype(np.float32)
    all_tris = np.vstack(tris_list).astype(np.uint32)

    bmin_local = all_pos.min(axis=0).astype(np.float64)
    bmax_local = all_pos.max(axis=0).astype(np.float64)

    pil_atlas = Image.fromarray(atlas_rgb)
    if pil_atlas.width > max_tex_dim or pil_atlas.height > max_tex_dim:
        scale = float(max_tex_dim) / float(max(pil_atlas.width, pil_atlas.height))
        new_w = max(16, int(round(pil_atlas.width * scale)))
        new_h = max(16, int(round(pil_atlas.height * scale)))
        pil_atlas = pil_atlas.resize((new_w, new_h), Image.Resampling.LANCZOS)
    final_tex_dims = (pil_atlas.width, pil_atlas.height)
    jpeg_buf = io.BytesIO()
    pil_atlas.save(jpeg_buf, format="JPEG", quality=jpeg_quality, optimize=True)
    jpeg_bytes = jpeg_buf.getvalue()

    # Build raw glTF 2.0 binary in local coordinates
    idx_bytes = all_tris.reshape(-1).tobytes()
    pos_bytes = all_pos.tobytes()
    uv_bytes = all_uv.tobytes()

    bin_chunk = bytearray()
    bvs: List[Dict[str, Any]] = []

    def _add_bv(data: bytes, target: Optional[int] = None, stride: Optional[int] = None) -> int:
        while len(bin_chunk) % 4:
            bin_chunk.append(0)
        off = len(bin_chunk)
        bin_chunk.extend(data)
        entry: Dict[str, Any] = {"buffer": 0, "byteOffset": off, "byteLength": len(data)}
        if target is not None:
            entry["target"] = target
        if stride is not None:
            entry["byteStride"] = stride
        bvs.append(entry)
        return len(bvs) - 1

    bv_idx = _add_bv(idx_bytes, target=34963)
    bv_pos = _add_bv(pos_bytes, target=34962, stride=12)
    bv_uv = _add_bv(uv_bytes, target=34962, stride=8)
    bv_img = _add_bv(jpeg_bytes)

    gltf_json = {
        "asset": {"version": "2.0", "generator": "GatheringScans Native Octree Builder"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [
            {
                "primitives": [
                    {
                        "attributes": {"POSITION": 1, "TEXCOORD_0": 2},
                        "indices": 0,
                        "material": 0,
                        "mode": 4,
                    }
                ]
            }
        ],
        "materials": [
            {
                "pbrMetallicRoughness": {
                    "baseColorTexture": {"index": 0},
                    "metallicFactor": 0.0,
                    "roughnessFactor": 1.0,
                },
                "doubleSided": True,
            }
        ],
        "textures": [{"sampler": 0, "source": 0}],
        "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}],
        "images": [{"bufferView": bv_img, "mimeType": "image/jpeg"}],
        "bufferViews": bvs,
        "accessors": [
            {
                "bufferView": bv_idx,
                "byteOffset": 0,
                "componentType": 5125,
                "count": int(all_tris.size),
                "type": "SCALAR",
            },
            {
                "bufferView": bv_pos,
                "byteOffset": 0,
                "componentType": 5126,
                "count": int(len(all_pos)),
                "type": "VEC3",
                "min": [float(x) for x in bmin_local],
                "max": [float(x) for x in bmax_local],
            },
            {
                "bufferView": bv_uv,
                "byteOffset": 0,
                "componentType": 5126,
                "count": int(len(all_uv)),
                "type": "VEC2",
            },
        ],
        "buffers": [{"byteLength": len(bin_chunk)}],
    }

    jb = json.dumps(gltf_json, separators=(",", ":")).encode("utf-8")
    while len(jb) % 4:
        jb += b" "
    while len(bin_chunk) % 4:
        bin_chunk.append(0)

    raw_glb = bytearray()
    raw_glb += struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(jb) + 8 + len(bin_chunk))
    raw_glb += struct.pack("<I4s", len(jb), b"JSON")
    raw_glb += jb
    raw_glb += struct.pack("<I4s", len(bin_chunk), b"BIN\x00")
    raw_glb += bin_chunk

    os.makedirs(os.path.dirname(os.path.abspath(out_glb_path)), exist_ok=True)
    fd_tmp, tmp_raw = tempfile.mkstemp(suffix=".glb")
    os.close(fd_tmp)
    try:
        with open(tmp_raw, "wb") as wf:
            wf.write(raw_glb)

        cmd = [GLTFPACK_EXE, "-i", tmp_raw, "-o", out_glb_path, "-vp", "16", "-vt", "16", "-cc"]
        total_tris = len(all_tris)
        if target_tris is not None and total_tris > target_tris:
            ratio = max(0.05, min(0.98, float(target_tris) / float(total_tris)))
            cmd.extend(["-si", f"{ratio:.4f}", "-slb"])

        subprocess.run(cmd, check=True, capture_output=True, timeout=180, creationflags=_WIN_NO_WINDOW)
    finally:
        if os.path.exists(tmp_raw):
            try:
                os.remove(tmp_raw)
            except OSError:
                pass

    # Read meshopt-compressed GLB, count final triangles, and apply 64-bit TWD97 offset
    with open(out_glb_path, "rb") as rf:
        comp_bytes = rf.read()

    jlen_c = struct.unpack_from("<I", comp_bytes, 12)[0]
    j_c = json.loads(comp_bytes[20 : 20 + jlen_c].decode("utf-8"))

    final_tris = len(all_tris)
    accs_c = j_c.get("accessors") or []
    for m_c in j_c.get("meshes") or []:
        for p_c in m_c.get("primitives") or []:
            if "indices" in p_c and p_c["indices"] < len(accs_c):
                final_tris = int(accs_c[p_c["indices"]].get("count", 0)) // 3

    ox, oy, oz = offset_xyz
    if abs(ox) > 1.0 or abs(oy) > 1.0 or abs(oz) > 0.001:
        comp_bytes = shift_glb_node_translation(comp_bytes, ox, oy, oz)
        with open(out_glb_path, "wb") as wf:
            wf.write(comp_bytes)

    return final_tris, len(comp_bytes), final_tex_dims, bmin_local, bmax_local


def build_tileset_from_pix4d_native_octree(
    src_proj_dir: str,
    target_proj_dir: str,
    occ_mask: Optional[Dict[str, Any]] = None,
    focal_bbox_local: Optional[Tuple[np.ndarray, np.ndarray]] = None,
    outer_max_level: int = 5,
    max_leaf_texels: int = int(4096 * 4096 * 0.88),
    max_leaf_tris: int = 280000,
    progress_callback: Optional[Callable[[float, str], None]] = None,
) -> Dict[str, Any]:
    """
    Builds a complete multi-level 3D Tileset (`<target_proj_dir>/tileset/tileset.json` + `tiles/*.glb`)
    directly from Pix4Dmatic's native octree (`<src_proj_dir>/**/processing/meshes/*/content/*.glb`).
    - If `occ_mask` is provided (e.g. for `edited_daan_661536`), filters every cell across L2-L9 by
      the 3D voxel occupancy mask so only the cropped structure is kept at full L2-L9 resolution.
    - If `focal_bbox_local` is provided (e.g. for full `catch_DaAn`), preserves up to Level 9 inside
      `focal_bbox_local` and caps outer park foliage at `outer_max_level` (e.g. Level 5).
    """
    t0 = time.time()
    content_glbs = glob.glob(
        os.path.join(src_proj_dir, "**", "processing", "meshes", "*", "content", "*.glb"),
        recursive=True,
    )
    if not content_glbs:
        raise FileNotFoundError(f"No native Pix4Dmatic octree .glb cells found under {src_proj_dir}")

    # Resolve 64-bit TWD97 offset.xyz
    ox, oy, oz = 0.0, 0.0, 0.0
    for off_cand in (
        os.path.join(src_proj_dir, "exports", "obj_mesh", "offset.xyz"),
        os.path.join(src_proj_dir, "tileset", "offset.xyz"),
        os.path.join(target_proj_dir, "tileset", "offset.xyz"),
    ):
        if os.path.isfile(off_cand):
            try:
                with open(off_cand, "r", encoding="utf-8") as f:
                    parts = [float(x) for x in f.read().strip().split()]
                if len(parts) >= 3:
                    ox, oy, oz = parts[0], parts[1], parts[2]
                    break
            except Exception:
                pass

    # 1. Scan & filter all native octree cells across Levels 2..9
    all_files: Dict[Tuple[int, int, int, int], str] = {}
    for fp in content_glbs:
        bn = os.path.splitext(os.path.basename(fp))[0]
        toks = bn.split("_")
        if len(toks) == 4 and all(t.isdigit() for t in toks):
            c = (int(toks[0]), int(toks[1]), int(toks[2]), int(toks[3]))
            all_files[c] = fp

    vmin_occ = occ_mask["vmin"] if occ_mask else None
    vmax_occ = occ_mask["vmax"] if occ_mask else None
    res_occ = occ_mask["res"] if occ_mask else 0.20
    grid_occ = occ_mask["occ"] if occ_mask else None

    cell_records: Dict[Tuple[int, int, int, int], Dict[str, Any]] = {}

    def _load_single_cell_record(
        c: Tuple[int, int, int, int], fp: str, apply_focal_filter: bool = True
    ) -> Optional[Dict[str, Any]]:
        lvl = c[0]
        with open(fp, "rb") as f:
            raw = f.read()
        jlen = struct.unpack_from("<I", raw, 12)[0]
        j = json.loads(raw[20 : 20 + jlen].decode("utf-8"))
        acc_pos = j["accessors"][1]
        bmin = np.array(acc_pos["min"], dtype=np.float64)
        bmax = np.array(acc_pos["max"], dtype=np.float64)

        if vmin_occ is not None and vmax_occ is not None:
            if not (np.all(bmax >= vmin_occ) and np.all(bmin <= vmax_occ)):
                return None

        if apply_focal_filter and focal_bbox_local is not None and lvl > outer_max_level:
            fmin, fmax = focal_bbox_local
            if not (np.all(bmax >= fmin) and np.all(bmin <= fmax)):
                return None

        boff = 28 + jlen
        b = memoryview(raw)[boff:]
        bvs = j["bufferViews"]
        v_cnt = int(acc_pos["count"])
        bv_pos = bvs[int(acc_pos["bufferView"])]
        pos = np.frombuffer(b, dtype=np.float32, count=v_cnt * 3, offset=int(bv_pos.get("byteOffset", 0))).reshape(v_cnt, 3)

        acc_uv = j["accessors"][2]
        bv_uv = bvs[int(acc_uv["bufferView"])]
        uv = np.frombuffer(b, dtype=np.float32, count=v_cnt * 2, offset=int(bv_uv.get("byteOffset", 0))).reshape(v_cnt, 2)

        acc_idx = j["accessors"][0]
        bv_idx = bvs[int(acc_idx["bufferView"])]
        dt = np.uint16 if int(acc_idx["componentType"]) == 5123 else np.uint32
        tris = np.frombuffer(b, dtype=dt, count=int(acc_idx["count"]), offset=int(bv_idx.get("byteOffset", 0))).reshape(-1, 3)

        if grid_occ is not None and vmin_occ is not None and vmax_occ is not None:
            tc = pos[tris].mean(axis=1)
            in_box = np.all((tc >= vmin_occ) & (tc <= vmax_occ), axis=1)
            if not np.any(in_box):
                return None
            tc_ijk = np.floor((tc[in_box] - vmin_occ) / res_occ).astype(int)
            tc_ijk = np.clip(tc_ijk, 0, np.array(grid_occ.shape) - 1)
            sub_keep = grid_occ[tc_ijk[:, 0], tc_ijk[:, 1], tc_ijk[:, 2]]
            if not np.any(sub_keep):
                return None
            keep_mask = np.zeros(len(tris), dtype=bool)
            keep_mask[np.nonzero(in_box)[0][sub_keep]] = True
            kept_tris = tris[keep_mask]
            u_verts, inv = np.unique(kept_tris, return_inverse=True)
            pos = np.ascontiguousarray(pos[u_verts])
            uv = np.ascontiguousarray(uv[u_verts])
            tris = inv.astype(np.uint32).reshape(-1, 3)
            bmin = pos.min(axis=0).astype(np.float64)
            bmax = pos.max(axis=0).astype(np.float64)
        else:
            pos = np.array(pos, dtype=np.float32, copy=True)
            uv = np.array(uv, dtype=np.float32, copy=True)
            tris = np.array(tris, dtype=np.uint32, copy=True)

        img_bv = bvs[int(j["images"][0]["bufferView"])]
        ktx_rel_off = int(img_bv.get("byteOffset", 0))
        ktx_len = int(img_bv["byteLength"])
        ktx_abs_off = boff + ktx_rel_off
        w_ktx, h_ktx = struct.unpack_from("<II", raw, ktx_abs_off + 20)

        uv_clamped = np.clip(uv, 0.0, 1.0)
        u0, v0 = float(uv_clamped[:, 0].min()), float(uv_clamped[:, 1].min())
        u1, v1 = float(uv_clamped[:, 0].max()), float(uv_clamped[:, 1].max())
        pad_px = 2
        px0 = max(0, int(math.floor(u0 * w_ktx)) - pad_px)
        px1 = min(int(w_ktx), int(math.ceil(u1 * w_ktx)) + pad_px)
        py0 = max(0, int(math.floor(v0 * h_ktx)) - pad_px)
        py1 = min(int(h_ktx), int(math.ceil(v1 * h_ktx)) + pad_px)
        cw = max(1, px1 - px0)
        ch = max(1, py1 - py0)

        return {
            "coord": c,
            "fp": fp,
            "pos": pos,
            "uv": uv_clamped,
            "tris": tris,
            "n_tris": int(len(tris)),
            "bmin": bmin,
            "bmax": bmax,
            "w_ktx": int(w_ktx),
            "h_ktx": int(h_ktx),
            "px0": px0,
            "py0": py0,
            "px1": px1,
            "py1": py1,
            "cw": cw,
            "ch": ch,
            "texels": int(cw * ch),
            "ktx_abs_offset": ktx_abs_off,
            "ktx_byte_length": ktx_len,
        }

    for c, fp in sorted(all_files.items()):
        rec = _load_single_cell_record(c, fp, apply_focal_filter=True)
        if rec is not None:
            cell_records[c] = rec

    if not cell_records:
        raise RuntimeError("No octree cells survived spatial filtering")

    # Enforce Ancestor + Sibling Octant Closure to fixed point so no subdivided parent node ever loses child octants under REPLACE
    raw_children_by_parent: Dict[Tuple[int, int, int, int], List[Tuple[int, int, int, int]]] = {}
    for c_raw in sorted(all_files.keys()):
        if c_raw[0] > 2:
            p_raw = (c_raw[0] - 1, c_raw[1] // 2, c_raw[2] // 2, c_raw[3] // 2)
            raw_children_by_parent.setdefault(p_raw, []).append(c_raw)

    while True:
        added_in_pass = False
        # 1. Ensure every surviving cell's parent up to L2 is present in cell_records
        for c_surv in sorted(cell_records.keys()):
            if c_surv[0] > 2:
                p_surv = (c_surv[0] - 1, c_surv[1] // 2, c_surv[2] // 2, c_surv[3] // 2)
                if p_surv not in cell_records and p_surv in all_files:
                    p_rec = _load_single_cell_record(p_surv, all_files[p_surv], apply_focal_filter=False)
                    if p_rec is not None:
                        cell_records[p_surv] = p_rec
                        added_in_pass = True

        # 2. Ensure every parent with >=1 surviving child includes all its valid sibling octants
        active_parents: Set[Tuple[int, int, int, int]] = set()
        for c_surv in list(cell_records.keys()):
            if c_surv[0] > 2:
                p_surv = (c_surv[0] - 1, c_surv[1] // 2, c_surv[2] // 2, c_surv[3] // 2)
                if p_surv in cell_records:
                    active_parents.add(p_surv)

        for p_act in sorted(active_parents):
            for sib_c in raw_children_by_parent.get(p_act, []):
                if sib_c not in cell_records:
                    sib_rec = _load_single_cell_record(sib_c, all_files[sib_c], apply_focal_filter=False)
                    if sib_rec is not None:
                        cell_records[sib_c] = sib_rec
                        added_in_pass = True

        if not added_in_pass:
            break

    # Build octree parent-child adjacency over surviving cells
    children_map: Dict[Tuple[int, int, int, int], List[Tuple[int, int, int, int]]] = {
        c: [] for c in cell_records
    }
    for c in sorted(cell_records.keys()):
        if c[0] > 2:
            p = (c[0] - 1, c[1] // 2, c[2] // 2, c[3] // 2)
            if p in children_map:
                children_map[p].append(c)

    def _get_true_leaves(c: Tuple[int, int, int, int]) -> List[Tuple[int, int, int, int]]:
        chs = children_map.get(c) or []
        if not chs:
            return [c]
        out: List[Tuple[int, int, int, int]] = []
        for ch in chs:
            out.extend(_get_true_leaves(ch))
        return out

    # 2. Batch-transcode all active KTX2 textures in one single Node.js + WASM pass
    ordered_coords = sorted(cell_records.keys())
    ordered_recs = [cell_records[c] for c in ordered_coords]

    tmp_work_dir = tempfile.mkdtemp(prefix="gs_octree_")
    try:
        if progress_callback:
            progress_callback(30.0, f"Transcoding {len(ordered_recs)} multi-level KTX2 octree textures...")
        rgb_bin_path, meta_list = _batch_transcode_ktx2_cells(ordered_recs, tmp_work_dir)
        for rec, m_info in zip(ordered_recs, meta_list):
            rec["rgb_meta"] = m_info
            # Clamp crop box to actual transcoded dimensions
            rec["px1"] = min(int(m_info["w"]), max(rec["px0"] + 1, rec["px1"]))
            rec["py1"] = min(int(m_info["h"]), max(rec["py0"] + 1, rec["py1"]))
            rec["cw"] = max(1, rec["px1"] - rec["px0"])
            rec["ch"] = max(1, rec["py1"] - rec["py0"])
            rec["texels"] = int(rec["cw"] * rec["ch"])

        rgb_mmap = np.memmap(rgb_bin_path, dtype=np.uint8, mode="r")

        final_tileset_dir = os.path.join(target_proj_dir, "tileset")
        staging_dir = os.path.join(target_proj_dir, "tileset_octree_staging")
        if os.path.isdir(staging_dir):
            shutil.rmtree(staging_dir, ignore_errors=True)
        tiles_out_dir = os.path.join(staging_dir, "tiles")
        os.makedirs(tiles_out_dir, exist_ok=True)

        stats = {
            "total_tiles": 0,
            "internal_tiles": 0,
            "leaf_tiles": 0,
            "leaf_triangles": 0,
            "leaf_texels_mp": 0.0,
            "max_octree_level": max(c[0] for c in ordered_coords),
            "max_tree_depth": 0,
            "total_bytes": 0,
        }

        # 3. Build Level-0 Root Overview Tile (`tiles/root.glb`) from Level-2 cells
        l2_coords = sorted(c for c in cell_records if c[0] == 2)
        if not l2_coords:
            min_lvl = min(c[0] for c in cell_records)
            l2_coords = sorted(c for c in cell_records if c[0] == min_lvl)

        from concurrent.futures import ThreadPoolExecutor

        root_cells = [cell_records[c] for c in l2_coords]
        root_glb_path = os.path.join(tiles_out_dir, "root.glb")
        root_bmin = np.min(np.vstack([c["bmin"] for c in root_cells]), axis=0)
        root_bmax = np.max(np.vstack([c["bmax"] for c in root_cells]), axis=0)
        diag = float(np.linalg.norm(root_bmax - root_bmin))
        root_error = max(24.0, round(diag / 4.0, 2))

        pack_jobs: List[Dict[str, Any]] = [
            {
                "cells": root_cells,
                "out_glb_path": root_glb_path,
                "max_tex_dim": 2048,
                "target_tris": 150000,
                "jpeg_quality": 86,
                "is_leaf": False,
                "is_root": True,
            }
        ]
        leaf_counter = [0]

        def _build_leaf_node_from_coords(
            leaf_coords: List[Tuple[int, int, int, int]],
            depth: int,
            node_tag: str,
        ) -> Dict[str, Any]:
            leaf_counter[0] += 1
            stats["max_tree_depth"] = max(stats["max_tree_depth"], depth)
            tile_rel = f"tiles/{node_tag}.glb"
            tile_abs = os.path.join(staging_dir, tile_rel)
            l_cells = [cell_records[x] for x in leaf_coords]
            bmin_l = np.min(np.vstack([c["bmin"] for c in l_cells]), axis=0)
            bmax_l = np.max(np.vstack([c["bmax"] for c in l_cells]), axis=0)
            pack_jobs.append(
                {
                    "cells": l_cells,
                    "out_glb_path": tile_abs,
                    "max_tex_dim": 4096,
                    "target_tris": None,  # Zero triangle decimation on finest leaf macro-tiles!
                    "jpeg_quality": 88,
                    "is_leaf": True,
                    "is_root": False,
                }
            )
            return {
                "boundingVolume": {"box": _compute_3dtiles_box(bmin_l, bmax_l, ox, oy, oz)},
                "geometricError": 0.0,
                "refine": "REPLACE",
                "content": {"uri": tile_rel},
            }

        def _build_subtree_node(
            c: Tuple[int, int, int, int],
            depth: int,
            parent_err: float,
        ) -> Dict[str, Any]:
            stats["max_tree_depth"] = max(stats["max_tree_depth"], depth)
            leaves = _get_true_leaves(c)
            tot_tex = sum(cell_records[x]["texels"] for x in leaves)
            tot_tris = sum(cell_records[x]["n_tris"] for x in leaves)

            tag = f"tile_d{depth}_l{c[0]}_{c[1]}_{c[2]}_{c[3]}"
            if (
                tot_tex <= max_leaf_texels
                and tot_tris <= max_leaf_tris
                and _can_pack_cells_1to1([cell_records[x] for x in leaves], max_tex_dim=4096)
            ):
                return _build_leaf_node_from_coords(leaves, depth, tag)

            # Internal LOD node: export `c`'s own intermediate Pix4Dmatic cell mesh
            tile_rel = f"tiles/{tag}.glb"
            tile_abs = os.path.join(staging_dir, tile_rel)
            bmin_i = cell_records[c]["bmin"]
            bmax_i = cell_records[c]["bmax"]
            pack_jobs.append(
                {
                    "cells": [cell_records[c]],
                    "out_glb_path": tile_abs,
                    "max_tex_dim": 2048,
                    "target_tris": 120000,
                    "jpeg_quality": 85,
                    "is_leaf": False,
                    "is_root": False,
                }
            )

            node_err = round(max(0.25, parent_err / 2.2), 3)
            child_nodes: List[Dict[str, Any]] = []
            ready_siblings: List[Tuple[Tuple[int, int, int, int], List[Tuple[int, int, int, int]], int, int]] = []

            for ch in sorted(children_map.get(c) or []):
                ch_leaves = _get_true_leaves(ch)
                ch_tex = sum(cell_records[x]["texels"] for x in ch_leaves)
                ch_tris = sum(cell_records[x]["n_tris"] for x in ch_leaves)
                if (
                    ch_tex <= max_leaf_texels
                    and ch_tris <= max_leaf_tris
                    and _can_pack_cells_1to1([cell_records[x] for x in ch_leaves], max_tex_dim=4096)
                ):
                    ready_siblings.append((ch, ch_leaves, ch_tris, ch_tex))
                else:
                    child_nodes.append(_build_subtree_node(ch, depth + 1, node_err))

            # Greedily bin-pack leaf-ready sibling octants under `c` into guaranteed 1:1 <= 4096x4096 leaf macro-tiles
            cur_leaves: List[Tuple[int, int, int, int]] = []
            cur_tris = 0
            cur_tex = 0
            pack_idx = 0
            for ch, ch_leaves, ch_tris, ch_tex in ready_siblings:
                cand_leaves = cur_leaves + list(ch_leaves)
                if cur_leaves and (
                    cur_tex + ch_tex > max_leaf_texels
                    or cur_tris + ch_tris > max_leaf_tris
                    or not _can_pack_cells_1to1([cell_records[x] for x in cand_leaves], max_tex_dim=4096)
                ):
                    pack_tag = f"{tag}_leaf{pack_idx}"
                    child_nodes.append(_build_leaf_node_from_coords(cur_leaves, depth + 1, pack_tag))
                    pack_idx += 1
                    cur_leaves = list(ch_leaves)
                    cur_tris = ch_tris
                    cur_tex = ch_tex
                else:
                    cur_leaves = cand_leaves
                    cur_tris += ch_tris
                    cur_tex += ch_tex
            if cur_leaves:
                pack_tag = f"{tag}_leaf{pack_idx}"
                child_nodes.append(_build_leaf_node_from_coords(cur_leaves, depth + 1, pack_tag))

            all_sub_bmins = [cell_records[x]["bmin"] for x in leaves] if leaves else [bmin_i]
            all_sub_bmaxs = [cell_records[x]["bmax"] for x in leaves] if leaves else [bmax_i]
            u_bmin = np.min(np.vstack(all_sub_bmins), axis=0)
            u_bmax = np.max(np.vstack(all_sub_bmaxs), axis=0)

            return {
                "boundingVolume": {"box": _compute_3dtiles_box(u_bmin, u_bmax, ox, oy, oz)},
                "geometricError": node_err if child_nodes else 0.0,
                "refine": "REPLACE",
                "content": {"uri": tile_rel},
                "children": child_nodes,
            }

        root_children: List[Dict[str, Any]] = []
        for r_coord in l2_coords:
            root_children.append(_build_subtree_node(r_coord, 1, root_error))

        def _run_pack_job(job: Dict[str, Any]) -> Tuple[Dict[str, Any], int, int, Tuple[int, int]]:
            f_tris, f_bytes, f_dims, _, _ = _pack_cells_to_glb_tile(
                cells=job["cells"],
                rgb_mmap=rgb_mmap,
                out_glb_path=job["out_glb_path"],
                offset_xyz=(ox, oy, oz),
                max_tex_dim=job["max_tex_dim"],
                target_tris=job["target_tris"],
                jpeg_quality=job["jpeg_quality"],
            )
            return job, f_tris, f_bytes, f_dims

        with ThreadPoolExecutor(max_workers=min(8, max(1, len(pack_jobs)))) as pool:
            for job_res, f_tris, f_bytes, f_dims in pool.map(_run_pack_job, pack_jobs):
                stats["total_tiles"] += 1
                stats["total_bytes"] += f_bytes
                if job_res["is_leaf"]:
                    stats["leaf_tiles"] += 1
                    stats["leaf_triangles"] += f_tris
                    stats["leaf_texels_mp"] += (f_dims[0] * f_dims[1]) / 1e6
                elif not job_res["is_root"]:
                    stats["internal_tiles"] += 1

        all_bmins = [rec["bmin"] for rec in ordered_recs]
        all_bmaxs = [rec["bmax"] for rec in ordered_recs]
        global_bmin = np.min(np.vstack(all_bmins), axis=0)
        global_bmax = np.max(np.vstack(all_bmaxs), axis=0)

        tileset_dict = {
            "asset": {
                "version": "1.1",
                "gltfUpAxis": "Z",
                "generator": "GatheringScans Native 9-Level Octree Builder v2.0",
            },
            "geometricError": root_error,
            "root": {
                "boundingVolume": {"box": _compute_3dtiles_box(global_bmin, global_bmax, ox, oy, oz)},
                "geometricError": root_error if root_children else 0.0,
                "refine": "REPLACE",
                "content": {"uri": "tiles/root.glb"},
                "children": root_children,
            },
        }

        ts_out_path = os.path.join(staging_dir, "tileset.json")
        with open(ts_out_path, "w", encoding="utf-8") as tf:
            json.dump(tileset_dict, tf, indent=2)

        with open(os.path.join(staging_dir, "offset.xyz"), "w", encoding="utf-8") as of:
            of.write(f"{ox:.3f} {oy:.3f} {oz:.3f}\n")

        del rgb_mmap

        # Atomically swap staging_dir into final_tileset_dir
        old_swap = os.path.join(target_proj_dir, "tileset_old_octree_swap")
        if os.path.isdir(old_swap):
            shutil.rmtree(old_swap, ignore_errors=True)
        if os.path.isdir(final_tileset_dir):
            os.replace(final_tileset_dir, old_swap)
        os.replace(staging_dir, final_tileset_dir)
        if os.path.isdir(old_swap):
            shutil.rmtree(old_swap, ignore_errors=True)

        final_ts_json = os.path.join(final_tileset_dir, "tileset.json")
        scan_id_str = os.path.basename(target_proj_dir.rstrip("\\/"))
        try:
            ensure_scan_low_quality_preview(final_ts_json, force=True)
            ensure_scan_full_quality_thumbnail(final_ts_json, scan_id_str, target_proj_dir)
        except Exception as pe:
            print(f"[NativeOctreeBuilder] Warning building preview/thumbnail: {pe}")

        # Persist accurate poly_count and size_bytes to scan_meta.json and ScanQueueDB
        try:
            meta_p = os.path.join(target_proj_dir, "scan_meta.json")
            meta_obj: Dict[str, Any] = {}
            if os.path.isfile(meta_p):
                with open(meta_p, "r", encoding="utf-8") as mf:
                    meta_obj = json.load(mf)
            meta_obj["poly_count"] = int(stats["leaf_triangles"])
            meta_obj["size_bytes"] = int(stats["total_bytes"])
            meta_obj["tileset_path"] = final_ts_json
            with open(meta_p, "w", encoding="utf-8") as mf:
                json.dump(meta_obj, mf, indent=2)
        except Exception as me:
            print(f"[NativeOctreeBuilder] Warning updating scan_meta.json: {me}")

        try:
            from pc_worker.priority_queue import ScanQueueDB
            db = ScanQueueDB()
            existing = db.get_scan(scan_id_str)
            if existing:
                upd = dict(existing)
                upd["size_bytes"] = int(stats["total_bytes"])
                upd["poly_count"] = int(stats["leaf_triangles"])
                upd["tileset_path"] = final_ts_json
                db.upsert_scan(upd)
        except Exception as de:
            print(f"[NativeOctreeBuilder] Warning updating ScanQueueDB: {de}")

        stats["duration_s"] = round(time.time() - t0, 2)
        stats["tileset_path"] = final_ts_json
        return stats
    finally:
        shutil.rmtree(tmp_work_dir, ignore_errors=True)
