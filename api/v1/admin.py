"""api/v1/admin.py — Web Admin Panel API Routes.

Provides endpoints for the web admin dashboard:
  - Pending connection approvals:
      GET  /api/pending-connections
      POST /api/pending-connections/resolve
  - Log management:
      GET  /api/logs
      POST /api/logs/clear
  - Config management:
      GET  /api/config
      POST /api/config
  - Sync history:
      GET  /api/sync/history
      POST /api/sync/history/clear
  - Status & System info:
      GET  /api/admin/status
      POST /api/admin/server/restart
  - Server Filesystem Explorer:
      GET  /api/admin/fs/browse
      POST /api/admin/fs/mkdir
      POST /api/admin/fs/open
  - Cache & Memory Maintenance:
      GET  /api/admin/cache/stats
      POST /api/admin/cache/preview/clear
      POST /api/admin/cache/preview/relocate
      POST /api/admin/cache/rewind/clear
      POST /api/admin/cache/thumbnail/clear
      POST /api/admin/memories/reindex
  - Devices Management & File Browser:
      GET    /api/admin/devices
      GET    /api/admin/devices/{device_id}/files
      POST   /api/admin/devices/{device_id}/username
      DELETE /api/admin/devices/{device_id}
  - Shared Folders Management:
      GET    /api/admin/shared-folders
      POST   /api/admin/shared-folders/add
      POST   /api/admin/shared-folders/update
      DELETE /api/admin/shared-folders/{folder_id}
  - Posts Management:
      GET    /api/admin/posts
      GET    /api/admin/posts/{group_id}/targets
      POST   /api/admin/posts/{group_id}/targets
      GET    /api/admin/posts/{group_id}/items
      POST   /api/admin/posts/{group_id}/items/update
      POST   /api/admin/posts/{group_id}/items/upload
      POST   /api/admin/posts/{group_id}/caption
      DELETE /api/admin/posts/{group_id}
      GET    /api/admin/all-posts
      DELETE /api/admin/all-posts/{group_id}

All endpoints require API key auth (Bearer token).
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import string
import subprocess
import time
import uuid
from typing import Any, List, Optional
from urllib.parse import urlencode

from fastapi import APIRouter, File, Header, HTTPException, Query, Response, UploadFile, status
from pydantic import BaseModel

from config import APP_DATA_DIR, SHARED_DIRECT_POST_DIR, load_config, save_config
from core.path_utils import normalize_fs_path
from core.security import verify_api_key_or_device_token
from repositories import device_repo, file_repo, media_repo, social_repo
import memories
import network_info
from state import (
    clear_logs,
    get_logs,
    pending_connections,
    resolve_connection,
)
import rewind
import thumbnail
from version import APP_VERSION
import video_preview
from core.timeutil import format_local_ampm

router = APIRouter(tags=["Admin Panel"])

_SERVER_START_TIME = time.time()


def _auth(authorization: str | None, token: str | None) -> None:
    """Require API key — admin endpoints are privileged, never device-token access."""
    verify_api_key_or_device_token(authorization, token, None, None)


def _fmt_bytes(n: int | float) -> str:
    n = max(0, float(n or 0))
    units = ["B", "KB", "MB", "GB", "TB"]
    i = 0
    while n >= 1024.0 and i < len(units) - 1:
        n /= 1024.0
        i += 1
    return f"{n:.1f} {units[i]}" if i > 0 else f"{int(n)} B"


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

_EDITABLE_KEYS = {
    "HOST", "PORT", "DESKTOP_NAME", "API_KEY", "BACKUP_ROOT",
    "REQUIRE_APPROVAL", "SHARED_DIRS", "VIDEO_PREVIEW_CACHE_DIR",
    "VIDEO_PREVIEW_CACHE_MAX_BYTES", "CORS_ORIGINS", "THEME_MODE",
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
    THEME_MODE: str | None = None


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
    device_id: str | None = None,
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    total_count = await asyncio.to_thread(file_repo.get_sync_sessions_count, device_id or None)
    sessions = await asyncio.to_thread(file_repo.get_sync_sessions, device_id or None, limit, offset)
    has_more = (offset + len(sessions)) < total_count
    return {"sessions": sessions, "has_more": has_more, "total": total_count}


@router.post("/api/sync/history/clear")
async def clear_all_sync_history(
    device_id: str | None = None,
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    await asyncio.to_thread(file_repo.clear_sync_sessions, device_id or None)
    return {"ok": True}


# ── Status & System Info ───────────────────────────────────────────────────────

@router.get("/api/admin/status")
async def get_admin_status(
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    cfg = load_config()
    devices = await asyncio.to_thread(device_repo.get_devices)
    
    total_storage = sum(d.get("total_bytes", 0) or 0 for d in devices)
    total_files = sum(d.get("files_backed_up", 0) or 0 for d in devices)
    active_devices = sum(1 for d in devices if d.get("last_seen") and (time.time() - d["last_seen"]) < 300)
    
    local_ips = network_info.get_all_local_ips()
    tailscale = network_info.get_tailscale_network_info()
    
    uptime_seconds = int(time.time() - _SERVER_START_TIME)

    return {
        "server_version": APP_VERSION,
        "uptime_seconds": uptime_seconds,
        "host": cfg.get("HOST", "0.0.0.0"),
        "port": int(cfg.get("PORT", 8000)),
        "discovery_port": network_info.get_discovery_port(),
        "desktop_name": cfg.get("DESKTOP_NAME", ""),
        "backup_root": cfg.get("BACKUP_ROOT", ""),
        "require_approval": bool(cfg.get("REQUIRE_APPROVAL", True)),
        "all_ips": local_ips,
        "tailscale": tailscale,
        "total_devices": len(devices),
        "active_devices": active_devices,
        "total_storage_bytes": total_storage,
        "total_storage_formatted": _fmt_bytes(total_storage),
        "total_files": total_files,
        "status": "online",
    }


@router.post("/api/admin/server/restart")
async def restart_server(
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    # Config is persisted; in web/docker environment, notify restart is triggered
    return {"ok": True, "message": "Server configuration reloaded."}


# ── Server Filesystem Explorer (Windows Explorer & Server Folder Selector) ─────

def _get_system_roots() -> list[str]:
    roots = []
    if os.name == "nt":
        for letter in string.ascii_uppercase:
            drive = f"{letter}:\\"
            if os.path.exists(drive):
                roots.append(drive)
    else:
        roots.append("/")
        for candidate in ("/host_g", "/host_d", "/host_c", "/backup_storage", "/app_data", "/app", "/storage"):
            if os.path.exists(candidate) and candidate not in roots:
                roots.append(candidate)
            
    cfg_root = load_config().get("BACKUP_ROOT")
    if cfg_root and os.path.exists(cfg_root):
        roots.append(os.path.abspath(cfg_root))
    
    cwd = os.getcwd()
    if cwd and os.path.exists(cwd):
        roots.append(os.path.abspath(cwd))

    user_home = os.path.expanduser("~")
    if user_home and os.path.exists(user_home):
        roots.append(os.path.abspath(user_home))

    # Deduplicate while preserving order
    deduped = []
    for r in roots:
        norm = os.path.normpath(r)
        if norm not in deduped and os.path.exists(norm):
            deduped.append(norm)
    return deduped


@router.get("/api/admin/fs/browse")
async def browse_server_fs(
    path: str | None = None,
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    roots = _get_system_roots()

    if not path or not path.strip():
        # Default to Backup Root if set and exists, otherwise current working directory
        cfg_root = load_config().get("BACKUP_ROOT")
        if cfg_root and os.path.exists(cfg_root):
            path = cfg_root
        elif roots:
            path = roots[0]
        else:
            path = os.getcwd()

    raw_path = path.strip()
    norm_path = normalize_fs_path(raw_path) if not os.path.exists(raw_path) else os.path.abspath(raw_path)
    if not os.path.exists(norm_path):
        norm_path = os.path.abspath(os.path.expandvars(os.path.expanduser(raw_path)))
    if not os.path.exists(norm_path):
        raise HTTPException(status_code=404, detail=f"Path not found: {raw_path}")
    if not os.path.isdir(norm_path):
        raise HTTPException(status_code=400, detail=f"Path is not a directory: {raw_path}")

    dirs = []
    files = []
    try:
        with os.scandir(norm_path) as it:
            for entry in it:
                try:
                    is_dir = entry.is_dir(follow_symlinks=False)
                    st = entry.stat(follow_symlinks=False)
                    mtime = int(st.st_mtime)
                    if is_dir:
                        dirs.append({
                            "name": entry.name,
                            "path": os.path.abspath(entry.path),
                            "is_dir": True,
                            "modified_time": mtime,
                        })
                    else:
                        files.append({
                            "name": entry.name,
                            "path": os.path.abspath(entry.path),
                            "is_dir": False,
                            "size": st.st_size,
                            "formatted_size": _fmt_bytes(st.st_size),
                            "modified_time": mtime,
                        })
                except (PermissionError, OSError):
                    continue
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied to access this directory")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Filesystem error: {exc}")

    dirs.sort(key=lambda x: x["name"].lower())
    files.sort(key=lambda x: x["name"].lower())

    parent_dir = os.path.dirname(norm_path)
    if parent_dir == norm_path:
        parent_dir = None

    return {
        "current_path": norm_path,
        "parent_path": parent_dir,
        "roots": roots,
        "is_windows": os.name == "nt",
        "directories": dirs,
        "files": files,
        "total_dirs": len(dirs),
        "total_files": len(files),
    }


class MakeDirRequest(BaseModel):
    parent_path: str
    folder_name: str


@router.post("/api/admin/fs/mkdir")
async def make_server_directory(
    body: MakeDirRequest,
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    parent = os.path.abspath(os.path.expandvars(os.path.expanduser(body.parent_path.strip())))
    if not os.path.isdir(parent):
        raise HTTPException(status_code=400, detail=f"Parent path does not exist: {parent}")
    name = body.folder_name.strip()
    if not name or "/" in name or "\\" in name:
        raise HTTPException(status_code=400, detail="Invalid folder name")
    target = os.path.join(parent, name)
    try:
        os.makedirs(target, exist_ok=False)
    except FileExistsError:
        raise HTTPException(status_code=409, detail="Folder already exists")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Cannot create folder: {exc}")
    return {"ok": True, "path": target}


class OpenPathRequest(BaseModel):
    path: str


@router.post("/api/admin/fs/open")
async def open_server_path(
    body: OpenPathRequest,
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    target = os.path.abspath(os.path.expandvars(os.path.expanduser(body.path.strip())))
    if not os.path.exists(target):
        raise HTTPException(status_code=404, detail=f"Path not found: {target}")

    opened = False
    if os.name == "nt" and hasattr(os, "startfile"):
        try:
            os.startfile(target)  # type: ignore[attr-defined]
            opened = True
        except Exception:
            pass

    return {
        "ok": True,
        "path": target,
        "is_dir": os.path.isdir(target),
        "opened_in_os": opened,
    }


# ── Cache & Memory Maintenance ────────────────────────────────────────────────

@router.get("/api/admin/cache/stats")
async def get_cache_maintenance_stats(
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    try:
        p_stats = video_preview.get_video_preview_cache_stats()
    except Exception:
        p_stats = {"files": 0, "bytes": 0, "limit_bytes": 0}

    try:
        r_stats = rewind.get_rewind_cache_stats()
    except Exception:
        r_stats = {"files": 0, "bytes": 0}

    try:
        t_stats = thumbnail.get_thumbnail_cache_stats()
    except Exception:
        t_stats = {"files": 0, "bytes": 0}

    try:
        m_stats = memories.get_memory_index_stats()
    except Exception:
        m_stats = {"files": 0, "last_indexed_at": None}

    return {
        "preview_cache": {
            **p_stats,
            "formatted_bytes": _fmt_bytes(p_stats.get("bytes", 0)),
            "formatted_limit": "unlimited" if not p_stats.get("limit_bytes") else _fmt_bytes(p_stats.get("limit_bytes", 0)),
        },
        "rewind_cache": {
            **r_stats,
            "formatted_bytes": _fmt_bytes(r_stats.get("bytes", 0)),
        },
        "thumbnail_cache": {
            **t_stats,
            "formatted_bytes": _fmt_bytes(t_stats.get("bytes", 0)),
        },
        "memory_index": {
            **m_stats,
            "last_indexed_text": format_local_ampm(m_stats.get("last_indexed_at")) or "never",
        },
    }


@router.post("/api/admin/cache/preview/clear")
async def clear_preview_cache(
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    result = await asyncio.to_thread(video_preview.clear_video_preview_cache)
    return {
        "ok": True,
        "files": result.get("files", 0),
        "bytes": result.get("bytes", 0),
        "formatted_bytes": _fmt_bytes(result.get("bytes", 0)),
    }


class RelocateCacheRequest(BaseModel):
    destination: str


@router.post("/api/admin/cache/preview/relocate")
async def relocate_preview_cache(
    body: RelocateCacheRequest,
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    dest = os.path.abspath(os.path.expandvars(os.path.expanduser(body.destination.strip())))
    result = await asyncio.to_thread(video_preview.relocate_video_preview_cache, dest)
    cfg = load_config()
    cfg["VIDEO_PREVIEW_CACHE_DIR"] = dest
    save_config(cfg)
    return {
        "ok": True,
        "destination": dest,
        "moved_files": result.get("moved_files", 0),
        "moved_bytes": result.get("moved_bytes", 0),
        "formatted_bytes": _fmt_bytes(result.get("moved_bytes", 0)),
    }


@router.post("/api/admin/cache/rewind/clear")
async def clear_rewind_cache(
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    result = await asyncio.to_thread(rewind.clear_rewind_cache)
    return {
        "ok": True,
        "files": result.get("files", 0),
        "bytes": result.get("bytes", 0),
        "formatted_bytes": _fmt_bytes(result.get("bytes", 0)),
    }


@router.post("/api/admin/cache/thumbnail/clear")
async def clear_thumbnail_cache(
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    result = await asyncio.to_thread(thumbnail.clear_thumbnail_cache)
    return {
        "ok": True,
        "files": result.get("files", 0),
        "bytes": result.get("bytes", 0),
        "formatted_bytes": _fmt_bytes(result.get("bytes", 0)),
    }


@router.post("/api/admin/memories/reindex")
async def reindex_memory_index(
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    result = await asyncio.to_thread(memories.reset_and_reindex_all, background=True)
    return result


# ── Devices Management & File Browser ──────────────────────────────────────────

@router.get("/api/admin/devices")
async def list_admin_devices(
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    devices = await asyncio.to_thread(device_repo.get_devices)
    cfg_root = load_config().get("BACKUP_ROOT", "")
    
    enriched = []
    for d in devices:
        did = str(d.get("device_id") or "")
        folder_name = d.get("folder_name") or d.get("device_name") or did
        backup_folder = os.path.join(cfg_root, folder_name) if cfg_root else ""
        
        last_seen = d.get("last_seen")
        is_online = bool(last_seen and (time.time() - last_seen) < 300)
        
        display_name = device_repo.format_device_display_name(d)

        enriched.append({
            "id": d.get("id"),
            "device_id": did,
            "device_name": d.get("device_name", ""),
            "device_model": d.get("device_model", ""),
            "username": d.get("username"),
            "display_name": display_name,
            "device_ip": d.get("device_ip", ""),
            "status": d.get("status", "accepted"),
            "is_online": is_online,
            "first_seen": d.get("first_seen"),
            "last_seen": last_seen,
            "total_files": d.get("files_backed_up", 0) or 0,
            "total_size": d.get("total_bytes", 0) or 0,
            "formatted_size": _fmt_bytes(d.get("total_bytes", 0) or 0),
            "folder_name": folder_name,
            "backup_folder": backup_folder,
        })
    return {"devices": enriched}


class RenameDeviceRequest(BaseModel):
    username: str


@router.post("/api/admin/devices/{device_id}/username")
async def rename_device(
    device_id: str,
    body: RenameDeviceRequest,
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    username = body.username.strip()
    await asyncio.to_thread(device_repo.set_device_username, device_id, username if username else None)
    return {"ok": True, "username": username}


@router.delete("/api/admin/devices/{device_id}")
async def delete_device(
    device_id: str,
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    await asyncio.to_thread(device_repo.remove_device, device_id)
    return {"ok": True}


_CATEGORY_EXTS = {
    "photos": (".jpg", ".jpeg", ".png", ".heic", ".webp", ".gif", ".bmp", ".dng", ".tiff"),
    "videos": (".mp4", ".mov", ".avi", ".mkv", ".webm", ".3gp", ".m4v", ".ts"),
    "audio": (".mp3", ".m4a", ".wav", ".aac", ".flac", ".ogg", ".opus", ".wma"),
    "docs": (".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".csv", ".zip", ".rar", ".7z"),
}


@router.get("/api/admin/devices/{device_id}/files")
async def search_device_files(
    device_id: str,
    q: str = "",
    category: str = "all",
    limit: int = 500,
    offset: int = 0,
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    raw_files = await asyncio.to_thread(file_repo.search_files_for_device, device_id, q, category=category, limit=max(1, min(limit * 3, 1000)))
    
    cat_lower = category.lower()
    if cat_lower in _CATEGORY_EXTS:
        allowed = _CATEGORY_EXTS[cat_lower]
        raw_files = [f for f in raw_files if str(f.get("path", "")).lower().endswith(allowed)]

    total = len(raw_files)
    paged = raw_files[offset: offset + limit]

    key = token or (authorization.split(" ", 1)[1] if authorization and " " in authorization else "")
    enriched = []
    for f in paged:
        path = f.get("path", "")
        fname = os.path.basename(path) or path
        ext = os.path.splitext(fname)[1].lower()
        
        file_cat = "other"
        for cat_name, exts in _CATEGORY_EXTS.items():
            if ext in exts:
                file_cat = cat_name
                break

        size = f.get("size", 0) or 0
        mtime = f.get("modified_time", 0) or 0

        encoded_path = path.replace("\\", "/")
        thumb_url = f"/api/files/thumbnail?device_id={device_id}&path={encoded_path}&token={key}" if key else f"/api/files/thumbnail?device_id={device_id}&path={encoded_path}"
        download_url = f"/api/files/download?device_id={device_id}&path={encoded_path}&token={key}" if key else f"/api/files/download?device_id={device_id}&path={encoded_path}"
        preview_url = f"/api/files/preview?device_id={device_id}&path={encoded_path}&token={key}" if key else f"/api/files/preview?device_id={device_id}&path={encoded_path}"

        enriched.append({
            "name": fname,
            "path": path,
            "size": size,
            "formatted_size": _fmt_bytes(size),
            "modified_time": mtime,
            "category": file_cat,
            "thumbnail_url": thumb_url,
            "download_url": download_url,
            "preview_url": preview_url,
        })

    return {
        "files": enriched,
        "total": total,
        "has_more": (offset + limit) < total,
        "device_id": device_id,
    }


# ── Shared Folders Management ──────────────────────────────────────────────────

class GoogleDriveApiKeyRequest(BaseModel):
    api_key: str


@router.get("/api/admin/google-drive/api-key")
async def get_google_drive_api_key(
    response: Response,
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    response.headers["Cache-Control"] = "no-store, private"
    key = str(load_config().get("GOOGLE_DRIVE_API_KEY") or "").strip()
    return {"api_key": key, "configured": bool(key)}


@router.post("/api/admin/google-drive/api-key")
async def save_google_drive_api_key(
    body: GoogleDriveApiKeyRequest,
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    key = body.api_key.strip()
    if not key:
        raise HTTPException(status_code=400, detail="Google Drive API key cannot be empty")
    cfg = load_config()
    cfg["GOOGLE_DRIVE_API_KEY"] = key
    save_config(cfg)
    return {"ok": True, "configured": True}

@router.get("/api/admin/shared-folders")
async def list_admin_shared_folders(
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    cfg = load_config()
    dirs = list(cfg.get("SHARED_DIRS", []))
    cleaned = False
    for d in dirs:
        p = d.get("path", "")
        m = re.search(r'(?:^/app/)([a-zA-Z]:(?:[\\/].*)?)$', p.replace("\\", "/"))
        if m:
            d["path"] = m.group(1).replace("/", "\\")
            cleaned = True
        if d.get("type") == "google_drive" and str(d.get("label") or "").strip().casefold() in ("", "google drive folder"):
            try:
                from core.google_drive import folder_id_from_link, folder_name
                folder_id = d.get("drive_folder_id") or folder_id_from_link(d.get("path", ""))
                actual_name = await asyncio.to_thread(folder_name, folder_id)
                if actual_name and actual_name != d.get("label"):
                    d["label"] = actual_name
                    cleaned = True
            except Exception:
                pass
    if cleaned:
        cfg["SHARED_DIRS"] = dirs
        save_config(cfg)
    return {"shared_dirs": dirs}


class AddSharedFolderRequest(BaseModel):
    path: str
    source_type: str | None = None
    label: str | None = None
    device_ids: list[str] | None = None
    available_in_reels: bool = True


@router.post("/api/admin/shared-folders/add")
async def add_admin_shared_folder(
    body: AddSharedFolderRequest,
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    raw_path = body.path.strip()
    source_type = (body.source_type or "").strip().lower()
    if source_type not in ("", "server", "google_drive"):
        raise HTTPException(status_code=400, detail="Unsupported shared folder source type")
    drive_folder = False
    try:
        from core.google_drive import FOLDER_MIME, GoogleDriveError, folder_id_from_link, get_file, list_children
        # Explicit server paths stay server paths. Retain URL inference only for
        # older clients that do not send source_type.
        drive_folder = source_type == "google_drive" or (
            not source_type and ("/folders/" in raw_path or "drive.google.com" in raw_path)
        )
        if drive_folder:
            folder_id = folder_id_from_link(raw_path)
            metadata = await asyncio.to_thread(get_file, folder_id)
            if metadata.get("mimeType") != FOLDER_MIME:
                raise GoogleDriveError("That link is not a Google Drive folder. Paste a folder link.")
            await asyncio.to_thread(list_children, folder_id)
    except GoogleDriveError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if drive_folder:
        cfg = load_config()
        dirs = list(cfg.get("SHARED_DIRS", []))
        folder_id = folder_id_from_link(raw_path)
        if any(d.get("type") == "google_drive" and (d.get("drive_folder_id") == folder_id or d.get("path") == raw_path) for d in dirs):
            raise HTTPException(status_code=409, detail="This Google Drive folder is already shared")
        requested_label = (body.label or "").strip()
        if not requested_label or requested_label.casefold() == "google drive folder":
            requested_label = str(metadata.get("name") or "Google Drive Folder").strip()
        label = requested_label or "Google Drive Folder"
        entry = {
            "id": f"shared_{int(time.time() * 1000)}",
            "path": raw_path,
            "label": label,
            "type": "google_drive",
            "drive_folder_id": folder_id,
            "device_ids": body.device_ids if body.device_ids is not None else ["all"],
            "available_in_reels": bool(body.available_in_reels),
        }
        dirs.append(entry)
        cfg["SHARED_DIRS"] = dirs
        save_config(cfg)
        return {"ok": True, "entry": entry}

    norm_path = normalize_fs_path(raw_path)
    target = norm_path if (norm_path and os.path.exists(norm_path)) else os.path.abspath(os.path.expandvars(os.path.expanduser(raw_path)))
    if not os.path.exists(target):
        raise HTTPException(status_code=400, detail=f"Directory does not exist: {raw_path}")
    if not os.path.isdir(target):
        raise HTTPException(status_code=400, detail=f"Path is not a directory: {raw_path}")

    # Preserve host Windows drive paths without prepending /app/ in container
    if re.match(r'^[a-zA-Z]:[\\/]', raw_path):
        folder_path = raw_path
    else:
        folder_path = target

    label = body.label.strip() if body.label else os.path.basename(raw_path.rstrip("\\/")) or raw_path
    cfg = load_config()
    dirs = list(cfg.get("SHARED_DIRS", []))
    
    entry_id = f"shared_{int(time.time() * 1000)}"
    new_entry = {
        "id": entry_id,
        "path": folder_path,
        "label": label,
        "device_ids": body.device_ids if body.device_ids is not None else ["all"],
        "available_in_reels": bool(body.available_in_reels),
    }
    dirs.append(new_entry)
    cfg["SHARED_DIRS"] = dirs
    save_config(cfg)
    return {"ok": True, "entry": new_entry}


class UpdateSharedFolderRequest(BaseModel):
    id: str
    path: str | None = None
    label: str | None = None
    device_ids: list[str] | None = None
    available_in_reels: bool | None = None


@router.post("/api/admin/shared-folders/update")
async def update_admin_shared_folder(
    body: UpdateSharedFolderRequest,
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    cfg = load_config()
    dirs = list(cfg.get("SHARED_DIRS", []))
    
    idx = next((i for i, d in enumerate(dirs) if d.get("id") == body.id), None)
    if idx is None:
        raise HTTPException(status_code=404, detail="Shared folder entry not found")
    
    entry = dirs[idx]
    if body.path is not None and body.path.strip():
        raw_path = body.path.strip()
        norm_path = normalize_fs_path(raw_path)
        target = norm_path if (norm_path and os.path.exists(norm_path)) else os.path.abspath(os.path.expandvars(os.path.expanduser(raw_path)))
        if not os.path.exists(target):
            raise HTTPException(status_code=400, detail=f"Directory does not exist: {raw_path}")
        if not os.path.isdir(target):
            raise HTTPException(status_code=400, detail=f"Path is not a directory: {raw_path}")
        if re.match(r'^[a-zA-Z]:[\\/]', raw_path):
            entry["path"] = raw_path
        else:
            entry["path"] = target
    else:
        # Heal any existing accidental /app/ drive prefix
        p = entry.get("path", "")
        m = re.search(r'(?:^/app/)([a-zA-Z]:(?:[\\/].*)?)$', p.replace("\\", "/"))
        if m:
            entry["path"] = m.group(1).replace("/", "\\")

    if body.label is not None and body.label.strip():
        entry["label"] = body.label.strip()
    if body.device_ids is not None:
        entry["device_ids"] = body.device_ids
    if body.available_in_reels is not None:
        entry["available_in_reels"] = bool(body.available_in_reels)

    dirs[idx] = entry
    cfg["SHARED_DIRS"] = dirs
    save_config(cfg)
    return {"ok": True, "entry": entry}


class DeleteSharedFolderRequest(BaseModel):
    id: str


@router.post("/api/admin/shared-folders/delete")
async def delete_admin_shared_folder(
    body: DeleteSharedFolderRequest,
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    cfg = load_config()
    dirs = [d for d in cfg.get("SHARED_DIRS", []) if d.get("id") != body.id]
    cfg["SHARED_DIRS"] = dirs
    save_config(cfg)
    return {"ok": True}


# ── Posts Management (Feed & Direct Posts) ─────────────────────────────────────

@router.get("/api/admin/posts")
async def list_admin_posts(
    q: str = "",
    device_filter: str | None = None,
    offset: int = 0,
    limit: int = 20,
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    key = token or (authorization.split(" ", 1)[1] if authorization and " " in authorization else "")

    rows = await asyncio.to_thread(social_repo.get_device_shares_by_sharer, "desktop-server")
    all_targets = await asyncio.to_thread(social_repo.get_all_share_targets_for_sharer, "desktop-server")

    groups: dict[str, list[dict]] = {}
    order: list[str] = []
    for r in rows:
        gid = r.get("share_group_id") or str(r["share_id"])
        if gid not in groups:
            groups[gid] = []
            order.append(gid)
        groups[gid].append(r)

    post_list = []
    for gid in order:
        items = groups[gid]
        head = items[0]
        targets = all_targets.get(gid, [])
        target_ids = [t.get("target_device_id") for t in targets]
        target_names = [device_repo.format_device_display_name(t) for t in targets]

        caption = head.get("group_caption") or head.get("caption") or ""
        author = head.get("shared_by_name") or "Desktop"
        created_at = head.get("created_at") or 0

        # Filter by text search
        if q:
            q_lower = q.lower()
            if q_lower not in caption.lower() and q_lower not in author.lower() and not any(q_lower in tn.lower() for tn in target_names):
                continue

        # Filter by target device
        if device_filter and device_filter != "all" and device_filter not in target_ids:
            continue

        item_list = []
        for it in items:
            sid = it.get("share_id") or it.get("id")
            rel_path = it.get("relative_path", "")
            fname = os.path.basename(rel_path) or rel_path
            thumb_url = f"/api/share/{sid}/thumbnail?device_id=desktop-server&token={key}" if key else f"/api/share/{sid}/thumbnail?device_id=desktop-server"
            download_url = f"/api/share/{sid}/download?device_id=desktop-server&token={key}" if key else f"/api/share/{sid}/download?device_id=desktop-server"
            preview_url = f"/api/share/{sid}/preview?device_id=desktop-server&token={key}" if key else f"/api/share/{sid}/preview?device_id=desktop-server"

            item_list.append({
                "share_id": sid,
                "name": fname,
                "relative_path": rel_path,
                "source_type": it.get("source_type", "desktop"),
                "source_key": it.get("source_key", "desktop-server"),
                "size": it.get("size", 0) or 0,
                "formatted_size": _fmt_bytes(it.get("size", 0) or 0),
                "modified_time": it.get("modified_time", 0) or 0,
                "thumbnail_url": thumb_url,
                "download_url": download_url,
                "preview_url": preview_url,
            })

        post_list.append({
            "group_id": gid,
            "caption": caption,
            "created_at": created_at,
            "shared_by": author,
            "shared_by_device_id": head.get("shared_by_device_id", "desktop-server"),
            "post_kind": head.get("post_kind", "photo"),
            "target_device_ids": target_ids,
            "target_names": target_names,
            "item_count": len(items),
            "items": item_list,
        })

    total = len(post_list)
    paged = post_list[offset: offset + limit]
    has_more = (offset + limit) < total

    return {
        "posts": paged,
        "total": total,
        "has_more": has_more,
    }


class BulkDeletePostsRequest(BaseModel):
    group_ids: list[str]


@router.post("/api/admin/posts/bulk-delete")
async def bulk_delete_desktop_posts(
    body: BulkDeletePostsRequest,
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    deleted_ids = []
    failed_ids = []
    for group_id in dict.fromkeys(body.group_ids):
        ok = await asyncio.to_thread(social_repo.delete_device_share_group, group_id, "desktop-server")
        (deleted_ids if ok else failed_ids).append(group_id)
    return {"ok": not failed_ids, "deleted_ids": deleted_ids, "failed_ids": failed_ids}


@router.get("/api/admin/all-posts")
async def list_all_admin_posts(
    q: str = "",
    device_filter: str | None = None,
    offset: int = 0,
    limit: int = 20,
    authorization: str = Header(None),
    token: str = Query(None),
):
    """Compact moderation list covering posts created by every device."""
    _auth(authorization, token)
    api_key = token or (authorization.split(" ", 1)[1] if authorization and " " in authorization else "")
    rows = await asyncio.to_thread(social_repo.get_all_device_shares)
    all_targets = await asyncio.to_thread(social_repo.get_all_share_targets)
    groups: dict[str, list[dict]] = {}
    order: list[str] = []
    for row in rows:
        group_id = row.get("share_group_id") or str(row["share_id"])
        if group_id not in groups:
            groups[group_id] = []
            order.append(group_id)
        groups[group_id].append(row)

    posts = []
    author_devices = {}
    search_query = q.strip().lower()
    for group_id in order:
        items = groups[group_id]
        head = items[0]
        device_id = head.get("shared_by_device_id") or "unknown"
        device_name = device_repo.format_device_display_name(
            username=head.get("shared_by_username"),
            device_name=head.get("shared_by_name"),
            device_model=head.get("shared_by_model"),
            device_id=device_id,
            fallback=device_id,
        )
        author = head.get("shared_by_username") or head.get("shared_by_name") or device_id
        caption = head.get("group_caption") or head.get("caption") or ""
        targets = all_targets.get(group_id, [])
        target_names = [device_repo.format_device_display_name(target) for target in targets]
        author_devices[device_id] = device_name
        if search_query and search_query not in caption.lower() and search_query not in author.lower() and search_query not in device_name.lower():
            continue
        if device_filter and device_filter != "all" and device_filter != device_id:
            continue
        item_list = []
        for item in items[:6]:
            share_id = item.get("share_id")
            query_params = {"device_id": device_id}
            if api_key:
                query_params["token"] = api_key
            media_query = urlencode(query_params)
            relative_path = item.get("relative_path", "")
            item_list.append({
                "share_id": share_id,
                "name": os.path.basename(relative_path) or relative_path,
                "thumbnail_url": f"/api/share/{share_id}/thumbnail?{media_query}",
                "download_url": f"/api/share/{share_id}/download?{media_query}",
                "preview_url": f"/api/share/{share_id}/preview?{media_query}",
            })
        posts.append({
            "group_id": group_id,
            "caption": caption,
            "created_at": head.get("created_at") or 0,
            "shared_by": author,
            "device_id": device_id,
            "device_name": device_name,
            "item_count": len(items),
            "target_names": target_names,
            "items": item_list,
        })

    return {
        "posts": posts[offset:offset + limit],
        "total": len(posts),
        "has_more": offset + limit < len(posts),
        "devices": [
            {"device_id": device_id, "display_name": name}
            for device_id, name in sorted(author_devices.items(), key=lambda item: item[1].lower())
        ],
    }


@router.get("/api/admin/all-posts/{group_id}/items")
async def get_all_admin_post_items(
    group_id: str,
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    api_key = token or (authorization.split(" ", 1)[1] if authorization and " " in authorization else "")
    rows = await asyncio.to_thread(social_repo.get_all_device_shares)
    items = [row for row in rows if (row.get("share_group_id") or str(row.get("share_id"))) == group_id]
    if not items:
        raise HTTPException(status_code=404, detail="Post not found")

    device_id = items[0].get("shared_by_device_id") or "unknown"
    query_params = {"device_id": device_id}
    if api_key:
        query_params["token"] = api_key
    media_query = urlencode(query_params)
    enriched = []
    for item in items:
        share_id = item.get("share_id")
        relative_path = item.get("relative_path", "")
        enriched.append({
            "share_id": share_id,
            "name": os.path.basename(relative_path) or relative_path,
            "thumbnail_url": f"/api/share/{share_id}/thumbnail?{media_query}",
            "download_url": f"/api/share/{share_id}/download?{media_query}",
            "preview_url": f"/api/share/{share_id}/preview?{media_query}",
        })
    return {"items": enriched, "total": len(enriched)}


@router.get("/api/admin/posts/{group_id}/targets")
async def get_admin_post_targets(
    group_id: str,
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    targets = await asyncio.to_thread(social_repo.get_share_targets_for_group, group_id, "desktop-server")
    for t in targets:
        t["display_name"] = device_repo.format_device_display_name(t)
    return {"targets": targets}


class UpdateTargetsRequest(BaseModel):
    target_device_ids: list[str]


@router.post("/api/admin/posts/{group_id}/targets")
async def update_admin_post_targets(
    group_id: str,
    body: UpdateTargetsRequest,
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    current_targets = await asyncio.to_thread(social_repo.get_share_targets_for_group, group_id, "desktop-server")
    current_ids = {t["target_device_id"] for t in current_targets}
    new_ids = set(body.target_device_ids)

    # To remove
    to_remove = current_ids - new_ids
    for did in to_remove:
        await asyncio.to_thread(social_repo.remove_share_group_target, group_id, did, "desktop-server")

    # To add
    to_add = new_ids - current_ids
    if to_add:
        await asyncio.to_thread(social_repo.add_share_group_targets, group_id, list(to_add), "desktop-server")

    return {"ok": True}


@router.get("/api/admin/posts/{group_id}/items")
async def get_admin_post_items(
    group_id: str,
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    key = token or (authorization.split(" ", 1)[1] if authorization and " " in authorization else "")
    shares = await asyncio.to_thread(social_repo.get_device_shares_by_sharer, "desktop-server")
    items = [s for s in shares if (s.get("share_group_id") or str(s["share_id"])) == group_id]
    
    enriched = []
    for it in items:
        sid = it.get("share_id") or it.get("id")
        rel_path = it.get("relative_path", "")
        fname = os.path.basename(rel_path) or rel_path
        thumb_url = f"/api/share/{sid}/thumbnail?device_id=desktop-server&token={key}" if key else f"/api/share/{sid}/thumbnail?device_id=desktop-server"
        download_url = f"/api/share/{sid}/download?device_id=desktop-server&token={key}" if key else f"/api/share/{sid}/download?device_id=desktop-server"
        preview_url = f"/api/share/{sid}/preview?device_id=desktop-server&token={key}" if key else f"/api/share/{sid}/preview?device_id=desktop-server"

        enriched.append({
            "share_id": sid,
            "name": fname,
            "relative_path": rel_path,
            "source_type": it.get("source_type", "desktop"),
            "source_key": it.get("source_key", "desktop-server"),
            "size": it.get("size", 0) or 0,
            "formatted_size": _fmt_bytes(it.get("size", 0) or 0),
            "modified_time": it.get("modified_time", 0) or 0,
            "thumbnail_url": thumb_url,
            "download_url": download_url,
            "preview_url": preview_url,
        })
    return {"items": enriched}


class UpdatePostItemsRequest(BaseModel):
    items: list[dict]


@router.post("/api/admin/posts/{group_id}/items/update")
async def update_admin_post_items(
    group_id: str,
    body: UpdatePostItemsRequest,
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    ok = await asyncio.to_thread(social_repo.update_share_group_items, group_id, "desktop-server", body.items)
    if not ok:
        raise HTTPException(status_code=400, detail="Failed to update post items")
    return {"ok": True}


@router.post("/api/admin/posts/{group_id}/items/upload")
async def upload_admin_post_items(
    group_id: str,
    files: list[UploadFile] = File(...),
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    os.makedirs(SHARED_DIRECT_POST_DIR, exist_ok=True)

    # Get existing items
    shares = await asyncio.to_thread(social_repo.get_device_shares_by_sharer, "desktop-server")
    current_items = [
        {
            "source_type": it.get("source_type", "desktop"),
            "source_key": it.get("source_key", "desktop-server"),
            "relative_path": it.get("relative_path", ""),
            "size": int(it.get("size") or 0),
            "modified_time": int(it.get("modified_time") or 0),
        }
        for it in shares if (it.get("share_group_id") or str(it["share_id"])) == group_id
    ]

    new_items = list(current_items)
    for f in files:
        ext = os.path.splitext(f.filename or "")[1].lower()
        unique_name = f"{uuid.uuid4().hex}{ext}"
        dest_path = os.path.join(SHARED_DIRECT_POST_DIR, unique_name)
        with open(dest_path, "wb") as out:
            shutil.copyfileobj(f.file, out)
        
        file_size = os.path.getsize(dest_path)
        new_items.append({
            "source_type": "desktop",
            "source_key": "desktop-server",
            "relative_path": dest_path,
            "size": file_size,
            "modified_time": int(time.time()),
        })

    ok = await asyncio.to_thread(social_repo.update_share_group_items, group_id, "desktop-server", new_items)
    if not ok:
        raise HTTPException(status_code=400, detail="Failed to save uploaded files to post")
    return {"ok": True, "total_items": len(new_items)}


class EditCaptionRequest(BaseModel):
    caption: str | None = None


@router.post("/api/admin/posts/{group_id}/caption")
async def edit_admin_post_caption(
    group_id: str,
    body: EditCaptionRequest,
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    caption = (body.caption or "").strip() or None
    ok = await asyncio.to_thread(social_repo.edit_device_share_group_caption, group_id, "desktop-server", caption)
    if not ok:
        raise HTTPException(status_code=400, detail="Failed to edit caption")
    return {"ok": True, "caption": caption}


@router.delete("/api/admin/posts/{group_id}")
async def delete_admin_post_group(
    group_id: str,
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    ok = await asyncio.to_thread(social_repo.delete_device_share_group, group_id, "desktop-server")
    if not ok:
        raise HTTPException(status_code=400, detail="Failed to delete post")
    return {"ok": True}


@router.delete("/api/admin/all-posts/{group_id}")
async def delete_any_admin_post(
    group_id: str,
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    rows = await asyncio.to_thread(social_repo.get_all_device_shares)
    matching = [r for r in rows if (r.get("share_group_id") or str(r.get("share_id"))) == group_id]
    if not matching:
        raise HTTPException(status_code=404, detail="Post not found")
    owner = matching[0].get("shared_by_device_id")
    actual_group_id = matching[0].get("share_group_id")
    if actual_group_id:
        ok = await asyncio.to_thread(social_repo.delete_device_share_group, actual_group_id, owner)
    else:
        ok = await asyncio.to_thread(social_repo.delete_device_share, matching[0]["share_id"], owner)
    if not ok:
        raise HTTPException(status_code=404, detail="Post was already deleted")
    return {"ok": True}


@router.post("/api/admin/all-posts/bulk-delete")
async def bulk_delete_any_admin_posts(
    body: BulkDeletePostsRequest,
    authorization: str = Header(None),
    token: str = Query(None),
):
    _auth(authorization, token)
    rows = await asyncio.to_thread(social_repo.get_all_device_shares)
    posts_by_id: dict[str, list[dict]] = {}
    for row in rows:
        group_id = row.get("share_group_id") or str(row.get("share_id"))
        posts_by_id.setdefault(group_id, []).append(row)

    deleted_ids = []
    failed_ids = []
    for group_id in dict.fromkeys(body.group_ids):
        matching = posts_by_id.get(group_id, [])
        if not matching:
            failed_ids.append(group_id)
            continue
        owner = matching[0].get("shared_by_device_id")
        actual_group_id = matching[0].get("share_group_id")
        if actual_group_id:
            ok = await asyncio.to_thread(social_repo.delete_device_share_group, actual_group_id, owner)
        else:
            ok = await asyncio.to_thread(social_repo.delete_device_share, matching[0]["share_id"], owner)
        (deleted_ids if ok else failed_ids).append(group_id)
    return {"ok": not failed_ids, "deleted_ids": deleted_ids, "failed_ids": failed_ids}
