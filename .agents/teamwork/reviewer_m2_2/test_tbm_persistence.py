import urllib.request
import json
import sqlite3
import os

scan_id = "quchi_20261005_merged"
db_path = r"data\gathering_scans.db"

# 1. Check DB before
conn = sqlite3.connect(db_path)
cur = conn.cursor()
row = cur.execute("SELECT scan_id, project_dir, extra_json FROM scans WHERE scan_id = ?", (scan_id,)).fetchone()
proj_dir = row[1]
extra_before = json.loads(row[2]) if row[2] else {}
print("Extra before:", extra_before.get("tbm_calibration"), extra_before.get("vertical_datum_offset"))

# 2. Record mtimes of geometry/raster files if present
monitored_files = []
if proj_dir and os.path.isdir(proj_dir):
    for f in os.listdir(proj_dir):
        if f.endswith((".obj", ".las", ".ply", ".npz", ".glb")):
            fp = os.path.join(proj_dir, f)
            monitored_files.append((fp, os.path.getmtime(fp)))

print(f"Monitored {len(monitored_files)} raw/cached geometry files in {proj_dir}")

# 3. Call API with apply_tbm_calibration: True
req_data = {
    "scan_id": scan_id,
    "generate_sample_points": True,
    "apply_tbm_calibration": True,
    "selected_tbm_id": "CP-01"
}
req = urllib.request.Request(
    "http://127.0.0.1:8095/api/survey/gcp-qa",
    data=json.dumps(req_data).encode("utf-8"),
    headers={"Content-Type": "application/json"}
)
with urllib.request.urlopen(req) as resp:
    res = json.loads(resp.read().decode("utf-8"))
    print("API returned tbm_applied:", res.get("tbm_applied"), "tbm_shift_m:", res.get("tbm_shift_m"))

# 4. Check DB after apply
row_after = cur.execute("SELECT extra_json FROM scans WHERE scan_id = ?", (scan_id,)).fetchone()
extra_after = json.loads(row_after[0]) if row_after[0] else {}
print("Extra after apply:", extra_after.get("tbm_calibration"), extra_after.get("vertical_datum_offset"))

# Check scan_meta.json
meta_fp = os.path.join(proj_dir, "scan_meta.json")
if os.path.isfile(meta_fp):
    with open(meta_fp, "r", encoding="utf-8") as mf:
        meta_data = json.load(mf)
    print("scan_meta.json tbm_calibration:", meta_data.get("tbm_calibration"))
    print("scan_meta.json vertical_datum_offset:", meta_data.get("vertical_datum_offset"))

# 5. Check monitored geometry files were NOT touched
modified_geom = []
for fp, mtime in monitored_files:
    cur_mtime = os.path.getmtime(fp)
    if cur_mtime != mtime:
        modified_geom.append((fp, mtime, cur_mtime))

if not modified_geom:
    print("ZERO-DESTRUCTION VERIFIED: 0 geometry/point cloud/DSM files were modified!")
else:
    print("DESTRUCTION VIOLATION: Files modified:", modified_geom)

# 6. Call API with reset_calibration: True
req_reset = {
    "scan_id": scan_id,
    "reset_calibration": True
}
req = urllib.request.Request(
    "http://127.0.0.1:8095/api/survey/gcp-qa",
    data=json.dumps(req_reset).encode("utf-8"),
    headers={"Content-Type": "application/json"}
)
with urllib.request.urlopen(req) as resp:
    res_reset = json.loads(resp.read().decode("utf-8"))
    print("API reset returned tbm_applied:", res_reset.get("tbm_applied"), "tbm_shift_m:", res_reset.get("tbm_shift_m"))

# 7. Check DB after reset
row_reset = cur.execute("SELECT extra_json FROM scans WHERE scan_id = ?", (scan_id,)).fetchone()
extra_reset = json.loads(row_reset[0]) if row_reset[0] else {}
print("Extra after reset:", extra_reset.get("tbm_calibration"), extra_reset.get("vertical_datum_offset"))

if os.path.isfile(meta_fp):
    with open(meta_fp, "r", encoding="utf-8") as mf:
        meta_reset = json.load(mf)
    print("scan_meta.json after reset tbm_calibration:", meta_reset.get("tbm_calibration"))
    print("scan_meta.json after reset vertical_datum_offset:", meta_reset.get("vertical_datum_offset"))

conn.close()
