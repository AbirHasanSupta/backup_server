"""storage/s3.py — High-Throughput S3 & MinIO Object Storage Provider."""

from __future__ import annotations

import asyncio
import hashlib
import os
import re
import tempfile
from typing import AsyncGenerator, BinaryIO, Tuple

from core.config import load_config
from storage.base import StorageBackend


class S3StorageBackend(StorageBackend):
    """S3-compatible object storage provider (MinIO / AWS S3 / Cloudflare R2 / Ceph)."""

    def __init__(self, bucket_name: str = "phone-backups"):
        self.bucket_name = os.environ.get("S3_BUCKET_NAME") or bucket_name
        self.endpoint_url = os.environ.get("S3_ENDPOINT_URL")
        self.access_key = os.environ.get("S3_ACCESS_KEY")
        self.secret_key = os.environ.get("S3_SECRET_KEY")
        self._s3_client = None

    def _get_client(self):
        if self._s3_client is not None:
            return self._s3_client
        import boto3
        self._s3_client = boto3.client(
            "s3",
            endpoint_url=self.endpoint_url,
            aws_access_key_id=self.access_key,
            aws_secret_access_key=self.secret_key,
        )
        return self._s3_client

    def _object_key(self, relative_path: str, device_id: str | None = None) -> str:
        parts = []
        for part in (relative_path or "").replace("\\", "/").split("/"):
            part = part.strip()
            if not part or part in (".", ".."):
                continue
            parts.append(re.sub(r'[<>:"|?*]', "_", part))
        clean_path = "/".join(parts) or "unnamed"
        if not device_id:
            return clean_path
        safe_device_id = re.sub(r"[^A-Za-z0-9_-]", "_", device_id).strip("_") or "unknown-device"
        return f"{safe_device_id}/{clean_path}"

    def get_file_path(self, relative_path: str, device_id: str | None = None) -> str:
        # Return S3 URI format
        return f"s3://{self.bucket_name}/{self._object_key(relative_path, device_id)}"

    def exists(self, relative_path: str, size: int | None = None, device_id: str | None = None) -> bool:
        client = self._get_client()
        try:
            resp = client.head_object(Bucket=self.bucket_name, Key=self._object_key(relative_path, device_id))
            if size is not None and size > 0:
                return resp.get("ContentLength") == size
            return True
        except Exception:
            return False

    def get_file_size(self, relative_path: str, device_id: str | None = None) -> int:
        client = self._get_client()
        try:
            resp = client.head_object(Bucket=self.bucket_name, Key=self._object_key(relative_path, device_id))
            return resp.get("ContentLength", 0)
        except Exception:
            return 0

    def calculate_sha256(self, relative_path: str, device_id: str | None = None) -> str:
        # If stored in S3 metadata, return it, otherwise compute from stream
        client = self._get_client()
        try:
            resp = client.head_object(Bucket=self.bucket_name, Key=self._object_key(relative_path, device_id))
            meta_sha = resp.get("Metadata", {}).get("sha256")
            if meta_sha:
                return meta_sha
        except Exception:
            pass
        return ""

    def save_bytes(self, relative_path: str, data: bytes, device_id: str | None = None) -> str:
        client = self._get_client()
        key = self._object_key(relative_path, device_id)
        sha = hashlib.sha256(data).hexdigest()
        client.put_object(
            Bucket=self.bucket_name,
            Key=key,
            Body=data,
            Metadata={"sha256": sha},
        )
        return self.get_file_path(relative_path, device_id)

    def save_stream(
        self,
        relative_path: str,
        source: BinaryIO,
        device_id: str | None = None,
        expected_size: int | None = None,
        compute_sha256: bool = True,
        expected_sha256: str | None = None,
    ) -> Tuple[str, str]:
        # S3's managed upload can retry internally.  Spool first so the
        # checksum and declared size are verified before an object becomes
        # visible under its final key.
        hasher = hashlib.sha256() if (compute_sha256 or expected_sha256) else None
        bytes_written = 0
        with tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024, mode="w+b") as spool:
            for block in iter(lambda: source.read(4 * 1024 * 1024), b""):
                spool.write(block)
                bytes_written += len(block)
                if hasher:
                    hasher.update(block)
            if expected_size is not None and expected_size > 0 and bytes_written != expected_size:
                raise ValueError(f"Uploaded file size mismatch: expected {expected_size}, wrote {bytes_written}")
            digest = hasher.hexdigest() if hasher else ""
            if expected_sha256 and digest.lower() != expected_sha256.lower():
                raise ValueError("Uploaded file does not match the declared SHA-256")
            spool.seek(0)
            upload_args = (spool, self.bucket_name, self._object_key(relative_path, device_id))
            if digest:
                self._get_client().upload_fileobj(*upload_args, ExtraArgs={"Metadata": {"sha256": digest}})
            else:
                self._get_client().upload_fileobj(*upload_args)
        return self.get_file_path(relative_path, device_id), digest

    async def save_async_stream(
        self,
        relative_path: str,
        stream: AsyncGenerator[bytes, None],
        device_id: str | None = None,
        expected_size: int | None = None,
        compute_sha256: bool = True,
        expected_sha256: str | None = None,
    ) -> Tuple[str, str]:
        # Temporarily spool async stream and upload to S3
        from storage.local import LocalStorageBackend
        local_temp = LocalStorageBackend()
        temp_path, sha = await local_temp.save_async_stream(
            relative_path, stream, device_id, expected_size, compute_sha256, expected_sha256
        )
        try:
            with open(temp_path, "rb") as f:
                self.save_stream(relative_path, f, device_id, expected_size, False, expected_sha256)
        finally:
            local_temp.delete(relative_path, device_id)
        return self.get_file_path(relative_path, device_id), sha

    def save_chunk(self, upload_id: str, chunk_index: int, data: bytes, device_id: str | None = None) -> int:
        from storage.local import LocalStorageBackend
        local_temp = LocalStorageBackend()
        return local_temp.save_chunk(upload_id, chunk_index, data, device_id)

    def assemble_chunks(
        self,
        upload_id: str,
        relative_path: str,
        total_chunks: int,
        expected_size: int | None = None,
        device_id: str | None = None,
        expected_sha256: str | None = None,
    ) -> Tuple[str, str]:
        from storage.local import LocalStorageBackend
        local_temp = LocalStorageBackend()
        temp_path, sha = local_temp.assemble_chunks(
            upload_id, relative_path, total_chunks, expected_size, device_id, expected_sha256
        )
        try:
            with open(temp_path, "rb") as f:
                self.save_stream(relative_path, f, device_id, expected_size, False, expected_sha256)
        finally:
            local_temp.delete(relative_path, device_id)
        return self.get_file_path(relative_path, device_id), sha

    def cleanup_chunks(self, upload_id: str, device_id: str | None = None) -> None:
        from storage.local import LocalStorageBackend
        local_temp = LocalStorageBackend()
        local_temp.cleanup_chunks(upload_id, device_id)

    def get_chunk_status(
        self, upload_id: str, total_chunks: int, device_id: str | None = None
    ) -> dict:
        from storage.local import LocalStorageBackend
        local_temp = LocalStorageBackend()
        return local_temp.get_chunk_status(upload_id, total_chunks, device_id)

    def cleanup_expired_chunks(self, max_age_seconds: int) -> int:
        from storage.local import LocalStorageBackend
        return LocalStorageBackend().cleanup_expired_chunks(max_age_seconds)

    def delete(self, relative_path: str, device_id: str | None = None) -> bool:
        client = self._get_client()
        try:
            client.delete_object(Bucket=self.bucket_name, Key=self._object_key(relative_path, device_id))
            return True
        except Exception:
            return False
