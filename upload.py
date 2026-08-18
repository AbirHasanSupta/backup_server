import asyncio
from email.utils import formatdate
from mimetypes import guess_type
import os
import re
import socket
import subprocess
import threading
import time
import uuid

import memories
import rewind
from fastapi import APIRouter, HTTPException, Request, UploadFile, Form, Header
from fastapi.responses import StreamingResponse, FileResponse
from pydantic import BaseModel

from config import load_config
from database import (
    batch_check_files,
    find_device_by_name_model,
    get_stats,
    get_device_stats,
    get_devices,
    get_files_for_device,
    insert_file,
    insert_sync_session,
    get_sync_sessions,
    clear_sync_sessions,
    is_device_known,
    is_uploaded_compatible,
    merge_device_id,
    remove_device,
    remove_file_record,
    touch_device,
    upsert_device,
    ensure_device_token,
    verify_device_token,
)
from state import add_log, get_current_activity, pending_connections, set_current_activity
from storage import file_exists, save_fileobj, save_upload_stream, full_path_for
from thumbnail import get_video_thumbnail_path
from video_preview import (
    arm_active_video_preview,
    get_video_preview_path,
    is_video_path,
    preview_request_is_active,
)

router = APIRouter()

APP_VERSION = "3.1.0"


# ──────────────────────────────────────────────────────────────────────────────
# Auth helper
# ──────────────────────────────────────────────────────────────────────────────

def _extract_bearer(authorization: str | None) -> str | None:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    return authorization[7:]


def verify_auth(authorization: str | None, device_id: str | None = None) -> None:
    """Accept global API key or a per-device token when device_id is supplied."""
    token = _extract_bearer(authorization)
    if not token:
        raise HTTPException(status_code=401, detail="Unauthorized")

    current_key = load_config()["API_KEY"]
    if token == current_key:
        return

    if device_id and verify_device_token(device_id, token):
        return

    raise HTTPException(status_code=401, detail="Unauthorized")


def verify_connect_auth(authorization: str | None) -> None:
    """Initial pairing uses the shared API key only."""
    token = _extract_bearer(authorization)
    current_key = load_config()["API_KEY"]
    if token != current_key:
        raise HTTPException(status_code=401, detail="Unauthorized")


def verify_known_device(device_ip: str, device_id: str | None) -> None:
    if not is_device_known(device_ip, device_id):
        raise HTTPException(
            status_code=403,
            detail="Device is not approved. Reconnect from the Android app settings.",
        )


def verify_known_device_by_id(device_id: str) -> None:
    if not any(d["device_id"] == device_id for d in get_devices()):
        raise HTTPException(status_code=403, detail="Device not approved")


# ──────────────────────────────────────────────────────────────────────────────
# Discovery / health-check
# ──────────────────────────────────────────────────────────────────────────────

@router.get("/ping")
async def ping():
    """
    LAN discovery endpoint.
    The Android app scans the subnet and identifies backup servers by this response.
    """
    return {
        "status": "ok",
        "name": socket.gethostname(),
        "version": APP_VERSION,
    }


# ──────────────────────────────────────────────────────────────────────────────
# Device connection / approval
# ──────────────────────────────────────────────────────────────────────────────

class ConnectRequest(BaseModel):
    device_name: str
    device_id: str | None = None
    device_model: str | None = None


class FileCheckItem(BaseModel):
    relative_path: str
    modified_time: int
    size: int = 0
    external_id: str | None = None
    sha256: str | None = None


class FileCheckRequest(BaseModel):
    device_id: str | None = None
    verify_disk: bool = False
    files: list[FileCheckItem]


