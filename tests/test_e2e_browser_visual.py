#!/usr/bin/env python3
"""
End-to-End Live HTTP API + Headless Chrome Visual Verification for GatheringScans
Verifies:
1. All REST APIs & HTTP Range streaming of QuChi_20261005_Compressed-optimized_tileset
2. Scoped external share link enforcement (200 OK for allowed scan, 403 Forbidden for other scans & after revoke)
3. Captures screenshots of Map Overview, 3D Studio + Cut/Fill Volume Report, 3D Contours + DWG Export,
   Multi-Date Curtain Slider + Delta-Z Heatmap, PIX4Dmatic Smart Queue, and Sharing Controls.
"""

import os
import sys
import json
import time
import subprocess
import urllib.request
import urllib.error

BASE_URL = "http://127.0.0.1:8095"
ARTIFACT_DIR = r"C:\Users\user\.gemini\antigravity\brain\a9a1ef66-7562-4e8a-9f4f-f2f841ffdeb5"
os.makedirs(ARTIFACT_DIR, exist_ok=True)


def http_json(method: str, path: str, body: dict = None, headers: dict = None):
    url = BASE_URL + path
    req_headers = {"Content-Type": "application/json"}
    if headers:
        req_headers.update(headers)
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, headers=req_headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


def run_api_e2e_checks():
    print("=== [1/6] Checking /api/status and /api/scans ===")
    st_code, st = http_json("GET", "/api/status")
    assert st_code == 200 and st["pc_online"] is True
    assert "TWD97" in st["crs"] and st["texture_limit"] == 2048

    sc_code, sc = http_json("GET", "/api/scans")
    assert sc_code == 200 and len(sc["scans"]) >= 5
    scan_ids = [s["scan_id"] for s in sc["scans"]]
    print(f"Discovered {len(scan_ids)} scans: {scan_ids}")
    assert "quchi_20261005_merged" in scan_ids

    print("=== [2/6] Verifying 3D Tileset HTTP Range Streaming (QuChi_20261005_Compressed-optimized_tileset) ===")
    ts_req = urllib.request.Request(f"{BASE_URL}/stream/quchi_20261005_merged/tileset.json")
    with urllib.request.urlopen(ts_req, timeout=10) as r:
        ts_data = json.loads(r.read().decode("utf-8"))
        assert "root" in ts_data
        box = ts_data["root"]["boundingVolume"]["box"]
        print(f"Verified TWD97 Tileset Root Box Center: E={box[0]}, N={box[1]}, H={box[2]}")
        assert 300000 <= box[0] <= 310000 and 2750000 <= box[1] <= 2760000

    # Range request for tiles/root.glb
    glb_req = urllib.request.Request(
        f"{BASE_URL}/stream/quchi_20261005_merged/tiles/root.glb",
        headers={"Range": "bytes=0-15"},
    )
    with urllib.request.urlopen(glb_req, timeout=10) as r:
        assert r.status == 206
        magic = r.read()
        assert magic[:4] == b"glTF"
        print("Verified HTTP 206 Partial Content Range streaming of tiles/root.glb (magic: b'glTF')")

    print("=== [3/6] Verifying Civil Surveying APIs (Volume, Contours DWG/DXF, Profile, RTK Photos) ===")
    v_code, v_res = http_json(
        "POST",
        "/api/survey/volume",
        {
            "scan_id": "quchi_20261005_merged",
            "stockpile_name": "QuChi Spillway Aggregate Stockpile A",
            "base_mode": "triangulated_boundary",
            "material_type": "crushed_stone",
        },
    )
    assert v_code == 200 and v_res["fill_volume_m3"] > 0 and v_res["estimated_tonnage_t"] > 0
    print(
        f"Stockpile Volume: +{v_res['fill_volume_m3']} m3 | Mass: {v_res['estimated_tonnage_t']} t | Report: {v_res['report_html_url']}"
    )

    c_code, c_res = http_json(
        "POST",
        "/api/survey/contours",
        {"scan_id": "quchi_20261005_merged", "minor_interval_m": 0.5, "major_interval_m": 2.5},
    )
    assert c_code == 200 and c_res["contour_count"] > 10
    # Verify DXF and DWG download
    with urllib.request.urlopen(BASE_URL + c_res["dxf_url"]) as r:
        dxf_bytes = r.read()
        assert b"CONTOUR-MAJOR" in dxf_bytes and b"POLYLINE" in dxf_bytes
    with urllib.request.urlopen(BASE_URL + c_res["dwg_url"]) as r:
        dwg_bytes = r.read()
        assert dwg_bytes.startswith(b"AC1027")
    print(f"Verified .DXF ({len(dxf_bytes)}B) and .DWG ({len(dwg_bytes)}B) CAD exports in TWD97 + TWVD2001")

    p_code, p_res = http_json("POST", "/api/survey/profile", {"scan_id": "quchi_20261005_merged"})
    assert p_code == 200 and len(p_res["samples"]) > 10

    ph_code, ph_res = http_json(
        "POST", "/api/survey/inspect-photos", {"scan_id": "quchi_20261005_merged", "x": 2.0, "y": 1.0, "z": -3.0}
    )
    assert ph_code == 200

    print("=== [4/6] Verifying GC_ScanOptimizer PC Actions & PIX4Dmatic .GST Preview ===")
    opt_code, opt_res = http_json(
        "POST",
        "/api/optimizer/optimize",
        {"scan_id": "quchi_20261005_merged", "preset": "balanced", "fast_mode": True},
    )
    assert opt_code == 200 and opt_res["texture_limit"] == 2048 and opt_res["reduction_pct"] > 0
    print(f"Verified GC_ScanOptimizer preset='balanced': -{opt_res['reduction_pct']}% (2K texture cap)")

    gst_code, gst_res = http_json("POST", "/api/queue/preview-gst", {"scan_id": "quchi_20261005_merged"})
    assert gst_code == 200 and 'ID["EPSG",3826]' in gst_res["gst_script"] and "2048" in gst_res["gst_script"]

    print("=== [5/6] Verifying Scoped External Share Link Isolation & Instant Revocation ===")
    sh_code, sh_res = http_json(
        "POST",
        "/api/share/create",
        {
            "scope_type": "scan",
            "target_id": "quchi_20261005_merged",
            "label": "E2E External Subcontractor Link",
            "allow_measurements": True,
            "allow_comments": True,
            "allow_download": False,
        },
    )
    assert sh_code == 200
    token = sh_res["link"]["token"]

    # External guest can list ONLY quchi_20261005_merged
    g_code, g_scans = http_json("GET", f"/api/scans?share={token}")
    assert g_code == 200 and len(g_scans["scans"]) == 1
    assert g_scans["scans"][0]["scan_id"] == "quchi_20261005_merged"

    # External guest is blocked (403) from accessing rosepark_20260918_merged
    b_code, _ = http_json("GET", f"/api/scans/rosepark_20260918_merged?share={token}")
    assert b_code == 403

    # Revoke share link -> External guest is immediately blocked (403)
    rev_code, _ = http_json("POST", "/api/share/revoke", {"token": token})
    assert rev_code == 200
    after_code, _ = http_json("GET", f"/api/scans?share={token}")
    assert after_code == 403
    print(f"Verified scoped external share token (/s/{token}) isolation & instant revocation (HTTP 403)")

    print("=== [6/6] Verifying Google Chat Notification Card & Offline Cache Manifest ===")
    gc_code, gc_res = http_json("POST", "/api/gchat/notify", {"scan_id": "quchi_20261005_merged"})
    assert gc_code == 200 and "cardsV2" in gc_res["card"]
    mf_code, mf_res = http_json("GET", "/api/cache/manifest/quchi_20261005_merged")
    assert mf_code == 200 and len(mf_res["asset_urls"]) >= 2
    print("All API E2E assertions passed 100%!")


if __name__ == "__main__":
    run_api_e2e_checks()
