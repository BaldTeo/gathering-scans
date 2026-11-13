# Adversarial Challenge Handoff Report — Milestone 4 & Milestone 5 (Construction QA & RTK Stakeout)

**Agent**: `challenger_m4_m5_2`  
**Recipient**: Orchestrator (`35a7b3c4-959a-4d2b-a4b5-21fb2891dea3`)  
**Timestamp**: 2026-10-31T07:56:00Z  
**Verdict**: **REQUEST_CHANGES**  

---

## 1. Observation

### 1.1 Automated Test Suite Execution
- Ran command: `python -m unittest tests.test_gathering_scans_suite.GatheringScansTestSuite.test_39_milestone4_milestone5_construction_qa_and_stakeout tests/test_civil_surveying_e2e.py`
  - Output: `Ran 58 tests in 4.228s - OK`
- Ran full regression suite: `python -m unittest tests/test_gathering_scans_suite.py`
  - Output: `Ran 39 tests in 11.616s - OK`

### 1.2 Zero Data Destruction & Raw Storage Audit
- Scanned raw scan storage root `C:\GatheringScans`:
  - Verified 43 directories present, including critical scans: `catch_QihuPark_20261028`, `RosePark_Merged2`, `NTU_Dorm_260915`, `QuChi261016_Trees`, `edited_qihu_unified_merged_scan_4_scans__edited_372953`.
  - Total file count: **523,114 files** (exceeds minimum threshold of 50,474 files).
  - Total byte size: **614,272,006,059 bytes (572.09 GB)** (exceeds minimum threshold of 56.98 GB).
- Verified SQLite database `data/gathering_scans.db`:
  - `PRAGMA integrity_check;` returned `[('ok',)]`.
  - `SELECT COUNT(*) FROM scans;` returned `41` scan records intact.

### 1.3 Architectural & UI Standards Audit
- Line counts:
  - `pc_worker/surveying/construction_qa.py`: 1,206 lines (< 5,000 ceiling).
  - `web/src/10-construction-qa-and-stakeout.js`: 1,053 lines (< 5,000 ceiling).
  - `web/survey-bim.css`: 490 lines (< 5,000 ceiling).
- Unicode Emoji check on `web/src/10-construction-qa-and-stakeout.js`:
  - Regex pattern `r"[\U00010000-\U0010ffff]|[\u2600-\u27bf]|[\u2300-\u23ff]|[\u2b50-\u2b55]|[\u203c-\u2049]"` returned 0 matches.
- Strict 1-word action button labels:
  - All buttons verified strictly 1 word (`檢核`, `選點`, `重置`, `CSV`, `追蹤`, `加點`, `清除`, `DXF`, `計算`, `圈選`, `導出`, `放樣`, `TXT`, `列印`).

### 1.4 Live HTTP Server Empirical Verification (`http://127.0.0.1:8095`)
Created and executed `tests/test_m4_m5_adversarial_challenger.py` (14 tests).
- Functional endpoints pass:
  - `POST /api/survey/surface-qa`: Verified SVD plane fitting (best-fit), horizontal normal `(0, 0, 1)`, vertical plumb normal with $C=0$, ASTM E1155 ($F_F$, $F_L$) ratings, and plumb tilt ratio.
  - `POST /api/survey/utility-trace`: Verified 2D/3D length, invert/crown math ($Z_{invert} = Z_{center} - D/2$, $Z_{crown} = Z_{center} + D/2$), gradient calculations (% and 1:N), depth of cover from DSM surface, and 3D DXF / CSV exports.
  - `POST /api/survey/compare-volume`: Verified multi-epoch cut/fill delta integration, bank/loose/compacted volume mass conservation ($V_{LCM} = V_{BCM} \times 1.25$, $Mass = V_{BCM} \times 1.80$), and haulage truck trips estimator.
  - `POST /api/survey/stakeout-export`: Verified coordinates are strictly formatted in Easting, Northing, Elevation (`PtID, Easting, Northing, Elevation, Code`) across CSV, TXT, DXF entities, and printable A4 field sheet.
- Empty payload `{}`: Returns clean HTTP 200 with fallback data.
- Malformed JSON `{ bad json syntax }`: Returns clean HTTP 400 Bad Request with `{"error": "Invalid JSON: ..."}`.
- Numerical extremes & degenerate geometries: Handled gracefully without crash.

### 1.5 CONFIRMED FAILURE MODE: Unhandled HTTP 500 on Non-Dictionary JSON Bodies
- **Command / Payload**:
  ```powershell
  python -c "import urllib.request; req = urllib.request.Request('http://127.0.0.1:8095/api/survey/surface-qa', data=b'[1, 2, 3]', headers={'Content-Type': 'application/json'}, method='POST'); urllib.request.urlopen(req)"
  ```
- **Verbatim Server Response**:
  ```
  HTTP/1.0 500 Internal Server Error
  Content-Type: application/json
  {"error": "'list' object has no attribute 'get'"}
  ```
