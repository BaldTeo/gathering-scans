# BRIEFING — 2026-10-31T04:20:00Z

## Mission
Empirically stress-test and verify `calculate_cut_fill_volume` and least-squares best-fit plane in `pc_worker/surveying/dsm_and_volume.py` across extreme slopes, collinear points, determinant collapse, scale extremes, large coordinate offsets, and trigonometric azimuth/slope oracles.

## 🔒 My Identity
- Archetype: empirical challenger
- Roles: critic, specialist
- Working directory: c:\Antigravity\GatheringScans\.agents\teamwork\challenger_m1_1
- Original parent: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3
- Milestone: M1 Numerical & Geometric Challenger
- Instance: 1 of 1

## 🔒 Key Constraints
- Review-only — do NOT modify implementation code
- Report failures as findings — do not fix them yourself
- Empirically verify everything: if you cannot reproduce a bug empirically, it does not count
- Provide explicit verdict in handoff.md: APPROVE or REQUEST_CHANGES

## Current Parent
- Conversation ID: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3
- Updated: 2026-10-31T04:20:00Z

## Review Scope
- **Files to review**: `pc_worker/surveying/dsm_and_volume.py`
- **Interface contracts**: `c:\Antigravity\GatheringScans\.agents\teamwork\PROJECT.md`, `c:\Antigravity\GatheringScans\.agents\teamwork\ORIGINAL_REQUEST.md`
- **Review criteria**: Numerical stability, boundary edge cases, float64 precision/cancellation, collinear determinant collapse safeguards, trigonometric correctness, extreme polygon scales.

## Attack Surface
- **Hypotheses tested**:
  - Near-vertical slopes (89.9 deg and 89.99 deg): Verified robust and non-crashing across all 8 cardinal/intercardinal azimuths.
  - Collinear determinant collapse: FAILED on lines >= 100m at arbitrary angles (det becomes negative noise > 1e-9 in magnitude) and on near-collinear 179.999 deg lines with 10m baseline (det > 1e-9).
  - Micro-polygons (0.0001 m^2): Verified safe from crash; area rounded to 0.00 m^2 per formatting.
  - Giant polygons (10km x 10km): Verified fast execution (< 0.1s) and float64 stability.
  - Coordinate offsets (3,000,000 E, 27,000,000 N): Verified exact precision via centroid conditioning.
  - Trigonometric oracles (all 360 deg): 100% agreement.
- **Vulnerabilities found**:
  - Determinant safeguard `abs(det_plane) < 1e-9` leaks on collinear lines >= 100m where float64 cancellation produces det = -7.45e-9 or worse, computing a spurious 8.84% slope instead of 0.0%.
  - Fixed dimensional threshold `1e-9` in meters^4 fails for 179.999 deg near-collinear points with 10m baseline, computing a 114,591% slope.
- **Untested angles**: None in M1 scope.

## Loaded Skills
- None requested in dispatch.

## Key Decisions Made
- Tested isolated numerical plane solver and full end-to-end `calculate_cut_fill_volume` on real and synthetic scan DSMs.
- Executed 18 automated adversarial test cases in `test_m1_empirical_adversarial.py`.
- Formulated mathematically proven eigenvalue-based mitigation for collinear safeguard.
- Issued verdict: REQUEST_CHANGES.

## Artifact Index
- `test_m1_empirical_adversarial.py` — Adversarial test suite with 18 empirical stress tests.
- `handoff.md` — Final handoff report with verdict and 5 components.
- `progress.md` — Liveness heartbeat.
