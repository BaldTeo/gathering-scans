#!/usr/bin/env python3
"""
Live PIX4Dmatic 2.11.0 Headless .GST Execution Smoke Test
Verifies that PIX4Dmatic.exe --gst executes headless, creates a .p4m project
with TWD97 (121) [EPSG:3826] + TWVD2001 [EPSG:8904], and closes cleanly.
"""
import os
import sys
import time
import shutil
import subprocess

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from pc_worker.config import PIX4DMATIC_EXE, TWD97_TWVD2001_WKT


def main():
    test_dir = os.path.join(BASE_DIR, "data", "pix4d_smoke_test")
    if os.path.exists(test_dir):
        shutil.rmtree(test_dir, ignore_errors=True)
    os.makedirs(test_dir, exist_ok=True)

    p4m_path = os.path.join(test_dir, "smoke_twd97.p4m").replace("\\", "/")
    gst_path = os.path.join(test_dir, "smoke_twd97.gst")

    gst = f"""import Pix4D.Gst 1.0

Session {{
    Project {{
        path : "{p4m_path}"
        create : true

        SetGcpCrs {{
            settings.srsDefinition : '{TWD97_TWVD2001_WKT}'
            inputs : [InputCameras{{ }},TiePointSet{{ }},RoiSet{{ }}]
            outputs : [InputCameras{{ }},TiePointSet{{ }},RoiSet{{ }}]
        }}
        SaveProject {{ }}
    }}
    CloseSession {{ }}
}}
"""
    with open(gst_path, "w", encoding="utf-8") as f:
        f.write(gst)

    startupinfo = subprocess.STARTUPINFO()
    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startupinfo.wShowWindow = 7

    t0 = time.time()
    p = subprocess.run(
        [PIX4DMATIC_EXE, "--gst", gst_path],
        capture_output=True,
        text=True,
        timeout=90,
        startupinfo=startupinfo,
    )
    dt = round(time.time() - t0, 2)
    print(f"Exit code: {p.returncode} in {dt}s")
    print("Stdout:", p.stdout[-1200:])
    print("Stderr:", p.stderr[-1200:])
    print("Created files:", os.listdir(test_dir))


if __name__ == "__main__":
    main()
