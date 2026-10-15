#!/usr/bin/env python3
"""
Automated Interface-Free PIX4Dmatic 2.11.0 GST Runner
Enforces:
- Mandatory Coordinate System: TWD97 (121) [EPSG:3826] + TWVD2001 [EPSG:8904, TWGEOID2018h]
- Mandatory 2K Texture Resolution: settings.textureSize = 2048
- Automated execution via PIX4Dmatic.exe --gst <script.gst> (acquiring network seat 6fdbf93b
  and terminating cleanly with CloseSession {})
- Chained web tileset generation via GC_ScanOptimizer QuadtreeTiler (texture_limit=2048).
"""

import os
import sys
import time
import subprocess
from typing import Dict, Any, Optional, Callable

from pc_worker.config import (
    PIX4DMATIC_EXE,
    PIX4DMATIC_TEXTURE_SIZE,
    TWD97_TWVD2001_WKT,
    TWD97_TWVD2001_LABEL,
    LOCAL_SCANS_ROOT,
    GC_SCAN_OPTIMIZER_DIR,
)


def generate_pix4dmatic_gst_script(
    project_p4m_path: str,
    input_zip_or_folder: str,
    export_dir: str,
    texture_size: int = PIX4DMATIC_TEXTURE_SIZE,
    srs_wkt: str = TWD97_TWVD2001_WKT,
    extracted_image_paths: Optional[list] = None,
) -> str:
    """
    Generates a verified PIX4Dmatic 2.11.0 .gst / .p4mpl QML automation script matching
    the exact CommandGraph schema from C:/Scans/QuChi/QuChi_20261005/history.p4mpl:
    1. Creates/opens the project (.p4m)
    2. Sets GCP & Project CRS to TWD97 / TM2 zone 121 + TWVD 2001 height (EPSG:3826+8904 [TWGEOID2018h])
    3. Imports the Pix4DCatch images/depth/confidence maps via AddImagesFromPaths
    4. Runs CommandGraph:
       - GenerateReconstruction (CalibPipeline.AccurateCameraExternalMeasurements, CalibTemplate.CatchRTK, ImageScale.Full)
       - GenerateGaPmvsDensePointCloud (SensorType.Rgb, ImageScale.Half, PointDensity.Optimal)
       - GenerateDepthPointCloud (ConfidenceLevel.High)
       - GenerateFusedPointCloud (distanceThresholdMeters: 0.025, nearestNeighboursCount: 128)
       - GenerateScalableMesh (MeshPipeline.FixedSize, MeshProjectTemplate.Catch, textureSize: 2048)
       - ExportMeshToObj (ExportSrs.Project, exportLod: 13)
    5. Saves project and closes session cleanly.
    """
    p4m_clean = project_p4m_path.replace("\\", "/")
    exp_clean = export_dir.replace("\\", "/")
    report_pdf = f"{exp_clean}/quality_report.pdf"

    if extracted_image_paths:
        paths_literal = ",\n            ".join(f'"{p.replace(chr(92), "/")}"' for p in extracted_image_paths)
    else:
        part_paths = [p.strip().replace("\\", "/") for p in input_zip_or_folder.split(";") if p.strip()]
        if not part_paths:
            part_paths = [input_zip_or_folder.replace("\\", "/")]
        paths_literal = ",\n            ".join(f'"{p}"' for p in part_paths)

    gst_content = f"""import Pix4D.Gst 1.0

Session {{
    Project {{
        path : "{p4m_clean}"
        create : true

        // 1. Enforce TWD97 (121) [EPSG:3826] + TWVD2001 [EPSG:8904, TWGEOID2018h]
        SetGcpCrs {{
            settings.srsDefinition : '{srs_wkt}'
            inputs : [InputCameras{{ }},TiePointSet{{ }},RoiSet{{ }}]
            outputs : [InputCameras{{ }},TiePointSet{{ }},RoiSet{{ }}]
        }}

        // 2. Import Pix4DCatch RTK Frames + LiDAR Depth & Confidence Maps (Single or Multi-Part Merged)
        AddImagesFromPaths {{
            paths : [{paths_literal}]
            inputs : [InputCameras{{ }},TiePointSet{{ }},RoiSet{{ }}]
            outputs : [InputCameras{{ }},TiePointSet{{ }},RoiSet{{ }}]
        }}
        SaveProject {{ }}

        // 3. Full Photogrammetry & 2K Mesh Pipeline (PIX4Dmatic 2.11.0 CommandGraph)
        CommandGraph {{
            GenerateReconstruction {{
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
                inputs : [InputCameras{{ }},TiePointSet{{ }},ConstraintSet{{ }}]
                outputs : [InputCameras{{ }},CalibratedCameras{{ }},SparsePointCloud{{ }},FeaturesAndMatches{{ }},IntersectionTiePointSet{{ }},LineFeatures{{ }}]
            }}
            GenerateGaPmvsDensePointCloud {{
                settings.sensorType : SensorType.Rgb
                settings.denoise : true
                settings.imageScale : ImageScale.Half
                settings.maskAware : false
                settings.minNbrOfMatches : 3
                settings.multiScale : true
                settings.pointDensity : PointDensity.Optimal
                settings.skyless : false
                resources.useGpu : GpuUsage.Automatic
                inputs : [CalibratedCameras{{ }},SparsePointCloud{{ }},SkyMasks{{ }}]
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
                settings.deghosting : Deghosting.Weak
                settings.generatePlanes : false
                settings.maskAware : false
                settings.meshPipeline : MeshPipeline.FixedSize
                settings.meshProjectTemplate : MeshProjectTemplate.Catch
                settings.modelSimplification : ModelSimplification.Conservative
                settings.polygonAware : false
                settings.skyless : false
                settings.textureSize : {int(texture_size)}
                inputs : [FusedPointCloud{{ }}]
                outputs : [Mesh{{ }}]
            }}
            ExportMeshToObj {{
                folder : "{exp_clean}"
                settings.exportAsTiles : false
                settings.exportLod : 13
                settings.exportSrs : ExportSrs.Project
                inputs : [Mesh{{ }}]
            }}
        }}
        ExportQualityReport {{
            path : "{report_pdf}"
        }}
        SaveProject {{ }}
    }}
    CloseSession {{ }}
}}
"""
    return gst_content


