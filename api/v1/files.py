"""api/v1/files.py — Library Browsing, Search, Download, Preview & Thumbnail Router."""

from __future__ import annotations

import asyncio
import contextlib
import os
import time
from pydantic import BaseModel
from fastapi import APIRouter, Header, HTTPException, Query, Request, status
from fastapi.responses import FileResponse, StreamingResponse

from core.config import get_shared_dirs, load_config, save_config
from core.google_drive import EXPORT_FORMATS, GoogleDriveError, all_files as drive_all_files, browse as drive_browse, ensure_descendant as drive_ensure_descendant, folder_id_from_link
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

# Warm the next folder level after a Google Drive listing. The mobile client
# expands folders over separate requests, so doing this work after returning
# the current listing makes the next tap use a cached response.
_DRIVE_PREFETCH_SEMAPHORE = asyncio.Semaphore(4)
_DRIVE_PREFETCH_TASKS: dict[tuple[str, str], asyncio.Task] = {}


async def _prefetch_drive_folder(root_id: str, prefix: str) -> None:
    try:
        async with _DRIVE_PREFETCH_SEMAPHORE:
            await asyncio.to_thread(drive_browse, root_id, prefix, root_id=root_id)
    except Exception:
        # Prefetch must never affect the interactive browse response.
        pass


def _schedule_drive_prefetch(root_id: str, folders: list[dict]) -> None:
    for folder in folders[:12]:
        prefix = str(folder.get("path") or "")
        folder_id = prefix.split("/", 1)[0]
        task_key = (root_id, folder_id)
        if not folder_id or task_key in _DRIVE_PREFETCH_TASKS:
            continue
        task = asyncio.create_task(_prefetch_drive_folder(root_id, prefix))
        _DRIVE_PREFETCH_TASKS[task_key] = task
        task.add_done_callback(lambda done, key=task_key: _DRIVE_PREFETCH_TASKS.pop(key, None))

# Bound concurrent full-tree shared-folder walks under Docker/Postgres so sync
# I/O cannot exhaust the thread pool. Desktop SQLite keeps unlimited concurrency.
_HEAVY_FS_SEM: asyncio.Semaphore | None = None


def _heavy_fs_semaphore() -> asyncio.Semaphore | None:
    """Lazy semaphore: only enabled for the Postgres/Docker deployment path."""
    global _HEAVY_FS_SEM
    try:
        from core.config import load_config
        if load_config().get("DATABASE_BACKEND") != "postgres":
            return None
    except Exception:
        return None
    if _HEAVY_FS_SEM is None:
        _HEAVY_FS_SEM = asyncio.Semaphore(2)
    return _HEAVY_FS_SEM


@contextlib.asynccontextmanager
async def _heavy_fs_slot():
    sem = _heavy_fs_semaphore()
    if sem is None:
        yield
        return
    async with sem:
        yield


class WarmPreviewsRequest(BaseModel):
    paths: list[str]
    device_id: str | None = None


class AddGoogleDriveFolderRequest(BaseModel):
    link: str
    label: str | None = None


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


def _drive_source(entry: dict) -> bool:
    return entry.get("type") == "google_drive" or entry.get("kind") == "google_drive"


def _drive_file_id(relative_path: str) -> str:
    # Drive source paths carry the opaque file ID as their first segment and
    # the original filename as their final segment for the existing UI.
    parts = relative_path.replace("\\", "/").strip("/").split("/")
    if len(parts) < 2 or not parts[0]:
        raise HTTPException(status_code=400, detail="Invalid Google Drive file path")
    return parts[0]


