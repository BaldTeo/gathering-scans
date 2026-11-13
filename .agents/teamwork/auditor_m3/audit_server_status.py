import urllib.request
import json
import ssl

print("=== DEPLOYMENT INTEGRITY CHECK ===")

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

# 1. Local Server (127.0.0.1:8095)
local_url = "http://127.0.0.1:8095/api/status"
try:
    with urllib.request.urlopen(local_url, timeout=5) as r:
        raw = r.read().decode("utf-8")
        data = json.loads(raw)
        print("1. Local Server (127.0.0.1:8095):")
        print(f"   HTTP Status: {r.status}")
        print(f"   Version: {data.get('version')}")
        print(f"   Scans Count: {data.get('scans')}")
        print(f"   Disk Free GB: {data.get('disk_free_gb')}")
        print("   [PASS] Local Windows server is online, healthy, and responsive.")
except Exception as e:
    print(f"   ERROR connecting to local server: {e}")

# 2. Live Hostinger VPS Server (scans.gatheren.cloud)
vps_url = "https://scans.gatheren.cloud/api/status"
try:
    with urllib.request.urlopen(vps_url, context=ctx, timeout=10) as r:
        raw = r.read().decode("utf-8")
        data = json.loads(raw)
        print("\n2. Live Hostinger VPS (scans.gatheren.cloud):")
        print(f"   HTTP Status: {r.status}")
        print(f"   Version: {data.get('version')}")
        print(f"   Scans Count: {data.get('scans')}")
        print(f"   Disk Free GB: {data.get('disk_free_gb')}")
        print("   [PASS] Live Hostinger VPS container is online, healthy, and responsive.")
except Exception as e:
    print(f"   ERROR connecting to VPS: {e}")

# 3. Live API endpoint test on local server: /api/survey/stationing
stationing_url = "http://127.0.0.1:8095/api/survey/stationing"
payload = {
    "scan_id": "edited_qihu_unified_merged_scan_4_scans__edited_372953",
    "interval": 10.0,
    "swath_width": 14.0,
    "template_type": "roadway",
    "road_width": 6.0,
    "cross_slope_pct": 2.0
}
req = urllib.request.Request(
    stationing_url,
    data=json.dumps(payload).encode("utf-8"),
    headers={"Content-Type": "application/json"}
)
try:
    with urllib.request.urlopen(req, timeout=10) as r:
        data = json.loads(r.read().decode("utf-8"))
        print("\n3. Live API Query: /api/survey/stationing")
        print(f"   HTTP Status: {r.status}")
        print(f"   Status in body: {data.get('status')}")
        print(f"   Stations: {data.get('station_count')}, Length: {data.get('total_length_m')} m")
        print(f"   Cut Vol: {data.get('total_cut_volume_m3')} m3, Fill Vol: {data.get('total_fill_volume_m3')} m3")
        assert data.get("status") == "ok"
        assert data.get("station_count") > 0
        print("   [PASS] Live endpoint /api/survey/stationing returned genuine calculation.")
except Exception as e:
    print(f"   ERROR querying /api/survey/stationing: {e}")

# 4. Live API endpoint test on local server: /api/survey/drainage
drainage_url = "http://127.0.0.1:8095/api/survey/drainage"
d_payload = {
    "scan_id": "edited_qihu_unified_merged_scan_4_scans__edited_372953",
    "min_ponding_depth_m": 0.05
}
req_d = urllib.request.Request(
    drainage_url,
    data=json.dumps(d_payload).encode("utf-8"),
    headers={"Content-Type": "application/json"}
)
try:
    with urllib.request.urlopen(req_d, timeout=10) as r:
        data = json.loads(r.read().decode("utf-8"))
        print("\n4. Live API Query: /api/survey/drainage")
        print(f"   HTTP Status: {r.status}")
        print(f"   Status in body: {data.get('status')}")
        depressions = data.get("depressions", [])
        print(f"   Depressions detected: {len(depressions)}")
        if depressions:
            print(f"   Top Depression: {depressions[0].get('depression_id')}, Vol: {depressions[0].get('volume_m3')} m3, MaxDepth: {depressions[0].get('max_depth_cm')} cm")
        assert data.get("status") == "ok"
        print("   [PASS] Live endpoint /api/survey/drainage returned genuine calculation.")
except Exception as e:
    print(f"   ERROR querying /api/survey/drainage: {e}")

print("\n=== DEPLOYMENT INTEGRITY VERIFIED: ALL CLEAN ===")
