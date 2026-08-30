import json
import os
import platform
import shutil
import sys
import threading


APP_NAME = "PhoneBackupServer"

_MODULE_DIR = os.path.dirname(os.path.abspath(__file__))
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

CONFIG_FILE = os.path.join(APP_DATA_DIR, "server_config.json")
DB_PATH = os.path.join(APP_DATA_DIR, "backup.db")

_PORTABLE_CONFIG_FILE = os.path.join(_EXE_DIR, "server_config.json")
_PORTABLE_DB_PATH = os.path.join(_EXE_DIR, "backup.db")

_DEFAULTS = {
    "API_KEY": "YOUR_SECRET_KEY",
    "BACKUP_ROOT": os.path.join("D:\\", "PhoneBackup"),
    "HOST": "0.0.0.0",
    "PORT": 8000,
    "DB_PATH": DB_PATH,
    "REQUIRE_APPROVAL": True,
    "THEME_MODE": "light",
    "SSL_CERT": os.path.join(APP_DATA_DIR, "cert.pem"),
    "SSL_KEY": os.path.join(APP_DATA_DIR, "key.pem"),
    # A dedicated directory containing only generated, server-side video
    # previews.  Users can relocate it from desktop Settings.
    "VIDEO_PREVIEW_CACHE_DIR": os.path.join(APP_DATA_DIR, "video_preview_cache"),
    # Optimized video copies are LRU-evicted at this size.  Keeping the limit
    # finite prevents a busy Restore screen from silently consuming a disk.
    # Set to 0 in server_config.json to disable automatic eviction.
    "VIDEO_PREVIEW_CACHE_MAX_BYTES": 8 * 1024 * 1024 * 1024,
    # List of dicts: [{id: str, label: str, path: str}, ...]
    # IDs are stable slugs like "shared_0", "shared_1", etc.
    "SHARED_DIRS": [],
    "START_WITH_WINDOWS": False,
    "MINIMIZE_TO_TRAY": True,
    # Display name shown on feed cards for posts sent from this desktop server.
    # Defaults to the machine's hostname; can be changed in Settings.
    "DESKTOP_NAME": platform.node() or "Desktop Server",
}

_AUTOSTART_KEY_NAME = APP_NAME
_AUTOSTART_REG_PATH = r"Software\Microsoft\Windows\CurrentVersion\Run"


def _autostart_target() -> str | None:
    if sys.platform != "win32":
        return None
    if _IS_FROZEN:
        return f'"{sys.executable}"'
    return f'"{sys.executable}" "{os.path.abspath(__file__).replace("config.py", "desktop_app.py")}"'


def is_autostart_enabled() -> bool:
    if sys.platform != "win32":
        return False
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _AUTOSTART_REG_PATH, 0, winreg.KEY_READ) as key:
            winreg.QueryValueEx(key, _AUTOSTART_KEY_NAME)
            return True
    except FileNotFoundError:
        return False
    except Exception:
        return False


def set_autostart_enabled(enabled: bool) -> bool:
    if sys.platform != "win32":
        return False
    try:
        import winreg
        with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, _AUTOSTART_REG_PATH, 0, winreg.KEY_SET_VALUE) as key:
            if enabled:
                target = _autostart_target()
                if not target:
                    return False
                winreg.SetValueEx(key, _AUTOSTART_KEY_NAME, 0, winreg.REG_SZ, target)
            else:
                try:
                    winreg.DeleteValue(key, _AUTOSTART_KEY_NAME)
                except FileNotFoundError:
                    pass
        return True
    except Exception:
        return False


def _copy_if_missing(src: str, dest: str) -> None:
    if src == dest or os.path.exists(dest) or not os.path.exists(src):
        return
    try:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copy2(src, dest)
    except Exception:
        pass


def _load_json(path: str) -> dict | None:
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


_migrated = False


def _migrate_frozen_files() -> None:
    global _migrated
    if _migrated or not _IS_FROZEN:
        _migrated = True
        return

    _copy_if_missing(_PORTABLE_CONFIG_FILE, CONFIG_FILE)
    _copy_if_missing(_PORTABLE_DB_PATH, DB_PATH)

    cfg = _load_json(CONFIG_FILE)
    old_db_path = (cfg or {}).get("DB_PATH")
    if old_db_path and os.path.abspath(old_db_path) != os.path.abspath(DB_PATH):
        _copy_if_missing(old_db_path, DB_PATH)
    _migrated = True


_config_lock = threading.Lock()
_config_cache: dict | None = None
_config_cache_mtime: float | None = None


def load_config() -> dict:
    global _config_cache, _config_cache_mtime
    _migrate_frozen_files()

    try:
        current_mtime = os.path.getmtime(CONFIG_FILE)
    except OSError:
        current_mtime = None

    with _config_lock:
        if _config_cache is not None and current_mtime == _config_cache_mtime:
            return _config_cache

        data = _load_json(CONFIG_FILE)
        if data is None and _IS_FROZEN:
            data = _load_json(_PORTABLE_CONFIG_FILE)

        cfg = {**_DEFAULTS, **(data or {})}
        if _IS_FROZEN:
            cfg["DB_PATH"] = DB_PATH

        if not cfg.get("SERVER_ID"):
            import uuid
            cfg["SERVER_ID"] = str(uuid.uuid4())
            try:
                os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
                with open(CONFIG_FILE, "w", encoding="utf-8") as f:
                    json.dump(cfg, f, indent=2)
                current_mtime = os.path.getmtime(CONFIG_FILE)
            except Exception:
                pass

        _config_cache = cfg
        _config_cache_mtime = current_mtime
        return cfg


def save_config(cfg: dict) -> None:
    global _config_cache, _config_cache_mtime
    merged = {**_DEFAULTS, **cfg}
    if _IS_FROZEN:
        merged["DB_PATH"] = DB_PATH

    os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(merged, f, indent=2)

    with _config_lock:
        _config_cache = None
        _config_cache_mtime = None


_cfg = load_config()

API_KEY = _cfg["API_KEY"]
BACKUP_ROOT = _cfg["BACKUP_ROOT"]
HOST = _cfg["HOST"]
PORT = int(_cfg["PORT"])
DB_PATH = _cfg["DB_PATH"]
REQUIRE_APPROVAL = bool(_cfg.get("REQUIRE_APPROVAL", True))
SHARED_DIRS: list = _cfg.get("SHARED_DIRS", [])