def _drive_media_response(file_id: str, request: Request, metadata: dict | None = None):
    import urllib.error
    import urllib.parse
    import urllib.request
    from config import load_config

    api_key = str(load_config().get("GOOGLE_DRIVE_API_KEY") or "").strip()
    if not api_key:
        raise HTTPException(status_code=503, detail="Google Drive API key is not configured")
    metadata = metadata or {}
    # Public blob links are the most compatible anonymous download route. The
    # API alt=media endpoint remains a fallback for files without a browser link.
    mime_type = metadata.get("mimeType") or ""
    export = EXPORT_FORMATS.get(mime_type)
    if export:
        url = (metadata.get("exportLinks") or {}).get(export[0]) or (
            f"https://www.googleapis.com/drive/v3/files/{urllib.parse.quote(file_id, safe='')}/export?mimeType={urllib.parse.quote(export[0], safe='')}&key={urllib.parse.quote(api_key)}"
        )
    else:
        url = metadata.get("webContentLink") or (
            f"https://www.googleapis.com/drive/v3/files/{urllib.parse.quote(file_id, safe='')}?alt=media&supportsAllDrives=true&key={urllib.parse.quote(api_key)}"
        )
    headers = {}
    if request.headers.get("range"):
        headers["Range"] = request.headers["range"]
    try:
        upstream = urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60)
    except urllib.error.HTTPError as exc:
        raise HTTPException(status_code=404 if exc.code == 404 else 502, detail="Google Drive file could not be downloaded") from exc
    response_headers = {}
    for header in ("Content-Length", "Content-Range", "Accept-Ranges", "Content-Disposition"):
        if upstream.headers.get(header):
            response_headers[header] = upstream.headers[header]
    media_type = upstream.headers.get_content_type()
    def _stream():
        try:
            while chunk := upstream.read(1024 * 1024):
                yield chunk
        finally:
            upstream.close()
    return StreamingResponse(_stream(), status_code=upstream.status, media_type=media_type, headers=response_headers)


def _fetch_drive_thumbnail(url: str) -> tuple[bytes, str]:
    import urllib.request
    with urllib.request.urlopen(url, timeout=15) as response:
        return response.read(), response.headers.get_content_type()


