"""api/v1/auth.py — Device Pairing, Token Auth & Status Router."""

from __future__ import annotations

import asyncio
import os
import shutil
import socket
import uuid
from pydantic import BaseModel
from fastapi import APIRouter, Header, HTTPException, Query, Request, status

from core.config import load_config
from core.security import verify_api_key_or_device_token
from repositories import device_repo
from state import (
    add_log,
    clear_logs,
    get_current_activity,
    get_logs,
    pending_connections,
    resolve_connection,
    set_current_activity,
)
from network_info import get_all_local_ips, get_tailscale_network_info
from version import APP_VERSION

router = APIRouter(tags=["Authentication & Devices"])

class ConnectRequest(BaseModel):
    device_name: str
    device_id: str | None = None
    device_model: str | None = None
    username: str | None = None


class UsernameRequest(BaseModel):
    username: str


class ActivityRequest(BaseModel):
    message: str | None = None
    device_ip: str | None = None
    device_id: str | None = None


@router.get("/api/ping")
@router.get("/ping")
async def ping():
    """LAN discovery endpoint without auth."""
    local_ips = await asyncio.to_thread(get_all_local_ips)
    hostname = socket.gethostname()
    cfg = load_config()
    tailscale = await asyncio.to_thread(get_tailscale_network_info)
    cert_fp = ""
    try:
        from network_info import get_cert_fingerprint
        cert_fp = get_cert_fingerprint()
    except Exception:
        pass

    return {
        "status": "ok",
        "server_id": cfg.get("SERVER_ID", ""),
        "name": cfg.get("DESKTOP_NAME") or hostname,
        "hostname": f"{hostname}.local",
        "version": APP_VERSION,
        "cert_fingerprint": cert_fp,
        "all_ips": local_ips,
        "tailscale": tailscale,
    }


@router.post("/api/connect")
@router.post("/connect")
async def connect_device(
    request: Request,
    body: ConnectRequest,
    authorization: str = Header(None),
    token: str = Query(None),
):
    """Pair new device with optional interactive desktop approval modal."""
    cfg = load_config()
    verify_api_key_or_device_token(authorization, token, None, None)

    device_ip = request.client.host if request.client else "127.0.0.1"
    device_name = body.device_name.strip() or device_ip
    device_id = (body.device_id or "").strip() or str(uuid.uuid4())
    device_model = (body.device_model or "").strip() or None
    username = (body.username or "").strip() or None

    require_approval = cfg.get("REQUIRE_APPROVAL", True)
    is_known = device_repo.is_device_known(device_ip, device_id)
    recovery_available = False

    # Check for reinstall / migration if device_id changed
    if device_id and not is_known:
        existing = device_repo.find_device_by_name_model(device_name, device_model)
        if existing and existing.get("device_id") and existing["device_id"] != device_id:
            old_id = existing["device_id"]
            add_log(f"🔄 Reinstall detected for '{device_name}': merging {old_id[:8]}… → {device_id[:8]}…")
            device_repo.merge_device_id(old_id, device_id, device_ip)
            recovery_available = True
            is_known = True

    if require_approval and not is_known:
        req_id = str(uuid.uuid4())
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        pending_connections[req_id] = {
            "name": device_name,
            "ip": device_ip,
            "device_id": device_id,
            "device_model": device_model,
            "username": username,
            "display_name": device_repo.format_device_display_name(username, device_name, device_model),
            "future": future,
            "loop": loop,
            "_shown": False,
        }
        try:
            accepted = await asyncio.wait_for(future, timeout=30.0)
        except asyncio.TimeoutError:
            pending_connections.pop(req_id, None)
            raise HTTPException(status_code=403, detail="Connection request timed out or was rejected.")

        if not accepted:
            raise HTTPException(status_code=403, detail="Connection request rejected by user.")

    device_repo.upsert_device(device_name, device_ip, device_id, device_model, username)
    assigned_token = device_repo.ensure_device_token(device_id)

    # Broadcast pairing approval via WebSocket
    if device_id and assigned_token:
        try:
            from services.ws_service import ws_service
            ws_service.notify_pairing_approved(device_id, assigned_token)
        except Exception:
            pass

    local_ips = await asyncio.to_thread(get_all_local_ips)
    hostname = socket.gethostname()
    tailscale = await asyncio.to_thread(get_tailscale_network_info)
    stats = device_repo.get_device_stats(device_ip, device_id=device_id)

    return {
        "status": "accepted",
        "ok": True,
        "device_id": device_id,
        "server_id": cfg.get("SERVER_ID", ""),
        "name": cfg.get("DESKTOP_NAME") or hostname,
        "hostname": f"{hostname}.local",
        "device_name": device_name,
        "username": username,
        "token": assigned_token,
        "server_version": APP_VERSION,
        "version": APP_VERSION,
        "all_ips": local_ips,
        "tailscale": tailscale,
        "recovery_available": recovery_available,
        "files_backed_up": stats.get("total_files", 0),
    }


@router.get("/api/devices")
@router.get("/devices")
async def list_devices(
    device_id: str | None = None,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    devices = device_repo.get_devices()
    for d in devices:
        d["display_name"] = device_repo.format_device_display_name(d.get("username"), d.get("device_name"))
    return {"devices": devices}


@router.delete("/api/devices/{target_device_id}")
@router.delete("/devices/{target_device_id}")
async def delete_device(
    target_device_id: str,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, None, None)
    ok = device_repo.remove_device(target_device_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Device not found")
    return {"ok": True}


@router.post("/api/devices/{target_device_id}/username")
@router.post("/devices/{target_device_id}/username")
async def update_username(
    target_device_id: str,
    body: UsernameRequest,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, target_device_id, device_repo.verify_device_token)
    new_username = (body.username or "").strip() or None
    device_repo.set_device_username(target_device_id, new_username)
    return {"ok": True, "username": new_username}


@router.get("/api/status")
@router.get("/status")
async def get_server_status(
    request: Request,
    device_id: str | None = None,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    device_ip = request.client.host if request.client else "127.0.0.1"
    is_known = device_repo.is_device_known(device_ip, device_id)
    dev_obj = device_repo.get_device_by_id(device_id) if device_id else None
    local_ips = await asyncio.to_thread(get_all_local_ips)
    hostname = socket.gethostname()
    tailscale = await asyncio.to_thread(get_tailscale_network_info)

    return {
        "status": "online",
        "server_version": APP_VERSION,
        "device_connected": is_known,
        "username": dev_obj.get("username") if dev_obj else None,
        "current_activity": get_current_activity(),
        "all_ips": local_ips,
        "hostname": f"{hostname}.local",
        "tailscale": tailscale,
    }


@router.post("/api/status/activity")
@router.post("/status/activity")
async def update_activity(
    body: ActivityRequest,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, body.device_id, device_repo.verify_device_token)
    set_current_activity(body.message, body.device_ip, body.device_id)
    return {"ok": True}
