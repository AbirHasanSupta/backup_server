import asyncio
from email.utils import formatdate
from mimetypes import guess_type
import os
import re
import shutil
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

from config import load_config, APP_DATA_DIR
from database import (
    batch_check_files,
    find_device_by_name_model,
    get_stats,
    get_device_stats,
    get_devices,
    get_files_for_device,
    search_files_for_device,
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
    set_device_username,
    ensure_device_token,
    verify_device_token, get_files_browse,
    get_cleanup_candidates,
    get_upload_cache,
    log_cleanup_deletions,
    get_trips,
    get_trip_media,
    toggle_reaction,
    get_media_reactions,
    get_reactions_for_media_ids,
    get_or_create_media_id,
    get_comment_counts_for_media_ids,
    add_comment,
    get_comments_for_media,
    delete_comment,
    is_media_or_post_creator,
    get_share_target_devices,
    create_device_share,
    get_device_shares_for_target,
    get_device_shares_by_sharer,
    get_device_share_by_id,
    get_share_targets_for_group,
    delete_device_share_group,
    delete_device_share,
    remove_share_group_target,
    remove_share_target,
    is_share_target,
    get_unseen_share_notifications,
    mark_share_notifications_seen,
    add_share_group_targets,
    edit_device_share_group_caption,
    MAX_COMMENT_LENGTH,
)
from trips import cluster_source_media, trigger_background_clustering
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

APP_VERSION = "4.1.2"


# ──────────────────────────────────────────────────────────────────────────────
# Auth helper
# ──────────────────────────────────────────────────────────────────────────────

def format_display_name(username: str | None, device_name: str | None) -> str | None:
    """Primary: username (device_name). Fallback: device_name only."""
    username = (username or "").strip() or None
    device_name = (device_name or "").strip() or None
    if username and device_name:
        return f"{username} ({device_name})"
    return username or device_name


def _extract_bearer(authorization: str | None) -> str | None:
    if not authorization or not isinstance(authorization, str) or not authorization.startswith("Bearer "):
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


def get_all_local_ips() -> list[str]:
    """
    Returns all active, non-loopback, non-link-local IPv4 addresses across
    all network interfaces on the host.
    """
    ips = set()
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            outbound_ip = s.getsockname()[0]
            if outbound_ip and not outbound_ip.startswith("127."):
                ips.add(outbound_ip)
    except Exception:
        pass

    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if ip and not ip.startswith("127.") and not ip.startswith("169.254."):
                ips.add(ip)
    except Exception:
        pass

    try:
        _, _, host_ips = socket.gethostbyname_ex(socket.gethostname())
        for ip in host_ips:
            if ip and not ip.startswith("127.") and not ip.startswith("169.254."):
                ips.add(ip)
    except Exception:
        pass

    res = list(ips)
    return res if res else ["127.0.0.1"]


# ──────────────────────────────────────────────────────────────────────────────
# Discovery / health-check
# ──────────────────────────────────────────────────────────────────────────────

@router.get("/ping")
async def ping():
    """
    LAN discovery endpoint.
    The Android app scans the subnet(s) and identifies backup servers by this response.
    """
    local_ips = get_all_local_ips()
    hostname = socket.gethostname()
    cfg = load_config()
    return {
        "status": "ok",
        "name": hostname,
        "hostname": f"{hostname}.local",
        "version": APP_VERSION,
        "all_ips": local_ips,
        "port": int(cfg.get("PORT", 8000)),
    }


# ──────────────────────────────────────────────────────────────────────────────
# Device connection / approval
# ──────────────────────────────────────────────────────────────────────────────

class ConnectRequest(BaseModel):
    device_name: str
    device_id: str | None = None
    device_model: str | None = None
    username: str | None = None


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
    username = (body.username or "").strip() or None

    def accepted_response() -> dict:
        local_ips = get_all_local_ips()
        hostname = socket.gethostname()
        resp = {
            "status": "accepted",
            "all_ips": local_ips,
            "hostname": hostname,
        }
        if device_id:
            token = ensure_device_token(device_id)
            resp["token"] = token
        return resp

    # Already registered — just refresh the record, no dialog needed
    if is_device_known(device_ip, device_id):
        upsert_device(device_name, device_ip, device_id, device_model, username)
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
            upsert_device(device_name, device_ip, device_id, device_model, username)
            stats = get_device_stats(device_ip, device_id=device_id)
            resp = accepted_response()
            resp["recovery_available"] = True
            resp["files_backed_up"] = stats["total_files"]
            return resp

    add_log(f"📱 New connection request: {device_name} ({device_id or device_ip})")

    if not load_config().get("REQUIRE_APPROVAL", True):
        upsert_device(device_name, device_ip, device_id, device_model, username)
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
        upsert_device(device_name, device_ip, device_id, device_model, username)
        return accepted_response()

    return {"status": "rejected"}


# ──────────────────────────────────────────────────────────────────────────────
# Device management
# ──────────────────────────────────────────────────────────────────────────────

