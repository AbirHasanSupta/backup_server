"""repositories/file_repo.py — File & Sync Session Repository."""

from __future__ import annotations

from typing import Any, Dict, List, Set
from database import (
    batch_check_files as db_batch_check_files,
    is_uploaded_compatible as db_is_uploaded_compatible,
    insert_file as db_insert_file,
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


def get_files_for_device(device_id: str, prefix: str = "") -> List[Dict[str, Any]]:
    return db_get_files_for_device(device_id, prefix)


def search_files_for_device(
    device_id: str,
    query: str,
    category: str = "all",
    limit: int = 100,
) -> List[Dict[str, Any]]:
    return db_search_files_for_device(device_id, query, category, limit)


def get_files_browse(
    device_id: str,
    folder_path: str = "",
    recursive: bool = False,
    sort_by: str = "date",
    sort_order: str = "desc",
    category: str = "all",
    limit: int | None = None,
    offset: int = 0,
) -> Dict[str, Any]:
    return db_get_files_browse(device_id, folder_path, recursive, sort_by, sort_order, category, limit, offset)


def remove_file_record(device_id: str, relative_path: str) -> bool:
    return db_remove_file_record(device_id, relative_path)


def get_upload_cache(device_id: str) -> List[Dict[str, Any]]:
    return db_get_upload_cache(device_id)


def insert_sync_session(data: Dict[str, Any]) -> None:
    db_insert_sync_session(data)


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