@router.post("/connect")
async def connect_device(
        body: ConnectRequest,
        request: Request,
        authorization: str = Header(None),
):
    """
    Called by the Android app when it first connects (or re-saves) its server config.
    • If the device is already known → silently update its record and return "accepted".
    • If it's a new device and REQUIRE_APPROVAL is True → block until the desktop user
      clicks Accept or Reject (30-second auto-reject timeout).
    • If REQUIRE_APPROVAL is False → auto-accept immediately.
    """
    verify_connect_auth(authorization)

    device_ip = request.client.host
    device_name = body.device_name.strip() or device_ip
    device_id = body.device_id
    device_model = (body.device_model or "").strip() or None

    def accepted_response() -> dict:
        if device_id:
            token = ensure_device_token(device_id)
            return {"status": "accepted", "token": token}
        return {"status": "accepted"}

    # Already registered — just refresh the record, no dialog needed
    if is_device_known(device_ip, device_id):
        upsert_device(device_name, device_ip, device_id, device_model)
        add_log(f"📱 Re-connected: {device_name} ({device_id or device_ip})")
        return accepted_response()

    # ── Reinstall detection ────────────────────────────────────────────────────
    # A new device_id might belong to a phone that already has a backup record
    # (same device_name + model).  If so, silently re-link the new ID to the
    # existing device row and migrate all file records — the old backup folder
    # is preserved, and already-uploaded files are not re-uploaded.
    if device_id:
        existing = find_device_by_name_model(device_name, device_model)
        if existing and existing.get("device_id") and existing["device_id"] != device_id:
            old_id = existing["device_id"]
            add_log(
                f"🔄 Reinstall detected for '{device_name}' ({device_model or 'unknown model'}). "
                f"Merging {old_id[:12]}… → {device_id[:12]}…"
            )
            merge_device_id(old_id, device_id, device_ip)
            # Update the name/ip/model in case they changed slightly
            upsert_device(device_name, device_ip, device_id, device_model)
            return accepted_response()

    add_log(f"📱 New connection request: {device_name} ({device_id or device_ip})")

    if not load_config().get("REQUIRE_APPROVAL", True):
        upsert_device(device_name, device_ip, device_id, device_model)
        add_log(f"✅ Auto-accepted: {device_name} ({device_id or device_ip})")
        return accepted_response()

    # ── Approval flow ─────────────────────────────────────────────────────────
    req_id = str(uuid.uuid4())
    loop = asyncio.get_running_loop()
    future: asyncio.Future = loop.create_future()

    pending_connections[req_id] = {
        "name": device_name,
        "ip": device_ip,
        "device_id": device_id,
        "future": future,
        "loop": loop,
        "_shown": False,
    }

    try:
        accepted = await asyncio.wait_for(asyncio.shield(future), timeout=30.0)
    except asyncio.TimeoutError:
        pending_connections.pop(req_id, None)
        add_log(f"⏱️ Connection timed out: {device_name} ({device_id or device_ip})")
        return {"status": "rejected", "reason": "timeout"}

    if accepted:
        upsert_device(device_name, device_ip, device_id, device_model)
        return accepted_response()

    return {"status": "rejected"}


# ──────────────────────────────────────────────────────────────────────────────
# Device management
# ──────────────────────────────────────────────────────────────────────────────

@router.get("/devices")
async def list_devices(authorization: str = Header(None)):
    """Returns the list of accepted connected devices."""
    verify_auth(authorization)
    return {"devices": await asyncio.to_thread(get_devices)}


@router.delete("/devices/{device_id}")
async def delete_device(device_id: int, authorization: str = Header(None)):
    """Removes a device from the connected-devices list."""
    verify_auth(authorization)
    await asyncio.to_thread(remove_device, device_id)
    add_log(f"🗑️ Device #{device_id} removed via API")
    return {"status": "removed"}


# ──────────────────────────────────────────────────────────────────────────────
# Status
# ──────────────────────────────────────────────────────────────────────────────

@router.get("/status")
async def status(request: Request, device_id: str | None = None, authorization: str = Header(None)):
    """
    Aggregate server stats.
    Intended for the future desktop UI or monitoring scripts.
    """
    verify_auth(authorization, device_id)
    stats = await asyncio.to_thread(get_stats)
    devices = await asyncio.to_thread(get_devices)
    device_connected = await asyncio.to_thread(is_device_known, request.client.host, device_id) if device_id else None
    return {
        **stats,
        "connected_devices": len(devices),
        "devices": devices,
        "device_connected": device_connected,
        "server_version": APP_VERSION,
        "current_activity": get_current_activity(),
    }


class ActivityReport(BaseModel):
    message: str | None = None
    device_id: str | None = None


@router.post("/status/activity")
async def report_activity(body: ActivityReport, request: Request, authorization: str = Header(None)):
    verify_auth(authorization, body.device_id)
    set_current_activity(body.message, request.client.host, body.device_id)
    return {"status": "ok"}



# ──────────────────────────────────────────────────────────────────────────────
# File upload
# ──────────────────────────────────────────────────────────────────────────────

@router.post("/files/check")
async def check_files(body: FileCheckRequest, request: Request, authorization: str = Header(None)):
    """
    Batch metadata check used before upload.
    Files deleted from the PC are reported as missing even when an old DB row exists.
    """
    verify_auth(authorization, body.device_id)
    device_ip = request.client.host
    device_id = body.device_id
    verify_known_device(device_ip, device_id)
    return await asyncio.to_thread(_check_files_sync, body, device_ip, device_id)


