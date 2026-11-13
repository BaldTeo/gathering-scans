import urllib.request
import json
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

urls = [
    "http://127.0.0.1:8095/api/status",
    "https://scans.gatheren.cloud/api/status"
]

for url in urls:
    try:
        with urllib.request.urlopen(url, context=ctx, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            print(f"{url} -> 200 OK: status={data.get('status')}, pc_online={data.get('pc_online')}, total_scans={data.get('total_scans')}")
    except Exception as e:
        print(f"{url} -> ERROR: {e}")
