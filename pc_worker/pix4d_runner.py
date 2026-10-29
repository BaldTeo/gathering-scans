#!/usr/bin/env python3
"""
Automated Interface-Free PIX4Dmatic 2.11.0 GST Runner
Enforces:
- Mandatory Coordinate System: TWD97 (121) [EPSG:3826] + TWVD2001 [EPSG:8904, TWGEOID2018h]
- Configurable Texture Resolution & Pipeline Settings (data/pix4d_settings.json)
- Automated execution via PIX4Dmatic.exe --gst <script.gst> with real-time log tailing
  and QML error watchdog so it never hangs
- Chained web tileset generation via GC_ScanOptimizer QuadtreeTiler.
"""

import os
import re
import sys
import glob
import json
import time
import shutil
import zipfile
import threading
import subprocess
from typing import Dict, Any, Optional, Callable, List, Tuple

from pc_worker.config import (
    PIX4DMATIC_EXE,
    PIX4DMATIC_TEXTURE_SIZE,
    TWD97_TWVD2001_WKT,
    TWD97_TWVD2001_LABEL,
    LOCAL_SCANS_ROOT,
    GC_SCAN_OPTIMIZER_DIR,
    load_pix4d_settings,
    load_pix4d_settings_from_dict,
)

_PSUTIL_CACHE = {"ts": 0.0, "cpu": 0, "ram": 0, "label": ""}


def get_live_system_cpu_ram() -> Tuple[Optional[int], Optional[int], str]:
    """
    Returns (cpu_pct, ram_pct, formatted_label) directly from live OS hardware counters
    via psutil (matching Windows Task Manager), rather than stale PIX4Dmatic log headers.
    Caches samples for 1.5s so back-to-back calls within the same millisecond never
    produce a 0ms zero-delta reading.
    """
    now = time.time()
    if now - _PSUTIL_CACHE["ts"] < 1.5 and _PSUTIL_CACHE["label"]:
        return _PSUTIL_CACHE["cpu"], _PSUTIL_CACHE["ram"], _PSUTIL_CACHE["label"]
    try:
        import psutil
        cpu_val = int(round(psutil.cpu_percent(interval=0.12)))
        ram_val = int(round(psutil.virtual_memory().percent))
        lbl = f"{cpu_val}%CPU · {ram_val}%RAM"
        _PSUTIL_CACHE.update({"ts": now, "cpu": cpu_val, "ram": ram_val, "label": lbl})
        return cpu_val, ram_val, lbl
    except Exception:
        return None, None, ""


def parse_pix4dmatic_log_progress(log_path: str) -> Dict[str, Any]:
    """
    Reads the tail of a PIX4Dmatic project or app log file and extracts:
    - stage: human-readable current stage
    - cpu_ram: live OS CPU/RAM string (with log fallback)
    - progress_pct: float (10.0 .. 96.0)
    - is_finished: bool
    - has_fatal_error: bool
    - error_message: str
    - tail_lines: List[str]
    """
    out: Dict[str, Any] = {
        "log_path": log_path,
        "stage": "Initializing",
        "cpu_ram": "",
        "progress_pct": 10.0,
        "is_finished": False,
        "has_fatal_error": False,
        "error_message": "",
        "tail_lines": [],
    }
    if not log_path or not os.path.isfile(log_path):
        return out
    try:
        fsize = os.path.getsize(log_path)
        with open(log_path, "rb") as lf:
            if fsize > 24576:
                lf.seek(fsize - 24576)
            tail_text = lf.read().decode("utf-8", errors="replace")
        tail_lines = [ln.strip() for ln in tail_text.splitlines() if ln.strip()]
        out["tail_lines"] = tail_lines[-12:]

        if "Could not create runnable pipeline due to QML errors" in tail_text:
            out["has_fatal_error"] = True
            for ln in reversed(tail_lines):
                if "QML" in ln or "Cannot assign" in ln or "not a type" in ln or "Invalid property" in ln:
                    out["error_message"] = ln
                    break
            if not out["error_message"]:
                out["error_message"] = "PIX4Dmatic QML pipeline script error"

        for ln in tail_lines[-4:]:
            if "CloseSession" in ln or "[Export mesh to .obj] Finished" in ln or "[Processing] Finished" in ln:
                out["is_finished"] = True

        stage_name = ""
        log_cpu_ram = ""
        for ln in reversed(tail_lines):
            m = re.search(r"\[(\d+%CPU)\]\[(\d+%RAM)\]\[([^\]]+)\]", ln)
            if m:
                log_cpu_ram = f"{m.group(1)} · {m.group(2)}"
                stage_name = m.group(3).strip()
                break

        _, _, live_cpu_ram = get_live_system_cpu_ram()
        cpu_ram = live_cpu_ram or log_cpu_ram

        stage_pct_map = [
            ("Initializing", 5.0),
            ("Loading", 5.0),
            ("Import", 12.0),
            ("Keypoints", 14.0),
            ("Extract", 14.0),
            ("Sky mask", 16.0),
            ("Feature extraction", 18.0),
            ("Matching", 24.0),
            ("Match", 24.0),
            ("Pair matching", 28.0),
            ("Initial tracks creation", 33.0),
            ("Calibrating", 38.0),
            ("Calibrate", 38.0),
            ("Calibration", 38.0),
            ("Bundle", 38.0),
            ("Optimizing camera", 38.0),
            ("Georeferencing", 45.0),
            ("Control points", 45.0),
            ("Densifying", 58.0),
            ("Dense", 58.0),
            ("Depth map", 58.0),
            ("Densification", 58.0),
            ("Generate point cloud", 66.0),
            ("Point cloud", 66.0),
            ("Depth point cloud", 72.0),
            ("Finalize point cloud", 75.0),
            ("Generate fused point cloud", 79.0),
            ("Fusing", 79.0),
            ("Fuse", 79.0),
            ("Generate mesh", 84.0),
            ("Mesh", 84.0),
            ("Decimat", 84.0),
            ("Texture", 88.0),
            ("Texturing", 88.0),
            ("scalable mesh", 88.0),
            ("Finalize scalable mesh", 91.0),
            ("Generate tiles", 91.0),
            ("Tiles", 91.0),
            ("Cesium", 91.0),
            ("3D Tiles", 91.0),
            ("DSM", 93.0),
            ("Ortho", 95.0),
            ("Orthomosaic", 95.0),
            ("Export", 97.0),
            ("Quality report", 97.0),
            ("Saving", 97.0),
        ]
        est_pct = 12.0
        # Match against the active stage_name so an early "[Save project]" after Import never jumps progress to 97%
        if stage_name:
            stg_low = stage_name.lower()
            for k_stg, v_pct in stage_pct_map:
                if k_stg.lower() in stg_low:
                    est_pct = max(est_pct, v_pct)
            if "save project" in stg_low:
                if any(
                    k in tail_text
                    for k in ("Export mesh to .obj", "Export quality report", "Generate tiles", "Finalize scalable mesh")
                ):
                    est_pct = 97.0
                else:
                    est_pct = 14.0

        if "Scene [2/2]" in tail_text and 60.0 <= est_pct < 73.0:
            est_pct = max(est_pct, 69.0)
            if "colorizing" in tail_text.split("Scene [2/2]")[-1]:
                est_pct = max(est_pct, 73.0)
        elif "Scene [1/2]" in tail_text and 60.0 <= est_pct < 68.0:
            if "colorizing" in tail_text.split("Scene [1/2]")[-1]:
                est_pct = max(est_pct, 65.0)

        out["stage"] = stage_name or "Processing"
        out["cpu_ram"] = cpu_ram
        out["progress_pct"] = 96.0 if out["is_finished"] else est_pct
    except Exception:
        pass
    return out


