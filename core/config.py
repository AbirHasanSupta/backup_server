"""core/config.py — Central Typed Configuration Manager."""

from __future__ import annotations

import json
import os
import platform
import shutil
import sys
import threading
from typing import Any, Dict, List

APP_NAME = "PhoneBackupServer"
_MODULE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_IS_FROZEN = bool(getattr(sys, "frozen", False))
_EXE_DIR = os.path.dirname(os.path.abspath(sys.executable)) if _IS_FROZEN else _MODULE_DIR


def _get_app_data_dir() -> str:
    if not _IS_FROZEN:
        return _MODULE_DIR
    if sys.platform == "win32":
        root = os.environ.get("APPDATA") or os.path.expanduser("~")
        return os.path.join(root, APP_NAME)
    root = os.environ.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share")
    return os.path.join(root, APP_NAME)


APP_DATA_DIR = _get_app_data_dir()
os.makedirs(APP_DATA_DIR, exist_ok=True)

SHARED_QUIZ_DIR = os.path.join(APP_DATA_DIR, "shared_quiz_cards")
SHARED_REWIND_DIR = os.path.join(APP_DATA_DIR, "shared_rewind_reels")
SHARED_DIRECT_POST_DIR = os.path.join(APP_DATA_DIR, "shared_direct_posts")
os.makedirs(SHARED_QUIZ_DIR, exist_ok=True)
os.makedirs(SHARED_REWIND_DIR, exist_ok=True)
os.makedirs(SHARED_DIRECT_POST_DIR, exist_ok=True)

CONFIG_FILE = os.path.join(APP_DATA_DIR, "server_config.json")
DB_PATH = os.path.join(APP_DATA_DIR, "backup.db")

_DEFAULTS: Dict[str, Any] = {
    "API_KEY": "YOUR_SECRET_KEY",
    "BACKUP_ROOT": os.environ.get("BACKUP_ROOT") or os.path.join("D:\\", "PhoneBackup"),
    "HOST": os.environ.get("HOST", "0.0.0.0"),
    "PORT": int(os.environ.get("PORT", 8000)),
    "DB_PATH": DB_PATH,
    "REQUIRE_APPROVAL": True,
    "THEME_MODE": "light",
    "SSL_CERT": os.path.join(APP_DATA_DIR, "cert.pem"),
    "SSL_KEY": os.path.join(APP_DATA_DIR, "key.pem"),
    "VIDEO_PREVIEW_CACHE_DIR": os.path.join(APP_DATA_DIR, "video_preview_cache"),
    "VIDEO_PREVIEW_CACHE_MAX_BYTES": 8 * 1024 * 1024 * 1024,
    "SHARED_DIRS": [],
    "START_WITH_WINDOWS": False,
    "MINIMIZE_TO_TRAY": True,
    "DESKTOP_NAME": platform.node() or "Desktop Server",
    "DATABASE_BACKEND": os.environ.get("DATABASE_BACKEND", "sqlite"),
    "POSTGRES_URL": os.environ.get("POSTGRES_URL") or os.environ.get("DATABASE_URL") or "postgresql://postgres:postgres@localhost:5432/backup_db",
    "REDIS_URL": os.environ.get("REDIS_URL") or "redis://localhost:6379/0",
    "CELERY_ENABLED": os.environ.get("CELERY_ENABLED", "0").lower() in ("1", "true", "yes"),
    "STORAGE_BACKEND": os.environ.get("STORAGE_BACKEND", "local"),  # "local" or "s3"
    "ENABLE_CAS_DEDUPLICATION": os.environ.get("ENABLE_CAS_DEDUPLICATION", "1").lower() in ("1", "true", "yes"),
}

_config_lock = threading.RLock()
_config_cache: Dict[str, Any] | None = None
_config_cache_mtime: float | None = None


def load_config() -> Dict[str, Any]:
    global _config_cache, _config_cache_mtime
    try:
        current_mtime = os.path.getmtime(CONFIG_FILE)
    except OSError:
        current_mtime = None

    with _config_lock:
        if _config_cache is not None and current_mtime == _config_cache_mtime:
            return dict(_config_cache)

        data = None
        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except Exception:
                pass

        cfg = {**_DEFAULTS, **(data or {})}
        if _IS_FROZEN:
            cfg["DB_PATH"] = DB_PATH

        if not cfg.get("SERVER_ID"):
            import uuid
            cfg["SERVER_ID"] = str(uuid.uuid4())
            try:
                with open(CONFIG_FILE, "w", encoding="utf-8") as f:
                    json.dump(cfg, f, indent=2)
                current_mtime = os.path.getmtime(CONFIG_FILE)
            except Exception:
                pass

        _config_cache = cfg
        _config_cache_mtime = current_mtime
        return dict(cfg)


def save_config(cfg: Dict[str, Any]) -> None:
    global _config_cache, _config_cache_mtime
    with _config_lock:
        merged = {**_DEFAULTS, **cfg}
        os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
        tmp_path = f"{CONFIG_FILE}.tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(merged, f, indent=2)
        os.replace(tmp_path, CONFIG_FILE)
        _config_cache = None
        _config_cache_mtime = None


def get_shared_dirs() -> List[Dict[str, Any]]:
    return load_config().get("SHARED_DIRS", [])
