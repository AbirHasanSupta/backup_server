import os
import json

# config file lives next to this module
_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(_DIR, "server_config.json")

_DEFAULTS = {
    "API_KEY": "YOUR_SECRET_KEY",
    "BACKUP_ROOT": os.path.join("D:\\", "PhoneBackup"),
    "HOST": "0.0.0.0",
    "PORT": 8000,
    "DB_PATH": os.path.join(_DIR, "backup.db"),
    "REQUIRE_APPROVAL": True,
}


def load_config() -> dict:
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            return {**_DEFAULTS, **data}
        except Exception:
            pass
    return _DEFAULTS.copy()


def save_config(cfg: dict) -> None:
    merged = {**_DEFAULTS, **cfg}
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(merged, f, indent=2)


_cfg = load_config()

API_KEY = _cfg["API_KEY"]
BACKUP_ROOT = _cfg["BACKUP_ROOT"]
HOST = _cfg["HOST"]
PORT = int(_cfg["PORT"])
DB_PATH = _cfg["DB_PATH"]
REQUIRE_APPROVAL = bool(_cfg.get("REQUIRE_APPROVAL", True))
