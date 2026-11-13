#!/usr/bin/env python3
"""
Portable scan bundles: Google Drive is the source of truth so ANY workstation can adopt a finished scan.

Drive layout (next to INPUTS, inside GDRIVE_INBOX_DIR):
    SCANS\\<scan_id>\\<scan_id>.gsbundle      one ZIP_STORED archive: tileset, exports, project, caches, scan_meta.json,
                                              db_row.json (relative paths) and comments.json
    SCANS\\<scan_id>\\<scan_id>_photos.zip    one ZIP_STORED archive of the JPG photos (Photo tool reads from it)
    SCANS\\<scan_id>\\manifest.json           written LAST: completion marker + sha256 + tileset_version
    PROCESSED\\...                            original input zips/folders moved here after a verified full-HQ publish
    _claims\\<scan_id>.<pc_id>.json           per-PC claim file with heartbeat counter (stops double processing)

Google Drive handles a handful of large files far better than thousands of small ones, hence archives.
If the Drive folder is unavailable (G: offline) every function degrades to a no-op and the app behaves as before.
"""

from __future__ import annotations

import glob
import hashlib
import json
import os
import re
import shutil
import socket
import tempfile
import threading
import time
import uuid
import zipfile
from typing import Any, Dict, List, Optional, Tuple

from pc_worker.config import DATA_DIR, GDRIVE_INBOX_DIR, GDRIVE_INPUTS_DIR, LOCAL_SCANS_ROOT

SCANS_DIRNAME = "SCANS"
PROCESSED_DIRNAME = "PROCESSED"
CLAIMS_DIRNAME = "_claims"
SCHEMA = 1

STALE_CLAIM_SEC = float(os.environ.get("GS_CLAIM_STALE_SEC", 30 * 60))
CLAIM_SETTLE_SEC = float(os.environ.get("GS_CLAIM_SETTLE_SEC", 20))
HEARTBEAT_SEC = 60.0

# Never packed into a bundle: raw photos (own archive), backups, scratch.
EXCLUDE_TOP_DIRS = {"inputs", "tileset_backup", "temp", "__pycache__", ".git"}
EXCLUDE_SUFFIXES = (".log", ".part", ".tmp")
PHOTO_SUFFIXES = (".jpg", ".jpeg")

_PATH_FIELDS = ("project_dir", "tileset_path", "obj_path", "report_path", "cameras_dir")
_ADOPT_LOCK = threading.Lock()
_PUBLISH_LOCK = threading.Lock()
_FAIL_UNTIL: Dict[str, float] = {}


# ----------------------------------------------------------------------------------------------
# Identity & paths
# ----------------------------------------------------------------------------------------------
def pc_id() -> str:
    """Stable per-PC id (hostname + short GUID persisted in DATA_DIR/pc_id.json)."""
    path = os.path.join(DATA_DIR, "pc_id.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            d = json.load(f)
        if d.get("id"):
            return str(d["id"])
    except Exception:
        pass
    host = re.sub(r"[^A-Za-z0-9_-]", "", socket.gethostname()) or "pc"
    new_id = f"{host}-{uuid.uuid4().hex[:6]}"
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"id": new_id, "host": socket.gethostname(), "created": time.time()}, f)
    except Exception:
        pass
    return new_id


def _base() -> Optional[str]:
    try:
        if GDRIVE_INBOX_DIR and os.path.isdir(GDRIVE_INBOX_DIR):
            return GDRIVE_INBOX_DIR
    except Exception:
        pass
    return None


def drive_available() -> bool:
    return _base() is not None


def scans_dir() -> Optional[str]:
    b = _base()
    return os.path.join(b, SCANS_DIRNAME) if b else None


def processed_dir() -> Optional[str]:
    b = _base()
    return os.path.join(b, PROCESSED_DIRNAME) if b else None


def claims_dir() -> Optional[str]:
    b = _base()
    return os.path.join(b, CLAIMS_DIRNAME) if b else None


def _scan_folder(scan_id: str) -> Optional[str]:
    d = scans_dir()
    return os.path.join(d, scan_id) if d else None


