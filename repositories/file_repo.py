"""repositories/file_repo.py — File & Sync Session Repository."""

from __future__ import annotations

import time
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
    now_ms = int(time.time() * 1000)
    dev_id = str(data.get("device_id") or "")
    dev_name = data.get("device_name")
    if not dev_name and dev_id:
        try:
            from repositories import device_repo
            dev_name = device_repo.get_device_display_name(dev_id)
        except Exception:
            dev_name = dev_id

    st = int(data.get("started_at") or now_ms)
    fin = int(data.get("ended_at") or data.get("finished_at") or now_ms)
    dur_sec = float(data.get("duration_sec") or ((data.get("duration_ms") or max(0, fin - st)) / 1000.0))
    dur_ms = int(data.get("duration_ms") or int(dur_sec * 1000))
    up = int(data.get("uploaded") or data.get("files_uploaded") or 0)
    by = int(data.get("bytes_uploaded") or 0)
    sk = int(data.get("skipped") or data.get("files_skipped") or 0)
    fa = int(data.get("errors") or data.get("files_failed") or 0)
    stat = str(data.get("outcome") or data.get("status") or "completed")
    ip = data.get("device_ip")
    tot = int(data.get("total_files") or 0)
    trigger = str(data.get("trigger") or "manual")
    scanned = int(data.get("scanned") or 0)
    checked = int(data.get("checked") or 0)

    if is_postgres():
        execute_write(
            """
            INSERT INTO sync_sessions (
                device_id, device_name, started_at, finished_at, duration_sec, duration_ms,
                files_uploaded, bytes_uploaded, files_skipped, files_failed, status, total_files, device_ip
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (dev_id, dev_name, st, fin, dur_sec, dur_ms, up, by, sk, fa, stat, tot, ip),
        )
        return 1

    return db_insert_sync_session(
        device_id=dev_id,
        device_name=dev_name,
        started_at=st,
        ended_at=fin,
        duration_ms=dur_ms,
        trigger=trigger,
        outcome=stat,
        scanned=scanned,
        checked=checked,
        uploaded=up,
        skipped=sk,
        errors=fa,
        total_files=tot,
    )


def get_sync_sessions(device_id: str | None = None, limit: int = 50, offset: int = 0) -> List[Dict[str, Any]]:
    if is_postgres():
        if device_id:
            rows = execute_read_query(
                """
                SELECT s.*, COALESCE(s.device_name, d.device_name, s.device_id) AS device_name
                FROM sync_sessions s
                LEFT JOIN devices d ON s.device_id = d.device_id
                WHERE s.device_id = ?
                ORDER BY s.started_at DESC LIMIT ? OFFSET ?
                """,
                (device_id, limit, offset),
            )
        else:
            rows = execute_read_query(
                """
                SELECT s.*, COALESCE(s.device_name, d.device_name, s.device_id) AS device_name
                FROM sync_sessions s
                LEFT JOIN devices d ON s.device_id = d.device_id
                ORDER BY s.started_at DESC LIMIT ? OFFSET ?
                """,
                (limit, offset),
            )
        for r in rows:
            r["duration_seconds"] = r.get("duration_sec") if r.get("duration_sec") is not None else ((r.get("duration_ms") or 0) / 1000.0)
            r["file_count"] = r.get("files_uploaded") if r.get("files_uploaded") is not None else (r.get("uploaded") or 0)
            r["uploaded"] = r["file_count"]
            r["total_bytes"] = r.get("bytes_uploaded") or 0
            r["status"] = r.get("status") or r.get("outcome") or "completed"
            r["outcome"] = r["status"]
            r["errors"] = r.get("files_failed") if r.get("files_failed") is not None else (r.get("errors") or 0)
        return rows

    rows = db_get_sync_sessions(device_id, limit, offset)
    for r in rows:
        r["duration_seconds"] = (r.get("duration_ms") or 0) / 1000.0
        r["file_count"] = r.get("uploaded") if r.get("uploaded") is not None else (r.get("files_uploaded") or 0)
        r["files_uploaded"] = r["file_count"]
        r["total_bytes"] = r.get("bytes_uploaded") or 0
        r["status"] = r.get("outcome") or r.get("status") or "completed"
        r["outcome"] = r["status"]
        r["files_failed"] = r.get("errors") or 0
    return rows


def get_sync_sessions_count(device_id: str | None = None) -> int:
    if is_postgres():
        if device_id:
            row = execute_read_one("SELECT COUNT(*) AS c FROM sync_sessions WHERE device_id = ?", (device_id,))
        else:
            row = execute_read_one("SELECT COUNT(*) AS c FROM sync_sessions")
        return int(row["c"]) if row and "c" in row else 0
    from database import get_sync_sessions_count as db_get_sync_sessions_count
    return db_get_sync_sessions_count(device_id)


def clear_sync_sessions(device_id: str | None = None) -> bool:
    if is_postgres():
        if device_id:
            execute_write("DELETE FROM sync_sessions WHERE device_id = ?", (device_id,))
        else:
            execute_write("DELETE FROM sync_sessions")
        return True
    return db_clear_sync_sessions(device_id)


def get_cleanup_candidates(device_id: str) -> List[Dict[str, Any]]:
    if is_postgres():
        rows = execute_read_query(
            "SELECT id, path, size, modified_time FROM files WHERE device_id = ?",
            (device_id,),
        )
        capture_rows = execute_read_query(
            "SELECT relative_path, cap_time AS capture_time FROM media_index WHERE source_type = 'phone' AND source_key = ?",
            (device_id,),
        )
        capture_map = {r["relative_path"]: r["capture_time"] for r in capture_rows}
        candidates = []
        for r in rows:
            candidates.append({
                "id": r["id"],
                "path": r["path"],
                "size": r["size"],
                "modified_time": r["modified_time"],
                "capture_time": capture_map.get(r["path"]),
            })
        return candidates
    return db_get_cleanup_candidates(device_id)


def log_cleanup_deletions(device_id: str, deleted_files: List[Dict[str, Any]]) -> Dict[str, Any]:
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
