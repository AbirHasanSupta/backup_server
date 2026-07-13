import asyncio
import socket
import time
import uuid

from fastapi import APIRouter, HTTPException, Request, UploadFile, Form, Header
from pydantic import BaseModel

from config import load_config
from database import (
    batch_check_files,
    find_device_by_name_model,
    get_stats,
    get_device_stats,
    get_devices,
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
)
from state import add_log, get_current_activity, pending_connections, set_current_activity
from storage import file_exists, save_fileobj, save_upload_stream

router = APIRouter()

APP_VERSION = "1.0.0"


# ──────────────────────────────────────────────────────────────────────────────
# Auth helper
# ──────────────────────────────────────────────────────────────────────────────

def verify_auth(authorization: str | None) -> None:
    """Reads the API key fresh from disk on every call so key changes take effect immediately."""
    current_key = load_config()["API_KEY"]
    if authorization != f"Bearer {current_key}":
        raise HTTPException(status_code=401, detail="Unauthorized")


def verify_known_device(device_ip: str, device_id: str | None) -> None:
    if not is_device_known(device_ip, device_id):
        raise HTTPException(
            status_code=403,
            detail="Device is not approved. Reconnect from the Android app settings.",
        )


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
    verify_auth(authorization)

    device_ip = request.client.host
    device_name = body.device_name.strip() or device_ip
    device_id = body.device_id
    device_model = (body.device_model or "").strip() or None

    # Already registered — just refresh the record, no dialog needed
    if is_device_known(device_ip, device_id):
        upsert_device(device_name, device_ip, device_id, device_model)
        add_log(f"📱 Re-connected: {device_name} ({device_id or device_ip})")
        return {"status": "accepted"}

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
            return {"status": "accepted"}

    add_log(f"📱 New connection request: {device_name} ({device_id or device_ip})")

    if not load_config().get("REQUIRE_APPROVAL", True):
        upsert_device(device_name, device_ip, device_id, device_model)
        add_log(f"✅ Auto-accepted: {device_name} ({device_id or device_ip})")
        return {"status": "accepted"}

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
        return {"status": "accepted"}

    return {"status": "rejected"}



# ──────────────────────────────────────────────────────────────────────────────
# Device management
# ──────────────────────────────────────────────────────────────────────────────

@router.get("/devices")
async def list_devices(authorization: str = Header(None)):
    """Returns the list of accepted connected devices."""
    verify_auth(authorization)
    return {"devices": get_devices()}


@router.delete("/devices/{device_id}")
async def delete_device(device_id: int, authorization: str = Header(None)):
    """Removes a device from the connected-devices list."""
    verify_auth(authorization)
    remove_device(device_id)
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
    verify_auth(authorization)
    stats = get_stats()
    devices = get_devices()
    device_connected = is_device_known(request.client.host, device_id) if device_id else None
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
    verify_auth(authorization)
    if body.device_id:
        verify_known_device(request.client.host, body.device_id)
    set_current_activity(body.message, request.client.host)
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
    verify_auth(authorization)
    device_ip = request.client.host
    device_id = body.device_id
    verify_known_device(device_ip, device_id)

    # Convert body items to list of dicts for batch check
    items = []
    for item in body.files:
        items.append({
            "path": item.relative_path,
            "size": item.size,
            "modified_time": item.modified_time,
            "external_id": item.external_id,
            "device_id": device_id,
        })

    # Get all that ARE in database
    present_in_db = batch_check_files(items)
    
    # Debug logging for check
    if len(items) > 0:
        add_log(f"🔍 Checking {len(items)} files for {device_id or device_ip}. Found in DB: {len(present_in_db)}")

    checked = []
    present = 0
    for item in body.files:
        key = f"{item.relative_path}|{item.modified_time}|{item.size}"
        db_exists = key in present_in_db
        
        # Check disk only for DB matches; missing DB rows are already known missing.
        on_disk = db_exists and file_exists(item.relative_path, item.size, device_id=device_id)
        
        if db_exists and not on_disk:
            # File is in DB but missing from disk. 
            # Remove it from DB so counts are accurate and it gets re-uploaded.
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

    device_ip = request.client.host
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


@router.post("/upload/raw")
async def upload_file_raw(
    request: Request,
    relative_path: str,
    modified_time: int,
    size: int,
    external_id: str = None,
    sha256: str = None,
    device_id: str = None,
    authorization: str = Header(None),
):
    verify_auth(authorization)

    device_ip = request.client.host
    verify_known_device(device_ip, device_id)

    if is_uploaded_compatible(relative_path, size, modified_time, external_id, device_id=device_id) and file_exists(relative_path, size, device_id=device_id):
        return skipped_upload_response(device_ip, device_id)

    set_current_activity(f"Uploading {relative_path}", device_ip)
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
        set_current_activity(None)

    if not sha256:
        sha256 = saved_sha256

    return finish_upload_record(relative_path, size, modified_time, device_ip, external_id, sha256, device_id)


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
    authorization: str = Header(None),
):
    verify_auth(authorization)

    device_ip = request.client.host
    verify_known_device(device_ip, device_id)

    if is_uploaded_compatible(relative_path, size, modified_time, external_id, device_id=device_id) and file_exists(relative_path, size, device_id=device_id):
        return skipped_upload_response(device_ip, device_id)

    set_current_activity(f"Uploading {relative_path}", device_ip)
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
        set_current_activity(None)
    
    if not sha256:
        sha256 = saved_sha256

    return finish_upload_record(relative_path, size, modified_time, device_ip, external_id, sha256, device_id)


# ──────────────────────────────────────────────────────────────────────────────
# Sync session history
# ──────────────────────────────────────────────────────────────────────────────

class SyncSessionRequest(BaseModel):
    device_id:   str | None = None
    device_name: str | None = None
    started_at:  int
    ended_at:    int
    duration_ms: int = 0
    trigger:     str = "manual"
    outcome:     str = "completed"
    scanned:     int = 0
    checked:     int = 0
    uploaded:    int = 0
    skipped:     int = 0
    errors:      int = 0
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
    verify_auth(authorization)

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
    verify_auth(authorization)
    sessions = get_sync_sessions(device_id=device_id, limit=min(limit, 500))
    return {"sessions": sessions}


@router.delete("/sync/sessions")
async def delete_sync_sessions(
    device_id: str | None = None,
    authorization: str = Header(None),
):
    """Clear all or device-specific session history."""
    verify_auth(authorization)
    clear_sync_sessions(device_id=device_id)
    return {"ok": True}
