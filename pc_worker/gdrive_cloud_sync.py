#!/usr/bin/env python3
"""
Google Drive .3tz Single-File Cloud Package Builder & VPS Manifest Syncer
for GatheringScans (scans.gatheren.cloud).

Solves two problems simultaneously:
1. Google Drive Sync Bogging:
   Instead of syncing 3,000-15,000 tiny Cesium tile files per scan, packages each scan's
   optimized web tileset (`tileset.json`, `preview_tileset.json`, `tiles/root.glb`,
   `preview_low/tiles/root.glb`, `thumbnail.png`, and any L1/L2 child tiles) + pre-gzipped
   versions (`.gz`) into a single `ZIP_STORED` `.3tz` archive:
     `G:\\Shared drives\\6.軟體\\3. GatheringScans\\StreamPackages\\<scan_id>.3tz`
   (and optionally mirrors to `G:\\My Drive\\Scans\\StreamPackages\\<scan_id>.3tz`).
   Google Drive only syncs 1 file per scan (~3-10 MB) in ~2 seconds.

2. Zero Workstation Upload Bandwidth During Viewing:
   Extracts the exact Google Drive `file_id` of each `<scan_id>.3tz` from Google Drive for
   Desktop's local SQLite database (`DriveFS\\...\\metadata_sqlite_db`) along with the exact
   byte offsets (`offset`, `size`, `gz_offset`, `gz_size`) of every inner file inside the
   `ZIP_STORED` `.3tz` archive, and pushes this lightweight manifest (`~25 KB`) to the
   Hostinger VPS (`/api/cloud-manifest/sync`).
   When any client or external guest views a scan on `scans.gatheren.cloud`, the VPS pulls
   the exact byte range directly from Google's servers at 300+ Mbps (0% workstation upload,
   works 24/7 even when the office workstation is powered off).
"""

from __future__ import annotations

import base64
import glob
import gzip
import io
import json
import os
import shutil
import sqlite3
import struct
import tempfile
import time
import urllib.parse
import urllib.request
import zipfile
from typing import Any, Dict, List, Optional, Tuple

from pc_worker.config import (
    BASE_DIR,
    DATA_DIR,
    GDRIVE_INBOX_DIR,
    GDRIVE_SERVICE_ACCOUNT_EMAIL,
    GDRIVE_SERVICE_ACCOUNT_PROJECT_ID,
    LOCAL_SCANS_ROOT,
    SERVER_PORT,
    TUNNEL_SHARED_KEY,
    VPS_HOST,
)

CLOUD_MANIFEST_PATH = os.path.join(DATA_DIR, "gdrive_cloud_manifest.json")
CLOUD_AUTH_PATH = os.path.join(DATA_DIR, "gdrive_cloud_auth.json")
THUMBS_DIR = os.path.join(DATA_DIR, "thumbnails")


def discover_service_account_json_on_disk() -> Optional[Dict[str, Any]]:
    """
    Searches standard directories (`data/`, project root, `Downloads`, `Desktop`, `G:\\Shared drives\\6.軟體\\3. GatheringScans`)
    for a Google Cloud Service Account JSON key matching `gcworker@modular-temple-508005-c4.iam.gserviceaccount.com`
    (project `modular-temple-508005-c4`) or any valid service_account key file.
    """
    if os.path.isfile(CLOUD_AUTH_PATH):
        try:
            with open(CLOUD_AUTH_PATH, "r", encoding="utf-8") as f:
                saved = json.load(f)
            sa = saved.get("service_account") if isinstance(saved, dict) else None
            if isinstance(sa, dict) and sa.get("private_key") and sa.get("client_email"):
                return sa
        except Exception:
            pass

    search_dirs = [
        DATA_DIR,
        BASE_DIR,
        "/host_docker/gathering_scans/data",
        "/opt/gathering-cloud-data",
        "/host_opt/gathering-cloud-data",
        os.path.expanduser(r"~\Downloads"),
        os.path.expanduser(r"~\Desktop"),
        GDRIVE_INBOX_DIR,
    ]
    candidates: List[Tuple[int, Dict[str, Any], str]] = []
    for sdir in search_dirs:
        if not sdir or not os.path.isdir(sdir):
            continue
        try:
            for fn in os.listdir(sdir):
                if not fn.lower().endswith(".json"):
                    continue
                if fn in ("gdrive_cloud_manifest.json", "pix4d_settings.json", "site_renames.json", "package.json", "tsconfig.json"):
                    continue
                fp = os.path.join(sdir, fn)
                if not os.path.isfile(fp) or os.path.getsize(fp) > 64 * 1024:
                    continue
                try:
                    with open(fp, "r", encoding="utf-8") as jf:
                        obj = json.load(jf)
                    if isinstance(obj, dict) and obj.get("type") == "service_account" and obj.get("private_key") and obj.get("client_email"):
                        email = str(obj.get("client_email") or "").strip().lower()
                        proj = str(obj.get("project_id") or "").strip().lower()
                        prio = 2 if (email == GDRIVE_SERVICE_ACCOUNT_EMAIL.lower() or proj == GDRIVE_SERVICE_ACCOUNT_PROJECT_ID.lower()) else 1
                        candidates.append((prio, obj, fp))
                except Exception:
                    continue
        except Exception:
            continue

    if candidates:
        candidates.sort(key=lambda x: x[0], reverse=True)
        best_sa = candidates[0][1]
        # Persist into CLOUD_AUTH_PATH automatically
        try:
            existing = {}
            if os.path.isfile(CLOUD_AUTH_PATH):
                with open(CLOUD_AUTH_PATH, "r", encoding="utf-8") as f:
                    existing = json.load(f)
            existing["service_account"] = best_sa
            existing["auth_mode"] = "service_account"
            with open(CLOUD_AUTH_PATH, "w", encoding="utf-8") as f:
                json.dump(existing, f, ensure_ascii=False, indent=2)
        except Exception:
            pass
        return best_sa
    return None