def _check_files_sync(body: FileCheckRequest, device_ip: str, device_id: str | None) -> dict:
    items = []
    for item in body.files:
        items.append({
            "path": item.relative_path,
            "size": item.size,
            "modified_time": item.modified_time,
            "external_id": item.external_id,
            "device_id": device_id,
        })

    present_in_db = batch_check_files(items)

    if len(items) > 0:
        add_log(f"🔍 Checking {len(items)} files for {device_id or device_ip}. Found in DB: {len(present_in_db)}")

    checked = []
    present = 0
    verify_disk = body.verify_disk
    for item in body.files:
        key = f"{item.relative_path}|{item.modified_time}|{item.size}"
        db_exists = key in present_in_db

        on_disk = True
        if verify_disk:
            on_disk = db_exists and file_exists(item.relative_path, item.size, device_id=device_id)

            if db_exists and not on_disk:
                add_log(f"⚠️  {item.relative_path} in DB but missing from disk. Removing record.")
                remove_file_record(item.relative_path, item.size, item.modified_time, device_id=device_id)
                db_exists = False

        is_present = db_exists and on_disk

        if is_present:
            present += 1

        checked.append({
            "relative_path": item.relative_path,
            "modified_time": item.modified_time,
            "size": item.size,
            "status": "present" if is_present else "missing",
        })

    touch_device(device_ip, device_id=device_id, files_delta=0)
    device_stats = get_device_stats(device_ip, device_id=device_id)

    return {
        "files": checked,
        "present": present,
        "missing": len(checked) - present,
        "device_total_files": device_stats["total_files"],
        "device_total_size": device_stats["total_size"],
    }


def finish_upload_record(
        relative_path: str,
        size: int,
        modified_time: int,
        device_ip: str,
        external_id: str | None,
        sha256: str | None,
        device_id: str | None,
):
    now = int(time.time())
    try:
        insert_file(relative_path, size, modified_time, now, device_ip, external_id, sha256, device_id=device_id)
    except Exception as e:
        add_log(f"Error updating DB for {relative_path}: {str(e)}")
        raise

    touch_device(device_ip, device_id=device_id)
    device_stats = get_device_stats(device_ip, device_id=device_id)
    add_log(f"Uploaded: {relative_path} ({device_id or device_ip})")

    return {
        "status": "uploaded",
        "device_total_files": device_stats["total_files"],
        "device_total_size": device_stats["total_size"],
    }


def skipped_upload_response(device_ip: str, device_id: str | None):
    touch_device(device_ip, device_id=device_id, files_delta=0)
    device_stats = get_device_stats(device_ip, device_id=device_id)
    return {
        "status": "skipped",
        "device_total_files": device_stats["total_files"],
        "device_total_size": device_stats["total_size"],
    }


def should_skip_upload(
        relative_path: str,
        size: int,
        modified_time: int,
        external_id: str | None,
        device_id: str | None,
        verify_disk: bool,
) -> bool:
    if not is_uploaded_compatible(relative_path, size, modified_time, external_id, device_id=device_id):
        return False
    if verify_disk:
        return file_exists(relative_path, size, device_id=device_id)
    return True


@router.post("/upload/raw")
async def upload_file_raw(
        request: Request,
        relative_path: str,
        modified_time: int,
        size: int,
        external_id: str = None,
        sha256: str = None,
        device_id: str = None,
        verify_disk: bool = False,
        authorization: str = Header(None),
):
    verify_auth(authorization, device_id)

    device_ip = request.client.host
    verify_known_device(device_ip, device_id)

    if await asyncio.to_thread(should_skip_upload, relative_path, size, modified_time, external_id, device_id, verify_disk):
        return await asyncio.to_thread(skipped_upload_response, device_ip, device_id)

    set_current_activity(f"Uploading {relative_path}", device_ip, device_id)
    add_log(f"Uploading: {relative_path} ({device_id or device_ip})")
    try:
        _, saved_sha256 = await save_upload_stream(
            relative_path,
            request.stream(),
            device_id=device_id,
            compute_sha256=not bool(sha256),
            expected_size=size,
        )
    except Exception as e:
        add_log(f"Error saving {relative_path}: {str(e)}")
        raise
    finally:
        set_current_activity(None, device_ip, device_id)

    if not sha256:
        sha256 = saved_sha256

    return await asyncio.to_thread(finish_upload_record, relative_path, size, modified_time, device_ip, external_id, sha256, device_id)


