"""repositories/device_repo.py — Device Repository."""

from __future__ import annotations

import re
import time
from typing import Any, Dict, List
from repositories.base import execute_read_one, execute_read_query, execute_write, is_postgres
from database import (
    format_device_display_name as db_format_device_display_name,
    get_device_display_name,
    get_devices as db_get_devices,
    get_device_by_id as db_get_device_by_id,
    upsert_device as db_upsert_device,
    remove_device as db_remove_device,
    touch_device as db_touch_device,
    touch_device_and_get_stats as db_touch_device_and_get_stats,
    get_device_stats as db_get_device_stats,
    ensure_device_token as db_ensure_device_token,
    verify_device_token as db_verify_device_token,
    set_device_username as db_set_device_username,
    is_device_known as db_is_device_known,
    get_device_folder_name as db_get_device_folder_name,
    find_device_by_name_model as db_find_device_by_name_model,
    merge_device_id as db_merge_device_id,
)


def format_device_display_name(
    dev: dict | str | None = None,
    device_name: str | None = None,
    device_model: str | None = None,
    *,
    username: str | None = None,
    device_id: str | None = None,
    fallback: str | None = None,
) -> str:
    """Flexible device display name formatter supporting (username, device_name, device_model), (dict), or kwargs."""
    if isinstance(dev, str):
        u = username or dev
        dn = device_name
        dm = device_model
        return db_format_device_display_name(username=u, device_name=dn, device_model=dm, fallback=fallback)
    elif isinstance(dev, dict):
        return db_format_device_display_name(dev, username=username, device_name=device_name, device_model=device_model, device_id=device_id, fallback=fallback)
    else:
        return db_format_device_display_name(username=username, device_name=device_name, device_model=device_model, device_id=device_id, fallback=fallback)


def get_devices() -> List[Dict[str, Any]]:
    if is_postgres():
        return execute_read_query("SELECT * FROM devices ORDER BY last_seen DESC")
    return db_get_devices()


def get_device_by_id(device_id: str) -> Dict[str, Any] | None:
    if is_postgres():
        return execute_read_one("SELECT * FROM devices WHERE device_id = ?", (device_id,))
    return db_get_device_by_id(device_id)


def upsert_device(
    device_name: str,
    device_ip: str,
    device_id: str | None = None,
    device_model: str | None = None,
    username: str | None = None,
) -> None:
    if is_postgres():
        now = int(time.time())
        target_id = device_id or device_ip
        sql = """
        INSERT INTO devices (device_id, device_name, device_ip, status, first_seen, last_seen, device_model, username)
        VALUES (?, ?, ?, 'accepted', ?, ?, ?, ?)
        ON CONFLICT (device_id) DO UPDATE SET
            device_name = EXCLUDED.device_name,
            device_ip = EXCLUDED.device_ip,
            last_seen = EXCLUDED.last_seen,
            device_model = COALESCE(EXCLUDED.device_model, devices.device_model),
            username = COALESCE(EXCLUDED.username, devices.username)
        """
        execute_write(sql, (target_id, device_name, device_ip, now, now, device_model, username))
        return
    db_upsert_device(device_name, device_ip, device_id, device_model, username)


def touch_device_and_get_stats(
    device_ip: str,
    device_id: str | None = None,
    files_delta: int = 0,
    size_delta: int = 0,
) -> Dict[str, Any]:
    if is_postgres():
        now = int(time.time())
        target_id = device_id or device_ip
        execute_write(
            "UPDATE devices SET last_seen = ?, files_backed_up = files_backed_up + ?, total_bytes = total_bytes + ? WHERE device_id = ?",
            (now, files_delta, size_delta, target_id),
        )
        return get_device_stats(device_ip, device_id)
    return db_touch_device_and_get_stats(device_ip, device_id, files_delta, size_delta)


def get_device_stats(device_ip: str, device_id: str | None = None) -> Dict[str, Any]:
    if is_postgres():
        target = device_id or device_ip
        row = execute_read_one(
            "SELECT files_backed_up, total_bytes FROM devices WHERE device_id = ? OR device_ip = ?",
            (target, target),
        )
        if row:
            return {"total_files": row.get("files_backed_up") or 0, "total_size": row.get("total_bytes") or 0}
        return {"total_files": 0, "total_size": 0}
    return db_get_device_stats(device_ip, device_id)


def get_device_folder_name(device_id: str) -> str | None:
    if is_postgres():
        row = execute_read_one("SELECT folder_name, device_name FROM devices WHERE device_id = ?", (device_id,))
        if row:
            return row.get("folder_name") or re.sub(r'[<>:"/\\|?*]', "_", (row.get("device_name") or "device").strip()).strip(". ") or "device"
        return None
    return db_get_device_folder_name(device_id)


def is_device_known(device_ip: str, device_id: str | None = None) -> bool:
    if is_postgres():
        if device_id:
            row = execute_read_one("SELECT id FROM devices WHERE device_id = ?", (device_id,))
            if row:
                return True
        row = execute_read_one("SELECT id FROM devices WHERE device_ip = ?", (device_ip,))
        return row is not None
    return db_is_device_known(device_ip, device_id)


def ensure_device_token(device_id: str) -> str:
    if is_postgres():
        row = execute_read_one("SELECT token FROM devices WHERE device_id = ?", (device_id,))
        if row and row.get("token"):
            return row["token"]
        import secrets
        token = secrets.token_hex(32)
        execute_write("UPDATE devices SET token = ? WHERE device_id = ?", (token, device_id))
        return token
    return db_ensure_device_token(device_id)


def verify_device_token(device_id: str, token: str) -> bool:
    if is_postgres():
        if not device_id or not token:
            return False
        row = execute_read_one("SELECT token FROM devices WHERE device_id = ?", (device_id,))
        return bool(row and row.get("token") == token)
    return db_verify_device_token(device_id, token)


def set_device_username(device_id: str, username: str | None) -> None:
    if is_postgres():
        execute_write("UPDATE devices SET username = ? WHERE device_id = ?", (username, device_id))
        return
    db_set_device_username(device_id, username)


def remove_device(device_id: str) -> bool:
    if is_postgres():
        n = execute_write("DELETE FROM devices WHERE device_id = ?", (device_id,))
        return n > 0
    return db_remove_device(device_id)


def find_device_by_name_model(device_name: str, device_model: str | None) -> Dict[str, Any] | None:
    if is_postgres():
        if device_model:
            return execute_read_one("SELECT * FROM devices WHERE device_name = ? AND device_model = ?", (device_name, device_model))
        return execute_read_one("SELECT * FROM devices WHERE device_name = ?", (device_name,))
    return db_find_device_by_name_model(device_name, device_model)


def merge_device_id(old_device_id: str, new_device_id: str, new_device_ip: str) -> Dict[str, int]:
    if is_postgres():
        execute_write("UPDATE files SET device_id = ? WHERE device_id = ?", (new_device_id, old_device_id))
        execute_write("UPDATE devices SET device_id = ?, device_ip = ? WHERE device_id = ?", (new_device_id, new_device_ip, old_device_id))
        return {"migrated_files": 1}
    return db_merge_device_id(old_device_id, new_device_id, new_device_ip)

