#!/usr/bin/env python3
"""
GC_ScanOptimizer Bridge for GatheringScans
Allows users on scans.gatheren.cloud to invoke real PC-side optimization actions in
c:\\Antigravity\\GC_ScanOptimizer:
1. Preset Compression ('quality', 'balanced', 'web', 'ultra_light') via TilesetOptimizer + gltfpack + PIL texture downscaling
2. Spatial 3D Polygon & Elevation Cropping ('keep_inside' / 'delete_inside') via SpatialCutter + trimesh/shapely
3. Coordinate Reference System Alignment to TWD97 (121) + TWVD2001
"""

import io
import os
import sys
import json
import time
import struct
from typing import Dict, Any, List

from pc_worker.config import (
    GC_SCAN_OPTIMIZER_DIR,
    PIX4DMATIC_TEXTURE_SIZE,
    TWD97_TWVD2001_SHORT,
)
from pc_worker.priority_queue import ScanQueueDB

if os.path.isdir(GC_SCAN_OPTIMIZER_DIR) and GC_SCAN_OPTIMIZER_DIR not in sys.path:
    sys.path.insert(0, GC_SCAN_OPTIMIZER_DIR)


def _downscale_glb_embedded_textures(glb_path: str, tex_limit: int = 2048, jpeg_quality: int = 78) -> int:
    """
    Downscales embedded JPEG/PNG images inside a .glb file (including EXT_meshopt_compression GLBs)
    so that max dimension <= tex_limit and re-encodes with optimized JPEG quality.
    Returns the final file size in bytes.
    """
    if not os.path.isfile(glb_path):
        return 0
    orig_size = os.path.getsize(glb_path)
    if orig_size < 32768:
        return orig_size
    try:
        from PIL import Image

        with open(glb_path, "rb") as f:
            raw = f.read()
        if raw[:4] != b"glTF":
            return orig_size
        magic, ver, _ = struct.unpack_from("<4sII", raw, 0)
        if ver != 2:
            return orig_size
        j_len, j_type = struct.unpack_from("<I4s", raw, 12)
        if j_type != b"JSON":
            return orig_size
        b_off = 20 + j_len
        if b_off + 8 > len(raw):
            return orig_size
        b_len, b_type = struct.unpack_from("<I4s", raw, b_off)
        if b_type != b"BIN\x00":
            return orig_size

        j = json.loads(raw[20 : 20 + j_len].decode("utf-8"))
        images = j.get("images") or []
        bvs = j.get("bufferViews") or []
        if not images or not bvs:
            return orig_size

        blob = raw[b_off + 8 : b_off + 8 + b_len]
        img_bv_indices = {img["bufferView"]: img for img in images if "bufferView" in img}
        if not img_bv_indices:
            return orig_size

        # Rebuild binary buffer(0) segments while updating byteOffsets
        # Collect all segments referencing buffer 0 (either directly or via EXT_meshopt_compression)
        segments = []
        for idx, bv in enumerate(bvs):
            ext_mc = (bv.get("extensions") or {}).get("EXT_meshopt_compression")
            if ext_mc and ext_mc.get("buffer", 0) == 0:
                segments.append(("meshopt", idx, int(ext_mc.get("byteOffset", 0)), int(ext_mc["byteLength"]), ext_mc))
            elif bv.get("buffer", 0) == 0 and not ext_mc:
                segments.append(("direct", idx, int(bv.get("byteOffset", 0)), int(bv["byteLength"]), bv))

        if not segments:
            return orig_size

        segments.sort(key=lambda x: x[2])
        new_bin = bytearray()
        modified_any = False

        for kind, bv_idx, old_off, old_len, target_dict in segments:
            chunk = blob[old_off : old_off + old_len]
            if kind == "direct" and bv_idx in img_bv_indices:
                img_obj = img_bv_indices[bv_idx]
                try:
                    im = Image.open(io.BytesIO(chunk))
                    if im.mode not in ("RGB", "L"):
                        im = im.convert("RGB")
                    if max(im.size) > tex_limit or len(chunk) > 250_000:
                        im.thumbnail((tex_limit, tex_limit), Image.Resampling.LANCZOS)
                        out_io = io.BytesIO()
                        im.save(out_io, format="JPEG", quality=jpeg_quality, optimize=True)
                        new_chunk = out_io.getvalue()
                        if len(new_chunk) < len(chunk):
                            chunk = new_chunk
                            img_obj["mimeType"] = "image/jpeg"
                            modified_any = True
                except Exception:
                    pass

            while len(new_bin) % 4 != 0:
                new_bin.append(0)
            new_off = len(new_bin)
            new_bin.extend(chunk)
            target_dict["byteOffset"] = new_off
            target_dict["byteLength"] = len(chunk)

        if not modified_any:
            return orig_size

        while len(new_bin) % 4 != 0:
            new_bin.append(0)
        if j.get("buffers"):
            j["buffers"][0]["byteLength"] = len(new_bin)

        new_j = json.dumps(j, separators=(",", ":")).encode("utf-8")
        while len(new_j) % 4 != 0:
            new_j += b" "

        total_len = 12 + 8 + len(new_j) + 8 + len(new_bin)
        out_glb = bytearray()
        out_glb.extend(struct.pack("<4sII", b"glTF", 2, total_len))
        out_glb.extend(struct.pack("<I4s", len(new_j), b"JSON"))
        out_glb.extend(new_j)
        out_glb.extend(struct.pack("<I4s", len(new_bin), b"BIN\x00"))
        out_glb.extend(new_bin)

        with open(glb_path, "wb") as wf:
            wf.write(out_glb)
        return len(out_glb)
    except Exception:
        return orig_size