@router.post("/upload")
async def upload_file(
        request: Request,
        file: UploadFile,
        relative_path: str = Form(...),
        modified_time: int = Form(...),
        size: int = Form(...),
        external_id: str = Form(None),
        sha256: str = Form(None),
        device_id: str = Form(None),
        verify_disk: bool = Form(False),
        authorization: str = Header(None),
):
    verify_auth(authorization, device_id)

    device_ip = request.client.host
    verify_known_device(device_ip, device_id)

    if await asyncio.to_thread(should_skip_upload, relative_path, size, modified_time, external_id, device_id, verify_disk):
        return await asyncio.to_thread(skipped_upload_response, device_ip, device_id)

    set_current_activity(f"Uploading {relative_path}", device_ip, device_id)
    add_log(f"Uploading: {relative_path} ({device_id or device_ip})")
    try:
        await file.seek(0)
        _, saved_sha256 = await asyncio.to_thread(
            save_fileobj,
            relative_path,
            file.file,
            device_id=device_id,
            compute_sha256=not bool(sha256),
            expected_size=size,
        )
    except Exception as e:
        add_log(f"❌ Error saving {relative_path}: {str(e)}")
        raise
    finally:
        set_current_activity(None, device_ip, device_id)


    if not sha256:
        sha256 = saved_sha256

    return await asyncio.to_thread(finish_upload_record, relative_path, size, modified_time, device_ip, external_id, sha256, device_id)


# ──────────────────────────────────────────────────────────────────────────────
# File download / restore
# ──────────────────────────────────────────────────────────────────────────────

@router.get("/files/list")
async def list_files(device_id: str, authorization: str = Header(None), token: str = None):
    # Accept auth either via Authorization header or ?token= query param
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    verify_known_device_by_id(device_id)
    files = await asyncio.to_thread(get_files_for_device, device_id)
    return {"files": files}


_MIME_MAP = {
    # Images
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic",
    ".heif": "image/heif", ".bmp": "image/bmp", ".tiff": "image/tiff",
    ".tif": "image/tiff", ".avif": "image/avif", ".svg": "image/svg+xml",
    # Video
    ".mp4": "video/mp4", ".mov": "video/quicktime", ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska", ".webm": "video/webm", ".3gp": "video/3gpp",
    ".m4v": "video/x-m4v", ".wmv": "video/x-ms-wmv",
    # Audio
    ".mp3": "audio/mpeg", ".aac": "audio/aac", ".wav": "audio/wav",
    ".flac": "audio/flac", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
    ".opus": "audio/opus", ".wma": "audio/x-ms-wma",
}

_RANGE_RE = re.compile(r"^(\d*)-(\d*)$")
_STREAM_CHUNK = 1024 * 1024


def _parse_range(range_header: str, file_size: int) -> tuple[int, int] | None:
    if not range_header.startswith("bytes="):
        return None
    spec = range_header[len("bytes="):].split(",")[0].strip()
    match = _RANGE_RE.match(spec)
    if not match:
        return None
    start_str, end_str = match.groups()
    if start_str == "" and end_str == "":
        return None
    if start_str == "":
        suffix_len = int(end_str)
        if suffix_len <= 0:
            return None
        start = max(file_size - suffix_len, 0)
        end = file_size - 1
    else:
        start = int(start_str)
        end = int(end_str) if end_str != "" else file_size - 1
        end = min(end, file_size - 1)
    return (start, end)


def _stream_cache_headers(path: str, file_size: int, cache_control: str | None = None) -> dict[str, str]:
    stat = os.stat(path)
    return {
        "Content-Length": str(file_size),
        "Accept-Ranges": "bytes",
        # Let clients reuse recently streamed media segments unless the caller
        # is serving a temporary source-file preview representation.
        "Cache-Control": cache_control or "private, max-age=300",
        "ETag": f'W/"{int(stat.st_mtime)}-{file_size}"',
        "Last-Modified": formatdate(stat.st_mtime, usegmt=True),
    }


