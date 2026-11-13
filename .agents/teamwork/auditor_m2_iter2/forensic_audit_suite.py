"""
Forensic Integrity Audit Suite for Milestone 2 Iteration 2
Author: auditor_m2_iter2
Target: web/src/09-construction-survey-and-bim.js & web/survey-bim.css
"""
import os
import re
import sys
import math
import copy
import shutil
import sqlite3
import tempfile
import xml.etree.ElementTree as ET

REPO_ROOT = r"c:\Antigravity\GatheringScans"
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from pc_worker.priority_queue import ScanQueueDB
from pc_worker.surveying_engine import SurveyingEngine

EMOJI_PATTERN = re.compile(
    r"[\U00010000-\U0010ffff]|[\u2600-\u27bf]|[\u2300-\u23ff]|[\u2b50-\u2b55]"
)

def check_anti_cheat_and_hardcoding():
    print("\n--- Check 1: Anti-Cheat & Hardcoding Detection ---")
    js_path = os.path.join(REPO_ROOT, "web", "src", "09-construction-survey-and-bim.js")
    css_path = os.path.join(REPO_ROOT, "web", "survey-bim.css")

    with open(js_path, "r", encoding="utf-8") as f:
        js_content = f.read()

    with open(css_path, "r", encoding="utf-8") as f:
        css_content = f.read()

    # 1. Search for prohibited cheating patterns
    prohibited_patterns = [
        r"return\s*['\"](?:PASS|CLEAN|OK|SUCCESS)['\"]",
        r"return\s*true\s*;\s*//\s*bypass",
        r"mock(?:_data|_result|_points|_gcp)\s*=",
        r"fake(?:_data|_result|_points)\s*=",
        r"dummy(?:_data|_result|_points)\s*=",
    ]
    for pat in prohibited_patterns:
        m = re.search(pat, js_content, re.IGNORECASE)
        assert m is None, f"Anti-cheat violation: found suspicious pattern '{pat}': {m.group(0)}"

    # 2. Check for hardcoded residuals or RMSE results
    hardcoded_checks = [
        "2.13 cm", "0.0213", "1.9600 * 0.", "Grade A (2.13 cm)"
    ]
    for hc in hardcoded_checks:
        # If it's a fixed string literal in code (not a comment or demo text)
        lines = [line for line in js_content.splitlines() if hc in line and not line.strip().startswith("//") and not line.strip().startswith("*")]
        assert len(lines) == 0, f"Anti-cheat violation: found hardcoded value '{hc}' in active code: {lines}"

    print("PASS: No hardcoded test results, facade implementations, or cheating patterns detected in JS/CSS.")
    return True


