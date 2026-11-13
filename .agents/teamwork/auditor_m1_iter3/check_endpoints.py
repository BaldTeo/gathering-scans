import urllib.request
import json
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

servers = [
    ('Local PC Daemon', 'http://127.0.0.1:8095'),
    ('Live Hostinger VPS', 'https://scans.gatheren.cloud')
]

for sname, base_url in servers:
    print(f"=== Testing {sname} ({base_url}) ===")
    try:
        req = urllib.request.Request(f"{base_url}/api/status", headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10, context=ctx if base_url.startswith("https") else None) as resp:
            data = json.loads(resp.read().decode())
            print(f"  /api/status -> HTTP {resp.status}, status={data.get('status')}")
    except Exception as e:
        print(f"  /api/status -> FAILED: {e}")

    # Test POST /api/survey/gcp-qa with empty/whitespace tokens
    try:
        payload = json.dumps({'scan_id': 'quchi_20261005_merged', 'points': [{'name': 'CP1', 'e': '', 'n': '  ', 'h_gcp': 'invalid'}]}).encode()
        req = urllib.request.Request(f"{base_url}/api/survey/gcp-qa", data=payload, headers={'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0'}, method='POST')
        with urllib.request.urlopen(req, timeout=15, context=ctx if base_url.startswith("https") else None) as resp:
            data = json.loads(resp.read().decode())
            print(f"  /api/survey/gcp-qa -> HTTP {resp.status}, status={data.get('status')}, point_count={data.get('point_count')}")
    except Exception as e:
        print(f"  /api/survey/gcp-qa -> FAILED: {e}")

    # Test POST /api/survey/volume with malformed polygon (should return HTTP 200 with clean error status, not 500)
    try:
        payload = json.dumps({'scan_id': 'quchi_20261005_merged', 'polygon': [{'x': '', 'z': '  '}, {'x': 10, 'z': 10}]}).encode()
        req = urllib.request.Request(f"{base_url}/api/survey/volume", data=payload, headers={'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0'}, method='POST')
        with urllib.request.urlopen(req, timeout=15, context=ctx if base_url.startswith("https") else None) as resp:
            data = json.loads(resp.read().decode())
            print(f"  /api/survey/volume -> HTTP {resp.status}, status={data.get('status')}, error={data.get('error')}")
    except Exception as e:
        print(f"  /api/survey/volume -> FAILED: {e}")