@router.get("/files/list")
@router.get("/api/files/list")
async def list_files(
    device_id: str,
    prefix: str = "",
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    files = await asyncio.to_thread(file_repo.get_files_for_device, device_id, prefix)
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
    files = await asyncio.to_thread(file_repo.search_files_for_device, device_id, q, category, limit)
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
    return await asyncio.to_thread(thumbnail_service.get_thumbnail_response, full_path)


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

    if _drive_source(entry):
        try:
            root_id = entry.get("drive_folder_id") or folder_id_from_link(entry.get("path", ""))
            folder_id = prefix.split("/", 1)[0] if prefix else root_id
            if folder_id != root_id:
                nested = await asyncio.to_thread(drive_ensure_descendant, root_id, folder_id)
                if nested.get("mimeType") != "application/vnd.google-apps.folder":
                    raise GoogleDriveError("Invalid Google Drive folder path.")
            files = await asyncio.to_thread(drive_all_files, folder_id)
        except GoogleDriveError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        return {"files": files, "source_id": source_id, "label": entry.get("label")}

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

    async with _heavy_fs_slot():
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
    if _drive_source(entry):
        try:
            files = await asyncio.to_thread(drive_all_files, folder_id_from_link(entry.get("path", "")))
        except GoogleDriveError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        return {"files": [f for f in files if q in f.get("name", "").lower()]}
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

    async with _heavy_fs_slot():
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

    if _drive_source(entry):
        try:
            root_id = entry.get("drive_folder_id") or folder_id_from_link(entry.get("path", ""))
            if prefix:
                nested_id = prefix.split("/", 1)[0]
                if nested_id != root_id:
                    nested = await asyncio.to_thread(drive_ensure_descendant, root_id, nested_id)
                    if nested.get("mimeType") != "application/vnd.google-apps.folder":
                        raise GoogleDriveError("Invalid Google Drive folder path.")
            result = await asyncio.to_thread(drive_browse, root_id, prefix, root_id=root_id)
        except GoogleDriveError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        _schedule_drive_prefetch(root_id, result.get("folders") or [])
        return result

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

    if _drive_source(entry):
        try:
            root_id = entry.get("drive_folder_id") or folder_id_from_link(entry.get("path", ""))
            metadata = await asyncio.to_thread(drive_ensure_descendant, root_id, _drive_file_id(relative_path))
        except GoogleDriveError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return await asyncio.to_thread(_drive_media_response, _drive_file_id(relative_path), request, metadata)

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

    if _drive_source(entry):
        file_id = _drive_file_id(relative_path)
        try:
            root_id = entry.get("drive_folder_id") or folder_id_from_link(entry.get("path", ""))
            metadata = await asyncio.to_thread(drive_ensure_descendant, root_id, file_id)
        except GoogleDriveError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        if not str(metadata.get("mimeType", "")).startswith("video/"):
            raise HTTPException(status_code=400, detail="Preview is only available for video files")
        return await asyncio.to_thread(_drive_media_response, file_id, request, metadata)

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

    if _drive_source(entry):
        try:
            root_id = entry.get("drive_folder_id") or folder_id_from_link(entry.get("path", ""))
            metadata = await asyncio.to_thread(drive_ensure_descendant, root_id, _drive_file_id(relative_path))
        except GoogleDriveError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        thumbnail = metadata.get("thumbnailLink")
        if not thumbnail:
            raise HTTPException(status_code=404, detail="Thumbnail is not available")
        try:
            content, media_type = await asyncio.to_thread(_fetch_drive_thumbnail, thumbnail)
        except Exception as exc:
            raise HTTPException(status_code=404, detail="Google Drive thumbnail is not available") from exc
        return StreamingResponse(iter([content]), media_type=media_type, headers={"Cache-Control": "private, max-age=3600"})

    root = os.path.abspath(normalize_fs_path(entry["path"]))
    safe_rel = os.path.normpath(relative_path.replace("\\", "/"))
    full_path = os.path.abspath(os.path.join(root, safe_rel))
    if os.path.commonpath([root, full_path]) != root or not os.path.isfile(full_path):
        raise HTTPException(status_code=404, detail="File not found")
    return await asyncio.to_thread(thumbnail_service.get_thumbnail_response, full_path)


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
    if _drive_source(entry):
        return {"ok": True, "scheduled": 0}
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


@router.post("/api/shared/google-drive/add")
@router.post("/shared/google-drive/add")
async def add_shared_google_drive_folder(
    body: AddGoogleDriveFolderRequest,
    device_id: str | None = None,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    try:
        folder_id = folder_id_from_link(body.link)
        from core.google_drive import FOLDER_MIME, get_file, list_children
        metadata = await asyncio.to_thread(get_file, folder_id)
        if metadata.get("mimeType") != FOLDER_MIME:
            raise GoogleDriveError("That link is not a Google Drive folder. Paste a folder link.")
        await asyncio.to_thread(list_children, folder_id)
    except GoogleDriveError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    cfg = load_config()
    dirs = list(cfg.get("SHARED_DIRS", []))
    existing = next((d for d in dirs if _drive_source(d) and d.get("drive_folder_id") == folder_id), None)
    if existing:
        if str(existing.get("label") or "").strip().casefold() in ("", "google drive folder") and metadata.get("name"):
            existing["label"] = str(metadata["name"]).strip()
            cfg["SHARED_DIRS"] = dirs
            save_config(cfg)
        return {"ok": True, "entry": existing, "existing": True}
    requested_label = (body.label or "").strip()
    if not requested_label or requested_label.casefold() == "google drive folder":
        requested_label = str(metadata.get("name") or "Google Drive Folder").strip()
    entry = {
        "id": f"drive_{folder_id}",
        "path": body.link.strip(),
        "drive_folder_id": folder_id,
        "type": "google_drive",
        "label": requested_label or "Google Drive Folder",
        # A device-token request creates a source for that device only. Admin
        # API-key requests may intentionally publish it to every paired device.
        "device_ids": [device_id] if device_id else ["all"],
        "available_in_reels": False,
    }
    dirs.append(entry)
    cfg["SHARED_DIRS"] = dirs
    save_config(cfg)
    return {"ok": True, "entry": entry, "existing": False}
