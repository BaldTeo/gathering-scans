# GatheringScans — Mandatory Agent Synchronization & Deployment Rules (`AGENTS.md`)

> **CRITICAL RULE FOR ALL AGENTS:**
> You **MUST** follow this exact GitHub + Local Server + Hostinger VPS synchronization protocol on **every session and after every code save/modification**. Never leave changes only in local files without syncing to GitHub and reloading both the local server and the live VPS container.

---

## 1. Pre-Flight Rule: Always Fast-Forward from GitHub First
Before reading, planning, or modifying any code in `c:\Antigravity\GatheringScans`, you **MUST** fetch and fast-forward the latest commits from `origin/main` so you never overwrite or ignore recent updates:

```powershell
git fetch origin main
git status
# If working tree has local changes, inspect them carefully (`git diff`) so they are preserved, then fast-forward:
git merge --ff-only origin/main
```

- **Never** run `git reset --hard` or `git checkout -- <file>` that would discard uncommitted user or parallel-session changes (`server.py`, `web/app.js`, `web/index.html`, `web/app.css`, `web/sw.js`, `pc_worker/*`).
- Always bump the cache-busting asset version query string (`?v=YYYYMMDD_vXX` in `web/index.html` and `CACHE_NAME` in `web/sw.js`) whenever modifying frontend assets (`web/app.js`, `web/app.css`, `web/index.html`).

---

## 2. Post-Save Rule: Push to GitHub & Deploy to Both Local Server and Live VPS After Every Save
Whenever you save code changes (or complete an implementation iteration), you **MUST** immediately execute all three steps below before finishing your turn:

### Step A — Commit & Push to GitHub (`origin/main`)
Stage only source/config files (never commit `.env`, API keys, or runtime `.log`/`.pid` files):
```powershell
git add server.py start_gathering_scans.py pc_worker/ web/ tests/ vps_deploy/ docker-compose.yml Dockerfile AGENTS.md
git commit -m "Describe the update and bumped asset version"
git push origin main
```

### Step B — Restart / Reload the Local Windows PC Server (`127.0.0.1:8095`)
Because Python keeps `server.py` and `pc_worker/*` loaded in memory, editing `.py` files on disk does **not** update the running `127.0.0.1:8095` server until the process is restarted:
```powershell
# Stop existing Python server listening on 8095 (while preserving any running PIX4Dmatic.exe process) and relaunch via watchdog:
Get-NetTCPConnection -LocalPort 8095 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1
powershell -ExecutionPolicy Bypass -File "C:\Antigravity\GatheringScans\ensure_daemon_running.ps1"
```
Then verify `http://127.0.0.1:8095/api/status` returns `200 OK`.

### Step C — Update & Restart the Live Hostinger VPS Server (`scans.gatheren.cloud` / `76.13.197.29`)
The live production container `gathering_scans_web` on `76.13.197.29` pulls the latest `main.tar.gz` from `https://github.com/BaldTeo/gathering-scans` on container start (and syncs `/docker/gathering_scans` & `/opt/gathering_scans`):
1. Pull the latest `origin/main` into the VPS host directories (`/docker/gathering_scans` and `/opt/gathering_scans` if present) and restart the `gathering_scans_web` container:
   ```powershell
   ssh -i "$env:USERPROFILE\.ssh\id_gathering_vps" -o StrictHostKeyChecking=no root@76.13.197.29 "cd /docker/gathering_scans 2>/dev/null && git pull --ff-only origin main || true; cd /opt/gathering_scans 2>/dev/null && git pull --ff-only origin main || true; docker restart gathering_scans_web"
   ```
2. Verify that both `http://127.0.0.1:8095/api/status` and `https://scans.gatheren.cloud/api/status` respond with `200 OK` and serve the updated asset version.

---

## 3. 3D Scan Classification & Cache Persistence Rules
Whenever modifying 3D scan classification logic (`pc_worker/surveying_engine.py`), `/api/survey/categorize*` endpoints (`server.py`), or 3D categorization overlays (`web/app.js`):
1. **Consult the `scan-classification-tuning` Skill**: Read `.agent/skills/scan-classification-tuning/SKILL.md` before changing tree, wall, road, or water detection heuristics.
2. **Update & Commit Server Cache Files**: Regenerate and commit `data/categorization_cache/<scan_id>_categorization_v3.json` alongside `<project_dir>/_categorization_cache_v3.json` so both the local PC server and Hostinger VPS serve the updated classifications immediately.
3. **Preserve Manual Overrides & Hidden-by-Default UX**:
   - Always preserve existing `manual_overrides` (`added_trees`, `added_walls`, `added_roads`, `added_water`, `removed_ids`) across algorithmic recomputes.
   - Keep 3D classification overlays hidden by default on scan load (`overlay_visible_default: false` / `STATE.categorizeOverlayVisible = false`) with separate toggles for 3D overlays and 3D labels.
4. **Multi-Scan Regression Check**: Verify classification changes across `edited_qihu_unified_merged_scan_4_scans__edited_372953`, `rosepark_20260918_merged`, `ntudorm_20260915_baseline`, and `QuChi261016_Trees` to ensure improving one site never degrades another.
