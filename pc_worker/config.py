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

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
os.makedirs(DATA_DIR, exist_ok=True)

# 1. Google Drive Inbox & Local Scan Vault Paths (Strictly Jailed to 3. GatheringScans & C:\GatheringScans)
GDRIVE_INBOX_DIR = os.environ.get("GDRIVE_INBOX_DIR", r"G:\Shared drives\6.軟體\3. GatheringScans")
GDRIVE_INPUTS_DIR = os.environ.get("GDRIVE_INPUTS_DIR", os.path.join(GDRIVE_INBOX_DIR, "INPUTS"))
LEGACY_GDRIVE_INBOX_DIR = os.environ.get("LEGACY_GDRIVE_INBOX_DIR", r"G:\My Drive\SCANS TEST")
LOCAL_SCANS_ROOT = os.environ.get("LOCAL_SCANS_ROOT", r"C:\GatheringScans")
LEGACY_SCANS_ROOT = os.environ.get("LEGACY_SCANS_ROOT", r"C:\Scans")
GC_SCAN_OPTIMIZER_DIR = os.environ.get("GC_SCAN_OPTIMIZER_DIR", r"C:\Antigravity\GC_ScanOptimizer")
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
DB_PATH = os.path.join(DATA_DIR, "gathering_scans.db")
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
VPS_SSH_KEY = os.environ.get("VPS_SSH_KEY", os.path.expanduser(r"~\.ssh\id_gathering_vps"))
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
}

# Option C — Hybrid Adaptive Pass 1 Fast Preview Settings (~3–6 min preview before Pass 2 16K HQ)
FAST_PREVIEW_PIX4D_SETTINGS = {
    "mesh_pipeline": "FixedSize",
    "skyless": False,
    "use_roi": False,
    "texture_size": 2048,
    "calib_image_scale": "AutoAdaptive",    # Full (1:1) if <=500 imgs & 1 part, else Quarter (1/4)
    "skip_dense_cloud": True,               # Use fast LiDAR DepthPointCloud directly in Pass 1
    "dense_image_scale": "Quarter",         # Fallback only if scan has no LiDAR depth maps
    "depth_min_confidence": "Medium",
    "depth_agreement_m": 0.02,
    "model_simplification": "Moderate",
    "deghosting": "Weak",
    "export_lod": 12,
}


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
    return cfg


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
    return cfg

