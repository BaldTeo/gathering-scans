#!/usr/bin/env python3
"""
Smart Single-Concurrency Priority Queue & Scan Registry (SQLite)
Implements Weighted Shortest Job First with Aging (WSJF-Aging) so small scans get priority
over large scans up to an anti-starvation cap (3 bypasses or 90 minutes wait).
"""

import os
import json
import time
import math
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional

from pc_worker.config import (
    DB_PATH,
    TWD97_TWVD2001_SHORT,
    PIX4DMATIC_TEXTURE_SIZE,
)

DB_LOCK = threading.RLock()


def calculate_priority_score(
    image_count: int,
    size_mb: float,
    wait_minutes: float,
    bypass_count: int = 0,
    force_next: int = 0,
) -> float:
    """
    Computes dynamic WSJF-Aging priority score for a queued scan:
    - Small scans receive a boost inversely proportional to image_count^0.65.
    - Waiting scans gain +1.5 * (wait_minutes^1.15) aging priority.
    - Anti-starvation guarantee: if bypassed >= 3 times or waited >= 90 minutes,
      locks priority to 1e9+ so large scans are never starved indefinitely.
    """
    wait_m = max(0.0, float(wait_minutes))
    if force_next:
        return round(2e9 + wait_m, 3)
    if bypass_count >= 3 or wait_m >= 90.0:
        return round(1e9 + wait_m, 3)

    effective_units = max(float(image_count) if image_count > 0 else (max(size_mb, 1.0) / 3.5), 25.0)
    size_score = 1000.0 / (effective_units ** 0.65)
    aging_score = 1.5 * (wait_m ** 1.15)
    return round(size_score + aging_score, 3)