def _safe_member(dest_root: str, member: str) -> Optional[str]:
    target = os.path.abspath(os.path.join(dest_root, member.replace("/", os.sep)))
    root = os.path.abspath(dest_root)
    if target == root or target.startswith(root + os.sep):
        return target
    return None


def _sha256_file(path: str, chunk: int = 8 * 1024 * 1024) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def _read_json(path: str) -> Optional[Dict[str, Any]]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else None
    except Exception:
        return None


def _write_json_atomic(path: str, data: Dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".part"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def _to_int(v: Any) -> int:
    try:
        return int(float(v or 0))
    except Exception:
        return 0


# ----------------------------------------------------------------------------------------------
# Claims (prevents two PCs processing the same scan)
# ----------------------------------------------------------------------------------------------
_MY_CLAIMS: Dict[str, Dict[str, Any]] = {}
_OBS: Dict[Tuple[str, str], Tuple[int, float]] = {}  # (scan_id, pc) -> (last hb counter, monotonic time it last changed)
_HB_THREAD: Optional[threading.Thread] = None
_CLAIM_LOCK = threading.Lock()


def _claim_path(scan_id: str, pc: str) -> Optional[str]:
    d = claims_dir()
    return os.path.join(d, f"{scan_id}.{pc}.json") if d else None


def _foreign_live_claims(scan_id: str) -> List[Dict[str, Any]]:
    """Other PCs' claims that are still alive. Liveness is judged by *observing* their heartbeat counter change locally,
    never by comparing wall clocks across PCs."""
    d = claims_dir()
    if not d or not os.path.isdir(d):
        return []
    me = pc_id()
    live: List[Dict[str, Any]] = []
    now = time.monotonic()
    for fp in glob.glob(os.path.join(glob.escape(d), glob.escape(scan_id) + ".*.json")):
        c = _read_json(fp)
        if not c or c.get("pc") == me or c.get("scan_id") != scan_id:
            continue
        key = (scan_id, str(c.get("pc")))
        hb = _to_int(c.get("hb"))
        prev = _OBS.get(key)
        if prev is None or prev[0] != hb:
            _OBS[key] = (hb, now)
            live.append(c)
        elif now - prev[1] < STALE_CLAIM_SEC:
            live.append(c)
    return live


def foreign_claim_owner(scan_id: str) -> str:
    """Name of another PC currently processing scan_id, or '' if none."""
    try:
        live = _foreign_live_claims(scan_id)
        if live:
            return str(live[0].get("host") or live[0].get("pc") or "another PC")
    except Exception:
        pass
    return ""


def _hb_loop() -> None:
    while True:
        time.sleep(HEARTBEAT_SEC)
        with _CLAIM_LOCK:
            items = list(_MY_CLAIMS.items())
        for sid, c in items:
            try:
                c["hb"] = _to_int(c.get("hb")) + 1
                p = _claim_path(sid, c["pc"])
                if p:
                    _write_json_atomic(p, c)
            except Exception:
                pass


def try_claim(scan_id: str) -> Tuple[bool, str]:
    """Claim scan_id for this PC. Returns (won, other_owner_name). Always (True, '') when Drive is unavailable."""
    global _HB_THREAD
    if not drive_available():
        return True, ""
    me = pc_id()
    with _CLAIM_LOCK:
        if scan_id in _MY_CLAIMS:
            return True, ""
    owner = foreign_claim_owner(scan_id)
    if owner:
        return False, owner
    claim = {"scan_id": scan_id, "pc": me, "host": socket.gethostname(), "started": time.time(), "hb": 0, "nonce": uuid.uuid4().hex}
    try:
        _write_json_atomic(_claim_path(scan_id, me), claim)
    except Exception:
        return True, ""  # cannot write claims -> do not block processing
    time.sleep(CLAIM_SETTLE_SEC)  # let Google Drive propagate competing claim files
    rivals = _foreign_live_claims(scan_id)
    for r in rivals:
        # Deterministic tie-break so both PCs reach the same verdict: earliest start, then smallest pc id.
        if (float(r.get("started") or 0), str(r.get("pc"))) < (claim["started"], me):
            try:
                os.remove(_claim_path(scan_id, me))
            except Exception:
                pass
            return False, str(r.get("host") or r.get("pc"))
    with _CLAIM_LOCK:
        _MY_CLAIMS[scan_id] = claim
        if _HB_THREAD is None:
            _HB_THREAD = threading.Thread(target=_hb_loop, daemon=True)
            _HB_THREAD.start()
    return True, ""


def release_claim(scan_id: str) -> None:
    with _CLAIM_LOCK:
        c = _MY_CLAIMS.pop(scan_id, None)
    p = _claim_path(scan_id, (c or {}).get("pc") or pc_id())
    if p and os.path.isfile(p):
        try:
            os.remove(p)
        except Exception:
            pass


def my_claim_ids() -> List[str]:
    with _CLAIM_LOCK:
        return list(_MY_CLAIMS.keys())


# ----------------------------------------------------------------------------------------------
# Path (de)relativisation
# ----------------------------------------------------------------------------------------------
def _root_rel(project_dir: str, scan_id: str) -> str:
    """Folder of the scan relative to LOCAL_SCANS_ROOT (e.g. 'catch_TUfloor' or 'Project\\\\scan')."""
    try:
        rel = os.path.relpath(os.path.abspath(project_dir), os.path.abspath(LOCAL_SCANS_ROOT))
        if not rel.startswith("..") and not os.path.isabs(rel) and rel != ".":
            return rel
    except Exception:
        pass
    return os.path.basename(project_dir.rstrip("\\/")) or scan_id


def _relativise_row(row: Dict[str, Any], project_dir: str) -> Dict[str, Any]:
    out = dict(row)
    pd = os.path.abspath(project_dir)
    for k in _PATH_FIELDS:
        v = str(out.get(k) or "")
        if not v:
            continue
        try:
            rel = os.path.relpath(os.path.abspath(v), pd)
            out[k] = "" if rel.startswith("..") else ("{PROJECT}" if rel == "." else "{PROJECT}/" + rel.replace("\\", "/"))
        except Exception:
            out[k] = ""
    return out


def _localise_row(row: Dict[str, Any], local_project_dir: str) -> Dict[str, Any]:
    out = dict(row)
    for k in _PATH_FIELDS:
        v = str(out.get(k) or "")
        if v.startswith("{PROJECT}"):
            rest = v[len("{PROJECT}"):].lstrip("/")
            out[k] = os.path.normpath(os.path.join(local_project_dir, rest)) if rest else local_project_dir
    out["project_dir"] = local_project_dir
    return out


# ----------------------------------------------------------------------------------------------
# Publish
# ----------------------------------------------------------------------------------------------
def _iter_bundle_files(project_dir: str):
    for root, dirs, files in os.walk(project_dir):
        rel_root = os.path.relpath(root, project_dir)
        if rel_root == ".":
            dirs[:] = [d for d in dirs if d.lower() not in EXCLUDE_TOP_DIRS]
        for fn in files:
            if fn.lower().endswith(EXCLUDE_SUFFIXES) or fn.startswith("~"):
                continue
            full = os.path.join(root, fn)
            rel = os.path.relpath(full, project_dir).replace("\\", "/")
            yield full, rel


def _comments_for(db: Any, scan_id: str) -> List[Dict[str, Any]]:
    try:
        with db._connect() as conn:
            rows = conn.execute("SELECT * FROM scan_comments WHERE scan_id = ?", (scan_id,)).fetchall()
            return [dict(r) for r in rows]
    except Exception:
        return []


def _photo_dirs(row: Dict[str, Any], project_dir: str) -> List[str]:
    dirs = []
    for cand in (str(row.get("cameras_dir") or ""), os.path.join(project_dir, "inputs")):
        if cand and os.path.isdir(cand) and cand not in dirs:
            dirs.append(cand)
    return dirs


def _build_photos_zip(photo_roots: List[str], out_path: str) -> int:
    """STORED zip of JPGs. Arcname is relative to the photo root's parent-most 'inputs' folder when present."""
    count = 0
    seen = set()
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_STORED, allowZip64=True) as zf:
        for root in photo_roots:
            base = root
            for r, _, files in os.walk(root):
                for fn in files:
                    if not fn.lower().endswith(PHOTO_SUFFIXES):
                        continue
                    full = os.path.join(r, fn)
                    arc = os.path.relpath(full, base).replace("\\", "/")
                    if arc in seen:
                        continue
                    seen.add(arc)
                    zf.write(full, arc)
                    count += 1
    return count