def generate_pix4dmatic_gst_script(
    project_p4m_path: str,
    input_zip_or_folder: str,
    export_dir: str,
    texture_size: Optional[int] = None,
    srs_wkt: str = TWD97_TWVD2001_WKT,
    extracted_image_paths: Optional[list] = None,
    primary_opf_path: Optional[str] = None,
    part_image_groups: Optional[list] = None,
    pipeline_settings: Optional[Dict[str, Any]] = None,
    existing_project_only: bool = False,
) -> str:
    """
    Generates a verified PIX4Dmatic 2.11.0 .gst / .p4mpl QML automation script:
    - Default meshPipeline: MeshPipeline.FixedSize (compact file size, preserves trees when skyless=false)
    - Default skyless: false (Sky Mask disabled so surrounding trees & canopy are never trimmed away)
    - Default use_roi: false (excludes restrictive OPF RoiSet bounding box)
    - Default textureSize: 4096
    - Default modelSimplification: ModelSimplification.Conservative
    - Default deghosting: Deghosting.Weak
    - Default exportLod: 13
    """
    cfg = load_pix4d_settings()
    if isinstance(pipeline_settings, dict):
        cfg = load_pix4d_settings_from_dict({**cfg, **pipeline_settings})
    if texture_size is not None:
        cfg["texture_size"] = int(texture_size)

    mesh_pipeline = cfg["mesh_pipeline"]
    skyless = bool(cfg["skyless"])
    use_roi = bool(cfg["use_roi"])
    tex_size = int(cfg["texture_size"])
    dense_image_scale = str(cfg.get("dense_image_scale", "Full"))
    if dense_image_scale not in ("Full", "Half", "Quarter"):
        dense_image_scale = "Full"
    depth_min_confidence = str(cfg.get("depth_min_confidence", "Medium"))
    if depth_min_confidence not in ("High", "Medium", "Low"):
        depth_min_confidence = "Medium"
    try:
        depth_agreement_m = max(0.0005, min(0.5, float(cfg.get("depth_agreement_m", 0.01))))
    except Exception:
        depth_agreement_m = 0.01
    simplification = cfg["model_simplification"]
    deghosting = cfg["deghosting"]
    export_lod = int(cfg["export_lod"])
    skyless_str = "true" if skyless else "false"

    proj_folder_clean = os.path.dirname(project_p4m_path).replace("\\", "/")
    proj_name = os.path.splitext(os.path.basename(project_p4m_path))[0] or "p4m_project"
    exp_clean = export_dir.replace("\\", "/")
    report_pdf = f"{exp_clean}/quality_report.pdf"
    obj_mesh_folder = f"{exp_clean}/obj_mesh"

    mesh_roi_token = ",RoiSet{ }" if use_roi else ""
    sky_token = ",SkyMasks{ }" if skyless else ""

    import_blocks = []
    if not existing_project_only:
        set_crs_block = f"""        // Enforce TWD97 (121) [EPSG:3826] + TWVD2001 [EPSG:8904, TWGEOID2018h]
        SetGcpCrs {{
            settings.srsDefinition : '{srs_wkt}'
            inputs : [InputCameras{{ }},TiePointSet{{ }},RoiSet{{ }}]
            outputs : [InputCameras{{ }},TiePointSet{{ }},RoiSet{{ }}]
        }}"""

        if primary_opf_path:
            opf_clean = primary_opf_path.replace("\\", "/")
            import_blocks.append(
                f"""        // 1. Import Primary Pix4DCatch OPF Project
        ImportOpf {{
            path : "{opf_clean}"
            settings.colorizeTracks : true
            outputs : [InputCameras{{ }},CalibratedCameras{{ }},TiePointSet{{ }},FeaturesAndMatches{{ }},IntersectionTiePointSet{{ }},ConstraintSet{{ }},LineFeatures{{ }},Wireframe{{ }},SparsePointCloud{{ }},GaussianSplats{{ }},DensePointCloud{{ }},DepthPointCloud{{ }},FusedPointCloud{{ }},AsprsClasses{{ }},ComputedDepthMaps{{ }},RoiSet{{ }},SkyMasks{{ }},Dsm{{ }},Dtm{{ }},Ortho{{ }},VectorLayer{{ name: 'Polygons'; group: 'polygons'; }},VectorLayer{{ group: 'masks'; }}]
        }}"""
            )
            import_blocks.append(set_crs_block)
            if part_image_groups:
                for idx, grp in enumerate(part_image_groups):
                    if not grp:
                        continue
                    grp_literal = ",\n            ".join(f'"{p.replace(chr(92), "/")}"' for p in grp)
                    import_blocks.append(
                        f"""        // Import Part {idx + 2} Images + Depth + Confidence
        AddImagesFromPaths {{
            paths : [{grp_literal}]
            inputs : [InputCameras{{ }},TiePointSet{{ }},RoiSet{{ }}]
            outputs : [InputCameras{{ }},TiePointSet{{ }},RoiSet{{ }}]
        }}"""
                    )
        else:
            if part_image_groups:
                for idx, grp in enumerate(part_image_groups):
                    if not grp:
                        continue
                    grp_literal = ",\n            ".join(f'"{p.replace(chr(92), "/")}"' for p in grp)
                    import_blocks.append(
                        f"""        // Import Part {idx + 1} Images + Depth + Confidence
        AddImagesFromPaths {{
            paths : [{grp_literal}]
            inputs : [InputCameras{{ }},TiePointSet{{ }},RoiSet{{ }}]
            outputs : [InputCameras{{ }},TiePointSet{{ }},RoiSet{{ }}]
        }}"""
                    )
            else:
                if extracted_image_paths:
                    paths_literal = ",\n            ".join(f'"{p.replace(chr(92), "/")}"' for p in extracted_image_paths)
                else:
                    part_paths = [p.strip().replace("\\", "/") for p in input_zip_or_folder.split(";") if p.strip()]
                    if not part_paths:
                        part_paths = [input_zip_or_folder.replace("\\", "/")]
                    paths_literal = ",\n            ".join(f'"{p}"' for p in part_paths)
                import_blocks.append(
                    f"""        AddImagesFromPaths {{
            paths : [{paths_literal}]
            inputs : [InputCameras{{ }},TiePointSet{{ }},RoiSet{{ }}]
            outputs : [InputCameras{{ }},TiePointSet{{ }},RoiSet{{ }}]
        }}"""
                )
            import_blocks.append(set_crs_block)

    imports_joined = ("\n\n".join(import_blocks) + "\n\n        SaveProject { }\n") if import_blocks else ""

    sky_masks_step = ""
    if skyless:
        sky_masks_step = """            GenerateSkyMasks {
                resources.useGpu : GpuUsage.Yes
                inputs : [CalibratedCameras{ }]
                outputs : [SkyMasks{ }]
            }
"""

    calib_step = ""
    if not existing_project_only:
        calib_step = """            GenerateReconstruction {
                settings.calibPipeline : CalibPipeline.AccurateCameraExternalMeasurements
                settings.calibTemplate : CalibTemplate.CatchRTK
                settings.cameraExternalsConfidence : CameraExternalsConfidence.Auto
                settings.cameraInternalsOptimizationType : CameraInternalsOptimizationType.All
                settings.computeUncertainties : true
                settings.imageScale : ImageScale.Full
                settings.maxKeyPointCount : 20000
                settings.optimizeInternalsWithTiePoints : false
                settings.preprocessImagePairs : false
                settings.rematch : true
                settings.tryUseDepth : true
                settings.useAutomaticItps : false
                resources.tryReusePreviousResults : true
                resources.useGpu : GpuUsage.Yes
                inputs : [InputCameras{ },TiePointSet{ },ConstraintSet{ }]
                outputs : [InputCameras{ },CalibratedCameras{ },SparsePointCloud{ },FeaturesAndMatches{ },IntersectionTiePointSet{ },LineFeatures{ }]
            }
"""

    gst_content = f"""Session {{
    Project {{
        folder : "{proj_folder_clean}"
        name : "{proj_name}"

{imports_joined}        // Photogrammetry & Mesh Pipeline (PIX4Dmatic 2.11.0 CommandGraph)
        // Defaults: MeshPipeline.{mesh_pipeline}, skyless={skyless_str}, use_roi={str(use_roi).lower()}, textureSize={tex_size}, exportLod={export_lod}
        CommandGraph {{
{calib_step}{sky_masks_step}            GenerateGaPmvsDensePointCloud {{
                settings.sensorType : SensorType.Rgb
                settings.denoise : true
                settings.imageScale : ImageScale.{dense_image_scale}
                settings.maskAware : false
                settings.minNbrOfMatches : 3
                settings.multiScale : true
                settings.pointDensity : PointDensity.Optimal
                settings.skyless : {skyless_str}
                resources.useGpu : GpuUsage.Automatic
                inputs : [CalibratedCameras{{ }},SparsePointCloud{{ }}{sky_token}]
                outputs : [DensePointCloud{{ }}]
            }}
            GenerateDepthPointCloud {{
                settings.depthFilterAgreementThresholdMeters : {depth_agreement_m}
                settings.filter : true
                settings.minConfidenceLevel : ConfidenceLevel.{depth_min_confidence}
                settings.normalEstimationNeighborCount : 10
                inputs : [CalibratedCameras{{ }},SparsePointCloud{{ }}]
                outputs : [DepthPointCloud{{ }}]
            }}
            GenerateFusedPointCloud {{
                settings.distanceThresholdMeters : 0.025
                settings.nearestNeighboursCount : 128
                inputs : [DensePointCloud{{ }},DepthPointCloud{{ }}]
                outputs : [FusedPointCloud{{ }}]
            }}
            GenerateScalableMesh {{
                settings.deghosting : Deghosting.{deghosting}
                settings.generatePlanes : false
                settings.maskAware : false
                settings.meshPipeline : MeshPipeline.{mesh_pipeline}
                settings.meshProjectTemplate : MeshProjectTemplate.Catch
                settings.modelSimplification : ModelSimplification.{simplification}
                settings.polygonAware : false
                settings.skyless : {skyless_str}
                settings.textureSize : {tex_size}
                inputs : [FusedPointCloud{{ }}{sky_token}{mesh_roi_token}]
                outputs : [Mesh{{ }}]
            }}
            ExportQualityReport {{
                path : "{report_pdf}"
                settings.displayUnit : 'm'
                settings.reportExportFormat : ReportExportFormat.Pdf
                settings.temperatureUnit : TemperatureUnit.Celsius
                settings.thermalColorMap : ColorMap.Inferno
                inputs : [CalibratedCameras{{ }},SparsePointCloud{{ }},TiePointSet{{ }},IntersectionTiePointSet{{ }}{",GaussianSplats{ }" if primary_opf_path else ""},DensePointCloud{{ }},DepthPointCloud{{ }},FusedPointCloud{{ }},Mesh{{ }}]
            }}
            ExportMeshToObj {{
                folder : "{obj_mesh_folder}"
                settings.exportAsTiles : false
                settings.exportLod : {export_lod}
                settings.exportSrs : ExportSrs.Scene
                inputs : [Mesh{{ }}]
            }}
        }}
        SaveProject {{ }}
    }}
    CloseSession {{ }}
}}
"""
    return gst_content


