# Adversarial Challenge Handoff Report: Milestone 3 — Centerline Stationing, AEA Volume & Surface Drainage Ponding

**Agent**: `challenger_m3_2` (Empirical Challenger, Critic & Specialist)  
**Parent Agent**: `35a7b3c4-959a-4d2b-a4b5-21fb2891dea3`  
**Timestamp**: 2026-10-31T07:55:00Z  
**Scope**: Adversarial live API fuzzing, payload stress-testing, Caterpillar mass conservation, zero data destruction, and downstream regression verification for Milestone 3.  
**Verdict**: **REQUEST_CHANGES** (Empirically verified unhandled HTTP 500 crash on primitive non-iterable alignment payloads, plus orphaned dead code stub in `dsm_and_volume.py`).

---

## 1. Observation

### A. Live Server & Endpoint Payload Fuzzing
1. **Server Status**:
   - `http://127.0.0.1:8095/api/status` returned `200 OK` (`pc_online: true, daemon_running: true, total_scans: 27`).

2. **Empirical Finding 1 (Medium Severity — Unhandled 500 Crash on Primitive Alignment)**:
   - Command:
     ```python
     import urllib.request, json
     req = urllib.request.Request(
         'http://127.0.0.1:8095/api/survey/stationing',
         data=json.dumps({'scan_id': 'quchi_20261005_merged', 'alignment': 12345}).encode(),
         headers={'Content-Type': 'application/json'}
     )
     urllib.request.urlopen(req)
     ```
   - Verbatim Response:
     `HTTP Error 500: Internal Server Error`
     Body: `{"error": "'int' object is not iterable"}`
   - Tested variations:
     - `{"alignment": True}` -> `HTTP 500: {"error": "'bool' object is not iterable"}`
     - `{"alignment": 45.67}` -> `HTTP 500: {"error": "'float' object is not iterable"}`
   - Exact location in code:
     `pc_worker/surveying/contours_and_cad.py`, lines 2799–2821:
     ```python
     2799: raw_align = payload.get("alignment") or payload.get("centerline") or payload.get("polyline") or payload.get("points") or []
     ...
     2821: for item in raw_align:
     2822:     parsed_pt = _parse_align_pt(item)
     ```
     When `alignment` is an integer, boolean, or float, `raw_align` evaluates to the truthy primitive instead of a list or tuple. Looping `for item in raw_align:` raises `TypeError: '<type>' object is not iterable`. Because this is unhandled in `compute_centerline_stationing_and_volume`, the exception bubbles to `pc_worker/server_api_routes.py:1028` and outputs HTTP 500.

3. **Empirical Finding 2 (Low Severity — Dead / Shadow Code Method Stub)**:
   - In `pc_worker/surveying/dsm_and_volume.py`, lines 2499–2535:
     An incomplete, unclosed stub of `compute_drainage_and_slope` was left directly above `@staticmethod def _parse_custom_slope_tiers`:
     ```python
     2499: def compute_drainage_and_slope(self, payload: Dict[str, Any]) -> Dict[str, Any]:
     ...
     2534:     hull_mask = dsm_data.get("hull_mask")
     2535: 
     2536: @staticmethod
     2537: def _parse_custom_slope_tiers(custom_input: Any) -> List[Dict[str, Any]]:
     ```
     At line 2812, `def compute_drainage_and_slope` is defined again with the full implementation including Priority-Flood depression calculation. While Python allows this (the latter class attribute overwrites the former), lines 2499–2535 are orphaned dead code that clutters the codebase.

4. **Resilient Payloads Handled Gracefully**:
   - Empty payload `{}`: Returns HTTP 404 `{"error": "Missing scan_id"}` (graceful HTTP client error, no 500 crash).
   - Missing / empty scan ID `{"scan_id": ""}`: Returns HTTP 404 `{"error": "Missing scan_id"}`.
   - Non-existent scan ID `{"scan_id": "ghost_scan_404"}`: Returns HTTP 404 `{"error": "Scan not found: ghost_scan_404"}`.
   - Negative swath width `{"swath_width": -100.0}`: Safely clamped to 2.0m minimum.
   - Zero / negative interval `{"interval": 0.0}`: Safely clamped to 10.0m default / 1.0m minimum.
   - Malformed alignments with strings, nested nulls, non-numeric items, single points, or duplicate identical points: Deduplicated and safely triggered synthetic alignment spanning scan bounds, returning HTTP 200 OK.
   - Drainage endpoint `/api/survey/drainage`: Handled invalid `grid_size` ("INVALID"), invalid `min_ponding_depth_m` ("BAD"), negative depths (-10m), non-list `custom_slope_tiers` (12345), and unsorted tiers safely returning HTTP 200 OK.

### B. Caterpillar Earthwork Mass Conservation Verification
- Tested across varied geotechnical parameters (swell factor 1.15–1.40, shrinkage factor 0.05–0.15, density 1.45–1.90 t/m³, truck capacity 12.0–18.0 m³, truck payload 18.0–25.0 tonnes) and site balances:
  1. **Surplus Cut** (offset -20m):
     - Bank Cut: 120,761.85 m³ (BCM)
     - Loose Cut: 156,990.41 m³ (LCM = BCM × 1.30, exact to 0.01 m³)
     - Compacted Cut: 106,270.43 m³ (CCM = BCM × (1 - 0.12), exact to 0.01 m³)
     - Conserved Mass: 205,295.15 tonnes (Mass = BCM × 1.70, exact to 0.01 tonnes)
     - Trips: 10,467 trips governed by weight constraint.
  2. **Deficit Fill** (offset 0m):
     - Bank Cut: 26,636.61 m³, Fill: 83,126.21 m³, Net: -56,489.60 m³
     - Borrow haul target: 73,436.48 m³ (LCM = |-56489.60| × 1.30)
     - Trips: 4,896 trips.
  3. **Large Deficit Fill** (offset +20m):
     - Bank Cut: 3,982.85 m³, Fill: 241,080.42 m³, Net: -237,097.57 m³
     - Trips: 20,549 trips.
  - Mathematical mass and volume conservation holds 100% across all evaluated scenarios.

