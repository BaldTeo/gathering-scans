#!/usr/bin/env python3
"""
Automated Verification Suite for GatheringScans (scans.gatheren.cloud)
Tests:
1. GDrive Inbox OPF .zip extraction & TWD97 (121) + TWVD2001 coordinate conversion
2. Smart Single-Concurrency Queue (WSJF-Aging + Anti-Starvation after 3 bypasses / 90m)
3. PIX4Dmatic 2.11.0 .gst script generation (TWD97 + TWVD2001 WKT & 2048px 2K textures)
4. Cut/Fill & Stockpile Volume + HTML/Excel Report & AutoCAD .DXF/.DWG 3D Contours
5. Scoped External Share Links (/s/<token>) isolation & instant revocation
6. GC_ScanOptimizer PC actions & Google Chat Rich Card notifications
"""

import os
import sys
import time
import tempfile
import unittest

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from pc_worker.config import (
    GDRIVE_INBOX_DIR,
    TWD97_TWVD2001_WKT,
    PIX4DMATIC_TEXTURE_SIZE,
)
from pc_worker.priority_queue import ScanQueueDB, calculate_priority_score
from pc_worker.gdrive_watcher import extract_opf_zip_metadata, twd97_to_wgs84, wgs84_to_twd97
from pc_worker.pix4d_runner import generate_pix4dmatic_gst_script
from pc_worker.surveying_engine import SurveyingEngine
from pc_worker.auth_and_sharing import AuthAndSharingManager, parse_user_agent, is_link_preview_bot
from pc_worker.optimizer_bridge import OptimizerBridge
from pc_worker.gchat_notifier import GoogleChatNotifier