- **File & Line**:
  `pc_worker/server_api_routes.py` lines 130–135:
  ```python
  130:        try:
  131:            payload = json.loads(body.decode("utf-8")) if body else {}
  132:        except Exception as e:
  133:            self.send_json({"error": f"Invalid JSON: {e}"}, status=400)
  134:            return
  ```
  `payload` is parsed as a valid JSON `list` (`[1, 2, 3]`), string, or integer, but `pc_worker/server_api_routes.py` does not check `isinstance(payload, dict)`.
  When `payload.get(...)` is called downstream (e.g. line 1036: `requested_scan_id=payload.get("scan_id")` or in `construction_qa.py` line 73: `scan_id = str(payload.get("scan_id") or "").strip()`), Python raises `AttributeError: 'list' object has no attribute 'get'`.
  The unhandled exception bubbles up to the outer HTTP handler which sends an unhandled **HTTP 500 Internal Server Error** instead of a clean **HTTP 400 Bad Request** (`{"error": "Payload must be a JSON object"}`).

---

## 2. Logic Chain
1. *Observation 1.5*: Sending valid JSON non-dictionary payloads (e.g. `[1, 2, 3]`, `"a string"`, or `12345`) to `/api/survey/surface-qa`, `/api/survey/utility-trace`, `/api/survey/compare-volume`, and `/api/survey/stakeout-export` triggers an unhandled `AttributeError: 'list' object has no attribute 'get'` and returns `HTTP 500 Internal Server Error`.
2. *Requirement*: The prompt states:
   > "Test invalid/empty/malformed payloads and verify clean HTTP 400/404 error responses without unhandled 500 exceptions."
3. *Logic*: A production-grade civil API endpoint receiving a non-dictionary JSON body must return a clean client error (`HTTP 400 Bad Request: {"error": "Payload must be a JSON object"}`), not crash with an internal server error `HTTP 500`.
4. *Constraint*: As an empirical challenger, my role is review-only. I must NOT modify implementation code.
5. *Deduction*: Therefore, the appropriate and required verdict is **REQUEST_CHANGES** so the worker can add the 2-line type guard in `pc_worker/server_api_routes.py`.

---

## 3. Caveats
- No raw scan data, comments, or database records were modified or deleted during testing (verified 572 GB and 523,114 files intact in `C:\GatheringScans`).
- All core civil mathematics (SVD plane fitting, ASTM E1155, utility tracer invert/crown, BCM/LCM/CCM mass conservation, RTK stakeout E-N-Z order) and frontend UI constraints (< 5,000 lines, 0 emojis, 1-word buttons, dark/light themes) are 100% compliant and fully verified.
- Only the input type validation in HTTP POST request parsing requires mitigation.

---

## 4. Conclusion
Milestone 4 and Milestone 5 demonstrate outstanding mathematical rigor and compliance with civil surveying standards. However, because valid JSON non-dictionary inputs trigger unhandled `HTTP 500 Internal Server Error` instead of clean `HTTP 400 Bad Request`, the requirement for clean error handling without 500s failed.

**Verdict**: **REQUEST_CHANGES**

### Actionable Mitigation for Worker
In `pc_worker/server_api_routes.py`, immediately following JSON parsing at line 134, add an `isinstance` check:
```python
        try:
            payload = json.loads(body.decode("utf-8")) if body else {}
        except Exception as e:
            self.send_json({"error": f"Invalid JSON: {e}"}, status=400)
            return

        if not isinstance(payload, dict):
            self.send_json({"error": "Payload must be a JSON object"}, status=400)
            return
```
And/or in `pc_worker/surveying/construction_qa.py`, ensure each handler safely coerces `payload = payload if isinstance(payload, dict) else {}`.

---

## 5. Verification Method
To independently reproduce the bug and verify the fix:

1. **Bug Reproduction Command**:
   ```powershell
   python -c "import urllib.request; req = urllib.request.Request('http://127.0.0.1:8095/api/survey/surface-qa', data=b'[1, 2, 3]', headers={'Content-Type': 'application/json'}, method='POST'); urllib.request.urlopen(req)"
   ```
   *Expected Current Output*: HTTP 500 with `{"error": "'list' object has no attribute 'get'"}`.
   *Expected Fixed Output*: HTTP 400 with `{"error": "Payload must be a JSON object"}`.

2. **Run Full Adversarial Challenge Suite**:
   ```powershell
   python -m unittest tests/test_m4_m5_adversarial_challenger.py
   ```
   *Current Result*: 13 passed, 1 failed (`test_09_non_dict_json_payloads`).
   *Post-Fix Result*: 14 passed (100% OK).

3. **Run Regression Suites**:
   ```powershell
   python -m unittest tests.test_gathering_scans_suite.GatheringScansTestSuite.test_39_milestone4_milestone5_construction_qa_and_stakeout tests/test_civil_surveying_e2e.py
   python -m unittest tests/test_gathering_scans_suite.py
   ```
