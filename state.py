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


def add_log(message: str) -> None:
    with _logs_lock:
        _logs.append({"time": int(time.time()), "message": message})
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