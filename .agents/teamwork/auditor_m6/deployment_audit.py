import json
import urllib.request
import urllib.error

def check_deployment():
    print("=== DEPLOYMENT INTEGRITY CHECK ===")

    # 1. Local Server status
    local_url = "http://127.0.0.1:8095/api/status"
    try:
        req = urllib.request.Request(local_url, headers={"User-Agent": "AuditorM6"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            status_code = resp.getcode()
            body = resp.read().decode("utf-8")
            data = json.loads(body)
            print(f"[LOCAL SERVER] {local_url} -> HTTP {status_code}")
            print(f"  status: {data.get('status')}, daemon_running: {data.get('daemon_running')}, version: {data.get('version')}")
    except Exception as e:
        print(f"[LOCAL SERVER ERROR] {e}")

    # 2. Local asset check
    asset_local = "http://127.0.0.1:8095/src/11-scan-to-bim-primitives.js"
    try:
        req = urllib.request.Request(asset_local, headers={"User-Agent": "AuditorM6"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            status_code = resp.getcode()
            content = resp.read()
            print(f"[LOCAL ASSET] {asset_local} -> HTTP {status_code}, Length: {len(content)} bytes")
    except Exception as e:
        print(f"[LOCAL ASSET ERROR] {e}")

    # 3. Live VPS status
    vps_url = "https://scans.gatheren.cloud/api/status"
    try:
        req = urllib.request.Request(vps_url, headers={"User-Agent": "AuditorM6"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            status_code = resp.getcode()
            body = resp.read().decode("utf-8")
            data = json.loads(body)
            print(f"[VPS SERVER] {vps_url} -> HTTP {status_code}")
            print(f"  status: {data.get('status')}, version: {data.get('version')}")
    except Exception as e:
        print(f"[VPS SERVER ERROR] {e}")

    # 4. Live VPS asset check
    asset_vps = "https://scans.gatheren.cloud/src/11-scan-to-bim-primitives.js"
    try:
        req = urllib.request.Request(asset_vps, headers={"User-Agent": "AuditorM6"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            status_code = resp.getcode()
            content = resp.read()
            print(f"[VPS ASSET] {asset_vps} -> HTTP {status_code}, Length: {len(content)} bytes")
    except Exception as e:
        print(f"[VPS ASSET ERROR] {e}")

    # 5. Local API endpoint POST /api/survey/scan-to-bim
    api_url = "http://127.0.0.1:8095/api/survey/scan-to-bim"
    try:
        payload = json.dumps({"scan_id": "quchi_20261005_merged", "categories": ["walls", "trees"]}).encode("utf-8")
        req = urllib.request.Request(api_url, data=payload, headers={"Content-Type": "application/json", "User-Agent": "AuditorM6"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            status_code = resp.getcode()
            res_data = json.loads(resp.read().decode("utf-8"))
            print(f"[LOCAL API POST /api/survey/scan-to-bim] -> HTTP {status_code}")
            print(f"  ok: {res_data.get('ok')}, primitive_count: {res_data.get('primitive_count')}, total_volume_m3: {res_data.get('total_volume_m3')}")
    except Exception as e:
        print(f"[LOCAL API ERROR] {e}")

if __name__ == "__main__":
    check_deployment()