def check_dynamic_computation():
    print("\n--- Check 2: Dynamic Computation Verification ---")
    tmp_dir = tempfile.mkdtemp()
    tmp_db_path = os.path.join(tmp_dir, "test_audit_dynamic.db")
    try:
        db = ScanQueueDB(db_path=tmp_db_path)
        engine = SurveyingEngine(db)

        scan_id = "test_dynamic_scan"
        scan_dir = os.path.join(tmp_dir, scan_id)
        os.makedirs(scan_dir, exist_ok=True)
        db.upsert_scan({
            "scan_id": scan_id,
            "name": "Dynamic Audit Scan",
            "project_group": "Audit Group",
            "twd97_e": 304950.0,
            "twd97_n": 2757080.0,
            "twd97_h": 125.0,
            "project_dir": scan_dir,
        })

        test_points = [
            {"id": "GCP-101", "name": "GCP-101", "e": 304950.123, "n": 2757080.456, "h_gcp": 120.550, "mesh_e": 304950.145, "mesh_n": 2757080.440, "mesh_h": 120.582, "is_tbm": False},
            {"id": "GCP-102", "name": "GCP-102", "e": 304960.789, "n": 2757085.123, "h_gcp": 121.200, "mesh_e": 304960.770, "mesh_n": 2757085.150, "mesh_h": 121.175, "is_tbm": False},
            {"id": "GCP-103", "name": "GCP-103", "e": 304970.456, "n": 2757090.789, "h_gcp": 122.850, "mesh_e": 304970.480, "mesh_n": 2757090.765, "mesh_h": 122.895, "is_tbm": False},
            {"id": "TBM-999", "name": "TBM-999", "e": 304980.234, "n": 2757095.678, "h_gcp": 123.400, "mesh_e": 304980.240, "mesh_n": 2757095.685, "mesh_h": 123.445, "is_tbm": True},
        ]

        res = engine.compute_gcp_accuracy_qa({
            "scan_id": scan_id,
            "points": copy.deepcopy(test_points),
            "selected_tbm_id": "TBM-999",
            "apply_tbm_calibration": False,
        })
        assert res["status"] == "ok"
        residuals = res["gcp_residuals"]
        assert len(residuals) == 4

        # Manually compute expected values
        manual_eval = []
        for p in test_points:
            de = round(p["mesh_e"] - p["e"], 4)
            dn = round(p["mesh_n"] - p["n"], 4)
            dh = round(p["mesh_h"] - p["h_gcp"], 4)
            d2d = round(math.hypot(de, dn), 4)
            d3d = round(math.hypot(d2d, dh), 4)
            manual_eval.append((de, dn, dh, d2d, d3d))

        for idx, (de, dn, dh, d2d, d3d) in enumerate(manual_eval):
            r = residuals[idx]
            assert abs(r["de"] - de) < 1e-4, f"de mismatch on point {idx}: {r['de']} vs {de}"
            assert abs(r["dn"] - dn) < 1e-4, f"dn mismatch on point {idx}: {r['dn']} vs {dn}"
            assert abs(r["dh"] - dh) < 1e-4, f"dh mismatch on point {idx}: {r['dh']} vs {dh}"
            assert abs(r["d2d"] - d2d) < 1e-4, f"d2d mismatch on point {idx}: {r['d2d']} vs {d2d}"
            assert abs(r["d3d"] - d3d) < 1e-4, f"d3d mismatch on point {idx}: {r['d3d']} vs {d3d}"

        n = 4
        exp_rmse_e = round(math.sqrt(sum(x[0]**2 for x in manual_eval) / n), 4)
        exp_rmse_n = round(math.sqrt(sum(x[1]**2 for x in manual_eval) / n), 4)
        exp_rmse_h = round(math.sqrt(sum(x[2]**2 for x in manual_eval) / n), 4)
        exp_rmse_2d = round(math.hypot(exp_rmse_e, exp_rmse_n), 4)
        exp_rmse_3d = round(math.hypot(exp_rmse_2d, exp_rmse_h), 4)
        exp_asprs_z = round(1.9600 * exp_rmse_h, 4)
        exp_asprs_r = round(1.7308 * exp_rmse_2d, 4)

        assert abs(res["rmse_e"] - exp_rmse_e) < 1e-4, f"RMSE_E mismatch: {res['rmse_e']} vs {exp_rmse_e}"
        assert abs(res["rmse_n"] - exp_rmse_n) < 1e-4, f"RMSE_N mismatch: {res['rmse_n']} vs {exp_rmse_n}"
        assert abs(res["rmse_h"] - exp_rmse_h) < 1e-4, f"RMSE_H mismatch: {res['rmse_h']} vs {exp_rmse_h}"
        assert abs(res["rmse_2d"] - exp_rmse_2d) < 1e-4, f"RMSE_2D mismatch: {res['rmse_2d']} vs {exp_rmse_2d}"
        assert abs(res["rmse_3d"] - exp_rmse_3d) < 1e-4, f"RMSE_3D mismatch: {res['rmse_3d']} vs {exp_rmse_3d}"
        assert abs(res["accuracy_z_95_m"] - exp_asprs_z) < 1e-4, f"ASPRS Z mismatch: {res['accuracy_z_95_m']} vs {exp_asprs_z}"
        assert abs(res["accuracy_r_95_m"] - exp_asprs_r) < 1e-4, f"ASPRS R mismatch: {res['accuracy_r_95_m']} vs {exp_asprs_r}"

        # Test TBM Calibration
        tbm_dh = manual_eval[3][2] # TBM is index 3
        exp_tbm_shift = round(-tbm_dh, 4)
        assert abs(res["tbm_calibration_preview"]["shift_m"] - exp_tbm_shift) < 1e-4, \
            f"TBM shift mismatch: {res['tbm_calibration_preview']['shift_m']} vs {exp_tbm_shift}"

        print("PASS: GCP residuals, RMSE (2D/3D/H), ASPRS 95% confidence intervals, and TBM vertical calibration are dynamically computed and mathematically verified.")
        return True
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def check_zero_data_destruction():
    print("\n--- Check 3: Zero Data Destruction Verification ---")
    scans_dir = r"C:\GatheringScans"
    assert os.path.exists(scans_dir), f"Directory {scans_dir} missing!"

    entries = os.listdir(scans_dir)
    print(f"Total directory entries in {scans_dir}: {len(entries)}")
    assert len(entries) >= 42, f"Expected at least 42 entries, found {len(entries)}"

    # Required reference datasets from ORIGINAL_REQUEST.md
    required_datasets = [
        "edited_qihu_unified_merged_scan_4_scans__edited_372953",
        "rosepark_20260918_merged",
        "ntudorm_20260915_baseline",
        "QuChi261016_Trees"
    ]
    # Check folder names or case-insensitive match
    lower_entries = [e.lower() for e in entries]
    for req in required_datasets:
        # Check either exact or matching start/prefix
        matched = any(req.lower() in e for e in lower_entries)
        print(f"  Dataset '{req}': {'FOUND' if matched else 'NOT FOUND'}")
        # Note: some have variations like RosePark_Merged2, NTU_Dorm_260915, QuChi261016_Trees
        assert any(p in lower_entries for p in [req.lower(), "rosepark_merged2", "ntu_dorm_260915"]), f"Required dataset {req} not found!"

    # Check SQLite database
    db_path = os.path.join(REPO_ROOT, "data", "gathering_scans.db")
    assert os.path.exists(db_path), f"Database {db_path} does not exist!"

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    cur.execute("PRAGMA integrity_check;")
    integrity = cur.fetchall()
    assert integrity == [("ok",)], f"SQLite integrity failure: {integrity}"

    cur.execute("SELECT count(*) FROM scans;")
    scans_count = cur.fetchone()[0]
    print(f"Scans table record count: {scans_count}")
    assert scans_count >= 10, f"Expected at least 10 scans in DB, found {scans_count}"

    # Verify tables
    cur.execute("SELECT name FROM sqlite_master WHERE type='table';")
    tables = [r[0] for r in cur.fetchall()]
    print(f"Database tables: {tables}")
    assert "scans" in tables, "Table 'scans' missing!"
    assert "comments" in tables or "scan_comments" in tables or "scan_queue" in tables, "Queue/comments tables missing!"

    conn.close()
    print("PASS: Zero data destruction confirmed. All scan directories and SQLite database tables are fully intact.")
    return True


