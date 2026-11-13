## 2026-10-31T06:26:08Z
You are worker_m2_iter2 (Milestone 2 UI/UX Remediation Worker).
Your working directory is: c:\Antigravity\GatheringScans\.agents\teamwork\worker_m2_iter2\
Your parent is: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3

MANDATORY: Read c:\Antigravity\GatheringScans\.agents\teamwork\ORIGINAL_REQUEST.md and c:\Antigravity\GatheringScans\.agents\teamwork\PROJECT.md before doing anything else.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

CONTEXT & REASON FOR ITERATION 2:
Milestone 2 Gate 1 passed all mathematical, statistical, backend persistence, and unit test checks (63/63 tests passing, auditor verified CLEAN).
HOWEVER, Gate 1 FAILED on mandatory user directives based on `m2_gcp_qa_inspector.png`:
User feedback: "Just looking at this photo, I immediately see that emojis were used instead of icons, which is a no-no; bright/dark theme were not properly configured; excessive text and more than 1 word in buttons."

YOUR TASKS:
1. ZERO UNICODE EMOJIS IN UI:
   - Inspect `web/src/09-construction-survey-and-bim.js` and `web/survey-bim.css`.
   - Remove every single Unicode emoji (e.g. 📍, 📊, ⚖️, 📋, 📄, 🔍, ✅, ⚠️, 🚛, 🎯, 📌, etc.) across all headings, cards, table headers, table cells, toolbars, badges, and buttons.
   - Replace each with clean, crisp inline SVG icons (14x14 or 16x16 with viewBox, stroke="currentColor", stroke-width="2", fill="none") consistent with the existing minimalist Autodesk/BIM CAD design language.
2. COMPREHENSIVE BRIGHT & DARK THEME SUPPORT:
   - In `web/src/09-construction-survey-and-bim.js`, remove all hardcoded dark hex colors (`#0f172a`, `#1e293b`, `#334155`, `#f8fafc`, `rgba(15,23,42,...)`) from HTML template strings.
   - In `web/survey-bim.css`, style all surfaces, cards, tables, headers, and text using standard CSS variables: `var(--bg-surface)`, `var(--bg-elevated)`, `var(--text-main)`, `var(--text-muted)`, `var(--border-subtle)`, `var(--primary)`, etc.
   - Add explicit support for both `.theme-dark` and `.theme-light` (or `[data-theme="light"]` / `[data-theme="dark"]` matching `web/app.css` / `07-compare-and-queue.js`) so that all text, KPI borders, and table cells have high contrast and clean appearance in bright theme as well as dark theme.
3. MINIMALIST TEXT & STRICT 1-WORD BUTTON LABELS:
   - Strip out explanatory paragraphs, walls of text, and wordy subtitles. Use compact metric cells, concise labels, and native browser tooltips (`title="..."`) for explanations.
   - EVERY BUTTON LABEL MUST BE AT MOST 1 WORD (plus an inline SVG icon).
     Examples:
     - `<button ...><svg .../> 檢核</button>` (or `[svg] Check`)
     - `<button ...><svg .../> 選點</button>` (or `[svg] Pick`)
     - `<button ...><svg .../> 校正</button>` (or `[svg] Calibrate`)
     - `<button ...><svg .../> 重設</button>` (or `[svg] Reset`)
     - `<button ...><svg .../> CSV</button>`
     - `<button ...><svg .../> 報告</button>` (or `[svg] Report`)
     - `<button ...><svg .../> 關閉</button>` (or `[svg] Close`)
     - Exaggeration factor buttons: `1x`, `10x`, `20x`, `50x`, `100x`.
     NEVER use multi-word sentences inside button labels!
4. STRICT 5,000-LINE MODULAR CEILING:
   - DO NOT modify `03-studio-core.js`, `05-studio-civil-inspectors.js`, or `08-advanced-surveying-and-qa.js`.
   - All changes must remain strictly inside `web/src/09-construction-survey-and-bim.js` and `web/survey-bim.css`. Ensure both remain strictly < 5,000 lines.
5. DUAL-THEME SCREENSHOT CAPTURE:
   - Capture real `.png` screenshots using headless Chrome CDP:
     - `c:\Antigravity\GatheringScans\.agents\teamwork\screenshots\m2_gcp_qa_dark_theme.png` (Dark theme active)
     - `c:\Antigravity\GatheringScans\.agents\teamwork\screenshots\m2_gcp_qa_light_theme.png` (Bright/Light theme active)
     - Update `c:\Antigravity\GatheringScans\.agents\teamwork\screenshots\m2_gcp_qa_inspector.png` with the new emoji-free UI.
6. AUTOMATED VERIFICATION & SYNCHRONIZATION:
   - Run both test suites: `python -m unittest tests/test_civil_surveying_e2e.py` and `python -m unittest tests/test_gathering_scans_suite.py`.
   - Bump cache version query to `?v=20261031_v220` in `web/index.html` and `web/sw.js`.
   - Commit changes: `git add web/src/09-construction-survey-and-bim.js web/survey-bim.css web/index.html web/sw.js tests/ && git commit -m "Remediate M2 UI: zero emojis, SVG icons, 1-word buttons, bright and dark theme support v220"`.
   - Push to `origin/main` (if rate-limited, proceed with direct VPS update).
   - Reload local server (`ensure_daemon_running.ps1` at `127.0.0.1:8095`) and reload production VPS container (`docker restart gathering_scans_web` on `76.13.197.29`). Verify 200 OK on both.

## 2026-10-31T06:47:55Z
**Context**: Milestone 2 UI/UX Polish — 3 Specific Visual Polish Issues to Fix Before Finishing
**Content**: Visual inspection of `m2_gcp_qa_dark_scrolled.png` and `m2_gcp_qa_light_scrolled.png` revealed 3 visual polish items that must be fixed:
1. **Legacy Emoji Peeking at Bottom of Panel**: At the very bottom of `m2_gcp_qa_light_scrolled.png` (below the CSV / 報告 / 列印 buttons), a clipped legacy row from `08-advanced-surveying-and-qa.js` peeks through with a green plant emoji (`🌱`). Ensure that `openGcpAccuracyQaInspector` completely empties / replaces any legacy content in the panel (`container.innerHTML = ...` or remove prior children), and verify no legacy emojis peek through.
2. **Duplicate Header & Wrapping CRS Subtitle**: The outer panel header says `控制點精度檢核`. Right below, the inner card repeats `控制點空間精度檢核` with a 3-line wrapping subtitle (`CRS: TWD97 / TM2 zone 121 + TWVD 2001 height - EPSG:3826+8904 [TWGEOID2018h] · N = 6` where `= 6` dangles on line 3). Remove the duplicate inner heading and replace the subtitle with a compact single-line badge/pill (`EPSG:3826 + TWVD2001 · N=6`).
3. **Horizontal Scrollbar Clipping the Residual Table**: The residual table overflows the narrow side panel width, creating a horizontal scrollbar and clipping the right edge. Make table columns compact (`TBM | ID | ΔE | ΔN | ΔH | Δ3D` in cm, e.g. `±0.5` or `+1.2`), and move `H_gcp` and `H_scan` into row tooltip `title="..."` so the table fits 100% cleanly inside the side panel with NO horizontal scrollbar!

Re-capture the verification screenshots (`m2_gcp_qa_dark_theme.png`, `m2_gcp_qa_light_theme.png`, `m2_gcp_qa_dark_scrolled.png`, `m2_gcp_qa_light_scrolled.png`) to prove these 3 issues are completely resolved.
**Action**: Implement these 3 polish fixes, verify clean layout without emojis or scrollbars, and report in handoff.md.