def run_pix4dmatic_pipeline(
    scan_id: str,
    input_path: str,
    output_project_dir: Optional[str] = None,
    progress_callback: Optional[Callable[[float, str], None]] = None,
    dry_run: bool = False,
) -> Dict[str, Any]:
    """
    Executes the automated PIX4Dmatic 2.11.0 workflow (without --batch-mode so the
    cloud license seat 6fdbf93b is acquired automatically, minimized/hidden window)
    and chains GC_ScanOptimizer QuadtreeTiler (2K texture cap) to produce a web tileset.
    Supports both single .zip archives ('FileName.zip') and multi-part archives
    ('FileName_1of4.zip;FileName_2of4.zip;FileName_3of4.zip;FileName_4of4.zip')
    merged into a single PIX4Dmatic project.
    """
    import zipfile

    proj_dir = output_project_dir or os.path.join(LOCAL_SCANS_ROOT, scan_id)
    export_dir = os.path.join(proj_dir, "exports")
    inputs_dir = os.path.join(proj_dir, "inputs")
    os.makedirs(export_dir, exist_ok=True)
    os.makedirs(inputs_dir, exist_ok=True)

    p4m_path = os.path.join(proj_dir, f"{scan_id}.p4m")
    gst_path = os.path.join(proj_dir, f"{scan_id}_pipeline.gst")

    # Extract single or multi-part Pix4DCatch .zip archives into inputs/<stem>
    extracted_files = []
    part_paths = [p.strip() for p in input_path.split(";") if p.strip()]
    if not dry_run:
        for zpath in part_paths:
            if os.path.isfile(zpath) and zpath.lower().endswith(".zip"):
                stem = os.path.splitext(os.path.basename(zpath))[0]
                target_extract = os.path.join(inputs_dir, stem)
                if not os.path.isdir(target_extract):
                    with zipfile.ZipFile(zpath, "r") as zf:
                        zf.extractall(target_extract)
                for root, _, files in os.walk(target_extract):
                    for fn in sorted(files):
                        if fn.lower().endswith((".jpg", ".jpeg", ".png", ".tiff", ".tif")):
                            extracted_files.append(os.path.join(root, fn))

    gst_code = generate_pix4dmatic_gst_script(
        project_p4m_path=p4m_path,
        input_zip_or_folder=input_path,
        export_dir=export_dir,
        texture_size=PIX4DMATIC_TEXTURE_SIZE,
        srs_wkt=TWD97_TWVD2001_WKT,
        extracted_image_paths=extracted_files if extracted_files else None,
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
            "texture_size": PIX4DMATIC_TEXTURE_SIZE,
        }

    if progress_callback:
        progress_callback(10.0, "Launching PIX4Dmatic 2.11.0 (CRS: TWD97 (121) + TWVD2001, 2K Textures)...")

    # Configure minimized/background window on Windows so GUI never steals focus
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

    log_lines = []
    if proc.stdout:
        for line in proc.stdout:
            log_lines.append(line.rstrip())
            if "SetGcpCrs" in line and progress_callback:
                progress_callback(20.0, "Applying CRS: TWD97 (121) + TWVD2001 [EPSG:3826+8904]...")
            elif "GenerateReconstruction" in line and progress_callback:
                progress_callback(35.0, "Calibrating RTK Cameras (CatchRTK)...")
            elif "GenerateFusedPointCloud" in line and progress_callback:
                progress_callback(55.0, "Generating Dense + Depth Fused Point Cloud...")
            elif "GenerateScalableMesh" in line and progress_callback:
                progress_callback(75.0, "Generating 2K (2048px) Textured Mesh...")
            elif "ExportMeshToObj" in line and progress_callback:
                progress_callback(88.0, "Exporting .OBJ in TWD97 (121) + TWVD2001...")

    ret = proc.wait()
    duration_p4m = round(time.time() - t0, 2)

    # Locate exported .obj and build 2K Web Tileset via GC_ScanOptimizer QuadtreeTiler
    objs = [
        os.path.join(export_dir, f)
        for f in os.listdir(export_dir)
        if f.lower().endswith(".obj")
    ] if os.path.isdir(export_dir) else []

    obj_path = objs[0] if objs else ""
    tileset_path = ""
    if obj_path and os.path.isfile(obj_path):
        if progress_callback:
            progress_callback(93.0, "Building 2K Hierarchical 3D Tileset in GC_ScanOptimizer...")
        if GC_SCAN_OPTIMIZER_DIR not in sys.path:
            sys.path.insert(0, GC_SCAN_OPTIMIZER_DIR)
        from optimizer.quadtree_tiler import QuadtreeTiler

        tileset_dir = os.path.join(export_dir, f"{scan_id}-optimized_tileset")
        tiler = QuadtreeTiler(
            input_path=obj_path,
            output_dir=tileset_dir,
            max_levels=3,
            texture_quality=7,
            texture_limit=PIX4DMATIC_TEXTURE_SIZE,  # Enforce 2048 max texture resolution
            high_compression=True,
            verbose=False,
        )
        tiler.run()
        ts_candidate = os.path.join(tileset_dir, "tileset.json")
        if os.path.isfile(ts_candidate):
            tileset_path = ts_candidate

    if progress_callback:
        progress_callback(100.0, "Completed (TWD97 + TWVD2001, 2K Web Tileset)")

    return {
        "success": ret == 0,
        "return_code": ret,
        "duration_s": duration_p4m,
        "gst_path": gst_path,
        "p4m_path": p4m_path,
        "obj_path": obj_path,
        "tileset_path": tileset_path,
        "crs": TWD97_TWVD2001_LABEL,
        "texture_size": PIX4DMATIC_TEXTURE_SIZE,
        "log_tail": log_lines[-30:],
    }
