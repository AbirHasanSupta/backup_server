"""
state.py — Shared in-memory state between the FastAPI server and the desktop GUI.

The GUI (tkinter thread) and the API (asyncio thread) communicate via:
  • pending_connections  – dict of connection-approval requests awaiting user action
  • resolve_connection() – called by tkinter to accept/reject a pending request
  • add_log / get_logs   – ring buffer of recent activity messages
"""

from __future__ import annotations

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


def add_log(message: str) -> None:
    global _logs
    _logs.append({"time": int(time.time()), "message": message})
    if len(_logs) > _LOG_LIMIT:
        _logs = _logs[-_LOG_LIMIT:]


def get_logs() -> list[dict]:
    return list(_logs)


def clear_logs() -> None:
    global _logs
    _logs = []
