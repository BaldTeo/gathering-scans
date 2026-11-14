#!/usr/bin/env python3
"""
Central Configuration for GatheringScans (scans.gatheren.cloud)
Enforces:
1. TWD97 (121) [EPSG:3826] + TWVD2001 [EPSG:8904, TWGEOID2018h] CRS conversion in PIX4Dmatic
2. 2K (2048) texture size limit in PIX4Dmatic and GC_ScanOptimizer for fast web streaming
3. Zero raw scan / photo / cache storage on the Linux VPS (all scans remain on Windows PC;
   offline caching is strictly client-side in the user's browser via IndexedDB / CacheStorage).
"""

import os
import shutil
import socket
import time

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKSTATION_ID = str(os.environ.get("WORKSTATION_ID") or socket.gethostname() or "workstation_1").strip()

# Derive default scans root dynamically from _app parent (e.g. D:\GatheringScans\_app -> D:\GatheringScans)
if os.path.basename(BASE_DIR).lower() == "_app":
    _DEFAULT_SCANS_ROOT = os.path.dirname(BASE_DIR)
elif WORKSTATION_ID.upper() == "WORKPC1" and os.path.isdir(r"D:\GatheringScans"):
    _DEFAULT_SCANS_ROOT = r"D:\GatheringScans"
elif os.path.isdir(r"C:\GatheringScans"):
    _DEFAULT_SCANS_ROOT = r"C:\GatheringScans"
elif os.path.isdir(r"D:\GatheringScans"):
    _DEFAULT_SCANS_ROOT = r"D:\GatheringScans"
else:
    _DEFAULT_SCANS_ROOT = r"C:\GatheringScans"

LOCAL_SCANS_ROOT = os.environ.get("LOCAL_SCANS_ROOT", _DEFAULT_SCANS_ROOT)

# Automatically load .env from <LOCAL_SCANS_ROOT>\_app\.env, <LOCAL_SCANS_ROOT>\.env, or BASE_DIR\.env into os.environ
# Ignore per-machine path keys inside synced _app\.env so C:\ vs D:\ never collide across workstations.
_IGNORED_SYNCED_ENV_KEYS = {
    "LOCAL_SCANS_ROOT",
    "LEGACY_SCANS_ROOT",
    "GATHERING_SCANS_DATA_DIR",
    "GC_SCAN_OPTIMIZER_DIR",
    "WORKSTATION_ID",
}
for _env_cand in (
    os.path.join(LOCAL_SCANS_ROOT, "_app", ".env"),
    os.path.join(LOCAL_SCANS_ROOT, ".env"),
    os.path.join(BASE_DIR, ".env"),
):
    if os.path.isfile(_env_cand):
        _is_synced_env = os.path.normcase(os.path.abspath(_env_cand)).startswith(
            os.path.normcase(os.path.abspath(LOCAL_SCANS_ROOT)) + os.sep
        )
        try:
            with open(_env_cand, "r", encoding="utf-8", errors="ignore") as _ef:
                for _line in _ef:
                    _ls = _line.strip()
                    if not _ls or _ls.startswith("#") or "=" not in _ls:
                        continue
                    _k, _v = _ls.split("=", 1)
                    _k = _k.strip()
                    _v = _v.strip().strip('"').strip("'")
                    if _is_synced_env and _k in _IGNORED_SYNCED_ENV_KEYS:
                        continue
                    if _k and _v and _k not in os.environ:
                        os.environ[_k] = _v
        except Exception:
            pass

LOCAL_SCANS_ROOT = os.environ.get("LOCAL_SCANS_ROOT", _DEFAULT_SCANS_ROOT)
_MASTER_DATA_DIR = os.path.join(LOCAL_SCANS_ROOT, "_app", "data")
DATA_DIR = os.environ.get(
    "GATHERING_SCANS_DATA_DIR",
    _MASTER_DATA_DIR if (os.name == "nt" and os.path.isdir(_MASTER_DATA_DIR)) else os.path.join(BASE_DIR, "data"),
)
os.makedirs(DATA_DIR, exist_ok=True)

