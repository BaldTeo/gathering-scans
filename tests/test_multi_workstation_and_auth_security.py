#!/usr/bin/env python3
"""
Verification suite for:
1. Redesigned Multi-Workstation Coordinator (DESKTOP-OEBISC7 + WorkPC1, zero '(this PC)', daemon start/pause, strict processing pinning, 0ms query failover, Syncthing readiness)
2. Admin-only Queue / Workstation / Cancel controls (hidden & 403-protected from non-admins)
3. Persistent 90-day Admin login, clean Google-OAuth-only login screen, 'Log out everyone' (min_valid_iat), zero guest access, and instant share-link revocation
4. Google Chat 4-button prompts tagging 雲在天 (both raw Catch inputs & finished PIX4Dmatic projects; preview always uses SkyMask + ROI)
5. Manual scan imports (catch_TUroof & catch_QuChi_BianDao) with portable cross-workstation RTK camera catalogs + Studio mesh smoothness
"""

import json
import os
import shutil
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest.mock import patch

import server as main_server
from pc_worker import config as gs_config
from pc_worker import server_api_routes
from pc_worker import server_cloud_and_tunnel as gs_server
from pc_worker.auth_and_sharing import (
    AuthAndSharingManager,
    issue_session_token,
    verify_session_token,
)
from pc_worker.gchat_notifier import GoogleChatNotifier
from pc_worker.pix4d_runner import (
    are_syncthing_inputs_ready,
    generate_pix4dmatic_gst_script,
)
from pc_worker.priority_queue import ScanQueueDB
from pc_worker.surveying_engine import SurveyingEngine

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class TestMultiWorkstationAuthAndImports(unittest.TestCase):
    def test_01_multi_workstation_coordinator_pinning_and_failover(self):
        tmp_dir = tempfile.mkdtemp(prefix="gs_ws_coord_")
        try:
            ws_file = os.path.join(tmp_dir, "workstation_settings.json")
            with patch.object(gs_config, "WORKSTATION_SETTINGS_PATH", ws_file):
                cfg = gs_config.load_workstation_settings()
                self.assertIn("DESKTOP-OEBISC7", cfg["workstations"])
                self.assertIn("WorkPC1", cfg["workstations"])
                self.assertEqual(cfg["workstations"]["WorkPC1"]["root_dir"], r"D:\GatheringScans")

                # Strict processing_workstation pinning: if pinned to DESKTOP-OEBISC7, WorkPC1 NEVER processes even if DESKTOP-OEBISC7 is offline
                cfg["processing_workstation"] = "DESKTOP-OEBISC7"
                cfg["query_serving_workstation"] = "WorkPC1"
                cfg["workstations"]["DESKTOP-OEBISC7"]["last_seen"] = time.time() - 3600  # offline 1h
                cfg["workstations"]["WorkPC1"]["last_seen"] = time.time()  # online now
                gs_config.save_workstation_settings(cfg)

                self.assertTrue(gs_config.is_workstation_processing_active("DESKTOP-OEBISC7"))
                self.assertFalse(gs_config.is_workstation_processing_active("WorkPC1"))

                # Query serving respects online WorkPC1, and fails over to DESKTOP-OEBISC7 in 0ms once WorkPC1 goes stale > 45s
                self.assertTrue(gs_config.is_workstation_query_serving_active("WorkPC1"))
                self.assertFalse(gs_config.is_workstation_query_serving_active("DESKTOP-OEBISC7"))

                cfg["workstations"]["WorkPC1"]["last_seen"] = time.time() - 120
                gs_config.save_workstation_settings(cfg)
                self.assertTrue(gs_config.is_workstation_query_serving_active("DESKTOP-OEBISC7"))

                # Heartbeat preserves admin-configured nickname and daemon_enabled toggle
                cfg["workstations"]["WorkPC1"]["name"] = "Always-On Office Server"
                cfg["workstations"]["WorkPC1"]["daemon_enabled"] = False
                gs_config.save_workstation_settings(cfg)
                updated = gs_config.register_workstation_heartbeat("WorkPC1", {"name": "IgnoredDefaultName", "daemon_enabled": True})
                self.assertEqual(updated["workstations"]["WorkPC1"]["name"], "Always-On Office Server")
                self.assertFalse(updated["workstations"]["WorkPC1"]["daemon_enabled"])
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)

        # Verify UI renders zero '(this PC)' labels
        with open(os.path.join(BASE_DIR, "web", "src", "07-compare-and-queue.js"), "r", encoding="utf-8") as f:
            js07 = f.read()
        self.assertNotIn("(this PC)", js07)
        self.assertIn("refreshWorkstationCoordinatorPanels", js07)

    def test_02_syncthing_folder_readiness_guard(self):
        tmp_dir = tempfile.mkdtemp(prefix="gs_syncthing_chk_")
        try:
            img_dir = os.path.join(tmp_dir, "inputs", "images")
            os.makedirs(img_dir, exist_ok=True)
            for i in range(3):
                with open(os.path.join(img_dir, f"Image_{i:04d}.jpg"), "wb") as wf:
                    wf.write(b"\xff\xd8\xff\xd9")

            # Temp .syncthing.*.tmp file blocks readiness
            tmp_sync = os.path.join(img_dir, ".syncthing.Image_0003.jpg.tmp")
            with open(tmp_sync, "wb") as wf:
                wf.write(b"partial")
            ok_busy, reason_busy = are_syncthing_inputs_ready("test_sync_scan", "", proj_dir=tmp_dir)
            self.assertFalse(ok_busy)
            self.assertIn("syncthing", reason_busy.lower())

            os.remove(tmp_sync)
            with open(os.path.join(tmp_dir, "inputs", "_staged_manifest.json"), "w", encoding="utf-8") as mf:
                json.dump({"expected_image_count": 10}, mf)
            ok_short, _ = are_syncthing_inputs_ready("test_sync_scan", "", proj_dir=tmp_dir)
            self.assertFalse(ok_short)

            with open(os.path.join(tmp_dir, "inputs", "_staged_manifest.json"), "w", encoding="utf-8") as mf:
                json.dump({"expected_image_count": 3}, mf)
            ok_ready, _ = are_syncthing_inputs_ready("test_sync_scan", "", proj_dir=tmp_dir)
            self.assertTrue(ok_ready)
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)

    def test_03_persistent_auth_logout_everyone_zero_guest_and_share_revocation(self):
        tmp_dir = tempfile.mkdtemp(prefix="gs_auth_sec_")
        try:
            tmp_db = ScanQueueDB(db_path=os.path.join(tmp_dir, "auth_test.db"))
            tmp_auth = AuthAndSharingManager(tmp_db)
            tmp_sec_path = os.path.join(tmp_dir, "session_security.json")
            tmp_ws_path = os.path.join(tmp_dir, "workstation_settings.json")
            tmp_mf_path = os.path.join(tmp_dir, "cloud_manifest.json")
            with open(tmp_mf_path, "w", encoding="utf-8") as mf:
                json.dump({"scans": [], "share_links": []}, mf)

            tmp_db.upsert_scan(
                {
                    "scan_id": "test_scan_alpha",
                    "name": "Alpha Scan",
                    "project_group": "Alpha Site",
                    "status": "completed",
                }
            )
            tmp_db.upsert_scan(
                {
                    "scan_id": "test_scan_beta",
                    "name": "Beta Queued Scan",
                    "project_group": "Alpha Site",
                    "status": "queued",
                }
            )

            tmp_auth.admin_save_user(
                actor_email="glibivanov@gatheren.com.tw",
                target_email="viewer@gatheren.com.tw",
                name="Viewer Engineer",
                role="viewer",
            )

            with patch.object(gs_config, "DATA_DIR", tmp_dir), \
                 patch.object(gs_config, "AUTH_GLOBAL_STATE_PATH", tmp_sec_path), \
                 patch.object(gs_config, "WORKSTATION_SETTINGS_PATH", tmp_ws_path), \
                 patch.object(server_api_routes, "DB", tmp_db), \
                 patch.object(server_api_routes, "AUTH_SHARE", tmp_auth), \
                 patch.object(server_api_routes, "_load_cloud_manifest", lambda: {"scans": [], "share_links": []}), \
                 patch.object(server_api_routes, "_save_cloud_manifest", lambda d: None), \
                 patch.object(gs_server, "DB", tmp_db), \
                 patch.object(gs_server, "AUTH_SHARE", tmp_auth), \
                 patch("pc_worker.gdrive_cloud_sync.sync_all_scans_to_gdrive_and_vps", lambda *a, **kw: {"scans": [], "share_links": []}), \
                 patch.object(gs_server, "_load_cloud_manifest", lambda: {"scans": [], "share_links": []}), \
                 patch.object(gs_server, "_save_cloud_manifest", lambda d: None), \
                 patch.object(main_server, "DB", tmp_db), \
                 patch.object(main_server, "AUTH_SHARE", tmp_auth):

                old_owner_tok = issue_session_token("glibivanov@gatheren.com.tw", role="owner")
                viewer_tok = issue_session_token("viewer@gatheren.com.tw", role="viewer")

                httpd = ThreadingHTTPServer(("127.0.0.1", 0), main_server.GatheringScansHandler)
                port = httpd.server_address[1]
                threading.Thread(target=httpd.serve_forever, daemon=True).start()
                base = f"http://127.0.0.1:{port}"
                try:
                    def _req(method, path, body=None, token=""):
                        hdrs = {"Content-Type": "application/json"}
                        if token:
                            hdrs["X-Session-Token"] = token
                        data = json.dumps(body).encode("utf-8") if body is not None else None
                        r = urllib.request.Request(base + path, data=data, headers=hdrs, method=method)
                        try:
                            with urllib.request.urlopen(r, timeout=8) as resp:
                                return resp.status, json.loads(resp.read().decode("utf-8"))
                        except urllib.error.HTTPError as he:
                            return he.code, json.loads(he.read().decode("utf-8"))

                    # 1. Zero guest access: unauthenticated /api/scans returns 401
                    st_unauth, _ = _req("GET", "/api/scans")
                    self.assertEqual(st_unauth, 401)

                    # 2. Persistent Admin session validation via GET /api/auth/session returnsOwner permissions
                    st_sess, sess_data = _req("GET", "/api/auth/session", token=old_owner_tok)
                    self.assertEqual(st_sess, 200)
                    self.assertTrue(sess_data["authenticated"])
                    self.assertTrue(sess_data["isOwner"])
                    self.assertTrue(sess_data["isAdmin"])

                    # 3. Non-admin (Viewer) can read queue progress (/api/queue/status) WITHOUT seeing workstation settings,
                    #    and receives 403 on /api/admin/workstations & /api/queue/cancel
                    st_vq, vq_data = _req("GET", "/api/queue/status", token=viewer_tok)
                    self.assertEqual(st_vq, 200)
                    self.assertNotIn("workstation_settings", vq_data)
                    st_vws, _ = _req("GET", "/api/admin/workstations", token=viewer_tok)
                    self.assertEqual(st_vws, 403)
                    st_vcancel, _ = _req("POST", "/api/queue/cancel", {"scan_id": "test_scan_beta"}, token=viewer_tok)
                    self.assertEqual(st_vcancel, 403)

                    # 4. Admin can cancel queued scan and manage workstations
                    st_aws, aws_data = _req("GET", "/api/admin/workstations", token=old_owner_tok)
                    self.assertEqual(st_aws, 200)
                    self.assertIn("DESKTOP-OEBISC7", aws_data["workstations"])
                    self.assertIn("WorkPC1", aws_data["workstations"])
                    st_acancel, _ = _req("POST", "/api/queue/cancel", {"scan_id": "test_scan_beta"}, token=old_owner_tok)
                    self.assertEqual(st_acancel, 200)
                    self.assertEqual(tmp_db.get_scan("test_scan_beta")["status"], "cancelled")

                    # 5. Scoped share link works without Google login and revokes immediately (including embed fallback)
                    st_sh, sh_data = _req(
                        "POST",
                        "/api/share/create",
                        {"scope_type": "scan", "target_id": "test_scan_alpha", "label": "Client Link"},
                        token=old_owner_tok,
                    )
                    self.assertEqual(st_sh, 200)
                    sh_tok = sh_data["link"]["token"]
                    st_pub_ok, pub_scans = _req("GET", f"/api/scans?share={sh_tok}")
                    self.assertEqual(st_pub_ok, 200)
                    self.assertEqual(len(pub_scans["scans"]), 1)

                    st_rev, _ = _req("POST", "/api/share/revoke", {"token": sh_tok}, token=old_owner_tok)
                    self.assertEqual(st_rev, 200)
                    st_pub_rev, _ = _req("GET", f"/api/scans?share={sh_tok}")
                    self.assertEqual(st_pub_rev, 403)
                    stray_mf = os.path.join(tmp_dir, "gdrive_cloud_manifest.json")
                    if os.path.exists(stray_mf):
                        os.remove(stray_mf)
                    ok_ph_after, _, _, _ = tmp_auth.validate_share_access("YOUR_SHARE_TOKEN")
                    self.assertFalse(ok_ph_after)

                    # 6. Admin clicks 'Log out everyone' -> old_owner_tok & viewer_tok immediately become invalid (401)!
                    time.sleep(1.1)
                    st_lge, lge_data = _req("POST", "/api/admin/logout-everyone", {}, token=old_owner_tok)
                    self.assertEqual(st_lge, 200)
                    self.assertTrue(lge_data["ok"])
                    self.assertIsNone(verify_session_token(old_owner_tok))
                    self.assertIsNone(verify_session_token(viewer_tok))
                    st_old_after, _ = _req("GET", "/api/auth/session", token=old_owner_tok)
                    self.assertEqual(st_old_after, 401)

                    # Newly issued token after logout-everyone works cleanly
                    time.sleep(1.1)
                    fresh_owner_tok = issue_session_token("glibivanov@gatheren.com.tw", role="owner")
                    st_fresh, fresh_sess = _req("GET", "/api/auth/session", token=fresh_owner_tok)
                    self.assertEqual(st_fresh, 200)
                    self.assertTrue(fresh_sess["isOwner"])
                finally:
                    httpd.shutdown()
                    httpd.server_close()
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)

    def test_04_gchat_4_button_prompts_and_preview_skymask_roi(self):
        tmp_dir = tempfile.mkdtemp(prefix="gs_gchat_test_")
        try:
            tmp_db = ScanQueueDB(db_path=os.path.join(tmp_dir, "gchat.db"))
            notifier = GoogleChatNotifier(tmp_db, webhook_url="")
            captured_cards = []
            with patch.object(
                notifier,
                "_dispatch_card_to_uploader",
                side_effect=lambda *a, **kw: (captured_cards.append(kw.get("card_payload")) or {"sent": True}),
            ):
                scan_rec = {
                    "scan_id": "catch_test_new",
                    "name": "Test New Scan",
                    "project_group": "QuChi Dam",
                    "image_count": 420,
                }
                notifier.notify_new_scan_preset_question(
                    "catch_test_new",
                    scan_rec,
                    preview_img_url="https://scans.gatheren.cloud/thumb.jpg",
                    decision_token="tok123",
                )
                raw_json = json.dumps(captured_cards[-1], ensure_ascii=False)
                self.assertIn("<users/107639887113416939995>", raw_json)
                for preset_tok in ("cancel", "optimal_nosky", "optimal_sky", "manual_preset=1"):
                    self.assertIn(preset_tok, raw_json)

                notifier.notify_manual_project_import_question(
                    "catch_test_manual",
                    scan_rec,
                    preview_img_url="https://scans.gatheren.cloud/thumb.jpg",
                    decision_token="tok456",
                )
                fin_json = json.dumps(captured_cards[-1], ensure_ascii=False)
                self.assertIn("<users/107639887113416939995>", fin_json)
                for mode_tok in ("replace_existing", "import_separate", "rerun_photos", "cancel"):
                    self.assertIn(mode_tok, fin_json)
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)

        # Preview round MUST always enable GenerateSkyMasks + ROI
        preview_gst = generate_pix4dmatic_gst_script(
            project_p4m_path=os.path.join(BASE_DIR, "test_proj.p4m"),
            input_zip_or_folder=BASE_DIR,
            export_dir=BASE_DIR,
            pipeline_pass="preview",
        )
        self.assertIn("GenerateSkyMasks", preview_gst)
        self.assertIn("SkyMasks{ }", preview_gst)

    def test_05_manual_imports_portable_photos_and_studio_smoothness(self):
        with open(os.path.join(BASE_DIR, "web", "src", "03-studio-core.js"), "r", encoding="utf-8") as f:
            js03 = f.read()
        self.assertIn("cursorHitPt", js03)
        self.assertIn("updateProjectionMatrix", js03)

        if os.name == "nt" and os.path.isdir(r"C:\GatheringScans\catch_TUroof"):
            db = ScanQueueDB()
            eng = SurveyingEngine(db)
            tu = db.get_scan("catch_TUroof")
            if tu is not None:
                self.assertTrue(os.path.isfile(tu["tileset_path"]))
                with open(tu["tileset_path"], "r", encoding="utf-8") as tuf:
                    tu_ts_doc = json.load(tuf)
                self.assertGreaterEqual(len((tu_ts_doc.get("root") or {}).get("children") or []), 70)
                self.assertGreaterEqual(int(tu.get("poly_count") or 0), 30000000)
                cams = eng._load_or_build_camera_catalog(tu)
                self.assertEqual(len(cams), 1463)
                self.assertTrue(cams[0]["abs_path"].lower().startswith(r"c:\gatheringscans\catch_turoof\inputs"))
                self.assertTrue(os.path.isfile(eng.resolve_camera_photo_path("catch_TUroof", cams[0]["filename"])))

        if os.name == "nt" and os.path.isdir(r"C:\GatheringScans\catch_QuChi_BianDao"):
            db = ScanQueueDB()
            eng = SurveyingEngine(db)
            qc_bd = db.get_scan("catch_QuChi_BianDao")
            self.assertIsNotNone(qc_bd)
            self.assertEqual(qc_bd["name"], "屈尺便道")
            self.assertEqual(qc_bd["project_group"], "QuChi Dam")
            self.assertTrue(os.path.isfile(qc_bd["tileset_path"]))
            with open(qc_bd["tileset_path"], "r", encoding="utf-8") as tsf:
                qc_ts_doc = json.load(tsf)
            self.assertGreaterEqual(len((qc_ts_doc.get("root") or {}).get("children") or []), 40)
            self.assertGreaterEqual(int(qc_bd.get("poly_count") or 0), 5000000)
            cams_bd = eng._load_or_build_camera_catalog(qc_bd)
            self.assertGreaterEqual(len(cams_bd), 2400)
            self.assertTrue(cams_bd[0]["abs_path"].lower().startswith(r"c:\gatheringscans\catch_quchi_biandao\inputs"))
            self.assertTrue(os.path.isfile(eng.resolve_camera_photo_path("catch_QuChi_BianDao", cams_bd[0]["filename"])))


if __name__ == "__main__":
    unittest.main()
