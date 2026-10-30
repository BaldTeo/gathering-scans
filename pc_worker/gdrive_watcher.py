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
    GDRIVE_INPUTS_DIR,
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
    return round(math.degrees(lat), 9), round(math.degrees(lon), 9)


def wgs84_to_twd97(lat_deg: float, lon_deg: float, ortho_h: float = 0.0) -> Tuple[float, float, float]:
    """
    Converts WGS84 geodetic (lat_deg, lon_deg) to TWD97 (121) [EPSG:3826] Easting/Northing meters,
    carrying through the supplied elevation `ortho_h` (caller subtracts geoid separation when source is ellipsoidal).
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
    twvd2001_h = round(ortho_h, 3)
    return round(easting, 4), round(northing, 4), twvd2001_h


def wgs84_to_utm(lat_deg: float, lon_deg: float) -> Tuple[float, float, int, str]:
    """Converts global WGS84 (lat, lon) to standard UTM (Easting, Northing, zone, hemisphere 'N'|'S')."""
    zone = max(1, min(60, int(math.floor((lon_deg + 180.0) / 6.0)) + 1))
    lon0 = math.radians((zone - 1) * 6.0 - 180.0 + 3.0)
    a = 6378137.0
    f = 1.0 / 298.257223563
    e2 = 2.0 * f - f * f
    ep2 = e2 / (1.0 - e2)
    k0 = 0.9996
    lat = math.radians(lat_deg)
    lon = math.radians(lon_deg)
    sin_lat = math.sin(lat)
    cos_lat = math.cos(lat)
    tan_lat = math.tan(lat)
    n = a / math.sqrt(1.0 - e2 * sin_lat * sin_lat)
    t = tan_lat * tan_lat
    c = ep2 * cos_lat * cos_lat
    A = cos_lat * (lon - lon0)
    M = a * (
        (1.0 - e2 / 4.0 - 3.0 * e2**2 / 64.0 - 5.0 * e2**3 / 256.0) * lat
        - (3.0 * e2 / 8.0 + 3.0 * e2**2 / 32.0 + 45.0 * e2**3 / 1024.0) * math.sin(2.0 * lat)
        + (15.0 * e2**2 / 256.0 + 45.0 * e2**3 / 1024.0) * math.sin(4.0 * lat)
        - (35.0 * e2**3 / 3072.0) * math.sin(6.0 * lat)
    )
    easting = 500000.0 + k0 * n * (
        A
        + (1.0 - t + c) * (A**3) / 6.0
        + (5.0 - 18.0 * t + t**2 + 72.0 * c - 58.0 * ep2) * (A**5) / 120.0
    )
    northing = k0 * (
        M
        + n
        * tan_lat
        * (
            (A**2) / 2.0
            + (5.0 - t + 9.0 * c + 4.0 * c**2) * (A**4) / 24.0
            + (61.0 - 58.0 * t + t**2 + 600.0 * c - 330.0 * ep2) * (A**6) / 720.0
        )
    )
    hemi = "N" if lat_deg >= 0.0 else "S"
    if lat_deg < 0.0:
        northing += 10000000.0
    return round(easting, 3), round(northing, 3), zone, hemi


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
        + (61 + 90 * t1 + 298 * c1 + 45 * t1**2 - 252 * e2 - 3 * c1**2) * d**6 / 720
    )
    lon = lon0 + (
        d
        - (1 + 2 * t1 + c1) * d**3 / 6
        + (5 - 2 * c1 + 28 * t1 - 3 * c1**2 + 8 * e2 + 24 * t1**2) * d**5 / 120
    ) / math.cos(fp)
    return round(math.degrees(lat), 9), round(math.degrees(lon), 9)


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
    (e.g., 'BridgeNorth_20261015_1of4' -> 'Bridge North', 'Taoyuan_MRT_261015' -> 'Taoyuan MRT').
    Returns '' if the name is purely a numeric timestamp like '2026-10-05-15-37-05'.
    """
    if not hint_name:
        return ""
    stem = os.path.splitext(os.path.basename(hint_name.strip("\\/")))[0]
    if stem.lower().startswith("catch_"):
        stem = stem[6:]
    # Strip trailing export/date/part tokens like -cesium_mesh, -obj_mesh, _20261005, _260917, _1of4, _Compressed, _Merged
    cleaned = re.sub(
        r"([_\-\s]+(cesium[_\-]?mesh|obj[_\-]?mesh|20\d{6}|\d{6}|\d{4}[\-_]\d{2}[\-_]\d{2}.*|\d+\s*of\s*\d+|compressed|merged\d*|sector\d*|part\d*|trees|nortk|\d+))+$",
        "",
        stem,
        flags=re.IGNORECASE,
    ).strip(" _-()")
    if not cleaned or re.match(r"^[\d\-_]+$", cleaned) or cleaned.lower() in ("catch", "scan", "scans", "export", "tileset"):
        return ""
    spaced = re.sub(r"[_\-]+", " ", cleaned)
    spaced = re.sub(r"([a-z])([A-Z])", r"\1 \2", spaced)
    return re.sub(r"\s+", " ", spaced).strip()


def _apply_site_rename_override(pg: str, pzh: str) -> Tuple[str, str]:
    """Applies any user-configured site rename from data/site_renames.json."""
    try:
        from pc_worker.config import DATA_DIR
        ren_file = os.path.join(DATA_DIR, "site_renames.json")
        if os.path.isfile(ren_file):
            with open(ren_file, "r", encoding="utf-8") as rf:
                ren_map = json.load(rf)
            if isinstance(ren_map, dict) and pg in ren_map:
                entry = ren_map[pg]
                if isinstance(entry, dict) and entry.get("project_group"):
                    return entry["project_group"], entry.get("project_name_zh") or pzh
    except Exception:
        pass
    return pg, pzh


def match_project_group(
    lat: Optional[float],
    lon: Optional[float],
    hint_name: str = "",
    parent_project: str = "",
    dynamic_clusters: Optional[List[Dict[str, Any]]] = None,
) -> Tuple[str, str]:
    """
    100% Data-Driven Project-Agnostic Resolver (zero hardcoded coordinates or site names):
    1. Explicit parent project folder name (e.g., C:\\GatheringScans\\<Project>\\<Scan>)
    2. Spatial proximity match (<= 1000m / 1 km radius) against dynamically discovered scan clusters & projects_registry.json
    3. Project prefix inferred from folder/archive filename (e.g., 'ProjectX_20261015.zip' -> 'Project X')
    4. Coordinate-based site cluster fallback ('Site (25.0374N, 121.5253E)') or 'Unassigned Site' if un-georeferenced
    """
    candidates: List[Dict[str, Any]] = []
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

    if parent_project and parent_project.strip():
        pg = parent_project.strip()
        for p in candidates:
            if str(p.get("project_group") or "").lower() == pg.lower():
                return _apply_site_rename_override(
                    p["project_group"],
                    p.get("project_name_zh") or f"{p['project_group']} 工程掃描群組",
                )
        return _apply_site_rename_override(pg, f"{pg} 工程掃描群組")

    has_valid_georef = (
        lat is not None
        and lon is not None
        and (abs(float(lat)) > 0.001 or abs(float(lon)) > 0.001)
    )
    if has_valid_georef:
        best = None
        best_dist = 1e12
        for p in candidates:
            try:
                if p.get("lat") is None or p.get("lon") is None:
                    continue
                plat, plon = float(p["lat"]), float(p["lon"])
                if abs(plat) <= 0.001 and abs(plon) <= 0.001:
                    continue
                d = haversine_m(float(lat), float(lon), plat, plon)
                rad = max(float(p.get("radius_m", 1000.0)), 1000.0)
                if d <= rad and d < best_dist:
                    best = p
                    best_dist = d
            except Exception:
                continue
        if best:
            return _apply_site_rename_override(
                best["project_group"],
                best.get("project_name_zh") or f"{best['project_group']} 工程掃描群組",
            )

    inferred = _infer_project_prefix(hint_name)
    if inferred:
        for p in candidates:
            if str(p.get("project_group") or "").lower() == inferred.lower():
                return _apply_site_rename_override(
                    p["project_group"],
                    p.get("project_name_zh") or f"{inferred} 工程掃描群組",
                )
        return _apply_site_rename_override(inferred, f"{inferred} 工程掃描群組")

    if has_valid_georef:
        return _apply_site_rename_override(f"Site ({float(lat):.4f}N, {float(lon):.4f}E)", "新增工區掃描點")

    return _apply_site_rename_override("Unassigned Site", "未定位掃描工區")


GATHEREN_DRIVEFS_USER_MAP: Dict[str, Tuple[str, str, str, str]] = {
    "0B9iDvpnqzFdI": ("雲在天", "glibivanov@gatheren.com.tw", "工務/BIM", "#14b8a6"),
    "0B_7euqQkEuTc": ("趙冠人", "frankchao@gatheren.com.tw", "總經理", "#ef4444"),
    "0B4ivIGgbWwve": ("胡佳雯", "wenhu@gatheren.com.tw", "行政/管理", "#ec4899"),
    "0B8KUfOzTj-EC": ("薛鈞豪", "HowardHsueh@gatheren.com.tw", "工務/專案", "#3b82f6"),
    "0BzHb4wJMZJa4": ("蘇容德", "litasu@gatheren.com.tw", "成控/採購", "#a855f7"),
    "0B1JR5X9StbPX": ("楊斯顯", "szhsienyang@gatheren.com.tw", "工務/品管", "#f97316"),
    "0B2Yj38NHCSUd": ("黃聖文", "shengwenhuang@gatheren.com.tw", "工務工程師", "#eab308"),
    "0BxxwiCzAZ_Zh": ("黃聖文", "shengwenhuang@gatheren.com.tw", "工務工程師", "#eab308"),
    "0B34fkGa3yIcF": ("鄭宇翔", "leocheng@gatheren.com.tw", "工務工程師", "#06b6d4"),
    "0B52Y9wroxqHr": ("駱介正", "JasonLo@gatheren.com.tw", "財務經理", "#6366f1"),
    "0B8PgVwzUHnRd": ("游忠偉", "kentyu@gatheren.com.tw", "工務/訪價", "#10b981"),
    "0ByiKtcWmlGtI": ("葉烝佑", "ChengYouYeh@gatheren.com.tw", "工務工程師", "#84cc16"),
    "0Bz9icckT3CZZ": ("王騰德", "tengtewang@gatheren.com.tw", "工務經理", "#0ea5e9"),
    "0BziTTOFSCVhJ": ("陳聰榮", "congrongchen@gatheren.com.tw", "工務人員", "#f59e0b"),
    "0B5fGwAtfvOyh": ("李振嘉", "edwardli@gatheren.com.tw", "工務工程師", "#8b5cf6"),
    "0B6EWVm5brWwN": ("孫暐岑", "neilsun@gatheren.com.tw", "工務工程師", "#22c55e"),
    "0Bx93O1IxaYa5": ("陳冠羽", "kevinchen@gatheren.com.tw", "機電/工務", "#d946ef"),
    "0B9dBuM-XDr0c": ("陳錦鴻", "jimmy.gimi@gmail.com", "機電經理", "#ec4899"),
    "0B0M_NvlPG_fF": ("鄭諭謙", "yuchien@gatheren.com.tw", "工務工程師", "#06b6d4"),
}

GATHEREN_EMAIL_TO_NAME: Dict[str, str] = {
    info[1].lower(): info[0] for info in GATHEREN_DRIVEFS_USER_MAP.values()
}

_DRIVEFS_CACHE: Dict[str, Any] = {"ts": 0.0, "by_title": {}}


def _pick_best_user_from_proto(proto: bytes) -> Optional[Tuple[str, str]]:
    """
    Extracts the uploader's (display_name_zh, email) from DriveFS protobuf bytes.
    Prefers any non-default uploader token over the shared-folder/daemon owner (0B9iDvpnqzFdI).
    """
    if not proto:
        return None
    m = re.findall(b"0B[A-Za-z0-9_-]{11}", proto)
    if not m:
        return None
    tokens = [tok.decode("ascii", errors="ignore") for tok in m]
    for tok in reversed(tokens):
        if tok != "0B9iDvpnqzFdI" and tok in GATHEREN_DRIVEFS_USER_MAP:
            u_info = GATHEREN_DRIVEFS_USER_MAP[tok]
            return (u_info[0], u_info[1])
    for tok in reversed(tokens):
        if tok in GATHEREN_DRIVEFS_USER_MAP:
            u_info = GATHEREN_DRIVEFS_USER_MAP[tok]
            return (u_info[0], u_info[1])
    return None


