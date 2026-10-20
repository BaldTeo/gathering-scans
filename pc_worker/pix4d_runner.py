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
import subprocess
from typing import Dict, Any, Optional, Callable, List

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


def parse_pix4dmatic_log_progress(log_path: str) -> Dict[str, Any]:
    """
    Reads the tail of a PIX4Dmatic project or app log file and extracts:
    - stage: human-readable current stage
    - cpu_ram: e.g. '94%CPU · 59%RAM'
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

        for ln in tail_lines[-6:]:
            if "CloseSession" in ln or ("[Save project" in ln and "Finished" in ln) or "[Processing] Finished" in ln:
                out["is_finished"] = True

        stage_name = ""
        cpu_ram = ""
        for ln in reversed(tail_lines):
            m = re.search(r"\[(\d+%CPU)\]\[(\d+%RAM)\]\[([^\]]+)\]", ln)
            if m:
                cpu_ram = f"{m.group(1)} · {m.group(2)}"
                stage_name = m.group(3).strip()
                break

        stage_pct_map = [
            ("Import", 12.0),
            ("Sky mask", 16.0),
            ("Keypoints", 24.0),
            ("Pair matching", 34.0),
            ("Calibration", 44.0),
            ("Bundle", 50.0),
            ("dense point cloud", 62.0),
            ("Densification", 62.0),
            ("Depth point cloud", 75.0),
            ("Fuse", 79.0),
            ("textured mesh", 85.0),
            ("scalable mesh", 88.0),
            ("Finalize scalable mesh", 91.0),
            ("Export quality report", 93.0),
            ("Export mesh to .obj", 95.0),
            ("Save project", 96.0),
        ]
        est_pct = 12.0
        for k_stg, v_pct in stage_pct_map:
            if k_stg.lower() in stage_name.lower() or k_stg.lower() in tail_text.lower():
                est_pct = max(est_pct, v_pct)

        if "Scene [2/2]" in tail_text and est_pct < 73.0:
            est_pct = max(est_pct, 69.0)
            if "colorizing" in tail_text.split("Scene [2/2]")[-1]:
                est_pct = max(est_pct, 73.0)
        elif "Scene [1/2]" in tail_text and est_pct < 68.0:
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
                settings.imageScale : ImageScale.Half
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
                settings.depthFilterAgreementThresholdMeters : 0.001
                settings.filter : true
                settings.minConfidenceLevel : ConfidenceLevel.High
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

    # Ensure companion .mtl files specify Kd 1.000000 1.000000 1.000000 so trimesh and gltfpack never dim textures to 0.4
    try:
        for mtl_file in glob.glob(os.path.join(obj_dir, "*.mtl")):
            with open(mtl_file, "r", encoding="utf-8", errors="ignore") as mf:
                m_txt = mf.read()
            if "Kd " not in m_txt and "newmtl" in m_txt:
                m_txt = m_txt.replace("newmtl material_0", "newmtl material_0\nKd 1.000000 1.000000 1.000000")
                if "Kd " not in m_txt:
                    m_txt += "\nKd 1.000000 1.000000 1.000000\n"
                with open(mtl_file, "w", encoding="utf-8") as mf:
                    mf.write(m_txt)
    except Exception as e:
        print(f"[PIX4DRunner] Warning updating MTL Kd factor: {e}")

    if progress_callback:
        progress_callback(96.0, "Building Hierarchical 3D Tileset in GC_ScanOptimizer...")
    if GC_SCAN_OPTIMIZER_DIR not in sys.path:
        sys.path.insert(0, GC_SCAN_OPTIMIZER_DIR)
    from optimizer.quadtree_tiler import QuadtreeTiler

    active_cfg = load_pix4d_settings()
    active_tex_limit = int(active_cfg.get("texture_size", PIX4DMATIC_TEXTURE_SIZE))
    tileset_dir = os.path.join(proj_dir, "tileset")
    tiler = QuadtreeTiler(
        input_path=obj_path,
        output_dir=tileset_dir,
        max_levels=3,
        texture_quality=7,
        texture_limit=active_tex_limit,
        high_compression=True,
        verbose=False,
    )
    tiler.run()
    ts_candidate = os.path.join(tileset_dir, "tileset.json")
    if os.path.isfile(ts_candidate):
        # Build high-precision (-vp 14 -vt 12) root.glb directly from local-coordinate obj_path via gltfpack
        try:
            from pc_worker.preview_generator import (
                GLTFPACK_EXE,
                _downscale_glb_textures,
                shift_glb_node_translation,
                ensure_scan_low_quality_preview,
                ensure_scan_full_quality_thumbnail,
            )

            if os.path.isfile(GLTFPACK_EXE):
                face_count = 0
                with open(obj_path, "r", encoding="utf-8", errors="ignore") as f_obj:
                    for ln in f_obj:
                        if ln.startswith("f "):
                            face_count += 1
                root_glb = os.path.join(tileset_dir, "tiles", "root.glb")
                os.makedirs(os.path.dirname(root_glb), exist_ok=True)
                ratio_full = min(1.0, max(0.08, 320000.0 / float(max(face_count, 1))))
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
                )
                if r_res.returncode == 0 and os.path.isfile(tmp_root) and os.path.getsize(tmp_root) > 1024:
                    with open(tmp_root, "rb") as tf:
                        raw_r = tf.read()
                    os.remove(tmp_root)
                    opt_r = _downscale_glb_textures(raw_r, max_dim=active_tex_limit, jpeg_quality=88)
                    with open(root_glb, "wb") as wf:
                        wf.write(opt_r)

            # Apply 64-bit TWD97 offset (ox, oy, oz) to all generated .glb node.translation and tileset.json bounding boxes
            if abs(ox) > 1.0 or abs(oy) > 1.0 or abs(oz) > 0.001:
                for glb_fp in glob.glob(os.path.join(tileset_dir, "tiles", "*.glb")):
                    try:
                        with open(glb_fp, "rb") as gf:
                            g_bytes = gf.read()
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
                            bv["box"][0] = round(float(bv["box"][0]) + ox, 4)
                            bv["box"][1] = round(float(bv["box"][1]) + oy, 4)
                            bv["box"][2] = round(float(bv["box"][2]) + oz, 4)
                        for ch in node.get("children") or []:
                            if isinstance(ch, dict):
                                _shift_ts_node_boxes(ch)

                    if isinstance(ts_json.get("root"), dict):
                        _shift_ts_node_boxes(ts_json["root"])
                    with open(ts_candidate, "w", encoding="utf-8") as tf_out:
                        json.dump(ts_json, tf_out, indent=2)
                    with open(os.path.join(tileset_dir, "offset.xyz"), "w", encoding="utf-8") as off_out:
                        off_out.write(f"{ox:.3f} {oy:.3f} {oz:.3f}\n")
                except Exception as te:
                    print(f"[PIX4DRunner] Warning shifting tileset.json boundingVolume: {te}")
        except Exception as e:
            print(f"[PIX4DRunner] Warning building direct gltfpack root.glb: {e}")

        # Remove stale DSM cache so surveying_engine rebuilds DSM from the new mesh
        dsm_cache = os.path.join(proj_dir, "_dsm_cache_v3.npz")
        if os.path.isfile(dsm_cache):
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
    if os.path.isfile(rerun_cfg_path):
        try:
            with open(rerun_cfg_path, "r", encoding="utf-8") as rf:
                r_data = json.load(rf)
            if isinstance(r_data, dict):
                if r_data.get("force_from_photos", True):
                    force_from_photos = True
                if isinstance(r_data.get("settings"), dict):
                    custom_settings = r_data["settings"]
            if not dry_run:
                os.remove(rerun_cfg_path)
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
            if os.path.isdir(old_obj_dir):
                shutil.rmtree(old_obj_dir, ignore_errors=True)

            if part_paths:
                for idx, zpath in enumerate(part_paths):
                    if os.path.isfile(zpath) and zpath.lower().endswith(".zip"):
                        stem = os.path.splitext(os.path.basename(zpath))[0]
                        target_extract = os.path.join(inputs_dir, stem)
                        if not os.path.isdir(target_extract):
                            if progress_callback:
                                progress_callback(
                                    6.0 + idx * 0.8,
                                    f"Extracting archive {idx + 1}/{len(part_paths)}: {os.path.basename(zpath)}...",
                                )
                            with zipfile.ZipFile(zpath, "r") as zf:
                                zf.extractall(target_extract)
                        cand_opf = os.path.join(target_extract, "project.opf")
                        part_imgs = []
                        for root, _, files in os.walk(target_extract):
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
                        if progress_callback:
                            progress_callback(
                                6.0 + idx * 0.8,
                                f"Staging folder {idx + 1}/{len(part_paths)}: {stem}...",
                            )
                        os.makedirs(target_extract, exist_ok=True)
                        alt_unredacted_dirs = glob.glob(os.path.join(r"G:\My Drive\Scans", "*", stem, "images")) + glob.glob(os.path.join(r"G:\My Drive\Scans", stem, "images"))
                        alt_src_dir = alt_unredacted_dirs[0] if alt_unredacted_dirs and os.path.isdir(alt_unredacted_dirs[0]) else ""
                        for root, _, files in os.walk(zpath):
                            rel_dir = os.path.relpath(root, zpath)
                            dst_dir = target_extract if rel_dir == "." else os.path.join(target_extract, rel_dir)
                            os.makedirs(dst_dir, exist_ok=True)
                            for fn in files:
                                if fn.startswith("."):
                                    continue
                                s_f = os.path.join(root, fn)
                                d_f = os.path.join(dst_dir, fn)
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
                        cand_opf = os.path.join(target_extract, "project.opf")
                        part_imgs = []
                        for root, _, files in os.walk(target_extract):
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

    if progress_callback:
        progress_callback(10.0, f"Launching PIX4Dmatic 2.11.0 (CRS: TWD97 + TWVD2001, {active_tex_size}px)...")

    startupinfo = None
    if os.name == "nt":
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = 7  # SW_SHOWMINNOACTIVE

    cmd = [PIX4DMATIC_EXE, "--gst", gst_path]
    t0 = time.time()
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        startupinfo=startupinfo,
    )

    appdata_log_dir = os.path.join(os.environ.get("APPDATA", ""), "pix4d", "PIX4Dmatic", "logs")
    proj_log_dirs = [
        os.path.join(proj_dir, scan_id, "logs"),
        os.path.join(proj_dir, "project", "logs"),
        os.path.join(LOCAL_SCANS_ROOT, "catch_QuChi261016", "catch_QuChi261016", "logs"),
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

    ret = proc.wait()
    duration_p4m = round(time.time() - t0, 2)

    if fatal_err_msg:
        return {
            "success": False,
            "return_code": ret or -1,
            "error": fatal_err_msg,
            "duration_s": duration_p4m,
            "gst_path": gst_path,
            "log_tail": tail_lines,
        }

    # Locate newest exported .obj in export_dir
    objs = []
    if os.path.isdir(export_dir):
        for r_dir, _, r_files in os.walk(export_dir):
            for f in sorted(r_files):
                if f.lower().endswith(".obj"):
                    fp = os.path.join(r_dir, f)
                    objs.append((os.path.getmtime(fp), fp))
    objs.sort(key=lambda x: x[0], reverse=True)
    obj_path = objs[0][1] if objs else ""

    tileset_path = ""
    if obj_path and os.path.isfile(obj_path):
        tileset_path = postprocess_obj_to_tileset(
            scan_id=scan_id,
            proj_dir=proj_dir,
            obj_path=obj_path,
            progress_callback=progress_callback,
        )

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
