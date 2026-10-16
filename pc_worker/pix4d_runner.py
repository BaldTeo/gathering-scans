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
    primary_opf_path: Optional[str] = None,
    part_image_groups: Optional[list] = None,
) -> str:
    """
    Generates a verified PIX4Dmatic 2.11.0 .gst / .p4mpl QML automation script matching
    the exact CommandGraph schema from C:/Scans/QuChi/QuChi_20261015/history.p4mpl:
    1. Creates/opens the project (.p4m)
    2. Imports primary OPF (ImportOpf) for part 1
    3. Sets GCP & Project CRS to TWD97 / TM2 zone 121 + TWVD 2001 height (EPSG:3826+8904 [TWGEOID2018h])
    4. Imports any additional parts via AddImagesFromPaths
    5. Runs CommandGraph (GenerateReconstruction -> GenerateSkyMasks -> GenerateGaPmvsDensePointCloud
       -> GenerateDepthPointCloud -> GenerateFusedPointCloud -> GenerateScalableMesh(2048) -> ExportQualityReport -> ExportMeshToObj)
    6. Saves project and closes session cleanly.
    """
    proj_folder_clean = os.path.dirname(project_p4m_path).replace("\\", "/")
    proj_name = os.path.splitext(os.path.basename(project_p4m_path))[0] or "p4m_project"
    exp_clean = export_dir.replace("\\", "/")
    report_pdf = f"{exp_clean}/quality_report.pdf"
    obj_mesh_folder = f"{exp_clean}/obj_mesh"

    import_blocks = []
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

    import_blocks.append(
        f"""        // 2. Enforce TWD97 (121) [EPSG:3826] + TWVD2001 [EPSG:8904, TWGEOID2018h]
        SetGcpCrs {{
            settings.srsDefinition : '{srs_wkt}'
            inputs : [InputCameras{{ }},TiePointSet{{ }},RoiSet{{ }}]
            outputs : [InputCameras{{ }},TiePointSet{{ }},RoiSet{{ }}]
        }}"""
    )

    if part_image_groups:
        for idx, grp in enumerate(part_image_groups):
            if not grp:
                continue
            grp_literal = ",\n            ".join(f'"{p.replace(chr(92), "/")}"' for p in grp)
            import_blocks.append(
                f"""        // Import Part {idx + 2 if primary_opf_path else idx + 1} Images + Depth + Confidence
        AddImagesFromPaths {{
            paths : [{grp_literal}]
            inputs : [InputCameras{{ }},TiePointSet{{ }},RoiSet{{ }}]
            outputs : [InputCameras{{ }},TiePointSet{{ }},RoiSet{{ }}]
        }}"""
            )
    elif not primary_opf_path:
        if extracted_image_paths:
            paths_literal = ",\n            ".join(f'"{p.replace(chr(92), "/")}"' for p in extracted_image_paths)
        else:
            part_paths = [p.strip().replace("\\", "/") for p in input_zip_or_folder.split(";") if p.strip()]
            if not part_paths:
                part_paths = [input_zip_or_folder.replace("\\", "/")]
            paths_literal = ",\n            ".join(f'"{p}"' for p in part_paths)
        import_blocks.insert(
            0,
            f"""        AddImagesFromPaths {{
            paths : [{paths_literal}]
            inputs : [InputCameras{{ }},TiePointSet{{ }},RoiSet{{ }}]
            outputs : [InputCameras{{ }},TiePointSet{{ }},RoiSet{{ }}]
        }}""",
        )

    imports_joined = "\n\n".join(import_blocks)

    gst_content = f"""Session {{
    Project {{
        folder : "{proj_folder_clean}"
        name : "{proj_name}"

{imports_joined}

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
            GenerateSkyMasks {{
                resources.useGpu : GpuUsage.Yes
                inputs : [CalibratedCameras{{ }}]
                outputs : [SkyMasks{{ }}]
            }}
            GenerateGaPmvsDensePointCloud {{
                settings.sensorType : SensorType.Rgb
                settings.denoise : true
                settings.imageScale : ImageScale.Half
                settings.maskAware : false
                settings.minNbrOfMatches : 3
                settings.multiScale : true
                settings.pointDensity : PointDensity.Optimal
                settings.skyless : true
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
                settings.skyless : true
                settings.textureSize : {int(texture_size)}
                inputs : [FusedPointCloud{{ }},SkyMasks{{ }}]
                outputs : [Mesh{{ }}]
            }}
            ExportQualityReport {{
                path : "{report_pdf}"
                settings.displayUnit : 'm'
                settings.reportExportFormat : ReportExportFormat.Pdf
                settings.temperatureUnit : TemperatureUnit.Celsius
                settings.thermalColorMap : ColorMap.Inferno
                inputs : [CalibratedCameras{{ }},SparsePointCloud{{ }},TiePointSet{{ }},IntersectionTiePointSet{{ }},GaussianSplats{{ }},DensePointCloud{{ }},DepthPointCloud{{ }},FusedPointCloud{{ }},Mesh{{ }}]
            }}
            ExportMeshToObj {{
                folder : "{obj_mesh_folder}"
                settings.exportAsTiles : false
                settings.exportLod : 0
                settings.exportSrs : ExportSrs.Project
                inputs : [Mesh{{ }}]
            }}
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
    primary_opf_path = None
    part_image_groups = []
    part_paths = [p.strip() for p in input_path.split(";") if p.strip()]
    if not dry_run:
        for idx, zpath in enumerate(part_paths):
            if os.path.isfile(zpath) and zpath.lower().endswith(".zip"):
                stem = os.path.splitext(os.path.basename(zpath))[0]
                target_extract = os.path.join(inputs_dir, stem)
                if not os.path.isdir(target_extract):
                    if progress_callback:
                        progress_callback(6.0 + idx * 0.8, f"Extracting archive {idx + 1}/{len(part_paths)}: {os.path.basename(zpath)}...")
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
                else:
                    if part_imgs:
                        part_image_groups.append(part_imgs)

    gst_code = generate_pix4dmatic_gst_script(
        project_p4m_path=p4m_path,
        input_zip_or_folder=input_path,
        export_dir=export_dir,
        texture_size=PIX4DMATIC_TEXTURE_SIZE,
        srs_wkt=TWD97_TWVD2001_WKT,
        extracted_image_paths=extracted_files if extracted_files else None,
        primary_opf_path=primary_opf_path,
        part_image_groups=part_image_groups if part_image_groups else None,
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

    # Locate exported .obj (recursively in export_dir) and build 2K Web Tileset via GC_ScanOptimizer QuadtreeTiler
    objs = []
    if os.path.isdir(export_dir):
        for r_dir, _, r_files in os.walk(export_dir):
            for f in sorted(r_files):
                if f.lower().endswith(".obj"):
                    objs.append(os.path.join(r_dir, f))

    obj_path = objs[0] if objs else ""
    tileset_path = ""
    if obj_path and os.path.isfile(obj_path):
        if progress_callback:
            progress_callback(93.0, "Building 2K Hierarchical 3D Tileset in GC_ScanOptimizer...")
        if GC_SCAN_OPTIMIZER_DIR not in sys.path:
            sys.path.insert(0, GC_SCAN_OPTIMIZER_DIR)
        from optimizer.quadtree_tiler import QuadtreeTiler

        tileset_dir = os.path.join(proj_dir, "tileset")
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