# Per-workstation local runtime directory (outside Syncthing) for SQLite WAL/SHM, daemon_state, PIDs, and logs
if os.name == "nt" and "GATHERING_SCANS_RUNTIME_DIR" not in os.environ:
    _LOCAL_APPDATA = os.environ.get("LOCALAPPDATA") or os.path.expanduser(r"~\AppData\Local")
    RUNTIME_DATA_DIR = os.path.join(_LOCAL_APPDATA, "GatheringScans", WORKSTATION_ID, "data")
else:
    RUNTIME_DATA_DIR = os.environ.get("GATHERING_SCANS_RUNTIME_DIR", DATA_DIR)
os.makedirs(RUNTIME_DATA_DIR, exist_ok=True)
SHARED_STATE_DIR = os.path.join(DATA_DIR, "_shared_state")
os.makedirs(SHARED_STATE_DIR, exist_ok=True)


def rebase_scan_path(path_str: str) -> str:
    """
    Rebases any scan path rooted at C:\\GatheringScans or D:\\GatheringScans onto this
    workstation's LOCAL_SCANS_ROOT so Syncthing-mirrored scans resolve on both PCs.
    Supports ';'-delimited multi-part paths.
    """
    if not path_str or os.name != "nt":
        return path_str
    s = str(path_str)
    if ";" in s:
        return ";".join(rebase_scan_path(p.strip()) for p in s.split(";") if p.strip())
    norm = s.replace("/", "\\")
    low = norm.lower()
    for prefix in ("c:\\gatheringscans", "d:\\gatheringscans"):
        if low == prefix:
            return LOCAL_SCANS_ROOT
        if low.startswith(prefix + "\\"):
            rel = norm[len(prefix) + 1 :]
            cand = os.path.join(LOCAL_SCANS_ROOT, rel)
            if os.path.exists(cand) or not os.path.exists(norm):
                return cand
    return s

# 1. Google Drive Inbox & Local Scan Vault Paths (Strictly Jailed to 3. GatheringScans & C:\GatheringScans)
_GDRIVE_ROOT = os.environ.get("GDRIVE_ROOT", r"G:\\").strip()
if len(_GDRIVE_ROOT) == 2 and _GDRIVE_ROOT.endswith(":"):
    _GDRIVE_ROOT += "\\"
GDRIVE_INBOX_DIR = os.environ.get("GDRIVE_INBOX_DIR", os.path.join(_GDRIVE_ROOT, "Shared drives", "6.軟體", "3. GatheringScans"))
GDRIVE_INPUTS_DIR = os.environ.get("GDRIVE_INPUTS_DIR", os.path.join(GDRIVE_INBOX_DIR, "INPUTS"))
LEGACY_GDRIVE_INBOX_DIR = os.environ.get("LEGACY_GDRIVE_INBOX_DIR", os.path.join(_GDRIVE_ROOT, "My Drive", "SCANS TEST"))
LEGACY_SCANS_ROOT = os.environ.get("LEGACY_SCANS_ROOT", LOCAL_SCANS_ROOT)
_DEFAULT_OPTIMIZER_DIR = os.path.join(LOCAL_SCANS_ROOT, "_optimizer")
if not os.path.isdir(_DEFAULT_OPTIMIZER_DIR) and os.path.isdir(r"C:\Antigravity\GC_ScanOptimizer"):
    _DEFAULT_OPTIMIZER_DIR = r"C:\Antigravity\GC_ScanOptimizer"
GC_SCAN_OPTIMIZER_DIR = os.environ.get("GC_SCAN_OPTIMIZER_DIR", _DEFAULT_OPTIMIZER_DIR)
GATHERING_CLOUD_DEV_DIR = os.environ.get("GATHERING_CLOUD_DEV_DIR", r"C:\Antigravity\GatheringCloud_Develop")

# 2. PIX4Dmatic 2.11.0 Automated Engine Settings
PIX4DMATIC_EXE = os.environ.get("PIX4DMATIC_EXE", r"C:\Program Files\PIX4Dmatic\PIX4Dmatic.exe")

# Default 16K (16384) texture size for PIX4Dmatic (QuadtreeTiler repacks per-quadrant into <=4096px WebGL tiles)
PIX4DMATIC_TEXTURE_SIZE = 16384

