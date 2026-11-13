# BRIEFING — 2026-10-31T16:50:00Z

## Mission
Fix 3D viewport overlay rendering across Milestones 4, 5, 6, and 7 so that true 3D geometric entities (BIM solids, underground utility pipes, slab flatness/wall plumbness heatmaps, open-trench pipes, compare cut/fill prisms, stakeout pins) are vividly visible in the Three.js viewport and captured in dual-theme screenshots.

## 🔒 My Identity
- Archetype: worker_3d_viewport_overlays
- Roles: implementer, qa
- Working directory: c:\Antigravity\GatheringScans\.agents\teamwork\worker_3d_viewport_overlays\
- Original parent: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3
- Milestone: 3D Viewport Overlays (M4, M5, M6, M7)

## 🔒 Key Constraints
- Zero destruction of raw scan data or database records.
- Strict 5,000-line modular ceiling per file.
- Zero Unicode emojis (monochrome inline SVGs only).
- CSS variables for Bright and Dark theme support.
- Strict 1-word buttons.
- Bump asset version query string in web/index.html and web/sw.js.
- Pass test suites.
- GitHub commit/push, local server restart on 8095, VPS update.

## Current Parent
- Conversation ID: 35a7b3c4-959a-4d2b-a4b5-21fb2891dea3
- Updated: 2026-10-31T16:50:00Z

## Task Summary
- **What to build**: Expose `window.studioThree` in `web/src/03-studio-core.js`. Fix TWD97 to local coordinates transformation in modules 10, 11, 12 using canonical `originTwd = localToTwd97({x:0, y:0, z:0})`. Implement solid 3D BIM primitives with mesh ghosting in module 11. Implement subsurface X-ray 3D pipes with leader lines and auto-frame in module 12. Implement 3D deviation heatmap grid/frame/pins/normal arrows, 3D cylindrical trench pipes, and 3D cut/fill prisms in module 10. Re-capture and verify all screenshots in dark and light modes.
- **Success criteria**: 3D geometric entities are visibly populated in the 3D viewport in screenshots for M4, M5, M6, M7.
- **Interface contracts**: `PROJECT.md` / `SCOPE.md`
- **Code layout**: `web/src/*.js`, `pc_worker/*`, `tests/*`

## Key Decisions Made
- Exposed `window.studioThree = studioThree;` in `web/src/03-studio-core.js` line 549 so all modular studio inspectors can query the Three.js context.
- Computed canonical local scene origin via `originTwd = (typeof localToTwd97 === 'function') ? localToTwd97({ x: 0, y: 0, z: 0 }) : { e: 0, n: 0, h: 0 }` to avoid multi-hundred-kilometer offsets.
- For Subsurface Utilities (M7), applied X-ray rendering with `depthTest: false`, `renderOrder: 995`, glowing emissive colors, vertical surface leader drop-lines, and camera auto-framing.
- For Scan-to-BIM (M6), ghosted the raw photogrammetric mesh to `opacity: 0.25` and rendered shaded solid 3D primitives with wireframe edges.
- For Surface QA (M4), rendered 3D point deviation heatmap, reference plane frame, high/low cones, drop lines, normal arrows, and auto-focused camera on surface.
- For Utility Tracer (M4), rendered true 3D cylindrical pipe with amber wireframe trench, depth-of-cover drop lines, and stationing rings.
- For Compare Delta-V (M5), rendered 3D cut (red) and fill (blue) volumetric prisms.

## Change Tracker
- **Files modified**:
  - `web/src/03-studio-core.js` (line 549: attached `window.studioThree`)
  - `web/src/10-construction-qa-and-stakeout.js` (canonical origin, 3D overlays for flatness/plumbness, cylindrical pipe tracer, cut/fill prisms, stakeout pins)
  - `web/src/11-scan-to-bim-primitives.js` (canonical origin, mesh ghosting, solid shaded BIM primitives, auto-render on fit)
  - `web/src/12-public-utilities-gis.js` (canonical origin, subsurface X-ray mode, depthTest: false, ground leader lines)
  - `pc_worker/surveying/construction_qa.py` (graceful grading simulation fallback for compare volume)
  - `web/index.html` (bumped to v231)
  - `web/sw.js` (bumped to v231)
- **Build status**: Pass (39/39 unit tests, 57/57 civil surveying tests)
- **Pending issues**: None

## Quality Status
- **Build/test result**: Pass (Commit `79a37b2`, local server 8095 online, VPS 76.13.197.29 container online)
- **Lint status**: Strict 5000-line modular ceiling compliant across all files
- **Tests added/modified**: `tests/capture_m4_m5_m6_screenshots.py` updated and 12 screenshots verified

## Artifact Index
- `.agents/teamwork/worker_3d_viewport_overlays/DISPATCH.md` — assignment
- `.agents/teamwork/worker_3d_viewport_overlays/BRIEFING.md` — state
- `.agents/teamwork/worker_3d_viewport_overlays/handoff.md` — 5-component handoff report
- `.agents/teamwork/screenshots/*.png` — verified dual-theme screenshots with 3D overlays
