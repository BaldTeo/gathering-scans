#!/usr/bin/env python3
"""
GatheringScans HTTP Write Routes Mixin (do_POST & do_DELETE)
Separated from server.py to keep all server modules strictly under 2,650 lines.
"""

import os
import re
import json
import time
import base64
import shutil
import threading
import urllib.parse
from typing import Dict, Any, Optional, Tuple

from pc_worker.config import (
    TUNNEL_SHARED_KEY,
    LOCAL_SCANS_ROOT,
    GDRIVE_INBOX_DIR,
    GDRIVE_INPUTS_DIR,
    MATERIAL_CATALOG,
    TWD97_TWVD2001_LABEL,
    TWD97_TWVD2001_SHORT,
    PIX4DMATIC_TEXTURE_SIZE,
    load_pix4d_settings,
    save_pix4d_settings,
    load_pix4d_settings_from_dict,
)
from pc_worker.gdrive_watcher import seed_and_discover_scans, extract_opf_zip_metadata
from pc_worker.pix4d_runner import (
    generate_pix4dmatic_gst_script,
    run_pix4dmatic_pipeline,
)
from pc_worker.auth_and_sharing import (
    ROLE_LEVELS,
    ROLE_LABELS,
    normalize_role,
    get_role_permissions,
)
from pc_worker.server_cloud_and_tunnel import (
    BASE_DIR,
    DATA_DIR,
    WEB_DIR,
    THUMBS_DIR,
    GLB_CACHE_DIR,
    DB,
    OPTIMIZER,
    SURVEY,
    AUTH_SHARE,
    GCHAT,
    _DAEMON_WAKE_EVENT,
    _PIX4D_WAKE_EVENT,
    _VPS_RAM_FALLBACK_CACHE,
    is_pc_daemon_running,
    set_pc_daemon_running,
    get_pc_daemon_status,
    sync_scans_with_filesystem,
    _load_cloud_manifest,
    _save_cloud_manifest,
    _load_cloud_auth,
    _save_cloud_auth,
    _test_gdrive_service_account,
)


