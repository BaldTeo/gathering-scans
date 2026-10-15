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

# 1. Google Drive Inbox & Local Scan Vault Paths
GDRIVE_INBOX_DIR = os.environ.get("GDRIVE_INBOX_DIR", r"G:\My Drive\SCANS TEST")
LOCAL_SCANS_ROOT = os.environ.get("LOCAL_SCANS_ROOT", r"C:\Scans")
GC_SCAN_OPTIMIZER_DIR = os.environ.get("GC_SCAN_OPTIMIZER_DIR", r"C:\Antigravity\GC_ScanOptimizer")
GATHERING_CLOUD_DEV_DIR = os.environ.get("GATHERING_CLOUD_DEV_DIR", r"C:\Antigravity\GatheringCloud_Develop")

# 2. PIX4Dmatic 2.11.0 Automated Engine Settings
PIX4DMATIC_EXE = os.environ.get("PIX4DMATIC_EXE", r"C:\Program Files\PIX4Dmatic\PIX4Dmatic.exe")

# Mandatory 2K texture cap for PIX4Dmatic and GC_ScanOptimizer
PIX4DMATIC_TEXTURE_SIZE = 2048

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
os.makedirs(REPORTS_DIR, exist_ok=True)
os.makedirs(CONTOURS_DIR, exist_ok=True)

SERVER_HOST = os.environ.get("GATHERING_SCANS_HOST", "0.0.0.0")
SERVER_PORT = int(os.environ.get("GATHERING_SCANS_PORT", "8095"))
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "https://scans.gatheren.cloud")

# 4. Hostinger VPS Reverse SSH Tunnel Settings
VPS_HOST = os.environ.get("VPS_HOST", "76.13.197.29")
VPS_USER = os.environ.get("VPS_USER", "root")
VPS_SSH_KEY = os.environ.get("VPS_SSH_KEY", os.path.expanduser(r"~\.ssh\id_gathering_vps"))
VPS_REMOTE_TUNNEL_PORT = int(os.environ.get("VPS_REMOTE_TUNNEL_PORT", "18095"))

# 5. Google OAuth & Google Chat Notification Settings
GOOGLE_OAUTH_CLIENT_ID = os.environ.get(
    "GOOGLE_OAUTH_CLIENT_ID",
    "gathering-cloud-workspace.apps.googleusercontent.com"
)
ALLOWED_WORKSPACE_DOMAINS = ["gatheren.com.tw", "gatheren.cloud", "gathering.cloud", "gmail.com"]
GCHAT_WEBHOOK_URL = os.environ.get(
    "GCHAT_WEBHOOK_URL",
    "https://chat.googleapis.com/v1/spaces/AAQA_oh-3w8/messages?key=AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI&token=zCavjGk6CkJ6Dkn8HFqOCR9xP9we8c_Ml2Icq6aWbdM",
)

# 6. Standard Engineering Material Densities (tonnes / m^3) & Swell Factors
MATERIAL_CATALOG = {
    "crushed_stone": {"name": "Crushed Stone / 碎石級配", "density_t_m3": 1.65, "swell_factor": 0.88},
    "river_gravel": {"name": "River Gravel & Cobble / 河床卵礫石", "density_t_m3": 1.78, "swell_factor": 0.90},
    "sand_dry": {"name": "Dry Construction Sand / 建築乾砂", "density_t_m3": 1.55, "swell_factor": 0.92},
    "sand_wet": {"name": "Wet River Sand / 河砂(含水)", "density_t_m3": 1.92, "swell_factor": 0.94},
    "excavated_soil": {"name": "Excavated Earth / 一般開挖土方", "density_t_m3": 1.45, "swell_factor": 0.80},
    "clay_compacted": {"name": "Compacted Clay / 壓實黏土", "density_t_m3": 1.85, "swell_factor": 1.00},
    "concrete_rubble": {"name": "Concrete Rubble / 混凝土廢料", "density_t_m3": 1.50, "swell_factor": 0.78},
    "asphalt_milling": {"name": "Asphalt Millings / 瀝青刨除料", "density_t_m3": 1.40, "swell_factor": 0.85},
}
