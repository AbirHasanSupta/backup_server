"""storage/base.py — Abstract Storage Provider Interface."""

from __future__ import annotations

import abc
from typing import AsyncGenerator, BinaryIO, Generator, Tuple


class StorageBackend(abc.ABC):
    """Abstract interface defining required storage operations for files, blobs, and streams."""

    @abc.abstractmethod
    def save_bytes(self, relative_path: str, data: bytes, device_id: str | None = None) -> str:
        """Persist raw byte data atomically and return absolute storage location."""
        pass

    @abc.abstractmethod
    def save_stream(
        self,
        relative_path: str,
        source: BinaryIO,
        device_id: str | None = None,
        expected_size: int | None = None,
        compute_sha256: bool = True,
    ) -> Tuple[str, str]:
        """Stream data from file-like object to disk atomically. Returns (path, sha256)."""
        pass

    @abc.abstractmethod
    async def save_async_stream(
        self,
        relative_path: str,
        stream: AsyncGenerator[bytes, None],
        device_id: str | None = None,
        expected_size: int | None = None,
        compute_sha256: bool = True,
    ) -> Tuple[str, str]:
        """Save chunked async stream (e.g. from FastAPI request body) atomically. Returns (path, sha256)."""
        pass

    @abc.abstractmethod
    def exists(self, relative_path: str, size: int | None = None, device_id: str | None = None) -> bool:
        """Check if file exists and matches size."""
        pass

    @abc.abstractmethod
    def get_file_path(self, relative_path: str, device_id: str | None = None) -> str:
        """Resolve full absolute storage path safely guarding against directory traversal."""
        pass

    @abc.abstractmethod
    def get_file_size(self, relative_path: str, device_id: str | None = None) -> int:
        """Return size in bytes."""
        pass

    @abc.abstractmethod
    def calculate_sha256(self, relative_path: str, device_id: str | None = None) -> str:
        """Compute SHA-256 hash of stored file."""
        pass

    @abc.abstractmethod
    def delete(self, relative_path: str, device_id: str | None = None) -> bool:
        """Delete file safely."""
        pass