### C. Zero Data Destruction Audit
- Directory `C:\GatheringScans`:
  - 42 project directories present.
  - 523,114 total raw files (.las, .laz, .tiff, .jpg, .glb, etc.) verified untouched.
  - Zero deleted, renamed, or modified raw survey datasets.
- Database `data/gathering_scans.db`:
  - `PRAGMA integrity_check` -> `ok`.
  - `PRAGMA foreign_key_check` -> `[]` (0 errors).
  - All 27 scan rows and 11 tables intact.

### D. Regression Test Suite Execution
- `python -m unittest tests/test_civil_surveying_e2e.py`: 57 tests passed in 4.928s (**OK**).
- `python -m unittest tests/test_gathering_scans_suite.py`: 39 tests passed in 12.803s (**OK**), including strict 5,000-line ceiling (`test_07_modular_architecture_strict_5000_line_ceiling`).
- `python -m unittest tests/test_m3_adversarial_challenge.py`: 16 adversarial tests passed in 1.608s (**OK**).

---

## 2. Logic Chain

1. The prompt mandates: *"Test invalid, empty, or malicious payloads... Verify graceful HTTP error responses without unhandled 500 crashes."*
2. Passing an alignment payload with a primitive type (`int`, `bool`, `float`) into `/api/survey/stationing` causes `contours_and_cad.py:2821` to attempt iteration on a non-iterable object.
3. This raises `TypeError: '<type>' object is not iterable`, which bubbles up to the HTTP server handler and emits an unhandled `500 Internal Server Error`.
4. While typical frontend requests send valid coordinate arrays, robust production civil engineering web APIs must defend against malformed payloads and never throw 500 server crashes.
5. In addition, the orphaned stub at lines 2499–2535 of `dsm_and_volume.py` represents accidental dead code introduced during refactoring.
6. Therefore, while core calculation mathematics (stationing, AEA, Priority-Flood ponding, Caterpillar mass conservation) and data integrity are authentic and sound, this unhandled 500 defect requires a 2-line defensive hardening patch before final approval.

---

## 3. Caveats

- Finding 1 does not affect standard frontend UI usage because `09-construction-survey-and-bim.js` always packages alignment coordinates as an array of points (`[{e, n}, ...]`) or omits the key. The vulnerability only triggers when an external or third-party client passes a non-iterable primitive value in the alignment field.
- The orphaned stub in `dsm_and_volume.py` does not alter runtime behavior because the later class definition overrides it in Python's class namespace dictionary.

---

## 4. Conclusion

**Verdict: REQUEST_CHANGES**

To clear this gate, Worker Track A must apply the following two trivial fixes:

### Required Action 1: Guard Alignment Type in `pc_worker/surveying/contours_and_cad.py`
In `compute_centerline_stationing_and_volume`, lines 2799–2801, add an `isinstance` sequence guard:
```python
# Before (line 2799):
raw_align = payload.get("alignment") or payload.get("centerline") or payload.get("polyline") or payload.get("points") or []

# After:
raw_align = payload.get("alignment") or payload.get("centerline") or payload.get("polyline") or payload.get("points") or []
if not isinstance(raw_align, (list, tuple)):
    raw_align = []
```
This ensures non-iterable primitives gracefully fallback to the default synthetic domain alignment (or empty), returning HTTP 200 OK instead of HTTP 500.

### Required Action 2: Remove Orphaned Dead Code in `pc_worker/surveying/dsm_and_volume.py`
Delete lines 2499–2535 in `pc_worker/surveying/dsm_and_volume.py` (the truncated, shadowed stub of `compute_drainage_and_slope`).

---

## 5. Verification Method

To independently verify the bug reproduction and validate the fix once applied:

1. **Reproduction Test**:
   ```powershell
   python -c "import urllib.request, json; req = urllib.request.Request('http://127.0.0.1:8095/api/survey/stationing', data=json.dumps({'scan_id': 'quchi_20261005_merged', 'alignment': 12345}).encode(), headers={'Content-Type': 'application/json'}); urllib.request.urlopen(req)"
   ```
   - Current behavior: Returns HTTP 500 with `{"error": "'int' object is not iterable"}`.
   - Expected behavior after fix: Returns HTTP 200 OK with default alignment.

2. **Run Full Adversarial & Regression Test Suites**:
   ```powershell
   python -m unittest tests/test_m3_adversarial_challenge.py
   python -m unittest tests/test_civil_surveying_e2e.py
   python -m unittest tests/test_gathering_scans_suite.py
   ```

3. **Verify Zero Data Destruction**:
   ```powershell
   python -c "import os, sqlite3; print('Raw exists:', os.path.exists(r'C:\GatheringScans')); conn = sqlite3.connect(r'data/gathering_scans.db'); print('DB integrity:', conn.cursor().execute('PRAGMA integrity_check').fetchall())"
   ```