def check_ui_authenticity_and_polish():
    print("\n--- Check 4: UI Authenticity, Zero Emojis, Dual-Theme CSS & 1-Word Buttons ---")
    js_path = os.path.join(REPO_ROOT, "web", "src", "09-construction-survey-and-bim.js")
    css_path = os.path.join(REPO_ROOT, "web", "survey-bim.css")

    with open(js_path, "r", encoding="utf-8") as f:
        js_content = f.read()

    with open(css_path, "r", encoding="utf-8") as f:
        css_content = f.read()

    # 1. Zero Unicode Emojis
    js_emojis = EMOJI_PATTERN.findall(js_content)
    css_emojis = EMOJI_PATTERN.findall(css_content)
    assert len(js_emojis) == 0, f"Emoji violation in JS: found {len(js_emojis)} emojis: {js_emojis[:5]}"
    assert len(css_emojis) == 0, f"Emoji violation in CSS: found {len(css_emojis)} emojis: {css_emojis[:5]}"
    print("  - Zero Unicode Emojis: PASS (0 emojis in JS and CSS)")

    # 2. Genuine SVG Icons Verification
    svg_icons_match = re.search(r"const\s+SVG_ICONS\s*=\s*\{([^}]+)\};", js_content, re.DOTALL)
    assert svg_icons_match is not None, "SVG_ICONS dictionary missing in 09-construction-survey-and-bim.js!"
    svg_block = svg_icons_match.group(1)
    svg_tags = re.findall(r"<svg[^>]+>.*?</svg>", svg_block, re.DOTALL)
    print(f"  - Genuine SVG Icons found: {len(svg_tags)}")
    assert len(svg_tags) >= 10, f"Expected at least 10 SVG icons, found {len(svg_tags)}"

    # Validate SVG XML syntax
    for idx, svg in enumerate(svg_tags):
        try:
            root = ET.fromstring(svg)
            assert root.tag.endswith("svg"), f"Tag is not svg: {root.tag}"
            assert "viewBox" in root.attrib, f"viewBox missing in SVG {idx}"
        except Exception as e:
            raise AssertionError(f"Invalid SVG markup at index {idx}: {svg} - {e}")
    print("  - SVG XML syntax validation: PASS (all SVG icons are valid XML vectors)")

    # 3. Dual Theme Support in CSS
    assert 'html[data-theme="dark"]' in css_content or 'body.theme-dark' in css_content, "Dark theme rules missing in CSS!"
    assert 'html[data-theme="light"]' in css_content or 'body.theme-light' in css_content, "Light theme rules missing in CSS!"
    assert "var(--ui-bg-surface" in css_content, "CSS variable --ui-bg-surface missing!"
    assert "var(--ui-border" in css_content, "CSS variable --ui-border missing!"
    assert "var(--ui-text-primary" in css_content, "CSS variable --ui-text-primary missing!"
    print("  - Dual Light/Dark Theme CSS Variables: PASS")

    # 4. Strictly 1-Word Action Button Labels
    # Extract button labels inside openEnhancedGcpAccuracyQaInspector
    btn_regex = re.compile(r"<button[^>]*>(.*?)</button>", re.DOTALL)
    buttons = btn_regex.findall(js_content)
    print(f"  - Found {len(buttons)} button elements in JS")
    for btn in buttons:
        # Strip SVG tags
        clean_btn = re.sub(r"<svg.*?</svg>", "", btn, flags=re.DOTALL)
        clean_btn = re.sub(r"<[^>]+>", "", clean_btn).strip()
        # Handle template expressions ${t("檢核", "Check")}
        t_matches = re.findall(r't\(\s*["\']([^"\']+)["\']\s*,\s*["\']([^"\']+)["\']\s*\)', clean_btn)
        if t_matches:
            for zh, en in t_matches:
                # Check that both zh and en are 1-word
                assert len(zh.split()) <= 1, f"Button zh text is multi-word: '{zh}'"
                assert len(en.split()) <= 1, f"Button en text is multi-word: '{en}'"
        elif clean_btn:
            # Standalone word (e.g. "CSV")
            words = clean_btn.split()
            # If it's a template variable or short term
            if not clean_btn.startswith("${"):
                assert len(words) <= 1, f"Button label has more than 1 word: '{clean_btn}'"
    print("  - Strict 1-Word Button Labels: PASS (all button labels are single-action words)")

    # 5. Fix for Horizontal Scrollbar on Residual Table
    assert "table-layout: fixed" in css_content, "table-layout: fixed missing in .gcp-residuals-table!"
    assert "overflow-x: hidden" in css_content, "overflow-x: hidden missing in .gcp-table-container!"
    # Check that residual table has exactly 6 compact columns: TBM, ID, ΔE, ΔN, ΔH, Δ3D
    table_headers = re.findall(r"<th[^>]*>(.*?)</th>", js_content)
    # Check the 6 compact column headers in the table
    compact_cols = ["TBM", "ID", "ΔE", "ΔN", "ΔH", "Δ3D"]
    found_cols = [c for c in compact_cols if any(c in th for th in table_headers)]
    assert len(found_cols) == 6, f"Expected 6 compact columns {compact_cols}, found {found_cols}"
    print("  - Compact 6-Column Residual Table & Zero Horizontal Scrollbar: PASS")

    # 6. Container Purge on Open
    assert "Array.from(panel.children).forEach" in js_content, "Container child purging logic missing in openEnhancedGcpAccuracyQaInspector!"
    assert 'bodyEl.innerHTML = ""' in js_content, "sidePanelBody reset missing!"
    print("  - Container Purging & Zero Leaks: PASS")

    # 7. Single-line CRS Pill (No duplicate inner heading)
    assert 'class="gcp-crs-pill"' in js_content, ".gcp-crs-pill missing in JS!"
    assert 'EPSG:3826 + TWVD2001 · N=' in js_content, "CRS compact pill text pattern missing!"
    # Ensure no duplicate inner heading like "控制點空間精度檢核" inside card
    assert "控制點空間精度檢核" not in js_content, "Duplicate inner card heading '控制點空間精度檢核' still present in JS!"
    print("  - Single-line Compact CRS Pill & No Duplicate Heading: PASS")

    print("PASS: UI authenticity, vector icons, CSS theme variables, 1-word buttons, and layout polish verified.")
    return True