class GatheringScansTestSuite(unittest.TestCase):
    def setUp(self):
        self.tmp_db_fd, self.tmp_db_path = tempfile.mkstemp(suffix=".db")
        os.close(self.tmp_db_fd)
        self.db = ScanQueueDB(db_path=self.tmp_db_path)

    def tearDown(self):
        try:
            os.remove(self.tmp_db_path)
        except OSError:
            pass

    def test_01_twd97_and_opf_zip_extraction(self):
        """Verify TWD97 (121) <-> WGS84 conversion and real SCANS TEST .zip inspection."""
        lat, lon = twd97_to_wgs84(304952.656, 2757084.875)
        self.assertAlmostEqual(lat, 24.9203, places=3)
        self.assertAlmostEqual(lon, 121.5441, places=3)

        e, n, h = wgs84_to_twd97(lat, lon, 43.18)
        self.assertAlmostEqual(e, 304952.656, delta=1.5)
        self.assertAlmostEqual(n, 2757084.875, delta=1.5)

        if os.path.isdir(GDRIVE_INBOX_DIR):
            test_zip = os.path.join(GDRIVE_INBOX_DIR, "2026-10-05-15-37-05.zip")
            if os.path.isfile(test_zip):
                meta = extract_opf_zip_metadata(test_zip)
                self.assertEqual(meta["image_count"], 709)
                self.assertEqual(meta["project_group"], "QuChi Dam")
                self.assertEqual(meta["texture_resolution"], 2048)
                self.assertIn("TWD97", meta["crs"])

    def test_02_smart_priority_queue_and_anti_starvation(self):
        """Verify small scans get priority over large scans up to the anti-starvation threshold."""
        now = time.time()
        # Enqueue a large scan first (2463 photos)
        self.db.upsert_scan(
            {
                "scan_id": "large_scan_2463",
                "name": "Large Scan (2463 imgs)",
                "image_count": 2463,
                "size_bytes": 8600 * 1024 * 1024,
                "uploaded_at": now - 60,  # waited 1 min
                "status": "queued",
            }
        )
        # Enqueue a small scan slightly later (120 photos)
        self.db.upsert_scan(
            {
                "scan_id": "small_scan_120",
                "name": "Small Trench Scan (120 imgs)",
                "image_count": 120,
                "size_bytes": 350 * 1024 * 1024,
                "uploaded_at": now,
                "status": "queued",
            }
        )

        # Pop first job -> small scan should win because 120 imgs << 2463 imgs
        job1 = self.db.pop_next_job(now=now)
        self.assertIsNotNone(job1)
        self.assertEqual(job1["scan_id"], "small_scan_120")

        # While job1 is 'processing', single-concurrency mutex blocks next pop
        blocked = self.db.pop_next_job(now=now)
        self.assertIsNone(blocked)

        # Complete job1 and verify large_scan_2463 had its bypass_count incremented to 1
        self.db.update_job_progress("small_scan_120", "completed", 100.0, "Done")
        large_info = self.db.get_scan("large_scan_2463")
        self.assertEqual(large_info["bypass_count"], 1)

        # Simulate 2 more small scans bypassing large_scan_2463 (reaching bypass_count == 3)
        for idx in (2, 3):
            sid = f"small_scan_{idx}"
            self.db.upsert_scan(
                {
                    "scan_id": sid,
                    "name": f"Small Scan {idx}",
                    "image_count": 90,
                    "size_bytes": 200 * 1024 * 1024,
                    "uploaded_at": now + idx,
                    "status": "queued",
                }
            )
            popped = self.db.pop_next_job(now=now + idx)
            self.assertEqual(popped["scan_id"], sid)
            self.db.update_job_progress(sid, "completed", 100.0, "Done")

        # Now large_scan_2463 has bypass_count == 3 -> anti-starvation lock MUST beat a brand new tiny scan!
        self.db.upsert_scan(
            {
                "scan_id": "tiny_scan_30",
                "name": "Tiny Scan (30 imgs)",
                "image_count": 30,
                "size_bytes": 80 * 1024 * 1024,
                "uploaded_at": now + 10,
                "status": "queued",
            }
        )
        locked_job = self.db.pop_next_job(now=now + 10)
        self.assertEqual(locked_job["scan_id"], "large_scan_2463")

    def test_03_pix4dmatic_gst_enforces_twd97_twvd2001_and_2k(self):
        """Verify generated PIX4Dmatic .gst script enforces EPSG:3826+8904 and 2048 textureSize."""
        gst = generate_pix4dmatic_gst_script(
            project_p4m_path="C:/Scans/test_job/test_job.p4m",
            input_zip_or_folder="G:/My Drive/SCANS TEST/2026-10-05-15-37-05.zip",
            export_dir="C:/Scans/test_job/exports",
        )
        self.assertIn("SetGcpCrs", gst)
        self.assertIn('ID["EPSG",3826]', gst)
        self.assertIn('ID["EPSG",8904]', gst)
        self.assertIn('GEOIDMODEL["TWGEOID2018h"]', gst)
        self.assertIn(f"settings.textureSize : {PIX4DMATIC_TEXTURE_SIZE}", gst)
        self.assertTrue("settings.exportSrs : ExportSrs.Scene" in gst or "settings.exportSrs : ExportSrs.Project" in gst)
        self.assertIn("CloseSession", gst)

    def test_04_surveying_volume_and_dwg_dxf_contours(self):
        """Verify Cut/Fill Stockpile report generation and AutoCAD 3D .DXF/.DWG contour export."""
        survey = SurveyingEngine(self.db)
        vol = survey.calculate_cut_fill_volume(
            {
                "scan_id": "quchi_20261005_merged",
                "stockpile_name": "Unit Test Stockpile",
                "base_mode": "triangulated_boundary",
                "material_type": "crushed_stone",
                "polygon": [
                    [304945.0, 2757078.0, 43.1],
                    [304960.0, 2757078.0, 43.1],
                    [304960.0, 2757090.0, 43.2],
                    [304945.0, 2757090.0, 43.2],
                ],
            }
        )
        self.assertEqual(vol["status"], "ok")
        self.assertAlmostEqual(vol["planar_area_m2"], 180.0, places=1)
        self.assertGreater(vol["fill_volume_m3"], 50.0)
        self.assertGreater(vol["estimated_tonnage_t"], 80.0)

        cnt = survey.generate_elevation_contours(
            {
                "scan_id": "quchi_20261005_merged",
                "minor_interval_m": 0.5,
                "major_interval_m": 2.5,
            }
        )
        self.assertEqual(cnt["status"], "ok")
        self.assertGreater(cnt["contour_count"], 10)
        self.assertTrue(cnt["dxf_url"].endswith(".dxf"))
        self.assertTrue(cnt["dwg_url"].endswith((".dwg", ".dxf")))

    def test_05_scoped_external_sharing_and_revocation(self):
        """Verify external share links strictly isolate scan access and revoke immediately."""
        self.db.upsert_scan({"scan_id": "scan_a", "name": "Scan A", "project_group": "Group 1", "status": "completed"})
        self.db.upsert_scan({"scan_id": "scan_b", "name": "Scan B", "project_group": "Group 2", "status": "completed"})

        auth = AuthAndSharingManager(self.db)
        link = auth.create_share_link(
            {
                "scope_type": "scan",
                "target_id": "scan_a",
                "label": "External Contractor Link",
            }
        )
        tok = link["token"]
        self.assertEqual(link["share_url"], f"https://scans.gatheren.cloud/s/{tok}")
        self.assertEqual(link["direct_url"], f"https://scans.gatheren.cloud/?share={tok}")

        # Authorized scan_a succeeds
        ok_a, _, _, allowed = auth.validate_share_access(tok, requested_scan_id="scan_a")
        self.assertTrue(ok_a)
        self.assertEqual(len(allowed), 1)
        self.assertEqual(allowed[0]["scan_id"], "scan_a")

        # Unauthorized scan_b is strictly blocked
        ok_b, reason_b, _, _ = auth.validate_share_access(tok, requested_scan_id="scan_b")
        self.assertFalse(ok_b)
        self.assertIn("outside the authorized scope", reason_b)

        # Revoke link -> scan_a is immediately blocked
        auth.revoke_share_link(tok)
        ok_revoked, reason_rev, _, _ = auth.validate_share_access(tok, requested_scan_id="scan_a")
        self.assertFalse(ok_revoked)
        self.assertIn("revoked", reason_rev)

        # Quick Single-Scan View & Comment Only link
        quick_link = auth.create_share_link(
            {
                "scope_type": "scan",
                "target_id": "scan_a",
                "label": "View & Comment — Scan A",
                "allow_measurements": False,
                "allow_comments": True,
                "allow_download": False,
            }
        )
        self.assertFalse(quick_link["allow_measurements"])
        self.assertTrue(quick_link["allow_comments"])
        self.assertFalse(quick_link["allow_download"])
        self.assertTrue(quick_link["share_url"].startswith("https://scans.gatheren.cloud/s/"))

    def test_06_share_telemetry_analytics_and_preview_bots(self):
        """Verify LINE/chat bot detection vs LINE In-App human browser, and monotonic telemetry analytics."""
        # 1. LINE link-preview bot vs LINE In-App human visitor vs Desktop Chrome
        line_bot = parse_user_agent("facebookexternalhit/1.1;line-poker/1.0")
        self.assertTrue(line_bot["is_bot"])
        self.assertEqual(line_bot["browser"], "LINE Preview Bot")
        self.assertTrue(is_link_preview_bot("facebookexternalhit/1.1;line-poker/1.0"))

        line_human = parse_user_agent(
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 "
            "(KHTML, like Gecko) Mobile/15E148 Safari/604.1 Line/14.16.0"
        )
        self.assertFalse(line_human["is_bot"])
        self.assertIn("LINE In-App", line_human["browser"])
        self.assertEqual(line_human["os"], "iOS 17.5")
        self.assertEqual(line_human["device_type"], "Mobile")

        # 2. Bot unfurl vs Human session telemetry
        self.db.upsert_scan(
            {
                "scan_id": "scan_qihu",
                "name": "QiHu — Unified Merged Scan (4 Scans)",
                "project_group": "QiHu",
                "capture_date": "2026-10-24",
                "status": "completed",
            }
        )
        auth = AuthAndSharingManager(self.db)
        link = auth.create_share_link(
            {
                "scope_type": "scan",
                "target_id": "scan_qihu",
                "label": "View & Comment — QiHu",
                "allow_measurements": False,
                "allow_comments": True,
                "allow_download": False,
            }
        )
        tok = link["token"]

        # Chat preview unfurl does NOT inflate human view_count
        auth.record_bot_unfurl(tok, "203.104.140.10", "facebookexternalhit/1.1;line-poker/1.0")
        after_bot = auth.get_share_link(tok)
        self.assertEqual(after_bot["view_count"], 0)
        self.assertEqual(after_bot["bot_unfurls"], 1)

        # Human session #1 initial heartbeat + later monotonic update
        auth.record_or_update_share_session(
            {
                "token": tok,
                "session_id": "s_test_human_1",
                "visitor_id": "v_alice_01",
                "viewer_name": "",
                "total_duration_sec": 12.0,
                "active_duration_sec": 10.0,
                "max_load_pct": 65.0,
                "camera_interactions": 4,
                "scans_viewed": [{"scan_id": "scan_qihu", "name": "QiHu — Unified Merged Scan (4 Scans)"}],
                "tools_used": {"orbit": {"count": 4, "seconds": 10.0}},
                "events": [{"id": "ev1", "t": 0.0, "type": "session_open", "detail": "Opened link"}],
            },
            request_meta={
                "ip_address": "127.0.0.1",
                "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
                "accept_language": "zh-TW",
            },
        )
        auth.record_or_update_share_session(
            {
                "token": tok,
                "session_id": "s_test_human_1",
                "visitor_id": "v_alice_01",
                "viewer_name": "Alice Chen",
                "total_duration_sec": 95.0,
                "active_duration_sec": 74.0,
                "max_load_pct": 100.0,
                "load_time_ms": 2850,
                "camera_interactions": 18,
                "fp_seconds": 22.0,
                "comments_posted": 1,
                "tools_used": {
                    "orbit": {"count": 18, "seconds": 40.0},
                    "first_person_fly": {"count": 1, "seconds": 22.0},
                    "comments": {"count": 1, "seconds": 12.0},
                    "comment_posted": {"count": 1, "seconds": 0.0},
                },
                "events": [
                    {"id": "ev1", "t": 0.0, "type": "session_open", "detail": "Opened link"},
                    {"id": "ev2", "t": 2.9, "type": "scan_loaded", "detail": "100%"},
                    {"id": "ev3", "t": 55.0, "type": "comment", "detail": "Alice Chen posted comment"},
                ],
            },
            request_meta={"ip_address": "127.0.0.1"},
        )

        analytics = auth.get_share_analytics(token=tok)
        self.assertEqual(analytics["status"], "ok")
        summary = analytics["summary"]
        self.assertEqual(analytics["link"]["view_count"], 1)
        self.assertEqual(summary["recorded_sessions"], 1)
        self.assertEqual(summary["unique_visitors"], 1)
        self.assertEqual(summary["bot_unfurls"], 1)
        self.assertAlmostEqual(summary["total_active_sec"], 74.0, places=1)
        self.assertEqual(summary["comments_posted_total"], 1)
        human_sess = [s for s in analytics["sessions"] if not s["is_bot"]][0]
        self.assertEqual(human_sess["viewer_name"], "Alice Chen")
        self.assertEqual(human_sess["load_time_ms"], 2850)
        self.assertEqual(len(human_sess["events"]), 3)

    def test_07_modular_architecture_strict_5000_line_ceiling(self):
        """Verify all source files (.py, .js, .css, .html) strictly obey the < 5,000-line modular limit."""
        checked = 0
        for root, dirs, files in os.walk(BASE_DIR):
            dirs[:] = [
                d
                for d in dirs
                if d not in (".git", "data", "node_modules", "__pycache__", ".agent", "third_party")
            ]
            for fn in files:
                if fn.endswith((".py", ".js", ".css", ".html")):
                    fp = os.path.join(root, fn)
                    with open(fp, "r", encoding="utf-8", errors="ignore") as f:
                        line_count = sum(1 for _ in f)
                    self.assertLess(
                        line_count,
                        5000,
                        f"File {os.path.relpath(fp, BASE_DIR)} has {line_count} lines (exceeds 5,000-line ceiling)",
                    )
                    checked += 1
        self.assertGreaterEqual(checked, 35)


if __name__ == "__main__":
    unittest.main()
