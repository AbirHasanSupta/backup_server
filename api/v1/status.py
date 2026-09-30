"""api/v1/status.py — Lightweight online/activity probes used during sync."""

from __future__ import annotations

import asyncio
import socket

from fastapi import APIRouter, Header, Query, Request
from pydantic import BaseModel

from core.security import verify_api_key_or_device_token
from network_info import get_all_local_ips, get_tailscale_network_info
from repositories import device_repo
from state import get_current_activity, set_current_activity
from version import APP_VERSION

router = APIRouter(tags=["Status"])


class ActivityRequest(BaseModel):
    message: str | None = None
    device_ip: str | None = None
    device_id: str | None = None


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
