#!/usr/bin/env python3
"""
Google Chat Notification Dispatcher for GatheringScans (Requirement 4.a)
Sends a rich Google Chat Card v2 private completion notification directly to the
photos uploader when their PIX4Dcatch scan finishes processing in PIX4Dmatic
(TWD97 (121) + TWVD2001, 4K WebP 3D Tileset + .3tz stream package).
"""

import os
import re
import glob
import time
import json
import base64
import sqlite3
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional

from pc_worker.config import (
    GCHAT_WEBHOOK_URL,
    PUBLIC_BASE_URL,
    TWD97_TWVD2001_SHORT,
    DATA_DIR,
    PIX4DMATIC_TEXTURE_SIZE,
)
from pc_worker.priority_queue import ScanQueueDB, DB_LOCK

GCHAT_CONFIG_PATH = os.path.join(DATA_DIR, "gchat_config.json")
MANIFEST_PATH = os.path.join(DATA_DIR, "gdrive_cloud_manifest.json")

# Known Google Workspace / DriveFS numeric User IDs (users/<id>) for direct @mentions & private DMs
DEFAULT_UPLOADER_GCHAT_USER_IDS: Dict[str, str] = {
    "glibivanov@gatheren.com.tw": "107639887113416939995",
    "gleb.ivanov1999@gmail.com": "110772246686332466252",
    "kentyu@gatheren.com.tw": "104324004082669082985",
    "frankchao@gatheren.com.tw": "113563863225856947636",
    "feiwenhsueh@gatheren.com.tw": "103768730904451087495",
    "tengtewang@gatheren.com.tw": "103254235603034005707",
    "public@gatheren.com.tw": "111667799374014791533",
    "leo7164@gmail.com": "112616399687407417489",
}


def _discover_drivefs_google_user_ids() -> Dict[str, str]:
    """Extracts email -> 21-digit Google Workspace User ID mappings from local DriveFS databases."""
    mapping = dict(DEFAULT_UPLOADER_GCHAT_USER_IDS)
    local_app = os.environ.get("LOCALAPPDATA", "")
    if not local_app:
        return mapping
    try:
        for db_path in glob.glob(os.path.join(local_app, "Google", "DriveFS", "*", "metadata_sqlite_db")):
            folder_uid = os.path.basename(os.path.dirname(db_path))
            if not folder_uid.isdigit():
                continue
            try:
                con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
                con.text_factory = bytes
                row = con.execute("SELECT value FROM properties WHERE key = b'driveway_account'").fetchone()
                con.close()
                if row and row[0]:
                    raw = row[0].decode("utf-8", errors="ignore")
                    emails = re.findall(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}", raw)
                    for em in emails:
                        mapping[em.lower()] = folder_uid
            except Exception:
                pass
    except Exception:
        pass
    return mapping