def _copy_verified(src: str, dst: str) -> str:
    """Copy src -> dst.part, verify size, atomically rename. Returns sha256 of src."""
    sha = _sha256_file(src)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    tmp = dst + ".part"
    shutil.copyfile(src, tmp)
    if os.path.getsize(tmp) != os.path.getsize(src):
        raise IOError(f"Size mismatch copying {src} -> {tmp}")
    os.replace(tmp, dst)
    return sha


def manifest_for(scan_id: str) -> Optional[Dict[str, Any]]:
    folder = _scan_folder(scan_id)
    if not folder:
        return None
    return _read_json(os.path.join(folder, "manifest.json"))


def needs_publish(row: Dict[str, Any]) -> bool:
    if not drive_available():
        return False
    if row.get("status") != "completed":
        return False
    if str(row.get("pending_pass") or "") or str(row.get("quality_stage") or "") == "preview_ready":
        return False
    pd = str(row.get("project_dir") or "")
    ts = str(row.get("tileset_path") or "")
    if not pd or not os.path.isdir(pd) or not ts or not os.path.isfile(ts):
        return False
    m = manifest_for(row["scan_id"])
    if not m:
        return True
    return _to_int(row.get("tileset_version")) > _to_int(m.get("tileset_version"))


def publish_scan(db: Any, row: Dict[str, Any]) -> bool:
    """Pack a completed local scan into SCANS\\<scan_id>\\ on Drive. Idempotent; manifest.json is written last."""
    sid = row["scan_id"]
    pd = str(row.get("project_dir") or "")
    folder = _scan_folder(sid)
    if not folder or not os.path.isdir(pd):
        return False
    with _PUBLISH_LOCK:
        tmp_dir = tempfile.mkdtemp(prefix=f"gs_pub_{sid}_", dir=os.path.join(DATA_DIR))
        try:
            meta = {
                "schema": SCHEMA,
                "scan_id": sid,
                "root_rel": _root_rel(pd, sid),
                "published_by": pc_id(),
                "published_host": socket.gethostname(),
                "published_at": time.time(),
                "tileset_version": _to_int(row.get("tileset_version")),
            }
            bundle_tmp = os.path.join(tmp_dir, f"{sid}.gsbundle")
            with zipfile.ZipFile(bundle_tmp, "w", zipfile.ZIP_STORED, allowZip64=True) as zf:
                for full, rel in _iter_bundle_files(pd):
                    try:
                        zf.write(full, "files/" + rel)
                    except OSError as e:
                        print(f"[PortableBundle] skip {full}: {e}")
                zf.writestr("db_row.json", json.dumps(_relativise_row(row, pd), ensure_ascii=False, default=str))
                zf.writestr("comments.json", json.dumps(_comments_for(db, sid), ensure_ascii=False, default=str))
                zf.writestr("bundle_meta.json", json.dumps(meta, ensure_ascii=False))
            bundle_sha = _copy_verified(bundle_tmp, os.path.join(folder, f"{sid}.gsbundle"))
            manifest = dict(meta)
            manifest.update({"bundle_sha256": bundle_sha, "bundle_size": os.path.getsize(bundle_tmp)})

            photo_roots = _photo_dirs(row, pd)
            photos_tmp = os.path.join(tmp_dir, f"{sid}_photos.zip")
            n_photos = _build_photos_zip(photo_roots, photos_tmp) if photo_roots else 0
            if n_photos > 0:
                manifest["photos_sha256"] = _copy_verified(photos_tmp, os.path.join(folder, f"{sid}_photos.zip"))
                manifest["photos_size"] = os.path.getsize(photos_tmp)
            manifest["photo_count"] = n_photos
            _write_json_atomic(os.path.join(folder, "manifest.json"), manifest)  # completion marker
            print(f"[PortableBundle] Published {sid} ({manifest['bundle_size']/1e6:.0f} MB bundle, {n_photos} photos) -> {folder}")
            return True
        except Exception as e:
            print(f"[PortableBundle] Publish failed for {sid}: {e}")
            return False
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)