def postprocess_obj_to_tileset(
    scan_id: str,
    proj_dir: str,
    obj_path: str,
    progress_callback: Optional[Callable[[float, str], None]] = None,
) -> str:
    """
    Ensures OBJ vertices are in local centered coordinates near (0,0,0) with 64-bit TWD97
    offset in offset.xyz so neither PIX4Dmatic, trimesh, nor gltfpack quantizes TWD97 coordinates
    (2,775,627m) in float32 (which causes 25cm steps). Then shifts generated .glb node.translation
    and tileset.json boundingVolume.box[0..2] by the 64-bit TWD97 offset.
    """
    if not obj_path or not os.path.isfile(obj_path):
        return ""
    obj_dir = os.path.dirname(obj_path)
    offset_xyz_path = os.path.join(obj_dir, "offset.xyz")
    ox, oy, oz = 0.0, 0.0, 0.0
    if os.path.isfile(offset_xyz_path):
        try:
            with open(offset_xyz_path, "r", encoding="utf-8", errors="ignore") as f_off:
                parts = f_off.read().strip().split()
                if len(parts) >= 3:
                    ox, oy, oz = float(parts[0]), float(parts[1]), float(parts[2])
        except Exception:
            pass

    try:
        from pc_worker.gdrive_watcher import utm51n_to_wgs84, wgs84_to_twd97
        first_v = None
        with open(obj_path, "r", encoding="utf-8", errors="ignore") as f_chk:
            for ln in f_chk:
                if ln.startswith("v "):
                    pts = ln.split()
                    first_v = (float(pts[1]), float(pts[2]), float(pts[3]))
                    break

        if first_v:
            # Case A: OBJ vertices themselves have large georeferenced coordinates (>10,000m)
            if abs(first_v[0]) > 10000.0 or abs(first_v[1]) > 10000.0:
                u0, v0, z0 = round(first_v[0]), round(first_v[1]), round(first_v[2])
                if 330000.0 < u0 < 450000.0 and 2400000.0 < v0 < 2900000.0:
                    e0, n0, _ = wgs84_to_twd97(*utm51n_to_wgs84(u0, v0))
                    ex, nx, _ = wgs84_to_twd97(*utm51n_to_wgs84(u0 + 100.0, v0))
                    ey, ny, _ = wgs84_to_twd97(*utm51n_to_wgs84(u0, v0 + 100.0))
                    j00, j01 = (ex - e0) / 100.0, (ey - e0) / 100.0
                    j10, j11 = (nx - n0) / 100.0, (ny - n0) / 100.0
                    ox, oy, oz = round(e0, 3), round(n0, 3), round(z0, 3)
                    out_lns = []
                    with open(obj_path, "r", encoding="utf-8", errors="ignore") as f_in:
                        for ln in f_in:
                            if ln.startswith("v "):
                                p = ln.split()
                                vx, vy, vz = float(p[1]), float(p[2]), float(p[3])
                                dx, dy, dz = vx - u0, vy - v0, vz - z0
                                out_lns.append(f"v {j00 * dx + j01 * dy:.4f} {j10 * dx + j11 * dy:.4f} {dz:.4f}\n")
                            else:
                                out_lns.append(ln)
                    with open(obj_path, "w", encoding="utf-8") as f_out:
                        f_out.writelines(out_lns)
                else:
                    ox, oy, oz = u0, v0, z0
                    out_lns = []
                    with open(obj_path, "r", encoding="utf-8", errors="ignore") as f_in:
                        for ln in f_in:
                            if ln.startswith("v "):
                                p = ln.split()
                                vx, vy, vz = float(p[1]), float(p[2]), float(p[3])
                                out_lns.append(f"v {vx - ox:.4f} {vy - oy:.4f} {vz - oz:.4f}\n")
                            else:
                                out_lns.append(ln)
                    with open(obj_path, "w", encoding="utf-8") as f_out:
                        f_out.writelines(out_lns)
                with open(offset_xyz_path, "w", encoding="utf-8") as f_off:
                    f_off.write(f"{ox:.3f} {oy:.3f} {oz:.3f}\n")
            # Case B: OBJ is already in local Scene coordinates, check if offset.xyz is UTM51N
            elif 330000.0 < ox < 450000.0 and 2400000.0 < oy < 2900000.0:
                u0, v0 = ox, oy
                e0, n0, _ = wgs84_to_twd97(*utm51n_to_wgs84(u0, v0))
                ex, nx, _ = wgs84_to_twd97(*utm51n_to_wgs84(u0 + 100.0, v0))
                ey, ny, _ = wgs84_to_twd97(*utm51n_to_wgs84(u0, v0 + 100.0))
                j00, j01 = (ex - e0) / 100.0, (ey - e0) / 100.0
                j10, j11 = (nx - n0) / 100.0, (ny - n0) / 100.0
                ox, oy = round(e0, 3), round(n0, 3)
                out_lns = []
                with open(obj_path, "r", encoding="utf-8", errors="ignore") as f_in:
                    for ln in f_in:
                        if ln.startswith("v "):
                            p = ln.split()
                            dx, dy, dz = float(p[1]), float(p[2]), float(p[3])
                            out_lns.append(f"v {j00 * dx + j01 * dy:.4f} {j10 * dx + j11 * dy:.4f} {dz:.4f}\n")
                        else:
                            out_lns.append(ln)
                with open(obj_path, "w", encoding="utf-8") as f_out:
                    f_out.writelines(out_lns)
                with open(offset_xyz_path, "w", encoding="utf-8") as f_off:
                    f_off.write(f"{ox:.3f} {oy:.3f} {oz:.3f}\n")
    except Exception as e:
        print(f"[PIX4DRunner] Warning checking/converting OBJ local coordinates & offset: {e}")

    # Safeguard B: Detect disconnected distant mesh islands (> 1,000m apart) in mesh.obj
    # and notify/ask the uploader via Google Chat Bot with interactive Yes (split) / No (combine) buttons.
    dominant_island_info = None
    try:
        island_check = _detect_obj_mesh_islands(obj_path, ox, oy, oz, min_dist_m=1000.0)
        if island_check:
            dominant_island_info = island_check["island_1"]
            decision_fp = os.path.join(proj_dir, "_mesh_island_decision.json")
            pending_fp = os.path.join(proj_dir, "_pending_island_decision.json")
            user_decision = ""
            if os.path.isfile(decision_fp):
                try:
                    with open(decision_fp, "r", encoding="utf-8") as df:
                        user_decision = str((json.load(df) or {}).get("decision") or "").strip().lower()
                except Exception:
                    pass

            if user_decision not in ("split", "combine"):
                import hashlib

                token = hashlib.sha256(f"{scan_id}:{proj_dir}:{int(time.time() // 86400)}".encode("utf-8")).hexdigest()[:16]
                pending_data = {
                    "scan_id": scan_id,
                    "proj_dir": proj_dir,
                    "obj_path": obj_path,
                    "ox": ox,
                    "oy": oy,
                    "oz": oz,
                    "distance_m": island_check["distance_m"],
                    "island_1": island_check["island_1"],
                    "island_2": island_check["island_2"],
                    "token": token,
                    "created_at": time.time(),
                }
                try:
                    with open(pending_fp, "w", encoding="utf-8") as pf:
                        json.dump(pending_data, pf, ensure_ascii=False, indent=2)
                    from pc_worker.config import DATA_DIR

                    pend_dir = os.path.join(DATA_DIR, "pending_island_decisions")
                    os.makedirs(pend_dir, exist_ok=True)
                    with open(os.path.join(pend_dir, f"{scan_id}.json"), "w", encoding="utf-8") as pf2:
                        json.dump(pending_data, pf2, ensure_ascii=False, indent=2)
                except Exception as pe:
                    print(f"[PIX4DRunner] Warning saving pending island decision for {scan_id}: {pe}")

                # Dispatch Google Chat interactive Yes/No question card tagging the uploader
                try:
                    from pc_worker.priority_queue import ScanQueueDB
                    from pc_worker.gchat_notifier import GoogleChatNotifier

                    db_tmp = ScanQueueDB()
                    sc_row = db_tmp.get_scan(scan_id) or {}
                    up_email = str(sc_row.get("uploader_email") or "glibivanov@gatheren.com.tw")
                    up_name = str(sc_row.get("uploader_name") or "雲在天")
                    notifier = GoogleChatNotifier(db_tmp)
                    notifier.notify_mesh_island_question(
                        scan_id=scan_id,
                        uploader_email=up_email,
                        uploader_name=up_name,
                        island_1=island_check["island_1"],
                        island_2=island_check["island_2"],
                        distance_m=island_check["distance_m"],
                        decision_token=token,
                    )
                    print(
                        f"[Safeguard B] Sent Google Chat Yes/No confirmation card for multi-island scan {scan_id} "
                        f"({island_check['distance_m']:.0f}m apart: {island_check['island_1']['site_name']} vs {island_check['island_2']['site_name']})."
                    )
                except Exception as ge:
                    print(f"[Safeguard B] Warning sending Google Chat island confirmation card: {ge}")

                # Wait briefly (up to 60s) in case the user clicks Yes/No immediately; otherwise proceed with
                # dominant-island centering so the scan is usable right away and can be split/combined when clicked.
                if progress_callback:
                    progress_callback(
                        95.5,
                        f"Waiting for Google Chat confirmation on 2 mesh islands ({island_check['distance_m']:.0f}m apart)...",
                    )
                for _ in range(30):
                    if os.path.isfile(decision_fp):
                        try:
                            with open(decision_fp, "r", encoding="utf-8") as df:
                                user_decision = str((json.load(df) or {}).get("decision") or "").strip().lower()
                            if user_decision in ("split", "combine"):
                                break
                        except Exception:
                            pass
                    time.sleep(2.0)

            if user_decision == "split":
                sec_site = re.sub(r"[^a-zA-Z0-9_]", "_", str(island_check["island_2"].get("project_group") or "Site2")).strip("_")
                split_scan_id = f"{scan_id}_{sec_site}"
                sec_proj_dir = os.path.join(LOCAL_SCANS_ROOT, split_scan_id)
                sec_obj_path = os.path.join(sec_proj_dir, "exports", "obj_mesh", "mesh.obj")
                _split_obj_into_two_island_files(obj_path, island_check, obj_path, sec_obj_path)
                dominant_island_info = None
                try:
                    postprocess_obj_to_tileset(split_scan_id, sec_proj_dir, sec_obj_path)
                except Exception as se:
                    print(f"[Safeguard B] Warning tiling secondary island scan {split_scan_id}: {se}")
    except Exception as ie:
        print(f"[PIX4DRunner] Safeguard B island check note: {ie}")

    # Ensure companion .mtl files specify Kd 1.000000 1.000000 1.000000 so trimesh and gltfpack never dim textures to 0.4
    try:
        for mtl_file in glob.glob(os.path.join(obj_dir, "*.mtl")):
            with open(mtl_file, "r", encoding="utf-8", errors="ignore") as mf:
                m_txt = mf.read()
            if "Kd " not in m_txt and "newmtl" in m_txt:
                m_txt = re.sub(r"(newmtl\s+\S+)", r"\1\nKd 1.000000 1.000000 1.000000", m_txt)
                if "Kd " not in m_txt:
                    m_txt += "\nKd 1.000000 1.000000 1.000000\n"
                with open(mtl_file, "w", encoding="utf-8") as mf:
                    mf.write(m_txt)
    except Exception as e:
        print(f"[PIX4DRunner] Warning updating MTL Kd factor: {e}")

    if progress_callback:
        progress_callback(96.0, "Building Hierarchical 3D Tileset in GC_ScanOptimizer...")
    if GC_SCAN_OPTIMIZER_DIR not in sys.path:
        sys.path.append(GC_SCAN_OPTIMIZER_DIR)
    from optimizer.quadtree_tiler import QuadtreeTiler

    active_cfg = load_pix4d_settings()
    active_tex_limit = min(4096, int(active_cfg.get("texture_size", PIX4DMATIC_TEXTURE_SIZE)))
    tileset_dir = os.path.join(proj_dir, "tileset")
    tiler = QuadtreeTiler(
        input_path=obj_path,
        output_dir=tileset_dir,
        max_levels=2,
        root_triangles=120000,
        root_texture_limit=2048,
        level1_triangles=90000,
        level1_texture_limit=2048,
        level2_triangles=250000,
        leaf_max_triangles=250000,
        texture_quality=8,
        texture_limit=active_tex_limit,
        high_compression=True,
        verbose=False,
    )
    tiler.run()
    ts_candidate = os.path.join(tileset_dir, "tileset.json")
    if os.path.isfile(ts_candidate):
        # Build high-precision (-vp 14 -vt 12) L0 overview root.glb (~180k tris, 2048px) via gltfpack
        try:
            from pc_worker.preview_generator import (
                GLTFPACK_EXE,
                _downscale_glb_textures,
                extract_glb_large_offset,
                shift_glb_node_translation,
                ensure_scan_low_quality_preview,
                ensure_scan_full_quality_thumbnail,
            )

            root_glb = os.path.join(tileset_dir, "tiles", "root.glb")
            if os.path.isfile(GLTFPACK_EXE) and (not os.path.isfile(root_glb) or os.path.getsize(root_glb) < 1024):
                face_count = 0
                with open(obj_path, "r", encoding="utf-8", errors="ignore") as f_obj:
                    for ln in f_obj:
                        if ln.startswith("f "):
                            face_count += 1
                os.makedirs(os.path.dirname(root_glb), exist_ok=True)
                ratio_full = min(1.0, max(0.08, 180000.0 / float(max(face_count, 1))))
                tmp_root = root_glb + ".tmp.glb"
                r_res = subprocess.run(
                    [
                        GLTFPACK_EXE,
                        "-i",
                        obj_path,
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
                if r_res.returncode == 0 and os.path.isfile(tmp_root) and os.path.getsize(tmp_root) > 1024:
                    with open(tmp_root, "rb") as tf:
                        raw_r = tf.read()
                    os.remove(tmp_root)
                    opt_r = _downscale_glb_textures(raw_r, max_dim=2048, jpeg_quality=86)
                    with open(root_glb, "wb") as wf:
                        wf.write(opt_r)

            # Apply 64-bit TWD97 offset (ox, oy, oz) to all generated .glb node.translation and tileset.json bounding boxes
            if abs(ox) > 1.0 or abs(oy) > 1.0 or abs(oz) > 0.001:
                for glb_fp in glob.glob(os.path.join(tileset_dir, "tiles", "*.glb")):
                    try:
                        with open(glb_fp, "rb") as gf:
                            g_bytes = gf.read()
                        cur_ox, cur_oy, _ = extract_glb_large_offset(g_bytes)
                        if abs(cur_ox) < 10000.0 and abs(cur_oy) < 10000.0:
                            shifted_bytes = shift_glb_node_translation(g_bytes, ox, oy, oz)
                            if shifted_bytes is not g_bytes:
                                with open(glb_fp, "wb") as gf:
                                    gf.write(shifted_bytes)
                    except Exception as ge:
                        print(f"[PIX4DRunner] Warning shifting GLB translation {glb_fp}: {ge}")

                try:
                    with open(ts_candidate, "r", encoding="utf-8") as tf_in:
                        ts_json = json.load(tf_in)

                    def _shift_ts_node_boxes(node: Dict[str, Any]) -> None:
                        bv = node.get("boundingVolume")
                        if isinstance(bv, dict) and isinstance(bv.get("box"), list) and len(bv["box"]) >= 3:
                            if abs(float(bv["box"][0])) < 10000.0 and abs(float(bv["box"][1])) < 10000.0:
                                bv["box"][0] = round(float(bv["box"][0]) + ox, 4)
                                bv["box"][1] = round(float(bv["box"][1]) + oy, 4)
                                bv["box"][2] = round(float(bv["box"][2]) + oz, 4)
                        for ch in node.get("children") or []:
                            if isinstance(ch, dict):
                                _shift_ts_node_boxes(ch)

                    if isinstance(ts_json.get("root"), dict):
                        _shift_ts_node_boxes(ts_json["root"])
                    if dominant_island_info:
                        ts_json.setdefault("extras", {})["dominantIslandCenter"] = [
                            round(float(dominant_island_info["twd97_x"]), 4),
                            round(float(dominant_island_info["twd97_y"]), 4),
                            round(float(dominant_island_info["twd97_z"]), 4),
                        ]
                    with open(ts_candidate, "w", encoding="utf-8") as tf_out:
                        json.dump(ts_json, tf_out, indent=2)
                    with open(os.path.join(tileset_dir, "offset.xyz"), "w", encoding="utf-8") as off_out:
                        off_out.write(f"{ox:.3f} {oy:.3f} {oz:.3f}\n")
                except Exception as te:
                    print(f"[PIX4DRunner] Warning shifting tileset.json boundingVolume: {te}")
        except Exception as e:
            print(f"[PIX4DRunner] Warning building direct gltfpack root.glb: {e}")

        # Save a pristine backup of the freshly generated tileset so mesh edits can always be undone/restored
        try:
            backup_dir = os.path.join(proj_dir, "tileset_backup")
            prev_dir = os.path.join(proj_dir, "tileset_prev")
            if os.path.isdir(prev_dir):
                shutil.rmtree(prev_dir, ignore_errors=True)
            if os.path.isdir(backup_dir):
                shutil.rmtree(backup_dir, ignore_errors=True)
            shutil.copytree(tileset_dir, backup_dir)
        except Exception as bk_err:
            print(f"[PIX4DRunner] Warning creating tileset_backup for {scan_id}: {bk_err}")

        # Remove any stale DSM caches so surveying_engine rebuilds DSM from the new mesh
        for dsm_cache in glob.glob(os.path.join(proj_dir, "_dsm_cache_*.npz")):
            try:
                os.remove(dsm_cache)
            except OSError:
                pass
        try:
            from pc_worker.preview_generator import (
                ensure_scan_low_quality_preview,
                ensure_scan_full_quality_thumbnail,
            )

            ensure_scan_low_quality_preview(ts_candidate, force=True)
            ensure_scan_full_quality_thumbnail(ts_candidate, scan_id, project_dir=proj_dir, force=True)
        except Exception as e:
            print(f"[PIX4DRunner] Warning generating preview/thumbnail for {ts_candidate}: {e}")
        try:
            from pc_worker.gdrive_cloud_sync import build_scan_3tz_package

            build_scan_3tz_package(
                {"scan_id": scan_id, "tileset_path": ts_candidate, "project_dir": proj_dir},
                force=True,
            )
        except Exception as e:
            print(f"[PIX4DRunner] Warning building .3tz cloud package for {scan_id}: {e}")
        return ts_candidate
    return ""


def _detect_obj_mesh_islands(
    obj_path: str,
    ox: float,
    oy: float,
    oz: float,
    min_dist_m: float = 1000.0,
) -> Optional[Dict[str, Any]]:
    """
    Safeguard B helper: Checks whether `obj_path` contains two or more disconnected spatial
    vertex islands separated by >= `min_dist_m` meters. Returns None for normal single-site scans.
    """
    import math

    if not obj_path or not os.path.isfile(obj_path):
        return None
    min_x, max_x = 1e18, -1e18
    min_y, max_y = 1e18, -1e18
    verts = []
    with open(obj_path, "r", encoding="utf-8", errors="ignore") as f:
        for ln in f:
            if ln.startswith("v "):
                parts = ln.split()
                if len(parts) >= 4:
                    vx, vy, vz = float(parts[1]), float(parts[2]), float(parts[3])
                    if vx < min_x:
                        min_x = vx
                    if vx > max_x:
                        max_x = vx
                    if vy < min_y:
                        min_y = vy
                    if vy > max_y:
                        max_y = vy
                    verts.append((vx, vy, vz))
    if len(verts) < 100:
        return None
    diag = math.hypot(max_x - min_x, max_y - min_y)
    if diag < min_dist_m:
        return None

    # 2-cluster k-means initialized at the two extremal vertices
    p_min = min(verts, key=lambda v: v[0] + v[1])
    p_max = max(verts, key=lambda v: v[0] + v[1])
    c1x, c1y = p_min[0], p_min[1]
    c2x, c2y = p_max[0], p_max[1]
    for _ in range(8):
        s1x = s1y = s1z = 0.0
        n1 = 0
        s2x = s2y = s2z = 0.0
        n2 = 0
        for vx, vy, vz in verts:
            d1 = (vx - c1x) ** 2 + (vy - c1y) ** 2
            d2 = (vx - c2x) ** 2 + (vy - c2y) ** 2
            if d1 <= d2:
                s1x += vx
                s1y += vy
                s1z += vz
                n1 += 1
            else:
                s2x += vx
                s2y += vy
                s2z += vz
                n2 += 1
        if n1 == 0 or n2 == 0:
            return None
        c1x, c1y, c1z = s1x / n1, s1y / n1, s1z / n1
        c2x, c2y, c2z = s2x / n2, s2y / n2, s2z / n2

    if min(n1, n2) < 50:
        return None
    centroid_dist = math.hypot(c1x - c2x, c1y - c2y)
    if centroid_dist < min_dist_m:
        return None

    # Verify there is a true empty gap along the axis connecting c1 -> c2
    ux = (c2x - c1x) / centroid_dist
    uy = (c2y - c1y) / centroid_dist
    max_proj_1 = -1e18
    min_proj_2 = 1e18
    for vx, vy, _ in verts:
        d1 = (vx - c1x) ** 2 + (vy - c1y) ** 2
        d2 = (vx - c2x) ** 2 + (vy - c2y) ** 2
        proj = (vx - c1x) * ux + (vy - c1y) * uy
        if d1 <= d2:
            if proj > max_proj_1:
                max_proj_1 = proj
        else:
            if proj < min_proj_2:
                min_proj_2 = proj
    gap_m = min_proj_2 - max_proj_1
    if gap_m < 400.0:
        return None

    # Ensure island_1 is the dominant island (more vertices)
    if n2 > n1:
        c1x, c1y, c1z, n1, c2x, c2y, c2z, n2 = c2x, c2y, c2z, n2, c1x, c1y, c1z, n1

    from pc_worker.gdrive_watcher import twd97_to_wgs84, match_project_group

    def _build_island_meta(cx: float, cy: float, cz: float, v_cnt: int) -> Dict[str, Any]:
        tx = round(ox + cx, 3)
        ty = round(oy + cy, 3)
        tz = round(oz + cz, 3)
        lat, lon = twd97_to_wgs84(tx, ty)
        pg, pzh = match_project_group(lat, lon)
        return {
            "local_x": round(cx, 3),
            "local_y": round(cy, 3),
            "local_z": round(cz, 3),
            "twd97_x": tx,
            "twd97_y": ty,
            "twd97_z": tz,
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "vertex_count": v_cnt,
            "project_group": pg,
            "site_name": f"{pzh} ({pg})" if pzh and pzh != pg else pg,
        }

    return {
        "distance_m": round(centroid_dist, 1),
        "gap_m": round(gap_m, 1),
        "ox": ox,
        "oy": oy,
        "oz": oz,
        "island_1": _build_island_meta(c1x, c1y, c1z, n1),
        "island_2": _build_island_meta(c2x, c2y, c2z, n2),
    }


def _split_obj_into_two_island_files(
    src_obj_path: str,
    island_info: Dict[str, Any],
    primary_out_obj: str,
    secondary_out_obj: str,
) -> Tuple[int, int]:
    """
    Splits a multi-island `mesh.obj` into two clean OBJ meshes:
    - `primary_out_obj` retains Island 1 vertices/faces in original `offset.xyz` coordinates.
    - `secondary_out_obj` receives Island 2 vertices/faces recentered around Island 2's centroid,
      with its own `offset.xyz`, `.mtl`, and textures copied to `os.path.dirname(secondary_out_obj)`.
    """
    bak_combined = src_obj_path + ".combined_islands.bak"
    if not os.path.isfile(bak_combined):
        shutil.copy2(src_obj_path, bak_combined)

    src_to_read = bak_combined if os.path.isfile(bak_combined) else src_obj_path
    c1x = float(island_info["island_1"]["local_x"])
    c1y = float(island_info["island_1"]["local_y"])
    c2x = float(island_info["island_2"]["local_x"])
    c2y = float(island_info["island_2"]["local_y"])
    c2z = float(island_info["island_2"]["local_z"])
    ox = float(island_info.get("ox", 0.0))
    oy = float(island_info.get("oy", 0.0))
    oz = float(island_info.get("oz", 0.0))

    v_cluster = [0]  # 1-based vertex cluster assignment (1 or 2)
    v_remap = [0]    # 1-based new vertex index within its cluster
    v1_lines = []
    v2_lines = []
    header_lines = []
    vt_vn_lines = []
    f1_lines = []
    f2_lines = []

    with open(src_to_read, "r", encoding="utf-8", errors="ignore") as f:
        for ln in f:
            if ln.startswith("v "):
                p = ln.split()
                vx, vy, vz = float(p[1]), float(p[2]), float(p[3])
                d1 = (vx - c1x) ** 2 + (vy - c1y) ** 2
                d2 = (vx - c2x) ** 2 + (vy - c2y) ** 2
                if d1 <= d2:
                    v_cluster.append(1)
                    v1_lines.append(ln)
                    v_remap.append(len(v1_lines))
                else:
                    v_cluster.append(2)
                    v2_lines.append(f"v {vx - c2x:.4f} {vy - c2y:.4f} {vz - c2z:.4f}\n")
                    v_remap.append(len(v2_lines))
            elif ln.startswith(("vt ", "vn ")):
                vt_vn_lines.append(ln)
            elif ln.startswith(("mtllib ", "o ", "g ")):
                header_lines.append(ln)
            elif ln.startswith("usemtl "):
                f1_lines.append(ln)
                f2_lines.append(ln)
            elif ln.startswith("f "):
                parts = ln.strip().split()[1:]
                c_ids = set()
                new_toks = []
                for tok in parts:
                    subs = tok.split("/")
                    vi = int(subs[0])
                    c_ids.add(v_cluster[vi])
                    subs[0] = str(v_remap[vi])
                    new_toks.append("/".join(subs))
                if c_ids == {1}:
                    f1_lines.append("f " + " ".join(new_toks) + "\n")
                elif c_ids == {2}:
                    f2_lines.append("f " + " ".join(new_toks) + "\n")

    os.makedirs(os.path.dirname(primary_out_obj), exist_ok=True)
    with open(primary_out_obj, "w", encoding="utf-8") as f1:
        f1.writelines(header_lines)
        f1.writelines(v1_lines)
        f1.writelines(vt_vn_lines)
        f1.writelines(f1_lines)

    sec_dir = os.path.dirname(secondary_out_obj)
    os.makedirs(sec_dir, exist_ok=True)
    with open(secondary_out_obj, "w", encoding="utf-8") as f2:
        f2.writelines(header_lines)
        f2.writelines(v2_lines)
        f2.writelines(vt_vn_lines)
        f2.writelines(f2_lines)

    # Write offset.xyz and copy .mtl + texture images for secondary_out_obj
    with open(os.path.join(sec_dir, "offset.xyz"), "w", encoding="utf-8") as f_off2:
        f_off2.write(f"{ox + c2x:.3f} {oy + c2y:.3f} {oz + c2z:.3f}\n")
    src_dir = os.path.dirname(src_obj_path)
    for fn in os.listdir(src_dir):
        if fn.lower().endswith((".mtl", ".jpg", ".jpeg", ".png")):
            shutil.copy2(os.path.join(src_dir, fn), os.path.join(sec_dir, fn))

    return len(v1_lines), len(v2_lines)


def apply_mesh_island_decision(scan_id: str, decision: str, token: str = "") -> Dict[str, Any]:
    """
    Executes the user's Google Chat button choice for Safeguard B:
    - `decision == "split"` (Yes): Splits the two mesh islands into 2 separate scans assigned to their sites.
    - `decision == "combine"` (No): Keeps 1 combined scan with two mesh islands and anchors the camera/site on Island 1.
    """
    from pc_worker.config import DATA_DIR
    from pc_worker.priority_queue import ScanQueueDB
    from pc_worker.gchat_notifier import GoogleChatNotifier
    from pc_worker.gdrive_watcher import seed_and_discover_scans

    clean_dec = (decision or "").strip().lower()
    if clean_dec in ("yes", "y", "true", "1", "separate", "split"):
        clean_dec = "split"
    elif clean_dec in ("no", "n", "false", "0", "same", "combine", "combined"):
        clean_dec = "combine"
    else:
        raise ValueError(f"Invalid decision '{decision}'. Expected 'split' (Yes) or 'combine' (No).")

    proj_dir = os.path.join(LOCAL_SCANS_ROOT, scan_id)
    pend_fp = os.path.join(proj_dir, "_pending_island_decision.json")
    alt_pend_fp = os.path.join(DATA_DIR, "pending_island_decisions", f"{scan_id}.json")
    pend_data: Dict[str, Any] = {}
    for fp in (pend_fp, alt_pend_fp):
        if os.path.isfile(fp):
            try:
                with open(fp, "r", encoding="utf-8") as f:
                    pend_data = json.load(f)
                break
            except Exception:
                pass

    if token and pend_data.get("token") and token != pend_data.get("token"):
        raise ValueError("Invalid confirmation token for mesh island decision.")

    if pend_data.get("proj_dir") and os.path.isdir(pend_data["proj_dir"]):
        proj_dir = pend_data["proj_dir"]
    os.makedirs(proj_dir, exist_ok=True)
    decision_fp = os.path.join(proj_dir, "_mesh_island_decision.json")
    with open(decision_fp, "w", encoding="utf-8") as df:
        json.dump(
            {"scan_id": scan_id, "decision": clean_dec, "decided_at": time.time()},
            df,
            ensure_ascii=False,
            indent=2,
        )

    obj_path = pend_data.get("obj_path") or os.path.join(proj_dir, "exports", "obj_mesh", "mesh.obj")
    bak_combined = obj_path + ".combined_islands.bak"
    if clean_dec == "combine" and os.path.isfile(bak_combined):
        shutil.copy2(bak_combined, obj_path)

    db = ScanQueueDB()
    sc_row = db.get_scan(scan_id) or {}
    up_email = str(sc_row.get("uploader_email") or "glibivanov@gatheren.com.tw")
    up_name = str(sc_row.get("uploader_name") or "雲在天")

    def _run_bg():
        try:
            if os.path.isfile(obj_path):
                postprocess_obj_to_tileset(scan_id, proj_dir, obj_path)
            seed_and_discover_scans(db)
            notifier = GoogleChatNotifier(db)
            if clean_dec == "split":
                s1 = (pend_data.get("island_1") or {}).get("site_name") or "工區 A"
                s2 = (pend_data.get("island_2") or {}).get("site_name") or "工區 B"
                sec_pg = re.sub(r"[^a-zA-Z0-9_]", "_", str((pend_data.get("island_2") or {}).get("project_group") or "Site2")).strip("_")
                split_id = f"{scan_id}_{sec_pg}"
                notifier.notify_island_decision_result(
                    scan_id=scan_id,
                    uploader_email=up_email,
                    uploader_name=up_name,
                    decision="split",
                    summary_text=f"已將 *{scan_id}* 拆分為 2 個獨立掃描：`{scan_id}`（{s1}）與 `{split_id}`（{s2}），並已完成各自的 3D 網格建置！",
                )
            else:
                s1 = (pend_data.get("island_1") or {}).get("site_name") or "主要工區"
                notifier.notify_island_decision_result(
                    scan_id=scan_id,
                    uploader_email=up_email,
                    uploader_name=up_name,
                    decision="combine",
                    summary_text=f"已將 *{scan_id}* 保留為 1 個合併掃描（含 2 個網格區塊），並將定位與預設視角錨定於主區塊（{s1}）！",
                )
        except Exception as e:
            print(f"[Safeguard B] Error executing island decision {clean_dec} for {scan_id}: {e}")

    threading.Thread(target=_run_bg, daemon=True).start()
    return {
        "status": "ok",
        "scan_id": scan_id,
        "decision": clean_dec,
        "message": (
            f"Decision '{clean_dec}' recorded for {scan_id}. Processing in background."
        ),
    }


def _filter_multi_subscan_geographic_outliers(
    scan_id: str,
    inputs_dir: str,
    extracted_files: List[str],
    primary_opf_path: Optional[str],
    part_image_groups: List[List[str]],
    max_cluster_dist_m: float = 1500.0,
) -> Tuple[List[str], Optional[str], List[List[str]]]:
    """
    Safeguard A: Inspects staged sub-scan folders inside `inputs_dir`. If any minority sub-scan
    is > `max_cluster_dist_m` (1,500 m) away from the dominant cluster, excludes its images from
    the merged PIX4Dmatic job, moves it into a standalone scan folder, and sends a Google Chat
    warning notification tagging the uploader.
    """
    import math

    if not os.path.isdir(inputs_dir):
        return extracted_files, primary_opf_path, part_image_groups
    subfolders = sorted(
        os.path.join(inputs_dir, d)
        for d in os.listdir(inputs_dir)
        if os.path.isdir(os.path.join(inputs_dir, d)) and not d.startswith(".")
    )
    if len(subfolders) <= 1:
        return extracted_files, primary_opf_path, part_image_groups

    from pc_worker.gdrive_watcher import extract_opf_zip_metadata, wgs84_to_twd97, match_project_group

    sub_infos = []
    for sdir in subfolders:
        meta = extract_opf_zip_metadata(sdir)
        lat = float(meta.get("lat") or 0.0)
        lon = float(meta.get("lon") or 0.0)
        img_cnt = max(1, int(meta.get("image_count") or 1))
        has_gps = abs(lat) > 0.1 and abs(lon) > 0.1 and not (abs(lat - 25.0330) < 1e-4 and abs(lon - 121.5654) < 1e-4)
        tx, ty, tz = wgs84_to_twd97(lat, lon) if has_gps else (0.0, 0.0, 0.0)
        pg, pzh = match_project_group(lat, lon) if has_gps else ("", "")
        sub_infos.append(
            {
                "sdir": sdir,
                "name": os.path.basename(sdir),
                "has_gps": has_gps,
                "lat": lat,
                "lon": lon,
                "tx": tx,
                "ty": ty,
                "img_cnt": img_cnt,
                "project_group": pg,
                "site_name": f"{pzh} ({pg})" if pzh and pzh != pg else pg,
                "uploader_email": meta.get("uploader_email") or "",
                "uploader_name": meta.get("uploader_name") or "",
            }
        )

    gps_subs = [s for s in sub_infos if s["has_gps"]]
    if len(gps_subs) <= 1:
        return extracted_files, primary_opf_path, part_image_groups

    # Pick dominant sub-scan anchor (largest image weight within max_cluster_dist_m)
    best_anchor = gps_subs[0]
    best_weight = -1
    for cand in gps_subs:
        w = sum(
            other["img_cnt"]
            for other in gps_subs
            if math.hypot(other["tx"] - cand["tx"], other["ty"] - cand["ty"]) <= max_cluster_dist_m
        )
        if w > best_weight:
            best_weight = w
            best_anchor = cand

    outliers = []
    kept = []
    for s in sub_infos:
        if not s["has_gps"]:
            kept.append(s)
            continue
        dist_m = math.hypot(s["tx"] - best_anchor["tx"], s["ty"] - best_anchor["ty"])
        s["distance_m"] = dist_m
        if dist_m > max_cluster_dist_m:
            outliers.append(s)
        else:
            kept.append(s)

    if not outliers or not kept:
        return extracted_files, primary_opf_path, part_image_groups

    primary_info = {
        "site_name": best_anchor["site_name"] or best_anchor["project_group"] or scan_id,
        "part_names": [k["name"] for k in kept],
    }

    for out_s in outliers:
        out_sdir = out_s["sdir"]
        out_name = out_s["name"]
        out_pg = re.sub(r"[^a-zA-Z0-9_]", "_", out_s["project_group"] or "Outlier").strip("_")
        split_scan_id = f"catch_{out_pg}_{re.sub(r'[^a-zA-Z0-9_]', '_', out_name).strip('_')}"
        split_proj_dir = os.path.join(LOCAL_SCANS_ROOT, split_scan_id)
        split_inputs_dir = os.path.join(split_proj_dir, "inputs", out_name)
        print(
            f"[Safeguard A] Excluding geographic outlier sub-scan '{out_name}' from {scan_id}: "
            f"{out_s['distance_m']:.0f}m away ({out_s['site_name']} vs {primary_info['site_name']}) -> {split_scan_id}"
        )
        try:
            os.makedirs(os.path.dirname(split_inputs_dir), exist_ok=True)
            if os.path.isdir(split_inputs_dir):
                shutil.rmtree(split_inputs_dir, ignore_errors=True)
            shutil.move(out_sdir, split_inputs_dir)
        except Exception as me:
            print(f"[Safeguard A] Warning moving outlier sub-scan {out_sdir}: {me}")

        # Notify uploader via Google Chat Bot
        try:
            from pc_worker.priority_queue import ScanQueueDB
            from pc_worker.gchat_notifier import GoogleChatNotifier

            db_tmp = ScanQueueDB()
            sc_row = db_tmp.get_scan(scan_id) or {}
            up_email = str(sc_row.get("uploader_email") or out_s.get("uploader_email") or "glibivanov@gatheren.com.tw")
            up_name = str(sc_row.get("uploader_name") or out_s.get("uploader_name") or "雲在天")
            notifier = GoogleChatNotifier(db_tmp)
            notifier.notify_subscan_outlier_warning(
                scan_id=scan_id,
                uploader_email=up_email,
                uploader_name=up_name,
                primary_info=primary_info,
                outlier_info={
                    "part_name": out_name,
                    "site_name": out_s["site_name"],
                    "distance_m": out_s["distance_m"],
                    "split_scan_id": split_scan_id,
                },
            )
        except Exception as ge:
            print(f"[Safeguard A] Warning sending Google Chat outlier notification: {ge}")

    # Rebuild extracted_files, primary_opf_path, and part_image_groups from the kept sub-scans
    new_extracted: List[str] = []
    new_primary_opf: Optional[str] = None
    new_groups: List[List[str]] = []
    for idx, k in enumerate(kept):
        sdir = k["sdir"]
        if not os.path.isdir(sdir):
            continue
        cand_opf = os.path.join(sdir, "project.opf")
        part_imgs = []
        for root, dirs, files in os.walk(sdir):
            dirs[:] = [d for d in dirs if d.lower() != "meshes"]
            for fn in sorted(files):
                if fn.lower().endswith((".jpg", ".jpeg", ".png", ".tiff", ".tif")):
                    full_img = os.path.join(root, fn)
                    new_extracted.append(full_img)
                    part_imgs.append(full_img)
        if new_primary_opf is None and os.path.isfile(cand_opf):
            new_primary_opf = cand_opf
        elif part_imgs:
            new_groups.append(part_imgs)

    return new_extracted, new_primary_opf, new_groups


def run_pix4dmatic_pipeline(
    scan_id: str,
    input_path: str,
    output_project_dir: Optional[str] = None,
    progress_callback: Optional[Callable[[float, str], None]] = None,
    dry_run: bool = False,
    custom_gst_path: Optional[str] = None,
    force_from_photos: bool = False,
    custom_settings: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Executes the automated PIX4Dmatic 2.11.0 workflow (acquiring cloud license seat 6fdbf93b,
    minimized window) with live log-file progress monitoring and QML error watchdog,
    then chains GC_ScanOptimizer QuadtreeTiler to produce the web 3D Tileset.
    Supports re-running from original photos (inputs/ or source_zip_path) with custom settings.
    """
    import zipfile
    import shutil

    proj_dir = output_project_dir or os.path.join(LOCAL_SCANS_ROOT, scan_id)
    export_dir = os.path.join(proj_dir, "exports")
    inputs_dir = os.path.join(proj_dir, "inputs")
    os.makedirs(export_dir, exist_ok=True)
    os.makedirs(inputs_dir, exist_ok=True)

    # Check if per-scan rerun_settings.json was queued by /api/scans/rerun or /api/queue/reprocess
    rerun_cfg_path = os.path.join(proj_dir, "rerun_settings.json")
    r_data: Dict[str, Any] = {}
    if os.path.isfile(rerun_cfg_path):
        try:
            with open(rerun_cfg_path, "r", encoding="utf-8") as rf:
                loaded_r = json.load(rf)
            if isinstance(loaded_r, dict):
                r_data = loaded_r
                if r_data.get("force_from_photos", True):
                    force_from_photos = True
                if isinstance(r_data.get("settings"), dict):
                    custom_settings = r_data["settings"]
        except Exception as e:
            print(f"[PIX4DRunner] Warning reading {rerun_cfg_path}: {e}")

    active_cfg = (
        load_pix4d_settings_from_dict(custom_settings)
        if isinstance(custom_settings, dict) and custom_settings
        else load_pix4d_settings()
    )
    active_tex_size = int(active_cfg.get("texture_size", PIX4DMATIC_TEXTURE_SIZE))

    # Persist used pix4d_settings into scan_meta.json for audit/inspection
    meta_fp = os.path.join(proj_dir, "scan_meta.json")
    if os.path.isfile(meta_fp) and not dry_run:
        try:
            with open(meta_fp, "r", encoding="utf-8") as mf:
                m_obj = json.load(mf)
            if isinstance(m_obj, dict):
                m_obj["pix4d_settings"] = active_cfg
                m_obj["texture_resolution"] = active_tex_size
                with open(meta_fp, "w", encoding="utf-8") as mf:
                    json.dump(m_obj, mf, ensure_ascii=False, indent=2)
        except Exception:
            pass

    p4m_path = os.path.join(proj_dir, f"{scan_id}.p4m")
    nested_proj_dir = os.path.join(proj_dir, scan_id)
    recon_dir = os.path.join(nested_proj_dir, "processing", "reconstructions")
    part_paths = [p.strip() for p in input_path.split(";") if p.strip() and os.path.exists(p.strip())]
    has_inputs_on_disk = bool(part_paths) or (
        os.path.isdir(inputs_dir)
        and any(
            fn.lower().endswith((".jpg", ".jpeg", ".png", ".tiff", ".tif", ".opf"))
            for _, _, files in os.walk(inputs_dir)
            for fn in files
        )
    )
    existing_project_only = (
        not force_from_photos
        and not has_inputs_on_disk
        and os.path.isdir(recon_dir)
        and bool(os.listdir(recon_dir))
    )

    if custom_gst_path and os.path.isfile(custom_gst_path):
        gst_path = custom_gst_path
    else:
        gst_path = os.path.join(proj_dir, f"{scan_id}_pipeline.gst")
        extracted_files: List[str] = []
        primary_opf_path = None
        part_image_groups: List[List[str]] = []

        if not dry_run and not existing_project_only:
            if os.path.isdir(nested_proj_dir):
                shutil.rmtree(nested_proj_dir, ignore_errors=True)
            if os.path.isfile(p4m_path):
                try:
                    os.remove(p4m_path)
                except OSError:
                    pass
            old_obj_dir = os.path.join(export_dir, "obj_mesh")
            prev_obj_dir = os.path.join(export_dir, "obj_mesh_prev")
            if os.path.isdir(old_obj_dir):
                if os.path.isdir(prev_obj_dir):
                    shutil.rmtree(prev_obj_dir, ignore_errors=True)
                try:
                    os.replace(old_obj_dir, prev_obj_dir)
                except Exception:
                    shutil.rmtree(old_obj_dir, ignore_errors=True)

            if part_paths:
                for idx, zpath in enumerate(part_paths):
                    if os.path.isfile(zpath) and zpath.lower().endswith(".zip"):
                        stem = os.path.splitext(os.path.basename(zpath))[0]
                        target_extract = os.path.join(inputs_dir, stem)
                        stage_marker = os.path.join(target_extract, ".staged_ok")
                        if not os.path.isfile(stage_marker):
                            if progress_callback:
                                progress_callback(
                                    6.0 + idx * 0.8,
                                    f"Extracting archive {idx + 1}/{len(part_paths)}: {os.path.basename(zpath)} to local SSD...",
                                )
                            os.makedirs(target_extract, exist_ok=True)
                            with zipfile.ZipFile(zpath, "r") as zf:
                                zf.extractall(target_extract)
                            # Remove un-georeferenced mobile preview meshes folder so it is never mistaken for exported mesh
                            preview_meshes_dir = os.path.join(target_extract, "meshes")
                            if os.path.isdir(preview_meshes_dir):
                                shutil.rmtree(preview_meshes_dir, ignore_errors=True)
                            try:
                                with open(stage_marker, "w", encoding="utf-8") as mf:
                                    mf.write(str(int(time.time())))
                            except Exception:
                                pass
                        cand_opf = os.path.join(target_extract, "project.opf")
                        part_imgs = []
                        for root, dirs, files in os.walk(target_extract):
                            dirs[:] = [d for d in dirs if d.lower() != "meshes"]
                            for fn in sorted(files):
                                if fn.lower().endswith((".jpg", ".jpeg", ".png", ".tiff", ".tif")):
                                    full_img = os.path.join(root, fn)
                                    extracted_files.append(full_img)
                                    part_imgs.append(full_img)
                        if idx == 0 and os.path.isfile(cand_opf):
                            primary_opf_path = cand_opf
                        elif part_imgs:
                            part_image_groups.append(part_imgs)
                    elif os.path.isdir(zpath):
                        stem = os.path.basename(zpath.rstrip("/\\"))
                        target_extract = os.path.join(inputs_dir, stem)
                        stage_marker = os.path.join(target_extract, ".staged_ok")
                        os.makedirs(target_extract, exist_ok=True)
                        # Remove any mobile preview meshes directory if previously copied
                        preview_meshes_dir = os.path.join(target_extract, "meshes")
                        if os.path.isdir(preview_meshes_dir):
                            shutil.rmtree(preview_meshes_dir, ignore_errors=True)

                        already_staged = False
                        if os.path.isfile(stage_marker):
                            staged_img_chk = any(
                                fn.lower().endswith((".jpg", ".jpeg", ".png", ".tiff", ".tif"))
                                for r_chk, d_chk, f_chk in os.walk(target_extract)
                                for fn in f_chk
                            )
                            if staged_img_chk:
                                already_staged = True

                        if not already_staged:
                            if progress_callback:
                                progress_callback(
                                    6.0 + idx * 0.8,
                                    f"Fast-staging folder {idx + 1}/{len(part_paths)} to local SSD: {stem}...",
                                )

                            alt_unredacted_dirs = glob.glob(os.path.join(r"G:\My Drive\Scans", "*", stem, "images")) + glob.glob(os.path.join(r"G:\My Drive\Scans", stem, "images"))
                            alt_src_dir = alt_unredacted_dirs[0] if alt_unredacted_dirs and os.path.isdir(alt_unredacted_dirs[0]) else ""

                            copy_tasks = []
                            for root, dirs, files in os.walk(zpath):
                                # Skip mobile preview meshes folder (unneeded by PIX4Dmatic and saves time)
                                dirs[:] = [d for d in dirs if d.lower() not in {"meshes", ".git", "__pycache__"}]
                                rel_dir = os.path.relpath(root, zpath)
                                dst_dir = target_extract if rel_dir == "." else os.path.join(target_extract, rel_dir)
                                os.makedirs(dst_dir, exist_ok=True)
                                for fn in files:
                                    if fn.startswith("."):
                                        continue
                                    copy_tasks.append((os.path.join(root, fn), os.path.join(dst_dir, fn), fn))

                            total_files = max(1, len(copy_tasks))
                            copied_cnt = 0
                            copy_lock = threading.Lock()

                            def _copy_one(task_tuple):
                                nonlocal copied_cnt
                                s_f, d_f, fn = task_tuple
                                try:
                                    if not os.path.isfile(d_f) or os.path.getsize(d_f) != os.path.getsize(s_f):
                                        shutil.copy2(s_f, d_f)
                                    if fn.lower().endswith((".jpg", ".jpeg")) and alt_src_dir:
                                        alt_f = os.path.join(alt_src_dir, fn)
                                        if os.path.isfile(alt_f):
                                            with open(d_f, "rb") as chk_f:
                                                hdr = chk_f.read(4096)
                                            if b"\x00\x00\x00\x00\x00\x00\x00\x00" in hdr[200:3500] and b"RTKLatitude" not in hdr:
                                                shutil.copy2(alt_f, d_f)
                                except Exception:
                                    pass
                                with copy_lock:
                                    copied_cnt += 1
                                    cur_c = copied_cnt
                                if progress_callback and (cur_c % 250 == 0 or cur_c == total_files):
                                    progress_callback(
                                        min(9.5, 6.0 + (cur_c / float(total_files)) * 3.5),
                                        f"Fast-staging {stem} to local SSD ({cur_c}/{total_files} files, 16x parallel)...",
                                    )

                            from concurrent.futures import ThreadPoolExecutor
                            with ThreadPoolExecutor(max_workers=16) as pool:
                                list(pool.map(_copy_one, copy_tasks))

                            try:
                                with open(stage_marker, "w", encoding="utf-8") as mf:
                                    mf.write(str(int(time.time())))
                            except Exception:
                                pass
                        else:
                            if progress_callback:
                                progress_callback(
                                    9.0,
                                    f"Using already-staged local SSD inputs for {stem}...",
                                )

                        cand_opf = os.path.join(target_extract, "project.opf")
                        part_imgs = []
                        for root, dirs, files in os.walk(target_extract):
                            dirs[:] = [d for d in dirs if d.lower() != "meshes"]
                            for fn in sorted(files):
                                if fn.lower().endswith((".jpg", ".jpeg", ".png", ".tiff", ".tif")):
                                    full_img = os.path.join(root, fn)
                                    extracted_files.append(full_img)
                                    part_imgs.append(full_img)
                        if idx == 0 and os.path.isfile(cand_opf):
                            primary_opf_path = cand_opf
                        elif part_imgs:
                            part_image_groups.append(part_imgs)
            elif os.path.isdir(inputs_dir):
                # Discover already-extracted part folders inside inputs_dir
                subfolders = sorted(
                    os.path.join(inputs_dir, d)
                    for d in os.listdir(inputs_dir)
                    if os.path.isdir(os.path.join(inputs_dir, d))
                )
                for idx, sdir in enumerate(subfolders):
                    cand_opf = os.path.join(sdir, "project.opf")
                    part_imgs = []
                    for root, _, files in os.walk(sdir):
                        for fn in sorted(files):
                            if fn.lower().endswith((".jpg", ".jpeg", ".png", ".tiff", ".tif")):
                                full_img = os.path.join(root, fn)
                                extracted_files.append(full_img)
                                part_imgs.append(full_img)
                    if idx == 0 and os.path.isfile(cand_opf):
                        primary_opf_path = cand_opf
                    elif part_imgs:
                        part_image_groups.append(part_imgs)

            if not existing_project_only:
                extracted_files, primary_opf_path, part_image_groups = _filter_multi_subscan_geographic_outliers(
                    scan_id=scan_id,
                    inputs_dir=inputs_dir,
                    extracted_files=extracted_files,
                    primary_opf_path=primary_opf_path,
                    part_image_groups=part_image_groups,
                )

        gst_code = generate_pix4dmatic_gst_script(
            project_p4m_path=p4m_path,
            input_zip_or_folder=input_path,
            export_dir=export_dir,
            texture_size=active_tex_size,
            srs_wkt=TWD97_TWVD2001_WKT,
            extracted_image_paths=extracted_files if extracted_files else None,
            primary_opf_path=primary_opf_path,
            part_image_groups=part_image_groups if part_image_groups else None,
            pipeline_settings=active_cfg,
            existing_project_only=existing_project_only,
        )
        with open(gst_path, "w", encoding="utf-8") as f:
            f.write(gst_code)

    if dry_run:
        return {
            "success": True,
            "dry_run": True,
            "gst_path": gst_path,
            "p4m_path": p4m_path,
            "export_dir": export_dir,
            "crs": TWD97_TWVD2001_LABEL,
            "texture_size": active_tex_size,
        }

    if "commentphoto" in scan_id.lower() or (not existing_project_only and not primary_opf_path and len(extracted_files) < 10):
        return {
            "success": False,
            "return_code": -2,
            "error": f"Skipped non-scan or insufficient image count ({len(extracted_files)} images) for {scan_id}",
            "gst_path": gst_path,
        }

    if progress_callback:
        progress_callback(10.0, f"Launching PIX4Dmatic 2.11.0 (CRS: TWD97 + TWVD2001, {active_tex_size}px)...")

    startupinfo = None
    creation_flags = 0
    if os.name == "nt":
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = 7  # SW_SHOWMINNOACTIVE
        creation_flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)

    cmd = [PIX4DMATIC_EXE, "--gst", gst_path]
    t0 = time.time()
    stdout_log_path = os.path.join(proj_dir, "pix4d_stdout.log")
    stdout_fh = open(stdout_log_path, "w", encoding="utf-8", errors="replace")
    proc = subprocess.Popen(
        cmd,
        stdout=stdout_fh,
        stderr=subprocess.STDOUT,
        startupinfo=startupinfo,
        creationflags=creation_flags,
    )
    if os.path.isfile(rerun_cfg_path) or r_data:
        try:
            r_state = dict(r_data) if isinstance(r_data, dict) else {}
            r_state.update(
                {
                    "scan_id": scan_id,
                    "force_from_photos": force_from_photos,
                    "settings": active_cfg,
                    "started_at": t0,
                    "pid": proc.pid,
                }
            )
            with open(rerun_cfg_path, "w", encoding="utf-8") as rf:
                json.dump(r_state, rf, ensure_ascii=False, indent=2)
        except Exception:
            pass

    appdata_log_dir = os.path.join(os.environ.get("APPDATA", ""), "pix4d", "PIX4Dmatic", "logs")
    proj_log_dirs = [
        os.path.join(proj_dir, scan_id, "logs"),
        os.path.join(proj_dir, "project", "logs"),
    ]
    if os.path.isdir( appdata_log_dir ):
        proj_log_dirs.append(appdata_log_dir)

    last_stage_msg = ""
    last_pct = 10.0
    fatal_err_msg = ""
    tail_lines: List[str] = []

    while proc.poll() is None:
        time.sleep(2.5)
        newest_log = ""
        newest_mtime = t0 - 5.0
        for ldir in proj_log_dirs:
            if not os.path.isdir(ldir):
                continue
            for lp in glob.glob(os.path.join(ldir, "*.txt")):
                try:
                    mt = os.path.getmtime(lp)
                    if mt >= newest_mtime:
                        newest_mtime = mt
                        newest_log = lp
                except OSError:
                    pass
        if newest_log:
            info = parse_pix4dmatic_log_progress(newest_log)
            tail_lines = info.get("tail_lines", [])
            if info.get("has_fatal_error"):
                fatal_err_msg = info.get("error_message") or "PIX4Dmatic QML pipeline error"
                print(f"[PIX4DRunner] Fatal error detected in {newest_log}: {fatal_err_msg}; terminating hung process.")
                try:
                    proc.terminate()
                    time.sleep(1.0)
                    if proc.poll() is None:
                        proc.kill()
                except Exception:
                    pass
                break
            pct = max(last_pct, float(info.get("progress_pct", 10.0)))
            stg = info.get("stage", "Processing")
            cpu_ram = info.get("cpu_ram", "")
            msg = f"PIX4Dmatic: {stg} ({cpu_ram})" if cpu_ram else f"PIX4Dmatic: {stg}"
            if progress_callback and (msg != last_stage_msg or abs(pct - last_pct) >= 1.0):
                progress_callback(pct, msg)
                last_stage_msg = msg
                last_pct = pct

    try:
        ret = proc.wait()
    finally:
        try:
            stdout_fh.close()
        except Exception:
            pass
    duration_p4m = round(time.time() - t0, 2)

    prev_obj_dir = os.path.join(export_dir, "obj_mesh_prev")
    old_obj_dir = os.path.join(export_dir, "obj_mesh")

    if fatal_err_msg:
        if os.path.isdir(prev_obj_dir) and not os.path.isdir(old_obj_dir):
            try:
                os.replace(prev_obj_dir, old_obj_dir)
            except Exception:
                pass
        return {
            "success": False,
            "return_code": ret or -1,
            "error": fatal_err_msg,
            "duration_s": duration_p4m,
            "gst_path": gst_path,
            "log_tail": tail_lines,
        }

    # Locate newest exported .obj in export_dir (excluding obj_mesh_prev backup)
    objs = []
    if os.path.isdir(export_dir):
        for r_dir, r_subdirs, r_files in os.walk(export_dir):
            r_subdirs[:] = [d for d in r_subdirs if d != "obj_mesh_prev"]
            for f in sorted(r_files):
                if f.lower().endswith(".obj"):
                    fp = os.path.join(r_dir, f)
                    objs.append((os.path.getmtime(fp), fp))
    objs.sort(key=lambda x: x[0], reverse=True)
    obj_path = objs[0][1] if objs else ""

    tileset_path = ""
    if obj_path and os.path.isfile(obj_path):
        if os.path.isdir(prev_obj_dir):
            shutil.rmtree(prev_obj_dir, ignore_errors=True)
        tileset_path = postprocess_obj_to_tileset(
            scan_id=scan_id,
            proj_dir=proj_dir,
            obj_path=obj_path,
            progress_callback=progress_callback,
        )
    elif os.path.isdir(prev_obj_dir) and not os.path.isdir(old_obj_dir):
        try:
            os.replace(prev_obj_dir, old_obj_dir)
        except Exception:
            pass

    if tileset_path and os.path.isfile(rerun_cfg_path):
        try:
            os.remove(rerun_cfg_path)
        except OSError:
            pass

    if progress_callback and tileset_path:
        progress_callback(100.0, f"Completed (TWD97 + TWVD2001, {active_tex_size}px Web Tileset)")

    return {
        "success": (ret == 0 and bool(tileset_path)),
        "return_code": ret,
        "duration_s": duration_p4m,
        "gst_path": gst_path,
        "p4m_path": p4m_path,
        "obj_path": obj_path,
        "tileset_path": tileset_path,
        "crs": TWD97_TWVD2001_LABEL,
        "texture_size": active_tex_size,
        "log_tail": tail_lines[-30:],
    }


def prestage_input_to_local_ssd(input_path: str, output_project_dir: str) -> bool:
    """
    Pre-extracts `.zip` archives or fast-copies uncompressed Google Drive folders
    into `<output_project_dir>/inputs/<stem>` in the background (16-thread parallel copy,
    skipping mobile preview `meshes/`) so queued jobs start immediately when PIX4Dmatic
    is ready for them.
    """
    if not input_path or not output_project_dir:
        return False
    inputs_dir = os.path.join(output_project_dir, "inputs")
    os.makedirs(inputs_dir, exist_ok=True)
    part_paths = [p.strip() for p in input_path.split(";") if p.strip()]
    any_staged = False
    from concurrent.futures import ThreadPoolExecutor

    for zpath in part_paths:
        if os.path.isfile(zpath) and zpath.lower().endswith(".zip"):
            stem = os.path.splitext(os.path.basename(zpath))[0]
            target_extract = os.path.join(inputs_dir, stem)
            stage_marker = os.path.join(target_extract, ".staged_ok")
            if os.path.isfile(stage_marker):
                continue
            try:
                os.makedirs(target_extract, exist_ok=True)
                with zipfile.ZipFile(zpath, "r") as zf:
                    zf.extractall(target_extract)
                preview_meshes_dir = os.path.join(target_extract, "meshes")
                if os.path.isdir(preview_meshes_dir):
                    shutil.rmtree(preview_meshes_dir, ignore_errors=True)
                with open(stage_marker, "w", encoding="utf-8") as mf:
                    mf.write(str(int(time.time())))
                any_staged = True
            except Exception:
                pass
        elif os.path.isdir(zpath):
            stem = os.path.basename(zpath.rstrip("/\\"))
            target_extract = os.path.join(inputs_dir, stem)
            stage_marker = os.path.join(target_extract, ".staged_ok")
            if os.path.isfile(stage_marker):
                continue
            try:
                os.makedirs(target_extract, exist_ok=True)
                preview_meshes_dir = os.path.join(target_extract, "meshes")
                if os.path.isdir(preview_meshes_dir):
                    shutil.rmtree(preview_meshes_dir, ignore_errors=True)
                copy_tasks = []
                for root, dirs, files in os.walk(zpath):
                    dirs[:] = [d for d in dirs if d.lower() not in {"meshes", ".git", "__pycache__"}]
                    rel_dir = os.path.relpath(root, zpath)
                    dst_dir = target_extract if rel_dir == "." else os.path.join(target_extract, rel_dir)
                    os.makedirs(dst_dir, exist_ok=True)
                    for fn in files:
                        if fn.startswith("."):
                            continue
                        s_f = os.path.join(root, fn)
                        d_f = os.path.join(dst_dir, fn)
                        if not os.path.isfile(d_f) or os.path.getsize(d_f) != os.path.getsize(s_f):
                            copy_tasks.append((s_f, d_f))
                if copy_tasks:
                    def _cp(pair):
                        try:
                            shutil.copy2(pair[0], pair[1])
                        except Exception:
                            pass
                    with ThreadPoolExecutor(max_workers=16) as pool:
                        list(pool.map(_cp, copy_tasks))
                    any_staged = True
                with open(stage_marker, "w", encoding="utf-8") as mf:
                    mf.write(str(int(time.time())))
            except Exception:
                pass
    return any_staged