# Mandatory Coordinate Reference System: TWD97 / TM2 zone 121 (EPSG:3826) + TWVD 2001 height (EPSG:8904 [TWGEOID2018h])
TWD97_TWVD2001_LABEL = "TWD97 / TM2 zone 121 + TWVD 2001 height - EPSG:3826+8904 [TWGEOID2018h]"
TWD97_TWVD2001_SHORT = "TWD97 (121) + TWVD2001"
TWD97_TWVD2001_WKT = (
    'COMPOUNDCRS["TWD97 / TM2 zone 121 + TWVD 2001 height",'
    'PROJCRS["TWD97 / TM2 zone 121",'
    'BASEGEOGCRS["TWD97",DATUM["Taiwan Datum 1997",ELLIPSOID["GRS 1980",6378137,298.257222101,LENGTHUNIT["metre",1]]],'
    'PRIMEM["Greenwich",0,ANGLEUNIT["degree",0.0174532925199433]],ID["EPSG",3824]],'
    'CONVERSION["Taiwan 2-degree TM zone 121",METHOD["Transverse Mercator",ID["EPSG",9807]],'
    'PARAMETER["Latitude of natural origin",0,ANGLEUNIT["degree",0.0174532925199433],ID["EPSG",8801]],'
    'PARAMETER["Longitude of natural origin",121,ANGLEUNIT["degree",0.0174532925199433],ID["EPSG",8802]],'
    'PARAMETER["Scale factor at natural origin",0.9999,SCALEUNIT["unity",1],ID["EPSG",8805]],'
    'PARAMETER["False easting",250000,LENGTHUNIT["metre",1],ID["EPSG",8806]],'
    'PARAMETER["False northing",0,LENGTHUNIT["metre",1],ID["EPSG",8807]]],'
    'CS[Cartesian,2],AXIS["easting (X)",east,ORDER[1],LENGTHUNIT["metre",1]],'
    'AXIS["northing (Y)",north,ORDER[2],LENGTHUNIT["metre",1]],'
    'USAGE[SCOPE["Engineering survey, topographic mapping."],'
    'AREA["Taiwan, Republic of China - between 120°E and 122°E, onshore and offshore - Taiwan Island."],'
    'BBOX[20.41,119.99,26.72,122.06]],ID["EPSG",3826]],'
    'VERTCRS["TWVD 2001 height",VDATUM["Taiwan Vertical Datum 2001"],'
    'CS[vertical,1],AXIS["gravity-related height (H)",up,LENGTHUNIT["metre",1]],'
    'GEOIDMODEL["TWGEOID2018h"],ID["EPSG",8904]]]'
)

# 3. Database & Server Configuration
_LEGACY_SHARED_DB_PATH = os.path.join(DATA_DIR, "gathering_scans.db")
DB_PATH = os.path.join(RUNTIME_DATA_DIR, "gathering_scans.db")
if (
    DB_PATH != _LEGACY_SHARED_DB_PATH
    and (not os.path.isfile(DB_PATH) or os.path.getsize(DB_PATH) == 0)
    and os.path.isfile(_LEGACY_SHARED_DB_PATH)
    and os.path.getsize(_LEGACY_SHARED_DB_PATH) > 0
):
    try:
        shutil.copy2(_LEGACY_SHARED_DB_PATH, DB_PATH)
    except Exception:
        pass
DAEMON_STATE_PATH = os.path.join(RUNTIME_DATA_DIR, "daemon_state.json")
AUTH_GLOBAL_STATE_PATH = os.path.join(DATA_DIR, "auth_global_state.json")
REPORTS_DIR = os.path.join(DATA_DIR, "reports")
CONTOURS_DIR = os.path.join(DATA_DIR, "contours")
CATEGORIZATION_CACHE_DIR = os.path.join(DATA_DIR, "categorization_cache")
os.makedirs(REPORTS_DIR, exist_ok=True)
os.makedirs(CONTOURS_DIR, exist_ok=True)
os.makedirs(CATEGORIZATION_CACHE_DIR, exist_ok=True)

SERVER_HOST = os.environ.get("GATHERING_SCANS_HOST", "0.0.0.0")
SERVER_PORT = int(os.environ.get("GATHERING_SCANS_PORT", "8095"))
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "https://scans.gatheren.cloud")

