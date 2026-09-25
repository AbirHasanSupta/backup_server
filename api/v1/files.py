"""api/v1/files.py — Library Browsing, Search, Download, Preview & Thumbnail Router."""

from __future__ import annotations

import asyncio
import os
import time
from pydantic import BaseModel
from fastapi import APIRouter, Header, HTTPException, Query, Request, status
from fastapi.responses import FileResponse

from core.config import get_shared_dirs
from core.path_utils import normalize_fs_path
from core.security import verify_api_key_or_device_token
from repositories import device_repo, file_repo, social_repo
from services.preview_service import preview_service
from services.thumbnail_service import thumbnail_service
from storage.manager import get_storage
from video_preview import arm_active_video_preview

router = APIRouter(tags=["Files & Library"])

# ── In-memory cache for browse_shared_files ─────────────────────────────────
# Keyed by (source_id, norm_prefix). Value: (result_dict, cached_at, dir_mtime)
# TTL: 10 s; also invalidated when the directory mtime changes.
_BROWSE_SHARED_CACHE: dict[tuple[str, str], tuple[dict, float, float]] = {}
_BROWSE_SHARED_TTL = 10.0  # seconds


class WarmPreviewsRequest(BaseModel):
    paths: list[str]
    device_id: str | None = None


def _find_shared_dir(source_id: str) -> dict | None:
    for entry in get_shared_dirs():
        if entry.get("id") == source_id:
            return entry
    return None


def _is_folder_tagged_for_device(entry: dict, device_id: str | None) -> bool:
    if not device_id:
        return True
    tags = entry.get("device_ids", ["all"])
    return not tags or "all" in tags or device_id in tags