# ----------------------------------------------------------------------------------------------
# Archive inputs into PROCESSED
# ----------------------------------------------------------------------------------------------
def _under(path: str, root: str) -> bool:
    try:
        p, r = os.path.normcase(os.path.abspath(path)), os.path.normcase(os.path.abspath(root))
        return p == r or p.startswith(r + os.sep)
    except Exception:
        return False


def archive_inputs(db: Any, row: Dict[str, Any]) -> List[str]:
    """Move the original INPUTS zip(s)/raw folders to PROCESSED (same relative sub-path). Only call after a verified publish."""
    moved: List[str] = []
    pdir = processed_dir()
    if not pdir or not GDRIVE_INPUTS_DIR:
        return moved
    srcs = [p.strip() for p in str(row.get("source_zip_path") or "").split(";") if p.strip()]
    new_srcs: List[str] = []
    changed = False
    for src in srcs:
        if not _under(src, GDRIVE_INPUTS_DIR) or not os.path.exists(src):
            new_srcs.append(src)
            continue
        rel = os.path.relpath(os.path.abspath(src), os.path.abspath(GDRIVE_INPUTS_DIR))
        dst = os.path.join(pdir, rel)
        if os.path.exists(dst):
            stem, ext = os.path.splitext(dst)
            dst = f"{stem}.{int(time.time())}{ext}"
        try:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.move(src, dst)
            moved.append(dst)
            new_srcs.append(dst)
            changed = True
            # Local mirrors of Drive folders delete themselves if their origin vanishes: repoint their marker.
            marker = os.path.join(str(row.get("project_dir") or ""), ".gdrive_inbox_origin.json")
            md = _read_json(marker)
            if md and os.path.normcase(str(md.get("src_folder") or "")) == os.path.normcase(src):
                md["src_folder"] = dst
                _write_json_atomic(marker, md)
            print(f"[PortableBundle] Archived input {src} -> {dst}")
        except Exception as e:
            print(f"[PortableBundle] Could not archive {src}: {e}")
            new_srcs.append(src)
    if changed:
        try:
            cur = db.get_scan(row["scan_id"]) or dict(row)
            cur["source_zip_path"] = ";".join(new_srcs)
            db.upsert_scan(cur)
            meta_fp = os.path.join(str(row.get("project_dir") or ""), "scan_meta.json")
            md = _read_json(meta_fp)
            if md is not None:
                md["source_zip_path"] = ";".join(new_srcs)
                _write_json_atomic(meta_fp, md)
        except Exception as e:
            print(f"[PortableBundle] DB path update note for {row['scan_id']}: {e}")
    return moved