# 4. Hostinger VPS Reverse SSH & Socket Pool Tunnel Settings
VPS_HOST = os.environ.get("VPS_HOST", "76.13.197.29")
VPS_USER = os.environ.get("VPS_USER", "root")
_USER_SSH_KEY = os.path.expanduser(r"~\.ssh\id_gathering_vps")
_MASTER_SSH_KEY = os.path.join(LOCAL_SCANS_ROOT, "_ssh", "id_gathering_vps")
VPS_SSH_KEY = os.environ.get(
    "VPS_SSH_KEY",
    _USER_SSH_KEY if os.path.isfile(_USER_SSH_KEY) else (_MASTER_SSH_KEY if os.path.isfile(_MASTER_SSH_KEY) else _USER_SSH_KEY),
)
VPS_REMOTE_TUNNEL_PORT = int(os.environ.get("VPS_REMOTE_TUNNEL_PORT", "18095"))
TUNNEL_SHARED_KEY = os.environ.get("GATHERING_SCANS_TUNNEL_KEY", "gs_tunnel_gatheren_2026_twd97")

# 5. Google OAuth, Service Account & Google Chat Notification Settings (Shared with GatheringCloud)
GOOGLE_OAUTH_CLIENT_ID = os.environ.get(
    "GOOGLE_OAUTH_CLIENT_ID",
    "753778992341-hpe65ilnti31j0m7etmq5rn7a1q802da.apps.googleusercontent.com",
)
GDRIVE_SERVICE_ACCOUNT_EMAIL = os.environ.get(
    "GDRIVE_SERVICE_ACCOUNT_EMAIL",
    "gcworker@modular-temple-508005-c4.iam.gserviceaccount.com",
)
GDRIVE_SERVICE_ACCOUNT_PROJECT_ID = os.environ.get(
    "GDRIVE_SERVICE_ACCOUNT_PROJECT_ID",
    "modular-temple-508005-c4",
)
ALLOWED_WORKSPACE_DOMAINS = ["gatheren.com.tw", "gatheren.cloud", "gathering.cloud", "gmail.com"]
GCHAT_WEBHOOK_URL = os.environ.get(
    "GCHAT_WEBHOOK_URL",
    "",
)

# 6. Standard Engineering Material Densities (tonnes / m^3) & Swell / Shrinkage Factors
MATERIAL_CATALOG = {
    "crushed_stone": {"name": "Crushed Stone / 碎石級配", "density_t_m3": 1.65, "swell_factor": 0.88, "shrinkage_factor": 0.05, "swell_pct": 0.136},
    "river_gravel": {"name": "River Gravel & Cobble / 河床卵礫石", "density_t_m3": 1.78, "swell_factor": 0.90, "shrinkage_factor": 0.06, "swell_pct": 0.111},
    "sand_dry": {"name": "Dry Construction Sand / 建築乾砂", "density_t_m3": 1.55, "swell_factor": 0.92, "shrinkage_factor": 0.08, "swell_pct": 0.087},
    "sand_wet": {"name": "Wet River Sand / 河砂(含水)", "density_t_m3": 1.92, "swell_factor": 0.94, "shrinkage_factor": 0.10, "swell_pct": 0.064},
    "excavated_soil": {"name": "Excavated Earth / 一般開挖土方", "density_t_m3": 1.45, "swell_factor": 0.80, "shrinkage_factor": 0.10, "swell_pct": 0.250},
    "clay_compacted": {"name": "Compacted Clay / 壓實黏土", "density_t_m3": 1.85, "swell_factor": 1.00, "shrinkage_factor": 0.15, "swell_pct": 0.000},
    "concrete_rubble": {"name": "Concrete Rubble / 混凝土廢料", "density_t_m3": 1.50, "swell_factor": 0.78, "shrinkage_factor": 0.04, "swell_pct": 0.282},
    "asphalt_milling": {"name": "Asphalt Millings / 瀝青刨除料", "density_t_m3": 1.40, "swell_factor": 0.85, "shrinkage_factor": 0.05, "swell_pct": 0.176},
}

