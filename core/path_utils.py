"""core/path_utils.py — Cross-Platform & Container-Aware Path Translation."""

from __future__ import annotations

import os
import re
from config import APP_DATA_DIR, load_config


def normalize_fs_path(path: str | None) -> str:
    """Translate host Windows filesystem paths into valid container/OS paths.
    
    In Docker container deployments on Linux, records created on Windows or
    stored in server_config.json contain Windows drive letters (C:\\, D:\\, G:\\)
    and AppData paths. This function resolves them to their mounted container
    equivalents (/app_data, /backup_storage, /host_g, etc.).
    """
    if not path or not isinstance(path, str):
        return ""

    raw = path.strip()
    if not raw:
        return ""

    # If it's already an existing file or directory on current OS, return standard absolute path
    if os.path.exists(raw):
        return os.path.abspath(raw)

    normalized = raw.replace("\\", "/")

    # 1. Check for AppData subdirectories (shared_direct_posts, shared_quiz_cards, etc.)
    app_data_subs = (
        "shared_direct_posts",
        "shared_quiz_cards",
        "shared_rewind_reels",
        "thumbnail_cache",
        "video_preview_cache",
        "music_cache",
        "rewind_cache",
    )
    for sub in app_data_subs:
        token = f"/{sub}/"
        if token in normalized or normalized.startswith(f"{sub}/"):
            filename = normalized.split(token)[-1] if token in normalized else normalized[len(sub) + 1:]
            filename = filename.lstrip("/")
            candidate = os.path.join(APP_DATA_DIR, sub, filename)
            if os.path.exists(candidate) or not os.path.exists(raw):
                return candidate

    # 2. Check for Backup Root paths (PhoneBackup)
    try:
        backup_root = os.path.abspath(load_config().get("BACKUP_ROOT", "/backup_storage"))
    except Exception:
        backup_root = "/backup_storage"

    if "/PhoneBackup/" in normalized or normalized.startswith("PhoneBackup/"):
        token = "/PhoneBackup/"
        rel = normalized.split(token)[-1] if token in normalized else normalized[len("PhoneBackup/"):]
        rel = rel.lstrip("/")
        candidate = os.path.join(backup_root, rel)
        if os.path.exists(candidate) or not os.path.exists(raw):
            return candidate

    # 3. Check for Windows Drive Letters (e.g. G:/..., D:/..., C:/...)
    if len(normalized) >= 2 and normalized[1] == ":":
        drive = normalized[0].lower()
        rest = normalized[2:].lstrip("/")

        # If drive is D (backup drive default)
        if drive == "d" and ("phonebackup" in rest.lower() or os.path.isdir(backup_root)):
            if rest.lower().startswith("phonebackup/"):
                rest_sub = rest[len("phonebackup/"):].lstrip("/")
            else:
                rest_sub = rest
            candidate = os.path.join(backup_root, rest_sub)
            if os.path.exists(candidate):
                return candidate

        # If drive is C and contains AppData/PhoneBackupServer
        if drive == "c" and "phonebackupserver" in rest.lower():
            idx = rest.lower().find("phonebackupserver/")
            if idx != -1:
                appdata_rel = rest[idx + len("phonebackupserver/"):].lstrip("/")
                candidate = os.path.join(APP_DATA_DIR, appdata_rel)
                if os.path.exists(candidate):
                    return candidate

        # Standard container drive mounts: /host_g, /mnt/g, /g
        for prefix in (f"/host_{drive}", f"/mnt/{drive}", f"/{drive}"):
            if os.path.isdir(prefix):
                candidate = os.path.join(prefix, rest)
                if os.path.exists(candidate):
                    return candidate
                return candidate

    return os.path.abspath(raw)