# ----------------------------------------------------------------------------------------------
# Adopt
# ----------------------------------------------------------------------------------------------
def list_remote_manifests() -> Dict[str, Dict[str, Any]]:
    d = scans_dir()
    out: Dict[str, Dict[str, Any]] = {}
    if not d or not os.path.isdir(d):
        return out
    for name in sorted(os.listdir(d)):
        m = _read_json(os.path.join(d, name, "manifest.json"))
        if m and m.get("scan_id") == name:
            out[name] = m
    return out


def bundle_available(scan_id: str) -> bool:
    m = manifest_for(scan_id)
    return bool(m) and os.path.isfile(os.path.join(_scan_folder(scan_id) or "", f"{scan_id}.gsbundle"))


def _local_is_current(db: Any, scan_id: str, manifest: Dict[str, Any]) -> bool:
    local_dir = os.path.join(LOCAL_SCANS_ROOT, str(manifest.get("root_rel") or scan_id))
    if not os.path.isfile(os.path.join(local_dir, "tileset", "tileset.json")):
        return False
    row = db.get_scan(scan_id) or {}
    if row.get("status") != "completed":
        return False
    return _to_int(row.get("tileset_version")) >= _to_int(manifest.get("tileset_version"))


def adopt_scan(db: Any, scan_id: str, manifest: Optional[Dict[str, Any]] = None) -> bool:
    manifest = manifest or manifest_for(scan_id)
    folder = _scan_folder(scan_id)
    if not manifest or not folder:
        return False
    bundle = os.path.join(folder, f"{scan_id}.gsbundle")
    if not os.path.isfile(bundle):
        return False
    root_rel = str(manifest.get("root_rel") or scan_id)
    dest = os.path.abspath(os.path.join(LOCAL_SCANS_ROOT, root_rel))
    if not _under(dest, LOCAL_SCANS_ROOT):
        return False
    stage = os.path.join(LOCAL_SCANS_ROOT, "_adopt", scan_id)
    try:
        shutil.rmtree(stage, ignore_errors=True)
        os.makedirs(stage, exist_ok=True)
        # Verify integrity BEFORE touching the live folder.
        if manifest.get("bundle_sha256") and _sha256_file(bundle) != manifest["bundle_sha256"]:
            print(f"[PortableBundle] Checksum mismatch for {scan_id}; Drive still syncing? Will retry.")
            return False
        with zipfile.ZipFile(bundle, "r") as zf:
            row = json.loads(zf.read("db_row.json").decode("utf-8"))
            comments = json.loads(zf.read("comments.json").decode("utf-8")) if "comments.json" in zf.namelist() else []
            for info in zf.infolist():
                if not info.filename.startswith("files/") or info.is_dir():
                    continue
                target = _safe_member(stage, info.filename[len("files/"):])
                if not target:
                    continue
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with zf.open(info) as src, open(target, "wb") as out:
                    shutil.copyfileobj(src, out, 8 * 1024 * 1024)
        os.makedirs(dest, exist_ok=True)
        entries = sorted(os.listdir(stage), key=lambda n: (n == "tileset", n))  # tileset swapped in last
        for name in entries:
            s, d = os.path.join(stage, name), os.path.join(dest, name)
            if os.path.isdir(s) and os.path.isdir(d):
                old = d + f".old_{int(time.time())}"
                os.replace(d, old)
                os.replace(s, d)
                shutil.rmtree(old, ignore_errors=True)
            else:
                if os.path.isdir(d):
                    shutil.rmtree(d, ignore_errors=True)
                elif os.path.isfile(d):
                    os.remove(d)
                os.replace(s, d)
        local_row = _localise_row(row, dest)
        # Photos live in the Drive archive; point cameras_dir at the local inputs folder only if it really exists here.
        cams = str(local_row.get("cameras_dir") or "")
        if not cams or not os.path.isdir(cams):
            local_row["cameras_dir"] = os.path.join(dest, "inputs")
        local_row["status"] = "completed"
        local_row["progress_pct"] = 100.0
        local_row["quality_stage"] = "full_hq"
        local_row["pending_pass"] = ""
        local_row["adopted_from_pc"] = str(manifest.get("published_host") or manifest.get("published_by") or "")
        db.upsert_scan(local_row)
        if comments:
            try:
                with db._connect() as conn:
                    for c in comments:
                        cols = list(c.keys())
                        conn.execute(
                            f"INSERT OR IGNORE INTO scan_comments ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
                            [c[k] for k in cols],
                        )
                    conn.commit()
            except Exception as e:
                print(f"[PortableBundle] comment import note for {scan_id}: {e}")
        print(f"[PortableBundle] Adopted {scan_id} from Drive (published by {manifest.get('published_host')}) -> {dest}")
        return True
    except Exception as e:
        print(f"[PortableBundle] Adopt failed for {scan_id}: {e}")
        return False
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def adopt_missing(db: Any, deleted_ids: Optional[set] = None) -> List[str]:
    """Adopt every Drive bundle that is missing or older locally. Single-flight; safe to call from a background thread."""
    adopted: List[str] = []
    if not drive_available() or not _ADOPT_LOCK.acquire(blocking=False):
        return adopted
    try:
        mine = set(my_claim_ids())
        busy = {r["scan_id"] for r in db.list_scans() if r.get("status") == "processing" or (r.get("status") == "queued" and r["scan_id"] in mine)}
        for sid, m in list_remote_manifests().items():
            if sid in busy or (deleted_ids and (sid.lower() in deleted_ids)):
                continue
            if _local_is_current(db, sid, m):
                continue
            if adopt_scan(db, sid, m):
                adopted.append(sid)
    finally:
        _ADOPT_LOCK.release()
    return adopted


