#!/usr/bin/env python3
"""
GatheringScans Milestone 7 Adversarial Verification Suite
(tests/test_adversarial_m7_challenger.py)
=========================================================
Challenger: challenger_m7_1 (Empirical Challenger)
Target: Milestone 7 — Real Public Utilities GIS Integration with Taiwan Open APIs

Tests & Stress Harnesses:
1. Live endpoint querying at Rose Park (genuine Taiwan WRD/Sewer data, real geometries, attributes).
2. Anti-mock tests: Ocean, off-island, NaN, and negative coordinates returning 0 features honestly.
3. Malformed fuzzing stress tests: GML, KML, GeoJSON, CSV corruptions (no HTTP 500, graceful error payloads).
4. Direct SurveyingEngine vs HTTP REST API parity.
5. 3D DXF and GeoJSON export resilience against broken feature records.
6. Frontend code inspection (strict 1-word buttons, zero emojis, line ceilings, dual-theme CSS).
"""

import unittest
import os
import sys
import json
import math
import re
import urllib.request
import urllib.error

# Ensure root repository is on PYTHONPATH
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from pc_worker.surveying_engine import SurveyingEngine
from pc_worker.surveying.public_utilities_gis import UTILITY_LAYERS, PublicUtilitiesGISMixin
from pc_worker.priority_queue import ScanQueueDB
from pc_worker.config import DATA_DIR, REPORTS_DIR

LIVE_API_BASE = "http://127.0.0.1:8095"


def http_post_json(path: str, payload: dict, timeout: float = 10.0) -> tuple[int, dict]:
    """Helper to issue HTTP POST requests against the running GatheringScans server."""
    url = f"{LIVE_API_BASE}{path}"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", "Accept": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            return resp.status, json.loads(body)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, {"error": body}
    except Exception as e:
        return 0, {"error": str(e)}


class TestM7AdversarialRoseParkLiveQuery(unittest.TestCase):
    """Adversarial Challenge 1: Real Taiwan API Querying & Anti-Mock Testing."""

    def test_01_rosepark_live_endpoint_returns_genuine_features(self):
        """Query live endpoint /api/survey/utilities-query with Rose Park scan."""
        status, data = http_post_json("/api/survey/utilities-query", {
            "scan_id": "rosepark_20260918_merged",
            "radius_m": 120,
            "force_refresh": False,
        })
        self.assertEqual(status, 200, f"Expected 200 OK from utilities-query, got {status}: {data}")
        self.assertEqual(data.get("status"), "ok")
        self.assertGreater(data.get("total_features", 0), 20, "Rose Park must return real municipal utility features (>20)")
        self.assertGreater(data.get("total_pipe_length_m", 0.0), 500.0, "Total pipe length must be > 500m")

        features = data.get("features", [])
        self.assertEqual(len(features), data.get("total_features"))

        # Inspect feature integrity
        pipe_count = 0
        mh_count = 0
        culvert_count = 0

        for f in features:
            self.assertIn("id", f)
            self.assertIn("layer", f)
            self.assertIn(f["layer"], UTILITY_LAYERS)
            self.assertIn("type", f)

            if f["type"] in ("pipe", "box_culvert"):
                if f["type"] == "box_culvert":
                    culvert_count += 1
                else:
                    pipe_count += 1
                coords = f.get("coords")
                self.assertIsInstance(coords, list)
                self.assertGreaterEqual(len(coords), 2, "Pipe must have at least 2 vertices")
                for pt in coords:
                    self.assertEqual(len(pt), 3, "Pipe vertex must be 3D [E, N, Z]")
                    e, n, z = pt[0], pt[1], pt[2]
                    self.assertTrue(295500 < e < 296500, f"Easting {e} must be in Rose Park TWD97 range")
                    self.assertTrue(2768000 < n < 2769000, f"Northing {n} must be in Rose Park TWD97 range")
                self.assertGreater(f.get("length_m", 0), 0)
                self.assertGreater(f.get("diameter_mm", 0), 0)
                # Realistic hydraulic slopes (between -25% and +25%)
                if "slope_pct" in f and f["slope_pct"] is not None:
                    self.assertTrue(-25.0 <= f["slope_pct"] <= 25.0, f"Pipe slope {f['slope_pct']}% outside civil range")
            elif f["type"] in ("manhole", "catch_basin", "hydrant", "pole"):
                mh_count += 1
                coord = f.get("coord")
                self.assertIsInstance(coord, list)
                self.assertEqual(len(coord), 3, "Manhole coord must be 3D [E, N, Z]")
                self.assertTrue(295500 < coord[0] < 296500)
                self.assertTrue(2768000 < coord[1] < 2769000)
                self.assertGreater(f.get("depth_m", 0), 0.5, "Manhole depth must be realistic (>0.5m)")

        self.assertGreater(pipe_count + culvert_count, 0, "Must have genuine pipes/culverts")
        self.assertIn("New Taipei City", features[0].get("source", ""))

    def test_02_rosepark_layer_filtering_consistency(self):
        """Querying subset of layers must strictly return only those requested layers."""
        status, data = http_post_json("/api/survey/utilities-query", {
            "scan_id": "rosepark_20260918_merged",
            "radius_m": 120,
            "layers": ["storm"],
            "force_refresh": False,
        })
        self.assertEqual(status, 200)
        features = data.get("features", [])
        for f in features:
            self.assertEqual(f.get("layer"), "storm", f"Layer filtering failed: found {f.get('layer')}")
        self.assertEqual(data.get("layer_counts", {}).get("sanitary", 0), 0)


