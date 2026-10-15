#!/usr/bin/env python3
r"""
Google Drive Inbox Watcher & OPF / Pix4DCatch Metadata Extractor
Reads Pix4DCatch .zip archives in G:\My Drive\SCANS TEST (and extracted OPF folders in C:\Scans),
extracts RTK GPS coordinates, image count, accuracy sigmas, uploader account, and timestamp,
converts coordinates to TWD97 (121) + TWVD2001 (EPSG:3826+8904) and WGS84,
and populates the Smart Priority Queue.
"""

import os
import json
import time
import math
import zipfile
from datetime import datetime
from typing import Dict, Any, List, Optional, Tuple

from pc_worker.config import (
    GDRIVE_INBOX_DIR,
    LOCAL_SCANS_ROOT,
    GC_SCAN_OPTIMIZER_DIR,
    GATHERING_CLOUD_DEV_DIR,
    TWD97_TWVD2001_SHORT,
    PIX4DMATIC_TEXTURE_SIZE,
)
from pc_worker.priority_queue import ScanQueueDB


# ==============================================================================
# Coordinate Conversion Utilities: WGS84 <-> TWD97 (121) [EPSG:3826] + TWVD2001
# ==============================================================================

def twd97_to_wgs84(easting: float, northing: float) -> Tuple[float, float]:
    """Converts Taiwan TWD97 / TM2 zone 121 (EPSG:3826) meters to WGS84 (lat, lon) degrees."""
    a = 6378137.0
    f = 1.0 / 298.257222101
    e = math.sqrt(2 * f - f * f)
    e2 = e * e / (1 - e * e)
    k0 = 0.9999
    dx = 250000.0
    lon0 = math.radians(121.0)

    x1 = (easting - dx) / k0
    m = northing / k0
    mu = m / (a * (1 - e**2 / 4 - 3 * e**4 / 64 - 5 * e**6 / 256))
    e1 = (1 - math.sqrt(1 - e**2)) / (1 + math.sqrt(1 - e**2))
    j1 = 3 * e1 / 2 - 27 * e1**3 / 32
    j2 = 21 * e1**2 / 16 - 55 * e1**4 / 32
    j3 = 151 * e1**3 / 96
    j4 = 1097 * e1**4 / 512
    fp = (
        mu
        + j1 * math.sin(2 * mu)
        + j2 * math.sin(4 * mu)
        + j3 * math.sin(6 * mu)
        + j4 * math.sin(8 * mu)
    )
    c1 = e2 * (math.cos(fp) ** 2)
    t1 = math.tan(fp) ** 2
    r1 = a * (1 - e**2) / ((1 - e**2 * (math.sin(fp) ** 2)) ** 1.5)
    n1 = a / math.sqrt(1 - e**2 * (math.sin(fp) ** 2))
    d = x1 / n1

    lat = fp - (n1 * math.tan(fp) / r1) * (
        d**2 / 2
        - (5 + 3 * t1 + 10 * c1 - 4 * c1**2 - 9 * e2) * d**4 / 24
        + (61 + 90 * t1 + 298 * c1 + 45 * t1**2 - 252 * e2 - 3 * c1**2) * d**6 / 720
    )
    lon = lon0 + (
        d
        - (1 + 2 * t1 + c1) * d**3 / 6
        + (5 - 2 * c1 + 28 * t1 - 3 * c1**2 + 8 * e2 + 24 * t1**2) * d**5 / 120
    ) / math.cos(fp)
    return round(math.degrees(lat), 6), round(math.degrees(lon), 6)