def _file_range_response(
        path: str,
        request: Request,
        *,
        cache_control: str | None = None,
) -> StreamingResponse:
    file_size = os.path.getsize(path)
    ext = os.path.splitext(path)[1].lower()
    mime = _MIME_MAP.get(ext, "application/octet-stream")
    filename = os.path.basename(path)
    range_header = request.headers.get("range")
    base_headers = _stream_cache_headers(path, file_size, cache_control)

    parsed = _parse_range(range_header, file_size) if (file_size > 0 and range_header) else None

    if parsed is not None:
        start, end = parsed
        if start > end or start >= file_size or start < 0:
            raise HTTPException(
                status_code=416,
                detail="Requested range not satisfiable",
                headers={"Content-Range": f"bytes */{file_size}"},
            )
        chunk_size = end - start + 1

        def ranged_stream():
            with open(path, "rb") as f:
                f.seek(start)
                remaining = chunk_size
                while remaining > 0:
                    chunk = f.read(min(_STREAM_CHUNK, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    yield chunk

        return StreamingResponse(
            ranged_stream(),
            status_code=206,
            media_type=mime,
            headers={
                "Content-Disposition": f'inline; filename="{filename}"',
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                **base_headers,
                "Content-Length": str(chunk_size),
            },
        )

    def full_stream():
        with open(path, "rb") as f:
            while chunk := f.read(_STREAM_CHUNK):
                yield chunk

    return StreamingResponse(
        full_stream(),
        media_type=mime,
        headers={
            "Content-Disposition": f'inline; filename="{filename}"',
            **base_headers,
        },
    )


@router.get("/files/download")
async def download_file(
        relative_path: str,
        device_id: str,
        request: Request,
        authorization: str = Header(None),
        token: str = None,
):
    # Accept auth either via Authorization header or ?token= query param
    # (expo-av on Android cannot set custom headers, so we support the token QP)
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    verify_known_device_by_id(device_id)
    path = full_path_for(relative_path, device_id=device_id)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="File not found")

    return _file_range_response(path, request)


@router.get("/files/preview")
async def preview_file(
        relative_path: str,
        device_id: str,
        request: Request,
        authorization: str = Header(None),
        token: str = None,
):
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    verify_known_device_by_id(device_id)
    path = full_path_for(relative_path, device_id=device_id)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="File not found")
    if not is_video_path(path):
        raise HTTPException(status_code=400, detail="Preview is only available for video files")

    try:
        # The Android player and its adjacent-video preloaders issue identical
        # GETs.  Only a GET correlated with the first path in the app's warm
        # request is allowed to create a server cache; all other GETs simply
        # stream without doing background conversion work.
        preview_path = get_video_preview_path(
            path,
            schedule_missing=preview_request_is_active(f"files:{device_id}", path),
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="File not found")
    except subprocess.CalledProcessError:
        raise HTTPException(status_code=500, detail="Failed to generate video preview")

    # This URL initially represents the original source, then the optimized
    # cache once ready.  Revalidate only that temporary response so a later
    # open can pick up the optimized representation at the same URL.
    cache_control = "private, no-cache" if preview_path == path else None
    return _file_range_response(preview_path, request, cache_control=cache_control)