# ----------------------------------------------------------------------------------------------
# Photos from the Drive archive (used by the Photo tool when raw images are not on this PC)
# ----------------------------------------------------------------------------------------------
_PHOTO_INDEX: Dict[str, Tuple[float, Dict[str, List[str]]]] = {}


def extract_photo_from_archive(scan_id: str, file_key: str) -> Optional[str]:
    folder = _scan_folder(scan_id)
    if not folder:
        return None
    zpath = os.path.join(folder, f"{scan_id}_photos.zip")
    if not os.path.isfile(zpath):
        return None
    norm = str(file_key or "").replace("\\", "/").strip("/")
    base = os.path.basename(norm)
    if not base or ".." in base:
        return None
    mtime = os.path.getmtime(zpath)
    cached = _PHOTO_INDEX.get(scan_id)
    if not cached or cached[0] != mtime:
        idx: Dict[str, List[str]] = {}
        with zipfile.ZipFile(zpath, "r") as zf:
            for n in zf.namelist():
                idx.setdefault(os.path.basename(n).lower(), []).append(n)
        _PHOTO_INDEX[scan_id] = (mtime, idx)
        cached = _PHOTO_INDEX[scan_id]
    cands = cached[1].get(base.lower()) or []
    if not cands:
        return None
    sub = os.path.dirname(norm).lower()
    pick = next((c for c in cands if sub and sub in c.lower()), cands[0])
    out = os.path.join(DATA_DIR, "photo_cache", scan_id, pick.replace("/", os.sep))
    if not os.path.isfile(out):
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with zipfile.ZipFile(zpath, "r") as zf, zf.open(pick) as src, open(out + ".part", "wb") as dst:
            shutil.copyfileobj(src, dst)
        os.replace(out + ".part", out)
    return out


