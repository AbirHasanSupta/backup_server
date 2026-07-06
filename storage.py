import os
import re

from config import load_config


def _backup_root() -> str:
    """Read BACKUP_ROOT fresh from config on every call so reloads propagate."""
    return load_config()["BACKUP_ROOT"]


def sanitize_relative_path(relative_path: str) -> str:
    parts = relative_path.split("/")
    parts = [re.sub(r'[<>:"|?*]', "_", p) for p in parts]
    return os.path.join(*parts)


def save_file(relative_path: str, content: bytes) -> str:
    safe_path = sanitize_relative_path(relative_path)
    full_path = os.path.join(_backup_root(), safe_path)
    os.makedirs(os.path.dirname(full_path), exist_ok=True)
    with open(full_path, "wb") as f:
        f.write(content)
    return full_path