class ServerWriteRoutesMixin:
    @staticmethod
    def _can_actor_modify_comment(
        existing_cmt: Optional[Dict[str, Any]],
        actor_email: str,
        actor_role: str,
        payload: Optional[Dict[str, Any]] = None,
    ) -> bool:
        if actor_role in ("admin", "owner"):
            return True
        if not existing_cmt:
            return False
        c_email = str(existing_cmt.get("author_email") or "").strip().lower()
        c_name = str(existing_cmt.get("author_name") or "").strip().lower()
        a_email = str(actor_email or (payload or {}).get("author_email") or "").strip().lower()
        a_name = str((payload or {}).get("author_name") or "").strip().lower()
        owner_aliases = {"glibivanov@gatheren.com.tw", "gleb.ivanov1999@gmail.com"}
        if a_email and a_email not in ("guest@gatheren.cloud", "external@gatheren.cloud"):
            if c_email == a_email or (a_email in owner_aliases and c_email in owner_aliases):
                return True
            if c_email and c_email not in ("guest@gatheren.cloud", "external@gatheren.cloud"):
                return False
        if c_email in ("", "external@gatheren.cloud", "guest@gatheren.cloud") and a_name and c_name == a_name:
            return True
        return False

    def do_POST(self):
        global PC_SIMULATED_OFFLINE
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)
        query = urllib.parse.parse_qs(parsed.query)
        share_token = self._extract_share_token(query)

        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length > 0 else b"{}"

        if path == "/api/cloud-manifest/upload-3tz":
            t_key = self.headers.get("X-Tunnel-Key", "")
            if t_key != TUNNEL_SHARED_KEY:
                self.send_json({"error": "Invalid X-Tunnel-Key"}, status=403)
                return
            scan_id = re.sub(r"[^a-zA-Z0-9_\-]", "", (query.get("scan_id") or [""])[0].strip())
            if not scan_id or not body:
                self.send_json({"error": "scan_id and binary body required"}, status=400)
                return
            target_dirs = [os.path.join(DATA_DIR, "stream_packages")]
            if os.path.isdir("/host_docker/gathering_scans/data"):
                target_dirs.insert(0, "/host_docker/gathering_scans/data/stream_packages")
            saved_paths = []
            for td in target_dirs:
                try:
                    os.makedirs(td, exist_ok=True)
                    dst = os.path.join(td, f"{scan_id}.3tz")
                    with open(dst, "wb") as f:
                        f.write(body)
                    saved_paths.append(dst)
                except Exception:
                    pass
            _VPS_RAM_FALLBACK_CACHE.clear()
            self.send_json({"status": "ok", "scan_id": scan_id, "bytes": len(body), "saved": saved_paths})
            return

        try:
            payload = json.loads(body.decode("utf-8")) if body else {}
        except Exception as e:
            self.send_json({"error": f"Invalid JSON: {e}"}, status=400)
            return

        # 0. Google Drive .3tz Cloud Manifest Sync & Auth (handled directly on both VPS and PC)
        if path == "/api/cloud-manifest/sync":
            t_key = self.headers.get("X-Tunnel-Key", "")
            if t_key != TUNNEL_SHARED_KEY:
                self.send_json({"error": "Invalid X-Tunnel-Key"}, status=403)
                return
            if payload.get("share_links_only") and isinstance(payload.get("share_links"), list):
                m_cur = _load_cloud_manifest()
                by_t = {str(x.get("token")): x for x in payload["share_links"] if isinstance(x, dict) and x.get("token")}
                if os.name != "nt":
                    for lx in AUTH_SHARE.list_share_links():
                        if lx.get("token") and str(lx["token"]) not in by_t:
                            by_t[str(lx["token"])] = lx
                m_cur["share_links"] = sorted(
                    by_t.values(), key=lambda x: str(x.get("created_at") or ""), reverse=True
                )
                m_cur["updated_at"] = int(time.time())
                _save_cloud_manifest(m_cur)
                _VPS_RAM_FALLBACK_CACHE.clear()
                vps_sessions = AUTH_SHARE.export_recent_share_sessions(limit=400) if os.name != "nt" else []
                self.send_json(
                    {
                        "status": "ok",
                        "share_links_count": len(m_cur["share_links"]),
                        "vps_share_sessions": vps_sessions,
                    }
                )
                return
            missing_vps_pkgs = []
            if isinstance(payload.get("manifest"), dict):
                m_in = payload["manifest"]
                if os.name != "nt":
                    by_t = {str(x.get("token")): x for x in (m_in.get("share_links") or []) if isinstance(x, dict) and x.get("token")}
                    for lx in AUTH_SHARE.list_share_links():
                        if lx.get("token") and str(lx["token"]) not in by_t:
                            by_t[str(lx["token"])] = lx
                    m_in["share_links"] = sorted(
                        by_t.values(), key=lambda x: str(x.get("created_at") or ""), reverse=True
                    )
                _save_cloud_manifest(m_in)
                _VPS_RAM_FALLBACK_CACHE.clear()
                pkgs_in = m_in.get("packages") or {}
                trashed_keep = {str(x) for x in (m_in.get("trashed_scan_ids") or []) if x}
                pkg_dirs = [os.path.join(DATA_DIR, "stream_packages")]
                if os.path.isdir("/host_docker/gathering_scans/data"):
                    pkg_dirs.insert(0, "/host_docker/gathering_scans/data/stream_packages")
                for pd in pkg_dirs:
                    if os.path.isdir(pd):
                        for fn in os.listdir(pd):
                            if fn.endswith(".3tz"):
                                sid_f = fn[:-4]
                                if sid_f not in pkgs_in and sid_f not in trashed_keep:
                                    try:
                                        os.remove(os.path.join(pd, fn))
                                    except OSError:
                                        pass
                primary_pd = pkg_dirs[0]
                os.makedirs(primary_pd, exist_ok=True)
                for sid_k, p_info in pkgs_in.items():
                    expected_sz = int((p_info or {}).get("size_bytes") or 0)
                    cand_f = os.path.join(primary_pd, f"{sid_k}.3tz")
                    if not os.path.isfile(cand_f) or (expected_sz > 0 and os.path.getsize(cand_f) != expected_sz):
                        missing_vps_pkgs.append(sid_k)
            if isinstance(payload.get("auth"), dict) and payload["auth"]:
                _save_cloud_auth(payload["auth"])
            st_resp = self._build_cloud_manifest_status()
            st_resp["missing_vps_packages"] = missing_vps_pkgs
            if os.name != "nt":
                st_resp["vps_share_sessions"] = AUTH_SHARE.export_recent_share_sessions(limit=400)
            self.send_json(st_resp)
            return

        if path == "/api/cloud-manifest/auth":
            _, _, auth_perms = self._resolve_request_role(payload, query, share_token)
            if share_token or not auth_perms.get("can_manage_users"):
                self.send_json({"error": "Owner or Admin session required to modify cloud auth."}, status=403)
                return
            auth_update: Dict[str, Any] = {}
            if payload.get("access_token"):
                exp_in = float(payload.get("expires_in", 3500))
                auth_update["access_token"] = str(payload["access_token"]).strip()
                auth_update["expires_at"] = time.time() + exp_in
                auth_update["auth_mode"] = "oauth_token"
            if payload.get("oauth_refresh_token"):
                auth_update["oauth_refresh_token"] = str(payload["oauth_refresh_token"]).strip()
                if payload.get("oauth_client_secret"):
                    auth_update["oauth_client_secret"] = str(payload["oauth_client_secret"]).strip()
                auth_update["auth_mode"] = "oauth_refresh"
            if isinstance(payload.get("service_account"), dict):
                auth_update["service_account"] = payload["service_account"]
                auth_update["auth_mode"] = "service_account"
            elif isinstance(payload.get("service_account_json"), str) and payload["service_account_json"].strip():
                try:
                    sa_parsed = json.loads(payload["service_account_json"])
                    if isinstance(sa_parsed, dict) and sa_parsed.get("client_email"):
                        auth_update["service_account"] = sa_parsed
                        auth_update["auth_mode"] = "service_account"
                except Exception as e:
                    self.send_json({"error": f"Invalid Service Account JSON: {e}"}, status=400)
                    return

            if auth_update:
                _save_cloud_auth(auth_update)
                # If on Windows PC, push updated auth + manifest to VPS immediately
                if os.name == "nt":
                    try:
                        from pc_worker.gdrive_cloud_sync import sync_all_scans_to_gdrive_and_vps

                        m = sync_all_scans_to_gdrive_and_vps(DB, AUTH_SHARE, force=False)
                        _save_cloud_manifest(m)
                    except Exception as e:
                        print(f"[GatheringScans] Auth sync to VPS note: {e}")
            self.send_json(self._build_cloud_manifest_status())
            return

        if path == "/api/cloud-manifest/test-sa":
            _, _, sa_perms = self._resolve_request_role(payload, query, share_token)
            if share_token or not sa_perms.get("can_manage_users"):
                self.send_json({"error": "Owner or Admin session required to test cloud service account."}, status=403)
                return
            custom_sa = None
            if isinstance(payload.get("service_account"), dict):
                custom_sa = payload["service_account"]
            elif isinstance(payload.get("service_account_json"), str) and payload["service_account_json"].strip():
                try:
                    custom_sa = json.loads(payload["service_account_json"])
                except Exception as e:
                    self.send_json({"error": f"Invalid Service Account JSON: {e}"}, status=400)
                    return
            test_res = _test_gdrive_service_account(custom_sa=custom_sa)
            if custom_sa and os.name == "nt":
                try:
                    from pc_worker.gdrive_cloud_sync import sync_all_scans_to_gdrive_and_vps

                    m = sync_all_scans_to_gdrive_and_vps(DB, AUTH_SHARE, force=False)
                    _save_cloud_manifest(m)
                except Exception:
                    pass
            self.send_json(test_res)
            return

        if os.name != "nt" and path.startswith("/api/"):
            if path.startswith("/api/scans/") and path.endswith("/thumbnail"):
                try:
                    scan_id_vps = re.sub(r"[^a-zA-Z0-9_\-]", "", path[len("/api/scans/") : -len("/thumbnail")].strip("/"))
                    data_url_vps = str(payload.get("data_url", "")).strip()
                    if scan_id_vps and "," in data_url_vps:
                        raw_vps = base64.b64decode(data_url_vps.split(",", 1)[1])
                        os.makedirs(THUMBS_DIR, exist_ok=True)
                        with open(os.path.join(THUMBS_DIR, f"{scan_id_vps}.png"), "wb") as vf:
                            vf.write(raw_vps)
                        with open(os.path.join(THUMBS_DIR, f"{scan_id_vps.lower()}.png"), "wb") as vf2:
                            vf2.write(raw_vps)
                except Exception:
                    pass
            if path in ("/api/user/settings", "/api/user/preferences"):
                try:
                    em_vps = str(
                        payload.get("email")
                        or payload.get("user_email")
                        or self.headers.get("X-User-Email")
                        or "guest@anonymous"
                    ).strip().lower()
                    s_vps = DB.update_user_settings(em_vps, payload)
                    if em_vps and em_vps != "guest@anonymous":
                        ex_p = AUTH_SHARE.get_user_profile(em_vps)
                        if ex_p:
                            AUTH_SHARE.upsert_user_profile(
                                {**ex_p, "email": em_vps, "language": s_vps.get("language", "zh-TW")},
                                preserve_existing_role=True,
                            )
                except Exception:
                    pass
            if self._proxy_via_pc_tunnel_if_vps("POST", path, body):
                return

        try:
            actor_email, actor_role, actor_perms = self._resolve_request_role(payload, query, share_token)

            # 0b. Rebuild & Sync .3tz Packages on Google Drive + Push Manifest to VPS
            if path == "/api/cloud-manifest/rebuild":
                if share_token or not actor_perms.get("can_manage_users"):
                    self.send_json({"error": "Owner or Admin session required to rebuild cloud packages."}, status=403)
                    return
                from pc_worker.gdrive_cloud_sync import sync_all_scans_to_gdrive_and_vps

                sync_scans_with_filesystem(force=True)
                manifest = sync_all_scans_to_gdrive_and_vps(
                    DB, AUTH_SHARE, force=bool(payload.get("force", False))
                )
                _save_cloud_manifest(manifest)
                status_obj = self._build_cloud_manifest_status()
                status_obj["vps_synced"] = bool(manifest.get("vps_synced", False))
                self.send_json(status_obj)
                return

            # 1. Simulate PC Online / Offline Mode (for testing Requirement 5)
            if path == "/api/pc/simulate-offline":
                if not actor_perms.get("can_manage_users"):
                    self.send_json({"error": "Owner or Admin session required to toggle offline simulation."}, status=403)
                    return
                want_offline = bool(payload.get("offline", False))
                d_stat = set_pc_daemon_running(not want_offline, actor_email=actor_email)
                self.send_json({"status": "ok", "pc_online": d_stat["pc_online"], "daemon_running": d_stat["daemon_running"]})
                return

            if path == "/api/admin/pc-daemon":
                if not actor_perms.get("can_manage_users") and not actor_perms.get("can_run_workflows"):
                    self.send_json({"error": "Only Owner, Admin, or Editor accounts can control the PC daemon."}, status=403)
                    return
                action = str(payload.get("action") or "").strip().lower()
                if action == "sync_now":
                    sync_scans_with_filesystem(force=True)
                    st_now = get_pc_daemon_status()
                    st_now["message"] = "Triggered immediate Google Drive Inbox discovery & .3tz Cloud Sync on PC."
                    self.send_json(st_now)
                    return
                if action == "start":
                    target_running = True
                elif action == "stop":
                    target_running = False
                elif "running" in payload:
                    target_running = bool(payload.get("running"))
                else:
                    target_running = not is_pc_daemon_running()
                st_res = set_pc_daemon_running(target_running, actor_email=actor_email)
                st_res["message"] = (
                    "Workstation Daemon STARTED (Google Drive Inbox Watcher + PIX4Dmatic Queue + 3D Tiler active)."
                    if target_running
                    else "Workstation Daemon STOPPED (Background inbox polling & PIX4Dmatic queue paused; tunnel remains on standby)."
                )
                self.send_json(st_res)
                return

            # 1b. Save Automatically Captured 3D Scan Screenshot Thumbnail
            if path.startswith("/api/scans/") and path.endswith("/thumbnail"):
                scan_id = re.sub(r"[^a-zA-Z0-9_\-]", "", path[len("/api/scans/") : -len("/thumbnail")].strip("/"))
                data_url = str(payload.get("data_url", "")).strip()
                if not scan_id or "," not in data_url:
                    self.send_json({"error": "Invalid scan_id or data_url"}, status=400)
                    return
                b64_part = data_url.split(",", 1)[1]
                raw_bytes = base64.b64decode(b64_part)
                out_file = os.path.join(THUMBS_DIR, f"{scan_id}.png")
                with open(out_file, "wb") as f:
                    f.write(raw_bytes)
                try:
                    with open(os.path.join(THUMBS_DIR, f"{scan_id.lower()}.png"), "wb") as f2:
                        f2.write(raw_bytes)
                except Exception:
                    pass
                scan_row = DB.get_scan(scan_id) or {}
                pdir = scan_row.get("project_dir") or ""
                if pdir and os.path.isdir(pdir):
                    try:
                        with open(os.path.join(pdir, "thumbnail.png"), "wb") as pf:
                            pf.write(raw_bytes)
                    except Exception:
                        pass
                self.send_json(
                    {
                        "status": "ok",
                        "scan_id": scan_id,
                        "bytes": len(raw_bytes),
                        "thumbnail_url": f"/api/scans/{scan_id}/thumbnail?t={int(time.time())}",
                    }
                )
                return

            # 1b-2. Save or Regenerate True-Nadir Transparent RGBA Orthomosaic + Geographic Bounds
            if path.startswith("/api/scans/") and path.endswith("/ortho"):
                scan_id = re.sub(r"[^a-zA-Z0-9_\-]", "", path[len("/api/scans/") : -len("/ortho")].strip("/"))
                if not scan_id:
                    self.send_json({"error": "Invalid scan_id"}, status=400)
                    return
                if payload.get("regenerate") or not payload.get("data_url"):
                    meta = SURVEY.get_or_generate_true_nadir_ortho(scan_id, force=bool(payload.get("force", True)))
                    if not meta:
                        self.send_json({"error": f"Failed to generate true-nadir orthomosaic for {scan_id}"}, status=404)
                        return
                    clean_bounds = {k: v for k, v in meta.items() if k not in ("png_path", "json_path")}
                    for ck in list(_VPS_RAM_FALLBACK_CACHE.keys()):
                        if ck.startswith(f"/api/scans/{scan_id}") or ck.startswith("/api/scans?"):
                            _VPS_RAM_FALLBACK_CACHE.pop(ck, None)
                    self.send_json(
                        {
                            "status": "ok",
                            "ok": True,
                            "scan_id": scan_id,
                            "ortho_bounds": clean_bounds,
                            "ortho_url": f"/api/scans/{scan_id}/ortho?t={int(time.time())}",
                        }
                    )
                    return

                data_url = str(payload.get("data_url", "")).strip()
                if "," not in data_url:
                    self.send_json({"error": "Invalid data_url"}, status=400)
                    return
                raw_bytes = base64.b64decode(data_url.split(",", 1)[1])
                os.makedirs(THUMBS_DIR, exist_ok=True)
                out_png = os.path.join(THUMBS_DIR, f"{scan_id}_ortho.png")
                with open(out_png, "wb") as f:
                    f.write(raw_bytes)
                bounds_in = payload.get("ortho_bounds") or {}
                meta_existing = SURVEY.get_saved_ortho_meta(scan_id) or {}
                merged_bounds = {
                    "scan_id": scan_id,
                    "north_lat": float(bounds_in.get("north_lat") or meta_existing.get("north_lat") or 0.0),
                    "south_lat": float(bounds_in.get("south_lat") or meta_existing.get("south_lat") or 0.0),
                    "west_lon": float(bounds_in.get("west_lon") or meta_existing.get("west_lon") or 0.0),
                    "east_lon": float(bounds_in.get("east_lon") or meta_existing.get("east_lon") or 0.0),
                    "min_e": float(bounds_in.get("min_e") or meta_existing.get("min_e") or 0.0),
                    "max_e": float(bounds_in.get("max_e") or meta_existing.get("max_e") or 0.0),
                    "min_n": float(bounds_in.get("min_n") or meta_existing.get("min_n") or 0.0),
                    "max_n": float(bounds_in.get("max_n") or meta_existing.get("max_n") or 0.0),
                    "width": int(bounds_in.get("width") or meta_existing.get("width") or 720),
                    "height": int(bounds_in.get("height") or meta_existing.get("height") or 720),
                    "resolution_m": float(bounds_in.get("resolution_m") or meta_existing.get("resolution_m") or 0.2),
                    "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                }
                if abs(merged_bounds["north_lat"]) > 0.001 and abs(merged_bounds["west_lon"]) > 0.001:
                    out_json = os.path.join(THUMBS_DIR, f"{scan_id}_ortho.json")
                    with open(out_json, "w", encoding="utf-8") as jf:
                        json.dump(merged_bounds, jf, ensure_ascii=False, indent=2)
                for ck in list(_VPS_RAM_FALLBACK_CACHE.keys()):
                    if ck.startswith(f"/api/scans/{scan_id}") or ck.startswith("/api/scans?"):
                        _VPS_RAM_FALLBACK_CACHE.pop(ck, None)
                self.send_json(
                    {
                        "status": "ok",
                        "ok": True,
                        "scan_id": scan_id,
                        "bytes": len(raw_bytes),
                        "ortho_bounds": merged_bounds,
                        "ortho_url": f"/api/scans/{scan_id}/ortho?t={int(time.time())}",
                    }
                )
                return

            # 1c. Edit and Save Scan Display Name (persists to SQLite + scan_meta.json on local disk)
            if path == "/api/scans/rename" or (path.startswith("/api/scans/") and path.endswith("/rename")):
                if not actor_perms.get("can_edit_names"):
                    self.send_json({"error": f"Role '{actor_role}' cannot rename scans (Editor, Admin, or Owner required)."}, status=403)
                    return
                if path == "/api/scans/rename":
                    scan_id = str(payload.get("scan_id") or (query.get("scan_id") or [""])[0]).strip()
                else:
                    scan_id = re.sub(r"[^a-zA-Z0-9_\-]", "", path[len("/api/scans/") : -len("/rename")].strip("/"))
                new_name = str(payload.get("name") or (query.get("name") or [""])[0]).strip()
                if not scan_id or not new_name:
                    self.send_json({"error": "scan_id and name are required"}, status=400)
                    return
                updated = DB.rename_scan(scan_id, new_name)
                if not updated:
                    self.send_json({"error": f"Scan not found: {scan_id}"}, status=404)
                    return
                for ck in list(_VPS_RAM_FALLBACK_CACHE.keys()):
                    if ck.startswith("/api/scans") or ck.startswith("/api/projects"):
                        _VPS_RAM_FALLBACK_CACHE.pop(ck, None)
                self.send_json({"status": "ok", "scan": self._enrich_scan_urls(updated)})
                return

            # 1c-2. Move Scan to Recycle Bin (/api/scans/delete or /api/scans/bin/trash)
            if path in ("/api/scans/delete", "/api/scans/bin/trash") or (path.startswith("/api/scans/") and path.endswith("/delete")):
                if not actor_perms.get("can_edit_names"):
                    self.send_json({"error": f"Role '{actor_role}' cannot move scans to the Bin (Editor, Admin, or Owner required)."}, status=403)
                    return
                if path in ("/api/scans/delete", "/api/scans/bin/trash"):
                    scan_id = str(payload.get("scan_id") or (query.get("scan_id") or [""])[0]).strip()
                else:
                    scan_id = re.sub(r"[^a-zA-Z0-9_\-]", "", path[len("/api/scans/") : -len("/delete")].strip("/"))
                if not scan_id:
                    self.send_json({"error": "scan_id is required"}, status=400)
                    return
                actor_name = str(payload.get("actor_name") or self.headers.get("X-User-Name") or actor_email or "User").strip()
                trashed_scan = DB.trash_scan(scan_id, actor_email=actor_email, actor_name=actor_name)
                if not trashed_scan:
                    self.send_json({"error": f"Scan not found: {scan_id}"}, status=404)
                    return
                _VPS_RAM_FALLBACK_CACHE.clear()
                if os.name == "nt":
                    def _bg_sync_after_trash():
                        try:
                            from pc_worker.gdrive_cloud_sync import sync_all_scans_to_gdrive_and_vps
                            sync_all_scans_to_gdrive_and_vps(DB, AUTH_SHARE, force=False)
                        except Exception:
                            pass
                    threading.Thread(target=_bg_sync_after_trash, daemon=True).start()
                all_scans = [self._enrich_scan_urls(s) for s in DB.list_scans()]
                bin_scans = DB.list_trashed_scans()
                self.send_json(
                    {
                        "status": "ok",
                        "ok": True,
                        "deleted_scan_id": scan_id,
                        "trashed": trashed_scan,
                        "scans": all_scans,
                        "projects": self._build_projects_summary(all_scans),
                        "bin_scans": bin_scans,
                        "bin_scans_count": len(bin_scans),
                    }
                )
                return

            # 1c-3. Recycle Bin Restore (/api/scans/bin/restore — Editor, Admin, or Owner)
            if path == "/api/scans/bin/restore":
                if not (actor_perms.get("can_edit_names") or actor_perms.get("can_manage_users")):
                    self.send_json({"error": f"Role '{actor_role}' cannot restore from the Recycle Bin (Editor, Admin, or Owner required)."}, status=403)
                    return
                raw_ids = payload.get("scan_ids")
                if not isinstance(raw_ids, list):
                    single_id = str(payload.get("scan_id") or "").strip()
                    raw_ids = [single_id] if single_id else []
                scan_ids = [str(x).strip() for x in raw_ids if str(x).strip()]
                if not scan_ids:
                    self.send_json({"error": "scan_ids is required"}, status=400)
                    return
                restored = DB.restore_trashed_scans(scan_ids)
                _VPS_RAM_FALLBACK_CACHE.clear()
                if os.name == "nt":
                    def _bg_sync_after_restore():
                        try:
                            from pc_worker.gdrive_cloud_sync import sync_all_scans_to_gdrive_and_vps
                            sync_all_scans_to_gdrive_and_vps(DB, AUTH_SHARE, force=False)
                        except Exception:
                            pass
                    threading.Thread(target=_bg_sync_after_restore, daemon=True).start()
                all_scans = [self._enrich_scan_urls(s) for s in DB.list_scans()]
                bin_scans = DB.list_trashed_scans()
                self.send_json(
                    {
                        "status": "ok",
                        "ok": True,
                        "restored_count": len(restored),
                        "restored": restored,
                        "scans": all_scans,
                        "projects": self._build_projects_summary(all_scans),
                        "bin_scans": bin_scans,
                        "bin_scans_count": len(bin_scans),
                    }
                )
                return

            # 1c-4. Admin-Only Recycle Bin Permanent Delete / Clear Bin (/api/scans/bin/purge, /api/scans/bin/empty, /api/scans/bin/clear)
            if path in ("/api/scans/bin/purge", "/api/scans/bin/empty", "/api/scans/bin/clear"):
                if not actor_perms.get("can_manage_users"):
                    self.send_json({"error": f"Role '{actor_role}' cannot permanently delete or clear the Recycle Bin (Admin or Owner required)."}, status=403)
                    return
                clear_all = bool(payload.get("clear_all") or path in ("/api/scans/bin/empty", "/api/scans/bin/clear"))
                raw_ids = payload.get("scan_ids")
                if not isinstance(raw_ids, list):
                    single_id = str(payload.get("scan_id") or "").strip()
                    raw_ids = [single_id] if single_id else []
                scan_ids = [str(x).strip() for x in raw_ids if str(x).strip()]
                if not clear_all and not scan_ids:
                    self.send_json({"error": "scan_ids or clear_all=true is required"}, status=400)
                    return
                purged_ids = DB.purge_trashed_scans(scan_ids=scan_ids, clear_all=clear_all)
                # Also remove purged scans from cloud manifest
                if purged_ids:
                    purged_lower = {p.lower() for p in purged_ids}
                    try:
                        m_cur = _load_cloud_manifest()
                        if isinstance(m_cur, dict):
                            if isinstance(m_cur.get("scans"), list):
                                m_cur["scans"] = [s for s in m_cur["scans"] if str(s.get("scan_id") or "").lower() not in purged_lower]
                            if isinstance(m_cur.get("packages"), dict):
                                for pk in list(m_cur["packages"].keys()):
                                    if pk.lower() in purged_lower:
                                        m_cur["packages"].pop(pk, None)
                            _save_cloud_manifest(m_cur)
                    except Exception as me:
                        print(f"[GatheringScans] Manifest cleanup warning during bin purge: {me}")
                _VPS_RAM_FALLBACK_CACHE.clear()
                if os.name == "nt":
                    def _bg_sync_after_purge():
                        try:
                            from pc_worker.gdrive_cloud_sync import sync_all_scans_to_gdrive_and_vps
                            sync_all_scans_to_gdrive_and_vps(DB, AUTH_SHARE, force=False)
                        except Exception:
                            pass
                    threading.Thread(target=_bg_sync_after_purge, daemon=True).start()
                all_scans = [self._enrich_scan_urls(s) for s in DB.list_scans()]
                bin_scans = DB.list_trashed_scans()
                self.send_json(
                    {
                        "status": "ok",
                        "ok": True,
                        "purged_scan_ids": purged_ids,
                        "scans": all_scans,
                        "projects": self._build_projects_summary(all_scans),
                        "bin_scans": bin_scans,
                        "bin_scans_count": len(bin_scans),
                    }
                )
                return

            # 1d. Edit and Save Site / Project Group Name (persists to SQLite + scan_meta.json + site_renames.json)
            if path in ("/api/projects/rename", "/api/sites/rename"):
                if not actor_perms.get("can_edit_names"):
                    self.send_json({"error": f"Role '{actor_role}' cannot rename sites (Editor, Admin, or Owner required)."}, status=403)
                    return
                old_group = str(payload.get("old_project_group") or payload.get("project_group") or "").strip()
                new_group = str(payload.get("new_project_group") or payload.get("name") or "").strip()
                new_zh = str(payload.get("new_project_name_zh") or payload.get("project_name_zh") or new_group).strip()
                if not old_group or not new_group:
                    self.send_json({"error": "old_project_group and new_project_group are required"}, status=400)
                    return
                res_rename = DB.rename_site(old_group, new_group, new_zh)
                if isinstance(res_rename, dict) and not res_rename.get("ok", True):
                    self.send_json({"error": res_rename.get("error", "Failed to rename site")}, status=404)
                    return
                updated_list = res_rename if isinstance(res_rename, list) else res_rename.get("updated_scans", [])
                for ck in list(_VPS_RAM_FALLBACK_CACHE.keys()):
                    if ck.startswith("/api/scans") or ck.startswith("/api/projects"):
                        _VPS_RAM_FALLBACK_CACHE.pop(ck, None)
                all_scans = [self._enrich_scan_urls(s) for s in DB.list_scans()]
                self.send_json(
                    {
                        "status": "ok",
                        "ok": True,
                        "old_project_group": old_group,
                        "new_project_group": new_group,
                        "new_project_name_zh": new_zh,
                        "updated_count": len(updated_list),
                        "projects": self._build_projects_summary(all_scans),
                        "scans": all_scans,
                    }
                )
                return

            # 2. Civil Surveying: Cut/Fill & Stockpile Volume + Report Generation
            if path in ("/api/survey/volume", "/api/surveying/volume"):
                if share_token:
                    ok_s, reason_s, link_s, _ = AUTH_SHARE.validate_share_access(
                        share_token, requested_scan_id=payload.get("scan_id")
                    )
                    if not ok_s or not (link_s and link_s.get("allow_measurements", True)):
                        self.send_json({"error": "Measurements are disabled for this external share link."}, status=403)
                        return
                res = SURVEY.calculate_cut_fill_volume(payload)
                self.send_json(res)
                return

            # 3. Civil Surveying: Elevation Contours + Civil3D.dxf & A3 Survey Report .PDF Export
            if path in ("/api/survey/contours", "/api/survey/report", "/api/surveying/contours", "/api/surveying/report"):
                if share_token:
                    ok_s, reason_s, link_s, _ = AUTH_SHARE.validate_share_access(
                        share_token, requested_scan_id=payload.get("scan_id")
                    )
                    if not ok_s or not (link_s and link_s.get("allow_measurements", True)):
                        self.send_json({"error": "Measurements are disabled for this external share link."}, status=403)
                        return
                res = SURVEY.generate_civil3d_survey_report(payload)
                self.send_json(res)
                return

            # 4. Civil Surveying: Cross-Section Profile
            if path in ("/api/survey/profile", "/api/surveying/profile"):
                if share_token:
                    ok_s, reason_s, link_s, _ = AUTH_SHARE.validate_share_access(
                        share_token, requested_scan_id=payload.get("scan_id")
                    )
                    if not ok_s or not (link_s and link_s.get("allow_measurements", True)):
                        self.send_json({"error": "Measurements are disabled for this external share link."}, status=403)
                        return
                res = SURVEY.compute_cross_section_profile(payload)
                self.send_json(res)
                return

            # 5. Civil Surveying: RTK Raw Camera Photo Pin Inspector & Calibrated Camera Catalog
            if path in ("/api/survey/inspect-photos", "/api/survey/photos-at-point", "/api/surveying/inspect-photos"):
                if share_token:
                    ok_s, reason_s, link_s, _ = AUTH_SHARE.validate_share_access(
                        share_token, requested_scan_id=payload.get("scan_id")
                    )
                    if not ok_s or not (link_s and link_s.get("allow_measurements", True)):
                        self.send_json({"error": "Photo inspection is disabled for this external share link."}, status=403)
                        return
                res = SURVEY.inspect_rtk_camera_photos(payload)
                self.send_json(res)
                return

            if path in ("/api/survey/cameras", "/api/surveying/cameras"):
                sid_c = str(payload.get("scan_id") or "").strip()
                lim_c = int(payload.get("limit") or 10000)
                fmt_c = str(payload.get("format") or "json").lower()
                res = SURVEY.get_scan_cameras_response(sid_c, limit=lim_c, fmt=fmt_c)
                self.send_json(res if isinstance(res, dict) else {"status": "ok", "csv": res})
                return

            # 5b. Civil Surveying: AI + 3D Geometric Surface & Object Categorization
            if path in ("/api/survey/categorize", "/api/surveying/categorize"):
                if share_token:
                    ok_s, reason_s, link_s, _ = AUTH_SHARE.validate_share_access(
                        share_token, requested_scan_id=payload.get("scan_id")
                    )
                    if not ok_s or not (link_s and link_s.get("allow_measurements", True)):
                        self.send_json({"error": "Surface categorization is disabled for this external share link."}, status=403)
                        return
                res = SURVEY.categorize_scan_surfaces_and_objects(payload)
                self.send_json(res)
                return

            # 5c. Civil Surveying: Automated GCP / Check-Point Accuracy QA Report
            if path in ("/api/survey/gcp-qa", "/api/surveying/gcp-qa"):
                if share_token:
                    ok_s, reason_s, link_s, _ = AUTH_SHARE.validate_share_access(
                        share_token, requested_scan_id=payload.get("scan_id")
                    )
                    if not ok_s or not (link_s and link_s.get("allow_measurements", True)):
                        self.send_json({"error": "GCP QA is disabled for this external share link."}, status=403)
                        return
                res = SURVEY.compute_gcp_accuracy_qa(payload)
                self.send_json(res)
                return

            # 5d. Civil Surveying: Surface Drainage / Slope Steepness & Rainwater Runoff Analysis
            if path in ("/api/survey/drainage", "/api/surveying/drainage"):
                if share_token:
                    ok_s, reason_s, link_s, _ = AUTH_SHARE.validate_share_access(
                        share_token, requested_scan_id=payload.get("scan_id")
                    )
                    if not ok_s or not (link_s and link_s.get("allow_measurements", True)):
                        self.send_json({"error": "Drainage analysis is disabled for this external share link."}, status=403)
                        return
                res = SURVEY.compute_drainage_and_slope(payload)
                self.send_json(res)
                return

            # 5e. Persistent Measurement Sets ("Saved Survey Views" / Bookmarks)
            if path in ("/api/measurements/bookmarks", "/api/measurements/bookmarks/delete"):
                action = str(
                    payload.get("action")
                    or ("delete" if path.endswith("/delete") else "save")
                ).strip().lower()
                scan_id = str(payload.get("scan_id") or "").strip()
                bookmark_id = str(payload.get("bookmark_id") or "").strip()
                if share_token:
                    ok_s, reason_s, link_s, _ = AUTH_SHARE.validate_share_access(
                        share_token, requested_scan_id=scan_id or None
                    )
                    if not ok_s or not (link_s and link_s.get("allow_measurements", True)):
                        self.send_json({"error": "Measurements are disabled for this external share link."}, status=403)
                        return
                elif actor_role == "guest":
                    self.send_json({"error": "Read-only Guest cannot modify saved measurement bookmarks."}, status=403)
                    return
                if action == "delete":
                    if not bookmark_id:
                        self.send_json({"error": "bookmark_id is required to delete a bookmark."}, status=400)
                        return
                    deleted = DB.delete_measurement_bookmark(bookmark_id, scan_id or None)
                    _VPS_RAM_FALLBACK_CACHE.clear()
                    bms_list = DB.list_measurement_bookmarks(scan_id) if scan_id else []
                    self.send_json({"status": "ok", "deleted": deleted, "bookmark_id": bookmark_id, "bookmarks": bms_list})
                    return
                if not scan_id:
                    self.send_json({"error": "scan_id is required to save a measurement bookmark."}, status=400)
                    return
                if not payload.get("author_email") and actor_email:
                    payload["author_email"] = actor_email
                saved_bmk = DB.save_measurement_bookmark(payload)
                _VPS_RAM_FALLBACK_CACHE.clear()
                bms_list = DB.list_measurement_bookmarks(scan_id)
                self.send_json({"status": "ok", "bookmark": saved_bmk, "bookmarks": bms_list})
                return

            # 6. GC_ScanOptimizer PC Actions & Multi-Scan Alignment Merge
            def _trigger_auto_ortho_regen(target_sid: Optional[str]):
                sid_clean = str(target_sid or "").strip()
                if not sid_clean:
                    return
                try:
                    SURVEY.get_or_generate_true_nadir_ortho(sid_clean, force=True)
                except Exception:
                    pass

            if path == "/api/optimizer/optimize":
                if not actor_perms.get("can_run_workflows"):
                    self.send_json({"error": f"Role '{actor_role}' cannot run PC optimization workflows (Editor, Admin, or Owner required)."}, status=403)
                    return
                res = OPTIMIZER.run_optimize_action(payload)
                self._GZIP_FILE_CACHE.clear()
                self._OPTIMIZED_TILESET_CACHE.clear()
                _VPS_RAM_FALLBACK_CACHE.clear()
                for _inv_sid in {res.get("scan_id"), payload.get("scan_id")}:
                    if _inv_sid:
                        SURVEY._dsm_mem_cache.pop(str(_inv_sid), None)
                        _trigger_auto_ortho_regen(str(_inv_sid))
                self.send_json(res)
                return

            if path == "/api/optimizer/crop":
                if not actor_perms.get("can_run_workflows"):
                    self.send_json({"error": f"Role '{actor_role}' cannot run PC crop workflows (Editor, Admin, or Owner required)."}, status=403)
                    return
                res = OPTIMIZER.run_crop_action(payload)
                self._GZIP_FILE_CACHE.clear()
                self._OPTIMIZED_TILESET_CACHE.clear()
                _VPS_RAM_FALLBACK_CACHE.clear()
                if res.get("scan_id"):
                    SURVEY._dsm_mem_cache.pop(res["scan_id"], None)
                    _trigger_auto_ortho_regen(res["scan_id"])
                self.send_json(res)
                return

            if path == "/api/optimizer/restore":
                if not actor_perms.get("can_run_workflows"):
                    self.send_json({"error": f"Role '{actor_role}' cannot restore scan backups on the PC (Editor, Admin, or Owner required)."}, status=403)
                    return
                res = OPTIMIZER.restore_scan_backup(payload)
                self._GZIP_FILE_CACHE.clear()
                self._OPTIMIZED_TILESET_CACHE.clear()
                _VPS_RAM_FALLBACK_CACHE.clear()
                if res.get("scan_id"):
                    SURVEY._dsm_mem_cache.pop(res["scan_id"], None)
                    _trigger_auto_ortho_regen(res["scan_id"])
                self.send_json(res)
                return

            if path == "/api/optimizer/restore-region":
                if not actor_perms.get("can_run_workflows"):
                    self.send_json({"error": f"Role '{actor_role}' cannot restore scan regions on the PC (Editor, Admin, or Owner required)."}, status=403)
                    return
                res = OPTIMIZER.run_restore_region_action(payload)
                self._GZIP_FILE_CACHE.clear()
                self._OPTIMIZED_TILESET_CACHE.clear()
                _VPS_RAM_FALLBACK_CACHE.clear()
                if res.get("scan_id"):
                    SURVEY._dsm_mem_cache.pop(res["scan_id"], None)
                    _trigger_auto_ortho_regen(res["scan_id"])
                if isinstance(res.get("scan"), dict):
                    res["scan"] = self._enrich_scan_urls(res["scan"])
                all_scans = [self._enrich_scan_urls(s) for s in DB.list_scans()]
                res["scans"] = all_scans
                res["projects"] = self._build_projects_summary(all_scans)
                self.send_json(res)
                return

            if path == "/api/optimizer/generate-scan":
                if not actor_perms.get("can_run_workflows"):
                    self.send_json({"error": f"Role '{actor_role}' cannot generate edited scans on the PC (Editor, Admin, or Owner required)."}, status=403)
                    return
                payload["actor_email"] = actor_email
                payload["actor_name"] = str(payload.get("actor_name") or self.headers.get("X-User-Name") or actor_email or "雲在天").strip()
                res = OPTIMIZER.run_generate_scan_action(payload)
                self._GZIP_FILE_CACHE.clear()
                self._OPTIMIZED_TILESET_CACHE.clear()
                _VPS_RAM_FALLBACK_CACHE.clear()
                new_sid_gen = res.get("scan_id") or (res.get("scan") or {}).get("scan_id")
                if new_sid_gen:
                    _trigger_auto_ortho_regen(new_sid_gen)
                if isinstance(res.get("scan"), dict):
                    res["scan"] = self._enrich_scan_urls(res["scan"])
                all_scans = [self._enrich_scan_urls(s) for s in DB.list_scans()]
                bin_scans = DB.list_trashed_scans()
                res["scans"] = all_scans
                res["projects"] = self._build_projects_summary(all_scans)
                res["bin_scans"] = bin_scans
                res["bin_scans_count"] = len(bin_scans)
                self.send_json(res)
                return

            if path in ("/api/scans/merge", "/api/optimizer/merge"):
                if not actor_perms.get("can_run_workflows"):
                    self.send_json({"error": f"Role '{actor_role}' cannot merge scans on the PC (Editor, Admin, or Owner required)."}, status=403)
                    return
                payload["actor_email"] = actor_email
                payload["actor_name"] = str(payload.get("actor_name") or self.headers.get("X-User-Name") or actor_email or "雲在天").strip()
                res = OPTIMIZER.run_merge_scans_action(payload, surveying_engine=SURVEY)
                self._GZIP_FILE_CACHE.clear()
                self._OPTIMIZED_TILESET_CACHE.clear()
                _VPS_RAM_FALLBACK_CACHE.clear()
                merged_sid_gen = res.get("scan_id") or (res.get("scan") or {}).get("scan_id")
                if merged_sid_gen:
                    _trigger_auto_ortho_regen(merged_sid_gen)
                if isinstance(res.get("scan"), dict):
                    res["scan"] = self._enrich_scan_urls(res["scan"])
                all_scans = [self._enrich_scan_urls(s) for s in DB.list_scans()]
                bin_scans = DB.list_trashed_scans()
                res["scans"] = all_scans
                res["projects"] = self._build_projects_summary(all_scans)
                res["bin_scans"] = bin_scans
                res["bin_scans_count"] = len(bin_scans)
                self.send_json(res)
                return

            # 7. Smart Queue & PIX4Dmatic Automation Actions (including Re-run from Original Photos)
            if path in ("/api/queue/scan-inbox", "/api/queue/rescan"):
                if not actor_perms.get("can_run_workflows"):
                    self.send_json({"error": f"Role '{actor_role}' cannot trigger PC inbox rescans."}, status=403)
                    return
                self._GZIP_FILE_CACHE.clear()
                self._OPTIMIZED_TILESET_CACHE.clear()
                _VPS_RAM_FALLBACK_CACHE.clear()
                scans = seed_and_discover_scans(DB)
                for _s_item in scans:
                    _sid_i = _s_item.get("scan_id") if isinstance(_s_item, dict) else None
                    if _sid_i and not SURVEY.get_saved_ortho_meta(_sid_i, _s_item):
                        _trigger_auto_ortho_regen(_sid_i)
                self.send_json({"status": "ok", "inbox_dir": GDRIVE_INPUTS_DIR, "total_scans": len(scans)})
                return

            if path == "/api/pix4d/settings":
                if not actor_perms.get("can_manage_users"):
                    self.send_json({"error": f"Role '{actor_role}' cannot modify global PIX4Dmatic settings (Admin/Owner required)."}, status=403)
                    return
                saved = save_pix4d_settings(payload.get("settings", payload) if isinstance(payload, dict) else {})
                self.send_json({"status": "ok", "settings": saved})
                return

            if path == "/api/queue/force-next":
                if not actor_perms.get("can_run_workflows"):
                    self.send_json({"error": f"Role '{actor_role}' cannot reorder the PC processing queue."}, status=403)
                    return
                scan_id = payload.get("scan_id", "")
                updated = DB.set_force_next(scan_id, bool(payload.get("force", True)))
                _PIX4D_WAKE_EVENT.set()
                self.send_json({"status": "ok", "scan": updated})
                return

            if path in ("/api/scans/rerun", "/api/queue/enqueue", "/api/queue/reprocess"):
                if not actor_perms.get("can_run_workflows"):
                    self.send_json({"error": f"Role '{actor_role}' cannot run or re-run scans on the PC (Editor, Admin, or Owner required)."}, status=403)
                    return
                scan_id = str(payload.get("scan_id", "")).strip()
                scan = DB.get_scan(scan_id)
                if not scan:
                    self.send_json({"error": f"Scan not found: {scan_id}"}, status=404)
                    return
                force = bool(payload.get("force_next", True if path == "/api/scans/rerun" else False))
                force_from_photos = bool(payload.get("force_from_photos", True if path == "/api/scans/rerun" else False))
                raw_custom = payload.get("settings") if isinstance(payload.get("settings"), dict) else {}
                p4d_cfg = load_pix4d_settings_from_dict({**load_pix4d_settings(), **raw_custom})
                for k_extra in ("mesh_quality", "vertex_density"):
                    if k_extra in raw_custom:
                        p4d_cfg[k_extra] = str(raw_custom[k_extra])
                tex_sz = int(p4d_cfg.get("texture_size", PIX4DMATIC_TEXTURE_SIZE))
                mesh_pipe = str(p4d_cfg.get("mesh_pipeline", "FixedSize"))
                mesh_qual = str(p4d_cfg.get("mesh_quality", "Standard"))

                proj_dir = scan.get("project_dir") or os.path.join(LOCAL_SCANS_ROOT, scan_id)
                os.makedirs(proj_dir, exist_ok=True)
                inputs_dir = os.path.join(proj_dir, "inputs")
                src_zip = str(scan.get("source_zip_path") or "")
                photo_files = []
                if os.path.isdir(inputs_dir):
                    for r_root, _, r_files in os.walk(inputs_dir):
                        for fn in r_files:
                            if fn.lower().endswith((".jpg", ".jpeg", ".png")):
                                photo_files.append(os.path.join(r_root, fn))
                has_photos = len(photo_files) > 0 or (bool(src_zip) and os.path.exists(src_zip))

                rerun_cfg_path = os.path.join(proj_dir, "rerun_settings.json")
                with open(rerun_cfg_path, "w", encoding="utf-8") as rf:
                    json.dump(
                        {
                            "scan_id": scan_id,
                            "force_from_photos": force_from_photos,
                            "settings": p4d_cfg,
                            "requested_by": actor_email,
                            "requested_at": time.time(),
                        },
                        rf,
                        ensure_ascii=False,
                        indent=2,
                    )

                label_mode = "Re-run from Original Photos" if force_from_photos else "Queued for PIX4Dmatic"
                DB.update_job_progress(
                    scan_id,
                    "queued",
                    0.0,
                    f"{label_mode} ({mesh_pipe}/{mesh_qual}, {tex_sz}px, TWD97)",
                )
                run_immediately = bool(payload.get("run_immediately", False))
                if force or run_immediately:
                    DB.set_force_next(scan_id, True)

                in_path = inputs_dir if os.path.isdir(inputs_dir) else (src_zip or proj_dir)
                gst_script = generate_pix4dmatic_gst_script(
                    project_p4m_path=f"C:/GatheringScans/{scan_id}/{scan_id}.p4m",
                    input_zip_or_folder=in_path,
                    export_dir=f"C:/GatheringScans/{scan_id}/exports",
                    texture_size=tex_sz,
                    pipeline_settings=p4d_cfg,
                )

                # Wake both inbox watcher and pix4d_worker_loop immediately so the single
                # authoritative queue worker picks up this job with proper arguments & progress tracking.
                _DAEMON_WAKE_EVENT.set()
                _PIX4D_WAKE_EVENT.set()

                self.send_json(
                    {
                        "status": "ok",
                        "scan": DB.get_scan(scan_id),
                        "force_from_photos": force_from_photos,
                        "has_original_photos": has_photos,
                        "original_photos_count": len(photo_files) or int(scan.get("total_photos") or 0),
                        "input_source": in_path,
                        "settings": p4d_cfg,
                        "gst_script": gst_script,
                    }
                )
                return

            if path == "/api/queue/preview-gst":
                scan_id = (payload.get("scan_id") or "").strip()
                if not scan_id:
                    self.send_json({"error": "Missing required parameter: scan_id"}, status=400)
                    return
                scan = DB.get_scan(scan_id)
                if not scan:
                    self.send_json({"error": f"Scan not found: {scan_id}"}, status=404)
                    return
                proj_dir = scan.get("project_dir") or os.path.join(LOCAL_SCANS_ROOT, scan_id)
                inputs_dir = os.path.join(proj_dir, "inputs")
                in_path = inputs_dir if os.path.isdir(inputs_dir) else (scan.get("source_zip_path") or proj_dir)
                raw_custom = payload.get("settings") if isinstance(payload.get("settings"), dict) else {}
                custom_cfg = {**load_pix4d_settings(), **raw_custom}
                gst_script = generate_pix4dmatic_gst_script(
                    project_p4m_path=f"C:/GatheringScans/{scan_id}/{scan_id}.p4m",
                    input_zip_or_folder=in_path,
                    export_dir=f"C:/GatheringScans/{scan_id}/exports",
                    texture_size=int(custom_cfg.get("texture_size", PIX4DMATIC_TEXTURE_SIZE)),
                    pipeline_settings=custom_cfg,
                )
                self.send_json(
                    {
                        "status": "ok",
                        "scan_id": scan_id,
                        "crs": TWD97_TWVD2001_LABEL,
                        "texture_size": int(custom_cfg.get("texture_size", PIX4DMATIC_TEXTURE_SIZE)),
                        "settings": custom_cfg,
                        "gst_script": gst_script,
                    }
                )
                return

            # 8. Comments API (Upload Photo to Google Drive, Create, Edit/Update, Delete)
            if path in ("/api/comments/upload-photo", "/api/comments/upload_photo"):
                from pc_worker.gdrive_cloud_sync import save_and_sync_comment_photo_to_gdrive

                scan_id = str(payload.get("scan_id") or "").strip()
                comment_id = str(payload.get("comment_id") or "").strip()
                existing_cmt = DB.get_comment(comment_id) if comment_id else None
                if not scan_id and existing_cmt:
                    scan_id = str(existing_cmt.get("scan_id") or "").strip()
                if not scan_id:
                    scan_id = "general"

                if share_token:
                    ok_s, reason_s, link_s, _ = AUTH_SHARE.validate_share_access(
                        share_token, requested_scan_id=scan_id if scan_id != "general" else None
                    )
                    if not ok_s and os.name != "nt":
                        ok_s, reason_s, link_s, _ = self._validate_cloud_share_token(
                            share_token, requested_scan_id=scan_id if scan_id != "general" else None
                        )
                    if not ok_s:
                        self.send_json({"error": reason_s}, status=403)
                        return
                    if not (link_s and link_s.get("allow_comments", False)):
                        self.send_json({"error": "Comments are disabled for this external share link."}, status=403)
                        return
                elif actor_role == "guest":
                    self.send_json(
                        {"error": "Read-only Guest Mode cannot upload comment photos. Sign in with Google to comment."},
                        status=403,
                    )
                    return

                if comment_id and existing_cmt and not self._can_actor_modify_comment(existing_cmt, actor_email, actor_role, payload):
                    self.send_json(
                        {"error": "Only the comment author or an admin can edit or modify photos on this comment."},
                        status=403,
                    )
                    return

                raw_items = payload.get("photos") if isinstance(payload.get("photos"), list) else [payload]
                uploaded_photos = []
                for item in raw_items:
                    if not isinstance(item, dict):
                        continue
                    b64_str = str(
                        item.get("data_base64")
                        or item.get("data_url")
                        or item.get("base64")
                        or item.get("content_base64")
                        or ""
                    ).strip()
                    if not b64_str:
                        continue
                    inferred_ct = str(item.get("content_type") or item.get("mime_type") or "").strip()
                    if b64_str.startswith("data:"):
                        header_part, _, b64_payload = b64_str.partition(",")
                        if not inferred_ct and ";" in header_part:
                            inferred_ct = header_part[5:].split(";", 1)[0].strip()
                        b64_str = b64_payload.strip()
                    try:
                        raw_bytes = base64.b64decode(b64_str)
                    except Exception as de:
                        self.send_json({"error": f"Invalid base64 image data: {de}"}, status=400)
                        return
                    if not raw_bytes:
                        continue
                    if len(raw_bytes) > 25 * 1024 * 1024:
                        self.send_json({"error": "Image exceeds 25 MB limit."}, status=400)
                        return
                    fname = str(item.get("filename") or item.get("name") or payload.get("filename") or "comment_photo.jpg").strip()
                    photo_meta = save_and_sync_comment_photo_to_gdrive(
                        scan_id=scan_id,
                        filename=fname,
                        raw_bytes=raw_bytes,
                        content_type=inferred_ct or "image/jpeg",
                        camera_meta=item,
                    )
                    uploaded_photos.append(photo_meta)

                if not uploaded_photos:
                    self.send_json({"error": "No valid image payload provided (expected data_base64 or data_url)."}, status=400)
                    return

                updated_cmt = None
                if comment_id and existing_cmt:
                    orig_author = str(existing_cmt.get("author_name") or "").strip()
                    updated_cmt = DB.update_comment(
                        comment_id,
                        None,
                        author_name=orig_author or payload.get("author_name"),
                        append_photos=uploaded_photos,
                    )
                _VPS_RAM_FALLBACK_CACHE.clear()
                cmts_list = DB.list_comments(scan_id) if scan_id and scan_id != "general" else []
                self.send_json(
                    {
                        "status": "ok",
                        "ok": True,
                        "scan_id": scan_id,
                        "comment_id": comment_id or None,
                        "photo": uploaded_photos[0],
                        "photos": uploaded_photos,
                        "comment": updated_cmt,
                        "comments": cmts_list,
                    }
                )
                return

            if path in ("/api/comments", "/api/comments/update", "/api/comments/delete"):
                action = str(
                    payload.get("action")
                    or ("update" if path.endswith("/update") else "delete" if path.endswith("/delete") else "create")
                ).strip().lower()
                scan_id = str(payload.get("scan_id") or "").strip()
                comment_id = str(payload.get("comment_id") or "").strip()
                existing_cmt = DB.get_comment(comment_id) if comment_id else None
                if not scan_id and existing_cmt:
                    scan_id = str(existing_cmt.get("scan_id") or "").strip()

                if share_token:
                    ok_s, reason_s, link_s, _ = AUTH_SHARE.validate_share_access(
                        share_token, requested_scan_id=scan_id or None
                    )
                    if not ok_s and os.name != "nt":
                        ok_s, reason_s, link_s, _ = self._validate_cloud_share_token(
                            share_token, requested_scan_id=scan_id or None
                        )
                    if not ok_s:
                        self.send_json({"error": reason_s}, status=403)
                        return
                    if not (link_s and link_s.get("allow_comments", False)):
                        self.send_json({"error": "Comments are disabled for this external share link."}, status=403)
                        return
                elif actor_role == "guest":
                    self.send_json({"error": "Read-only Guest Mode cannot post or edit comments. Sign in with Google to comment."}, status=403)
                    return

                if action == "create_folder":
                    if not scan_id:
                        self.send_json({"error": "scan_id is required to create a comment folder."}, status=400)
                        return
                    fname_new = str(payload.get("folder") or payload.get("folder_name") or "").strip()
                    folders_out = DB.create_comment_folder(scan_id, fname_new)
                    _VPS_RAM_FALLBACK_CACHE.clear()
                    cmts_list = DB.list_comments(scan_id)
                    self.send_json(
                        {
                            "status": "ok",
                            "scan_id": scan_id,
                            "folder": fname_new,
                            "comment_folders": folders_out,
                            "comments": cmts_list,
                        }
                    )
                    return

                if action == "rename_folder":
                    if not scan_id:
                        self.send_json({"error": "scan_id is required to rename a comment folder."}, status=400)
                        return
                    old_f = str(payload.get("old_folder") or payload.get("old_name") or "").strip()
                    new_f = str(payload.get("new_folder") or payload.get("new_name") or payload.get("folder") or "").strip()
                    folders_out = DB.rename_comment_folder(scan_id, old_f, new_f)
                    _VPS_RAM_FALLBACK_CACHE.clear()
                    cmts_list = DB.list_comments(scan_id)
                    self.send_json(
                        {
                            "status": "ok",
                            "scan_id": scan_id,
                            "old_folder": old_f,
                            "folder": new_f,
                            "comment_folders": folders_out,
                            "comments": cmts_list,
                        }
                    )
                    return

                if action == "delete_folder":
                    if not scan_id:
                        self.send_json({"error": "scan_id is required to delete a comment folder."}, status=400)
                        return
                    del_f = str(payload.get("folder") or payload.get("folder_name") or "").strip()
                    folders_out = DB.delete_comment_folder(scan_id, del_f)
                    _VPS_RAM_FALLBACK_CACHE.clear()
                    cmts_list = DB.list_comments(scan_id)
                    self.send_json(
                        {
                            "status": "ok",
                            "scan_id": scan_id,
                            "deleted_folder": del_f,
                            "comment_folders": folders_out,
                            "comments": cmts_list,
                        }
                    )
                    return

                if action == "move_photo":
                    src_cid = str(payload.get("source_comment_id") or "").strip()
                    tgt_cid = str(payload.get("target_comment_id") or "").strip()
                    tgt_folder = payload.get("target_folder")
                    src_cmt = DB.get_comment(src_cid) if src_cid else None
                    if not src_cmt:
                        self.send_json({"error": "Source comment not found."}, status=404)
                        return
                    if not scan_id:
                        scan_id = str(src_cmt.get("scan_id") or "").strip()
                    if not self._can_actor_modify_comment(src_cmt, actor_email, actor_role, payload):
                        self.send_json(
                            {"error": "Only the comment author or an admin can move photos from this comment."},
                            status=403,
                        )
                        return
                    raw_photo = payload.get("photo") if isinstance(payload.get("photo"), dict) else {}
                    photo_url = str(payload.get("photo_url") or raw_photo.get("url") or "").strip()
                    src_photos = list(src_cmt.get("photos") or [])
                    matched_photo = next((p for p in src_photos if str(p.get("url") or "") == photo_url), None) or raw_photo
                    if not matched_photo or not matched_photo.get("url"):
                        self.send_json({"error": "Photo to move not found."}, status=400)
                        return
                    remaining_src = [p for p in src_photos if str(p.get("url") or "") != str(matched_photo.get("url"))]
                    DB.update_comment(
                        src_cid,
                        None,
                        author_name=src_cmt.get("author_name"),
                        photos=remaining_src,
                    )
                    target_updated = None
                    if tgt_cid and tgt_cid != src_cid:
                        tgt_cmt = DB.get_comment(tgt_cid)
                        if tgt_cmt:
                            target_updated = DB.update_comment(
                                tgt_cid,
                                None,
                                author_name=tgt_cmt.get("author_name"),
                                append_photos=[matched_photo],
                            )
                    elif tgt_folder is not None:
                        clean_tf = str(tgt_folder or "").strip()
                        target_updated = DB.add_comment(
                            {
                                "scan_id": scan_id,
                                "author_email": src_cmt.get("author_email") or actor_email or "glibivanov@gatheren.com.tw",
                                "author_name": src_cmt.get("author_name") or payload.get("author_name") or "雲在天",
                                "text": str(matched_photo.get("filename") or src_cmt.get("text") or "Photo Note"),
                                "pos_x": src_cmt.get("pos_x", 0.0),
                                "pos_y": src_cmt.get("pos_y", 0.0),
                                "pos_z": src_cmt.get("pos_z", 0.0),
                                "twd97_e": src_cmt.get("twd97_e", 0.0),
                                "twd97_n": src_cmt.get("twd97_n", 0.0),
                                "twd97_h": src_cmt.get("twd97_h", 0.0),
                                "photos": [matched_photo],
                                "folder": clean_tf,
                            }
                        )
                    _VPS_RAM_FALLBACK_CACHE.clear()
                    cmts_list = DB.list_comments(scan_id) if scan_id else []
                    folders_out = DB.list_comment_folders(scan_id) if scan_id else []
                    self.send_json(
                        {
                            "status": "ok",
                            "scan_id": scan_id,
                            "comment": target_updated,
                            "comment_folders": folders_out,
                            "comments": cmts_list,
                        }
                    )
                    return

                if action in ("update", "attach_photos"):
                    if not comment_id:
                        self.send_json({"error": "comment_id is required to update a comment."}, status=400)
                        return
                    if not existing_cmt:
                        self.send_json({"error": "Comment not found."}, status=404)
                        return
                    if not self._can_actor_modify_comment(existing_cmt, actor_email, actor_role, payload):
                        self.send_json(
                            {"error": "Only the comment author or an admin can edit, move, or modify photos on this comment."},
                            status=403,
                        )
                        return
                    new_text = str(payload.get("text") or "").strip() if payload.get("text") is not None else None
                    has_photo_update = ("photos" in payload) or ("append_photos" in payload)
                    has_folder_update = "folder" in payload
                    has_pos_update = any(k in payload for k in ("pos_x", "pos_y", "pos_z", "twd97_e", "twd97_n", "twd97_h"))
                    if not new_text and not has_photo_update and not has_folder_update and not has_pos_update:
                        self.send_json({"error": "Comment text, photos, folder, or position required."}, status=400)
                        return
                    orig_author = str(existing_cmt.get("author_name") or "").strip()
                    updated_cmt = DB.update_comment(
                        comment_id,
                        new_text,
                        author_name=orig_author or payload.get("author_name"),
                        photos=payload.get("photos"),
                        append_photos=payload.get("append_photos"),
                        folder=payload.get("folder") if has_folder_update else None,
                        pos_x=payload.get("pos_x"),
                        pos_y=payload.get("pos_y"),
                        pos_z=payload.get("pos_z"),
                        twd97_e=payload.get("twd97_e"),
                        twd97_n=payload.get("twd97_n"),
                        twd97_h=payload.get("twd97_h"),
                    )
                    _VPS_RAM_FALLBACK_CACHE.clear()
                    cmts_list = DB.list_comments(scan_id) if scan_id else []
                    folders_out = DB.list_comment_folders(scan_id) if scan_id else []
                    self.send_json(
                        {
                            "status": "ok",
                            "comment": updated_cmt,
                            "comment_folders": folders_out,
                            "comments": cmts_list,
                        }
                    )
                    return

                if action == "delete":
                    if not comment_id:
                        self.send_json({"error": "comment_id is required to delete a comment."}, status=400)
                        return
                    if existing_cmt and not self._can_actor_modify_comment(existing_cmt, actor_email, actor_role, payload):
                        self.send_json(
                            {"error": "Only the comment author or an admin can edit or modify photos on this comment."},
                            status=403,
                        )
                        return
                    deleted = DB.delete_comment(comment_id)
                    _VPS_RAM_FALLBACK_CACHE.clear()
                    cmts_list = DB.list_comments(scan_id) if scan_id else []
                    folders_out = DB.list_comment_folders(scan_id) if scan_id else []
                    self.send_json(
                        {
                            "status": "ok",
                            "deleted": deleted,
                            "comment_id": comment_id,
                            "comment_folders": folders_out,
                            "comments": cmts_list,
                        }
                    )
                    return

                cmt = DB.add_comment(payload)
                _VPS_RAM_FALLBACK_CACHE.clear()
                cmts_list = DB.list_comments(scan_id) if scan_id else [cmt]
                folders_out = DB.list_comment_folders(scan_id) if scan_id else []
                self.send_json(
                    {
                        "status": "ok",
                        "comment": cmt,
                        "comment_folders": folders_out,
                        "comments": cmts_list,
                    }
                )
                return

            # 9a. Share Link Visitor Session & Tool Telemetry
            if path == "/api/share/telemetry":
                tok_tel = str(payload.get("token") or payload.get("share_token") or share_token or "").strip()
                if not tok_tel:
                    self.send_json({"error": "Missing share token"}, status=400)
                    return
                ok_t, reason_t, link_t, _ = AUTH_SHARE.validate_share_access(tok_tel, increment_view=False)
                if not ok_t and os.name != "nt":
                    ok_c, reason_c, link_c, _ = self._validate_cloud_share_token(tok_tel)
                    if ok_c and link_c:
                        ok_t, reason_t, link_t = ok_c, reason_c, link_c
                        try:
                            if not AUTH_SHARE.get_share_link(tok_tel):
                                AUTH_SHARE.create_share_link(
                                    {
                                        "token": tok_tel,
                                        "label": link_c.get("label") or f"External View — {link_c.get('target_id', '')}",
                                        "scope_type": link_c.get("scope_type") or "scan",
                                        "target_id": link_c.get("target_id") or "",
                                        "created_by_email": link_c.get("created_by_email") or "system@gatheren.com.tw",
                                        "created_by_name": link_c.get("created_by_name") or "System",
                                        "expires_at": link_c.get("expires_at") or "",
                                        "allow_download": bool(link_c.get("allow_download", False)),
                                        "allow_measurements": bool(link_c.get("allow_measurements", True)),
                                        "allow_comments": bool(link_c.get("allow_comments", True)),
                                    }
                                )
                        except Exception:
                            pass
                if not ok_t:
                    self.send_json({"error": reason_t or "Invalid or revoked share link"}, status=403)
                    return
                payload["token"] = tok_tel
                req_meta = {
                    "share_token": tok_tel,
                    "ip_address": self._extract_client_ip(),
                    "user_agent": self.headers.get("User-Agent", ""),
                    "referrer": self.headers.get("Referer", ""),
                    "accept_language": self.headers.get("Accept-Language", ""),
                }
                tel_res = AUTH_SHARE.record_or_update_share_session(payload, request_meta=req_meta)
                self.send_json(tel_res)
                return

            # 9. Scoped External Share Link Creation & Revocation
            if path in ("/api/share/create", "/api/share/revoke", "/api/share/restore"):
                def _persist_share_links_cloud(updated_link: Optional[Dict[str, Any]] = None):
                    if os.name == "nt":
                        def _bg_sync_shares():
                            try:
                                from pc_worker.gdrive_cloud_sync import sync_share_links_to_vps_manifest
                                sync_share_links_to_vps_manifest(AUTH_SHARE)
                            except Exception:
                                pass
                        threading.Thread(target=_bg_sync_shares, daemon=True).start()
                    else:
                        try:
                            m_cur = _load_cloud_manifest()
                            by_t = {str(x.get("token")): x for x in (m_cur.get("share_links") or []) if x.get("token")}
                            for lx in AUTH_SHARE.list_share_links():
                                if lx.get("token"):
                                    by_t[str(lx["token"])] = lx
                            if updated_link and updated_link.get("token"):
                                by_t[str(updated_link["token"])] = updated_link
                            m_cur["share_links"] = sorted(
                                by_t.values(), key=lambda x: str(x.get("created_at") or ""), reverse=True
                            )
                            _save_cloud_manifest(m_cur)
                            _VPS_RAM_FALLBACK_CACHE.clear()
                        except Exception:
                            pass

                if path == "/api/share/create":
                    wants_dl = bool(payload.get("allow_download", False))
                    can_create = bool(actor_perms.get("can_manage_shares")) or (
                        bool(actor_perms.get("can_share")) and not wants_dl
                    )
                    if not can_create:
                        self.send_json({"error": f"Role '{actor_role}' cannot create this external share link."}, status=403)
                        return
                    if actor_email and not payload.get("created_by_email") and not payload.get("actor_email"):
                        payload["actor_email"] = actor_email
                    link = AUTH_SHARE.create_share_link(payload)
                    _persist_share_links_cloud(link)
                    self.send_json({"status": "ok", "link": link})
                    return

                if path == "/api/share/revoke":
                    if not actor_perms.get("can_manage_shares"):
                        self.send_json({"error": f"Role '{actor_role}' cannot revoke external share links."}, status=403)
                        return
                    token = payload.get("token", "")
                    link = AUTH_SHARE.revoke_share_link(token)
                    if not link and os.name != "nt" and token:
                        m_cur = _load_cloud_manifest()
                        for item in (m_cur.get("share_links") or []):
                            if item.get("token") == token:
                                item["revoked"] = True
                                link = item
                                break
                        if link:
                            _save_cloud_manifest(m_cur)
                            _VPS_RAM_FALLBACK_CACHE.clear()
                    if not link:
                        self.send_json({"error": "Share token not found"}, status=404)
                        return
                    _persist_share_links_cloud(link)
                    self.send_json({"status": "ok", "link": link})
                    return

                if path == "/api/share/restore":
                    if not actor_perms.get("can_manage_shares"):
                        self.send_json({"error": f"Role '{actor_role}' cannot restore external share links."}, status=403)
                        return
                    token = payload.get("token", "")
                    link = AUTH_SHARE.restore_share_link(token)
                    if not link and os.name != "nt" and token:
                        m_cur = _load_cloud_manifest()
                        for item in (m_cur.get("share_links") or []):
                            if item.get("token") == token:
                                item["revoked"] = False
                                item["revoked_at"] = ""
                                link = item
                                break
                        if link:
                            _save_cloud_manifest(m_cur)
                            _VPS_RAM_FALLBACK_CACHE.clear()
                    _persist_share_links_cloud(link)
                    self.send_json({"status": "ok", "link": link})
                    return

            # 10. Google Chat Notification Dispatch, Interactive App Endpoint & Webhook Config
            if path == "/api/gchat/webhook":
                # Interactive Google Chat HTTP Endpoint (handles ADDED_TO_SPACE, MESSAGE, CARD_CLICKED)
                evt_type = str(payload.get("type") or "").upper()
                user_obj = payload.get("user") if isinstance(payload.get("user"), dict) else {}
                u_email = str(user_obj.get("email") or "").strip().lower()
                u_name_res = str(user_obj.get("name") or "").strip()  # e.g. "users/107639887113416939995"
                if u_email and u_name_res.startswith("users/"):
                    uid_num = u_name_res.split("/", 1)[1].strip()
                    if uid_num:
                        GCHAT.user_gchat_ids[u_email] = uid_num
                        GCHAT._save_config()
                if evt_type == "ADDED_TO_SPACE":
                    self.send_json(
                        {
                            "text": (
                                "✅ *GatheringScans 3D Survey Bot* is connected! "
                                "When your uploaded PIX4Dcatch scan finishes processing in PIX4Dmatic, "
                                "I will send your private completion card and 3D Studio link directly."
                            )
                        }
                    )
                    return
                if evt_type == "MESSAGE":
                    self.send_json(
                        {
                            "text": (
                                f"👋 Hi {user_obj.get('displayName') or u_email or 'there'}! "
                                f"Your Google Chat ID (`{u_name_res or 'linked'}`) is registered with GatheringScans (`https://scans.gatheren.cloud`)."
                            )
                        }
                    )
                    return
                self.send_json({"text": "GatheringScans Bot received event."})
                return

            if path == "/api/gchat/test-app":
                if not actor_perms.get("can_manage_users") and not actor_perms.get("can_run_workflows"):
                    self.send_json({"error": "Authenticated Editor, Admin, or Owner session required."}, status=403)
                    return
                test_em = str(payload.get("email") or actor_email or "").strip()
                self.send_json(GCHAT.test_chat_app_connection(test_email=test_em))
                return

            if path == "/api/gchat/config":
                if not actor_perms.get("can_manage_users"):
                    self.send_json({"error": "Owner or Admin session required to configure webhooks."}, status=403)
                    return
                webhook = payload.get("webhook_url", "")
                up_email = payload.get("uploader_email", "")
                saved = GCHAT.set_webhook_url(webhook, uploader_email=up_email)
                self.send_json(
                    {
                        "status": "ok",
                        "webhook_url": saved,
                        "user_webhooks": GCHAT.user_webhooks,
                        "user_gchat_ids": GCHAT.user_gchat_ids,
                    }
                )
                return

            if path == "/api/gchat/notify":
                if not actor_perms.get("can_run_workflows"):
                    self.send_json({"error": "Authenticated Editor, Admin, or Owner session required."}, status=403)
                    return
                scan_id = payload.get("scan_id", "")
                webhook = payload.get("webhook_url", "")
                if webhook and actor_perms.get("can_manage_users"):
                    GCHAT.set_webhook_url(webhook)
                res = GCHAT.notify_scan_ready(scan_id, custom_webhook_url=webhook)
                self.send_json(res)
                return

            # 11. User-Specific Offline Cache Settings, Language Preferences & User Profiles Update / Admin Control Panel
            if path in ("/api/user/settings", "/api/user/preferences"):
                email = str(
                    payload.get("email")
                    or payload.get("user_email")
                    or self.headers.get("X-User-Email")
                    or actor_email
                    or "guest@anonymous"
                ).strip().lower()
                settings = DB.update_user_settings(email, payload)
                lang_saved = settings.get("language", "zh-TW")
                prof = None
                if email and email != "guest@anonymous":
                    mirror_list = (
                        ("glibivanov@gatheren.com.tw", "gleb.ivanov1999@gmail.com")
                        if email in ("glibivanov@gatheren.com.tw", "gleb.ivanov1999@gmail.com")
                        else (email,)
                    )
                    for m_em in mirror_list:
                        existing_p = AUTH_SHARE.get_user_profile(m_em)
                        if existing_p:
                            up_p = AUTH_SHARE.upsert_user_profile(
                                {**existing_p, "email": m_em, "language": lang_saved},
                                preserve_existing_role=True,
                            )
                            if m_em == email:
                                prof = up_p
                _VPS_RAM_FALLBACK_CACHE.clear()
                self.send_json(
                    {
                        "status": "ok",
                        "ok": True,
                        "email": email,
                        "language": lang_saved,
                        "settings": settings,
                        "preferences": {
                            "email": email,
                            "language": lang_saved,
                            "theme_preference": settings.get("theme_preference", "auto"),
                        },
                        "profile": prof,
                    }
                )
                return

            if path == "/api/auth/roster-login":
                email = str(
                    payload.get("email")
                    or payload.get("user_email")
                    or self.headers.get("X-User-Email")
                    or actor_email
                    or ""
                ).strip().lower()
                if not email:
                    self.send_json({"error": "email is required"}, status=400)
                    return
                prof = AUTH_SHARE.get_user_profile(email)
                if not prof:
                    prof = AUTH_SHARE.upsert_user_profile(
                        {
                            "email": email,
                            "name": str(payload.get("name") or email.split("@")[0]),
                            "language": payload.get("language") or "zh-TW",
                        },
                        preserve_existing_role=True,
                    )
                u_settings = DB.get_user_settings(email)
                lang_val = str(u_settings.get("language") or prof.get("language") or "zh-TW")
                if lang_val not in ("zh-TW", "en"):
                    lang_val = "zh-TW"
                prof["language"] = lang_val
                is_admin_caller = bool(actor_perms.get("can_manage_users"))
                safe_self = self._sanitize_single_profile(prof, is_admin=is_admin_caller)
                self.send_json(
                    {
                        "status": "ok",
                        "authenticated": True,
                        "email": email,
                        "language": lang_val,
                        "user": safe_self,
                        "profile": safe_self,
                        "settings": u_settings,
                        "profiles": self._filter_profiles_for_caller(
                            AUTH_SHARE.list_user_profiles(), email, is_admin_caller
                        ),
                    }
                )
                return

            if path == "/api/admin/users/save":
                if not actor_perms.get("can_manage_users"):
                    self.send_json({"error": "Owner or Admin session required to manage user roles."}, status=403)
                    return
                res_admin = AUTH_SHARE.admin_save_user(
                    actor_email=actor_email,
                    target_email=str(payload.get("email") or payload.get("target_email") or ""),
                    name=str(payload.get("name") or ""),
                    zh_name=str(payload.get("zh_name") or ""),
                    role=str(payload.get("role") or "viewer"),
                    gchat_user_id=str(payload.get("gchat_user_id") or ""),
                )
                if not res_admin.get("ok"):
                    self.send_json({"error": res_admin.get("error", "Permission denied")}, status=403)
                    return
                self.send_json({"status": "ok", **res_admin})
                return

            if path == "/api/admin/users/delete":
                if not actor_perms.get("can_manage_users"):
                    self.send_json({"error": "Owner or Admin session required to remove users."}, status=403)
                    return
                res_del = AUTH_SHARE.admin_delete_user(
                    actor_email=actor_email,
                    target_email=str(payload.get("email") or payload.get("target_email") or ""),
                )
                if not res_del.get("ok"):
                    self.send_json({"error": res_del.get("error", "Permission denied")}, status=403)
                    return
                self.send_json({"status": "ok", **res_del})
                return

            if path == "/api/user-profiles":
                if actor_role == "guest":
                    self.send_json({"error": "Authenticated Google session required to update user profiles."}, status=403)
                    return
                target_em = str(payload.get("email") or "").strip().lower()
                is_admin_caller = bool(actor_perms.get("can_manage_users"))
                if not is_admin_caller and target_em != actor_email:
                    self.send_json({"error": "Only Owner or Admin accounts can modify other user profiles."}, status=403)
                    return
                safe_payload = dict(payload)
                if not is_admin_caller:
                    safe_payload.pop("role", None)
                    safe_payload.pop("isAdmin", None)
                    safe_payload.pop("isOwner", None)
                    safe_payload.pop("googleSub", None)
                    safe_payload.pop("google_sub", None)
                    safe_payload.pop("gchat_user_id", None)
                saved = AUTH_SHARE.upsert_user_profile(safe_payload, preserve_existing_role=not is_admin_caller)
                if target_em and safe_payload.get("language") in ("zh-TW", "en"):
                    DB.update_user_settings(target_em, {"language": safe_payload["language"]})
                safe_saved = self._sanitize_single_profile(saved, is_admin=is_admin_caller)
                self.send_json(
                    {
                        "status": "ok",
                        "profile": safe_saved,
                        "profiles": self._filter_profiles_for_caller(
                            AUTH_SHARE.list_user_profiles(), actor_email, is_admin_caller
                        ),
                    }
                )
                return

            # 12. Google OAuth Login Verification (Same Client ID as GatheringCloud)
            if path == "/api/auth/google":
                cred = payload.get("credential", "")
                fallback_profile = payload.get("profile") if isinstance(payload.get("profile"), dict) else None
                user = AUTH_SHARE.verify_google_oauth_credential(cred, fallback_profile=fallback_profile)
                u_em = str(user.get("email") or "").strip().lower()
                if u_em:
                    u_set = DB.get_user_settings(u_em)
                    u_lang = str(u_set.get("language") or user.get("language") or "zh-TW")
                    if u_lang not in ("zh-TW", "en"):
                        u_lang = "zh-TW"
                    user["language"] = u_lang
                user_is_admin = bool((user.get("permissions") or {}).get("can_manage_users") or user.get("role") in ("owner", "admin"))
                safe_user = self._sanitize_single_profile(user, is_admin=user_is_admin)
                self.send_json(
                    {
                        "status": "ok",
                        "user": safe_user,
                        "language": user.get("language", "zh-TW"),
                        "profiles": self._filter_profiles_for_caller(
                            AUTH_SHARE.list_user_profiles(), u_em, user_is_admin
                        ),
                    }
                )
                return

            self.send_json({"error": f"Unknown endpoint: {path}"}, status=404)
        except KeyError as e:
            msg = e.args[0] if e.args else str(e)
            self.send_json({"error": str(msg)}, status=404)
        except ValueError as e:
            self.send_json({"error": str(e)}, status=400)
        except Exception as e:
            self.send_json({"error": str(e)}, status=500)

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)
        query = urllib.parse.parse_qs(parsed.query)
        share_token = self._extract_share_token(query)
        if os.name != "nt" and path.startswith("/api/"):
            self._proxy_via_pc_tunnel_if_vps("DELETE", path)
            return
        if path.startswith("/api/comments/"):
            actor_email, actor_role, actor_perms = self._resolve_request_role(None, query, share_token)
            cid = path[len("/api/comments/") :].strip("/")
            existing_c = DB.get_comment(cid)
            scan_id_c = str(existing_c.get("scan_id") or "") if existing_c else ""
            if share_token:
                ok_s, reason_s, link_s, _ = AUTH_SHARE.validate_share_access(
                    share_token, requested_scan_id=scan_id_c or None
                )
                if not ok_s or not (link_s and link_s.get("allow_comments", False)):
                    self.send_json({"error": "Comments are disabled for this external share link."}, status=403)
                    return
            elif actor_role == "guest":
                self.send_json({"error": "Authenticated session required to delete spatial comments."}, status=403)
                return
            if existing_c and not self._can_actor_modify_comment(existing_c, actor_email, actor_role, None):
                self.send_json(
                    {"error": "Only the comment author or an admin can edit or modify photos on this comment."},
                    status=403,
                )
                return
            deleted = DB.delete_comment(cid)
            _VPS_RAM_FALLBACK_CACHE.clear()
            self.send_json(
                {
                    "status": "ok",
                    "deleted": deleted,
                    "comment_id": cid,
                    "comments": DB.list_comments(scan_id_c) if scan_id_c else [],
                }
            )
            return
        self.send_json({"error": "Unknown DELETE endpoint"}, status=404)

