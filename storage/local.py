"""storage/local.py — High-Performance Local Filesystem Storage with CAS."""

from __future__ import annotations

import asyncio
import hashlib
import os
import re
import threading
from typing import AsyncGenerator, BinaryIO, Tuple

from core.config import load_config
from core.exceptions import StoragePathTraversalError
from storage.base import StorageBackend

_BUFFER_SIZE = 4 * 1024 * 1024  # 4MB high-throughput buffer block


class LocalStorageBackend(StorageBackend):
    """Production local filesystem storage backend with atomic temp files and traversal guards."""

    def __init__(self, custom_root: str | None = None):
        self._custom_root = custom_root

    def _get_root(self, device_id: str | None = None) -> str:
        base_root = os.path.abspath(self._custom_root or load_config().get("BACKUP_ROOT", "D:\\PhoneBackup"))
        if device_id:
            try:
                from repositories.device_repo import get_device_folder_name
                folder = get_device_folder_name(device_id)
            except Exception:
                folder = None
            safe_folder = folder or re.sub(r'[<>:"|?*]', '_', device_id).strip()
            return os.path.join(base_root, safe_folder)
        return base_root

    @staticmethod
    def sanitize_path(relative_path: str) -> str:
        normalized = (relative_path or "").replace("\\", "/")
        parts = []
        for part in normalized.split("/"):
            part = part.strip()
            if not part or part in (".", ".."):
                continue
            parts.append(re.sub(r'[<>:"|?*]', '_', part))
        return os.path.join(*parts) if parts else "unnamed"

    def get_file_path(self, relative_path: str, device_id: str | None = None) -> str:
        root = self._get_root(device_id)
        safe_rel = self.sanitize_path(relative_path)
        full_path = os.path.abspath(os.path.join(root, safe_rel))
        if os.path.commonpath([root, full_path]) != root:
            raise StoragePathTraversalError(f"Directory traversal detected for path: {relative_path}")
        return full_path

    def exists(self, relative_path: str, size: int | None = None, device_id: str | None = None) -> bool:
        try:
            full_path = self.get_file_path(relative_path, device_id=device_id)
            if not os.path.isfile(full_path):
                return False
            if size is not None and size > 0:
                return os.path.getsize(full_path) == size
            return True
        except Exception:
            return False

    def get_file_size(self, relative_path: str, device_id: str | None = None) -> int:
        try:
            return os.path.getsize(self.get_file_path(relative_path, device_id=device_id))
        except OSError:
            return 0

    def calculate_sha256(self, relative_path: str, device_id: str | None = None) -> str:
        try:
            full_path = self.get_file_path(relative_path, device_id=device_id)
            hasher = hashlib.sha256()
            with open(full_path, "rb") as f:
                for chunk in iter(lambda: f.read(65536), b""):
                    hasher.update(chunk)
            return hasher.hexdigest()
        except Exception:
            return ""

    def save_bytes(self, relative_path: str, data: bytes, device_id: str | None = None) -> str:
        full_path = self.get_file_path(relative_path, device_id=device_id)
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        tmp_path = f"{full_path}.tmp-{os.getpid()}-{threading.get_ident()}"
        with open(tmp_path, "wb") as f:
            f.write(data)
        os.replace(tmp_path, full_path)
        return full_path

    def save_stream(
        self,
        relative_path: str,
        source: BinaryIO,
        device_id: str | None = None,
        expected_size: int | None = None,
        compute_sha256: bool = True,
    ) -> Tuple[str, str]:
        full_path = self.get_file_path(relative_path, device_id=device_id)
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        tmp_path = f"{full_path}.tmp-{os.getpid()}-{threading.get_ident()}"
        hasher = hashlib.sha256() if compute_sha256 else None
        bytes_written = 0

        try:
            with open(tmp_path, "wb", buffering=_BUFFER_SIZE) as out:
                for chunk in iter(lambda: source.read(_BUFFER_SIZE), b""):
                    out.write(chunk)
                    bytes_written += len(chunk)
                    if hasher:
                        hasher.update(chunk)

            if expected_size is not None and expected_size > 0 and bytes_written != expected_size:
                raise ValueError(f"Uploaded file size mismatch: expected {expected_size}, wrote {bytes_written}")

            os.replace(tmp_path, full_path)
        except Exception:
            if os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
            raise

        return full_path, hasher.hexdigest() if hasher else ""

    async def save_async_stream(
        self,
        relative_path: str,
        stream: AsyncGenerator[bytes, None],
        device_id: str | None = None,
        expected_size: int | None = None,
        compute_sha256: bool = True,
    ) -> Tuple[str, str]:
        full_path = self.get_file_path(relative_path, device_id=device_id)
        await asyncio.to_thread(os.makedirs, os.path.dirname(full_path), exist_ok=True)
        tmp_path = f"{full_path}.tmp-{os.getpid()}-{threading.get_ident()}"
        hasher = hashlib.sha256() if compute_sha256 else None
        bytes_written = 0
        write_buf = bytearray()

        def _sync_write(f, data: bytes | bytearray):
            f.write(data)

        out = await asyncio.to_thread(open, tmp_path, "wb", _BUFFER_SIZE)
        try:
            async for chunk in stream:
                if not chunk:
                    continue
                write_buf.extend(chunk)
                bytes_written += len(chunk)
                if hasher:
                    hasher.update(chunk)

                if len(write_buf) >= _BUFFER_SIZE:
                    data_to_write = bytes(write_buf)
                    write_buf.clear()
                    await asyncio.to_thread(_sync_write, out, data_to_write)

            if write_buf:
                data_to_write = bytes(write_buf)
                write_buf.clear()
                await asyncio.to_thread(_sync_write, out, data_to_write)

            await asyncio.to_thread(out.close)
            if expected_size is not None and expected_size > 0 and bytes_written != expected_size:
                raise ValueError(f"Stream size mismatch: expected {expected_size}, got {bytes_written}")

            await asyncio.to_thread(os.replace, tmp_path, full_path)
        except Exception:
            try:
                await asyncio.to_thread(out.close)
            except Exception:
                pass
            if os.path.exists(tmp_path):
                try:
                    await asyncio.to_thread(os.remove, tmp_path)
                except OSError:
                    pass
            raise

        return full_path, hasher.hexdigest() if hasher else ""

    def delete(self, relative_path: str, device_id: str | None = None) -> bool:
        try:
            full_path = self.get_file_path(relative_path, device_id=device_id)
            if os.path.isfile(full_path):
                os.remove(full_path)
                return True
            return False
        except Exception:
            return False
