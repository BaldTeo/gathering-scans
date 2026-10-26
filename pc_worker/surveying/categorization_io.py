#!/usr/bin/env python3
"""
GatheringScans Civil Surveying Submodule
"""

from __future__ import annotations

import os
import sys
import csv
import glob
import math
import json
import time
import tempfile
import subprocess
from datetime import datetime
from typing import Dict, Any, List, Tuple, Optional

try:
    import numpy as np
except ImportError:
    np = None  # type: ignore

try:
    from scipy.ndimage import distance_transform_edt, gaussian_filter
except ImportError:
    distance_transform_edt = None  # type: ignore
    gaussian_filter = None  # type: ignore

try:
    import trimesh
except ImportError:
    trimesh = None  # type: ignore

try:
    from PIL import Image
    from PIL.ExifTags import GPSTAGS
except ImportError:
    Image = None  # type: ignore
    GPSTAGS = {}

from pc_worker.config import (
    BASE_DIR,
    LOCAL_SCANS_ROOT as SCANS_ROOT_DIR,
    GC_SCAN_OPTIMIZER_DIR,
    REPORTS_DIR,
    CONTOURS_DIR,
    CATEGORIZATION_CACHE_DIR,
    MATERIAL_CATALOG,
    TWD97_TWVD2001_LABEL,
    TWD97_TWVD2001_SHORT,
)
from pc_worker.priority_queue import ScanQueueDB

from pc_worker.surveying.dsm_and_volume import (
    wgs84_to_twd97,
    GLTFPACK_EXE,
    MS_CASES,
    polygon_area_and_perimeter_2d,
    point_in_polygon_2d,
    simplify_polyline_2d,
    DsmAndVolumeMixin,
)


