"""
state.py — Shared in-memory state between the FastAPI server and the desktop GUI.

The GUI (tkinter thread) and the API (asyncio thread) communicate via:
  • pending_connections  – dict of connection-approval requests awaiting user action
  • resolve_connection() – called by tkinter to accept/reject a pending request
  • add_log / get_logs   – ring buffer of recent activity messages
"""

from __future__ import annotations

import threading
import time
from typing import Any

# ─── Connection approval ──────────────────────────────────────────────────────
# Keyed by a UUID request ID.
# Each entry: {'name': str, 'ip': str, 'future': asyncio.Future, 'loop': asyncio.AbstractEventLoop, '_shown': bool}
pending_connections: dict[str, dict[str, Any]] = {}


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
    with _logs_lock:
        _logs.append({"time": int(time.time()), "message": resolved})
        del _logs[:-_LOG_LIMIT]



def get_logs() -> list[dict]:
    with _logs_lock:
        return list(_logs)


def clear_logs() -> None:
    with _logs_lock:
        _logs.clear()


def set_current_activity(
    message: str | None,
    device_ip: str | None = None,
    device_id: str | None = None,
) -> None:
    key = device_id or device_ip or "default"
    with _activity_lock:
        if message:
            _active_activities[key] = {
                "time": int(time.time()),
                "message": message,
                "device_ip": device_ip,
                "device_id": device_id,
            }
        else:
            _active_activities.pop(key, None)


def get_current_activity() -> dict[str, Any] | None:
    with _activity_lock:
        if not _active_activities:
            return None
        # Return the most recent activity
        latest = max(_active_activities.values(), key=lambda a: a.get("time", 0))
        active_count = len(_active_activities)
        res = dict(latest)
        if active_count > 1:
            res["active_devices_count"] = active_count
        return res


def get_all_active_activities() -> list[dict[str, Any]]:
    with _activity_lock:
        return [dict(a) for a in _active_activities.values()]