import asyncio
import socket
import time
import uuid

from fastapi import APIRouter, HTTPException, Request, UploadFile, Form, Header
from pydantic import BaseModel

from config import load_config
from database import (
    get_stats,
    get_devices,
    insert_file,
    is_uploaded,
    remove_device,
    touch_device,
    upsert_device,
)
from state import add_log, pending_connections
from storage import save_file

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

    # Already registered — just refresh the record, no dialog needed
    if is_device_known(device_ip):
        upsert_device(device_name, device_ip)
        add_log(f"📱 Re-connected: {device_name} ({device_ip})")
        return {"status": "accepted"}

    add_log(f"📱 New connection request: {device_name} ({device_ip})")

    if not load_config().get("REQUIRE_APPROVAL", True):
        upsert_device(device_name, device_ip)
        add_log(f"✅ Auto-accepted: {device_name} ({device_ip})")
        return {"status": "accepted"}

    # ── Approval flow ─────────────────────────────────────────────────────────
    req_id = str(uuid.uuid4())
    loop = asyncio.get_running_loop()
    future: asyncio.Future = loop.create_future()

    pending_connections[req_id] = {
        "name": device_name,
        "ip": device_ip,
        "future": future,
        "loop": loop,
        "_shown": False,
    }

    try:
        accepted = await asyncio.wait_for(asyncio.shield(future), timeout=30.0)
    except asyncio.TimeoutError:
        pending_connections.pop(req_id, None)
        add_log(f"⏱️ Connection timed out: {device_name} ({device_ip})")
        return {"status": "rejected", "reason": "timeout"}

    if accepted:
        upsert_device(device_name, device_ip)
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
async def status(authorization: str = Header(None)):
    """
    Aggregate server stats.
    Intended for the future desktop UI or monitoring scripts.
    """
    verify_auth(authorization)
    stats = get_stats()
    devices = get_devices()
    return {
        **stats,
        "connected_devices": len(devices),
        "devices": devices,
        "server_version": APP_VERSION,
    }


# ──────────────────────────────────────────────────────────────────────────────
# File upload
# ──────────────────────────────────────────────────────────────────────────────

@router.post("/upload")
async def upload_file(
    request: Request,
    file: UploadFile,
    relative_path: str = Form(...),
    modified_time: int = Form(...),
    size: int = Form(...),
    authorization: str = Header(None),
):
    verify_auth(authorization)

    device_ip = request.client.host

    if is_uploaded(relative_path, size, modified_time):
        return {"status": "skipped"}

    content = await file.read()
    save_file(relative_path, content)
    now = int(time.time())
    insert_file(relative_path, size, modified_time, now, device_ip)

    # Update device stats (last_seen + files counter)
    touch_device(device_ip)

    add_log(f"⬆️  {relative_path}  ({device_ip})")

    return {"status": "uploaded"}