def _register_drivefs_title_keys(
    by_title: Dict[str, Tuple[str, str]],
    raw_title: str,
    u_pair: Tuple[str, str],
    is_priority: bool = False,
) -> None:
    """
    Indexes a file/folder title, its stem, and (for scan inbox items) its ASCII scan_id slug
    (e.g. '屈尺取石塊1021.zip' -> '1021', 'catch_1021').
    Excludes daemon-generated .3tz archives so they never overwrite the real scan uploader.
    """
    t_str = (raw_title or "").strip().lower()
    if not t_str or t_str.endswith(".3tz"):
        return
    stem = os.path.splitext(t_str)[0]
    keys = [t_str, stem]
    if is_priority:
        clean_slug = re.sub(r"[^a-zA-Z0-9_]", "_", stem).strip("_").lower()
        if len(clean_slug) >= 3:
            keys.extend([clean_slug, f"catch_{clean_slug}"])
    is_non_default = u_pair[1].lower() != "glibivanov@gatheren.com.tw"
    for k in keys:
        if not k:
            continue
        existing = by_title.get(k)
        if (
            existing is None
            or (is_priority and (is_non_default or existing[1].lower() == "glibivanov@gatheren.com.tw"))
            or (is_non_default and existing[1].lower() == "glibivanov@gatheren.com.tw")
        ):
            by_title[k] = u_pair