# 7. Default PIX4Dmatic 2.11.0 Mesh & Photogrammetry Pipeline Settings
# Scalable mesh pipeline + Sky Mask OFF (skyless: false) + ROI clipping OFF (use_roi: false)
# + 16384px 16K texture atlas + Full dense image scale + Medium depth confidence + Conservative simplification + Export LOD 13
PIX4D_SETTINGS_PATH = os.path.join(DATA_DIR, "pix4d_settings.json")
DEFAULT_PIX4D_SETTINGS = {
    "mesh_pipeline": "Scalable",            # "Scalable" or "FixedSize"
    "skyless": False,                       # False = Sky Mask Disabled (preserves surrounding trees & canopy)
    "use_roi": False,                       # False = Exclude restrictive OPF RoiSet clipping
    "texture_size": 16384,                  # 1024, 2048, 4096, 8192, or 16384
    "calib_image_scale": "Full",            # "Full", "Half", "Quarter", or "AutoAdaptive"
    "skip_dense_cloud": False,              # True = Pass 1 uses LiDAR DepthPointCloud directly
    "dense_image_scale": "Full",            # "Full", "Half", or "Quarter" (1x full resolution to fill surface gaps)
    "depth_min_confidence": "Medium",       # "High", "Medium", or "Low"
    "depth_agreement_m": 0.01,              # Depth filter agreement threshold in meters
    "model_simplification": "Conservative", # "Conservative", "Moderate", or "Aggressive"
    "deghosting": "Weak",                   # "Weak", "Strong", or "Disabled"
    "export_lod": 13,                       # 13 = Full detail LOD export
    "compute_gaussian_splats": False,       # Optional 3D Gaussian Splatting (GenerateGaussianSplats + ExportGaussianSplatsToPly)
    "gaussian_splats_template": "Catch",    # "Catch", "Nadir", "Oblique", or "Mixed"
    "gaussian_splats_max_millions": 2.0,    # Max splats (in millions) packed into web tiles/splats.gsplat (2.0M = 64 MB)
    "cleanup_raw_splat_ply": True,          # Delete intermediate raw splats.ply after building tiles/splats.gsplat
}

# Option C — Hybrid Adaptive Pass 1 Fast Preview Settings (~3–6 min preview before Pass 2 16K HQ)
# Rule: Preview round ALWAYS has SkyMask ON (skyless: True) and ROI ON (use_roi: True)
FAST_PREVIEW_PIX4D_SETTINGS = {
    "mesh_pipeline": "FixedSize",
    "skyless": True,                        # Enforce SkyMask ON for fast preview
    "use_roi": True,                        # Enforce ROI ON for fast preview
    "texture_size": 2048,
    "calib_image_scale": "AutoAdaptive",    # Full (1:1) if <=500 imgs & 1 part, else Quarter (1/4)
    "skip_dense_cloud": True,               # Use fast LiDAR DepthPointCloud directly in Pass 1
    "dense_image_scale": "Quarter",         # Fallback only if scan has no LiDAR depth maps
    "depth_min_confidence": "Medium",
    "depth_agreement_m": 0.02,
    "model_simplification": "Moderate",
    "deghosting": "Weak",
    "export_lod": 12,
    "compute_gaussian_splats": False,       # Fast preview never computes 3DGS; Pass 2 Full HQ computes it if enabled
    "gaussian_splats_template": "Catch",
    "gaussian_splats_max_millions": 2.0,
    "cleanup_raw_splat_ply": True,
}


