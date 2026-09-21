"""storage/local.py — High-Performance Local Filesystem Storage with CAS."""

from __future__ import annotations

import asyncio
import hashlib
import os
import re
import threading
import time
from typing import AsyncGenerator, BinaryIO, Tuple

from core.config import APP_DATA_DIR, load_config
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
        expected_sha256: str | None = None,
    ) -> Tuple[str, str]:
        full_path = self.get_file_path(relative_path, device_id=device_id)
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        tmp_path = f"{full_path}.tmp-{os.getpid()}-{threading.get_ident()}"
        hasher = hashlib.sha256() if (compute_sha256 or expected_sha256) else None
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

            if expected_sha256 and (not hasher or hasher.hexdigest().lower() != expected_sha256.lower()):
                raise ValueError("Uploaded file does not match the declared SHA-256")

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
        expected_sha256: str | None = None,
    ) -> Tuple[str, str]:
        full_path = self.get_file_path(relative_path, device_id=device_id)
        await asyncio.to_thread(os.makedirs, os.path.dirname(full_path), exist_ok=True)
        tmp_path = f"{full_path}.tmp-{os.getpid()}-{threading.get_ident()}"
        hasher = hashlib.sha256() if (compute_sha256 or expected_sha256) else None
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

            if expected_sha256 and (not hasher or hasher.hexdigest().lower() != expected_sha256.lower()):
                raise ValueError("Uploaded file does not match the declared SHA-256")

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

    @staticmethod
    def _safe_upload_id(upload_id: str) -> str:
        safe_id = re.sub(r"[^a-zA-Z0-9_-]", "", upload_id or "").strip()
        if not 8 <= len(safe_id) <= 128:
            raise ValueError("Invalid resumable upload identifier")
        return safe_id

    def _get_chunks_dir(self, upload_id: str, device_id: str | None = None) -> str:
        safe_id = self._safe_upload_id(upload_id)
        # Sessions are scoped to the authenticated device.  This prevents a
        # second device from observing, completing, or deleting another
        # device's partial upload even if an identifier is guessed.
        device_key = hashlib.sha256((device_id or "anonymous").encode("utf-8")).hexdigest()[:32]
        chunks_base = os.path.join(APP_DATA_DIR, "upload_chunks", device_key)
        return os.path.join(chunks_base, safe_id)

    def save_chunk(self, upload_id: str, chunk_index: int, data: bytes, device_id: str | None = None) -> int:
        chunks_dir = self._get_chunks_dir(upload_id, device_id)
        os.makedirs(chunks_dir, exist_ok=True)
        chunk_file = os.path.join(chunks_dir, f"chunk_{chunk_index:06d}.part")
        tmp_chunk = f"{chunk_file}.tmp-{threading.get_ident()}"
        with open(tmp_chunk, "wb") as f:
            f.write(data)
        os.replace(tmp_chunk, chunk_file)
        os.utime(chunks_dir, None)
        return len(data)

    def assemble_chunks(
        self,
        upload_id: str,
        relative_path: str,
        total_chunks: int,
        expected_size: int | None = None,
        device_id: str | None = None,
        expected_sha256: str | None = None,
    ) -> Tuple[str, str]:
        chunks_dir = self._get_chunks_dir(upload_id, device_id)
        if not os.path.isdir(chunks_dir):
            raise FileNotFoundError(f"Upload chunks session {upload_id} not found.")

        # Verify all chunk files exist
        for idx in range(total_chunks):
            chunk_file = os.path.join(chunks_dir, f"chunk_{idx:06d}.part")
            if not os.path.isfile(chunk_file):
                raise ValueError(f"Missing chunk {idx} of {total_chunks} for upload session {upload_id}")

        full_path = self.get_file_path(relative_path, device_id=device_id)
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        tmp_path = f"{full_path}.tmp-{os.getpid()}-{threading.get_ident()}"
        hasher = hashlib.sha256()
        bytes_written = 0

        try:
            with open(tmp_path, "wb", buffering=_BUFFER_SIZE) as out:
                for idx in range(total_chunks):
                    chunk_file = os.path.join(chunks_dir, f"chunk_{idx:06d}.part")
                    with open(chunk_file, "rb", buffering=_BUFFER_SIZE) as c_in:
                        for block in iter(lambda: c_in.read(_BUFFER_SIZE), b""):
                            out.write(block)
                            bytes_written += len(block)
                            hasher.update(block)

            if expected_size is not None and expected_size > 0 and bytes_written != expected_size:
                raise ValueError(f"Assembled file size mismatch: expected {expected_size}, got {bytes_written}")

            if expected_sha256 and hasher.hexdigest().lower() != expected_sha256.lower():
                raise ValueError("Assembled file does not match the declared SHA-256")

            os.replace(tmp_path, full_path)
            self.cleanup_chunks(upload_id, device_id=device_id)
            return full_path, hasher.hexdigest()
        except Exception:
            if os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
            raise

    def cleanup_chunks(self, upload_id: str, device_id: str | None = None) -> None:
        chunks_dir = self._get_chunks_dir(upload_id, device_id)
        if os.path.isdir(chunks_dir):
            try:
                import shutil
                shutil.rmtree(chunks_dir, ignore_errors=True)
            except Exception:
                pass

    def get_chunk_status(
        self, upload_id: str, total_chunks: int, device_id: str | None = None
    ) -> dict:
        chunks_dir = self._get_chunks_dir(upload_id, device_id)
        received: list[int] = []
        bytes_received = 0
        if not os.path.isdir(chunks_dir):
            return {"received_chunks": received, "bytes_received": bytes_received}

        for entry in os.scandir(chunks_dir):
            match = re.fullmatch(r"chunk_(\d{6})\.part", entry.name)
            if not match or not entry.is_file():
                continue
            index = int(match.group(1))
            if 0 <= index < total_chunks:
                received.append(index)
                bytes_received += entry.stat().st_size
        received.sort()
        return {"received_chunks": received, "bytes_received": bytes_received}

    def cleanup_expired_chunks(self, max_age_seconds: int) -> int:
        """Delete only expired device-scoped session directories beneath APP_DATA_DIR."""
        ttl = max(1, int(max_age_seconds))
        root = os.path.join(APP_DATA_DIR, "upload_chunks")
        if not os.path.isdir(root):
            return 0

        deadline = time.time() - ttl
        deleted = 0
        for device_dir in os.scandir(root):
            if not device_dir.is_dir():
                continue
            for session_dir in os.scandir(device_dir.path):
                if not session_dir.is_dir() or session_dir.stat().st_mtime >= deadline:
                    continue
                try:
                    import shutil
                    shutil.rmtree(session_dir.path)
                    deleted += 1
                except OSError:
                    # A concurrently completing session is retried on the
                    # next maintenance pass instead of disrupting an upload.
                    continue
        return deleted

    def delete(self, relative_path: str, device_id: str | None = None) -> bool:
        try:
            full_path = self.get_file_path(relative_path, device_id=device_id)
            if os.path.isfile(full_path):
                os.remove(full_path)
                return True
            return False
        except Exception:
            return False