@router.get("/devices")
async def list_devices(authorization: str = Header(None)):
    """Returns the list of accepted connected devices."""
    verify_auth(authorization)
    devices = await asyncio.to_thread(get_devices)
    for d in devices:
        d["display_name"] = format_display_name(d.get("username"), d.get("device_name"))
    return {"devices": devices}


@router.delete("/devices/{device_id}")
async def delete_device(device_id: int, authorization: str = Header(None)):
    """Removes a device from the connected-devices list."""
    verify_auth(authorization)
    await asyncio.to_thread(remove_device, device_id)
    add_log(f"🗑️ Device #{device_id} removed via API")
    return {"status": "removed"}


class UsernameUpdateRequest(BaseModel):
    username: str | None = None


@router.post("/devices/{device_id}/username")
async def update_device_username(
    device_id: str,
    body: UsernameUpdateRequest,
    authorization: str = Header(None),
):
    """Set or clear a device's display username. device_id may be its own token."""
    verify_auth(authorization, device_id)
    await asyncio.to_thread(set_device_username, device_id, body.username)
    return {"status": "ok", "username": (body.username or "").strip() or None}


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
        "all_ips": get_all_local_ips(),
        "hostname": socket.gethostname(),
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
    if device_id:
        trigger_background_clustering(device_id)

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
async def list_files(device_id: str, prefix: str = "", authorization: str = Header(None), token: str = None):
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    verify_known_device_by_id(device_id)
    files = await asyncio.to_thread(get_files_for_device, device_id, prefix)
    return {"files": files}


@router.get("/files/browse")
async def browse_files(device_id: str, prefix: str = "", authorization: str = Header(None), token: str = None):
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    verify_known_device_by_id(device_id)
    norm_prefix = prefix.strip("/")
    norm_prefix = f"{norm_prefix}/" if norm_prefix else ""
    folders, files = await asyncio.to_thread(get_files_browse, device_id, norm_prefix)
    return {"folders": folders, "files": files}


@router.get("/files/search")
async def search_files(device_id: str, q: str, authorization: str = Header(None), token: str = None):
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    verify_known_device_by_id(device_id)
    q = q.strip()
    if not q:
        return {"files": []}
    files = await asyncio.to_thread(search_files_for_device, device_id, q)
    return {"files": files}


def _enrich_shared_files_with_reactions(source_id: str, files: list[dict], device_id: str | None = None) -> list[dict]:
    if not files:
        return []
    media_ids = []
    for f in files:
        mid = get_or_create_media_id("shared", source_id, f["path"], f.get("size", 0), f.get("modified_time", 0))
        f["media_id"] = mid
        media_ids.append(mid)

    counts_map, user_map = get_reactions_for_media_ids(media_ids, current_source_id=device_id)
    comment_counts = get_comment_counts_for_media_ids(media_ids)
    video_exts = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".3gp", ".m4v", ".wmv"}
    for f in files:
        mid = f["media_id"]
        f["reaction_counts"] = counts_map.get(mid, {})
        f["user_reactions"] = user_map.get(mid, [])
        f["comment_count"] = comment_counts.get(mid, 0)
        ext = ("." + f["path"].rsplit(".", 1)[-1].lower()) if "." in f["path"] else ""
        f["is_video"] = ext in video_exts
    return files


def _search_shared_dir(root: str, query: str, limit: int = 500) -> list[dict]:
    query = query.lower()
    results = []
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace("\\", "/")
            # Match against the full relative path so folder names — and every
            # descendant of a matching folder — are searchable, not just filenames.
            if query not in rel.lower():
                continue
            try:
                stat = os.stat(full)
            except OSError:
                continue
            results.append({"path": rel, "size": stat.st_size, "modified_time": int(stat.st_mtime)})
            if len(results) >= limit:
                return results
    return results


# Media extensions surfaced in feeds (shared-folder + device-to-device shares).
_FEED_MEDIA_EXTS = {
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif",
    ".bmp", ".tiff", ".tif", ".avif",
    ".mp4", ".mov", ".avi", ".mkv", ".webm", ".3gp", ".m4v", ".wmv",
}


def _collect_shared_media(root: str) -> list[dict]:
    """Walk a shared-folder root, returning media files (path/size/modified_time), newest first."""
    all_files = []
    for dirpath, _dirs, filenames in os.walk(root):
        for fname in filenames:
            ext = os.path.splitext(fname)[1].lower()
            if ext not in _FEED_MEDIA_EXTS:
                continue
            full = os.path.join(dirpath, fname)
            try:
                st = os.stat(full)
                rel = os.path.relpath(full, root).replace("\\", "/")
                all_files.append({
                    "path": rel,
                    "size": st.st_size,
                    "modified_time": int(st.st_mtime),
                })
            except OSError:
                continue
    all_files.sort(key=lambda x: x["modified_time"], reverse=True)
    return all_files


