"""Targeted unit tests for Syncthing dual-workstation coordination, admin queue cancel, GChat preset prompt, and mandatory preview SkyMask+ROI."""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class WorkstationGchatPresetTests(unittest.TestCase):
    def test_01_preview_always_enforces_skymask_and_roi(self):
        from pc_worker import config, pix4d_runner

        self.assertTrue(config.FAST_PREVIEW_PIX4D_SETTINGS["skyless"])
        self.assertTrue(config.FAST_PREVIEW_PIX4D_SETTINGS["use_roi"])

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as td:
            p4m_path = os.path.join(td, "test_scan.p4m")
            script = pix4d_runner.generate_pix4dmatic_gst_script(
                project_p4m_path=p4m_path,
                input_zip_or_folder=td,
                export_dir=td,
                pipeline_pass="preview",
                pipeline_settings={"skyless": False, "use_roi": False},
            )
            self.assertIn("settings.skyless : true", script.lower())
            self.assertIn("generateskymasks", script.lower())
            self.assertIn("roiset{ }", script.lower())

    def test_02_workstation_settings_and_heartbeat(self):
        from pc_worker import config

        orig_path = config.WORKSTATION_SETTINGS_PATH
        try:
            with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as td:
                config.WORKSTATION_SETTINGS_PATH = os.path.join(td, "ws.json")
                config.register_workstation_heartbeat("PC-A", {"root_dir": r"C:\GatheringScans"})
                config.register_workstation_heartbeat("PC-B", {"root_dir": r"D:\GatheringScans"})

                cfg = config.load_workstation_settings()
                self.assertIn("PC-A", cfg["workstations"])
                self.assertIn("PC-B", cfg["workstations"])
                self.assertTrue(config.is_workstation_daemon_active("PC-A"))

                config.save_workstation_settings(
                    {
                        "query_serving_workstation": "PC-A",
                        "processing_workstation": "PC-B",
                        "workstations": {"PC-A": {"daemon_enabled": False}},
                    }
                )
                self.assertTrue(config.is_workstation_query_serving_active("PC-A"))
                self.assertFalse(config.is_workstation_query_serving_active("PC-B"))
                self.assertFalse(config.is_workstation_processing_active("PC-A"))
                self.assertTrue(config.is_workstation_processing_active("PC-B"))
                self.assertFalse(config.is_workstation_daemon_active("PC-A"))
                self.assertTrue(config.is_workstation_daemon_active("PC-B"))
        finally:
            config.WORKSTATION_SETTINGS_PATH = orig_path

    def test_03_awaiting_preset_gchat_decision_and_cancel_scan(self):
        from pc_worker.priority_queue import ScanQueueDB
        from pc_worker import server_api_routes

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as td:
            db = ScanQueueDB(db_path=os.path.join(td, "test_q.db"))
            orig_db = server_api_routes.DB
            server_api_routes.DB = db
            try:
                db.upsert_scan(
                    {
                        "scan_id": "scan_wait_preset",
                        "name": "WaitPreset",
                        "status": "queued",
                        "image_count": 20,
                        "extra_json": {"awaiting_preset": True, "preset_token": "tok123"},
                    }
                )
                # pop_next_job must skip awaiting_preset=True
                self.assertIsNone(db.pop_next_job())

                # Wrong token rejected
                with self.assertRaises(PermissionError):
                    server_api_routes.apply_gchat_preset_decision("scan_wait_preset", "optimal_sky", "badtok")

                # Optimal with SkyMask clears awaiting_preset and sets pipeline_settings
                res = server_api_routes.apply_gchat_preset_decision("scan_wait_preset", "optimal_sky", "tok123")
                self.assertEqual(res["status"], "ok")
                row = db.get_scan("scan_wait_preset")
                ex = json.loads(row["extra_json"]) if isinstance(row["extra_json"], str) else row["extra_json"]
                self.assertFalse(ex.get("awaiting_preset"))
                self.assertTrue(ex["pipeline_settings"]["skyless"])

                # Cancel scan marks status as cancelled
                c_res = db.cancel_scan("scan_wait_preset", actor_email="admin@test.com")
                self.assertEqual(c_res["status"], "cancelled")
                row2 = db.get_scan("scan_wait_preset")
                self.assertEqual(row2["status"], "cancelled")
            finally:
                server_api_routes.DB = orig_db


if __name__ == "__main__":
    unittest.main()
