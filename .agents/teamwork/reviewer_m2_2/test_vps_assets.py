import urllib.request
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

assets = [
    "https://scans.gatheren.cloud/survey-bim.css?v=20261031_v219",
    "https://scans.gatheren.cloud/src/09-construction-survey-and-bim.js?v=20261031_v219"
]

for url in assets:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
            content = resp.read()
            print(f"{url} -> HTTP {resp.status}, length: {len(content)} bytes")
    except Exception as e:
        print(f"{url} -> ERROR: {e}")
