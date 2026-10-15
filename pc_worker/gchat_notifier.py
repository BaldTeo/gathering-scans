#!/usr/bin/env python3
"""
Google Chat Notification Dispatcher for GatheringScans (Requirement 4.a)
Sends a rich Google Chat Card v2 notification mentioning the uploader when their
PIX4Dcatch scan finishes processing in PIX4Dmatic (TWD97 (121) + TWVD2001, 2K textures).
"""

import os
import json
import urllib.request
from datetime import datetime, timezone
from typing import Dict, Any, List

from pc_worker.config import GCHAT_WEBHOOK_URL, PUBLIC_BASE_URL, TWD97_TWVD2001_SHORT, DATA_DIR
from pc_worker.priority_queue import ScanQueueDB, DB_LOCK

GCHAT_CONFIG_PATH = os.path.join(DATA_DIR, "gchat_config.json")


class GoogleChatNotifier:
    def __init__(self, db: ScanQueueDB, webhook_url: str = GCHAT_WEBHOOK_URL):
        self.db = db
        self.webhook_url = webhook_url or self._load_saved_webhook()

    def _load_saved_webhook(self) -> str:
        if os.path.isfile(GCHAT_CONFIG_PATH):
            try:
                with open(GCHAT_CONFIG_PATH, "r", encoding="utf-8") as f:
                    return (json.load(f).get("webhook_url") or "").strip()
            except Exception:
                return ""
        return ""

    def set_webhook_url(self, url: str) -> str:
        self.webhook_url = (url or "").strip()
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(GCHAT_CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump({"webhook_url": self.webhook_url}, f, indent=2)
        return self.webhook_url

    def get_webhook_url(self) -> str:
        return self.webhook_url

    def build_completion_card(self, scan: Dict[str, Any]) -> Dict[str, Any]:
        """Builds a Google Chat API v2 Rich Card mentioning the uploader."""
        scan_id = scan.get("scan_id", "quchi_20261005_merged")
        name = scan.get("name", scan_id)
        project_group = scan.get("project_group", "QuChi Dam")
        uploader_name = scan.get("uploader_name", "Glib Ivanov")
        uploader_email = scan.get("uploader_email", "glibivanov@gatheren.com.tw")
        image_count = scan.get("image_count", 0)
        rtk_acc = scan.get("rtk_accuracy_cm", 1.5)
        twd_e = scan.get("twd97_e", 304952.656)
        twd_n = scan.get("twd97_n", 2757084.875)
        twd_h = scan.get("twd97_h", 43.18)
        view_url = f"{PUBLIC_BASE_URL}/?scan={scan_id}"

        return {
            "text": f"[GatheringScans] *{name}* is ready on GatheringScans! Uploaded by *{uploader_name}* (`{uploader_email}`).",
            "cardsV2": [
                {
                    "cardId": f"scan_ready_{scan_id}",
                    "card": {
                        "header": {
                            "title": f"3D Scan Ready: {name}",
                            "subtitle": f"{project_group} • {TWD97_TWVD2001_SHORT} • 2K Web Stream",
                        },
                        "sections": [
                            {
                                "header": "Processing & Geolocation Summary",
                                "widgets": [
                                    {
                                        "decoratedText": {
                                            "topLabel": "Uploader Account",
                                            "text": f"{uploader_name} ({uploader_email})",
                                        }
                                    },
                                    {
                                        "decoratedText": {
                                            "topLabel": "Coordinate Reference System",
                                            "text": f"TWD97 (121) [EPSG:3826] + TWVD2001 [EPSG:8904] (E:{twd_e:.1f}, N:{twd_n:.1f}, H:+{twd_h:.2f}m)",
                                        }
                                    },
                                    {
                                        "decoratedText": {
                                            "topLabel": "Photogrammetry Metrics",
                                            "text": f"{image_count} RTK Photos • σ={rtk_acc} cm • 2K (2048px) Mesh & 3D Tileset",
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

    def notify_scan_ready(self, scan_id: str, custom_webhook_url: str = "") -> Dict[str, Any]:
        scan = self.db.get_scan(scan_id)
        if not scan:
            raise ValueError(f"Scan not found: {scan_id}")

        card_payload = self.build_completion_card(scan)
        target_webhook = (custom_webhook_url or self.webhook_url or "").strip()
        sent_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

        webhook_status = "logged_ready"
        if target_webhook.startswith("https://chat.googleapis.com/"):
            try:
                req = urllib.request.Request(
                    target_webhook,
                    data=json.dumps(card_payload).encode("utf-8"),
                    headers={"Content-Type": "application/json; charset=UTF-8"},
                    method="POST",
                )
                with urllib.request.urlopen(req, timeout=8) as resp:
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
                    scan.get("uploader_email", ""),
                    webhook_status,
                    json.dumps(card_payload),
                    sent_at,
                ),
            )
            conn.commit()

        return {
            "status": "ok",
            "scan_id": scan_id,
            "uploader_email": scan.get("uploader_email"),
            "uploader_name": scan.get("uploader_name"),
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