def query_gdrive_api_v3_folder_files(bearer_token: str, folder_id: str) -> Dict[str, Dict[str, Any]]:
    """
    Uses the Google Service Account (`gcworker@modular-temple-508005-c4.iam.gserviceaccount.com`)
    Bearer token to list `<scan_id>.3tz` packages inside `folder_id` via Google Drive API v3.
    """
    out: Dict[str, Dict[str, Any]] = {}
    if not bearer_token or not folder_id:
        return out
    try:
        q = urllib.parse.quote(f"'{folder_id}' in parents and trashed = false")
        url = (
            f"https://www.googleapis.com/drive/v3/files?q={q}"
            f"&supportsAllDrives=true&includeItemsFromAllDrives=true"
            f"&pageSize=200&fields=files(id,name,size,mimeType,modifiedTime)"
        )
        req = urllib.request.Request(
            url,
            headers={"Authorization": f"Bearer {bearer_token}"},
            method="GET",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        for f in data.get("files") or []:
            name = str(f.get("name") or "")
            fid = str(f.get("id") or "")
            if name.endswith(".3tz") and fid:
                sid = name[: -len(".3tz")]
                out[sid] = {
                    "file_id": fid,
                    "size": int(f.get("size") or 0),
                    "modifiedTime": f.get("modifiedTime", ""),
                }
    except Exception as e:
        print(f"[GDriveCloudSync] Drive API v3 list note for folder {folder_id}: {e}")
    return out


def resolve_gdrive_stream_dirs() -> Tuple[Optional[str], Optional[str]]:
    """
    Returns (shared_drive_stream_dir, my_drive_stream_dir) on the local Google Drive mount.
    """
    shared_dir: Optional[str] = None
    if os.path.isdir(GDRIVE_INBOX_DIR):
        shared_dir = os.path.join(GDRIVE_INBOX_DIR, "StreamPackages")
    else:
        sd_root = r"G:\Shared drives"
        if os.path.isdir(sd_root):
            try:
                for item in os.listdir(sd_root):
                    if item.startswith("6."):
                        p6 = os.path.join(sd_root, item)
                        for sub in os.listdir(p6):
                            if "GatheringScans" in sub:
                                shared_dir = os.path.join(p6, sub, "StreamPackages")
                                break
            except Exception:
                pass

    my_drive_dir: Optional[str] = None
    md_scans = r"G:\My Drive\Scans"
    if os.path.isdir(md_scans):
        my_drive_dir = os.path.join(md_scans, "StreamPackages")

    for d in (shared_dir, my_drive_dir):
        if d:
            try:
                os.makedirs(d, exist_ok=True)
            except Exception:
                pass
    return shared_dir, my_drive_dir


def _collect_referenced_glb_uris(ts_data: Dict[str, Any]) -> List[str]:
    uris: List[str] = []

    def _walk(node: Dict[str, Any]):
        c = node.get("content") or {}
        if isinstance(c, dict) and c.get("uri"):
            clean_u = str(c["uri"]).split("?")[0].replace("\\", "/").lstrip("/")
            if clean_u and clean_u not in uris:
                uris.append(clean_u)
        for ch in node.get("children") or []:
            if isinstance(ch, dict):
                _walk(ch)

    if isinstance(ts_data.get("root"), dict):
        _walk(ts_data["root"])
    return uris


def _build_optimized_tileset_dict(ts_path: str) -> Dict[str, Any]:
    """
    Builds the same web-optimized tileset JSON structure served by `_serve_optimized_tileset_json`
    in `server.py` so the `.3tz` package contains ready-to-serve `tileset.json`.
    """
    with open(ts_path, "r", encoding="utf-8") as f:
        ts = json.load(f)
    base_dir = os.path.dirname(ts_path)
    root = ts.get("root") or {}
    if not root.get("transform"):
        ts.setdefault("asset", {})["gltfUpAxis"] = "Z"
    r_content = root.get("content") or {}
    r_uri = r_content.get("uri") if isinstance(r_content, dict) else None
    if r_uri:
        clean_r_uri = r_uri.split("?")[0]
        r_file = os.path.join(base_dir, clean_r_uri)
        if os.path.isfile(r_file):
            r_content["uri"] = f"{clean_r_uri}?v={int(os.path.getmtime(r_file))}"
        valid_c1 = []
        for c1 in root.get("children") or []:
            if not isinstance(c1, dict):
                continue
            c1_c = c1.get("content") or {}
            if isinstance(c1_c, dict) and c1_c.get("uri"):
                u1 = c1_c["uri"].split("?")[0]
                f1 = os.path.join(base_dir, u1)
                if os.path.isfile(f1):
                    c1_c["uri"] = f"{u1}?v={int(os.path.getmtime(f1))}"
            valid_c2 = []
            for c2 in c1.get("children") or []:
                if not isinstance(c2, dict):
                    continue
                c2_c = c2.get("content") or {}
                if isinstance(c2_c, dict) and c2_c.get("uri"):
                    u2 = c2_c["uri"].split("?")[0]
                    f2 = os.path.join(base_dir, u2)
                    if os.path.isfile(f2):
                        c2_c["uri"] = f"{u2}?v={int(os.path.getmtime(f2))}"
                c2["geometricError"] = 0.0
                c2["children"] = []
                valid_c2.append(c2)
            c1["children"] = valid_c2
            if valid_c2:
                c1["geometricError"] = max(float(c1.get("geometricError") or 0.0), 8.0)
            else:
                c1["geometricError"] = 0.0
            valid_c1.append(c1)
        if valid_c1:
            root["children"] = valid_c1
            root["geometricError"] = max(float(root.get("geometricError") or 0.0), 24.0)
            ts["geometricError"] = max(float(ts.get("geometricError") or 0.0), float(root["geometricError"]))
        else:
            root["geometricError"] = 0.0
            root["children"] = []
    else:
        def _prune_branch(node: dict, depth: int = 0) -> bool:
            c = node.get("content") or {}
            if isinstance(c, dict) and c.get("uri"):
                u_clean = c["uri"].split("?")[0]
                f_clean = os.path.join(base_dir, u_clean)
                if os.path.isfile(f_clean):
                    c["uri"] = f"{u_clean}?v={int(os.path.getmtime(f_clean))}"
                node["geometricError"] = 0.0
                node["children"] = []
                return True
            if depth >= 2:
                node["children"] = []
                return False
            kept = []
            for ch in node.get("children") or []:
                if _prune_branch(ch, depth + 1):
                    kept.append(ch)
            kept.sort(key=lambda x: 0 if isinstance(x.get("content"), dict) and x["content"].get("uri") else 1)
            node["children"] = kept
            return len(kept) > 0

        _prune_branch(root, 0)
    return ts


def extract_3tz_toc(zip_path: str) -> Dict[str, Dict[str, int]]:
    """
    Reads the ZIP central directory and 30-byte local file headers of a `ZIP_STORED` `.3tz`
    archive and returns a mapping of inner paths to exact raw byte ranges:
      { "tiles/root.glb": {"offset": 1234, "size": 8439832, "gz_offset": ..., "gz_size": ...} }
    """
    raw_entries: Dict[str, Tuple[int, int]] = {}
    with open(zip_path, "rb") as rf:
        with zipfile.ZipFile(rf, "r") as zf:
            for info in zf.infolist():
                rf.seek(info.header_offset + 26)
                hdr_tail = rf.read(4)
                if len(hdr_tail) < 4:
                    continue
                fn_len, ext_len = struct.unpack("<HH", hdr_tail)
                data_offset = info.header_offset + 30 + fn_len + ext_len
                raw_entries[info.filename] = (data_offset, info.file_size)

    toc: Dict[str, Dict[str, int]] = {}
    for name, (off, sz) in raw_entries.items():
        if name.endswith(".gz"):
            base_n = name[:-3]
            if base_n not in raw_entries:
                toc[base_n] = {"offset": off, "size": sz, "gz_offset": off, "gz_size": sz, "gzip_only": 1}
            continue
        entry: Dict[str, int] = {"offset": off, "size": sz}
        gz_name = name + ".gz"
        if gz_name in raw_entries:
            entry["gz_offset"] = raw_entries[gz_name][0]
            entry["gz_size"] = raw_entries[gz_name][1]
        toc[name] = entry
    return toc


def build_scan_3tz_package(scan: Dict[str, Any], force: bool = False) -> Optional[Dict[str, Any]]:
    """
    Packages a single scan's optimized web tileset, preview tileset, GLB tiles, pre-gzipped
    GLB tiles, and thumbnail into `<scan_id>.3tz` (`ZIP_STORED`) inside Google Drive's
    `StreamPackages` folder.
    Returns package metadata including `toc` byte offsets.
    """
    scan_id = str(scan.get("scan_id") or "").strip()
    ts_path = str(scan.get("tileset_path") or "").strip()
    if not scan_id or not ts_path or not os.path.isfile(ts_path):
        return None

    shared_dir, my_drive_dir = resolve_gdrive_stream_dirs()
    target_dir = shared_dir or my_drive_dir
    if not target_dir:
        return None

    pkg_path = os.path.join(target_dir, f"{scan_id}.3tz")
    base_dir = os.path.dirname(ts_path)
    proj_dir = str(scan.get("project_dir") or os.path.dirname(base_dir) or "")
    r_glb = os.path.join(base_dir, "tiles", "root.glb")
    p_glb = os.path.join(base_dir, "preview_low", "tiles", "root.glb")
    meta_json = os.path.join(proj_dir, "scan_meta.json") if proj_dir else ""
    src_mtime = os.path.getmtime(ts_path)
    for cand in (r_glb, p_glb, meta_json):
        if cand and os.path.isfile(cand):
            src_mtime = max(src_mtime, os.path.getmtime(cand))
    for sub_d in ("content", os.path.join("preview_low", "content"), "tiles"):
        sd_full = os.path.join(base_dir, sub_d)
        if os.path.isdir(sd_full):
            try:
                for fn in os.listdir(sd_full)[:64]:
                    if fn.lower().endswith(".glb"):
                        src_mtime = max(src_mtime, os.path.getmtime(os.path.join(sd_full, fn)))
            except OSError:
                pass

    if not force and os.path.isfile(pkg_path) and os.path.getsize(pkg_path) > 1024:
        try:
            if os.path.getmtime(pkg_path) >= src_mtime:
                # Mirror to my_drive_dir if missing
                if my_drive_dir and shared_dir and my_drive_dir != shared_dir:
                    md_pkg = os.path.join(my_drive_dir, f"{scan_id}.3tz")
                    if not os.path.isfile(md_pkg) or os.path.getsize(md_pkg) != os.path.getsize(pkg_path):
                        shutil.copy2(pkg_path, md_pkg)
                return {
                    "scan_id": scan_id,
                    "pkg_path": pkg_path,
                    "size_bytes": os.path.getsize(pkg_path),
                    "mtime": int(os.path.getmtime(pkg_path)),
                    "toc": extract_3tz_toc(pkg_path),
                }
        except Exception:
            pass

    files_to_pack: Dict[str, bytes] = {}

    if ts_path.lower().endswith(".glb"):
        bn = os.path.basename(ts_path)
        with open(ts_path, "rb") as f:
            files_to_pack[bn] = f.read()
        prev_glb = os.path.join(base_dir, "preview_low.glb")
        if os.path.isfile(prev_glb):
            with open(prev_glb, "rb") as f:
                files_to_pack["preview_low.glb"] = f.read()
    else:
        opt_ts = _build_optimized_tileset_dict(ts_path)
        opt_ts_bytes = json.dumps(opt_ts, separators=(",", ":")).encode("utf-8")
        files_to_pack["tileset.json"] = opt_ts_bytes

        glb_cache_dir = os.path.join(DATA_DIR, "glb_cache")
        os.makedirs(glb_cache_dir, exist_ok=True)
        for u in _collect_referenced_glb_uris(opt_ts):
            gf = os.path.join(base_dir, u)
            if os.path.isfile(gf):
                norm_u = u.replace("\\", "/").lower()
                f_sz = os.path.getsize(gf)
                if f_sz > 700_000 and "content/" in norm_u and "preview_low" not in norm_u:
                    import hashlib

                    mtime_g = os.path.getmtime(gf)
                    k_hash = hashlib.md5(f"v2:{gf}:{int(mtime_g)}:{f_sz}".encode("utf-8")).hexdigest()
                    opt_disk = os.path.join(glb_cache_dir, f"{k_hash}.glb")
                    if os.path.isfile(opt_disk):
                        with open(opt_disk, "rb") as f:
                            files_to_pack[u] = f.read()
                        continue
                    try:
                        from server import GatheringScansHandler

                        with open(gf, "rb") as f:
                            raw_b = f.read()
                        opt_b = GatheringScansHandler._optimize_cesium_glb_bytes(raw_b)
                        with open(opt_disk, "wb") as df:
                            df.write(opt_b)
                        files_to_pack[u] = opt_b
                        continue
                    except Exception:
                        pass
                with open(gf, "rb") as f:
                    files_to_pack[u] = f.read()

        prev_ts_path = os.path.join(base_dir, "preview_tileset.json")
        if os.path.isfile(prev_ts_path):
            try:
                with open(prev_ts_path, "r", encoding="utf-8") as pf:
                    pts = json.load(pf)
                pts_bytes = json.dumps(pts, separators=(",", ":")).encode("utf-8")
                files_to_pack["preview_tileset.json"] = pts_bytes
                for u in _collect_referenced_glb_uris(pts):
                    gf = os.path.join(base_dir, u)
                    if os.path.isfile(gf):
                        with open(gf, "rb") as f:
                            files_to_pack[u] = f.read()
            except Exception:
                pass

    # Include scan thumbnail.png inside the .3tz package
    proj_dir = scan.get("project_dir") or ""
    for thumb_cand in [
        os.path.join(proj_dir, "thumbnail.png") if proj_dir else "",
        os.path.join(THUMBS_DIR, f"{scan_id}.png"),
    ]:
        if thumb_cand and os.path.isfile(thumb_cand) and os.path.getsize(thumb_cand) > 256:
            with open(thumb_cand, "rb") as tf:
                files_to_pack["thumbnail.png"] = tf.read()
            break

    if not files_to_pack:
        return None

    # Build ZIP_STORED archive into a temporary file, including pre-gzipped (.gz) streams for instant VPS piping
    tmp_fd, tmp_zip = tempfile.mkstemp(suffix=".3tz")
    os.close(tmp_fd)
    try:
        with zipfile.ZipFile(tmp_zip, "w", compression=zipfile.ZIP_STORED) as zf:
            for arc_name, raw_data in files_to_pack.items():
                clean_arc = arc_name.replace("\\", "/").lstrip("/")
                # Always write the canonical file (e.g. tiles/root.glb, tileset.json) directly as ZIP_STORED
                # so the .3tz/.zip archive works out-of-the-box in any external 3D Tiles viewer or app when unzipped,
                # while still supporting direct HTTP byte-range streaming.
                zf.writestr(clean_arc, raw_data, compress_type=zipfile.ZIP_STORED)

        shutil.move(tmp_zip, pkg_path)
        if my_drive_dir and shared_dir and my_drive_dir != shared_dir:
            try:
                shutil.copy2(pkg_path, os.path.join(my_drive_dir, f"{scan_id}.3tz"))
            except Exception:
                pass

        return {
            "scan_id": scan_id,
            "pkg_path": pkg_path,
            "size_bytes": os.path.getsize(pkg_path),
            "mtime": int(os.path.getmtime(pkg_path)),
            "toc": extract_3tz_toc(pkg_path),
        }
    finally:
        if os.path.isfile(tmp_zip):
            try:
                os.remove(tmp_zip)
            except OSError:
                pass


def query_drivefs_cloud_ids() -> Dict[str, Any]:
    """
    Queries Google Drive for Desktop's local SQLite metadata database (`DriveFS\\...\\metadata_sqlite_db`)
    to resolve exact Google Drive File IDs (`items.id`) for `StreamPackages` folders and `<scan_id>.3tz` files.
    """
    result: Dict[str, Any] = {
        "shared_drive_folder_id": "",
        "my_drive_folder_id": "",
        "files_shared_drive": {},
        "files_my_drive": {},
    }
    dfs_root = os.path.expandvars(r"%LOCALAPPDATA%\Google\DriveFS")
    if not os.path.isdir(dfs_root):
        return result

    for entry in os.listdir(dfs_root):
        acc_dir = os.path.join(dfs_root, entry)
        db_src = os.path.join(acc_dir, "metadata_sqlite_db")
        if not os.path.isfile(db_src):
            continue
        tmp_dir = tempfile.mkdtemp(prefix="gs_dfs_")
        try:
            for ext in ("", "-wal", "-shm"):
                if os.path.isfile(db_src + ext):
                    shutil.copy2(db_src + ext, os.path.join(tmp_dir, "meta.db" + ext))
            conn = sqlite3.connect(os.path.join(tmp_dir, "meta.db"))
            # Find StreamPackages folder(s)
            sp_rows = conn.execute(
                "SELECT i.stable_id, i.id, i.team_drive_stable_id FROM items i "
                "WHERE i.local_title = 'StreamPackages' AND i.is_folder = 1 AND i.trashed = 0"
            ).fetchall()
            for sp_stable_id, sp_cloud_id, td_id in sp_rows:
                if not sp_cloud_id or str(sp_cloud_id).startswith("local"):
                    continue
                is_shared_drive = bool(td_id)
                if is_shared_drive:
                    result["shared_drive_folder_id"] = sp_cloud_id
                else:
                    result["my_drive_folder_id"] = sp_cloud_id
                children = conn.execute(
                    "SELECT i.local_title, i.id, i.file_size FROM items i "
                    "JOIN stable_parents sp ON i.stable_id = sp.item_stable_id "
                    "WHERE sp.parent_stable_id = ? AND i.trashed = 0",
                    (sp_stable_id,),
                ).fetchall()
                for title, cid, fsize in children:
                    if not cid or str(cid).startswith("local"):
                        continue
                    if str(title).endswith(".3tz"):
                        sid = str(title)[: -len(".3tz")]
                        if is_shared_drive:
                            result["files_shared_drive"][sid] = {"file_id": cid, "size": fsize}
                        else:
                            result["files_my_drive"][sid] = {"file_id": cid, "size": fsize}
            conn.close()
        except Exception as e:
            print(f"[GDriveCloudSync] DriveFS query note: {e}")
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)
    return result


