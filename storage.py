import os
import re
import shutil
import threading

from config import load_config


def _backup_root() -> str:
    """Read BACKUP_ROOT fresh from config on every call so reloads propagate."""
    return load_config()["BACKUP_ROOT"]


def sanitize_relative_path(relative_path: str) -> str:
    normalized = (relative_path or "").replace("\\", "/")
    parts = []
    for part in normalized.split("/"):
        part = part.strip()
        if not part or part in (".", ".."):
            continue
        parts.append(re.sub(r'[<>:"|?*]', "_", part))
    return os.path.join(*parts) if parts else "unnamed"


def full_path_for(relative_path: str) -> str:
    root = os.path.abspath(_backup_root())
    full_path = os.path.abspath(os.path.join(root, sanitize_relative_path(relative_path)))
    if os.path.commonpath([root, full_path]) != root:
        raise ValueError("Invalid backup path")
    return full_path


def file_exists(relative_path: str, size: int | None = None) -> bool:
    try:
        full_path = full_path_for(relative_path)
        if not os.path.isfile(full_path):
            return False
        if size is not None and size >= 0:
            return os.path.getsize(full_path) == size
        return True
    except Exception:
        return False


def save_file(relative_path: str, content: bytes) -> str:
    full_path = full_path_for(relative_path)
    os.makedirs(os.path.dirname(full_path), exist_ok=True)
    tmp_path = f"{full_path}.tmp-{os.getpid()}-{threading.get_ident()}"
    with open(tmp_path, "wb") as f:
        f.write(content)
    os.replace(tmp_path, full_path)
    return full_path


def save_fileobj(relative_path: str, source, buffer_size: int = 1024 * 1024) -> str:
    full_path = full_path_for(relative_path)
    os.makedirs(os.path.dirname(full_path), exist_ok=True)
    tmp_path = f"{full_path}.tmp-{os.getpid()}-{threading.get_ident()}"
    try:
        with open(tmp_path, "wb") as out:
            shutil.copyfileobj(source, out, length=buffer_size)
        os.replace(tmp_path, full_path)
    except Exception:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise
    return full_path