@router.get("/files/list")
@router.get("/api/files/list")
async def list_files(
    device_id: str,
    prefix: str = "",
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    files = file_repo.get_files_for_device(device_id, prefix)
    return {"device_id": device_id, "files": files}


@router.get("/files/browse")
@router.get("/api/files/browse")
async def browse_files(
    device_id: str,
    prefix: str = "",
    folder_path: str = "",
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    norm_prefix = (prefix or folder_path).strip("/")
    norm_prefix = f"{norm_prefix}/" if norm_prefix else ""
    folders, files = await asyncio.to_thread(file_repo.get_files_browse, device_id, norm_prefix)
    return {"folders": folders, "files": files}


@router.get("/api/files/search")
@router.get("/files/search")
async def search_files(
    device_id: str,
    q: str = "",
    category: str = "all",
    limit: int = 100,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    files = file_repo.search_files_for_device(device_id, q, category, limit)
    return {"device_id": device_id, "query": q, "files": files}


@router.get("/api/files/download")
@router.get("/files/download")
async def download_file(
    request: Request,
    path: str | None = None,
    relative_path: str | None = None,
    device_id: str | None = None,
    authorization: str = Header(None),
    token: str = Query(None),
):
    target_path = relative_path or path
    if not target_path:
        raise HTTPException(status_code=400, detail="Missing path or relative_path parameter")
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    storage = get_storage()
    full_path = storage.get_file_path(target_path, device_id=device_id)
    return preview_service.stream_file_range(full_path, request)


@router.get("/api/files/preview")
@router.get("/files/preview")
async def preview_file(
    request: Request,
    path: str | None = None,
    relative_path: str | None = None,
    device_id: str | None = None,
    authorization: str = Header(None),
    token: str = Query(None),
):
    target_path = relative_path or path
    if not target_path:
        raise HTTPException(status_code=400, detail="Missing path or relative_path parameter")
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    storage = get_storage()
    full_path = storage.get_file_path(target_path, device_id=device_id)

    if not preview_service.is_video(full_path):
        raise HTTPException(status_code=400, detail="Preview is only available for video files")

    cached_preview = preview_service.get_preview_path(full_path, schedule_missing=True)
    cache_ctrl = "public, max-age=604800, immutable" if cached_preview != full_path else "private, max-age=86400"
    return preview_service.stream_file_range(cached_preview, request, cache_control=cache_ctrl)


@router.get("/api/files/thumbnail")
@router.get("/files/thumbnail")
async def get_thumbnail(
    path: str | None = None,
    relative_path: str | None = None,
    device_id: str | None = None,
    authorization: str = Header(None),
    token: str = Query(None),
):
    target_path = relative_path or path
    if not target_path:
        raise HTTPException(status_code=400, detail="Missing path or relative_path parameter")
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    storage = get_storage()
    full_path = storage.get_file_path(target_path, device_id=device_id)
    return thumbnail_service.get_thumbnail_response(full_path)


@router.post("/api/files/warm_previews")
@router.post("/files/warm_previews")
async def warm_previews(
    body: WarmPreviewsRequest,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, body.device_id, device_repo.verify_device_token)
    storage = get_storage()
    for rel_path in body.paths[:3]:
        try:
            full_path = storage.get_file_path(rel_path, device_id=body.device_id)
            if preview_service.is_video(full_path):
                arm_active_video_preview(body.device_id or "device", full_path)
                preview_service.get_preview_path(full_path, schedule_missing=True)
        except Exception:
            pass
    return {"ok": True}


# Shared Folders endpoints
@router.get("/api/shared/{source_id}/files")
@router.get("/shared/{source_id}/files")
async def list_shared_files(
    source_id: str,
    prefix: str = "",
    device_id: str | None = None,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    entry = _find_shared_dir(source_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Shared source not found")
    if not _is_folder_tagged_for_device(entry, device_id):
        raise HTTPException(status_code=403, detail="Shared source not tagged for this device")

    root = os.path.abspath(normalize_fs_path(entry["path"]))
    if not os.path.isdir(root):
        return {"files": [], "warning": "Directory does not exist on server"}

    norm_prefix = prefix.strip("/").replace("\\", "/")
    target_dir = os.path.join(root, norm_prefix) if norm_prefix else root
    target_dir = os.path.abspath(target_dir)
    if os.path.commonpath([root, target_dir]) != root:
        raise HTTPException(status_code=400, detail="Invalid path")
    if not os.path.isdir(target_dir):
        return {"files": [], "source_id": source_id, "label": entry.get("label")}

    def _walk():
        files = []
        for dirpath, _, filenames in os.walk(target_dir):
            for fname in filenames:
                full = os.path.join(dirpath, fname)
                try:
                    stat = os.stat(full)
                    rel = os.path.relpath(full, root).replace("\\", "/")
                    files.append({
                        "path": rel,
                        "size": stat.st_size,
                        "modified_time": int(stat.st_mtime),
                    })
                except OSError:
                    continue
        return files

    files = await asyncio.to_thread(_walk)
    return {"files": files, "source_id": source_id, "label": entry.get("label")}


@router.get("/shared/{source_id}/search")
@router.get("/api/shared/{source_id}/search")
async def search_shared_files(
    source_id: str,
    q: str,
    device_id: str | None = None,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    entry = _find_shared_dir(source_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Shared source not found")
    if not _is_folder_tagged_for_device(entry, device_id):
        raise HTTPException(status_code=403, detail="Shared source not tagged for this device")
    q = q.strip().lower()
    if not q:
        return {"files": []}
    root = os.path.abspath(normalize_fs_path(entry["path"]))
    if not os.path.isdir(root):
        return {"files": []}

    def _search():
        matched = []
        for dirpath, _, filenames in os.walk(root):
            for fname in filenames:
                if q in fname.lower():
                    full = os.path.join(dirpath, fname)
                    try:
                        stat = os.stat(full)
                        rel = os.path.relpath(full, root).replace("\\", "/")
                        matched.append({
                            "path": rel,
                            "size": stat.st_size,
                            "modified_time": int(stat.st_mtime),
                        })
                    except OSError:
                        pass
        return matched

    files = await asyncio.to_thread(_search)
    return {"files": files}


@router.get("/shared/{source_id}/browse")
@router.get("/api/shared/{source_id}/browse")
async def browse_shared_files(
    source_id: str,
    prefix: str = "",
    device_id: str | None = None,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    entry = _find_shared_dir(source_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Shared source not found")
    if not _is_folder_tagged_for_device(entry, device_id):
        raise HTTPException(status_code=403, detail="Shared source not tagged for this device")

    root = os.path.abspath(normalize_fs_path(entry["path"]))
    norm_prefix = prefix.strip("/").replace("\\", "/")
    target_dir = os.path.join(root, norm_prefix) if norm_prefix else root
    target_dir = os.path.abspath(target_dir)
    if os.path.commonpath([root, target_dir]) != root:
        raise HTTPException(status_code=400, detail="Invalid path")
    if not os.path.isdir(target_dir):
        return {"folders": [], "files": []}

    def _scan_with_cache() -> dict:
        cache_key = (source_id, norm_prefix)
        now = time.monotonic()
        try:
            dir_mtime = os.stat(target_dir).st_mtime
        except OSError:
            dir_mtime = 0.0

        cached = _BROWSE_SHARED_CACHE.get(cache_key)
        if cached:
            result, cached_at, cached_mtime = cached
            if (now - cached_at) < _BROWSE_SHARED_TTL and cached_mtime == dir_mtime:
                return result

        folders = []
        files = []
        for e in os.scandir(target_dir):
            try:
                rel = f"{norm_prefix}/{e.name}" if norm_prefix else e.name
                if e.is_dir(follow_symlinks=False):
                    folders.append({"name": e.name, "path": rel})
                elif e.is_file(follow_symlinks=False):
                    st = e.stat()
                    files.append({"name": e.name, "path": rel, "size": st.st_size, "modified_time": int(st.st_mtime)})
            except OSError:
                pass
        result = {"folders": folders, "files": files}
        _BROWSE_SHARED_CACHE[cache_key] = (result, now, dir_mtime)
        return result

    return await asyncio.to_thread(_scan_with_cache)


@router.get("/api/shared/{source_id}/download")
@router.get("/shared/{source_id}/download")
async def download_shared_file(
    source_id: str,
    relative_path: str,
    request: Request,
    device_id: str | None = None,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    entry = _find_shared_dir(source_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Shared source not found")
    if not _is_folder_tagged_for_device(entry, device_id):
        raise HTTPException(status_code=403, detail="Shared source not tagged for this device")

    root = os.path.abspath(normalize_fs_path(entry["path"]))
    safe_rel = os.path.normpath(relative_path.replace("\\", "/"))
    full_path = os.path.abspath(os.path.join(root, safe_rel))
    if os.path.commonpath([root, full_path]) != root or not os.path.isfile(full_path):
        raise HTTPException(status_code=404, detail="File not found")
    return preview_service.stream_file_range(full_path, request)


@router.get("/api/shared/{source_id}/preview")
@router.get("/shared/{source_id}/preview")
async def preview_shared_file(
    source_id: str,
    relative_path: str,
    request: Request,
    device_id: str | None = None,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    entry = _find_shared_dir(source_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Shared source not found")
    if not _is_folder_tagged_for_device(entry, device_id):
        raise HTTPException(status_code=403, detail="Shared source not tagged for this device")

    root = os.path.abspath(normalize_fs_path(entry["path"]))
    safe_rel = os.path.normpath(relative_path.replace("\\", "/"))
    full_path = os.path.abspath(os.path.join(root, safe_rel))
    if os.path.commonpath([root, full_path]) != root or not os.path.isfile(full_path):
        raise HTTPException(status_code=404, detail="File not found")
    if not preview_service.is_video(full_path):
        raise HTTPException(status_code=400, detail="Preview is only available for video files")

    cached = preview_service.get_preview_path(full_path, schedule_missing=True)
    cache_ctrl = "public, max-age=604800, immutable" if cached != full_path else "private, max-age=86400"
    return preview_service.stream_file_range(cached, request, cache_control=cache_ctrl)


@router.get("/api/shared/{source_id}/thumbnail")
@router.get("/shared/{source_id}/thumbnail")
async def thumbnail_shared_file(
    source_id: str,
    relative_path: str,
    device_id: str | None = None,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    entry = _find_shared_dir(source_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Shared source not found")
    if not _is_folder_tagged_for_device(entry, device_id):
        raise HTTPException(status_code=403, detail="Shared source not tagged for this device")

    root = os.path.abspath(normalize_fs_path(entry["path"]))
    safe_rel = os.path.normpath(relative_path.replace("\\", "/"))
    full_path = os.path.abspath(os.path.join(root, safe_rel))
    if os.path.commonpath([root, full_path]) != root or not os.path.isfile(full_path):
        raise HTTPException(status_code=404, detail="File not found")
    return thumbnail_service.get_thumbnail_response(full_path)


@router.post("/api/shared/{source_id}/warm_previews")
@router.post("/shared/{source_id}/warm_previews")
async def warm_shared_previews(
    source_id: str,
    body: WarmPreviewsRequest,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, body.device_id, device_repo.verify_device_token)
    entry = _find_shared_dir(source_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Shared source not found")
    root = os.path.abspath(normalize_fs_path(entry["path"]))
    for rel_path in body.paths[:3]:
        try:
            full_path = os.path.abspath(os.path.join(root, rel_path))
            if preview_service.is_video(full_path):
                arm_active_video_preview(body.device_id or "shared", full_path)
                preview_service.get_preview_path(full_path, schedule_missing=True)
        except Exception:
            pass
    return {"ok": True}
