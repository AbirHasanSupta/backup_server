"""api/v1/files.py — Library Browsing, Search, Download, Preview & Thumbnail Router."""

from __future__ import annotations

import asyncio
import os
from pydantic import BaseModel
from fastapi import APIRouter, Header, HTTPException, Query, Request, status
from fastapi.responses import FileResponse

from core.config import get_shared_dirs
from core.security import verify_api_key_or_device_token
from repositories import device_repo, file_repo, social_repo
from services.preview_service import preview_service
from services.thumbnail_service import thumbnail_service
from storage.manager import get_storage
from video_preview import arm_active_video_preview

router = APIRouter(tags=["Files & Library"])


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
    return "all" in tags or device_id in tags


@router.get("/files/list")
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
async def browse_files(
    device_id: str,
    folder_path: str = "",
    recursive: bool = False,
    sort_by: str = "date",
    sort_order: str = "desc",
    category: str = "all",
    limit: int | None = None,
    offset: int = 0,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    return file_repo.get_files_browse(
        device_id=device_id,
        folder_path=folder_path,
        recursive=recursive,
        sort_by=sort_by,
        sort_order=sort_order,
        category=category,
        limit=limit,
        offset=offset,
    )


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


@router.get("/files/download")
async def download_file(
    path: str,
    request: Request,
    device_id: str | None = None,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    storage = get_storage()
    full_path = storage.get_file_path(path, device_id=device_id)
    return preview_service.stream_file_range(full_path, request)


@router.get("/files/preview")
async def preview_file(
    path: str,
    request: Request,
    device_id: str | None = None,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    storage = get_storage()
    full_path = storage.get_file_path(path, device_id=device_id)

    if not preview_service.is_video(full_path):
        raise HTTPException(status_code=400, detail="Preview is only available for video files")

    cached_preview = preview_service.get_preview_path(full_path, schedule_missing=True)
    cache_ctrl = "public, max-age=604800, immutable" if cached_preview != full_path else "private, max-age=86400"
    return preview_service.stream_file_range(cached_preview, request, cache_control=cache_ctrl)


@router.get("/files/thumbnail")
async def get_thumbnail(
    path: str,
    device_id: str | None = None,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    storage = get_storage()
    full_path = storage.get_file_path(path, device_id=device_id)
    return thumbnail_service.get_thumbnail_response(full_path)


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

    root = os.path.abspath(entry["path"])
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
    root = os.path.abspath(entry["path"])
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

    root = os.path.abspath(entry["path"])
    norm_prefix = prefix.strip("/").replace("\\", "/")
    target_dir = os.path.join(root, norm_prefix) if norm_prefix else root
    target_dir = os.path.abspath(target_dir)
    if os.path.commonpath([root, target_dir]) != root:
        raise HTTPException(status_code=400, detail="Invalid path")
    if not os.path.isdir(target_dir):
        return {"folders": [], "files": []}

    def _scan():
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
        return {"folders": folders, "files": files}

    return await asyncio.to_thread(_scan)


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

    root = os.path.abspath(entry["path"])
    safe_rel = os.path.normpath(relative_path.replace("\\", "/"))
    full_path = os.path.abspath(os.path.join(root, safe_rel))
    if os.path.commonpath([root, full_path]) != root or not os.path.isfile(full_path):
        raise HTTPException(status_code=404, detail="File not found")
    return preview_service.stream_file_range(full_path, request)


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

    root = os.path.abspath(entry["path"])
    safe_rel = os.path.normpath(relative_path.replace("\\", "/"))
    full_path = os.path.abspath(os.path.join(root, safe_rel))
    if os.path.commonpath([root, full_path]) != root or not os.path.isfile(full_path):
        raise HTTPException(status_code=404, detail="File not found")
    if not preview_service.is_video(full_path):
        raise HTTPException(status_code=400, detail="Preview is only available for video files")

    cached = preview_service.get_preview_path(full_path, schedule_missing=True)
    cache_ctrl = "public, max-age=604800, immutable" if cached != full_path else "private, max-age=86400"
    return preview_service.stream_file_range(cached, request, cache_control=cache_ctrl)


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

    root = os.path.abspath(entry["path"])
    safe_rel = os.path.normpath(relative_path.replace("\\", "/"))
    full_path = os.path.abspath(os.path.join(root, safe_rel))
    if os.path.commonpath([root, full_path]) != root or not os.path.isfile(full_path):
        raise HTTPException(status_code=404, detail="File not found")
    return thumbnail_service.get_thumbnail_response(full_path)
