"""
state.py — Shared in-memory state between the FastAPI server and the desktop GUI.

The GUI (tkinter thread) and the API (asyncio thread) communicate via:
  • pending_connections  – dict of connection-approval requests awaiting user action
  • resolve_connection() – called by tkinter to accept/reject a pending request
  • add_log / get_logs   – ring buffer of recent activity messages

When Redis is available (Docker), activity and logs are also mirrored there so
the isolated sync-api and app-api containers share the same operator-visible
status. Desktop/SQLite without Redis keeps the previous process-local behavior.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from typing import Any

logger = logging.getLogger("backup_server.state")

# ─── Connection approval ──────────────────────────────────────────────────────
# Keyed by a UUID request ID.
# Each entry: {'name': str, 'ip': str, 'future': asyncio.Future, 'loop': asyncio.AbstractEventLoop, '_shown': bool}
pending_connections: dict[str, dict[str, Any]] = {}

_REDIS_ACTIVITY_HASH = "backup:activity:map"
_REDIS_LOGS_LIST = "backup:activity:logs"
_ACTIVITY_TTL_SEC = 15 * 60


def resolve_connection(req_id: str, accepted: bool) -> None:
    """Called from the tkinter thread to resolve a pending connection request."""
    entry = pending_connections.pop(req_id, None)
    if entry is None:
        return
    future = entry["future"]
    loop = entry["loop"]
    # Safely set the future result from a non-async thread
    loop.call_soon_threadsafe(
        lambda f=future, a=accepted: f.set_result(a) if not f.done() else None
    )


# ─── Activity log ─────────────────────────────────────────────────────────────
_LOG_LIMIT = 200
_logs: list[dict] = []
_logs_lock = threading.Lock()

_activity_lock = threading.Lock()
_active_activities: dict[str, dict[str, Any]] = {}

_device_name_cache: dict[str, str] = {}
_device_name_cache_lock = threading.Lock()
_last_cache_refresh = 0.0


def _redis():
    """Best-effort Redis client; never raises into request handlers."""
    try:
        from services.redis_service import get_redis_client
        return get_redis_client()
    except Exception:
        return None


def update_device_display_name_cache(
    mapping: dict[str, str] | None = None,
    identifier: str | None = None,
    name: str | None = None,
) -> None:
    """Update in-memory device display name cache for fast log resolution."""
    with _device_name_cache_lock:
        if mapping:
            _device_name_cache.update(mapping)
        if identifier and name:
            _device_name_cache[identifier] = name


def _resolve_device_names_in_message(msg: str) -> str:
    """Safely replace raw device IDs/IPs in log messages with human-readable display names."""
    if not msg or not isinstance(msg, str):
        return msg

    global _last_cache_refresh
    now = time.time()
    with _device_name_cache_lock:
        should_refresh = (now - _last_cache_refresh > 5.0) or not _device_name_cache

    if should_refresh:
        try:
            from database import format_device_display_name, get_devices
            devs = get_devices()
            new_cache = {}
            for d in devs:
                did = str(d.get("device_id") or "").strip()
                dip = str(d.get("device_ip") or "").strip()
                dname = format_device_display_name(d)
                if did:
                    new_cache[did] = dname
                if dip and dip != "127.0.0.1":
                    new_cache[dip] = dname
            with _device_name_cache_lock:
                _device_name_cache.update(new_cache)
                _last_cache_refresh = now
        except Exception:
            pass

    with _device_name_cache_lock:
        cache = dict(_device_name_cache)

    if not cache:
        return msg

    result = msg
    for raw_id, display_name in sorted(cache.items(), key=lambda x: len(x[0]), reverse=True):
        if not raw_id or raw_id == display_name:
            continue
        if raw_id in result:
            result = result.replace(f"for source {raw_id}", f"for {display_name}")
            result = result.replace(f"source {raw_id}", display_name)
            result = result.replace(raw_id, display_name)

    return result


def add_log(message: str) -> None:
    resolved = _resolve_device_names_in_message(message)
    entry = {"time": int(time.time()), "message": resolved}
    with _logs_lock:
        _logs.append(entry)
        del _logs[:-_LOG_LIMIT]

    client = _redis()
    if not client:
        return
    try:
        pipe = client.pipeline()
        pipe.rpush(_REDIS_LOGS_LIST, json.dumps(entry, separators=(",", ":")))
        pipe.ltrim(_REDIS_LOGS_LIST, -_LOG_LIMIT, -1)
        pipe.execute()
    except Exception as exc:
        logger.debug("Redis activity log mirror failed: %s", exc)


def get_logs() -> list[dict]:
    client = _redis()
    if client:
        try:
            raw_items = client.lrange(_REDIS_LOGS_LIST, 0, -1)
            if raw_items:
                parsed: list[dict] = []
                for raw in raw_items:
                    try:
                        item = json.loads(raw)
                    except Exception:
                        continue
                    if isinstance(item, dict) and "message" in item:
                        parsed.append(item)
                if parsed:
                    return parsed
        except Exception as exc:
            logger.debug("Redis activity log read failed: %s", exc)

    with _logs_lock:
        return list(_logs)


def clear_logs() -> None:
    with _logs_lock:
        _logs.clear()
    client = _redis()
    if not client:
        return
    try:
        client.delete(_REDIS_LOGS_LIST)
    except Exception as exc:
        logger.debug("Redis activity log clear failed: %s", exc)


def set_current_activity(
    message: str | None,
    device_ip: str | None = None,
    device_id: str | None = None,
) -> None:
    key = device_id or device_ip or "default"
    payload = None
    with _activity_lock:
        if message:
            payload = {
                "time": int(time.time()),
                "message": message,
                "device_ip": device_ip,
                "device_id": device_id,
            }
            _active_activities[key] = payload
        else:
            _active_activities.pop(key, None)

    client = _redis()
    if not client:
        return
    try:
        if payload is not None:
            client.hset(_REDIS_ACTIVITY_HASH, key, json.dumps(payload, separators=(",", ":")))
        else:
            client.hdel(_REDIS_ACTIVITY_HASH, key)
    except Exception as exc:
        logger.debug("Redis activity mirror failed: %s", exc)


def _merged_activities() -> list[dict[str, Any]]:
    """Combine local + Redis activities, dropping stale Redis entries."""
    merged: dict[str, dict[str, Any]] = {}
    now = int(time.time())

    with _activity_lock:
        for key, value in _active_activities.items():
            merged[key] = dict(value)

    client = _redis()
    if client:
        try:
            remote = client.hgetall(_REDIS_ACTIVITY_HASH) or {}
            stale_fields: list[str] = []
            for field, raw in remote.items():
                key = str(field)
                try:
                    data = json.loads(raw)
                except Exception:
                    stale_fields.append(key)
                    continue
                if not isinstance(data, dict):
                    stale_fields.append(key)
                    continue
                age = now - int(data.get("time") or 0)
                if age > _ACTIVITY_TTL_SEC:
                    stale_fields.append(key)
                    continue
                existing = merged.get(key)
                if existing is None or int(data.get("time") or 0) >= int(existing.get("time") or 0):
                    merged[key] = data
            if stale_fields:
                client.hdel(_REDIS_ACTIVITY_HASH, *stale_fields)
        except Exception as exc:
            logger.debug("Redis activity read failed: %s", exc)

    return list(merged.values())


def get_current_activity() -> dict[str, Any] | None:
    activities = _merged_activities()
    if not activities:
        return None
    latest = max(activities, key=lambda a: a.get("time", 0))
    res = dict(latest)
    if len(activities) > 1:
        res["active_devices_count"] = len(activities)
    return res


def get_all_active_activities() -> list[dict[str, Any]]:
    return _merged_activities()
