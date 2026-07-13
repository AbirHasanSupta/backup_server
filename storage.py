import hashlib
import os
import re
import threading

from config import load_config

# Lazy import to avoid circular dependency — database imports config, not storage.
_get_device_folder_name = None


def _resolve_device_folder(device_id: str) -> str:
    """Return the human-readable folder name for *device_id*.

    The first time this is called we import ``get_device_folder_name`` from
    database (deferred to break any import cycle).  If the DB has no entry yet
    (e.g. during the very first upsert) we fall back to the raw device_id so
    files are never lost.
    """
    global _get_device_folder_name
    if _get_device_folder_name is None:
        try:
            from database import get_device_folder_name as _fn
            _get_device_folder_name = _fn
        except Exception:
            _get_device_folder_name = lambda did: None  # noqa: E731

    folder = _get_device_folder_name(device_id)
    if folder:
        return folder
    # Fallback: sanitize device_id itself (keeps old behaviour for legacy rows)
    return re.sub(r'[<>:"|?*]', "_", device_id).strip()


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


def full_path_for(relative_path: str, device_id: str | None = None) -> str:
    root = os.path.abspath(_backup_root())

    # If device_id is provided, nest files under the device's human-readable
    # folder name (derived from device_name, stored in DB).  This makes the
    # backup directory legible and stable across app reinstalls.
    if device_id:
        folder = _resolve_device_folder(device_id)
        root = os.path.join(root, folder)

    full_path = os.path.abspath(os.path.join(root, sanitize_relative_path(relative_path)))

    # Ensure the final path is still within the expected device-specific root (or global root)
    if os.path.commonpath([root, full_path]) != root:
        raise ValueError("Invalid backup path")
    return full_path


def calculate_sha256(relative_path: str, device_id: str | None = None) -> str:
    try:
        full_path = full_path_for(relative_path, device_id=device_id)
        sha256_hash = hashlib.sha256()
        with open(full_path, "rb") as f:
            for byte_block in iter(lambda: f.read(65536), b""):
                sha256_hash.update(byte_block)
        return sha256_hash.hexdigest()
    except Exception:
        return ""


def file_exists(relative_path: str, size: int | None = None, device_id: str | None = None) -> bool:
    try:
        full_path = full_path_for(relative_path, device_id=device_id)
        if not os.path.isfile(full_path):
            return False
        if size is not None and size >= 0:
            return os.path.getsize(full_path) == size
        return True
    except Exception:
        return False


def save_file(relative_path: str, content: bytes, device_id: str | None = None) -> str:
    full_path = full_path_for(relative_path, device_id=device_id)
    os.makedirs(os.path.dirname(full_path), exist_ok=True)
    tmp_path = f"{full_path}.tmp-{os.getpid()}-{threading.get_ident()}"
    with open(tmp_path, "wb") as f:
        f.write(content)
    os.replace(tmp_path, full_path)
    return full_path


def save_fileobj(
    relative_path: str,
    source,
    buffer_size: int = 4 * 1024 * 1024,
    device_id: str | None = None,
    compute_sha256: bool = False,
    expected_size: int | None = None,
) -> tuple[str, str]:
    full_path = full_path_for(relative_path, device_id=device_id)
    os.makedirs(os.path.dirname(full_path), exist_ok=True)
    tmp_path = f"{full_path}.tmp-{os.getpid()}-{threading.get_ident()}"
    sha256_hash = hashlib.sha256() if compute_sha256 else None
    bytes_written = 0
    try:
        with open(tmp_path, "wb", buffering=buffer_size) as out:
            for chunk in iter(lambda: source.read(buffer_size), b""):
                out.write(chunk)
                bytes_written += len(chunk)
                if sha256_hash:
                    sha256_hash.update(chunk)
        if expected_size is not None and expected_size >= 0 and bytes_written != expected_size:
            raise ValueError(f"Uploaded file size mismatch: expected {expected_size}, wrote {bytes_written}")
        os.replace(tmp_path, full_path)
    except Exception:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise
    return full_path, sha256_hash.hexdigest() if sha256_hash else ""


async def save_upload_stream(
    relative_path: str,
    chunks,
    buffer_size: int = 4 * 1024 * 1024,
    device_id: str | None = None,
    compute_sha256: bool = False,
    expected_size: int | None = None,
) -> tuple[str, str]:
    full_path = full_path_for(relative_path, device_id=device_id)
    os.makedirs(os.path.dirname(full_path), exist_ok=True)
    tmp_path = f"{full_path}.tmp-{os.getpid()}-{threading.get_ident()}"
    sha256_hash = hashlib.sha256() if compute_sha256 else None
    bytes_written = 0
    try:
        with open(tmp_path, "wb", buffering=buffer_size) as out:
            async for chunk in chunks:
                if not chunk:
                    continue
                out.write(chunk)
                bytes_written += len(chunk)
                if sha256_hash:
                    sha256_hash.update(chunk)
        if expected_size is not None and expected_size >= 0 and bytes_written != expected_size:
            raise ValueError(f"Uploaded file size mismatch: expected {expected_size}, wrote {bytes_written}")
        os.replace(tmp_path, full_path)
    except Exception:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise
    return full_path, sha256_hash.hexdigest() if sha256_hash else ""