class TestM7AdversarialOceanAndOffIsland(unittest.TestCase):
    """Adversarial Challenge 2: Ocean / Off-Island Anti-Mocking Integrity."""

    def test_01_ocean_coordinates_zero_zero_honest_zero(self):
        """Querying E: 0, N: 0 (Gulf of Guinea / Atlantic Ocean) must return 0 features honestly."""
        status, data = http_post_json("/api/survey/utilities-query", {
            "center_e": 0.0,
            "center_n": 0.0,
            "center_h": 0.0,
            "radius_m": 120.0,
            "force_refresh": True,
        })
        self.assertEqual(status, 200)
        self.assertEqual(data.get("status"), "ok")
        self.assertEqual(data.get("total_features"), 0)
        self.assertEqual(len(data.get("features", [])), 0)
        self.assertEqual(data.get("total_pipe_length_m"), 0.0)

    def test_02_offshore_taiwan_strait_honest_zero(self):
        """Querying offshore in the middle of the Taiwan Strait (E: 120000, N: 2500000)."""
        status, data = http_post_json("/api/survey/utilities-query", {
            "center_e": 120000.0,
            "center_n": 2500000.0,
            "radius_m": 200.0,
            "force_refresh": True,
        })
        self.assertEqual(status, 200)
        self.assertEqual(data.get("total_features"), 0)
        self.assertEqual(len(data.get("features", [])), 0)

    def test_03_deep_pacific_ocean_honest_zero(self):
        """Querying East of Taiwan in deep Pacific trench (E: 450000, N: 2650000)."""
        status, data = http_post_json("/api/survey/utilities-query", {
            "center_e": 450000.0,
            "center_n": 2650000.0,
            "radius_m": 500.0,
            "force_refresh": True,
        })
        self.assertEqual(status, 200)
        self.assertEqual(data.get("total_features"), 0)

    def test_04_negative_and_extreme_coordinates_resilience(self):
        """Querying extreme negative coordinates (-999999, -999999)."""
        status, data = http_post_json("/api/survey/utilities-query", {
            "center_e": -999999.0,
            "center_n": -999999.0,
            "radius_m": 1000.0,
            "force_refresh": True,
        })
        self.assertEqual(status, 200)
        self.assertEqual(data.get("total_features"), 0)