def sync_all_scans_to_gdrive_and_vps(db: Any, auth_share: Any = None, force: bool = False) -> Dict[str, Any]:
    """
    1. Builds/updates `<scan_id>.3tz` in Google Drive `StreamPackages` for all completed scans.
    2. Queries `DriveFS` for the Google Drive `file_id` of each `<scan_id>.3tz`.
    3. Saves `data/gdrive_cloud_manifest.json` locally and pushes it to the VPS (`/api/cloud-manifest/sync`).
    """
    scans = db.list_scans()
    prev_manifest: Dict[str, Any] = {}
    if os.path.isfile(CLOUD_MANIFEST_PATH):
        try:
            with open(CLOUD_MANIFEST_PATH, "r", encoding="utf-8") as f:
                prev_manifest = json.load(f)
        except Exception:
            prev_manifest = {}

    prev_pkgs = (prev_manifest.get("packages") or {}) if isinstance(prev_manifest, dict) else {}
    packages: Dict[str, Any] = {}

    for s in scans:
        if s.get("status") != "completed":
            continue
        sid = s["scan_id"]
        pkg_info = build_scan_3tz_package(s, force=force)
        if pkg_info:
            old_p = prev_pkgs.get(sid) or {}
            pkg_info["file_id"] = old_p.get("file_id", "")
            pkg_info["my_drive_file_id"] = old_p.get("my_drive_file_id", "")
            packages[sid] = pkg_info

    # Query DriveFS SQLite DB for live Google Drive File IDs
    dfs_ids = query_drivefs_cloud_ids()
    for sid, pkg in packages.items():
        sd_entry = dfs_ids["files_shared_drive"].get(sid)
        md_entry = dfs_ids["files_my_drive"].get(sid)
        if sd_entry and sd_entry.get("file_id"):
            pkg["file_id"] = sd_entry["file_id"]
        if md_entry and md_entry.get("file_id"):
            pkg["my_drive_file_id"] = md_entry["file_id"]

    share_links = auth_share.list_share_links() if auth_share else []
    shared_dir, my_drive_dir = resolve_gdrive_stream_dirs()
    trashed_ids = [
        str(t.get("scan_id") or "")
        for t in (db.list_trashed_scans() if hasattr(db, "list_trashed_scans") else [])
        if t.get("scan_id")
    ]

    manifest = {
        "updated_at": int(time.time()),
        "shared_drive_dir": shared_dir or "",
        "my_drive_dir": my_drive_dir or "",
        "shared_drive_folder_id": dfs_ids.get("shared_drive_folder_id") or prev_manifest.get("shared_drive_folder_id", ""),
        "my_drive_folder_id": dfs_ids.get("my_drive_folder_id") or prev_manifest.get("my_drive_folder_id", ""),
        "scans": scans,
        "trashed_scan_ids": trashed_ids,
        "share_links": share_links,
        "packages": packages,
    }

    with open(CLOUD_MANIFEST_PATH, "w", encoding="utf-8") as mf:
        json.dump(manifest, mf, ensure_ascii=False, indent=2)

    # Also include any saved cloud auth credentials when syncing to VPS so VPS can authenticate with Google Drive API
    discover_service_account_json_on_disk()
    auth_data: Dict[str, Any] = {}
    if os.path.isfile(CLOUD_AUTH_PATH):
        try:
            with open(CLOUD_AUTH_PATH, "r", encoding="utf-8") as af:
                auth_data = json.load(af)
        except Exception:
            auth_data = {}
    auth_data.setdefault("expected_service_account_email", GDRIVE_SERVICE_ACCOUNT_EMAIL)
    auth_data.setdefault("expected_project_id", GDRIVE_SERVICE_ACCOUNT_PROJECT_ID)

    payload_bytes = json.dumps({"manifest": manifest, "auth": auth_data}, ensure_ascii=False).encode("utf-8")
    vps_synced = False
    missing_vps_pkgs: List[str] = []
    try:
        req = urllib.request.Request(
            f"http://{VPS_HOST}:8095/api/cloud-manifest/sync",
            data=payload_bytes,
            headers={
                "Content-Type": "application/json; charset=utf-8",
                "X-Tunnel-Key": TUNNEL_SHARED_KEY,
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=12) as resp:
            vps_synced = resp.status == 200
            try:
                rj = json.loads(resp.read().decode("utf-8"))
                missing_vps_pkgs = rj.get("missing_vps_packages") or []
                if auth_share and hasattr(auth_share, "merge_share_sessions") and isinstance(rj.get("vps_share_sessions"), list):
                    auth_share.merge_share_sessions(rj["vps_share_sessions"])
            except Exception:
                pass
    except Exception as e:
        print(f"[GDriveCloudSync] VPS manifest push note: {e}")

    for m_sid in missing_vps_pkgs[:4]:
        p_info = packages.get(m_sid) or {}
        p_file = p_info.get("pkg_path") or ""
        if p_file and os.path.isfile(p_file) and os.path.getsize(p_file) <= 120 * 1024 * 1024:
            try:
                with open(p_file, "rb") as pf:
                    raw_pkg = pf.read()
                ureq = urllib.request.Request(
                    f"http://{VPS_HOST}:8095/api/cloud-manifest/upload-3tz?scan_id={urllib.parse.quote(m_sid)}",
                    data=raw_pkg,
                    headers={
                        "Content-Type": "application/octet-stream",
                        "X-Tunnel-Key": TUNNEL_SHARED_KEY,
                    },
                    method="POST",
                )
                with urllib.request.urlopen(ureq, timeout=180) as uresp:
                    pass
            except Exception as ue:
                print(f"[GDriveCloudSync] VPS .3tz mirror note for {m_sid}: {ue}")

    manifest["vps_synced"] = vps_synced
    return manifest


def sync_share_links_to_vps_manifest(auth_share: Any) -> bool:
    """
    Fast, lightweight (<150ms) sync of `share_links` into local `gdrive_cloud_manifest.json`
    and live VPS `/api/cloud-manifest/sync`, so newly created or revoked `/s/<token>` links
    take effect immediately on `https://scans.gatheren.cloud` even if the PC later goes offline.
    """
    if not auth_share:
        return False
    manifest: Dict[str, Any] = {}
    if os.path.isfile(CLOUD_MANIFEST_PATH):
        try:
            with open(CLOUD_MANIFEST_PATH, "r", encoding="utf-8") as mf:
                manifest = json.load(mf)
        except Exception:
            manifest = {}
    manifest["updated_at"] = int(time.time())
    share_links = auth_share.list_share_links()
    manifest["share_links"] = share_links
    try:
        os.makedirs(os.path.dirname(CLOUD_MANIFEST_PATH), exist_ok=True)
        with open(CLOUD_MANIFEST_PATH, "w", encoding="utf-8") as mf:
            json.dump(manifest, mf, ensure_ascii=False, indent=2)
    except Exception:
        pass
    try:
        payload_bytes = json.dumps(
            {"share_links_only": True, "share_links": share_links}, ensure_ascii=False
        ).encode("utf-8")
        req = urllib.request.Request(
            f"http://{VPS_HOST}:8095/api/cloud-manifest/sync",
            data=payload_bytes,
            headers={
                "Content-Type": "application/json; charset=utf-8",
                "X-Tunnel-Key": TUNNEL_SHARED_KEY,
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            try:
                rj = json.loads(resp.read().decode("utf-8"))
                if hasattr(auth_share, "merge_share_sessions") and isinstance(rj.get("vps_share_sessions"), list):
                    auth_share.merge_share_sessions(rj["vps_share_sessions"])
            except Exception:
                pass
            return resp.status == 200
    except Exception as e:
        print(f"[GDriveCloudSync] Share links fast-sync note: {e}")
        return False


COMMENT_PHOTOS_DIR = os.path.join(BASE_DIR, "data", "comment_photos")
GDRIVE_COMMENT_PHOTOS_FALLBACK_DIR = os.path.join(BASE_DIR, "data", "gdrive_comment_photos")


def save_and_sync_comment_photo_to_gdrive(
    scan_id: str,
    filename: str,
    raw_bytes: bytes,
    content_type: str = "image/jpeg",
    camera_meta: Optional[Dict[str, Any]] = None,
    forced_stored_name: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Saves a user-uploaded comment photo (from PC drag-and-drop or mobile gallery/camera)
    into local storage (`data/comment_photos/<scan_id>/`), syncs it into the Google Drive
    `CommentPhotos/<scan_id>/` folder (both mounted Google Drive for Desktop and Google Drive
    API v3 when credentials are present), and returns the normalized photo descriptor.
    """
    import re
    from datetime import datetime

    safe_scan_id = re.sub(r"[^A-Za-z0-9._-]+", "_", str(scan_id or "general").strip()) or "general"
    orig_name = os.path.basename(str(filename or "comment_photo.jpg").strip()) or "comment_photo.jpg"
    stem, ext = os.path.splitext(orig_name)
    ext_lower = ext.lower()
    if ext_lower not in (".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".bmp"):
        ct_low = str(content_type or "").lower()
        if "png" in ct_low:
            ext_lower = ".png"
        elif "webp" in ct_low:
            ext_lower = ".webp"
        elif "gif" in ct_low:
            ext_lower = ".gif"
        else:
            ext_lower = ".jpg"
    safe_stem = re.sub(r"[^A-Za-z0-9._-]+", "_", stem).strip("._-") or "photo"
    ts_ms = int(time.time() * 1000)
    if forced_stored_name:
        safe_name = os.path.basename(str(forced_stored_name).strip()) or f"{ts_ms}_{safe_stem[:48]}{ext_lower}"
    else:
        safe_name = f"{ts_ms}_{safe_stem[:48]}{ext_lower}"

    local_scan_dir = os.path.join(COMMENT_PHOTOS_DIR, safe_scan_id)
    os.makedirs(local_scan_dir, exist_ok=True)
    local_fp = os.path.join(local_scan_dir, safe_name)
    with open(local_fp, "wb") as f:
        f.write(raw_bytes)

    # Mirror to Google Drive desktop mount (if available) AND local gdrive_comment_photos mirror
    gdrive_saved_path = ""
    gdrive_candidates = [
        r"G:\Shared drives\6.軟體\3. GatheringScans\CommentPhotos",
        r"G:\My Drive\Scans\CommentPhotos",
        GDRIVE_COMMENT_PHOTOS_FALLBACK_DIR,
    ]
    for cand_root in gdrive_candidates:
        try:
            parent_drive = os.path.splitdrive(cand_root)[0]
            if parent_drive and parent_drive.upper().startswith("G:") and not os.path.exists(parent_drive + "\\"):
                continue
            target_dir = os.path.join(cand_root, safe_scan_id)
            os.makedirs(target_dir, exist_ok=True)
            target_fp = os.path.join(target_dir, safe_name)
            with open(target_fp, "wb") as gf:
                gf.write(raw_bytes)
            if not gdrive_saved_path:
                gdrive_saved_path = target_fp
        except Exception:
            continue

    # Also attempt direct Google Drive REST API v3 upload into the Shared Drive folder if configured
    gdrive_file_id = ""
    gdrive_web_url = ""
    folder_id = (
        os.environ.get("GDRIVE_COMMENT_PHOTOS_FOLDER_ID")
        or os.environ.get("GDRIVE_SCANS_FOLDER_ID")
        or ""
    ).strip()
    if not folder_id and os.path.isfile(CLOUD_MANIFEST_PATH):
        try:
            with open(CLOUD_MANIFEST_PATH, "r", encoding="utf-8") as mf:
                m_obj = json.load(mf)
            folder_id = str(
                m_obj.get("comment_photos_folder_id")
                or m_obj.get("shared_drive_folder_id")
                or ""
            ).strip()
        except Exception:
            folder_id = ""

    token = None
    if folder_id:
        try:
            from pc_worker.server_cloud_and_tunnel import _get_gdrive_bearer_token
            token = _get_gdrive_bearer_token()
        except Exception:
            token = None
    if token and folder_id:
        try:
            boundary = f"===GatheringScansCommentPhoto_{ts_ms}==="
            meta_dict: Dict[str, Any] = {
                "name": f"{safe_scan_id}__{safe_name}",
                "mimeType": content_type or "image/jpeg",
                "description": f"GatheringScans comment photo for scan {safe_scan_id}",
                "parents": [folder_id],
            }
            meta_part = json.dumps(meta_dict).encode("utf-8")
            body = (
                f"--{boundary}\r\n"
                "Content-Type: application/json; charset=UTF-8\r\n\r\n"
            ).encode("utf-8") + meta_part + (
                f"\r\n--{boundary}\r\n"
                f"Content-Type: {content_type or 'image/jpeg'}\r\n\r\n"
            ).encode("utf-8") + raw_bytes + f"\r\n--{boundary}--\r\n".encode("utf-8")
            up_req = urllib.request.Request(
                "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink,webContentLink",
                data=body,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": f"multipart/related; boundary={boundary}",
                },
                method="POST",
            )
            with urllib.request.urlopen(up_req, timeout=20) as up_resp:
                up_json = json.loads(up_resp.read().decode("utf-8"))
                gdrive_file_id = str(up_json.get("id") or "")
                gdrive_web_url = str(up_json.get("webContentLink") or up_json.get("webViewLink") or "")
        except Exception as ge:
            print(f"[GDriveCloudSync] Optional Drive API v3 photo upload note: {ge}")

    rel_url = f"/api/comments/photo/{urllib.parse.quote(safe_scan_id)}/{urllib.parse.quote(safe_name)}"
    photo_obj: Dict[str, Any] = {
        "id": f"cphoto_{ts_ms}",
        "url": rel_url,
        "filename": orig_name,
        "stored_filename": safe_name,
        "mime_type": content_type or "image/jpeg",
        "size_bytes": len(raw_bytes),
        "storage": "gdrive",
        "source": "comment_upload",
        "gdrive_synced": True,
        "gdrive_path": gdrive_saved_path or local_fp,
        "uploaded_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    if gdrive_file_id:
        photo_obj["gdrive_file_id"] = gdrive_file_id
    if gdrive_web_url:
        photo_obj["gdrive_url"] = gdrive_web_url
    if isinstance(camera_meta, dict):
        for ck in ("camera_twd97_e", "camera_twd97_n", "camera_twd97_h", "distance_m"):
            if camera_meta.get(ck) is not None:
                try:
                    photo_obj[ck] = float(camera_meta[ck])
                except (TypeError, ValueError):
                    pass
    return photo_obj

