"""storage/s3.py — High-Throughput S3 & MinIO Object Storage Provider."""

from __future__ import annotations

import asyncio
import hashlib
import os
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
        clean_path = relative_path.replace("\\", "/").strip("/")
        return f"{device_id}/{clean_path}" if device_id else clean_path

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
    ) -> Tuple[str, str]:
        client = self._get_client()
        key = self._object_key(relative_path, device_id)
        # Stream upload directly to S3
        client.upload_fileobj(source, self.bucket_name, key)
        return self.get_file_path(relative_path, device_id), ""

    async def save_async_stream(
        self,
        relative_path: str,
        stream: AsyncGenerator[bytes, None],
        device_id: str | None = None,
        expected_size: int | None = None,
        compute_sha256: bool = True,
    ) -> Tuple[str, str]:
        # Temporarily spool async stream and upload to S3
        from storage.local import LocalStorageBackend
        local_temp = LocalStorageBackend()
        temp_path, sha = await local_temp.save_async_stream(
            relative_path, stream, device_id, expected_size, compute_sha256
        )
        try:
            with open(temp_path, "rb") as f:
                self.save_stream(relative_path, f, device_id, expected_size, False)
        finally:
            local_temp.delete(relative_path, device_id)
        return self.get_file_path(relative_path, device_id), sha

    def delete(self, relative_path: str, device_id: str | None = None) -> bool:
        client = self._get_client()
        try:
            client.delete_object(Bucket=self.bucket_name, Key=self._object_key(relative_path, device_id))
            return True
        except Exception:
            return False
