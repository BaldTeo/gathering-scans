"""Portable scan bundles: publish on PC-A, adopt on PC-B, archive inputs, claims, photo archive."""
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
import zipfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pc_worker import portable_bundle as pb  # noqa: E402
from pc_worker.priority_queue import ScanQueueDB  # noqa: E402


class PortableBundleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="gs_pb_")
        self.drive = os.path.join(self.tmp, "G", "GatheringScans")
        os.makedirs(os.path.join(self.drive, "INPUTS", "TUroof"))
        self.root_a = os.path.join(self.tmp, "pcA")
        self.root_b = os.path.join(self.tmp, "pcB")
        self.data_a = os.path.join(self.tmp, "dataA")
        self.data_b = os.path.join(self.tmp, "dataB")
        for d in (self.root_a, self.root_b, self.data_a, self.data_b):
            os.makedirs(d)
        self._saved = (pb.GDRIVE_INBOX_DIR, pb.GDRIVE_INPUTS_DIR, pb.LOCAL_SCANS_ROOT, pb.DATA_DIR, pb.CLAIM_SETTLE_SEC)
        pb.GDRIVE_INBOX_DIR = self.drive
        pb.GDRIVE_INPUTS_DIR = os.path.join(self.drive, "INPUTS")
        pb.CLAIM_SETTLE_SEC = 0.0
        pb._OBS.clear()
        pb._MY_CLAIMS.clear()
        pb._PHOTO_INDEX.clear()

        # --- PC A: a finished scan with tileset, exports, raw photos and the input zip still in INPUTS
        self.sid = "catch_TUfloor"
        pb.LOCAL_SCANS_ROOT, pb.DATA_DIR = self.root_a, self.data_a
        self.proj_a = os.path.join(self.root_a, self.sid)
        os.makedirs(os.path.join(self.proj_a, "tileset", "tiles"))
        os.makedirs(os.path.join(self.proj_a, "exports"))
        os.makedirs(os.path.join(self.proj_a, "inputs", "TUfloor", "images"))
        for name, data in (("tileset/tileset.json", b"{}"), ("tileset/tiles/root.glb", b"glb" * 100),
                           ("exports/mesh.obj", b"o x"), ("scan_meta.json", b"{}"), ("pix4d_stdout.log", b"log")):
            with open(os.path.join(self.proj_a, name), "wb") as f:
                f.write(data)
        for i in range(3):
            with open(os.path.join(self.proj_a, "inputs", "TUfloor", "images", f"Image_{i:06d}.jpg"), "wb") as f:
                f.write(b"jpg%d" % i)
        with open(os.path.join(self.proj_a, "inputs", "TUfloor", "images", "Confidence_000001.tiff"), "wb") as f:
            f.write(b"tiff")
        self.zip_src = os.path.join(self.drive, "INPUTS", "TUroof", "TUfloor.zip")
        with zipfile.ZipFile(self.zip_src, "w") as zf:
            zf.writestr("a.txt", "x")

        self.db_a = ScanQueueDB(os.path.join(self.data_a, "gs.db"))
        self.db_a.upsert_scan({
            "scan_id": self.sid, "name": "TUfloor", "project_group": "NTU", "capture_date": "2026-11-12",
            "uploaded_at": time.time(), "uploader_email": "a@b.c", "uploader_name": "A",
            "source_zip_path": self.zip_src, "project_dir": self.proj_a,
            "tileset_path": os.path.join(self.proj_a, "tileset", "tileset.json"),
            "cameras_dir": os.path.join(self.proj_a, "inputs"), "status": "completed",
            "progress_pct": 100.0, "quality_stage": "full_hq", "tileset_version": 5,
        })

    def tearDown(self):
        pb.GDRIVE_INBOX_DIR, pb.GDRIVE_INPUTS_DIR, pb.LOCAL_SCANS_ROOT, pb.DATA_DIR, pb.CLAIM_SETTLE_SEC = self._saved
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_publish_adopt_archive_roundtrip(self):
        row = self.db_a.get_scan(self.sid)
        self.assertTrue(pb.needs_publish(row))
        self.assertTrue(pb.publish_scan(self.db_a, row))
        m = pb.manifest_for(self.sid)
        self.assertEqual(m["photo_count"], 3)  # jpgs only, tiff depth/confidence excluded
        self.assertEqual(m["tileset_version"], 5)
        self.assertFalse(pb.needs_publish(self.db_a.get_scan(self.sid)))
        # bundle must exclude raw inputs and logs
        with zipfile.ZipFile(os.path.join(self.drive, "SCANS", self.sid, f"{self.sid}.gsbundle")) as zf:
            names = zf.namelist()
        self.assertIn("files/tileset/tileset.json", names)
        self.assertFalse(any(n.startswith("files/inputs/") for n in names))
        self.assertFalse(any(n.endswith(".log") for n in names))

        # input zip moves INPUTS -> PROCESSED (project subfolder preserved), DB path updated
        moved = pb.archive_inputs(self.db_a, self.db_a.get_scan(self.sid))
        self.assertEqual(len(moved), 1)
        self.assertFalse(os.path.exists(self.zip_src))
        self.assertTrue(os.path.isfile(os.path.join(self.drive, "PROCESSED", "TUroof", "TUfloor.zip")))
        self.assertIn("PROCESSED", self.db_a.get_scan(self.sid)["source_zip_path"])

        # --- PC B: empty root, different drive letter / root; adopts without reprocessing
        pb.LOCAL_SCANS_ROOT, pb.DATA_DIR = self.root_b, self.data_b
        db_b = ScanQueueDB(os.path.join(self.data_b, "gs.db"))
        self.assertEqual(pb.adopt_missing(db_b), [self.sid])
        got = db_b.get_scan(self.sid)
        self.assertEqual(got["status"], "completed")
        self.assertTrue(got["tileset_path"].startswith(self.root_b))
        self.assertTrue(os.path.isfile(got["tileset_path"]))
        self.assertTrue(got["project_dir"].startswith(self.root_b))
        self.assertEqual(pb.adopt_missing(db_b), [])  # idempotent: already current

        # photo served from the Drive archive although no raw images exist on PC B
        p = pb.extract_photo_from_archive(self.sid, "Image_000001.jpg")
        self.assertTrue(p and os.path.isfile(p))
        with open(p, "rb") as f:
            self.assertEqual(f.read(), b"jpg1")
        self.assertIsNone(pb.extract_photo_from_archive(self.sid, "../../etc/passwd"))

    def test_claims_block_second_pc_and_release(self):
        pb.LOCAL_SCANS_ROOT, pb.DATA_DIR = self.root_a, self.data_a
        won, _ = pb.try_claim("catch_X")
        self.assertTrue(won)
        # a different PC id sees the live claim
        pb.DATA_DIR = self.data_b
        pb._MY_CLAIMS.clear()
        self.assertNotEqual(pb.pc_id(), json.load(open(os.path.join(self.data_a, "pc_id.json")))["id"])
        won2, owner = pb.try_claim("catch_X")
        self.assertFalse(won2)
        self.assertTrue(owner)
        # original PC releases -> other PC can claim
        pb.DATA_DIR = self.data_a
        pb._MY_CLAIMS["catch_X"] = {"pc": pb.pc_id()}
        pb.release_claim("catch_X")
        pb.DATA_DIR = self.data_b
        pb._OBS.clear()
        self.assertTrue(pb.try_claim("catch_X")[0])

    def test_stale_claim_is_taken_over(self):
        pb.DATA_DIR = self.data_a
        pb.try_claim("catch_Y")
        pb._MY_CLAIMS.clear()  # PC A "crashes": claim file stays, heartbeat stops
        pb.DATA_DIR = self.data_b
        old = pb.STALE_CLAIM_SEC
        try:
            pb.STALE_CLAIM_SEC = 0.05
            self.assertFalse(pb.try_claim("catch_Y")[0])  # first observation counts as live
            time.sleep(0.1)
            self.assertTrue(pb.try_claim("catch_Y")[0])  # heartbeat unchanged for > STALE -> takeover
        finally:
            pb.STALE_CLAIM_SEC = old

    def test_drive_offline_is_noop(self):
        pb.GDRIVE_INBOX_DIR = os.path.join(self.tmp, "does_not_exist")
        self.assertFalse(pb.drive_available())
        self.assertEqual(pb.try_claim("catch_Z"), (True, ""))
        self.assertFalse(pb.needs_publish(self.db_a.get_scan(self.sid)))


if __name__ == "__main__":
    unittest.main()