def _normalize_pix4d_settings_dict(cfg: dict) -> dict:
    cfg["mesh_pipeline"] = "FixedSize" if str(cfg.get("mesh_pipeline")) == "FixedSize" else "Scalable"
    cfg["skyless"] = bool(cfg.get("skyless", False))
    cfg["use_roi"] = bool(cfg.get("use_roi", False))
    try:
        ts = int(cfg.get("texture_size", 16384))
        cfg["texture_size"] = ts if ts in (1024, 2048, 4096, 8192, 16384) else 16384
    except Exception:
        cfg["texture_size"] = 16384
    dense_scale = str(cfg.get("dense_image_scale", "Full"))
    cfg["dense_image_scale"] = dense_scale if dense_scale in ("Full", "Half", "Quarter") else "Full"
    calib_scale = str(cfg.get("calib_image_scale", "Full"))
    cfg["calib_image_scale"] = calib_scale if calib_scale in ("Full", "Half", "Quarter", "AutoAdaptive") else "Full"
    cfg["skip_dense_cloud"] = bool(cfg.get("skip_dense_cloud", False))
    depth_conf = str(cfg.get("depth_min_confidence", "Medium"))
    cfg["depth_min_confidence"] = depth_conf if depth_conf in ("High", "Medium", "Low") else "Medium"
    try:
        cfg["depth_agreement_m"] = max(0.0005, min(0.5, float(cfg.get("depth_agreement_m", 0.01))))
    except Exception:
        cfg["depth_agreement_m"] = 0.01
    simp = str(cfg.get("model_simplification", "Conservative"))
    cfg["model_simplification"] = simp if simp in ("Conservative", "Moderate", "Aggressive") else "Conservative"
    degh = str(cfg.get("deghosting", "Weak"))
    cfg["deghosting"] = degh if degh in ("Weak", "Strong", "Disabled") else "Weak"
    try:
        cfg["export_lod"] = max(0, min(20, int(cfg.get("export_lod", 13))))
    except Exception:
        cfg["export_lod"] = 13
    cfg["compute_gaussian_splats"] = bool(cfg.get("compute_gaussian_splats", False))
    gs_tpl = str(cfg.get("gaussian_splats_template", "Catch"))
    cfg["gaussian_splats_template"] = gs_tpl if gs_tpl in ("Catch", "Nadir", "Oblique", "Mixed") else "Catch"
    try:
        cfg["gaussian_splats_max_millions"] = round(max(0.25, min(8.0, float(cfg.get("gaussian_splats_max_millions", 2.0)))), 2)
    except Exception:
        cfg["gaussian_splats_max_millions"] = 2.0
    cfg["cleanup_raw_splat_ply"] = bool(cfg.get("cleanup_raw_splat_ply", True))
    return cfg


def load_pix4d_settings() -> dict:
    import json
    cfg = dict(DEFAULT_PIX4D_SETTINGS)
    if os.path.isfile(PIX4D_SETTINGS_PATH):
        try:
            with open(PIX4D_SETTINGS_PATH, "r", encoding="utf-8") as f:
                saved = json.load(f)
            if isinstance(saved, dict):
                cfg.update(saved)
        except Exception:
            pass
    return _normalize_pix4d_settings_dict(cfg)


def save_pix4d_settings(updates: dict) -> dict:
    import json
    cfg = load_pix4d_settings()
    if isinstance(updates, dict):
        cfg.update(updates)
    cfg = load_pix4d_settings_from_dict(cfg)
    try:
        with open(PIX4D_SETTINGS_PATH, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)
    except Exception:
        pass
    return cfg


def load_pix4d_settings_from_dict(raw: dict) -> dict:
    cfg = dict(DEFAULT_PIX4D_SETTINGS)
    if isinstance(raw, dict):
        cfg.update(raw)
    return _normalize_pix4d_settings_dict(cfg)


# 8. Optimal Presets (for Google Chat bot interactive prompt & Queue options)
OPTIMAL_PRESET_NO_SKYMASK = {
    "mesh_pipeline": "Scalable",
    "skyless": False,                        # Optimal without SkyMask (preserves full scene & vegetation)
    "use_roi": True,                         # Enforce ROI clipping
    "texture_size": 16384,
    "calib_image_scale": "Full",
    "dense_image_scale": "Full",
    "depth_min_confidence": "Medium",
    "model_simplification": "Conservative",
    "deghosting": "Weak",
    "export_lod": 13,
}

OPTIMAL_PRESET_WITH_SKYMASK = {
    "mesh_pipeline": "Scalable",
    "skyless": True,                         # Optimal with SkyMask (eliminates distant sky geometry)
    "use_roi": True,                         # Enforce ROI clipping
    "texture_size": 16384,
    "calib_image_scale": "Full",
    "dense_image_scale": "Full",
    "depth_min_confidence": "Medium",
    "model_simplification": "Conservative",
    "deghosting": "Weak",
    "export_lod": 13,
}


# 9. Dual-Workstation Coordination (Syncthing P2P Scan Folder + VPS Authoritative Coordinator)
WORKSTATION_SETTINGS_PATH = os.path.join(DATA_DIR, "workstation_settings.json")
GLOBAL_PIX4D_LOCK_PATH = os.path.join(SHARED_STATE_DIR, "pix4d_seat_lock.json")

