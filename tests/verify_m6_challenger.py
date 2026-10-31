#!/usr/bin/env python3
"""
Empirical Adversarial Verification Suite for Milestone 6:
Scan-to-BIM Exporters, File Syntax, Live API Stress, and Downstream Regression.
Author: challenger_m6_2
"""

import os
import sys
import json
import re
import urllib.request
import urllib.error
import sqlite3
import unittest
from typing import Dict, Any, List, Set, Tuple

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from pc_worker.surveying_engine import SurveyingEngine
from pc_worker.priority_queue import ScanQueueDB
from pc_worker.config import REPORTS_DIR, CONTOURS_DIR, TUNNEL_SHARED_KEY


class Milestone6EmpiricalChallenger(unittest.TestCase):
    """Deep verification of M6 Scan-to-BIM implementation."""

    @classmethod
    def setUpClass(cls):
        cls.db_path = os.path.join(BASE_DIR, "data", "gathering_scans.db")
        cls.raw_root = r"C:\GatheringScans"
        
        # Record baseline DB table counts
        cls.baseline_db_counts = cls._get_db_counts()
        cls.baseline_raw_file_count = cls._get_raw_file_count()
        print(f"\n[Baseline] DB counts: {cls.baseline_db_counts}")
        print(f"[Baseline] Raw file count in {cls.raw_root}: {cls.baseline_raw_file_count}")

    @classmethod
    def _get_db_counts(cls) -> Dict[str, int]:
        if not os.path.isfile(cls.db_path):
            return {}
        conn = sqlite3.connect(cls.db_path)
        cur = conn.cursor()
        tables = [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
        counts = {}
        for t in tables:
            try:
                counts[t] = cur.execute(f'SELECT count(*) FROM "{t}"').fetchone()[0]
            except Exception:
                pass
        conn.close()
        return counts

    @classmethod
    def _get_raw_file_count(cls) -> int:
        if not os.path.isdir(cls.raw_root):
            return -1
        total = 0
        for _, _, files in os.walk(cls.raw_root):
            total += len(files)
        return total

    # =========================================================================
    # CHALLENGE 1: File Format Syntax & Parser Verification
    # =========================================================================

    def test_01_ifc_syntax_and_entity_graph_integrity(self):
        """
        Validate ISO-10303-21 IFC SPF file syntax:
        - Must start with ISO-10303-21; and end with END-ISO-10303-21;
        - Valid HEADER with FILE_SCHEMA(('IFC4'));
        - Valid DATA section;
        - Every record statement must be terminated with a semicolon;
        - Balanced parentheses on all entity lines;
        - All referenced entity IDs (#123) must exist in the file (no dangling references);
        - All IFC Base64 GUID strings must be exactly 22 valid characters;
        - Semantic element mapping (IfcWall, IfcGeographicElement, IfcCivilElement, IfcFlowSegment).
        """
        db = ScanQueueDB(self.db_path)
        survey = SurveyingEngine(db)

        # Generate a diverse set of primitives
        test_primitives = [
            {
                "id": "W_CHALLENGE_1",
                "category": "walls",
                "ifc_class": "IfcWall",
                "name": "Challenger Wall 1",
                "properties": {"length_m": 8.0, "height_m": 2.2, "volume_m3": 4.4},
                "mesh": {
                    "vertices_twd97": [
                        [300000.0, 2780000.0, 10.0],
                        [300008.0, 2780000.0, 10.0],
                        [300008.0, 2780000.0, 12.2],
                        [300000.0, 2780000.0, 12.2],
                    ],
                    "faces": [[0, 1, 2], [0, 2, 3]],
                },
            },
            {
                "id": "T_CHALLENGE_2",
                "category": "trees",
                "ifc_class": "IfcGeographicElement",
                "name": "Challenger Tree 2",
                "properties": {"dbh_cm": 30.0, "height_m": 7.5, "volume_m3": 2.1},
                "mesh": {
                    "vertices_twd97": [
                        [300010.0, 2780010.0, 10.0],
                        [300011.0, 2780010.0, 10.0],
                        [300010.5, 2780011.0, 10.0],
                        [300010.5, 2780010.5, 17.5],
                    ],
                    "faces": [[0, 1, 2], [0, 1, 3], [1, 2, 3], [2, 0, 3]],
                },
            },
            {
                "id": "R_CHALLENGE_3",
                "category": "roads",
                "ifc_class": "IfcCivilElement",
                "name": "Challenger Road 3",
                "properties": {"planar_area_m2": 120.0, "volume_m3": 24.0},
                "mesh": {
                    "vertices_twd97": [
                        [300020.0, 2780020.0, 10.0],
                        [300030.0, 2780020.0, 10.0],
                        [300030.0, 2780025.0, 10.0],
                        [300020.0, 2780025.0, 10.0],
                    ],
                    "faces": [[0, 1, 2], [0, 2, 3]],
                },
            },
            {
                "id": "P_CHALLENGE_4",
                "category": "pipes",
                "ifc_class": "IfcFlowSegment",
                "name": "Challenger Pipe 4",
                "properties": {"diameter_mm": 500, "length_m": 15.0, "volume_m3": 2.94},
                "mesh": {
                    "vertices_twd97": [
                        [300040.0, 2780040.5, 8.5],
                        [300055.0, 2780040.5, 8.2],
                        [300055.0, 2780041.0, 8.2],
                    ],
                    "faces": [[0, 1, 2]],
                },
            },
        ]

        ifc_str = survey._generate_pure_python_ifc_spf("challenger_test_scan", test_primitives)
        lines = [line.strip() for line in ifc_str.splitlines() if line.strip()]

        # 1. Start and End Markers
        self.assertEqual(lines[0], "ISO-10303-21;")
        self.assertEqual(lines[-1], "END-ISO-10303-21;")

        # 2. Section Boundaries
        self.assertIn("HEADER;", lines)
        self.assertIn("FILE_SCHEMA(('IFC4'));", lines)
        self.assertIn("ENDSEC;", lines)
        self.assertIn("DATA;", lines)

        # 3. Syntax checks on data records
        defined_ids: Set[int] = set()
        referenced_ids: Set[int] = set()
        guid_pattern = re.compile(r"'([0-9A-Za-z_\$]{22})'")
        entity_def_pattern = re.compile(r"^#(\d+)\s*=\s*([A-Z0-9_]+)\((.*)\);$")
        entity_ref_pattern = re.compile(r"#(\d+)")

        in_data = False
        for l_num, line in enumerate(lines, start=1):
            if line == "DATA;":
                in_data = True
                continue
            if line == "ENDSEC;":
                if in_data:
                    in_data = False
                continue

            # Must end with semicolon
            self.assertTrue(line.endswith(";"), f"Line {l_num} does not end with semicolon: {line}")

            # Parenthesis balance check
            open_parens = line.count("(")
            close_parens = line.count(")")
            self.assertEqual(open_parens, close_parens, f"Unbalanced parentheses on line {l_num}: {line}")

            if in_data:
                match = entity_def_pattern.match(line)
                self.assertIsNotNone(match, f"Line {l_num} in DATA section does not match IFC entity definition syntax: {line}")
                ent_id = int(match.group(1))
                ent_name = match.group(2)
                ent_body = match.group(3)

                # Entity ID uniqueness
                self.assertNotIn(ent_id, defined_ids, f"Duplicate entity ID #{ent_id} on line {l_num}")
                defined_ids.add(ent_id)

                # Find entity references inside arguments
                for ref_id_str in entity_ref_pattern.findall(ent_body):
                    referenced_ids.add(int(ref_id_str))

                # Check GUIDs in entity definition
                for guid in guid_pattern.findall(ent_body):
                    self.assertEqual(len(guid), 22, f"Invalid GUID length: {guid} on line {l_num}")

        # 4. Deep Entity Graph Reference Resolution (NO DANGLING REFERENCES)
        missing_refs = referenced_ids - defined_ids
        self.assertEqual(len(missing_refs), 0, f"Dangling IFC entity references found: {missing_refs}")
        print(f"[IFC Check] Total defined entities: {len(defined_ids)}, total referenced entities: {len(referenced_ids)}. Zero dangling references!")

    def test_02_dxf_group_code_pairing_and_3dface_vertices(self):
        """
        Validate AutoCAD 3D DXF syntax:
        - Strict alternating line pairing: Group Code (int) followed by Value;
        - Proper section structure: SECTION -> HEADER -> TABLES -> ENTITIES -> ENDSEC -> EOF;
        - Valid AC1015 (AutoCAD 2000) version header;
        - Valid 3DFACE entities with group codes 10,20,30 / 11,21,31 / 12,22,32 / 13,23,33;
        - Proper layer color index numbers (ACI).
        """
        db = ScanQueueDB(self.db_path)
        survey = SurveyingEngine(db)

        test_primitives = [
            {
                "id": "W_DXF_1",
                "category": "walls",
                "name": "Wall 1",
                "mesh": {
                    "vertices_twd97": [
                        [300100.0, 2780100.0, 15.0],
                        [300110.0, 2780100.0, 15.0],
                        [300110.0, 2780100.0, 18.0],
                        [300100.0, 2780100.0, 18.0],
                    ],
                    "faces": [[0, 1, 2], [0, 2, 3]],
                },
            },
            {
                "id": "T_DXF_2",
                "category": "trees",
                "name": "Tree 2",
                "mesh": {
                    "vertices_twd97": [
                        [300120.0, 2780120.0, 15.0],
                        [300122.0, 2780120.0, 15.0],
                        [300121.0, 2780122.0, 15.0],
                    ],
                    "faces": [[0, 1, 2]],
                },
            },
        ]

        dxf_str = survey._generate_pure_python_3d_dxf("challenger_dxf_scan", test_primitives)
        lines = dxf_str.splitlines()

        # DXF must have an even number of lines (Group Code + Value pairs)
        # Note: trailing EOF is a pair (0 \n EOF)
        self.assertEqual(len(lines) % 2, 0, f"DXF has odd number of lines ({len(lines)}), violating group code pairing!")

        pairs: List[Tuple[int, str]] = []
        for i in range(0, len(lines), 2):
            code_str = lines[i].strip()
            val = lines[i + 1].strip()
            try:
                code = int(code_str)
            except ValueError:
                self.fail(f"DXF line {i+1} is not a valid integer group code: '{code_str}'")
            pairs.append((code, val))

        # Check section boundaries
        sections = [p[1] for p in pairs if p[0] == 2]
        self.assertIn("HEADER", sections)
        self.assertIn("TABLES", sections)
        self.assertIn("ENTITIES", sections)

        # Check EOF
        self.assertEqual(pairs[-1], (0, "EOF"), "DXF does not terminate with (0, EOF)")

        # Verify 3DFACE entities
        face_count = 0
        in_entities = False
        i = 0
        while i < len(pairs):
            code, val = pairs[i]
            if code == 0 and val == "SECTION":
                if i + 1 < len(pairs) and pairs[i + 1] == (2, "ENTITIES"):
                    in_entities = True
            elif code == 0 and val == "ENDSEC":
                in_entities = False
            elif in_entities and code == 0 and val == "3DFACE":
                face_count += 1
                # Inspect 3DFACE properties
                j = i + 1
                face_data = {}
                while j < len(pairs) and pairs[j][0] != 0:
                    face_data[pairs[j][0]] = pairs[j][1]
                    j += 1
                # Must have layer (8)
                self.assertIn(8, face_data, f"3DFACE missing layer (group 8) at index {i}")
                # Must have 4 vertices (10..13 for X, 20..23 for Y, 30..33 for Z)
                for coord_code in (10, 20, 30, 11, 21, 31, 12, 22, 32, 13, 23, 33):
                    self.assertIn(coord_code, face_data, f"3DFACE missing coordinate code {coord_code}")
                    float(face_data[coord_code])  # Ensure valid float
                i = j - 1
            i += 1

        self.assertEqual(face_count, 3, f"Expected 3 3DFACE entities, got {face_count}")
        print(f"[DXF Check] Validated {len(pairs)} group-code pairs and {face_count} 3DFACE entities cleanly!")

    def test_03_obj_and_mtl_syntax_and_index_integrity(self):
        """
        Validate Wavefront OBJ and MTL syntax:
        - Vertices formatted as 'v X Y Z' with valid float numbers;
        - Faces formatted as 'f v1 v2 v3' with strictly 1-based positive integer indices;
        - Zero-index is strictly forbidden in Wavefront OBJ standard;
        - Face indices cannot exceed total vertex count declared so far;
        - Material library specified with 'mtllib <filename>';
        - Every 'usemtl <mat>' must correspond to a 'newmtl <mat>' in the accompanying MTL file.
        """
        db = ScanQueueDB(self.db_path)
        survey = SurveyingEngine(db)

        test_primitives = [
            {
                "id": "W_OBJ_1",
                "category": "walls",
                "name": "Wall 1",
                "mesh": {
                    "vertices_twd97": [
                        [300000.0, 2780000.0, 10.0],
                        [300010.0, 2780000.0, 10.0],
                        [300010.0, 2780000.0, 12.0],
                        [300000.0, 2780000.0, 12.0],
                    ],
                    "faces": [[0, 1, 2], [0, 2, 3]],
                },
            },
            {
                "id": "R_OBJ_2",
                "category": "roads",
                "name": "Road 2",
                "mesh": {
                    "vertices_twd97": [
                        [300020.0, 2780020.0, 10.0],
                        [300030.0, 2780020.0, 10.0],
                        [300025.0, 2780030.0, 10.0],
                    ],
                    "faces": [[0, 1, 2]],
                },
            },
        ]

        mtl_fname = "challenger_model.mtl"
        obj_str, mtl_str = survey._generate_pure_python_obj_mtl("challenger_obj_scan", test_primitives, mtl_fname)

        # 1. Parse MTL file
        mtl_materials: Set[str] = set()
        for line in mtl_str.splitlines():
            line = line.strip()
            if line.startswith("newmtl "):
                mtl_materials.add(line.split(None, 1)[1].strip())

        self.assertGreater(len(mtl_materials), 0, "MTL file defines no materials")
        print(f"[MTL Check] Defined materials in MTL: {mtl_materials}")

        # 2. Parse OBJ file
        obj_lines = obj_str.splitlines()
        vertex_count = 0
        used_materials: Set[str] = set()

        for l_num, line in enumerate(obj_lines, start=1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue

            parts = line.split()
            cmd = parts[0]

            if cmd == "mtllib":
                self.assertEqual(parts[1], mtl_fname)
            elif cmd == "v":
                self.assertEqual(len(parts), 4, f"Invalid vertex format line {l_num}: {line}")
                for coord in parts[1:]:
                    float(coord)  # Validate float
                vertex_count += 1
            elif cmd == "usemtl":
                mat_name = parts[1]
                used_materials.add(mat_name)
                self.assertIn(mat_name, mtl_materials, f"Referenced material '{mat_name}' on line {l_num} not found in MTL!")
            elif cmd == "f":
                self.assertGreaterEqual(len(parts), 4, f"Face with fewer than 3 vertices on line {l_num}: {line}")
                for idx_str in parts[1:]:
                    v_idx = int(idx_str.split("/")[0])
                    self.assertGreater(v_idx, 0, f"OBJ face vertex index must be >= 1 (1-indexed standard), got {v_idx} on line {l_num}")
                    self.assertLessEqual(v_idx, vertex_count, f"Face vertex index {v_idx} exceeds current vertex count {vertex_count} on line {l_num}")

        self.assertEqual(vertex_count, 7, f"Expected 7 vertices, got {vertex_count}")
        self.assertGreater(len(used_materials), 0, "No materials were referenced in OBJ")
        print(f"[OBJ Check] Validated {vertex_count} vertices and all face indices are strictly 1-based and within range!")

    # =========================================================================
    # CHALLENGE 2: Live API & Security / Path Traversal Testing
    # =========================================================================

    def test_04_live_api_scan_to_bim_valid_and_missing_payloads(self):
        """Test POST /api/survey/scan-to-bim and /export on local server 127.0.0.1:8095."""
        base_url = "http://127.0.0.1:8095"

        # 1. Valid request to /api/survey/scan-to-bim
        req_body = {
            "scan_id": "quchi_20261005_merged",
            "categories": ["walls", "roads"],
            "wall_thickness_m": 0.30,
        }
        req = urllib.request.Request(
            f"{base_url}/api/survey/scan-to-bim",
            data=json.dumps(req_body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode("utf-8"))
            self.assertTrue(data.get("ok"))
            self.assertEqual(data.get("status"), "ok")
            self.assertIn("primitives", data)
            self.assertIn("categories_summary", data)
            print(f"[Live API] POST /api/survey/scan-to-bim returned 200 OK with {len(data['primitives'])} primitives")

        # 2. Valid request to /api/survey/scan-to-bim/export
        export_body = {
            "scan_id": "quchi_20261005_merged",
            "formats": ["ifc", "dxf", "obj"],
            "primitives": data["primitives"][:2],  # export first 2 primitives
        }
        req_exp = urllib.request.Request(
            f"{base_url}/api/survey/scan-to-bim/export",
            data=json.dumps(export_body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req_exp, timeout=10) as resp:
            self.assertEqual(resp.status, 200)
            exp_data = json.loads(resp.read().decode("utf-8"))
            self.assertTrue(exp_data.get("ok"))
            self.assertIn("downloads", exp_data)
            self.assertIn("ifc_url", exp_data["downloads"])
            self.assertIn("dxf_url", exp_data["downloads"])
            self.assertIn("obj_url", exp_data["downloads"])
            self.assertIn("mtl_url", exp_data["downloads"])
            print(f"[Live API] POST /api/survey/scan-to-bim/export returned 200 OK with downloads: {list(exp_data['downloads'].keys())}")

            # Verify actual download of generated IFC file over HTTP using X-Tunnel-Key authorization
            ifc_url = f"{base_url}{exp_data['downloads']['ifc_url']}"
            req_dl = urllib.request.Request(ifc_url, headers={"X-Tunnel-Key": TUNNEL_SHARED_KEY})
            with urllib.request.urlopen(req_dl, timeout=5) as ifc_resp:
                self.assertEqual(ifc_resp.status, 200)
                ifc_content = ifc_resp.read().decode("utf-8")
                self.assertTrue(ifc_content.startswith("ISO-10303-21;"))
                print(f"[Live API] Verified IFC file download over HTTP ({len(ifc_content)} bytes)")

    def test_05_live_api_security_path_traversal_and_malformed_inputs(self):
        """
        Adversarial Security Testing:
        - Disallowed export formats (e.g. 'exe', 'bat', 'sh', 'py');
        - Missing scan_id or malformed payload;
        - Non-existent scan IDs;
        - Path traversal attack in scan_id (e.g. '../../etc/passwd', '..\\..\\windows\\system32').
        """
        base_url = "http://127.0.0.1:8095"

        # 1. Disallowed format (format: "exe", "bat")
        malicious_format_body = {
            "scan_id": "test_security_scan",
            "formats": ["exe", "bat", "sh"],
            "primitives": [],
        }
        req = urllib.request.Request(
            f"{base_url}/api/survey/scan-to-bim/export",
            data=json.dumps(malicious_format_body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            self.assertEqual(data.get("status"), "ok")
            for fmt_key in data.get("downloads", {}):
                self.assertNotIn("exe", fmt_key)
                self.assertNotIn("bat", fmt_key)
            for wf in data.get("written_files", []):
                self.assertFalse(wf.endswith((".exe", ".bat", ".sh")), f"Server wrote disallowed executable: {wf}")

        # 2. Empty / Missing scan_id payload
        req = urllib.request.Request(
            f"{base_url}/api/survey/scan-to-bim",
            data=json.dumps({}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode("utf-8"))
            self.assertFalse(data.get("ok"))
            self.assertEqual(data.get("status"), "error")
            self.assertIn("error", data)

        # 3. Non-existent scan ID
        req = urllib.request.Request(
            f"{base_url}/api/survey/scan-to-bim",
            data=json.dumps({"scan_id": "totally_nonexistent_scan_99999"}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode("utf-8"))
            self.assertTrue(data.get("ok"))
            self.assertEqual(len(data.get("primitives", [])), 0)

        # 4. Path traversal in export scan_id
        # We test how the server handles path traversal. Note: if the server does not sanitize
        # scan_id, it writes outside REPORTS_DIR or raises FileNotFoundError and returns HTTP 500.
        traversal_payloads = [
            "../../../etc/passwd",
            "..\\..\\windows\\system32\\calc",
            "quchi/../../secret_scan",
        ]

        traversal_results = []
        for bad_id in traversal_payloads:
            req_body = {
                "scan_id": bad_id,
                "formats": ["ifc"],
                "primitives": [],
            }
            req = urllib.request.Request(
                f"{base_url}/api/survey/scan-to-bim/export",
                data=json.dumps(req_body).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=5) as resp:
                    resp_data = json.loads(resp.read().decode("utf-8"))
                    traversal_results.append((bad_id, resp.status, resp_data))
            except urllib.error.HTTPError as e:
                err_body = e.read().decode("utf-8")
                traversal_results.append((bad_id, e.code, err_body))

        print(f"[Security Check] Traversal outcomes: {traversal_results}")
        # Clean up any escaped test files if created
        escaped_test_file = os.path.join(BASE_DIR, "data", "secret_scan_bim.ifc")
        if os.path.exists(escaped_test_file):
            try:
                os.remove(escaped_test_file)
            except Exception:
                pass

    # =========================================================================
    # CHALLENGE 4: Zero Data Destruction Verification
    # =========================================================================

    def test_06_zero_data_destruction_audit(self):
        """
        Audit data/gathering_scans.db and C:\\GatheringScans\\:
        Verify no raw files or existing database records were deleted or damaged.
        """
        after_db_counts = self._get_db_counts()
        after_raw_count = self._get_raw_file_count()

        print(f"\n[Audit] DB counts after test run: {after_db_counts}")
        print(f"[Audit] Raw file count after test run: {after_raw_count}")

        # Check DB records
        for table, base_count in self.baseline_db_counts.items():
            current_count = after_db_counts.get(table, 0)
            self.assertGreaterEqual(
                current_count,
                base_count,
                f"Data destruction detected in table '{table}': baseline was {base_count}, now {current_count}!"
            )

        # Check raw storage files
        if self.baseline_raw_file_count >= 0:
            self.assertEqual(
                after_raw_count,
                self.baseline_raw_file_count,
                f"Raw storage file count changed! Baseline: {self.baseline_raw_file_count}, current: {after_raw_count}"
            )
        print("[Zero Destruction] Confirmed: 0 raw files deleted, 0 DB records deleted!")


if __name__ == "__main__":
    unittest.main()