# ----------------------------------------------------------------------------------------------
# Background maintenance loop
# ----------------------------------------------------------------------------------------------
def sync_cycle(db: Any) -> Dict[str, Any]:
    """One pass: release finished claims, adopt missing bundles, publish ONE pending scan, archive its inputs."""
    res: Dict[str, Any] = {"adopted": [], "published": [], "archived": []}
    if not drive_available():
        return res
    for sid in my_claim_ids():
        row = db.get_scan(sid) or {}
        if not row or row.get("status") == "failed" or (row.get("status") == "completed" and manifest_for(sid)):
            release_claim(sid)
    try:
        reg = db.load_deleted_scans_registry() if hasattr(db, "load_deleted_scans_registry") else {}
        deleted = {str(x).lower() for x in (reg.get("scan_ids") or [])}
    except Exception:
        deleted = set()
    res["adopted"] = adopt_missing(db, deleted)
    for row in db.list_scans():
        sid = row["scan_id"]
        if sid.lower() in deleted:
            continue
        if foreign_claim_owner(sid) or _FAIL_UNTIL.get(sid, 0) > time.time():
            continue
        if needs_publish(row):
            if publish_scan(db, row):
                res["published"].append(sid)
                res["archived"] += archive_inputs(db, db.get_scan(sid) or row)
                release_claim(sid)
                break  # one heavy publish per cycle
            _FAIL_UNTIL[sid] = time.time() + 3600  # back off an hour, keep serving other scans
        m = manifest_for(sid)
        if m and row.get("status") == "completed" and str(row.get("source_zip_path") or ""):
            moved = archive_inputs(db, row)
            if moved:
                res["archived"] += moved
    return res


def portable_sync_loop(db: Any, is_enabled=lambda: True, interval: float = 30.0) -> None:
    time.sleep(15.0)
    while True:
        try:
            if is_enabled():
                sync_cycle(db)
        except Exception as e:
            print(f"[PortableBundle] sync cycle note: {e}")
        time.sleep(interval)
