#!/usr/bin/env python3
"""
Google OAuth Authentication & Scoped External Share Link Access Control
Implements:
- Requirement 4.a: Company Google OAuth login with full system access.
- Requirement 4.b: Scoped view links (/s/<token>) for a single scan or project group
  so external viewers cannot see any other scans, and access can be revoked at any time.
"""

import re
import time
import json
import hmac
import hashlib
import base64
import secrets
import ipaddress
import threading
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional, Set, Tuple

from pc_worker.config import PUBLIC_BASE_URL, ALLOWED_WORKSPACE_DOMAINS, GOOGLE_OAUTH_CLIENT_ID, TUNNEL_SHARED_KEY
from pc_worker.priority_queue import ScanQueueDB, DB_LOCK

_GEO_INFLIGHT_LOCK = threading.Lock()
_GEO_INFLIGHT_IPS: Set[str] = set()


def parse_user_agent(ua: str) -> Dict[str, Any]:
    """
    Parses HTTP User-Agent into structured {browser, os, device_type, is_bot}.
    Carefully distinguishes social/chat link-preview bots (e.g. line-poker, Slackbot,
    WhatsApp unfurler, facebookexternalhit) from real humans opening links inside
    in-app browsers (e.g. LINE In-App Browser on iOS/Android).
    """
    raw = (ua or "").strip()
    low = raw.lower()
    if not raw:
        return {"browser": "Unknown", "os": "Unknown", "device_type": "Unknown", "is_bot": False}

    # 1. Explicit link-preview crawlers / unfurlers
    bot_signatures = [
        ("line-poker", "LINE Preview Bot"),
        ("linelinkpreview", "LINE Preview Bot"),
        ("facebookexternalhit", "Facebook / Meta Preview"),
        ("facebot", "Facebook / Meta Preview"),
        ("slackbot-linkexpanding", "Slack Link Preview"),
        ("slack-imgproxy", "Slack Image Proxy"),
        ("slackbot", "Slack Bot"),
        ("telegrambot", "Telegram Preview Bot"),
        ("discordbot", "Discord Preview Bot"),
        ("twitterbot", "X / Twitter Card Bot"),
        ("linkedinbot", "LinkedIn Preview Bot"),
        ("whatsapp", "WhatsApp Link Preview"),
        ("imessagelinkpreview", "iMessage Preview"),
        ("applebot", "Apple Link Preview"),
        ("skypeuripreview", "Teams / Skype Preview"),
        ("viber", "Viber Preview"),
        ("pinterest", "Pinterest Bot"),
        ("iframely", "Iframely Unfurler"),
        ("embedly", "Embedly Unfurler"),
        ("google-inspectiontool", "Google Inspection Bot"),
        ("googlebot", "Googlebot"),
        ("bingbot", "Bingbot"),
        ("headlesschrome", "Headless Browser"),
    ]
    for sig, label in bot_signatures:
        if sig in low:
            # Guard: WhatsApp in-app webview on Android/iOS has Mozilla/5.0 + Safari/Chrome; bare WhatsApp/2.x is preview fetcher
            if sig == "whatsapp" and "mozilla/5.0" in low and ("applewebkit" in low or "chrome/" in low):
                break
            return {"browser": label, "os": "Crawler", "device_type": "Bot", "is_bot": True}

    # Bare "Line/x.y" without Mozilla/AppleWebKit is LINE's server unfurler
    if (low.startswith("line/") or " line/" in f" {low}") and "applewebkit" not in low and "mozilla/5.0" not in low:
        return {"browser": "LINE Preview Bot", "os": "Crawler", "device_type": "Bot", "is_bot": True}

    if any(k in low for k in ("bot/", "crawler", "spider", "curl/", "python-urllib", "python-requests", "go-http-client")):
        return {"browser": raw.split("/")[0][:32] or "Bot", "os": "Crawler", "device_type": "Bot", "is_bot": True}

    # 2. Operating System detection for human visitors
    os_label = "Unknown OS"
    if "iphone" in low:
        m = re.search(r"iphone os (\d+)[._](\d+)?", low)
        os_label = f"iOS {m.group(1)}" + (f".{m.group(2)}" if m and m.group(2) else "") if m else "iOS"
    elif "ipad" in low:
        m = re.search(r"cpu os (\d+)[._](\d+)?", low)
        os_label = f"iPadOS {m.group(1)}" if m else "iPadOS"
    elif "android" in low:
        m = re.search(r"android (\d+(?:\.\d+)?)", low)
        os_label = f"Android {m.group(1)}" if m else "Android"
    elif "windows nt" in low:
        if "windows nt 10.0" in low:
            os_label = "Windows 10/11"
        elif "windows nt 6.3" in low:
            os_label = "Windows 8.1"
        elif "windows nt 6.1" in low:
            os_label = "Windows 7"
        else:
            os_label = "Windows"
    elif "mac os x" in low or "macintosh" in low:
        m = re.search(r"mac os x (\d+)[._](\d+)?", low)
        os_label = f"macOS {m.group(1)}.{m.group(2)}" if (m and m.group(2)) else "macOS"
    elif "cros" in low:
        os_label = "ChromeOS"
    elif "linux" in low:
        os_label = "Linux"

    # 3. Device Type
    if "ipad" in low or "tablet" in low or ("android" in low and "mobile" not in low):
        device_type = "Tablet"
    elif any(k in low for k in ("iphone", "ipod", "mobile", "android")):
        device_type = "Mobile"
    else:
        device_type = "Desktop"

    # 4. Browser / In-App Container detection
    browser = "Browser"
    m_line = re.search(r"\bline/(\d+(?:\.\d+)?)", low)
    if m_line:
        browser = f"LINE In-App {m_line.group(1)}"
    elif "micromessenger/" in low:
        browser = "WeChat In-App"
    elif "fban" in low or "fbav" in low:
        browser = "Facebook In-App"
    elif "instagram" in low:
        browser = "Instagram In-App"
    elif "edg/" in low or "edgios/" in low or "edga/" in low:
        m = re.search(r"edg(?:ios|a)?/(\d+)", low)
        browser = f"Edge {m.group(1)}" if m else "Edge"
    elif "opr/" in low or "opera" in low:
        m = re.search(r"opr/(\d+)", low)
        browser = f"Opera {m.group(1)}" if m else "Opera"
    elif "crios/" in low:
        m = re.search(r"crios/(\d+)", low)
        browser = f"Chrome iOS {m.group(1)}" if m else "Chrome iOS"
    elif "fxios/" in low:
        m = re.search(r"fxios/(\d+)", low)
        browser = f"Firefox iOS {m.group(1)}" if m else "Firefox iOS"
    elif "firefox/" in low:
        m = re.search(r"firefox/(\d+)", low)
        browser = f"Firefox {m.group(1)}" if m else "Firefox"
    elif "samsungbrowser/" in low:
        m = re.search(r"samsungbrowser/(\d+)", low)
        browser = f"Samsung Internet {m.group(1)}" if m else "Samsung Internet"
    elif "chrome/" in low and "safari/" in low:
        m = re.search(r"chrome/(\d+)", low)
        browser = f"Chrome {m.group(1)}" if m else "Chrome"
    elif "version/" in low and "safari/" in low:
        m = re.search(r"version/(\d+(?:\.\d+)?)", low)
        browser = f"Safari {m.group(1)}" if m else "Safari"
    elif "safari/" in low:
        browser = "Safari"

    return {
        "browser": browser,
        "os": os_label,
        "device_type": device_type,
        "is_bot": False,
    }


def is_link_preview_bot(ua: str) -> bool:
    return bool(parse_user_agent(ua).get("is_bot", False))


def _is_private_or_loopback_ip(ip_str: str) -> bool:
    clean = (ip_str or "").strip()
    if not clean or clean.lower() == "localhost":
        return True
    try:
        ip_obj = ipaddress.ip_address(clean)
        return bool(ip_obj.is_private or ip_obj.is_loopback or ip_obj.is_link_local or ip_obj.is_reserved)
    except Exception:
        return True


def _get_session_hmac_key() -> bytes:
    return hashlib.sha256(f"gatheringscans-session-hmac-v1:{TUNNEL_SHARED_KEY}".encode("utf-8")).digest()


