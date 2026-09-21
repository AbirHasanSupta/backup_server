"""storage/manager.py — Central Storage Provider Factory & Path Resolver."""

from __future__ import annotations

from core.config import load_config
from storage.base import StorageBackend
from storage.local import LocalStorageBackend
from storage.s3 import S3StorageBackend

_storage_instance: StorageBackend | None = None


def get_storage() -> StorageBackend:
    """Return the configured StorageBackend singleton."""
    global _storage_instance
    if _storage_instance is not None:
        return _storage_instance

    cfg = load_config()
    backend_type = cfg.get("STORAGE_BACKEND", "local").lower()
    if backend_type == "s3":
        _storage_instance = S3StorageBackend()
    else:
        _storage_instance = LocalStorageBackend()
    return _storage_instance
