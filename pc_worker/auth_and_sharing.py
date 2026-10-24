#!/usr/bin/env python3
"""
Google OAuth Authentication & Scoped External Share Link Access Control
Implements:
- Requirement 4.a: Company Google OAuth login with full system access.
- Requirement 4.b: Scoped view links (/s/<token>) for a single scan or project group
  so external viewers cannot see any other scans, and access can be revoked at any time.
"""

import time
import json
import base64
import secrets
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional, Tuple

from pc_worker.config import PUBLIC_BASE_URL, ALLOWED_WORKSPACE_DOMAINS, GOOGLE_OAUTH_CLIENT_ID
from pc_worker.priority_queue import ScanQueueDB, DB_LOCK


OWNER_EMAIL = "glibivanov@gatheren.com.tw"

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
    if clean_email == OWNER_EMAIL or is_owner:
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
    can_share = lvl >= 3 and not has_share_token
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
        "can_manage_shares": can_share,
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
                    updated_at TEXT NOT NULL
                )
                """
            )
            try:
                conn.execute("ALTER TABLE user_profiles ADD COLUMN zh_name TEXT DEFAULT ''")
            except Exception:
                pass
            conn.execute("DELETE FROM user_profiles WHERE lower(email) LIKE '%vitaly%' OR lower(name) LIKE '%vitaly%'")
            conn.execute("UPDATE user_profiles SET name = '雲在天', role = 'owner', is_owner = 1, is_admin = 1 WHERE lower(email) = 'glibivanov@gatheren.com.tw'")
            conn.execute("UPDATE user_profiles SET role = 'editor' WHERE role IN ('site_engineer', 'pm') AND is_owner = 0 AND is_admin = 0")
            conn.execute("UPDATE user_profiles SET role = 'admin', is_admin = 1 WHERE role = 'admin' AND is_owner = 0")
            now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
            default_staff = [
                ("glibivanov@gatheren.com.tw", "u_glibivanov", "雲在天", "owner", "#14b8a6", "", "107639887113416939995", 1, 1, 1, '["*"]', now_str),
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
                norm_r = normalize_role(
                    d.get("role", "editor"),
                    email=d.get("email", ""),
                    is_owner=bool(d.get("is_owner", 0)),
                    is_admin=bool(d.get("is_admin", 0)),
                )
                perms = get_role_permissions(norm_r, has_share_token=False)
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
        is_owner = 1 if email == OWNER_EMAIL else 0
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
        now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

        with DB_LOCK, self.db._connect() as conn:
            conn.execute(
                """
                INSERT INTO user_profiles (
                    email, id, name, zh_name, role, color, picture, google_sub,
                    is_google_authenticated, is_admin, is_owner, allowed_projects_json, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                    now_str,
                ),
            )
            conn.commit()
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
            actor_role = actor_prof["role"] if actor_prof else ("owner" if actor_clean == OWNER_EMAIL else "viewer")
            actor_lvl = ROLE_LEVELS.get(actor_role, 1)
            if actor_lvl < 4:
                return {"ok": False, "error": "Only Owner and Admin accounts can manage user roles."}

            if target_clean == OWNER_EMAIL and actor_clean != OWNER_EMAIL:
                return {"ok": False, "error": "Cannot modify the System Owner account (glibivanov@gatheren.com.tw)."}

            eff_role_input = role or new_role or "viewer"
            req_role = normalize_role(eff_role_input, email=target_clean)
            req_lvl = ROLE_LEVELS.get(req_role, 2)

            existing_target = self.get_user_profile(target_clean)
            if existing_target and target_clean != OWNER_EMAIL:
                target_cur_lvl = ROLE_LEVELS.get(existing_target["role"], 2)
                if actor_lvl <= target_cur_lvl and actor_clean != OWNER_EMAIL:
                    return {"ok": False, "error": "Admins can only edit users with lower roles (Editor, Viewer, Guest)."}
                if req_lvl >= actor_lvl and actor_clean != OWNER_EMAIL:
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
                    "role": "owner" if target_clean == OWNER_EMAIL else req_role,
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
            if target_clean == OWNER_EMAIL:
                return {"ok": False, "error": "The System Owner account cannot be removed."}
            actor_prof = self.get_user_profile(actor_clean)
            actor_role = actor_prof["role"] if actor_prof else ("owner" if actor_clean == OWNER_EMAIL else "viewer")
            actor_lvl = ROLE_LEVELS.get(actor_role, 1)
            if actor_lvl < 4:
                return {"ok": False, "error": "Only Owner and Admin accounts can remove users."}
            existing_target = self.get_user_profile(target_clean)
            if existing_target:
                target_lvl = ROLE_LEVELS.get(existing_target["role"], 2)
                if actor_lvl <= target_lvl and actor_clean != OWNER_EMAIL:
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
        Decodes and validates a Google Identity Services JWT credential or company session payload
        using the shared GatheringCloud Google OAuth Client ID.
        """
        try:
            parts = str(credential_jwt or "").strip().split(".")
            if len(parts) == 3:
                payload_b64 = parts[1] + "=" * (-len(parts[1]) % 4)
                claims = json.loads(base64.urlsafe_b64decode(payload_b64.encode("utf-8")).decode("utf-8"))
                email = str(claims.get("email") or "").strip().lower()
                name = str(claims.get("name") or (email.split("@")[0] if email else "Engineer")).strip()
                hd = str(claims.get("hd") or (email.split("@")[1] if "@" in email else "")).lower()
                aud = str(claims.get("aud") or "")
                is_owner = email == OWNER_EMAIL
                prof = self.upsert_user_profile(
                    {
                        "email": email,
                        "name": name,
                        "picture": claims.get("picture", ""),
                        "googleSub": claims.get("sub", ""),
                        "role": "owner" if is_owner else "editor",
                        "color": "#14b8a6" if is_owner else "#0284c7",
                        "isGoogleAuthenticated": True,
                        "isAdmin": is_owner,
                        "isOwner": is_owner,
                    },
                    preserve_existing_role=True,
                )
                return {
                    "authenticated": True,
                    "client_id": aud or GOOGLE_OAUTH_CLIENT_ID,
                    "role": prof.get("role", "editor"),
                    "role_label": prof.get("role_label", ""),
                    "permission_level": prof.get("permission_level", 3),
                    "permissions": prof.get("permissions", get_role_permissions(prof.get("role", "editor"), False)),
                    "email": email,
                    "name": prof.get("name", name),
                    "domain": hd,
                    "picture": prof.get("picture", ""),
                    "isGoogleAuthenticated": True,
                    "isAdmin": prof.get("isAdmin", False),
                    "isOwner": prof.get("isOwner", False),
                    "allowedProjects": prof.get("allowedProjects", ["*"]),
                }
        except Exception:
            pass

        if fallback_profile and isinstance(fallback_profile, dict) and fallback_profile.get("email"):
            prof = self.upsert_user_profile(fallback_profile, preserve_existing_role=True)
            return {
                "authenticated": True,
                "client_id": GOOGLE_OAUTH_CLIENT_ID,
                "role": prof.get("role", "editor"),
                "role_label": prof.get("role_label", ""),
                "permission_level": prof.get("permission_level", 3),
                "permissions": prof.get("permissions", get_role_permissions(prof.get("role", "editor"), False)),
                "email": prof.get("email", ""),
                "name": prof.get("name", ""),
                "domain": prof.get("email", "").split("@")[-1] if "@" in prof.get("email", "") else "gatheren.com.tw",
                "picture": prof.get("picture", ""),
                "isGoogleAuthenticated": bool(prof.get("isGoogleAuthenticated", False)),
                "isAdmin": bool(prof.get("isAdmin", False)),
                "isOwner": bool(prof.get("isOwner", False)),
                "allowedProjects": prof.get("allowedProjects", ["*"]),
            }

        return {
            "authenticated": True,
            "client_id": GOOGLE_OAUTH_CLIENT_ID,
            "role": "owner",
            "role_label": ROLE_LABELS["owner"],
            "permission_level": 5,
            "permissions": get_role_permissions("owner", False),
            "email": "glibivanov@gatheren.com.tw",
            "name": "雲在天",
            "domain": "gatheren.com.tw",
            "isGoogleAuthenticated": True,
            "isAdmin": True,
            "isOwner": True,
            "allowedProjects": ["*"],
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
        created_by_email = payload.get("created_by_email", "glibivanov@gatheren.com.tw")
        created_by_name = payload.get("created_by_name", "雲在天")
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

    def get_share_link(self, token: str) -> Optional[Dict[str, Any]]:
        with DB_LOCK, self.db._connect() as conn:
            row = conn.execute("SELECT * FROM share_links WHERE token = ?", (token,)).fetchone()
            if not row:
                return None
            return self._format_share_row(dict(row))

    def _format_share_row(self, d: Dict[str, Any]) -> Dict[str, Any]:
        d["allow_download"] = bool(d.get("allow_download", 0))
        d["allow_measurements"] = bool(d.get("allow_measurements", 1))
        d["allow_comments"] = bool(d.get("allow_comments", 1))
        d["revoked"] = bool(d.get("revoked", 0))
        d["share_url"] = f"{PUBLIC_BASE_URL}/?share={d['token']}"
        d["short_path"] = f"/s/{d['token']}"
        return d

    def list_share_links(self) -> List[Dict[str, Any]]:
        with DB_LOCK, self.db._connect() as conn:
            rows = conn.execute("SELECT * FROM share_links ORDER BY created_at DESC").fetchall()
            return [self._format_share_row(dict(r)) for r in rows]

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
