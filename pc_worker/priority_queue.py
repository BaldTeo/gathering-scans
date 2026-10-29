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
import shutil
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
                    covered_area_m2 REAL DEFAULT 0.0,
                    rtk_accuracy_cm REAL DEFAULT 1.8,
                    crs TEXT DEFAULT 'TWD97 (121) + TWVD2001',
                    texture_resolution INTEGER DEFAULT 2048,
                    lat REAL DEFAULT NULL,
                    lon REAL DEFAULT NULL,
                    elev_m REAL DEFAULT 0.0,
                    twd97_e REAL DEFAULT 0.0,
                    twd97_n REAL DEFAULT 0.0,
                    twd97_h REAL DEFAULT 0.0,
                    bounding_box_json TEXT DEFAULT '{}',
                    status TEXT DEFAULT 'queued',
                    progress_pct REAL DEFAULT 0.0,
                    stage_label TEXT DEFAULT 'Queued',
                    bypass_count INTEGER DEFAULT 0,
                    force_next INTEGER DEFAULT 0,
                    priority_score REAL DEFAULT 0.0,
                    notes TEXT DEFAULT '',
                    tileset_version INTEGER DEFAULT 0,
                    extra_json TEXT DEFAULT '{}'
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
                    photos_json TEXT DEFAULT '[]',
                    folder TEXT DEFAULT '',
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

                CREATE TABLE IF NOT EXISTS share_access_sessions (
                    session_id TEXT PRIMARY KEY,
                    token TEXT NOT NULL,
                    visitor_id TEXT DEFAULT '',
                    viewer_name TEXT DEFAULT '',
                    viewer_email TEXT DEFAULT '',
                    ip_address TEXT DEFAULT '',
                    country TEXT DEFAULT '',
                    region TEXT DEFAULT '',
                    city TEXT DEFAULT '',
                    isp TEXT DEFAULT '',
                    user_agent TEXT DEFAULT '',
                    browser TEXT DEFAULT '',
                    os TEXT DEFAULT '',
                    device_type TEXT DEFAULT '',
                    is_bot INTEGER DEFAULT 0,
                    language TEXT DEFAULT '',
                    timezone TEXT DEFAULT '',
                    screen_res TEXT DEFAULT '',
                    viewport_res TEXT DEFAULT '',
                    gpu_renderer TEXT DEFAULT '',
                    connection_type TEXT DEFAULT '',
                    referrer TEXT DEFAULT '',
                    entry_url TEXT DEFAULT '',
                    started_at TEXT NOT NULL,
                    started_ts REAL NOT NULL,
                    last_active_at TEXT NOT NULL,
                    last_active_ts REAL NOT NULL,
                    total_duration_sec REAL DEFAULT 0.0,
                    active_duration_sec REAL DEFAULT 0.0,
                    max_load_pct REAL DEFAULT 0.0,
                    load_time_ms INTEGER DEFAULT 0,
                    camera_interactions INTEGER DEFAULT 0,
                    fp_seconds REAL DEFAULT 0.0,
                    comments_posted INTEGER DEFAULT 0,
                    downloads_count INTEGER DEFAULT 0,
                    measurements_count INTEGER DEFAULT 0,
                    scans_viewed_json TEXT DEFAULT '[]',
                    tools_used_json TEXT DEFAULT '{}',
                    events_json TEXT DEFAULT '[]'
                );

                CREATE INDEX IF NOT EXISTS idx_share_sessions_token
                ON share_access_sessions(token, started_ts DESC);

                CREATE TABLE IF NOT EXISTS ip_geo_cache (
                    ip_address TEXT PRIMARY KEY,
                    country TEXT DEFAULT '',
                    country_code TEXT DEFAULT '',
                    region TEXT DEFAULT '',
                    city TEXT DEFAULT '',
                    isp TEXT DEFAULT '',
                    updated_ts REAL DEFAULT 0.0
                );

                CREATE TABLE IF NOT EXISTS user_settings (
                    email TEXT PRIMARY KEY,
                    display_name TEXT DEFAULT '',
                    offline_cache_enabled INTEGER DEFAULT 1,
                    auto_cache_pinned_groups TEXT DEFAULT '[]',
                    theme_preference TEXT DEFAULT 'auto',
                    language TEXT DEFAULT 'zh-TW',
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

                CREATE TABLE IF NOT EXISTS trashed_scans (
                    scan_id TEXT PRIMARY KEY,
                    name TEXT DEFAULT '',
                    project_group TEXT DEFAULT '',
                    capture_date TEXT DEFAULT '',
                    project_dir TEXT DEFAULT '',
                    size_bytes INTEGER DEFAULT 0,
                    image_count INTEGER DEFAULT 0,
                    trashed_by_email TEXT DEFAULT '',
                    trashed_by_name TEXT DEFAULT '',
                    trashed_at REAL DEFAULT 0.0,
                    scan_json TEXT DEFAULT '{}',
                    comments_json TEXT DEFAULT '[]',
                    tombstone_json TEXT DEFAULT '{}'
                );

                CREATE TABLE IF NOT EXISTS scan_measurement_bookmarks (
                    bookmark_id TEXT PRIMARY KEY,
                    scan_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    author_email TEXT DEFAULT '',
                    author_name TEXT DEFAULT '',
                    state_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_measurement_bookmarks_scan
                ON scan_measurement_bookmarks(scan_id, created_at DESC);
                """
            )
            try:
                conn.execute("ALTER TABLE user_settings ADD COLUMN theme_preference TEXT DEFAULT 'auto'")
            except Exception:
                pass
            try:
                conn.execute("ALTER TABLE user_settings ADD COLUMN language TEXT DEFAULT 'zh-TW'")
            except Exception:
                pass
            try:
                conn.execute("ALTER TABLE scans ADD COLUMN user_edited_name INTEGER DEFAULT 0")
            except Exception:
                pass
            try:
                conn.execute("ALTER TABLE scans ADD COLUMN covered_area_m2 REAL DEFAULT 0.0")
            except Exception:
                pass
            try:
                conn.execute("ALTER TABLE scans ADD COLUMN tileset_version INTEGER DEFAULT 0")
            except Exception:
                pass
            try:
                conn.execute("ALTER TABLE scans ADD COLUMN extra_json TEXT DEFAULT '{}'")
            except Exception:
                pass
            try:
                conn.execute("ALTER TABLE scan_comments ADD COLUMN photos_json TEXT DEFAULT '[]'")
            except Exception:
                pass
            try:
                conn.execute("ALTER TABLE scan_comments ADD COLUMN folder TEXT DEFAULT ''")
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
        covered_area_m2 = float(scan_data.get("covered_area_m2", 0.0))
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

        raw_lat = scan_data.get("lat")
        raw_lon = scan_data.get("lon")
        extra_payload: Dict[str, Any] = {}
        if isinstance(scan_data.get("extra_json"), str) and scan_data["extra_json"].strip() not in ("", "{}"):
            try:
                parsed_ex = json.loads(scan_data["extra_json"])
                if isinstance(parsed_ex, dict):
                    extra_payload.update(parsed_ex)
            except Exception:
                pass
        for ex_k in ("merged_from", "derived_from_scan_id", "applied_adjustments"):
            if ex_k in scan_data and scan_data[ex_k] not in (None, "", [], {}):
                extra_payload[ex_k] = scan_data[ex_k]

        record = {
            "scan_id": scan_data["scan_id"],
            "name": scan_data.get("name", scan_data["scan_id"]),
            "user_edited_name": user_edited_name,
            "project_group": scan_data.get("project_group") or "Unassigned Site",
            "project_name_zh": scan_data.get("project_name_zh") or "",
            "capture_date": scan_data.get("capture_date", datetime.now().strftime("%Y-%m-%d %H:%M")),
            "uploaded_at": uploaded_at,
            "uploader_email": scan_data.get("uploader_email", "engineer@gatheren.cloud"),
            "uploader_name": scan_data.get("uploader_name", "Field Engineer"),
            "source_zip_path": scan_data.get("source_zip_path", ""),
            "project_dir": scan_data.get("project_dir", ""),
            "tileset_path": scan_data.get("tileset_path", ""),
            "obj_path": scan_data.get("obj_path", ""),
            "clear_obj_path": 1
            if (
                scan_data.get("_clear_obj_path")
                or ("obj_path" in scan_data and scan_data.get("status") == "completed" and not scan_data.get("obj_path"))
            )
            else 0,
            "report_path": scan_data.get("report_path", ""),
            "cameras_dir": scan_data.get("cameras_dir", ""),
            "image_count": image_count,
            "size_bytes": size_bytes,
            "covered_area_m2": covered_area_m2,
            "rtk_accuracy_cm": float(scan_data.get("rtk_accuracy_cm", 1.8)),
            "crs": scan_data.get("crs", TWD97_TWVD2001_SHORT),
            "texture_resolution": int(scan_data.get("texture_resolution", PIX4DMATIC_TEXTURE_SIZE)),
            "lat": float(raw_lat) if raw_lat is not None else None,
            "lon": float(raw_lon) if raw_lon is not None else None,
            "elev_m": float(scan_data["elev_m"]) if scan_data.get("elev_m") is not None else 0.0,
            "twd97_e": float(scan_data["twd97_e"]) if scan_data.get("twd97_e") is not None else 0.0,
            "twd97_n": float(scan_data["twd97_n"]) if scan_data.get("twd97_n") is not None else 0.0,
            "twd97_h": float(scan_data["twd97_h"]) if scan_data.get("twd97_h") is not None else 0.0,
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
            "tileset_version": int(scan_data.get("tileset_version") or 0),
            "extra_json": json.dumps(extra_payload, ensure_ascii=False) if extra_payload else "{}",
        }

        with DB_LOCK, self._connect() as conn:
            conn.execute(
                """
                INSERT INTO scans (
                    scan_id, name, user_edited_name, project_group, project_name_zh, capture_date,
                    uploaded_at, uploader_email, uploader_name, source_zip_path,
                    project_dir, tileset_path, obj_path, report_path, cameras_dir,
                    image_count, size_bytes, covered_area_m2, rtk_accuracy_cm, crs, texture_resolution,
                    lat, lon, elev_m, twd97_e, twd97_n, twd97_h, bounding_box_json,
                    status, progress_pct, stage_label, bypass_count, force_next,
                    priority_score, notes, tileset_version, extra_json
                ) VALUES (
                    :scan_id, :name, :user_edited_name, :project_group, :project_name_zh, :capture_date,
                    :uploaded_at, :uploader_email, :uploader_name, :source_zip_path,
                    :project_dir, :tileset_path, :obj_path, :report_path, :cameras_dir,
                    :image_count, :size_bytes, :covered_area_m2, :rtk_accuracy_cm, :crs, :texture_resolution,
                    :lat, :lon, :elev_m, :twd97_e, :twd97_n, :twd97_h, :bounding_box_json,
                    :status, :progress_pct, :stage_label, :bypass_count, :force_next,
                    :priority_score, :notes, :tileset_version, :extra_json
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
                    obj_path=CASE WHEN :clear_obj_path = 1 THEN '' WHEN excluded.obj_path != '' THEN excluded.obj_path ELSE scans.obj_path END,
                    report_path=CASE WHEN excluded.report_path != '' THEN excluded.report_path ELSE scans.report_path END,
                    cameras_dir=CASE WHEN excluded.cameras_dir != '' THEN excluded.cameras_dir ELSE scans.cameras_dir END,
                    image_count=CASE WHEN excluded.image_count > 0 THEN excluded.image_count ELSE scans.image_count END,
                    size_bytes=CASE WHEN excluded.size_bytes > 0 THEN excluded.size_bytes ELSE scans.size_bytes END,
                    covered_area_m2=CASE WHEN excluded.covered_area_m2 > 0 THEN excluded.covered_area_m2 ELSE scans.covered_area_m2 END,
                    rtk_accuracy_cm=excluded.rtk_accuracy_cm,
                    crs=excluded.crs,
                    texture_resolution=excluded.texture_resolution,
                    lat=excluded.lat,
                    lon=excluded.lon,
                    elev_m=excluded.elev_m,
                    twd97_e=excluded.twd97_e,
                    twd97_n=excluded.twd97_n,
                    twd97_h=excluded.twd97_h,
                    bounding_box_json=CASE WHEN excluded.bounding_box_json != '{}' THEN excluded.bounding_box_json ELSE scans.bounding_box_json END,
                    status=excluded.status,
                    progress_pct=excluded.progress_pct,
                    stage_label=excluded.stage_label,
                    priority_score=excluded.priority_score,
                    notes=CASE WHEN excluded.notes != '' THEN excluded.notes ELSE scans.notes END,
                    tileset_version=CASE WHEN excluded.tileset_version > 0 THEN excluded.tileset_version ELSE scans.tileset_version END,
                    extra_json=CASE WHEN excluded.extra_json != '{}' THEN excluded.extra_json ELSE scans.extra_json END
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

    def rename_site(
        self,
        old_project_group: str,
        new_project_group: str,
        new_project_name_zh: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """
        Renames a site (project_group and optional project_name_zh) across all scans in SQLite,
        updates each scan's scan_meta.json on disk, and persists the mapping in data/site_renames.json
        so periodic discovery never reverts the site name.
        """
        old_grp = (old_project_group or "").strip()
        new_grp = (new_project_group or "").strip()
        if not old_grp or not new_grp:
            return []

        with DB_LOCK, self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM scans WHERE project_group = ?", (old_grp,)
            ).fetchall()
            existing_zh = rows[0]["project_name_zh"] if rows else ""
            final_zh = (
                new_project_name_zh.strip()
                if new_project_name_zh is not None and new_project_name_zh.strip()
                else (existing_zh or f"{new_grp} 工程掃描群組")
            )
            conn.execute(
                "UPDATE scans SET project_group = ?, project_name_zh = ? WHERE project_group = ?",
                (new_grp, final_zh, old_grp),
            )
            conn.commit()

        # Persist in data/site_renames.json so gdrive_watcher maps old_grp -> (new_grp, final_zh)
        try:
            ren_file = os.path.join(os.path.dirname(self.db_path), "site_renames.json")
            ren_map: Dict[str, Dict[str, str]] = {}
            if os.path.isfile(ren_file):
                with open(ren_file, "r", encoding="utf-8") as rf:
                    loaded = json.load(rf)
                    if isinstance(loaded, dict):
                        ren_map = loaded
            # Update any transitive mappings pointing to old_grp
            for k, v in list(ren_map.items()):
                if isinstance(v, dict) and v.get("project_group") == old_grp:
                    ren_map[k] = {"project_group": new_grp, "project_name_zh": final_zh}
            ren_map[old_grp] = {"project_group": new_grp, "project_name_zh": final_zh}
            with open(ren_file, "w", encoding="utf-8") as wf:
                json.dump(ren_map, wf, indent=2, ensure_ascii=False)
        except Exception as e:
            print(f"[DB] Warning persisting site_renames.json: {e}")

        updated_scans = [
            s for s in self.list_scans() if s.get("project_group") == new_grp
        ]
        for sc in updated_scans:
            proj_dir = sc.get("project_dir") or ""
            if proj_dir and os.path.isdir(proj_dir):
                meta_file = os.path.join(proj_dir, "scan_meta.json")
                meta: Dict[str, Any] = {}
                if os.path.isfile(meta_file):
                    try:
                        with open(meta_file, "r", encoding="utf-8") as rf:
                            meta = json.load(rf)
                    except Exception:
                        meta = {}
                meta["project_group"] = new_grp
                meta["project_name_zh"] = final_zh
                meta["user_edited_project"] = True
                try:
                    with open(meta_file, "w", encoding="utf-8") as wf:
                        json.dump(meta, wf, indent=2, ensure_ascii=False)
                except Exception as e:
                    print(f"[DB] Warning updating scan_meta.json for site rename {meta_file}: {e}")
        return updated_scans

    def get_deleted_scans_registry_path(self) -> str:
        return os.path.join(os.path.dirname(self.db_path), "deleted_scans.json")

    def load_deleted_scans_registry(self) -> Dict[str, List[str]]:
        reg_path = self.get_deleted_scans_registry_path()
        default_reg: Dict[str, List[str]] = {"scan_ids": [], "folder_names": [], "source_paths": []}
        if not os.path.isfile(reg_path):
            return default_reg
        try:
            with open(reg_path, "r", encoding="utf-8") as rf:
                data = json.load(rf)
            if isinstance(data, dict):
                return {
                    "scan_ids": [str(x).lower() for x in (data.get("scan_ids") or []) if x],
                    "folder_names": [str(x).lower() for x in (data.get("folder_names") or []) if x],
                    "source_paths": [str(x).lower() for x in (data.get("source_paths") or []) if x],
                }
        except Exception:
            pass
        return default_reg

    def _collect_tombstone_keys_for_scan(self, scan: Optional[Dict[str, Any]], clean_id: str) -> Dict[str, List[str]]:
        proj_dir = (scan or {}).get("project_dir") or ""
        src_zip = (scan or {}).get("source_zip_path") or ""
        folder_name = os.path.basename(proj_dir.rstrip("\\/")) if proj_dir else clean_id

        sids = {clean_id.lower()}
        fnames = set()
        spaths = set()
        if folder_name:
            fnames.add(folder_name.lower())
            if folder_name.lower().startswith("catch_"):
                fnames.add(folder_name[6:].lower())
        if src_zip:
            for p in src_zip.split(";"):
                if p.strip():
                    spaths.add(os.path.normcase(os.path.abspath(p.strip())))
                    fnames.add(os.path.basename(p.strip().rstrip("\\/")).lower())
        if proj_dir and os.path.isdir(proj_dir):
            origin_marker = os.path.join(proj_dir, ".gdrive_inbox_origin.json")
            if os.path.isfile(origin_marker):
                try:
                    with open(origin_marker, "r", encoding="utf-8") as mf:
                        om = json.load(mf)
                    if om.get("src_folder"):
                        spaths.add(os.path.normcase(os.path.abspath(om["src_folder"])))
                        fnames.add(os.path.basename(om["src_folder"].rstrip("\\/")).lower())
                except Exception:
                    pass
        return {
            "scan_ids": sorted(sids),
            "folder_names": sorted(fnames),
            "source_paths": sorted(spaths),
        }

    def _save_deleted_scans_registry(self, reg: Dict[str, Any]) -> None:
        try:
            with open(self.get_deleted_scans_registry_path(), "w", encoding="utf-8") as wf:
                json.dump(
                    {
                        "scan_ids": sorted(set(str(x).lower() for x in (reg.get("scan_ids") or []) if x)),
                        "folder_names": sorted(set(str(x).lower() for x in (reg.get("folder_names") or []) if x)),
                        "source_paths": sorted(set(str(x).lower() for x in (reg.get("source_paths") or []) if x)),
                    },
                    wf,
                    indent=2,
                    ensure_ascii=False,
                )
        except Exception as e:
            print(f"[DB] Warning updating deleted_scans.json: {e}")

    def trash_scan(
        self,
        scan_id: str,
        actor_email: str = "",
        actor_name: str = "",
        backup_name_override: Optional[str] = None,
        replaced_by_scan_id: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Soft-deletes a scan by moving its metadata and comments into trashed_scans (Recycle Bin)
        while preserving its local folder in C:\\GatheringScans, .3tz package, and thumbnail on disk.
        Also records tombstone keys in data/deleted_scans.json so GDrive polling does not re-import
        the scan while it is sitting in the Bin.
        """
        clean_id = (scan_id or "").strip()
        if not clean_id:
            return None

        scan = self.get_scan(clean_id)
        if not scan:
            for s in self.list_scans():
                if str(s.get("scan_id") or "").lower() == clean_id.lower():
                    scan = s
                    clean_id = s["scan_id"]
                    break
        if not scan:
            return None

        with DB_LOCK, self._connect() as conn:
            comments = [
                dict(r)
                for r in conn.execute(
                    "SELECT * FROM scan_comments WHERE lower(scan_id) = lower(?)",
                    (clean_id,),
                ).fetchall()
            ]
        tomb = self._collect_tombstone_keys_for_scan(scan, clean_id)
        if replaced_by_scan_id:
            tomb["replaced_by_scan_id"] = str(replaced_by_scan_id).strip()
            tomb["is_edit_backup"] = True

        # Add to deleted_scans.json so GDrive watcher skips it while in Bin
        reg = self.load_deleted_scans_registry()
        reg["scan_ids"] = list(set(reg["scan_ids"]) | set(tomb["scan_ids"]))
        reg["folder_names"] = list(set(reg["folder_names"]) | set(tomb["folder_names"]))
        reg["source_paths"] = list(set(reg["source_paths"]) | set(tomb["source_paths"]))
        self._save_deleted_scans_registry(reg)

        now_ts = time.time()
        size_bytes = int(scan.get("size_bytes") or 0)
        proj_dir = scan.get("project_dir") or ""
        if size_bytes <= 0 and proj_dir and os.path.isdir(proj_dir):
            try:
                total_sz = 0
                for root_d, _, files in os.walk(proj_dir):
                    for fn in files:
                        try:
                            total_sz += os.path.getsize(os.path.join(root_d, fn))
                        except OSError:
                            pass
                size_bytes = total_sz
                scan["size_bytes"] = size_bytes
            except Exception:
                pass

        bin_display_name = (backup_name_override or scan.get("name") or clean_id).strip()

        with DB_LOCK, self._connect() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO trashed_scans (
                    scan_id, name, project_group, capture_date, project_dir,
                    size_bytes, image_count, trashed_by_email, trashed_by_name,
                    trashed_at, scan_json, comments_json, tombstone_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    clean_id,
                    bin_display_name,
                    scan.get("project_group") or "",
                    scan.get("capture_date") or "",
                    proj_dir,
                    size_bytes,
                    int(scan.get("image_count") or 0),
                    actor_email or "",
                    actor_name or actor_email or "User",
                    now_ts,
                    json.dumps(scan, ensure_ascii=False),
                    json.dumps(comments, ensure_ascii=False),
                    json.dumps(tomb, ensure_ascii=False),
                ),
            )
            conn.execute("DELETE FROM scans WHERE lower(scan_id) = lower(?)", (clean_id,))
            conn.execute("DELETE FROM scan_comments WHERE lower(scan_id) = lower(?)", (clean_id,))
            conn.commit()

        return {
            "scan_id": clean_id,
            "name": bin_display_name,
            "original_name": scan.get("name") or clean_id,
            "replaced_by_scan_id": tomb.get("replaced_by_scan_id", ""),
            "is_edit_backup": bool(tomb.get("is_edit_backup")),
            "project_group": scan.get("project_group") or "",
            "capture_date": scan.get("capture_date") or "",
            "size_bytes": size_bytes,
            "image_count": int(scan.get("image_count") or 0),
            "trashed_by_email": actor_email or "",
            "trashed_by_name": actor_name or actor_email or "User",
            "trashed_at": now_ts,
        }

    def get_trashed_scan(self, scan_id: str) -> Optional[Dict[str, Any]]:
        clean_id = (scan_id or "").strip()
        if not clean_id:
            return None
        with DB_LOCK, self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM trashed_scans WHERE lower(scan_id) = lower(?) LIMIT 1",
                (clean_id,),
            ).fetchone()
        if not row:
            return None
        d = dict(row)
        try:
            sc = json.loads(d.get("scan_json") or "{}")
            if not isinstance(sc, dict):
                sc = {}
        except Exception:
            sc = {}
        sc.setdefault("scan_id", d.get("scan_id") or clean_id)
        sc.setdefault("name", d.get("name") or clean_id)
        sc.setdefault("project_group", d.get("project_group") or "")
        sc.setdefault("project_dir", d.get("project_dir") or "")
        return sc

    def clone_comments_to_scan(self, source_scan_id: str, target_scan_id: str, transform_fn=None) -> int:
        src_id = (source_scan_id or "").strip()
        dst_id = (target_scan_id or "").strip()
        if not src_id or not dst_id or src_id.lower() == dst_id.lower():
            return 0
        with DB_LOCK, self._connect() as conn:
            rows = [
                dict(r)
                for r in conn.execute(
                    "SELECT * FROM scan_comments WHERE lower(scan_id) = lower(?)",
                    (src_id,),
                ).fetchall()
            ]
            src_row = conn.execute(
                "SELECT project_dir, extra_json FROM scans WHERE lower(scan_id) = lower(?)", (src_id,)
            ).fetchone()
            dst_row = conn.execute(
                "SELECT project_dir, extra_json FROM scans WHERE lower(scan_id) = lower(?)", (dst_id,)
            ).fetchone()

            src_extra = {}
            dst_extra = {}
            if src_row and src_row["extra_json"]:
                try:
                    src_extra = json.loads(src_row["extra_json"])
                except Exception:
                    pass
            if dst_row and dst_row["extra_json"]:
                try:
                    dst_extra = json.loads(dst_row["extra_json"])
                except Exception:
                    pass

            src_folders = [str(f).strip() for f in (src_extra.get("comment_folders") or []) if str(f).strip()]
            dst_folders = [str(f).strip() for f in (dst_extra.get("comment_folders") or []) if str(f).strip()]
            for f in src_folders:
                if f not in dst_folders:
                    dst_folders.append(f)

            copied = 0
            for idx, c in enumerate(rows):
                orig_cid = str(c.get("comment_id") or f"cmt_{idx}")
                new_cid = f"{orig_cid}_{dst_id[-16:]}"
                px = float(c.get("pos_x") or 0.0)
                py = float(c.get("pos_y") or 0.0)
                pz = float(c.get("pos_z") or 0.0)
                ce = float(c.get("twd97_e") or 0.0)
                cn = float(c.get("twd97_n") or 0.0)
                ch = float(c.get("twd97_h") or 0.0)
                if callable(transform_fn):
                    try:
                        px, py, pz, ce, cn, ch = transform_fn(px, py, pz, ce, cn, ch)
                    except Exception:
                        pass

                folder_val = str(c.get("folder") or "").strip()
                if not folder_val and src_folders:
                    folder_val = src_folders[0]
                if folder_val and folder_val not in dst_folders:
                    dst_folders.append(folder_val)

                conn.execute(
                    """
                    INSERT OR REPLACE INTO scan_comments (
                        comment_id, scan_id, author_email, author_name, text,
                        pos_x, pos_y, pos_z, twd97_e, twd97_n, twd97_h,
                        camera_json, photos_json, folder, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        new_cid,
                        dst_id,
                        c.get("author_email") or "",
                        c.get("author_name") or "User",
                        c.get("text") or "",
                        px,
                        py,
                        pz,
                        ce,
                        cn,
                        ch,
                        c.get("camera_json") or "{}",
                        c.get("photos_json") or json.dumps(c.get("photos") or [], ensure_ascii=False),
                        folder_val,
                        c.get("created_at") or "",
                    ),
                )
                copied += 1

            if dst_row is not None and dst_folders:
                dst_extra["comment_folders"] = dst_folders
                conn.execute(
                    "UPDATE scans SET extra_json = ? WHERE lower(scan_id) = lower(?)",
                    (json.dumps(dst_extra, ensure_ascii=False), dst_id),
                )

            if src_row and dst_row and src_row["project_dir"] and dst_row["project_dir"]:
                src_pdir = os.path.join(str(src_row["project_dir"]), "comment_photos")
                dst_pdir = os.path.join(str(dst_row["project_dir"]), "comment_photos")
                if os.path.isdir(src_pdir):
                    os.makedirs(dst_pdir, exist_ok=True)
                    for fn in os.listdir(src_pdir):
                        sp = os.path.join(src_pdir, fn)
                        dp = os.path.join(dst_pdir, fn)
                        if os.path.isfile(sp) and not os.path.exists(dp):
                            try:
                                shutil.copy2(sp, dp)
                            except Exception:
                                pass

            if copied or dst_folders:
                conn.commit()
        return copied

    def clone_measurement_bookmarks_to_scan(self, source_scan_id: str, target_scan_id: str, transform_fn=None) -> int:
        src_id = (source_scan_id or "").strip()
        dst_id = (target_scan_id or "").strip()
        if not src_id or not dst_id or src_id.lower() == dst_id.lower():
            return 0

        def _tx_pt(pt_obj):
            if not callable(transform_fn) or not isinstance(pt_obj, dict):
                return pt_obj
            if "x" in pt_obj and "y" in pt_obj and "z" in pt_obj:
                try:
                    nx, ny, nz, ne, nn, nh = transform_fn(
                        float(pt_obj.get("x") or 0.0),
                        float(pt_obj.get("y") or 0.0),
                        float(pt_obj.get("z") or 0.0),
                        float(pt_obj.get("twd97_e") or pt_obj.get("e") or 0.0),
                        float(pt_obj.get("twd97_n") or pt_obj.get("n") or 0.0),
                        float(pt_obj.get("twd97_h") or pt_obj.get("h") or 0.0),
                    )
                    pt_obj["x"], pt_obj["y"], pt_obj["z"] = nx, ny, nz
                    if "twd97_e" in pt_obj:
                        pt_obj["twd97_e"], pt_obj["twd97_n"], pt_obj["twd97_h"] = ne, nn, nh
                    if "e" in pt_obj:
                        pt_obj["e"], pt_obj["n"], pt_obj["h"] = ne, nn, nh
                except Exception:
                    pass
            return pt_obj

        def _tx_walk(node):
            if not callable(transform_fn):
                return node
            if isinstance(node, dict):
                _tx_pt(node)
                for k, v in list(node.items()):
                    if isinstance(v, (dict, list)):
                        _tx_walk(v)
            elif isinstance(node, list):
                for item in node:
                    if isinstance(item, (dict, list)):
                        _tx_walk(item)
            return node

        with DB_LOCK, self._connect() as conn:
            try:
                rows = [
                    dict(r)
                    for r in conn.execute(
                        "SELECT * FROM scan_measurement_bookmarks WHERE lower(scan_id) = lower(?)",
                        (src_id,),
                    ).fetchall()
                ]
            except Exception:
                return 0
            copied = 0
            for idx, r in enumerate(rows):
                orig_bid = str(r.get("bookmark_id") or f"bm_{idx}")
                new_bid = f"{orig_bid}_{dst_id[-16:]}"
                state_str = r.get("state_json") or "{}"
                if callable(transform_fn):
                    try:
                        st_obj = json.loads(state_str)
                        _tx_walk(st_obj)
                        state_str = json.dumps(st_obj, ensure_ascii=False)
                    except Exception:
                        pass
                conn.execute(
                    """
                    INSERT OR REPLACE INTO scan_measurement_bookmarks (
                        bookmark_id, scan_id, title, author_email, author_name, state_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        new_bid,
                        dst_id,
                        r.get("title") or "Saved Survey View",
                        r.get("author_email") or "",
                        r.get("author_name") or "User",
                        state_str,
                        r.get("created_at") or "",
                    ),
                )
                copied += 1
            if copied:
                conn.commit()
        return copied

    def list_trashed_scans(self) -> List[Dict[str, Any]]:
        with DB_LOCK, self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM trashed_scans ORDER BY trashed_at DESC"
            ).fetchall()
        items: List[Dict[str, Any]] = []
        for r in rows:
            d = dict(r)
            sid = d.get("scan_id") or ""
            proj_dir = d.get("project_dir") or ""
            d["thumbnail_url"] = f"/api/scans/{sid}/thumbnail"
            d["has_local_files"] = bool(proj_dir and os.path.isdir(proj_dir))
            try:
                sc_j = json.loads(d.get("scan_json") or "{}")
                if isinstance(sc_j, dict) and sc_j.get("name"):
                    d["original_name"] = sc_j["name"]
            except Exception:
                pass
            try:
                tb_j = json.loads(d.get("tombstone_json") or "{}")
                if isinstance(tb_j, dict):
                    d["replaced_by_scan_id"] = tb_j.get("replaced_by_scan_id", "")
                    d["is_edit_backup"] = bool(tb_j.get("is_edit_backup"))
            except Exception:
                pass
            items.append(d)
        return items

    def restore_trashed_scans(self, scan_ids: List[str]) -> List[Dict[str, Any]]:
        """
        Restores one or more scans from trashed_scans back into active scans + scan_comments,
        and removes their temporary tombstone keys from data/deleted_scans.json.
        """
        if not scan_ids:
            return []
        target_lower = {str(s).strip().lower() for s in scan_ids if str(s).strip()}
        if not target_lower:
            return []

        with DB_LOCK, self._connect() as conn:
            all_rows = conn.execute("SELECT * FROM trashed_scans").fetchall()

        to_restore = [dict(r) for r in all_rows if str(r["scan_id"]).lower() in target_lower]
        remaining_trashed = [dict(r) for r in all_rows if str(r["scan_id"]).lower() not in target_lower]
        if not to_restore:
            return []

        # Collect tombstone keys still needed by remaining trashed scans
        keep_sids = set()
        keep_fnames = set()
        keep_spaths = set()
        for rem in remaining_trashed:
            try:
                rt = json.loads(rem.get("tombstone_json") or "{}")
                keep_sids.update(str(x).lower() for x in (rt.get("scan_ids") or []))
                keep_fnames.update(str(x).lower() for x in (rt.get("folder_names") or []))
                keep_spaths.update(str(x).lower() for x in (rt.get("source_paths") or []))
            except Exception:
                pass

        reg = self.load_deleted_scans_registry()
        cur_sids = set(reg["scan_ids"])
        cur_fnames = set(reg["folder_names"])
        cur_spaths = set(reg["source_paths"])

        restored_scans: List[Dict[str, Any]] = []
        for row in to_restore:
            sid = row["scan_id"]
            try:
                tomb = json.loads(row.get("tombstone_json") or "{}")
            except Exception:
                tomb = {}
            for k in (tomb.get("scan_ids") or [sid.lower()]):
                kl = str(k).lower()
                if kl not in keep_sids:
                    cur_sids.discard(kl)
            for k in (tomb.get("folder_names") or []):
                kl = str(k).lower()
                if kl not in keep_fnames:
                    cur_fnames.discard(kl)
            for k in (tomb.get("source_paths") or []):
                kl = str(k).lower()
                if kl not in keep_spaths:
                    cur_spaths.discard(kl)

            try:
                scan_data = json.loads(row.get("scan_json") or "{}")
            except Exception:
                scan_data = {}
            if not scan_data.get("scan_id"):
                scan_data["scan_id"] = sid
                scan_data["name"] = row.get("name") or sid
                scan_data["project_group"] = row.get("project_group") or "Default"
                scan_data["capture_date"] = row.get("capture_date") or ""
                scan_data["project_dir"] = row.get("project_dir") or ""
                scan_data["size_bytes"] = row.get("size_bytes") or 0
                scan_data["image_count"] = row.get("image_count") or 0
                scan_data["status"] = "completed"

            # Disambiguate any active edited scan derived from this backup if both share the exact same name
            replaced_by_id = str(tomb.get("replaced_by_scan_id") or "").strip()
            orig_clean_name = str(scan_data.get("name") or "").strip()
            if replaced_by_id and orig_clean_name:
                existing_edited = self.get_scan(replaced_by_id)
                if existing_edited and str(existing_edited.get("name") or "").strip() == orig_clean_name:
                    try:
                        self.rename_scan(replaced_by_id, f"{orig_clean_name} (Edited)")
                    except Exception:
                        pass

            restored_item = self.upsert_scan(scan_data)
            restored_scans.append(restored_item)

            try:
                comments = json.loads(row.get("comments_json") or "[]")
            except Exception:
                comments = []
            with DB_LOCK, self._connect() as conn:
                for c in comments:
                    if isinstance(c, dict) and c.get("comment_id"):
                        conn.execute(
                            """
                            INSERT OR REPLACE INTO scan_comments (
                                comment_id, scan_id, author_name, author_email, text,
                                pos_x, pos_y, pos_z, twd97_e, twd97_n, twd97_h, camera_json, photos_json, created_at
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            """,
                            (
                                c.get("comment_id"),
                                sid,
                                c.get("author_name") or "User",
                                c.get("author_email") or "",
                                c.get("text") or "",
                                float(c.get("pos_x") or 0.0),
                                float(c.get("pos_y") or 0.0),
                                float(c.get("pos_z") or 0.0),
                                float(c.get("twd97_e") or 0.0),
                                float(c.get("twd97_n") or 0.0),
                                float(c.get("twd97_h") or 0.0),
                                c.get("camera_json") or "{}",
                                c.get("photos_json") or json.dumps(c.get("photos") or [], ensure_ascii=False),
                                c.get("created_at") or "",
                            ),
                        )
                conn.execute("DELETE FROM trashed_scans WHERE lower(scan_id) = lower(?)", (sid,))
                conn.commit()

        self._save_deleted_scans_registry(
            {
                "scan_ids": list(cur_sids),
                "folder_names": list(cur_fnames),
                "source_paths": list(cur_spaths),
            }
        )
        return restored_scans

    def purge_trashed_scans(self, scan_ids: Optional[List[str]] = None, clear_all: bool = False) -> List[str]:
        """
        Permanently deletes selected scans (or all scans if clear_all=True) from the Recycle Bin,
        wiping their local folder in C:\\GatheringScans, cached thumbnail, and .3tz package, while
        keeping their tombstone in data/deleted_scans.json so GDrive polling never re-imports them.
        """
        import shutil
        from pc_worker.config import LOCAL_SCANS_ROOT

        with DB_LOCK, self._connect() as conn:
            all_rows = [dict(r) for r in conn.execute("SELECT * FROM trashed_scans").fetchall()]

        if clear_all:
            targets = all_rows
        else:
            target_set = {str(s).strip().lower() for s in (scan_ids or []) if str(s).strip()}
            targets = [r for r in all_rows if str(r.get("scan_id") or "").lower() in target_set]

        if not targets:
            return []

        reg = self.load_deleted_scans_registry()
        sids = set(reg["scan_ids"])
        fnames = set(reg["folder_names"])
        spaths = set(reg["source_paths"])

        purged_ids: List[str] = []
        data_dir = os.path.dirname(self.db_path)
        active_scans_snapshot = self.list_scans()

        for row in targets:
            clean_id = row["scan_id"]
            purged_ids.append(clean_id)
            proj_dir = row.get("project_dir") or ""
            try:
                scan_dict = json.loads(row.get("scan_json") or "{}")
            except Exception:
                scan_dict = {"scan_id": clean_id, "project_dir": proj_dir}

            tomb = self._collect_tombstone_keys_for_scan(scan_dict, clean_id)
            sids.update(tomb["scan_ids"])
            fnames.update(tomb["folder_names"])
            spaths.update(tomb["source_paths"])

            # Delete local folder inside C:\GatheringScans (strictly jailed)
            candidates_to_remove = []
            if proj_dir:
                candidates_to_remove.append(proj_dir)
            if LOCAL_SCANS_ROOT:
                candidates_to_remove.append(os.path.join(LOCAL_SCANS_ROOT, clean_id))
            for cand_dir in candidates_to_remove:
                try:
                    if cand_dir and os.path.isdir(cand_dir) and LOCAL_SCANS_ROOT:
                        abs_root = os.path.normcase(os.path.abspath(LOCAL_SCANS_ROOT))
                        abs_cand = os.path.normcase(os.path.abspath(cand_dir))
                        if abs_cand.startswith(abs_root + os.sep) and abs_cand != abs_root:
                            # Preserve inherited cameras_dir if any active edited/merged scan still points inside cand_dir
                            for act_sc in active_scans_snapshot:
                                act_cam = str(act_sc.get("cameras_dir") or "").strip()
                                act_pdir = str(act_sc.get("project_dir") or "").strip()
                                if act_cam and act_pdir and os.path.isdir(act_cam) and os.path.isdir(act_pdir):
                                    abs_cam = os.path.normcase(os.path.abspath(act_cam))
                                    if abs_cam == abs_cand or abs_cam.startswith(abs_cand + os.sep):
                                        try:
                                            relocated_cam = os.path.join(act_pdir, "inputs")
                                            if not os.path.isdir(relocated_cam):
                                                shutil.copytree(act_cam, relocated_cam)
                                            act_sc["cameras_dir"] = relocated_cam
                                            self.upsert_scan(act_sc)
                                            act_meta = os.path.join(act_pdir, "scan_meta.json")
                                            if os.path.isfile(act_meta):
                                                with open(act_meta, "r", encoding="utf-8") as mf_r:
                                                    mj = json.load(mf_r)
                                                mj["cameras_dir"] = relocated_cam
                                                with open(act_meta, "w", encoding="utf-8") as mf_w:
                                                    json.dump(mj, mf_w, indent=2, ensure_ascii=False)
                                        except Exception as ce:
                                            print(f"[DB] Note relocating shared cameras_dir for {act_sc.get('scan_id')}: {ce}")
                            shutil.rmtree(cand_dir, ignore_errors=True)
                except Exception as e:
                    print(f"[DB] Warning removing folder {cand_dir}: {e}")

            # Remove cached thumbnail & .3tz stream package
            for rel_rm in (
                os.path.join(data_dir, "thumbnails", f"{clean_id}.png"),
                os.path.join(data_dir, "thumbnails", f"{clean_id.lower()}.png"),
                os.path.join(data_dir, "stream_packages", f"{clean_id}.3tz"),
                os.path.join(data_dir, "stream_packages", f"{clean_id.lower()}.3tz"),
            ):
                try:
                    if os.path.isfile(rel_rm):
                        os.remove(rel_rm)
                except OSError:
                    pass

            with DB_LOCK, self._connect() as conn:
                conn.execute("DELETE FROM trashed_scans WHERE lower(scan_id) = lower(?)", (clean_id,))
                conn.execute("DELETE FROM scans WHERE lower(scan_id) = lower(?)", (clean_id,))
                conn.execute("DELETE FROM scan_comments WHERE lower(scan_id) = lower(?)", (clean_id,))
                conn.commit()

        self._save_deleted_scans_registry(
            {"scan_ids": list(sids), "folder_names": list(fnames), "source_paths": list(spaths)}
        )
        return purged_ids

    def delete_scan(self, scan_id: str) -> Optional[Dict[str, Any]]:
        """
        Permanently deletes a scan immediately (bypassing Bin if called directly, or purges if in Bin).
        """
        trashed = self.trash_scan(scan_id, actor_email="system", actor_name="System")
        self.purge_trashed_scans(scan_ids=[scan_id], clear_all=False)
        return trashed or {"scan_id": scan_id, "name": scan_id}

    def refresh_queue_priorities(self, now: Optional[float] = None) -> List[Dict[str, Any]]:
        """Recalculates dynamic WSJF-Aging priority scores for all queued jobs."""
        now_ts = now if now is not None else time.time()
        with DB_LOCK, self._connect() as conn:
            rows = conn.execute("SELECT * FROM scans WHERE status = 'queued'").fetchall()
            if not rows:
                return []
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

    def prioritize_scan_next(self, scan_id: str) -> Optional[Dict[str, Any]]:
        clean_id = (scan_id or "").strip()
        if not clean_id:
            return None
        with DB_LOCK, self._connect() as conn:
            conn.execute(
                "UPDATE scans SET force_next = 0 WHERE scan_id != ?",
                (clean_id,),
            )
            conn.execute(
                "UPDATE scans SET force_next = 1, priority_score = 9999.0 WHERE scan_id = ?",
                (clean_id,),
            )
            conn.commit()
        self.refresh_queue_priorities()
        return self.get_scan(clean_id)

    def _row_to_dict(self, row: sqlite3.Row) -> Dict[str, Any]:
        d = dict(row)
        try:
            d["bounding_box"] = json.loads(d.get("bounding_box_json") or "{}")
        except Exception:
            d["bounding_box"] = {}
        extra_raw = d.get("extra_json") or "{}"
        extra_dict: Dict[str, Any] = {}
        if isinstance(extra_raw, str) and extra_raw.strip() not in ("", "{}"):
            try:
                parsed_ex = json.loads(extra_raw)
                if isinstance(parsed_ex, dict):
                    extra_dict = parsed_ex
            except Exception:
                pass
        elif d.get("project_dir") and str(d.get("scan_id") or "").startswith(("merged_", "edited_")):
            meta_fp = os.path.join(str(d["project_dir"]), "scan_meta.json")
            if os.path.isfile(meta_fp):
                try:
                    with open(meta_fp, "r", encoding="utf-8") as mf:
                        m_obj = json.load(mf)
                    if isinstance(m_obj, dict):
                        for ex_k in ("merged_from", "derived_from_scan_id", "applied_adjustments"):
                            if ex_k in m_obj and m_obj[ex_k] not in (None, "", [], {}):
                                extra_dict[ex_k] = m_obj[ex_k]
                        if not d.get("tileset_version") and m_obj.get("tileset_version"):
                            d["tileset_version"] = int(m_obj["tileset_version"])
                except Exception:
                    pass
        for ex_k in ("merged_from", "derived_from_scan_id", "applied_adjustments"):
            if ex_k in extra_dict:
                d[ex_k] = extra_dict[ex_k]
        raw_folders = extra_dict.get("comment_folders")
        if isinstance(raw_folders, list):
            d["comment_folders"] = [str(f).strip() for f in raw_folders if str(f).strip()]
        else:
            d["comment_folders"] = []
        d["size_mb"] = round(float(d.get("size_bytes", 0)) / (1024 * 1024), 2)
        wait_m = max(0.0, (time.time() - float(d.get("uploaded_at", time.time()))) / 60.0)
        d["wait_minutes"] = round(wait_m, 1)
        if d.get("status") == "queued":
            d["priority_score"] = calculate_priority_score(
                image_count=int(d.get("image_count") or 0),
                size_mb=float(d.get("size_bytes") or 0) / (1024 * 1024),
                wait_minutes=wait_m,
                bypass_count=int(d.get("bypass_count") or 0),
                force_next=int(d.get("force_next") or 0),
            )
        return d

    def _bookmark_row_to_dict(self, row: Any) -> Dict[str, Any]:
        d = dict(row)
        raw_st = d.get("state_json") or "{}"
        try:
            parsed_st = json.loads(raw_st) if isinstance(raw_st, str) else raw_st
            d["state"] = parsed_st if isinstance(parsed_st, dict) else {}
        except Exception:
            d["state"] = {}
        st = d["state"]
        d["camera_state"] = st.get("camera_state") or st.get("camera") or {}
        d["measurements_state"] = st.get("measurements_state") or st
        return d

    @staticmethod
    def _normalize_comment_photos(raw_photos: Any) -> List[Dict[str, Any]]:
        if not raw_photos:
            return []
        if isinstance(raw_photos, str):
            try:
                raw_photos = json.loads(raw_photos)
            except Exception:
                return []
        if not isinstance(raw_photos, list):
            return []
        out: List[Dict[str, Any]] = []
        seen_urls = set()
        for item in raw_photos:
            if isinstance(item, str) and item.strip():
                u = item.strip()
                if u not in seen_urls:
                    seen_urls.add(u)
                    fn = u.split("/")[-1].split("?")[0] or "photo.jpg"
                    out.append({"url": u, "filename": fn})
            elif isinstance(item, dict):
                u = str(item.get("url") or item.get("src") or item.get("data_url") or "").strip()
                if u and u not in seen_urls:
                    seen_urls.add(u)
                    fn = str(item.get("filename") or item.get("name") or u.split("/")[-1].split("?")[0] or "photo.jpg").strip()
                    p_obj: Dict[str, Any] = {"url": u, "filename": fn}
                    if item.get("id") is not None:
                        p_obj["id"] = str(item.get("id"))
                    for coord_key in ("camera_twd97_e", "camera_twd97_n", "camera_twd97_h", "distance_m", "proj_u", "proj_v"):
                        if item.get(coord_key) is not None:
                            try:
                                p_obj[coord_key] = float(item.get(coord_key))
                            except (TypeError, ValueError):
                                pass
                    if isinstance(item.get("target_uv"), dict):
                        tu = item.get("target_uv") or {}
                        try:
                            p_obj["target_uv"] = {
                                "u": float(tu.get("u", 0.5)),
                                "v": float(tu.get("v", 0.5)),
                                "in_fov": bool(tu.get("in_fov", True)),
                            }
                        except (TypeError, ValueError):
                            pass
                    if item.get("rtk_h_sigma_cm") is not None:
                        p_obj["rtk_h_sigma_cm"] = item.get("rtk_h_sigma_cm")
                    elif item.get("rtk_sigma_cm") is not None:
                        p_obj["rtk_h_sigma_cm"] = item.get("rtk_sigma_cm")
                    for meta_key in (
                        "gdrive_file_id",
                        "gdrive_url",
                        "gdrive_path",
                        "gdrive_synced",
                        "storage",
                        "source",
                        "mime_type",
                        "size_bytes",
                        "uploaded_at",
                    ):
                        if item.get(meta_key) is not None:
                            p_obj[meta_key] = item.get(meta_key)
                    out.append(p_obj)
        return out

    def _comment_row_to_dict(self, row: Any) -> Dict[str, Any]:
        d = dict(row)
        photos = self._normalize_comment_photos(d.get("photos_json"))
        if not photos and d.get("camera_json"):
            try:
                cam_obj = json.loads(d["camera_json"]) if isinstance(d["camera_json"], str) else d["camera_json"]
                if isinstance(cam_obj, dict) and cam_obj.get("photos"):
                    photos = self._normalize_comment_photos(cam_obj.get("photos"))
            except Exception:
                pass
        d["photos"] = photos
        d["photos_json"] = json.dumps(photos, ensure_ascii=False)
        d["folder"] = str(d.get("folder") or "").strip()
        return d

    @staticmethod
    def _merge_comment_folder_names(existing_folders: Any, comments: List[Dict[str, Any]]) -> List[str]:
        merged: List[str] = []
        seen = set()
        for f in (existing_folders if isinstance(existing_folders, list) else []):
            fn = str(f or "").strip()
            if fn and fn not in seen:
                seen.add(fn)
                merged.append(fn)
        for c in (comments or []):
            fn = str((c or {}).get("folder") or "").strip()
            if fn and fn not in seen:
                seen.add(fn)
                merged.append(fn)
        return merged

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
            res["comments"] = [self._comment_row_to_dict(c) for c in comments]
            res["comment_count"] = len(res["comments"])
            res["comment_folders"] = self._merge_comment_folder_names(res.get("comment_folders"), res["comments"])
            bms = conn.execute(
                "SELECT * FROM scan_measurement_bookmarks WHERE scan_id = ? ORDER BY created_at DESC",
                (scan_id,),
            ).fetchall()
            res["measurement_bookmarks"] = [self._bookmark_row_to_dict(b) for b in bms]
            res["bookmark_count"] = len(res["measurement_bookmarks"])
            return res

    def list_scans(self, project_group: Optional[str] = None) -> List[Dict[str, Any]]:
        with DB_LOCK, self._connect() as conn:
            if project_group:
                rows = conn.execute(
                    "SELECT * FROM scans WHERE project_group = ? ORDER BY capture_date DESC",
                    (project_group,),
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT * FROM scans
                    ORDER BY
                      CASE
                        WHEN status = 'processing' THEN 0
                        WHEN status = 'queued' THEN 1
                        WHEN status = 'waiting_parts' THEN 2
                        ELSE 3
                      END ASC,
                      CASE WHEN status = 'queued' THEN COALESCE(force_next, 0) END DESC,
                      CASE WHEN status = 'queued' THEN priority_score END DESC,
                      CASE WHEN status = 'queued' THEN uploaded_at END ASC,
                      capture_date DESC
                    """
                ).fetchall()
            all_comments = conn.execute(
                "SELECT * FROM scan_comments ORDER BY created_at DESC"
            ).fetchall()
            comments_by_scan: Dict[str, List[Dict[str, Any]]] = {}
            for c_row in all_comments:
                c_dict = self._comment_row_to_dict(c_row)
                sid_c = str(c_dict.get("scan_id") or "")
                comments_by_scan.setdefault(sid_c, []).append(c_dict)

            all_bms = conn.execute(
                "SELECT * FROM scan_measurement_bookmarks ORDER BY created_at DESC"
            ).fetchall()
            bms_by_scan: Dict[str, List[Dict[str, Any]]] = {}
            for b_row in all_bms:
                b_dict = self._bookmark_row_to_dict(b_row)
                sid_b = str(b_dict.get("scan_id") or "")
                bms_by_scan.setdefault(sid_b, []).append(b_dict)

            out = []
            for r in rows:
                item = self._row_to_dict(r)
                sid_item = item["scan_id"]
                cmts = comments_by_scan.get(sid_item, [])
                item["comments"] = cmts
                item["comment_count"] = len(cmts)
                item["comment_folders"] = self._merge_comment_folder_names(item.get("comment_folders"), cmts)
                bms = bms_by_scan.get(sid_item, [])
                item["measurement_bookmarks"] = bms
                item["bookmark_count"] = len(bms)
                out.append(item)
            if not project_group:
                out.sort(
                    key=lambda x: (
                        0
                        if x.get("status") == "processing"
                        else (1 if x.get("status") == "queued" else (2 if x.get("status") == "waiting_parts" else 3)),
                        -int(x.get("force_next") or 0) if x.get("status") == "queued" else 0,
                        -float(x.get("priority_score") or 0.0) if x.get("status") == "queued" else 0.0,
                        float(x.get("uploaded_at") or 0.0) if x.get("status") == "queued" else 0.0,
                    )
                )
            return out

    def list_measurement_bookmarks(self, scan_id: str) -> List[Dict[str, Any]]:
        clean_id = (scan_id or "").strip()
        if not clean_id:
            return []
        with DB_LOCK, self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM scan_measurement_bookmarks WHERE scan_id = ? ORDER BY created_at DESC",
                (clean_id,),
            ).fetchall()
            return [self._bookmark_row_to_dict(r) for r in rows]

    def save_measurement_bookmark(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        scan_id = str(payload.get("scan_id") or "").strip()
        if not scan_id:
            raise ValueError("scan_id is required")
        bookmark_id = str(payload.get("bookmark_id") or f"bmk_{int(time.time() * 1000)}").strip()
        title = str(payload.get("title") or payload.get("name") or "Saved Survey View").strip()
        author_email = str(payload.get("author_email") or "glibivanov@gatheren.com.tw").strip()
        author_name = str(payload.get("author_name") or "雲在天").strip()
        created_at = str(payload.get("created_at") or datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"))

        raw_state = payload.get("state")
        if not isinstance(raw_state, dict):
            raw_json = payload.get("state_json")
            if isinstance(raw_json, str) and raw_json.strip():
                try:
                    raw_state = json.loads(raw_json)
                except Exception:
                    raw_state = {}
            else:
                raw_state = {
                    "completed_measurements": payload.get("completed_measurements") or [],
                    "last_volume_result": payload.get("last_volume_result"),
                    "cut_fill_polygon_points": payload.get("cut_fill_polygon_points") or [],
                    "last_profile_result": payload.get("last_profile_result"),
                    "profile_endpoints": payload.get("profile_endpoints") or [],
                    "camera": payload.get("camera") or payload.get("camera_state") or {},
                    "camera_state": payload.get("camera_state") or payload.get("camera") or {},
                    "measurements_state": payload.get("measurements_state") or {},
                    "active_tool": payload.get("active_tool") or "distance",
                }
        state_json = json.dumps(raw_state, ensure_ascii=False)
        rec = {
            "bookmark_id": bookmark_id,
            "scan_id": scan_id,
            "title": title,
            "author_email": author_email,
            "author_name": author_name,
            "state_json": state_json,
            "created_at": created_at,
        }
        with DB_LOCK, self._connect() as conn:
            conn.execute(
                """
                INSERT INTO scan_measurement_bookmarks (
                    bookmark_id, scan_id, title, author_email, author_name, state_json, created_at
                ) VALUES (
                    :bookmark_id, :scan_id, :title, :author_email, :author_name, :state_json, :created_at
                )
                ON CONFLICT(bookmark_id) DO UPDATE SET
                    title = excluded.title,
                    author_email = excluded.author_email,
                    author_name = excluded.author_name,
                    state_json = excluded.state_json,
                    created_at = excluded.created_at
                """,
                rec,
            )
            conn.commit()
        return self._bookmark_row_to_dict(rec)

    def delete_measurement_bookmark(self, bookmark_id: str, scan_id: Optional[str] = None) -> bool:
        clean_id = (bookmark_id or "").strip()
        if not clean_id:
            return False
        with DB_LOCK, self._connect() as conn:
            if scan_id:
                cur = conn.execute(
                    "DELETE FROM scan_measurement_bookmarks WHERE bookmark_id = ? AND scan_id = ?",
                    (clean_id, scan_id.strip()),
                )
            else:
                cur = conn.execute(
                    "DELETE FROM scan_measurement_bookmarks WHERE bookmark_id = ?",
                    (clean_id,),
                )
            conn.commit()
            return cur.rowcount > 0

    def _get_scan_extra_dict(self, conn: sqlite3.Connection, scan_id: str) -> Dict[str, Any]:
        row = conn.execute("SELECT extra_json FROM scans WHERE scan_id = ?", (scan_id,)).fetchone()
        if not row:
            return {}
        raw = row["extra_json"] or "{}"
        try:
            d = json.loads(raw)
            return d if isinstance(d, dict) else {}
        except Exception:
            return {}

    def _save_scan_extra_dict(self, conn: sqlite3.Connection, scan_id: str, extra_dict: Dict[str, Any]) -> None:
        raw_json = json.dumps(extra_dict, ensure_ascii=False)
        cur = conn.execute(
            "UPDATE scans SET extra_json = ? WHERE scan_id = ?",
            (raw_json, scan_id),
        )
        if cur.rowcount == 0:
            conn.execute(
                """
                INSERT OR IGNORE INTO scans (
                    scan_id, name, project_group, capture_date, uploaded_at, uploader_email, uploader_name, status, extra_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?)
                """,
                (scan_id, scan_id, scan_id, "2026-10-26", time.time(), "system@gatheren.cloud", "System", raw_json),
            )

    def list_comment_folders(self, scan_id: str) -> List[str]:
        clean_sid = str(scan_id or "").strip()
        if not clean_sid:
            return []
        with DB_LOCK, self._connect() as conn:
            ex = self._get_scan_extra_dict(conn, clean_sid)
            rows = conn.execute(
                "SELECT folder FROM scan_comments WHERE scan_id = ? ORDER BY created_at DESC",
                (clean_sid,),
            ).fetchall()
            cmts = [{"folder": r["folder"]} for r in rows]
            return self._merge_comment_folder_names(ex.get("comment_folders"), cmts)

    def create_comment_folder(self, scan_id: str, folder_name: str) -> List[str]:
        clean_sid = str(scan_id or "").strip()
        clean_name = str(folder_name or "").strip()
        if not clean_sid:
            return []
        if not clean_name:
            return self.list_comment_folders(clean_sid)
        with DB_LOCK, self._connect() as conn:
            ex = self._get_scan_extra_dict(conn, clean_sid)
            cur = [str(f).strip() for f in (ex.get("comment_folders") or []) if str(f).strip()]
            if clean_name not in cur:
                cur.append(clean_name)
                ex["comment_folders"] = cur
                self._save_scan_extra_dict(conn, clean_sid, ex)
                conn.commit()
        return self.list_comment_folders(clean_sid)

    def rename_comment_folder(self, scan_id: str, old_name: str, new_name: str) -> List[str]:
        clean_sid = str(scan_id or "").strip()
        clean_old = str(old_name or "").strip()
        clean_new = str(new_name or "").strip()
        if not clean_sid or not clean_old or not clean_new or clean_old == clean_new:
            return self.list_comment_folders(clean_sid)
        with DB_LOCK, self._connect() as conn:
            conn.execute(
                "UPDATE scan_comments SET folder = ? WHERE scan_id = ? AND folder = ?",
                (clean_new, clean_sid, clean_old),
            )
            ex = self._get_scan_extra_dict(conn, clean_sid)
            cur = [str(f).strip() for f in (ex.get("comment_folders") or []) if str(f).strip()]
            updated = []
            seen = set()
            replaced = False
            for f in cur:
                val = clean_new if f == clean_old else f
                if val == clean_new:
                    replaced = True
                if val not in seen:
                    seen.add(val)
                    updated.append(val)
            if not replaced and clean_new not in seen:
                updated.append(clean_new)
            ex["comment_folders"] = updated
            self._save_scan_extra_dict(conn, clean_sid, ex)
            conn.commit()
        return self.list_comment_folders(clean_sid)

    def delete_comment_folder(self, scan_id: str, folder_name: str) -> List[str]:
        clean_sid = str(scan_id or "").strip()
        clean_name = str(folder_name or "").strip()
        if not clean_sid or not clean_name:
            return self.list_comment_folders(clean_sid)
        with DB_LOCK, self._connect() as conn:
            conn.execute(
                "UPDATE scan_comments SET folder = '' WHERE scan_id = ? AND folder = ?",
                (clean_sid, clean_name),
            )
            ex = self._get_scan_extra_dict(conn, clean_sid)
            cur = [str(f).strip() for f in (ex.get("comment_folders") or []) if str(f).strip()]
            ex["comment_folders"] = [f for f in cur if f != clean_name]
            self._save_scan_extra_dict(conn, clean_sid, ex)
            conn.commit()
        return self.list_comment_folders(clean_sid)

    def add_comment(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        comment_id = payload.get("comment_id") or f"cmt_{int(time.time()*1000)}"
        created_at = payload.get("created_at") or datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        photos = self._normalize_comment_photos(payload.get("photos") or payload.get("photos_json"))
        folder_val = str(payload.get("folder") or "").strip()
        rec = {
            "comment_id": comment_id,
            "scan_id": payload["scan_id"],
            "author_email": payload.get("author_email", "glibivanov@gatheren.com.tw"),
            "author_name": payload.get("author_name", "雲在天"),
            "text": payload.get("text", "").strip(),
            "pos_x": float(payload.get("pos_x", 0.0)),
            "pos_y": float(payload.get("pos_y", 0.0)),
            "pos_z": float(payload.get("pos_z", 0.0)),
            "twd97_e": float(payload.get("twd97_e", 0.0)),
            "twd97_n": float(payload.get("twd97_n", 0.0)),
            "twd97_h": float(payload.get("twd97_h", 0.0)),
            "camera_json": json.dumps(payload.get("camera", {})),
            "photos_json": json.dumps(photos, ensure_ascii=False),
            "folder": folder_val,
            "created_at": created_at,
        }
        with DB_LOCK, self._connect() as conn:
            conn.execute(
                """
                INSERT INTO scan_comments (
                    comment_id, scan_id, author_email, author_name, text,
                    pos_x, pos_y, pos_z, twd97_e, twd97_n, twd97_h, camera_json, photos_json, folder, created_at
                ) VALUES (
                    :comment_id, :scan_id, :author_email, :author_name, :text,
                    :pos_x, :pos_y, :pos_z, :twd97_e, :twd97_n, :twd97_h, :camera_json, :photos_json, :folder, :created_at
                )
                """,
                rec,
            )
            if folder_val:
                ex = self._get_scan_extra_dict(conn, str(payload["scan_id"]))
                cur_f = [str(f).strip() for f in (ex.get("comment_folders") or []) if str(f).strip()]
                if folder_val not in cur_f:
                    cur_f.append(folder_val)
                    ex["comment_folders"] = cur_f
                    self._save_scan_extra_dict(conn, str(payload["scan_id"]), ex)
            conn.commit()
        return self._comment_row_to_dict(rec)

    def list_comments(self, scan_id: str) -> List[Dict[str, Any]]:
        with DB_LOCK, self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM scan_comments WHERE scan_id = ? ORDER BY created_at DESC",
                (scan_id,),
            ).fetchall()
            return [self._comment_row_to_dict(r) for r in rows]

    def get_comment(self, comment_id: str) -> Optional[Dict[str, Any]]:
        with DB_LOCK, self._connect() as conn:
            row = conn.execute("SELECT * FROM scan_comments WHERE comment_id = ?", (comment_id,)).fetchone()
            return self._comment_row_to_dict(row) if row else None

    def update_comment(
        self,
        comment_id: str,
        text: Optional[str] = None,
        author_name: Optional[str] = None,
        photos: Optional[Any] = None,
        append_photos: Optional[Any] = None,
        folder: Optional[str] = None,
        pos_x: Optional[float] = None,
        pos_y: Optional[float] = None,
        pos_z: Optional[float] = None,
        twd97_e: Optional[float] = None,
        twd97_n: Optional[float] = None,
        twd97_h: Optional[float] = None,
    ) -> Optional[Dict[str, Any]]:
        if not comment_id:
            return None
        with DB_LOCK, self._connect() as conn:
            existing_row = conn.execute(
                "SELECT * FROM scan_comments WHERE comment_id = ?", (comment_id,)
            ).fetchone()
            if not existing_row:
                return None
            existing_dict = self._comment_row_to_dict(existing_row)
            clean_text = (text or "").strip() if text is not None else ""
            final_text = clean_text if clean_text else str(existing_dict.get("text") or "").strip()
            has_pos = any(v is not None for v in (pos_x, pos_y, pos_z, twd97_e, twd97_n, twd97_h))
            if not final_text and photos is None and append_photos is None and folder is None and not has_pos:
                return None
            final_author = (
                author_name.strip()
                if author_name and author_name.strip()
                else str(existing_dict.get("author_name") or "雲在天")
            )
            cur_photos = list(existing_dict.get("photos") or [])
            if photos is not None:
                cur_photos = self._normalize_comment_photos(photos)
            if append_photos is not None:
                extra_photos = self._normalize_comment_photos(append_photos)
                cur_photos = self._normalize_comment_photos(cur_photos + extra_photos)
            photos_json_str = json.dumps(cur_photos, ensure_ascii=False)
            final_folder = (
                str(folder).strip()
                if folder is not None
                else str(existing_dict.get("folder") or "").strip()
            )
            final_px = float(pos_x) if pos_x is not None else float(existing_dict.get("pos_x") or 0.0)
            final_py = float(pos_y) if pos_y is not None else float(existing_dict.get("pos_y") or 0.0)
            final_pz = float(pos_z) if pos_z is not None else float(existing_dict.get("pos_z") or 0.0)
            final_e = float(twd97_e) if twd97_e is not None else float(existing_dict.get("twd97_e") or 0.0)
            final_n = float(twd97_n) if twd97_n is not None else float(existing_dict.get("twd97_n") or 0.0)
            final_h = float(twd97_h) if twd97_h is not None else float(existing_dict.get("twd97_h") or 0.0)
            conn.execute(
                """
                UPDATE scan_comments
                SET text = ?, author_name = ?, photos_json = ?, folder = ?,
                    pos_x = ?, pos_y = ?, pos_z = ?, twd97_e = ?, twd97_n = ?, twd97_h = ?
                WHERE comment_id = ?
                """,
                (
                    final_text,
                    final_author,
                    photos_json_str,
                    final_folder,
                    final_px,
                    final_py,
                    final_pz,
                    final_e,
                    final_n,
                    final_h,
                    comment_id,
                ),
            )
            if final_folder and existing_dict.get("scan_id"):
                sid_u = str(existing_dict["scan_id"])
                ex = self._get_scan_extra_dict(conn, sid_u)
                cur_f = [str(f).strip() for f in (ex.get("comment_folders") or []) if str(f).strip()]
                if final_folder not in cur_f:
                    cur_f.append(final_folder)
                    ex["comment_folders"] = cur_f
                    self._save_scan_extra_dict(conn, sid_u, ex)
            conn.commit()
            row = conn.execute("SELECT * FROM scan_comments WHERE comment_id = ?", (comment_id,)).fetchone()
            return self._comment_row_to_dict(row) if row else None

    def delete_comment(self, comment_id: str) -> bool:
        with DB_LOCK, self._connect() as conn:
            cur = conn.execute("DELETE FROM scan_comments WHERE comment_id = ?", (comment_id,))
            conn.commit()
            return cur.rowcount > 0

    def _user_prefs_json_path(self) -> str:
        return os.path.join(os.path.dirname(self.db_path), "user_preferences.json")

    def _load_user_prefs_json(self) -> Dict[str, Any]:
        p = self._user_prefs_json_path()
        if os.path.isfile(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if isinstance(data, dict):
                        return data
            except Exception:
                pass
        return {}

    def _save_user_prefs_json_entry(self, email: str, entry: Dict[str, Any]) -> None:
        clean = (email or "").strip().lower()
        if not clean:
            return
        p = self._user_prefs_json_path()
        try:
            os.makedirs(os.path.dirname(p), exist_ok=True)
            data = self._load_user_prefs_json()
            cur = data.get(clean) if isinstance(data.get(clean), dict) else {}
            cur.update(entry)
            data[clean] = cur
            with open(p, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception:
            pass

    OWNER_MIRROR_EMAILS = ("glibivanov@gatheren.com.tw", "gleb.ivanov1999@gmail.com")

    def get_user_settings(self, email: str) -> Dict[str, Any]:
        clean = (email or "").strip().lower() or "guest@anonymous"
        prefs_map = self._load_user_prefs_json()
        json_pref = prefs_map.get(clean) if isinstance(prefs_map.get(clean), dict) else {}
        if not json_pref and clean in self.OWNER_MIRROR_EMAILS:
            for alt_em in self.OWNER_MIRROR_EMAILS:
                if isinstance(prefs_map.get(alt_em), dict):
                    json_pref = prefs_map[alt_em]
                    break
        with DB_LOCK, self._connect() as conn:
            row = conn.execute("SELECT * FROM user_settings WHERE lower(email) = ?", (clean,)).fetchone()
            if not row and clean in self.OWNER_MIRROR_EMAILS:
                for alt_em in self.OWNER_MIRROR_EMAILS:
                    row = conn.execute("SELECT * FROM user_settings WHERE lower(email) = ?", (alt_em,)).fetchone()
                    if row:
                        break
            if not row:
                lang_val = str(json_pref.get("language") or "zh-TW").strip()
                if lang_val not in ("zh-TW", "en"):
                    lang_val = "zh-TW"
                default = {
                    "email": clean,
                    "display_name": clean.split("@")[0],
                    "offline_cache_enabled": True,
                    "auto_cache_pinned_groups": [],
                    "theme_preference": str(json_pref.get("theme_preference") or "auto"),
                    "language": lang_val,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
                return default
            d = dict(row)
            d["email"] = clean
            d["offline_cache_enabled"] = bool(d.get("offline_cache_enabled", 1))
            json_theme = str(json_pref.get("theme_preference") or "").strip()
            if json_theme in ("auto", "light", "dark"):
                d["theme_preference"] = json_theme
            elif d.get("theme_preference") not in ("auto", "light", "dark"):
                d["theme_preference"] = "auto"
            json_lang = str(json_pref.get("language") or "").strip()
            lang_val = json_lang if json_lang in ("zh-TW", "en") else str(d.get("language") or "zh-TW").strip()
            if lang_val not in ("zh-TW", "en"):
                lang_val = "zh-TW"
            d["language"] = lang_val
            try:
                d["auto_cache_pinned_groups"] = json.loads(d.get("auto_cache_pinned_groups") or "[]")
            except Exception:
                d["auto_cache_pinned_groups"] = []
            return d

    def update_user_settings(self, email: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        clean = (email or "").strip().lower() or "guest@anonymous"
        current = self.get_user_settings(clean)
        offline_enabled = 1 if payload.get("offline_cache_enabled", current["offline_cache_enabled"]) else 0
        pinned = payload.get("auto_cache_pinned_groups", current["auto_cache_pinned_groups"])
        display_name = payload.get("display_name", current["display_name"])
        theme_pref = payload.get("theme_preference", current.get("theme_preference", "auto"))
        if theme_pref not in ("auto", "light", "dark"):
            theme_pref = "auto"
        raw_lang = str(payload.get("language") or payload.get("lang") or current.get("language") or "zh-TW").strip()
        if raw_lang.lower() in ("en", "en-us", "en-gb", "english"):
            lang_pref = "en"
        elif raw_lang.lower() in ("zh", "zh-tw", "zh-hant", "chinese"):
            lang_pref = "zh-TW"
        else:
            lang_pref = current.get("language", "zh-TW") if current.get("language") in ("zh-TW", "en") else "zh-TW"
        now_iso = datetime.now(timezone.utc).isoformat()
        target_emails = list(self.OWNER_MIRROR_EMAILS) if clean in self.OWNER_MIRROR_EMAILS else [clean]
        with DB_LOCK, self._connect() as conn:
            for em_target in target_emails:
                conn.execute(
                    """
                    INSERT INTO user_settings (email, display_name, offline_cache_enabled, auto_cache_pinned_groups, theme_preference, language, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(email) DO UPDATE SET
                        display_name=excluded.display_name,
                        offline_cache_enabled=excluded.offline_cache_enabled,
                        auto_cache_pinned_groups=excluded.auto_cache_pinned_groups,
                        theme_preference=excluded.theme_preference,
                        language=excluded.language,
                        updated_at=excluded.updated_at
                    """,
                    (em_target, display_name, offline_enabled, json.dumps(pinned), theme_pref, lang_pref, now_iso),
                )
            conn.commit()
        for em_target in target_emails:
            self._save_user_prefs_json_entry(
                em_target,
                {
                    "email": em_target,
                    "language": lang_pref,
                    "theme_preference": theme_pref,
                    "updated_at": now_iso,
                },
            )
        return self.get_user_settings(clean)