PREDEFINED_WORKSTATIONS = {
    "DESKTOP-OEBISC7": {
        "workstation_id": "DESKTOP-OEBISC7",
        "name": "Stronger Processing PC (DESKTOP-OEBISC7)",
        "daemon_enabled": True,
        "root_dir": r"C:\GatheringScans",
        "last_seen": 0.0,
    },
    "WorkPC1": {
        "workstation_id": "WorkPC1",
        "name": "Office Always-On PC (WorkPC1)",
        "daemon_enabled": True,
        "root_dir": r"D:\GatheringScans",
        "last_seen": 0.0,
    },
}

DEFAULT_WORKSTATION_SETTINGS = {
    "query_serving_workstation": "auto",            # "auto" (prefer online), or specific workstation_id with failover
    "processing_workstation": "DESKTOP-OEBISC7",    # Strict pinning by default ("DESKTOP-OEBISC7", "WorkPC1", "auto", "none")
    "workstations": {k: dict(v) for k, v in PREDEFINED_WORKSTATIONS.items()},
}


def load_workstation_settings() -> dict:
    import json
    cfg = {
        "query_serving_workstation": DEFAULT_WORKSTATION_SETTINGS["query_serving_workstation"],
        "processing_workstation": DEFAULT_WORKSTATION_SETTINGS["processing_workstation"],
        "workstations": {k: dict(v) for k, v in PREDEFINED_WORKSTATIONS.items()},
    }
    if os.path.isfile(WORKSTATION_SETTINGS_PATH):
        try:
            with open(WORKSTATION_SETTINGS_PATH, "r", encoding="utf-8") as f:
                saved = json.load(f)
            if isinstance(saved, dict):
                if "query_serving_workstation" in saved and saved["query_serving_workstation"]:
                    cfg["query_serving_workstation"] = str(saved["query_serving_workstation"]).strip()
                if "processing_workstation" in saved and saved["processing_workstation"]:
                    p_val = str(saved["processing_workstation"]).strip()
                    # Migrate legacy "auto" default to "DESKTOP-OEBISC7" unless user explicitly saved `explicit_processing_choice`
                    if p_val == "auto" and not saved.get("explicit_processing_choice"):
                        p_val = "DESKTOP-OEBISC7"
                    cfg["processing_workstation"] = p_val
                if saved.get("explicit_processing_choice"):
                    cfg["explicit_processing_choice"] = True
                if isinstance(saved.get("workstations"), dict):
                    for wid, winfo in saved["workstations"].items():
                        if not wid or not isinstance(winfo, dict):
                            continue
                        merged = dict(cfg["workstations"].get(wid, {"workstation_id": wid, "daemon_enabled": True, "last_seen": 0.0}))
                        merged.update(winfo)
                        merged["workstation_id"] = wid
                        cfg["workstations"][wid] = merged
        except Exception:
            pass
    return cfg


def save_workstation_settings(updates: dict) -> dict:
    import json
    cfg = load_workstation_settings()
    if isinstance(updates, dict):
        if "query_serving_workstation" in updates:
            cfg["query_serving_workstation"] = str(updates["query_serving_workstation"]).strip() or "auto"
        if "processing_workstation" in updates:
            cfg["processing_workstation"] = str(updates["processing_workstation"]).strip() or "DESKTOP-OEBISC7"
            cfg["explicit_processing_choice"] = True
        if isinstance(updates.get("workstations"), dict):
            for wid, winfo in updates["workstations"].items():
                if not wid or not isinstance(winfo, dict):
                    continue
                if wid not in cfg["workstations"]:
                    cfg["workstations"][wid] = {"workstation_id": wid, "daemon_enabled": True, "last_seen": 0.0}
                cfg["workstations"][wid].update(winfo)
                cfg["workstations"][wid]["workstation_id"] = wid
    try:
        os.makedirs(os.path.dirname(WORKSTATION_SETTINGS_PATH), exist_ok=True)
        tmp = WORKSTATION_SETTINGS_PATH + f".{os.getpid()}.part"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)
        os.replace(tmp, WORKSTATION_SETTINGS_PATH)
    except Exception as e:
        print(f"[Workstations] Warning saving workstation_settings.json: {e}")
    return cfg


