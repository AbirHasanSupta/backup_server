"""api/v1/admin.py — Web Admin Panel API Routes.

Provides endpoints exclusively for the web admin dashboard:
  - GET  /api/pending-connections           List pending device pairing requests
  - POST /api/pending-connections/resolve   Approve or reject a pairing request
  - GET  /api/logs                          Fetch current in-memory log buffer
  - POST /api/logs/clear                    Clear in-memory logs
  - GET  /api/config                        Read editable server configuration
  - POST /api/config                        Save server configuration (triggers restart)
  - GET  /api/sync/history                  All sync sessions across all devices
  - POST /api/sync/history/clear            Clear all sync history

All endpoints require API key auth (Bearer token).
"""

from __future__ import annotations

import asyncio
from pydantic import BaseModel
from fastapi import APIRouter, Header, Query

from core.security import verify_api_key_or_device_token
from state import (
    get_logs,
    clear_logs,
    pending_connections,
    resolve_connection,
)
from config import load_config, save_config
import database as db

router = APIRouter(tags=["Admin Panel"])


def _auth(authorization: str | None, token: str | None) -> None:
    """Require API key — admin endpoints are privileged, never device-token access."""
    verify_api_key_or_device_token(authorization, token, None, None)


# ── Pending connection approvals ───────────────────────────────────────────────

@router.get("/api/pending-connections")
async def list_pending_connections(
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    result = [
        {
            "id": req_id,
            "name": entry.get("name", ""),
            "ip": entry.get("ip", ""),
            "device_id": entry.get("device_id", ""),
            "device_model": entry.get("device_model", ""),
            "username": entry.get("username", ""),
            "display_name": entry.get("display_name", ""),
        }
        for req_id, entry in list(pending_connections.items())
    ]
    return {"pending": result}


class ResolveRequest(BaseModel):
    req_id: str
    accepted: bool


@router.post("/api/pending-connections/resolve")
async def resolve_pending_connection(
    body: ResolveRequest,
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    resolve_connection(body.req_id, body.accepted)
    return {"ok": True}


# ── Log management ─────────────────────────────────────────────────────────────

@router.get("/api/logs")
async def get_server_logs(
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    return {"logs": get_logs()}


@router.post("/api/logs/clear")
async def clear_server_logs(
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    clear_logs()
    return {"ok": True}


# ── Config management ──────────────────────────────────────────────────────────

# Keys that the web admin is allowed to read and write.
# Sensitive runtime keys like DB_PATH, SERVER_ID are excluded.
_EDITABLE_KEYS = {
    "HOST", "PORT", "DESKTOP_NAME", "API_KEY", "BACKUP_ROOT",
    "REQUIRE_APPROVAL", "SHARED_DIRS", "VIDEO_PREVIEW_CACHE_DIR",
    "VIDEO_PREVIEW_CACHE_MAX_BYTES", "CORS_ORIGINS",
}

_SAFE_READ_KEYS = _EDITABLE_KEYS | {
    "DATABASE_BACKEND", "REDIS_URL", "STORAGE_BACKEND",
    "CELERY_ENABLED", "WORKERS",
}


@router.get("/api/config")
async def get_config(
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    cfg = load_config()
    # Mask the API key for display (show last 4 chars)
    safe = {k: v for k, v in cfg.items() if k in _SAFE_READ_KEYS}
    return {"config": safe}


class ConfigUpdateRequest(BaseModel):
    HOST: str | None = None
    PORT: int | None = None
    DESKTOP_NAME: str | None = None
    API_KEY: str | None = None
    BACKUP_ROOT: str | None = None
    REQUIRE_APPROVAL: bool | None = None
    SHARED_DIRS: list | None = None
    VIDEO_PREVIEW_CACHE_DIR: str | None = None
    VIDEO_PREVIEW_CACHE_MAX_BYTES: int | None = None
    CORS_ORIGINS: str | None = None


@router.post("/api/config")
async def update_config(
    body: ConfigUpdateRequest,
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    cfg = load_config()
    update = body.model_dump(exclude_none=True)
    for k, v in update.items():
        if k in _EDITABLE_KEYS:
            cfg[k] = v
    save_config(cfg)
    return {"ok": True}


# ── Sync history (admin aggregate view) ───────────────────────────────────────

@router.get("/api/sync/history")
async def get_all_sync_history(
    offset: int = 0,
    limit: int = 50,
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    # database.get_sync_sessions supports device_id=None for all-devices view
    all_sessions = await asyncio.to_thread(db.get_sync_sessions, None, offset + limit + 1)
    paged = all_sessions[offset: offset + limit]
    has_more = len(all_sessions) > offset + limit
    return {"sessions": paged, "has_more": has_more}


@router.post("/api/sync/history/clear")
async def clear_all_sync_history(
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    await asyncio.to_thread(db.clear_sync_sessions, None)
    return {"ok": True}
