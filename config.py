import json
import os
import shutil
import sys


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
}


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


def _migrate_frozen_files() -> None:
    if not _IS_FROZEN:
        return

    _copy_if_missing(_PORTABLE_CONFIG_FILE, CONFIG_FILE)
    _copy_if_missing(_PORTABLE_DB_PATH, DB_PATH)

    cfg = _load_json(CONFIG_FILE)
    old_db_path = (cfg or {}).get("DB_PATH")
    if old_db_path and os.path.abspath(old_db_path) != os.path.abspath(DB_PATH):
        _copy_if_missing(old_db_path, DB_PATH)


def load_config() -> dict:
    _migrate_frozen_files()

    data = _load_json(CONFIG_FILE)
    if data is None and _IS_FROZEN:
        data = _load_json(_PORTABLE_CONFIG_FILE)

    cfg = {**_DEFAULTS, **(data or {})}

    if _IS_FROZEN:
        cfg["DB_PATH"] = DB_PATH

    return cfg


def save_config(cfg: dict) -> None:
    merged = {**_DEFAULTS, **cfg}
    if _IS_FROZEN:
        merged["DB_PATH"] = DB_PATH

    os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(merged, f, indent=2)


_cfg = load_config()

API_KEY = _cfg["API_KEY"]
BACKUP_ROOT = _cfg["BACKUP_ROOT"]
HOST = _cfg["HOST"]
PORT = int(_cfg["PORT"])
DB_PATH = _cfg["DB_PATH"]
REQUIRE_APPROVAL = bool(_cfg.get("REQUIRE_APPROVAL", True))
