"""repositories/file_repo.py — File & Sync Session Repository."""

from __future__ import annotations

from typing import Any, Dict, List, Set
from database import (
    batch_check_files as db_batch_check_files,
    is_uploaded_compatible as db_is_uploaded_compatible,
    insert_file as db_insert_file,
    insert_file_and_touch_device as db_insert_file_and_touch_device,
    get_files_for_device as db_get_files_for_device,
    search_files_for_device as db_search_files_for_device,
    get_files_browse as db_get_files_browse,
    remove_file_record as db_remove_file_record,
    get_upload_cache as db_get_upload_cache,
    insert_sync_session as db_insert_sync_session,
    get_sync_sessions as db_get_sync_sessions,
    clear_sync_sessions as db_clear_sync_sessions,
    get_cleanup_candidates as db_get_cleanup_candidates,
    log_cleanup_deletions as db_log_cleanup_deletions,
    get_stats as db_get_stats,
)


def batch_check_files(items: List[Dict[str, Any]]) -> Set[str]:
    return db_batch_check_files(items)


def is_uploaded_compatible(
    path: str,
    size: int,
    modified_time: int,
    external_id: str | None = None,
    device_id: str | None = None,
) -> bool:
    return db_is_uploaded_compatible(path, size, modified_time, external_id, device_id=device_id)


def insert_file(
    path: str,
    size: int,
    modified_time: int,
    uploaded_time: int,
    device_ip: str,
    external_id: str | None = None,
    sha256: str | None = None,
    device_id: str | None = None,
) -> None:
    db_insert_file(path, size, modified_time, uploaded_time, device_ip, external_id, sha256, device_id=device_id)


def insert_file_and_touch_device(
    path: str,
    size: int,
    modified_time: int,
    uploaded_time: int,
    device_ip: str,
    external_id: str | None = None,
    sha256: str | None = None,
    device_id: str | None = None,
) -> Dict[str, Any]:
    return db_insert_file_and_touch_device(
        path, size, modified_time, uploaded_time, device_ip, external_id, sha256, device_id=device_id
    )


def get_files_for_device(device_id: str, prefix: str = "") -> List[Dict[str, Any]]:
    return db_get_files_for_device(device_id, prefix)


def search_files_for_device(
    device_id: str,
    query: str,
    category: str = "all",
    limit: int = 100,
) -> List[Dict[str, Any]]:
    return db_search_files_for_device(device_id, query, limit=limit)


def get_files_browse(
    device_id: str,
    prefix: str = "",
    folder_path: str = "",
    **kwargs,
) -> tuple[list[dict], list[dict]]:
    norm_prefix = (prefix or folder_path).strip("/")
    norm_prefix = f"{norm_prefix}/" if norm_prefix else ""
    return db_get_files_browse(device_id, norm_prefix)


def remove_file_record(device_id: str, relative_path: str, size: int = 0, modified_time: int = 0) -> bool:
    try:
        from database import get_conn
        conn = get_conn()
        cur = conn.execute(
            "DELETE FROM files WHERE (device_id = ? OR device_id IS NULL) AND path = ?",
            (device_id, relative_path),
        )
        conn.commit()
        deleted = cur.rowcount > 0
        conn.close()
        return deleted
    except Exception:
        return False


def get_upload_cache(device_id: str) -> List[Dict[str, Any]]:
    return db_get_upload_cache(device_id)


def insert_sync_session(data: Dict[str, Any]) -> int:
    return db_insert_sync_session(
        device_id=data.get("device_id"),
        device_name=data.get("device_name"),
        started_at=data.get("started_at", 0),
        ended_at=data.get("ended_at", data.get("finished_at", 0)),
        duration_ms=data.get("duration_ms", int(data.get("duration_sec", 0) * 1000)),
        trigger=data.get("trigger", "manual"),
        outcome=data.get("outcome", data.get("status", "success")),
        scanned=data.get("scanned", 0),
        checked=data.get("checked", 0),
        uploaded=data.get("uploaded", data.get("files_uploaded", 0)),
        skipped=data.get("skipped", data.get("files_skipped", 0)),
        errors=data.get("errors", data.get("files_failed", 0)),
        total_files=data.get("total_files", 0),
    )


def get_sync_sessions(device_id: str, limit: int = 50) -> List[Dict[str, Any]]:
    return db_get_sync_sessions(device_id, limit)


def clear_sync_sessions(device_id: str) -> bool:
    return db_clear_sync_sessions(device_id)


def get_cleanup_candidates(device_id: str, client_files: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return db_get_cleanup_candidates(device_id, client_files)


def log_cleanup_deletions(device_id: str, deleted_files: List[Dict[str, Any]]) -> int:
    return db_log_cleanup_deletions(device_id, deleted_files)


def get_global_stats() -> Dict[str, Any]:
    return db_get_stats()