@router.get("/shared/{source_id}/search")
@router.get("/api/shared/{source_id}/search")
async def search_shared_files(
        source_id: str,
        q: str,
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
    q = q.strip()
    if not q:
        return {"files": []}
    root = os.path.abspath(entry["path"])
    if not os.path.isdir(root):
        return {"files": []}
    files = await asyncio.to_thread(_search_shared_dir, root, q)
    enriched = await asyncio.to_thread(_enrich_shared_files_with_reactions, source_id, files, device_id)
    return {"files": enriched}


@router.get("/shared/{source_id}/browse")
@router.get("/api/shared/{source_id}/browse")
async def browse_shared_files(
        source_id: str,
        prefix: str = "",
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
                    count = 0
                    total_size = 0
                    try:
                        for dirpath, _dirs, filenames in os.walk(e.path):
                            for fname in filenames:
                                try:
                                    st = os.stat(os.path.join(dirpath, fname))
                                    count += 1
                                    total_size += st.st_size
                                except OSError:
                                    pass
                    except OSError:
                        pass
                    folders.append({"name": e.name, "path": rel, "file_count": count, "total_size": total_size})
                else:
                    stat = e.stat()
                    files.append({"path": rel, "size": stat.st_size, "modified_time": int(stat.st_mtime)})
            except OSError:
                continue
        return folders, files

    folders, files = await asyncio.to_thread(_scan)
    enriched_files = await asyncio.to_thread(_enrich_shared_files_with_reactions, source_id, files, device_id)
    return {"folders": folders, "files": enriched_files}


@router.get("/shared/{source_id}/feed")
@router.get("/api/shared/{source_id}/feed")
async def get_shared_feed(
        source_id: str,
        device_id: str | None = None,
        authorization: str = Header(None),
        token: str = None,
):
    """
    Return a flat, chronological feed of media items in the shared folder
    with attached reaction counts and the user's reaction status.
    """
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    entry = _find_shared_dir(source_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Shared source not found")
    if not _is_folder_tagged_for_device(entry, device_id, authorization, token):
        raise HTTPException(status_code=403, detail="Shared source not tagged for this device")

    root = os.path.abspath(entry["path"])
    if not os.path.isdir(root):
        return {"items": [], "source_id": source_id, "label": entry["label"]}

    def _collect_feed():
        all_files = _collect_shared_media(root)
        return _enrich_shared_files_with_reactions(source_id, all_files, device_id)

    items = await asyncio.to_thread(_collect_feed)
    return {"items": items, "source_id": source_id, "label": entry["label"]}


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


@router.get("/sync/upload-cache")
async def sync_upload_cache(
    device_id: str,
    request: Request,
    authorization: str = Header(None),
):
    """Return the server's upload index for a device so the phone can rebuild its
    local upload cache after a reinstall without re-uploading every file."""
    verify_auth(authorization, device_id)
    verify_known_device_by_id(device_id)
    cache = await asyncio.to_thread(get_upload_cache, device_id, request.client.host)
    return cache


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

    if body.device_id and body.uploaded > 0:
        trigger_background_clustering(body.device_id)

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
        prefix: str = "",
        device_id: str | None = None,
        authorization: str = Header(None),
        token: str = None,
):
    """
    Recursively list files inside the shared directory identified by *source_id*,
    optionally filtered by *prefix*.
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

    norm_prefix = prefix.strip("/").replace("\\", "/")
    target_dir = os.path.join(root, norm_prefix) if norm_prefix else root
    target_dir = os.path.abspath(target_dir)
    if os.path.commonpath([root, target_dir]) != root:
        raise HTTPException(status_code=400, detail="Invalid path")
    if not os.path.isdir(target_dir):
        return {"files": [], "source_id": source_id, "label": entry["label"]}

    def _walk():
        files = []
        for dirpath, _dirnames, filenames in os.walk(target_dir):
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
    return {"files": files, "source_id": source_id, "label": entry["label"]}


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


# ──────────────────────────────────────────────────────────────────────────────
# Cleanup / Free-up-storage endpoints
# ──────────────────────────────────────────────────────────────────────────────

class CleanupDeleteItem(BaseModel):
    path: str
    size: int = 0
    file_id: int | None = None


class CleanupDeleteRequest(BaseModel):
    source_id: str
    files: list[CleanupDeleteItem]


@router.get("/cleanup/candidates")
async def cleanup_candidates(
    source_id: str,
    authorization: str = Header(None),
):
    """
    Return files for this device that are confirmed backed up on disk and have
    not yet been cleaned from the phone.  Used to pre-populate the "Free up
    storage" review screen and to retrieve already-cleaned paths so the phone
    can exclude them from its local scan.
    """
    verify_auth(authorization, source_id)
    verify_known_device_by_id(source_id)
    candidates = await asyncio.to_thread(get_cleanup_candidates, source_id)
    total_size = sum(c["size"] for c in candidates)
    return {
        "candidates": candidates,
        "total_size": total_size,
        "count": len(candidates),
    }


@router.post("/cleanup/delete")
async def cleanup_delete(
    body: CleanupDeleteRequest,
    authorization: str = Header(None),
):
    """
    Record that the client deleted a batch of phone-side files.
    The server does NOT touch its own backup copies — it only logs the
    deletion in cleanup_log so the files are excluded from future candidate
    lists and can be audited later.
    """
    verify_auth(authorization, body.source_id)
    verify_known_device_by_id(body.source_id)
    items = [
        {"path": f.path, "size": f.size, "file_id": f.file_id}
        for f in body.files
    ]
    result = await asyncio.to_thread(log_cleanup_deletions, body.source_id, items)
    add_log(
        f"🗑️  Cleanup: {body.source_id} freed "
        f"{result['total_bytes_freed'] / (1024 ** 3):.2f} GB "
        f"({len(body.files)} files)"
    )
    return result


# ──────────────────────────────────────────────────────────────────────────────
# Auto-generated Trips Endpoints
# ──────────────────────────────────────────────────────────────────────────────

@router.get("/api/trips")
@router.get("/trips")
async def list_trips(
    source_id: str | None = None,
    device_id: str | None = None,
    authorization: str = Header(None),
    token: str = None,
):
    target_id = source_id or device_id
    if not target_id:
        raise HTTPException(status_code=400, detail="Missing source_id")
    verify_auth(authorization or (f"Bearer {token}" if token else None), target_id)
    trips = await asyncio.to_thread(get_trips, target_id)
    return {"trips": trips}


@router.get("/api/trips/{trip_id}/media")
@router.get("/trips/{trip_id}/media")
async def get_trip_media_items(
    trip_id: int,
    device_id: str | None = None,
    authorization: str = Header(None),
    token: str = None,
):
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    trip, media = await asyncio.to_thread(get_trip_media, trip_id)
    if not trip:
        raise HTTPException(status_code=404, detail="Trip not found")
    return {"trip": trip, "media": media}


@router.post("/api/trips/recluster")
@router.post("/trips/recluster")
async def recluster_trips(
    source_id: str | None = None,
    device_id: str | None = None,
    authorization: str = Header(None),
    token: str = None,
):
    target_id = source_id or device_id
    if not target_id:
        raise HTTPException(status_code=400, detail="Missing source_id")
    verify_auth(authorization or (f"Bearer {token}" if token else None), target_id)
    clusters = await asyncio.to_thread(cluster_source_media, target_id)
    trips = await asyncio.to_thread(get_trips, target_id)
    return {"ok": True, "clusters_found": len(clusters), "trips": trips}


# ──────────────────────────────────────────────────────────────────────────────
# Media Reactions Endpoints
# ──────────────────────────────────────────────────────────────────────────────

class ReactRequest(BaseModel):
    source_id: str
    emoji: str


@router.post("/api/media/{media_id}/react")
@router.post("/media/{media_id}/react")
async def react_to_media(
    media_id: int,
    body: ReactRequest,
    authorization: str = Header(None),
    token: str = None,
):
    verify_auth(authorization or (f"Bearer {token}" if token else None), body.source_id)
    emoji = body.emoji.strip()
    if not emoji:
        raise HTTPException(status_code=400, detail="Emoji cannot be empty")
    try:
        res = await asyncio.to_thread(toggle_reaction, media_id, body.source_id, emoji)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return res


@router.get("/api/media/{media_id}/reactions")
@router.get("/media/{media_id}/reactions")
async def get_reactions(
    media_id: int,
    device_id: str | None = None,
    authorization: str = Header(None),
    token: str = None,
):
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    result = await asyncio.to_thread(get_media_reactions, media_id)
    for r in result["reactions"]:
        r["display_name"] = format_display_name(r.get("username"), r.get("device_name")) or r["source_id"]
        r["is_own"] = device_id is not None and r["source_id"] == device_id
    return result


# ──────────────────────────────────────────────────────────────────────────────
# Media Comments Endpoints
# ──────────────────────────────────────────────────────────────────────────────

class CommentRequest(BaseModel):
    source_id: str
    text: str


class CommentDeleteRequest(BaseModel):
    source_id: str


@router.get("/api/media/{media_id}/comments")
@router.get("/media/{media_id}/comments")
async def list_media_comments(
    media_id: int,
    device_id: str | None = None,
    authorization: str = Header(None),
    token: str = None,
):
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    comments = await asyncio.to_thread(get_comments_for_media, media_id)
    is_post_creator = False
    if device_id:
        is_post_creator = await asyncio.to_thread(is_media_or_post_creator, media_id, device_id)
    for c in comments:
        c["is_own"] = (device_id is not None and c["source_id"] == device_id)
        c["can_delete"] = c["is_own"] or is_post_creator
        c["display_name"] = format_display_name(c.get("username"), c.get("device_name"))
    return {"comments": comments}


@router.post("/api/media/{media_id}/comments")
@router.post("/media/{media_id}/comments")
async def add_media_comment(
    media_id: int,
    body: CommentRequest,
    authorization: str = Header(None),
    token: str = None,
):
    verify_auth(authorization or (f"Bearer {token}" if token else None), body.source_id)
    verify_known_device_by_id(body.source_id)
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Comment cannot be empty")
    if len(text) > MAX_COMMENT_LENGTH:
        text = text[:MAX_COMMENT_LENGTH]
    comment = await asyncio.to_thread(add_comment, media_id, body.source_id, text)
    comment["is_own"] = True
    comment["can_delete"] = True
    # Ensure display_name is present (add_comment now returns it, but guard for safety)
    if "display_name" not in comment:
        comment["display_name"] = format_display_name(
            comment.get("username"), comment.get("device_name")
        ) or comment.get("device_name") or body.source_id
    return comment


@router.post("/api/comments/{comment_id}/delete")
@router.post("/comments/{comment_id}/delete")
async def delete_media_comment(
    comment_id: int,
    body: CommentDeleteRequest,
    authorization: str = Header(None),
    token: str = None,
):
    verify_auth(authorization or (f"Bearer {token}" if token else None), body.source_id)
    ok = await asyncio.to_thread(delete_comment, comment_id, body.source_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Comment not found or not yours")
    return {"ok": True}


# ──────────────────────────────────────────────────────────────────────────────
# Device-to-Device Sharing Endpoints
# ──────────────────────────────────────────────────────────────────────────────

SHARED_REWIND_DIR = os.path.join(APP_DATA_DIR, "shared_rewind_reels")
os.makedirs(SHARED_REWIND_DIR, exist_ok=True)


def _persist_shared_rewind_reel(source_key: str, relative_path: str) -> str:
    """Copy the live (session-cached) rewind reel into a durable location so
    the share survives server restarts / cache clears. Only deleted when the
    owning share/post is deleted (see database._cleanup_rewind_shared_files).
    """
    year_str, _, month_str = relative_path.partition("-")
    live_path = rewind.get_rewind_path(source_key, int(year_str), int(month_str) if month_str else None)
    if not live_path or not os.path.isfile(live_path):
        raise HTTPException(status_code=404, detail="Reel not ready")
    dest_path = os.path.join(SHARED_REWIND_DIR, f"{uuid.uuid4().hex}.mp4")
    shutil.copy2(live_path, dest_path)
    return dest_path


class ShareItem(BaseModel):
    source_type: str
    source_key: str
    relative_path: str
    size: int = 0
    modified_time: int = 0


class CreateShareRequest(BaseModel):
    shared_by_device_id: str
    target_device_ids: list[str]
    caption: str | None = None
    items: list[ShareItem]
    post_kind: str | None = None
    post_title: str | None = None


@router.get("/api/share/devices")
@router.get("/share/devices")
async def list_share_target_devices(
    device_id: str,
    authorization: str = Header(None),
    token: str = None,
):
    """Return accepted devices this device can share to. SAFE FIELDS ONLY — never token."""
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    verify_known_device_by_id(device_id)
    devices = await asyncio.to_thread(get_share_target_devices, device_id)
    for d in devices:
        d["display_name"] = format_display_name(d.get("username"), d.get("device_name"))
    return {"devices": devices}


@router.post("/api/share/create")
@router.post("/share/create")
async def create_share(
    body: CreateShareRequest,
    authorization: str = Header(None),
    token: str = None,
):
    verify_auth(authorization or (f"Bearer {token}" if token else None), body.shared_by_device_id)
    verify_known_device_by_id(body.shared_by_device_id)

    if not body.items:
        raise HTTPException(status_code=400, detail="No items to share")
    if not body.target_device_ids:
        raise HTTPException(status_code=400, detail="No target devices")

    # Authorize every item for the sharer: phone media must belong to them; a
    # shared folder must be tagged for them.
    for it in body.items:
        if it.source_type == "phone":
            if it.source_key != body.shared_by_device_id:
                raise HTTPException(status_code=403, detail="Cannot share another device's phone media")
        elif it.source_type == "shared":
            entry = _find_shared_dir(it.source_key)
            if not entry or not _is_folder_tagged_for_device(entry, body.shared_by_device_id, authorization, token):
                raise HTTPException(status_code=403, detail="Shared folder not available for this device")
        elif it.source_type == "rewind":
            if it.source_key != body.shared_by_device_id:
                raise HTTPException(status_code=403, detail="Cannot share another device's rewind reel")
        else:
            raise HTTPException(status_code=400, detail="Invalid share source type")

    # Restrict targets to known accepted devices (excluding the sharer).
    known_ids = {
        d["device_id"]
        for d in await asyncio.to_thread(get_share_target_devices, body.shared_by_device_id)
    }
    targets = [t for t in body.target_device_ids if t in known_ids]
    if not targets:
        raise HTTPException(status_code=400, detail="No valid target devices")

    persisted_paths: list[str] = []
    try:
        for it in body.items:
            if it.source_type == "rewind":
                persisted = await asyncio.to_thread(
                    _persist_shared_rewind_reel, it.source_key, it.relative_path
                )
                persisted_paths.append(persisted)
                it.relative_path = persisted
                it.source_type = "rewind_shared"
    except Exception:
        for p in persisted_paths:
            try:
                os.remove(p)
            except OSError:
                pass
        raise

    items = [
        {
            "source_type": it.source_type,
            "source_key": it.source_key,
            "relative_path": it.relative_path,
            "size": it.size,
            "modified_time": it.modified_time,
        }
        for it in body.items
    ]
    result = await asyncio.to_thread(
        create_device_share, body.shared_by_device_id, targets, body.caption, items,
        body.post_kind, body.post_title,
    )
    if not result.get("ok"):
        for p in persisted_paths:
            try:
                os.remove(p)
            except OSError:
                pass
    return result


@router.get("/api/feed")
@router.get("/feed")
async def get_unified_feed(
    device_id: str,
    offset: int = 0,
    limit: int = 50,
    authorization: str = Header(None),
    token: str = None,
):
    """Device-to-device shares feed for this device.

    Returns shares received by this device plus shares sent by this device,
    grouped into posts by share_group_id. Supports pagination via offset/limit.
    Results are sorted newest-first (by group created_at).
    """
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    verify_known_device_by_id(device_id)

    def _build():
        video_exts = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".3gp", ".m4v", ".wmv"}

        # 1. Shares received by this device
        received = get_device_shares_for_target(device_id)
        # 2. Shares sent by this device (to see/manage own posts)
        sent = get_device_shares_by_sharer(device_id)

        # Deduplicate: a sender also appears in their own sent list but not received.
        # Use (share_id) as the dedup key.
        seen_share_ids: set[int] = set()
        all_shares: list[dict] = []
        for s in received:
            if s["share_id"] not in seen_share_ids:
                seen_share_ids.add(s["share_id"])
                all_shares.append({**s, "is_own_post": s["shared_by_device_id"] == device_id})
        for s in sent:
            if s["share_id"] not in seen_share_ids:
                seen_share_ids.add(s["share_id"])
                all_shares.append({**s, "is_own_post": True})

        # Group shares by share_group_id (or fall back to share_id as a singleton group)
        from collections import OrderedDict
        groups: OrderedDict[str, dict] = OrderedDict()
        for s in all_shares:
            gid = s.get("share_group_id") or f"__solo__{s['share_id']}"
            if gid not in groups:
                groups[gid] = {
                    "group_id": gid,
                    "caption": s.get("group_caption") or s.get("caption"),
                    "shared_by": format_display_name(s.get("shared_by_username"), s.get("shared_by_name")) or s["shared_by_device_id"],
                    "shared_by_device_id": s["shared_by_device_id"],
                    "created_at": s["created_at"],
                    "is_own_post": s["is_own_post"],
                    "post_kind": s.get("post_kind"),
                    "post_title": s.get("post_title"),
                    "items": [],
                }
            ext = os.path.splitext(s["relative_path"])[1].lower()
            groups[gid]["items"].append({
                "share_id": s["share_id"],
                "media_id": s["media_id"],
                "path": s["relative_path"],
                "size": s["size"],
                "modified_time": s["modified_time"],
                "is_video": s["source_type"] in ("rewind", "rewind_shared") or ext in video_exts,
            })

        # Sort groups newest-first by created_at
        sorted_groups = sorted(groups.values(), key=lambda g: g["created_at"], reverse=True)

        # Collect all share_ids and media_ids for bulk reaction/comment fetch
        all_share_ids = [item["share_id"] for g in sorted_groups for item in g["items"]]
        all_media_ids = [item["media_id"] for g in sorted_groups for item in g["items"]]

        # Use first item's media_id as the reaction anchor for the group
        counts_map, user_map = get_reactions_for_media_ids(all_media_ids, current_source_id=device_id)
        comment_counts = get_comment_counts_for_media_ids(all_media_ids)

        # Build final post list with reaction/comment data attached to group
        posts = []
        for g in sorted_groups:
            anchor_mid = g["items"][0]["media_id"] if g["items"] else None
            posts.append({
                "kind": "share",
                "group_id": g["group_id"],
                "caption": g["caption"],
                "shared_by": g["shared_by"],
                "shared_by_device_id": g["shared_by_device_id"],
                "created_at": g["created_at"],
                "is_own_post": g["is_own_post"],
                "post_kind": g.get("post_kind"),
                "post_title": g.get("post_title"),
                "media_id": anchor_mid,
                "reaction_counts": counts_map.get(anchor_mid, {}) if anchor_mid else {},
                "user_reactions": user_map.get(anchor_mid, []) if anchor_mid else [],
                "comment_count": comment_counts.get(anchor_mid, 0) if anchor_mid else 0,
                "items": g["items"],
            })

        total = len(posts)
        page = posts[offset: offset + limit]
        has_more = (offset + limit) < total
        return page, has_more, total

    page, has_more, total = await asyncio.to_thread(_build)
    return {"items": page, "has_more": has_more, "total": total}


@router.get("/api/notifications/pending")
@router.get("/notifications/pending")
async def get_pending_share_notifications(
    device_id: str,
    authorization: str = Header(None),
    token: str = None,
):
    """Post groups shared to this device that it hasn't been notified about yet."""
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    verify_known_device_by_id(device_id)
    posts = await asyncio.to_thread(get_unseen_share_notifications, device_id)
    for p in posts:
        p["shared_by"] = format_display_name(p.get("shared_by_username"), p.get("shared_by_name")) or p["shared_by_device_id"]
    return {"posts": posts}


class MarkNotificationsSeenRequest(BaseModel):
    device_id: str
    group_ids: list[str]


@router.post("/api/notifications/seen")
@router.post("/notifications/seen")
async def mark_pending_share_notifications_seen(
    body: MarkNotificationsSeenRequest,
    authorization: str = Header(None),
    token: str = None,
):
    verify_auth(authorization or (f"Bearer {token}" if token else None), body.device_id)
    verify_known_device_by_id(body.device_id)
    await asyncio.to_thread(mark_share_notifications_seen, body.device_id, body.group_ids)
    return {"ok": True}


# ──────────────────────────────────────────────────────────────────────────────
# Share Group Management Endpoints
# ──────────────────────────────────────────────────────────────────────────────

class RemoveShareTargetRequest(BaseModel):
    device_id: str  # the target device to remove


@router.get("/api/share/group/{group_id}/targets")
@router.get("/share/group/{group_id}/targets")
async def get_share_group_targets(
    group_id: str,
    device_id: str,
    authorization: str = Header(None),
    token: str = None,
):
    """List all target devices for a share group. Only the group owner may call this."""
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    verify_known_device_by_id(device_id)
    targets = await asyncio.to_thread(get_share_targets_for_group, group_id, device_id)
    for t in targets:
        t["display_name"] = format_display_name(t.get("username"), t.get("device_name"))
    return {"targets": targets}


@router.post("/api/share/group/{group_id}/delete")
@router.post("/share/group/{group_id}/delete")
async def delete_share_group(
    group_id: str,
    device_id: str,
    authorization: str = Header(None),
    token: str = None,
):
    """Delete a share group and all its items. Only the original sharer may do this."""
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    verify_known_device_by_id(device_id)
    ok = await asyncio.to_thread(delete_device_share_group, group_id, device_id)
    if not ok:
        raise HTTPException(status_code=403, detail="Not authorized or group not found")
    return {"ok": True}


@router.post("/api/share/group/{group_id}/remove_target")
@router.post("/share/group/{group_id}/remove_target")
async def remove_share_group_target_endpoint(
    group_id: str,
    body: RemoveShareTargetRequest,
    device_id: str,
    authorization: str = Header(None),
    token: str = None,
):
    """Remove a specific target device from a share group. Sharer or self-removal allowed."""
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    verify_known_device_by_id(device_id)
    ok = await asyncio.to_thread(
        remove_share_group_target, group_id, body.device_id, device_id
    )
    if not ok:
        raise HTTPException(status_code=403, detail="Not authorized or group not found")
    return {"ok": True}


@router.post("/api/share/{share_id}/delete")
@router.post("/share/{share_id}/delete")
async def delete_share_by_id_endpoint(
    share_id: int,
    device_id: str,
    authorization: str = Header(None),
    token: str = None,
):
    """Delete a share by its share_id. Only the original sharer may do this."""
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    verify_known_device_by_id(device_id)
    ok = await asyncio.to_thread(delete_device_share, share_id, device_id)
    if not ok:
        raise HTTPException(status_code=403, detail="Not authorized or share not found")
    return {"ok": True}


@router.post("/api/share/{share_id}/remove_target")
@router.post("/share/{share_id}/remove_target")
async def remove_share_target_by_id_endpoint(
    share_id: int,
    body: RemoveShareTargetRequest,
    device_id: str,
    authorization: str = Header(None),
    token: str = None,
):
    """Remove a specific target device from a share. Sharer or self-removal allowed."""
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    verify_known_device_by_id(device_id)
    ok = await asyncio.to_thread(
        remove_share_target, share_id, body.device_id, device_id
    )
    if not ok:
        raise HTTPException(status_code=403, detail="Not authorized or share not found")
    return {"ok": True}




# ──────────────────────────────────────────────────────────────────────────────
# Device list endpoint (for recipient management)
# ──────────────────────────────────────────────────────────────────────────────

@router.get("/api/devices")
@router.get("/devices")
async def list_all_devices(
    device_id: str,
    authorization: str = Header(None),
    token: str = None,
):
    """Return all accepted devices (safe fields only). Used for recipient management."""
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    verify_known_device_by_id(device_id)
    devices = await asyncio.to_thread(get_share_target_devices, device_id)
    for d in devices:
        d["display_name"] = format_display_name(d.get("username"), d.get("device_name")) or d.get("device_name") or d.get("device_id", "")
    return {"devices": devices}


class AddShareTargetRequest(BaseModel):
    device_id: str  # the device to add as recipient


@router.post("/api/share/group/{group_id}/add_target")
@router.post("/share/group/{group_id}/add_target")
async def add_share_group_target_endpoint(
    group_id: str,
    body: AddShareTargetRequest,
    device_id: str,
    authorization: str = Header(None),
    token: str = None,
):
    """Add a device as a recipient of a share group. Only the group owner may call this."""
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    verify_known_device_by_id(device_id)
    ok = await asyncio.to_thread(
        add_share_group_targets, group_id, [body.device_id], device_id
    )
    if not ok:
        raise HTTPException(status_code=403, detail="Not authorized or group not found")
    return {"ok": True}


class EditCaptionRequest(BaseModel):
    caption: str | None = None


@router.post("/api/share/group/{group_id}/edit_caption")
@router.post("/share/group/{group_id}/edit_caption")
async def edit_share_group_caption_endpoint(
    group_id: str,
    body: EditCaptionRequest,
    device_id: str,
    authorization: str = Header(None),
    token: str = None,
):
    """Edit the caption of a share group. Only the group owner may call this."""
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    verify_known_device_by_id(device_id)
    caption = (body.caption or "").strip() or None
    ok = await asyncio.to_thread(
        edit_device_share_group_caption, group_id, device_id, caption
    )
    if not ok:
        raise HTTPException(status_code=403, detail="Not authorized or group not found")
    return {"ok": True, "caption": caption}


def _authorize_share_access(share_id: int, device_id: str) -> dict:
    """Return the share row if device_id is its recipient or its sharer, else raise."""
    share = get_device_share_by_id(share_id)
    if not share:
        raise HTTPException(status_code=404, detail="Share not found")
    if not (share["shared_by_device_id"] == device_id or is_share_target(share_id, device_id)):
        raise HTTPException(status_code=403, detail="Share not available for this device")
    return share



def _resolve_share_path(share: dict) -> str:
    """Resolve the on-disk absolute path for a share's origin file (with traversal guard)."""
    source_type = share["source_type"]
    source_key = share["source_key"]
    relative_path = share["relative_path"]
    if source_type == "phone":
        return full_path_for(relative_path, device_id=source_key)
    if source_type == "desktop":
        return relative_path
    if source_type == "shared":
        entry = _find_shared_dir(source_key)
        if not entry:
            raise HTTPException(status_code=404, detail="Shared source not found")
        root = os.path.abspath(entry["path"])
        if not os.path.isdir(root):
            raise HTTPException(status_code=404, detail="Shared directory not found on server")
        safe_rel = os.path.normpath(relative_path.replace("\\", "/"))
        full_path = os.path.abspath(os.path.join(root, safe_rel))
        if os.path.commonpath([root, full_path]) != root:
            raise HTTPException(status_code=400, detail="Invalid path")
        return full_path
    if source_type == "rewind":
        year_str, _, month_str = relative_path.partition("-")
        path = rewind.get_rewind_path(source_key, int(year_str), int(month_str) if month_str else None)
        if not path:
            raise HTTPException(status_code=404, detail="Reel not ready")
        return path
    if source_type == "rewind_shared":
        full_path = os.path.abspath(relative_path)
        if os.path.commonpath([SHARED_REWIND_DIR, full_path]) != SHARED_REWIND_DIR:
            raise HTTPException(status_code=400, detail="Invalid path")
        return full_path
    raise HTTPException(status_code=400, detail="Unknown share source type")


@router.get("/api/share/{share_id}/download")
@router.get("/share/{share_id}/download")
async def download_device_share(
    share_id: int,
    request: Request,
    device_id: str,
    authorization: str = Header(None),
    token: str = None,
):
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    verify_known_device_by_id(device_id)
    share = _authorize_share_access(share_id, device_id)
    path = _resolve_share_path(share)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="File not found")
    return _file_range_response(path, request)


@router.get("/api/share/{share_id}/preview")
@router.get("/share/{share_id}/preview")
async def preview_device_share(
    share_id: int,
    request: Request,
    device_id: str,
    authorization: str = Header(None),
    token: str = None,
):
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    verify_known_device_by_id(device_id)
    share = _authorize_share_access(share_id, device_id)
    path = _resolve_share_path(share)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="File not found")
    if not is_video_path(path):
        raise HTTPException(status_code=400, detail="Preview is only available for video files")
    try:
        preview_path = get_video_preview_path(
            path,
            schedule_missing=True,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="File not found")
    except subprocess.CalledProcessError:
        raise HTTPException(status_code=500, detail="Failed to generate video preview")
    cache_control = "private, no-cache" if preview_path == path else None
    return _file_range_response(preview_path, request, cache_control=cache_control)


@router.get("/api/share/{share_id}/thumbnail")
@router.get("/share/{share_id}/thumbnail")
async def thumbnail_device_share(
    share_id: int,
    device_id: str,
    authorization: str = Header(None),
    token: str = None,
):
    verify_auth(authorization or (f"Bearer {token}" if token else None), device_id)
    verify_known_device_by_id(device_id)
    share = _authorize_share_access(share_id, device_id)
    path = _resolve_share_path(share)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="File not found")
    if not is_video_path(path):
        media_type = guess_type(path)[0] or "image/jpeg"
        return FileResponse(path, media_type=media_type, headers={"Cache-Control": "public, max-age=86400"})
    thumb_path = await asyncio.to_thread(get_video_thumbnail_path, path)
    if not thumb_path:
        raise HTTPException(status_code=500, detail="Failed to generate thumbnail")
    return FileResponse(thumb_path, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=86400"})