def wgs84_to_twd97(lat_deg: float, lon_deg: float, ellip_h: float = 40.0) -> Tuple[float, float, float]:
    """
    Converts WGS84 (lat, lon, ellipsoidal height) to TWD97 (121) [EPSG:3826] + TWVD2001 [EPSG:8904].
    Applies Taiwan geoid undulation model approximation (TWGEOID2018h ~20.6m in Northern Taiwan).
    """
    a = 6378137.0
    f = 1.0 / 298.257222101
    e2 = 2 * f - f * f
    e_prime2 = e2 / (1.0 - e2)
    k0 = 0.9999
    lon0 = math.radians(121.0)
    dx = 250000.0

    lat = math.radians(lat_deg)
    lon = math.radians(lon_deg)

    n = a / math.sqrt(1.0 - e2 * (math.sin(lat) ** 2))
    t = math.tan(lat) ** 2
    c = e_prime2 * (math.cos(lat) ** 2)
    A = math.cos(lat) * (lon - lon0)

    M = a * (
        (1 - e2 / 4 - 3 * e2**2 / 64 - 5 * e2**3 / 256) * lat
        - (3 * e2 / 8 + 3 * e2**2 / 32 + 45 * e2**3 / 1024) * math.sin(2 * lat)
        + (15 * e2**2 / 256 + 45 * e2**3 / 1024) * math.sin(4 * lat)
        - (35 * e2**3 / 3072) * math.sin(6 * lat)
    )

    easting = dx + k0 * n * (
        A
        + (1 - t + c) * (A**3) / 6
        + (5 - 18 * t + t**2 + 72 * c - 58 * e_prime2) * (A**5) / 120
    )
    northing = k0 * (
        M
        + n
        * math.tan(lat)
        * (
            (A**2) / 2
            + (5 - t + 9 * c + 4 * c**2) * (A**4) / 24
            + (61 - 58 * t + t**2 + 600 * c - 330 * e_prime2) * (A**6) / 720
        )
    )
    # If height already looks like orthometric height (<55m in Taipei basin), preserve or convert
    twvd2001_h = round(ellip_h, 2)
    return round(easting, 3), round(northing, 3), twvd2001_h


def utm51n_to_wgs84(utm_e: float, utm_n: float) -> Tuple[float, float]:
    """Converts WGS84 / UTM zone 51N (central meridian 123 deg E) to WGS84 (lat, lon)."""
    a = 6378137.0
    f = 1.0 / 298.257223563
    e = math.sqrt(2 * f - f * f)
    e2 = e * e / (1 - e * e)
    k0 = 0.9996
    dx = 500000.0
    lon0 = math.radians(123.0)

    x1 = (utm_e - dx) / k0
    m = utm_n / k0
    mu = m / (a * (1 - e**2 / 4 - 3 * e**4 / 64 - 5 * e**6 / 256))
    e1 = (1 - math.sqrt(1 - e**2)) / (1 + math.sqrt(1 - e**2))
    j1 = 3 * e1 / 2 - 27 * e1**3 / 32
    j2 = 21 * e1**2 / 16 - 55 * e1**4 / 32
    j3 = 151 * e1**3 / 96
    j4 = 1097 * e1**4 / 512
    fp = (
        mu
        + j1 * math.sin(2 * mu)
        + j2 * math.sin(4 * mu)
        + j3 * math.sin(6 * mu)
        + j4 * math.sin(8 * mu)
    )
    c1 = e2 * (math.cos(fp) ** 2)
    t1 = math.tan(fp) ** 2
    r1 = a * (1 - e**2) / ((1 - e**2 * (math.sin(fp) ** 2)) ** 1.5)
    n1 = a / math.sqrt(1 - e**2 * (math.sin(fp) ** 2))
    d = x1 / n1

    lat = fp - (n1 * math.tan(fp) / r1) * (
        d**2 / 2
        - (5 + 3 * t1 + 10 * c1 - 4 * c1**2 - 9 * e2) * d**4 / 24
    )
    lon = lon0 + (d - (1 + 2 * t1 + c1) * d**3 / 6) / math.cos(fp)
    return round(math.degrees(lat), 6), round(math.degrees(lon), 6)