class ScanQueueDB:
    def __init__(self, db_path: str = DB_PATH):
        self.db_path = db_path
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30.0, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_schema(self):
        with DB_LOCK, self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS scans (
                    scan_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    project_group TEXT NOT NULL,
                    project_name_zh TEXT DEFAULT '',
                    capture_date TEXT NOT NULL,
                    uploaded_at REAL NOT NULL,
                    uploader_email TEXT NOT NULL,
                    uploader_name TEXT NOT NULL,
                    source_zip_path TEXT DEFAULT '',
                    project_dir TEXT DEFAULT '',
                    tileset_path TEXT DEFAULT '',
                    obj_path TEXT DEFAULT '',
                    report_path TEXT DEFAULT '',
                    cameras_dir TEXT DEFAULT '',
                    image_count INTEGER DEFAULT 0,
                    size_bytes INTEGER DEFAULT 0,
                    rtk_accuracy_cm REAL DEFAULT 1.8,
                    crs TEXT DEFAULT 'TWD97 (121) + TWVD2001',
                    texture_resolution INTEGER DEFAULT 2048,
                    lat REAL DEFAULT 24.92032,
                    lon REAL DEFAULT 121.54351,
                    elev_m REAL DEFAULT 43.2,
                    twd97_e REAL DEFAULT 304952.6,
                    twd97_n REAL DEFAULT 2757084.9,
                    twd97_h REAL DEFAULT 43.2,
                    bounding_box_json TEXT DEFAULT '{}',
                    status TEXT DEFAULT 'queued',
                    progress_pct REAL DEFAULT 0.0,
                    stage_label TEXT DEFAULT 'Queued',
                    bypass_count INTEGER DEFAULT 0,
                    force_next INTEGER DEFAULT 0,
                    priority_score REAL DEFAULT 0.0,
                    notes TEXT DEFAULT ''
                );

                CREATE TABLE IF NOT EXISTS scan_comments (
                    comment_id TEXT PRIMARY KEY,
                    scan_id TEXT NOT NULL,
                    author_email TEXT NOT NULL,
                    author_name TEXT NOT NULL,
                    text TEXT NOT NULL,
                    pos_x REAL DEFAULT 0.0,
                    pos_y REAL DEFAULT 0.0,
                    pos_z REAL DEFAULT 0.0,
                    twd97_e REAL DEFAULT 0.0,
                    twd97_n REAL DEFAULT 0.0,
                    twd97_h REAL DEFAULT 0.0,
                    camera_json TEXT DEFAULT '{}',
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS share_links (
                    token TEXT PRIMARY KEY,
                    label TEXT NOT NULL,
                    scope_type TEXT NOT NULL,
                    target_id TEXT NOT NULL,
                    created_by_email TEXT NOT NULL,
                    created_by_name TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    expires_at TEXT DEFAULT '',
                    allow_download INTEGER DEFAULT 1,
                    allow_measurements INTEGER DEFAULT 1,
                    allow_comments INTEGER DEFAULT 1,
                    revoked INTEGER DEFAULT 0,
                    revoked_at TEXT DEFAULT '',
                    view_count INTEGER DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS user_settings (
                    email TEXT PRIMARY KEY,
                    display_name TEXT DEFAULT '',
                    offline_cache_enabled INTEGER DEFAULT 1,
                    auto_cache_pinned_groups TEXT DEFAULT '["QuChi Dam", "Rose Park"]',
                    theme_preference TEXT DEFAULT 'auto',
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS gchat_notifications (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    scan_id TEXT NOT NULL,
                    uploader_email TEXT NOT NULL,
                    webhook_status TEXT NOT NULL,
                    card_json TEXT NOT NULL,
                    sent_at TEXT NOT NULL
                );
                """
            )
            try:
                conn.execute("ALTER TABLE user_settings ADD COLUMN theme_preference TEXT DEFAULT 'auto'")
            except Exception:
                pass
            try:
                conn.execute("ALTER TABLE scans ADD COLUMN user_edited_name INTEGER DEFAULT 0")
            except Exception:
                pass
            conn.executescript(
                """
                DROP TRIGGER IF EXISTS trg_preserve_user_scan_name;
                CREATE TRIGGER trg_preserve_user_scan_name
                AFTER UPDATE ON scans
                WHEN OLD.user_edited_name = 1 AND NEW.user_edited_name = 0
                BEGIN
                    UPDATE scans SET name = OLD.name, user_edited_name = 1 WHERE scan_id = NEW.scan_id;
                END;

                DROP TRIGGER IF EXISTS trg_strip_fake_scan_name_upd;
                CREATE TRIGGER trg_strip_fake_scan_name_upd
                AFTER UPDATE OF name ON scans
                WHEN NEW.user_edited_name = 0 AND (NEW.name LIKE '% (Merged % Parts)' OR NEW.name LIKE 'PIX4Dcatch %')
                BEGIN
                    UPDATE scans
                    SET name = CASE
                        WHEN NEW.name LIKE '% (Merged % Parts)' THEN SUBSTR(NEW.name, 1, INSTR(NEW.name, ' (Merged ') - 1)
                        WHEN NEW.name LIKE 'PIX4Dcatch %' THEN SUBSTR(NEW.name, 12)
                        ELSE NEW.name
                    END
                    WHERE scan_id = NEW.scan_id;
                END;

                DROP TRIGGER IF EXISTS trg_strip_fake_scan_name_ins;
                CREATE TRIGGER trg_strip_fake_scan_name_ins
                AFTER INSERT ON scans
                WHEN NEW.user_edited_name = 0 AND (NEW.name LIKE '% (Merged % Parts)' OR NEW.name LIKE 'PIX4Dcatch %')
                BEGIN
                    UPDATE scans
                    SET name = CASE
                        WHEN NEW.name LIKE '% (Merged % Parts)' THEN SUBSTR(NEW.name, 1, INSTR(NEW.name, ' (Merged ') - 1)
                        WHEN NEW.name LIKE 'PIX4Dcatch %' THEN SUBSTR(NEW.name, 12)
                        ELSE NEW.name
                    END
                    WHERE scan_id = NEW.scan_id;
                END;
                """
            )
            conn.commit()

    def upsert_scan(self, scan_data: Dict[str, Any]) -> Dict[str, Any]:
        now = time.time()
        uploaded_at = float(scan_data.get("uploaded_at", now))
        image_count = int(scan_data.get("image_count", 0))
        size_bytes = int(scan_data.get("size_bytes", 0))
        bypass_count = int(scan_data.get("bypass_count", 0))
        force_next = int(scan_data.get("force_next", 0))
        user_edited_name = 1 if scan_data.get("user_edited_name") else 0
        wait_minutes = max(0.0, (now - uploaded_at) / 60.0)
        score = calculate_priority_score(
            image_count=image_count,
            size_mb=size_bytes / (1024 * 1024),
            wait_minutes=wait_minutes,
            bypass_count=bypass_count,
            force_next=force_next,
        )

        record = {
            "scan_id": scan_data["scan_id"],
            "name": scan_data.get("name", scan_data["scan_id"]),
            "user_edited_name": user_edited_name,
            "project_group": scan_data.get("project_group", "QuChi Dam"),
            "project_name_zh": scan_data.get("project_name_zh", "屈尺堰工程"),
            "capture_date": scan_data.get("capture_date", datetime.now().strftime("%Y-%m-%d %H:%M")),
            "uploaded_at": uploaded_at,
            "uploader_email": scan_data.get("uploader_email", "engineer@gatheren.cloud"),
            "uploader_name": scan_data.get("uploader_name", "Field Engineer"),
            "source_zip_path": scan_data.get("source_zip_path", ""),
            "project_dir": scan_data.get("project_dir", ""),
            "tileset_path": scan_data.get("tileset_path", ""),
            "obj_path": scan_data.get("obj_path", ""),
            "report_path": scan_data.get("report_path", ""),
            "cameras_dir": scan_data.get("cameras_dir", ""),
            "image_count": image_count,
            "size_bytes": size_bytes,
            "rtk_accuracy_cm": float(scan_data.get("rtk_accuracy_cm", 1.8)),
            "crs": scan_data.get("crs", TWD97_TWVD2001_SHORT),
            "texture_resolution": int(scan_data.get("texture_resolution", PIX4DMATIC_TEXTURE_SIZE)),
            "lat": float(scan_data.get("lat", 24.92032)),
            "lon": float(scan_data.get("lon", 121.54351)),
            "elev_m": float(scan_data.get("elev_m", 43.2)),
            "twd97_e": float(scan_data.get("twd97_e", 304952.6)),
            "twd97_n": float(scan_data.get("twd97_n", 2757084.9)),
            "twd97_h": float(scan_data.get("twd97_h", 43.2)),
            "bounding_box_json": json.dumps(scan_data.get("bounding_box", {}))
            if isinstance(scan_data.get("bounding_box"), dict)
            else str(scan_data.get("bounding_box_json", "{}")),
            "status": scan_data.get("status", "queued"),
            "progress_pct": float(scan_data.get("progress_pct", 0.0)),
            "stage_label": scan_data.get("stage_label", "Queued"),
            "bypass_count": bypass_count,
            "force_next": force_next,
            "priority_score": score,
            "notes": scan_data.get("notes", ""),
        }

        with DB_LOCK, self._connect() as conn:
            conn.execute(
                """
                INSERT INTO scans (
                    scan_id, name, user_edited_name, project_group, project_name_zh, capture_date,
                    uploaded_at, uploader_email, uploader_name, source_zip_path,
                    project_dir, tileset_path, obj_path, report_path, cameras_dir,
                    image_count, size_bytes, rtk_accuracy_cm, crs, texture_resolution,
                    lat, lon, elev_m, twd97_e, twd97_n, twd97_h, bounding_box_json,
                    status, progress_pct, stage_label, bypass_count, force_next,
                    priority_score, notes
                ) VALUES (
                    :scan_id, :name, :user_edited_name, :project_group, :project_name_zh, :capture_date,
                    :uploaded_at, :uploader_email, :uploader_name, :source_zip_path,
                    :project_dir, :tileset_path, :obj_path, :report_path, :cameras_dir,
                    :image_count, :size_bytes, :rtk_accuracy_cm, :crs, :texture_resolution,
                    :lat, :lon, :elev_m, :twd97_e, :twd97_n, :twd97_h, :bounding_box_json,
                    :status, :progress_pct, :stage_label, :bypass_count, :force_next,
                    :priority_score, :notes
                )
                ON CONFLICT(scan_id) DO UPDATE SET
                    name=CASE WHEN scans.user_edited_name = 1 AND excluded.user_edited_name = 0 THEN scans.name ELSE excluded.name END,
                    user_edited_name=CASE WHEN scans.user_edited_name = 1 OR excluded.user_edited_name = 1 THEN 1 ELSE 0 END,
                    project_group=excluded.project_group,
                    project_name_zh=excluded.project_name_zh,
                    capture_date=excluded.capture_date,
                    uploader_email=excluded.uploader_email,
                    uploader_name=excluded.uploader_name,
                    source_zip_path=CASE WHEN excluded.source_zip_path != '' THEN excluded.source_zip_path ELSE scans.source_zip_path END,
                    project_dir=CASE WHEN excluded.project_dir != '' THEN excluded.project_dir ELSE scans.project_dir END,
                    tileset_path=CASE WHEN excluded.tileset_path != '' THEN excluded.tileset_path ELSE scans.tileset_path END,
                    obj_path=CASE WHEN excluded.obj_path != '' THEN excluded.obj_path ELSE scans.obj_path END,
                    report_path=CASE WHEN excluded.report_path != '' THEN excluded.report_path ELSE scans.report_path END,
                    cameras_dir=CASE WHEN excluded.cameras_dir != '' THEN excluded.cameras_dir ELSE scans.cameras_dir END,
                    image_count=CASE WHEN excluded.image_count > 0 THEN excluded.image_count ELSE scans.image_count END,
                    size_bytes=CASE WHEN excluded.size_bytes > 0 THEN excluded.size_bytes ELSE scans.size_bytes END,
                    rtk_accuracy_cm=excluded.rtk_accuracy_cm,
                    crs=excluded.crs,
                    texture_resolution=excluded.texture_resolution,
                    lat=excluded.lat,
                    lon=excluded.lon,
                    elev_m=excluded.elev_m,
                    twd97_e=excluded.twd97_e,
                    twd97_n=excluded.twd97_n,
                    twd97_h=excluded.twd97_h,
                    status=excluded.status,
                    progress_pct=excluded.progress_pct,
                    stage_label=excluded.stage_label,
                    priority_score=excluded.priority_score,
                    notes=CASE WHEN excluded.notes != '' THEN excluded.notes ELSE scans.notes END
                """,
                record,
            )
            conn.commit()
        return self.get_scan(record["scan_id"])

    def rename_scan(self, scan_id: str, new_name: str) -> Optional[Dict[str, Any]]:
        """Updates a scan's display name in SQLite and persists it in scan_meta.json on disk."""
        clean_name = (new_name or "").strip()
        if not scan_id or not clean_name:
            return None
        with DB_LOCK, self._connect() as conn:
            conn.execute(
                "UPDATE scans SET name = ?, user_edited_name = 1 WHERE scan_id = ?",
                (clean_name, scan_id),
            )
            conn.commit()
        scan = self.get_scan(scan_id)
        if not scan:
            return None
        proj_dir = scan.get("project_dir") or ""
        if proj_dir and os.path.isdir(proj_dir):
            meta_file = os.path.join(proj_dir, "scan_meta.json")
            meta: Dict[str, Any] = {}
            if os.path.isfile(meta_file):
                try:
                    with open(meta_file, "r", encoding="utf-8") as rf:
                        meta = json.load(rf)
                except Exception:
                    meta = {}
            meta["name"] = clean_name
            meta["user_edited_name"] = True
            try:
                with open(meta_file, "w", encoding="utf-8") as wf:
                    json.dump(meta, wf, indent=2, ensure_ascii=False)
            except Exception as e:
                print(f"[DB] Warning writing renamed scan_meta.json {meta_file}: {e}")
        return scan

    def refresh_queue_priorities(self, now: Optional[float] = None) -> List[Dict[str, Any]]:
        """Recalculates dynamic WSJF-Aging priority scores for all queued jobs."""
        now_ts = now if now is not None else time.time()
        with DB_LOCK, self._connect() as conn:
            rows = conn.execute("SELECT * FROM scans WHERE status = 'queued'").fetchall()
            for r in rows:
                wait_m = max(0.0, (now_ts - float(r["uploaded_at"])) / 60.0)
                score = calculate_priority_score(
                    image_count=int(r["image_count"]),
                    size_mb=float(r["size_bytes"]) / (1024 * 1024),
                    wait_minutes=wait_m,
                    bypass_count=int(r["bypass_count"]),
                    force_next=int(r["force_next"]),
                )
                conn.execute(
                    "UPDATE scans SET priority_score = ? WHERE scan_id = ?",
                    (score, r["scan_id"]),
                )
            conn.commit()
            updated = conn.execute(
                "SELECT * FROM scans WHERE status = 'queued' ORDER BY priority_score DESC, uploaded_at ASC"
            ).fetchall()
            return [self._row_to_dict(x) for x in updated]

    def pop_next_job(self, now: Optional[float] = None) -> Optional[Dict[str, Any]]:
        """
        Single-concurrency queue pop:
        - If a scan is already in 'processing' status, returns None (mutex locked).
        - Otherwise refreshes WSJF-Aging scores, picks the highest-priority scan,
          increments bypass_count on any older queued scans that were jumped over,
          and transitions the chosen scan to 'processing'.
        """
        now_ts = now if now is not None else time.time()
        with DB_LOCK, self._connect() as conn:
            active = conn.execute(
                "SELECT scan_id FROM scans WHERE status = 'processing' LIMIT 1"
            ).fetchone()
            if active:
                return None

            queued = self.refresh_queue_priorities(now=now_ts)
            if not queued:
                return None

            chosen = queued[0]
            chosen_id = chosen["scan_id"]
            chosen_uploaded = float(chosen["uploaded_at"])

            # Increment bypass_count for any older scan that was bypassed by this smaller scan
            for other in queued[1:]:
                if float(other["uploaded_at"]) <= chosen_uploaded:
                    conn.execute(
                        "UPDATE scans SET bypass_count = bypass_count + 1 WHERE scan_id = ?",
                        (other["scan_id"],),
                    )

            conn.execute(
                """
                UPDATE scans
                SET status = 'processing',
                    progress_pct = 5.0,
                    stage_label = 'Initializing PIX4Dmatic (TWD97 + TWVD2001, 2K)...'
                WHERE scan_id = ?
                """,
                (chosen_id,),
            )
            conn.commit()
            self.refresh_queue_priorities(now=now_ts)
            return self.get_scan(chosen_id)

    def update_job_progress(
        self,
        scan_id: str,
        status: str,
        progress_pct: float,
        stage_label: str,
        tileset_path: Optional[str] = None,
        obj_path: Optional[str] = None,
    ):
        with DB_LOCK, self._connect() as conn:
            conn.execute(
                """
                UPDATE scans
                SET status = ?,
                    progress_pct = ?,
                    stage_label = ?,
                    tileset_path = CASE WHEN ? IS NOT NULL AND ? != '' THEN ? ELSE tileset_path END,
                    obj_path = CASE WHEN ? IS NOT NULL AND ? != '' THEN ? ELSE obj_path END
                WHERE scan_id = ?
                """,
                (
                    status,
                    float(progress_pct),
                    stage_label,
                    tileset_path,
                    tileset_path,
                    tileset_path,
                    obj_path,
                    obj_path,
                    obj_path,
                    scan_id,
                ),
            )
            conn.commit()

    def set_force_next(self, scan_id: str, force: bool = True) -> Optional[Dict[str, Any]]:
        with DB_LOCK, self._connect() as conn:
            conn.execute(
                "UPDATE scans SET force_next = ? WHERE scan_id = ?",
                (1 if force else 0, scan_id),
            )
            conn.commit()
        self.refresh_queue_priorities()
        return self.get_scan(scan_id)

    def _row_to_dict(self, row: sqlite3.Row) -> Dict[str, Any]:
        d = dict(row)
        try:
            d["bounding_box"] = json.loads(d.get("bounding_box_json") or "{}")
        except Exception:
            d["bounding_box"] = {}
        d["size_mb"] = round(float(d.get("size_bytes", 0)) / (1024 * 1024), 2)
        d["wait_minutes"] = round(max(0.0, (time.time() - float(d.get("uploaded_at", time.time()))) / 60.0), 1)
        return d

    def get_scan(self, scan_id: str) -> Optional[Dict[str, Any]]:
        with DB_LOCK, self._connect() as conn:
            row = conn.execute("SELECT * FROM scans WHERE scan_id = ?", (scan_id,)).fetchone()
            if not row:
                return None
            res = self._row_to_dict(row)
            comments = conn.execute(
                "SELECT * FROM scan_comments WHERE scan_id = ? ORDER BY created_at DESC",
                (scan_id,),
            ).fetchall()
            res["comments"] = [dict(c) for c in comments]
            res["comment_count"] = len(res["comments"])
            return res

    def list_scans(self, project_group: Optional[str] = None) -> List[Dict[str, Any]]:
        self.refresh_queue_priorities()
        with DB_LOCK, self._connect() as conn:
            if project_group:
                rows = conn.execute(
                    "SELECT * FROM scans WHERE project_group = ? ORDER BY capture_date DESC",
                    (project_group,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM scans ORDER BY CASE WHEN status='processing' THEN 0 WHEN status='queued' THEN 1 ELSE 2 END, capture_date DESC"
                ).fetchall()
            comment_counts = dict(
                conn.execute("SELECT scan_id, COUNT(*) FROM scan_comments GROUP BY scan_id").fetchall()
            )
            out = []
            for r in rows:
                item = self._row_to_dict(r)
                item["comment_count"] = comment_counts.get(item["scan_id"], 0)
                out.append(item)
            return out

    def add_comment(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        comment_id = payload.get("comment_id") or f"cmt_{int(time.time()*1000)}"
        created_at = payload.get("created_at") or datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        rec = {
            "comment_id": comment_id,
            "scan_id": payload["scan_id"],
            "author_email": payload.get("author_email", "glibivanov@gatheren.com.tw"),
            "author_name": payload.get("author_name", "Glib Ivanov"),
            "text": payload.get("text", "").strip(),
            "pos_x": float(payload.get("pos_x", 0.0)),
            "pos_y": float(payload.get("pos_y", 0.0)),
            "pos_z": float(payload.get("pos_z", 0.0)),
            "twd97_e": float(payload.get("twd97_e", 0.0)),
            "twd97_n": float(payload.get("twd97_n", 0.0)),
            "twd97_h": float(payload.get("twd97_h", 0.0)),
            "camera_json": json.dumps(payload.get("camera", {})),
            "created_at": created_at,
        }
        with DB_LOCK, self._connect() as conn:
            conn.execute(
                """
                INSERT INTO scan_comments (
                    comment_id, scan_id, author_email, author_name, text,
                    pos_x, pos_y, pos_z, twd97_e, twd97_n, twd97_h, camera_json, created_at
                ) VALUES (
                    :comment_id, :scan_id, :author_email, :author_name, :text,
                    :pos_x, :pos_y, :pos_z, :twd97_e, :twd97_n, :twd97_h, :camera_json, :created_at
                )
                """,
                rec,
            )
            conn.commit()
        return rec

    def delete_comment(self, comment_id: str) -> bool:
        with DB_LOCK, self._connect() as conn:
            cur = conn.execute("DELETE FROM scan_comments WHERE comment_id = ?", (comment_id,))
            conn.commit()
            return cur.rowcount > 0

    def get_user_settings(self, email: str) -> Dict[str, Any]:
        with DB_LOCK, self._connect() as conn:
            row = conn.execute("SELECT * FROM user_settings WHERE email = ?", (email,)).fetchone()
            if not row:
                default = {
                    "email": email,
                    "display_name": email.split("@")[0],
                    "offline_cache_enabled": True,
                    "auto_cache_pinned_groups": ["QuChi Dam", "Rose Park"],
                    "theme_preference": "auto",
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
                return default
            d = dict(row)
            d["offline_cache_enabled"] = bool(d.get("offline_cache_enabled", 1))
            if d.get("theme_preference") not in ("auto", "light", "dark"):
                d["theme_preference"] = "auto"
            try:
                d["auto_cache_pinned_groups"] = json.loads(d.get("auto_cache_pinned_groups") or "[]")
            except Exception:
                d["auto_cache_pinned_groups"] = []
            return d

    def update_user_settings(self, email: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        current = self.get_user_settings(email)
        offline_enabled = 1 if payload.get("offline_cache_enabled", current["offline_cache_enabled"]) else 0
        pinned = payload.get("auto_cache_pinned_groups", current["auto_cache_pinned_groups"])
        display_name = payload.get("display_name", current["display_name"])
        theme_pref = payload.get("theme_preference", current.get("theme_preference", "auto"))
        if theme_pref not in ("auto", "light", "dark"):
            theme_pref = "auto"
        now_iso = datetime.now(timezone.utc).isoformat()
        with DB_LOCK, self._connect() as conn:
            conn.execute(
                """
                INSERT INTO user_settings (email, display_name, offline_cache_enabled, auto_cache_pinned_groups, theme_preference, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(email) DO UPDATE SET
                    display_name=excluded.display_name,
                    offline_cache_enabled=excluded.offline_cache_enabled,
                    auto_cache_pinned_groups=excluded.auto_cache_pinned_groups,
                    theme_preference=excluded.theme_preference,
                    updated_at=excluded.updated_at
                """,
                (email, display_name, offline_enabled, json.dumps(pinned), theme_pref, now_iso),
            )
            conn.commit()
        return self.get_user_settings(email)