class TestM7AdversarialMalformedFileFuzzing(unittest.TestCase):
    """Adversarial Challenge 3: Stress-Testing Parser with Corrupted / Malformed Files."""

    def test_01_empty_payload_and_empty_file(self):
        """Empty string or empty payload must return structured error, never 500."""
        for empty_val in ["", "   ", "\n\t\r"]:
            status, data = http_post_json("/api/survey/utilities-parse", {
                "file_content": empty_val,
                "filename": "test.gml",
            })
            self.assertEqual(status, 200)
            self.assertEqual(data.get("status"), "error")
            self.assertIn("error", data)

    def test_02_malformed_gml_missing_tags_and_unclosed(self):
        """Unclosed XML tags and broken GML fragments."""
        broken_gml_samples = [
            "<ngis:Pipe><gml:posList>295900 2768500",  # Unclosed tag, truncated posList
            "<?xml version='1.0'?><ngis:FeatureCollection><ngis:Pipe gml:id='P1'><ngis:DIAMETER>bad_number</ngis:DIAMETER></ngis:Pipe>",
            "<gml:Point><gml:pos>only_one_token</gml:pos></gml:Point>",  # Incomplete coords
            "<random_junk>This is totally not GML nor XML",
            "<?xml version='1.0'?><!DOCTYPE foo [<!ENTITY xxe SYSTEM 'file:///etc/passwd'>]><foo>&xxe;</foo>",  # XXE entity
        ]
        for idx, sample in enumerate(broken_gml_samples):
            status, data = http_post_json("/api/survey/utilities-parse", {
                "file_content": sample,
                "filename": f"corrupt_{idx}.gml",
            })
            self.assertEqual(status, 200, f"GML sample {idx} crashed with HTTP {status}")
            self.assertIn(data.get("status"), ("ok", "error"))
            self.assertIsInstance(data.get("features", []), list)

    def test_03_malformed_kml_corrupted_coordinates(self):
        """Malformed KML with bad coords and broken tags."""
        broken_kml_samples = [
            "<kml><Placemark><name>Broken</name><LineString><coordinates>NaN,NaN,NaN 121.5,bad</coordinates></LineString></Placemark></kml>",
            "<kml><Placemark><Point><coordinates></coordinates></Point></Placemark></kml>",
            "<kml><Placemark><name>Unclosed",
            "<kml><Placemark><LineString><coordinates>121.5</coordinates></LineString></Placemark></kml>",
        ]
        for idx, sample in enumerate(broken_kml_samples):
            status, data = http_post_json("/api/survey/utilities-parse", {
                "file_content": sample,
                "filename": f"corrupt_{idx}.kml",
            })
            self.assertEqual(status, 200, f"KML sample {idx} crashed with HTTP {status}")
            self.assertIn(data.get("status"), ("ok", "error"))
            self.assertIsInstance(data.get("features", []), list)

    def test_04_malformed_geojson_broken_syntax_and_geometries(self):
        """Malformed GeoJSON objects, truncated coordinates, invalid geometry types."""
        broken_geojson_samples = [
            "{'invalid_json': true,",  # Invalid JSON syntax
            json.dumps({"type": "FeatureCollection", "features": None}),
            json.dumps({"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": None}]}),
            json.dumps({"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[121.5]]}}]}),
            json.dumps({"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "PolygonUnknown", "coordinates": []}}]}),
            json.dumps({"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "Point", "coordinates": ["bad", "coords"]}}]}),
        ]
        for idx, sample in enumerate(broken_geojson_samples):
            status, data = http_post_json("/api/survey/utilities-parse", {
                "file_content": sample,
                "filename": f"corrupt_{idx}.geojson",
            })
            self.assertEqual(status, 200, f"GeoJSON sample {idx} crashed with HTTP {status}")
            self.assertIn(data.get("status"), ("ok", "error"))
            self.assertIsInstance(data.get("features", []), list)

    def test_05_malformed_csv_truncated_columns(self):
        """Malformed CSV with missing columns, invalid floats, random gibberish."""
        broken_csv_samples = [
            "id,e,n,z,code\n1,bad,not_a_num,0,storm\n",
            "just one header with no data\n",
            "PT1,295900.0\nPT2\n",  # Truncated columns
            ",,,,,,,,,\n,,,,,,,,,\n",  # Empty commas
        ]
        for idx, sample in enumerate(broken_csv_samples):
            status, data = http_post_json("/api/survey/utilities-parse", {
                "file_content": sample,
                "filename": f"corrupt_{idx}.csv",
            })
            self.assertEqual(status, 200, f"CSV sample {idx} crashed with HTTP {status}")
            self.assertIn(data.get("status"), ("ok", "error"))
            self.assertIsInstance(data.get("features", []), list)

    def test_06_non_string_payload_validation_returns_400(self):
        """Non-string payload for file_content (int, list, dict, bool) must return HTTP 400 Bad Request."""
        non_string_samples = [
            12345,
            ["not", "a", "string"],
            {"nested": "dict"},
            True,
        ]
        for val in non_string_samples:
            status, data = http_post_json("/api/survey/utilities-parse", {
                "file_content": val,
                "filename": "test.gml",
            })
            self.assertEqual(status, 400, f"Expected 400 Bad Request for {type(val)}, got {status}: {data}")
            self.assertEqual(data.get("status"), "error")
            self.assertIn("error", data)


class TestM7AdversarialExportAndFrontendIntegrity(unittest.TestCase):
    """Adversarial Challenge 4: Export Resilience & Frontend Code Conformance."""

    def test_01_export_with_empty_and_broken_features(self):
        """Exporting empty list or malformed features must succeed gracefully without 500."""
        # Empty features
        status, data = http_post_json("/api/survey/utilities-export", {
            "scan_id": "test_scan",
            "format": "dxf",
            "features": [],
        })
        self.assertEqual(status, 200)
        self.assertEqual(data.get("status"), "ok")
        self.assertEqual(data.get("feature_count"), 0)

        # Corrupted feature entries (missing coords, missing fields)
        corrupted_features = [
            {"id": "broken_1"},
            {"id": "broken_2", "type": "pipe", "coords": None},
            {"id": "broken_3", "type": "point", "coord": [295900.0, 2768500.0, 10.0], "layer": "unknown_layer"},
        ]
        status_dxf, data_dxf = http_post_json("/api/survey/utilities-export", {
            "scan_id": "test_scan",
            "format": "dxf",
            "features": corrupted_features,
        })
        self.assertEqual(status_dxf, 200)
        self.assertEqual(data_dxf.get("status"), "ok")

        # Verify exported DXF file is intact
        dxf_path = os.path.join(REPORTS_DIR, data_dxf.get("filename", ""))
        self.assertTrue(os.path.isfile(dxf_path))
        with open(dxf_path, "r", encoding="utf-8") as f:
            dxf_content = f.read()
        self.assertIn("SECTION", dxf_content)
        self.assertIn("ENDSEC", dxf_content)
        self.assertIn("EOF", dxf_content)

    def test_02_frontend_strict_no_emojis_and_one_word_buttons(self):
        """Exhaustive check on web/src/12-public-utilities-gis.js for emojis and multi-word buttons."""
        js_path = os.path.join(REPO_ROOT, "web", "src", "12-public-utilities-gis.js")
        self.assertTrue(os.path.isfile(js_path))

        with open(js_path, "r", encoding="utf-8") as f:
            code = f.read()

        # Emoji check
        emoji_regex = re.compile(r"[\U0001F300-\U0001F6FF\U0001F900-\U0001F9FF\u2600-\u26FF\u2700-\u27BF]")
        matches = emoji_regex.findall(code)
        self.assertEqual(len(matches), 0, f"Found emojis in 12-public-utilities-gis.js: {matches}")

        # Check button labels inside template literals: <button ...>...TEXT...</button>
        button_pattern = re.compile(r"<button[^>]*>(.*?)</button>", re.DOTALL)
        buttons = button_pattern.findall(code)
        for btn in buttons:
            # Strip SVGs and inner tags
            text = re.sub(r"<[^>]+>", "", btn).strip()
            # Strip SVG template variables ${...SVG...}
            text = re.sub(r"\$\{[^}]*SVG[^}]*\}", "", text).strip()
            # Extract literal or bilingual t("...", "...") strings
            t_matches = re.findall(r't\(\s*["\']([^"\']+)["\']\s*,\s*["\']([^"\']+)["\']\s*\)', text)
            if t_matches:
                for zh_word, en_word in t_matches:
                    self.assertLessEqual(len(zh_word.split()), 1, f"Button ZH '{zh_word}' exceeds 1 word")
                    self.assertLessEqual(len(en_word.split()), 1, f"Button EN '{en_word}' exceeds 1 word")
            else:
                text_clean = re.sub(r"\$\{[^}]*\}", "", text).strip()
                if text_clean:
                    words = text_clean.split()
                    self.assertLessEqual(
                        len(words), 1,
                        f"Button '{text_clean}' violates strict 1-word limit in 12-public-utilities-gis.js"
                    )

    def test_03_css_dual_theme_variables_presence(self):
        """Verify web/survey-bim.css uses CSS variables for bright/dark themes and proper utility classes."""
        css_path = os.path.join(REPO_ROOT, "web", "survey-bim.css")
        self.assertTrue(os.path.isfile(css_path))

        with open(css_path, "r", encoding="utf-8") as f:
            css = f.read()

        # Check for utilities inspector CSS classes
        self.assertIn(".gs-util-layer-row", css)
        self.assertIn(".gs-util-metric-cell", css)
        self.assertIn(".gs-util-section-card", css)
        self.assertIn("var(--ui-bg-surface", css)
        self.assertIn("var(--ui-text", css)

    def test_04_2d_coordinates_dxf_export_resilience(self):
        """Exporting 2D [x, y] coordinates must default z=0.0 and never crash with IndexError."""
        features_2d = [
            {
                "id": "pipe_2d",
                "layer": "storm",
                "type": "pipe",
                "coords": [[295900.0, 2768500.0], [295950.0, 2768520.0]],
            },
            {
                "id": "point_2d",
                "layer": "sanitary",
                "type": "manhole",
                "coord": [295920.0, 2768510.0],
            },
        ]
        status, data = http_post_json("/api/survey/utilities-export", {
            "scan_id": "test_2d",
            "format": "dxf",
            "features": features_2d,
        })
        self.assertEqual(status, 200, f"Expected 200 OK for 2D DXF export, got {status}: {data}")
        self.assertEqual(data.get("status"), "ok")
        dxf_path = os.path.join(REPORTS_DIR, data.get("filename", ""))
        self.assertTrue(os.path.isfile(dxf_path))
        with open(dxf_path, "r", encoding="utf-8") as f:
            content = f.read()
        self.assertIn("LINE", content)
        self.assertIn("POINT", content)
        self.assertIn("0.000", content)

    def test_05_direct_engine_aliases_parity(self):
        """Verify parse_uploaded_utility_file and export_utilities_dxf aliases exist on SurveyingEngine."""
        survey = SurveyingEngine(db=ScanQueueDB())
        self.assertTrue(hasattr(survey, "parse_uploaded_utility_file"))
        self.assertTrue(hasattr(survey, "export_utilities_dxf"))
        # Non-string validation directly on engine
        res_bad = survey.parse_uploaded_utility_file({"file_content": 9999})
        self.assertEqual(res_bad.get("status"), "error")
        self.assertEqual(res_bad.get("http_status"), 400)


if __name__ == "__main__":
    unittest.main()
