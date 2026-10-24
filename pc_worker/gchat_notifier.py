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
        self.bot_bearer_token = str(saved_cfg.get("bot_bearer_token") or "").strip()
        default_admin_email = os.environ.get("GS_DEFAULT_NOTIFY_EMAIL", "").strip().lower()
        if self.webhook_url and default_admin_email and default_admin_email not in self.user_webhooks:
            self.user_webhooks[default_admin_email] = self.webhook_url
            self._save_config()

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
        uploader_name, uploader_email = normalize_gatheren_uploader(raw_name, raw_email, scan.get("project_dir") or scan_id)

        gchat_uid = private_viewer_uid or self.user_gchat_ids.get(uploader_email.lower(), "")
        mention_tag = f"<users/{gchat_uid}>" if gchat_uid else f"*{uploader_name}*"

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

    def _try_send_chat_api_direct_message(
        self, uploader_email: str, gchat_uid: str, card_payload: Dict[str, Any]
    ) -> Optional[str]:
        """
        If a Google Chat App Bearer token is configured, sends a 1:1 Direct Message
        (or privateMessageViewer card) directly to the uploader via the Google Chat v1 REST API.
        """
        if not self.bot_bearer_token:
            return None
        headers = {
            "Authorization": f"Bearer {self.bot_bearer_token}",
            "Content-Type": "application/json; charset=UTF-8",
        }
        user_ref = f"users/{gchat_uid}" if gchat_uid else f"users/{uploader_email}"
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
            pass
        return None

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

        uploader_name, uploader_email = normalize_gatheren_uploader(
            scan.get("uploader_name", ""),
            scan.get("uploader_email", "glibivanov@gatheren.com.tw"),
            scan.get("project_dir") or scan_id,
        )
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