def _resolve_drivefs_uploader(name_or_path: str) -> Tuple[str, str]:
    """
    Procedurally reads Google Drive for Desktop local metadata_sqlite_db to resolve
    the actual Google Account display name (Chinese name) and email for a scan file/folder.
    Handles:
    1. Direct .zip archives (including Chinese filenames whose ASCII slug becomes catch_<slug>).
    2. Raw or completed folders uploaded to INPUTS (resolving uploader from child files via stable_parents).
    3. Multi-user proto records (preferring the actual uploader over the shared folder/daemon owner).
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
                        t_raw = title_b.decode("utf-8", errors="ignore").strip()
                        if t_raw.lower().endswith(".3tz"):
                            continue
                        u_pair = _pick_best_user_from_proto(proto)
                        if u_pair:
                            _register_drivefs_title_keys(by_title, t_raw, u_pair, is_priority=False)

                    # Priority pass: inspect items and folders inside '3. GatheringScans', 'INPUTS', 'SCANS TEST'
                    cur.execute(
                        "SELECT stable_id FROM items WHERE trashed=0 AND local_title IN ('3. GatheringScans', 'INPUTS', 'SCANS TEST')"
                    )
                    root_ids = [int(r[0]) for r in cur.fetchall() if r and r[0] is not None]
                    if root_ids:
                        placeholders = ",".join("?" for _ in root_ids)
                        cur.execute(
                            f"""
                            WITH RECURSIVE inbox_tree(id, top_title, depth) AS (
                                SELECT i.stable_id, i.local_title, 0
                                FROM items i
                                JOIN stable_parents sp ON i.stable_id = sp.item_stable_id
                                WHERE sp.parent_stable_id IN ({placeholders})
                                  AND i.trashed = 0
                                  AND i.local_title NOT IN ('StreamPackages', 'CommentPhotos', 'INPUTS')
                                UNION ALL
                                SELECT i.stable_id, inbox_tree.top_title, inbox_tree.depth + 1
                                FROM items i
                                JOIN stable_parents sp ON i.stable_id = sp.item_stable_id
                                JOIN inbox_tree ON sp.parent_stable_id = inbox_tree.id
                                WHERE inbox_tree.depth < 3 AND i.trashed = 0
                            )
                            SELECT inbox_tree.top_title, i.local_title, i.is_folder, i.proto
                            FROM inbox_tree
                            JOIN items i ON i.stable_id = inbox_tree.id
                            """,
                            root_ids,
                        )
                        for top_b, item_b, is_f, proto in cur.fetchall():
                            u_pair = _pick_best_user_from_proto(proto)
                            if not u_pair:
                                continue
                            if item_b:
                                item_str = item_b.decode("utf-8", errors="ignore").strip()
                                _register_drivefs_title_keys(by_title, item_str, u_pair, is_priority=True)
                            if top_b:
                                top_str = top_b.decode("utf-8", errors="ignore").strip()
                                _register_drivefs_title_keys(by_title, top_str, u_pair, is_priority=True)
                    con.close()
        except Exception:
            pass
        _DRIVEFS_CACHE["ts"] = now
        _DRIVEFS_CACHE["by_title"] = by_title

    by_title = _DRIVEFS_CACHE.get("by_title") or {}
    first_part = (name_or_path or "").split(";")[0].strip()
    base = os.path.basename(first_part.rstrip("/\\")).strip().lower()
    stem = os.path.splitext(base)[0]
    clean_slug = re.sub(r"[^a-zA-Z0-9_]", "_", stem).strip("_").lower()
    no_catch = stem[6:] if stem.startswith("catch_") else stem
    edited_base = re.sub(r"^edited_(.+?)_\d{4,7}$", r"\1", stem)
    for candidate in (
        base,
        stem,
        f"{stem}.zip",
        no_catch,
        f"{no_catch}.zip",
        edited_base,
        f"catch_{edited_base}",
        clean_slug,
        f"catch_{clean_slug}",
    ):
        if candidate and candidate in by_title:
            return by_title[candidate]
    return ("雲在天", "glibivanov@gatheren.com.tw")


def normalize_gatheren_uploader(uploader_name: str, uploader_email: str, hint_path: str = "") -> Tuple[str, str]:
    """
    Ensures uploader metadata uses the real Google Account Chinese display name
    and automatically resolves non-default uploaders from DriveFS when hint_path is provided.
    """
    email = (uploader_email or "").strip() or "glibivanov@gatheren.com.tw"
    if email.lower() in ("glib@gatheren.com.tw", "argon@gatheren.com.tw", "engineer@gatheren.cloud"):
        email = "glibivanov@gatheren.com.tw"
    name = (uploader_name or "").strip()
    is_default_account = (
        not name
        or name.lower() in ("glib ivanov", "glibivanov", "argon", "admin", "system", "雲在天")
        or email.lower() == "glibivanov@gatheren.com.tw"
    )
    if hint_path and is_default_account:
        dfs_name, dfs_email = _resolve_drivefs_uploader(hint_path)
        if dfs_email.lower() != "glibivanov@gatheren.com.tw" or not name or name.lower() in ("glib ivanov", "glibivanov", "argon", "admin", "system"):
            return dfs_name, dfs_email
    mapped_zh = GATHEREN_EMAIL_TO_NAME.get(email.lower())
    if mapped_zh and (not name or name.lower() in ("glib ivanov", "glibivanov", "argon") or (email.lower() != "glibivanov@gatheren.com.tw" and name == "雲在天")):
        return mapped_zh, email
    if not name or name.lower() in ("glib ivanov", "glibivanov", "argon"):
        return "雲在天", email
    return name, email


def _extract_image_exif_xmp_gps(img_header_bytes: bytes) -> Optional[Dict[str, float]]:
    """
    Fast (<1ms) parser that extracts RTK / GPS coordinates and horizontal accuracy from
    Pix4DCatch XMP headers (Camera:RTKLatitude, Camera:RTKLongitude, Camera:RTKAltitude,
    Camera:RTKXYAccuracy, exif:GPSLatitude, etc.) or standard EXIF tags in the first 64 KB of a JPEG.
    """
    if not img_header_bytes:
        return None
    try:
        header_txt = img_header_bytes[:65536].decode("latin-1", errors="ignore")
        lat_val: Optional[float] = None
        lon_val: Optional[float] = None
        alt_val: float = 0.0
        acc_cm: Optional[float] = None

        m_lat = re.search(
            r'(?:Camera:RTKLatitude|Camera:GPSLatitude|exif:GPSLatitude)\s*=\s*"([+\-]?\d+(?:\.\d+)?)"',
            header_txt,
        )
        m_lon = re.search(
            r'(?:Camera:RTKLongitude|Camera:GPSLongitude|exif:GPSLongitude)\s*=\s*"([+\-]?\d+(?:\.\d+)?)"',
            header_txt,
        )
        if m_lat and m_lon:
            lat_val = float(m_lat.group(1))
            lon_val = float(m_lon.group(1))

        m_alt = re.search(
            r'(?:Camera:RTKAltitude|Camera:GPSAltitude|exif:GPSAltitude)\s*=\s*"([+\-]?\d+(?:\.\d+)?)"',
            header_txt,
        )
        if m_alt:
            alt_val = float(m_alt.group(1))

        m_acc = re.search(
            r'(?:Camera:RTKXYAccuracy|Camera:GPSXYAccuracy)\s*=\s*"([+\-]?\d+(?:\.\d+)?)"',
            header_txt,
        )
        if m_acc:
            acc_m = float(m_acc.group(1))
            if acc_m > 0:
                acc_cm = round(max(acc_m * 100.0, 0.5), 2)

        if lat_val is None or lon_val is None:
            import io
            from PIL import Image

            with Image.open(io.BytesIO(img_header_bytes)) as im:
                exif = im._getexif() or {}
                gps_ifd = exif.get(34853)
                if isinstance(gps_ifd, dict) and 2 in gps_ifd and 4 in gps_ifd:
                    def _dms_to_deg(dms, ref: str) -> float:
                        d = float(dms[0]) + float(dms[1]) / 60.0 + float(dms[2]) / 3600.0
                        return -d if str(ref).upper() in ("S", "W") else d

                    lat_val = _dms_to_deg(gps_ifd[2], gps_ifd.get(1, "N"))
                    lon_val = _dms_to_deg(gps_ifd[4], gps_ifd.get(3, "E"))
                    if 6 in gps_ifd:
                        alt_val = float(gps_ifd[6])

        if lat_val is not None and lon_val is not None and -90.0 <= lat_val <= 90.0 and -180.0 <= lon_val <= 180.0:
            if abs(lat_val) > 0.001 and abs(lon_val) > 0.001:
                res: Dict[str, float] = {
                    "lat": round(lat_val, 6),
                    "lon": round(lon_val, 6),
                    "elev_m": round(alt_val, 2),
                }
                if acc_cm is not None:
                    res["rtk_accuracy_cm"] = acc_cm
                return res
    except Exception:
        pass
    return None


def _apply_extracted_coords_to_info(info: Dict[str, Any], cx: float, cy: float, cz: float, crs_desc: str = "") -> bool:
    """Applies extracted coordinates (UTM51N, TWD97 TM2-121, or global WGS84 lat/lon) to info dict."""
    crs_low = (crs_desc or "").lower()
    is_ellip = ("ellipsoid" in crs_low) or ("4979" in crs_low) or ("wgs 84" in crs_low and "twvd" not in crs_low and "8904" not in crs_low)
    if 100000 <= cx <= 850000 and 2500000 <= cy <= 3000000 and ("utm zone 51n" in crs_low or cx < 200000 or cx > 345000):
        lat, lon = utm51n_to_wgs84(cx, cy)
        ortho_z = cz - 17.20 if (is_ellip and "twvd" not in crs_low and "8904" not in crs_low) else cz
        twd_e, twd_n, twd_h = wgs84_to_twd97(lat, lon, ortho_z)
        info.update(
            {
                "lat": lat,
                "lon": lon,
                "elev_m": round(twd_h, 2),
                "twd97_e": twd_e,
                "twd97_n": twd_n,
                "twd97_h": twd_h,
                "crs": TWD97_TWVD2001_SHORT,
            }
        )
        return True
    if 150000 <= cx <= 345000 and 2400000 <= cy <= 2850000:
        lat, lon = twd97_to_wgs84(cx, cy)
        info.update(
            {
                "lat": lat,
                "lon": lon,
                "elev_m": round(cz, 2),
                "twd97_e": round(cx, 3),
                "twd97_n": round(cy, 3),
                "twd97_h": round(cz, 2),
                "crs": TWD97_TWVD2001_SHORT,
            }
        )
        return True
    # Geodetic degrees: Taiwan region -> TWD97 (121) + TWVD2001
    if 20.0 <= cx <= 27.0 and 118.0 <= cy <= 123.5:
        lat, lon = round(cx, 6), round(cy, 6)
        ortho_z = cz - 17.20 if is_ellip else cz
        twd_e, twd_n, twd_h = wgs84_to_twd97(lat, lon, ortho_z)
        info.update(
            {
                "lat": lat,
                "lon": lon,
                "elev_m": round(twd_h, 2),
                "twd97_e": twd_e,
                "twd97_n": twd_n,
                "twd97_h": twd_h,
                "crs": TWD97_TWVD2001_SHORT,
            }
        )
        return True
    if 118.0 <= cx <= 123.5 and 20.0 <= cy <= 27.0:
        lat, lon = round(cy, 6), round(cx, 6)
        ortho_z = cz - 17.20 if is_ellip else cz
        twd_e, twd_n, twd_h = wgs84_to_twd97(lat, lon, ortho_z)
        info.update(
            {
                "lat": lat,
                "lon": lon,
                "elev_m": round(twd_h, 2),
                "twd97_e": twd_e,
                "twd97_n": twd_n,
                "twd97_h": twd_h,
                "crs": TWD97_TWVD2001_SHORT,
            }
        )
        return True
    # Global WGS84 geodetic degrees outside Taiwan -> standard UTM zone
    cand_lat_lon: Optional[Tuple[float, float]] = None
    if -90.0 <= cx <= 90.0 and -180.0 <= cy <= 180.0 and (abs(cx) > 0.01 or abs(cy) > 0.01):
        cand_lat_lon = (round(cx, 6), round(cy, 6))
    elif -180.0 <= cx <= 180.0 and -90.0 <= cy <= 90.0 and abs(cx) > 90.0 and (abs(cx) > 0.01 or abs(cy) > 0.01):
        cand_lat_lon = (round(cy, 6), round(cx, 6))
    if cand_lat_lon is not None:
        lat, lon = cand_lat_lon
        utm_e, utm_n, zone, hemi = wgs84_to_utm(lat, lon)
        info.update(
            {
                "lat": lat,
                "lon": lon,
                "elev_m": round(cz, 2),
                "twd97_e": utm_e,
                "twd97_n": utm_n,
                "twd97_h": round(cz, 2),
                "crs": f"WGS84 / UTM Zone {zone}{hemi}",
            }
        )
        return True
    return False


def extract_opf_zip_metadata(zip_path: str) -> Dict[str, Any]:
    """
    Fast metadata extractor for Pix4DCatch 'Export to PIX4Dmatic' .zip archives
    AND raw photo folders uploaded directly to Google Drive.
    Reads OPF JSON headers or JPEG EXIF/XMP RTK tags and converts coordinates to TWD97 + TWVD2001.
    """
    stat = os.stat(zip_path)
    is_dir = os.path.isdir(zip_path)
    raw_base = os.path.basename(zip_path.rstrip("/\\"))
    bname = raw_base if is_dir else os.path.splitext(raw_base)[0]
    dfs_name, dfs_email = _resolve_drivefs_uploader(zip_path)
    info: Dict[str, Any] = {
        "scan_id": f"catch_{bname.replace('-', '_')}",
        "name": bname,
        "source_zip_path": zip_path,
        "size_bytes": stat.st_size if not is_dir else 0,
        "uploaded_at": stat.st_mtime,
        "capture_date": bname[:10] + " " + bname[11:16].replace("-", ":")
        if len(bname) >= 16 and bname[4] == "-"
        else datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M"),
        "uploader_email": dfs_email,
        "uploader_name": dfs_name,
        "image_count": 0,
        "rtk_accuracy_cm": 1.6,
        "lat": None,
        "lon": None,
        "elev_m": 0.0,
        "twd97_e": 0.0,
        "twd97_n": 0.0,
        "twd97_h": 0.0,
        "crs": "LOCAL_ORIGIN",
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

    coords_resolved = False
    try:
        if is_dir:
            jpg_files: List[str] = []
            meta_files_disk: List[str] = []
            srf_files_disk: List[str] = []
            cam_files_disk: List[str] = []
            total_sz = 0
            latest_mt = stat.st_mtime

            # Fast path for Pix4DCatch OPF directories (avoids 4,500 individual os.stat calls over Google Drive File Stream)
            cand_meta = os.path.join(zip_path, "metadata", "projectMetadata.json")
            cand_srf = os.path.join(zip_path, "opf_files", "scene_reference_frame.json")
            cand_cam = os.path.join(zip_path, "opf_files", "input_cameras.json")
            cand_imgs_dir = os.path.join(zip_path, "images")
            if os.path.isfile(cand_meta):
                meta_files_disk.append(cand_meta)
            if os.path.isfile(cand_srf):
                srf_files_disk.append(cand_srf)
            if os.path.isfile(cand_cam):
                cam_files_disk.append(cand_cam)

            if os.path.isdir(cand_imgs_dir) and (meta_files_disk or cam_files_disk or os.path.isfile(os.path.join(zip_path, "project.opf"))):
                try:
                    with os.scandir(cand_imgs_dir) as it:
                        for entry in it:
                            low = entry.name.lower()
                            if low.endswith((".jpg", ".jpeg", ".png")):
                                jpg_files.append(entry.path)
                            try:
                                est = entry.stat()
                                total_sz += est.st_size
                                if est.st_mtime > latest_mt:
                                    latest_mt = est.st_mtime
                            except OSError:
                                pass
                except Exception:
                    pass
                jpg_files.sort()
            else:
                for root, _, files in os.walk(zip_path):
                    for fn in sorted(files):
                        fp = os.path.join(root, fn)
                        try:
                            fst = os.stat(fp)
                            total_sz += fst.st_size
                            if fst.st_mtime > latest_mt:
                                latest_mt = fst.st_mtime
                        except OSError:
                            pass
                        low = fn.lower()
                        if low.endswith((".jpg", ".jpeg", ".png")):
                            jpg_files.append(fp)
                        elif fn.endswith("projectMetadata.json"):
                            meta_files_disk.append(fp)
                        elif fn.endswith("scene_reference_frame.json"):
                            srf_files_disk.append(fp)
                        elif fn.endswith("input_cameras.json"):
                            cam_files_disk.append(fp)

            info["image_count"] = len(jpg_files)
            info["size_bytes"] = max(total_sz, 1024)
            info["uploaded_at"] = latest_mt

            if meta_files_disk:
                with open(meta_files_disk[0], "r", encoding="utf-8") as mf:
                    mdata = json.load(mf)
                loc_obj = mdata.get("locationInfo") or mdata.get("locationInformation") or {}
                min_h_acc = loc_obj.get("minHorizontalAccuracy") or loc_obj.get("averageHorizontalAccuracy")
                if min_h_acc is not None:
                    info["rtk_accuracy_cm"] = round(max(float(min_h_acc) * 100.0, 0.8), 2)

            crs_desc = ""
            if srf_files_disk:
                with open(srf_files_disk[0], "r", encoding="utf-8") as sf:
                    srf = json.load(sf)
                crs_desc = (srf.get("crs") or {}).get("definition", "")

            if cam_files_disk:
                with open(cam_files_disk[0], "r", encoding="utf-8") as cf:
                    cams = json.load(cf)
                cam_list = cams.get("cameras") or cams.get("captures") or []
                if cam_list and info["image_count"] == 0:
                    info["image_count"] = len(cam_list)
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
                    coords_resolved = _apply_extracted_coords_to_info(info, cx, cy, cz, crs_desc)

            if not coords_resolved and jpg_files:
                sample_paths = jpg_files[:5] if len(jpg_files) <= 10 else [
                    jpg_files[0],
                    jpg_files[len(jpg_files) // 4],
                    jpg_files[len(jpg_files) // 2],
                    jpg_files[(3 * len(jpg_files)) // 4],
                    jpg_files[-1],
                ]
                samples = []
                for sp in sample_paths:
                    try:
                        with open(sp, "rb") as jf:
                            parsed = _extract_image_exif_xmp_gps(jf.read(65536))
                        if parsed:
                            samples.append(parsed)
                    except Exception:
                        pass
                if samples:
                    avg_lat = sum(s["lat"] for s in samples) / len(samples)
                    avg_lon = sum(s["lon"] for s in samples) / len(samples)
                    avg_elev = sum(s["elev_m"] for s in samples) / len(samples)
                    accs = [s["rtk_accuracy_cm"] for s in samples if "rtk_accuracy_cm" in s]
                    if accs:
                        info["rtk_accuracy_cm"] = round(sum(accs) / len(accs), 2)
                    coords_resolved = _apply_extracted_coords_to_info(info, avg_lat, avg_lon, avg_elev)
        else:
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
                if srf_files:
                    srf = json.loads(zf.read(srf_files[0]).decode("utf-8"))
                    crs_obj = srf.get("crs", {})
                    crs_desc = crs_obj.get("definition", "")

                if cam_files:
                    cams = json.loads(zf.read(cam_files[0]).decode("utf-8"))
                    cam_list = cams.get("cameras") or cams.get("captures") or []
                    if cam_list and info["image_count"] == 0:
                        info["image_count"] = len(cam_list)

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
                        coords_resolved = _apply_extracted_coords_to_info(info, cx, cy, cz, crs_desc)

                if not coords_resolved and jpgs:
                    samples = []
                    for jname in jpgs[:3]:
                        try:
                            with zf.open(jname, "r") as jf:
                                parsed = _extract_image_exif_xmp_gps(jf.read(65536))
                            if parsed:
                                samples.append(parsed)
                        except Exception:
                            pass
                    if samples:
                        avg_lat = sum(s["lat"] for s in samples) / len(samples)
                        avg_lon = sum(s["lon"] for s in samples) / len(samples)
                        avg_elev = sum(s["elev_m"] for s in samples) / len(samples)
                        accs = [s["rtk_accuracy_cm"] for s in samples if "rtk_accuracy_cm" in s]
                        if accs:
                            info["rtk_accuracy_cm"] = round(sum(accs) / len(accs), 2)
                        coords_resolved = _apply_extracted_coords_to_info(info, avg_lat, avg_lon, avg_elev)
    except Exception as e:
        print(f"[GDriveWatcher] Warning parsing {zip_path}: {e}")

    proj_group, proj_zh = match_project_group(info["lat"], info["lon"], hint_name=bname)
    info["project_group"] = proj_group
    info["project_name_zh"] = proj_zh
    return info


def _ecef_to_wgs84(x: float, y: float, z: float) -> Tuple[float, float, float]:
    """Converts ECEF (EPSG:4978) meters to WGS84 (lat_deg, lon_deg, h_ellip_m)."""
    a = 6378137.0
    f = 1.0 / 298.257223563
    e2 = 2.0 * f - f * f
    b = a * (1.0 - f)
    ep2 = (a * a - b * b) / (b * b)
    p = math.hypot(x, y)
    th = math.atan2(a * z, b * p)
    lon = math.degrees(math.atan2(y, x))
    lat = math.degrees(
        math.atan2(
            z + ep2 * b * (math.sin(th) ** 3),
            p - e2 * a * (math.cos(th) ** 3),
        )
    )
    sin_lat = math.sin(math.radians(lat))
    N = a / math.sqrt(1.0 - e2 * sin_lat * sin_lat)
    h_ellip = p / max(math.cos(math.radians(lat)), 1e-9) - N
    return lat, lon, h_ellip


def _mat4_mul_pt(m: List[float], x: float, y: float, z: float) -> Tuple[float, float, float]:
    """Multiplies a column-major 4x4 3D Tiles transform matrix by local point (x, y, z, 1)."""
    return (
        float(m[0]) * x + float(m[4]) * y + float(m[8]) * z + float(m[12]),
        float(m[1]) * x + float(m[5]) * y + float(m[9]) * z + float(m[13]),
        float(m[2]) * x + float(m[6]) * y + float(m[10]) * z + float(m[14]),
    )


def _walk_tight_leaf_center_and_extents(root: Dict[str, Any]) -> Tuple[float, float, float, Optional[List[float]]]:
    """
    Walks 3D Tiles content leaf boundingVolume.box nodes (up to depth 8) to compute
    the tight 3D mesh centroid and half-extents, avoiding sky-high cubic octree root boxes.
    """
    by_depth: Dict[int, List[List[float]]] = {}

    def _walk(node: Any, d: int) -> None:
        if not isinstance(node, dict) or d > 8:
            return
        content = node.get("content") or {}
        uri = content.get("uri") or content.get("url")
        box = (node.get("boundingVolume") or {}).get("box")
        if uri and isinstance(box, list) and len(box) >= 12:
            by_depth.setdefault(d, []).append([float(v or 0.0) for v in box[:12]])
        for ch in node.get("children") or []:
            _walk(ch, d + 1)

    _walk(root, 0)
    if by_depth:
        max_d = max(by_depth.keys())
        boxes = by_depth[max_d]
        xs_all = [b[0] for b in boxes]
        ys_all = [b[1] for b in boxes]
        if len(boxes) >= 2 and (max(xs_all) - min(xs_all) > 1000.0 or max(ys_all) - min(ys_all) > 1000.0):
            # Safeguard C: Multi-island tileset (>1,000m span) -> select the dominant leaf cluster
            best_cluster = boxes
            best_cnt = -1
            for anchor in boxes:
                cluster = [
                    b
                    for b in boxes
                    if math.hypot(b[0] - anchor[0], b[1] - anchor[1]) <= 1000.0
                ]
                if len(cluster) > best_cnt:
                    best_cnt = len(cluster)
                    best_cluster = cluster
            boxes = best_cluster
        xs = [b[0] for b in boxes]
        ys = [b[1] for b in boxes]
        zs = sorted(b[2] for b in boxes)
        lx = (min(xs) + max(xs)) * 0.5
        ly = (min(ys) + max(ys)) * 0.5
        lz = zs[len(zs) // 2]
        min_x = min(b[0] - (abs(b[3]) + abs(b[6]) + abs(b[9])) for b in boxes)
        max_x = max(b[0] + (abs(b[3]) + abs(b[6]) + abs(b[9])) for b in boxes)
        min_y = min(b[1] - (abs(b[4]) + abs(b[7]) + abs(b[10])) for b in boxes)
        max_y = max(b[1] + (abs(b[4]) + abs(b[7]) + abs(b[10])) for b in boxes)
        min_z = min(b[2] - (abs(b[5]) + abs(b[8]) + abs(b[11])) for b in boxes)
        max_z = max(b[2] + (abs(b[5]) + abs(b[8]) + abs(b[11])) for b in boxes)
        he = [
            round(max((max_x - min_x) * 0.5, 1.0), 2),
            round(max((max_y - min_y) * 0.5, 1.0), 2),
            round(max((max_z - min_z) * 0.5, 1.0), 2),
        ]
        return lx, ly, lz, he

    box = (root.get("boundingVolume") or {}).get("box")
    if isinstance(box, list) and len(box) >= 12:
        hx = abs(float(box[3] or 0.0)) + abs(float(box[6] or 0.0)) + abs(float(box[9] or 0.0))
        hy = abs(float(box[4] or 0.0)) + abs(float(box[7] or 0.0)) + abs(float(box[10] or 0.0))
        hz = abs(float(box[5] or 0.0)) + abs(float(box[8] or 0.0)) + abs(float(box[11] or 0.0))
        he = [round(max(hx, 1.0), 2), round(max(hy, 1.0), 2), round(max(hz, 1.0), 2)]
        return float(box[0] or 0.0), float(box[1] or 0.0), float(box[2] or 0.0), he
    return 0.0, 0.0, 0.0, None


def _extract_tileset_georef_and_fix_axis(tileset_path: str, geoid_sep_m: float = 17.2) -> Dict[str, Any]:
    """
    Inspects a 3D Tiles tileset.json on disk:
    1. Automatically removes erroneous 'gltfUpAxis': 'z' when child tiles are Y-up .glb files (PIX4Dmatic export quirk).
    2. Extracts tight 3D mesh centroid in TWD97 (E, N, H) and WGS84 (lat, lon) from root.transform * tight_leaf_center.
    """
    out: Dict[str, Any] = {}
    if not (tileset_path and os.path.isfile(tileset_path) and tileset_path.lower().endswith(".json")):
        return out
    try:
        with open(tileset_path, "r", encoding="utf-8") as f:
            ts = json.load(f)
        asset = ts.get("asset") or {}
        raw_str = json.dumps(ts)
        has_root_tf = bool((ts.get("root") or {}).get("transform"))
        if str(asset.get("gltfUpAxis", "")).lower() == "z" and has_root_tf and ".glb" in raw_str.lower():
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
        region = bv.get("region")

        lx, ly, lz, tight_he = _walk_tight_leaf_center_and_extents(root)
        dom_center = (ts.get("extras") or {}).get("dominantIslandCenter")
        root_box = bv.get("box")
        if isinstance(dom_center, list) and len(dom_center) >= 3:
            lx, ly, lz = float(dom_center[0]), float(dom_center[1]), float(dom_center[2])
        elif (
            isinstance(root_box, list)
            and len(root_box) >= 12
            and (
                abs(float(root_box[3] or 0.0) - float(root_box[11] or 0.0)) > 0.5
                or "gatheringcloud" in str(asset.get("generator") or "").lower()
            )
        ):
            r_hx = abs(float(root_box[3] or 0.0)) + abs(float(root_box[6] or 0.0)) + abs(float(root_box[9] or 0.0))
            r_hy = abs(float(root_box[4] or 0.0)) + abs(float(root_box[7] or 0.0)) + abs(float(root_box[10] or 0.0))
            # Only use root_box center if it is not a huge multi-island midpoint (>1,000m half-extent)
            if max(r_hx, r_hy) <= 1000.0 or not tight_he:
                lx, ly, lz = float(root_box[0] or 0.0), float(root_box[1] or 0.0), float(root_box[2] or 0.0)
        if tight_he:
            out["half_extents"] = tight_he

        if isinstance(transform, list) and len(transform) >= 16:
            wx, wy, wz = _mat4_mul_pt([float(v or 0.0) for v in transform[:16]], lx, ly, lz)
        else:
            wx, wy, wz = lx, ly, lz

        # 1. ECEF (EPSG:4978) root.transform (e.g. PIX4Dmatic *-cesium_mesh.json)
        if abs(wx) > 1000000.0 and abs(wy) > 1000000.0:
            lat, lon, h_ellip = _ecef_to_wgs84(wx, wy, wz)
            if 20.0 <= lat <= 27.0 and 118.0 <= lon <= 123.5:
                ortho_h = round(h_ellip - geoid_sep_m, 2)
                twd_e, twd_n, twd_h = wgs84_to_twd97(lat, lon, ortho_h)
                out.update(
                    {
                        "lat": round(lat, 6),
                        "lon": round(lon, 6),
                        "elev_m": twd_h,
                        "twd97_e": twd_e,
                        "twd97_n": twd_n,
                        "twd97_h": twd_h,
                        "crs": TWD97_TWVD2001_SHORT,
                    }
                )
            else:
                utm_e, utm_n, zone, hemi = wgs84_to_utm(lat, lon)
                out.update(
                    {
                        "lat": round(lat, 6),
                        "lon": round(lon, 6),
                        "elev_m": round(h_ellip, 2),
                        "twd97_e": utm_e,
                        "twd97_n": utm_n,
                        "twd97_h": round(h_ellip, 2),
                        "crs": f"WGS84 / UTM Zone {zone}{hemi}",
                    }
                )
        # 2. TWD97 TM2-121 (Easting <= 345,000m in Taiwan)
        elif 150000.0 <= wx <= 345000.0 and 2400000.0 <= wy <= 2850000.0:
            lat, lon = twd97_to_wgs84(wx, wy)
            out.update(
                {
                    "lat": lat,
                    "lon": lon,
                    "elev_m": round(wz, 2),
                    "twd97_e": round(wx, 3),
                    "twd97_n": round(wy, 3),
                    "twd97_h": round(wz, 2),
                    "crs": TWD97_TWVD2001_SHORT,
                }
            )
        # 3. WGS84 / UTM Zone 51N (Easting ~345,000..400,000m in Northern Taiwan)
        elif 100000.0 <= wx <= 850000.0 and 2500000.0 <= wy <= 3000000.0:
            lat, lon = utm51n_to_wgs84(wx, wy)
            twd_e, twd_n, twd_h = wgs84_to_twd97(lat, lon, wz)
            out.update(
                {
                    "lat": lat,
                    "lon": lon,
                    "elev_m": twd_h,
                    "twd97_e": twd_e,
                    "twd97_n": twd_n,
                    "twd97_h": twd_h,
                    "crs": TWD97_TWVD2001_SHORT,
                }
            )
        # 4. 3D Tiles boundingVolume.region [west_rad, south_rad, east_rad, north_rad, min_h, max_h]
        elif isinstance(region, list) and len(region) >= 5:
            lon = math.degrees((float(region[0]) + float(region[2])) * 0.5)
            lat = math.degrees((float(region[1]) + float(region[3])) * 0.5)
            elev = (float(region[4]) + float(region[5])) * 0.5 if len(region) >= 6 else float(region[4] or 0.0)
            twd_e, twd_n, twd_h = wgs84_to_twd97(lat, lon, elev)
            out.update(
                {
                    "lat": round(lat, 6),
                    "lon": round(lon, 6),
                    "elev_m": twd_h,
                    "twd97_e": twd_e,
                    "twd97_n": twd_n,
                    "twd97_h": twd_h,
                    "crs": TWD97_TWVD2001_SHORT,
                }
            )
        else:
            out["local_center"] = [round(wx, 3), round(wy, 3), round(wz, 3)]
            out["is_local_origin"] = True
    except Exception:
        pass
    return out


def _get_imported_opf_roots(folder_path: str) -> List[str]:
    """Reads PIX4Dmatic project/configs/opf.json (if present) to locate original OPF capture folders."""
    roots: List[str] = []
    for rel_cfg in (os.path.join("project", "configs", "opf.json"), os.path.join("configs", "opf.json")):
        cfg_p = os.path.join(folder_path, rel_cfg)
        if os.path.isfile(cfg_p):
            try:
                with open(cfg_p, "r", encoding="utf-8", errors="ignore") as f:
                    obj = json.load(f)
                imp = obj.get("imported-opf") or []
                if isinstance(imp, dict):
                    imp = [imp]
                for item in imp:
                    if isinstance(item, dict) and item.get("path"):
                        rdir = os.path.dirname(str(item["path"]))
                        if os.path.isdir(rdir) and rdir not in roots:
                            roots.append(rdir)
            except Exception:
                pass
    return roots


def _detect_project_geoid_separation_and_ortho_h(folder_path: str, cameras_dir: str = "") -> Tuple[float, Optional[float]]:
    """
    Inspects rtkGPS.csv in the scan folder or its linked OPF capture directory to extract
    exact local GeoidSeparation (m) and median RTK orthometric height (Alt - GeoidSeparation).
    """
    import csv

    search_roots = [folder_path]
    if cameras_dir and os.path.isdir(cameras_dir):
        search_roots.append(cameras_dir)
        parent_cam = os.path.dirname(cameras_dir.rstrip("\\/"))
        if parent_cam and os.path.isdir(parent_cam) and parent_cam not in search_roots:
            search_roots.append(parent_cam)
    search_roots.extend(_get_imported_opf_roots(folder_path))

    for sroot in search_roots:
        for cand_csv in (
            os.path.join(sroot, "rtkGPS.csv"),
            os.path.join(sroot, "geolocations", "rtkGPS.csv"),
            os.path.join(sroot, "inputs", "rtkGPS.csv"),
        ):
            if os.path.isfile(cand_csv):
                try:
                    geoids: List[float] = []
                    ortho_hs: List[float] = []
                    with open(cand_csv, "r", encoding="utf-8", errors="ignore") as cf:
                        reader = csv.DictReader(cf)
                        for i, row in enumerate(reader):
                            if i >= 500:
                                break
                            g_raw = row.get("GeoidSeparation") or row.get("geoid_separation")
                            ref_raw = row.get("ReferenceAltitude") or row.get("reference_altitude")
                            a_raw = (
                                row.get("GPSAltitude")
                                or row.get("Alt")
                                or row.get("Altitude")
                                or row.get("alt")
                            )
                            if g_raw is not None and str(g_raw).strip() != "":
                                g_val = float(g_raw)
                                if 5.0 <= g_val <= 35.0:
                                    geoids.append(g_val)
                                    if ref_raw is not None and str(ref_raw).strip() != "":
                                        ortho_hs.append(float(ref_raw))
                                    elif a_raw is not None and str(a_raw).strip() != "":
                                        ortho_hs.append(float(a_raw) - g_val)
                    if geoids:
                        geoids.sort()
                        med_g = geoids[len(geoids) // 2]
                        med_h = None
                        if ortho_hs:
                            ortho_hs.sort()
                            med_h = round(ortho_hs[len(ortho_hs) // 2], 2)
                        return med_g, med_h
                except Exception:
                    pass
    return 17.2, None


def _sample_georef_from_obj_or_xyz(mesh_or_xyz_path: str) -> Dict[str, Any]:
    """Samples vertex coordinates from a georeferenced .obj or .xyz file when coordinates are in TWD97 or UTM51N."""
    res: Dict[str, Any] = {}
    if not (mesh_or_xyz_path and os.path.isfile(mesh_or_xyz_path)):
        return res
    is_obj = mesh_or_xyz_path.lower().endswith(".obj")
    xs: List[float] = []
    ys: List[float] = []
    zs: List[float] = []
    try:
        fsize = os.path.getsize(mesh_or_xyz_path)
        with open(mesh_or_xyz_path, "rb") as bf:
            # Sample 32 chunks evenly across the file for an unbiased spatial median
            n_chunks = 32 if fsize > 1024 * 1024 else 1
            step = max(fsize // n_chunks, 65536)
            for c_idx in range(n_chunks):
                bf.seek(min(c_idx * step, max(0, fsize - 32768)))
                chunk = bf.read(32768).decode("ascii", errors="ignore")
                lines = chunk.splitlines()[1:-1] if c_idx > 0 else chunk.splitlines()
                for ln in lines[:120]:
                    if is_obj:
                        if not ln.startswith("v "):
                            continue
                        parts = ln[2:].split()
                    else:
                        parts = ln.split()
                    if len(parts) >= 3:
                        try:
                            vx, vy, vz = float(parts[0]), float(parts[1]), float(parts[2])
                            if abs(vx) > 100000.0 and abs(vy) > 1000000.0:
                                xs.append(vx)
                                ys.append(vy)
                                zs.append(vz)
                        except ValueError:
                            continue
        if xs:
            xs.sort()
            ys.sort()
            zs.sort()
            mx = (xs[0] + xs[-1]) * 0.5
            my = (ys[0] + ys[-1]) * 0.5
            mz = zs[len(zs) // 2]
            if 150000.0 <= mx <= 345000.0 and 2400000.0 <= my <= 2850000.0:
                lat, lon = twd97_to_wgs84(mx, my)
                res.update(
                    {
                        "lat": lat,
                        "lon": lon,
                        "elev_m": round(mz, 2),
                        "twd97_e": round(mx, 3),
                        "twd97_n": round(my, 3),
                        "twd97_h": round(mz, 2),
                        "crs": TWD97_TWVD2001_SHORT,
                    }
                )
            elif 100000.0 <= mx <= 850000.0 and 2500000.0 <= my <= 3000000.0:
                lat, lon = utm51n_to_wgs84(mx, my)
                twd_e, twd_n, twd_h = wgs84_to_twd97(lat, lon, mz)
                res.update(
                    {
                        "lat": lat,
                        "lon": lon,
                        "elev_m": twd_h,
                        "twd97_e": twd_e,
                        "twd97_n": twd_n,
                        "twd97_h": twd_h,
                        "crs": TWD97_TWVD2001_SHORT,
                    }
                )
    except Exception:
        pass
    return res


def _extract_authentic_project_georef(
    folder_path: str,
    tileset_path: str,
    obj_path: str = "",
    cameras_dir: str = "",
) -> Dict[str, Any]:
    """
    Extracts 100% authentic scan-derived coordinates by inspecting:
    1. Primary tileset.json (root.transform * tight_leaf_center)
    2. Sibling / PIX4Dmatic project/exports *-cesium_mesh.json (ECEF transform * tight_leaf_center)
    3. offset.xyz sidecars
    4. Georeferenced mesh.obj or dense_point_cloud.xyz in folder_path / project/exports
    5. Linked OPF input_cameras.json / rtkGPS.csv / JPEG EXIF
    Returns lat=None, lon=None, crs='LOCAL_ORIGIN' if the scan has no georeferencing on disk.
    """
    import glob

    geoid_sep_m, rtk_ortho_h = _detect_project_geoid_separation_and_ortho_h(folder_path, cameras_dir=cameras_dir)
    out = _extract_tileset_georef_and_fix_axis(tileset_path, geoid_sep_m=geoid_sep_m)

    # Fallback A: inspect PIX4Dmatic *-cesium_mesh.json in project/exports or tileset/
    if out.get("lat") is None:
        cesium_jsons = glob.glob(os.path.join(folder_path, "project", "exports", "**", "*-cesium_mesh.json"), recursive=True)
        cesium_jsons.extend(glob.glob(os.path.join(folder_path, "tileset", "*-cesium_mesh.json")))
        for cj in cesium_jsons:
            c_geo = _extract_tileset_georef_and_fix_axis(cj, geoid_sep_m=geoid_sep_m)
            if c_geo.get("lat") is not None:
                he = out.get("half_extents") or c_geo.get("half_extents")
                out.update(c_geo)
                if he:
                    out["half_extents"] = he
                break

    # Fallback B: inspect offset.xyz
    if out.get("lat") is None:
        off_candidates = [
            os.path.join(folder_path, "offset.xyz"),
            os.path.join(os.path.dirname(obj_path), "offset.xyz") if obj_path else "",
            os.path.join(os.path.dirname(tileset_path), "offset.xyz") if tileset_path else "",
        ]
        for cand_off in off_candidates:
            if cand_off and os.path.isfile(cand_off):
                try:
                    with open(cand_off, "r", encoding="utf-8", errors="ignore") as f_off:
                        pts = f_off.read().strip().split()
                    if len(pts) >= 3:
                        ox, oy, oz = float(pts[0]), float(pts[1]), float(pts[2])
                        if abs(ox) > 100.0 and abs(oy) > 100.0:
                            if _apply_extracted_coords_to_info(out, ox, oy, oz):
                                break
                except Exception:
                    pass

    # Fallback C: inspect georeferenced mesh.obj or .xyz in folder_path / project/exports
    if out.get("lat") is None:
        mesh_cands = [obj_path] if obj_path else []
        mesh_cands.extend(glob.glob(os.path.join(folder_path, "project", "exports", "**", "*.obj"), recursive=True))
        mesh_cands.extend(glob.glob(os.path.join(folder_path, "project", "exports", "*.xyz")))
        for mc in mesh_cands:
            m_geo = _sample_georef_from_obj_or_xyz(mc)
            if m_geo.get("lat") is not None:
                out.update(m_geo)
                break

    # Fallback D: inspect OPF input_cameras.json / JPEG EXIF in cameras_dir or linked opf.json
    if out.get("lat") is None:
        cam_roots = [cameras_dir] if (cameras_dir and os.path.isdir(cameras_dir)) else []
        cam_roots.extend(_get_imported_opf_roots(folder_path))
        for croot in cam_roots:
            try:
                opf_meta = extract_opf_zip_metadata(croot)
                if opf_meta.get("lat") is not None and opf_meta.get("lon") is not None:
                    out.update(
                        {
                            "lat": opf_meta["lat"],
                            "lon": opf_meta["lon"],
                            "elev_m": opf_meta["elev_m"],
                            "twd97_e": opf_meta["twd97_e"],
                            "twd97_n": opf_meta["twd97_n"],
                            "twd97_h": opf_meta["twd97_h"],
                            "crs": TWD97_TWVD2001_SHORT,
                        }
                    )
                    break
            except Exception:
                pass

    # Refine vertical datum if single-session uncalibrated barometric GPS drifted strongly negative (e.g. -116m)
    # while the scan's own RTK CSV log recorded the true orthometric ground height
    if out.get("lat") is not None and float(out.get("elev_m") or 0.0) < -50.0 and rtk_ortho_h is not None:
        out["elev_m"] = rtk_ortho_h
        out["twd97_h"] = rtk_ortho_h

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
    candidates = [
        os.path.join(folder_path, "_dsm_cache_v5.npz"),
        os.path.join(folder_path, "_dsm_cache_v4.npz"),
        os.path.join(folder_path, "_dsm_cache_v3.npz"),
    ]
    if tileset_path:
        tdir = os.path.dirname(tileset_path)
        candidates.append(os.path.join(tdir, "_dsm_cache_v5.npz"))
        candidates.append(os.path.join(tdir, "_dsm_cache_v4.npz"))
        candidates.append(os.path.join(tdir, "_dsm_cache_v3.npz"))
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
        hx = float(half_extents[0] or 0.0)
        hy = float(half_extents[1] or 0.0)
        if hx > 0.0 and hy > 0.0:
            return round((hx * 2.0) * (hy * 2.0) * 0.68, 1)
    return 0.0


def _infer_capture_date_from_name(folder_name: str, fallback_mtime: float) -> str:
    """Extracts YYYY-MM-DD (and optional HH:MM) from folder names with YYYYMMDD or YYMMDD date stamps."""
    time_part = datetime.fromtimestamp(fallback_mtime).strftime("%H:%M")
    m_full = re.search(r"(20\d{2})[-_]?([01]\d)[-_]?([0-3]\d)(?:[-_]([0-2]\d)[-_]([0-5]\d))?", folder_name)
    if m_full:
        hh_mm = f"{m_full.group(4)}:{m_full.group(5)}" if (m_full.group(4) and m_full.group(5)) else time_part
        return f"{m_full.group(1)}-{m_full.group(2)}-{m_full.group(3)} {hh_mm}"
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
    "meshes",
    "opf_files",
    "point_clouds",
    "region_of_interest",
    "geolocations",
    "metadata",
    "reports",
    "commentphotos",
    "comment_photos",
    "gdrive_comment_photos",
    "cameras_cache",
    "categorization_cache",
    "thumbnails",
    "streampackages",
}


def _is_raw_pix4dcatch_opf_folder(folder_path: str) -> bool:
    """
    Returns True if folder_path is an uncompressed Pix4DCatch OPF capture folder
    (contains project.opf, projectManifest.json, or opf_files/input_cameras.json)
    that has NOT been tiled into a completed web scan (no tileset/tileset.json or scan_meta.json).
    Note: Pix4DCatch saves a low-res mobile AR preview mesh in `meshes/mesh.obj`;
    that preview mesh must NOT cause the folder to be mistaken for a completed scan!
    """
    if not os.path.isdir(folder_path):
        return False
    if os.path.isfile(os.path.join(folder_path, "tileset", "tileset.json")) or os.path.isfile(
        os.path.join(folder_path, "scan_meta.json")
    ):
        return False
    return (
        os.path.isfile(os.path.join(folder_path, "project.opf"))
        or os.path.isfile(os.path.join(folder_path, "projectManifest.json"))
        or os.path.isfile(os.path.join(folder_path, "opf_files", "input_cameras.json"))
    )


def _is_direct_scan_folder(folder_path: str) -> bool:
    """
    Returns True if folder_path itself is directly a scan folder (contains scan_meta.json,
    tileset.json, *-cesium_mesh.json, *.obj, or *.glb at root, or tileset/tileset.json).
    """
    if not os.path.isdir(folder_path):
        return False
    if _is_raw_pix4dcatch_opf_folder(folder_path):
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
                or low.endswith(".ply")
                or low.endswith(".splat")
            ):
                return True
    except Exception:
        pass
    return False


def _folder_has_completed_scan_assets(folder_path: str) -> bool:
    """Checks if a folder contains completed scan assets (.obj, .glb, .ply, .splat, tileset.json, *-cesium_mesh.json, scan_meta.json)."""
    if not os.path.isdir(folder_path):
        return False
    if _is_raw_pix4dcatch_opf_folder(folder_path):
        return False
    folder_name = os.path.basename(folder_path.rstrip("\\/"))
    if folder_name.lower() in INTERNAL_ASSET_DIRS:
        return False
    for root, dirs, files in os.walk(folder_path):
        # Do not descend into Pix4DCatch mobile preview `meshes/` or raw `images/`/`opf_files/`
        dirs[:] = [d for d in dirs if d.lower() not in ("meshes", "opf_files", "point_clouds", "images", "inputs", "logs", "temp")]
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
                or (low.endswith(".ply") and rel_depth <= 1)
                or (low.endswith(".splat") and rel_depth <= 1)
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
                    if fn.lower() == "scan_meta.json" and d_stat.st_mtime >= s_stat.st_mtime:
                        need_copy = False
                    elif d_stat.st_size == s_stat.st_size and abs(d_stat.st_mtime - s_stat.st_mtime) < 2.0:
                        need_copy = False
                if need_copy:
                    shutil.copy2(s_file, d_file)
                    copied_any = True
            except Exception as e:
                print(f"[GDriveWatcher] Warning copying {s_file} -> {d_file}: {e}")

    if copied_any:
        print(f"[GDriveWatcher] Synced completed scan folder from Google Drive to local disk: {src_folder} -> {dst_folder}")
    return dst_folder


_AUTO_TILE_ATTEMPTED_CACHE: Dict[str, float] = {}


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

    # Auto-detect tileset.json, .glb, or .obj inside folder_path (strictly excluding inputs/, images/, meshes/, opf_files/, etc.)
    _SKIP_WALK_DIRS = {"inputs", "images", "meshes", "opf_files", "point_clouds", "processing", "logs", "temp", "configs"}
    tileset_path = meta.get("tileset_path", "")
    obj_candidates: List[str] = []
    if not (tileset_path and os.path.isfile(tileset_path)):
        candidate_ts = [
            os.path.join(folder_path, "tileset", "tileset.json"),
            os.path.join(folder_path, "tileset.json"),
        ]
        glb_fallbacks = []
        for root, dirs, files in os.walk(folder_path):
            dirs[:] = [d for d in dirs if d.lower() not in _SKIP_WALK_DIRS]
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
                    fp_obj = os.path.join(root, fn)
                    try:
                        if os.path.getsize(fp_obj) > 1024:
                            obj_candidates.append(fp_obj)
                    except OSError:
                        pass
        for c in candidate_ts + glb_fallbacks:
            if os.path.isfile(c):
                tileset_path = c
                break
    else:
        for root, dirs, files in os.walk(folder_path):
            dirs[:] = [d for d in dirs if d.lower() not in _SKIP_WALK_DIRS]
            rel_depth = os.path.relpath(root, folder_path).count(os.sep)
            if rel_depth > 2:
                continue
            for fn in files:
                if fn.lower().endswith(".obj"):
                    fp_obj = os.path.join(root, fn)
                    try:
                        if os.path.getsize(fp_obj) > 1024:
                            obj_candidates.append(fp_obj)
                    except OSError:
                        pass

    # Auto-detect obj_path if not already valid (ignore mobile preview meshes inside inputs/ and 0-byte .obj files)
    obj_path = meta.get("obj_path", "")
    if obj_path and ("\\inputs\\" in obj_path.lower() or "/inputs/" in obj_path.lower() or "\\meshes\\" in obj_path.lower()):
        obj_path = ""
    if obj_path and os.path.isfile(obj_path):
        try:
            if os.path.getsize(obj_path) <= 1024:
                obj_path = ""
        except OSError:
            obj_path = ""
    if not (obj_path and os.path.isfile(obj_path)):
        cand_obj = os.path.join(folder_path, "mesh.obj")
        exp_obj = os.path.join(folder_path, "exports", "obj_mesh", "mesh.obj")
        if os.path.isfile(exp_obj) and os.path.getsize(exp_obj) > 1024:
            obj_path = exp_obj
        elif os.path.isfile(cand_obj) and os.path.getsize(cand_obj) > 1024:
            obj_path = cand_obj
        elif obj_candidates:
            obj_path = obj_candidates[0]
        else:
            obj_path = ""

    stat = os.stat(folder_path)
    default_id = (
        folder_name
        if folder_name.lower().startswith("catch_")
        else re.sub(r"[^a-zA-Z0-9_]", "_", folder_name.lower())
    )
    scan_id = meta.get("scan_id") or default_id
    if scan_id.lower().startswith("catch_") and folder_name.lower().startswith("catch_"):
        scan_id = folder_name

    # If a 3D Gaussian Splat (.ply / .compressed.ply / .splat) was dropped into folder_path,
    # auto-convert it into a tileset + splats.gsplat + oriented surfel GLB + thumbnail.png
    try:
        from pc_worker.gaussian_splat_builder import (
            find_gaussian_splat_source_in_folder,
            build_gaussian_splat_tileset,
        )

        gsplat_src = find_gaussian_splat_source_in_folder(folder_path)
        if gsplat_src and os.path.isfile(gsplat_src):
            built_gs_ts = build_gaussian_splat_tileset(scan_id, folder_path, gsplat_src, force=False)
            if built_gs_ts and os.path.isfile(built_gs_ts):
                tileset_path = built_gs_ts
    except Exception as e_gs:
        print(f"[GDriveWatcher] Warning checking Gaussian Splat in {folder_path}: {e_gs}")

    # If a completed .obj mesh was dropped without a 3D tileset, auto-build a 4K quadtree tileset on local disk
    # using postprocess_obj_to_tileset so offset.xyz (UTM51N / TWD97) and .mtl Kd factors are properly applied.
    if not (tileset_path and os.path.isfile(tileset_path)) and obj_path and os.path.isfile(obj_path) and os.path.getsize(obj_path) > 1024:
        abs_raw_obj = os.path.abspath(obj_path)
        try:
            obj_mtime = os.path.getmtime(abs_raw_obj)
        except OSError:
            obj_mtime = 0.0
        if _AUTO_TILE_ATTEMPTED_CACHE.get(abs_raw_obj) != obj_mtime:
            _AUTO_TILE_ATTEMPTED_CACHE[abs_raw_obj] = obj_mtime
            try:
                from pc_worker.pix4d_runner import postprocess_obj_to_tileset

                print(f"[GDriveWatcher] Auto-tiling standalone OBJ mesh with offset.xyz support: {obj_path}")
                built_ts = postprocess_obj_to_tileset(scan_id, folder_path, obj_path)
                if built_ts and os.path.isfile(built_ts):
                    tileset_path = built_ts
            except Exception as e:
                print(f"[GDriveWatcher] Warning in postprocess_obj_to_tileset for {obj_path}, falling back to QuadtreeTiler: {e}")
                try:
                    import sys
                    from pc_worker.config import GC_SCAN_OPTIMIZER_DIR
                    if GC_SCAN_OPTIMIZER_DIR and os.path.isdir(GC_SCAN_OPTIMIZER_DIR) and GC_SCAN_OPTIMIZER_DIR not in sys.path:
                        sys.path.append(GC_SCAN_OPTIMIZER_DIR)
                    from optimizer.quadtree_tiler import QuadtreeTiler  # type: ignore
                    auto_ts_dir = os.path.join(folder_path, "tileset")
                    os.makedirs(auto_ts_dir, exist_ok=True)
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
                except Exception as e2:
                    print(f"[GDriveWatcher] Warning auto-tiling standalone OBJ {obj_path}: {e2}")

    if not (tileset_path and os.path.isfile(tileset_path)):
        return None

    try:
        from pc_worker.preview_generator import (
            ensure_scan_low_quality_preview,
            ensure_scan_full_quality_thumbnail,
        )

        ensure_scan_low_quality_preview(tileset_path, force=False)
        ensure_scan_full_quality_thumbnail(tileset_path, scan_id, project_dir=folder_path, force=False)
    except Exception as e:
        print(f"[GDriveWatcher] Warning generating preview/thumbnail for {tileset_path}: {e}")

    # Auto-detect cameras_dir
    cameras_dir = meta.get("cameras_dir", "")
    if not (cameras_dir and os.path.isdir(cameras_dir)):
        for sub in ("inputs", "Inputs", "images", "Images"):
            cdir = os.path.join(folder_path, sub)
            if os.path.isdir(cdir):
                cameras_dir = cdir
                break

    ts_georef = _extract_authentic_project_georef(
        folder_path, tileset_path, obj_path=obj_path, cameras_dir=cameras_dir
    )

    if ts_georef.get("lat") is not None and ts_georef.get("lon") is not None:
        lat: Optional[float] = float(ts_georef["lat"])
        lon: Optional[float] = float(ts_georef["lon"])
        elev_m = float(ts_georef.get("elev_m") if ts_georef.get("elev_m") is not None else 0.0)
        twd_e = float(ts_georef.get("twd97_e") if ts_georef.get("twd97_e") is not None else 0.0)
        twd_n = float(ts_georef.get("twd97_n") if ts_georef.get("twd97_n") is not None else 0.0)
        twd_h = float(ts_georef.get("twd97_h") if ts_georef.get("twd97_h") is not None else elev_m)
        raw_crs = str(meta.get("crs") or "").strip()
        crs_val = raw_crs if (raw_crs and "LOCAL" not in raw_crs.upper()) else TWD97_TWVD2001_SHORT
    elif (
        meta.get("lat") is not None
        and meta.get("lon") is not None
        and (abs(float(meta["lat"])) > 0.001 or abs(float(meta["lon"])) > 0.001)
        and "LOCAL" not in str(meta.get("crs") or "").upper()
    ):
        lat = float(meta["lat"])
        lon = float(meta["lon"])
        elev_m = float(meta.get("elev_m") or 0.0)
        twd_e = float(meta.get("twd97_e") or 0.0)
        twd_n = float(meta.get("twd97_n") or 0.0)
        twd_h = float(meta.get("twd97_h") if meta.get("twd97_h") is not None else elev_m)
        crs_val = str(meta.get("crs") or TWD97_TWVD2001_SHORT)
    else:
        lat = None
        lon = None
        elev_m = 0.0
        twd_e = 0.0
        twd_n = 0.0
        twd_h = 0.0
        crs_val = "LOCAL_ORIGIN"

    is_gaussian_splat = bool(meta.get("is_gaussian_splat"))
    splat_count = int(meta.get("splat_count") or 0)
    gaussian_splat_uri = str(meta.get("gaussian_splat_uri") or "")
    if tileset_path and tileset_path.lower().endswith(".json") and os.path.isfile(tileset_path):
        try:
            with open(tileset_path, "r", encoding="utf-8") as tsf:
                ts_doc_peek = json.load(tsf)
            ts_extras = ts_doc_peek.get("extras") or {}
            if ts_extras.get("is_gaussian_splat"):
                is_gaussian_splat = True
                splat_count = int(ts_extras.get("splat_count") or splat_count or 0)
                gaussian_splat_uri = str(ts_extras.get("gaussian_splat_uri") or "tiles/splats.gsplat")
        except Exception:
            pass

    # Check library_folders.json for explicit admin move assignments
    lib_assign: Optional[Dict[str, Any]] = None
    try:
        from pc_worker.config import DATA_DIR
        lib_reg_path = os.path.join(DATA_DIR, "library_folders.json")
        if os.path.isfile(lib_reg_path):
            with open(lib_reg_path, "r", encoding="utf-8") as lrf:
                lib_reg = json.load(lrf)
            if isinstance(lib_reg, dict):
                assigns = lib_reg.get("scan_assignments") or {}
                if scan_id.lower() in assigns and isinstance(assigns[scan_id.lower()], dict):
                    lib_assign = assigns[scan_id.lower()]
    except Exception:
        pass

    proj_group = meta.get("project_group")
    proj_zh = meta.get("project_name_zh")
    group_type = str(meta.get("group_type") or "").strip().lower()
    user_edited_project = bool(meta.get("user_edited_project"))

    if lib_assign and lib_assign.get("project_group"):
        proj_group = str(lib_assign["project_group"]).strip()
        proj_zh = str(lib_assign.get("project_name_zh") or proj_group)
        group_type = "site" if str(lib_assign.get("group_type") or "").lower() == "site" else "library"
        if group_type == "library":
            from pc_worker.priority_queue import ScanQueueDB
            proj_group, proj_zh = ScanQueueDB._normalize_library_folder_names(proj_group, proj_zh)
        user_edited_project = True
    elif user_edited_project and proj_group and proj_group != "Unassigned Site":
        if group_type not in ("site", "library"):
            group_type = "site" if (lat is not None and lon is not None and crs_val != "LOCAL_ORIGIN") else "library"
        if group_type == "site":
            proj_group, proj_zh = _apply_site_rename_override(proj_group, proj_zh or f"{proj_group} 工程掃描群組")
        else:
            from pc_worker.priority_queue import ScanQueueDB
            proj_group, proj_zh = ScanQueueDB._normalize_library_folder_names(proj_group, proj_zh or "")
    elif lat is None or lon is None or crs_val == "LOCAL_ORIGIN":
        # Non-georeferenced model (not tied to map) -> 3D Model Library folder
        group_type = "library"
        if parent_project:
            from pc_worker.priority_queue import ScanQueueDB
            proj_group, proj_zh = ScanQueueDB._normalize_library_folder_names(parent_project, parent_project)
        else:
            fn_low = folder_name.lower()
            if any(k in fn_low for k in ("jishi", "person", "people", "human", "man", "woman", "avatar", "character", "人物", "人像")):
                proj_group = "People"
                proj_zh = "人物與角色"
            elif any(k in fn_low for k in ("equip", "machine", "excavator", "truck", "crane", "tool", "drone", "device", "機具", "設備")):
                proj_group = "Equipment"
                proj_zh = "機具與設備"
            else:
                proj_group = "General Models"
                proj_zh = "一般 3D 模型"
    else:
        group_type = "site"
        if parent_project:
            proj_group, proj_zh = match_project_group(
                lat, lon, hint_name=folder_name, parent_project=parent_project, dynamic_clusters=dynamic_clusters
            )
        elif not proj_group or proj_group == "Unassigned Site":
            proj_group, proj_zh = match_project_group(
                lat,
                lon,
                hint_name=folder_name,
                parent_project=parent_project,
                dynamic_clusters=dynamic_clusters,
            )
        else:
            proj_group, proj_zh = _apply_site_rename_override(proj_group, proj_zh or f"{proj_group} 工程掃描群組")

    if (
        dynamic_clusters is not None
        and lat is not None
        and lon is not None
        and (abs(lat) > 0.001 or abs(lon) > 0.001)
        and not any(c.get("project_group") == proj_group for c in dynamic_clusters)
    ):
        dynamic_clusters.append(
            {
                "project_group": proj_group,
                "project_name_zh": proj_zh or f"{proj_group} 工程掃描群組",
                "lat": lat,
                "lon": lon,
                "radius_m": 1000.0,
            }
        )

    disk_bytes, est_imgs = (0, 0)
    raw_meta_imgs = int(meta.get("image_count") or 0)
    if "size_bytes" not in meta or raw_meta_imgs <= 0 or raw_meta_imgs > 25000:
        disk_bytes, est_imgs = _compute_folder_stats(folder_path)
        if raw_meta_imgs > 25000:
            raw_meta_imgs = est_imgs

    half_extents = ts_georef.get("half_extents", [50.0, 50.0, 15.0])
    covered_area_m2 = float(meta.get("covered_area_m2") or 0.0)
    if covered_area_m2 <= 0.0:
        covered_area_m2 = _compute_scan_covered_area_m2(folder_path, tileset_path, half_extents)

    user_edited = bool(meta.get("user_edited_name"))
    default_display_name = folder_name[6:] if folder_name.lower().startswith("catch_") and len(folder_name) > 6 else folder_name
    src_zip_first = (meta.get("source_zip_path") or "").split(";")[0].strip()
    if src_zip_first and not user_edited:
        zip_base, _, _ = parse_multipart_zip_filename(os.path.basename(src_zip_first))
        if zip_base:
            default_display_name = zip_base
    resolved_name = (meta.get("name") or "").strip() if user_edited else default_display_name
    if not resolved_name:
        resolved_name = default_display_name

    resolved_uploader_name, resolved_uploader_email = normalize_gatheren_uploader(
        meta.get("uploader_name", ""),
        meta.get("uploader_email", "glibivanov@gatheren.com.tw"),
        meta.get("source_zip_path") or meta.get("name") or meta.get("derived_from_scan_id") or folder_name,
    )

    bbox_center = [twd_e, twd_n, twd_h] if lat is not None else (ts_georef.get("local_center") or [0.0, 0.0, 0.0])
    ts_ver = (
        int(os.path.getmtime(tileset_path) * 1000)
        if (tileset_path and os.path.isfile(tileset_path))
        else int(meta.get("tileset_version") or (stat.st_mtime * 1000))
    )

    tex_res_val = int(meta.get("texture_resolution", PIX4DMATIC_TEXTURE_SIZE))
    tex_k_label = "3DGS Splat" if is_gaussian_splat else ("16K" if tex_res_val >= 12288 else ("8K" if tex_res_val >= 6144 else ("4K" if tex_res_val >= 3072 else "2K")))
    default_stage_lbl = (
        f"Completed (3D Gaussian Splat, {splat_count:,} splats)"
        if is_gaussian_splat
        else f"Completed ({crs_val}, {tex_k_label} Web Tileset)"
    )
    result_item = {
        "scan_id": scan_id,
        "name": resolved_name,
        "user_edited_name": 1 if user_edited else 0,
        "project_group": proj_group,
        "project_name_zh": proj_zh or ("模型庫" if group_type == "library" else "工程掃描群組"),
        "group_type": group_type,
        "user_edited_project": user_edited_project,
        "is_gaussian_splat": is_gaussian_splat,
        "splat_count": splat_count,
        "gaussian_splat_uri": gaussian_splat_uri,
        "capture_date": meta.get("capture_date") or _infer_capture_date_from_name(folder_name, stat.st_mtime),
        "uploaded_at": float(meta.get("uploaded_at", stat.st_mtime)),
        "uploader_email": resolved_uploader_email,
        "uploader_name": resolved_uploader_name,
        "source_zip_path": meta.get("source_zip_path", ""),
        "project_dir": folder_path,
        "tileset_path": tileset_path,
        "obj_path": obj_path,
        "cameras_dir": cameras_dir,
        "image_count": int(raw_meta_imgs or est_imgs or 0),
        "size_bytes": int(meta.get("size_bytes") or disk_bytes or 0),
        "covered_area_m2": round(covered_area_m2, 1),
        "rtk_accuracy_cm": float(meta.get("rtk_accuracy_cm", 1.5)),
        "crs": crs_val,
        "texture_resolution": tex_res_val,
        "lat": lat,
        "lon": lon,
        "elev_m": elev_m,
        "twd97_e": twd_e,
        "twd97_n": twd_n,
        "twd97_h": twd_h,
        "bounding_box": {
            "center": bbox_center,
            "half_extents": half_extents,
        },
        "tileset_version": ts_ver,
        "status": meta.get("status", "completed"),
        "progress_pct": float(meta.get("progress_pct", 100.0)),
        "stage_label": default_stage_lbl if is_gaussian_splat else meta.get("stage_label", default_stage_lbl),
        "notes": meta.get("notes", f"Dynamically loaded from {folder_path}"),
    }
    if is_gaussian_splat and splat_count > 0:
        result_item["poly_count"] = splat_count
    for extra_key in ("merged_from", "derived_from_scan_id", "applied_adjustments", "poly_count", "home_view"):
        if extra_key in meta and extra_key not in result_item:
            result_item[extra_key] = meta[extra_key]

    # Persist scan_meta.json on local disk whenever georeferencing, bounding_box, or metadata changed
    coords_changed = (
        meta.get("lat") != lat
        or meta.get("lon") != lon
        or meta.get("elev_m") != elev_m
        or meta.get("twd97_e") != twd_e
        or meta.get("twd97_n") != twd_n
        or meta.get("twd97_h") != twd_h
        or meta.get("crs") != crs_val
        or meta.get("bounding_box") != result_item["bounding_box"]
        or meta.get("tileset_version") != ts_ver
    )
    need_write_meta = (
        not os.path.isfile(meta_file)
        or coords_changed
        or not meta.get("covered_area_m2")
        or not meta.get("bounding_box")
        or (not user_edited and meta.get("name") != resolved_name)
        or meta.get("uploader_name") != resolved_uploader_name
        or meta.get("uploader_email") != resolved_uploader_email
        or bool(meta.get("is_gaussian_splat")) != is_gaussian_splat
        or meta.get("group_type") != group_type
        or meta.get("project_group") != proj_group
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
    r"^(?P<base>.+?)[_\-\s\(]+(?P<part>\d+)\s*of\s*(?P<total>\d+)\)?(?:\.zip)?$",
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


def _inspect_raw_photo_scan_folder(folder_path: str) -> Tuple[bool, bool, int, int]:
    """
    Checks whether a folder in Google Drive inbox is a raw photo/Pix4DCatch scan folder
    (not yet processed into .obj/.glb/tileset.json).
    Returns (is_raw_scan, is_settled, jpg_count, total_file_count).
    """
    if not os.path.isdir(folder_path):
        return False, False, 0, 0
    folder_name = os.path.basename(folder_path.rstrip("/\\"))
    if (
        not folder_name
        or folder_name.startswith(("_", "."))
        or folder_name.lower() in INTERNAL_ASSET_DIRS
        or folder_name.lower() in ("streampackages", "inputs")
    ):
        return False, False, 0, 0
    if _folder_has_completed_scan_assets(folder_path):
        return False, False, 0, 0

    jpg_count = 0
    tiff_count = 0
    total_files = 0
    newest_mtime = 0.0
    try:
        images_sub = os.path.join(folder_path, "images")
        if os.path.isdir(images_sub):
            # Fast scandir path (<15ms for 4,500 files on Google Drive File Stream)
            with os.scandir(images_sub) as it:
                for entry in it:
                    if entry.name.startswith("."):
                        continue
                    total_files += 1
                    low = entry.name.lower()
                    if low.endswith((".jpg", ".jpeg", ".png")):
                        jpg_count += 1
                    elif low.endswith((".tiff", ".tif")):
                        tiff_count += 1
                    try:
                        mt = entry.stat().st_mtime
                        if mt > newest_mtime:
                            newest_mtime = mt
                    except OSError:
                        pass
        else:
            for root, _, files in os.walk(folder_path):
                rel_depth = os.path.relpath(root, folder_path).count(os.sep)
                if rel_depth > 2:
                    continue
                for fn in files:
                    if fn.startswith("."):
                        continue
                    fp = os.path.join(root, fn)
                    total_files += 1
                    try:
                        mt = os.path.getmtime(fp)
                        if mt > newest_mtime:
                            newest_mtime = mt
                    except OSError:
                        pass
                    low = fn.lower()
                    if low.endswith((".jpg", ".jpeg", ".png")):
                        jpg_count += 1
                    elif low.endswith((".tiff", ".tif")):
                        tiff_count += 1
    except Exception:
        return False, False, 0, 0

    if jpg_count == 0 and tiff_count == 0:
        return False, False, 0, 0
    if not _is_raw_pix4dcatch_opf_folder(folder_path) and jpg_count < 10 and tiff_count < 10:
        return False, False, 0, 0

    expected_jpgs = (tiff_count // 2) if tiff_count >= 2 else 1
    has_all_expected_jpgs = jpg_count >= max(1, expected_jpgs)
    quiet_seconds = time.time() - newest_mtime if newest_mtime > 0 else 999.0
    is_settled = has_all_expected_jpgs and (quiet_seconds >= 5.0 or (tiff_count >= 2 and jpg_count == expected_jpgs))
    return True, is_settled, jpg_count, total_files


import threading as _threading
_DISCOVERY_LOCK = _threading.RLock()


def seed_and_discover_scans(db: ScanQueueDB) -> List[Dict[str, Any]]:
    with _DISCOVERY_LOCK:
        return _seed_and_discover_scans_locked(db)


def _seed_and_discover_scans_locked(db: ScanQueueDB) -> List[Dict[str, Any]]:
    """
    100% Dynamic, Project-Agnostic Scan Discovery from C:\\GatheringScans (LOCAL_SCANS_ROOT)
    and G:\\Shared drives\\6.軟體\\3. GatheringScans\\INPUTS (GDRIVE_INPUTS_DIR).
    - Google Drive (GDRIVE_INPUTS_DIR / GDRIVE_INBOX_DIR) is strictly an input-only inbox:
      users can upload either directly into `INPUTS\\<ScanOrZip>` or into project subfolders
      `INPUTS\\<Project>\\<ScanOrZip>`.
    - Any completed scan folders dropped into `INPUTS` are automatically copied into
      `C:\\GatheringScans` (LOCAL_SCANS_ROOT) and tiled/indexed from local disk.
    - Raw Pix4DCatch OPF folders (`QiHuTender_1..4`, `2026-09-21-11-39-49`), single-part `.zip`,
      and multi-part (`_1of5.zip`..`_5of5.zip`) archives are queued for PIX4Dmatic processing.
    """
    discovered_ids = set()
    dynamic_clusters: List[Dict[str, Any]] = []
    deleted_reg = db.load_deleted_scans_registry() if hasattr(db, "load_deleted_scans_registry") else {"scan_ids": [], "folder_names": [], "source_paths": []}
    deleted_scan_ids = set(deleted_reg.get("scan_ids") or [])
    deleted_folder_names = set(deleted_reg.get("folder_names") or [])
    deleted_source_paths = set(deleted_reg.get("source_paths") or [])

    def _is_entry_deleted(fname_or_id: str, full_path: str = "") -> bool:
        low_n = (fname_or_id or "").strip().lower()
        if not low_n:
            return False
        if low_n in deleted_scan_ids or low_n in deleted_folder_names or f"catch_{low_n}" in deleted_scan_ids:
            return True
        if full_path:
            try:
                if os.path.normcase(os.path.abspath(full_path)) in deleted_source_paths:
                    return True
            except Exception:
                pass
        return False

    inbox_dirs = []
    if GDRIVE_INBOX_DIR and os.path.isdir(GDRIVE_INBOX_DIR):
        try:
            os.makedirs(GDRIVE_INPUTS_DIR, exist_ok=True)
        except Exception:
            pass
    if GDRIVE_INPUTS_DIR and os.path.isdir(GDRIVE_INPUTS_DIR):
        inbox_dirs.append(GDRIVE_INPUTS_DIR)

    # 0. Sync any completed scan folders from Google Drive (input-only) into C:\GatheringScans (local disk storage)
    #    and collect .zip raw-photo archives AND raw-photo folders for the PIX4Dmatic queue.
    grouped_uploads: Dict[Tuple[str, str, int], Dict[str, Any]] = {}
    seen_zip_keys = set()

    for idir in inbox_dirs:
        for entry in sorted(os.listdir(idir)):
            if entry.startswith(("_", ".")) or entry.lower() in INTERNAL_ASSET_DIRS or entry.lower() in ("streampackages", "inputs"):
                continue
            epath = os.path.join(idir, entry)
            if not is_safe_jailed_path(epath, idir) or _is_entry_deleted(entry, epath):
                continue

            zip_candidates: List[Tuple[str, str, str]] = []
            if os.path.isfile(epath) and entry.lower().endswith(".zip"):
                zip_candidates.append(("", entry, epath))
            elif os.path.isdir(epath):
                # First check if epath itself is directly a completed scan folder
                if _is_direct_scan_folder(epath):
                    _sync_gdrive_folder_to_local_vault(epath, parent_project="")
                else:
                    # Check if epath is a raw photo scan folder (e.g. 2026-09-21-11-39-49)
                    is_raw, _, _, _ = _inspect_raw_photo_scan_folder(epath)
                    if is_raw:
                        zip_candidates.append(("", entry, epath))
                    else:
                        # Otherwise check if epath is a Project Folder containing nested scan folders or .zip archives
                        synced_nested = False
                        for sub_fn in sorted(os.listdir(epath)):
                            if sub_fn.startswith(("_", ".")) or sub_fn.lower() in INTERNAL_ASSET_DIRS:
                                continue
                            sub_fpath = os.path.join(epath, sub_fn)
                            if not is_safe_jailed_path(sub_fpath, idir) or _is_entry_deleted(sub_fn, sub_fpath):
                                continue
                            if os.path.isfile(sub_fpath) and sub_fn.lower().endswith(".zip"):
                                zip_candidates.append((entry, sub_fn, sub_fpath))
                            elif os.path.isdir(sub_fpath):
                                sub_raw, _, _, _ = _inspect_raw_photo_scan_folder(sub_fpath)
                                if sub_raw:
                                    zip_candidates.append((entry, sub_fn, sub_fpath))
                                else:
                                    local_dst = _sync_gdrive_folder_to_local_vault(sub_fpath, parent_project=entry)
                                    if local_dst:
                                        synced_nested = True

                        if not synced_nested and not zip_candidates:
                            _sync_gdrive_folder_to_local_vault(epath, parent_project="")

            for parent_proj, fname, fpath in zip_candidates:
                dedup_key = (parent_proj.lower(), fname.lower())
                if dedup_key in seen_zip_keys:
                    continue
                if os.path.isfile(fpath) and os.path.getsize(fpath) <= 0:
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
        if _is_entry_deleted(item.get("scan_id", ""), item.get("project_dir", "")):
            return
        existing_row = db.get_scan(item["scan_id"])
        if existing_row and existing_row.get("status") in ("queued", "processing", "waiting_parts"):
            item["status"] = existing_row["status"]
            item["progress_pct"] = float(existing_row.get("progress_pct", 0.0))
            item["stage_label"] = existing_row.get("stage_label", "Queued")
            item["force_next"] = int(existing_row.get("force_next", 0))
            item["bypass_count"] = int(existing_row.get("bypass_count", 0))
            if existing_row.get("quality_stage"):
                item["quality_stage"] = existing_row["quality_stage"]
            if existing_row.get("pending_pass"):
                item["pending_pass"] = existing_row["pending_pass"]
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
    active_job_dirs = set()
    active_job_ids = set()
    for r_scan in db.list_scans():
        if r_scan.get("status") in ("processing", "queued", "waiting_parts"):
            active_job_ids.add(r_scan["scan_id"])
            if r_scan.get("project_dir"):
                active_job_dirs.add(os.path.normcase(os.path.abspath(r_scan["project_dir"])))

    if os.path.isdir(LOCAL_SCANS_ROOT):
        for entry in sorted(os.listdir(LOCAL_SCANS_ROOT)):
            if entry.startswith(("_", ".")) or entry.lower() in INTERNAL_ASSET_DIRS:
                continue
            sub_dir = os.path.join(LOCAL_SCANS_ROOT, entry)
            if not is_safe_jailed_path(sub_dir, LOCAL_SCANS_ROOT) or not os.path.isdir(sub_dir):
                continue
            if os.path.normcase(os.path.abspath(sub_dir)) in active_job_dirs or entry in active_job_ids:
                discovered_ids.add(entry)
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
                    if os.path.normcase(os.path.abspath(child_dir)) in active_job_dirs or child_entry in active_job_ids:
                        discovered_ids.add(child_entry)
                        found_nested = True
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

        folder_syncing = False
        sync_jpg_count = 0
        sync_total_files = 0
        for p in present_parts:
            ppath = parts_map[p]
            if os.path.isdir(ppath):
                is_raw, is_settled, j_cnt, tot_cnt = _inspect_raw_photo_scan_folder(ppath)
                sync_jpg_count += j_cnt
                sync_total_files += tot_cnt
                if is_raw and not is_settled:
                    folder_syncing = True

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
        if _is_entry_deleted(scan_id) or _is_entry_deleted(base_name):
            continue
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
        if existing.get("status") in ("processing", "queued", "failed"):
            primary_meta["status"] = existing["status"]
            primary_meta["progress_pct"] = float(existing.get("progress_pct", 0.0))
            primary_meta["stage_label"] = existing.get("stage_label", "Queued")
            primary_meta["tileset_path"] = existing.get("tileset_path", cand_processed_ts if os.path.isfile(cand_processed_ts) else "")
            primary_meta["obj_path"] = existing.get("obj_path", "")
            primary_meta["project_dir"] = existing.get("project_dir", cand_processed_dir)
            primary_meta["force_next"] = int(existing.get("force_next", 0))
            primary_meta["bypass_count"] = int(existing.get("bypass_count", 0))
            if existing.get("quality_stage"):
                primary_meta["quality_stage"] = existing["quality_stage"]
            if existing.get("pending_pass"):
                primary_meta["pending_pass"] = existing["pending_pass"]
        elif all_parts_ready and not folder_syncing and os.path.isfile(cand_processed_ts):
            true_img_cnt = sum(int(m.get("image_count", 0)) for m in part_metas)
            zip_up_name = part_metas[0].get("uploader_name") or ""
            zip_up_email = part_metas[0].get("uploader_email") or ""
            if existing and existing.get("tileset_path"):
                primary_meta = dict(existing)
                primary_meta["source_zip_path"] = ";".join(parts_map[p] for p in present_parts)
                if not existing.get("user_edited_name"):
                    primary_meta["name"] = base_name
                if zip_up_email and (
                    not primary_meta.get("uploader_email")
                    or primary_meta.get("uploader_email", "").lower() == "glibivanov@gatheren.com.tw"
                    or zip_up_email.lower() != "glibivanov@gatheren.com.tw"
                ):
                    primary_meta["uploader_email"] = zip_up_email
                    primary_meta["uploader_name"] = zip_up_name or primary_meta.get("uploader_name", "雲在天")
            primary_meta["project_group"] = proj_group
            primary_meta["project_name_zh"] = proj_zh
            if true_img_cnt > 0:
                primary_meta["image_count"] = true_img_cnt
            primary_meta["tileset_path"] = cand_processed_ts
            primary_meta["project_dir"] = cand_processed_dir
            cand_obj = os.path.join(cand_processed_dir, "exports", "obj_mesh", "mesh.obj")
            if os.path.isfile(cand_obj) and os.path.getsize(cand_obj) > 1024:
                primary_meta["obj_path"] = cand_obj
            primary_meta["status"] = "completed"
            primary_meta["quality_stage"] = "full_hq"
            primary_meta["pending_pass"] = ""
            primary_meta["progress_pct"] = 100.0
            _pm_tex = int(primary_meta.get("texture_resolution", PIX4DMATIC_TEXTURE_SIZE))
            _pm_k = "16K" if _pm_tex >= 12288 else ("8K" if _pm_tex >= 6144 else ("4K" if _pm_tex >= 3072 else "2K"))
            primary_meta["stage_label"] = f"Processed -> {scan_id} (TWD97 + TWVD2001, {_pm_k})"
            # Keep scan_meta.json on disk in sync with parent_proj, uploader, and true_img_cnt
            meta_on_disk = os.path.join(cand_processed_dir, "scan_meta.json")
            if os.path.isfile(meta_on_disk):
                try:
                    with open(meta_on_disk, "r", encoding="utf-8") as mf:
                        m_disk = json.load(mf)
                    if m_disk.get("bounding_box") and not primary_meta.get("bounding_box"):
                        primary_meta["bounding_box"] = m_disk["bounding_box"]
                    if m_disk.get("tileset_version"):
                        primary_meta["tileset_version"] = m_disk["tileset_version"]
                    for coord_k in ("twd97_e", "twd97_n", "twd97_h", "elev_m", "lat", "lon"):
                        if m_disk.get(coord_k) is not None and not primary_meta.get(coord_k):
                            primary_meta[coord_k] = m_disk[coord_k]
                    disk_needs_sync = (
                        m_disk.get("project_group") != proj_group
                        or m_disk.get("image_count") != primary_meta["image_count"]
                        or m_disk.get("uploader_email") != primary_meta.get("uploader_email")
                        or m_disk.get("uploader_name") != primary_meta.get("uploader_name")
                        or m_disk.get("source_zip_path") != primary_meta.get("source_zip_path")
                        or (not existing.get("user_edited_name") and m_disk.get("name") != primary_meta.get("name"))
                        or (cand_obj and os.path.isfile(cand_obj) and os.path.getsize(cand_obj) > 1024 and m_disk.get("obj_path") != cand_obj)
                    )
                    if disk_needs_sync:
                        m_disk["project_group"] = proj_group
                        m_disk["project_name_zh"] = proj_zh
                        m_disk["image_count"] = primary_meta["image_count"]
                        m_disk["source_zip_path"] = primary_meta["source_zip_path"]
                        m_disk["uploader_email"] = primary_meta.get("uploader_email", "glibivanov@gatheren.com.tw")
                        m_disk["uploader_name"] = primary_meta.get("uploader_name", "雲在天")
                        if not existing.get("user_edited_name") and primary_meta.get("name"):
                            m_disk["name"] = primary_meta["name"]
                        if cand_obj and os.path.isfile(cand_obj) and os.path.getsize(cand_obj) > 1024:
                            m_disk["obj_path"] = cand_obj
                        with open(meta_on_disk, "w", encoding="utf-8") as wf:
                            json.dump(m_disk, wf, indent=2, ensure_ascii=False)
                except Exception:
                    pass
        else:
            if folder_syncing:
                primary_meta["status"] = "waiting_parts"
                primary_meta["progress_pct"] = round(min(18.0, (sync_jpg_count / max(119.0, float(sync_jpg_count + 1))) * 18.0), 1)
                primary_meta["stage_label"] = f"Syncing from Google Drive ({sync_jpg_count} photos / {sync_total_files} files)..."
                primary_meta["notes"] = (
                    f"Raw photo folder '{base_name}' is actively syncing from Google Drive "
                    f"({sync_jpg_count} photos, {sync_total_files} total files received so far)."
                )
            elif not all_parts_ready:
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
                primary_meta["quality_stage"] = existing.get("quality_stage") or "full_hq"
                primary_meta["pending_pass"] = ""
                primary_meta["progress_pct"] = existing.get("progress_pct", 100.0)
                primary_meta["stage_label"] = existing.get("stage_label", "Completed")
                primary_meta["tileset_path"] = existing.get("tileset_path", "")
                primary_meta["obj_path"] = existing.get("obj_path", "")
                primary_meta["project_dir"] = existing.get("project_dir", "")
            else:
                primary_meta["status"] = "queued"
                primary_meta["quality_stage"] = "none"
                primary_meta["pending_pass"] = "preview"
                primary_meta["progress_pct"] = 0.0
                if total_parts > 1:
                    primary_meta["stage_label"] = f"Queued for Pass 1/2 Fast 2K Preview (All {total_parts}/{total_parts} parts ready)"
                    primary_meta["notes"] = (
                        f"All {total_parts}/{total_parts} parts uploaded ({', '.join(os.path.basename(parts_map[p]) for p in present_parts)}). "
                        f"Queued for Two-Pass PIX4Dmatic pipeline ({primary_meta['image_count']} RTK photos)."
                    )
                else:
                    primary_meta["stage_label"] = "Queued for Pass 1/2 Fast 2K Preview (TWD97 + TWVD2001)"
                    primary_meta["notes"] = f"Scan '{base_name}' ({primary_meta['image_count']} RTK photos) queued for Pass 1 Fast Preview + Pass 2 Full HQ."

        db.upsert_scan(primary_meta)
        discovered_ids.add(scan_id)

    # 3. Strictly remove any scans from SQLite that are no longer present in C:\GatheringScans or the jailed GDrive inbox
    with db._connect() as conn:
        existing_rows = conn.execute("SELECT scan_id, status, project_dir, source_zip_path FROM scans").fetchall()
        for row in existing_rows:
            sid = row["scan_id"]
            sid_clean = sid[6:].lower() if sid.lower().startswith("catch_") else sid.lower()
            if sid_clean in INTERNAL_ASSET_DIRS:
                conn.execute("DELETE FROM scans WHERE scan_id = ?", (sid,))
                conn.execute("DELETE FROM scan_comments WHERE scan_id = ?", (sid,))
                continue
            if sid not in discovered_ids:
                st = row["status"]
                pdir = row["project_dir"] or ""
                szip = (row["source_zip_path"] or "").split(";")[0].strip()
                if st in ("queued", "processing", "waiting_parts") and (os.path.isdir(pdir) or (szip and os.path.exists(szip))):
                    continue
                conn.execute("DELETE FROM scans WHERE scan_id = ?", (sid,))
                conn.execute("DELETE FROM scan_comments WHERE scan_id = ?", (sid,))
        conn.commit()

    return db.list_scans()