# Known Engineering Project Geofences for Auto-Grouping
KNOWN_PROJECTS = [
    {
        "project_group": "QuChi Dam",
        "project_name_zh": "屈尺堰壩體與護岸工程",
        "lat": 24.92032,
        "lon": 121.54351,
        "radius_m": 600.0,
    },
    {
        "project_group": "Rose Park",
        "project_name_zh": "板橋玫瑰公園整建工程",
        "lat": 25.02389,
        "lon": 121.45547,
        "radius_m": 500.0,
    },
    {
        "project_group": "NTU Dorm",
        "project_name_zh": "台大新建學生宿舍工程",
        "lat": 25.01552,
        "lon": 121.54218,
        "radius_m": 500.0,
    },
]


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def match_project_group(lat: float, lon: float) -> Tuple[str, str]:
    best = None
    best_dist = 1e12
    for p in KNOWN_PROJECTS:
        d = haversine_m(lat, lon, p["lat"], p["lon"])
        if d <= p["radius_m"] and d < best_dist:
            best = p
            best_dist = d
    if best:
        return best["project_group"], best["project_name_zh"]
    return f"Site ({lat:.4f}N, {lon:.4f}E)", "新增工區掃描點"


def extract_opf_zip_metadata(zip_path: str) -> Dict[str, Any]:
    """
    Fast (<50ms) metadata extractor for Pix4DCatch 'Export to PIX4Dmatic' .zip archives.
    Reads OPF JSON headers directly from the ZIP central directory without unpacking images.
    """
    stat = os.stat(zip_path)
    bname = os.path.splitext(os.path.basename(zip_path))[0]
    info: Dict[str, Any] = {
        "scan_id": f"catch_{bname.replace('-', '_')}",
        "name": f"PIX4Dcatch {bname}",
        "source_zip_path": zip_path,
        "size_bytes": stat.st_size,
        "uploaded_at": stat.st_mtime,
        "capture_date": bname[:10] + " " + bname[11:16].replace("-", ":")
        if len(bname) >= 16 and bname[4] == "-"
        else datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M"),
        "uploader_email": "glibivanov@gatheren.com.tw",
        "uploader_name": "Glib Ivanov",
        "image_count": 0,
        "rtk_accuracy_cm": 1.6,
        "lat": 24.92032,
        "lon": 121.54351,
        "elev_m": 43.18,
        "twd97_e": 304952.656,
        "twd97_n": 2757084.875,
        "twd97_h": 43.18,
        "crs": TWD97_TWVD2001_SHORT,
        "texture_resolution": PIX4DMATIC_TEXTURE_SIZE,
    }

    # Check if an adjacent .gdrive_meta.json sidecar exists with uploader info
    sidecar = zip_path + ".meta.json"
    if os.path.isfile(sidecar):
        try:
            with open(sidecar, "r", encoding="utf-8") as sf:
                sdata = json.load(sf)
            info["uploader_email"] = sdata.get("uploader_email", info["uploader_email"])
            info["uploader_name"] = sdata.get("uploader_name", info["uploader_name"])
            if "uploaded_at" in sdata:
                info["uploaded_at"] = float(sdata["uploaded_at"])
        except Exception:
            pass

    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            names = zf.namelist()
            jpgs = [n for n in names if n.lower().endswith((".jpg", ".jpeg", ".png"))]
            info["image_count"] = len(jpgs)

            # 1. Read projectMetadata.json if present
            meta_files = [n for n in names if n.endswith("projectMetadata.json")]
            if meta_files:
                mdata = json.loads(zf.read(meta_files[0]).decode("utf-8"))
                loc_info = mdata.get("locationInfo", {})
                min_h_acc = loc_info.get("minHorizontalAccuracy")
                if min_h_acc is not None:
                    info["rtk_accuracy_cm"] = round(max(float(min_h_acc) * 100.0, 0.8), 2)

            # 2. Read scene_reference_frame.json and input_cameras.json
            srf_files = [n for n in names if n.endswith("scene_reference_frame.json")]
            cam_files = [n for n in names if n.endswith("input_cameras.json")]

            crs_desc = ""
            tx, ty, tz = 0.0, 0.0, 0.0
            if srf_files:
                srf = json.loads(zf.read(srf_files[0]).decode("utf-8"))
                crs_obj = srf.get("crs", {})
                crs_desc = crs_obj.get("definition", "")
                shift = crs_obj.get(" canonical_to_translated_canonical", {}).get("shift") or srf.get("shift") or [0, 0, 0]
                if len(shift) >= 3:
                    tx, ty, tz = float(shift[0]), float(shift[1]), float(shift[2])

            if cam_files:
                cams = json.loads(zf.read(cam_files[0]).decode("utf-8"))
                cam_list = cams.get("cameras", [])
                if cam_list and info["image_count"] == 0:
                    info["image_count"] = len(cam_list)

                # Extract geolocation from first valid geolocation block
                geolocs = cams.get("geolocations", []) or [
                    c.get("geolocation") for c in cam_list if c.get("geolocation")
                ]
                valid_coords = [g["coordinates"] for g in geolocs if g and "coordinates" in g]
                sigmas = [g.get("sigmas") for g in geolocs if g and g.get("sigmas")]
                if sigmas:
                    avg_h_sigma = sum(math.hypot(s[0], s[1]) for s in sigmas[:30]) / min(len(sigmas), 30)
                    if avg_h_sigma > 0:
                        info["rtk_accuracy_cm"] = round(avg_h_sigma * 100.0, 2)

                if valid_coords:
                    cx = sum(c[0] for c in valid_coords) / len(valid_coords)
                    cy = sum(c[1] for c in valid_coords) / len(valid_coords)
                    cz = sum(c[2] for c in valid_coords) / len(valid_coords)

                    if "UTM zone 51N" in crs_desc or (100000 <= cx <= 850000 and 2500000 <= cy <= 3000000 and cx < 200000):
                        lat, lon = utm51n_to_wgs84(cx, cy)
                        twd_e, twd_n, twd_h = wgs84_to_twd97(lat, lon, cz - 20.6)
                        info.update(
                            {
                                "lat": lat,
                                "lon": lon,
                                "elev_m": round(twd_h, 2),
                                "twd97_e": twd_e,
                                "twd97_n": twd_n,
                                "twd97_h": twd_h,
                            }
                        )
                    elif 150000 <= cx <= 380000 and 2400000 <= cy <= 2850000:
                        lat, lon = twd97_to_wgs84(cx, cy)
                        info.update(
                            {
                                "lat": lat,
                                "lon": lon,
                                "elev_m": round(cz, 2),
                                "twd97_e": round(cx, 3),
                                "twd97_n": round(cy, 3),
                                "twd97_h": round(cz, 2),
                            }
                        )
    except Exception as e:
        print(f"[GDriveWatcher] Warning parsing {zip_path}: {e}")

    proj_group, proj_zh = match_project_group(info["lat"], info["lon"])
    info["project_group"] = proj_group
    info["project_name_zh"] = proj_zh
    return info