class OptimizerBridge:
    def __init__(self, db: ScanQueueDB):
        self.db = db
        self.exports_dir = os.path.join(GC_SCAN_OPTIMIZER_DIR, "exports")
        os.makedirs(self.exports_dir, exist_ok=True)

    def get_presets(self) -> Dict[str, Any]:
        try:
            from optimizer.presets import PRESETS
            return PRESETS
        except Exception:
            return {
                "quality": {
                    "label": "High Fidelity (2K KTX2)",
                    "target_triangle_ratio": 0.75,
                    "texture_limit": 2048,
                    "description": "Preserves fine structural details with 2K BasisU textures.",
                },
                "balanced": {
                    "label": "Balanced Web Stream (Default)",
                    "target_triangle_ratio": 0.50,
                    "texture_limit": 2048,
                    "description": "Optimal balance of fast web streaming and crisp 2K textures.",
                },
                "web": {
                    "label": "Fast Mobile / Field Tablet",
                    "target_triangle_ratio": 0.35,
                    "texture_limit": 1024,
                    "description": "High frame-rate streaming for 4G/5G field devices.",
                },
                "ultra_light": {
                    "label": "Ultra-Light Browser Offline Cache",
                    "target_triangle_ratio": 0.20,
                    "texture_limit": 1024,
                    "description": "Compact footprint ideal for client-side browser offline caching.",
                },
            }

    def run_optimize_action(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        Invokes the real GC_ScanOptimizer TilesetOptimizer on the selected scan's 3D Tileset.
        Performs real gltfpack mesh decimation, attribute quantization, and embedded texture resizing.
        """
        scan_id = payload.get("scan_id", "quchi_20261005_merged")
        preset_name = str(payload.get("preset", "balanced")).lower().strip()
        preset_key = "ultra" if preset_name == "ultra_light" else preset_name
        if preset_key not in ("quality", "balanced", "web", "ultra"):
            preset_key = "balanced"

        scan = self.db.get_scan(scan_id)
        if not scan:
            raise ValueError(f"Scan not found: {scan_id}")

        ts_path = scan.get("tileset_path") or ""
        if not ts_path or not os.path.exists(ts_path):
            raise FileNotFoundError(f"Tileset path not found on PC: {ts_path}")

        t0 = time.time()
        out_folder_name = payload.get("output_name") or f"{scan_id}_{preset_name}_opt"
        out_dir = os.path.join(self.exports_dir, out_folder_name)
        os.makedirs(out_dir, exist_ok=True)

        in_dir = os.path.dirname(ts_path) if os.path.isfile(ts_path) else ts_path
        if not os.path.isdir(in_dir):
            raise FileNotFoundError(f"Input tileset directory not found: {in_dir}")

        from optimizer.tileset_optimizer import TilesetOptimizer

        opt = TilesetOptimizer(
            input_dir=in_dir,
            output_dir=out_dir,
            preset_name=preset_key,
            resume=False,
        )
        stats = opt.run()

        tex_limit_map = {"quality": 2048, "balanced": 1536, "web": 1024, "ultra": 768}
        jpeg_qual_map = {"quality": 85, "balanced": 76, "web": 68, "ultra": 58}
        target_tex = tex_limit_map.get(preset_key, 1536)
        target_qual = jpeg_qual_map.get(preset_key, 75)

        comp_bytes = 0
        for r, _, files in os.walk(out_dir):
            for fn in files:
                fp = os.path.join(r, fn)
                if fn.lower().endswith(".glb"):
                    comp_bytes += _downscale_glb_embedded_textures(fp, tex_limit=target_tex, jpeg_quality=target_qual)
                else:
                    comp_bytes += os.path.getsize(fp)

        orig_bytes = int(stats.get("original_bytes") or scan.get("size_bytes") or 1)
        saved_bytes = max(0, orig_bytes - comp_bytes)
        reduction_pct = round((saved_bytes / max(1, orig_bytes)) * 100.0, 1)
        duration_s = round(time.time() - t0, 2)

        if payload.get("apply_to_scan", True) and os.path.isdir(out_dir) and os.path.isdir(in_dir):
            try:
                import shutil
                for r_root, _, r_files in os.walk(out_dir):
                    rel_r = os.path.relpath(r_root, out_dir)
                    dst_r = in_dir if rel_r == "." else os.path.join(in_dir, rel_r)
                    os.makedirs(dst_r, exist_ok=True)
                    for fn in r_files:
                        shutil.copy2(os.path.join(r_root, fn), os.path.join(dst_r, fn))
                scan_upd = dict(scan)
                scan_upd["size_bytes"] = max(comp_bytes, 1024)
                scan_upd["texture_resolution"] = target_tex
                self.db.upsert_scan(scan_upd)
            except Exception as e:
                print(f"[OptimizerBridge] Warning applying optimized tiles to scan {scan_id}: {e}")

        return {
            "status": "ok",
            "action": "optimize",
            "scan_id": scan_id,
            "scan_name": scan.get("name"),
            "preset": preset_name,
            "texture_limit": target_tex,
            "crs": TWD97_TWVD2001_SHORT,
            "output_dir": out_dir,
            "tiles_processed": int(stats.get("tiles_processed", 0)),
            "original_mb": round(orig_bytes / (1024 * 1024), 2),
            "compressed_mb": round(comp_bytes / (1024 * 1024), 2),
            "saved_mb": round(saved_bytes / (1024 * 1024), 2),
            "reduction_pct": reduction_pct,
            "duration_s": duration_s,
        }

    def run_crop_action(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        Invokes the real GC_ScanOptimizer SpatialCutter (3D polygon + Z-elevation crop) on the PC.
        Slices actual .glb/.obj meshes using trimesh + shapely and writes out the cropped 3D Tileset.
        """
        scan_id = payload.get("scan_id", "quchi_20261005_merged")
        raw_polygon = payload.get("polygon", [])
        min_elev = float(payload.get("min_elev", -9999.0))
        max_elev = float(payload.get("max_elev", 9999.0))
        mode = str(payload.get("mode", "keep_inside")).lower().strip()
        if mode not in ("keep_inside", "delete_inside"):
            mode = "keep_inside"

        if len(raw_polygon) < 3:
            raise ValueError("Polygon crop requires at least 3 vertices.")

        scan = self.db.get_scan(scan_id)
        if not scan:
            raise ValueError(f"Scan not found: {scan_id}")

        ts_path = scan.get("tileset_path") or ""
        if not ts_path or not os.path.exists(ts_path):
            raise FileNotFoundError(f"Tileset path not found on PC: {ts_path}")

        in_dir = os.path.dirname(ts_path) if os.path.isfile(ts_path) else ts_path

        # Inspect root boundingVolume in tileset.json to map user polygon into the tileset's native XY coordinate frame
        ts_cx, ts_cy, ts_cz = 0.0, 0.0, 0.0
        if os.path.isfile(ts_path) and ts_path.lower().endswith(".json"):
            try:
                with open(ts_path, "r", encoding="utf-8") as f:
                    ts_data = json.load(f)
                box = ((ts_data.get("root") or {}).get("boundingVolume") or {}).get("box")
                if isinstance(box, list) and len(box) >= 3:
                    ts_cx, ts_cy, ts_cz = float(box[0]), float(box[1]), float(box[2])
            except Exception:
                pass

        scan_e = float(scan.get("twd97_e") or 304952.656)
        scan_n = float(scan.get("twd97_n") or 2757084.875)
        scan_h = float(scan.get("twd97_h") or 43.18)

        native_poly: List[List[float]] = []
        twd_poly: List[List[float]] = []
        for pt in raw_polygon:
            px, py = float(pt[0]), float(pt[1])
            if abs(px) > 10000.0 and abs(py) > 100000.0:
                # Input is TWD97 (E, N)
                dx = px - scan_e
                dn = py - scan_n
                twd_poly.append([px, py])
            else:
                # Input is local offset (dx, dn) relative to scan center
                dx = px
                dn = py
                twd_poly.append([scan_e + dx, scan_n + dn])
            native_poly.append([ts_cx + dx, ts_cy + dn])

        # Adjust elevation range to tileset native Z frame if needed
        if abs(ts_cz - scan_h) > 15.0 and min_elev > -1000.0 and max_elev < 1000.0:
            native_min_z = ts_cz + (min_elev - scan_h)
            native_max_z = ts_cz + (max_elev - scan_h)
        else:
            native_min_z = min_elev
            native_max_z = max_elev

        t0 = time.time()
        out_name = payload.get("output_name") or f"{scan_id}_crop_{int(t0)}"
        out_dir = os.path.join(self.exports_dir, out_name)
        os.makedirs(out_dir, exist_ok=True)

        from cutter.spatial_cutter import SpatialCutter

        cutter = SpatialCutter(
            input_tileset_dir=in_dir,
            output_tileset_dir=out_dir,
            polygon_coords=native_poly,
            min_elev=native_min_z,
            max_elev=native_max_z,
            up_axis="z",
            compress_output=True,
            mode=mode,
        )
        # Our tilesets store Z-up coordinates directly inside the GLB vertices
        cutter.gltf_y_to_z = False
        stats = cutter.run()

        # Compute polygon area in m^2
        area_m2 = 0.0
        n = len(twd_poly)
        for i in range(n):
            x1, y1 = twd_poly[i][0], twd_poly[i][1]
            x2, y2 = twd_poly[(i + 1) % n][0], twd_poly[(i + 1) % n][1]
            area_m2 += x1 * y2 - x2 * y1
        area_m2 = round(abs(area_m2) * 0.5, 2)

        if payload.get("apply_to_scan", True) and os.path.isdir(out_dir) and os.path.isdir(in_dir):
            try:
                import shutil
                for r_root, _, r_files in os.walk(out_dir):
                    rel_r = os.path.relpath(r_root, out_dir)
                    dst_r = in_dir if rel_r == "." else os.path.join(in_dir, rel_r)
                    os.makedirs(dst_r, exist_ok=True)
                    for fn in r_files:
                        shutil.copy2(os.path.join(r_root, fn), os.path.join(dst_r, fn))
                proj_dir = scan.get("project_dir") or os.path.dirname(in_dir)
                for cache_fn in ("_dsm_cache_v3.npz", "_dsm_cache_v4.npz"):
                    cp = os.path.join(proj_dir, cache_fn)
                    if os.path.isfile(cp):
                        try:
                            os.remove(cp)
                        except OSError:
                            pass
                scan_upd = dict(scan)
                if mode == "keep_inside" and area_m2 > 0:
                    scan_upd["covered_area_m2"] = area_m2
                if int(stats.get("output_size_bytes", 0)) > 0:
                    scan_upd["size_bytes"] = int(stats["output_size_bytes"])
                self.db.upsert_scan(scan_upd)
            except Exception as e:
                print(f"[OptimizerBridge] Warning applying cropped tiles to scan {scan_id}: {e}")

        return {
            "status": "ok",
            "action": "spatial_crop",
            "scan_id": scan_id,
            "scan_name": scan.get("name"),
            "mode": mode,
            "vertex_count": len(native_poly),
            "cropped_area_m2": area_m2,
            "z_range_m": [round(min_elev, 2), round(max_elev, 2)],
            "tiles_sliced": int(stats.get("tiles_sliced", 0)),
            "tiles_retained": int(stats.get("tiles_fully_retained", 0)),
            "tiles_pruned": int(stats.get("tiles_pruned", 0)),
            "output_mb": round(float(stats.get("output_size_bytes", 0)) / (1024 * 1024), 2),
            "crs": TWD97_TWVD2001_SHORT,
            "output_dir": out_dir,
            "output_tileset_path": stats.get("output_tileset_path", os.path.join(out_dir, "tileset.json")),
            "duration_s": round(float(stats.get("duration_s") or (time.time() - t0)), 2),
        }

    def run_merge_scans_action(self, payload: Dict[str, Any], surveying_engine: Any = None) -> Dict[str, Any]:
        """
        Merges 2 to 8 aligned scans (each with user-adjusted 3D Gizmo translation and rotation
        and locked orientation) into a single unified georeferenced 3D Scan in C:\\GatheringScans.
        Produces:
          - Unified exports/obj_mesh/mesh.obj + mesh.mtl + 4K texture atlas mesh_0.jpg + offset.xyz
          - Unified tileset/tileset.json + tileset/tiles/root.glb + preview_tileset.json + thumbnail.png
          - Full SQLite scan record + scan_meta.json compatible with Optimizer, Spatial Crop, Volume,
            Contours, Cross-Section Profile, and CAD/PDF exports.
        """
        import re
        import math
        import shutil
        import subprocess
        import numpy as np
        from datetime import datetime
        from PIL import Image
        from pc_worker.config import LOCAL_SCANS_ROOT
        from pc_worker.gdrive_watcher import twd97_to_wgs84
        from pc_worker.preview_generator import (
            GLTFPACK_EXE,
            _downscale_glb_textures,
            shift_glb_node_translation,
            ensure_scan_low_quality_preview,
            ensure_scan_full_quality_thumbnail,
        )

        t0 = time.time()
        layers = payload.get("layers") or payload.get("scans") or []
        if not isinstance(layers, list) or len(layers) < 2:
            raise ValueError("Merging requires at least 2 scan layers in the alignment workspace.")

        unlocked = [str(ly.get("scan_id") or f"Layer #{idx+1}") for idx, ly in enumerate(layers) if not ly.get("locked", False)]
        if unlocked:
            raise ValueError(
                f"All scan orientations must be locked before merging. Unlocked: {', '.join(unlocked)}"
            )

        resolved_layers: List[Tuple[Dict[str, Any], Dict[str, Any]]] = []
        for ly in layers:
            sid = str(ly.get("scan_id") or "").strip()
            sc = self.db.get_scan(sid)
            if not sc:
                raise ValueError(f"Scan not found in catalog: {sid}")
            resolved_layers.append((ly, sc))

        primary_ly, primary_scan = resolved_layers[0]
        raw_name = str(payload.get("new_scan_name") or payload.get("name") or "").strip()
        if not raw_name:
            base_n = str(primary_scan.get("name") or primary_scan["scan_id"]).strip()
            raw_name = f"{base_n}_Unified_{len(resolved_layers)}Scans"

        proj_group = str(payload.get("project_group") or primary_scan.get("project_group") or "QuChi Dam").strip()
        proj_zh = str(payload.get("project_name_zh") or primary_scan.get("project_name_zh") or f"{proj_group} 工程掃描群組").strip()

        clean_slug = re.sub(r"[^a-z0-9_]+", "_", raw_name.lower()).strip("_")[:48]
        if not clean_slug:
            clean_slug = f"unified_{int(t0)}"
        new_scan_id = f"merged_{clean_slug}_{int(t0) % 100000}"
        out_proj_dir = os.path.join(LOCAL_SCANS_ROOT, new_scan_id)
        obj_out_dir = os.path.join(out_proj_dir, "exports", "obj_mesh")
        tiles_out_dir = os.path.join(out_proj_dir, "tileset", "tiles")
        os.makedirs(obj_out_dir, exist_ok=True)
        os.makedirs(tiles_out_dir, exist_ok=True)

        # Write initial scan_meta.json and processing DB entry immediately so background filesystem
        # discovery never creates a conflicting scan_id or auto-tiles before gltfpack finishes.
        init_meta = {
            "scan_id": new_scan_id,
            "name": raw_name,
            "user_edited_name": 1,
            "project_group": proj_group,
            "project_name_zh": proj_zh,
            "project_dir": out_proj_dir,
            "status": "processing",
            "progress_pct": 10.0,
            "stage_label": f"Merging {len(resolved_layers)} Aligned Scans...",
        }
        try:
            with open(os.path.join(out_proj_dir, "scan_meta.json"), "w", encoding="utf-8") as imf:
                json.dump(init_meta, imf, indent=2, ensure_ascii=False)
            self.db.upsert_scan({**primary_scan, **init_meta})
        except Exception:
            pass

        # Reference Z-up center (TWD97 Easting, Northing, TWVD2001 Elevation)
        ref_c = payload.get("ref_center_zup")
        if isinstance(ref_c, list) and len(ref_c) >= 3:
            c_ref = np.array([float(ref_c[0]), float(ref_c[1]), float(ref_c[2])], dtype=np.float64)
        else:
            c_ref = np.array(
                [
                    float(primary_scan.get("twd97_e") or 304952.656),
                    float(primary_scan.get("twd97_n") or 2757084.875),
                    float(primary_scan.get("twd97_h") or 43.18),
                ],
                dtype=np.float64,
            )

        merged_offset = np.round(c_ref, 0)
        ox_m, oy_m, oz_m = float(merged_offset[0]), float(merged_offset[1]), float(merged_offset[2])

        # Change-of-basis matrices between Three.js Y-up (X=East, Y=Up, Z=South) and TWD97 Z-up (X=East, Y=North, Z=Up)
        # zUpGroup in Three.js rotates -90 deg on X: (x_zup, y_zup, z_zup) -> (x_zup, z_zup, -y_zup)
        r_x_neg90 = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]], dtype=np.float64)
        r_x_pos90 = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, -1.0], [0.0, 1.0, 0.0]], dtype=np.float64)

        def _quat_to_mat3(qx: float, qy: float, qz: float, qw: float) -> np.ndarray:
            n = math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw)
            if n < 1e-12:
                return np.eye(3, dtype=np.float64)
            qx, qy, qz, qw = qx / n, qy / n, qz / n, qw / n
            xx, yy, zz = qx * qx, qy * qy, qz * qz
            xy, xz, yz = qx * qy, qx * qz, qy * qz
            wx, wy, wz = qw * qx, qw * qy, qw * qz
            return np.array(
                [
                    [1.0 - 2.0 * (yy + zz), 2.0 * (xy - wz), 2.0 * (xz + wy)],
                    [2.0 * (xy + wz), 1.0 - 2.0 * (xx + zz), 2.0 * (yz - wx)],
                    [2.0 * (xz - wy), 2.0 * (yz + wx), 1.0 - 2.0 * (xx + yy)],
                ],
                dtype=np.float64,
            )

        num_scans = len(resolved_layers)
        grid_g = max(1, int(math.ceil(math.sqrt(num_scans))))
        atlas_dim = 4096
        cell_px = atlas_dim // grid_g
        atlas_img = Image.new("RGB", (atlas_dim, atlas_dim), (128, 128, 128))

        all_v: List[np.ndarray] = []
        all_vt: List[np.ndarray] = []
        all_f: List[np.ndarray] = []
        v_offset = 0
        vt_offset = 0
        total_images = 0
        merged_from_meta: List[Dict[str, Any]] = []

        for idx, (ly, sc) in enumerate(resolved_layers):
            sid = sc["scan_id"]
            total_images += int(sc.get("image_count") or 0)
            col = idx % grid_g
            row_uv = idx // grid_g
            row_pil = grid_g - 1 - row_uv

            # Locate .obj path (or convert primary .glb tile if needed)
            obj_p = surveying_engine._resolve_scan_obj_path(sc) if surveying_engine else sc.get("obj_path")
            if not (obj_p and os.path.isfile(obj_p)):
                cand_obj = os.path.join(sc.get("project_dir") or "", "exports", "obj_mesh", "mesh.obj")
                if os.path.isfile(cand_obj):
                    obj_p = cand_obj

            v_arr = None
            vt_arr = None
            f_arr = None
            tex_im = None

            if obj_p and os.path.isfile(obj_p):
                obj_dir = os.path.dirname(obj_p)
                for jpg_cand in ("mesh_0.jpg", "texture.jpg", "mesh.jpg", "mesh_0.png"):
                    jp = os.path.join(obj_dir, jpg_cand)
                    if os.path.isfile(jp):
                        try:
                            tex_im = Image.open(jp).convert("RGB")
                            break
                        except Exception:
                            pass
                if tex_im is None:
                    import glob as _glob
                    jpgs = _glob.glob(os.path.join(obj_dir, "*.jpg")) + _glob.glob(os.path.join(obj_dir, "*.png"))
                    if jpgs:
                        try:
                            tex_im = Image.open(jpgs[0]).convert("RGB")
                        except Exception:
                            pass

                with open(obj_p, "r", encoding="utf-8", errors="ignore") as f_in:
                    lines = f_in.read().splitlines()
                v_lines = [ln[2:] for ln in lines if ln.startswith("v ")]
                vt_lines = [ln[3:] for ln in lines if ln.startswith("vt ")]
                f_lines = [ln[2:] for ln in lines if ln.startswith("f ")]

                if v_lines and f_lines:
                    v_arr = np.fromstring(" ".join(v_lines), sep=" ", dtype=np.float64).reshape(-1, 3)
                    if vt_lines:
                        vt_arr = np.fromstring(" ".join(vt_lines), sep=" ", dtype=np.float64).reshape(-1, 2)
                    else:
                        vt_arr = np.zeros((len(v_arr), 2), dtype=np.float64)

                    sample_f = f_lines[0].strip().split()[0]
                    slash_cnt = sample_f.count("/")
                    if slash_cnt == 1:
                        f_arr = np.fromstring(" ".join(f_lines).replace("/", " "), sep=" ", dtype=np.int64).reshape(-1, 6)
                    elif slash_cnt >= 2:
                        raw_f = np.fromstring(" ".join(f_lines).replace("//", "/0/").replace("/", " "), sep=" ", dtype=np.int64).reshape(-1, 9)
                        f_arr = raw_f[:, [0, 1, 3, 4, 6, 7]]
                    else:
                        raw_f = np.fromstring(" ".join(f_lines), sep=" ", dtype=np.int64).reshape(-1, 3)
                        f_arr = np.column_stack([raw_f[:, 0], raw_f[:, 0], raw_f[:, 1], raw_f[:, 1], raw_f[:, 2], raw_f[:, 2]])

            if v_arr is None or f_arr is None:
                # Fallback: load from root.glb via trimesh
                import trimesh
                ts_p = sc.get("tileset_path") or ""
                r_glb = os.path.join(os.path.dirname(ts_p), "tiles", "root.glb") if ts_p else ""
                if not os.path.isfile(r_glb):
                    raise FileNotFoundError(f"Could not resolve 3D mesh (.obj or root.glb) for scan: {sid}")
                tm = trimesh.load(r_glb, force="mesh", process=False)
                v_arr = np.asarray(tm.vertices, dtype=np.float64)
                f_idx = np.asarray(tm.faces, dtype=np.int64) + 1
                if hasattr(tm.visual, "uv") and tm.visual.uv is not None and len(tm.visual.uv) == len(v_arr):
                    vt_arr = np.asarray(tm.visual.uv, dtype=np.float64)
                else:
                    vt_arr = np.zeros((len(v_arr), 2), dtype=np.float64)
                f_arr = np.column_stack([f_idx[:, 0], f_idx[:, 0], f_idx[:, 1], f_idx[:, 1], f_idx[:, 2], f_idx[:, 2]])
                if hasattr(tm.visual, "material") and getattr(tm.visual.material, "image", None) is not None:
                    tex_im = tm.visual.material.image.convert("RGB")

            if tex_im is not None:
                tile_im = tex_im.resize((cell_px, cell_px), Image.Resampling.LANCZOS)
                atlas_img.paste(tile_im, (col * cell_px, row_pil * cell_px))

            # Center scan i's vertices at its own bounding box midpoint (matching Three.js tr.group.position = -C_i)
            v_mid = (v_arr.min(axis=0) + v_arr.max(axis=0)) * 0.5
            v_centered = v_arr - v_mid

            # Extract Three.js translation & rotation (quaternion or Euler XYZ in degrees) from alignment layer
            pos_three = ly.get("position_three")
            if isinstance(pos_three, list) and len(pos_three) >= 3:
                tx, ty, tz = float(pos_three[0]), float(pos_three[1]), float(pos_three[2])
            else:
                tx = float(ly.get("tx") or 0.0)
                ty = float(ly.get("ty") or 0.0)
                tz = float(ly.get("tz") or 0.0)

            rx_deg = float(ly.get("rx_deg") or (ly.get("euler_deg_three") or [0.0, 0.0, 0.0])[0] or 0.0)
            ry_deg = float(ly.get("ry_deg") or (ly.get("euler_deg_three") or [0.0, 0.0, 0.0])[1] or 0.0)
            rz_deg = float(ly.get("rz_deg") or (ly.get("euler_deg_three") or [0.0, 0.0, 0.0])[2] or 0.0)

            quat_three = ly.get("quaternion_three")
            if isinstance(quat_three, list) and len(quat_three) >= 4:
                r_three = _quat_to_mat3(
                    float(quat_three[0]),
                    float(quat_three[1]),
                    float(quat_three[2]),
                    float(quat_three[3]),
                )
            else:
                # Intrinsic XYZ Euler matching THREE.Euler(rx, ry, rz, 'XYZ'): R = Rx * Ry * Rz
                rx_r = math.radians(rx_deg)
                ry_r = math.radians(ry_deg)
                rz_r = math.radians(rz_deg)
                cx, sx = math.cos(rx_r), math.sin(rx_r)
                cy, sy = math.cos(ry_r), math.sin(ry_r)
                cz, sz = math.cos(rz_r), math.sin(rz_r)
                r_x = np.array([[1.0, 0.0, 0.0], [0.0, cx, -sx], [0.0, sx, cx]], dtype=np.float64)
                r_y = np.array([[cy, 0.0, sy], [0.0, 1.0, 0.0], [-sy, 0.0, cy]], dtype=np.float64)
                r_z = np.array([[cz, -sz, 0.0], [sz, cz, 0.0], [0.0, 0.0, 1.0]], dtype=np.float64)
                r_three = r_x @ r_y @ r_z
                quat_three = [0.0, 0.0, 0.0, 1.0]

            r_zup = r_x_pos90 @ r_three @ r_x_neg90
            d_zup = np.array([tx, -tz, ty], dtype=np.float64)

            # Transform into unified TWD97 Z-up coordinates, then subtract merged_offset
            v_twd97 = c_ref + d_zup + (v_centered @ r_zup.T)
            v_local_merged = (v_twd97 - merged_offset).astype(np.float32)

            # Map UV into quadrant (col, row_uv) of the unified texture atlas
            vt_clipped = np.clip(vt_arr, 0.0, 1.0).astype(np.float32)
            vt_mapped = np.empty_like(vt_clipped)
            vt_mapped[:, 0] = (float(col) + vt_clipped[:, 0]) / float(grid_g)
            vt_mapped[:, 1] = (float(row_uv) + vt_clipped[:, 1]) / float(grid_g)

            f_shifted = f_arr.copy()
            f_shifted[:, [0, 2, 4]] += v_offset
            f_shifted[:, [1, 3, 5]] += vt_offset

            all_v.append(v_local_merged)
            all_vt.append(vt_mapped)
            all_f.append(f_shifted)
            v_offset += len(v_local_merged)
            vt_offset += len(vt_mapped)

            merged_from_meta.append(
                {
                    "scan_id": sid,
                    "name": sc.get("name") or sid,
                    "position_three": [round(tx, 4), round(ty, 4), round(tz, 4)],
                    "quaternion_three": [round(float(x), 6) for x in quat_three[:4]],
                    "euler_deg_three": [round(rx_deg, 2), round(ry_deg, 2), round(rz_deg, 2)],
                }
            )

        v_merged = np.vstack(all_v)
        vt_merged = np.vstack(all_vt)
        f_merged = np.vstack(all_f)

        # Save unified texture atlas, .mtl, offset.xyz, and .obj
        atlas_path = os.path.join(obj_out_dir, "mesh_0.jpg")
        atlas_img.save(atlas_path, format="JPEG", quality=88, optimize=True)

        mtl_path = os.path.join(obj_out_dir, "mesh.mtl")
        with open(mtl_path, "w", encoding="utf-8") as mf:
            mf.write("newmtl mesh_0\nKd 1.000000 1.000000 1.000000\nillum 0\nmap_Kd mesh_0.jpg\n")

        off_path = os.path.join(obj_out_dir, "offset.xyz")
        with open(off_path, "w", encoding="utf-8") as of:
            of.write(f"{ox_m:.3f} {oy_m:.3f} {oz_m:.3f}\n")

        obj_out_path = os.path.join(obj_out_dir, "mesh.obj")
        with open(obj_out_path, "wb") as obj_f:
            obj_f.write(b"mtllib mesh.mtl\nusemtl mesh_0\n")
            np.savetxt(obj_f, v_merged, fmt="v %.4f %.4f %.4f")
            np.savetxt(obj_f, vt_merged, fmt="vt %.5f %.5f")
            np.savetxt(obj_f, f_merged, fmt="f %d/%d %d/%d %d/%d")

        # Build fast 3D Tileset (tileset/tiles/root.glb + tileset/tileset.json) via gltfpack
        total_faces = len(f_merged)
        root_glb_path = os.path.join(tiles_out_dir, "root.glb")
        ratio_full = min(1.0, max(0.08, 360000.0 / float(max(total_faces, 1))))
        tmp_root = root_glb_path + ".tmp.glb"
        subprocess.run(
            [
                GLTFPACK_EXE,
                "-i",
                obj_out_path,
                "-o",
                tmp_root,
                "-si",
                f"{ratio_full:.4f}",
                "-slb",
                "-sv",
                "-vp",
                "14",
                "-vt",
                "12",
                "-cc",
            ],
            capture_output=True,
            timeout=180,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000) if os.name == "nt" else 0,
        )
        if os.path.isfile(tmp_root) and os.path.getsize(tmp_root) > 1024:
            with open(tmp_root, "rb") as tf:
                raw_r = tf.read()
            os.remove(tmp_root)
            opt_r = _downscale_glb_textures(raw_r, max_dim=PIX4DMATIC_TEXTURE_SIZE, jpeg_quality=88)
            shifted_r = shift_glb_node_translation(opt_r, ox_m, oy_m, oz_m)
            with open(root_glb_path, "wb") as wf:
                wf.write(shifted_r)

        vmin_twd = v_merged.min(axis=0).astype(np.float64) + merged_offset
        vmax_twd = v_merged.max(axis=0).astype(np.float64) + merged_offset
        bc = (vmin_twd + vmax_twd) * 0.5
        bh = (vmax_twd - vmin_twd) * 0.5
        diag = float(np.linalg.norm(vmax_twd - vmin_twd))

        ts_dict = {
            "asset": {
                "version": "1.1",
                "generator": "GatheringCloud Multi-Scan Unifier v1.0",
                "gltfUpAxis": "Z",
            },
            "geometricError": round(max(1.0, diag / 16.0), 4),
            "root": {
                "boundingVolume": {
                    "box": [
                        round(float(bc[0]), 4),
                        round(float(bc[1]), 4),
                        round(float(bc[2]), 4),
                        round(max(float(bh[0]), 0.5), 4),
                        0.0,
                        0.0,
                        0.0,
                        round(max(float(bh[1]), 0.5), 4),
                        0.0,
                        0.0,
                        0.0,
                        round(max(float(bh[2]), 0.5), 4),
                    ]
                },
                "geometricError": 0.0,
                "refine": "REPLACE",
                "content": {"uri": "tiles/root.glb"},
                "children": [],
            },
        }
        ts_out_path = os.path.join(out_proj_dir, "tileset", "tileset.json")
        with open(ts_out_path, "w", encoding="utf-8") as tf_out:
            json.dump(ts_dict, tf_out, indent=2)
        with open(os.path.join(out_proj_dir, "tileset", "offset.xyz"), "w", encoding="utf-8") as off_ts:
            off_ts.write(f"{ox_m:.3f} {oy_m:.3f} {oz_m:.3f}\n")

        try:
            ensure_scan_low_quality_preview(ts_out_path, force=True)
            ensure_scan_full_quality_thumbnail(ts_out_path, new_scan_id, project_dir=out_proj_dir, force=True)
        except Exception as e:
            print(f"[OptimizerBridge] Warning generating preview/thumbnail for merged scan {new_scan_id}: {e}")

        # Compute 2D occupied footprint area in m^2 using 2m grid cells
        gx = np.floor(v_merged[:, 0] / 2.0).astype(np.int64)
        gy = np.floor(v_merged[:, 1] / 2.0).astype(np.int64)
        unique_cells = len(np.unique(gx * 1000003 + gy))
        covered_area_m2 = round(max(float(unique_cells) * 4.0, float(bh[0] * bh[1] * 2.2)), 1)

        lat_m, lon_m = twd97_to_wgs84(float(bc[0]), float(bc[1]))
        total_disk_bytes = 0
        for r_d, _, r_fs in os.walk(out_proj_dir):
            for fn in r_fs:
                try:
                    total_disk_bytes += os.path.getsize(os.path.join(r_d, fn))
                except OSError:
                    pass

        now_ts = time.time()
        scan_record = {
            "scan_id": new_scan_id,
            "name": raw_name,
            "user_edited_name": 1,
            "project_group": proj_group,
            "project_name_zh": proj_zh,
            "capture_date": datetime.now().strftime("%Y-%m-%d %H:%M"),
            "uploaded_at": now_ts,
            "uploader_email": str(payload.get("actor_email") or primary_scan.get("uploader_email") or "glibivanov@gatheren.com.tw"),
            "uploader_name": str(payload.get("actor_name") or primary_scan.get("uploader_name") or "雲在天"),
            "source_zip_path": "",
            "project_dir": out_proj_dir,
            "tileset_path": ts_out_path,
            "obj_path": obj_out_path,
            "cameras_dir": primary_scan.get("cameras_dir") or "",
            "image_count": max(total_images, 1),
            "size_bytes": max(total_disk_bytes, 1024),
            "covered_area_m2": covered_area_m2,
            "rtk_accuracy_cm": float(primary_scan.get("rtk_accuracy_cm") or 1.5),
            "crs": TWD97_TWVD2001_SHORT,
            "texture_resolution": PIX4DMATIC_TEXTURE_SIZE,
            "lat": lat_m,
            "lon": lon_m,
            "elev_m": round(float(bc[2]), 2),
            "twd97_e": round(float(bc[0]), 3),
            "twd97_n": round(float(bc[1]), 3),
            "twd97_h": round(float(bc[2]), 2),
            "bounding_box": {
                "center": [round(float(bc[0]), 3), round(float(bc[1]), 3), round(float(bc[2]), 2)],
                "half_extents": [round(float(bh[0]), 2), round(float(bh[1]), 2), round(float(bh[2]), 2)],
            },
            "status": "completed",
            "progress_pct": 100.0,
            "stage_label": f"Unified from {num_scans} Aligned Scans (TWD97 + TWVD2001, 4K)",
            "notes": f"Unified scan merged from {', '.join(m['scan_id'] for m in merged_from_meta)}",
            "merged_from": merged_from_meta,
        }

        meta_file = os.path.join(out_proj_dir, "scan_meta.json")
        with open(meta_file, "w", encoding="utf-8") as mf:
            json.dump(scan_record, mf, indent=2, ensure_ascii=False)

        saved_scan = self.db.upsert_scan(scan_record)
        duration_s = round(time.time() - t0, 2)
        out_mb = round(total_disk_bytes / (1024 * 1024), 2)

        return {
            "status": "ok",
            "action": "merge_scans",
            "scan_id": new_scan_id,
            "scan": saved_scan,
            "merged_count": num_scans,
            "total_vertices": int(len(v_merged)),
            "total_faces": int(len(f_merged)),
            "covered_area_m2": covered_area_m2,
            "output_mb": out_mb,
            "glb_size_mb": out_mb,
            "duration_s": duration_s,
        }