def register_workstation_heartbeat(workstation_id: str = None, info: dict = None) -> dict:
    wid = str(workstation_id or WORKSTATION_ID).strip()
    cfg = load_workstation_settings()
    cur = dict(cfg["workstations"].get(wid) or {})
    cur["workstation_id"] = wid
    if not cur.get("name"):
        cur["name"] = PREDEFINED_WORKSTATIONS.get(wid, {}).get("name") or f"Workstation ({wid})"
    if wid == WORKSTATION_ID and os.name == "nt":
        cur["root_dir"] = LOCAL_SCANS_ROOT
    elif not cur.get("root_dir"):
        cur["root_dir"] = PREDEFINED_WORKSTATIONS.get(wid, {}).get("root_dir") or LOCAL_SCANS_ROOT
    cur["last_seen"] = time.time()
    if "daemon_enabled" not in cur:
        cur["daemon_enabled"] = True
    if isinstance(info, dict):
        # Preserve admin-configured `name` and `daemon_enabled` unless explicitly supplied as admin update
        preserve_name = cur.get("name")
        preserve_daemon = cur.get("daemon_enabled", True)
        cur.update(info)
        if preserve_name and not info.get("_override_name"):
            cur["name"] = preserve_name
        if not info.get("_override_daemon"):
            cur["daemon_enabled"] = preserve_daemon
        cur.pop("_override_name", None)
        cur.pop("_override_daemon", None)
    cfg["workstations"][wid] = cur
    return save_workstation_settings(cfg)


def is_workstation_query_serving_active(workstation_id: str = None) -> bool:
    wid = str(workstation_id or WORKSTATION_ID).strip().lower()
    cfg = load_workstation_settings()
    q_ws = str(cfg.get("query_serving_workstation") or "auto").strip().lower()
    if q_ws in ("auto", "both", "*", ""):
        return True
    if q_ws == wid:
        return True
    # Automatic failover: if preferred query workstation has been offline > 45s, serve queries seamlessly
    for k, winfo in (cfg.get("workstations") or {}).items():
        if str(k).strip().lower() == q_ws and isinstance(winfo, dict):
            last_s = float(winfo.get("last_seen") or 0.0)
            if time.time() - last_s <= 45.0:
                return False
            return True
    return True


def is_workstation_processing_active(workstation_id: str = None) -> bool:
    """
    Strict processing workstation check:
    When `processing_workstation` is pinned to a specific workstation (e.g. 'DESKTOP-OEBISC7'),
    NEVER fall back to the weaker PC even if the pinned workstation is currently offline.
    """
    wid = str(workstation_id or WORKSTATION_ID).strip().lower()
    cfg = load_workstation_settings()
    p_ws = str(cfg.get("processing_workstation") or "DESKTOP-OEBISC7").strip().lower()
    if p_ws in ("auto", "both", "*"):
        return True
    if p_ws == "none":
        return False
    return p_ws == wid


def is_workstation_daemon_active(workstation_id: str = None) -> bool:
    wid = str(workstation_id or WORKSTATION_ID).strip()
    cfg = load_workstation_settings()
    for k, ws_info in (cfg.get("workstations") or {}).items():
        if str(k).strip().lower() == wid.lower() and isinstance(ws_info, dict):
            if "daemon_enabled" in ws_info:
                return bool(ws_info["daemon_enabled"])
    return True


def get_min_valid_session_iat() -> int:
    """Returns global minimum valid session issued-at epoch timestamp (set by 'Log out everyone')."""
    import json
    if os.path.isfile(AUTH_GLOBAL_STATE_PATH):
        try:
            with open(AUTH_GLOBAL_STATE_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                return int(data.get("min_valid_iat") or 0)
        except Exception:
            pass
    return 0


def set_min_valid_session_iat(min_iat: int, updated_by: str = "") -> int:
    """Persists global minimum valid session issued-at epoch timestamp atomically."""
    import json
    cur = get_min_valid_session_iat()
    val = max(cur, int(min_iat or 0))
    payload = {"min_valid_iat": val, "updated_by": str(updated_by or "")}
    try:
        os.makedirs(os.path.dirname(AUTH_GLOBAL_STATE_PATH), exist_ok=True)
        tmp = AUTH_GLOBAL_STATE_PATH + f".{os.getpid()}.part"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)
        os.replace(tmp, AUTH_GLOBAL_STATE_PATH)
    except Exception as e:
        print(f"[AuthGlobal] Warning saving auth_global_state.json: {e}")
    return val