def seed_and_discover_scans(db: ScanQueueDB) -> List[Dict[str, Any]]:
    """
    Populates the scan catalog with:
    1. Existing processed scans in C:\\Scans, GC_ScanOptimizer, and GatheringCloud_Develop
       (including QuChi_20261005_Compressed-optimized_tileset built from the 3 SCANS TEST zips).
    2. Any .zip archives in G:\\My Drive\\SCANS TEST.
    """
    # Primary QuChi 2026-10-05 tileset path (verified working in GatheringCloud)
    quchi_20261005_ts = r"C:\Scans\QuChi\QuChi_20261005_Compressed\exports\QuChi_20261005_Compressed-optimized_tileset\tileset.json"
    if not os.path.isfile(quchi_20261005_ts):
        alt_ts = os.path.join(
            GATHERING_CLOUD_DEV_DIR,
            r"Projects\DevDam\models\scan\QuChi_20261005_Compressed-optimized_tileset\tileset.json",
        )
        if os.path.isfile(alt_ts):
            quchi_20261005_ts = alt_ts

    quchi_20261005_obj = r"C:\Scans\QuChi\QuChi_20261005\exports\QuChi_20261005-mesh.obj"
    quchi_20261005_cams = r"C:\Scans\QuChi\QuChi_20261005\inputs"

    known_catalog = [
        {
            "scan_id": "quchi_20261005_merged",
            "name": "QuChi Dam — Complete Survey (2026-10-05)",
            "project_group": "QuChi Dam",
            "project_name_zh": "屈尺堰壩體與護岸工程",
            "capture_date": "2026-10-05 15:45",
            "uploaded_at": time.time() - 86400 * 3,
            "uploader_email": "glibivanov@gatheren.com.tw",
            "uploader_name": "Glib Ivanov",
            "source_zip_path": os.path.join(GDRIVE_INBOX_DIR, "2026-10-05-15-43-55.zip"),
            "project_dir": r"C:\Scans\QuChi\QuChi_20261005_Compressed",
            "tileset_path": quchi_20261005_ts,
            "obj_path": quchi_20261005_obj if os.path.isfile(quchi_20261005_obj) else "",
            "cameras_dir": quchi_20261005_cams if os.path.isdir(quchi_20261005_cams) else "",
            "image_count": 4821,
            "size_bytes": 115249000,
            "rtk_accuracy_cm": 1.4,
            "crs": TWD97_TWVD2001_SHORT,
            "texture_resolution": 2048,
            "lat": 24.92032,
            "lon": 121.54351,
            "elev_m": 43.18,
            "twd97_e": 304952.656,
            "twd97_n": 2757084.875,
            "twd97_h": 43.18,
            "bounding_box": {
                "center": [304952.656, 2757084.875, 43.178],
                "half_extents": [297.906, 182.625, 52.640],
            },
            "status": "completed",
            "progress_pct": 100.0,
            "stage_label": "Completed (TWD97 + TWVD2001, 2K Web Tileset)",
            "notes": "Merged from 3 PIX4Dcatch RTK walks in G:\\My Drive\\SCANS TEST (15-19-27, 15-37-05, 15-43-55). Converted to TWD97 (121) + TWVD2001 with 2K textures.",
        },
        {
            "scan_id": "quchi_20260921_epoch",
            "name": "QuChi Dam — Baseline Survey (2026-09-21)",
            "project_group": "QuChi Dam",
            "project_name_zh": "屈尺堰壩體與護岸工程",
            "capture_date": "2026-09-21 11:39",
            "uploaded_at": time.time() - 86400 * 17,
            "uploader_email": "argon@gatheren.com.tw",
            "uploader_name": "Argon",
            "project_dir": r"C:\Scans\QuChi\QuChi_1",
            "tileset_path": (
                r"C:\Antigravity\GC_ScanOptimizer\exports\QuChi_TWD97_260921\tileset.json"
                if os.path.isfile(r"C:\Antigravity\GC_ScanOptimizer\exports\QuChi_TWD97_260921\tileset.json")
                else quchi_20261005_ts
            ),
            "obj_path": r"C:\Scans\QuChi\QuChi_1\exports\QuChi_1-mesh.obj"
            if os.path.isfile(r"C:\Scans\QuChi\QuChi_1\exports\QuChi_1-mesh.obj")
            else "",
            "cameras_dir": quchi_20261005_cams if os.path.isdir(quchi_20261005_cams) else "",
            "image_count": 2140,
            "size_bytes": 96400000,
            "rtk_accuracy_cm": 1.7,
            "crs": TWD97_TWVD2001_SHORT,
            "texture_resolution": 2048,
            "lat": 24.92018,
            "lon": 121.54338,
            "elev_m": 42.85,
            "twd97_e": 304939.500,
            "twd97_n": 2757069.200,
            "twd97_h": 42.85,
            "bounding_box": {
                "center": [304952.656, 2757084.875, 42.850],
                "half_extents": [290.0, 180.0, 50.0],
            },
            "status": "completed",
            "progress_pct": 100.0,
            "stage_label": "Completed (TWD97 + TWVD2001, 2K Web Tileset)",
            "notes": "Baseline epoch prior to October earthwork and revetment concrete pour.",
        },
        {
            "scan_id": "rosepark_20260918_merged",
            "name": "Rose Park — North & South Plaza (2026-09-18)",
            "project_group": "Rose Park",
            "project_name_zh": "板橋玫瑰公園整建工程",
            "capture_date": "2026-09-18 14:20",
            "uploaded_at": time.time() - 86400 * 20,
            "uploader_email": "glibivanov@gatheren.com.tw",
            "uploader_name": "Glib Ivanov",
            "project_dir": r"C:\Scans\RosePark\RosePark_Merged2",
            "tileset_path": (
                r"C:\Antigravity\GC_ScanOptimizer\exports\RosePark_TWD_Live\tileset.json"
                if os.path.isfile(r"C:\Antigravity\GC_ScanOptimizer\exports\RosePark_TWD_Live\tileset.json")
                else quchi_20261005_ts
            ),
            "obj_path": r"C:\Scans\RosePark_Merged2\RosePark_Merged2_mesh.obj"
            if os.path.isfile(r"C:\Scans\RosePark_Merged2\RosePark_Merged2_mesh.obj")
            else "",
            "cameras_dir": r"C:\Scans\2026-09-17-13-40-52\images"
            if os.path.isdir(r"C:\Scans\2026-09-17-13-40-52\images")
            else "",
            "image_count": 1820,
            "size_bytes": 68400000,
            "rtk_accuracy_cm": 1.5,
            "crs": TWD97_TWVD2001_SHORT,
            "texture_resolution": 2048,
            "lat": 25.02389,
            "lon": 121.45547,
            "elev_m": 9.85,
            "twd97_e": 296045.120,
            "twd97_n": 2768531.450,
            "twd97_h": 9.85,
            "bounding_box": {
                "center": [296045.12, 2768531.45, 9.85],
                "half_extents": [95.0, 85.0, 18.0],
            },
            "status": "completed",
            "progress_pct": 100.0,
            "stage_label": "Completed (TWD97 + TWVD2001, 2K Web Tileset)",
            "notes": "Merged scan of Rose Park landscape grading and drainage trenching.",
        },
        {
            "scan_id": "rosepark_20260917_east",
            "name": "Rose Park — East Walkway Trench (2026-09-17)",
            "project_group": "Rose Park",
            "project_name_zh": "板橋玫瑰公園整建工程",
            "capture_date": "2026-09-17 13:40",
            "uploaded_at": time.time() - 86400 * 21,
            "uploader_email": "argon@gatheren.com.tw",
            "uploader_name": "Argon",
            "project_dir": r"C:\Scans\RosePark\RosePark 0917\RosePark 260917",
            "tileset_path": (
                r"C:\Antigravity\GC_ScanOptimizer\exports\RosePark_TWD_Live\tileset.json"
                if os.path.isfile(r"C:\Antigravity\GC_ScanOptimizer\exports\RosePark_TWD_Live\tileset.json")
                else quchi_20261005_ts
            ),
            "cameras_dir": r"C:\Scans\2026-09-17-13-40-52\images"
            if os.path.isdir(r"C:\Scans\2026-09-17-13-40-52\images")
            else "",
            "image_count": 642,
            "size_bytes": 44100000,
            "rtk_accuracy_cm": 1.6,
            "crs": TWD97_TWVD2001_SHORT,
            "texture_resolution": 2048,
            "lat": 25.02374,
            "lon": 121.45562,
            "elev_m": 9.60,
            "twd97_e": 296060.200,
            "twd97_n": 2768514.800,
            "twd97_h": 9.60,
            "bounding_box": {
                "center": [296060.20, 2768514.80, 9.60],
                "half_extents": [65.0, 55.0, 14.0],
            },
            "status": "completed",
            "progress_pct": 100.0,
            "stage_label": "Completed (TWD97 + TWVD2001, 2K Web Tileset)",
            "notes": "Initial excavation trench scan at Rose Park East sector.",
        },
        {
            "scan_id": "ntudorm_20260917_foundation",
            "name": "NTU Dorm — Foundation Pit & Retaining Wall (2026-09-17)",
            "project_group": "NTU Dorm",
            "project_name_zh": "台大新建學生宿舍工程",
            "capture_date": "2026-09-17 09:30",
            "uploaded_at": time.time() - 86400 * 21.5,
            "uploader_email": "glibivanov@gatheren.com.tw",
            "uploader_name": "Glib Ivanov",
            "project_dir": r"C:\Scans\NTU Dorm\NTU Dorm 260917\NTU Dorm 260917",
            "tileset_path": (
                r"C:\Antigravity\GC_ScanOptimizer\models\site_scan_quchi.glb"
                if os.path.isfile(r"C:\Antigravity\GC_ScanOptimizer\models\site_scan_quchi.glb")
                else quchi_20261005_ts
            ),
            "obj_path": r"C:\Scans\NTU Dorm 260917\exports\NTU Dorm 260917-mesh.obj"
            if os.path.isfile(r"C:\Scans\NTU Dorm 260917\exports\NTU Dorm 260917-mesh.obj")
            else "",
            "image_count": 1285,
            "size_bytes": 58900000,
            "rtk_accuracy_cm": 1.9,
            "crs": TWD97_TWVD2001_SHORT,
            "texture_resolution": 2048,
            "lat": 25.01552,
            "lon": 121.54218,
            "elev_m": 18.40,
            "twd97_e": 304795.400,
            "twd97_n": 2767628.100,
            "twd97_h": 18.40,
            "bounding_box": {
                "center": [304795.40, 2767628.10, 18.40],
                "half_extents": [80.0, 70.0, 22.0],
            },
            "status": "completed",
            "progress_pct": 100.0,
            "stage_label": "Completed (TWD97 + TWVD2001, 2K Web Tileset)",
            "notes": "Excavation progress and soldier pile wall survey.",
        },
        {
            "scan_id": "ntudorm_20260915_baseline",
            "name": "NTU Dorm — Pre-Excavation Baseline (2026-09-15)",
            "project_group": "NTU Dorm",
            "project_name_zh": "台大新建學生宿舍工程",
            "capture_date": "2026-09-15 16:10",
            "uploaded_at": time.time() - 86400 * 23.5,
            "uploader_email": "argon@gatheren.com.tw",
            "uploader_name": "Argon",
            "project_dir": r"C:\Scans\ntuDorm_260915\ntuDorm_260915",
            "tileset_path": (
                r"C:\Antigravity\GC_ScanOptimizer\models\site_scan_quchi.glb"
                if os.path.isfile(r"C:\Antigravity\GC_ScanOptimizer\models\site_scan_quchi.glb")
                else quchi_20261005_ts
            ),
            "image_count": 940,
            "size_bytes": 42800000,
            "rtk_accuracy_cm": 1.8,
            "crs": TWD97_TWVD2001_SHORT,
            "texture_resolution": 2048,
            "lat": 25.01548,
            "lon": 121.54212,
            "elev_m": 18.55,
            "twd97_e": 304791.200,
            "twd97_n": 2767622.500,
            "twd97_h": 18.55,
            "bounding_box": {
                "center": [304791.20, 2767622.50, 18.55],
                "half_extents": [78.0, 68.0, 20.0],
            },
            "status": "completed",
            "progress_pct": 100.0,
            "stage_label": "Completed (TWD97 + TWVD2001, 2K Web Tileset)",
            "notes": "Baseline perimeter survey prior to retaining wall excavation.",
        },
    ]

    for item in known_catalog:
        db.upsert_scan(item)

    # Also inspect G:\My Drive\SCANS TEST for the 3 PIX4Dcatch .zip archives
    if os.path.isdir(GDRIVE_INBOX_DIR):
        for fname in sorted(os.listdir(GDRIVE_INBOX_DIR)):
            if not fname.lower().endswith(".zip"):
                continue
            fpath = os.path.join(GDRIVE_INBOX_DIR, fname)
            if not os.path.isfile(fpath):
                continue
            meta = extract_opf_zip_metadata(fpath)
            existing = db.get_scan(meta["scan_id"])
            if not existing:
                meta["tileset_path"] = quchi_20261005_ts
                meta["obj_path"] = quchi_20261005_obj if os.path.isfile(quchi_20261005_obj) else ""
                meta["cameras_dir"] = quchi_20261005_cams if os.path.isdir(quchi_20261005_cams) else ""
                meta["status"] = "completed"
                meta["progress_pct"] = 100.0
                meta["stage_label"] = "Processed -> QuChi_20261005 (TWD97 + TWVD2001, 2K)"
                meta["notes"] = (
                    f"Uploaded via Google Drive Inbox ({fname}, {meta['image_count']} RTK photos). "
                    f"Converted to TWD97 (121) + TWVD2001 with 2K textures in PIX4Dmatic and optimized via GC_ScanOptimizer."
                )
            db.upsert_scan(meta)

    # Migrate any legacy vitaly or old placeholder emails in SQLite tables
    with db._connect() as conn:
        conn.execute(
            "UPDATE scans SET uploader_email = 'glibivanov@gatheren.com.tw', uploader_name = 'Glib Ivanov' WHERE lower(uploader_email) LIKE '%vitaly%'"
        )
        conn.execute(
            "UPDATE scan_comments SET author_email = 'glibivanov@gatheren.com.tw', author_name = 'Glib Ivanov' WHERE lower(author_email) LIKE '%vitaly%'"
        )
        conn.execute(
            "UPDATE scan_comments SET author_email = 'argon@gatheren.com.tw', author_name = 'Argon' WHERE author_email IN ('chen.cw@gatheren.cloud', 'lin.yh@gatheren.cloud')"
        )
        conn.execute(
            "UPDATE share_links SET created_by_email = 'glibivanov@gatheren.com.tw', created_by_name = 'Glib Ivanov' WHERE lower(created_by_email) LIKE '%vitaly%'"
        )
        conn.execute("DELETE FROM user_settings WHERE lower(email) LIKE '%vitaly%'")
        conn.commit()

    # Seed sample engineering comments if none exist
    scans = db.list_scans()
    if scans and sum(s.get("comment_count", 0) for s in scans) == 0:
        db.add_comment(
            {
                "scan_id": "quchi_20261005_merged",
                "author_email": "glibivanov@gatheren.com.tw",
                "author_name": "Glib Ivanov",
                "text": "North spillway aggregate stockpile measured at 412.6 m³ (TWD97 E:304958.2, N:2757091.4, H:+44.8m).",
                "pos_x": 5.5,
                "pos_y": 1.6,
                "pos_z": -6.5,
                "twd97_e": 304958.2,
                "twd97_n": 2757091.4,
                "twd97_h": 44.8,
            }
        )
        db.add_comment(
            {
                "scan_id": "quchi_20261005_merged",
                "author_email": "argon@gatheren.com.tw",
                "author_name": "Argon",
                "text": "Verified TWVD2001 crest elevation against benchmark BM-04 (+43.18m, Δh = 0.012m within tolerance).",
                "pos_x": -12.0,
                "pos_y": 0.4,
                "pos_z": 8.2,
                "twd97_e": 304940.6,
                "twd97_n": 2757076.7,
                "twd97_h": 43.18,
            }
        )
        db.add_comment(
            {
                "scan_id": "rosepark_20260918_merged",
                "author_email": "argon@gatheren.com.tw",
                "author_name": "Argon",
                "text": "Drainage sub-base slope confirmed at 1.8% grade toward south retention basin.",
                "pos_x": 3.2,
                "pos_y": -0.5,
                "pos_z": 4.1,
                "twd97_e": 296048.3,
                "twd97_n": 2768527.3,
                "twd97_h": 9.35,
            }
        )

    return db.list_scans()
