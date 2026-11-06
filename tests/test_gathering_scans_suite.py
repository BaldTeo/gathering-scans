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
import math
import unittest
import re

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
    def _ensure_test_scan(self, scan_id: str = "quchi_20261005_merged"):
        """Hermetic scan record guaranteeing zero dependency on data/gdrive_cloud_manifest.json."""
        self.db.upsert_scan(
            {
                "scan_id": scan_id,
                "name": "2026-10-05-15-43-55",
                "project_group": "QuChi Dam",
                "project_dir": r"C:\GatheringScans\QuChi_20261005_Compressed",
                "tileset_path": r"C:\GatheringScans\QuChi_20261005_Compressed\tileset\tileset.json",
                "obj_path": r"C:\Scans\QuChi\QuChi_20261005_Compressed\exports\QuChi_20261005_Compressed-obj_mesh\mesh.obj",
                "crs": "TWD97 (121) + TWVD2001",
                "status": "completed",
            }
        )

    def setUp(self):
        self.tmp_db_fd, self.tmp_db_path = tempfile.mkstemp(suffix=".db")
        os.close(self.tmp_db_fd)
        self.db = ScanQueueDB(db_path=self.tmp_db_path)
        self.survey = SurveyingEngine(db=self.db)
        self._ensure_test_scan("quchi_20261005_merged")

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
        self.assertGreater(vol["fill_volume_m3"], 45.0)
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

    def test_08_eleven_ux_and_surveying_fixes(self):
        """Verify all 11 UX, mobile, surveying, and admin layout fixes."""
        survey = SurveyingEngine(self.db)

        # 1. Profile slope in % and dh:L
        prof = survey.compute_cross_section_profile(
            {
                "scan_id": "quchi_20261005_merged",
                "start_point": [304945.0, 2757078.0],
                "end_point": [304960.0, 2757090.0],
            }
        )
        self.assertEqual(prof["status"], "ok")
        self.assertIn("overall_dh_m", prof)
        self.assertIn("overall_slope_pct", prof)
        self.assertIn("overall_slope_dhl", prof)
        self.assertTrue(prof["overall_slope_dhl"].startswith(("1:", "0:")))

        with open(os.path.join(BASE_DIR, "web", "index.html"), "r", encoding="utf-8") as f:
            html = f.read()
        with open(os.path.join(BASE_DIR, "web", "app.css"), "r", encoding="utf-8") as f:
            css = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "01-core-state.js"), "r", encoding="utf-8") as f:
            js01 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "02-map-and-timeline.js"), "r", encoding="utf-8") as f:
            js02 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "03-studio-core.js"), "r", encoding="utf-8") as f:
            js03 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "04-studio-lasso-and-edits.js"), "r", encoding="utf-8") as f:
            js04 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "05-studio-civil-inspectors.js"), "r", encoding="utf-8") as f:
            js05 = f.read()

        # 2. Guest mode includes laser and volume tools
        self.assertIn('"btnMeasureLaser"', js01)
        self.assertIn('"btnMeasureVolume"', js01)
        self.assertIn('"btnDockVolume"', js01)

        # 3. Mobile view first page map-only until site chosen
        self.assertIn("mobile-site-open", css)
        self.assertIn("mobile-site-open", js02)

        # 4. Mobile Studio editing dock umbrella button & Clear right after Laser
        self.assertIn('id="btnMobileEditingUmbrella"', html)
        laser_idx = html.index('id="btnMeasureLaser"')
        clear_idx = html.index('id="btnMeasureClear"')
        vol_idx = html.index('id="btnDockVolume"')
        self.assertLess(laser_idx, clear_idx)
        self.assertLess(clear_idx, vol_idx)

        # 5. Laser 2 independent bubble pairs (width & length) with dh:L and no origin label
        self.assertIn("formatSlopeDhL", js04)
        self.assertIn("autodesk-laser-pair", js04)
        self.assertIn("laser-bubble-w", js04)
        self.assertIn("laser-bubble-l", js04)

        # 6. Top-left semi-transparent red-blue small north arrow
        self.assertIn('id="gsNorthArrowCompass"', html)
        self.assertIn("updateNorthArrowCompass", js03)

        # 7. Angle tool: angle once at P2 + azimuths at P1 & P3
        self.assertIn("autodesk-azimuth-badge", js03)
        self.assertIn("Az ${az1.toFixed(1)}°", js03)
        self.assertIn("Az ${az3.toFixed(1)}°", js03)

        # 8. Compact 4-row point coordinate badge (Name; E; N; H)
        self.assertIn("coord-row coord-row-name", js03)

        # 9. Area tool waits until polygon is closed
        self.assertIn("renderClosedAreaPolygon", js04)

        # 10. Section, Profile, Volume, Contours wait for user input
        self.assertIn('tool === "section"', js04)
        self.assertIn("STATE.sectionBoxEndpoints", js05)
        self.assertIn("Slope A→B (% & dh:L)", js05)

        # 11. GChat webhook inside Admin Settings modal (#modalOfflineCache) and NOT in #modalQueue
        queue_start = html.index('id="modalQueue"')
        offline_start = html.index('id="modalOfflineCache"')
        webhook_idx = html.index('id="inputGChatWebhookUrl"')
        self.assertGreater(webhook_idx, offline_start)
        self.assertNotIn('id="inputGChatWebhookUrl"', html[queue_start:offline_start])

    def test_09_six_additional_ux_security_and_compare_fixes(self):
        """Verify all 6 additional fixes: Comments persistence & CRUD, 3x North Arrow without background, 2-row TWD97/WGS84, 雲在天 博士, 3/4-scan Multi-Viewport Compare, and Admin-only settings security."""
        # 1a & 1b: Comments returned in list_scans(), update_comment(), and delete_comment()
        scan_id = "quchi_20261005_merged"
        self.db.upsert_scan(
            {
                "scan_id": scan_id,
                "name": "QuChi Dam Merged Scan",
                "project_group": "QuChi Dam",
                "status": "completed",
            }
        )
        created = self.db.add_comment(
            {
                "scan_id": scan_id,
                "author_email": "glibivanov@gatheren.com.tw",
                "author_name": "雲在天",
                "text": "Initial test comment on scan",
                "pos_x": 1.5,
                "pos_y": 2.0,
                "pos_z": -3.5,
                "twd97_e": 304950.0,
                "twd97_n": 2757080.0,
                "twd97_h": 125.4,
            }
        )
        cid = created["comment_id"]
        scans = self.db.list_scans()
        target_scan = [s for s in scans if s["scan_id"] == scan_id][0]
        self.assertIn("comments", target_scan)
        self.assertTrue(any(c["comment_id"] == cid for c in target_scan["comments"]))

        updated = self.db.update_comment(cid, "Edited test comment text", "雲在天")
        self.assertIsNotNone(updated)
        self.assertEqual(updated["text"], "Edited test comment text")

        deleted_ok = self.db.delete_comment(cid)
        self.assertTrue(deleted_ok)
        scans_after = self.db.list_scans()
        target_after = [s for s in scans_after if s["scan_id"] == scan_id][0]
        self.assertFalse(any(c["comment_id"] == cid for c in target_after["comments"]))

        with open(os.path.join(BASE_DIR, "web", "index.html"), "r", encoding="utf-8") as f:
            html = f.read()
        with open(os.path.join(BASE_DIR, "web", "app.css"), "r", encoding="utf-8") as f:
            css = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "01-core-state.js"), "r", encoding="utf-8") as f:
            js01 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "02-map-and-timeline.js"), "r", encoding="utf-8") as f:
            js02 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "03-studio-core.js"), "r", encoding="utf-8") as f:
            js03 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "04-studio-lasso-and-edits.js"), "r", encoding="utf-8") as f:
            js04 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "05-studio-civil-inspectors.js"), "r", encoding="utf-8") as f:
            js05 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "07-compare-and-queue.js"), "r", encoding="utf-8") as f:
            js07 = f.read()
        with open(os.path.join(BASE_DIR, "web", "app.js"), "r", encoding="utf-8") as f:
            app_js = f.read()
        with open(os.path.join(BASE_DIR, "server.py"), "r", encoding="utf-8") as f:
            srv_py = f.read()

        # 1a/1b/1c: Comment pins preserved on clear, edit/delete buttons, semi-transparent comment icon + hover/tap popover
        self.assertIn("isCommentPin", js03)
        self.assertIn("STATE.pendingCommentDraftPt", js04)
        self.assertNotIn('if (tool === "comments") {\n      add3DPinMarker', js04)
        self.assertIn("data-comment-edit", js05)
        self.assertIn("data-comment-delete", js05)
        self.assertIn("gs-scan-comment-pin", js05)
        self.assertIn("gs-comment-pin-popover", js05)
        self.assertIn(".gs-scan-comment-pin", css)

        # 2. North arrow compass ~3x bigger (84x84 SVG, 92x92 container), no circular background, mobile top: 76px
        self.assertIn('width="84" height="84"', html)
        self.assertIn("background: transparent !important;", css)
        self.assertIn("top: 76px !important;", css)

        # 3. Removed redundant TWD97 labels and 2-row TWD97 + WGS84 in Scan Clusters modal
        self.assertNotIn("Scan Clusters (TWD97)", html)
        self.assertNotIn("掃描工區群組 (TWD97)", html)
        self.assertIn('coordEl.innerHTML = `<div style="white-space:nowrap;">TWD97(121)', js02)
        self.assertNotIn("Google Maps · TWD97 (121) + TWVD2001", js02)

        # 4. In Chinese Dr. Glib Ivanov is 雲在天 博士
        self.assertIn("由 雲在天 博士與 Gemini 4 Argon 開發", html)
        self.assertIn("由 雲在天 博士與 Gemini 4 Argon 開發", app_js)
        self.assertNotIn("由 Glib Ivanov 博士", html)
        self.assertNotIn("由 Glib Ivanov 博士", app_js)

        # 5. Compare 2, 3, or 4 scans in Multi-Viewport
        self.assertIn('id="compareScanCountSwitcher"', html)
        self.assertIn('id="compareThirdLayer"', html)
        self.assertIn('id="compareFourthLayer"', html)
        self.assertIn('id="compareThirdSelect"', html)
        self.assertIn('id="compareFourthSelect"', html)
        self.assertIn("setCompareScanCount", js07)
        self.assertIn('data-compare-count="3"', css)
        self.assertIn('data-compare-count="4"', css)

        # 6. Critical/secret/internal settings accessible only by Admin
        self.assertIn('setDisp("adminControlPanelSection", info.canManageUsers', js01)
        self.assertIn('setDisp("settingsServiceAccountCard", info.canManageUsers', js01)
        self.assertIn('setDisp("settingsPix4dPipelineSection", info.canManageUsers', js01)
        self.assertIn('setDisp("gateExistingUsersSection", info.canManageUsers', js01)
        self.assertIn("_filter_profiles_for_caller", srv_py)

    def test_10_six_new_surveying_compare_and_qa_features(self):
        """Verify all 6 new civil surveying, compare & QA features:
        1. Persistent Measurement Bookmarks (SQLite + REST + Studio restore)
        2. True Orthomosaic 2D Nadir Plan Overlay on Map
        3. Compare Mode ΔZ Probe & Multi-Epoch Cross-Section Profile (A→B)
        4. Surface Drainage / Slope Steepness Heatmap & Rainwater Runoff Flow-Lines
        5. Automated GCP / Check-Point Accuracy QA Report (RMSE_E/N/Z/3D + ASPRS grade)
        6. Direct Field-to-3D Photo Frustum Projection & Camera Alignment
        """
        scan_id = "quchi_20261005_merged"
        self.db.upsert_scan(
            {
                "scan_id": scan_id,
                "name": "QuChi Dam Merged Scan",
                "project_group": "QuChi Dam",
                "status": "completed",
            }
        )

        # 1. Persistent Measurement Bookmarks CRUD in ScanQueueDB
        saved_bm = self.db.save_measurement_bookmark(
            {
                "scan_id": scan_id,
                "title": "Dam Crest Cut/Fill & Profile Check",
                "author_email": "glibivanov@gatheren.com.tw",
                "author_name": "Dr. Glib Ivanov",
                "active_tool": "volume",
                "camera_state": {
                    "pos": [12.5, 45.0, 18.2],
                    "target": [0.0, 2.0, -5.0],
                    "view_mode": "3d",
                },
                "measurements_state": {
                    "measure_points": [{"x": 1.0, "y": 2.0, "z": -3.0, "twd97": {"E": 304950.0, "N": 2757080.0, "H": 125.4}}],
                    "volume_points": [{"x": 0.0, "y": 1.0, "z": 0.0}, {"x": 5.0, "y": 1.2, "z": 0.0}, {"x": 5.0, "y": 1.1, "z": -5.0}],
                    "profile_points": [{"x": -4.0, "y": 1.0, "z": 2.0}, {"x": 6.0, "y": 2.5, "z": -3.0}],
                    "section_box": {"enabled": True, "minX": -25, "maxX": 25, "minY": -10, "maxY": 25, "minZ": -25, "maxZ": 25},
                },
            }
        )
        self.assertIn("bookmark_id", saved_bm)
        self.assertEqual(saved_bm["title"], "Dam Crest Cut/Fill & Profile Check")
        self.assertEqual(saved_bm["camera_state"]["view_mode"], "3d")
        self.assertEqual(len(saved_bm["measurements_state"]["volume_points"]), 3)

        bms = self.db.list_measurement_bookmarks(scan_id)
        self.assertTrue(any(b["bookmark_id"] == saved_bm["bookmark_id"] for b in bms))

        scans = self.db.list_scans()
        target_scan = [s for s in scans if s["scan_id"] == scan_id][0]
        self.assertIn("measurement_bookmarks", target_scan)
        self.assertGreaterEqual(target_scan["bookmark_count"], 1)

        deleted_bm = self.db.delete_measurement_bookmark(saved_bm["bookmark_id"], scan_id)
        self.assertTrue(deleted_bm)
        self.assertEqual(len(self.db.list_measurement_bookmarks(scan_id)), 0)

        # 4. Surface Drainage / Slope Steepness Heatmap & Runoff Flow-Lines engine
        survey = SurveyingEngine(self.db)
        drain_res = survey.compute_drainage_and_slope(
            {
                "scan_id": scan_id,
                "grid_size": 16,
                "num_droplets": 18,
                "pond_slope_threshold_deg": 2.0,
            }
        )
        self.assertEqual(drain_res["status"], "ok")
        self.assertIn("gentle_pct", drain_res)
        self.assertIn("moderate_pct", drain_res)
        self.assertIn("steep_pct", drain_res)
        self.assertIn("mean_slope_deg", drain_res)
        self.assertIn("max_slope_deg", drain_res)

        # Also test compute_drainage_and_slope when _load_or_build_scan_dsm returns a 220x220 dsm_contour / dsm_raw dict
        import numpy as np
        orig_loader = survey._load_or_build_scan_dsm
        try:
            yy, xx = np.mgrid[0:220, 0:220]
            synth_dsm = 120.0 + 0.12 * xx - 0.08 * yy
            survey._load_or_build_scan_dsm = lambda sc: {
                "dsm_raw": synth_dsm,
                "dsm_contour": synth_dsm,
                "e_min": 304900.0,
                "e_max": 305010.0,
                "n_min": 2757020.0,
                "n_max": 2757130.0,
                "h_median": 125.0,
            }
            drain_real = survey.compute_drainage_and_slope({"scan_id": scan_id, "grid_size": 16})
            self.assertEqual(drain_real["status"], "ok")
            self.assertGreater(len(drain_real["slope_cells"]), 0)
            self.assertLessEqual(len(drain_real["slope_cells"]), 16 * 16)
        finally:
            survey._load_or_build_scan_dsm = orig_loader

        # 5. Automated GCP / Check-Point Accuracy QA Report engine
        gcp_res = survey.compute_gcp_accuracy_qa(
            {
                "scan_id": scan_id,
                "tolerance_3d_m": 0.05,
                "gcps": [
                    {
                        "id": "GCP-01",
                        "e": 304950.000,
                        "n": 2757080.000,
                        "h": 125.400,
                        "mesh_e": 304950.012,
                        "mesh_n": 2757079.989,
                        "mesh_h": 125.418,
                    },
                    {
                        "id": "GCP-02",
                        "e": 304985.000,
                        "n": 2757110.000,
                        "h": 126.850,
                        "mesh_e": 304984.991,
                        "mesh_n": 2757110.014,
                        "mesh_h": 126.835,
                    },
                ],
            }
        )
        self.assertEqual(gcp_res["status"], "ok")
        self.assertEqual(gcp_res["point_count"], 2)
        self.assertLess(gcp_res["rmse_z_m"], 0.05)
        self.assertEqual(gcp_res["qa_grade"], "A")
        self.assertIn("Grade A", gcp_res["qa_grade_label"])
        self.assertTrue(gcp_res["csv_url"].startswith("/api/reports/"))
        self.assertTrue(gcp_res["html_url"].startswith("/api/reports/"))

        # Verify all frontend & backend wiring across files + JS syntax check via node --check
        import subprocess
        import shutil
        node_bin = shutil.which("node")
        if node_bin:
            js_files = [
                os.path.join(BASE_DIR, "web", "app.js"),
                os.path.join(BASE_DIR, "web", "sw.js"),
            ]
            src_dir = os.path.join(BASE_DIR, "web", "src")
            for fn in sorted(os.listdir(src_dir)):
                if fn.endswith(".js"):
                    js_files.append(os.path.join(src_dir, fn))
            for jf in js_files:
                proc = subprocess.run([node_bin, "--check", jf], capture_output=True, text=True)
                self.assertEqual(proc.returncode, 0, f"JS syntax error in {jf}: {proc.stderr}")

        with open(os.path.join(BASE_DIR, "web", "index.html"), "r", encoding="utf-8") as f:
            html = f.read()
        with open(os.path.join(BASE_DIR, "web", "sw.js"), "r", encoding="utf-8") as f:
            sw_js = f.read()
        with open(os.path.join(BASE_DIR, "web", "app.css"), "r", encoding="utf-8") as f:
            css = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "02-map-and-timeline.js"), "r", encoding="utf-8") as f:
            js02 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "03-studio-core.js"), "r", encoding="utf-8") as f:
            js03 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "05-studio-civil-inspectors.js"), "r", encoding="utf-8") as f:
            js05 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "06-studio-align-and-optimizer.js"), "r", encoding="utf-8") as f:
            js06 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "07-compare-and-queue.js"), "r", encoding="utf-8") as f:
            js07 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "08-advanced-surveying-and-qa.js"), "r", encoding="utf-8") as f:
            js08 = f.read()
        with open(os.path.join(BASE_DIR, "pc_worker", "server_api_routes.py"), "r", encoding="utf-8") as f:
            routes_py = f.read()

        self.assertIn("/src/08-advanced-surveying-and-qa.js", html)
        self.assertIn("/src/08-advanced-surveying-and-qa.js", sw_js)
        self.assertIn('id="btnMapToggleOrthoOverlay"', html)
        self.assertIn('id="btnStudioSavedViews"', html)
        self.assertIn('id="btnDockDrainage"', html)
        self.assertIn('id="btnDockGcpQa"', html)
        self.assertIn('id="btnDockBookmarks"', html)
        self.assertIn('id="btnCompareDeltaZProbe"', html)
        self.assertIn('id="btnCompareMultiProfile"', html)
        self.assertIn('id="compareProfileDrawer"', html)
        self.assertIn('id="studioPhotoFrustumOverlay"', html)
        self.assertIn("drawMapTrueOrthoOverlays", js02)
        self.assertIn("clearDrainageVisuals3D()", js03)
        self.assertIn("clearGcpQaMarkers3D()", js03)
        self.assertIn("clearRtkPhotoFrustums3D()", js03)
        self.assertIn("renderRtkPhotoFrustums3D", js05)
        self.assertIn('tool === "drainage"', js06)
        self.assertIn('tool === "gcp_qa"', js06)
        self.assertIn('tool === "bookmarks"', js06)
        self.assertIn("initCompareSurveyingTools", js07)
        self.assertIn("openDrainageAndSlopeInspector", js08)
        self.assertIn("openGcpAccuracyQaInspector", js08)
        self.assertIn("openSavedMeasurementsInspector", js08)
        self.assertIn("alignStudioCameraToRtkPhoto", js08)
        self.assertIn("clearMeasurements()", js08)
        self.assertIn("renderDistanceVisuals(null, measObj)", js08)
        self.assertIn("renderAngleVisuals(null, measObj)", js08)
        self.assertIn("renderCoordinateVisuals(pt, measObj)", js08)
        self.assertIn("renderLaserVisuals(null, measObj)", js08)
        self.assertIn("Read-only Guest cannot modify saved measurement bookmarks.", routes_py)
        self.assertIn(".gs-photo-frustum-overlay", css)
        self.assertIn(".gs-compare-profile-drawer", css)

    def test_11_timeline_wheel_scroll_and_account_language_sync(self):
        """Verify Site Timeline horizontal mouse-wheel scroll and reliable account language persistence & mirroring."""
        # 1. Saving language 'en' for glibivanov@gatheren.com.tw persists and mirrors to gleb.ivanov1999@gmail.com
        saved_s = self.db.update_user_settings(
            "glibivanov@gatheren.com.tw",
            {"language": "en", "theme_preference": "light"},
        )
        self.assertEqual(saved_s["language"], "en")
        self.assertEqual(saved_s["theme_preference"], "light")

        s_corp = self.db.get_user_settings("glibivanov@gatheren.com.tw")
        s_gmail = self.db.get_user_settings("gleb.ivanov1999@gmail.com")
        self.assertEqual(s_corp["language"], "en")
        self.assertEqual(s_gmail["language"], "en")
        self.assertEqual(s_gmail["theme_preference"], "light")

        # 2. Verify frontend wiring for wheel scroll and language hydration without guest overwrite
        with open(os.path.join(BASE_DIR, "web", "src", "02-map-and-timeline.js"), "r", encoding="utf-8") as f:
            js02 = f.read()
        with open(os.path.join(BASE_DIR, "web", "app.js"), "r", encoding="utf-8") as f:
            app_js = f.read()
        with open(os.path.join(BASE_DIR, "web", "i18n.js"), "r", encoding="utf-8") as f:
            i18n_js = f.read()
        with open(os.path.join(BASE_DIR, "server.py"), "r", encoding="utf-8") as f:
            srv_py = f.read()

        self.assertIn("bindHorizontalWheelScroll", js02)
        self.assertIn("ensureTimelineAndDockWheelScroll", js02)
        self.assertIn("scrollTargetEl.scrollLeft += delta", js02)
        self.assertIn("STATE._prefsFetchedForEmail !== targetEmail || markAuthorized", app_js)
        self.assertIn("isSignedInSettingsMatch", app_js)
        self.assertIn("window.persistLanguageToServer = persistLanguageToServer", i18n_js)
        self.assertIn('fetch("/api/user-profiles"', i18n_js)
        self.assertNotIn('fetch("/api/auth/profile"', i18n_js)
        self.assertIn('pref_em not in ("guest", "guest@anonymous", "guest@external", "guest@gatheren.cloud")', srv_py)

    def test_12_map_true_nadir_rgba_ortho_and_single_scan_per_group(self):
        """Verify true-nadir transparent RGBA orthomosaic generation, exact TWD97->WGS84 bounds, and 1-scan-per-site Map rule."""
        from PIL import Image
        import numpy as np
        from pc_worker.surveying_engine import SurveyingEngine, wgs84_to_twd97, twd97_to_wgs84

        # 1. Exact inverse GRS80 TWD97 -> WGS84 projection round-trip
        e, n = wgs84_to_twd97(25.13635757, 121.50137316)
        lat_rt, lon_rt = twd97_to_wgs84(e, n)
        self.assertAlmostEqual(lat_rt, 25.13635757, places=6)
        self.assertAlmostEqual(lon_rt, 121.50137316, places=6)

        # 2. Verify pre-generated true-nadir RGBA orthomosaic PNG + JSON bounds for QiHu merged scan
        s_eng = SurveyingEngine(self.db)
        sid = "edited_qihu_unified_merged_scan_4_scans__edited_372953"
        meta = s_eng.get_saved_ortho_meta(sid)
        self.assertIsNotNone(meta)
        self.assertGreater(meta["north_lat"], meta["south_lat"])
        self.assertGreater(meta["east_lon"], meta["west_lon"])
        self.assertTrue(os.path.isfile(meta["png_path"]))
        with Image.open(meta["png_path"]) as im:
            self.assertEqual(im.mode, "RGBA")
            arr = np.asarray(im)
            # Exterior corners must be 100% transparent (alpha == 0), while interior scan footprint has opaque pixels (alpha == 255)
            self.assertEqual(int(arr[0, 0, 3]), 0)
            self.assertTrue(bool(np.any(arr[:, :, 3] == 255)))

        # 4. Surface Drainage / Stepped 1:N Slope Arrows & Legend (Zero-Freeze)
        with open(os.path.join(BASE_DIR, "web", "src", "08-advanced-surveying-and-qa.js"), "r", encoding="utf-8") as f:
            js08 = f.read()
        self.assertIn("SLOPE_STEPPED_TIERS", js08)
        self.assertIn("buildFastStudioSurfaceArrows", js08)
        self.assertIn("updateStudioDrainageLegendHud", js08)
        self.assertIn("1:200 – 1:100", js08)
        self.assertIn("1:100 – 1:50", js08)
        self.assertIn("1:50 – 1:20", js08)
        # Ensure renderDrainageAndSlopeVisuals3D NEVER calls sampleStudioMeshElevationAtLocalXZ or fake sine waves
        self.assertNotIn("0.35 * Math.sin(x * 0.14)", js08)

        # 5. True-Nadir Ortho & Single-Scan-per-Site Map Rule
        with open(os.path.join(BASE_DIR, "web", "src", "02-map-and-timeline.js"), "r", encoding="utf-8") as f:
            js02 = f.read()
        self.assertIn("pickRepresentativeOrthoScanForGroup", js08)
        self.assertIn("mapInst.projectLatLon(Number(bounds.north_lat), Number(bounds.west_lon))", js08)
        self.assertIn("mapInst.projectLatLon(Number(bounds.south_lat), Number(bounds.east_lon))", js08)
        self.assertNotIn("scan.thumbnail_url || `/api/scans/${encodeURIComponent(sid)}/thumbnail`", js08)
        self.assertNotIn("ctx.strokeRect(x0, y0, boxW, boxH)", js08)
        self.assertIn("gsMap.drawMap()", js02)

    def test_13_comment_pins_labels_bright_theme_avatar_and_concise_buttons(self):
        """Verify all 5 comment pin, labels toggle, bright theme, author avatar, and concise button fixes."""
        with open(os.path.join(BASE_DIR, "web", "index.html"), "r", encoding="utf-8") as f:
            html = f.read()
        with open(os.path.join(BASE_DIR, "web", "app.css"), "r", encoding="utf-8") as f:
            css = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "03-studio-core.js"), "r", encoding="utf-8") as f:
            js03 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "05-studio-civil-inspectors.js"), "r", encoding="utf-8") as f:
            js05 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "08-advanced-surveying-and-qa.js"), "r", encoding="utf-8") as f:
            js08 = f.read()

        # 1. Comment pins decoupled from categorizeLabelsVisible (controlled by folder visibility STATE.hiddenCommentFolders) & #btnStudioToggleCategorizeLabels always visible
        self.assertIn("if (b.isCommentPin) {\n        if (b.folderKey && STATE.hiddenCommentFolders && STATE.hiddenCommentFolders[b.folderKey]) {", js03)
        self.assertIn('topLblBtn.style.display = "inline-flex";', js05)
        self.assertIn("studioThree.commentPinsGroup.visible = true;", js05)

        # 2. Bright/light theme support for .gs-comment-pin-popover
        self.assertIn('html[data-theme="light"] .gs-comment-pin-popover', css)
        self.assertIn("body.theme-light .gs-comment-pin-popover", css)
        self.assertIn('html[data-theme="light"] .gs-comment-pin-author', css)
        self.assertIn('html[data-theme="light"] .gs-comment-pin-text', css)

        # 3. No native browser title attribute on .gs-comment-pin-icon or .gs-scan-comment-pin (eliminates double hover tooltip)
        self.assertNotIn('class="gs-comment-pin-icon" title=', js05)
        self.assertNotIn('class="gs-scan-comment-pin" data-comment-pin-id="${cid}" title=', js05)

        # 4. Circular character avatar of comment author inside comment pin and comment card
        self.assertIn("function getCommentAuthorAvatar(", js05)
        self.assertIn("gs-comment-pin-avatar-char", js05)
        self.assertIn("gs-comment-card-avatar", js05)
        self.assertIn(".gs-comment-pin-avatar-char", css)

        # 5. Concise 1-word / icon-only buttons
        self.assertNotIn("重新命名工區</span>", html)
        self.assertNotIn("正射影像疊圖</span>", html)
        self.assertIn('${tr("載入", "Load")}', js08)
        self.assertIn('${tr("💾 儲存", "💾 Save")}', js08)

    def test_14_drainage_arrow_scale_void_filtering_qihu_water_and_photo_comment_attachments(self):
        """Verify 1/5 drainage arrow default size + sliders, strict void/water filtering, QiHu water void classification, and RTK photo enlarge/download/drag-to-comment attachment."""
        import json

        with open(os.path.join(BASE_DIR, "web", "src", "05-studio-civil-inspectors.js"), "r", encoding="utf-8") as f:
            js05 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "08-advanced-surveying-and-qa.js"), "r", encoding="utf-8") as f:
            js08 = f.read()

        # 1. Drainage arrows default to 1/5 (0.20x) size (`0.85 * tier.lenScale * arrowScale`, `0.055 * arrowScale`, `0.135 * arrowScale`) + Density & Arrow Size sliders
        self.assertIn("const len = 0.85 * tier.lenScale * arrowScale;", js08)
        self.assertIn("const shaftHalfW = Math.max(0.02, 0.055 * arrowScale);", js08)
        self.assertIn("const headHalfW = Math.max(0.045, 0.135 * arrowScale);", js08)
        self.assertIn('id="rngDrainageDensity"', js08)
        self.assertIn('id="rngDrainageArrowSize"', js08)

        # 2. Drainage arrows strictly filter out un-scanned empty voids & water polygons (no extrapolation into empty cells)
        self.assertIn("isFineSurfaceOccupied", js08)
        self.assertIn("isPointInsideAnyWaterPolyXZ", js08)
        self.assertNotIn("if (validCell[idx] || nCnt >= 5)", js08)
        self.assertIn("if (!validCell[idx]) continue;", js08)

        # 3. QiHu unified merged scan classifies depressed moat/pond empty area as water (`unmodelled_void_shoreline`) with zero regressions on Rose Park, NTU Dorm, and QuChi
        qihu_cache_path = os.path.join(
            BASE_DIR,
            "data",
            "categorization_cache",
            "edited_qihu_unified_merged_scan_4_scans__edited_372953_categorization_v3.json",
        )
        self.assertTrue(os.path.isfile(qihu_cache_path))
        with open(qihu_cache_path, "r", encoding="utf-8") as f:
            qihu_cat = json.load(f)
        self.assertGreaterEqual(int(qihu_cat.get("summary", {}).get("water_count", 0)), 2)
        self.assertGreaterEqual(float(qihu_cat.get("summary", {}).get("water_planar_area_m2", 0.0)), 1400.0)
        qihu_modes = [w.get("detection_mode") for w in qihu_cat.get("water_bodies", [])]
        self.assertIn("unmodelled_void_shoreline", qihu_modes)

        for zero_water_sid in ("rosepark_20260918_merged", "ntudorm_20260915_baseline"):
            p = os.path.join(BASE_DIR, "data", "categorization_cache", f"{zero_water_sid}_categorization_v3.json")
            with open(p, "r", encoding="utf-8") as f:
                cat = json.load(f)
            self.assertEqual(int(cat.get("summary", {}).get("water_count", 0)), 0)

        quchi_path = os.path.join(BASE_DIR, "data", "categorization_cache", "QuChi261016_Trees_categorization_v3.json")
        with open(quchi_path, "r", encoding="utf-8") as f:
            quchi_cat = json.load(f)
        self.assertGreaterEqual(int(quchi_cat.get("summary", {}).get("water_count", 0)), 1)

        # 4. RTK Photo Inspector replaces Match Photo View with Enlarge, Download, and Drag-and-Drop onto Comments (including multi-photo attachment)
        self.assertNotIn("Match Photo View", js05)
        self.assertNotIn("Project 55%", js05)
        self.assertIn("data-photo-enlarge-idx", js05)
        self.assertIn("data-rtk-photo-check", js05)
        self.assertIn("openPhotoLightboxModal", js08)
        self.assertIn("attachPhotosToCommentById", js08)

        # Verify backend comment DB supports attaching multiple photos (`photos` / `append_photos`) and preserves RTK coordinates
        created = self.db.add_comment(
            {
                "scan_id": "ntudorm_20260915_baseline",
                "author_email": "tester@gatheren.cloud",
                "author_name": "Photo Attachment Tester",
                "text": "Initial field comment",
                "pos_x": 1.0,
                "pos_y": 2.0,
                "pos_z": 3.0,
                "twd97_e": 304125.0,
                "twd97_n": 2767820.0,
                "twd97_h": 18.5,
                "photos": [
                    {
                        "id": "P1",
                        "filename": "DJI_0001.JPG",
                        "url": "/api/survey/photo-preview?scan_id=test&idx=0",
                        "camera_twd97_e": 304120.5,
                        "camera_twd97_n": 2767815.2,
                        "camera_twd97_h": 35.8,
                        "distance_m": 18.4,
                    }
                ],
            }
        )
        cid = created["comment_id"]
        c_rec = self.db.get_comment(cid)
        self.assertIsNotNone(c_rec)
        self.assertEqual(len(c_rec.get("photos", [])), 1)
        self.assertAlmostEqual(float(c_rec["photos"][0].get("camera_twd97_e", 0.0)), 304120.5, places=1)
        self.assertAlmostEqual(float(c_rec["photos"][0].get("camera_twd97_h", 0.0)), 35.8, places=1)

        updated = self.db.update_comment(
            cid,
            append_photos=[
                {"id": "P2", "filename": "DJI_0002.JPG", "url": "/api/survey/photo-preview?scan_id=test&idx=1"},
                {"id": "P3", "filename": "DJI_0003.JPG", "url": "/api/survey/photo-preview?scan_id=test&idx=2"},
            ],
        )
        self.assertIsNotNone(updated)
        self.assertEqual(len(updated.get("photos", [])), 3)
        self.db.delete_comment(cid)

    def test_15_tool_dblclick_esc_vertex_move_point_snap_bright_tooltips_and_gdrive_comment_photo(self):
        """Verify v155 features: (1) Tool dblclick = ESC, (2) Dblclick vertex to move measurement/area/coord/angle points,
        (3) Snapping to existing measurement/area/coord/angle points, (4) Bright-theme tooltips/HUD/azimuth pills,
        (5) Uploading new local/gallery photo to a comment saved on Google Drive (gdrive)."""
        import base64
        from pc_worker.gdrive_cloud_sync import save_and_sync_comment_photo_to_gdrive

        with open(os.path.join(BASE_DIR, "web", "src", "01-core-state.js"), "r", encoding="utf-8") as f:
            js01 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "03-studio-core.js"), "r", encoding="utf-8") as f:
            js03 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "04-studio-lasso-and-edits.js"), "r", encoding="utf-8") as f:
            js04 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "05-studio-civil-inspectors.js"), "r", encoding="utf-8") as f:
            js05 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "06-studio-align-and-optimizer.js"), "r", encoding="utf-8") as f:
            js06 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "08-advanced-surveying-and-qa.js"), "r", encoding="utf-8") as f:
            js08 = f.read()
        with open(os.path.join(BASE_DIR, "web", "app.css"), "r", encoding="utf-8") as f:
            app_css = f.read()
        with open(os.path.join(BASE_DIR, "pc_worker", "server_api_routes.py"), "r", encoding="utf-8") as f:
            routes_py = f.read()
        with open(os.path.join(BASE_DIR, "server.py"), "r", encoding="utf-8") as f:
            server_py = f.read()

        # 1. Double-clicking on a selected tool button = pressing ESC (with 280ms debounce & Click #1 state preservation)
        self.assertIn("function triggerStudioEscapeAction(", js06)
        self.assertIn("window.triggerStudioEscapeAction = triggerStudioEscapeAction;", js06)
        self.assertIn('btn.addEventListener("dblclick"', js06)
        self.assertIn("nowMs - _lastToolBtnClick.ts <= 420", js06)
        self.assertIn("_lastDockEscapeTriggeredMs", js06)

        # 2. Double-clicking an existing measurement, area, coordinate, or angle point allows moving it
        self.assertIn("movingVertex: null", js01)
        self.assertIn("function findNearestEditableVertexAtScreenXY(", js03)
        self.assertIn("function startStudioVertexMove(", js03)
        self.assertIn("function updateStudioVertexMove(", js03)
        self.assertIn("function commitStudioVertexMove(", js03)
        self.assertIn("function cancelStudioVertexMove(", js03)
        self.assertIn("function rebuildAllCompletedMeasurements3D(", js03)
        self.assertIn("c === studioThree.drainageGroup", js03)
        self.assertIn('document.getElementById("studioCanvasContainer")?.addEventListener("dblclick"', js04)
        self.assertIn("commitStudioVertexMove(moveHit ? moveHit.point : null)", js04)

        # 3. Snapping (STATE.snapEnabled) snaps to existing measurement, area, coordinate, and angle points
        self.assertIn("function getAllSnappableToolVertices(", js03)
        self.assertIn("function findNearestSnappableToolVertex(", js03)
        self.assertIn("snappedToToolVertex: true", js03)
        self.assertIn("function updateStudioSnapIndicator(", js03)

        # 4. Bright theme ([data-theme="light"]) for tooltips, azimuth pills, floating draw HUD, slope sprites, and Compare ΔZ probe
        self.assertIn('html[data-theme="light"] .gs-mobile-tool-hud', app_css)
        self.assertIn('html[data-theme="light"] .autodesk-azimuth-badge', app_css)
        self.assertIn('html[data-theme="light"] .autodesk-coord-badge', app_css)
        self.assertIn('html[data-theme="light"] .laser-bubble-w', app_css)
        self.assertIn('html[data-theme="light"] .laser-bubble-slope', app_css)
        self.assertIn('document.documentElement.getAttribute("data-theme") === "light"', js08)
        self.assertNotIn("title=", [line for line in js05.splitlines() if "gs-scan-comment-pin" in line or "gs-comment-pin-icon" in line][0] if any("gs-scan-comment-pin" in line for line in js05.splitlines()) else "")

        # 5. Upload a new photo (drag-and-drop on PC; gallery on mobile) to a comment, saved on Google Drive (gdrive)
        self.assertIn('if path in ("/api/comments/upload-photo", "/api/comments/upload_photo"):', routes_py)
        self.assertIn('path.startswith("/api/comments/photo/")', server_py)
        self.assertIn("async function uploadLocalFilesToComment(", js05)
        self.assertIn("function triggerCommentPhotoFilePicker(", js05)
        self.assertIn("btnUploadDraftCommentPhoto", js05)
        self.assertIn("data-comment-upload-photo", js05)
        self.assertIn("data-pin-upload-photo", js05)

        # End-to-end test of save_and_sync_comment_photo_to_gdrive + ScanQueueDB gdrive metadata persistence
        png_1x1 = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ZkAAAAASUVORK5CYII="
        )
        photo_obj = save_and_sync_comment_photo_to_gdrive(
            scan_id="ntudorm_20260915_baseline",
            filename="field_defect_mobile.png",
            raw_bytes=png_1x1,
            content_type="image/png",
            camera_meta={"camera_twd97_e": 304128.4, "camera_twd97_n": 2767822.1, "camera_twd97_h": 19.2},
        )
        self.assertEqual(photo_obj.get("storage"), "gdrive")
        self.assertTrue(photo_obj.get("gdrive_synced"))
        self.assertTrue(photo_obj.get("url", "").startswith("/api/comments/photo/ntudorm_20260915_baseline/"))
        self.assertGreater(int(photo_obj.get("size_bytes", 0)), 0)

        saved_c = self.db.add_comment(
            {
                "scan_id": "ntudorm_20260915_baseline",
                "author_email": "field@gatheren.cloud",
                "author_name": "Mobile Field Engineer",
                "text": "Uploaded field inspection photo to GDrive",
                "pos_x": 2.5,
                "pos_y": 1.2,
                "pos_z": -3.4,
                "photos": [photo_obj],
            }
        )
        cid = saved_c["comment_id"]
        fetched_c = self.db.get_comment(cid)
        self.assertIsNotNone(fetched_c)
        self.assertEqual(len(fetched_c.get("photos", [])), 1)
        p0 = fetched_c["photos"][0]
        self.assertEqual(p0.get("storage"), "gdrive")
        self.assertTrue(p0.get("gdrive_synced"))
        self.assertEqual(p0.get("source"), "comment_upload")
        self.assertEqual(p0.get("mime_type"), "image/png")
        self.db.delete_comment(cid)

        # Clean up test photo files created on disk
        for root_dir in ("comment_photos", "gdrive_comment_photos"):
            cand = os.path.join(BASE_DIR, "data", root_dir, "ntudorm_20260915_baseline", os.path.basename(photo_obj["url"]))
            if os.path.isfile(cand):
                try:
                    os.remove(cand)
                except OSError:
                    pass
        g_cand = photo_obj.get("gdrive_path") or ""
        if g_cand and os.path.isfile(g_cand):
            try:
                os.remove(g_cand)
            except OSError:
                pass

    def test_16_photo_zoom_sidebar_merged_rtk_photos_auto_ortho_section_gizmos_and_mesh_drainage_density(self):
        """Verify v157 features: (1) 1x-25x photo lightbox zoom with vertical zoom sidebar, (2) Merged/edited scan RTK photo spatial matching + pin cleanup,
        (3) Hidden manual Ortho capture buttons, auto ortho regen, map zoom 23, and clean dropdown labels, (4) Interactive 3D section box gizmos & yaw rotation,
        (5) Mesh triangle rasterization for drainage arrows (including InterleavedBufferAttribute) + arrows/m2 density slider decoupled from arrow length."""
        from pc_worker.surveying_engine import SurveyingEngine

        with open(os.path.join(BASE_DIR, "web", "index.html"), "r", encoding="utf-8") as f:
            html = f.read()
        with open(os.path.join(BASE_DIR, "web", "app.css"), "r", encoding="utf-8") as f:
            app_css = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "01-core-state.js"), "r", encoding="utf-8") as f:
            js01 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "02-map-and-timeline.js"), "r", encoding="utf-8") as f:
            js02 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "03-studio-core.js"), "r", encoding="utf-8") as f:
            js03 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "04-studio-lasso-and-edits.js"), "r", encoding="utf-8") as f:
            js04 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "05-studio-civil-inspectors.js"), "r", encoding="utf-8") as f:
            js05 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "08-advanced-surveying-and-qa.js"), "r", encoding="utf-8") as f:
            js08 = f.read()
        with open(os.path.join(BASE_DIR, "pc_worker", "surveying", "contours_and_cad.py"), "r", encoding="utf-8") as f:
            cad_py = f.read()
        with open(os.path.join(BASE_DIR, "pc_worker", "server_api_routes.py"), "r", encoding="utf-8") as f:
            routes_py = f.read()

        # 1. Requirement 1: 1x-25x Zoom & Vertical Zoom Sidebar in Picture View Mode (openPhotoLightboxModal)
        self.assertIn("Math.max(1.0, Math.min(25.0, Number(nextZoom) || 1.0))", js08)
        self.assertIn('id="photoLightboxZoomSidebar"', js08)
        self.assertIn('id="btnPhotoZoomIn"', js08)
        self.assertIn('id="rngPhotoLightboxZoom"', js08)
        self.assertIn('min="1" max="25" step="0.1"', js08)
        self.assertIn('id="btnPhotoZoomOut"', js08)
        self.assertIn('id="lblPhotoLightboxZoom"', js08)
        self.assertIn('id="btnPhotoZoomReset"', js08)
        self.assertIn(".gs-photo-zoom-sidebar", app_css)

        # 2. Requirement 2: Merged/Edited Scan RTK Photos + Photo Target Pin Cleanup
        self.assertIn("_cameras_cache_v4.json", cad_py)
        self.assertIn("merged_from", cad_py)
        self.assertIn("derived_from_scan_id", cad_py)
        self.assertIn("r_zup_rowmajor", cad_py)
        self.assertIn("function clearPhotoTargetVisuals3D()", js08)
        self.assertIn("m.userData.isPhotoTargetPin = true;", js04)
        self.assertIn("openRtkPhotoInspector(pt, true);", js04)
        self.assertIn("if (!pt)", js05)
        self.assertIn('if (STATE.activeTool === "photos" && toolName !== "photos" && typeof clearPhotoTargetVisuals3D === "function")', js03)

        eng = SurveyingEngine(os.path.join(BASE_DIR, "scans"))
        qihu_dir = os.path.join(BASE_DIR, "scans", "edited_qihu_unified_merged_scan_4_scans__edited_372953")
        if os.path.isdir(qihu_dir):
            r_west = eng.query_cameras_for_point("edited_qihu_unified_merged_scan_4_scans__edited_372953", 300525.0, 2780995.0, 12.0, top_k=4)
            r_east = eng.query_cameras_for_point("edited_qihu_unified_merged_scan_4_scans__edited_372953", 300590.0, 2780950.0, 12.0, top_k=4)
            west_files = [m["filename"] for m in r_west.get("matched_photos", [])]
            east_files = [m["filename"] for m in r_east.get("matched_photos", [])]
            self.assertGreater(len(west_files), 0)
            self.assertGreater(len(east_files), 0)
            self.assertNotEqual(west_files, east_files)

        # 3. Requirement 3: Hidden Ortho Capture Buttons, Auto Ortho Regen, Map Zoom 23, Clean Dropdown Names
        self.assertIn('id="btnCaptureNadirOrtho"', html)
        self.assertIn('id="btnStudioCaptureOrtho"', html)
        self.assertIn('id="btnMapToggleOrthoOverlay"', html)
        for btn_id in ("btnCaptureNadirOrtho", "btnStudioCaptureOrtho", "btnMapToggleOrthoOverlay"):
            idx = html.find(f'id="{btn_id}"')
            self.assertGreater(idx, 0)
            snippet = html[max(0, idx - 180) : idx + 260]
            self.assertIn("display:none !important", snippet)
        self.assertNotIn("localStorage.getItem('gs_nadir_ortho_v2_' + sid)", js08)
        self.assertIn("def _trigger_auto_ortho_regen(target_sid: Optional[str]):", routes_py)
        self.assertIn("Math.max(2.0, Math.min(23.0, nextZoom))", js02)
        self.assertIn("Math.min(23.0, gsMap.zoom + 0.75)", js02)
        self.assertIn("const zInt = Math.max(2, Math.min(19, Math.floor(gsMap.zoom)));", js02)
        self.assertIn("formatGroupDisplayName(grp.project_group, grp.project_name_zh)", js01)
        self.assertIn("opt.textContent = s.name;", js01)
        self.assertNotIn("`${s.name} (${s.scan_date})`", js01)

        # 4. Requirement 4: Interactive 3D Section Box Gizmos (Move, Resize Faces, Rotate Yaw)
        self.assertIn("sectionBoxState:", js01)
        self.assertIn("function rebuildSectionBox3DGizmos()", js05)
        self.assertIn("function applySectionBoxStateToClippingAndUI(", js05)
        self.assertIn("function handleSectionBoxGizmoPointerDown(", js05)
        self.assertIn("function handleSectionBoxGizmoPointerMove(", js05)
        self.assertIn("function handleSectionBoxGizmoPointerUp(", js05)
        self.assertIn('id="secClipYaw"', js05)
        self.assertIn("setFromNormalAndCoplanarPoint", js05)
        self.assertIn("handleSectionBoxGizmoPointerDown(e)", js03)
        self.assertIn("c === studioThree.sectionBoxGizmoGroup", js03)
        self.assertIn("c.userData?.isPhotoTargetPin", js03)
        self.assertIn("c.userData?.isSectionTempPin", js03)
        self.assertIn("m.userData.isSectionTempPin = true;", js04)
        self.assertIn("if ((p1 && p2) || !st.active) {\n      st.active = true;", js05)

        # 5. Requirement 5: Drainage Mesh Triangle Rasterization (InterleavedBufferAttribute safe) + Density (arrows/m2) vs Length Sliders
        self.assertIn("pos.getX(i)", js08)
        self.assertIn("idxAttr.getX(ti * 3 + 2)", js08)
        self.assertNotIn("pos.array[i * itemSize]", js08)
        self.assertIn("drainageDensityPerM2: 0.25", js01)
        self.assertIn('min="0.04" max="2.00" step="0.02"', js08)
        self.assertIn('/ m²', js08)
        self.assertIn("const len = 0.85 * tier.lenScale * arrowScale;", js08)

    def test_17_pix4dmatic_calibrated_cameras_frustums_and_subscan_photo_resolution(self):
        """Verify Loop 1: Pix4Dmatic calibrated camera extraction (_cameras_cache_v6.json), canonical upright basis,
        FOV pinhole photo selection + 2D target reticle (proj_u, proj_v), sub-scan photo collision fix, and 3D trajectory."""
        import json
        from pc_worker.surveying_engine import SurveyingEngine

        s_eng = SurveyingEngine(self.db)
        qihu_sid = "edited_qihu_unified_merged_scan_4_scans__edited_372953"
        cam_res = s_eng.get_scan_cameras_response(qihu_sid, limit=10000, fmt="json")
        self.assertEqual(cam_res.get("status"), "ok")
        self.assertEqual(int(cam_res.get("total_cameras", 0)), 6000)
        sub_scans = cam_res.get("sub_scans") or {}
        self.assertEqual(len(sub_scans), 4)
        for k, cnt in sub_scans.items():
            self.assertEqual(int(cnt), 1500)

        c0 = cam_res["cameras"][0]
        self.assertTrue(c0.get("calibrated"))
        self.assertEqual(c0.get("pose_source"), "pix4dmatic_p4m")
        self.assertEqual(len(c0.get("right", [])), 3)
        self.assertEqual(len(c0.get("down", [])), 3)
        self.assertEqual(len(c0.get("forward", [])), 3)
        # Upright camera down vector points toward -Z (gravity)
        self.assertLess(float(c0["down"][2]), -0.2)

        csv_str = s_eng.get_scan_cameras_response(qihu_sid, fmt="csv")
        self.assertTrue(isinstance(csv_str, str) and "twd97_e,twd97_n,twd2001_h" in csv_str)

        # Verify FOV photo selection on west vs east side of unified QiHu
        west_res = s_eng.inspect_rtk_camera_photos(
            {"scan_id": qihu_sid, "twd_e": 300519.0, "twd_n": 2781009.0, "twd_h": 13.6}
        )
        east_res = s_eng.inspect_rtk_camera_photos(
            {"scan_id": qihu_sid, "twd_e": 300583.0, "twd_n": 2780947.0, "twd_h": 9.3}
        )
        self.assertGreater(len(west_res.get("photos", [])), 0)
        self.assertGreater(len(east_res.get("photos", [])), 0)
        wp0 = west_res["photos"][0]
        ep0 = east_res["photos"][0]
        self.assertTrue(wp0.get("in_fov"))
        self.assertTrue(ep0.get("in_fov"))
        self.assertTrue(wp0.get("calibrated"))
        self.assertTrue(ep0.get("calibrated"))
        self.assertTrue(0.02 <= float(wp0.get("proj_u", 0.5)) <= 0.98)
        self.assertTrue(0.02 <= float(wp0.get("proj_v", 0.5)) <= 0.98)
        self.assertIn("QiHuTender_1", wp0["filename"])
        self.assertIn("QiHuTender_4", ep0["filename"])

        # Verify user screenshot coordinates on QiHu unified and NTU Dorm (260917 & 260915) + orthometric TWVD2001 heights (~1.4m-1.7m above ground, NOT +30m ellipsoidal)
        for cache_sid, expected_ground_h_min, expected_ground_h_max in (
            ("edited_qihu_unified_merged_scan_4_scans__edited_372953", 6.0, 22.0),
            ("ntudorm_20260917_foundation", 10.0, 26.0),
            ("ntudorm_20260915_baseline", 10.0, 26.0),
            ("rosepark_20260918_merged", 4.0, 24.0),
            ("QuChi261016_Trees", 35.0, 58.0),
        ):
            cache_fp = os.path.join(BASE_DIR, "data", "cameras_cache", f"{cache_sid}_cameras_v6.json")
            self.assertTrue(os.path.isfile(cache_fp), f"Missing camera cache: {cache_fp}")
            with open(cache_fp, "r", encoding="utf-8") as cf:
                cams_cached = json.load(cf)
            self.assertGreater(len(cams_cached), 50)
            med_cam_h = sorted(float(c["h"]) for c in cams_cached)[len(cams_cached) // 2]
            self.assertTrue(
                expected_ground_h_min <= med_cam_h <= expected_ground_h_max,
                f"{cache_sid} median cam_h={med_cam_h} outside orthometric TWVD2001 range [{expected_ground_h_min}, {expected_ground_h_max}]",
            )

        ntu_res = s_eng.inspect_rtk_camera_photos(
            {"scan_id": "ntudorm_20260917_foundation", "twd_e": 303025.0, "twd_n": 2770015.0, "twd_h": 8.6}
        )
        self.assertGreater(len(ntu_res.get("photos", [])), 0)
        np0 = ntu_res["photos"][0]
        self.assertTrue(np0.get("in_fov"))
        self.assertTrue(np0.get("calibrated"))
        self.assertTrue(0.02 <= float(np0.get("proj_u", 0.5)) <= 0.98)
        self.assertTrue(0.02 <= float(np0.get("proj_v", 0.5)) <= 0.98)
        # Camera height at NTU Dorm (~10.0m-10.3m TWVD2001) is ~1.4m-1.8m above the 8.6m ground target, NEVER +40m ellipsoidal
        self.assertTrue(0.8 <= (float(np0["camera_twd97_h"]) - 8.6) <= 3.0)

        # Verify sub-scan photo resolution never collides between catch_QiHuTender_1 and catch_QiHuTender_4
        p1 = s_eng.resolve_camera_photo_path(qihu_sid, "catch_QiHuTender_1/Image_001068.jpg")
        p4 = s_eng.resolve_camera_photo_path(qihu_sid, "catch_QiHuTender_4/Image_001068.jpg")
        if p1 and p4:
            self.assertNotEqual(os.path.normcase(p1), os.path.normcase(p4))
            self.assertIn("qihutender_1", p1.lower())
            self.assertIn("qihutender_4", p4.lower())

        # Verify Loop 2 fixes: (1) VPS tunnel cacheability for /api/survey/cameras and /api/camera-photo,
        # (2) proj_u / proj_v / target_uv persistence on comment photos in ScanQueueDB,
        # (3) hasTargetReticle guard and one-click [data-photo-attach-comment-idx] button in 08-advanced-surveying-and-qa.js
        with open(os.path.join(BASE_DIR, "pc_worker", "server_cloud_and_tunnel.py"), "r", encoding="utf-8") as f:
            tunnel_py = f.read()
        self.assertIn('path.startswith("/api/survey/cameras")', tunnel_py)
        self.assertIn('path in ("/api/camera-photo", "/api/photo-file")', tunnel_py)

        cmt_reticle = self.db.add_comment(
            {
                "scan_id": qihu_sid,
                "author_email": "qa@gatheren.cloud",
                "author_name": "Loop 3 QA",
                "text": "Reticle UV persistence check",
                "pos_x": 0.0,
                "pos_y": 0.0,
                "pos_z": 0.0,
                "twd97_e": 300583.0,
                "twd97_n": 2780947.0,
                "twd97_h": 9.3,
                "photos": [
                    {
                        "id": ep0["filename"],
                        "filename": ep0["filename"],
                        "url": ep0["url"],
                        "camera_twd97_e": ep0["camera_twd97_e"],
                        "camera_twd97_n": ep0["camera_twd97_n"],
                        "camera_twd97_h": ep0["camera_twd97_h"],
                        "proj_u": ep0["proj_u"],
                        "proj_v": ep0["proj_v"],
                        "target_uv": {"u": ep0["proj_u"], "v": ep0["proj_v"], "in_fov": True},
                    }
                ],
            }
        )
        saved_ret = self.db.get_comment(cmt_reticle["comment_id"])
        self.assertIsNotNone(saved_ret)
        sp0 = saved_ret["photos"][0]
        self.assertAlmostEqual(float(sp0["proj_u"]), float(ep0["proj_u"]), places=4)
        self.assertAlmostEqual(float(sp0["proj_v"]), float(ep0["proj_v"]), places=4)
        self.assertIsInstance(sp0.get("target_uv"), dict)
        self.assertAlmostEqual(float(sp0["target_uv"]["u"]), float(ep0["proj_u"]), places=4)
        self.assertTrue(sp0["target_uv"]["in_fov"])
        self.db.delete_comment(cmt_reticle["comment_id"])

        with open(os.path.join(BASE_DIR, "web", "src", "08-advanced-surveying-and-qa.js"), "r", encoding="utf-8") as f:
            js08 = f.read()
        self.assertIn("function _projectWorldPointToPhotoUV(", js08)
        self.assertIn("function _serializeRtkPhotoForComment(", js08)
        self.assertIn("const hasTargetReticle = Boolean(", js08)
        self.assertIn("data-photo-attach-comment-idx", js08)
        self.assertIn("function loadAndRenderScanCameraTrajectory3D(", js08)
        self.assertIn("function pickCameraTrajectoryMarkerAtScreenXY(", js08)
        self.assertIn("function selectCalibratedCameraFrom3D(", js08)
        self.assertIn("window.renderPhoto3DFrustums = renderRtkPhotoFrustums3D;", js08)
        self.assertIn("STATE.targetAttachCommentId", js08)

        # Verify author/admin comment edit permission & 3D pin location photo selector
        from pc_worker.server_api_routes import ServerWriteRoutesMixin

        sample_cmt = {"author_email": "alice@gatheren.com.tw", "author_name": "Alice"}
        self.assertTrue(ServerWriteRoutesMixin._can_actor_modify_comment(sample_cmt, "alice@gatheren.com.tw", "viewer", {}))
        self.assertFalse(ServerWriteRoutesMixin._can_actor_modify_comment(sample_cmt, "bob@gatheren.com.tw", "editor", {}))
        self.assertTrue(ServerWriteRoutesMixin._can_actor_modify_comment(sample_cmt, "admin@gatheren.com.tw", "admin", {}))
        self.assertTrue(ServerWriteRoutesMixin._can_actor_modify_comment(sample_cmt, "glibivanov@gatheren.com.tw", "owner", {}))
        ext_cmt = {"author_email": "external@gatheren.cloud", "author_name": "Reviewer Wang"}
        self.assertTrue(
            ServerWriteRoutesMixin._can_actor_modify_comment(
                ext_cmt, "external@gatheren.cloud", "guest", {"author_name": "Reviewer Wang"}
            )
        )
        self.assertFalse(
            ServerWriteRoutesMixin._can_actor_modify_comment(
                ext_cmt, "external@gatheren.cloud", "guest", {"author_name": "Other Guest"}
            )
        )

        with open(os.path.join(BASE_DIR, "web", "src", "01-core-state.js"), "r", encoding="utf-8") as f:
            js01_chk = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "05-studio-civil-inspectors.js"), "r", encoding="utf-8") as f:
            js05_chk = f.read()
        with open(os.path.join(BASE_DIR, "web", "app.css"), "r", encoding="utf-8") as f:
            css_chk = f.read()
        self.assertIn("function canUserEditComment(", js01_chk)
        self.assertIn("window.renderCommentPins3D()", js01_chk)
        self.assertIn("function openLocationPhotosForComment(", js05_chk)
        self.assertIn("cmtPt._explicitTwd = cmtTwd;", js05_chk)
        self.assertIn("window.renderCommentPins3D = renderCommentPins3D;", js05_chk)
        self.assertIn("pt._explicitTwd", js08)
        self.assertIn(".gs-comment-pin-popover::before", css_chk)
        self.assertIn(".gs-comment-pin-popover:hover", css_chk)
        self.assertIn(".gs-comment-pin-close-btn", css_chk)
        self.assertIn("data-pin-close", js05_chk)
        self.assertIn("pointer-events: auto !important;", css_chk)

    def test_18_six_v162_features_upload_spinner_lightbox_theme_comment_folders_camera_hide_occlusion_and_auto_classify(self):
        """Verify all 6 v162 features:
        1. Immediate upload placeholder square (.gs-photo-upload-placeholder + .gs-upload-spinner-ring)
        2. Bright / Light Theme for Image Zoom Window (openPhotoLightboxModal)
        3. Comment Folders CRUD + Dragging Notes & Photos Between Folders + Folder Visibility Toggle + Icon-only controls
        4. Hide 3D camera objects when Photos menu is closed
        5. Depth occlusion for slope arrows, comment pins, and 2D badges behind scan geometry
        6. Auto-show classification when Classify tab opens & auto-hide when closed (decoupled from comment pins)
        """
        with open(os.path.join(BASE_DIR, "web", "src", "03-studio-core.js"), "r", encoding="utf-8") as f:
            js03 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "05-studio-civil-inspectors.js"), "r", encoding="utf-8") as f:
            js05 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "08-advanced-surveying-and-qa.js"), "r", encoding="utf-8") as f:
            js08 = f.read()
        with open(os.path.join(BASE_DIR, "web", "app.css"), "r", encoding="utf-8") as f:
            app_css = f.read()

        # Feature 1: Immediate upload placeholder square & spinner
        self.assertIn("gs-photo-upload-placeholder", js05)
        self.assertIn("gs-upload-spinner-ring", js05)
        self.assertIn(".gs-photo-upload-placeholder", app_css)
        self.assertIn(".gs-upload-spinner-ring", app_css)
        self.assertIn("@keyframes gsSpin", app_css)

        # Feature 2: Bright / Light Theme for Image Zoom Window
        self.assertIn("gs-lightbox-backdrop", js08)
        self.assertIn("gs-lightbox-card", js08)
        self.assertIn("gs-lightbox-header", js08)
        self.assertIn("gs-lightbox-stage", js08)
        self.assertIn('html[data-theme="light"] .gs-lightbox-card', app_css)
        self.assertIn('html[data-theme="light"] .gs-lightbox-stage', app_css)

        # Feature 3: Comment Folders CRUD + Photo Move in ScanQueueDB & UI
        sid = "ntudorm_20260915_baseline"
        folders_after_create = self.db.create_comment_folder(sid, "Structural Cracks")
        self.assertIn("Structural Cracks", folders_after_create)

        c1 = self.db.add_comment(
            {
                "scan_id": sid,
                "author_email": "eng@gatheren.cloud",
                "author_name": "Engineer A",
                "text": "North wall crack",
                "folder": "Structural Cracks",
                "pos_x": 1.0,
                "pos_y": 2.0,
                "pos_z": 3.0,
                "photos": [{"id": "P_MOVE", "filename": "crack1.jpg", "url": "/api/comments/photo/test/crack1.jpg"}],
            }
        )
        c2 = self.db.add_comment(
            {
                "scan_id": sid,
                "author_email": "eng@gatheren.cloud",
                "author_name": "Engineer A",
                "text": "Drainage note",
                "folder": "",
                "pos_x": 4.0,
                "pos_y": 2.0,
                "pos_z": 1.0,
                "photos": [],
            }
        )
        self.assertEqual(c1.get("folder"), "Structural Cracks")
        self.assertEqual(c2.get("folder"), "")

        # Rename folder updates both scan folder list and comment.folder
        renamed_list = self.db.rename_comment_folder(sid, "Structural Cracks", "Wall Defects")
        self.assertIn("Wall Defects", renamed_list)
        self.assertNotIn("Structural Cracks", renamed_list)
        c1_reloaded = self.db.get_comment(c1["comment_id"])
        self.assertEqual(c1_reloaded.get("folder"), "Wall Defects")

        # Delete folder moves notes back to Unclassified ('')
        after_del = self.db.delete_comment_folder(sid, "Wall Defects")
        self.assertNotIn("Wall Defects", after_del)
        c1_unclass = self.db.get_comment(c1["comment_id"])
        self.assertEqual(c1_unclass.get("folder"), "")

        self.db.delete_comment(c1["comment_id"])
        self.db.delete_comment(c2["comment_id"])

        self.assertIn("data-comment-folder-header", js08)
        self.assertIn("data-comment-folder-drop", js08)
        self.assertIn("application/x-gs-comment-photo", js08)
        self.assertIn("application/x-gs-comment-card", js08)
        self.assertIn("STATE.hiddenCommentFolders", js08)

        # Feature 4: Hide 3D camera objects when Photos menu is closed
        self.assertIn("clearPhotoTargetVisuals3D(true)", js03)
        self.assertIn("clearPhotoTargetVisuals3D(true)", js05)
        self.assertIn("studioThree.cameraTrajectoryGroup.visible = false", js08)
        self.assertIn("studioThree.photoFrustumGroup.visible = false", js08)

        # Feature 5: Depth occlusion for slope arrows and 3D measurement pins (while keeping comment pins visible through scan)
        self.assertIn("const isCommentMarker = grp === studioThree.commentPinsGroup;", js03)
        self.assertIn("depthTest: !isCommentMarker", js03)
        self.assertIn("polygonOffsetFactor: -1", js08)

        # Feature 6: Auto-show classification when Classify tab opens & auto-hide when closed (while keeping comment/measurement Labels visible by default)
        self.assertIn('STATE.categorizeOverlayVisible = STATE.activeTool === "categorize";', js03)
        self.assertIn("STATE.categorizeOverlayVisible = false;\n      STATE.categorizeLabelsVisible = true;", js03)
        self.assertIn("STATE.categorizeOverlayVisible = autoShow;\n    STATE.categorizeLabelsVisible = autoShow;", js05)

    def test_19_ipad_webgl_memory_and_view_lifecycle_protection(self):
        """Verify iPadOS/iOS WebGL Jetsam crash prevention, single-context lifecycle, and preview_tileset LOD streaming."""
        with open(os.path.join(BASE_DIR, "web", "src", "01-core-state.js"), "r", encoding="utf-8") as f:
            js01 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "02-map-and-timeline.js"), "r", encoding="utf-8") as f:
            js02 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "03-studio-core.js"), "r", encoding="utf-8") as f:
            js03 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "07-compare-and-queue.js"), "r", encoding="utf-8") as f:
            js07 = f.read()
        with open(os.path.join(BASE_DIR, "web", "app.js"), "r", encoding="utf-8") as f:
            app_js = f.read()
        with open(os.path.join(BASE_DIR, "web", "app.css"), "r", encoding="utf-8") as f:
            app_css = f.read()
        with open(os.path.join(BASE_DIR, "web", "sw.js"), "r", encoding="utf-8") as f:
            sw_js = f.read()

        # 1. iPadOS Safari desktop-mode detection + temporary WebGL context release + deep GPU resource disposal
        self.assertIn("function isIOSOrIPadDevice()", js01)
        self.assertIn("Number(navigator.maxTouchPoints || 0) > 1", js01)
        self.assertIn("function disposeObject3DResources(", js01)
        self.assertIn('gl.getExtension("WEBGL_lose_context")', js01)

        # 2. Prevent hidden Map previewThree initialization when opening Studio or single-scan share link
        self.assertIn("function suspendPreview3DResources()", js02)
        self.assertIn('STATE.activeView === "map"', js02)
        self.assertIn("opts.preservePopover", js02)
        self.assertIn("window.innerWidth <= 767", js02)

        # 3. Studio 3D WebGL memory budget on iPad/mobile: preview_tileset.json LOD, mipmap/MSAA suppression, context restoration
        self.assertIn("preview_tileset.json", js03)
        self.assertIn("mat.map.generateMipmaps = false", js03)
        self.assertIn("webglcontextlost", js03)
        self.assertIn("webglcontextrestored", js03)
        self.assertIn("suspendPreview3DResources()", js03)

        # 4. Compare view memory protection + view switching suspension
        self.assertIn("suspendCompare3DResources", js07)
        self.assertIn("suspendPreview3DResources()", app_js)
        self.assertIn('@media (max-width: 767px)', app_css)

        # 5. Service worker avoids cloning uncached multi-megabyte .glb stream buffers in RAM
        self.assertIn("caches.open(SCAN_TILES_CACHE)", sw_js)
        self.assertIn("if (existingCached && tileCache) {", sw_js)

    def test_20_recursive_merge_5_paths_and_move_notes(self):
        """Verify recursive merge provenance (_flatten_merged_from_leaves), 5 separate photo paths on
        merged_qihu_merged_2026_10_28_77753, DB.update_comment position updates, DB.clone_comments_to_scan
        with transform_fn & folder preservation, DB.clone_measurement_bookmarks_to_scan with transform_fn,
        and frontend interactive Move Note (btn-move-comment / STATE.movingCommentId)."""
        import json
        from pc_worker.surveying_engine import SurveyingEngine

        # 1. Verify DB.update_comment position updates (pos_x, pos_y, pos_z, twd97_e, twd97_n, twd97_h)
        sid_src = "test_merge_src_scan"
        sid_dst = "test_merge_dst_scan"
        self.db.upsert_scan(
            {
                "scan_id": sid_src,
                "name": "Test Merge Source",
                "project_group": "QiHu",
                "project_dir": os.path.join(BASE_DIR, "scans", sid_src),
                "extra_json": json.dumps({"comment_folders": ["一般備註", "樹木移植"]}, ensure_ascii=False),
            }
        )
        self.db.upsert_scan(
            {
                "scan_id": sid_dst,
                "name": "Test Merge Target",
                "project_group": "QiHu",
                "project_dir": os.path.join(BASE_DIR, "scans", sid_dst),
                "extra_json": json.dumps({"comment_folders": []}, ensure_ascii=False),
            }
        )

        cmt = self.db.add_comment(
            {
                "scan_id": sid_src,
                "author_email": "glibivanov@gatheren.com.tw",
                "author_name": "Glib Ivanov",
                "text": "編號27樹。(需要移植最大顆)",
                "folder": "一般備註",
                "pos_x": 10.0,
                "pos_y": 2.5,
                "pos_z": -5.0,
                "twd97_e": 300580.0,
                "twd97_n": 2780960.0,
                "twd97_h": 10.5,
                "photos": [{"id": "P1", "filename": "tree27.jpg", "url": "/api/comments/photo/test/tree27.jpg"}],
            }
        )
        cid = cmt["comment_id"]
        moved_cmt = self.db.update_comment(
            cid,
            pos_x=13.5,
            pos_y=3.2,
            pos_z=-7.25,
            twd97_e=300583.5,
            twd97_n=2780962.25,
            twd97_h=11.2,
        )
        self.assertIsNotNone(moved_cmt)
        self.assertAlmostEqual(float(moved_cmt["pos_x"]), 13.5, places=3)
        self.assertAlmostEqual(float(moved_cmt["pos_y"]), 3.2, places=3)
        self.assertAlmostEqual(float(moved_cmt["pos_z"]), -7.25, places=3)
        self.assertAlmostEqual(float(moved_cmt["twd97_e"]), 300583.5, places=3)
        self.assertAlmostEqual(float(moved_cmt["twd97_n"]), 2780962.25, places=3)
        self.assertAlmostEqual(float(moved_cmt["twd97_h"]), 11.2, places=3)
        self.assertEqual(moved_cmt.get("folder"), "一般備註")

        # 2. Verify DB.clone_comments_to_scan with transform_fn and folder preservation
        def _tx_fn(px, py, pz, ce, cn, ch):
            return (px + 5.0, py - 1.0, pz + 2.0, ce + 5.0, cn - 2.0, ch - 1.0)

        cloned_cnt = self.db.clone_comments_to_scan(sid_src, sid_dst, transform_fn=_tx_fn)
        self.assertEqual(cloned_cnt, 1)
        dst_cmts = self.db.list_comments(sid_dst)
        self.assertEqual(len(dst_cmts), 1)
        dc0 = dst_cmts[0]
        self.assertEqual(dc0.get("folder"), "一般備註")
        self.assertAlmostEqual(float(dc0["pos_x"]), 18.5, places=3)
        self.assertAlmostEqual(float(dc0["pos_y"]), 2.2, places=3)
        self.assertAlmostEqual(float(dc0["pos_z"]), -5.25, places=3)
        self.assertAlmostEqual(float(dc0["twd97_e"]), 300588.5, places=3)
        self.assertAlmostEqual(float(dc0["twd97_n"]), 2780960.25, places=3)
        self.assertAlmostEqual(float(dc0["twd97_h"]), 10.2, places=3)
        dst_folders = self.db.list_comment_folders(sid_dst)
        self.assertIn("一般備註", dst_folders)
        self.assertIn("樹木移植", dst_folders)

        # 3. Verify DB.clone_measurement_bookmarks_to_scan with transform_fn
        self.db.save_measurement_bookmark(
            {
                "scan_id": sid_src,
                "title": "Tree Clearance Check",
                "author_email": "glibivanov@gatheren.com.tw",
                "author_name": "Glib Ivanov",
                "camera_state": {"view_mode": "3d", "pos": [0, 20, 20]},
                "measurements_state": {
                    "distance_points": [
                        {"x": 10.0, "y": 2.0, "z": -4.0, "twd97_e": 300580.0, "twd97_n": 2780960.0, "twd97_h": 10.0}
                    ]
                },
            }
        )
        bm_cloned = self.db.clone_measurement_bookmarks_to_scan(sid_src, sid_dst, transform_fn=_tx_fn)
        self.assertEqual(bm_cloned, 1)
        dst_bms = self.db.list_measurement_bookmarks(sid_dst)
        self.assertEqual(len(dst_bms), 1)
        pt0 = dst_bms[0]["measurements_state"]["distance_points"][0]
        self.assertAlmostEqual(float(pt0["x"]), 15.0, places=3)
        self.assertAlmostEqual(float(pt0["y"]), 1.0, places=3)
        self.assertAlmostEqual(float(pt0["z"]), -2.0, places=3)
        self.assertAlmostEqual(float(pt0["twd97_e"]), 300585.0, places=3)
        self.assertAlmostEqual(float(pt0["twd97_n"]), 2780958.0, places=3)
        self.assertAlmostEqual(float(pt0["twd97_h"]), 9.0, places=3)

        # 4. Verify _flatten_merged_from_leaves recursive 6-DOF composition
        sid_parent_merge = "test_parent_merged_4scans"
        self.db.upsert_scan(
            {
                "scan_id": sid_parent_merge,
                "name": "Parent Merged 4 Scans",
                "project_group": "QiHu",
                "project_dir": os.path.join(BASE_DIR, "scans", sid_parent_merge),
                "extra_json": json.dumps(
                    {
                        "merged_from": [
                            {
                                "scan_id": "leaf_scan_1",
                                "native_anchor_zup": [300500.0, 2780900.0, 10.0],
                                "merged_anchor_zup": [300510.0, 2780920.0, 12.0],
                                "r_zup_rowmajor": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
                            },
                            {
                                "scan_id": "leaf_scan_2",
                                "native_anchor_zup": [300550.0, 2780950.0, 11.0],
                                "merged_anchor_zup": [300560.0, 2780970.0, 13.0],
                                "r_zup_rowmajor": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
                            },
                        ]
                    }
                ),
            }
        )
        eng = SurveyingEngine(self.db)
        top_mf = [
            {
                "scan_id": sid_parent_merge,
                "native_anchor_zup": [300535.0, 2780945.0, 12.5],
                "merged_anchor_zup": [300540.0, 2780955.0, 14.5],
                "r_zup_rowmajor": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            },
            {
                "scan_id": "leaf_scan_side",
                "native_anchor_zup": [300600.0, 2781000.0, 15.0],
                "merged_anchor_zup": [300605.0, 2781010.0, 16.0],
                "r_zup_rowmajor": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            },
        ]
        flattened = eng._flatten_merged_from_leaves(top_mf)
        self.assertEqual([m["scan_id"] for m in flattened], ["leaf_scan_1", "leaf_scan_2", "leaf_scan_side"])
        # leaf_scan_1 had ma_1 = [300510, 2780920, 12]; parent shifted from na_2=[300535,2780945,12.5] to ma_2=[300540,2780955,14.5] (+5, +10, +2)
        self.assertAlmostEqual(float(flattened[0]["merged_anchor_zup"][0]), 300515.0, places=3)
        self.assertAlmostEqual(float(flattened[0]["merged_anchor_zup"][1]), 2780930.0, places=3)
        self.assertAlmostEqual(float(flattened[0]["merged_anchor_zup"][2]), 14.0, places=3)

        # Also verify real QiHu_Merged_2026-10-28 (merged_qihu_merged_2026_10_28_77753) 8,640 cameras across 5 paths
        real_qihu_merged = "merged_qihu_merged_2026_10_28_77753"
        qihu_cam_cache = os.path.join(BASE_DIR, "data", "cameras_cache", f"{real_qihu_merged}_cameras_v6.json")
        if os.path.isfile(qihu_cam_cache):
            with open(qihu_cam_cache, "r", encoding="utf-8") as cf:
                cams_8640 = json.load(cf)
            self.assertEqual(len(cams_8640), 8640)
            by_sub = {}
            for c in cams_8640:
                sk = c.get("sub_scan") or "root"
                by_sub[sk] = by_sub.get(sk, 0) + 1
            self.assertEqual(
                by_sub,
                {
                    "catch_QiHuTender_1": 1500,
                    "catch_QiHuTender_2": 1500,
                    "catch_QiHuTender_3": 1500,
                    "catch_QiHuTender_4": 1500,
                    "catch_QihuSide": 2640,
                },
            )

        # 5. Verify presence of btn-move-comment, STATE.movingCommentId, v173 drainage stability & immediate frustum pyramids in frontend
        with open(os.path.join(BASE_DIR, "web", "src", "04-studio-lasso-and-edits.js"), "r", encoding="utf-8") as f:
            js04 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "05-studio-civil-inspectors.js"), "r", encoding="utf-8") as f:
            js05 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "08-advanced-surveying-and-qa.js"), "r", encoding="utf-8") as f:
            js08 = f.read()
        self.assertIn("STATE.movingCommentId", js04)
        self.assertIn("btn-move-comment", js05)
        self.assertIn("data-pin-move", js05)
        self.assertIn("btn-move-comment", js08)
        self.assertIn("STATE.movingCommentId", js08)
        self.assertIn("function renderDrainageAndSlopeVisuals3D(opts = {})", js08)
        self.assertIn("cameraTrajectoryOriginH", js08)
        self.assertIn("const frustumPts = [];", js08)
        self.assertIn("const frustumStride = Math.max(1, Math.ceil(camList.length / 36));", js08)

    def test_21_zoom_drainage_hill_erase_modes_labels_and_laser_fixes(self):
        """Verify all 5 v174 fixes: surface-aware zoom near Earth, bare-earth drainage despike, 2-mode triangle erase (Erase All default), Labels button toggling comments, and full-mesh Laser tool."""
        with open(os.path.join(BASE_DIR, "web", "src", "01-core-state.js"), "r", encoding="utf-8") as f:
            js01 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "02-map-and-timeline.js"), "r", encoding="utf-8") as f:
            js02 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "03-studio-core.js"), "r", encoding="utf-8") as f:
            js03 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "04-studio-lasso-and-edits.js"), "r", encoding="utf-8") as f:
            js04 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "05-studio-civil-inspectors.js"), "r", encoding="utf-8") as f:
            js05 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "06-studio-align-and-optimizer.js"), "r", encoding="utf-8") as f:
            js06 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "07-compare-and-queue.js"), "r", encoding="utf-8") as f:
            js07 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "08-advanced-surveying-and-qa.js"), "r", encoding="utf-8") as f:
            js08 = f.read()

        # 1. Surface-aware OrbitControls zoom near Earth across Studio, Preview, and Compare (with strictly zero rotation)
        self.assertIn("function installSurfaceAwareOrbitZoom(", js03)
        self.assertIn("const savedQuat = cam.quaternion.clone();", js03)
        self.assertNotIn("lerp(cursorDir", js03)
        self.assertIn("controls.minDistance = 0.08;", js03)
        self.assertIn("controls.minDistance = 0.08;", js02)
        self.assertIn("controls.minDistance = 0.08;", js07)

        # 2. Drainage bare-earth minYGrid + 5x5 lower-envelope despike pass (no 0.22 * meanY canopy hill)
        self.assertIn("rawH[idx] = minYGrid[idx];", js08)
        self.assertIn("const despikedH = new Float32Array(rawH);", js08)
        self.assertNotIn("0.78 * minYGrid[idx] + 0.22 * meanY", js08)

        # 3. Erasing triangles 2 modes ("Erase All in Selection" default + "Erase Visible Only")
        self.assertIn("lassoVisibleOnlyDelete: false,", js01)
        self.assertIn('id="btnLassoEraseAllMode"', js06)
        self.assertIn('id="btnLassoEraseVisibleMode"', js06)
        self.assertIn("const applyLassoDeleteDepthMode = (visOnly) => {", js06)

        # 4. Labels button hides/shows 2D/3D comments & pins
        self.assertIn("if (STATE.categorizeLabelsVisible === false) {\n          b.el.style.display = \"none\";\n          return;\n        }", js03)
        self.assertIn("studioThree.commentPinsGroup.visible = STATE.categorizeLabelsVisible;", js05)

        # 5. Laser tool full-mesh indexing & slope-seeded surface tracing
        self.assertIn("const targetMaxTris = 750000;", js04)
        self.assertIn("const semiCands = [];", js04)
        self.assertIn("if (stepJump <= 0.135 && probe.absNy >= 0.68)", js04)

    def test_22_merge_invariant_categorization_and_ground_photo_referee(self):
        """Verify 100% merge-invariant 3D classification on QiHu_Merged vs QiHu_Unified + calibrated mobile phone photo referee."""
        import json
        with open(os.path.join(BASE_DIR, "pc_worker", "surveying", "categorization_heuristics.py"), "r", encoding="utf-8") as f:
            heur_py = f.read()
        with open(os.path.join(BASE_DIR, "pc_worker", "surveying", "categorization_io.py"), "r", encoding="utf-8") as f:
            io_py = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "05-studio-civil-inspectors.js"), "r", encoding="utf-8") as f:
            js05 = f.read()

        # 1. Verify zero hardcoded scan-size mode switches (no max_span / 280m / 180m / 60m / is_wide_valley_forestry_scan), global TWD97 grid-origin snapping, strict "No Trunk = No Tree" 3D cylinder verification, and per-tree AI Vision verification
        self.assertNotIn("is_wide_valley_forestry_scan", heur_py)
        self.assertNotIn("max_span", heur_py)
        self.assertNotIn("is_midspan_moat_scan", heur_py)
        self.assertNotIn("is_occluded_giant_canopy", heur_py)
        self.assertNotIn('dbh_method = "crown_height_allometry"', heur_py)
        self.assertIn("res = 0.25", heur_py)
        self.assertIn("e_min = math.floor(float(base_e.min()) / res) * res", heur_py)
        self.assertIn("n_min = math.floor(float(base_n.min()) / res) * res", heur_py)
        self.assertIn("area_scale = max(1.0, min(2.5, occupied_2d_m2 / 12500.0))", heur_py)
        self.assertIn("local_dtm_p25_grid = grey_erosion(", heur_py)
        self.assertIn("if n_ts_tight < 8 or n_low_trunk < 3 or n_mid_trunk < 3:", heur_py)
        self.assertIn('"trunk_verified_3d": True,', heur_py)
        self.assertIn('"ai_vision_verified": False,', heur_py)
        self.assertIn('tr["ai_vision_verified"] = is_genuinely_verified', heur_py)
        self.assertIn("for tr in trees_list:\n            seen_cands.add(tr[\"id\"])", heur_py)
        self.assertIn("rej_tags = set(str(x).strip() for x in (ai_info.get(\"rejected_false_positive_tags\") or [])", heur_py)
        self.assertIn('"anchor_twd97": {"e": round(ce, 3), "n": round(cn, 3), "h": round(ch, 3)},', heur_py)

        # 2. Verify Ground-Level Mobile Phone Photo Referee (384x384 crops, <=10 candidates/batch, 60s timeout, 2nd-angle PiP), unified fast RTK photo frustum matcher, and interactive 📸 photo lightbox badge
        self.assertIn("def _crop_rtk_photo_for_3d_feature(", io_py)
        self.assertIn("def _match_feature_to_rtk_photo_fast(", io_py)
        self.assertIn("cal_bonus = 0.0 if cam.get(\"calibrated\", True) else 4.0", io_py)
        self.assertIn("for c_info in candidates_info[:125]:", io_py)
        self.assertIn("tile_sz = 384", io_py)
        self.assertIn("batch_sz = 10", io_py)
        self.assertIn("timeout_s=60.0", io_py)
        self.assertIn('"per_tree_verdicts": per_tree_verdicts', io_py)
        self.assertIn("data-cat-photo-file", js05)
        self.assertIn("window.openPhotoLightboxModal(photoUrl, fname, meta", js05)

        # 3. Verify QiHu_Merged (edited_qihu_merged_2026_10_28_858499) preserves QiHu_Unified trees, strict 3D trunk + AI Vision verification, road planter holes, and water voids
        uni_path = os.path.join(BASE_DIR, "data", "categorization_cache", "edited_qihu_unified_merged_scan_4_scans__edited_372953_categorization_v3.json")
        mrg_path = os.path.join(BASE_DIR, "data", "categorization_cache", "edited_qihu_merged_2026_10_28_858499_categorization_v3.json")
        ntu_path = os.path.join(BASE_DIR, "data", "categorization_cache", "ntudorm_20260915_baseline_categorization_v3.json")
        self.assertTrue(os.path.isfile(uni_path))
        self.assertTrue(os.path.isfile(mrg_path))
        self.assertTrue(os.path.isfile(ntu_path))
        with open(uni_path, "r", encoding="utf-8") as f:
            uni_cat = json.load(f)
        with open(mrg_path, "r", encoding="utf-8") as f:
            mrg_cat = json.load(f)
        with open(ntu_path, "r", encoding="utf-8") as f:
            ntu_cat = json.load(f)

        self.assertEqual(float(mrg_cat["summary"]["grid_resolution_m"]), 0.25)
        self.assertIn("anchor_twd97", mrg_cat)
        self.assertGreaterEqual(int(mrg_cat["summary"]["trees_count"]), int(uni_cat["summary"]["trees_count"]) + 20)
        self.assertTrue(all(t.get("trunk_verified_3d") is True for t in uni_cat.get("trees", [])))
        self.assertTrue(all(t.get("ai_vision_verified") is True for t in uni_cat.get("trees", [])))
        self.assertTrue(all(bool(t.get("object_seen") or t.get("ai_vision_label")) for t in uni_cat.get("trees", [])))
        self.assertTrue(all(t.get("dbh_method") != "crown_height_allometry" for t in uni_cat.get("trees", [])))
        self.assertTrue(all(t.get("trunk_verified_3d") is True for t in mrg_cat.get("trees", [])))
        self.assertTrue(all(t.get("ai_vision_verified") is True for t in mrg_cat.get("trees", [])))
        self.assertTrue(all(bool(t.get("object_seen") or t.get("ai_vision_label")) for t in mrg_cat.get("trees", [])))
        self.assertTrue(all(t.get("dbh_method") != "crown_height_allometry" for t in mrg_cat.get("trees", [])))
        self.assertTrue(all(t.get("ai_vision_verified") is True for t in ntu_cat.get("trees", [])))
        self.assertLessEqual(int(ntu_cat["summary"]["trees_count"]), 15)
        self.assertGreaterEqual(float(mrg_cat["summary"]["roads_planar_area_m2"]), float(uni_cat["summary"]["roads_planar_area_m2"]))
        self.assertTrue(any(len(r.get("holes_twd97") or []) > 0 for r in mrg_cat.get("roads", [])))
        self.assertGreaterEqual(int(mrg_cat["summary"]["water_count"]), 2)
        self.assertGreaterEqual(float(mrg_cat["summary"]["water_planar_area_m2"]), 1300.0)
        self.assertTrue(all(t.get("verified_photo") for t in mrg_cat.get("trees", [])))

        # 4. Verify all 16 scan caches have real Gemini Vision verification (zero fallback summaries, 100% tree photo + AI verification)
        import glob
        cache_files = sorted(glob.glob(os.path.join(BASE_DIR, "data", "categorization_cache", "*_categorization_v3.json")))
        self.assertEqual(len(cache_files), 16)
        for cfp in cache_files:
            with open(cfp, "r", encoding="utf-8") as f:
                cdoc = json.load(f)
            self.assertTrue(cdoc.get("ai_verified"), f"ai_verified must be True in {cfp}")
            self.assertNotIn("3D 幾何自動分類完成", str(cdoc.get("ai_summary_zh") or ""), f"Fallback zh summary found in {cfp}")
            self.assertNotIn("3D geometric categorization completed:", str(cdoc.get("ai_summary_en") or ""), f"Fallback en summary found in {cfp}")
            anch = cdoc.get("anchor_twd97") or {}
            self.assertGreater(abs(float(anch.get("e") or 0.0)), 1000.0, f"Invalid anchor_twd97 in {cfp}")
            for tr in cdoc.get("trees", []):
                self.assertTrue(tr.get("trunk_verified_3d") is True, f"Unverified 3D trunk in {cfp}: {tr.get('id')}")
                self.assertTrue(tr.get("ai_vision_verified") is True, f"Unverified AI vision tree in {cfp}: {tr.get('id')}")
                self.assertTrue(bool(tr.get("verified_photo")), f"Missing verified_photo in {cfp}: {tr.get('id')}")
                self.assertTrue(bool(tr.get("object_seen") or tr.get("ai_vision_label")), f"Missing object_seen in {cfp}: {tr.get('id')}")

        # 5. Edge case: when Gemini fails/times out or when camera_catalog is empty, _refine_categorization_with_gemini_multimodal must return ai_verified=False and never cache fake verification
        from unittest.mock import patch
        import numpy as np
        from pc_worker.surveying_engine import SurveyingEngine
        eng = SurveyingEngine(self.db)
        dummy_grid = np.zeros((16, 16, 3), dtype=np.uint8)
        with patch("urllib.request.urlopen", side_effect=TimeoutError("simulated timeout")):
            fail_res = eng._refine_categorization_with_gemini_multimodal(
                scan={"scan_id": "__unit_test_gemini_timeout__", "name": "TestTimeout"},
                ortho_rgb_u8=dummy_grid,
                e_min=300540.0,
                n_min=2780965.0,
                res=0.25,
                summary_data={"roads_count": 1, "trees_count": 1, "water_count": 0, "walls_count": 0},
                candidates_info=[{"tag": "T1", "category": "trees", "e": 300542.0, "n": 2780967.0, "h": 14.0}],
                camera_catalog=[],
            )
        self.assertFalse(fail_res.get("ai_verified"))
        self.assertEqual(fail_res.get("per_tree_verdicts"), {})

        # 6. Verify CSV & HTML engineering reports include AI Vision Verified & Object Seen columns, zero leftover Road/Wall/Water sections, and V-fork twin-stem manual removal idempotency
        for tr_ntu in ntu_cat.get("trees", []):
            self.assertNotIn("low green hedge", str(tr_ntu.get("object_seen") or "").lower())
            self.assertNotIn("vining plant", str(tr_ntu.get("object_seen") or "").lower())
        twin_stems = [
            t for t in mrg_cat.get("trees", [])
            if ((float(t["trunk_twd97"][0]) - 300581.27) ** 2 + (float(t["trunk_twd97"][1]) - 2780932.20) ** 2) ** 0.5 <= 0.80
        ]
        self.assertEqual(len(twin_stems), 2, "Both diverging stems of the V-fork twin tree must be detected")
        for ts_obj in twin_stems:
            self.assertIn("trunk_base_twd97", ts_obj)
            self.assertIn("trunk_top_twd97", ts_obj)
        import copy
        mrg_copy = copy.deepcopy(mrg_cat)
        ts_first = twin_stems[0]
        ov_twin = {
            "removed_ids": [ts_first["id"]],
            "removed_centers": [{"category": "trees", "e": ts_first["trunk_twd97"][0], "n": ts_first["trunk_twd97"][1], "tol": 0.35}],
            "added_trees": [],
            "added_walls": [],
            "added_roads": [],
            "added_water": [],
        }
        after_ov1 = eng._apply_manual_overrides_to_categorization("edited_qihu_merged_2026_10_28_858499", mrg_copy, ov_twin)
        self.assertEqual(len(after_ov1["trees"]), len(mrg_cat["trees"]) - 1)
        after_ov2 = eng._apply_manual_overrides_to_categorization("edited_qihu_merged_2026_10_28_858499", after_ov1, after_ov1["manual_overrides"])
        self.assertEqual(len(after_ov2["trees"]), len(mrg_cat["trees"]) - 1)

        ntu_csv_path = os.path.join(BASE_DIR, "data", "reports", "categorization_report_ntudorm_20260915_baseline.csv")
        ntu_html_path = os.path.join(BASE_DIR, "data", "reports", "categorization_report_ntudorm_20260915_baseline.html")
        if os.path.isfile(ntu_csv_path) and os.path.isfile(ntu_html_path):
            with open(ntu_csv_path, "r", encoding="utf-8-sig") as cf:
                csv_txt = cf.read()
            with open(ntu_html_path, "r", encoding="utf-8") as hf:
                html_txt = hf.read()
            self.assertIn("AI Vision Verified", csv_txt)
            self.assertIn("AI Visual Inspection (Object Seen)", csv_txt)
            self.assertIn("Yes (AI+3D Trunk)", csv_txt)
            self.assertIn("AI Vision & DBH Verification", html_txt)
            self.assertIn("✓ AI+3D 樹幹", html_txt)
            self.assertNotIn("Road Surface (道路鋪面)", html_txt)
            self.assertNotIn("ROADS SCHEDULE", csv_txt)

    def test_23_silent_subprocess_queue_order_progress_and_rerun_visibility(self):
        """Verify Task 1 & Task 2: silent subprocess patch, psutil process check, auto-tile retry cache,
        PIX4Dmatic 2.11.0 stage progress mapping, queue ordering + prioritize_scan_next, and queued re-run 3D visibility."""
        import tempfile
        from pc_worker.pix4d_runner import parse_pix4dmatic_log_progress

        # 1. Verify PIX4Dmatic 2.11.0 stage mapping (Generate tiles -> textured_mesh substep, overall ~79%)
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as tf:
            tf.write("[2026-10-29 13:20:00][45%CPU][62%RAM][Generate textured mesh] Running\n")
            tf.write("[2026-10-29 13:20:01][45%CPU][62%RAM][Generate tiles] Generating Cesium 3D Tiles...\n")
            tmp_log = tf.name
        try:
            info = parse_pix4dmatic_log_progress(tmp_log)
            self.assertIn("Generate Textured Mesh", info["stage"])
            self.assertGreaterEqual(float(info["progress_pct"]), 75.0)
            self.assertLessEqual(float(info["progress_pct"]), 89.0)
        finally:
            try:
                os.remove(tmp_log)
            except OSError:
                pass

        # 2. Verify list_scans() ordering (processing -> queued by force_next DESC, priority_score DESC, uploaded_at ASC -> waiting_parts -> completed)
        now = time.time()
        self.db.upsert_scan({"scan_id": "s_comp", "name": "Completed", "status": "completed", "capture_date": "2026-10-28"})
        self.db.upsert_scan({"scan_id": "s_wait", "name": "Waiting Parts", "status": "waiting_parts", "capture_date": "2026-10-29"})
        self.db.upsert_scan({"scan_id": "s_q_large", "name": "Queued Large", "status": "queued", "image_count": 2000, "size_bytes": 5000 * 1024 * 1024, "uploaded_at": now - 10})
        self.db.upsert_scan({"scan_id": "s_q_small", "name": "Queued Small", "status": "queued", "image_count": 100, "size_bytes": 200 * 1024 * 1024, "uploaded_at": now - 5})
        self.db.upsert_scan({"scan_id": "s_proc", "name": "Processing", "status": "processing", "progress_pct": 71.0})

        ordered = [s["scan_id"] for s in self.db.list_scans() if s["scan_id"] in {"s_comp", "s_wait", "s_q_large", "s_q_small", "s_proc"}]
        self.assertEqual(ordered, ["s_proc", "s_q_small", "s_q_large", "s_wait", "s_comp"])

        # 3. Verify prioritize_scan_next moves s_q_large ahead of s_q_small
        self.db.prioritize_scan_next("s_q_large")
        ordered_after = [s["scan_id"] for s in self.db.list_scans() if s["scan_id"] in {"s_comp", "s_wait", "s_q_large", "s_q_small", "s_proc"}]
        self.assertEqual(ordered_after, ["s_proc", "s_q_large", "s_q_small", "s_wait", "s_comp"])

        # 4. Verify source wiring across Python & JS files
        with open(os.path.join(BASE_DIR, "start_gathering_scans.py"), "r", encoding="utf-8") as f:
            start_py = f.read()
        with open(os.path.join(BASE_DIR, "server.py"), "r", encoding="utf-8") as f:
            srv_py = f.read()
        with open(os.path.join(BASE_DIR, "pc_worker", "gdrive_watcher.py"), "r", encoding="utf-8") as f:
            watcher_py = f.read()
        with open(os.path.join(BASE_DIR, "pc_worker", "server_cloud_and_tunnel.py"), "r", encoding="utf-8") as f:
            tunnel_py = f.read()
        with open(os.path.join(BASE_DIR, "pc_worker", "server_api_routes.py"), "r", encoding="utf-8") as f:
            routes_py = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "02-map-and-timeline.js"), "r", encoding="utf-8") as f:
            js02 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "03-studio-core.js"), "r", encoding="utf-8") as f:
            js03 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "07-compare-and-queue.js"), "r", encoding="utf-8") as f:
            js07 = f.read()

        self.assertIn("def _install_silent_subprocess_patch()", start_py)
        self.assertIn("def _install_silent_subprocess_patch()", srv_py)
        self.assertIn("psutil.process_iter", start_py)
        self.assertIn("psutil.process_iter", srv_py)
        self.assertIn("_AUTO_TILE_ATTEMPTED_CACHE", watcher_py)
        self.assertIn("_KNOWN_OUTPUT_SUBDIRS", tunnel_py)
        self.assertIn('"/api/queue/prioritize"', routes_py)
        self.assertIn('if (scan.status && scan.status !== "completed" && !scan.stream_url)', js02)
        self.assertIn('if (scan.status && scan.status !== "completed" && !scan.stream_url)', js03)
        self.assertIn("data-prioritize", js07)
        self.assertIn("data-inspect3d", js07)

    def test_24_multi_stage_pipeline_progress_and_segmented_queue_bar(self):
        """Verify 6-section color-coded pipeline progress model and PIX4Dmatic 15-tile textured mesh substep accuracy."""
        import tempfile
        from pc_worker.pix4d_runner import parse_pix4dmatic_log_progress, build_pipeline_breakdown

        lines = [
            "[2026-10-29 14:00:00][20%CPU][50%RAM][Import project] Finished",
            "[2026-10-29 14:05:00][40%CPU][60%RAM][Generate calibration] Finished",
            "[2026-10-29 14:15:00][80%CPU][75%RAM][Generate dense point cloud] Finished",
            "[2026-10-29 14:18:00][60%CPU][76%RAM][Generate depth point cloud] Finished",
            "[2026-10-29 14:20:00][55%CPU][78%RAM][Fusing dense and depth point cloud] Finished",
            "[2026-10-29 14:20:05][30%CPU][80%RAM][Generate textured mesh] Running",
            "[2026-10-29 14:20:05][30%CPU][80%RAM][Generate scalable mesh] Running",
            "[2026-10-29 14:20:05][30%CPU][80%RAM][Generate tiles] Running",
            "[2026-10-29 14:20:05][30%CPU][80%RAM][Write tiles to disk] Running",
            "[2026-10-29 14:20:06][30%CPU][80%RAM][Generate tiles](Info) Scene subdivided into 15 tiles",
        ]
        # Pass 1 & Pass 2 for all 15 tiles
        for idx in range(1, 16):
            tid = f"{{tile-{idx:02d}}}"
            lines.append(f"[2026-10-29 14:22:00][75%CPU][85%RAM][Generate tiles](Info) [tileid={tid}] Pre-process point cloud - done")
            lines.append(f"[2026-10-29 14:23:00][75%CPU][85%RAM][Generate tiles](Info) [tileid={tid}] Generating mesh geometry - done")
            lines.append(f"[2026-10-29 14:24:00][75%CPU][85%RAM][Generate tiles](Info) [tileid={tid}] Decimate geometry - done")
            lines.append(f"[2026-10-29 14:25:00][75%CPU][85%RAM][Generate tiles](Info) [tileid={tid}] Update depth buffers - done")
            lines.append(f"[2026-10-29 14:26:00][65%CPU][88%RAM][Generate tiles](Info) [tileid={tid}] Compute face to view scores")

        # Pass 3: Tile 1 finished texturing & wrote tree level 0
        lines.extend([
            "[2026-10-29 14:30:00][40%CPU][92%RAM][Generate tiles](Debug) Generate texture for tile: [tileid={tile-01}]",
            "[2026-10-29 14:31:00][40%CPU][92%RAM][Generate tiles](Info) [tileid={tile-01}] Compute texture coordinates - start",
            "[2026-10-29 14:32:00][40%CPU][92%RAM][Generate tiles](Info) [tileid={tile-01}] Generate texture atlas",
            "[2026-10-29 14:33:00][40%CPU][92%RAM][Generate tiles](Info) [tileid={tile-01}] Texture mesh - done",
            "[2026-10-29 14:33:10][20%CPU][95%RAM][Write tiles to disk](Info) Generating leave nodes",
            "[2026-10-29 14:33:20][20%CPU][95%RAM][Write tiles to disk](Info) Processing tree level 0",
            # Tile 2 currently in progress (Texture mesh - done, writing LOD tree level 2)
            "[2026-10-29 14:34:00][20%CPU][97%RAM][Generate tiles](Debug) Generate texture for tile: [tileid={tile-02}]",
            "[2026-10-29 14:35:00][20%CPU][97%RAM][Generate tiles](Info) [tileid={tile-02}] Compute texture coordinates - start",
            "[2026-10-29 14:36:00][20%CPU][97%RAM][Generate tiles](Info) [tileid={tile-02}] Generate texture atlas",
            "[2026-10-29 14:37:00][20%CPU][97%RAM][Generate tiles](Info) [tileid={tile-02}] Texture mesh - done",
            "[2026-10-29 14:37:10][20%CPU][97%RAM][Write tiles to disk](Info) Generating leave nodes",
            "[2026-10-29 14:37:15][20%CPU][97%RAM][Write tiles to disk](Info) Processing tree level 2",
        ])

        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as tf:
            tf.write("\n".join(lines) + "\n")
            daan_log = tf.name
        try:
            info = parse_pix4dmatic_log_progress(daan_log)
            bd = info["pipeline_breakdown"]
            self.assertIsNotNone(bd)
            self.assertEqual(bd["active_section_id"], "textured_mesh")
            # Substep % for textured_mesh should be ~63% - 65% (matching PIX4Dmatic's 63%!), NOT 93%
            self.assertGreaterEqual(float(info["substep_pct"]), 62.0)
            self.assertLessEqual(float(info["substep_pct"]), 66.0)
            # Overall progress should be ~70% - 72% (8 + 18 + 22 + 36*0.64 = 71.0%)
            self.assertGreaterEqual(float(info["progress_pct"]), 69.5)
            self.assertLessEqual(float(info["progress_pct"]), 72.5)
            self.assertIn("Tile 2/15", info["stage"])
            self.assertEqual(len(bd["sections"]), 6)
            sec_by_id = {s["id"]: s for s in bd["sections"]}
            self.assertEqual(sec_by_id["copy_files"]["substep_pct"], 100.0)
            self.assertEqual(sec_by_id["calibration"]["substep_pct"], 100.0)
            self.assertEqual(sec_by_id["point_cloud"]["substep_pct"], 100.0)
            self.assertAlmostEqual(sec_by_id["textured_mesh"]["substep_pct"], info["substep_pct"], places=1)
            self.assertEqual(sec_by_id["pix4d_export"]["substep_pct"], 0.0)
            self.assertEqual(sec_by_id["web_tileset"]["substep_pct"], 0.0)
        finally:
            try:
                os.remove(daan_log)
            except OSError:
                pass

        # Verify Website Post-Processing breakdown (Section 6)
        web_bd = build_pipeline_breakdown(
            {"status": "processing", "progress_pct": 96.0, "stage_label": "Website Processing (65%): Building L0 Overview GLB & Applying Georef Offset..."}
        )
        self.assertEqual(web_bd["active_section_id"], "web_tileset")
        self.assertEqual(web_bd["active_substep_pct"], 65.0)
        self.assertAlmostEqual(web_bd["overall_pct"], 96.5, places=1)

        with open(os.path.join(BASE_DIR, "web", "src", "07-compare-and-queue.js"), "r", encoding="utf-8") as f:
            js07 = f.read()
        with open(os.path.join(BASE_DIR, "web", "index.html"), "r", encoding="utf-8") as f:
            idx_html = f.read()
        self.assertIn("function renderSegmentedPipelineBarHtml(", js07)
        self.assertIn("function renderPipelineSubitemsGridHtml(", js07)
        self.assertIn('id="livePix4dSegmentedBarWrap"', idx_html)
        self.assertIn('id="livePix4dSubitemsGrid"', idx_html)
        self.assertIn("?v=20261029_v", idx_html)

    def test_25_two_pass_preview_and_scalable_lod_recovery(self):
        """Verify Option C Two-Pass Fast Preview + Full 16K HQ pipeline, dynamic Scalable octree LOD recovery,
        0-byte mesh.obj rejection, and Pass 1 queue priority boost (+50000)."""
        import tempfile
        from pc_worker.config import FAST_PREVIEW_PIX4D_SETTINGS
        from pc_worker.pix4d_runner import (
            _detect_scalable_mesh_max_lod,
            generate_pix4dmatic_gst_script,
            postprocess_obj_to_tileset,
        )
        from pc_worker.priority_queue import calculate_priority_score

        # 1. Verify FAST_PREVIEW_PIX4D_SETTINGS & GST generation for Pass 1 (preview)
        self.assertEqual(FAST_PREVIEW_PIX4D_SETTINGS["mesh_pipeline"], "FixedSize")
        self.assertEqual(FAST_PREVIEW_PIX4D_SETTINGS["texture_size"], 2048)
        self.assertTrue(FAST_PREVIEW_PIX4D_SETTINGS["skip_dense_cloud"])

        gst_preview_small = generate_pix4dmatic_gst_script(
            project_p4m_path=r"C:\test\test_small.p4m",
            input_zip_or_folder=r"C:\test\photos",
            export_dir=r"C:\test\out",
            extracted_image_paths=[rf"C:\test\photos\img_{i}.jpg" for i in range(120)],
            pipeline_settings=dict(FAST_PREVIEW_PIX4D_SETTINGS, calib_image_scale="AutoAdaptive"),
            pipeline_pass="preview",
            has_depth_inputs=True,
        )
        self.assertIn("settings.imageScale : ImageScale.Full", gst_preview_small)
        self.assertIn("settings.meshPipeline : MeshPipeline.FixedSize", gst_preview_small)
        self.assertIn("settings.textureSize : 2048", gst_preview_small)
        # Skip dense cloud: GenerateGaPmvsDensePointCloud omitted and DepthPointCloud wired directly to GenerateScalableMesh
        self.assertNotIn("GenerateGaPmvsDensePointCloud", gst_preview_small)
        self.assertIn("inputs : [DepthPointCloud{ }", gst_preview_small)

        gst_preview_large = generate_pix4dmatic_gst_script(
            project_p4m_path=r"C:\test\test_large.p4m",
            input_zip_or_folder=r"C:\test\photos",
            export_dir=r"C:\test\out",
            part_image_groups=[[r"C:\test\part1\a.jpg"], [r"C:\test\part2\b.jpg"]],
            pipeline_settings=dict(FAST_PREVIEW_PIX4D_SETTINGS, calib_image_scale="AutoAdaptive"),
            pipeline_pass="preview",
            has_depth_inputs=True,
        )
        self.assertIn("settings.imageScale : ImageScale.Quarter", gst_preview_large)

        # 2. Verify Pass 1 priority boost (+50000) over Pass 2 full_hq
        score_pass1 = calculate_priority_score(
            image_count=300, size_mb=500.0, wait_minutes=10.0, pending_pass="preview"
        )
        score_pass2 = calculate_priority_score(
            image_count=300, size_mb=500.0, wait_minutes=10.0, pending_pass="full_hq"
        )
        self.assertGreater(score_pass1 - score_pass2, 49000.0)

        # 3. Verify _detect_scalable_mesh_max_lod detects level 9 from octree .glb tiles
        with tempfile.TemporaryDirectory() as tmp_proj:
            content_dir = os.path.join(tmp_proj, "catch_DaAn", "processing", "meshes", "uuid-1", "content")
            os.makedirs(content_dir, exist_ok=True)
            for fname in ["0_0_0_0.glb", "5_12_10_4.glb", "9_140_220_35.glb"]:
                with open(os.path.join(content_dir, fname), "wb") as f:
                    f.write(b"glTF" + b"\x00" * 32)
            self.assertEqual(_detect_scalable_mesh_max_lod(tmp_proj), 9)

            # 4. Verify postprocess_obj_to_tileset rejects 0-byte mesh.obj instead of looping infinitely
            zero_obj = os.path.join(tmp_proj, "mesh.obj")
            with open(zero_obj, "wb") as f:
                pass
            self.assertEqual(postprocess_obj_to_tileset("catch_DaAn", tmp_proj, zero_obj), "")

    def test_27_section_box_lasso_clipping_manual_inputs_hide_handles_and_unclipped_wireframe(self):
        """Verify Section Box is respected by Lasso 'Erase All in Selection', manual number inputs + 0.1m ArrowUp/ArrowDown step, flicker-free unclipped wireframe, and Hide Handles button."""
        import numpy as np
        from pc_worker.optimizer_bridge import _eval_multiscan_layer_delete_mask

        with open(os.path.join(BASE_DIR, "web", "src", "03-studio-core.js"), "r", encoding="utf-8") as f:
            js03 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "04-studio-lasso-and-edits.js"), "r", encoding="utf-8") as f:
            js04 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "05-studio-civil-inspectors.js"), "r", encoding="utf-8") as f:
            js05 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "06-studio-align-and-optimizer.js"), "r", encoding="utf-8") as f:
            js06 = f.read()

        # 1. Flicker-free unclipped material & reused wireframe box helper + Hide Handles button
        self.assertIn("function makeUnclippedMaterial(", js03)
        self.assertIn('#include <clipping_planes_fragment>', js03)
        self.assertIn("studioThree._sectionBoxHelper.scale.set(hx, hy, hz);", js05)
        self.assertIn('id="btnToggleSectionHandles"', js05)
        self.assertIn("st.hideHandles = !st.hideHandles;", js05)

        # 2. Manual value entry inputs + 0.1 m step & ArrowUp/ArrowDown 0.1 m movement
        for input_id in ("numSecClipX", "numSecClipZ", "numSecClipY", "numSecClipYMin", "numSecClipYaw"):
            self.assertIn(f'id="{input_id}"', js05)
        self.assertIn('step="0.1" value="${curYTop}" class="gs-input" id="secClipY"', js05)
        self.assertIn('step="0.1" value="${curYBot}" class="gs-input" id="secClipYMin"', js05)
        self.assertIn('const stepM = 0.1 * (e.key === "ArrowUp" ? 1 : -1);', js06)

        # 3. Lasso Erase All in Selection & Frustum Strokes respect active Section Box
        self.assertIn("function isTriangleInSectionBox(", js03)
        self.assertIn("isTriangleInSectionBox(wx0, wy0, wz0, wx1, wy1, wz1, wx2, wy2, wz2, sb)", js04)
        self.assertIn("sectionBox: parseSectionBoxForEval(st.section_box)", js04)

        # 4. Backend _eval_multiscan_layer_delete_mask respects section_box
        # Two triangles at X=0, Z=0: Tri 0 at Y=2.0 (inside section box Y in [-5, +5]), Tri 1 at Y=15.0 (clipped out by section box)
        v_centered = np.array(
            [
                [-1.0, 2.0, -1.0],
                [1.0, 2.0, -1.0],
                [0.0, 2.0, 1.0],
                [-1.0, 15.0, -1.0],
                [1.0, 15.0, -1.0],
                [0.0, 15.0, 1.0],
            ],
            dtype=np.float64,
        )
        f_idx = np.array([[0, 1, 2], [3, 4, 5]], dtype=np.int64)
        # Identity clip/world matrices where (x, y, z) -> clip (x*0.1, y*0.02, 0, 1) so both triangles project inside NDC [-0.5, 0.5]^2
        clip_mat = np.array(
            [
                [0.1, 0.0, 0.0, 0.0],
                [0.0, 0.02, 0.0, 0.0],
                [0.0, 0.0, 0.01, 0.0],
                [0.0, 0.0, 0.0, 1.0],
            ],
            dtype=np.float64,
        )
        world_mat = np.eye(4, dtype=np.float64)
        deletions = [
            {
                "frustum_strokes": [
                    {
                        "op": "add",
                        "ndc_polygon": [[-0.8, -0.8], [0.8, -0.8], [0.8, 0.8], [-0.8, 0.8]],
                        "visible_only": False,
                        "layer_zup_to_clip": {"scan_a": clip_mat.flatten(order="F").tolist()},
                        "layer_zup_to_world": {"scan_a": world_mat.flatten(order="F").tolist()},
                        "section_box": {"center": [0.0, 0.0, 0.0], "half": [10.0, 5.0, 10.0], "yaw_rad": 0.0},
                    }
                ]
            }
        ]
        mask = _eval_multiscan_layer_delete_mask(v_centered, f_idx, "scan_a", deletions)
        self.assertTrue(bool(mask[0]))
        self.assertFalse(bool(mask[1]))

    def test_28_middle_mouse_orbit_and_closed_area_polygon_vertex_drag(self):
        """Verify Middle Mouse Button (MMB) orbits across all tools (including Freehand Lasso & First-Person) and closed Area polygon vertices can be dragged directly to recalculate area."""
        with open(os.path.join(BASE_DIR, "web", "lib", "OrbitControls.js"), "r", encoding="utf-8") as f:
            orbit_js = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "03-studio-core.js"), "r", encoding="utf-8") as f:
            js03 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "04-studio-lasso-and-edits.js"), "r", encoding="utf-8") as f:
            js04 = f.read()

        # 1. Middle Mouse Button (MIDDLE: THREE.MOUSE.ROTATE) enabled even when LMB is used by Freehand Lasso or other tools
        self.assertIn("MIDDLE: THREE.MOUSE.ROTATE", orbit_js)
        self.assertNotIn("studioThree.controls.enableRotate = !isFreehandLasso;", js03)
        self.assertIn("studioThree.controls.enableRotate = true;", js03)
        self.assertIn("controls.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE;", js03)

        # 2. Direct click-and-drag on closed Area polygon vertices updates vertex position & recalculates Area/Perim live
        self.assertIn("function startStudioVertexMove(vDesc, opts = {})", js03)
        self.assertIn("dragMode: true, pointerId: e.pointerId", js03)
        self.assertIn("STATE.movingVertex?.dragMode && typeof updateStudioVertexMove === \"function\"", js03)
        self.assertIn("Recalculated Area: ${areaM2.toFixed(2)} m²", js03)
        self.assertIn("drag any vertex to adjust & recalculate area", js04)

    def test_29_hostinger_embed_mode_and_zero_roundtrip_bootstrap(self):
        """Verify Hostinger Website Builder Embed Mode (?embed=1, ?embed=poster, /embed/<token>), server-side __GS_EMBED_BOOTSTRAP__ injection, CSP frame-ancestors *, and embed code generator."""
        with open(os.path.join(BASE_DIR, "server.py"), "r", encoding="utf-8") as f:
            srv_py = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "01-core-state.js"), "r", encoding="utf-8") as f:
            js01 = f.read()
        with open(os.path.join(BASE_DIR, "web", "app.js"), "r", encoding="utf-8") as f:
            app_js = f.read()
        with open(os.path.join(BASE_DIR, "web", "index.html"), "r", encoding="utf-8") as f:
            idx_html = f.read()
        with open(os.path.join(BASE_DIR, "web", "app.css"), "r", encoding="utf-8") as f:
            app_css = f.read()

        # 1. Server-side CSP frame-ancestors *, /embed/<token> route, and zero-roundtrip bootstrap injection
        self.assertIn('self.send_header("Content-Security-Policy", "frame-ancestors *")', srv_py)
        self.assertIn("def _build_embed_bootstrap_payload(", srv_py)
        self.assertIn("window.__GS_EMBED_BOOTSTRAP__ =", srv_py)
        self.assertIn('if path.startswith("/embed/"):', srv_py)

        # 2. Core state embed mode detection & pre-populated STATE.scans
        self.assertIn("window.__GS_EMBED_BOOTSTRAP__", js01)
        self.assertIn("embedMode: initialEmbedMode", js01)
        self.assertIn("isEmbedded: initialIsEmbedded", js01)

        # 3. Hostinger Embed Code generator & Floating HUD / Poster overlay
        self.assertIn("function buildPublicEmbedUrl(", app_js)
        self.assertIn("function buildHostingerEmbedCode(", app_js)
        self.assertIn("function syncEmbedHudUI(", app_js)
        self.assertIn('id="gsEmbedFloatingHud"', idx_html)
        self.assertIn('id="gsEmbedPosterOverlay"', idx_html)
        self.assertIn('id="btnCopyLatestShareEmbed"', idx_html)
        self.assertIn("html.gs-embed-mode .gs-topbar", app_css)

        # 4. Placeholder token ("YOUR_SHARE_TOKEN") and direct scan_id in /embed/<token> auto-resolve without 403
        self.db.upsert_scan(
            {
                "scan_id": "edited_qihu_unified_merged_scan_4_scans__edited_372953",
                "name": "QiHu Unified Merged Scan (4 Scans)",
                "project_group": "QiHu",
                "status": "completed",
            }
        )
        auth = AuthAndSharingManager(self.db)
        real_link = auth.create_share_link(
            {
                "scope_type": "scan",
                "target_id": "edited_qihu_unified_merged_scan_4_scans__edited_372953",
                "label": "Hostinger Embed QiHu",
            }
        )
        ok_ph, _, link_ph, scans_ph = auth.validate_share_access("YOUR_SHARE_TOKEN")
        self.assertTrue(ok_ph)
        self.assertEqual(link_ph["token"], real_link["token"])
        self.assertEqual(len(scans_ph), 1)

        ok_sid, _, link_sid, scans_sid = auth.validate_share_access(
            "edited_qihu_unified_merged_scan_4_scans__edited_372953"
        )
        self.assertTrue(ok_sid)
        self.assertEqual(link_sid["token"], real_link["token"])
        self.assertEqual(len(scans_sid), 1)

        # 5. Share link whose original target_id was superseded by a newer edited/cleared scan auto-resolves to the active scan
        self.db.upsert_scan(
            {
                "scan_id": "edited_daan_cleared_246001",
                "name": "DaAn_Cleared",
                "project_group": "DaAn Park",
                "status": "completed",
            }
        )
        daan_link = auth.create_share_link(
            {
                "scope_type": "scan",
                "target_id": "edited_daan_661536",
                "label": "DaAn Embed Link",
            }
        )
        ok_daan, _, link_daan_res, scans_daan = auth.validate_share_access(daan_link["token"])
        self.assertTrue(ok_daan)
        self.assertEqual(len(scans_daan), 1)
        self.assertEqual(scans_daan[0]["scan_id"], "edited_daan_cleared_246001")

    def test_29_gaussian_splat_and_model_library_folders(self):
        """Verify 3D Gaussian Splat (.ply / .compressed.ply / .splat) builder, 3D Model Library folders, and moving scans between sites & folders."""
        from pc_worker.gaussian_splat_builder import (
            is_gaussian_splat_file,
            find_gaussian_splat_source_in_folder,
            load_gaussian_splats_raw,
            build_gaussian_splat_tileset,
        )

        jishi_dir = r"C:\GatheringScans\Jishi Gauss"
        if os.path.isdir(jishi_dir):
            ply_src = find_gaussian_splat_source_in_folder(jishi_dir)
            self.assertTrue(is_gaussian_splat_file(ply_src))
            raw_splats = load_gaussian_splats_raw(ply_src)
            self.assertEqual(len(raw_splats["xyz"]), 151391)
            ts_path = build_gaussian_splat_tileset("jishi_gauss", jishi_dir, ply_src, force=False)
            self.assertIsNotNone(ts_path)
            self.assertTrue(os.path.isfile(os.path.join(jishi_dir, "tileset", "tiles", "splats.gsplat")))
            self.assertTrue(os.path.isfile(os.path.join(jishi_dir, "thumbnail.png")))

        # Test Library Folders CRUD & moving scans between Map Sites and Library Folders
        folders_init = self.db.get_library_folders()
        self.assertGreaterEqual(len(folders_init), 3)

        folders_after_create = self.db.create_library_folder(
            "專題獎座與展品 (Awards)", "專題獎座與展品", "star"
        )
        self.assertTrue(
            any(f["folder_name"] == "Awards" and f["folder_name_zh"] == "專題獎座與展品" for f in folders_after_create)
        )

        self.db.upsert_scan(
            {
                "scan_id": "test_splat_person",
                "name": "Jishi Person Splat",
                "project_group": "人物與角色 (People)",
                "project_name_zh": "人物與角色 3D 模型",
                "group_type": "library",
                "is_gaussian_splat": True,
                "splat_count": 151391,
                "crs": "LOCAL_ORIGIN",
                "status": "completed",
            }
        )
        s0 = self.db.get_scan("test_splat_person")
        self.assertTrue(s0["is_gaussian_splat"])
        self.assertEqual(s0["group_type"], "library")
        self.assertEqual(s0["project_group"], "People")
        self.assertEqual(s0["project_name_zh"], "人物與角色")
        self.assertEqual(s0["splat_count"], 151391)

        # Move from Library Folder to Map Site
        self.db.move_scans_to_group(
            ["test_splat_person"], "QuChi Dam", "屈尺堰工程掃描群組", target_type="site"
        )
        s_moved_site = self.db.get_scan("test_splat_person")
        self.assertEqual(s_moved_site["project_group"], "QuChi Dam")
        self.assertEqual(s_moved_site["group_type"], "site")

        # Move from Map Site back to custom Library Folder
        self.db.move_scans_to_group(
            ["test_splat_person"], "專題獎座與展品 (Awards)", "專題獎座與展品", target_type="library"
        )
        s_moved_lib = self.db.get_scan("test_splat_person")
        self.assertEqual(s_moved_lib["project_group"], "Awards")
        self.assertEqual(s_moved_lib["project_name_zh"], "專題獎座與展品")
        self.assertEqual(s_moved_lib["group_type"], "library")

        # Verify frontend EWA Gaussian Splat shader, Embed Viewer splat support, Auto-Rotate defaults & Library UI wiring
        with open(os.path.join(BASE_DIR, "web", "src", "01-core-state.js"), "r", encoding="utf-8") as f:
            js01 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "03-studio-core.js"), "r", encoding="utf-8") as f:
            js03 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "07-compare-and-queue.js"), "r", encoding="utf-8") as f:
            js07 = f.read()
        with open(os.path.join(BASE_DIR, "web", "index.html"), "r", encoding="utf-8") as f:
            html_txt = f.read()
        self.assertIn("loadGaussianSplatIntoContext", js01)
        self.assertIn("updateGaussianSplatForContext", js01)
        self.assertIn("isScanOrTilesetGaussianSplat", js01)
        self.assertIn("vConic", js01)
        self.assertIn("embedAutoRotateEnabled", js01)
        self.assertIn("previewAutoRotateEnabled", js01)
        self.assertIn("studioAutoRotateEnabled: false", js01)
        self.assertIn("isScanOrTilesetGaussianSplat", js03)
        self.assertIn("controls.autoRotate = false;", js07)
        self.assertIn('id="btnEmbedAutoRotate" aria-pressed="true"', html_txt)
        self.assertIn('id="btnPreviewAutoRotate" aria-pressed="true"', html_txt)
        self.assertIn('id="btnStudioAutoRotate" aria-pressed="false"', html_txt)
        self.assertIn("renderModelLibraryView", js01)
        self.assertIn("openMoveScanModal", js01)
        self.assertIn("modelLibraryOverlay", html_txt)
        self.assertIn("moveScanModal", html_txt)

    def test_30_best_fit_reference_plane(self):
        """M1 Verification: Least-Squares Best-Fit Reference Plane via 2D Normal Equations with Cramer's Rule."""
        self._ensure_test_scan("quchi_20261005_merged")
        survey = SurveyingEngine(self.db)
        # Test 1: Sloping plane on real scan with best_fit_plane base mode
        vol = survey.calculate_cut_fill_volume(
            {
                "scan_id": "quchi_20261005_merged",
                "stockpile_name": "Best-Fit Plane Zone",
                "base_mode": "best_fit_plane",
                "polygon": [
                    [304945.0, 2757078.0, 43.1],
                    [304960.0, 2757078.0, 43.1],
                    [304960.0, 2757090.0, 43.4],
                    [304945.0, 2757090.0, 43.4],
                ],
            }
        )
        self.assertEqual(vol["status"], "ok")
        self.assertIn("best_fit_plane", vol)
        bfp = vol["best_fit_plane"]
        self.assertIn("a", bfp)
        self.assertIn("b", bfp)
        self.assertIn("c", bfp)
        self.assertIn("slope_pct", bfp)
        self.assertIn("azimuth_deg", bfp)
        self.assertGreaterEqual(bfp["slope_pct"], 0.0)
        self.assertGreaterEqual(bfp["azimuth_deg"], 0.0)
        self.assertLess(bfp["azimuth_deg"], 360.0)

        # Test 2: Degenerate / collinear points safeguard (must not raise ZeroDivisionError)
        vol_collinear = survey.calculate_cut_fill_volume(
            {
                "scan_id": "quchi_20261005_merged",
                "base_mode": "best_fit_plane",
                "polygon": [
                    [304945.0, 2757078.0, 42.0],
                    [304950.0, 2757083.0, 42.5],
                    [304955.0, 2757088.0, 43.0],
                ],
            }
        )
        self.assertEqual(vol_collinear["status"], "ok")
        self.assertIn("best_fit_plane", vol_collinear)
        # Collinear points fallback to mean horizontal plane (slope = 0.0)
        self.assertEqual(vol_collinear["best_fit_plane"]["slope_pct"], 0.0)
        self.assertEqual(vol_collinear["best_fit_plane"]["a"], 0.0)
        self.assertEqual(vol_collinear["best_fit_plane"]["b"], 0.0)

        # Test 3: 100m collinear alignment at arbitrary angle (eigenvalue safeguard test)
        angle = math.radians(35.0)
        dx, dy = math.cos(angle), math.sin(angle)
        collinear_100m = [
            [304950.0 + (k / 9.0 - 0.5) * 100.0 * dx, 2757080.0 + (k / 9.0 - 0.5) * 100.0 * dy, 42.0 + 0.1 * k]
            for k in range(10)
        ]
        vol_collinear_100m = survey.calculate_cut_fill_volume(
            {
                "scan_id": "quchi_20261005_merged",
                "base_mode": "best_fit_plane",
                "polygon": collinear_100m,
            }
        )
        self.assertEqual(vol_collinear_100m["status"], "ok")
        self.assertEqual(vol_collinear_100m["best_fit_plane"]["slope_pct"], 0.0)
        self.assertEqual(vol_collinear_100m["best_fit_plane"]["a"], 0.0)
        self.assertEqual(vol_collinear_100m["best_fit_plane"]["b"], 0.0)

    def test_31_earthwork_mass_conservation(self):
        """M1 Verification: Earthwork Mass Conservation across BCM, LCM, CCM, and Conserved Mass Identity."""
        self._ensure_test_scan("quchi_20261005_merged")
        survey = SurveyingEngine(self.db)
        vol = survey.calculate_cut_fill_volume(
            {
                "scan_id": "quchi_20261005_merged",
                "base_mode": "best_fit_plane",
                "material_type": "excavated_soil",
                "density_t_m3": 1.45,
                "swell_factor": 0.80,  # Caterpillar load factor -> 1.25x expansion
                "shrinkage_factor": 0.10,  # 10% shrinkage -> 0.90x compaction
                "polygon": [
                    [304945.0, 2757078.0, 43.1],
                    [304960.0, 2757078.0, 43.1],
                    [304960.0, 2757090.0, 43.2],
                    [304945.0, 2757090.0, 43.2],
                ],
            }
        )
        self.assertEqual(vol["status"], "ok")
        # Check required fields exist
        self.assertIn("cut_volume_bcm", vol)
        self.assertIn("fill_volume_bcm", vol)
        self.assertIn("cut_volume_lcm", vol)
        self.assertIn("fill_volume_ccm", vol)
        self.assertIn("conserved_cut_mass_t", vol)
        self.assertIn("conserved_fill_mass_t", vol)

        cut_bcm = vol["cut_volume_bcm"]
        cut_lcm = vol["cut_volume_lcm"]
        fill_bcm = vol["fill_volume_bcm"]
        fill_ccm = vol["fill_volume_ccm"]
        cut_mass = vol["conserved_cut_mass_t"]

        # If cut volume exists, LCM must expand (swell_mult = 1.25)
        if cut_bcm > 0.0:
            self.assertGreater(cut_lcm, cut_bcm)
            self.assertAlmostEqual(cut_lcm, round(cut_bcm * 1.25, 2), places=1)
            # Physical Mass Invariance: M_cut = BCM * rho_bank == LCM * rho_loose
            rho_bank = 1.45
            rho_loose = rho_bank / 1.25
            mass_from_bank = round(cut_bcm * rho_bank, 2)
            mass_from_loose = round(cut_lcm * rho_loose, 2)
            self.assertEqual(cut_mass, mass_from_bank)
            self.assertAlmostEqual(cut_mass, mass_from_loose, places=1)

        # If fill volume exists, CCM must compact (compaction_mult = 0.90)
        if fill_bcm > 0.0:
            self.assertLess(fill_ccm, fill_bcm)
            self.assertAlmostEqual(fill_ccm, round(fill_bcm * 0.90, 2), places=1)

        # Robust sanitization test: empty strings and invalid tokens do not crash
        vol_sanitized = survey.calculate_cut_fill_volume(
            {
                "scan_id": "quchi_20261005_merged",
                "base_mode": "best_fit_plane",
                "swell_factor": "",
                "shrinkage_factor": "   ",
                "density_t_m3": "not_a_num",
            }
        )
        self.assertEqual(vol_sanitized["status"], "ok")

    def test_32_dump_truck_dual_constraint_estimator(self):
        """M1 Verification: Dump Truck Load Estimator (Volume-limited vs Weight-limited haul trips)."""
        self._ensure_test_scan("quchi_20261005_merged")
        survey = SurveyingEngine(self.db)
        # Case A: Light material (1.1 t/m³) with custom truck volume (15 m³) and payload (25 t) -> volume limited
        vol_light = survey.calculate_cut_fill_volume(
            {
                "scan_id": "quchi_20261005_merged",
                "base_mode": "best_fit_plane",
                "density_t_m3": 1.10,
                "swell_factor": 1.30,
                "truck_volume_m3": 15.0,
                "truck_max_tonnes": 25.0,
            }
        )
        self.assertIn("truck_loads_cut", vol_light)
        self.assertIn("truck_limiting_factor", vol_light)
        self.assertIn("net_haul_direction", vol_light)
        self.assertIn("net_truck_loads", vol_light)
        if vol_light["cut_volume_bcm"] > 0:
            self.assertEqual(vol_light["truck_limiting_factor"], "volume")

        # Case B: Heavy material (2.5 t/m³) with standard truck (15 m³, 18 t) -> weight limited
        vol_heavy = survey.calculate_cut_fill_volume(
            {
                "scan_id": "quchi_20261005_merged",
                "base_mode": "best_fit_plane",
                "density_t_m3": 2.50,
                "swell_factor": 1.10,
                "truck_volume_m3": 15.0,
                "truck_max_tonnes": 18.0,
            }
        )
        if vol_heavy["cut_volume_bcm"] > 0:
            self.assertEqual(vol_heavy["truck_limiting_factor"], "weight")

        # Robust sanitization test: empty/invalid truck parameters fallback gracefully
        vol_truck_safe = survey.calculate_cut_fill_volume(
            {
                "scan_id": "quchi_20261005_merged",
                "truck_volume_m3": "",
                "truck_max_tonnes": "undefined",
            }
        )
        self.assertEqual(vol_truck_safe["status"], "ok")
        self.assertIn("truck_loads_cut", vol_truck_safe)

    def test_33_geoid_catalog_synchronization_and_overrides(self):
        """M1 Verification: UTM51N / UTM50N vertical geoid offsets synchronized and user override support."""
        self._ensure_test_scan("quchi_20261005_merged")
        from pc_worker.optimizer_bridge import CRS_DEFINITIONS, transform_scan_crs

        # 1. Backend CRS catalog verification
        self.assertEqual(CRS_DEFINITIONS["WGS84_UTM51N"]["h_offset_from_twvd"], 17.20)
        self.assertEqual(CRS_DEFINITIONS["WGS84_UTM50N"]["h_offset_from_twvd"], 16.80)

        # 2. Frontend catalog source code verification
        js_path = os.path.join(BASE_DIR, "web", "src", "06-studio-align-and-optimizer.js")
        with open(js_path, "r", encoding="utf-8") as f:
            js_src = f.read()

        # Must have 17.20 and 16.80 for UTM51N and UTM50N
        self.assertIn('code: "WGS84_UTM51N"', js_src)
        self.assertIn("hOff: 17.20", js_src)
        self.assertIn('code: "WGS84_UTM50N"', js_src)
        self.assertIn("hOff: 16.80", js_src)
        self.assertNotIn("hOff: 20.6", js_src)
        self.assertNotIn("hOff: 19.8", js_src)

        # Must have numGeoidOffset and btnResetGeoidOffset in inspector
        self.assertIn('id="numGeoidOffset"', js_src)
        self.assertIn('id="btnResetGeoidOffset"', js_src)
        self.assertIn("geoid_offset_override", js_src)

        # 3. User Geoid Offset Override in calculate_cut_fill_volume
        survey = SurveyingEngine(self.db)
        res_vol = survey.calculate_cut_fill_volume(
            {
                "scan_id": "quchi_20261005_merged",
                "geoid_offset_override": 18.45,
            }
        )
        self.assertEqual(res_vol["status"], "ok")
        self.assertEqual(res_vol["geoid_offset_override"], 18.45)
        self.assertEqual(res_vol["geoid_offset_m"], 18.45)

        # 4. User Geoid Offset Override in compute_gcp_accuracy_qa
        res_qa = survey.compute_gcp_accuracy_qa(
            {
                "scan_id": "quchi_20261005_merged",
                "geoid_offset_override": 17.50,
            }
        )
        self.assertEqual(res_qa["status"], "ok")
        self.assertEqual(res_qa["geoid_offset_override"], 17.50)
        self.assertTrue(res_qa["geoid_offset_applied"])

        # 5. Robust sanitization test: empty strings and invalid tokens do not throw unhandled ValueError
        res_vol_empty = survey.calculate_cut_fill_volume(
            {
                "scan_id": "quchi_20261005_merged",
                "geoid_offset_override": "",
            }
        )
        self.assertEqual(res_vol_empty["status"], "ok")

        res_qa_empty = survey.compute_gcp_accuracy_qa(
            {
                "scan_id": "quchi_20261005_merged",
                "geoid_offset_override": "invalid_geoid",
            }
        )
        self.assertEqual(res_qa_empty["status"], "ok")

    def test_34_compound_coordinate_adversarial_input_resilience(self):
        """M1 Iteration 3 Remediation: Verifies compound coordinate dictionary/array parsing resilience without 500 crashes."""
        self._ensure_test_scan("quchi_20261005_merged")
        from pc_worker.optimizer_bridge import OptimizerBridge

        survey = SurveyingEngine(self.db)
        opt = OptimizerBridge(self.db)

        # 1. /api/survey/gcp-qa: Empty strings, whitespace, and invalid non-numeric tokens
        res_qa_malformed = survey.compute_gcp_accuracy_qa(
            {
                "scan_id": "quchi_20261005_merged",
                "points": [
                    {"name": "CP_BAD_1", "e": "", "n": "  ", "h_gcp": "invalid"},
                    {"name": "CP_BAD_2", "e": "none", "n": "null", "h_gcp": ""},
                    {"name": "CP_VALID_1", "e": 304950.0, "n": 2757080.0, "h_gcp": 125.0, "h_scan": "125.04"},
                ],
            }
        )
        self.assertEqual(res_qa_malformed["status"], "ok")
        self.assertEqual(res_qa_malformed["point_count"], 1)
        self.assertEqual(res_qa_malformed["points"][0]["name"], "CP_VALID_1")

        # Completely invalid point list handles gracefully without crashing
        res_qa_all_invalid = survey.compute_gcp_accuracy_qa(
            {
                "scan_id": "quchi_20261005_merged",
                "points": [{"name": "CP_BAD", "e": "", "n": "abc"}],
            }
        )
        self.assertEqual(res_qa_all_invalid["status"], "ok")
        self.assertEqual(res_qa_all_invalid["point_count"], 0)

        # 2. /api/survey/volume: Malformed polygon vertices return clean error instead of 500 crash
        res_vol_invalid = survey.calculate_cut_fill_volume(
            {
                "scan_id": "quchi_20261005_merged",
                "polygon": [{"x": "", "z": "  "}, {"x": "bad", "z": 10}],
            }
        )
        self.assertEqual(res_vol_invalid["status"], "error")
        self.assertIn("at least 3 valid coordinate points", res_vol_invalid["error"])
        self.assertLess(res_vol_invalid["valid_points_count"], 3)

        # Mixed valid/invalid vertices with >= 3 valid vertices succeeds cleanly
        res_vol_mixed = survey.calculate_cut_fill_volume(
            {
                "scan_id": "quchi_20261005_merged",
                "polygon": [
                    {"x": "", "z": "bad"},
                    {"x": -5.0, "z": -5.0},
                    {"x": "none", "z": "null"},
                    {"x": 5.0, "z": -5.0},
                    {"x": 0.0, "z": 5.0},
                ],
            }
        )
        self.assertEqual(res_vol_mixed["status"], "ok")
        self.assertGreater(res_vol_mixed["planar_area_m2"], 0.0)

        # 3. /api/survey/contours: Empty string / whitespace intervals fallback safely
        res_contours = survey.generate_elevation_contours(
            {
                "scan_id": "quchi_20261005_merged",
                "minor_interval_m": "",
                "major_interval_m": "   ",
            }
        )
        self.assertEqual(res_contours["status"], "ok")
        self.assertGreaterEqual(res_contours["minor_interval_m"], 0.1)
        self.assertGreaterEqual(res_contours["major_interval_m"], res_contours["minor_interval_m"])

        # 4. /api/survey/profile: Empty strings/whitespace in start_point and end_point
        res_prof = survey.compute_cross_section_profile(
            {
                "scan_id": "quchi_20261005_merged",
                "start_point": {"x": "", "z": "  "},
                "end_point": {"x": "invalid", "z": ""},
            }
        )
        self.assertEqual(res_prof["status"], "ok")
        self.assertGreater(len(res_prof["samples"]), 0)

        # 5. /api/survey/inspect-photos: Empty strings/whitespace in click coordinates
        res_photos = survey.inspect_rtk_camera_photos(
            {
                "scan_id": "quchi_20261005_merged",
                "x": "",
                "y": "  ",
                "z": "bad",
                "max_radius_m": "",
                "limit": "   ",
            }
        )
        self.assertEqual(res_photos["status"], "ok")

        # 6. /api/optimizer/generate-scan: crop_keep empty strings & invalid elevation tokens
        with self.assertRaises(ValueError) as cm:
            opt.run_generate_scan_action(
                {
                    "scan_id": "quchi_20261005_merged",
                    "crop_keep": {"min_elev": "", "max_elev": "bad"},
                }
            )
        self.assertIn("Please stage at least one adjustment", str(cm.exception))

    def test_35_milestone2_control_alignment_and_3d_gcp_calibration(self):
        """Milestone 2 Verification: 3D GCP residuals, ASPRS 95% confidence accuracies, and 1-click TBM calibration."""
        self._ensure_test_scan("quchi_20261005_merged")
        from pc_worker.surveying_engine import SurveyingEngine

        survey = SurveyingEngine(self.db)
        sid = "quchi_20261005_merged"

        # 1. 3D GCP Target Pairing & Residuals
        payload = {
            "scan_id": sid,
            "points": [
                {"name": "GCP_01", "e": 304950.0, "n": 2757080.0, "h_gcp": 125.0, "mesh_e": 304950.02, "mesh_n": 2757080.01, "mesh_h": 125.04},
                {"name": "GCP_02", "e": 304960.0, "n": 2757090.0, "h_gcp": 126.0, "mesh_e": 304959.98, "mesh_n": 2757089.99, "mesh_h": 126.02},
            ],
        }
        res = survey.compute_gcp_accuracy_qa(payload)
        self.assertEqual(res["status"], "ok")
        self.assertEqual(res["point_count"], 2)
        self.assertIn("gcp_residuals", res)
        self.assertIn("rmse_3d", res)
        self.assertIn("rmse_2d", res)
        self.assertIn("accuracy_z_95_m", res)
        self.assertIn("accuracy_r_95_m", res)
        self.assertIn("accuracy_3d_95_m", res)
        self.assertIn("tbm_calibration_preview", res)

        # Legacy backward-compatible keys
        self.assertIn("points", res)
        self.assertIn("rmse_z_m", res)
        self.assertIn("rmse_z_cm", res)
        self.assertIn("qa_grade", res)

        # 2. 1-Click TBM Calibration Application & Persistence
        res_cal = survey.compute_gcp_accuracy_qa({
            "scan_id": sid,
            "points": [
                {"name": "TBM_01", "e": 304950.0, "n": 2757080.0, "h_gcp": 125.0, "mesh_h": 125.25, "is_tbm": True},
            ],
            "apply_tbm_calibration": True,
        })
        self.assertEqual(res_cal["status"], "ok")
        self.assertTrue(res_cal["tbm_applied"])
        self.assertAlmostEqual(res_cal["tbm_shift_m"], -0.250, places=3)

        # Verify DB persistence & resolver
        shift_resolved = survey._resolve_vertical_datum_shift(sid)
        self.assertAlmostEqual(shift_resolved, -0.250, places=3)

        # 3. Reset calibration
        res_reset = survey.compute_gcp_accuracy_qa({
            "scan_id": sid,
            "points": [],
            "reset_calibration": True,
            "apply_tbm_calibration": True,
        })
        self.assertEqual(res_reset["status"], "ok")
        self.assertFalse(res_reset["tbm_applied"])
        self.assertAlmostEqual(survey._resolve_vertical_datum_shift(sid), 0.0, places=3)

        # 4. Verify frontend assets & service worker registration
        with open(os.path.join(BASE_DIR, "web", "index.html"), "r", encoding="utf-8") as f:
            index_html = f.read()
        with open(os.path.join(BASE_DIR, "web", "sw.js"), "r", encoding="utf-8") as f:
            sw_js = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "09-construction-survey-and-bim.js"), "r", encoding="utf-8") as f:
            js09 = f.read()

        self.assertTrue(re.search(r"/survey-bim\.css\?v=\d{8}_v\d+", index_html))
        self.assertIn("/survey-bim.css", sw_js)
        self.assertTrue(re.search(r"gathering-scans-offline-v\d+", sw_js))
        self.assertIn("openEnhancedGcpAccuracyQaInspector", js09)
        self.assertIn("renderEnhancedGcpQaMarkers3D", js09)
        self.assertIn("window.openGcpAccuracyQaInspector", js09)

        # 5. Strict UI/UX Remediation verification: Zero Unicode emojis & Dual Theme support
        emoji_pattern = re.compile(r"[\U00010000-\U0010ffff]|[\u2600-\u27bf]|[\u2300-\u23ff]|[\u2b50-\u2b55]|[\u203c-\u2049]")
        self.assertEqual(len(emoji_pattern.findall(js09)), 0, "Zero emojis allowed in 09-construction-survey-and-bim.js")
        self.assertIn("SVG_ICONS", js09)

        with open(os.path.join(BASE_DIR, "web", "survey-bim.css"), "r", encoding="utf-8") as f:
            css_bim = f.read()
        self.assertEqual(len(emoji_pattern.findall(css_bim)), 0, "Zero emojis allowed in web/survey-bim.css")
        self.assertIn('html[data-theme="light"]', css_bim)
        self.assertIn('html[data-theme="dark"]', css_bim)
        self.assertIn('body.theme-light', css_bim)
        self.assertIn('body.theme-dark', css_bim)

    def test_36_milestone3_stationing_aea_and_drainage_ponding(self):
        """
        Milestone 3 Verification: Centerline Stationing (0K+000), Average-End-Area (AEA)
        Cut/Fill Volume, and Surface Drainage Depression Ponding Volume Takeoff (V_water m³).
        """
        self._ensure_test_scan("quchi_20261005_merged")
        from pc_worker.surveying_engine import SurveyingEngine
        survey = SurveyingEngine(self.db)
        sid = "quchi_20261005_merged"

        # 1. Verify Centerline Stationing & AEA Calculation
        stationing_payload = {
            "scan_id": sid,
            "alignment": [[304910.0, 2757050.0], [304950.0, 2757050.0]],
            "interval": 10.0,
            "swath_width": 14.0,
            "template_type": "roadway",
            "road_width": 7.0,
            "cross_slope_pct": 2.0,
        }
        res_station = survey.compute_centerline_stationing_and_volume(stationing_payload)
        self.assertEqual(res_station["status"], "ok")
        self.assertAlmostEqual(res_station["total_length_m"], 40.0, places=1)
        self.assertEqual(res_station["station_count"], 5)
        self.assertEqual(res_station["stations"][0]["chainage_code"], "0K+000.00")
        self.assertEqual(res_station["stations"][-1]["chainage_code"], "0K+040.00")
        self.assertIn("total_cut_volume_m3", res_station)
        self.assertIn("total_fill_volume_m3", res_station)
        self.assertIn("earthwork_schedule", res_station)
        self.assertIn("haul_trucks", res_station["earthwork_schedule"])

        # 2. Verify Surface Drainage & Priority-Flood Depression Takeoff
        drainage_payload = {
            "scan_id": sid,
            "custom_slope_tiers": [0.01, 0.02, 0.05, 0.10],
            "min_ponding_depth_m": 0.05,
        }
        res_drainage = survey.compute_drainage_and_slope(drainage_payload)
        self.assertEqual(res_drainage["status"], "ok")
        self.assertTrue(res_drainage["custom_tiers_applied"])
        self.assertEqual(len(res_drainage["tiers"]), 5)
        self.assertIn("depressions", res_drainage)
        self.assertIn("total_ponding_volume_m3", res_drainage)
        self.assertIn("max_ponding_depth_m", res_drainage)

        # 3. Verify Frontend Module 09 & CSS Integration
        with open(os.path.join(BASE_DIR, "web", "src", "09-construction-survey-and-bim.js"), "r", encoding="utf-8") as f:
            js09 = f.read()
        self.assertIn("openEnhancedStationingAndAeaInspector", js09)
        self.assertIn("openEnhancedDrainageAndPondingInspector", js09)

        # 4. Strict Zero Emoji Check
        emoji_pattern = re.compile(r"[\U00010000-\U0010ffff]|[\u2600-\u27bf]|[\u2300-\u23ff]|[\u2b50-\u2b55]|[\u203c-\u2049]")
        self.assertEqual(len(emoji_pattern.findall(js09)), 0, "Zero Unicode emojis allowed in 09-construction-survey-and-bim.js")

    def test_37_trees_tool_and_scan_to_bim_removal(self):
        """
        Verify Scan-to-BIM is completely removed and replaced with a dedicated
        Trees & 1.3m Trunk DBH tool across Studio UI and backend heuristics.
        """
        with open(os.path.join(BASE_DIR, "web", "index.html"), "r", encoding="utf-8") as f:
            index_html = f.read()
        with open(os.path.join(BASE_DIR, "web", "sw.js"), "r", encoding="utf-8") as f:
            sw_js = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "05-studio-civil-inspectors.js"), "r", encoding="utf-8") as f:
            js05 = f.read()
        with open(os.path.join(BASE_DIR, "pc_worker", "surveying", "categorization_heuristics.py"), "r", encoding="utf-8") as f:
            heur_py = f.read()

        # 1. Verify Scan-to-BIM files, API routes, and UI buttons are removed
        self.assertFalse(os.path.isfile(os.path.join(BASE_DIR, "web", "src", "11-scan-to-bim-primitives.js")))
        self.assertFalse(os.path.isfile(os.path.join(BASE_DIR, "pc_worker", "surveying", "scan_to_bim.py")))
        with open(os.path.join(BASE_DIR, "pc_worker", "server_api_routes.py"), "r", encoding="utf-8") as f:
            routes_py = f.read()
        self.assertNotIn("/api/survey/scan-to-bim", routes_py)
        self.assertNotIn("fit_scan_to_bim_primitives", routes_py)
        self.assertNotIn("export_scan_to_bim", routes_py)
        self.assertNotIn("11-scan-to-bim-primitives.js", index_html)
        self.assertNotIn("/src/11-scan-to-bim-primitives.js", sw_js)
        self.assertNotIn('id="btnStudioBim"', index_html)
        self.assertNotIn("btnCatLaunchScanToBim", js05)

        # 2. Verify dedicated Trees & 1.3m DBH dock tool and inspector
        self.assertIn('id="btnDockCategorize"', index_html)
        self.assertIn('data-i18n-zh="樹木" data-i18n-en="Trees"', index_html)
        self.assertIn("🌳 AI Trees & 1.3m Trunk DBH", js05)
        self.assertIn("STATE.categorizeFilters = { roads: false, trees: true, water: false, walls: false, stockpiles: false };", js05)

        # 3. Verify chlorophyll blue/red-absorption (gb_diff, rb_diff) and building column / court pole rejection in heuristics
        self.assertIn("gb_diff = rgb[:, 1] - rgb[:, 2]", heur_py)
        self.assertIn("fol_tri_mask = (exg >= 0.038) & (rb_diff >= -0.055)", heur_py)
        self.assertIn("roof_soffit_a =", heur_py)
        self.assertIn("wall_facade_a =", heur_py)
        self.assertIn("bldg_to_fol_ratio =", heur_py)

        # 4. Verify UI policy (no AI explanation boxes, 0-1 word buttons, 3D mesh catItemId raycasting) & VPS manual_remove handling
        self.assertNotIn("Combines <b>3D Mesh Geometry</b>", js05)
        self.assertNotIn("1.3m Pratt Circle + AI Vision Verified", js05)
        self.assertNotIn('id="btnToggleCategorizeOverlayVis"', js05)
        self.assertIn('<span>${treeIconSvg}${tr("樹木", "Trees")}</span>', js05)
        self.assertIn('tr("偵測", "Detect")', js05)
        self.assertIn('tr("重算", "Recompute")', js05)
        self.assertIn('tr("新增", "Add")', js05)
        self.assertIn('tr("刪除", "Remove")', js05)
        self.assertIn('tr("重設", "Reset")', js05)
        self.assertIn("trunkMesh.userData.catItemId = t.id;", js05)
        self.assertIn('trunkMesh.userData.catPart = "trunk";', js05)
        with open(os.path.join(BASE_DIR, "web", "src", "04-studio-lasso-and-edits.js"), "r", encoding="utf-8") as f:
            js04 = f.read()
        self.assertIn('cpart === "trunk" || cpart === "dbh_ring"', js04)
        self.assertIn("vlow_trunk_m =", heur_py)
        self.assertIn("def _stem_cyl_stats(", heur_py)
        with open(os.path.join(BASE_DIR, "pc_worker", "surveying", "contours_and_cad.py"), "r", encoding="utf-8") as f:
            contours_py = f.read()
        self.assertNotIn("qihutender_1", contours_py.lower())
        with open(os.path.join(BASE_DIR, "pc_worker", "server_cloud_and_tunnel.py"), "r", encoding="utf-8") as f:
            tunnel_py = f.read()
        self.assertIn('elif req_action in ("manual_remove", "manual_add", "manual_reset"):', tunnel_py)
        self.assertIn("upd_cat = SURVEY.modify_saved_categorization(req_sid, p_obj)", tunnel_py)
        self.assertIn('cat_obj_chk = json.loads(raw_cat_chk.decode("utf-8"))', tunnel_py)
        self.assertIn("saved_cat_fb = SURVEY.get_saved_categorization(req_sid_fb)", tunnel_py)

        # 5. Verify sequential manual_remove (no id vs orig_id double-deletion), manual_add, and manual_reset on cached scans
        import copy
        import json
        from unittest.mock import patch

        q_path = os.path.join(BASE_DIR, "data", "categorization_cache", "QuChi261016_Trees_categorization_v3.json")
        with open(q_path, "r", encoding="utf-8") as f:
            orig_cat = json.load(f)
        self.assertTrue(isinstance(orig_cat.get("_base_trees"), list) and len(orig_cat["_base_trees"]) == len(orig_cat["trees"]))
        working_cat = copy.deepcopy(orig_cat)
        with patch.object(self.survey, "get_saved_categorization", side_effect=lambda sid, scan=None: working_cat), \
             patch.object(self.survey, "categorize_scan_surfaces_and_objects", side_effect=RuntimeError("VPS mode")), \
             patch.object(self.survey, "_write_categorization_deliverables"), \
             patch.object(self.survey, "_persist_categorization_result"):
            working_cat = self.survey.modify_saved_categorization(
                "QuChi261016_Trees", {"action": "manual_remove", "item_id": "T4", "category": "trees"}
            )
            self.assertEqual(len(working_cat["trees"]), len(orig_cat["trees"]) - 1)
            working_cat = self.survey.modify_saved_categorization(
                "QuChi261016_Trees", {"action": "manual_remove", "item_id": "T5", "category": "trees"}
            )
            self.assertEqual(len(working_cat["trees"]), len(orig_cat["trees"]) - 2)
            self.assertEqual([t["orig_id"] for t in working_cat["trees"][:5]], ["T1", "T2", "T3", "T5", "T7"])
            working_cat = self.survey.modify_saved_categorization(
                "QuChi261016_Trees",
                {"action": "manual_add", "category": "trees", "item": {"trunk_local": [5.0, 0.0, 5.0], "auto_measure": True}},
            )
            self.assertEqual(len(working_cat["trees"]), len(orig_cat["trees"]) - 1)
            self.assertEqual(working_cat["trees"][-1]["id"], "TM1")
            working_cat = self.survey.modify_saved_categorization(
                "QuChi261016_Trees",
                {"action": "manual_add", "category": "trees", "item": {"trunk_local": [8.0, 0.0, 8.0], "auto_measure": True}},
            )
            self.assertEqual(working_cat["trees"][-1]["id"], "TM2")
            working_cat = self.survey.modify_saved_categorization(
                "QuChi261016_Trees", {"action": "manual_remove", "item_id": "TM1", "category": "trees"}
            )
            self.assertNotIn("TM1", [t["id"] for t in working_cat["trees"]])
            self.assertNotIn("TM1", (working_cat.get("manual_overrides") or {}).get("removed_ids") or [])
            working_cat = self.survey.modify_saved_categorization(
                "QuChi261016_Trees",
                {"action": "manual_add", "category": "trees", "item": {"trunk_local": [10.0, 0.0, 10.0], "auto_measure": True}},
            )
            self.assertEqual(working_cat["trees"][-1]["id"], "TM3")
            self.assertEqual(len(set(t["id"] for t in working_cat["trees"])), len(working_cat["trees"]))
            working_cat = self.survey.modify_saved_categorization("QuChi261016_Trees", {"action": "manual_reset"})
            self.assertEqual(len(working_cat["trees"]), len(orig_cat["trees"]))
            self.assertEqual([t["orig_id"] for t in working_cat["trees"][:6]], ["T1", "T2", "T3", "T4", "T5", "T6"])

    def test_38_milestone7_public_utilities_gis_and_gml_integration(self):
        """
        Milestone 7 Verification: Real Public Utilities GIS Integration with Taiwan Open APIs,
        10 layer toggles with color coding, animated 3D flow direction, MOI NGIS GML 3.1.1 parser,
        strictly 0 fake/mocked data, and pure Python DXF/GeoJSON exporters.
        """
        self._ensure_test_scan("rosepark_20260918_merged")
        from pc_worker.surveying_engine import SurveyingEngine
        from pc_worker.surveying.public_utilities_gis import UTILITY_LAYERS
        from pc_worker.config import REPORTS_DIR

        survey = SurveyingEngine(self.db)
        sid = "rosepark_20260918_merged"

        # 1. Verify 10 layer toggles & color coding
        self.assertEqual(len(UTILITY_LAYERS), 10)
        expected_colors = {
            "storm": "#06b6d4",
            "sanitary": "#d97706",
            "water": "#3b82f6",
            "electric": "#ef4444",
            "telecom": "#10b981",
            "gas": "#eab308",
            "ducts": "#8b5cf6",
            "streetlights": "#f59e0b",
            "excavations": "#ec4899",
            "as_built": "#14b8a6",
        }
        for lid, col in expected_colors.items():
            self.assertIn(lid, UTILITY_LAYERS)
            self.assertEqual(UTILITY_LAYERS[lid]["color"].lower(), col.lower())

        # 2. Verify MOI NGIS GML 3.1.1 XML parsing
        gml_text = """<?xml version="1.0" encoding="UTF-8"?>
<ngis:FeatureCollection xmlns:gml="http://www.opengis.net/gml" xmlns:ngis="http://ngis.moi.gov.tw">
  <ngis:Pipe gml:id="P1">
    <ngis:PIPE_ID>SP-101</ngis:PIPE_ID>
    <ngis:LAYER>storm</ngis:LAYER>
    <ngis:DIAMETER>600</ngis:DIAMETER>
    <ngis:MATERIAL>RCP</ngis:MATERIAL>
    <ngis:FLOW_DIR>1</ngis:FLOW_DIR>
    <gml:curveProperty>
      <gml:LineString srsName="EPSG:3826">
        <gml:posList>295900.0 2768500.0 10.5 295940.0 2768530.0 10.15</gml:posList>
      </gml:LineString>
    </gml:curveProperty>
  </ngis:Pipe>
  <ngis:Manhole gml:id="MH1">
    <ngis:FACILITY_ID>MH-01</ngis:FACILITY_ID>
    <ngis:LAYER>storm</ngis:LAYER>
    <ngis:DEPTH>2.8</ngis:DEPTH>
    <gml:pointProperty>
      <gml:Point srsName="EPSG:3826">
        <gml:pos>295900.0 2768500.0 10.5</gml:pos>
      </gml:Point>
    </gml:pointProperty>
  </ngis:Manhole>
</ngis:FeatureCollection>"""

        res_gml = survey.parse_utilities_file({"file_content": gml_text, "filename": "sample.gml"})
        self.assertEqual(res_gml["status"], "ok")
        self.assertEqual(res_gml["total_features"], 2)
        pipe = next(f for f in res_gml["features"] if f["type"] == "pipe")
        self.assertEqual(pipe["diameter_mm"], 600)
        self.assertEqual(pipe["flow_direction"], 1)

        # 3. Query genuine public utilities around scan coordinates
        res_q = survey.query_public_utilities_gis({"scan_id": sid, "radius_m": 120.0})
        self.assertEqual(res_q["status"], "ok")
        self.assertIn("crs", res_q)
        self.assertIn("layers", res_q)
        self.assertIn("layer_counts", res_q)

        # 4. Strict Zero Fake Data Integrity: Unpopulated coordinates must return 0 features
        res_offshore = survey.query_public_utilities_gis({
            "center_e": 100000.0,
            "center_n": 2500000.0,
            "radius_m": 50.0,
            "force_refresh": True,
        })
        self.assertEqual(res_offshore["status"], "ok")
        self.assertEqual(res_offshore["total_features"], 0)
        self.assertEqual(len(res_offshore["features"]), 0)

        # 5. Export to GeoJSON and DXF
        res_exp = survey.export_utilities_dataset({
            "scan_id": sid,
            "format": "dxf",
            "features": res_gml["features"],
        })
        self.assertEqual(res_exp["status"], "ok")
        self.assertTrue(os.path.isfile(os.path.join(REPORTS_DIR, res_exp["filename"])))

        # 6. Verify Frontend Module 12 & Zero Emojis
        js12_path = os.path.join(BASE_DIR, "web", "src", "12-public-utilities-gis.js")
        self.assertTrue(os.path.isfile(js12_path))
        with open(js12_path, "r", encoding="utf-8") as f:
            js12 = f.read()
        self.assertIn("openUtilitiesInspector", js12)
        self.assertIn("renderUtilities3D", js12)

        emoji_pattern = re.compile(r"[\U00010000-\U0010ffff]|[\u2600-\u27bf]|[\u2300-\u23ff]|[\u2b50-\u2b55]|[\u203c-\u2049]")
        self.assertEqual(len(emoji_pattern.findall(js12)), 0, "Zero Unicode emojis allowed in 12-public-utilities-gis.js")

        with open(os.path.join(BASE_DIR, "web", "index.html"), "r", encoding="utf-8") as f:
            index_html = f.read()
        with open(os.path.join(BASE_DIR, "web", "sw.js"), "r", encoding="utf-8") as f:
            sw_js = f.read()
        self.assertIn("12-public-utilities-gis.js", index_html)
        self.assertIn("btnDockUtilities", index_html)
        self.assertIn("/src/12-public-utilities-gis.js", sw_js)

    def test_39_milestone4_milestone5_construction_qa_and_stakeout(self):
        """
        Milestone 4 & Milestone 5 Verification:
        1. 3D Surface Flatness & Plumbness Inspector (ASTM E1155, horizontal/vertical/best-fit,
           tolerance heatmap, Pass Rate %, Max High / Max Low, plumb tilt ratio).
        2. Open-Trench Utility 3D Tracer (invert/crown elevation, pipe diameter, gradient % and 1:N,
           depth of cover, DXF/CSV export).
        3. Compare View ΔV Volume Takeoff (polygon-bounded cut/fill, mass conservation, haul trips).
        4. RTK Stakeout Export strictly in Easting, Northing, Elevation (E, N, Z) order:
           PtID, Easting, Northing, Elevation, Code format with printable field sheet.
        5. Frontend Module 10 validation:
           - web/src/10-construction-qa-and-stakeout.js exists and is < 5,000 lines
           - Zero Unicode emojis check
           - Registration in web/index.html and web/sw.js
        """
        from pc_worker.surveying_engine import SurveyingEngine
        survey = SurveyingEngine(self.db)
        self._ensure_test_scan("quchi_20261005_merged")
        sid = "quchi_20261005_merged"

        # 1. Surface Flatness & Plumbness Inspector
        flat_res = survey.compute_surface_flatness_and_plumbness({
            "scan_id": sid,
            "reference_mode": "horizontal",
            "tolerance_mm": 10.0,
        })
        self.assertEqual(flat_res["status"], "ok")
        self.assertIn("pass_rate_pct", flat_res)
        self.assertIn("max_high", flat_res)
        self.assertIn("max_low", flat_res)
        self.assertIn("astm_e1155", flat_res)
        self.assertIn("plumb_tilt", flat_res)

        # 2. Open-Trench Utility 3D Tracer
        util_res = survey.trace_open_trench_utility({
            "scan_id": sid,
            "pipe_type": "SEWER",
            "pipe_diameter_mm": 300.0,
            "trench_points": [
                {"e": 304950.0, "n": 2757080.0, "h": 120.0, "name": "MH-01"},
                {"e": 304980.0, "n": 2757120.0, "h": 119.0, "name": "P-02"},
            ],
        })
        self.assertEqual(util_res["status"], "ok")
        self.assertAlmostEqual(util_res["total_length_2d_m"], 50.0, places=1)
        self.assertIn("csv_export", util_res)
        self.assertIn("dxf_export", util_res)

        # 3. Compare View ΔV Volume Takeoff
        cmp_res = survey.compute_compare_volume_takeoff({
            "baseline_scan_id": sid,
            "compare_scan_id": sid,
            "polygon": [
                {"e": 304940.0, "n": 2757070.0},
                {"e": 304960.0, "n": 2757070.0},
                {"e": 304960.0, "n": 2757090.0},
                {"e": 304940.0, "n": 2757090.0},
            ],
            "material_type": "common_earth",
        })
        self.assertEqual(cmp_res["status"], "ok")
        self.assertIn("net_volume_delta_m3", cmp_res)
        self.assertIn("site_balance", cmp_res)

        # 4. RTK Stakeout Export strictly in E N Z order
        stk_res = survey.generate_stakeout_export({
            "scan_id": sid,
            "points": [
                {"id": "STK-1", "e": 304950.123, "n": 2757080.456, "z": 125.789, "code": "CORNER_1"},
            ],
        })
        self.assertEqual(stk_res["status"], "ok")
        self.assertEqual(stk_res["point_count"], 1)
        csv_lines = [l for l in stk_res["csv_export"].splitlines() if not l.startswith("#")]
        self.assertEqual(csv_lines[0], "PtID,Easting,Northing,Elevation,Code")
        self.assertEqual(csv_lines[1], "STK-1,304950.123,2757080.456,125.789,CORNER_1")
        self.assertIn("html_field_sheet", stk_res)
        self.assertIn("Design E (m)", stk_res["html_field_sheet"])
        self.assertIn("Design N (m)", stk_res["html_field_sheet"])
        self.assertIn("Design Z (m)", stk_res["html_field_sheet"])

        # 5. Frontend Module 10 validation
        js10_path = os.path.join(BASE_DIR, "web", "src", "10-construction-qa-and-stakeout.js")
        self.assertTrue(os.path.isfile(js10_path))
        with open(js10_path, "r", encoding="utf-8") as f:
            js10 = f.read()
        self.assertIn("openSurfaceFlatnessQaInspector", js10)
        self.assertIn("openUtilityTracerInspector", js10)
        self.assertIn("openCompareVolumeTakeoffInspector", js10)
        self.assertIn("openRtkStakeoutInspector", js10)

        emoji_pattern = re.compile(r"[\U00010000-\U0010ffff]|[\u2600-\u27bf]|[\u2300-\u23ff]|[\u2b50-\u2b55]|[\u203c-\u2049]")
        self.assertEqual(len(emoji_pattern.findall(js10)), 0, "Zero Unicode emojis allowed in 10-construction-qa-and-stakeout.js")

        with open(os.path.join(BASE_DIR, "web", "index.html"), "r", encoding="utf-8") as f:
            index_html = f.read()
        with open(os.path.join(BASE_DIR, "web", "sw.js"), "r", encoding="utf-8") as f:
            sw_js = f.read()
        self.assertIn("10-construction-qa-and-stakeout.js", index_html)
        self.assertIn("/src/10-construction-qa-and-stakeout.js", sw_js)

    def test_40_lishan_ntudorm_rosepark_utilities_flatten_zones_and_ai_bim(self):
        """
        Verify:
        1. Lishan (catch_LishanFinal_HQ) preserves 109m East street way 26790664 (內湖路一段629巷),
           clips synthesized road corridors outside site_poly (track/court), and attaches gov GIS/API/OSM/NLSC URLs.
        2. RosePark (rosepark_20260918_merged) manhole & sewer counts never decrease when expanding radius 120m -> 250m.
        3. NTU Dorm (ntudorm_20260917_foundation) local-origin scan TWD97 coordinate conversion fix in localToTwd97.
        4. Slope-preserving zone mesh flattening (_apply_slope_preserving_flatten_zones_to_tileset) and
           experimental scan edited_lishan_track_flattened_exp_copy_449912 while preserving original catch_LishanFinal.
        5. Studio UI Dock exposes Flatness (#btnDockFlatness), Trench (#btnDockTrench), Stakeout (#btnDockStakeout),
           Flatten (#btnDockFlatten), Bookmarks (#btnDockBookmarks), Utilities (#btnDockUtilities), BIM (#btnStudioBim),
           and Compare ΔV (#btnCompareDeltaV).
        6. Gemini 3.8 Flash AI-Assisted Scan-to-BIM reasoning (_run_gemini_ai_bim_reasoning).
        """
        import json
        from pc_worker.surveying_engine import SurveyingEngine
        from pc_worker.config import LOCAL_SCANS_ROOT as SCANS_ROOT_DIR

        survey = SurveyingEngine(self.db)

        # 1. Lishan utilities: genuine Taipei 8-Utility features & single exact upstream source link per feature
        lishan_res = survey.query_public_utilities_gis({"scan_id": "catch_LishanFinal_HQ", "radius_m": 120.0})
        self.assertEqual(lishan_res.get("status"), "ok")
        l_feats = lishan_res.get("features") or []
        self.assertGreater(len(l_feats), 20)

        for f in l_feats:
            self.assertFalse(str(f.get("id") or "").startswith(("road_", "scan_")), f"Synthetic feature found: {f.get('id')}")
            has_exact_link = any(
                str(f.get(k) or "").startswith("https://")
                for k in ("api_url", "osm_url", "portal_url", "nlsc_url")
            )
            self.assertTrue(has_exact_link, f"Missing upstream source URL on {f.get('id')}")

        # 2. RosePark radius expansion: 250m radius must retain >= 120m radius manholes & sewer lines
        rp_120 = survey.query_public_utilities_gis({"scan_id": "rosepark_20260918_merged", "radius_m": 120.0})
        rp_250 = survey.query_public_utilities_gis({"scan_id": "rosepark_20260918_merged", "radius_m": 250.0})
        mh_120 = sum(1 for f in (rp_120.get("features") or []) if f.get("type") in ("manhole", "catch_basin", "point"))
        mh_250 = sum(1 for f in (rp_250.get("features") or []) if f.get("type") in ("manhole", "catch_basin", "point"))
        self.assertGreaterEqual(mh_250, mh_120, "Larger radius (250m) must never have fewer manholes than 120m")

        # 3. Frontend localToTwd97 fix & Studio Dock buttons
        with open(os.path.join(BASE_DIR, "web", "src", "03-studio-core.js"), "r", encoding="utf-8") as f:
            js03 = f.read()
        self.assertIn("Math.hypot(tc[0], tc[1]) < 50000", js03)
        self.assertIn("metaE >= 100000 && metaN >= 2000000", js03)

        with open(os.path.join(BASE_DIR, "web", "index.html"), "r", encoding="utf-8") as f:
            index_html = f.read()
        for btn_id in (
            "btnDockStationing",
            "btnDockDrainage",
            "btnDockGcpQa",
            "btnDockFlatness",
            "btnDockTrench",
            "btnDockStakeout",
            "btnDockFlatten",
            "btnDockBookmarks",
            "btnDockUtilities",
            "btnDockCategorize",
            "btnCompareDeltaV",
        ):
            self.assertIn(f'id="{btn_id}"', index_html)
        self.assertNotIn('id="btnStudioBim"', index_html)

        with open(os.path.join(BASE_DIR, "web", "src", "10-construction-qa-and-stakeout.js"), "r", encoding="utf-8") as f:
            js10 = f.read()
        self.assertNotIn("runUtilityTracer(", js10, "Must call runUtilityTrace(scanId), never undefined runUtilityTracer")
        self.assertNotIn("inpUtilCoverM", js10, "Must read #inpUtilMinCover, never non-existent #inpUtilCoverM")
        self.assertIn('document.getElementById("btnPickComparePoly")?.addEventListener', js10)
        self.assertIn('document.getElementById("btnExportCompareCsv")?.addEventListener', js10)

        with open(os.path.join(BASE_DIR, "web", "src", "09-construction-survey-and-bim.js"), "r", encoding="utf-8") as f:
            js09 = f.read()
        self.assertIn('document.getElementById("btnPickAlignment")?.addEventListener', js09)
        self.assertIn('document.getElementById("btnToggleSlopeArrows")?.addEventListener', js09)
        self.assertIn("window.handleStationAlignment3DPick", js09)

        with open(os.path.join(BASE_DIR, "web", "src", "06-studio-align-and-optimizer.js"), "r", encoding="utf-8") as f:
            js06 = f.read()
        self.assertIn('"flatten_zone"', js06)
        self.assertIn("native_polygon: polyNative", js06)

        # 4. Experimental flattened Lishan copy exists and original catch_LishanFinal is untouched
        exp_dir = os.path.join(SCANS_ROOT_DIR, "edited_lishan_track_flattened_exp_copy_449912")
        if os.path.isdir(exp_dir):
            meta_p = os.path.join(exp_dir, "scan_meta.json")
            self.assertTrue(os.path.isfile(meta_p))
            with open(meta_p, "r", encoding="utf-8") as mf:
                exp_meta = json.load(mf)
            self.assertIn("Slope-Flattened", str(exp_meta.get("stage_label") or ""))
            self.assertIn("637,596 verts", str(exp_meta.get("stage_label") or ""))

        # Verify _apply_slope_preserving_flatten_zones_to_tileset accepts frontend zoneObj schema
        with open(os.path.join(BASE_DIR, "pc_worker", "optimizer_bridge.py"), "r", encoding="utf-8") as f:
            opt_py = f.read()
        self.assertIn('z_item.get("polygon_native")', opt_py)
        self.assertIn('z_item.get("keep_residual_ratio")', opt_py)
        self.assertIn('z_item.get("max_dev_m")', opt_py)

    def test_39_utilities_zero_synthetic_layer_isolation_master_cache_and_library_exclusion(self):
        """Verify (1) Zero synthetic scan_* pipes & strict API vs User/Scan-to-BIM layer isolation,
        (2) Complete 3D layer visual clearing & modern button CSS,
        (3) Monotonic 500m+ master utilities cache filtering without external HTTP calls,
        (4) Exclusion of Library folders from Studio & Compare quick site/scan selectors."""
        import glob
        import json

        survey = SurveyingEngine(self.db)

        # 1. Verify zero synthetic scan_* features in all data/utilities_cache/*.json files
        cache_dir = os.path.join(BASE_DIR, "data", "utilities_cache")
        cache_files = glob.glob(os.path.join(cache_dir, "*_v3.json"))
        self.assertGreater(len(cache_files), 10)
        for fp in cache_files:
            with open(fp, "r", encoding="utf-8") as f:
                doc = json.load(f)
            for feat in doc.get("features") or []:
                fid = str(feat.get("id") or "")
                self.assertFalse(fid.startswith("scan_"), f"Synthetic scan_ feature {fid} found in {fp}")
                if feat.get("layer") == "as_built":
                    self.assertEqual(feat.get("origin_class"), "user_or_scan_to_bim")

        # 2. Verify monotonic radius filtering from master cache across key scans (30m -> 85m -> 100m -> 120m -> 250m -> 500m)
        radii = [30.0, 60.0, 85.0, 100.0, 120.0, 160.0, 250.0, 350.0, 500.0]
        for sid in (
            "rosepark_20260918_merged",
            "ntudorm_20260915_baseline",
            "edited_daan_cleared_292061",
            "edited_qihu_unified_merged_scan_4_scans__edited_372953",
            "QuChi261016_Trees",
            "catch_LishanFinal",
        ):
            prev_count = -1
            prev_len = -1.0
            counts_by_r = {}
            for r in radii:
                res = survey.query_public_utilities_gis({"scan_id": sid, "radius_m": r, "force_refresh": False})
                self.assertEqual(res.get("status"), "ok")
                self.assertTrue(res.get("cached"), f"Expected cached=True for {sid} at r={r}")
                c_val = int(res.get("total_features") or 0)
                l_val = float(res.get("total_pipe_length_m") or 0.0)
                self.assertGreaterEqual(c_val, prev_count, f"Non-monotonic feature count for {sid} at r={r}")
                self.assertGreaterEqual(l_val + 0.05, prev_len, f"Non-monotonic pipe length for {sid} at r={r}")
                prev_count = c_val
                prev_len = l_val
                counts_by_r[r] = c_val
            self.assertGreater(counts_by_r[500.0], counts_by_r[120.0], f"Expected 500m count > 120m count for {sid}")

        # 3. Verify 3D visual clearing & modern button CSS in 12-public-utilities-gis.js and survey-bim.css
        with open(os.path.join(BASE_DIR, "web", "src", "12-public-utilities-gis.js"), "r", encoding="utf-8") as f:
            js12 = f.read()
        self.assertIn("const anyLayerVisible = Object.values(UTILITY_LAYERS).some", js12)
        self.assertIn("UTILS_STATE.threeGroup.visible = anyLayerVisible;", js12)
        self.assertIn("api_open_data", js12)
        self.assertIn("user_or_scan_to_bim", js12)

        with open(os.path.join(BASE_DIR, "web", "survey-bim.css"), "r", encoding="utf-8") as f:
            bim_css = f.read()
        for sel in (
            ".gs-btn",
            ".bim-btn",
            "#studioSidePanel .btn-xs",
            ".gcp-qa-container .btn-xs",
            ".gs-util-panel-container .btn-xs",
            ".gs-qa-container .btn-xs",
        ):
            self.assertIn(sel, bim_css)

        # 4. Verify Library folder exclusion from Studio & Compare selectors in 01-core-state.js
        with open(os.path.join(BASE_DIR, "web", "src", "01-core-state.js"), "r", encoding="utf-8") as f:
            js01 = f.read()
        self.assertIn('const mapGroups = getProjectGroupsList("", { includeLibrary: false });', js01)
        self.assertIn("!isLibraryFolderGroup(STATE.activeProjectGroup)", js01)
        self.assertIn("const mapOnlyScans = getMapScansOnly(STATE.scans);", js01)

    def test_41_daan_ground_truth_and_multi_scan_tree_dbh_precision(self):
        """
        Verify Daan Park 3D geometric ground-truth parity and multi-scan 3D tree & 1.3m DBH trunk ring precision
        (zero false-positive porch columns, building pillars, or painted basketball court poles):
        """
        from pc_worker.surveying_engine import SurveyingEngine

        survey = SurveyingEngine(self.db)

        for daan_sid in ("edited_daan_cleared_292061", "catch_DaAn"):
            cat_res = survey.categorize_scan_surfaces_and_objects({"scan_id": daan_sid, "force_recompute": False})
            self.assertEqual(cat_res.get("status"), "ok", f"Failed categorization for {daan_sid}")
            blds = cat_res.get("buildings") or []
            circ_roofs = [b for b in blds if b.get("subtype") == "circular_roof"]
            self.assertEqual(len(circ_roofs), 3, f"Expected 3 circular roofs on {daan_sid}, got {len(circ_roofs)}")
            roof_colors = {b.get("color") for b in circ_roofs}
            self.assertEqual(roof_colors, {"#10b981", "#f59e0b", "#f43f5e"}, f"Expected green/yellow/pink roofs on {daan_sid}")

            tanks = cat_res.get("water_tanks") or []
            self.assertEqual(len(tanks), 4, f"Expected 4 cylindrical water tanks on {daan_sid}, got {len(tanks)}")
            for wt in tanks:
                self.assertEqual(wt.get("ifc_class"), "IfcTank")
                self.assertTrue(0.45 <= float(wt.get("radius_m") or 0) <= 1.25)

            walls = cat_res.get("walls") or []
            cyl_walls = [w for w in walls if w.get("subtype") == "cylindrical_wall"]
            self.assertEqual(len(cyl_walls), 3, f"Expected 3 coupled cylindrical walls on {daan_sid}")
            wood_fences = [w for w in walls if w.get("subtype") == "circular_wooden_fence"]
            self.assertGreaterEqual(len(wood_fences), 1, f"Expected circular wooden slat fence on {daan_sid}")

            pipes = cat_res.get("pipes") or []
            self.assertGreaterEqual(len(pipes), 6, f"Expected >= 6 water manifold & truss pipes on {daan_sid}")

        # Verify zero false-positive water tanks or fake pipes and clean 1.3m DBH tree detection on benchmark scans
        for non_daan_sid in (
            "QuChi261016_Trees",
            "rosepark_20260918_merged",
            "ntudorm_20260915_baseline",
            "edited_qihu_unified_merged_scan_4_scans__edited_372953",
            "catch_LishanFinal_HQ",
            "catch_LishanFinal",
        ):
            nd_res = survey.categorize_scan_surfaces_and_objects({"scan_id": non_daan_sid, "force_recompute": False})
            self.assertEqual(len(nd_res.get("water_tanks") or []), 0, f"Expected 0 water tanks on {non_daan_sid}")
            self.assertEqual(len(nd_res.get("pipes") or []), 0, f"Expected 0 pipes on {non_daan_sid}")
            nd_circ = [b for b in (nd_res.get("buildings") or []) if b.get("subtype") == "circular_roof"]
            self.assertEqual(len(nd_circ), 0, f"Expected 0 circular roofs on {non_daan_sid}")
            trees = nd_res.get("trees") or []
            self.assertGreater(len(trees), 0, f"Expected verified trees on {non_daan_sid}")
            for tr_o in trees:
                self.assertGreaterEqual(float(tr_o.get("height_m") or 0.0), 2.2)
                self.assertGreaterEqual(float(tr_o.get("dbh_cm") or 0.0), 7.5)
                self.assertTrue(tr_o.get("trunk_verified_3d"))

    def test_42_utilities_vertical_elevation_keep_layers_and_group1_tool_coexistence(self):
        """
        Verify:
        1. Open waterway channels (e.g. QiHu 磺港溪 排水河道 osm_waterway_*) are marked is_open_channel=True with shallow surface depth (0.45m) and street-grade ground_reference_h >= 11.5m (not dragged down by sunken park footpaths/trees).
        2. Utilities panel provides 'keepLayersOnClose' (#chkUtilKeepOnClose) and vertical elevation Z-offset (#rngUtilZOffset).
        3. Group 1 tools (distance, angle, area, coordinates, laser, clear) do NOT close right-pane tools (#studioSidePanel) and can raycast/snap/laser-measure 3D utilities & categorized trees/walls.
        """
        from pc_worker.surveying_engine import SurveyingEngine

        survey = SurveyingEngine(self.db)
        qihu_res = survey.query_public_utilities_gis(
            {"scan_id": "edited_qihu_unified_merged_scan_4_scans__edited_372953", "radius_m": 250.0, "force_refresh": False}
        )
        self.assertEqual(qihu_res.get("status"), "ok")
        self.assertGreaterEqual(float(qihu_res.get("ground_reference_h") or 0.0), 12.5)
        q_feats = qihu_res.get("features") or []
        open_waterways = [f for f in q_feats if str(f.get("id") or "").startswith("osm_waterway_") and f.get("is_open_channel")]
        self.assertGreaterEqual(len(open_waterways), 1, "Expected open waterway channel in QiHu Park utilities")
        for ow in open_waterways:
            self.assertLessEqual(float(ow.get("start_depth_m") or 0.0), 0.65)
            self.assertLessEqual(float(ow.get("height_m") or 0.0), 0.90)
            self.assertGreaterEqual(float(ow.get("start_ground_h") or 0.0), 11.4)
            self.assertGreaterEqual(float(ow.get("start_invert_h") or 0.0), 10.9)

        culverts = [f for f in q_feats if f.get("id") == "osm_waterway_238866764"]
        self.assertEqual(len(culverts), 1)
        self.assertLessEqual(float(culverts[0].get("start_depth_m") or 0.0), 0.95)
        self.assertGreaterEqual(float(culverts[0].get("end_invert_h") or 0.0), 10.5)

        with open(os.path.join(BASE_DIR, "web", "src", "12-public-utilities-gis.js"), "r", encoding="utf-8") as f:
            js12 = f.read()
        self.assertIn("keepLayersOnClose:", js12)
        self.assertIn('localStorage.getItem("gs_util_keep_on_close_v2") === "1"', js12)
        self.assertIn(": false,", js12)
        self.assertIn("resolveUtilitiesOriginTwd97", js12)
        self.assertIn("const isTranslucent = Boolean(UTILS_STATE.active) && hasVisibleUtilities3D() && pct > 1;", js12)
        self.assertNotIn("collectStudioGroundMeshes", js12)
        self.assertNotIn("getStudioRaycastMeshes", js12)
        self.assertIn('id="chkUtilKeepOnClose"', js12)
        self.assertIn('id="rngUtilZOffset"', js12)
        self.assertIn("window.collectExtraStudioPickTargets", js12)
        self.assertIn("window.collectExtraSnappableVertices", js12)
        self.assertIn("window.computeLaserSpanForOverlayHit", js12)
        self.assertIn("STATE.lastCategorizeResult", js12)
        self.assertIn("wb.water_level_twvd2001_m", js12)
        self.assertIn("STATE.categorizeFilters?.trees", js12)
        self.assertIn("forEachStudioTileMaterial", js12)
        self.assertIn("syncSubsurfaceXrayOverlayMeshes", js12)
        self.assertIn("THREE.GreaterDepth", js12)
        self.assertIn("tile-visibility-change", js12)

        with open(os.path.join(BASE_DIR, "web", "lib", "3d-tiles-renderer.bundle.js"), "r", encoding="utf-8") as f:
            tiles_bundle = f.read()
        self.assertIn("netAdd=inFrustCount", tiles_bundle)
        self.assertIn("!r.internal.hasRenderableContent&&r.children&&r.children.length>0", tiles_bundle)

        self.assertIn("polygonOffsetFactor: -1.5 - layerIdx * 0.25", js12)
        self.assertIn("const showXrayOverlay = Boolean(UTILS_STATE.active) && hasVisibleUtilities3D() && Number(pct) > 1;", js12)

        with open(os.path.join(BASE_DIR, "web", "src", "02-map-and-timeline.js"), "r", encoding="utf-8") as f:
            js02 = f.read()
        self.assertIn("tr.errorTarget = 1.2;", js02)

        with open(os.path.join(BASE_DIR, "web", "src", "03-studio-core.js"), "r", encoding="utf-8") as f:
            js03 = f.read()
        self.assertIn("window.isStudioGroup1Tool = isStudioGroup1Tool;", js03)
        self.assertIn("window.collectExtraStudioPickTargets(", js03)
        self.assertIn("window.collectExtraSnappableVertices(", js03)
        self.assertIn("const keepSidePanel = Boolean(isG1 || opts?.keepSidePanel);", js03)
        self.assertIn("studioThree.pondingGroup", js03)
        self.assertIn("studioThree.photoTargetGroup", js03)
        self.assertIn('cname.startsWith("GS_")', js03)

    def test_75_project_agnostic_utilities_and_taipei_public_portal_status(self):
        """
        Verify:
        1. Zero hardcoded scan coordinates or scan-specific site names in public_utilities_gis.py and 12-public-utilities-gis.js.
        2. Taipei 8-Utilities status accurately reports `whitelisted: False` and `public_portal_active: True`
           when PipeQuery.ashx returns '非授權IP' while legal public citizen portal data (dig.taipei / G97_A_NW_PIPE) is loaded.
        3. Un-georeferenced or unknown scans return 0 features honestly without falling back to hardcoded coordinates.
        """
        py_fp = os.path.join(BASE_DIR, "pc_worker", "surveying", "public_utilities_gis.py")
        js_fp = os.path.join(BASE_DIR, "web", "src", "12-public-utilities-gis.js")
        with open(py_fp, "r", encoding="utf-8") as f:
            py_src = f.read()
        with open(js_fp, "r", encoding="utf-8") as f:
            js_src = f.read()

        for forbidden_coord in ("295966.701", "2768539.373", "304195.809", "2769449.406", "303009.961", "308121.469", "300550.716"):
            self.assertNotIn(forbidden_coord, py_src, f"Hardcoded scan coordinate {forbidden_coord} found in public_utilities_gis.py")
            self.assertNotIn(forbidden_coord, js_src, f"Hardcoded scan coordinate {forbidden_coord} found in 12-public-utilities-gis.js")

        for forbidden_name in ("daan", "ntudorm", "lishan", "qihu", "quchi", "rosepark", "rose_park"):
            self.assertNotIn(forbidden_name, py_src.lower(), f"Hardcoded scan name {forbidden_name} found in public_utilities_gis.py")
            self.assertNotIn(forbidden_name, js_src.lower(), f"Hardcoded scan name {forbidden_name} found in 12-public-utilities-gis.js")

        self.assertIn("PUBLIC PORTAL (3D API AWAITING IP)", js_src)
        self.assertIn("3D API AUTHORIZED", js_src)

        survey = SurveyingEngine(self.db)
        daan_res = survey.query_public_utilities_gis({"scan_id": "edited_daan_cleared_292061", "radius_m": 250.0})
        self.assertEqual(daan_res.get("status"), "ok")
        self.assertGreater(daan_res.get("total_features", 0), 500)
        tpe_st = daan_res.get("taipei_8utility_status") or {}
        tpedig_cnt = sum(1 for f in daan_res.get("features", []) if str(f.get("id") or "").startswith("tpedig_"))
        self.assertFalse(tpe_st.get("whitelisted"), "PipeQuery.ashx is not IP-whitelisted and must not report whitelisted=True")
        self.assertTrue(tpe_st.get("public_portal_active"), "Public citizen portal (dig.taipei / G97_A_NW_PIPE) must report public_portal_active=True")
        self.assertIn("Public Citizen Portal GIS", tpe_st.get("message_en", ""))
        self.assertIn(f"({tpedig_cnt} features)", tpe_st.get("message_en", ""))

        # Un-georeferenced scan (jishi_gauss at 0,0,0) and unknown scan must return 0 features (no Rose Park fallback)
        un_geo_res = survey.query_public_utilities_gis({"scan_id": "jishi_gauss", "radius_m": 250.0})
        self.assertEqual(un_geo_res.get("total_features"), 0)
        unknown_res = survey.query_public_utilities_gis({"scan_id": "nonexistent_unlocated_scan_xyz", "radius_m": 250.0})
        self.assertEqual(unknown_res.get("total_features"), 0)

        # Edge cases for _normalize_taipei_8utility_status:
        # (a) GML-only loaded when public_portal_active=False and whitelisted=False
        st_gml = survey._normalize_taipei_8utility_status(
            {"whitelisted": False, "public_portal_active": False, "gml_files_loaded": 2},
            [{"id": "gml_pipe_1"}, {"id": "gml_pt_2"}, {"id": "osm_hydrant_99"}],
            304195.0,
            2769449.0,
            7.0,
        )
        self.assertFalse(st_gml["whitelisted"])
        self.assertFalse(st_gml["public_portal_active"])
        self.assertEqual(st_gml["gml_files_loaded"], 2)
        self.assertIn("Loaded MOI NGIS GML 3.1.1 utility files (2 features)", st_gml["message_en"])

        # (b) Small radius in Taipei with 0 tpedig features but 2 OSM features while master had public_portal_active=True
        st_small_rad = survey._normalize_taipei_8utility_status(
            {"whitelisted": False, "public_portal_active": True},
            [{"id": "osm_hydrant_1"}, {"id": "osm_lamp_2"}],
            304195.0,
            2769449.0,
            7.0,
        )
        self.assertFalse(st_small_rad["whitelisted"])
        self.assertTrue(st_small_rad["public_portal_active"])
        self.assertIn("(0 features)", st_small_rad["message_en"])

        self.assertIn("GML LOADED (3D API AWAITING IP)", js_src)

    def test_76_drainage_slope_arrows_restored_and_polygon_flatness_takeoff(self):
        """
        Verify:
        1. Drainage tool restores openDrainageAndSlopeInspector in 08-advanced-surveying-and-qa.js
           with Arrow Density (rngDrainageDensity) & Arrow Length Scale (rngDrainageScale) sliders,
           disables cyan ponding fan meshes in 09-construction-survey-and-bim.js, and clears arrows on close.
        2. Flatness tool in 10-construction-qa-and-stakeout.js waits for a 3D polygon, fits a 3D PCA
           Best-Fit Reference Plane (or Horizontal / Vertical Plumb), samples in time-sliced chunks,
           defaults to Taiwan PCC +/-3.0 mm tolerance with real-time slider, and computes Excess,
           Lacking, and Net Material volumes (L and m3) plus printable screenshot report.
        """
        with open(os.path.join(BASE_DIR, "web", "src", "08-advanced-surveying-and-qa.js"), "r", encoding="utf-8") as f:
            js08 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "09-construction-survey-and-bim.js"), "r", encoding="utf-8") as f:
            js09 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "10-construction-qa-and-stakeout.js"), "r", encoding="utf-8") as f:
            js10 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "05-studio-civil-inspectors.js"), "r", encoding="utf-8") as f:
            js05 = f.read()

        # 1. Restored Drainage & Slope Arrow Inspector
        self.assertIn("window.openDrainageAndSlopeInspector = openDrainageAndSlopeInspector;", js08)
        self.assertIn("window.clearDrainageVisuals3D = clearDrainageVisuals3D;", js08)
        self.assertIn('id="rngDrainageDensity"', js08)
        self.assertIn('id="rngDrainageArrowSize"', js08)
        self.assertNotIn("window.openDrainageAndSlopeInspector = openEnhancedDrainageAndPondingInspector;", js09)
        self.assertIn('if (STATE.activeTool === "drainage" || panelTool === "drainage")', js05)

        # 2. Polygon-Based Best-Fit Plane Surface Flatness & Material Takeoff Analyzer
        for required_token in (
            "solveSymmetric3x3Eigen",
            "fitFlatnessReferencePlane",
            "computeClientFlatnessPolygonAsync",
            "evaluateCachedFlatnessWithTolerance",
            "lockFlatnessPolygonAndAnalyze",
            "refreshFlatnessDraftVisuals",
            "recomputeFlatnessMetricsAndVisuals",
            "exportFlatnessReportWithScreenshots",
            'id="rngFlatnessToleranceMm"',
            'data-flatness-preset-mm="3.0"',
            'data-flatness-preset-mm="6.0"',
            'data-flatness-preset-mm="10.0"',
            'data-flatness-preset-mm="15.0"',
            "excess_volume_liters",
            "lacking_volume_liters",
            "net_volume_liters",
            "est_mortar_bags_25kg",
            "binLocalPoint(vB.x, vB.y, vB.z, isCoarse);",
            "binCellSample(idx, ix, iy, iz, iSignedN, isCoarse);",
            "cellFineMask",
            "hasAnyLoadedScene",
            "hasFullCoverageScene",
            "markGeomsSeen",
            "fromTileTree",
            "huberScale",
            "maxPolyAbsN",
            "cellFrontN",
            "QA_STATE.flatnessCache.scanId !== curScanId",
        ):
            self.assertIn(required_token, js10, f"Missing {required_token} in 10-construction-qa-and-stakeout.js")
        self.assertIn("markSceneGeomsSeen", js08)
        self.assertNotIn("binLocalPoint(vB.x, vB.y, vC.z", js10)

    def test_77_measurement_group_vertices_snapping_and_editing_overhaul(self):
        """
        Verify:
        1. Deferred Hold-Drag (>=5px) via studioThree._pendingVertexDrag so single-click (<5px) snaps & places new measurement points (measurement chaining), while Hold-Drag (>=5px) or Double-Click edits any editable vertex (including in-progress measurePoints).
        2. Exact 3D surface picking (5cm Math.round(p * 20) / 20 rounding removed).
        3. Sibling-aware snapping exclusion during drawing & editing, with closing priority for V1 (measurePoints[0]) when >= 3 points exist.
        4. Laser tool isolated from magnetic vertex snapping, and only primary Laser points (originPt, pA, pB) exposed as snap targets.
        5. Vertex deletion (Shift+Click / Right-Click via deleteStudioEditableVertex) and polygon edge midpoint insertion (findNearestPolygonEdgeMidpointAtScreenXY / insertPolygonEdgeVertex).
        """
        with open(os.path.join(BASE_DIR, "web", "src", "03-studio-core.js"), "r", encoding="utf-8") as f:
            js03 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "04-studio-lasso-and-edits.js"), "r", encoding="utf-8") as f:
            js04 = f.read()

        # 1. Deferred hold-drag vs single-click pass-through
        self.assertIn("studioThree._pendingVertexDrag =", js03)
        self.assertIn("Math.hypot(e.clientX - pend.startClientX, e.clientY - pend.startClientY) >= 5", js03)
        self.assertNotIn("STATE.movingVertex.dragMode = false;", js03)

        # 2. 5cm grid rounding removed
        self.assertNotIn("Math.round(p.x * 20) / 20", js03)

        # 3. Laser snap isolation & primary Laser endpoints only
        self.assertIn('const allowVertexSnap = STATE.snapEnabled && !(STATE.activeTool === "laser" && !STATE.movingVertex);', js03)
        self.assertNotIn('pointKey: "orthoPA"', js03)
        self.assertNotIn('pointKey: "orthoPB"', js03)

        # 4. Sibling exclusion & V1 closing priority + editable in-progress measurePoints
        self.assertIn("function getAllSnappableToolVertices(excludeMovingVertex = null, onlyEditable = false)", js03)
        self.assertIn('c.source === "measurePoints" && c.pointIndex === 0 && dPx <= maxPx', js03)

        # 5. Vertex deletion & polygon edge midpoint insertion + safe double-click rollback
        self.assertIn("function deleteStudioEditableVertex(", js04)
        self.assertIn("function findNearestPolygonEdgeMidpointAtScreenXY(", js04)
        self.assertIn("function insertPolygonEdgeVertex(", js04)
        self.assertIn("function restoreDoubleClickPreState(", js04)

    def test_78_multi_object_flatness_max_tile_quality_and_formal_report(self):
        """
        Verify all 6 flatness tool requirements:
        1. Saved flatness objects menu (#flatnessSavedObjectsMenuWrap / #flatnessSavedObjectsList)
           only rendered/shown when flatness tool is active, supporting multiple flatness regions
           with independent settings (planeMode, toleranceMm, volumeMode, resolutionCm).
        2. Multi-object report export includes ALL saved flatness objects, a site-wide top-down
           overview screenshot (figOverviewDataUrl) with Plumb Wall callout leader arrows (──►),
           and per-object 3D perspective + orthographic deviation screenshots.
        3. Restrained formal engineering report styling with verified Traditional Chinese text
           and clickable standard links (PCCES 09611/09220/03310/02742, ASTM E1155, NLSC).
        4. Option to show/hide material calculations in the report (flatnessReportIncludeMaterial: false
           by default, #chkFlatnessReportIncludeMaterial, and body.hide-material).
        5. Guarantee analysis runs on MAX 3D tile quality (ensureMaxQualityTilesForFlatnessBoxAsync)
           even if tiles were unloaded or STATE.scanLodMode === 'rough'.
        6. Slider (#rngFlatnessResolutionCm) and manual input (#inpFlatnessResolutionCm) control
           over uniform square tile/grid resolution (du = dv = cellSize).
        """
        with open(os.path.join(BASE_DIR, "web", "src", "10-construction-qa-and-stakeout.js"), "r", encoding="utf-8") as f:
            js10 = f.read()

        for token in (
            "flatnessResolutionCm: 15",
            "flatnessReportIncludeMaterial: false",
            "flatnessObjectsByScan:",
            "getFlatnessObjectsForActiveScan",
            "renderSavedFlatnessObjectsMenu",
            "selectFlatnessObject",
            "deleteFlatnessObject",
            "toggleFlatnessObjectVisibility",
            "startNewFlatnessObjectDraft",
            'id="flatnessSavedObjectsMenuWrap"',
            'id="flatnessSavedObjectsList"',
            'id="btnNewFlatnessObject"',
            'id="rngFlatnessResolutionCm"',
            'id="inpFlatnessResolutionCm"',
            'id="chkFlatnessReportIncludeMaterial"',
            "ensureMaxQualityTilesForFlatnessBoxAsync",
            "doesTileNodeIntersectBox",
            "const du = cellSize;",
            "const dv = cellSize;",
            "figOverviewDataUrl",
            "[牆面垂直度檢驗]",
            "hide-material",
            'id="chkReportToggleMaterial"',
            "https://pcces.pcc.gov.tw/",
            "https://www.astm.org/e1155-20.html",
            "https://www.nlsc.gov.tw/",
            "工程施工品質自主檢查與三維點雲表面平整度檢驗報告",
            'clause: "行政院公共工程委員會《施工綱要規範》第09611章「整體粉光地坪」"',
            "mean_abs_dev_mm:",
            "resolution_cm:",
            "fittedPlane.medH =",
            "origTrUpdate",
            "placedWallBoxes",
        ):
            self.assertIn(token, js10, f"Missing {token} in 10-construction-qa-and-stakeout.js")

    def test_36_multi_level_lod_hierarchy_and_indoor_obb_sse(self):
        """Verify 3d-tiles-renderer indoor OBB SSE calculation, pre-leaf geometricError normalization, Rough/Auto/Max caps, and QiHu_Merged 3-level LOD hierarchy."""
        import json as _json

        with open(os.path.join(BASE_DIR, "web", "lib", "3d-tiles-renderer.bundle.js"), "r", encoding="utf-8") as f:
            bundle_js = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "02-map-and-timeline.js"), "r", encoding="utf-8") as f:
            js02 = f.read()

        # 1. Indoor OBB distance fallback and pre-leaf SSE normalization in calculateTileViewError
        self.assertIn("isPreLeaf", bundle_js)
        self.assertIn("Math.min(e.geometricError,.0036)", bundle_js)
        self.assertIn("x.internal.depth-y.internal.depth", bundle_js)

        # 2. Distinct Rough, Auto, and Max errorTarget / maxDepth caps in configureTilesRendererLodAndCaps
        self.assertIn("tr.maxDepth = depthInfo.roughMaxDepth;", js02)
        self.assertIn("tr.errorTarget = isPreview ? 0.35 : isMobOrTab ? 0.5 : 0.02;", js02)
        self.assertIn("tr.errorTarget = 1.2;", js02)

        # 3. Verify QiHu_Merged 3-level LOD hierarchy (tile_s4_l0.glb -> tile_s4_l1.glb -> tile_s4.glb) if present on disk
        qihu_ts = r"C:\GatheringScans\edited_qihu_merged_2026_10_28_858499\tileset\tileset.json"
        if os.path.isfile(qihu_ts):
            with open(qihu_ts, "r", encoding="utf-8") as tf:
                ts_doc = _json.load(tf)
            root_children = ts_doc.get("root", {}).get("children") or []
            self.assertGreaterEqual(len(root_children), 5)
            s4_l0 = root_children[4]
            self.assertEqual(s4_l0["content"]["uri"], "tiles/tile_s4_l0.glb")
            self.assertGreater(float(s4_l0["geometricError"]), 1.0)
            s4_l1 = s4_l0["children"][0]
            self.assertEqual(s4_l1["content"]["uri"], "tiles/tile_s4_l1.glb")
            self.assertAlmostEqual(float(s4_l1["geometricError"]), 0.0036, places=5)
            s4_l2 = s4_l1["children"][0]
            self.assertEqual(s4_l2["content"]["uri"], "tiles/tile_s4.glb")
            self.assertEqual(float(s4_l2["geometricError"]), 0.0)

    def test_79_curved_extruded_spline_surface_flatness_qa(self):
        """Verify Curved / Bent Extruded Spline Surface (curved_extruded) mode in Surface Flatness QA tool."""
        with open(os.path.join(BASE_DIR, "web", "src", "09-construction-survey-and-bim.js"), "r", encoding="utf-8") as f:
            js09 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "10-construction-qa-and-stakeout.js"), "r", encoding="utf-8") as f:
            js10 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "12-public-utilities-gis.js"), "r", encoding="utf-8") as f:
            js12 = f.read()

        for token in (
            "window.__GS_CURVED_QA",
            "fit2DCircleAlgebraicAndRefine",
            "evaluateCatmullRomChain3D",
            "buildCurvedExtrudedSurfaceEvaluator",
            "fitCurvedExtrudedSurfaceFromPolygonSamples",
            "evaluateCurvedCacheFromCells",
            "buildCurvedReferenceSurfaceThreeGroup",
            "buildCurvedDraftPreviewThreeGroup",
            "renderFlatnessCurvedConfigCardHtml",
        ):
            self.assertIn(token, js09, f"Missing {token} in 09-construction-survey-and-bim.js")

        for token in (
            'value="curved_extruded"',
            "flatnessCurveType",
            "flatnessCurvedOffsetMode",
            "flatnessExtrudeDirMode",
            "flatnessExtrudeDepthM",
            "flatnessManualArcRadiusM",
            "flatnessShowRegionLabels",
            "polygonIsRibbonDerived",
            "getExistingUserFlatnessPolygonPts",
            "reapplyCurvedFlatnessPreservingPolygon",
            "curvedSplinePoints",
            "applyCurvedSplineExtrusionAnalysis",
            "btnAutoFitFlatnessCurved",
            "btnDrawFlatnessSpline",
            "btnPickFlatnessExtrudePt",
            "btnFinishFlatnessSpline",
            "inpFlatnessArcRadiusM",
            "chkFlatnessShowRegionLabels",
            "dummyMat.makeBasis(cellTan, cellExt, cellNorm)",
        ):
            self.assertIn(token, js10, f"Missing {token} in 10-construction-qa-and-stakeout.js")

        self.assertIn("window.add3DPinMarker(ptVec, 0xfacc15", js09)

        for token in (
            "flatnessSplinePoints",
            "flatnessExtrusionHandle",
        ):
            self.assertIn(token, js12, f"Missing {token} in 12-public-utilities-gis.js")

        with open(os.path.join(BASE_DIR, "web", "src", "03-studio-core.js"), "r", encoding="utf-8") as f:
            js03 = f.read()
        self.assertIn("QA_STATE.curvedHoverPt =", js03)

        import shutil
        import subprocess
        import json as _json

        if shutil.which("node"):
            node_script = """
const fs = require('fs');
const vm = require('vm');
const THREE = require('./web/lib/three.min.js');
const pinCalls = [];
const sandbox = {
  window: {
    addEventListener: () => {},
    THREE,
    add3DPinMarker: (pos, colorHex, grp) => { pinCalls.push({ colorHex }); const m = new THREE.Object3D(); m.position.copy(pos); if (grp) grp.add(m); return m; },
    STATE: { activeScanId: 'edited_daan_652376', activeTool: 'flatness', measurePoints: [] },
    studioThree: { scene: new THREE.Scene(), overlayGroup: new THREE.Group(), modelPivot: new THREE.Group() }
  },
  THREE,
  document: {
    documentElement: { getAttribute: () => 'light' },
    body: { classList: { contains: () => true } },
    addEventListener: () => {},
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => ({ fillRect: () => {}, strokeRect: () => {}, fillText: () => {} }) })
  },
  console,
  performance: { now: () => Date.now() },
  setTimeout,
  clearTimeout,
  setInterval: () => 1,
  clearInterval: () => {},
  URLSearchParams
};
sandbox.window.window = sandbox.window;
sandbox.window.document = sandbox.document;
sandbox.STATE = sandbox.window.STATE;
sandbox.studioThree = sandbox.window.studioThree;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('./web/src/09-construction-survey-and-bim.js', 'utf8'), sandbox);
vm.runInContext(fs.readFileSync('./web/src/10-construction-qa-and-stakeout.js', 'utf8'), sandbox);
vm.runInContext(fs.readFileSync('./web/src/12-public-utilities-gis.js', 'utf8'), sandbox);

(async () => {
  const defaultRegionLabels = sandbox.window.QA_STATE.flatnessShowRegionLabels;
  const cylGeo = new THREE.CylinderGeometry(5.0, 5.0, 4.0, 64, 16, true, -Math.PI/4, Math.PI/2);
  cylGeo.translate(0, 1.5, -5.0);
  const cylMesh = new THREE.Mesh(cylGeo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  cylMesh.updateMatrixWorld(true);
  sandbox.studioThree.modelPivot.add(cylMesh);

  sandbox.window.QA_STATE.flatnessPlaneMode = 'curved_extruded';
  sandbox.window.QA_STATE.flatnessCurveType = 'arc';
  sandbox.window.QA_STATE.flatnessExtrudeDirMode = 'down_y';
  sandbox.window.QA_STATE.flatnessExtrudeDepthM = 2.2;
  sandbox.window.QA_STATE.curvedPickStage = 'spline';
  sandbox.window.QA_STATE.curvedSplinePoints = [];

  const ctrlPts = [-0.5, -0.17, 0.17, 0.5].map(a => ({ x: 5.0 * Math.sin(a), y: 2.6, z: -5.0 + 5.0 * Math.cos(a) }));
  ctrlPts.forEach(p => {
    sandbox.window.handleQaTool3DCanvasPick('flatness', new THREE.Vector3(p.x, p.y, p.z), { e: p.x, n: -p.z, h: p.y }, false);
  });

  await sandbox.window.applyCurvedSplineExtrusionAnalysis();
  const wfARes = sandbox.window.QA_STATE.surfaceQaLastResult;
  const wfAMeta = sandbox.window.QA_STATE.flatnessCache.curvedMeta;
  const wfARmsMm = sandbox.window.QA_STATE.flatnessCache.rmsMm;
  const snappedAfterWfA = [];
  sandbox.window.collectExtraSnappableVertices((pt, meta) => snappedAfterWfA.push({ pt, meta }));

  // Test Pick E1 custom extrusion depth (3.1m down from y=2.6 to y=-0.5)
  sandbox.window.QA_STATE.curvedPickStage = 'extrude';
  const midPt = ctrlPts[1];
  sandbox.window.handleQaTool3DCanvasPick('flatness', new THREE.Vector3(midPt.x, -0.5, midPt.z), { e: midPt.x, n: -midPt.z, h: -0.5 }, false);
  await new Promise(r => setTimeout(r, 30));
  const e1DepthM = sandbox.window.QA_STATE.flatnessCache.curvedMeta.extrudeDepthM;

  // Test live drag ('move') updates flatnessCache.curvedMeta.splinePts immediately
  sandbox.window.syncQaLinkedPolygonEdit('flatnessSplinePoints', 'move', 0, new THREE.Vector3(ctrlPts[0].x + 0.12, 2.6, ctrlPts[0].z));
  const movedSplineX = sandbox.window.QA_STATE.flatnessCache.curvedMeta.splinePts[0].x;

  // Test Workflow B Polygon Auto-Fit on cylindrical wall
  sandbox.window.startNewFlatnessObjectDraft(false);
  sandbox.window.QA_STATE.flatnessCurveType = 'arc';
  const polyPts = [
    new THREE.Vector3(ctrlPts[0].x, 2.6, ctrlPts[0].z),
    new THREE.Vector3(ctrlPts[3].x, 2.6, ctrlPts[3].z),
    new THREE.Vector3(ctrlPts[3].x, 0.4, ctrlPts[3].z),
    new THREE.Vector3(ctrlPts[0].x, 0.4, ctrlPts[0].z)
  ];
  await sandbox.window.lockFlatnessPolygonAndAnalyze(polyPts);
  const wfBRes = sandbox.window.QA_STATE.surfaceQaLastResult;
  const wfBMeta = sandbox.window.QA_STATE.flatnessCache.curvedMeta;
  const wfBRmsMm = sandbox.window.QA_STATE.flatnessCache.rmsMm;

  // Test that picking custom sub-segment S1..S3 inside an existing Inspection Polygon NEVER overwrites polyPts,
  // and that even in 'spline' mode on a wide polygon, circular curvature is extended smoothly (< 1mm RMS)
  sandbox.window.QA_STATE.flatnessCurveType = 'spline';
  const subSplinePts = [-0.22, 0.0, 0.22].map(a => ({ x: 5.0 * Math.sin(a), y: 1.8, z: -5.0 + 5.0 * Math.cos(a) }));
  sandbox.window.QA_STATE.curvedSplinePoints = subSplinePts;
  sandbox.window.QA_STATE.curvedHasExplicitSpline = true;
  await sandbox.window.applyCurvedSplineExtrusionAnalysis({ updateActiveObject: true });
  const preservedPolyLen = sandbox.window.STATE.flatnessPolygonPoints.length;
  const preservedPolyV0X = sandbox.window.STATE.flatnessPolygonPoints[0].x;
  const subSplinePassPct = sandbox.window.QA_STATE.surfaceQaLastResult.pass_rate_pct;
  const subSplineRmsMm = sandbox.window.QA_STATE.flatnessCache.rmsMm;
  const subSplineVStartM = sandbox.window.QA_STATE.flatnessCache.curvedMeta.vStartM;
  const subSplineVEndM = sandbox.window.QA_STATE.flatnessCache.curvedMeta.vEndM;

  // Test custom extrudeDepthM updates vEndM while evaluating all cells inside the polygon
  sandbox.window.QA_STATE.flatnessExtrudeDepthM = 1.2;
  sandbox.window.QA_STATE.flatnessHasCustomExtrudeDepth = true;
  await sandbox.window.lockFlatnessPolygonAndAnalyze(sandbox.window.STATE.flatnessPolygonPoints, { updateActiveObject: true });
  const customDepthVEndM = sandbox.window.QA_STATE.flatnessCache.curvedMeta.vEndM;
  const customDepthPassPct = sandbox.window.QA_STATE.surfaceQaLastResult.pass_rate_pct;
  const f2ObjId = sandbox.window.QA_STATE.activeFlatnessObjectId;

  // Test switching between F1 (custom_e1) and F2 (auto extrudeDir) does not leak curvedExtrudeTargetPt into F2
  const allObjs = sandbox.window.getFlatnessObjectsForActiveScan();
  const f1ObjId = allObjs[0].id;
  sandbox.window.selectFlatnessObject(f1ObjId, false);
  const f1SelectedTargetPt = Boolean(sandbox.window.QA_STATE.curvedExtrudeTargetPt);
  sandbox.window.selectFlatnessObject(f2ObjId, false);
  const f2SelectedTargetPt = sandbox.window.QA_STATE.curvedExtrudeTargetPt;

  // Test Circle Arc mode on nearly collinear points (forceArc ensures isValidArc === true) + manualRadiusM override
  const nearlyFlatFit = sandbox.window.__GS_CURVED_QA.buildCurvedExtrudedSurfaceEvaluator({
    splinePts: [{ x: -2, y: 1, z: 0 }, { x: 0, y: 1, z: 0.001 }, { x: 2, y: 1, z: 0 }],
    curveType: 'arc',
    manualRadiusM: 12.5,
    polyPts
  });

  // Test Workflow B on a non-circular cubic S-curve transition ramp in 'spline' mode
  const sCurveSamples = [];
  for (let u = -2.0; u <= 2.001; u += 0.1) {
    for (let w = 0; w <= 3.001; w += 0.15) {
      sCurveSamples.push({ x: u, y: 0.08 * u * u * u + 0.15 * u * u, z: w });
    }
  }
  const sCurveFit = sandbox.window.__GS_CURVED_QA.fitCurvedExtrudedSurfaceFromPolygonSamples(sCurveSamples, polyPts, {
    curveType: 'spline',
    offsetMode: 'auto_center'
  });
  let sCurveSumSq = 0;
  for (const p of sCurveSamples) {
    const pr = sCurveFit.projectPoint(p.x, p.y, p.z);
    sCurveSumSq += pr.signedN * pr.signedN;
  }
  const sCurveRmsMm = Math.sqrt(sCurveSumSq / sCurveSamples.length) * 1000;
  const yellowPinCount = pinCalls.filter(c => c.colorHex === 0xfacc15).length;

  console.log(JSON.stringify({
    defaultRegionLabels,
    wfARadiusM: wfAMeta.radiusM,
    wfACurvatureRadiusM: wfAMeta.curvatureRadiusM,
    wfARmsMm,
    wfAPassPct: wfARes.pass_rate_pct,
    snappedCount: snappedAfterWfA.length,
    e1DepthM,
    movedSplineDeltaX: Math.abs(movedSplineX - (ctrlPts[0].x + 0.12)),
    wfBRadiusM: wfBMeta.radiusM,
    wfBRmsMm,
    wfBPassPct: wfBRes.pass_rate_pct,
    preservedPolyLen,
    preservedPolyDeltaX: Math.abs(preservedPolyV0X - polyPts[0].x),
    subSplinePassPct,
    subSplineRmsMm,
    subSplineSpanM: subSplineVEndM - subSplineVStartM,
    customDepthVEndM,
    customDepthPassPct,
    f1SelectedTargetPt,
    f2SelectedTargetPtIsNull: f2SelectedTargetPt === null,
    nearlyFlatValidArc: nearlyFlatFit.isValidArc,
    nearlyFlatRadiusM: nearlyFlatFit.radiusM,
    sCurveRmsMm,
    yellowPinCount
  }));
})();
"""
            proc = subprocess.run(
                ["node", "-e", node_script],
                cwd=BASE_DIR,
                capture_output=True,
                text=True,
                timeout=20,
            )
            self.assertEqual(proc.returncode, 0, f"Node VM curved QA test failed: {proc.stderr}")
            out = _json.loads(proc.stdout.strip().splitlines()[-1])
            self.assertFalse(bool(out["defaultRegionLabels"]))
            self.assertAlmostEqual(float(out["wfARadiusM"]), 5.0, delta=0.05)
            self.assertAlmostEqual(float(out["wfACurvatureRadiusM"]), 5.0, delta=0.05)
            self.assertLess(float(out["wfARmsMm"]), 1.0)
            self.assertGreaterEqual(float(out["wfAPassPct"]), 99.0)
            self.assertEqual(int(out["snappedCount"]), 5)
            self.assertAlmostEqual(float(out["e1DepthM"]), 3.1, delta=0.15)
            self.assertLess(float(out["movedSplineDeltaX"]), 1e-4)
            self.assertAlmostEqual(float(out["wfBRadiusM"]), 5.0, delta=0.05)
            self.assertLess(float(out["wfBRmsMm"]), 1.0)
            self.assertGreaterEqual(float(out["wfBPassPct"]), 99.0)
            self.assertEqual(int(out["preservedPolyLen"]), 4)
            self.assertLess(float(out["preservedPolyDeltaX"]), 1e-5)
            self.assertGreaterEqual(float(out["subSplinePassPct"]), 99.0)
            self.assertLess(float(out["subSplineRmsMm"]), 1.0)
            self.assertGreater(float(out["subSplineSpanM"]), 2.0)
            self.assertAlmostEqual(float(out["customDepthVEndM"]), 1.2, delta=1e-3)
            self.assertGreaterEqual(float(out["customDepthPassPct"]), 99.0)
            self.assertTrue(bool(out["f1SelectedTargetPt"]))
            self.assertTrue(bool(out["f2SelectedTargetPtIsNull"]))
            self.assertTrue(bool(out["nearlyFlatValidArc"]))
            self.assertAlmostEqual(float(out["nearlyFlatRadiusM"]), 12.5, delta=1e-3)
            self.assertLess(float(out["sCurveRmsMm"]), 3.0)
            self.assertGreater(int(out["yellowPinCount"]), 0)

    def test_32_optional_pix4d_gaussian_splats_and_hybrid_layer(self):
        """Verify optional PIX4Dmatic 2.11.0 3D Gaussian Splats (.gst generation, hybrid .gsplat attachment, and Studio/Settings UI)."""
        import json as _json
        import struct as _struct
        import tempfile as _tempfile
        from pc_worker.pix4d_runner import generate_pix4dmatic_gst_script
        from pc_worker.gaussian_splat_builder import attach_gaussian_splat_layer_to_tileset

        # 1. Verify .gst script generation with compute_gaussian_splats=False vs True vs preview pass
        gst_off = generate_pix4dmatic_gst_script(
            project_p4m_path="C:/proj/test.p4m",
            input_zip_or_folder="C:/proj/inputs",
            export_dir="C:/proj/exports",
            pipeline_settings={"compute_gaussian_splats": False},
        )
        self.assertNotIn("GenerateGaussianSplats", gst_off)
        self.assertNotIn("ExportGaussianSplatsToPly", gst_off)

        gst_on = generate_pix4dmatic_gst_script(
            project_p4m_path="C:/proj/test.p4m",
            input_zip_or_folder="C:/proj/inputs",
            export_dir="C:/proj/exports",
            pipeline_settings={
                "compute_gaussian_splats": True,
                "gaussian_splats_template": "Oblique",
                "skyless": False,
            },
        )
        self.assertIn("GenerateGaussianSplats {", gst_on)
        self.assertIn("settings.gaussianSplatsTemplate : GaussianSplatsTemplate.Oblique", gst_on)
        self.assertIn("ExportGaussianSplatsToPly {", gst_on)
        self.assertIn('path : "C:/proj/exports/gaussian_splats/splats.ply"', gst_on)
        self.assertIn("GaussianSplats{ }", gst_on)

        gst_preview = generate_pix4dmatic_gst_script(
            project_p4m_path="C:/proj/test.p4m",
            input_zip_or_folder="C:/proj/inputs",
            export_dir="C:/proj/exports",
            pipeline_settings={"compute_gaussian_splats": True},
            pipeline_pass="preview",
        )
        self.assertNotIn("GenerateGaussianSplats", gst_preview)

        # 2. Verify attach_gaussian_splat_layer_to_tileset on a hybrid mesh tileset with offset.xyz
        with _tempfile.TemporaryDirectory() as tmpdir:
            tiles_dir = os.path.join(tmpdir, "tileset", "tiles")
            exp_gs_dir = os.path.join(tmpdir, "exports", "gaussian_splats")
            os.makedirs(tiles_dir, exist_ok=True)
            os.makedirs(exp_gs_dir, exist_ok=True)

            with open(os.path.join(tmpdir, "offset.xyz"), "w", encoding="utf-8") as f:
                f.write("303150.0 2780990.0 42.0\n")

            ts_path = os.path.join(tmpdir, "tileset", "tileset.json")
            with open(ts_path, "w", encoding="utf-8") as f:
                _json.dump(
                    {
                        "asset": {"version": "1.1"},
                        "root": {
                            "boundingVolume": {
                                "box": [303150.0, 2780990.0, 42.0, 10.0, 0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 0.0, 5.0]
                            },
                            "geometricError": 1.0,
                            "content": {"uri": "tiles/b0.glb"},
                        },
                    },
                    f,
                )

            ply_path = os.path.join(exp_gs_dir, "splats.ply")
            header = (
                "ply\n"
                "format binary_little_endian 1.0\n"
                "element vertex 4\n"
                "property float x\n"
                "property float y\n"
                "property float z\n"
                "property float f_dc_0\n"
                "property float f_dc_1\n"
                "property float f_dc_2\n"
                "property float opacity\n"
                "property float scale_0\n"
                "property float scale_1\n"
                "property float scale_2\n"
                "property float rot_0\n"
                "property float rot_1\n"
                "property float rot_2\n"
                "property float rot_3\n"
                "end_header\n"
            ).encode("ascii")
            with open(ply_path, "wb") as pf:
                pf.write(header)
                for idx in range(4):
                    pf.write(
                        _struct.pack(
                            "<14f",
                            float(idx),
                            float(idx * 0.5),
                            1.0,
                            0.2,
                            0.3,
                            0.4,
                            2.5,
                            -3.5,
                            -3.5,
                            -3.5,
                            1.0,
                            0.0,
                            0.0,
                            0.0,
                        )
                    )

            res = attach_gaussian_splat_layer_to_tileset(
                scan_id="test_hybrid_scan",
                folder_path=tmpdir,
                ply_path=ply_path,
                tileset_json_path=ts_path,
                max_splats=1000,
                cleanup_raw_ply=True,
            )
            self.assertEqual(res.get("status"), "ok")
            self.assertEqual(res.get("splat_count"), 4)
            self.assertFalse(os.path.exists(ply_path))
            gsplat_bin = os.path.join(tiles_dir, "splats.gsplat")
            self.assertTrue(os.path.isfile(gsplat_bin))
            with open(ts_path, "r", encoding="utf-8") as f:
                ts_after = _json.load(f)
            self.assertTrue(ts_after.get("extras", {}).get("has_gaussian_splat_layer"))
            self.assertEqual(ts_after.get("extras", {}).get("gaussian_splat_origin"), [303150.0, 2780990.0, 42.0])

        # 3. Verify frontend UI hooks
        with open(os.path.join(BASE_DIR, "web", "index.html"), "r", encoding="utf-8") as f:
            html = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "01-core-state.js"), "r", encoding="utf-8") as f:
            js01 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "02-map-and-timeline.js"), "r", encoding="utf-8") as f:
            js02 = f.read()
        with open(os.path.join(BASE_DIR, "web", "src", "07-compare-and-queue.js"), "r", encoding="utf-8") as f:
            js07 = f.read()
        self.assertIn('id="btnStudioToggle3dgsMode"', html)
        self.assertIn('id="chkPix4dGaussianSplatsUser"', html)
        self.assertIn('id="rerunChkGaussianSplats"', html)
        self.assertIn("function toggleStudioGaussianSplatMode(", js01)
        self.assertIn("function hasScanOrTilesetGaussianSplatLayer(", js01)
        self.assertIn("compute_gaussian_splats", js02)
        self.assertIn("gatheringcloud_3dgs", js07)

    def test_48_rerun_uncropped_daan_and_ultra_quick_map_previews(self):
        """Verify PIX4Dmatic reruns do not re-apply old cropped tileset occupancy masks (restoring full DaAn park),
        and Map View interactive previews load ultra-quick preview_tileset.json models across all devices."""
        import inspect
        import json as _json
        from pc_worker.native_octree_builder import build_native_octree_from_scalable_tileset
        from pc_worker.preview_generator import build_low_quality_preview_glb, simplify_glb_via_welded_qem

        # 1. Verify build_native_octree_from_scalable_tileset defaults preserve_existing_crop=False
        sig_oct = inspect.signature(build_native_octree_from_scalable_tileset)
        self.assertIn("preserve_existing_crop", sig_oct.parameters)
        self.assertFalse(sig_oct.parameters["preserve_existing_crop"].default)

        # 2. Verify build_low_quality_preview_glb defaults to sharp 110k tris, 2048px JPEG, allow_aggressive=False (never -sa UV corruption)
        from pc_worker.preview_generator import ensure_scan_low_quality_preview
        sig_prev = inspect.signature(build_low_quality_preview_glb)
        self.assertEqual(sig_prev.parameters["target_triangles"].default, 110000)
        self.assertEqual(sig_prev.parameters["max_tex_dim"].default, 2048)
        self.assertFalse(sig_prev.parameters["allow_aggressive"].default)
        self.assertTrue(callable(simplify_glb_via_welded_qem))
        qem_src = inspect.getsource(simplify_glb_via_welded_qem)
        self.assertIn("KHR_texture_transform", qem_src)
        self.assertIn("orig_inset", qem_src)
        self.assertIn("perms = ((0, 1, 2)", qem_src)
        ensure_src = inspect.getsource(ensure_scan_low_quality_preview)
        self.assertIn('_l1.glb"', ensure_src)

        # 3. Verify edited_daan_652376 ('DaAn') is uncropped on disk (full ~87m x 80m park, > 400 tiles)
        daan_dir = r"C:\GatheringScans\edited_daan_652376"
        if os.path.isdir(daan_dir):
            daan_ts_path = os.path.join(daan_dir, "tileset", "tileset.json")
            self.assertTrue(os.path.isfile(daan_ts_path))
            with open(daan_ts_path, "r", encoding="utf-8") as f:
                daan_ts = _json.load(f)
            r_box = daan_ts["root"]["boundingVolume"]["box"]
            self.assertGreater(float(r_box[3]), 35.0)
            self.assertGreater(float(r_box[7]), 35.0)
            daan_meta_path = os.path.join(daan_dir, "scan_meta.json")
            with open(daan_meta_path, "r", encoding="utf-8") as f:
                daan_meta = _json.load(f)
            self.assertNotIn("applied_adjustments", daan_meta)
            self.assertGreater(float(daan_meta["bounding_box"]["half_extents"][0]), 35.0)
            daan_prev_glb = os.path.join(daan_dir, "tileset", "preview_low", "tiles", "root.glb")
            self.assertTrue(os.path.isfile(daan_prev_glb))
            self.assertLess(os.path.getsize(daan_prev_glb), 3_800_000)

        # 4. Verify Map View loads preview_tileset.json across all devices in rough mode and tie-breaks same-date scans
        with open(os.path.join(BASE_DIR, "web", "src", "02-map-and-timeline.js"), "r", encoding="utf-8") as f:
            js02 = f.read()
        self.assertIn('const useRoughTilesetOnly = !previewThree._forceFullTilesetFallback && lodMode === "rough";', js02)
        self.assertIn("if (isPreviewTileset) {", js02)
        self.assertIn("Number(b.tileset_version || b.uploaded_at || 0) - Number(a.tileset_version || a.uploaded_at || 0)", js02)

        # 5. Verify run_pix4dmatic_pipeline uses proj_dir (never undefined project_dir) when archiving tileset_prev_rerun
        from pc_worker.pix4d_runner import run_pix4dmatic_pipeline
        runner_src = inspect.getsource(run_pix4dmatic_pipeline)
        self.assertNotIn("os.path.join(project_dir", runner_src)
        self.assertIn('os.path.join(proj_dir, "tileset")', runner_src)
        self.assertIn('os.path.join(proj_dir, "tileset_prev_rerun")', runner_src)

        # 6. Verify _CLOUD_SYNC_LOCK contention returns existing manifest and _save_cloud_manifest guards against status-only dicts
        from pc_worker.gdrive_cloud_sync import _CLOUD_SYNC_LOCK, sync_all_scans_to_gdrive_and_vps
        from pc_worker.server_cloud_and_tunnel import CLOUD_MANIFEST_PATH, _save_cloud_manifest
        acquired = _CLOUD_SYNC_LOCK.acquire(blocking=False)
        try:
            busy_ret = sync_all_scans_to_gdrive_and_vps(self.db, None, force=False)
            self.assertEqual(busy_ret.get("status"), "busy")
            if os.path.isfile(CLOUD_MANIFEST_PATH):
                self.assertIn("scans", busy_ret)
                self.assertGreater(len(busy_ret.get("scans") or []), 0)
        finally:
            if acquired:
                _CLOUD_SYNC_LOCK.release()
        _save_cloud_manifest({"status": "busy"})
        if os.path.isfile(CLOUD_MANIFEST_PATH):
            with open(CLOUD_MANIFEST_PATH, "r", encoding="utf-8") as mf:
                saved_m = _json.load(mf)
            self.assertIn("scans", saved_m)
            self.assertGreater(len(saved_m.get("scans") or []), 0)

    def test_49_surface_aware_zoom_and_3dtiles_lod_invariants(self):
        """Verify surface-aware zoom raycasting, non-collapsing 3D Tiles LOD traversal, Compare/Preview viewers, and Utilities mode scan visibility invariants."""
        with open(os.path.join(BASE_DIR, "web", "src", "03-studio-core.js"), "r", encoding="utf-8") as f:
            js03 = f.read()
        self.assertIn("const collectRaycastTargets = (v) =>", js03)
        self.assertIn("v.tilesRenderer.group", js03)
        self.assertIn("const minSurfDist = 0.25;", js03)
        self.assertNotIn("const tGround = (groundY - cam.position.y) / viewDir.y;", js03)
        self.assertNotIn("cam.position.addScaledVector(viewDir, stepAdvance);", js03)
        self.assertIn("if (studioThree.tilesRenderer && !STATE.multiAlign?.active) {", js03)
        self.assertIn("const filterValidHit = (hits, sbEval) =>", js03)
        self.assertIn("if (studioThree.tilesRenderer?.group && studioThree.tilesRenderer.group.visible) {", js03)

        with open(os.path.join(BASE_DIR, "web", "src", "02-map-and-timeline.js"), "r", encoding="utf-8") as f:
            js02 = f.read()
        self.assertIn("window.previewThree = previewThree;", js02)

        with open(os.path.join(BASE_DIR, "web", "src", "07-compare-and-queue.js"), "r", encoding="utf-8") as f:
            js07 = f.read()
        self.assertIn("installSurfaceAwareOrbitZoom(stage, () => compareCtx);", js07)
        self.assertNotIn("compareThree", js07)

        with open(os.path.join(BASE_DIR, "web", "lib", "3d-tiles-renderer.bundle.js"), "r", encoding="utf-8") as f:
            tiles_bundle = f.read()
        self.assertNotIn("e.loadAncestors&&!r.traversal.allChildrenLoaded&&!Ee(r)&&r.internal.hasContent&&Ft(r.internal.loadingState)&&(r.traversal.isLeaf=!0)", tiles_bundle)
        self.assertIn("e.traversal._queuedFrame===this.frameCount", tiles_bundle)
        self.assertIn("ge=isPreLeaf&&e.geometricError>2.5?Math.min(e.geometricError,.0036):e.geometricError", tiles_bundle)
        self.assertIn("pv=window.previewThree,cc=window.__gsCompareCtx", tiles_bundle)

        with open(os.path.join(BASE_DIR, "web", "src", "12-public-utilities-gis.js"), "r", encoding="utf-8") as f:
            js12 = f.read()
        self.assertIn("window.openPublicUtilitiesInspector = openUtilitiesInspector;", js12)
        self.assertIn("Boolean(UTILS_STATE.active) && hasVisibleUtilities3D() && dist > 60.0", js12)

    def test_50_utilities_per_vertex_terrain_and_gov_dem_draping(self):
        """
        Verify per-vertex bare-earth DTM + Government DEM elevation draping for 2D/3D utilities:
        1. Sloped scans (Rose Park, QuChi) produce non-flat per-vertex ground elevations (relief_m > 1.0m)
           and populate vertex_ground_hs, vertex_scan_ground_hs, vertex_gov_ground_hs, and terrain_grid.
        2. 2D uploaded GeoJSON files without Z coordinates are automatically draped onto the scan terrain + Gov DEM.
        3. Frontend 12-public-utilities-gis.js provides #selUtilElevationMode, sampleTerrainGridH, and mhRimByLayer.
        """
        import json as _json

        rp_res = self.survey.query_public_utilities_gis(
            {"scan_id": "rosepark_20260918_merged", "radius_m": 250.0, "force_refresh": False}
        )
        self.assertEqual(rp_res.get("status"), "ok")
        self.assertIn("elevation_summary", rp_res)
        self.assertGreater(float(rp_res["elevation_summary"].get("relief_m") or 0.0), 1.0)
        rp_pipes = [f for f in (rp_res.get("features") or []) if f.get("type") in ("pipe", "box_culvert")]
        self.assertGreater(len(rp_pipes), 0)
        self.assertTrue(any(isinstance(p.get("vertex_ground_hs"), list) and len(p["vertex_ground_hs"]) >= 2 for p in rp_pipes))

        # Test 2D GeoJSON file upload (missing Z coordinate) -> automatically draped onto bare-earth terrain
        geojson_2d = _json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {"id": "PIPE_2D_TEST", "layer": "storm", "diameter_mm": 500, "depth_m": 1.5},
                        "geometry": {
                            "type": "LineString",
                            "coordinates": [[303000.0, 2778650.0], [303045.0, 2778680.0]],
                        },
                    }
                ],
            }
        )
        parsed_2d = self.survey.parse_utilities_file(
            {
                "file_content": geojson_2d,
                "filename": "2d_storm.geojson",
                "scan_id": "edited_qihu_unified_merged_scan_4_scans__edited_372953",
            }
        )
        self.assertEqual(parsed_2d.get("status"), "ok")
        f2d = parsed_2d["features"][0]
        self.assertGreater(float(f2d.get("start_ground_h") or 0.0), 10.0)
        self.assertGreater(float(f2d.get("start_invert_h") or 0.0), 8.0)
        self.assertTrue(isinstance(f2d.get("vertex_ground_hs"), list) and len(f2d["vertex_ground_hs"]) >= 2)

        with open(os.path.join(BASE_DIR, "web", "src", "12-public-utilities-gis.js"), "r", encoding="utf-8") as f:
            js12 = f.read()
        self.assertIn('id="selUtilElevationMode"', js12)
        self.assertIn("sampleTerrainGridH", js12)
        self.assertIn("mhRimByLayer", js12)
        self.assertIn("vertex_scan_ground_hs", js12)

    def test_54_ui_redesign_phase2_invariants(self):
        with open(os.path.join(BASE_DIR, "web", "index.html"), "r", encoding="utf-8") as f:
            html = f.read()
        for required_id in (
            'id="mapCatalogModeSwitcher"',
            'id="btnCloseLibraryToMap"',
            'id="btnCloseSiteTimeline"',
            'id="btnStudioBackToTimeline"',
            'id="btnCompareBackToMap"',
            'id="studioInspectorEdgeTab"',
            'id="btnToggleEditDockCollapse"',
            'id="studioEditingDock"',
        ):
            self.assertIn(required_id, html)
        self.assertIn("gs-edit-dock-collapsed", html)
        for banned_emoji in ("⚡", "🗑", "🎯", "🔒", "🐢", "🧭", "📂", "🏛"):
            self.assertNotIn(banned_emoji, html)

        with open(os.path.join(BASE_DIR, "web", "survey-bim.css"), "r", encoding="utf-8") as f:
            bim_css = f.read()
        self.assertIn("--studio-inspector-w:", bim_css)
        self.assertIn("#studioEditingDock.gs-edit-dock-collapsed", bim_css)
        self.assertIn("writing-mode: vertical-rl", bim_css)
        self.assertIn("#viewMap.gs-library-mode-active", bim_css)
        self.assertIn("#studioEditingDock #btnToggleEditDockCollapse", bim_css)
        self.assertIn("#viewStudio:has(#studioFirstPersonHud.active) #studioEditingDock", bim_css)
        self.assertIn('#viewStudio:has(#studioMobileToolHud[style*="display: flex"]) #studioInspectorEdgeTab', bim_css)
        self.assertNotIn("#btnToggleEditDockCollapse {\n    display: none !important;\n  }", bim_css)

        with open(os.path.join(BASE_DIR, "web", "src", "01-core-state.js"), "r", encoding="utf-8") as f:
            js01 = f.read()
        self.assertIn("function getUnassignedScansList()", js01)
        self.assertIn('nextMode === "unassigned"', js01)
        self.assertIn("if (isLibraryFolderGroup(s.project_group) || s.group_type === \"library\") return false;", js01)
        self.assertIn("if (!STATE.siteTimelineOpen || !curScan || isLibraryScan(curScan))", js01)
        self.assertIn("if (isMobileViewport && typeof closeSiteTimeline === \"function\")", js01)

        with open(os.path.join(BASE_DIR, "web", "src", "03-studio-core.js"), "r", encoding="utf-8") as f:
            js03 = f.read()
        self.assertIn('getElementById("lblFpPointerLock")', js03)

        with open(os.path.join(BASE_DIR, "web", "src", "05-studio-civil-inspectors.js"), "r", encoding="utf-8") as f:
            js05 = f.read()
        self.assertIn("function syncSidePanelMinimizedState(", js05)
        self.assertIn("window.syncSidePanelMinimizedState = syncSidePanelMinimizedState;", js05)
        self.assertIn("const showEdgeTab = isOpen && isMin;", js05)
        self.assertNotIn("lblCollapse.textContent =", js05)
        self.assertNotIn("lblCol.textContent =", js05)
        self.assertNotIn("🔄 旋轉中", js05)
        self.assertNotIn("📐 ", js05)

        with open(os.path.join(BASE_DIR, "web", "src", "06-studio-align-and-optimizer.js"), "r", encoding="utf-8") as f:
            js06 = f.read()
        self.assertIn('getElementById("btnToggleEditDockCollapse")', js06)
        self.assertIn('dock.classList.remove("gs-edit-dock-collapsed")', js06)
        self.assertIn("function _setEditDockCollapsedState(collapsed)", js06)
        self.assertIn("align-brightness-slider", js06)
        self.assertIn("align-brightness-num", js06)
        self.assertIn("btn-align-reset-bright", js06)
        self.assertIn("applyLayerBrightnessTo3D", js06)
        self.assertIn("brightness: Number(Number(l.brightness ?? 1.0).toFixed(2))", js06)

        with open(os.path.join(BASE_DIR, "pc_worker", "optimizer_bridge.py"), "r", encoding="utf-8") as f:
            bridge_py = f.read()
        self.assertIn("ImageEnhance.Brightness(pil_im).enhance(p_brightness)", bridge_py)
        self.assertIn('"brightness": ly_brightness', bridge_py)

        with open(os.path.join(BASE_DIR, "web", "app.js"), "r", encoding="utf-8") as f:
            app_js = f.read()
        self.assertIn('getElementById("btnExitExternalPreview")', app_js)
        self.assertIn('window.innerWidth <= 767 && STATE.leftPaneMode === "library" && STATE.siteTimelineOpen', app_js)
        self.assertNotIn("lblCol.textContent =", app_js)


if __name__ == "__main__":
    unittest.main()
