#!/usr/bin/env python3
"""
Adversarial Empirical Verification Suite for Milestone 7
(Real Public Utilities GIS Integration with Taiwan Open APIs)
Tested by: challenger_m7_2
"""

import os
import sys
import json
import sqlite3
import unittest
import urllib.request
import urllib.error
import ezdxf

LOCAL_SERVER = "http://127.0.0.1:8095"

class TestMilestone7EmpiricalAdversarial(unittest.TestCase):

    def _post(self, path, payload):
        url = f"{LOCAL_SERVER}{path}"
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=15) as res:
            self.assertEqual(res.status, 200)
            return json.loads(res.read().decode("utf-8"))

    def test_01_live_utilities_query_rosepark(self):
        """Query genuine public utilities around Rose Park scan center."""
        payload = {
            "scan_id": "rosepark_20260918_merged",
            "radius_m": 120.0,
        }
        res = self._post("/api/survey/utilities-query", payload)
        self.assertEqual(res.get("status"), "ok")
        self.assertIn("features", res)
        self.assertIn("layer_counts", res)
        self.assertGreater(len(res["features"]), 0, "Rose Park should return real utility features")
        print(f"[Query RosePark] Found {len(res['features'])} features. Layer counts: {res['layer_counts']}")

    def test_02_live_utilities_query_zero_fabrication_ocean(self):
        """Adversarial check: unpopulated offshore ocean coordinate must strictly return 0 features."""
        payload = {
            "center_e": 100000.0,
            "center_n": 2500000.0,
            "radius_m": 50.0,
            "force_refresh": True,
        }
        res = self._post("/api/survey/utilities-query", payload)
        self.assertEqual(res.get("status"), "ok")
        self.assertEqual(len(res.get("features", [])), 0, "Offshore coordinate must return 0 features (no mock/fake data)")
        self.assertEqual(res.get("total_features"), 0)

    def test_03_live_utilities_parse_moi_gml(self):
        """Parse valid MOI NGIS GML 3.1.1 XML payload."""
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
        payload = {
            "filename": "official_moi_pipe.gml",
            "file_content": gml_text,
        }
        res = self._post("/api/survey/utilities-parse", payload)
        self.assertEqual(res.get("status"), "ok")
        self.assertEqual(res.get("total_features"), 2)
        pipe = next(f for f in res["features"] if f["type"] == "pipe")
        self.assertEqual(pipe["diameter_mm"], 600)
        self.assertEqual(pipe["flow_direction"], 1)

    def test_04_live_utilities_parse_adversarial_garbage(self):
        """Adversarial check: parse corrupt/garbage XML or empty payload."""
        payload = {
            "filename": "corrupt.gml",
            "file_content": "This is totally not XML <unclosed tag",
        }
        res = self._post("/api/survey/utilities-parse", payload)
        # Should gracefully return error or empty features, not crash server (500)
        self.assertIn("status", res)
        print(f"[Parse Garbage] Handled gracefully with status: {res.get('status')}")

    def test_05_live_utilities_export_dxf_and_syntax_validation(self):
        """Export utilities to DXF and deeply validate DXF syntax and entities."""
        # Query features first
        res_q = self._post("/api/survey/utilities-query", {"scan_id": "rosepark_20260918_merged", "radius_m": 100.0})
        features = res_q.get("features", [])
        self.assertGreater(len(features), 0)

        export_payload = {
            "scan_id": "rosepark_20260918_merged",
            "format": "dxf",
            "features": features,
        }
        res_exp = self._post("/api/survey/utilities-export", export_payload)
        self.assertEqual(res_exp.get("status"), "ok")
        fname = res_exp.get("filename")
        self.assertTrue(fname)
        dxf_path = os.path.join(r"c:\Antigravity\GatheringScans\data\reports", fname)
        self.assertTrue(os.path.isfile(dxf_path), f"DXF file must exist on disk: {dxf_path}")

        # Deep inspection of DXF syntax
        with open(dxf_path, "r", encoding="utf-8", errors="ignore") as f:
            dxf_text = f.read()

        print(f"[DXF Validation] File size: {len(dxf_text)} chars")
        # Check standard sections
        self.assertIn("SECTION\n  2\nHEADER" if "  2\n" in dxf_text else "SECTION\n2\nHEADER", dxf_text)
        self.assertIn("TABLES", dxf_text)
        self.assertIn("ENTITIES", dxf_text)
        self.assertIn("EOF", dxf_text)

        # Check ezdxf parsing
        try:
            doc = ezdxf.readfile(dxf_path)
            print(f"[DXF Validation] ezdxf loaded successfully. DXF version: {doc.dxfversion}")
            msp = doc.modelspace()
            entity_types = {}
            for e in msp:
                entity_types[e.dxftype()] = entity_types.get(e.dxftype(), 0) + 1
            print(f"[DXF Validation] Modelspace entity counts: {entity_types}")
            layers = [lyr.dxf.name for lyr in doc.layers]
            print(f"[DXF Validation] Layers registered: {layers}")
            
            # Check bounding coordinates of entities
            coords_x = []
            coords_y = []
            coords_z = []
            for e in msp:
                if e.dxftype() == "LINE":
                    coords_x.extend([e.dxf.start.x, e.dxf.end.x])
                    coords_y.extend([e.dxf.start.y, e.dxf.end.y])
                    coords_z.extend([e.dxf.start.z, e.dxf.end.z])
                elif e.dxftype() == "POINT":
                    coords_x.append(e.dxf.location.x)
                    coords_y.append(e.dxf.location.y)
                    coords_z.append(e.dxf.location.z)
                elif e.dxftype() in ("POLYLINE", "LWPOLYLINE"):
                    for pt in e.points():
                        coords_x.append(pt[0])
                        coords_y.append(pt[1])
                elif e.dxftype() == "3DFACE":
                    coords_x.extend([e.dxf.vtx0.x, e.dxf.vtx1.x, e.dxf.vtx2.x, e.dxf.vtx3.x])
                    coords_y.extend([e.dxf.vtx0.y, e.dxf.vtx1.y, e.dxf.vtx2.y, e.dxf.vtx3.y])
                    coords_z.extend([e.dxf.vtx0.z, e.dxf.vtx1.z, e.dxf.vtx2.z, e.dxf.vtx3.z])

            self.assertGreater(len(coords_x), 0, "DXF should contain entity coordinates")
            min_x, max_x = min(coords_x), max(coords_x)
            min_y, max_y = min(coords_y), max(coords_y)
            print(f"[DXF Validation] Bounding box: E [{min_x:.2f}, {max_x:.2f}], N [{min_y:.2f}, {max_y:.2f}]")
            # Verify coordinates are in valid TWD97 range (E approx 295000-297000, N approx 2768000-2770000)
            self.assertGreater(min_x, 150000, "Coordinates must be non-zero projected TWD97 Easting")
            self.assertGreater(min_y, 2500000, "Coordinates must be non-zero projected TWD97 Northing")

        except Exception as ex:
            self.fail(f"ezdxf failed to parse generated DXF file: {ex}")

    def test_06_verify_raw_scans_zero_destruction(self):
        """Verify C:\GatheringScans\ raw projects have zero data destruction."""
        scans_root = r"C:\GatheringScans"
        self.assertTrue(os.path.isdir(scans_root), "C:\\GatheringScans must exist")
        
        total_files = 0
        total_bytes = 0
        for root, dirs, files in os.walk(scans_root):
            for f in files:
                total_files += 1
                try:
                    total_bytes += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass
        
        total_gb = total_bytes / (1024 ** 3)
        print(f"[Zero Data Destruction] C:\\GatheringScans: {total_files} files, {total_gb:.2f} GB")
        self.assertGreaterEqual(total_files, 50000, "Raw scan file count must not be diminished")
        self.assertGreaterEqual(total_gb, 50.0, "Raw scan total volume must not be diminished")

    def test_07_verify_database_integrity(self):
        """Verify SQLite database integrity."""
        db_path = r"c:\Antigravity\GatheringScans\data\gathering_scans.db"
        self.assertTrue(os.path.isfile(db_path), "Database must exist")
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        cur.execute("PRAGMA integrity_check;")
        rows = cur.fetchall()
        print(f"[DB Integrity] PRAGMA integrity_check: {rows}")
        self.assertEqual(rows, [("ok",)], "Database integrity must be ok")
        conn.close()

if __name__ == "__main__":
    unittest.main()
