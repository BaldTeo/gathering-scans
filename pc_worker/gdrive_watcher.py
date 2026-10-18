#!/usr/bin/env python3
r"""
Google Drive Inbox Watcher & OPF / Pix4DCatch Metadata Extractor
Reads Pix4DCatch .zip archives in G:\My Drive\SCANS TEST (and extracted OPF folders in C:\Scans),
extracts RTK GPS coordinates, image count, accuracy sigmas, uploader account, and timestamp,
converts coordinates to TWD97 (121) + TWVD2001 (EPSG:3826+8904) and WGS84,
and populates the Smart Priority Queue.
"""

import os
import re
import json
import time
import math
import shutil
import zipfile
from datetime import datetime
from typing import Dict, Any, List, Optional, Tuple

from pc_worker.config import (
    GDRIVE_INBOX_DIR,
    LEGACY_GDRIVE_INBOX_DIR,
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


def _infer_project_prefix(hint_name: str) -> str:
    """
    Infers a clean human-readable project name from a folder or archive name
    (e.g., 'BridgeNorth_20261015_1of4' -> 'BridgeNorth', 'Taoyuan_MRT_261015' -> 'Taoyuan MRT').
    Returns '' if the name is purely a numeric timestamp like '2026-10-05-15-37-05'.
    """
    if not hint_name:
        return ""
    stem = os.path.splitext(os.path.basename(hint_name.strip("\\/")))[0]
    # Strip trailing date/part tokens like _20261005, _260917, _1of4, _Compressed, _Merged
    cleaned = re.sub(
        r"([_\-\s]+(20\d{6}|\d{6}|\d{4}[\-_]\d{2}[\-_]\d{2}.*|\d+\s*of\s*\d+|compressed|merged\d*|sector\d*|part\d*|\d+))+$",
        "",
        stem,
        flags=re.IGNORECASE,
    ).strip(" _-()")
    if not cleaned or re.match(r"^[\d\-_]+$", cleaned) or cleaned.lower() in ("catch", "scan", "scans", "export", "tileset"):
        return ""
    low = cleaned.lower().replace("_", "").replace("-", "").replace(" ", "")
    if "quchi" in low:
        return "QuChi Dam"
    if "rosepark" in low or "rose" in low:
        return "Rose Park"
    if "ntudorm" in low or "ntu" in low:
        return "NTU Dorm"
    return cleaned.replace("_", " ").strip()


def match_project_group(
    lat: float,
    lon: float,
    hint_name: str = "",
    parent_project: str = "",
    dynamic_clusters: Optional[List[Dict[str, Any]]] = None,
) -> Tuple[str, str]:
    """
    Project-agnostic resolver that scales to 100+ engineering projects:
    1. Explicit parent project folder name (e.g., C:\\GatheringScans\\<Project>\\<Scan>)
    2. Spatial proximity match (<= radius_m) against known + dynamically discovered project clusters
    3. Project prefix inferred from folder/archive filename (e.g., 'ProjectX_20261015.zip' -> 'ProjectX')
    4. Coordinate-based site cluster fallback ('Site (24.9203N, 121.5435E)')
    """
    if parent_project and parent_project.strip():
        pg = parent_project.strip()
        for p in KNOWN_PROJECTS:
            if p["project_group"].lower() == pg.lower():
                return p["project_group"], p["project_name_zh"]
        return pg, f"{pg} 工程掃描群組"

    candidates = list(KNOWN_PROJECTS)
    reg_file = os.path.join(LOCAL_SCANS_ROOT, "projects_registry.json")
    if os.path.isfile(reg_file):
        try:
            with open(reg_file, "r", encoding="utf-8") as rf:
                extra = json.load(rf)
                if isinstance(extra, list):
                    candidates.extend(extra)
        except Exception:
            pass
    if dynamic_clusters:
        candidates.extend(dynamic_clusters)

    best = None
    best_dist = 1e12
    for p in candidates:
        try:
            d = haversine_m(lat, lon, float(p["lat"]), float(p["lon"]))
            rad = float(p.get("radius_m", 600.0))
            if d <= rad and d < best_dist:
                best = p
                best_dist = d
        except Exception:
            continue
    if best:
        return best["project_group"], best.get("project_name_zh") or f"{best['project_group']} 工程掃描群組"

    inferred = _infer_project_prefix(hint_name)
    if inferred:
        for p in candidates:
            if p["project_group"].lower() == inferred.lower():
                return p["project_group"], p.get("project_name_zh") or f"{inferred} 工程掃描群組"
        return inferred, f"{inferred} 工程掃描群組"

    return f"Site ({lat:.4f}N, {lon:.4f}E)", "新增工區掃描點"


GATHEREN_DRIVEFS_USER_MAP: Dict[str, Tuple[str, str, str, str]] = {
    "0B9iDvpnqzFdI": ("雲在天", "glibivanov@gatheren.com.tw", "工務/BIM", "#14b8a6"),
    "0B_7euqQkEuTc": ("趙冠人", "frankchao@gatheren.com.tw", "總經理", "#ef4444"),
    "0B4ivIGgbWwve": ("胡佳雯", "wenhu@gatheren.com.tw", "行政/管理", "#ec4899"),
    "0B8KUfOzTj-EC": ("薛鈞豪", "HowardHsueh@gatheren.com.tw", "工務/專案", "#3b82f6"),
    "0BzHb4wJMZJa4": ("蘇容德", "litasu@gatheren.com.tw", "成控/採購", "#a855f7"),
    "0B1JR5X9StbPX": ("楊斯顯", "szhsienyang@gatheren.com.tw", "工務/品管", "#f97316"),
    "0B2Yj38NHCSUd": ("黃聖文", "shengwenhuang@gatheren.com.tw", "工務工程師", "#eab308"),
    "0B34fkGa3yIcF": ("鄭宇翔", "leocheng@gatheren.com.tw", "工務工程師", "#06b6d4"),
    "0B52Y9wroxqHr": ("駱介正", "JasonLo@gatheren.com.tw", "財務經理", "#6366f1"),
    "0B8PgVwzUHnRd": ("游忠偉", "kentyu@gatheren.com.tw", "工務/訪價", "#10b981"),
    "0ByiKtcWmlGtI": ("葉烝佑", "ChengYouYeh@gatheren.com.tw", "工務工程師", "#84cc16"),
    "0Bz9icckT3CZZ": ("王騰德", "tengtewang@gatheren.com.tw", "工務經理", "#0ea5e9"),
    "0BziTTOFSCVhJ": ("陳聰榮", "congrongchen@gatheren.com.tw", "工務人員", "#f59e0b"),
    "0B5fGwAtfvOyh": ("李振嘉", "edwardli@gatheren.com.tw", "工務工程師", "#8b5cf6"),
    "0B6EWVm5brWwN": ("孫暐岑", "neilsun@gatheren.com.tw", "工務工程師", "#22c55e"),
    "0Bx93O1IxaYa5": ("陳冠羽", "kevinchen@gatheren.com.tw", "機電/工務", "#d946ef"),
}

GATHEREN_EMAIL_TO_NAME: Dict[str, str] = {
    info[1].lower(): info[0] for info in GATHEREN_DRIVEFS_USER_MAP.values()
}

_DRIVEFS_CACHE: Dict[str, Any] = {"ts": 0.0, "by_title": {}}


def _resolve_drivefs_uploader(name_or_path: str) -> Tuple[str, str]:
    """
    Procedurally reads Google Drive for Desktop local metadata_sqlite_db to resolve
    the actual Google Account display name (Chinese name) and email for a scan file/folder.
    """
    now = time.time()
    if now - _DRIVEFS_CACHE["ts"] > 45.0 or not _DRIVEFS_CACHE["by_title"]:
        by_title: Dict[str, Tuple[str, str]] = {}
        try:
            import glob
            import sqlite3

            local_app = os.environ.get("LOCALAPPDATA", "")
            if local_app:
                candidates = glob.glob(os.path.join(local_app, "Google", "DriveFS", "*", "metadata_sqlite_db"))
                db_src = max(candidates, key=os.path.getsize) if candidates else None
                if db_src and os.path.isfile(db_src):
                    con = sqlite3.connect(f"file:{db_src}?mode=ro", uri=True)
                    con.text_factory = bytes
                    cur = con.cursor()
                    cur.execute("SELECT local_title, proto FROM items WHERE trashed=0 AND proto IS NOT NULL")
                    for title_b, proto in cur.fetchall():
                        if not title_b or not proto:
                            continue
                        m = re.findall(b"0B[A-Za-z0-9_-]{11}", proto)
                        if not m:
                            continue
                        u_pref = m[-1].decode("ascii", errors="ignore")
                        u_info = GATHEREN_DRIVEFS_USER_MAP.get(u_pref)
                        if u_info:
                            t_str = title_b.decode("utf-8", errors="ignore").strip().lower()
                            by_title[t_str] = (u_info[0], u_info[1])
                            stem = os.path.splitext(t_str)[0]
                            by_title[stem] = (u_info[0], u_info[1])
                    con.close()
        except Exception:
            pass
        _DRIVEFS_CACHE["ts"] = now
        _DRIVEFS_CACHE["by_title"] = by_title

    by_title = _DRIVEFS_CACHE.get("by_title") or {}
    base = os.path.basename(name_or_path.rstrip("/\\")).strip().lower()
    stem = os.path.splitext(base)[0]
    for candidate in (base, stem, f"{stem}.3tz", f"{stem}.zip", stem.replace("catch_", "")):
        if candidate in by_title:
            return by_title[candidate]
    return ("雲在天", "glibivanov@gatheren.com.tw")


def normalize_gatheren_uploader(uploader_name: str, uploader_email: str, hint_path: str = "") -> Tuple[str, str]:
    """
    Ensures uploader metadata uses the real Google Account Chinese display name
    rather than legacy hardcoded English placeholders ('Glib Ivanov', 'Argon').
    """
    email = (uploader_email or "").strip() or "glibivanov@gatheren.com.tw"
    if email.lower() in ("glib@gatheren.com.tw", "argon@gatheren.com.tw"):
        email = "glibivanov@gatheren.com.tw"
    name = (uploader_name or "").strip()
    if hint_path and (not name or name.lower() in ("glib ivanov", "glibivanov", "argon", "admin", "system")):
        dfs_name, dfs_email = _resolve_drivefs_uploader(hint_path)
        return dfs_name, dfs_email
    mapped_zh = GATHEREN_EMAIL_TO_NAME.get(email.lower())
    if mapped_zh and (not name or name.lower() in ("glib ivanov", "glibivanov", "argon")):
        return mapped_zh, email
    if not name or name.lower() in ("glib ivanov", "glibivanov", "argon"):
        return "雲在天", email
    return name, email


def extract_opf_zip_metadata(zip_path: str) -> Dict[str, Any]:
    """
    Fast (<50ms) metadata extractor for Pix4DCatch 'Export to PIX4Dmatic' .zip archives.
    Reads OPF JSON headers directly from the ZIP central directory without unpacking images.
    """
    stat = os.stat(zip_path)
    bname = os.path.splitext(os.path.basename(zip_path))[0]
    dfs_name, dfs_email = _resolve_drivefs_uploader(zip_path)
    info: Dict[str, Any] = {
        "scan_id": f"catch_{bname.replace('-', '_')}",
        "name": bname,
        "source_zip_path": zip_path,
        "size_bytes": stat.st_size,
        "uploaded_at": stat.st_mtime,
        "capture_date": bname[:10] + " " + bname[11:16].replace("-", ":")
        if len(bname) >= 16 and bname[4] == "-"
        else datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M"),
        "uploader_email": dfs_email,
        "uploader_name": dfs_name,
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
            raw_email = sdata.get("uploader_email", info["uploader_email"])
            raw_name = sdata.get("uploader_name", info["uploader_name"])
            info["uploader_name"], info["uploader_email"] = normalize_gatheren_uploader(raw_name, raw_email, zip_path)
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

    proj_group, proj_zh = match_project_group(info["lat"], info["lon"], hint_name=bname)
    info["project_group"] = proj_group
    info["project_name_zh"] = proj_zh
    return info


def _extract_tileset_georef_and_fix_axis(tileset_path: str) -> Dict[str, Any]:
    """
    Inspects a 3D Tiles tileset.json on disk:
    1. Automatically removes erroneous 'gltfUpAxis': 'z' when child tiles are Y-up .glb files (PIX4Dmatic export quirk).
    2. Extracts TWD97 (E, N, H) and WGS84 (lat, lon) coordinates directly from root.transform / root.boundingVolume.
    """
    out: Dict[str, Any] = {}
    if not (tileset_path and os.path.isfile(tileset_path) and tileset_path.lower().endswith(".json")):
        return out
    try:
        with open(tileset_path, "r", encoding="utf-8") as f:
            ts = json.load(f)
        asset = ts.get("asset") or {}
        raw_str = json.dumps(ts)
        if str(asset.get("gltfUpAxis", "")).lower() == "z" and ".glb" in raw_str.lower():
            asset.pop("gltfUpAxis", None)
            ts["asset"] = asset
            try:
                with open(tileset_path, "w", encoding="utf-8") as wf:
                    json.dump(ts, wf, indent=2)
            except Exception:
                pass

        root = ts.get("root") or {}
        transform = root.get("transform")
        bv = root.get("boundingVolume") or {}
        box = bv.get("box")
        region = bv.get("region")

        tx, ty, tz = 0.0, 0.0, 0.0
        if isinstance(transform, list) and len(transform) >= 16:
            tx = float(transform[12] or 0.0)
            ty = float(transform[13] or 0.0)
            tz = float(transform[14] or 0.0)

        bx, by, bz = 0.0, 0.0, 0.0
        if isinstance(box, list) and len(box) >= 3:
            bx = float(box[0] or 0.0)
            by = float(box[1] or 0.0)
            bz = float(box[2] or 0.0)

        cx = tx if abs(tx) > 1000 else bx
        cy = ty if abs(ty) > 1000 else by
        cz = tz if abs(tz) > 0.01 else bz

        if isinstance(box, list) and len(box) >= 12:
            hx = abs(float(box[3] or 0.0)) or 120.0
            hy = abs(float(box[7] or 0.0)) or 120.0
            hz = abs(float(box[11] or 0.0)) or 30.0
            out["half_extents"] = [round(hx, 2), round(hy, 2), round(hz, 2)]

        # In Taiwan (lon <= 122.0E), TWD97 TM2-121 Easting is strictly <= 345,000m;
        # Eastings around 345,000..400,000m in Northern Taiwan are WGS84 / UTM Zone 51N (EPSG:32651).
        if 150000.0 <= cx <= 345000.0 and 2400000.0 <= cy <= 2850000.0:
            lat, lon = twd97_to_wgs84(cx, cy)
            out.update(
                {
                    "lat": lat,
                    "lon": lon,
                    "elev_m": round(cz, 2),
                    "twd97_e": round(cx, 3),
                    "twd97_n": round(cy, 3),
                    "twd97_h": round(cz, 2),
                }
            )
        elif 100000.0 <= cx <= 850000.0 and 2500000.0 <= cy <= 3000000.0:
            lat, lon = utm51n_to_wgs84(cx, cy)
            twd_e, twd_n, twd_h = wgs84_to_twd97(lat, lon, cz)
            out.update(
                {
                    "lat": lat,
                    "lon": lon,
                    "elev_m": twd_h,
                    "twd97_e": twd_e,
                    "twd97_n": twd_n,
                    "twd97_h": twd_h,
                }
            )
        elif abs(tx) > 1000000.0 and abs(ty) > 1000000.0:
            # ECEF (EPSG:4978) root.transform (e.g. PIX4Dmatic *-cesium_mesh.json)
            a = 6378137.0
            f = 1.0 / 298.257223563
            e2 = 2.0 * f - f * f
            b = a * (1.0 - f)
            ep2 = (a * a - b * b) / (b * b)
            p = math.hypot(tx, ty)
            th = math.atan2(a * tz, b * p)
            lon = math.degrees(math.atan2(ty, tx))
            lat = math.degrees(
                math.atan2(
                    tz + ep2 * b * (math.sin(th) ** 3),
                    p - e2 * a * (math.cos(th) ** 3),
                )
            )
            sin_lat = math.sin(math.radians(lat))
            N = a / math.sqrt(1.0 - e2 * sin_lat * sin_lat)
            elev = p / max(math.cos(math.radians(lat)), 1e-9) - N
            twd_e, twd_n, twd_h = wgs84_to_twd97(lat, lon, max(0.0, elev))
            out.update(
                {
                    "lat": round(lat, 6),
                    "lon": round(lon, 6),
                    "elev_m": twd_h,
                    "twd97_e": twd_e,
                    "twd97_n": twd_n,
                    "twd97_h": twd_h,
                }
            )
        elif isinstance(region, list) and len(region) >= 5:
            lon = math.degrees((float(region[0]) + float(region[2])) * 0.5)
            lat = math.degrees((float(region[1]) + float(region[3])) * 0.5)
            elev = float(region[4] or 40.0)
            twd_e, twd_n, twd_h = wgs84_to_twd97(lat, lon, elev)
            out.update(
                {
                    "lat": round(lat, 6),
                    "lon": round(lon, 6),
                    "elev_m": twd_h,
                    "twd97_e": twd_e,
                    "twd97_n": twd_n,
                    "twd97_h": twd_h,
                }
            )
    except Exception:
        pass
    return out


def _compute_folder_stats(folder_path: str) -> Tuple[int, int]:
    """Computes total bytes on disk and exact input photo count for a scan folder."""
    total_bytes = 0
    direct_photo_count = 0
    p4m_candidates: List[str] = []
    log_candidates: List[str] = []
    try:
        # 1. Recursively count input images across inputs/** and images/** (including multi-part sub-folders)
        for img_root_name in ("inputs", "Inputs", "images", "Images"):
            img_root = os.path.join(folder_path, img_root_name)
            if os.path.isdir(img_root):
                count_in_root = 0
                for r, _, fls in os.walk(img_root):
                    for fn in fls:
                        if fn.lower().endswith((".jpg", ".jpeg", ".png")):
                            count_in_root += 1
                if count_in_root > 0:
                    direct_photo_count = max(direct_photo_count, count_in_root)

        # 2. Walk folder for total disk size and collect any root.p4m / log files if images aren't stored locally
        for root, dirs, files in os.walk(folder_path):
            for fn in files:
                fpath = os.path.join(root, fn)
                try:
                    total_bytes += os.path.getsize(fpath)
                except OSError:
                    pass
                low_fn = fn.lower()
                if low_fn.endswith(".p4m"):
                    p4m_candidates.append(fpath)
                elif low_fn.endswith(".log") and "logs" in root.lower():
                    log_candidates.append(fpath)

        # 3. If no raw images directory is on disk, extract exact camera count from PIX4Dmatic root.p4m binary
        if direct_photo_count == 0 and p4m_candidates:
            for p4m_path in p4m_candidates:
                try:
                    with open(p4m_path, "rb") as pf:
                        data = pf.read()
                    matches = re.findall(rb"[^\x00-\x1f\x7f-\xff]+?\.(?:jpg|jpeg|JPG|JPEG)", data)
                    bnames = {os.path.basename(m.decode("utf-8", errors="ignore")) for m in matches}
                    if len(bnames) > direct_photo_count:
                        direct_photo_count = len(bnames)
                except Exception:
                    pass

        # 4. Fallback to PIX4Dmatic log '[Add N image(s)]'
        if direct_photo_count == 0 and log_candidates:
            for lpath in log_candidates:
                try:
                    with open(lpath, "r", encoding="utf-8", errors="ignore") as lf:
                        txt = lf.read()
                    m_add = re.findall(r"\[Add\s+(\d+)\s+image\(s\)\]", txt)
                    if m_add:
                        direct_photo_count = max(direct_photo_count, max(int(x) for x in m_add))
                except Exception:
                    pass
    except Exception:
        pass
    return max(total_bytes, 1024), direct_photo_count


def _compute_scan_covered_area_m2(folder_path: str, tileset_path: str, half_extents: List[float]) -> float:
    """Computes or reads the 2D planar covered area (in m^2) of the 3D scan from its DSM hull mask or bounding box."""
    candidates = [os.path.join(folder_path, "_dsm_cache_v3.npz")]
    if tileset_path:
        candidates.append(os.path.join(os.path.dirname(tileset_path), "_dsm_cache_v3.npz"))
    for npz_path in candidates:
        if os.path.isfile(npz_path):
            try:
                import numpy as np
                data = np.load(npz_path)
                hull_mask = data["hull_mask"]
                res = float(np.asarray(data["res"]).flat[0])
                area = float(np.sum(hull_mask) * (res * res))
                if area > 10.0:
                    return round(area, 1)
            except Exception:
                pass
    if isinstance(half_extents, list) and len(half_extents) >= 2:
        hx = max(float(half_extents[0] or 0.0), 10.0)
        hy = max(float(half_extents[1] or 0.0), 10.0)
        return round((hx * 2.0) * (hy * 2.0) * 0.68, 1)
    return 15000.0



def _infer_capture_date_from_name(folder_name: str, fallback_mtime: float) -> str:
    """Extracts YYYY-MM-DD from folder names like QuChi_20261015-obj_mesh or NTU_Dorm_260915."""
    time_part = datetime.fromtimestamp(fallback_mtime).strftime("%H:%M")
    m8 = re.search(r"(20\d{2})([01]\d)([0-3]\d)", folder_name)
    if m8:
        return f"{m8.group(1)}-{m8.group(2)}-{m8.group(3)} {time_part}"
    m6 = re.search(r"(?<!\d)(2\d)([01]\d)([0-3]\d)(?!\d)", folder_name)
    if m6:
        return f"20{m6.group(1)}-{m6.group(2)}-{m6.group(3)} {time_part}"
    return datetime.fromtimestamp(fallback_mtime).strftime("%Y-%m-%d %H:%M")


INTERNAL_ASSET_DIRS = {
    "content",
    "subtrees",
    "tiles",
    "tileset",
    "inputs",
    "images",
    "exports",
    "processing",
    "configs",
    "logs",
    "temp",
    "project",
    "preview_low",
}


def _is_direct_scan_folder(folder_path: str) -> bool:
    """
    Returns True if folder_path itself is directly a scan folder (contains scan_meta.json,
    tileset.json, *-cesium_mesh.json, *.obj, or *.glb at root, or tileset/tileset.json).
    """
    if not os.path.isdir(folder_path):
        return False
    if os.path.isfile(os.path.join(folder_path, "tileset", "tileset.json")):
        return True
    try:
        for fn in os.listdir(folder_path):
            low = fn.lower()
            if os.path.isfile(os.path.join(folder_path, fn)) and (
                low in ("scan_meta.json", "tileset.json")
                or low.endswith("-cesium_mesh.json")
                or low.endswith(".obj")
                or low.endswith(".glb")
            ):
                return True
    except Exception:
        pass
    return False


def _folder_has_completed_scan_assets(folder_path: str) -> bool:
    """Checks if a folder contains completed scan assets (.obj, .glb, tileset.json, *-cesium_mesh.json, scan_meta.json)."""
    if not os.path.isdir(folder_path):
        return False
    folder_name = os.path.basename(folder_path.rstrip("\\/"))
    if folder_name.lower() in INTERNAL_ASSET_DIRS:
        return False
    for root, _, files in os.walk(folder_path):
        rel_depth = os.path.relpath(root, folder_path).count(os.sep)
        if rel_depth > 2:
            continue
        for fn in files:
            low = fn.lower()
            if (
                low in ("tileset.json", "scan_meta.json")
                or low.endswith("-cesium_mesh.json")
                or low.endswith(".obj")
                or (low.endswith(".glb") and rel_depth <= 1)
            ):
                return True
    return False


def _sync_gdrive_folder_to_local_vault(src_folder: str, parent_project: str = "") -> Optional[str]:
    """
    Copies a completed scan folder from Google Drive (input-only inbox) into local disk storage
    (C:\\GatheringScans\\<FolderName> or C:\\GatheringScans\\<ProjectName>\\<FolderName>).
    Returns the local destination path if scan assets exist, or None otherwise.
    """
    if not _folder_has_completed_scan_assets(src_folder):
        return None
    folder_name = os.path.basename(src_folder.rstrip("\\/"))
    if not folder_name or folder_name.startswith(("_", ".")) or folder_name.lower() in INTERNAL_ASSET_DIRS:
        return None

    if parent_project:
        dst_folder = os.path.join(LOCAL_SCANS_ROOT, parent_project, folder_name)
    else:
        dst_folder = os.path.join(LOCAL_SCANS_ROOT, folder_name)

    if not is_safe_jailed_path(dst_folder, LOCAL_SCANS_ROOT):
        return None

    was_new_local_dir = not os.path.isdir(dst_folder)
    origin_marker = os.path.join(dst_folder, ".gdrive_inbox_origin.json")
    os.makedirs(dst_folder, exist_ok=True)
    if was_new_local_dir or os.path.isfile(origin_marker):
        try:
            with open(origin_marker, "w", encoding="utf-8") as mf:
                json.dump({"src_folder": src_folder, "synced_at": time.time()}, mf)
        except Exception:
            pass

    copied_any = False
    for root, dirs, files in os.walk(src_folder):
        rel_dir = os.path.relpath(root, src_folder)
        target_dir = dst_folder if rel_dir == "." else os.path.join(dst_folder, rel_dir)
        os.makedirs(target_dir, exist_ok=True)
        for fn in files:
            if fn.startswith("."):
                continue
            s_file = os.path.join(root, fn)
            d_file = os.path.join(target_dir, fn)
            try:
                s_stat = os.stat(s_file)
                need_copy = True
                if os.path.isfile(d_file):
                    d_stat = os.stat(d_file)
                    if d_stat.st_size == s_stat.st_size and abs(d_stat.st_mtime - s_stat.st_mtime) < 2.0:
                        need_copy = False
                if need_copy:
                    shutil.copy2(s_file, d_file)
                    copied_any = True
            except Exception as e:
                print(f"[GDriveWatcher] Warning copying {s_file} -> {d_file}: {e}")

    if copied_any:
        print(f"[GDriveWatcher] Synced completed scan folder from Google Drive to local disk: {src_folder} -> {dst_folder}")
    return dst_folder


def _discover_folder_scan_item(
    folder_path: str,
    parent_project: str = "",
    dynamic_clusters: Optional[List[Dict[str, Any]]] = None,
) -> Optional[Dict[str, Any]]:
    """
    Dynamically inspects a scan folder inside C:\\GatheringScans (either flat or nested inside a project folder).
    Reads scan_meta.json if present, or auto-detects tileset.json / *-cesium_mesh.json / .glb / mesh.obj / thumbnail.png.
    """
    folder_name = os.path.basename(folder_path.rstrip("\\/"))
    if not folder_name or folder_name.startswith(("_", ".")) or folder_name.lower() in INTERNAL_ASSET_DIRS:
        return None

    meta_file = os.path.join(folder_path, "scan_meta.json")
    meta: Dict[str, Any] = {}
    if os.path.isfile(meta_file):
        try:
            with open(meta_file, "r", encoding="utf-8") as f:
                meta = json.load(f)
        except Exception as e:
            print(f"[GDriveWatcher] Warning reading {meta_file}: {e}")

    # Auto-detect tileset.json, .glb, or .obj inside folder_path (only direct or depth <= 2)
    tileset_path = meta.get("tileset_path", "")
    obj_candidates: List[str] = []
    if not (tileset_path and os.path.isfile(tileset_path)):
        candidate_ts = [
            os.path.join(folder_path, "tileset", "tileset.json"),
            os.path.join(folder_path, "tileset.json"),
        ]
        glb_fallbacks = []
        for root, _, files in os.walk(folder_path):
            rel_depth = os.path.relpath(root, folder_path).count(os.sep)
            if rel_depth > 2:
                continue
            for fn in files:
                low_fn = fn.lower()
                if low_fn == "tileset.json" or low_fn.endswith("-cesium_mesh.json"):
                    candidate_ts.append(os.path.join(root, fn))
                elif low_fn.endswith(".glb") and rel_depth <= 1:
                    glb_fallbacks.append(os.path.join(root, fn))
                elif low_fn.endswith(".obj") and rel_depth <= 2:
                    obj_candidates.append(os.path.join(root, fn))
        for c in candidate_ts + glb_fallbacks:
            if os.path.isfile(c):
                tileset_path = c
                break
    else:
        for root, _, files in os.walk(folder_path):
            rel_depth = os.path.relpath(root, folder_path).count(os.sep)
            if rel_depth > 2:
                continue
            for fn in files:
                if fn.lower().endswith(".obj"):
                    obj_candidates.append(os.path.join(root, fn))

    # Auto-detect obj_path if not already valid
    obj_path = meta.get("obj_path", "")
    if not (obj_path and os.path.isfile(obj_path)):
        cand_obj = os.path.join(folder_path, "mesh.obj")
        if os.path.isfile(cand_obj):
            obj_path = cand_obj
        elif obj_candidates:
            obj_path = obj_candidates[0]
        else:
            obj_path = ""

    # If a completed .obj mesh was dropped without a 3D tileset, auto-build a 2K quadtree tileset on local disk
    if not (tileset_path and os.path.isfile(tileset_path)) and obj_path and os.path.isfile(obj_path):
        try:
            import sys
            from pc_worker.config import GC_SCAN_OPTIMIZER_DIR
            if GC_SCAN_OPTIMIZER_DIR and os.path.isdir(GC_SCAN_OPTIMIZER_DIR) and GC_SCAN_OPTIMIZER_DIR not in sys.path:
                sys.path.insert(0, GC_SCAN_OPTIMIZER_DIR)
            from optimizer.quadtree_tiler import QuadtreeTiler  # type: ignore
            auto_ts_dir = os.path.join(folder_path, "tileset")
            os.makedirs(auto_ts_dir, exist_ok=True)
            print(f"[GDriveWatcher] Auto-tiling standalone OBJ mesh on local disk: {obj_path} -> {auto_ts_dir}")
            tiler = QuadtreeTiler(
                input_path=obj_path,
                output_dir=auto_ts_dir,
                max_levels=3,
                texture_quality=7,
                texture_limit=PIX4DMATIC_TEXTURE_SIZE,
                high_compression=True,
                verbose=True,
            )
            tiler.run()
            built_ts = os.path.join(auto_ts_dir, "tileset.json")
            if os.path.isfile(built_ts):
                tileset_path = built_ts
        except Exception as e:
            print(f"[GDriveWatcher] Warning auto-tiling standalone OBJ {obj_path}: {e}")

    if not (tileset_path and os.path.isfile(tileset_path)):
        return None

    stat = os.stat(folder_path)
    default_id = (
        folder_name
        if folder_name.lower().startswith("catch_")
        else re.sub(r"[^a-zA-Z0-9_]", "_", folder_name.lower())
    )
    scan_id = meta.get("scan_id") or default_id
    if scan_id.lower().startswith("catch_") and folder_name.lower().startswith("catch_"):
        scan_id = folder_name

    try:
        from pc_worker.preview_generator import (
            ensure_scan_low_quality_preview,
            ensure_scan_full_quality_thumbnail,
        )

        ensure_scan_low_quality_preview(tileset_path, force=False)
        ensure_scan_full_quality_thumbnail(tileset_path, scan_id, project_dir=folder_path, force=False)
    except Exception as e:
        print(f"[GDriveWatcher] Warning generating preview/thumbnail for {tileset_path}: {e}")

    ts_georef = _extract_tileset_georef_and_fix_axis(tileset_path)

    # Auto-detect cameras_dir
    cameras_dir = meta.get("cameras_dir", "")
    if not (cameras_dir and os.path.isdir(cameras_dir)):
        for sub in ("inputs", "Inputs", "images", "Images"):
            cdir = os.path.join(folder_path, sub)
            if os.path.isdir(cdir):
                cameras_dir = cdir
                break
    lat = float(meta.get("lat") or ts_georef.get("lat") or 24.92032)
    lon = float(meta.get("lon") or ts_georef.get("lon") or 121.54351)
    elev_m = float(meta.get("elev_m") or ts_georef.get("elev_m") or 43.18)
    twd_e = float(meta.get("twd97_e") or ts_georef.get("twd97_e") or 304952.656)
    twd_n = float(meta.get("twd97_n") or ts_georef.get("twd97_n") or 2757084.875)
    twd_h = float(meta.get("twd97_h") or ts_georef.get("twd97_h") or elev_m)
    proj_group = meta.get("project_group")
    proj_zh = meta.get("project_name_zh")
    if not proj_group:
        proj_group, proj_zh = match_project_group(
            lat,
            lon,
            hint_name=folder_name,
            parent_project=parent_project,
            dynamic_clusters=dynamic_clusters,
        )

    if dynamic_clusters is not None and not any(c.get("project_group") == proj_group for c in dynamic_clusters):
        dynamic_clusters.append(
            {
                "project_group": proj_group,
                "project_name_zh": proj_zh or f"{proj_group} 工程掃描群組",
                "lat": lat,
                "lon": lon,
                "radius_m": 600.0,
            }
        )

    disk_bytes, est_imgs = (0, 0)
    raw_meta_imgs = int(meta.get("image_count") or 0)
    if "size_bytes" not in meta or raw_meta_imgs <= 0 or raw_meta_imgs > 25000:
        disk_bytes, est_imgs = _compute_folder_stats(folder_path)
        if raw_meta_imgs > 25000:
            raw_meta_imgs = est_imgs

    half_extents = ts_georef.get("half_extents", [120.0, 120.0, 30.0])
    covered_area_m2 = float(meta.get("covered_area_m2") or 0.0)
    if covered_area_m2 <= 0.0:
        covered_area_m2 = _compute_scan_covered_area_m2(folder_path, tileset_path, half_extents)

    user_edited = bool(meta.get("user_edited_name"))
    default_display_name = folder_name[6:] if folder_name.lower().startswith("catch_") and len(folder_name) > 6 else folder_name
    resolved_name = (meta.get("name") or "").strip() if user_edited else default_display_name
    if not resolved_name:
        resolved_name = default_display_name

    resolved_uploader_name, resolved_uploader_email = normalize_gatheren_uploader(
        meta.get("uploader_name", ""),
        meta.get("uploader_email", "glibivanov@gatheren.com.tw"),
        meta.get("source_zip_path") or folder_name,
    )

    result_item = {
        "scan_id": scan_id,
        "name": resolved_name,
        "user_edited_name": 1 if user_edited else 0,
        "project_group": proj_group,
        "project_name_zh": proj_zh or "工程掃描群組",
        "capture_date": meta.get("capture_date") or _infer_capture_date_from_name(folder_name, stat.st_mtime),
        "uploaded_at": float(meta.get("uploaded_at", stat.st_mtime)),
        "uploader_email": resolved_uploader_email,
        "uploader_name": resolved_uploader_name,
        "source_zip_path": meta.get("source_zip_path", ""),
        "project_dir": folder_path,
        "tileset_path": tileset_path,
        "obj_path": obj_path,
        "cameras_dir": cameras_dir,
        "image_count": int(raw_meta_imgs or est_imgs or 1200),
        "size_bytes": int(meta.get("size_bytes") or disk_bytes or 64000000),
        "covered_area_m2": round(covered_area_m2, 1),
        "rtk_accuracy_cm": float(meta.get("rtk_accuracy_cm", 1.5)),
        "crs": meta.get("crs", TWD97_TWVD2001_SHORT),
        "texture_resolution": int(meta.get("texture_resolution", PIX4DMATIC_TEXTURE_SIZE)),
        "lat": lat,
        "lon": lon,
        "elev_m": elev_m,
        "twd97_e": twd_e,
        "twd97_n": twd_n,
        "twd97_h": twd_h,
        "bounding_box": meta.get(
            "bounding_box",
            {
                "center": [twd_e, twd_n, twd_h],
                "half_extents": half_extents,
            },
        ),
        "status": meta.get("status", "completed"),
        "progress_pct": float(meta.get("progress_pct", 100.0)),
        "stage_label": meta.get("stage_label", "Completed (TWD97 + TWVD2001, 2K Web Tileset)"),
        "notes": meta.get("notes", f"Dynamically loaded from {folder_path}"),
    }

    # Persist scan_meta.json on local disk if it did not exist yet, lacked covered_area_m2, or had a non-user-edited fake name
    need_write_meta = (
        not os.path.isfile(meta_file)
        or not meta.get("covered_area_m2")
        or (not user_edited and meta.get("name") != resolved_name)
        or meta.get("uploader_name") != resolved_uploader_name
    )
    if need_write_meta and is_safe_jailed_path(folder_path, LOCAL_SCANS_ROOT):
        try:
            meta_to_save = dict(meta)
            meta_to_save.update(result_item)
            meta_to_save["name"] = resolved_name
            meta_to_save["user_edited_name"] = bool(user_edited)
            meta_to_save["folder"] = folder_name
            meta_to_save["thumbnail_path"] = os.path.join(folder_path, "thumbnail.png")
            with open(meta_file, "w", encoding="utf-8") as wf:
                json.dump(meta_to_save, wf, indent=2, ensure_ascii=False)
        except Exception as e:
            print(f"[GDriveWatcher] Warning writing {meta_file}: {e}")

    return result_item


MULTIPART_ZIP_RE = re.compile(
    r"^(?P<base>.+?)[_\-\s\(]+(?P<part>\d+)\s*of\s*(?P<total>\d+)\)?\.zip$",
    re.IGNORECASE,
)


def is_safe_jailed_path(target_path: str, allowed_root: str) -> bool:
    """
    Strict path-jail check: verifies target_path resides directly inside allowed_root
    and prevents any parent/sibling traversal outside '3. GatheringScans'.
    """
    try:
        abs_root = os.path.normcase(os.path.abspath(allowed_root))
        abs_target = os.path.normcase(os.path.abspath(target_path))
        return abs_target == abs_root or abs_target.startswith(abs_root + os.sep)
    except Exception:
        return False


def parse_multipart_zip_filename(filename: str) -> Tuple[str, int, int]:
    """
    Parses upload filenames:
    - 'FileName_1of4.zip' -> ('FileName', 1, 4)
    - 'FileName.zip'      -> ('FileName', 1, 1)
    """
    m = MULTIPART_ZIP_RE.match(filename.strip())
    if m:
        base = m.group("base").strip(" _-()")
        part = max(1, int(m.group("part")))
        total = max(part, int(m.group("total")))
        return base, part, total
    stem = os.path.splitext(filename.strip())[0]
    return stem, 1, 1


import threading as _threading
_DISCOVERY_LOCK = _threading.RLock()


def seed_and_discover_scans(db: ScanQueueDB) -> List[Dict[str, Any]]:
    with _DISCOVERY_LOCK:
        return _seed_and_discover_scans_locked(db)


def _seed_and_discover_scans_locked(db: ScanQueueDB) -> List[Dict[str, Any]]:
    """
    100% Dynamic, Project-Agnostic Scan Discovery from C:\\GatheringScans (LOCAL_SCANS_ROOT)
    and G:\\Shared drives\\6.軟體\\3. GatheringScans (GDRIVE_INBOX_DIR).
    - Google Drive (GDRIVE_INBOX_DIR) is strictly an input-only inbox: any completed scan folders
      dropped into Google Drive are first copied into C:\\GatheringScans (LOCAL_SCANS_ROOT) and
      tiled/indexed exclusively from local disk.
    - Scales cleanly to 100+ projects via flat scan folders or nested project folders.
    - Single-part ('FileName.zip') and multi-part ('FileName_1of4.zip' .. 'FileName_4of4.zip') archives.
    - Immediate removal from SQLite when a scan folder or archive is deleted from local disk.
    """
    discovered_ids = set()
    dynamic_clusters: List[Dict[str, Any]] = []

    inbox_dirs = []
    if GDRIVE_INBOX_DIR and os.path.isdir(GDRIVE_INBOX_DIR):
        inbox_dirs.append(GDRIVE_INBOX_DIR)

    # 0. Sync any completed scan folders from Google Drive (input-only) into C:\GatheringScans (local disk storage)
    #    and collect .zip raw-photo archives for the PIX4Dmatic queue.
    grouped_uploads: Dict[Tuple[str, str, int], Dict[str, Any]] = {}
    seen_zip_keys = set()

    for idir in inbox_dirs:
        for entry in sorted(os.listdir(idir)):
            if entry.startswith(("_", ".")):
                continue
            epath = os.path.join(idir, entry)
            if not is_safe_jailed_path(epath, idir):
                continue

            zip_candidates: List[Tuple[str, str, str]] = []
            if os.path.isfile(epath) and entry.lower().endswith(".zip"):
                zip_candidates.append(("", entry, epath))
            elif os.path.isdir(epath):
                # First check if epath itself is directly a scan folder (e.g. QuChi_20261015-obj_mesh or QuChi_20261015-cesium_mesh)
                if _is_direct_scan_folder(epath):
                    _sync_gdrive_folder_to_local_vault(epath, parent_project="")
                else:
                    # Otherwise check if epath is a Project Folder containing nested scan folders or .zip archives
                    synced_nested = False
                    for sub_fn in sorted(os.listdir(epath)):
                        if sub_fn.startswith(("_", ".")) or sub_fn.lower() in INTERNAL_ASSET_DIRS:
                            continue
                        sub_fpath = os.path.join(epath, sub_fn)
                        if not is_safe_jailed_path(sub_fpath, idir):
                            continue
                        if os.path.isfile(sub_fpath) and sub_fn.lower().endswith(".zip"):
                            zip_candidates.append((entry, sub_fn, sub_fpath))
                        elif os.path.isdir(sub_fpath):
                            local_dst = _sync_gdrive_folder_to_local_vault(sub_fpath, parent_project=entry)
                            if local_dst:
                                synced_nested = True

                    if not synced_nested and not zip_candidates:
                        _sync_gdrive_folder_to_local_vault(epath, parent_project="")

            for parent_proj, fname, fpath in zip_candidates:
                dedup_key = (parent_proj.lower(), fname.lower())
                if dedup_key in seen_zip_keys or os.path.getsize(fpath) <= 0:
                    continue
                seen_zip_keys.add(dedup_key)
                base_name, part_idx, total_parts = parse_multipart_zip_filename(fname)
                gkey = (parent_proj.lower(), base_name.lower(), total_parts)
                if gkey not in grouped_uploads:
                    grouped_uploads[gkey] = {
                        "parent_project": parent_proj,
                        "base_name": base_name,
                        "total_parts": total_parts,
                        "parts": {},
                    }
                grouped_uploads[gkey]["parts"][part_idx] = fpath

    def _upsert_preserving_active_job(item: Dict[str, Any]):
        existing_row = db.get_scan(item["scan_id"])
        if existing_row and existing_row.get("status") in ("queued", "processing", "waiting_parts"):
            item["status"] = existing_row["status"]
            item["progress_pct"] = float(existing_row.get("progress_pct", 0.0))
            item["stage_label"] = existing_row.get("stage_label", "Queued")
            item["force_next"] = int(existing_row.get("force_next", 0))
            item["bypass_count"] = int(existing_row.get("bypass_count", 0))
            if existing_row.get("source_zip_path"):
                item["source_zip_path"] = existing_row["source_zip_path"]
        db.upsert_scan(item)
        discovered_ids.add(item["scan_id"])

    def _cleanup_if_gdrive_origin_deleted(folder_dir: str) -> bool:
        marker = os.path.join(folder_dir, ".gdrive_inbox_origin.json")
        if not os.path.isfile(marker):
            return False
        try:
            with open(marker, "r", encoding="utf-8") as mf:
                mdata = json.load(mf)
            src_f = mdata.get("src_folder", "")
            if src_f and not os.path.exists(src_f) and is_safe_jailed_path(folder_dir, LOCAL_SCANS_ROOT):
                shutil.rmtree(folder_dir, ignore_errors=True)
                print(f"[GDriveWatcher] Removed local mirror {folder_dir} because Google Drive folder {src_f} was deleted.")
                return True
        except Exception:
            pass
        return False

    # 1. Dynamically discover all scan folders in C:\GatheringScans (local disk storage)
    if os.path.isdir(LOCAL_SCANS_ROOT):
        for entry in sorted(os.listdir(LOCAL_SCANS_ROOT)):
            if entry.startswith(("_", ".")) or entry.lower() in INTERNAL_ASSET_DIRS:
                continue
            sub_dir = os.path.join(LOCAL_SCANS_ROOT, entry)
            if not is_safe_jailed_path(sub_dir, LOCAL_SCANS_ROOT) or not os.path.isdir(sub_dir):
                continue
            if _cleanup_if_gdrive_origin_deleted(sub_dir):
                continue

            # Check if sub_dir is directly a scan folder
            if _is_direct_scan_folder(sub_dir):
                item = _discover_folder_scan_item(sub_dir, dynamic_clusters=dynamic_clusters)
                if item:
                    _upsert_preserving_active_job(item)
            else:
                # Check if sub_dir is a Project Folder containing child scan folders (C:\GatheringScans\<Project>\<Scan>)
                found_nested = False
                for child_entry in sorted(os.listdir(sub_dir)):
                    if child_entry.startswith(("_", ".")) or child_entry.lower() in INTERNAL_ASSET_DIRS:
                        continue
                    child_dir = os.path.join(sub_dir, child_entry)
                    if not is_safe_jailed_path(child_dir, LOCAL_SCANS_ROOT) or not os.path.isdir(child_dir):
                        continue
                    if _cleanup_if_gdrive_origin_deleted(child_dir):
                        continue
                    nested_item = _discover_folder_scan_item(
                        child_dir, parent_project=entry, dynamic_clusters=dynamic_clusters
                    )
                    if nested_item:
                        _upsert_preserving_active_job(nested_item)
                        found_nested = True
                if not found_nested:
                    item = _discover_folder_scan_item(sub_dir, dynamic_clusters=dynamic_clusters)
                    if item:
                        _upsert_preserving_active_job(item)

    for (_, _, total_parts), ginfo in grouped_uploads.items():
        parent_proj = ginfo["parent_project"]
        base_name = ginfo["base_name"]
        parts_map: Dict[int, str] = ginfo["parts"]
        present_parts = sorted(parts_map.keys())
        missing_parts = [p for p in range(1, total_parts + 1) if p not in parts_map]
        all_parts_ready = len(missing_parts) == 0

        part_metas = [extract_opf_zip_metadata(parts_map[p]) for p in present_parts]
        primary_meta = dict(part_metas[0])

        proj_group, proj_zh = match_project_group(
            primary_meta["lat"],
            primary_meta["lon"],
            hint_name=base_name,
            parent_project=parent_proj,
            dynamic_clusters=dynamic_clusters,
        )
        primary_meta["project_group"] = proj_group
        primary_meta["project_name_zh"] = proj_zh

        clean_slug = re.sub(r"[^a-zA-Z0-9_]", "_", base_name).strip("_")
        scan_id = f"catch_{clean_slug}"
        primary_meta["scan_id"] = scan_id
        primary_meta["source_zip_path"] = ";".join(parts_map[p] for p in present_parts)
        primary_meta["size_bytes"] = sum(int(m.get("size_bytes", 0)) for m in part_metas)
        primary_meta["image_count"] = sum(int(m.get("image_count", 0)) for m in part_metas)
        primary_meta["uploaded_at"] = max(float(m.get("uploaded_at", time.time())) for m in part_metas)

        existing = db.get_scan(scan_id) or {}
        if existing.get("user_edited_name") and existing.get("name"):
            primary_meta["name"] = existing["name"]
            primary_meta["user_edited_name"] = 1
        else:
            primary_meta["name"] = base_name
            primary_meta["user_edited_name"] = 0

        cand_processed_dir = os.path.join(LOCAL_SCANS_ROOT, scan_id)
        cand_processed_ts = os.path.join(cand_processed_dir, "tileset", "tileset.json")
        if existing.get("status") in ("processing", "queued"):
            primary_meta["status"] = existing["status"]
            primary_meta["progress_pct"] = float(existing.get("progress_pct", 0.0))
            primary_meta["stage_label"] = existing.get("stage_label", "Queued")
            primary_meta["tileset_path"] = existing.get("tileset_path", cand_processed_ts if os.path.isfile(cand_processed_ts) else "")
            primary_meta["obj_path"] = existing.get("obj_path", "")
            primary_meta["project_dir"] = existing.get("project_dir", cand_processed_dir)
        elif all_parts_ready and os.path.isfile(cand_processed_ts):
            if existing and existing.get("tileset_path"):
                primary_meta = dict(existing)
                primary_meta["source_zip_path"] = ";".join(parts_map[p] for p in present_parts)
                if not existing.get("user_edited_name"):
                    primary_meta["name"] = base_name
            primary_meta["tileset_path"] = cand_processed_ts
            primary_meta["project_dir"] = cand_processed_dir
            cand_obj = os.path.join(cand_processed_dir, "exports", "obj_mesh", "mesh.obj")
            if os.path.isfile(cand_obj):
                primary_meta["obj_path"] = cand_obj
            primary_meta["status"] = "completed"
            primary_meta["progress_pct"] = 100.0
            primary_meta["stage_label"] = f"Processed -> {scan_id} (TWD97 + TWVD2001, 2K)"
        else:
            if not all_parts_ready:
                primary_meta["status"] = "waiting_parts"
                primary_meta["progress_pct"] = round((len(present_parts) / total_parts) * 20.0, 1)
                missing_str = ", ".join(str(m) for m in missing_parts)
                primary_meta["stage_label"] = f"Waiting for parts ({len(present_parts)}/{total_parts} uploaded — missing: {missing_str})"
                primary_meta["notes"] = (
                    f"Multi-part upload '{base_name}': received {len(present_parts)}/{total_parts} archives "
                    f"({', '.join(os.path.basename(parts_map[p]) for p in present_parts)}). "
                    f"Waiting for part(s) {missing_str} before launching unified PIX4Dmatic project."
                )
            elif existing.get("status") == "completed" and existing.get("tileset_path") and os.path.isfile(existing.get("tileset_path", "")):
                primary_meta["status"] = "completed"
                primary_meta["progress_pct"] = existing.get("progress_pct", 100.0)
                primary_meta["stage_label"] = existing.get("stage_label", "Completed")
                primary_meta["tileset_path"] = existing.get("tileset_path", "")
                primary_meta["obj_path"] = existing.get("obj_path", "")
                primary_meta["project_dir"] = existing.get("project_dir", "")
            else:
                primary_meta["status"] = "queued"
                primary_meta["progress_pct"] = 0.0
                if total_parts > 1:
                    primary_meta["stage_label"] = f"Queued (All {total_parts}/{total_parts} parts ready — Single PIX4Dmatic Project)"
                    primary_meta["notes"] = (
                        f"All {total_parts}/{total_parts} parts uploaded ({', '.join(os.path.basename(parts_map[p]) for p in present_parts)}). "
                        f"Queued to merge and process as a single PIX4Dmatic project ({primary_meta['image_count']} RTK photos)."
                    )
                else:
                    primary_meta["stage_label"] = "Queued for PIX4Dmatic (TWD97 + TWVD2001, 2K)"
                    primary_meta["notes"] = f"Single-archive scan '{base_name}.zip' ({primary_meta['image_count']} RTK photos) ready for processing."

        db.upsert_scan(primary_meta)
        discovered_ids.add(scan_id)

    # 3. Strictly remove any scans from SQLite that are no longer present in C:\GatheringScans or the jailed GDrive inbox
    with db._connect() as conn:
        existing_rows = conn.execute("SELECT scan_id, status, project_dir, source_zip_path FROM scans").fetchall()
        for row in existing_rows:
            sid = row["scan_id"]
            if sid not in discovered_ids:
                st = row["status"]
                pdir = row["project_dir"] or ""
                szip = (row["source_zip_path"] or "").split(";")[0].strip()
                if st in ("queued", "processing", "waiting_parts") and (os.path.isdir(pdir) or (szip and os.path.isfile(szip))):
                    continue
                conn.execute("DELETE FROM scans WHERE scan_id = ?", (sid,))
                conn.execute("DELETE FROM scan_comments WHERE scan_id = ?", (sid,))
        conn.commit()

    return db.list_scans()