class GoogleChatNotifier:
    def __init__(self, db: ScanQueueDB, webhook_url: str = GCHAT_WEBHOOK_URL):
        self.db = db
        self.user_webhooks: Dict[str, str] = {}
        self.user_gchat_ids: Dict[str, str] = _discover_drivefs_google_user_ids()
        self.bot_bearer_token: str = ""
        self._sa_chat_token: str = ""
        self._sa_chat_token_exp: float = 0.0
        saved_cfg = self._load_saved_config()
        self.webhook_url = (webhook_url or saved_cfg.get("webhook_url") or "").strip()
        if isinstance(saved_cfg.get("user_webhooks"), dict):
            for k, v in saved_cfg["user_webhooks"].items():
                if k and v:
                    self.user_webhooks[str(k).strip().lower()] = str(v).strip()
        if isinstance(saved_cfg.get("user_gchat_ids"), dict):
            for k, v in saved_cfg["user_gchat_ids"].items():
                if k and v:
                    self.user_gchat_ids[str(k).strip().lower()] = str(v).strip()
        self._sync_user_ids_from_db()
        self.bot_bearer_token = str(saved_cfg.get("bot_bearer_token") or "").strip()
        default_admin_email = os.environ.get("GS_DEFAULT_NOTIFY_EMAIL", "").strip().lower()
        if self.webhook_url and default_admin_email and default_admin_email not in self.user_webhooks:
            self.user_webhooks[default_admin_email] = self.webhook_url
            self._save_config()

    def _sync_user_ids_from_db(self) -> None:
        """Automatically populates `email -> 21-digit Google User ID` (`google_sub`) from `user_profiles`."""
        try:
            with DB_LOCK, self.db._connect() as conn:
                rows = conn.execute(
                    "SELECT email, google_sub FROM user_profiles WHERE google_sub IS NOT NULL AND google_sub != ''"
                ).fetchall()
                for r in rows:
                    em = str(r["email"] or "").strip().lower()
                    sub = str(r["google_sub"] or "").strip()
                    if em and sub and sub.isdigit():
                        self.user_gchat_ids[em] = sub
        except Exception:
            pass

    def _load_saved_config(self) -> Dict[str, Any]:
        if os.path.isfile(GCHAT_CONFIG_PATH):
            try:
                with open(GCHAT_CONFIG_PATH, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if isinstance(data, dict):
                        return data
            except Exception:
                pass
        return {}

    def _save_config(self) -> None:
        os.makedirs(DATA_DIR, exist_ok=True)
        payload = {
            "webhook_url": self.webhook_url,
            "user_webhooks": self.user_webhooks,
            "user_gchat_ids": self.user_gchat_ids,
        }
        if self.bot_bearer_token:
            payload["bot_bearer_token"] = self.bot_bearer_token
        try:
            with open(GCHAT_CONFIG_PATH, "w", encoding="utf-8") as f:
                json.dump(payload, f, indent=2, ensure_ascii=False)
        except Exception:
            pass

    def set_webhook_url(self, url: str, uploader_email: str = "") -> str:
        clean_url = (url or "").strip()
        if uploader_email:
            self.user_webhooks[uploader_email.strip().lower()] = clean_url
        else:
            self.webhook_url = clean_url
        self._save_config()
        return clean_url or self.webhook_url

    def get_webhook_url(self, uploader_email: str = "") -> str:
        if uploader_email:
            em = uploader_email.strip().lower()
            if em in self.user_webhooks and self.user_webhooks[em]:
                return self.user_webhooks[em]
        return self.webhook_url

    def _resolve_stream_size_mb(self, scan_id: str, scan: Dict[str, Any]) -> float:
        """Resolves the web stream package (.3tz) size in MB, falling back to root.glb size."""
        try:
            if os.path.isfile(MANIFEST_PATH):
                with open(MANIFEST_PATH, "r", encoding="utf-8") as mf:
                    manifest = json.load(mf)
                pkg = (manifest.get("packages") or {}).get(scan_id) or {}
                sz = int(pkg.get("size_bytes") or 0)
                if sz > 0:
                    return round(sz / (1024.0 * 1024.0), 2)
        except Exception:
            pass
        ts_path = scan.get("tileset_path") or ""
        if ts_path and os.path.isfile(ts_path):
            root_glb = os.path.join(os.path.dirname(ts_path), "tiles", "root.glb")
            if os.path.isfile(root_glb):
                return round(os.path.getsize(root_glb) / (1024.0 * 1024.0), 2)
        return round(float(scan.get("size_bytes") or 5242880) / (1024.0 * 1024.0), 2)

    def build_completion_card(self, scan: Dict[str, Any], private_viewer_uid: str = "") -> Dict[str, Any]:
        """
        Builds a Google Chat API v2 Rich Card addressed privately to the photos uploader
        with a verified raster PNG 3D scan preview, covered area (m²), and MB/m² density.
        """
        from pc_worker.gdrive_watcher import normalize_gatheren_uploader

        scan_id = scan.get("scan_id") or "scan"
        name = scan.get("name", scan_id)
        project_group = scan.get("project_group") or "Unassigned Site"
        raw_name = scan.get("uploader_name", "雲在天")
        raw_email = scan.get("uploader_email", "glibivanov@gatheren.com.tw")
        hint_ref = scan.get("source_zip_path") or scan.get("project_dir") or scan_id
        uploader_name, uploader_email = normalize_gatheren_uploader(raw_name, raw_email, hint_ref)

        gchat_uid = private_viewer_uid or self.user_gchat_ids.get(uploader_email.lower(), "")
        mention_tag = f"<users/{gchat_uid}>" if gchat_uid else f"*{uploader_name} ({uploader_email})*"

        image_count = int(scan.get("image_count") or 0)
        covered_area_m2 = float(scan.get("covered_area_m2") or 0.0)
        stream_mb = self._resolve_stream_size_mb(scan_id, scan)
        mb_per_m2 = (stream_mb / covered_area_m2) if covered_area_m2 > 0 else 0.0
        tex_res = int(scan.get("texture_resolution") or PIX4DMATIC_TEXTURE_SIZE)

        twd_e = float(scan.get("twd97_e") or 0.0)
        twd_n = float(scan.get("twd97_n") or 0.0)
        twd_h = float(scan.get("twd97_h") or 0.0)
        scan_crs = str(scan.get("crs") or TWD97_TWVD2001_SHORT)
        is_local_crs = "LOCAL" in scan_crs.upper() or (scan.get("lat") is None and abs(twd_e) < 50000.0)
        if is_local_crs:
            crs_card_text = f"{scan_crs} (X:{twd_e:.2f}m, Y:{twd_n:.2f}m, Z:{twd_h:+.2f}m)"
        else:
            crs_card_text = f"{scan_crs} (E:{twd_e:.1f}, N:{twd_n:.1f}, H:{twd_h:+.2f}m)"
        view_url = f"{PUBLIC_BASE_URL}/?scan={urllib.parse.quote(scan_id)}"
        # Use stable PNG URL (also cached locally on VPS /app/data/thumbnails/<scan_id>.png)
        thumb_url = f"{PUBLIC_BASE_URL}/api/scans/{urllib.parse.quote(scan_id)}/thumbnail.png"

        area_str = f"{covered_area_m2:,.1f} m²" if covered_area_m2 > 0 else "N/A"
        density_str = f"{mb_per_m2:.4f} MB/m² ({stream_mb:.2f} MB .3tz)" if covered_area_m2 > 0 else f"{stream_mb:.2f} MB .3tz"

        card_payload: Dict[str, Any] = {
            "text": (
                f"🔒 *Private Completion Notice for {mention_tag} ({uploader_name})*\n"
                f"Your uploaded 3D scan *{name}* has finished processing on GatheringScans and is ready for inspection!"
            ),
            "cardsV2": [
                {
                    "cardId": f"scan_ready_{scan_id}",
                    "card": {
                        "header": {
                            "title": f"3D Scan Processing Complete: {name}",
                            "subtitle": f"Private Notice to {uploader_name} • {project_group} • {scan_crs}",
                        },
                        "sections": [
                            {
                                "header": "3D Scan Preview & Survey Summary",
                                "widgets": [
                                    {
                                        "image": {
                                            "imageUrl": thumb_url,
                                            "altText": f"3D Scan Preview: {name}",
                                            "onClick": {"openLink": {"url": view_url}},
                                        }
                                    },
                                    {
                                        "decoratedText": {
                                            "topLabel": "Photos Uploader (Direct Recipient)",
                                            "text": f"{uploader_name} ({uploader_email})",
                                        }
                                    },
                                    {
                                        "decoratedText": {
                                            "topLabel": "Coordinate Reference System",
                                            "text": crs_card_text,
                                        }
                                    },
                                    {
                                        "decoratedText": {
                                            "topLabel": "Total Covered Area & Stream Density",
                                            "text": f"{area_str} • {density_str} • {image_count:,} Photos ({tex_res}px WebP)",
                                        }
                                    },
                                    {
                                        "buttonList": {
                                            "buttons": [
                                                {
                                                    "text": "Open 3D Scan Studio & Measure",
                                                    "onClick": {"openLink": {"url": view_url}},
                                                }
                                            ]
                                        }
                                    },
                                ],
                            }
                        ],
                    },
                }
            ],
        }
        return card_payload

    def _ensure_and_sync_thumbnail_to_public_url(self, scan_id: str, scan: Dict[str, Any]) -> None:
        """
        Ensures a valid raster PNG thumbnail exists locally for scan_id, uploads it to
        PUBLIC_BASE_URL (/app/data/thumbnails/<scan_id>.png on the VPS), and verifies HTTP 200
        availability before Google Chat fetches imageUrl.
        """
        thumbs_dir = os.path.join(DATA_DIR, "thumbnails")
        os.makedirs(thumbs_dir, exist_ok=True)
        local_thumb = os.path.join(thumbs_dir, f"{scan_id}.png")
        proj_dir = scan.get("project_dir") or ""
        ts_path = scan.get("tileset_path") or ""

        if not (os.path.isfile(local_thumb) and os.path.getsize(local_thumb) > 512):
            if ts_path and os.path.isfile(ts_path):
                try:
                    from pc_worker.preview_generator import ensure_scan_full_quality_thumbnail

                    ensure_scan_full_quality_thumbnail(ts_path, scan_id, project_dir=proj_dir, force=False)
                except Exception:
                    pass

        candidates = [
            local_thumb,
            os.path.join(thumbs_dir, f"{scan_id.lower()}.png"),
            os.path.join(proj_dir, "thumbnail.png") if proj_dir else "",
        ]
        for cpath in candidates:
            if cpath and os.path.isfile(cpath) and os.path.getsize(cpath) > 512:
                try:
                    with open(cpath, "rb") as f:
                        raw_png = f.read()
                    if not os.path.isfile(local_thumb):
                        with open(local_thumb, "wb") as lf:
                            lf.write(raw_png)
                    b64 = base64.b64encode(raw_png).decode("ascii")
                    payload = json.dumps({"data_url": f"data:image/png;base64,{b64}"}).encode("utf-8")
                    req = urllib.request.Request(
                        f"{PUBLIC_BASE_URL}/api/scans/{urllib.parse.quote(scan_id)}/thumbnail",
                        data=payload,
                        headers={"Content-Type": "application/json; charset=UTF-8"},
                        method="POST",
                    )
                    urllib.request.urlopen(req, timeout=12).read()
                except Exception:
                    pass
                break

    def _get_chat_bot_bearer_token(self, force_refresh: bool = False) -> str:
        """
        Acquires an OAuth2 Bearer token with scope `https://www.googleapis.com/auth/chat.bot`
        using the configured Google Cloud Service Account (`gcworker@modular-temple-508005-c4.iam.gserviceaccount.com`)
        from `data/gcp_service_account.json` or `data/gdrive_cloud_auth.json`.
        Falls back to manual `self.bot_bearer_token` if present.
        """
        now = time.time()
        if not force_refresh and self._sa_chat_token and self._sa_chat_token_exp > now + 90:
            return self._sa_chat_token
        try:
            from pc_worker.gdrive_cloud_sync import discover_service_account_json_on_disk
            from pc_worker.server_cloud_and_tunnel import _sign_rs256_jwt_assertion

            sa = discover_service_account_json_on_disk()
            if isinstance(sa, dict) and sa.get("client_email") and sa.get("private_key"):
                jwt_assertion = _sign_rs256_jwt_assertion(sa, scope="https://www.googleapis.com/auth/chat.bot")
                if jwt_assertion:
                    token_uri = str(sa.get("token_uri") or "https://oauth2.googleapis.com/token")
                    body = urllib.parse.urlencode(
                        {
                            "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                            "assertion": jwt_assertion,
                        }
                    ).encode("ascii")
                    req = urllib.request.Request(
                        token_uri,
                        data=body,
                        headers={"Content-Type": "application/x-www-form-urlencoded"},
                        method="POST",
                    )
                    with urllib.request.urlopen(req, timeout=8) as r:
                        resp = json.loads(r.read().decode("utf-8"))
                    tok = str(resp.get("access_token") or "").strip()
                    if tok:
                        self._sa_chat_token = tok
                        self._sa_chat_token_exp = now + float(resp.get("expires_in", 3500))
                        return tok
        except Exception as e:
            print(f"[GChatNotifier] Service account chat.bot token note: {e}")
        return self.bot_bearer_token

    def _try_send_chat_api_direct_message(
        self, uploader_email: str, gchat_uid: str, card_payload: Dict[str, Any]
    ) -> Optional[str]:
        """
        Uses the Google Cloud Service Account (`chat.bot` scope) to send a 1:1 Direct Message
        (or a privateMessageViewer card in a shared space where the bot is a member) directly
        to the uploader via the Google Chat v1 REST API.
        """
        token = self._get_chat_bot_bearer_token()
        if not token:
            return None
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=UTF-8",
        }
        # 1. Try 1:1 Direct Message (`spaces:findDirectMessage`) prioritizing numeric user ID (`users/<21-digit-id>`)
        self._sync_user_ids_from_db()
        eff_uid = gchat_uid or self.user_gchat_ids.get((uploader_email or "").strip().lower(), "")
        user_candidates = []
        if eff_uid:
            u_clean = eff_uid if str(eff_uid).startswith("users/") else f"users/{eff_uid}"
            user_candidates.append(u_clean)
        if uploader_email:
            u_em = f"users/{uploader_email.strip().lower()}"
            if u_em not in user_candidates:
                user_candidates.append(u_em)

        for user_ref in user_candidates:
            try:
                find_url = f"https://chat.googleapis.com/v1/spaces:findDirectMessage?name={urllib.parse.quote(user_ref)}"
                req = urllib.request.Request(find_url, headers=headers, method="GET")
                with urllib.request.urlopen(req, timeout=8) as resp:
                    dm_space = json.loads(resp.read().decode("utf-8")).get("name", "")
                if dm_space:
                    msg_url = f"https://chat.googleapis.com/v1/{dm_space}/messages"
                    mreq = urllib.request.Request(
                        msg_url,
                        data=json.dumps(card_payload).encode("utf-8"),
                        headers=headers,
                        method="POST",
                    )
                    with urllib.request.urlopen(mreq, timeout=8) as mresp:
                        return f"delivered_dm_http_{mresp.status}"
            except Exception:
                continue

        # 2. Fallback: If the Chat App is in a shared Space (e.g. AAQA_oh-3w8) and we know the
        #    recipient's user resource (`users/<id>` or `users/<email>`), post with `privateMessageViewer`
        #    so ONLY that specific uploader can see the card inside the group space!
        try:
            sreq = urllib.request.Request("https://chat.googleapis.com/v1/spaces", headers=headers, method="GET")
            with urllib.request.urlopen(sreq, timeout=8) as sresp:
                spaces_list = json.loads(sresp.read().decode("utf-8")).get("spaces") or []
            for sp in spaces_list:
                sp_name = str(sp.get("name") or "")
                sp_type = str(sp.get("spaceType") or sp.get("type") or "")
                if not sp_name or sp_type == "DIRECT_MESSAGE":
                    continue
                for viewer_ref in user_candidates:
                    try:
                        priv_body = dict(card_payload)
                        priv_body["privateMessageViewer"] = {"name": viewer_ref}
                        mreq = urllib.request.Request(
                            f"https://chat.googleapis.com/v1/{sp_name}/messages",
                            data=json.dumps(priv_body).encode("utf-8"),
                            headers=headers,
                            method="POST",
                        )
                        with urllib.request.urlopen(mreq, timeout=8) as mresp:
                            return f"delivered_private_card_http_{mresp.status}"
                    except Exception:
                        continue
        except Exception:
            pass
        return None

    def test_chat_app_connection(self, test_email: str = "") -> Dict[str, Any]:
        """
        Tests the Google Chat API Service Account (`chat.bot`) connection and checks whether
         the Google Cloud Console 'Configuration' tab has been saved yet.
        """
        import urllib.error

        token = self._get_chat_bot_bearer_token(force_refresh=True)
        result: Dict[str, Any] = {
            "token_acquired": bool(token),
            "chat_app_configured": False,
            "spaces": [],
            "dm_test": None,
        }
        if not token:
            result["status"] = "missing_token"
            result["message"] = "Could not acquire chat.bot OAuth2 token from Service Account."
            return result
        headers = {"Authorization": f"Bearer {token}"}
        try:
            req = urllib.request.Request("https://chat.googleapis.com/v1/spaces", headers=headers, method="GET")
            with urllib.request.urlopen(req, timeout=8) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            result["chat_app_configured"] = True
            result["spaces"] = data.get("spaces") or []
            result["status"] = "ok"
            result["message"] = f"Google Chat App is active and visible in {len(result['spaces'])} space(s)."
        except urllib.error.HTTPError as e:
            err_raw = e.read().decode("utf-8", errors="ignore")
            result["http_status"] = e.code
            result["error_detail"] = err_raw
            if e.code == 404 and "Google Chat app not found" in err_raw:
                result["status"] = "needs_console_configuration_tab"
                result["message"] = (
                    "Chat API is enabled and Service Account token works, but the 'Configuration' tab "
                    "in Google Cloud Console -> Google Chat API has not been saved yet."
                )
            else:
                result["status"] = f"http_{e.code}"
        except Exception as e:
            result["status"] = "error"
            result["message"] = str(e)

        if result["chat_app_configured"] and test_email:
            self._sync_user_ids_from_db()
            uid_t = self.user_gchat_ids.get(test_email.strip().lower(), "")
            u_ref = f"users/{uid_t}" if uid_t else f"users/{test_email.strip().lower()}"
            result["resolved_user_resource"] = u_ref
            try:
                f_url = f"https://chat.googleapis.com/v1/spaces:findDirectMessage?name={urllib.parse.quote(u_ref)}"
                freq = urllib.request.Request(f_url, headers=headers, method="GET")
                with urllib.request.urlopen(freq, timeout=8) as fresp:
                    result["dm_test"] = json.loads(fresp.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                result["dm_test"] = {"http_status": e.code, "body": e.read().decode("utf-8", errors="ignore")}
        return result

    def has_recent_notification(self, scan_id: str, within_seconds: float = 300.0) -> bool:
        """Checks whether a delivered_http_200 notification was already sent for scan_id recently."""
        with DB_LOCK, self.db._connect() as conn:
            row = conn.execute(
                """
                SELECT sent_at FROM gchat_notifications
                WHERE scan_id = ? AND webhook_status LIKE 'delivered_%'
                ORDER BY id DESC LIMIT 1
                """,
                (scan_id,),
            ).fetchone()
            if not row or not row["sent_at"]:
                return False
            try:
                dt = datetime.strptime(row["sent_at"], "%Y-%m-%d %H:%M:%S UTC").replace(tzinfo=timezone.utc)
                return (datetime.now(timezone.utc) - dt).total_seconds() < within_seconds
            except Exception:
                return False

    def notify_scan_ready(self, scan_id: str, custom_webhook_url: str = "") -> Dict[str, Any]:
        from pc_worker.gdrive_watcher import normalize_gatheren_uploader

        scan = self.db.get_scan(scan_id)
        if not scan:
            raise ValueError(f"Scan not found: {scan_id}")

        hint_ref = scan.get("source_zip_path") or scan.get("project_dir") or scan_id
        uploader_name, uploader_email = normalize_gatheren_uploader(
            scan.get("uploader_name", ""),
            scan.get("uploader_email", "glibivanov@gatheren.com.tw"),
            hint_ref,
        )
        if scan.get("uploader_name") != uploader_name or scan.get("uploader_email") != uploader_email:
            scan["uploader_name"] = uploader_name
            scan["uploader_email"] = uploader_email
            try:
                self.db.upsert_scan(scan)
            except Exception:
                pass
        else:
            scan["uploader_name"] = uploader_name
            scan["uploader_email"] = uploader_email

        self._ensure_and_sync_thumbnail_to_public_url(scan_id, scan)
        gchat_uid = self.user_gchat_ids.get(uploader_email.lower(), "")
        card_payload = self.build_completion_card(scan, private_viewer_uid=gchat_uid)

        # Resolve per-uploader private webhook first, then custom/default webhook
        target_webhook = (
            custom_webhook_url
            or self.get_webhook_url(uploader_email=uploader_email)
            or self.webhook_url
            or ""
        ).strip()
        sent_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

        webhook_status = "logged_ready"
        dm_status = self._try_send_chat_api_direct_message(uploader_email, gchat_uid, card_payload)
        if dm_status:
            webhook_status = dm_status
        elif target_webhook.startswith("https://chat.googleapis.com/"):
            try:
                # Route into a dedicated per-uploader thread so the uploader gets a direct personal thread
                sep = "&" if "?" in target_webhook else "?"
                threaded_url = target_webhook
                if "messageReplyOption=" not in threaded_url:
                    threaded_url = f"{threaded_url}{sep}messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD"
                send_body = dict(card_payload)
                send_body["thread"] = {"threadKey": f"private_{uploader_email}_{scan_id}"}
                req = urllib.request.Request(
                    threaded_url,
                    data=json.dumps(send_body).encode("utf-8"),
                    headers={"Content-Type": "application/json; charset=UTF-8"},
                    method="POST",
                )
                with urllib.request.urlopen(req, timeout=10) as resp:
                    webhook_status = f"delivered_http_{resp.status}"
            except Exception as e:
                webhook_status = f"webhook_error: {e}"

        with DB_LOCK, self.db._connect() as conn:
            conn.execute(
                """
                INSERT INTO gchat_notifications (scan_id, uploader_email, webhook_status, card_json, sent_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    scan_id,
                    uploader_email,
                    webhook_status,
                    json.dumps(card_payload, ensure_ascii=False),
                    sent_at,
                ),
            )
            conn.commit()

        return {
            "status": "ok",
            "scan_id": scan_id,
            "uploader_email": uploader_email,
            "uploader_name": uploader_name,
            "uploader_gchat_user_id": gchat_uid,
            "delivery_mode": "private_uploader_dm",
            "webhook_status": webhook_status,
            "sent_at": sent_at,
            "card": card_payload,
        }

    def list_notifications(self, limit: int = 20) -> List[Dict[str, Any]]:
        with DB_LOCK, self.db._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM gchat_notifications ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
            out = []
            for r in rows:
                d = dict(r)
                try:
                    d["card"] = json.loads(d.get("card_json") or "{}")
                except Exception:
                    d["card"] = {}
                out.append(d)
            return out