def issue_session_token(email: str, role: str = "", ttl_sec: int = 86400 * 14) -> str:
    clean_email = (email or "").strip().lower()
    if not clean_email:
        return ""
    payload = {
        "email": clean_email,
        "role": (role or "").strip().lower(),
        "exp": int(time.time()) + int(ttl_sec),
    }
    raw_b64 = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode("utf-8")).decode("ascii").rstrip("=")
    sig = hmac.new(_get_session_hmac_key(), raw_b64.encode("ascii"), hashlib.sha256).digest()
    sig_b64 = base64.urlsafe_b64encode(sig).decode("ascii").rstrip("=")
    return f"{raw_b64}.{sig_b64}"


def verify_session_token(token: str) -> Optional[str]:
    tok = (token or "").strip()
    if not tok or "." not in tok:
        return None
    try:
        raw_b64, sig_b64 = tok.split(".", 1)
        expected_sig = hmac.new(_get_session_hmac_key(), raw_b64.encode("ascii"), hashlib.sha256).digest()
        expected_b64 = base64.urlsafe_b64encode(expected_sig).decode("ascii").rstrip("=")
        if not hmac.compare_digest(sig_b64, expected_b64):
            return None
        padded = raw_b64 + "=" * (-len(raw_b64) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
        if int(payload.get("exp") or 0) <= int(time.time()):
            return None
        email = str(payload.get("email") or "").strip().lower()
        return email if email else None
    except Exception:
        return None


OWNER_EMAIL = "glibivanov@gatheren.com.tw"
OWNER_EMAILS = {
    "glibivanov@gatheren.com.tw",
    "gleb.ivanov1999@gmail.com",
}

ROLE_LEVELS: Dict[str, int] = {
    "owner": 5,
    "admin": 4,
    "editor": 3,
    "viewer": 2,
    "guest": 1,
}

ROLE_LABELS: Dict[str, str] = {
    "owner": "Owner (System Owner)",
    "admin": "Admin (User & Role Manager)",
    "editor": "Editor (Workflows & Renaming)",
    "viewer": "Viewer (View & Measure Only)",
    "guest": "Guest (Read-Only Basic Tools)",
}


def normalize_role(role_str: str, email: str = "", is_owner: bool = False, is_admin: bool = False) -> str:
    clean_email = (email or "").strip().lower()
    if clean_email in OWNER_EMAILS or is_owner:
        return "owner"
    r = (role_str or "").strip().lower()
    if r == "owner":
        return "admin"
    if r in ("admin", "administrator") or is_admin:
        return "admin"
    if r in ("editor", "site_engineer", "pm", "engineer"):
        return "editor"
    if r in ("viewer", "read_only", "readonly"):
        return "viewer"
    if r in ("guest", "external"):
        return "guest"
    return "editor"


def get_role_permissions(role: str, has_share_token: bool = False) -> Dict[str, Any]:
    eff_role = "guest" if has_share_token else (role if role in ROLE_LEVELS else "viewer")
    lvl = ROLE_LEVELS.get(eff_role, 1)
    can_manage_users = lvl >= 4 and not has_share_token
    can_edit_names = lvl >= 3 and not has_share_token
    can_run_workflows = lvl >= 3 and not has_share_token
    can_share = lvl >= 2 and not has_share_token
    can_manage_shares = lvl >= 3 and not has_share_token
    can_download = lvl >= 2 and not has_share_token
    if eff_role == "guest":
        allowed_tools = ["orbit", "distance", "area", "coordinates"]
    elif eff_role == "viewer":
        allowed_tools = [
            "orbit", "laser", "coordinates", "distance", "angle",
            "area", "volume", "profile", "contours", "photos", "comments",
        ]
    else:
        allowed_tools = [
            "orbit", "laser", "coordinates", "distance", "angle",
            "area", "volume", "profile", "contours", "crop", "photos", "comments",
        ]
    return {
        "role": eff_role,
        "role_label": ROLE_LABELS.get(eff_role, eff_role.title()),
        "permission_level": lvl,
        "can_manage_users": can_manage_users,
        "can_edit_names": can_edit_names,
        "can_run_workflows": can_run_workflows,
        "can_share": can_share,
        "can_manage_shares": can_manage_shares,
        "can_download": can_download,
        "allowed_tools": allowed_tools,
    }


class AuthAndSharingManager:
    def __init__(self, db: ScanQueueDB):
        self.db = db
        self._init_profiles_table()

    def _init_profiles_table(self):
        with DB_LOCK, self.db._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS user_profiles (
                    email TEXT PRIMARY KEY,
                    id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    zh_name TEXT DEFAULT '',
                    role TEXT DEFAULT 'editor',
                    color TEXT DEFAULT '#0284c7',
                    picture TEXT DEFAULT '',
                    google_sub TEXT DEFAULT '',
                    is_google_authenticated INTEGER DEFAULT 0,
                    is_admin INTEGER DEFAULT 0,
                    is_owner INTEGER DEFAULT 0,
                    allowed_projects_json TEXT DEFAULT '["*"]',
                    language TEXT DEFAULT 'zh-TW',
                    updated_at TEXT NOT NULL
                )
                """
            )
            try:
                conn.execute("ALTER TABLE user_profiles ADD COLUMN zh_name TEXT DEFAULT ''")
            except Exception:
                pass
            try:
                conn.execute("ALTER TABLE user_profiles ADD COLUMN language TEXT DEFAULT 'zh-TW'")
            except Exception:
                pass
            conn.execute("DELETE FROM user_profiles WHERE lower(email) LIKE '%vitaly%' OR lower(name) LIKE '%vitaly%'")
            conn.execute("UPDATE user_profiles SET name = '雲在天', role = 'owner', is_owner = 1, is_admin = 1 WHERE lower(email) = 'glibivanov@gatheren.com.tw'")
            conn.execute("UPDATE user_profiles SET role = 'owner', is_owner = 1, is_admin = 1 WHERE lower(email) = 'gleb.ivanov1999@gmail.com'")
            conn.execute("UPDATE user_profiles SET role = 'editor' WHERE role IN ('site_engineer', 'pm') AND is_owner = 0 AND is_admin = 0")
            conn.execute("UPDATE user_profiles SET role = 'admin', is_admin = 1 WHERE role = 'admin' AND is_owner = 0")
            now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
            default_staff = [
                ("glibivanov@gatheren.com.tw", "u_glibivanov", "雲在天", "owner", "#14b8a6", "", "107639887113416939995", 1, 1, 1, '["*"]', now_str),
                ("gleb.ivanov1999@gmail.com", "u_glebivanov", "雲在天 (Glib Ivanov)", "owner", "#14b8a6", "", "", 1, 1, 1, '["*"]', now_str),
                ("frankchao@gatheren.com.tw", "u_frankchao", "趙冠人", "admin", "#ef4444", "", "113563863225856947636", 1, 1, 0, '["*"]', now_str),
                ("wenhu@gatheren.com.tw", "u_wenhu", "胡佳雯", "admin", "#ec4899", "", "", 1, 1, 0, '["*"]', now_str),
                ("howardhsueh@gatheren.com.tw", "u_howardhsueh", "薛鈞豪", "editor", "#3b82f6", "", "", 1, 0, 0, '["*"]', now_str),
                ("feiwenhsueh@gatheren.com.tw", "u_feiwenhsueh", "薛斐文", "editor", "#0284c7", "", "103768730904451087495", 1, 0, 0, '["*"]', now_str),
                ("litasu@gatheren.com.tw", "u_litasu", "蘇容德", "editor", "#a855f7", "", "", 1, 0, 0, '["*"]', now_str),
                ("szhsienyang@gatheren.com.tw", "u_szhsienyang", "楊斯顯", "editor", "#f97316", "", "", 1, 0, 0, '["*"]', now_str),
                ("shengwenhuang@gatheren.com.tw", "u_shengwenhuang", "黃聖文", "editor", "#eab308", "", "", 1, 0, 0, '["*"]', now_str),
                ("leocheng@gatheren.com.tw", "u_leocheng", "鄭宇翔", "editor", "#06b6d4", "", "", 1, 0, 0, '["*"]', now_str),
                ("jasonlo@gatheren.com.tw", "u_jasonlo", "駱介正", "viewer", "#6366f1", "", "", 1, 0, 0, '["*"]', now_str),
                ("kentyu@gatheren.com.tw", "u_kentyu", "游忠偉", "editor", "#10b981", "", "", 1, 0, 0, '["*"]', now_str),
                ("chengyouyeh@gatheren.com.tw", "u_chengyouyeh", "葉烝佑", "editor", "#84cc16", "", "", 1, 0, 0, '["*"]', now_str),
                ("tengtewang@gatheren.com.tw", "u_tengtewang", "王騰德", "editor", "#0ea5e9", "", "", 1, 0, 0, '["*"]', now_str),
                ("congrongchen@gatheren.com.tw", "u_congrongchen", "陳聰榮", "viewer", "#f59e0b", "", "", 1, 0, 0, '["*"]', now_str),
                ("edwardli@gatheren.com.tw", "u_edwardli", "李振嘉", "viewer", "#8b5cf6", "", "", 1, 0, 0, '["*"]', now_str),
                ("neilsun@gatheren.com.tw", "u_neilsun", "孫暐岑", "viewer", "#22c55e", "", "", 1, 0, 0, '["*"]', now_str),
                ("kevinchen@gatheren.com.tw", "u_kevinchen", "陳冠羽", "viewer", "#d946ef", "", "", 1, 0, 0, '["*"]', now_str),
            ]
            for row in default_staff:
                conn.execute(
                    """
                    INSERT INTO user_profiles (
                        email, id, name, role, color, picture, google_sub,
                        is_google_authenticated, is_admin, is_owner, allowed_projects_json, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(email) DO NOTHING
                    """,
                    row,
                )
            conn.commit()

    def get_user_profile(self, email: str) -> Optional[Dict[str, Any]]:
        clean = (email or "").strip().lower()
        if not clean:
            return None
        for p in self.list_user_profiles():
            if p.get("email", "").lower() == clean:
                return p
        return None

    def list_user_profiles(self) -> List[Dict[str, Any]]:
        prefs_map = self.db._load_user_prefs_json() if hasattr(self.db, "_load_user_prefs_json") else {}
        with DB_LOCK, self.db._connect() as conn:
            rows = conn.execute("SELECT * FROM user_profiles ORDER BY is_owner DESC, is_admin DESC, name ASC").fetchall()
            out: List[Dict[str, Any]] = []
            for r in rows:
                d = dict(r)
                try:
                    allowed = json.loads(d.get("allowed_projects_json") or '["*"]')
                except Exception:
                    allowed = ["*"]
                pic = d.get("picture", "")
                em_low = str(d.get("email") or "").strip().lower()
                norm_r = normalize_role(
                    d.get("role", "editor"),
                    email=em_low,
                    is_owner=bool(d.get("is_owner", 0)),
                    is_admin=bool(d.get("is_admin", 0)),
                )
                perms = get_role_permissions(norm_r, has_share_token=False)
                json_lang = (prefs_map.get(em_low) or {}).get("language") if isinstance(prefs_map.get(em_low), dict) else None
                raw_lang = str(json_lang or d.get("language") or "zh-TW").strip()
                lang_val = "en" if raw_lang.lower() in ("en", "en-us", "en-gb", "english") else "zh-TW"
                prof = {
                    "id": d["id"],
                    "name": d["name"],
                    "zh_name": d.get("zh_name") or d["name"],
                    "email": d["email"],
                    "role": norm_r,
                    "role_label": perms["role_label"],
                    "permission_level": perms["permission_level"],
                    "permissions": perms,
                    "color": d["color"],
                    "picture": pic,
                    "avatar_url": pic,
                    "googleSub": d.get("google_sub", ""),
                    "hasConfigured": True,
                    "isGoogleAuthenticated": bool(d.get("is_google_authenticated", 0)),
                    "isAdmin": norm_r in ("owner", "admin"),
                    "isOwner": norm_r == "owner",
                    "allowedProjects": allowed,
                    "language": lang_val,
                    "lastUpdatedStr": d.get("updated_at", ""),
                }
                out.append(prof)
            out.sort(key=lambda x: (-x["permission_level"], x["name"]))
            return out

    def upsert_user_profile(self, profile: Dict[str, Any], preserve_existing_role: bool = False) -> Dict[str, Any]:
        email = str(profile.get("email") or "").strip().lower()
        name = str(profile.get("name") or "").strip()
        zh_name = str(profile.get("zh_name") or "").strip()
        if not name and zh_name:
            name = zh_name
        if not name and email:
            name = email.split("@")[0]
        if not email:
            email = f"{name.lower().replace(' ', '.')}@gatheren.com.tw"
        if "vitaly" in email or "vitaly" in name.lower():
            raise ValueError("Invalid user profile")

        existing = self.get_user_profile(email)
        if not zh_name:
            zh_name = (existing and existing.get("zh_name")) or name
        is_owner = 1 if email in OWNER_EMAILS else 0
        if is_owner:
            role = "owner"
        elif preserve_existing_role and existing:
            role = existing["role"]
        elif "role" in profile and profile.get("role"):
            role = normalize_role(str(profile.get("role")), email=email)
        elif existing:
            role = existing["role"]
        else:
            role = "editor" if email.endswith("@gatheren.com.tw") else "viewer"

        is_admin = 1 if role in ("owner", "admin") else 0
        uid = str((existing and existing.get("id")) or profile.get("id") or f"u_{int(time.time())}")
        color = str(profile.get("color") or (existing and existing.get("color")) or ("#14b8a6" if is_owner else "#0284c7"))
        picture = str(profile.get("picture") or profile.get("avatar_url") or (existing and existing.get("picture")) or "")
        google_sub = str(profile.get("googleSub") or profile.get("google_sub") or (existing and existing.get("googleSub")) or "")
        is_google = int(bool(profile.get("isGoogleAuthenticated", False) or profile.get("auth_provider") == "google" or (existing and existing.get("isGoogleAuthenticated"))))
        allowed = profile.get("allowedProjects") if isinstance(profile.get("allowedProjects"), list) else ((existing and existing.get("allowedProjects")) or ["*"])
        raw_lang = str(
            profile.get("language")
            or profile.get("lang")
            or (existing and existing.get("language"))
            or (self.db.get_user_settings(email).get("language") if hasattr(self.db, "get_user_settings") else "zh-TW")
            or "zh-TW"
        ).strip()
        lang_val = "en" if raw_lang.lower() in ("en", "en-us", "en-gb", "english") else "zh-TW"
        now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

        with DB_LOCK, self.db._connect() as conn:
            conn.execute(
                """
                INSERT INTO user_profiles (
                    email, id, name, zh_name, role, color, picture, google_sub,
                    is_google_authenticated, is_admin, is_owner, allowed_projects_json, language, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(email) DO UPDATE SET
                    name=excluded.name,
                    zh_name=CASE WHEN excluded.zh_name != '' THEN excluded.zh_name ELSE user_profiles.zh_name END,
                    role=excluded.role,
                    color=excluded.color,
                    picture=CASE WHEN excluded.picture != '' THEN excluded.picture ELSE user_profiles.picture END,
                    google_sub=CASE WHEN excluded.google_sub != '' THEN excluded.google_sub ELSE user_profiles.google_sub END,
                    is_google_authenticated=CASE WHEN excluded.is_google_authenticated = 1 THEN 1 ELSE user_profiles.is_google_authenticated END,
                    is_admin=excluded.is_admin,
                    is_owner=excluded.is_owner,
                    allowed_projects_json=excluded.allowed_projects_json,
                    language=excluded.language,
                    updated_at=excluded.updated_at
                """,
                (
                    email,
                    uid,
                    name,
                    zh_name,
                    role,
                    color,
                    picture,
                    google_sub,
                    is_google,
                    is_admin,
                    is_owner,
                    json.dumps(allowed),
                    lang_val,
                    now_str,
                ),
            )
            conn.commit()
        if "language" in profile or "lang" in profile:
            try:
                self.db.update_user_settings(email, {"language": lang_val, "display_name": name})
            except Exception:
                pass
        return self.get_user_profile(email) or {
            "id": uid,
            "name": name,
            "zh_name": zh_name,
            "email": email,
            "role": role,
            "role_label": ROLE_LABELS.get(role, role),
            "permission_level": ROLE_LEVELS.get(role, 2),
            "permissions": get_role_permissions(role, False),
            "color": color,
            "picture": picture,
            "avatar_url": picture,
            "isGoogleAuthenticated": bool(is_google),
            "isAdmin": bool(is_admin),
            "isOwner": bool(is_owner),
            "allowedProjects": allowed,
            "language": lang_val,
        }

    def admin_save_user(
        self,
        actor_email: str,
        target_email: str,
        target_name: str = "",
        new_role: str = "viewer",
        color: str = "",
        name: str = "",
        zh_name: str = "",
        role: str = "",
        gchat_user_id: str = "",
    ) -> Dict[str, Any]:
        """
        Enforces 5-level role hierarchy when adding or updating a user from the Admin Control Panel:
        - Owner (glibivanov@gatheren.com.tw, level 5) can add/edit any lower user and assign Admin/Editor/Viewer/Guest.
        - Admin (level 4) can add new users and edit lower users (Editor/Viewer/Guest), cannot edit Owner or other Admins.
        """
        try:
            actor_clean = (actor_email or "").strip().lower()
            target_clean = (target_email or "").strip().lower()
            if not target_clean or "@" not in target_clean:
                return {"ok": False, "error": "A valid user email address is required."}

            actor_prof = self.get_user_profile(actor_clean)
            actor_role = actor_prof["role"] if actor_prof else ("owner" if actor_clean in OWNER_EMAILS else "viewer")
            actor_lvl = ROLE_LEVELS.get(actor_role, 1)
            if actor_lvl < 4:
                return {"ok": False, "error": "Only Owner and Admin accounts can manage user roles."}

            if target_clean in OWNER_EMAILS and actor_clean not in OWNER_EMAILS:
                return {"ok": False, "error": "Cannot modify the System Owner account."}

            eff_role_input = role or new_role or "viewer"
            req_role = normalize_role(eff_role_input, email=target_clean)
            req_lvl = ROLE_LEVELS.get(req_role, 2)

            existing_target = self.get_user_profile(target_clean)
            if existing_target and target_clean not in OWNER_EMAILS:
                target_cur_lvl = ROLE_LEVELS.get(existing_target["role"], 2)
                if actor_lvl <= target_cur_lvl and actor_clean not in OWNER_EMAILS:
                    return {"ok": False, "error": "Admins can only edit users with lower roles (Editor, Viewer, Guest)."}
                if req_lvl >= actor_lvl and actor_clean not in OWNER_EMAILS:
                    return {"ok": False, "error": "Admins can only assign roles lower than Admin (Editor, Viewer, Guest)."}

            eff_name = (name or target_name or zh_name or (existing_target and existing_target["name"]) or target_clean.split("@")[0]).strip()
            eff_zh = (zh_name or (existing_target and existing_target.get("zh_name")) or eff_name).strip()
            if zh_name and name and zh_name not in eff_name:
                display_name = f"{zh_name} ({name})"
            else:
                display_name = eff_name

            saved_user = self.upsert_user_profile(
                {
                    "email": target_clean,
                    "name": display_name,
                    "zh_name": eff_zh,
                    "role": "owner" if target_clean in OWNER_EMAILS else req_role,
                    "color": color or (existing_target and existing_target.get("color")) or "#0284c7",
                },
                preserve_existing_role=False,
            )
            all_users = self.list_user_profiles()
            return {"ok": True, "user": saved_user, "users": all_users, "profiles": all_users}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def admin_delete_user(self, actor_email: str, target_email: str) -> Dict[str, Any]:
        try:
            actor_clean = (actor_email or "").strip().lower()
            target_clean = (target_email or "").strip().lower()
            if target_clean in OWNER_EMAILS:
                return {"ok": False, "error": "The System Owner account cannot be removed."}
            actor_prof = self.get_user_profile(actor_clean)
            actor_role = actor_prof["role"] if actor_prof else ("owner" if actor_clean in OWNER_EMAILS else "viewer")
            actor_lvl = ROLE_LEVELS.get(actor_role, 1)
            if actor_lvl < 4:
                return {"ok": False, "error": "Only Owner and Admin accounts can remove users."}
            existing_target = self.get_user_profile(target_clean)
            if existing_target:
                target_lvl = ROLE_LEVELS.get(existing_target["role"], 2)
                if actor_lvl <= target_lvl and actor_clean not in OWNER_EMAILS:
                    return {"ok": False, "error": "Admins can only remove users with lower roles."}
            with DB_LOCK, self.db._connect() as conn:
                cur = conn.execute("DELETE FROM user_profiles WHERE lower(email) = ?", (target_clean,))
                conn.commit()
                deleted = cur.rowcount > 0
            all_users = self.list_user_profiles()
            return {"ok": True, "deleted": deleted, "users": all_users, "profiles": all_users}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def verify_google_oauth_credential(self, credential_jwt: str, fallback_profile: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        Cryptographically verifies a Google Identity Services JWT credential against Google's
        public keys / tokeninfo endpoint (`aud == GOOGLE_OAUTH_CLIENT_ID`, `iss`, `exp`, `email_verified`)
        and issues an HMAC-signed `session_token`. Never accepts unsigned JWTs or unverified fallback profiles.
        """
        raw_jwt = str(credential_jwt or "").strip()
        parts = raw_jwt.split(".")
        if len(parts) != 3 or not all(parts):
            raise ValueError("Invalid or missing Google OAuth ID token.")

        claims: Optional[Dict[str, Any]] = None
        verify_err = ""
        try:
            from google.auth.transport import requests as _g_requests
            from google.oauth2 import id_token as _g_id_token

            claims = _g_id_token.verify_oauth2_token(raw_jwt, _g_requests.Request(), GOOGLE_OAUTH_CLIENT_ID)
        except ImportError:
            claims = None
        except Exception as ge:
            verify_err = str(ge)
            claims = None

        if claims is None:
            try:
                ti_url = "https://oauth2.googleapis.com/tokeninfo?id_token=" + urllib.parse.quote(raw_jwt, safe="")
                req = urllib.request.Request(ti_url, headers={"Accept": "application/json"}, method="GET")
                with urllib.request.urlopen(req, timeout=8) as resp:
                    if resp.status == 200:
                        claims = json.loads(resp.read().decode("utf-8"))
            except Exception as te:
                verify_err = verify_err or str(te)
                claims = None

        if not isinstance(claims, dict):
            raise ValueError(f"Google OAuth signature verification failed: {verify_err or 'invalid token'}")

        aud = str(claims.get("aud") or "").strip()
        iss = str(claims.get("iss") or "").strip()
        exp = int(claims.get("exp") or 0)
        email_verified = str(claims.get("email_verified", "")).strip().lower() in ("true", "1")
        email = str(claims.get("email") or "").strip().lower()

        if aud != GOOGLE_OAUTH_CLIENT_ID:
            raise ValueError("Google OAuth audience mismatch.")
        if iss not in ("accounts.google.com", "https://accounts.google.com"):
            raise ValueError("Google OAuth issuer mismatch.")
        if exp <= int(time.time()):
            raise ValueError("Google OAuth token has expired.")
        if not email or not email_verified:
            raise ValueError("Google OAuth account email is not verified.")

        name = str(claims.get("name") or (email.split("@")[0] if email else "Engineer")).strip()
        hd = str(claims.get("hd") or (email.split("@")[1] if "@" in email else "")).lower()
        is_owner = email in OWNER_EMAILS
        prof = self.upsert_user_profile(
            {
                "email": email,
                "name": name,
                "picture": claims.get("picture", ""),
                "googleSub": claims.get("sub", ""),
                "role": "owner" if is_owner else ("editor" if email.endswith("@gatheren.com.tw") else "viewer"),
                "color": "#14b8a6" if is_owner else "#0284c7",
                "isGoogleAuthenticated": True,
                "isAdmin": is_owner,
                "isOwner": is_owner,
            },
            preserve_existing_role=True,
        )
        eff_role = prof.get("role", "editor")
        session_token = issue_session_token(email, role=eff_role)
        return {
            "authenticated": True,
            "session_token": session_token,
            "client_id": GOOGLE_OAUTH_CLIENT_ID,
            "role": eff_role,
            "role_label": prof.get("role_label", ""),
            "permission_level": prof.get("permission_level", 3),
            "permissions": prof.get("permissions", get_role_permissions(eff_role, False)),
            "email": email,
            "name": prof.get("name", name),
            "domain": hd,
            "picture": prof.get("picture", ""),
            "isGoogleAuthenticated": True,
            "isAdmin": prof.get("isAdmin", False),
            "isOwner": prof.get("isOwner", False),
            "allowedProjects": prof.get("allowedProjects", ["*"]),
            "language": prof.get("language", "zh-TW"),
        }

    def create_share_link(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        Creates a scoped external view link (/s/<token>) for either:
        - scope_type = 'scan' (target_id = scan_id)
        - scope_type = 'group' (target_id = project_group)
        """
        scope_type = payload.get("scope_type", "scan").strip().lower()
        if scope_type not in ("scan", "group"):
            raise ValueError("scope_type must be 'scan' or 'group'")

        target_id = payload.get("target_id", "").strip()
        if not target_id:
            raise ValueError("target_id is required")

        token = payload.get("token") or secrets.token_urlsafe(12)
        label = payload.get("label") or f"External View — {target_id}"
        created_by_email = (
            payload.get("created_by_email")
            or payload.get("actor_email")
            or "system@gatheren.com.tw"
        )
        created_by_name = payload.get("created_by_name") or created_by_email.split("@")[0]
        created_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        expires_at = payload.get("expires_at", "")
        allow_download = 1 if payload.get("allow_download", False) else 0
        allow_measurements = 1 if payload.get("allow_measurements", True) else 0
        allow_comments = 1 if payload.get("allow_comments", True) else 0

        with DB_LOCK, self.db._connect() as conn:
            conn.execute(
                """
                INSERT INTO share_links (
                    token, label, scope_type, target_id, created_by_email, created_by_name,
                    created_at, expires_at, allow_download, allow_measurements, allow_comments,
                    revoked, revoked_at, view_count
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '', 0)
                """,
                (
                    token,
                    label,
                    scope_type,
                    target_id,
                    created_by_email,
                    created_by_name,
                    created_at,
                    expires_at,
                    allow_download,
                    allow_measurements,
                    allow_comments,
                ),
            )
            conn.commit()
        return self.get_share_link(token)

    def _compute_share_stats_map(self, conn, token_filter: Optional[str] = None) -> Dict[str, Dict[str, Any]]:
        if token_filter:
            rows = conn.execute(
                "SELECT * FROM share_access_sessions WHERE token = ? ORDER BY started_ts DESC",
                (token_filter,),
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM share_access_sessions ORDER BY started_ts DESC").fetchall()

        grouped: Dict[str, List[Dict[str, Any]]] = {}
        for r in rows:
            d = dict(r)
            grouped.setdefault(str(d.get("token") or ""), []).append(d)

        stats_map: Dict[str, Dict[str, Any]] = {}
        for tok, sess_list in grouped.items():
            human = [s for s in sess_list if not bool(s.get("is_bot", 0))]
            bots = [s for s in sess_list if bool(s.get("is_bot", 0))]
            uniq_keys: Set[str] = set()
            total_active = 0.0
            total_open = 0.0
            last_viewed = ""
            last_ts = 0.0
            tool_totals: Dict[str, int] = {}
            comments_sum = 0
            downloads_sum = 0
            measurements_sum = 0

            for s in human:
                vid = (s.get("visitor_id") or "").strip()
                if not vid:
                    vid = f"{s.get('ip_address', '')}|{s.get('browser', '')}|{s.get('os', '')}"
                uniq_keys.add(vid)
                total_active += max(0.0, float(s.get("active_duration_sec") or 0.0))
                total_open += max(0.0, float(s.get("total_duration_sec") or 0.0))
                lts = float(s.get("last_active_ts") or 0.0)
                if lts >= last_ts:
                    last_ts = lts
                    last_viewed = str(s.get("last_active_at") or "")
                comments_sum += int(s.get("comments_posted") or 0)
                downloads_sum += int(s.get("downloads_count") or 0)
                measurements_sum += int(s.get("measurements_count") or 0)
                try:
                    tmap = json.loads(s.get("tools_used_json") or "{}")
                    if isinstance(tmap, dict):
                        for tk, tv in tmap.items():
                            cnt = int(tv.get("count", 1)) if isinstance(tv, dict) else int(tv or 1)
                            tool_totals[str(tk)] = tool_totals.get(str(tk), 0) + max(1, cnt)
                except Exception:
                    pass

            top_tools = [
                {"tool": k, "count": v}
                for k, v in sorted(tool_totals.items(), key=lambda kv: (-kv[1], kv[0]))[:6]
            ]
            human_cnt = len(human)
            stats_map[tok] = {
                "recorded_sessions": human_cnt,
                "unique_visitors": len(uniq_keys),
                "bot_unfurls": len(bots),
                "total_active_sec": round(total_active, 1),
                "avg_active_sec": round(total_active / human_cnt, 1) if human_cnt > 0 else 0.0,
                "total_open_sec": round(total_open, 1),
                "last_viewed_at": last_viewed,
                "last_viewed_ts": last_ts,
                "comments_posted_total": comments_sum,
                "downloads_total": downloads_sum,
                "measurements_total": measurements_sum,
                "top_tools": top_tools,
            }
        return stats_map

    def get_share_link(self, token: str) -> Optional[Dict[str, Any]]:
        with DB_LOCK, self.db._connect() as conn:
            row = conn.execute("SELECT * FROM share_links WHERE token = ?", (token,)).fetchone()
            if not row:
                return None
            stats_map = self._compute_share_stats_map(conn, token_filter=token)
            return self._format_share_row(dict(row), stats_map.get(token))

    def _format_share_row(self, d: Dict[str, Any], stats: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        d["allow_download"] = bool(d.get("allow_download", 0))
        d["allow_measurements"] = bool(d.get("allow_measurements", 1))
        d["allow_comments"] = bool(d.get("allow_comments", 1))
        d["revoked"] = bool(d.get("revoked", 0))
        base = PUBLIC_BASE_URL.rstrip("/")
        d["share_url"] = f"{base}/s/{d['token']}"
        d["direct_url"] = f"{base}/?share={d['token']}"
        d["short_path"] = f"/s/{d['token']}"
        st = stats or {}
        rec_sessions = int(st.get("recorded_sessions", 0))
        raw_vc = int(d.get("view_count") or 0)
        # If rich session tracking exists, prefer exact human sessions (or max if legacy views existed before telemetry)
        d["human_views"] = rec_sessions if rec_sessions > 0 else raw_vc
        d["recorded_sessions"] = rec_sessions
        d["unique_visitors"] = int(st.get("unique_visitors", 0))
        d["bot_unfurls"] = int(st.get("bot_unfurls", 0))
        d["total_active_sec"] = float(st.get("total_active_sec", 0.0))
        d["avg_active_sec"] = float(st.get("avg_active_sec", 0.0))
        d["total_open_sec"] = float(st.get("total_open_sec", 0.0))
        d["last_viewed_at"] = str(st.get("last_viewed_at") or "")
        d["comments_posted_total"] = int(st.get("comments_posted_total", 0))
        d["downloads_total"] = int(st.get("downloads_total", 0))
        d["measurements_total"] = int(st.get("measurements_total", 0))
        d["top_tools"] = st.get("top_tools") or []
        return d

    def list_share_links(self) -> List[Dict[str, Any]]:
        with DB_LOCK, self.db._connect() as conn:
            rows = conn.execute("SELECT * FROM share_links ORDER BY created_at DESC").fetchall()
            stats_map = self._compute_share_stats_map(conn)
            return [self._format_share_row(dict(r), stats_map.get(str(r["token"]))) for r in rows]

    def _get_cached_or_queue_ip_geo(self, ip_address: str) -> Dict[str, str]:
        clean_ip = (ip_address or "").strip()
        if not clean_ip:
            return {"country": "", "region": "", "city": "", "isp": ""}
        if _is_private_or_loopback_ip(clean_ip):
            return {"country": "Local Network", "region": "", "city": "LAN / Localhost", "isp": "Internal Network"}

        now_ts = time.time()
        with DB_LOCK, self.db._connect() as conn:
            row = conn.execute("SELECT * FROM ip_geo_cache WHERE ip_address = ?", (clean_ip,)).fetchone()
            if row:
                rd = dict(row)
                if now_ts - float(rd.get("updated_ts") or 0.0) < 86400 * 30 and (rd.get("country") or rd.get("city")):
                    return {
                        "country": str(rd.get("country") or ""),
                        "region": str(rd.get("region") or ""),
                        "city": str(rd.get("city") or ""),
                        "isp": str(rd.get("isp") or ""),
                    }

        with _GEO_INFLIGHT_LOCK:
            if clean_ip in _GEO_INFLIGHT_IPS:
                return {"country": "", "region": "", "city": "", "isp": ""}
            _GEO_INFLIGHT_IPS.add(clean_ip)

        def _worker():
            geo_res = {"country": "", "country_code": "", "region": "", "city": "", "isp": ""}
            try:
                # Primary HTTPS lookup: ipwho.is (no API key required)
                url1 = f"https://ipwho.is/{urllib.parse.quote(clean_ip)}"
                req1 = urllib.request.Request(url1, headers={"User-Agent": "GatheringScans-Geo/1.0", "Accept": "application/json"})
                with urllib.request.urlopen(req1, timeout=4.0) as resp1:
                    if resp1.status == 200:
                        j1 = json.loads(resp1.read().decode("utf-8"))
                        if j1.get("success") is not False and (j1.get("country") or j1.get("city")):
                            conn_info = j1.get("connection") if isinstance(j1.get("connection"), dict) else {}
                            geo_res = {
                                "country": str(j1.get("country") or "").strip(),
                                "country_code": str(j1.get("country_code") or "").strip(),
                                "region": str(j1.get("region") or "").strip(),
                                "city": str(j1.get("city") or "").strip(),
                                "isp": str(conn_info.get("isp") or conn_info.get("org") or "").strip(),
                            }
            except Exception:
                pass

            if not geo_res["country"] and not geo_res["city"]:
                try:
                    # Fallback lookup: ip-api.com
                    url2 = f"http://ip-api.com/json/{urllib.parse.quote(clean_ip)}?fields=status,country,countryCode,regionName,city,isp,org"
                    req2 = urllib.request.Request(url2, headers={"User-Agent": "GatheringScans-Geo/1.0"})
                    with urllib.request.urlopen(req2, timeout=4.0) as resp2:
                        if resp2.status == 200:
                            j2 = json.loads(resp2.read().decode("utf-8"))
                            if j2.get("status") == "success":
                                geo_res = {
                                    "country": str(j2.get("country") or "").strip(),
                                    "country_code": str(j2.get("countryCode") or "").strip(),
                                    "region": str(j2.get("regionName") or "").strip(),
                                    "city": str(j2.get("city") or "").strip(),
                                    "isp": str(j2.get("isp") or j2.get("org") or "").strip(),
                                }
                except Exception:
                    pass

            try:
                if geo_res["country"] or geo_res["city"]:
                    with DB_LOCK, self.db._connect() as conn_w:
                        conn_w.execute(
                            """
                            INSERT INTO ip_geo_cache (ip_address, country, country_code, region, city, isp, updated_ts)
                            VALUES (?, ?, ?, ?, ?, ?, ?)
                            ON CONFLICT(ip_address) DO UPDATE SET
                                country=excluded.country,
                                country_code=excluded.country_code,
                                region=excluded.region,
                                city=excluded.city,
                                isp=excluded.isp,
                                updated_ts=excluded.updated_ts
                            """,
                            (
                                clean_ip,
                                geo_res["country"],
                                geo_res["country_code"],
                                geo_res["region"],
                                geo_res["city"],
                                geo_res["isp"],
                                time.time(),
                            ),
                        )
                        conn_w.execute(
                            """
                            UPDATE share_access_sessions
                            SET country = CASE WHEN country = '' THEN ? ELSE country END,
                                region  = CASE WHEN region = '' THEN ? ELSE region END,
                                city    = CASE WHEN city = '' THEN ? ELSE city END,
                                isp     = CASE WHEN isp = '' THEN ? ELSE isp END
                            WHERE ip_address = ?
                            """,
                            (
                                geo_res["country"],
                                geo_res["region"],
                                geo_res["city"],
                                geo_res["isp"],
                                clean_ip,
                            ),
                        )
                        conn_w.commit()
            except Exception:
                pass
            finally:
                with _GEO_INFLIGHT_LOCK:
                    _GEO_INFLIGHT_IPS.discard(clean_ip)

        threading.Thread(target=_worker, daemon=True).start()
        return {"country": "", "region": "", "city": "", "isp": ""}

    def record_bot_unfurl(self, token: str, ip_address: str = "", user_agent: str = "", referrer: str = "", entry_url: str = "") -> None:
        tok = (token or "").strip()
        if not tok:
            return
        ua_info = parse_user_agent(user_agent)
        ua_browser = ua_info.get("browser") or "Bot"
        now_ts = time.time()
        # Deduplicate repeated scrapes by same bot IP+UA within 30 seconds
        bucket = int(now_ts // 30)
        raw_sid = f"bot_{hashlib.sha1(f'{tok}|{ip_address}|{user_agent}|{bucket}'.encode('utf-8')).hexdigest()[:16]}"
        raw_vid = f"bot_{hashlib.sha1(f'{ip_address}|{ua_browser}'.encode('utf-8')).hexdigest()[:12]}"
        self.record_or_update_share_session(
            {
                "token": tok,
                "session_id": raw_sid,
                "visitor_id": raw_vid,
                "viewer_name": ua_browser if ua_browser != "Bot" else "Link Preview Bot",
                "is_bot": True,
                "entry_url": entry_url,
                "events": [{"t": 0, "type": "preview_unfurl", "detail": f"Link preview fetched ({ua_browser})"}],
            },
            request_meta={
                "ip_address": ip_address,
                "user_agent": user_agent,
                "referrer": referrer,
            },
        )

    def record_or_update_share_session(
        self, payload: Dict[str, Any], request_meta: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        meta = request_meta or {}
        tok = str(payload.get("token") or payload.get("share_token") or meta.get("share_token") or "").strip()
        if not tok:
            raise ValueError("Missing share token")

        raw_session_id = str(payload.get("session_id") or "").strip()
        if not raw_session_id:
            raw_session_id = f"s_{secrets.token_urlsafe(10)}"
        session_id = re.sub(r"[^a-zA-Z0-9_\-:]", "", raw_session_id)[:80] or f"s_{secrets.token_urlsafe(8)}"

        visitor_id = re.sub(r"[^a-zA-Z0-9_\-:]", "", str(payload.get("visitor_id") or ""))[:80]
        viewer_name = str(payload.get("viewer_name") or "").strip()[:120]
        viewer_email = str(payload.get("viewer_email") or "").strip()[:120]

        ip_addr = str(meta.get("ip_address") or payload.get("ip_address") or "").strip()[:64]
        ua_str = str(meta.get("user_agent") or payload.get("user_agent") or "").strip()[:512]
        ua_parsed = parse_user_agent(ua_str)
        is_bot = 1 if (bool(payload.get("is_bot", False)) or bool(ua_parsed.get("is_bot", False))) else 0

        browser = str(payload.get("browser") or ua_parsed.get("browser") or "Browser")[:80]
        os_name = str(payload.get("os") or ua_parsed.get("os") or "Unknown")[:80]
        device_type = str(payload.get("device_type") or ua_parsed.get("device_type") or "Desktop")[:32]
        language = str(payload.get("language") or meta.get("accept_language") or "").strip()[:48]
        tz_name = str(payload.get("timezone") or "").strip()[:64]
        screen_res = str(payload.get("screen_res") or "").strip()[:48]
        viewport_res = str(payload.get("viewport_res") or "").strip()[:48]
        gpu_renderer = str(payload.get("gpu_renderer") or "").strip()[:180]
        connection_type = str(payload.get("connection_type") or "").strip()[:64]
        referrer = str(payload.get("referrer") or meta.get("referrer") or "").strip()[:300]
        entry_url = str(payload.get("entry_url") or "").strip()[:300]

        geo = self._get_cached_or_queue_ip_geo(ip_addr)
        country = str(payload.get("country") or geo.get("country") or "")[:80]
        region = str(payload.get("region") or geo.get("region") or "")[:80]
        city = str(payload.get("city") or geo.get("city") or "")[:80]
        isp = str(payload.get("isp") or geo.get("isp") or "")[:120]

        now_ts = time.time()
        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

        in_total_sec = max(0.0, min(86400.0 * 3, float(payload.get("total_duration_sec") or 0.0)))
        in_active_sec = max(0.0, min(86400.0 * 3, float(payload.get("active_duration_sec") or 0.0)))
        if in_active_sec > in_total_sec and in_total_sec > 0:
            in_total_sec = in_active_sec
        in_load_pct = max(0.0, min(100.0, float(payload.get("max_load_pct") or 0.0)))
        in_load_ms = max(0, min(600_000, int(payload.get("load_time_ms") or 0)))
        in_cam = max(0, int(payload.get("camera_interactions") or 0))
        in_fp = max(0.0, float(payload.get("fp_seconds") or 0.0))
        in_cmts = max(0, int(payload.get("comments_posted") or 0))
        in_dl = max(0, int(payload.get("downloads_count") or 0))
        in_meas = max(0, int(payload.get("measurements_count") or 0))

        in_scans = payload.get("scans_viewed") if isinstance(payload.get("scans_viewed"), list) else []
        in_tools = payload.get("tools_used") if isinstance(payload.get("tools_used"), dict) else {}
        in_events = payload.get("events") if isinstance(payload.get("events"), list) else []

        generic_names = {"", "external reviewer", "guest viewer", "guest"}

        with DB_LOCK, self.db._connect() as conn:
            existing = conn.execute(
                "SELECT * FROM share_access_sessions WHERE session_id = ?", (session_id,)
            ).fetchone()

            if existing:
                ex = dict(existing)
                merged_viewer_name = ex.get("viewer_name") or ""
                if viewer_name and (merged_viewer_name.lower() in generic_names or viewer_name.lower() not in generic_names):
                    merged_viewer_name = viewer_name
                merged_viewer_email = viewer_email or ex.get("viewer_email") or ""

                # Merge scans_viewed
                try:
                    prev_scans = json.loads(ex.get("scans_viewed_json") or "[]")
                    if not isinstance(prev_scans, list):
                        prev_scans = []
                except Exception:
                    prev_scans = []
                scans_by_id: Dict[str, Dict[str, str]] = {}
                for s_item in prev_scans + in_scans:
                    if isinstance(s_item, dict) and s_item.get("scan_id"):
                        sid_k = str(s_item["scan_id"])[:80]
                        scans_by_id[sid_k] = {
                            "scan_id": sid_k,
                            "name": str(s_item.get("name") or scans_by_id.get(sid_k, {}).get("name") or sid_k)[:140],
                        }
                    elif isinstance(s_item, str) and s_item.strip():
                        sid_k = s_item.strip()[:80]
                        scans_by_id.setdefault(sid_k, {"scan_id": sid_k, "name": sid_k})

                # Merge tools_used monotonically
                try:
                    prev_tools = json.loads(ex.get("tools_used_json") or "{}")
                    if not isinstance(prev_tools, dict):
                        prev_tools = {}
                except Exception:
                    prev_tools = {}
                merged_tools: Dict[str, Dict[str, Any]] = {}
                for tk, tv in prev_tools.items():
                    if isinstance(tv, dict):
                        merged_tools[str(tk)] = {
                            "count": int(tv.get("count") or 1),
                            "seconds": round(float(tv.get("seconds") or 0.0), 1),
                        }
                    else:
                        merged_tools[str(tk)] = {"count": int(tv or 1), "seconds": 0.0}
                for tk_raw, tv in in_tools.items():
                    tk = re.sub(r"[^a-zA-Z0-9_\-]", "", str(tk_raw))[:48]
                    if not tk:
                        continue
                    cur_t = merged_tools.get(tk, {"count": 0, "seconds": 0.0})
                    if isinstance(tv, dict):
                        n_cnt = max(cur_t["count"], int(tv.get("count") or 1))
                        n_sec = max(cur_t["seconds"], round(float(tv.get("seconds") or 0.0), 1))
                    else:
                        n_cnt = max(cur_t["count"], int(tv or 1))
                        n_sec = cur_t["seconds"]
                    merged_tools[tk] = {"count": n_cnt, "seconds": n_sec}

                # Merge events deduplicated up to 100
                try:
                    prev_evts = json.loads(ex.get("events_json") or "[]")
                    if not isinstance(prev_evts, list):
                        prev_evts = []
                except Exception:
                    prev_evts = []
                seen_ev_keys: Set[str] = set()
                merged_evts: List[Dict[str, Any]] = []
                for ev in prev_evts + in_events:
                    if not isinstance(ev, dict):
                        continue
                    ev_t = round(float(ev.get("t", ev.get("t_offset_sec", 0.0)) or 0.0), 1)
                    ev_type = str(ev.get("type") or "event")[:40]
                    ev_det = str(ev.get("detail") or "")[:180]
                    ev_id = str(ev.get("id") or f"{ev_t}:{ev_type}:{ev_det}")
                    if ev_id in seen_ev_keys:
                        continue
                    seen_ev_keys.add(ev_id)
                    merged_evts.append({"id": ev_id[:64], "t": ev_t, "type": ev_type, "detail": ev_det})
                merged_evts = merged_evts[-100:]

                next_total = max(float(ex.get("total_duration_sec") or 0.0), in_total_sec)
                next_active = max(float(ex.get("active_duration_sec") or 0.0), in_active_sec)
                if next_active > next_total:
                    next_total = next_active
                prev_load_ms = int(ex.get("load_time_ms") or 0)
                next_load_ms = prev_load_ms if prev_load_ms > 0 else in_load_ms

                conn.execute(
                    """
                    UPDATE share_access_sessions SET
                        visitor_id = CASE WHEN ? != '' THEN ? ELSE visitor_id END,
                        viewer_name = ?,
                        viewer_email = ?,
                        ip_address = CASE WHEN ip_address = '' AND ? != '' THEN ? ELSE ip_address END,
                        country = CASE WHEN country = '' AND ? != '' THEN ? ELSE country END,
                        region = CASE WHEN region = '' AND ? != '' THEN ? ELSE region END,
                        city = CASE WHEN city = '' AND ? != '' THEN ? ELSE city END,
                        isp = CASE WHEN isp = '' AND ? != '' THEN ? ELSE isp END,
                        viewport_res = CASE WHEN ? != '' THEN ? ELSE viewport_res END,
                        screen_res = CASE WHEN screen_res = '' AND ? != '' THEN ? ELSE screen_res END,
                        gpu_renderer = CASE WHEN gpu_renderer = '' AND ? != '' THEN ? ELSE gpu_renderer END,
                        connection_type = CASE WHEN ? != '' THEN ? ELSE connection_type END,
                        referrer = CASE WHEN referrer = '' AND ? != '' THEN ? ELSE referrer END,
                        last_active_at = ?,
                        last_active_ts = ?,
                        total_duration_sec = ?,
                        active_duration_sec = ?,
                        max_load_pct = ?,
                        load_time_ms = ?,
                        camera_interactions = ?,
                        fp_seconds = ?,
                        comments_posted = ?,
                        downloads_count = ?,
                        measurements_count = ?,
                        scans_viewed_json = ?,
                        tools_used_json = ?,
                        events_json = ?
                    WHERE session_id = ?
                    """,
                    (
                        visitor_id, visitor_id,
                        merged_viewer_name,
                        merged_viewer_email,
                        ip_addr, ip_addr,
                        country, country,
                        region, region,
                        city, city,
                        isp, isp,
                        viewport_res, viewport_res,
                        screen_res, screen_res,
                        gpu_renderer, gpu_renderer,
                        connection_type, connection_type,
                        referrer, referrer,
                        now_iso,
                        max(float(ex.get("last_active_ts") or 0.0), now_ts),
                        round(next_total, 1),
                        round(next_active, 1),
                        round(max(float(ex.get("max_load_pct") or 0.0), in_load_pct), 1),
                        next_load_ms,
                        max(int(ex.get("camera_interactions") or 0), in_cam),
                        round(max(float(ex.get("fp_seconds") or 0.0), in_fp), 1),
                        max(int(ex.get("comments_posted") or 0), in_cmts),
                        max(int(ex.get("downloads_count") or 0), in_dl),
                        max(int(ex.get("measurements_count") or 0), in_meas),
                        json.dumps(list(scans_by_id.values()), ensure_ascii=False),
                        json.dumps(merged_tools, ensure_ascii=False),
                        json.dumps(merged_evts, ensure_ascii=False),
                        session_id,
                    ),
                )
                conn.commit()
            else:
                norm_scans: List[Dict[str, str]] = []
                for s_item in in_scans[:25]:
                    if isinstance(s_item, dict) and s_item.get("scan_id"):
                        norm_scans.append(
                            {
                                "scan_id": str(s_item["scan_id"])[:80],
                                "name": str(s_item.get("name") or s_item["scan_id"])[:140],
                            }
                        )
                    elif isinstance(s_item, str) and s_item.strip():
                        norm_scans.append({"scan_id": s_item.strip()[:80], "name": s_item.strip()[:80]})

                norm_tools: Dict[str, Dict[str, Any]] = {}
                for tk_raw, tv in in_tools.items():
                    tk = re.sub(r"[^a-zA-Z0-9_\-]", "", str(tk_raw))[:48]
                    if not tk:
                        continue
                    if isinstance(tv, dict):
                        norm_tools[tk] = {
                            "count": max(1, int(tv.get("count") or 1)),
                            "seconds": round(max(0.0, float(tv.get("seconds") or 0.0)), 1),
                        }
                    else:
                        norm_tools[tk] = {"count": max(1, int(tv or 1)), "seconds": 0.0}

                norm_evts: List[Dict[str, Any]] = []
                for ev in in_events[-100:]:
                    if isinstance(ev, dict):
                        ev_t = round(float(ev.get("t", ev.get("t_offset_sec", 0.0)) or 0.0), 1)
                        ev_type = str(ev.get("type") or "event")[:40]
                        ev_det = str(ev.get("detail") or "")[:180]
                        ev_id = str(ev.get("id") or f"{ev_t}:{ev_type}:{ev_det}")[:64]
                        norm_evts.append({"id": ev_id, "t": ev_t, "type": ev_type, "detail": ev_det})

                started_ts = float(payload.get("started_ts") or now_ts)
                started_at = str(payload.get("started_at") or now_iso)
                last_ts = float(payload.get("last_active_ts") or now_ts)
                last_at = str(payload.get("last_active_at") or now_iso)

                conn.execute(
                    """
                    INSERT INTO share_access_sessions (
                        session_id, token, visitor_id, viewer_name, viewer_email,
                        ip_address, country, region, city, isp,
                        user_agent, browser, os, device_type, is_bot,
                        language, timezone, screen_res, viewport_res, gpu_renderer,
                        connection_type, referrer, entry_url,
                        started_at, started_ts, last_active_at, last_active_ts,
                        total_duration_sec, active_duration_sec,
                        max_load_pct, load_time_ms, camera_interactions, fp_seconds,
                        comments_posted, downloads_count, measurements_count,
                        scans_viewed_json, tools_used_json, events_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        session_id,
                        tok,
                        visitor_id,
                        viewer_name,
                        viewer_email,
                        ip_addr,
                        country,
                        region,
                        city,
                        isp,
                        ua_str,
                        browser,
                        os_name,
                        device_type,
                        is_bot,
                        language,
                        tz_name,
                        screen_res,
                        viewport_res,
                        gpu_renderer,
                        connection_type,
                        referrer,
                        entry_url,
                        started_at,
                        started_ts,
                        last_at,
                        last_ts,
                        round(in_total_sec, 1),
                        round(in_active_sec, 1),
                        round(in_load_pct, 1),
                        in_load_ms,
                        in_cam,
                        round(in_fp, 1),
                        in_cmts,
                        in_dl,
                        in_meas,
                        json.dumps(norm_scans, ensure_ascii=False),
                        json.dumps(norm_tools, ensure_ascii=False),
                        json.dumps(norm_evts, ensure_ascii=False),
                    ),
                )
                if not is_bot:
                    conn.execute(
                        "UPDATE share_links SET view_count = view_count + 1 WHERE token = ?",
                        (tok,),
                    )
                conn.commit()

        return {"status": "ok", "session_id": session_id, "token": tok, "is_bot": bool(is_bot)}

    def _format_session_row(self, row_dict: Dict[str, Any]) -> Dict[str, Any]:
        d = dict(row_dict)
        d["is_bot"] = bool(d.get("is_bot", 0))
        try:
            d["scans_viewed"] = json.loads(d.get("scans_viewed_json") or "[]")
        except Exception:
            d["scans_viewed"] = []
        try:
            d["tools_used"] = json.loads(d.get("tools_used_json") or "{}")
        except Exception:
            d["tools_used"] = {}
        try:
            d["events"] = json.loads(d.get("events_json") or "[]")
        except Exception:
            d["events"] = []
        d.pop("scans_viewed_json", None)
        d.pop("tools_used_json", None)
        d.pop("events_json", None)
        loc_parts = [x for x in (d.get("city"), d.get("region"), d.get("country")) if x]
        d["location_label"] = ", ".join(dict.fromkeys(loc_parts)) if loc_parts else ""
        return d

    def get_share_analytics(self, token: Optional[str] = None, limit: int = 200) -> Dict[str, Any]:
        clean_tok = (token or "").strip()
        with DB_LOCK, self.db._connect() as conn:
            stats_map = self._compute_share_stats_map(conn, token_filter=clean_tok or None)
            if clean_tok:
                link_row = conn.execute("SELECT * FROM share_links WHERE token = ?", (clean_tok,)).fetchone()
                link_obj = self._format_share_row(dict(link_row), stats_map.get(clean_tok)) if link_row else None
                s_rows = conn.execute(
                    "SELECT * FROM share_access_sessions WHERE token = ? ORDER BY started_ts DESC LIMIT ?",
                    (clean_tok, int(limit)),
                ).fetchall()
                sessions = [self._format_session_row(dict(r)) for r in s_rows]
                summary = stats_map.get(clean_tok) or {
                    "recorded_sessions": 0,
                    "unique_visitors": 0,
                    "bot_unfurls": 0,
                    "total_active_sec": 0.0,
                    "avg_active_sec": 0.0,
                    "total_open_sec": 0.0,
                    "last_viewed_at": "",
                    "comments_posted_total": 0,
                    "downloads_total": 0,
                    "measurements_total": 0,
                    "top_tools": [],
                }
                return {
                    "status": "ok",
                    "token": clean_tok,
                    "link": link_obj,
                    "summary": summary,
                    "sessions": sessions,
                }

            # Global overview across all share links
            links = [
                self._format_share_row(dict(r), stats_map.get(str(r["token"])))
                for r in conn.execute("SELECT * FROM share_links ORDER BY created_at DESC").fetchall()
            ]
            s_rows = conn.execute(
                "SELECT * FROM share_access_sessions ORDER BY started_ts DESC LIMIT ?",
                (int(limit),),
            ).fetchall()
            sessions = [self._format_session_row(dict(r)) for r in s_rows]
            return {
                "status": "ok",
                "links": links,
                "sessions": sessions,
            }

    def export_recent_share_sessions(self, limit: int = 400) -> List[Dict[str, Any]]:
        with DB_LOCK, self.db._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM share_access_sessions ORDER BY last_active_ts DESC LIMIT ?",
                (int(limit),),
            ).fetchall()
            return [self._format_session_row(dict(r)) for r in rows]

    def merge_share_sessions(self, sessions: List[Dict[str, Any]]) -> int:
        if not isinstance(sessions, list) or not sessions:
            return 0
        merged = 0
        for s in sessions:
            if not isinstance(s, dict) or not s.get("token") or not s.get("session_id"):
                continue
            try:
                self.record_or_update_share_session(s, request_meta={"ip_address": s.get("ip_address", ""), "user_agent": s.get("user_agent", ""), "referrer": s.get("referrer", "")})
                merged += 1
            except Exception:
                pass
        return merged

    def revoke_share_link(self, token: str) -> Optional[Dict[str, Any]]:
        """Immediately revokes an external share link so external viewers lose access."""
        revoked_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        with DB_LOCK, self.db._connect() as conn:
            cur = conn.execute(
                "UPDATE share_links SET revoked = 1, revoked_at = ? WHERE token = ?",
                (revoked_at, token),
            )
            conn.commit()
            if cur.rowcount == 0:
                return None
        return self.get_share_link(token)

    def restore_share_link(self, token: str) -> Optional[Dict[str, Any]]:
        with DB_LOCK, self.db._connect() as conn:
            conn.execute(
                "UPDATE share_links SET revoked = 0, revoked_at = '' WHERE token = ?",
                (token,),
            )
            conn.commit()
        return self.get_share_link(token)

    def validate_share_access(
        self, token: str, requested_scan_id: Optional[str] = None, increment_view: bool = False
    ) -> Tuple[bool, str, Optional[Dict[str, Any]], List[Dict[str, Any]]]:
        """
        Strictly validates an external share token and returns only the scan(s) inside its scope.
        If revoked, expired, or requesting a scan outside the token's scope, returns (False, reason, ...).
        """
        link = self.get_share_link(token)
        if not link:
            return False, "Invalid or unknown share link token.", None, []

        if link["revoked"]:
            return False, "This share link has been revoked by the project administrator.", link, []

        if link.get("expires_at"):
            try:
                exp_dt = datetime.fromisoformat(link["expires_at"].replace("Z", "+00:00"))
                if datetime.now(timezone.utc) > exp_dt:
                    return False, "This share link has expired.", link, []
            except Exception:
                pass

        # Determine authorized scans for this token
        if link["scope_type"] == "scan":
            scan = self.db.get_scan(link["target_id"])
            allowed_scans = [scan] if scan else []
        else:
            allowed_scans = self.db.list_scans(project_group=link["target_id"])

        allowed_ids = {s["scan_id"] for s in allowed_scans if s}

        if requested_scan_id and requested_scan_id not in allowed_ids:
            return (
                False,
                f"Forbidden: Scan '{requested_scan_id}' is outside the authorized scope of this share link.",
                link,
                [],
            )

        if increment_view:
            with DB_LOCK, self.db._connect() as conn:
                conn.execute(
                    "UPDATE share_links SET view_count = view_count + 1 WHERE token = ?",
                    (token,),
                )
                conn.commit()
            link["view_count"] += 1

        return True, "ok", link, allowed_scans