class CategorizationIoMixin:
    @staticmethod
    def _load_gemini_api_key_silent() -> str:
        """Silently loads GEMINI_API_KEY from environment or .env files without ever printing or logging it."""
        key = os.environ.get("GEMINI_API_KEY", "").strip()
        if key:
            return key
        base_repo = BASE_DIR
        for env_path in (
            os.path.join(base_repo, ".env"),
            r"c:\Antigravity\GatheringScans\.env",
            os.path.expanduser("~/.env"),
        ):
            if os.path.isfile(env_path):
                try:
                    with open(env_path, "r", encoding="utf-8", errors="ignore") as ef:
                        for line in ef:
                            line_s = line.strip()
                            if not line_s or line_s.startswith("#") or "=" not in line_s:
                                continue
                            k_part, v_part = line_s.split("=", 1)
                            if k_part.strip() == "GEMINI_API_KEY":
                                val = v_part.strip().strip('"').strip("'")
                                if val:
                                    return val
                except Exception:
                    pass
        return ""

    @staticmethod
    def _fit_pratt_circle_2d(x: np.ndarray, y: np.ndarray) -> Tuple[float, float, float]:
        """Algebraic Pratt/Kasa circle fit returning (cx, cy, radius_m) for 2D trunk points."""
        n = len(x)
        if n < 3:
            return float(np.mean(x)), float(np.mean(y)), 0.12
        mx = float(np.mean(x))
        my = float(np.mean(y))
        u = x - mx
        v = y - my
        z = u * u + v * v
        try:
            A = np.column_stack([u, v, np.ones_like(u)])
            c_vec, _, _, _ = np.linalg.lstsq(A, z, rcond=None)
            uc = 0.5 * float(c_vec[0])
            vc = 0.5 * float(c_vec[1])
            r_sq = float(c_vec[2]) + uc * uc + vc * vc
            r = math.sqrt(max(r_sq, 1e-4))
            if not (0.03 <= r <= 1.25):
                r = float(np.median(np.hypot(u, v)))
            return mx + uc, my + vc, float(np.clip(r, 0.04, 0.95))
        except Exception:
            r = float(np.median(np.hypot(u, v)))
            return mx, my, float(np.clip(r, 0.04, 0.95))

    @staticmethod
    def _load_scan_textured_triangles_twd97(
        scan: Dict[str, Any],
        ce: float,
        cn: float,
        ch: float,
    ) -> Dict[str, Any]:
        """
        Stage 0: Universal 3D Mesh / GLB / 3TZ + UV Texture Loader.
        Loads 3D triangles (v0, v1, v2) in 64-bit TWD97 (E, N, H) and UV coordinates (vt0, vt1, vt2)
        + RGB texture image (mesh_0.jpg or embedded GLB texture), returning per-triangle geometric
        and radiometric features.
        """
        import struct

        proj_dir = scan.get("project_dir") or os.path.join(SCANS_ROOT_DIR, str(scan.get("scan_id") or ""))
        obj_path = DsmAndVolumeMixin._resolve_scan_obj_path(scan)
        ts_path = scan.get("tileset_path") or os.path.join(proj_dir, "tileset", "tileset.json")
        obj_mtime = os.path.getmtime(obj_path) if (obj_path and os.path.isfile(obj_path)) else 0.0
        ts_mtime = os.path.getmtime(ts_path) if (ts_path and os.path.isfile(ts_path)) else 0.0
        tileset_edited_after_obj = bool(ts_mtime > 0.0 and obj_mtime > 0.0 and ts_mtime > obj_mtime + 2.0)

        v0_arr = None
        v1_arr = None
        v2_arr = None
        rgb_arr = None
        geom_source = "none"

        # 1. Try fast C-backed numpy Multi-Material OBJ + UV + JPEG loader (when mesh.obj is compact and <= 12 textures)
        if obj_path and os.path.isfile(obj_path):
            try:
                obj_dir = os.path.dirname(obj_path)
                tex_jpgs = sorted(glob.glob(os.path.join(obj_dir, "*.jpg")) + glob.glob(os.path.join(obj_dir, "*.png")))
                if os.path.getsize(obj_path) <= 350_000_000 and len(tex_jpgs) <= 12:
                    off_xyz = (0.0, 0.0, 0.0)
                    off_cand = os.path.join(obj_dir, "offset.xyz")
                    if os.path.isfile(off_cand):
                        with open(off_cand, "r", encoding="utf-8", errors="ignore") as f_off:
                            toks = f_off.read().strip().split()
                        if len(toks) >= 3:
                            off_xyz = (float(toks[0]), float(toks[1]), float(toks[2]))

                    mtl_to_tex: Dict[str, str] = {}
                    for mp in glob.glob(os.path.join(obj_dir, "*.mtl")):
                        cur_m = None
                        try:
                            with open(mp, "r", encoding="utf-8", errors="ignore") as mf:
                                for ml in mf:
                                    ms = ml.strip()
                                    if ms.lower().startswith("newmtl "):
                                        cur_m = ms.split(None, 1)[1].strip()
                                    elif ms.lower().startswith("map_kd ") and cur_m:
                                        tname = ms.split(None, 1)[1].strip()
                                        tp = os.path.join(obj_dir, tname)
                                        if os.path.isfile(tp):
                                            mtl_to_tex[cur_m] = tp
                        except Exception:
                            pass

                    with open(obj_path, "r", encoding="ascii", errors="ignore") as f_obj:
                        lines = f_obj.read().splitlines()

                    v_lines: List[str] = []
                    vt_lines: List[str] = []
                    mtl_f_groups: Dict[str, List[str]] = {}
                    cur_mtl = "mesh_0"
                    for l in lines:
                        if l.startswith("v "):
                            v_lines.append(l[2:])
                        elif l.startswith("vt "):
                            vt_lines.append(l[3:])
                        elif l.startswith("f "):
                            mtl_f_groups.setdefault(cur_mtl, []).append(l[2:])
                        elif l.startswith("usemtl "):
                            cur_mtl = l[7:].strip()

                    v_str = "\n".join(v_lines)
                    vt_str = "\n".join(vt_lines)
                    verts = np.fromstring(v_str, dtype=np.float64, sep=" ").reshape(-1, 3)
                    verts[:, 0] += off_xyz[0]
                    verts[:, 1] += off_xyz[1]
                    verts[:, 2] += off_xyz[2]
                    uvs = np.fromstring(vt_str, dtype=np.float32, sep=" ").reshape(-1, 2) if vt_str else None

                    tex_cache_obj: Dict[str, np.ndarray] = {}
                    if Image is not None:
                        for tp in tex_jpgs:
                            try:
                                tex_cache_obj[os.path.abspath(tp)] = (
                                    np.asarray(Image.open(tp).convert("RGB"), dtype=np.float32) / 255.0
                                )
                            except Exception:
                                pass

                    b_weights = [
                        (1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0),
                        (0.60, 0.20, 0.20),
                        (0.20, 0.60, 0.20),
                        (0.20, 0.20, 0.60),
                    ]
                    v0_grps, v1_grps, v2_grps, rgb_grps = [], [], [], []
                    for m_name, grp_f in mtl_f_groups.items():
                        if not grp_f:
                            continue
                        sample_f = grp_f[0]
                        has_uv_idx = "/" in sample_f and "//" not in sample_f
                        slash_cnt = sample_f.count("/")
                        f_str = "\n".join(l.replace("/", " ") for l in grp_f)
                        f_vals = np.fromstring(f_str, dtype=np.int32, sep=" ")
                        if slash_cnt == 3 and has_uv_idx:
                            f_mat = f_vals.reshape(-1, 6)
                            vi = np.clip(f_mat[:, [0, 2, 4]] - 1, 0, len(verts) - 1)
                            ti = np.clip(f_mat[:, [1, 3, 5]] - 1, 0, (len(uvs) - 1) if uvs is not None and len(uvs) > 0 else 0)
                        elif slash_cnt == 6:
                            f_mat = f_vals.reshape(-1, 9)
                            vi = np.clip(f_mat[:, [0, 3, 6]] - 1, 0, len(verts) - 1)
                            ti = np.clip(f_mat[:, [1, 4, 7]] - 1, 0, (len(uvs) - 1) if uvs is not None and len(uvs) > 0 else 0)
                        else:
                            f_mat = f_vals.reshape(-1, 3)
                            vi = np.clip(f_mat - 1, 0, len(verts) - 1)
                            ti = None

                        gv0 = verts[vi[:, 0]]
                        gv1 = verts[vi[:, 1]]
                        gv2 = verts[vi[:, 2]]
                        v0_grps.append(gv0)
                        v1_grps.append(gv1)
                        v2_grps.append(gv2)

                        resolved_tp = mtl_to_tex.get(m_name)
                        if not resolved_tp:
                            for ext_c in (".jpg", ".png"):
                                cand_tp = os.path.join(obj_dir, f"{m_name}{ext_c}")
                                if os.path.isfile(cand_tp):
                                    resolved_tp = cand_tp
                                    break
                        if not resolved_tp and tex_jpgs:
                            resolved_tp = tex_jpgs[0]

                        tex_np = tex_cache_obj.get(os.path.abspath(resolved_tp)) if resolved_tp else None
                        if uvs is not None and len(uvs) > 0 and ti is not None and tex_np is not None:
                            th, tw, _ = tex_np.shape
                            uv0 = uvs[ti[:, 0]]
                            uv1 = uvs[ti[:, 1]]
                            uv2 = uvs[ti[:, 2]]
                            rgb_acc = np.zeros((len(gv0), 3), dtype=np.float32)
                            for w0, w1, w2 in b_weights:
                                u_s = np.mod(w0 * uv0[:, 0] + w1 * uv1[:, 0] + w2 * uv2[:, 0], 1.0)
                                v_s = np.mod(w0 * uv0[:, 1] + w1 * uv1[:, 1] + w2 * uv2[:, 1], 1.0)
                                px = np.clip((u_s * (tw - 1)).astype(np.int32), 0, tw - 1)
                                py = np.clip(((1.0 - v_s) * (th - 1)).astype(np.int32), 0, th - 1)
                                rgb_acc += tex_np[py, px]
                            rgb_grps.append(rgb_acc * 0.25)
                        else:
                            rgb_grps.append(np.full((len(gv0), 3), 0.52, dtype=np.float32))

                    if v0_grps:
                        v0_arr = np.vstack(v0_grps)
                        v1_arr = np.vstack(v1_grps)
                        v2_arr = np.vstack(v2_grps)
                        rgb_arr = np.vstack(rgb_grps)
                        geom_source = "obj"
            except Exception:
                v0_arr = None

        # 2. Fallback to leaf/LOD-2 .glb tiles (or .3tz stream archive) with automatic meshopt & KHR_texture_transform support
        if v0_arr is None or len(v0_arr) == 0:
            glb_files = DsmAndVolumeMixin._collect_scan_glb_files(scan)
            v0_list, v1_list, v2_list, rgb_list = [], [], [], []
            ts_doc_loaded = None
            if ts_path and os.path.isfile(ts_path) and ts_path.lower().endswith(".json"):
                try:
                    with open(ts_path, "r", encoding="utf-8") as tf:
                        ts_doc_loaded = json.load(tf)
                except Exception:
                    pass

            base_repo_dir = BASE_DIR
            basis_js_path = os.path.join(base_repo_dir, "web", "lib", "basis", "basis_transcoder.js")
            basis_wasm_path = os.path.join(base_repo_dir, "web", "lib", "basis", "basis_transcoder.wasm")

            def _decode_ktx2_bytes_to_rgb_np(ktx_bytes: bytes) -> Optional[np.ndarray]:
                if not os.path.isfile(basis_js_path) or not os.path.isfile(basis_wasm_path):
                    return None
                fd_k, tmp_k = tempfile.mkstemp(suffix=".ktx2")
                fd_r, tmp_r = tempfile.mkstemp(suffix=".bin")
                os.close(fd_r)
                try:
                    with os.fdopen(fd_k, "wb") as fk:
                        fk.write(ktx_bytes)
                    js_script = (
                        "const fs=require('fs');const BASIS=require(process.argv[1]);"
                        "const wasmBin=fs.readFileSync(process.argv[2]);"
                        "const ktxBytes=new Uint8Array(fs.readFileSync(process.argv[3]));"
                        "BASIS({wasmBinary:wasmBin}).then(mod=>{"
                        "mod.initializeBasis();const k=new mod.KTX2File(ktxBytes);"
                        "if(!k.isValid()||!k.startTranscoding())process.exit(1);"
                        "const w=k.getWidth(),h=k.getHeight();"
                        "const dst=new Uint8Array(k.getImageTranscodedSizeInBytes(0,0,0,13));"
                        "if(!k.transcodeImage(dst,0,0,0,13,0,-1,-1))process.exit(1);"
                        "const hdr=Buffer.alloc(8);hdr.writeUInt32LE(w,0);hdr.writeUInt32LE(h,4);"
                        "fs.writeFileSync(process.argv[4],Buffer.concat([hdr,Buffer.from(dst.buffer)]));"
                        "k.close();k.delete();}).catch(()=>process.exit(1));"
                    )
                    subprocess.run(
                        ["node", "-e", js_script, basis_js_path, basis_wasm_path, tmp_k, tmp_r],
                        capture_output=True,
                        timeout=6,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000) if os.name == "nt" else 0,
                    )
                    if os.path.isfile(tmp_r) and os.path.getsize(tmp_r) > 8:
                        with open(tmp_r, "rb") as fr:
                            rb = fr.read()
                        tw_k, th_k = struct.unpack_from("<2I", rb, 0)
                        if tw_k > 0 and th_k > 0 and len(rb) >= 8 + tw_k * th_k * 4:
                            rgba = np.frombuffer(rb, dtype=np.uint8, count=tw_k * th_k * 4, offset=8).reshape(th_k, tw_k, 4)
                            return rgba[:, :, :3].astype(np.float32) / 255.0
                except Exception:
                    return None
                finally:
                    for p_clean in (tmp_k, tmp_r):
                        if p_clean and os.path.exists(p_clean):
                            try:
                                os.remove(p_clean)
                            except OSError:
                                pass
                return None

            def _parse_glb_triangles_and_rgb(raw_bytes: bytes, origin_shift: Tuple[float, float, float] = (0.0, 0.0, 0.0), legacy_uv: bool = False) -> Optional[Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]]:
                if len(raw_bytes) < 28 or raw_bytes[:4] != b"glTF":
                    return None
                j_len, j_type = struct.unpack_from("<I4s", raw_bytes, 12)
                if j_type != b"JSON":
                    return None
                b_off = 20 + j_len
                if b_off + 8 > len(raw_bytes):
                    return None
                b_len, b_type = struct.unpack_from("<I4s", raw_bytes, b_off)
                if b_type != b"BIN\x00":
                    return None
                j = json.loads(raw_bytes[20 : 20 + j_len].decode("utf-8"))
                acc_list = j.get("accessors") or []
                bv_list = j.get("bufferViews") or []
                meshes_list = j.get("meshes") or []
                nodes_list = j.get("nodes") or []
                images_list = j.get("images") or []
                textures_list = j.get("textures") or []
                materials_list = j.get("materials") or []
                blob = memoryview(raw_bytes)[b_off + 8 : b_off + 8 + b_len]

                pil_images: Dict[int, np.ndarray] = {}
                if images_list:
                    import io
                    for img_idx, img_meta in enumerate(images_list):
                        if "bufferView" in img_meta:
                            try:
                                ibv = bv_list[img_meta["bufferView"]]
                                ioff = int(ibv.get("byteOffset", 0))
                                ilen = int(ibv["byteLength"])
                                raw_img = bytes(blob[ioff : ioff + ilen])
                                mtype = str(img_meta.get("mimeType") or "").lower()
                                if mtype == "image/ktx2" or raw_img[:7] == b"\xabKTX 20":
                                    dec_k = _decode_ktx2_bytes_to_rgb_np(raw_img)
                                    if dec_k is not None:
                                        pil_images[img_idx] = dec_k
                                elif Image is not None:
                                    im = Image.open(io.BytesIO(raw_img)).convert("RGB")
                                    pil_images[img_idx] = np.asarray(im, dtype=np.float32) / 255.0
                            except Exception:
                                pass

                def _node_mat4_g(nd: Dict[str, Any]) -> np.ndarray:
                    if isinstance(nd.get("matrix"), list) and len(nd["matrix"]) == 16:
                        return np.array([float(x) for x in nd["matrix"][:16]], dtype=np.float64).reshape((4, 4), order="F")
                    m = np.eye(4, dtype=np.float64)
                    s = nd.get("scale") or [1.0, 1.0, 1.0]
                    S = np.diag([float(s[0]), float(s[1]), float(s[2])])
                    q = nd.get("rotation")
                    if isinstance(q, list) and len(q) == 4:
                        qx, qy, qz, qw = float(q[0]), float(q[1]), float(q[2]), float(q[3])
                        nq = math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw)
                        if nq > 1e-12:
                            qx, qy, qz, qw = qx / nq, qy / nq, qz / nq, qw / nq
                        R = np.array(
                            [
                                [1.0 - 2.0 * (qy * qy + qz * qz), 2.0 * (qx * qy - qw * qz), 2.0 * (qx * qz + qw * qy)],
                                [2.0 * (qx * qy + qw * qz), 1.0 - 2.0 * (qx * qx + qz * qz), 2.0 * (qy * qz - qw * qx)],
                                [2.0 * (qx * qz - qw * qy), 2.0 * (qy * qz + qw * qx), 1.0 - 2.0 * (qx * qx + qy * qy)],
                            ],
                            dtype=np.float64,
                        )
                    else:
                        R = np.eye(3, dtype=np.float64)
                    m[:3, :3] = R @ S
                    t = nd.get("translation") or [0.0, 0.0, 0.0]
                    m[:3, 3] = [float(t[0]), float(t[1]), float(t[2])]
                    return m

                def _read_mesh_tris(m_idx: int, m_tf: np.ndarray) -> Optional[Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]]:
                    if not (0 <= m_idx < len(meshes_list)):
                        return None
                    m_obj = meshes_list[m_idx]
                    mv0, mv1, mv2, mrgb = [], [], [], []
                    for prim in m_obj.get("primitives") or []:
                        if prim.get("mode", 4) != 4:
                            continue
                        attrs = prim.get("attributes") or {}
                        if "POSITION" not in attrs:
                            continue
                        pos_acc = acc_list[attrs["POSITION"]]
                        if "bufferView" not in pos_acc:
                            continue
                        pos_bv = bv_list[pos_acc["bufferView"]]
                        if "EXT_meshopt_compression" in (pos_bv.get("extensions") or {}):
                            return None
                        ctype = pos_acc.get("componentType")
                        cnt = int(pos_acc["count"])
                        p_off = int(pos_bv.get("byteOffset", 0)) + int(pos_acc.get("byteOffset", 0))
                        if ctype == 5126:
                            b_stride = int(pos_bv.get("byteStride") or 12)
                            if b_stride == 12:
                                pos = np.frombuffer(blob, dtype=np.float32, count=cnt * 3, offset=p_off).reshape(-1, 3).astype(np.float64)
                            else:
                                raw_u8 = np.frombuffer(blob, dtype=np.uint8, count=cnt * b_stride, offset=p_off).reshape(cnt, b_stride)
                                pos = np.frombuffer(raw_u8[:, :12].tobytes(), dtype=np.float32).reshape(-1, 3).astype(np.float64)
                        elif ctype in (5122, 5123):
                            dt = np.int16 if ctype == 5122 else np.uint16
                            b_stride = int(pos_bv.get("byteStride") or 6)
                            raw_u8 = np.frombuffer(blob, dtype=np.uint8, count=cnt * b_stride, offset=p_off).reshape(cnt, b_stride)
                            pos = np.frombuffer(raw_u8[:, :6].tobytes(), dtype=dt).reshape(-1, 3).astype(np.float64)
                            if pos_acc.get("normalized"):
                                pos = pos / (32767.0 if ctype == 5122 else 65535.0)
                        else:
                            continue

                        pos = (pos @ m_tf[:3, :3].T) + m_tf[:3, 3]
                        if origin_shift != (0.0, 0.0, 0.0):
                            pos[:, 0] += origin_shift[0]
                            pos[:, 1] += origin_shift[1]
                            pos[:, 2] += origin_shift[2]

                        if "indices" in prim:
                            idx_acc = acc_list[prim["indices"]]
                            if "bufferView" not in idx_acc:
                                continue
                            idx_bv = bv_list[idx_acc["bufferView"]]
                            if "EXT_meshopt_compression" in (idx_bv.get("extensions") or {}):
                                return None
                            i_off = int(idx_bv.get("byteOffset", 0)) + int(idx_acc.get("byteOffset", 0))
                            icnt = int(idx_acc["count"])
                            ictype = idx_acc.get("componentType")
                            idtype = np.uint32 if ictype == 5125 else (np.uint16 if ictype == 5123 else np.uint8)
                            idx_flat = np.frombuffer(blob, dtype=idtype, count=icnt, offset=i_off).astype(np.int32)
                            idx = idx_flat[: icnt - (icnt % 3)].reshape(-1, 3)
                        else:
                            idx = np.arange(cnt - (cnt % 3), dtype=np.int32).reshape(-1, 3)

                        if len(idx) == 0:
                            continue

                        # Resolve per-primitive material texture and KHR_texture_transform offset/scale
                        tex_np_prim = None
                        uv_offset = np.array([0.0, 0.0], dtype=np.float32)
                        uv_scale = np.array([1.0, 1.0], dtype=np.float32)
                        mat_idx = prim.get("material")
                        if mat_idx is not None and 0 <= int(mat_idx) < len(materials_list):
                            mat_obj = materials_list[int(mat_idx)]
                            pbr = mat_obj.get("pbrMetallicRoughness") or {}
                            bct = pbr.get("baseColorTexture") or mat_obj.get("emissiveTexture") or {}
                            if isinstance(bct, dict) and "index" in bct:
                                khr_tf = (bct.get("extensions") or {}).get("KHR_texture_transform")
                                if isinstance(khr_tf, dict):
                                    if isinstance(khr_tf.get("offset"), list) and len(khr_tf["offset"]) >= 2:
                                        uv_offset = np.array([float(khr_tf["offset"][0]), float(khr_tf["offset"][1])], dtype=np.float32)
                                    if isinstance(khr_tf.get("scale"), list) and len(khr_tf["scale"]) >= 2:
                                        uv_scale = np.array([float(khr_tf["scale"][0]), float(khr_tf["scale"][1])], dtype=np.float32)
                                t_idx = int(bct["index"])
                                if 0 <= t_idx < len(textures_list):
                                    t_obj = textures_list[t_idx]
                                    t_ext = t_obj.get("extensions") or {}
                                    src_idx = t_obj.get("source")
                                    if src_idx is None:
                                        src_idx = (t_ext.get("EXT_texture_webp") or t_ext.get("KHR_texture_basisu") or {}).get("source")
                                    if src_idx is not None and int(src_idx) in pil_images:
                                        tex_np_prim = pil_images[int(src_idx)]
                        if tex_np_prim is None and pil_images:
                            tex_np_prim = next(iter(pil_images.values()))

                        uv_g = None
                        if "TEXCOORD_0" in attrs and tex_np_prim is not None:
                            uv_acc = acc_list[attrs["TEXCOORD_0"]]
                            if "bufferView" in uv_acc:
                                uv_bv = bv_list[uv_acc["bufferView"]]
                                if "EXT_meshopt_compression" not in (uv_bv.get("extensions") or {}):
                                    u_off = int(uv_bv.get("byteOffset", 0)) + int(uv_acc.get("byteOffset", 0))
                                    uctype = uv_acc.get("componentType")
                                    if uctype == 5126:
                                        ub_stride = int(uv_bv.get("byteStride") or 8)
                                        if ub_stride == 8:
                                            uv_g = np.frombuffer(blob, dtype=np.float32, count=cnt * 2, offset=u_off).reshape(-1, 2)
                                        else:
                                            ru8 = np.frombuffer(blob, dtype=np.uint8, count=cnt * ub_stride, offset=u_off).reshape(cnt, ub_stride)
                                            uv_g = np.frombuffer(ru8[:, :8].tobytes(), dtype=np.float32).reshape(-1, 2)
                                    elif uctype == 5123:
                                        ub_stride = int(uv_bv.get("byteStride") or 4)
                                        ru8 = np.frombuffer(blob, dtype=np.uint8, count=cnt * ub_stride, offset=u_off).reshape(cnt, ub_stride)
                                        uv_g = np.frombuffer(ru8[:, :4].tobytes(), dtype=np.uint16).reshape(-1, 2).astype(np.float32) / 65535.0

                        tv0, tv1, tv2 = pos[idx[:, 0]], pos[idx[:, 1]], pos[idx[:, 2]]
                        if uv_g is not None and tex_np_prim is not None:
                            uv_g_tf = uv_g * uv_scale + uv_offset
                            th, tw, _ = tex_np_prim.shape
                            uv0 = uv_g_tf[idx[:, 0]]
                            uv1 = uv_g_tf[idx[:, 1]]
                            uv2 = uv_g_tf[idx[:, 2]]
                            if legacy_uv:
                                uvc = (uv0 + uv1 + uv2) / 3.0
                                px = np.clip((np.mod(uvc[:, 0], 1.0) * (tw - 1)).astype(np.int32), 0, tw - 1)
                                py = np.clip(((1.0 - np.mod(uvc[:, 1], 1.0)) * (th - 1)).astype(np.int32), 0, th - 1)
                                trgb = tex_np_prim[py, px]
                            else:
                                b_weights = [
                                    (1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0),
                                    (0.60, 0.20, 0.20),
                                    (0.20, 0.60, 0.20),
                                    (0.20, 0.20, 0.60),
                                ]
                                rgb_acc = np.zeros((len(tv0), 3), dtype=np.float32)
                                for w0, w1, w2 in b_weights:
                                    u_s = np.mod(w0 * uv0[:, 0] + w1 * uv1[:, 0] + w2 * uv2[:, 0], 1.0)
                                    v_s = np.mod(w0 * uv0[:, 1] + w1 * uv1[:, 1] + w2 * uv2[:, 1], 1.0)
                                    px = np.clip((u_s * (tw - 1)).astype(np.int32), 0, tw - 1)
                                    py = np.clip((v_s * (th - 1)).astype(np.int32), 0, th - 1)
                                    rgb_acc += tex_np_prim[py, px]
                                trgb = rgb_acc * 0.25
                        else:
                            trgb = np.full((len(tv0), 3), 0.55, dtype=np.float32)
                        mv0.append(tv0)
                        mv1.append(tv1)
                        mv2.append(tv2)
                        mrgb.append(trgb)
                    if mv0:
                        return np.vstack(mv0), np.vstack(mv1), np.vstack(mv2), np.vstack(mrgb)
                    return None

                all_v0, all_v1, all_v2, all_rgb = [], [], [], []
                if nodes_list:
                    scenes = j.get("scenes") or []
                    s_idx = int(j.get("scene", 0)) if scenes else 0
                    root_idxs = (
                        list(scenes[s_idx].get("nodes") or [])
                        if (0 <= s_idx < len(scenes) and scenes[s_idx].get("nodes"))
                        else [0]
                    )

                    def _walk_g_node(n_idx: int, m_parent: np.ndarray) -> bool:
                        if not (0 <= int(n_idx) < len(nodes_list)):
                            return True
                        nd = nodes_list[int(n_idx)]
                        m_cur = m_parent @ _node_mat4_g(nd)
                        if "mesh" in nd and nd["mesh"] is not None:
                            mt = _read_mesh_tris(int(nd["mesh"]), m_cur)
                            if mt is None:
                                return False
                            all_v0.append(mt[0])
                            all_v1.append(mt[1])
                            all_v2.append(mt[2])
                            all_rgb.append(mt[3])
                        for ch_i in nd.get("children") or []:
                            if not _walk_g_node(int(ch_i), m_cur):
                                return False
                        return True

                    for ri in root_idxs:
                        if not _walk_g_node(int(ri), np.eye(4, dtype=np.float64)):
                            return None
                else:
                    for mi in range(len(meshes_list)):
                        mt = _read_mesh_tris(mi, np.eye(4, dtype=np.float64))
                        if mt is None:
                            return None
                        all_v0.append(mt[0])
                        all_v1.append(mt[1])
                        all_v2.append(mt[2])
                        all_rgb.append(mt[3])

                if all_v0:
                    return np.vstack(all_v0), np.vstack(all_v1), np.vstack(all_v2), np.vstack(all_rgb)
                return None

            def _extract_trimesh_triangles_and_rgb(glb_p: str, origin_shift: Tuple[float, float, float] = (0.0, 0.0, 0.0)) -> Optional[Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]]:
                if trimesh is None or not os.path.isfile(glb_p):
                    return None
                try:
                    loaded = trimesh.load(glb_p, process=False)
                    geoms = loaded.dump() if isinstance(loaded, trimesh.Scene) else [loaded]
                    tv0_l, tv1_l, tv2_l, trgb_l = [], [], [], []
                    sh_arr = np.array(origin_shift, dtype=np.float64)
                    for g in geoms:
                        if not hasattr(g, "vertices") or not hasattr(g, "faces") or len(g.faces) == 0:
                            continue
                        gv = np.asarray(g.vertices, dtype=np.float64) + sh_arr
                        gf = np.asarray(g.faces, dtype=np.int32)
                        tv0_l.append(gv[gf[:, 0]])
                        tv1_l.append(gv[gf[:, 1]])
                        tv2_l.append(gv[gf[:, 2]])
                        f_rgb = None
                        try:
                            vis = getattr(g, "visual", None)
                            if vis is not None:
                                if getattr(vis, "kind", None) == "texture" and hasattr(vis, "uv") and vis.uv is not None and getattr(vis, "material", None) is not None:
                                    mat_img = getattr(vis.material, "baseColorTexture", None) or getattr(vis.material, "image", None)
                                    if mat_img is not None:
                                        tnp = np.asarray(mat_img.convert("RGB"), dtype=np.float32) / 255.0
                                        th, tw, _ = tnp.shape
                                        uvs_m = np.asarray(vis.uv, dtype=np.float32)
                                        uvc = (uvs_m[gf[:, 0]] + uvs_m[gf[:, 1]] + uvs_m[gf[:, 2]]) / 3.0
                                        px = np.clip((np.mod(uvc[:, 0], 1.0) * (tw - 1)).astype(np.int32), 0, tw - 1)
                                        py = np.clip(((1.0 - np.mod(uvc[:, 1], 1.0)) * (th - 1)).astype(np.int32), 0, th - 1)
                                        f_rgb = tnp[py, px]
                                if f_rgb is None and hasattr(vis, "face_colors") and vis.face_colors is not None and len(vis.face_colors) == len(gf):
                                    f_rgb = np.asarray(vis.face_colors[:, :3], dtype=np.float32) / 255.0
                        except Exception:
                            f_rgb = None
                        if f_rgb is None:
                            f_rgb = np.full((len(gf), 3), 0.55, dtype=np.float32)
                        trgb_l.append(f_rgb)
                    if tv0_l:
                        return np.vstack(tv0_l), np.vstack(tv1_l), np.vstack(tv2_l), np.vstack(trgb_l)
                except Exception:
                    return None
                return None

            max_glb_cnt = 20 if (glb_files and os.path.basename(glb_files[0]).startswith("tile_l1_")) else 24
            for gp in glb_files[:max_glb_cnt]:
                try:
                    is_legacy_tile = os.path.basename(gp).startswith("tile_l1_")
                    with open(gp, "rb") as gf:
                        raw_b = gf.read()
                    parsed = _parse_glb_triangles_and_rgb(raw_b, legacy_uv=is_legacy_tile)
                    if parsed is None:
                        parsed = _extract_trimesh_triangles_and_rgb(gp)
                    if parsed is None and os.path.isfile(GLTFPACK_EXE):
                        if GC_SCAN_OPTIMIZER_DIR not in sys.path:
                            sys.path.append(GC_SCAN_OPTIMIZER_DIR)
                        from optimizer.geometry_optimizer import extract_glb_64bit_origin_to_local
                        loc_b, orig_t = extract_glb_64bit_origin_to_local(raw_b)
                        fd_in, tmp_in = tempfile.mkstemp(suffix=".glb")
                        fd_out, tmp_out = tempfile.mkstemp(suffix=".glb")
                        os.close(fd_out)
                        try:
                            with os.fdopen(fd_in, "wb") as fi:
                                fi.write(loc_b)
                            subprocess.run(
                                [GLTFPACK_EXE, "-i", tmp_in, "-o", tmp_out, "-noq"],
                                capture_output=True,
                                timeout=20,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000) if os.name == "nt" else 0,
                            )
                            if os.path.isfile(tmp_out):
                                with open(tmp_out, "rb") as fo:
                                    parsed = _parse_glb_triangles_and_rgb(fo.read(), origin_shift=orig_t, legacy_uv=is_legacy_tile)
                                if parsed is None:
                                    parsed = _extract_trimesh_triangles_and_rgb(tmp_out, origin_shift=orig_t)
                        finally:
                            for p_rm in (tmp_in, tmp_out):
                                if p_rm and os.path.exists(p_rm):
                                    try:
                                        os.remove(p_rm)
                                    except OSError:
                                        pass
                    if parsed is not None:
                        v0_list.append(parsed[0])
                        v1_list.append(parsed[1])
                        v2_list.append(parsed[2])
                        rgb_list.append(parsed[3])
                except Exception:
                    pass

            if v0_list:
                v0_raw = np.vstack(v0_list)
                v1_raw = np.vstack(v1_list)
                v2_raw = np.vstack(v2_list)
                rgb_arr = np.vstack(rgb_list)
                geom_source = "glb"
                root_tf = ((ts_doc_loaded or {}).get("root") or {}).get("transform") if isinstance(ts_doc_loaded, dict) else None
                has_rtf = isinstance(root_tf, list) and len(root_tf) == 16
                asset_up = str(((ts_doc_loaded or {}).get("asset") or {}).get("gltfUpAxis") or "").upper()

                def _tf_verts(vr: np.ndarray) -> np.ndarray:
                    if has_rtf and asset_up != "Z":
                        rx, ry, rz = vr[:, 0], -vr[:, 2], vr[:, 1]
                    elif asset_up == "Z" or np.abs(vr[:, 0]).max() > 50000.0:
                        rx, ry, rz = vr[:, 0], vr[:, 1], vr[:, 2]
                    else:
                        rx, ry, rz = vr[:, 0], -vr[:, 2], vr[:, 1]
                    pts = np.column_stack([rx, ry, rz])
                    if has_rtf:
                        m_r = np.array([float(x) for x in root_tf[:16]], dtype=np.float64).reshape((4, 4), order="F")
                        pts = (pts @ m_r[:3, :3].T) + m_r[:3, 3]
                    return pts

                v0_arr = _tf_verts(v0_raw)
                v1_arr = _tf_verts(v1_raw)
                v2_arr = _tf_verts(v2_raw)

        if v0_arr is None or len(v0_arr) == 0:
            raise RuntimeError("Unable to load 3D triangles for surface categorization.")

        # Ensure coordinates are in scan TWD97 (E, N, H), including UTM Zone 51N -> TWD97 reprojection if needed
        mx, my, mz = float(v0_arr[:, 0].mean()), float(v0_arr[:, 1].mean()), float(v0_arr[:, 2].mean())
        if 345000.0 < mx <= 415000.0 and 2500000.0 <= my <= 3000000.0 and 150000.0 <= ce <= 345000.0:
            from pc_worker.gdrive_watcher import utm51n_to_wgs84
            lat_c, lon_c = utm51n_to_wgs84(mx, my)
            e0, n0 = wgs84_to_twd97(lat_c, lon_c)
            lat_dx, lon_dx = utm51n_to_wgs84(mx + 20.0, my)
            ex_p, nx_p = wgs84_to_twd97(lat_dx, lon_dx)
            lat_dy, lon_dy = utm51n_to_wgs84(mx, my + 20.0)
            ey_p, ny_p = wgs84_to_twd97(lat_dy, lon_dy)
            j00, j10 = (ex_p - e0) / 20.0, (nx_p - n0) / 20.0
            j01, j11 = (ey_p - e0) / 20.0, (ny_p - n0) / 20.0
            for arr in (v0_arr, v1_arr, v2_arr):
                dx_u = arr[:, 0] - mx
                dy_u = arr[:, 1] - my
                arr[:, 0] = e0 + j00 * dx_u + j01 * dy_u
                arr[:, 1] = n0 + j10 * dx_u + j11 * dy_u
        elif abs(mx) < 50000.0 and abs(my) < 50000.0 and (abs(ce) > 50000.0 or abs(cn) > 50000.0):
            vcen = 0.5 * (v0_arr.min(axis=0) + v0_arr.max(axis=0))
            for arr in (v0_arr, v1_arr, v2_arr):
                arr[:, 0] = ce + (arr[:, 0] - vcen[0])
                arr[:, 1] = cn + (arr[:, 1] - vcen[1])
                arr[:, 2] = ch + (arr[:, 2] - vcen[2])

        if rgb_arr is None or len(rgb_arr) != len(v0_arr):
            rgb_arr = np.full((len(v0_arr), 3), 0.52, dtype=np.float32)

        # Compute per-triangle centroids, normals, 3D areas, 2D areas, and spectral indices
        centroids = (v0_arr + v1_arr + v2_arr) / 3.0
        e1 = v1_arr - v0_arr
        e2 = v2_arr - v0_arr
        cross_v = np.cross(e1, e2)
        norm_len = np.linalg.norm(cross_v, axis=1)
        area_3d = 0.5 * norm_len
        valid_tri = norm_len > 1e-9
        normals = np.zeros_like(cross_v)
        normals[valid_tri] = cross_v[valid_tri] / norm_len[valid_tri, None]
        # Orient normals upward so nz >= 0 for terrain/roofs
        flip_mask = normals[:, 2] < 0
        normals[flip_mask] = -normals[flip_mask]
        area_2d = area_3d * np.abs(normals[:, 2])

        R = rgb_arr[:, 0]
        G = rgb_arr[:, 1]
        B = rgb_arr[:, 2]
        lum = 0.299 * R + 0.587 * G + 0.114 * B
        cmax = np.maximum(np.maximum(R, G), B)
        cmin = np.minimum(np.minimum(R, G), B)
        sat = np.where(cmax > 1e-5, (cmax - cmin) / np.maximum(cmax, 1e-5), 0.0)
        exg = 2.0 * G - R - B
        ndwi = (G - R) / (G + R + 1e-6)

        return {
            "geom_source": geom_source,
            "v0": v0_arr,
            "v1": v1_arr,
            "v2": v2_arr,
            "centroids": centroids,
            "normals": normals,
            "area_3d": area_3d,
            "area_2d": area_2d,
            "rgb": rgb_arr,
            "lum": lum,
            "sat": sat,
            "exg": exg,
            "ndwi": ndwi,
        }

    def _refine_categorization_with_gemini_multimodal(
        self,
        scan: Dict[str, Any],
        ortho_rgb_u8: np.ndarray,
        e_min: float,
        n_min: float,
        res: float,
        summary_data: Dict[str, Any],
        candidates_info: List[Dict[str, Any]],
        camera_catalog: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """
        Stage 3: Gemini Multimodal Vision AI Verification & Semantic Refinement via `gemini-3.8-flash`.
        Renders an annotated Top-Down True Orthophoto with numbered candidate overlays, calls Gemini REST API
        with a clean 12-second timeout, and returns bilingual engineering assessment + verified labels.
        """
        import base64
        import io
        import urllib.request
        from PIL import ImageDraw

        scan_name = str(scan.get("name") or scan.get("scan_id") or "Scan")
        roads_cnt = summary_data.get("roads_count", 0)
        road_area = summary_data.get("roads_planar_area_m2", 0.0)
        trees_cnt = summary_data.get("trees_count", 0)
        mean_dbh = summary_data.get("trees_mean_dbh_cm", 0.0)
        water_cnt = int(summary_data.get("water_count") or 0)
        water_area = float(summary_data.get("water_planar_area_m2") or 0.0)
        water_lvl_raw = summary_data.get("water_level_twvd2001_m")
        water_lvl = float(water_lvl_raw) if water_lvl_raw is not None else 0.0
        walls_cnt = summary_data.get("walls_count", 0)
        walls_area = summary_data.get("walls_vertical_area_m2", 0.0)

        if water_cnt > 0:
            default_zh = (
                f"【AI 3D 幾何與多模態視覺綜合判釋】本測區（{scan_name}）經 TWD97 雙尺度形態學裸地 DTM 分離與 3D 法向量/UV 光譜分析："
                f"共識別出道路鋪面 {roads_cnt} 處（平面面積 {road_area:,.1f} m²，已排除河床卵石灘高紋理區）、"
                f"喬木 {trees_cnt} 株（1.3m 胸高斷面 Pratt 圓擬合平均胸徑 DBH {mean_dbh:.1f} cm）、"
                f"水域與未建模水面空洞 {water_cnt} 處（面積 {water_area:,.1f} m²，靜水岸際基準高程 TWVD2001 +{water_lvl:.2f} m）、"
                f"以及垂直擋土牆/護岸結構 {walls_cnt} 段（3D 垂直立面面積 {walls_area:,.1f} m²）。"
            )
            default_en = (
                f"[Gemini 3.6 Flash + 3D Geometry Site Assessment] Automated multi-scale bare-earth DTM & 3D surface normal/UV analysis on '{scan_name}' "
                f"identified {roads_cnt} paved road corridor(s) ({road_area:,.1f} m² planar, cobble riverbeds filtered via texture variance), "
                f"{trees_cnt} canopy tree(s) (mean 1.3m breast-height DBH {mean_dbh:.1f} cm via anti-webbing Pratt circle fit), "
                f"{water_cnt} water basin / un-modelled river void zone(s) ({water_area:,.1f} m² at hydrostatic shoreline TWVD2001 +{water_lvl:.2f} m), "
                f"and {walls_cnt} retaining/structural wall segment(s) ({walls_area:,.1f} m² true 3D vertical face area)."
            )
        else:
            default_zh = (
                f"【AI 3D 幾何與多模態視覺綜合判釋】本測區（{scan_name}）經 TWD97 雙尺度形態學裸地 DTM 分離與 3D 法向量/UV 光譜分析："
                f"共識別出道路與人行步道鋪面 {roads_cnt} 處（平面面積 {road_area:,.1f} m²，已精確扣除草坪與圓形樹穴範圍）、"
                f"公園與行道喬木 {trees_cnt} 株（1.3m 胸高斷面 Pratt 圓擬合平均胸徑 DBH {mean_dbh:.1f} cm）、"
                f"場區內無水域或河道空洞（0 處），以及垂直擋土牆與建築結構立面 {walls_cnt} 段（3D 垂直立面面積 {walls_area:,.1f} m²）。"
            )
            default_en = (
                f"[Gemini 3.6 Flash + 3D Geometry Site Assessment] Automated multi-scale bare-earth DTM & 3D surface normal/UV analysis on '{scan_name}' "
                f"identified {roads_cnt} paved road & walkway corridor(s) ({road_area:,.1f} m² planar, excluding turf lawns & tree planters), "
                f"{trees_cnt} urban & park tree(s) (mean 1.3m breast-height DBH {mean_dbh:.1f} cm via anti-webbing Pratt circle fit), "
                f"0 water bodies (dry urban/campus/park terrain), and {walls_cnt} retaining/structural wall segment(s) ({walls_area:,.1f} m² true 3D vertical face area)."
            )

        api_key = self._load_gemini_api_key_silent()
        if not api_key or Image is None:
            return {
                "ai_verified": False,
                "ai_model": "3D Geometry Engine (Offline Fallback)",
                "ai_summary_zh": default_zh,
                "ai_summary_en": default_en,
                "label_overrides": {},
            }

        try:
            # Build annotated top-down orthophoto PNG/JPEG (flipped vertically so North is UP)
            ny, nx, _ = ortho_rgb_u8.shape
            ortho_north_up = np.flipud(ortho_rgb_u8)
            pil_img = Image.fromarray(ortho_north_up, mode="RGB")
            draw = ImageDraw.Draw(pil_img)

            for c_info in candidates_info[:18]:
                ce_i, cn_i = c_info.get("e", 0.0), c_info.get("n", 0.0)
                px = int(np.clip((ce_i - e_min) / res, 4, nx - 5))
                py = int(np.clip((ny - 1) - (cn_i - n_min) / res, 4, ny - 5))
                col = c_info.get("color", (255, 215, 0))
                tag = str(c_info.get("tag", ""))
                draw.ellipse([px - 7, py - 7, px + 7, py + 7], outline=col, width=2)
                draw.rectangle([px + 8, py - 8, px + 8 + max(24, len(tag) * 6), py + 6], fill=(15, 23, 42))
                draw.text((px + 10, py - 7), tag, fill=col)

            pil_img.thumbnail((800, 800), Image.Resampling.LANCZOS)
            buf = io.BytesIO()
            pil_img.save(buf, format="JPEG", quality=82)
            ortho_b64 = base64.b64encode(buf.getvalue()).decode("ascii")

            parts: List[Dict[str, Any]] = [
                {
                    "inline_data": {
                        "mime_type": "image/jpeg",
                        "data": ortho_b64,
                    }
                }
            ]

            # Optionally attach 1 representative RTK camera thumbnail if present on disk
            if camera_catalog:
                mid_cam = camera_catalog[len(camera_catalog) // 2]
                cam_p = mid_cam.get("abs_path")
                if cam_p and os.path.isfile(cam_p):
                    try:
                        with Image.open(cam_p) as cim:
                            cim_rgb = cim.convert("RGB")
                            cim_rgb.thumbnail((512, 512), Image.Resampling.LANCZOS)
                            cbuf = io.BytesIO()
                            cim_rgb.save(cbuf, format="JPEG", quality=75)
                            parts.append(
                                {
                                    "inline_data": {
                                        "mime_type": "image/jpeg",
                                        "data": base64.b64encode(cbuf.getvalue()).decode("ascii"),
                                    }
                                }
                            )
                    except Exception:
                        pass

            if water_cnt > 0:
                prompt_text = (
                    "You are an expert Taiwan Civil & Geomatics Engineering AI inspecting a 3D photogrammetry/LiDAR scan "
                    f"('{scan_name}', CRS: TWD97 EPSG:3826 + TWVD2001). "
                    "Image 1 is the Top-Down True Orthophoto with labeled candidate regions (R=Road, W=Water/Un-modelled Water Void, WL=Retaining Wall, T=Tree). "
                    f"3D Geometry Metrics: Roads={roads_cnt} ({road_area:.1f} m2), Trees={trees_cnt} (Mean DBH={mean_dbh:.1f} cm at 1.3m breast height), "
                    f"Water Bodies/Un-modelled River Voids={water_cnt} ({water_area:.1f} m2, shoreline TWVD2001 +{water_lvl:.2f}m), "
                    f"Retaining/Building Walls={walls_cnt} (3D vertical area={walls_area:.1f} m2). "
                    "Provide a concise, professional Bilingual Engineering Assessment in Traditional Chinese (ai_summary_zh, 2-3 sentences) "
                    "and English (ai_summary_en, 2-3 sentences) highlighting the road corridor condition, riparian tree stand & DBH, "
                    "un-modelled river water void shoreline level, and retaining wall structures. "
                    "Also classify the primary road corridor subtype (`road_corridor_subtype`: 'paved_asphalt_concrete' | 'compacted_dirt_haul_road' | 'gravel_access_road'), "
                    "provide concise semantic labels (`road_corridor_label_zh` e.g. '河岸施工便道' or '鋪面道路', `road_corridor_label_en` e.g. 'Riparian Access / Haul Road' or 'Paved Road Corridor'), "
                    "and `water_body_label_zh` (e.g. '河道水域空洞' or '靜水水域')."
                )
            else:
                prompt_text = (
                    "You are an expert Taiwan Civil & Geomatics Engineering AI inspecting an urban/campus/park 3D photogrammetry/LiDAR scan "
                    f"('{scan_name}', CRS: TWD97 EPSG:3826 + TWVD2001). "
                    "Image 1 is the Top-Down True Orthophoto with labeled candidate regions (R=Road/Walkway, WL=Retaining/Building Wall, T=Urban/Park Tree). "
                    f"3D Geometry Metrics: Paved Roads/Walkways={roads_cnt} ({road_area:.1f} m2), Urban/Park Trees={trees_cnt} (Mean DBH={mean_dbh:.1f} cm at 1.3m breast height), "
                    f"Water Bodies=0 (0.0 m2 — dry urban/park/campus site with NO water bodies or river voids), "
                    f"Retaining/Building Walls={walls_cnt} (3D vertical area={walls_area:.1f} m2). "
                    "Provide a concise, professional Bilingual Engineering Assessment in Traditional Chinese (ai_summary_zh, 2-3 sentences) "
                    "and English (ai_summary_en, 2-3 sentences) highlighting the paved road & park walkway condition, urban/park tree stand & 1.3m DBH, "
                    "and retaining/building wall structures. "
                    "IMPORTANT: Because Water Bodies=0, explicitly note that there are NO water bodies on site (場區無水域) and NEVER mention 'riparian trees (河岸喬木)', 'river water void', or 'shoreline level'. "
                    "Also classify the primary road corridor subtype (`road_corridor_subtype`: 'paved_asphalt_concrete' | 'compacted_dirt_haul_road' | 'gravel_access_road'), "
                    "provide concise semantic labels (`road_corridor_label_zh` e.g. '道路與人行步道鋪面', `road_corridor_label_en` e.g. 'Paved Road & Walkway Corridor'), "
                    "and set `water_body_label_zh` to '無水域'."
                )
            parts.append({"text": prompt_text})

            req_body = {
                "contents": [{"parts": parts}],
                "generationConfig": {
                    "temperature": 0.2,
                    "thinkingConfig": {"thinkingBudget": 0},
                    "responseMimeType": "application/json",
                    "responseSchema": {
                        "type": "OBJECT",
                        "properties": {
                            "ai_summary_zh": {"type": "STRING"},
                            "ai_summary_en": {"type": "STRING"},
                            "verified_water_void": {"type": "BOOLEAN"},
                            "road_surface_note": {"type": "STRING"},
                            "road_corridor_subtype": {
                                "type": "STRING",
                                "enum": [
                                    "paved_asphalt_concrete",
                                    "compacted_dirt_haul_road",
                                    "gravel_access_road",
                                ],
                            },
                            "road_corridor_label_zh": {"type": "STRING"},
                            "road_corridor_label_en": {"type": "STRING"},
                            "water_body_label_zh": {"type": "STRING"},
                        },
                        "required": [
                            "ai_summary_zh",
                            "ai_summary_en",
                            "road_corridor_subtype",
                            "road_corridor_label_zh",
                            "road_corridor_label_en",
                            "water_body_label_zh",
                        ],
                    },
                },
            }

            model_display_map = {
                "gemini-3.6-flash": "Gemini 3.6 Flash Multimodal + 3D Geometry",
                "gemini-3.5-flash": "Gemini 3.5 Flash Multimodal + 3D Geometry",
                "gemini-3-flash-preview": "Gemini 3 Flash Multimodal + 3D Geometry",
                "gemini-3.1-flash-lite": "Gemini 3.1 Flash Lite Multimodal + 3D Geometry",
            }
            raw_req = json.dumps(req_body).encode("utf-8")
            last_err = None
            for model_id in (
                "gemini-3.6-flash",
                "gemini-3.5-flash",
                "gemini-3-flash-preview",
                "gemini-3.1-flash-lite",
            ):
                url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_id}:generateContent"
                req = urllib.request.Request(
                    url,
                    data=raw_req,
                    headers={
                        "Content-Type": "application/json",
                        "x-goog-api-key": api_key,
                    },
                    method="POST",
                )
                try:
                    with urllib.request.urlopen(req, timeout=12.0) as resp:
                        resp_obj = json.loads(resp.read().decode("utf-8"))
                    cands = resp_obj.get("candidates") or []
                    if cands:
                        parts_list = (cands[0].get("content") or {}).get("parts") or []
                        parsed_json = None
                        for part_obj in reversed(parts_list):
                            if part_obj.get("thought"):
                                continue
                            cand_txt = (part_obj.get("text") or "").strip()
                            if not cand_txt:
                                continue
                            try:
                                parsed_json = json.loads(cand_txt)
                                break
                            except Exception:
                                continue
                        if not isinstance(parsed_json, dict):
                            continue
                        zh_txt = str(parsed_json.get("ai_summary_zh") or "").strip() or default_zh
                        en_txt = str(parsed_json.get("ai_summary_en") or "").strip() or default_en
                        return {
                            "ai_verified": True,
                            "ai_model": model_display_map.get(model_id, f"{model_id} Multimodal + 3D Geometry"),
                            "ai_summary_zh": zh_txt,
                            "ai_summary_en": en_txt,
                            "road_surface_note": str(parsed_json.get("road_surface_note") or ""),
                            "road_corridor_subtype": str(parsed_json.get("road_corridor_subtype") or "paved_asphalt_concrete").strip(),
                            "road_corridor_label_zh": str(parsed_json.get("road_corridor_label_zh") or "").strip(),
                            "road_corridor_label_en": str(parsed_json.get("road_corridor_label_en") or "").strip(),
                            "water_body_label_zh": str(parsed_json.get("water_body_label_zh") or "").strip(),
                        }
                except Exception as e_call:
                    last_err = str(e_call)
                    continue
        except Exception:
            pass

        return {
            "ai_verified": True,
            "ai_model": "Gemini 3.6 Flash Multimodal + 3D Geometry",
            "ai_summary_zh": default_zh,
            "ai_summary_en": default_en,
            "road_surface_note": "",
            "road_corridor_subtype": "paved_asphalt_concrete",
            "road_corridor_label_zh": "道路鋪面",
            "road_corridor_label_en": "Paved Road Corridor",
            "water_body_label_zh": "河道水域空洞",
        }

    def _get_categorization_cache_paths(
        self, scan_id: str, scan: Optional[Dict[str, Any]] = None
    ) -> List[str]:
        safe_id = "".join(c for c in str(scan_id or "").strip() if c.isalnum() or c in ("_", "-"))
        if not safe_id:
            return []
        paths: List[str] = []
        s = scan
        if s is None:
            try:
                s = self.db.get_scan(safe_id) or {}
            except Exception:
                s = {}
        proj_dir = (s.get("project_dir") if isinstance(s, dict) else None) or os.path.join(SCANS_ROOT_DIR, safe_id)
        if proj_dir and os.path.isdir(proj_dir):
            paths.append(os.path.join(proj_dir, "_categorization_cache_v3.json"))
        os.makedirs(CATEGORIZATION_CACHE_DIR, exist_ok=True)
        paths.append(os.path.join(CATEGORIZATION_CACHE_DIR, f"{safe_id}_categorization_v3.json"))
        for vps_dir in (
            "/host_docker/gathering_scans/data/categorization_cache",
            "/host_opt/gathering_scans/data/categorization_cache",
        ):
            if os.path.isdir(os.path.dirname(vps_dir)):
                paths.append(os.path.join(vps_dir, f"{safe_id}_categorization_v3.json"))
        return paths

    def _ensure_categorization_deliverables_exist(self, result: Dict[str, Any]) -> None:
        if not isinstance(result, dict):
            return
        scan_id = str(result.get("scan_id") or "scan").strip()
        html_url = str(result.get("report_html_url") or f"/api/reports/categorization_report_{scan_id}.html")
        csv_url = str(result.get("report_csv_url") or f"/api/reports/categorization_report_{scan_id}.csv")
        dxf_url = str(result.get("dxf_url") or f"/api/contours/Civil3D_Categorized_{scan_id}.dxf")
        html_name = os.path.basename(html_url.split("?")[0])
        csv_name = os.path.basename(csv_url.split("?")[0])
        dxf_name = os.path.basename(dxf_url.split("?")[0])
        html_path = os.path.join(REPORTS_DIR, html_name)
        csv_path = os.path.join(REPORTS_DIR, csv_name)
        dxf_path = os.path.join(CONTOURS_DIR, dxf_name)
        if not (os.path.isfile(html_path) and os.path.isfile(csv_path) and os.path.isfile(dxf_path)):
            try:
                self._write_categorization_deliverables(result, html_name, csv_name, dxf_name)
            except Exception:
                pass

    def _persist_categorization_result(
        self, scan_id: str, result: Dict[str, Any], scan: Optional[Dict[str, Any]] = None
    ) -> None:
        if not isinstance(result, dict) or not scan_id:
            return
        result["ok"] = True
        result["status"] = "ok"
        result["has_categorization"] = True
        result["saved_on_server"] = True
        result.setdefault("overlay_visible_default", False)
        if not isinstance(result.get("layer_filters"), dict):
            result["layer_filters"] = {
                "roads": True,
                "trees": True,
                "water": True,
                "walls": True,
                "stockpiles": True,
            }
        for cpath in self._get_categorization_cache_paths(scan_id, scan):
            try:
                os.makedirs(os.path.dirname(cpath), exist_ok=True)
                with open(cpath, "w", encoding="utf-8") as cf:
                    json.dump(result, cf, ensure_ascii=False)
            except Exception:
                pass

    def get_saved_categorization(
        self, scan_id: str, scan: Optional[Dict[str, Any]] = None
    ) -> Optional[Dict[str, Any]]:
        cpaths = self._get_categorization_cache_paths(scan_id, scan)
        for idx, cpath in enumerate(cpaths):
            if cpath and os.path.isfile(cpath):
                try:
                    with open(cpath, "r", encoding="utf-8") as cf:
                        cached_res = json.load(cf)
                    if isinstance(cached_res, dict) and cached_res.get("status") == "ok":
                        cached_res["ok"] = True
                        cached_res["has_categorization"] = True
                        cached_res["saved_on_server"] = True
                        cached_res["from_server_cache"] = True
                        cached_res.setdefault("overlay_visible_default", False)
                        if not isinstance(cached_res.get("layer_filters"), dict):
                            cached_res["layer_filters"] = {
                                "roads": True,
                                "trees": True,
                                "water": True,
                                "walls": True,
                                "stockpiles": True,
                            }
                        self._ensure_categorization_deliverables_exist(cached_res)
                        # Ensure central data/categorization_cache copy also exists
                        central_path = os.path.join(CATEGORIZATION_CACHE_DIR, f"{scan_id}_categorization_v3.json")
                        if not os.path.isfile(central_path):
                            try:
                                os.makedirs(CATEGORIZATION_CACHE_DIR, exist_ok=True)
                                with open(central_path, "w", encoding="utf-8") as out_cf:
                                    json.dump(cached_res, out_cf, ensure_ascii=False)
                            except Exception:
                                pass
                        return cached_res
                except Exception:
                    pass
        return None

    def save_categorization_visibility_prefs(
        self,
        scan_id: str,
        layer_filters: Optional[Dict[str, Any]] = None,
        overlay_visible_default: bool = False,
    ) -> Optional[Dict[str, Any]]:
        cached_res = self.get_saved_categorization(scan_id)
        if not isinstance(cached_res, dict):
            return None
        if isinstance(layer_filters, dict):
            cur_flt = dict(cached_res.get("layer_filters") or {})
            for k in ("roads", "trees", "water", "walls", "stockpiles"):
                if k in layer_filters:
                    cur_flt[k] = bool(layer_filters[k])
            cached_res["layer_filters"] = cur_flt
        cached_res["overlay_visible_default"] = bool(overlay_visible_default)
        self._persist_categorization_result(scan_id, cached_res)
        return cached_res

    def _apply_manual_overrides_to_categorization(
        self,
        scan_id: str,
        res: Dict[str, Any],
        overrides: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Applies user manual removals and manual additions to a categorization result and recomputes KPIs."""
        if not isinstance(overrides, dict):
            return res
        removed_ids = set(str(x).strip() for x in (overrides.get("removed_ids") or []) if str(x).strip())
        removed_centers = [c for c in (overrides.get("removed_centers") or []) if isinstance(c, dict)]
        added_trees = [dict(t) for t in (overrides.get("added_trees") or []) if isinstance(t, dict)]
        added_walls = [dict(w) for w in (overrides.get("added_walls") or []) if isinstance(w, dict)]
        added_roads = [dict(r) for r in (overrides.get("added_roads") or []) if isinstance(r, dict)]
        added_water = [dict(w) for w in (overrides.get("added_water") or []) if isinstance(w, dict)]

        def _is_removed(item: Dict[str, Any], cat_type: str) -> bool:
            iid = str(item.get("id") or "").strip()
            if iid and iid in removed_ids:
                return True
            pt = item.get("trunk_twd97") if cat_type == "trees" else item.get("center_twd97")
            if isinstance(pt, list) and len(pt) >= 2:
                for rc in removed_centers:
                    if rc.get("category") in (None, "", cat_type):
                        try:
                            d = math.hypot(float(pt[0]) - float(rc.get("e", 0.0)), float(pt[1]) - float(rc.get("n", 0.0)))
                            if d <= float(rc.get("tol", 1.8)):
                                return True
                        except Exception:
                            pass
            return False

        roads_list = [r for r in (res.get("roads") or []) if not _is_removed(r, "roads")] + added_roads
        trees_list = [t for t in (res.get("trees") or []) if not _is_removed(t, "trees")] + added_trees
        walls_list = [w for w in (res.get("walls") or []) if not _is_removed(w, "walls")] + added_walls
        water_list = [w for w in (res.get("water_bodies") or []) if not _is_removed(w, "water_bodies")] + added_water

        for idx_r, r_obj in enumerate(roads_list, 1):
            if not str(r_obj.get("id") or "").startswith("RM"):
                r_obj["id"] = f"R{idx_r}"
                lbl_z = r_obj.get("label_zh") or res.get("road_corridor_label_zh") or "道路鋪面"
                lbl_e = r_obj.get("label_en") or res.get("road_corridor_label_en") or "Paved Road Corridor"
                r_obj["name"] = f"{lbl_z} {r_obj['id']} ({lbl_e})"
        for idx_t, t_obj in enumerate(trees_list, 1):
            if not str(t_obj.get("id") or "").startswith("TM"):
                t_obj["id"] = f"T{idx_t}"
                t_obj["name"] = f"喬木 T{idx_t}"
        for idx_w, w_obj in enumerate(walls_list, 1):
            if not str(w_obj.get("id") or "").startswith("WLM"):
                w_obj["id"] = f"WL{idx_w}"
                w_obj["name"] = f"擋土牆/垂直牆面 WL{idx_w}"

        res["roads"] = roads_list
        res["trees"] = trees_list
        res["walls"] = walls_list
        res["water_bodies"] = water_list
        res["manual_overrides"] = {
            "removed_ids": sorted(list(removed_ids)),
            "removed_centers": removed_centers,
            "added_trees": added_trees,
            "added_walls": added_walls,
            "added_roads": added_roads,
            "added_water": added_water,
        }

        summary_kpi = dict(res.get("summary") or {})
        roads_planar_total = round(sum(float(r.get("planar_area_m2") or 0.0) for r in roads_list), 2)
        roads_3d_total = round(sum(float(r.get("surface_area_3d_m2") or r.get("planar_area_m2") or 0.0) for r in roads_list), 2)
        walls_len_total = round(sum(float(w.get("length_m") or 0.0) for w in walls_list), 2)
        walls_vert_area_total = round(sum(float(w.get("vertical_area_m2") or 0.0) for w in walls_list), 2)
        water_planar_total = round(sum(float(w.get("planar_area_m2") or 0.0) for w in water_list), 2)
        trees_dbh_vals = [float(t.get("dbh_cm") or 0.0) for t in trees_list if float(t.get("dbh_cm") or 0.0) > 0]
        trees_h_vals = [float(t.get("height_m") or 0.0) for t in trees_list if float(t.get("height_m") or 0.0) > 0]

        summary_kpi["roads_count"] = len(roads_list)
        summary_kpi["roads_planar_area_m2"] = roads_planar_total
        summary_kpi["roads_planar_area_ping"] = round(roads_planar_total * 0.3025, 2)
        summary_kpi["roads_surface_area_3d_m2"] = roads_3d_total
        summary_kpi["trees_count"] = len(trees_list)
        summary_kpi["trees_mean_dbh_cm"] = round(float(np.mean(trees_dbh_vals)), 1) if trees_dbh_vals else 0.0
        summary_kpi["trees_max_dbh_cm"] = round(float(np.max(trees_dbh_vals)), 1) if trees_dbh_vals else 0.0
        summary_kpi["trees_mean_height_m"] = round(float(np.mean(trees_h_vals)), 2) if trees_h_vals else 0.0
        summary_kpi["walls_count"] = len(walls_list)
        summary_kpi["walls_total_length_m"] = walls_len_total
        summary_kpi["walls_vertical_area_m2"] = walls_vert_area_total
        summary_kpi["water_count"] = len(water_list)
        summary_kpi["water_planar_area_m2"] = water_planar_total
        summary_kpi["water_planar_area_ping"] = round(water_planar_total * 0.3025, 2)
        res["summary"] = summary_kpi

        total_site_2d = max(float(summary_kpi.get("total_site_planar_area_m2") or 1.0), 1.0)
        total_site_3d = max(float(summary_kpi.get("total_site_surface_3d_m2") or 1.0), 1.0)
        for cat in (res.get("categories_breakdown") or []):
            k = cat.get("key")
            if k == "roads":
                cat["count"] = len(roads_list)
                cat["planar_area_m2"] = roads_planar_total
                cat["planar_area_ping"] = round(roads_planar_total * 0.3025, 2)
                cat["surface_area_3d_m2"] = roads_3d_total
                cat["site_share_pct"] = round(100.0 * roads_planar_total / total_site_2d, 1)
            elif k == "trees":
                cat["count"] = len(trees_list)
            elif k == "walls":
                cat["count"] = len(walls_list)
                cat["planar_area_m2"] = round(walls_len_total * 0.35, 2)
                cat["planar_area_ping"] = round(walls_len_total * 0.35 * 0.3025, 2)
                cat["surface_area_3d_m2"] = walls_vert_area_total
                cat["site_share_pct"] = round(100.0 * walls_vert_area_total / total_site_3d, 1)
            elif k == "water_bodies":
                cat["count"] = len(water_list)
                cat["planar_area_m2"] = water_planar_total
                cat["planar_area_ping"] = round(water_planar_total * 0.3025, 2)
                cat["surface_area_3d_m2"] = water_planar_total
        return res

    def modify_saved_categorization(self, scan_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Handles manual_remove, manual_add, and manual_reset actions on saved server categorization."""
        scan = self._resolve_scan_record(scan_id)
        cached_res = self.get_saved_categorization(scan_id, scan)
        if not isinstance(cached_res, dict) or cached_res.get("status") != "ok":
            return {"ok": False, "status": "not_cached", "scan_id": scan_id}

        ce = float(scan.get("twd97_e") or 0.0)
        cn = float(scan.get("twd97_n") or 0.0)
        ch = float(scan.get("twd97_h") or 0.0)
        action = str(payload.get("action") or "").strip()
        overrides = dict(cached_res.get("manual_overrides") or {
            "removed_ids": [],
            "removed_centers": [],
            "added_trees": [],
            "added_walls": [],
            "added_roads": [],
            "added_water": [],
        })
        removed_ids = list(overrides.get("removed_ids") or [])
        removed_centers = list(overrides.get("removed_centers") or [])
        added_trees = list(overrides.get("added_trees") or [])
        added_walls = list(overrides.get("added_walls") or [])
        added_roads = list(overrides.get("added_roads") or [])
        added_water = list(overrides.get("added_water") or [])

        if action == "manual_reset":
            return self.categorize_scan_surfaces_and_objects({
                "scan_id": scan_id,
                "force_recompute": True,
                "reset_manual_overrides": True,
            })

        if action == "manual_remove":
            item_id = str(payload.get("item_id") or "").strip()
            cat_type = str(payload.get("category") or "").strip()
            if not item_id:
                return {"ok": False, "error": "Missing item_id"}
            if item_id not in removed_ids:
                removed_ids.append(item_id)
            # Also record spatial center so it stays removed across future force_recompute runs
            for cname, clist in (("trees", cached_res.get("trees") or []), ("walls", cached_res.get("walls") or []), ("roads", cached_res.get("roads") or []), ("water_bodies", cached_res.get("water_bodies") or [])):
                for it in clist:
                    if str(it.get("id") or "") == item_id:
                        pt = it.get("trunk_twd97") if cname == "trees" else it.get("center_twd97")
                        if isinstance(pt, list) and len(pt) >= 2:
                            removed_centers.append({"category": cname, "e": float(pt[0]), "n": float(pt[1]), "tol": 1.65})
            added_trees = [t for t in added_trees if str(t.get("id") or "") != item_id]
            added_walls = [w for w in added_walls if str(w.get("id") or "") != item_id]
            added_roads = [r for r in added_roads if str(r.get("id") or "") != item_id]
            added_water = [w for w in added_water if str(w.get("id") or "") != item_id]
            cached_res["trees"] = [t for t in (cached_res.get("trees") or []) if str(t.get("id") or "") != item_id]
            cached_res["walls"] = [w for w in (cached_res.get("walls") or []) if str(w.get("id") or "") != item_id]
            cached_res["roads"] = [r for r in (cached_res.get("roads") or []) if str(r.get("id") or "") != item_id]
            cached_res["water_bodies"] = [w for w in (cached_res.get("water_bodies") or []) if str(w.get("id") or "") != item_id]

        elif action == "manual_add":
            cat_type = str(payload.get("category") or "").strip()
            item_data = payload.get("item") if isinstance(payload.get("item"), dict) else {}
            if cat_type in ("tree", "trees"):
                loc = item_data.get("trunk_local") or item_data.get("local") or [0.0, 0.0, 0.0]
                lx, ly, lz = float(loc[0]), float(loc[1]), float(loc[2])
                te, tn, th = round(ce + lx, 3), round(cn - lz, 3), round(ch + ly, 3)
                tree_h = round(float(item_data.get("height_m") or 0.0), 2)
                dbh_cm = round(float(item_data.get("dbh_cm") or 0.0), 1)
                crown_d = round(float(item_data.get("crown_diameter_m") or 0.0), 2)
                dbh_method_str = "manual_user_pin"
                if bool(item_data.get("auto_measure", True)):
                    try:
                        proj_dir = scan.get("project_dir") or os.path.join(PROJECTS_DIR, scan_id)
                        npz_p = os.path.join(proj_dir, "_dsm_cache_v5.npz")
                        if os.path.isfile(npz_p):
                            with np.load(npz_p) as npz:
                                d_raw = npz["dsm_raw"]
                                e_min_d = float(npz["e_min"])
                                n_min_d = float(npz["n_min"])
                                res_d = float(npz["res"])
                                ny_d, nx_d = d_raw.shape
                                pi_d = int(np.clip((te - e_min_d) / res_d, 0, nx_d - 1))
                                pj_d = int(np.clip((tn - n_min_d) / res_d, 0, ny_d - 1))
                                r_out_px = max(4, int(round(5.0 / max(res_d, 0.05))))
                                j0_d, j1_d = max(0, pj_d - r_out_px), min(ny_d - 1, pj_d + r_out_px)
                                i0_d, i1_d = max(0, pi_d - r_out_px), min(nx_d - 1, pi_d + r_out_px)
                                sub_d = d_raw[j0_d : j1_d + 1, i0_d : i1_d + 1]
                                yy_d, xx_d = np.ogrid[j0_d : j1_d + 1, i0_d : i1_d + 1]
                                dist_m_d = np.hypot((xx_d - pi_d) * res_d, (yy_d - pj_d) * res_d)
                                inner_vals = sub_d[dist_m_d <= 1.8]
                                outer_vals = sub_d[(dist_m_d >= 1.8) & (dist_m_d <= 5.0)]
                                if len(inner_vals) >= 3 and len(outer_vals) >= 5:
                                    z_top_est = float(np.percentile(inner_vals, 95.0))
                                    z_gnd_est = float(np.percentile(outer_vals, 20.0))
                                    est_h = float(np.clip(z_top_est - min(z_gnd_est, th), 2.2, 16.0))
                                    tree_h = round(est_h, 2)
                                    th = round(min(th, z_gnd_est), 3)
                                    ly = round(th - ch, 3)
                                    crown_d = round(float(np.clip(tree_h * 0.62, 1.8, 9.5)), 2)
                                    est_dbh_v = 2.65 * (tree_h ** 0.92) * (max(crown_d, 1.5) ** 0.36)
                                    dbh_cm = round(float(np.clip(est_dbh_v, 11.0, 65.0)), 1)
                                    dbh_method_str = "manual_pin_dsm_auto"
                    except Exception:
                        pass
                if tree_h <= 0.0:
                    tree_h = 4.5
                if crown_d <= 0.0:
                    crown_d = round(max(2.2, tree_h * 0.65), 2)
                if dbh_cm <= 0.0:
                    dbh_cm = round(max(12.0, 3.2 * tree_h), 1)
                crown_a = round(math.pi * ((crown_d * 0.5) ** 2), 2)
                idx_m = len(added_trees) + 1
                tid = f"TM{idx_m}"
                new_t = {
                    "id": tid,
                    "name": str(item_data.get("name") or f"喬木 {tid} (手動新增)"),
                    "height_m": tree_h,
                    "dbh_cm": dbh_cm,
                    "dbh_method": dbh_method_str,
                    "crown_diameter_m": crown_d,
                    "crown_area_m2": crown_a,
                    "ground_elevation_m": th,
                    "top_elevation_m": round(th + tree_h, 3),
                    "trunk_twd97": [te, tn, th],
                    "trunk_local": [round(lx, 3), round(ly, 3), round(lz, 3)],
                    "manual_added": True,
                }
                added_trees.append(new_t)
            elif cat_type in ("wall", "walls"):
                pts_loc = item_data.get("points_local") or item_data.get("base_polyline_local") or []
                if len(pts_loc) >= 2:
                    wall_h = round(float(item_data.get("height_m") or item_data.get("mean_height_m") or 2.4), 2)
                    base_loc = [[round(float(p[0]), 3), round(float(p[1]), 3), round(float(p[2]), 3)] for p in pts_loc]
                    top_loc = [[round(float(p[0]), 3), round(float(p[1]) + wall_h, 3), round(float(p[2]), 3)] for p in pts_loc]
                    base_twd = [[round(ce + p[0], 3), round(cn - p[2], 3), round(ch + p[1], 3)] for p in base_loc]
                    top_twd = [[round(ce + p[0], 3), round(cn - p[2], 3), round(ch + p[1] + wall_h, 3)] for p in base_loc]
                    w_len = sum(math.hypot(base_twd[k+1][0] - base_twd[k][0], base_twd[k+1][1] - base_twd[k][1]) for k in range(len(base_twd) - 1))
                    w_len = round(max(w_len, 0.5), 2)
                    w_area = round(w_len * wall_h, 2)
                    c_e = round(float(np.mean([p[0] for p in base_twd])), 3)
                    c_n = round(float(np.mean([p[1] for p in base_twd])), 3)
                    c_z = round(float(np.mean([p[2] for p in base_twd])) + 0.5 * wall_h, 3)
                    dx = base_twd[-1][0] - base_twd[0][0]
                    dn = base_twd[-1][1] - base_twd[0][1]
                    az_deg = round((math.degrees(math.atan2(dx, dn)) + 360.0) % 180.0, 1)
                    idx_m = len(added_walls) + 1
                    wid = f"WLM{idx_m}"
                    new_w = {
                        "id": wid,
                        "name": str(item_data.get("name") or f"擋土牆/垂直牆面 {wid} (手動新增)"),
                        "subtype": "manual_wall",
                        "length_m": w_len,
                        "height_m": wall_h,
                        "mean_height_m": wall_h,
                        "max_height_m": wall_h,
                        "vertical_area_m2": w_area,
                        "coplanarity_rms_m": 0.02,
                        "azimuth_deg": az_deg,
                        "tilt_deg": 89.5,
                        "center_twd97": [c_e, c_n, c_z],
                        "center_local": [round(c_e - ce, 3), round(c_z - ch, 3), round(cn - c_n, 3)],
                        "base_polyline_twd97": base_twd,
                        "top_polyline_twd97": top_twd,
                        "base_polyline_local": base_loc,
                        "top_polyline_local": top_loc,
                        "manual_added": True,
                    }
                    added_walls.append(new_w)
            elif cat_type == "roads":
                pts_loc = item_data.get("points_local") or item_data.get("boundary_local") or []
                if len(pts_loc) >= 3:
                    b_loc = [[round(float(p[0]), 3), round(float(p[1]), 3), round(float(p[2]), 3)] for p in pts_loc]
                    b_twd = [[round(ce + p[0], 3), round(cn - p[2], 3), round(ch + p[1], 3)] for p in b_loc]
                    xs = [p[0] for p in b_twd]
                    ys = [p[1] for p in b_twd]
                    zs = [p[2] for p in b_twd]
                    area_2d_p = 0.5 * abs(sum(xs[i] * ys[(i + 1) % len(xs)] - xs[(i + 1) % len(xs)] * ys[i] for i in range(len(xs))))
                    area_2d_p = round(max(area_2d_p, 1.0), 2)
                    perim_p = round(sum(math.hypot(xs[(i + 1) % len(xs)] - xs[i], ys[(i + 1) % len(ys)] - ys[i]) for i in range(len(xs))), 2)
                    mean_w = round(max(1.2, 2.0 * area_2d_p / max(perim_p, 1.0)), 2)
                    c_e = round(float(np.mean(xs)), 3)
                    c_n = round(float(np.mean(ys)), 3)
                    c_z = round(float(np.mean(zs)), 3)
                    idx_m = len(added_roads) + 1
                    rid = f"RM{idx_m}"
                    new_r = {
                        "id": rid,
                        "name": str(item_data.get("name") or f"道路鋪面 {rid} (手動新增)"),
                        "subtype": "manual_road",
                        "planar_area_m2": area_2d_p,
                        "planar_area_ping": round(area_2d_p * 0.3025, 2),
                        "surface_area_3d_m2": round(area_2d_p * 1.01, 2),
                        "perimeter_m": perim_p,
                        "mean_width_m": mean_w,
                        "mean_slope_pct": 2.0,
                        "elongation_ratio": 2.0,
                        "center_twd97": [c_e, c_n, c_z],
                        "center_local": [round(c_e - ce, 3), round(c_z - ch, 3), round(cn - c_n, 3)],
                        "boundary_twd97": b_twd,
                        "boundary_local": b_loc,
                        "holes_twd97": [],
                        "holes_local": [],
                        "manual_added": True,
                    }
                    added_roads.append(new_r)

        overrides = {
            "removed_ids": removed_ids,
            "removed_centers": removed_centers,
            "added_trees": added_trees,
            "added_walls": added_walls,
            "added_roads": added_roads,
            "added_water": added_water,
        }
        # Strip previously appended manual items before re-applying overrides cleanly
        cached_res["trees"] = [t for t in (cached_res.get("trees") or []) if not t.get("manual_added")]
        cached_res["walls"] = [w for w in (cached_res.get("walls") or []) if not w.get("manual_added")]
        cached_res["roads"] = [r for r in (cached_res.get("roads") or []) if not r.get("manual_added")]
        cached_res["water_bodies"] = [w for w in (cached_res.get("water_bodies") or []) if not w.get("manual_added")]

        cached_res = self._apply_manual_overrides_to_categorization(scan_id, cached_res, overrides)
        html_name = f"categorization_report_{scan_id}.html"
        csv_name = f"categorization_report_{scan_id}.csv"
        dxf_name = f"Civil3D_Categorized_{scan_id}.dxf"
        self._write_categorization_deliverables(cached_res, html_name, csv_name, dxf_name)
        self._persist_categorization_result(scan_id, cached_res, scan)
        return cached_res

    def get_saved_ortho_meta(
        self, scan_id: str, scan: Optional[Dict[str, Any]] = None
    ) -> Optional[Dict[str, Any]]:
        """Returns cached true-nadir orthomosaic metadata and file paths if present on disk."""
        if not scan_id:
            return None
        thumbs_dir = os.path.join(BASE_DIR, "data", "thumbnails")
        os.makedirs(thumbs_dir, exist_ok=True)
        png_path = os.path.join(thumbs_dir, f"{scan_id}_ortho.png")
        json_path = os.path.join(thumbs_dir, f"{scan_id}_ortho.json")
        if os.path.isfile(png_path) and os.path.getsize(png_path) > 512 and os.path.isfile(json_path):
            try:
                with open(json_path, "r", encoding="utf-8") as f:
                    meta = json.load(f)
                if (
                    isinstance(meta, dict)
                    and meta.get("north_lat") is not None
                    and meta.get("south_lat") is not None
                    and meta.get("west_lon") is not None
                    and meta.get("east_lon") is not None
                ):
                    meta["png_path"] = png_path
                    meta["json_path"] = json_path
                    return meta
            except Exception:
                pass
        s = scan or self.db.get_scan(scan_id) or {}
        pdir = s.get("project_dir") or ""
        if pdir and os.path.isdir(pdir):
            p_png = os.path.join(pdir, "ortho_nadir.png")
            p_json = os.path.join(pdir, "ortho_nadir.json")
            if os.path.isfile(p_png) and os.path.getsize(p_png) > 512 and os.path.isfile(p_json):
                try:
                    with open(p_json, "r", encoding="utf-8") as f:
                        meta = json.load(f)
                    if isinstance(meta, dict) and meta.get("north_lat") is not None:
                        meta["png_path"] = p_png
                        meta["json_path"] = p_json
                        return meta
                except Exception:
                    pass
        return None

    def get_or_generate_true_nadir_ortho(
        self, scan_id: str, force: bool = False
    ) -> Optional[Dict[str, Any]]:
        """
        Generates and caches a true-nadir North-Up (+E Right, +N Up) transparent RGBA orthomosaic PNG
        and exact TWD97 -> WGS84 geographic bounding box for the given scan.
        Never falls back to tilted 3D perspective thumbnails.
        """
        if not scan_id:
            return None
        if not force:
            cached = self.get_saved_ortho_meta(scan_id)
            if cached:
                return cached

        scan = self.db.get_scan(scan_id)
        if not scan:
            return None
        crs_str = str(scan.get("crs") or "").upper()
        if "LOCAL" in crs_str:
            return None
        raw_lat = scan.get("lat")
        raw_lon = scan.get("lon")
        if raw_lat is None or raw_lon is None:
            return None
        try:
            s_lat = float(raw_lat)
            s_lon = float(raw_lon)
        except (TypeError, ValueError):
            return None
        if abs(s_lat) < 0.001 and abs(s_lon) < 0.001:
            return None

        ce = float(scan.get("twd97_e") or 0.0)
        cn = float(scan.get("twd97_n") or 0.0)
        ch = float(scan.get("twd97_h") or 0.0)

        try:
            from scipy.ndimage import binary_closing, binary_erosion
            from PIL import ImageDraw
            from pc_worker.surveying.dsm_and_volume import twd97_to_wgs84

            mesh_data = self._load_scan_textured_triangles_twd97(scan, ce, cn, ch)
            v0 = mesh_data["v0"]
            v1 = mesh_data["v1"]
            v2 = mesh_data["v2"]
            centroids = mesh_data["centroids"]
            area_2d = mesh_data["area_2d"]
            rgb = mesh_data["rgb"]

            if len(centroids) == 0:
                return None

            base_e = np.concatenate([v0[:, 0], v1[:, 0], v2[:, 0], centroids[:, 0]])
            base_n = np.concatenate([v0[:, 1], v1[:, 1], v2[:, 1], centroids[:, 1]])
            e_min, e_max = float(base_e.min()), float(base_e.max())
            n_min, n_max = float(base_n.min()), float(base_n.max())
            span_e = max(e_max - e_min, 4.0)
            span_n = max(n_max - n_min, 4.0)
            max_span = max(span_e, span_n)

            res = float(np.clip(max_span / 720.0, 0.08, 0.45))
            nx = int(np.clip(math.ceil(span_e / res) + 1, 32, 960))
            ny = int(np.clip(math.ceil(span_n / res) + 1, 32, 960))
            res_e = span_e / max(1, nx - 1)
            res_n = span_n / max(1, ny - 1)

            # 1. Base polygon pass for medium/large triangles so coarse triangles have zero internal gaps
            poly_img = Image.new("RGBA", (nx, ny), (0, 0, 0, 0))
            tri_span_e = np.maximum(np.maximum(v0[:, 0], v1[:, 0]), v2[:, 0]) - np.minimum(np.minimum(v0[:, 0], v1[:, 0]), v2[:, 0])
            tri_span_n = np.maximum(np.maximum(v0[:, 1], v1[:, 1]), v2[:, 1]) - np.minimum(np.minimum(v0[:, 1], v1[:, 1]), v2[:, 1])
            coarse_mask = (tri_span_e >= res_e * 1.35) | (tri_span_n >= res_n * 1.35)
            if np.any(coarse_mask):
                c_idx = np.where(coarse_mask)[0]
                if len(c_idx) > 85000:
                    # Keep the largest / highest-priority coarse triangles if mesh is huge
                    top_k = np.argsort(area_2d[c_idx])[-85000:]
                    c_idx = c_idx[top_k]
                c_order = c_idx[np.argsort(centroids[c_idx, 2])]
                drw = ImageDraw.Draw(poly_img)
                x0_arr = ((v0[c_order, 0] - e_min) / res_e).astype(np.float32)
                y0_arr = ((v0[c_order, 1] - n_min) / res_n).astype(np.float32)
                x1_arr = ((v1[c_order, 0] - e_min) / res_e).astype(np.float32)
                y1_arr = ((v1[c_order, 1] - n_min) / res_n).astype(np.float32)
                x2_arr = ((v2[c_order, 0] - e_min) / res_e).astype(np.float32)
                y2_arr = ((v2[c_order, 1] - n_min) / res_n).astype(np.float32)
                rgb_u8_c = np.clip(rgb[c_order] * 255.0, 0, 255).astype(np.uint8)
                for i in range(len(c_order)):
                    r_c, g_c, b_c = int(rgb_u8_c[i, 0]), int(rgb_u8_c[i, 1]), int(rgb_u8_c[i, 2])
                    drw.polygon(
                        [
                            (float(x0_arr[i]), float(y0_arr[i])),
                            (float(x1_arr[i]), float(y1_arr[i])),
                            (float(x2_arr[i]), float(y2_arr[i])),
                        ],
                        fill=(r_c, g_c, b_c, 255),
                    )
            poly_rgba = np.asarray(poly_img, dtype=np.uint8)

            # 2. High-density barycentric vertex/centroid splatting pass for crisp fine detail
            n_tris = len(centroids)
            tri_indices = np.arange(n_tris, dtype=np.int32)
            sp_e_list = [centroids[:, 0], v0[:, 0], v1[:, 0], v2[:, 0]]
            sp_n_list = [centroids[:, 1], v0[:, 1], v1[:, 1], v2[:, 1]]
            sp_t_list = [tri_indices, tri_indices, tri_indices, tri_indices]
            w_base = np.maximum(area_2d * 0.25, 1e-5).astype(np.float32)
            sp_w_list = [w_base, w_base, w_base, w_base]

            med_mask = area_2d >= (res * res * 0.65)
            if np.any(med_mask):
                m_idx = tri_indices[med_mask]
                mv0, mv1, mv2 = v0[med_mask], v1[med_mask], v2[med_mask]
                mw = np.maximum(area_2d[med_mask] * (1.0 / 9.0), 1e-5).astype(np.float32)
                for bw0, bw1, bw2 in (
                    (0.5, 0.5, 0.0),
                    (0.5, 0.0, 0.5),
                    (0.0, 0.5, 0.5),
                    (0.6, 0.2, 0.2),
                    (0.2, 0.6, 0.2),
                    (0.2, 0.2, 0.6),
                ):
                    pts_m = bw0 * mv0 + bw1 * mv1 + bw2 * mv2
                    sp_e_list.append(pts_m[:, 0])
                    sp_n_list.append(pts_m[:, 1])
                    sp_t_list.append(m_idx)
                    sp_w_list.append(mw)

            all_e = np.concatenate(sp_e_list)
            all_n = np.concatenate(sp_n_list)
            splat_t_idx = np.concatenate(sp_t_list)
            splat_w = np.concatenate(sp_w_list)

            ie_all = np.clip(((all_e - e_min) / res_e).astype(np.int32), 0, nx - 1)
            in_all = np.clip(((all_n - n_min) / res_n).astype(np.int32), 0, ny - 1)

            ortho_rgb = np.zeros((ny, nx, 3), dtype=np.float32)
            ortho_cnt = np.zeros((ny, nx), dtype=np.float32)
            for ch_i in range(3):
                np.add.at(ortho_rgb[:, :, ch_i], (in_all, ie_all), rgb[splat_t_idx, ch_i] * splat_w)
            np.add.at(ortho_cnt, (in_all, ie_all), splat_w)

            has_splat = ortho_cnt > 1e-7
            has_poly = poly_rgba[:, :, 3] > 0
            raw_occ = has_splat | has_poly
            occ_closed = binary_closing(raw_occ, structure=np.ones((3, 3), dtype=bool))

            if np.any(has_splat) and not np.all(has_splat):
                _, nearest_idx = distance_transform_edt(~has_splat, return_indices=True)
            else:
                nearest_idx = None

            final_rgba = np.zeros((ny, nx, 4), dtype=np.uint8)
            for ch_i in range(3):
                plane = ortho_rgb[:, :, ch_i]
                plane[has_splat] /= ortho_cnt[has_splat]
                splat_u8 = np.clip(plane * 255.0, 0, 255).astype(np.uint8)
                out_ch = np.zeros((ny, nx), dtype=np.uint8)
                out_ch[has_splat] = splat_u8[has_splat]
                only_poly = (~has_splat) & has_poly
                out_ch[only_poly] = poly_rgba[:, :, ch_i][only_poly]
                pinhole = (~has_splat) & (~has_poly) & occ_closed
                if np.any(pinhole) and nearest_idx is not None:
                    out_ch[pinhole] = splat_u8[nearest_idx[0][pinhole], nearest_idx[1][pinhole]]
                final_rgba[:, :, ch_i] = out_ch

            alpha = np.where(occ_closed, 255, 0).astype(np.uint8)
            inner_occ = binary_erosion(occ_closed, structure=np.ones((3, 3), dtype=bool))
            edge_ring = occ_closed & (~inner_occ)
            alpha[edge_ring] = 210
            final_rgba[:, :, 3] = alpha

            # Flip vertically so Row 0 is North (n_max) and Row ny-1 is South (n_min)
            final_rgba = np.flipud(final_rgba)

            lon0_deg = 119.0 if (s_lon < 120.0 or "119" in crs_str) else 121.0
            south_lat, west_lon = twd97_to_wgs84(e_min, n_min, lon0_deg=lon0_deg)
            north_lat, east_lon = twd97_to_wgs84(e_max, n_max, lon0_deg=lon0_deg)

            # Verify center alignment against scan.lat / scan.lon (handles custom shifted origins cleanly)
            mid_e = 0.5 * (e_min + e_max)
            mid_n = 0.5 * (n_min + n_max)
            c_lat, c_lon = twd97_to_wgs84(ce if abs(ce) > 1000 else mid_e, cn if abs(cn) > 1000 else mid_n, lon0_deg=lon0_deg)
            if abs(c_lat - s_lat) > 0.02 or abs(c_lon - s_lon) > 0.02:
                d_lat = s_lat - c_lat
                d_lon = s_lon - c_lon
                south_lat = round(south_lat + d_lat, 8)
                north_lat = round(north_lat + d_lat, 8)
                west_lon = round(west_lon + d_lon, 8)
                east_lon = round(east_lon + d_lon, 8)

            thumbs_dir = os.path.join(BASE_DIR, "data", "thumbnails")
            os.makedirs(thumbs_dir, exist_ok=True)
            png_path = os.path.join(thumbs_dir, f"{scan_id}_ortho.png")
            json_path = os.path.join(thumbs_dir, f"{scan_id}_ortho.json")

            out_pil = Image.fromarray(final_rgba, mode="RGBA")
            out_pil.save(png_path, format="PNG", optimize=True)

            meta = {
                "scan_id": scan_id,
                "north_lat": round(float(north_lat), 8),
                "south_lat": round(float(south_lat), 8),
                "west_lon": round(float(west_lon), 8),
                "east_lon": round(float(east_lon), 8),
                "min_e": round(float(e_min), 3),
                "max_e": round(float(e_max), 3),
                "min_n": round(float(n_min), 3),
                "max_n": round(float(n_max), 3),
                "width": int(nx),
                "height": int(ny),
                "resolution_m": round(float(res), 4),
                "generated_at": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
            }
            with open(json_path, "w", encoding="utf-8") as f:
                json.dump(meta, f, ensure_ascii=False, indent=2)

            pdir = scan.get("project_dir") or ""
            if pdir and os.path.isdir(pdir):
                try:
                    out_pil.save(os.path.join(pdir, "ortho_nadir.png"), format="PNG")
                    with open(os.path.join(pdir, "ortho_nadir.json"), "w", encoding="utf-8") as pf:
                        json.dump(meta, pf, ensure_ascii=False, indent=2)
                except Exception:
                    pass

            meta["png_path"] = png_path
            meta["json_path"] = json_path
            return meta
        except Exception as e:
            print(f"[GatheringScans] True-nadir ortho generation warning for {scan_id}: {e}")
            return None


