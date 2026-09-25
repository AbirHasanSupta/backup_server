"""repositories/file_repo.py — File & Sync Session Repository."""

from __future__ import annotations

from typing import Any, Dict, List, Set
from repositories.base import execute_read_one, execute_read_query, execute_write, is_postgres
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
    if is_postgres():
        if not device_id:
            return False
        if external_id:
            row = execute_read_one(
                "SELECT size, modified_time FROM files WHERE device_id = ? AND external_id = ?",
                (device_id, external_id),
            )
        else:
            row = execute_read_one(
                "SELECT size, modified_time FROM files WHERE device_id = ? AND path = ?",
                (device_id, path),
            )
        if not row:
            return False
        return row["size"] == size and row["modified_time"] == modified_time
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
    if is_postgres():
        target_id = device_id or device_ip
        execute_write(
            """
            INSERT INTO files (device_id, external_id, path, size, modified_time, sha256, uploaded_time, device_ip)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (target_id, external_id, path, size, modified_time, sha256, uploaded_time, device_ip),
        )
        return
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
    insert_file(path, size, modified_time, uploaded_time, device_ip, external_id, sha256, device_id=device_id)
    from repositories.device_repo import touch_device_and_get_stats
    return touch_device_and_get_stats(device_ip, device_id=device_id, files_delta=1, size_delta=size)


def get_files_for_device(device_id: str, prefix: str = "") -> List[Dict[str, Any]]:
    if is_postgres():
        if prefix:
            norm = prefix.strip("/")
            norm_dir = f"{norm}/%"
            return execute_read_query(
                "SELECT path, size, modified_time, sha256, uploaded_time FROM files WHERE device_id = ? AND (path = ? OR path LIKE ?) ORDER BY path",
                (device_id, norm, norm_dir),
            )
        return execute_read_query(
            "SELECT path, size, modified_time, sha256, uploaded_time FROM files WHERE device_id = ? ORDER BY path",
            (device_id,),
        )
    return db_get_files_for_device(device_id, prefix)


def search_files_for_device(
    device_id: str,
    query: str,
    category: str = "all",
    limit: int = 100,
) -> List[Dict[str, Any]]:
    if is_postgres():
        escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        return execute_read_query(
            "SELECT path, size, modified_time, sha256, uploaded_time FROM files WHERE device_id = ? AND path LIKE ? ORDER BY path LIMIT ?",
            (device_id, f"%{escaped}%", max(1, min(limit, 500))),
        )
    return db_search_files_for_device(device_id, query, limit=limit)


def get_files_browse(
    device_id: str,
    prefix: str = "",
    folder_path: str = "",
    **kwargs,
) -> tuple[list[dict], list[dict]]:
    norm_prefix = (prefix or folder_path).strip("/")
    norm_prefix = f"{norm_prefix}/" if norm_prefix else ""
    if is_postgres():
        like_pattern = f"{norm_prefix}%" if norm_prefix else "%"
        rows = execute_read_query(
            "SELECT path, size, modified_time, sha256, uploaded_time FROM files WHERE device_id = ? AND path LIKE ? ORDER BY path",
            (device_id, like_pattern),
        )
        prefix_len = len(norm_prefix)
        folders: dict[str, dict] = {}
        files: list[dict] = []
        for r in rows:
            path = r["path"]
            if norm_prefix and not path.startswith(norm_prefix):
                continue
            rest = path[prefix_len:]
            if not rest:
                continue
            slash_idx = rest.find("/")
            if slash_idx == -1:
                files.append(dict(r))
            else:
                folder_name = rest[:slash_idx]
                entry = folders.setdefault(
                    folder_name,
                    {"name": folder_name, "path": norm_prefix + folder_name, "file_count": 0, "total_size": 0},
                )
                entry["file_count"] += 1
                entry["total_size"] += r["size"] or 0
        return list(folders.values()), files
    return db_get_files_browse(device_id, norm_prefix)


def remove_file_record(device_id: str, relative_path: str, size: int = 0, modified_time: int = 0) -> bool:
    if is_postgres():
        n = execute_write("DELETE FROM files WHERE device_id = ? AND path = ?", (device_id, relative_path))
        return n > 0
    return db_remove_file_record(device_id, relative_path, size, modified_time)


def get_upload_cache(device_id: str) -> List[Dict[str, Any]]:
    if is_postgres():
        return execute_read_query("SELECT path, size, modified_time, sha256, uploaded_time FROM files WHERE device_id = ?", (device_id,))
    return db_get_upload_cache(device_id)


def insert_sync_session(data: Dict[str, Any]) -> int:
    if is_postgres():
        dev_id = data.get("device_id", "")
        st = data.get("started_at", 0)
        fin = data.get("ended_at", data.get("finished_at", 0))
        dur = data.get("duration_sec", (data.get("duration_ms", 0) / 1000))
        up = data.get("uploaded", data.get("files_uploaded", 0))
        by = data.get("bytes_uploaded", 0)
        sk = data.get("skipped", data.get("files_skipped", 0))
        fa = data.get("errors", data.get("files_failed", 0))
        stat = data.get("outcome", data.get("status", "completed"))
        ip = data.get("device_ip")
        execute_write(
            """
            INSERT INTO sync_sessions (device_id, started_at, finished_at, duration_sec, files_uploaded, bytes_uploaded, files_skipped, files_failed, status, device_ip)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (dev_id, st, fin, dur, up, by, sk, fa, stat, ip),
        )
        return 1
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
    if is_postgres():
        return execute_read_query(
            "SELECT * FROM sync_sessions WHERE device_id = ? ORDER BY started_at DESC LIMIT ?",
            (device_id, limit),
        )
    return db_get_sync_sessions(device_id, limit)


def clear_sync_sessions(device_id: str) -> bool:
    if is_postgres():
        execute_write("DELETE FROM sync_sessions WHERE device_id = ?", (device_id,))
        return True
    return db_clear_sync_sessions(device_id)


def get_cleanup_candidates(device_id: str, client_files: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return db_get_cleanup_candidates(device_id, client_files)


def log_cleanup_deletions(device_id: str, deleted_files: List[Dict[str, Any]]) -> int:
    return db_log_cleanup_deletions(device_id, deleted_files)


def get_global_stats() -> Dict[str, Any]:
    if is_postgres():
        row = execute_read_one("SELECT COUNT(*) as total_files, COALESCE(SUM(size), 0) as total_size FROM files")
        dev_count = execute_read_one("SELECT COUNT(*) as cnt FROM devices WHERE status = 'accepted'")
        return {
            "total_files": row["total_files"] if row else 0,
            "total_size": row["total_size"] if row else 0,
            "total_devices": dev_count["cnt"] if dev_count else 0,
        }
    return db_get_stats()
