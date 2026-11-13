import urllib.request
import json
import ssl

def check(url):
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "AuditorM7/1.0"})
        with urllib.request.urlopen(req, context=ctx, timeout=12.0) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            print(f"[OK] {url}: HTTP {resp.status}")
            print(f"     app: {data.get('app')}")
            print(f"     version: {data.get('version')}")
            print(f"     scans_count: {data.get('scans_count')}")
            print(f"     asset_version: {data.get('asset_version')}")
            return True, data
    except Exception as e:
        print(f"[FAIL] {url} ERROR: {e}")
        return False, str(e)

if __name__ == "__main__":
    print("=== Deployment Integrity Check ===")
    local_ok, local_data = check("http://127.0.0.1:8095/api/status")
    vps_ok, vps_data = check("https://scans.gatheren.cloud/api/status")
    print(f"\nSummary:")
    print(f"Local server (127.0.0.1:8095) online: {local_ok}")
    print(f"VPS server (scans.gatheren.cloud) online: {vps_ok}")
    
    # Also check utilities-query endpoint on live VPS if online
    if vps_ok:
        try:
            print("\nTesting VPS /api/survey/utilities-query:")
            payload = json.dumps({"scan_id": "rosepark_20260918_merged", "radius_m": 120}).encode("utf-8")
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            req = urllib.request.Request(
                "https://scans.gatheren.cloud/api/survey/utilities-query",
                data=payload,
                headers={"Content-Type": "application/json", "User-Agent": "AuditorM7/1.0"}
            )
            with urllib.request.urlopen(req, context=ctx, timeout=15.0) as resp:
                d = json.loads(resp.read().decode("utf-8"))
                print(f"VPS /api/survey/utilities-query status: {resp.status}, features: {len(d.get('features', []))}")
        except Exception as e:
            print(f"VPS utilities query error: {e}")
