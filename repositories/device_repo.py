"""repositories/device_repo.py — Device Repository."""

from __future__ import annotations

import re
import time
from typing import Any, Dict, List
from repositories.base import execute_read_one, execute_read_query, execute_write
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
    return db_get_devices()


def get_device_by_id(device_id: str) -> Dict[str, Any] | None:
    return db_get_device_by_id(device_id)


def upsert_device(
    device_name: str,
    device_ip: str,
    device_id: str | None = None,
    device_model: str | None = None,
    username: str | None = None,
) -> None:
    db_upsert_device(device_name, device_ip, device_id, device_model, username)


def touch_device_and_get_stats(
    device_ip: str,
    device_id: str | None = None,
    files_delta: int = 0,
    size_delta: int = 0,
) -> Dict[str, Any]:
    return db_touch_device_and_get_stats(device_ip, device_id, files_delta, size_delta)


def get_device_stats(device_ip: str, device_id: str | None = None) -> Dict[str, Any]:
    return db_get_device_stats(device_ip, device_id)


def get_device_folder_name(device_id: str) -> str | None:
    return db_get_device_folder_name(device_id)


def is_device_known(device_ip: str, device_id: str | None = None) -> bool:
    return db_is_device_known(device_ip, device_id)


def ensure_device_token(device_id: str) -> str:
    return db_ensure_device_token(device_id)


def verify_device_token(device_id: str, token: str) -> bool:
    return db_verify_device_token(device_id, token)


def set_device_username(device_id: str, username: str | None) -> None:
    db_set_device_username(device_id, username)


def remove_device(device_id: str) -> bool:
    return db_remove_device(device_id)


def find_device_by_name_model(device_name: str, device_model: str | None) -> Dict[str, Any] | None:
    return db_find_device_by_name_model(device_name, device_model)


def merge_device_id(old_device_id: str, new_device_id: str, new_device_ip: str) -> Dict[str, int]:
    return db_merge_device_id(old_device_id, new_device_id, new_device_ip)