@router.get("/files/thumbnail")
async def thumbnail_file(
        relative_path: str,
        device_id: str,
        authorization: str = Header(None),
        token: str = None,
):
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    verify_known_device_by_id(device_id)
    path = full_path_for(relative_path, device_id=device_id)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="File not found")
    if not is_video_path(path):
        media_type = guess_type(path)[0] or "image/jpeg"
        return FileResponse(path, media_type=media_type, headers={"Cache-Control": "public, max-age=86400"})
    thumb_path = await asyncio.to_thread(get_video_thumbnail_path, path)
    if not thumb_path:
        raise HTTPException(status_code=500, detail="Failed to generate thumbnail")
    return FileResponse(thumb_path, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=86400"})


class WarmPreviewsRequest(BaseModel):
    relative_paths: list[str]


@router.post("/shared/{source_id}/warm_previews")
async def warm_shared_preview_files(
        source_id: str,
        body: WarmPreviewsRequest,
        device_id: str | None = None,
        authorization: str = Header(None),
        token: str = None,
):
    """
    Mark only the currently active video as eligible for cache generation.

    The Android app sends the current video first, followed by adjacent videos.
    Nothing is generated by this request itself; its matching GET must arrive.
    """
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)

    entry = _find_shared_dir(source_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Shared source not found")
    if not _is_folder_tagged_for_device(entry, device_id, authorization, token):
        raise HTTPException(status_code=403, detail="Shared source not tagged for this device")

    root = os.path.abspath(entry["path"])
    armed = False
    scheduled = False
    # Do not loop: all remaining paths are adjacent/list warmups and must never
    # create disk cache entries on the server.
    for rel in (body.relative_paths or [])[:1]:
        safe_rel = os.path.normpath(rel.replace("\\", "/"))
        full_path = os.path.abspath(os.path.join(root, safe_rel))
        if os.path.commonpath([root, full_path]) != root:
            continue
        if not os.path.isfile(full_path):
            continue
        if not is_video_path(full_path):
            continue
        armed = True
        scheduled = arm_active_video_preview(f"shared:{source_id}:{device_id or ''}", full_path)

    return {"ok": True, "scheduled": int(scheduled), "armed": armed}


@router.post("/files/warm_previews")
async def warm_preview_files(
        body: WarmPreviewsRequest,
        device_id: str,
        authorization: str = Header(None),
        token: str = None,
):
    """
    Mark only the current video (the first path) as eligible for a cache build.
    Adjacent and Restore-list warmups are intentionally ignored.
    """
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    verify_known_device_by_id(device_id)

    armed = False
    scheduled = False
    for rel in (body.relative_paths or [])[:1]:
        try:
            path = full_path_for(rel, device_id=device_id)
        except Exception:
            continue
        if not os.path.isfile(path):
            continue
        if not is_video_path(path):
            continue
        armed = True
        scheduled = arm_active_video_preview(f"files:{device_id}", path)

    return {"ok": True, "scheduled": int(scheduled), "armed": armed}


# ──────────────────────────────────────────────────────────────────────────────
# Sync session history
# ──────────────────────────────────────────────────────────────────────────────

class SyncSessionRequest(BaseModel):
    device_id: str | None = None
    device_name: str | None = None
    started_at: int
    ended_at: int
    duration_ms: int = 0
    trigger: str = "manual"
    outcome: str = "completed"
    scanned: int = 0
    checked: int = 0
    uploaded: int = 0
    skipped: int = 0
    errors: int = 0
    total_files: int = 0


@router.post("/sync/session")
async def record_sync_session(
        body: SyncSessionRequest,
        request: Request,
        authorization: str = Header(None),
):
    """
    Called by the Android app at the end of each sync session to persist a
    summary record on the server.  The record is shown in the desktop History
    page so the operator can audit every device's backup activity.
    """
    verify_auth(authorization, body.device_id)

    # Resolve device name from DB if not supplied
    device_name = body.device_name
    if not device_name and body.device_id:
        devices = get_devices()
        match = next((d for d in devices if d.get("device_id") == body.device_id), None)
        if match:
            device_name = match.get("device_name")

    session_id = insert_sync_session(
        device_id=body.device_id,
        device_name=device_name,
        started_at=body.started_at,
        ended_at=body.ended_at,
        duration_ms=body.duration_ms,
        trigger=body.trigger,
        outcome=body.outcome,
        scanned=body.scanned,
        checked=body.checked,
        uploaded=body.uploaded,
        skipped=body.skipped,
        errors=body.errors,
        total_files=body.total_files,
    )

    label = {"completed": "✅", "stopped": "⏹", "force_stopped": "⚡", "failed": "❌"}.get(body.outcome, "🔄")
    add_log(
        f"{label} Sync session from {device_name or body.device_id or 'unknown'}: "
        f"{body.uploaded} uploaded, {body.skipped} skipped, {body.errors} errors — {body.outcome}"
    )

    return {"ok": True, "id": session_id}


@router.get("/sync/sessions")
async def list_sync_sessions(
        device_id: str | None = None,
        limit: int = 100,
        authorization: str = Header(None),
):
    """Return sync session records, optionally filtered by device_id."""
    verify_auth(authorization, device_id)
    sessions = get_sync_sessions(device_id=device_id, limit=min(limit, 500))
    return {"sessions": sessions}


@router.delete("/sync/sessions")
async def delete_sync_sessions(
        device_id: str | None = None,
        authorization: str = Header(None),
):
    """Clear all or device-specific session history."""
    verify_auth(authorization, device_id)
    clear_sync_sessions(device_id=device_id)
    return {"ok": True}


# ──────────────────────────────────────────────────────────────────────────────
# Shared Directories  (read-only browse + download from arbitrary PC folders)
# ──────────────────────────────────────────────────────────────────────────────

def _get_shared_dirs() -> list[dict]:
    """Return the current SHARED_DIRS list from live config."""
    return load_config().get("SHARED_DIRS", [])


def _find_shared_dir(source_id: str) -> dict | None:
    """Return the shared-dir entry matching *source_id*, or None."""
    return next((d for d in _get_shared_dirs() if d.get("id") == source_id), None)


def _is_folder_tagged_for_device(
    entry: dict,
    device_id: str | None,
    authorization: str | None = None,
    query_token: str | None = None,
) -> bool:
    """
    Check if a shared folder entry is tagged for the given device_id.
    Device-specific sharing rules:
    - Requests using the master API key have access to all shared directories.
    - Device requests must supply device_id and match tagged device IDs (or 'all').
    """
    req_token = _extract_bearer(authorization) or query_token
    if req_token and req_token == load_config()["API_KEY"]:
        return True

    if not device_id:
        return False
    tagged = entry.get("device_ids", [])
    if not isinstance(tagged, list) or len(tagged) == 0:
        return False
    return device_id in tagged or "all" in tagged


@router.get("/shared/list")
async def list_shared_sources(
        device_id: str | None = None,
        authorization: str = Header(None),
        token: str = None,
):
    """
    Return the list of shared directories configured in the desktop app for this device.
    Only id + label are exposed — the real filesystem path is never sent.
    """
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    dirs = _get_shared_dirs()
    return {
        "sources": [
            {"id": d["id"], "label": d["label"]}
            for d in dirs
            if d.get("id") and d.get("label") and _is_folder_tagged_for_device(d, device_id, authorization, token)
        ]
    }


@router.get("/shared/{source_id}/files")
async def list_shared_files(
        source_id: str,
        device_id: str | None = None,
        authorization: str = Header(None),
        token: str = None,
):
    """
    Recursively list all files inside the shared directory identified by *source_id*.
    Only accessible if the folder is tagged for this device.
    """
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)

    entry = _find_shared_dir(source_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Shared source not found")
    if not _is_folder_tagged_for_device(entry, device_id, authorization, token):
        raise HTTPException(status_code=403, detail="Shared source not tagged for this device")

    root = os.path.abspath(entry["path"])
    if not os.path.isdir(root):
        return {"files": [], "warning": "Directory does not exist on server"}

    files = await asyncio.to_thread(_walk_shared_dir, root)
    return {"files": files, "source_id": source_id, "label": entry["label"]}


def _walk_shared_dir(root: str) -> list[dict]:
    files = []
    for dirpath, _dirnames, filenames in os.walk(root):
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


@router.get("/shared/{source_id}/download")
async def download_shared_file(
        source_id: str,
        relative_path: str,
        request: Request,
        device_id: str | None = None,
        authorization: str = Header(None),
        token: str = None,
):
    """
    Stream a file from a shared directory.
    Only accessible if the folder is tagged for this device.
    """
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)

    entry = _find_shared_dir(source_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Shared source not found")
    if not _is_folder_tagged_for_device(entry, device_id, authorization, token):
        raise HTTPException(status_code=403, detail="Shared source not tagged for this device")

    root = os.path.abspath(entry["path"])
    if not os.path.isdir(root):
        raise HTTPException(status_code=404, detail="Shared directory not found on server")

    # Sanitize + path-traversal guard
    safe_rel = os.path.normpath(relative_path.replace("\\", "/"))
    full_path = os.path.abspath(os.path.join(root, safe_rel))
    if os.path.commonpath([root, full_path]) != root:
        raise HTTPException(status_code=400, detail="Invalid path")

    if not os.path.isfile(full_path):
        raise HTTPException(status_code=404, detail="File not found")

    return _file_range_response(full_path, request)


@router.get("/shared/{source_id}/preview")
async def preview_shared_file(
        source_id: str,
        relative_path: str,
        request: Request,
        device_id: str | None = None,
        authorization: str = Header(None),
        token: str = None,
):
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)

    entry = _find_shared_dir(source_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Shared source not found")
    if not _is_folder_tagged_for_device(entry, device_id, authorization, token):
        raise HTTPException(status_code=403, detail="Shared source not tagged for this device")

    root = os.path.abspath(entry["path"])
    if not os.path.isdir(root):
        raise HTTPException(status_code=404, detail="Shared directory not found on server")

    safe_rel = os.path.normpath(relative_path.replace("\\", "/"))
    full_path = os.path.abspath(os.path.join(root, safe_rel))
    if os.path.commonpath([root, full_path]) != root:
        raise HTTPException(status_code=400, detail="Invalid path")

    if not os.path.isfile(full_path):
        raise HTTPException(status_code=404, detail="File not found")
    if not is_video_path(full_path):
        raise HTTPException(status_code=400, detail="Preview is only available for video files")

    try:
        preview_path = get_video_preview_path(
            full_path,
            schedule_missing=preview_request_is_active(
                f"shared:{source_id}:{device_id or ''}",
                full_path,
            ),
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="File not found")
    except subprocess.CalledProcessError:
        raise HTTPException(status_code=500, detail="Failed to generate video preview")

    cache_control = "private, no-cache" if preview_path == full_path else None
    return _file_range_response(preview_path, request, cache_control=cache_control)


@router.get("/shared/{source_id}/thumbnail")
async def thumbnail_shared_file(
        source_id: str,
        relative_path: str,
        device_id: str | None = None,
        authorization: str = Header(None),
        token: str = None,
):
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)

    entry = _find_shared_dir(source_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Shared source not found")
    if not _is_folder_tagged_for_device(entry, device_id, authorization, token):
        raise HTTPException(status_code=403, detail="Shared source not tagged for this device")

    root = os.path.abspath(entry["path"])
    if not os.path.isdir(root):
        raise HTTPException(status_code=404, detail="Shared directory not found on server")

    safe_rel = os.path.normpath(relative_path.replace("\\", "/"))
    full_path = os.path.abspath(os.path.join(root, safe_rel))
    if os.path.commonpath([root, full_path]) != root:
        raise HTTPException(status_code=400, detail="Invalid path")

    if not os.path.isfile(full_path):
        raise HTTPException(status_code=404, detail="File not found")
    if not is_video_path(full_path):
        media_type = guess_type(full_path)[0] or "image/jpeg"
        return FileResponse(full_path, media_type=media_type, headers={"Cache-Control": "public, max-age=86400"})
    thumb_path = await asyncio.to_thread(get_video_thumbnail_path, full_path)
    if not thumb_path:
        raise HTTPException(status_code=500, detail="Failed to generate thumbnail")
    return FileResponse(thumb_path, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=86400"})


# ──────────────────────────────────────────────────────────────────────────────
# Memories Endpoints
# ──────────────────────────────────────────────────────────────────────────────

@router.get("/memories/today")
async def get_memories_today(
    device_id: str,
    authorization: str = Header(None),
    token: str = None,
):
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    verify_known_device_by_id(device_id)
    return await asyncio.to_thread(memories.get_todays_memories, device_id)


@router.get("/memories/recent")
async def get_memories_recent(
    device_id: str,
    days: int = 7,
    authorization: str = Header(None),
    token: str = None,
):
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    verify_known_device_by_id(device_id)
    return await asyncio.to_thread(memories.get_recent_memories, device_id, days)


@router.post("/memories/reindex")
async def reindex_memories(
    device_id: str,
    authorization: str = Header(None),
    token: str = None,
):
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    verify_known_device_by_id(device_id)
    threading.Thread(target=memories.reindex_all, daemon=True).start()
    return {"ok": True}


@router.get("/memories/flashback")
async def get_memories_flashback(
    device_id: str,
    authorization: str = Header(None),
    token: str = None,
):
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    verify_known_device_by_id(device_id)
    return await asyncio.to_thread(memories.get_random_flashback, device_id)


@router.get("/memories/wrapped")
async def get_memories_wrapped(
    device_id: str,
    year: int,
    authorization: str = Header(None),
    token: str = None,
):
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    verify_known_device_by_id(device_id)
    if year < 1970 or year > 2100:
        raise HTTPException(status_code=400, detail="Invalid year")
    return await asyncio.to_thread(memories.get_wrapped, device_id, year)


@router.get("/memories/quiz")
async def get_memories_quiz(
    device_id: str,
    count: int = 10,
    authorization: str = Header(None),
    token: str = None,
):
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    verify_known_device_by_id(device_id)
    count = max(1, min(count, 30))
    return await asyncio.to_thread(memories.get_quiz_round, device_id, count)


@router.get("/memories/roulette")
async def get_memories_roulette(
    device_id: str,
    authorization: str = Header(None),
    token: str = None,
):
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    verify_known_device_by_id(device_id)
    return await asyncio.to_thread(memories.get_roulette_item, device_id)


@router.get("/memories/places")
async def get_memories_places(
    device_id: str,
    authorization: str = Header(None),
    token: str = None,
):
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    verify_known_device_by_id(device_id)
    return await asyncio.to_thread(memories.get_place_clusters, device_id)


@router.get("/memories/places/{cluster_key}")
async def get_memories_place_items(
    device_id: str,
    cluster_key: str,
    authorization: str = Header(None),
    token: str = None,
):
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    verify_known_device_by_id(device_id)
    return await asyncio.to_thread(memories.get_place_items, device_id, cluster_key)


# ──────────────────────────────────────────────────────────────────────────────
# Rewind Reel Endpoints
# ──────────────────────────────────────────────────────────────────────────────

@router.post("/memories/rewind/generate")
async def generate_rewind_reel(
    device_id: str,
    year: int,
    month: int | None = None,
    authorization: str = Header(None),
    token: str = None,
):
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    verify_known_device_by_id(device_id)
    if year < 1970 or year > 2100:
        raise HTTPException(status_code=400, detail="Invalid year")
    if month is not None and (month < 1 or month > 12):
        raise HTTPException(status_code=400, detail="Invalid month")
    return await asyncio.to_thread(rewind.start_rewind_build, device_id, year, month)


@router.get("/memories/rewind/status")
async def get_rewind_reel_status(
    device_id: str,
    year: int,
    month: int | None = None,
    authorization: str = Header(None),
    token: str = None,
):
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    verify_known_device_by_id(device_id)
    if year < 1970 or year > 2100:
        raise HTTPException(status_code=400, detail="Invalid year")
    if month is not None and (month < 1 or month > 12):
        raise HTTPException(status_code=400, detail="Invalid month")
    return await asyncio.to_thread(rewind.get_rewind_status, device_id, year, month)


@router.get("/memories/rewind/stream")
async def stream_rewind_reel(
    device_id: str,
    year: int,
    request: Request,
    month: int | None = None,
    authorization: str = Header(None),
    token: str = None,
):
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    verify_known_device_by_id(device_id)
    if year < 1970 or year > 2100:
        raise HTTPException(status_code=400, detail="Invalid year")
    if month is not None and (month < 1 or month > 12):
        raise HTTPException(status_code=400, detail="Invalid month")
    path = await asyncio.to_thread(rewind.get_rewind_path, device_id, year, month)
    if not path:
        raise HTTPException(status_code=404, detail="Reel not ready")
    return _file_range_response(path, request)