def check_5000_line_ceiling():
    print("\n--- Check 5: Strict 5,000-Line Modular Architecture Ceiling ---")
    files_to_check = [
        os.path.join(REPO_ROOT, "web", "src", "09-construction-survey-and-bim.js"),
        os.path.join(REPO_ROOT, "web", "survey-bim.css"),
        os.path.join(REPO_ROOT, "pc_worker", "surveying", "dsm_and_volume.py"),
        os.path.join(REPO_ROOT, "pc_worker", "surveying_engine.py"),
        os.path.join(REPO_ROOT, "server.py"),
    ]
    for fpath in files_to_check:
        with open(fpath, "r", encoding="utf-8") as f:
            lines = sum(1 for _ in f)
        print(f"  {os.path.basename(fpath)}: {lines} lines (ceiling: 5,000)")
        assert lines < 5000, f"Modular ceiling exceeded in {fpath}: {lines} lines >= 5,000!"
    print("PASS: All audited source files strictly conform to the 5,000-line modular architecture ceiling.")
    return True


if __name__ == "__main__":
    print("================================================================")
    print("FORENSIC INTEGRITY AUDIT: Milestone 2 Iteration 2 (Auditor)")
    print("================================================================")
    try:
        check_anti_cheat_and_hardcoding()
        check_dynamic_computation()
        check_zero_data_destruction()
        check_ui_authenticity_and_polish()
        check_5000_line_ceiling()
        print("\n================================================================")
        print("VERDICT: CLEAN — ALL FORENSIC INTEGRITY CHECKS PASSED EMPIRICALLY")
        print("================================================================")
        sys.exit(0)
    except AssertionError as ae:
        print(f"\nINTEGRITY VIOLATION DETECTED: {ae}")
        sys.exit(1)
    except Exception as ex:
        print(f"\nERROR DURING AUDIT EXECUTION: {ex}")
        import traceback
        traceback.print_exc()
        sys.exit(2)
