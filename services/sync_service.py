"""services/sync_service.py — Differential Sync & File Ingestion Service."""

from __future__ import annotations

import asyncio
import time
from typing import Any, AsyncGenerator, Dict, List, Set

from repositories import device_repo, file_repo
from storage.manager import get_storage
from state import add_log, set_current_activity


class SyncService:
    def __init__(self):
        self.storage = get_storage()

    def check_files(self, device_id: str, files: List[Dict[str, Any]], verify_disk: bool = False) -> Dict[str, Any]:
        """Perform high-performance batch differential checking against database and storage."""
        items = []
        for f in files:
            items.append({
                "path": f.get("relative_path") or f.get("path") or "",
                "size": int(f.get("size") or 0),
                "modified_time": int(f.get("modified_time") or 0),
                "external_id": f.get("external_id") or f.get("id"),
                "device_id": device_id,
            })

        # Batch check against database index
        present_keys = file_repo.batch_check_files(items)
        checked = []
        present_count = 0

        for it in items:
            key = f"{it['path']}|{it['modified_time']}|{it['size']}"
            is_present = key in present_keys
            if is_present and verify_disk:
                is_present = self.storage.exists(it["path"], size=it["size"], device_id=device_id)

            if is_present:
                present_count += 1

            checked.append({
                "relative_path": it["path"],
                "present": is_present,
            })

        device_stats = device_repo.get_device_stats("", device_id=device_id)
        return {
            "files": checked,
            "present": present_count,
            "missing": len(checked) - present_count,
            "device_total_files": device_stats.get("total_files", 0),
            "device_total_size": device_stats.get("total_size", 0),
        }

    def should_skip_upload(
        self,
        relative_path: str,
        size: int,
        modified_time: int,
        external_id: str | None,
        device_id: str | None,
        verify_disk: bool = False,
    ) -> bool:
        if not file_repo.is_uploaded_compatible(relative_path, size, modified_time, external_id, device_id=device_id):
            return False
        if verify_disk:
            return self.storage.exists(relative_path, size=size, device_id=device_id)
        return True

    def finish_upload(
        self,
        relative_path: str,
        size: int,
        modified_time: int,
        device_ip: str,
        external_id: str | None = None,
        sha256: str | None = None,
        device_id: str | None = None,
    ) -> Dict[str, Any]:
        now = int(time.time())
        file_repo.insert_file(
            relative_path, size, modified_time, now, device_ip, external_id, sha256, device_id=device_id
        )

        # Atomic O(1) device stats increment
        device_stats = device_repo.touch_device_and_get_stats(
            device_ip, device_id=device_id, files_delta=1, size_delta=size
        )
        dev_name = device_repo.get_device_display_name(device_id or device_ip)
        add_log(f"Uploaded: {relative_path} ({dev_name})")

        # Debounced background clustering
        if device_id:
            try:
                from trips import trigger_background_clustering
                trigger_background_clustering(device_id)
            except Exception:
                pass

        return {
            "status": "uploaded",
            "device_total_files": device_stats.get("total_files", 0),
            "device_total_size": device_stats.get("total_size", 0),
        }

    def skipped_upload(self, device_ip: str, device_id: str | None = None) -> Dict[str, Any]:
        device_stats = device_repo.touch_device_and_get_stats(
            device_ip, device_id=device_id, files_delta=0, size_delta=0
        )
        return {
            "status": "skipped",
            "device_total_files": device_stats.get("total_files", 0),
            "device_total_size": device_stats.get("total_size", 0),
        }


sync_service = SyncService()
