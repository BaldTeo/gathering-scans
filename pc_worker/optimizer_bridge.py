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
