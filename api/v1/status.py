"""api/v1/status.py — Lightweight online/activity probes used during sync."""

from __future__ import annotations

import asyncio
import socket
import threading
import time

from fastapi import APIRouter, Header, Query, Request
from pydantic import BaseModel

from core.security import verify_api_key_or_device_token
from network_info import get_all_local_ips, get_tailscale_network_info
from repositories import device_repo
from state import get_current_activity, set_current_activity
from version import APP_VERSION

router = APIRouter(tags=["Status"])

# Phone health-checks hit /status often during sync. Network discovery is
# relatively expensive and changes rarely — cache it so sync workers stay free
# for /upload and /files/check instead of re-scanning interfaces every poll.
_NET_CACHE_TTL_SEC = 30.0
_net_cache_lock = threading.Lock()
_net_cache: dict[str, object] = {"at": 0.0, "local_ips": None, "tailscale": None, "hostname": None}


def _cached_network_snapshot() -> tuple[list, dict, str]:
    now = time.monotonic()
    with _net_cache_lock:
        age = now - float(_net_cache["at"] or 0.0)
        if (
            age < _NET_CACHE_TTL_SEC
            and _net_cache["local_ips"] is not None
            and _net_cache["tailscale"] is not None
            and _net_cache["hostname"] is not None
        ):
            return (
                list(_net_cache["local_ips"]),  # type: ignore[arg-type]
                dict(_net_cache["tailscale"]),  # type: ignore[arg-type]
                str(_net_cache["hostname"]),
            )

    local_ips = get_all_local_ips()
    tailscale = get_tailscale_network_info()
    hostname = socket.gethostname()
    with _net_cache_lock:
        _net_cache["at"] = time.monotonic()
        _net_cache["local_ips"] = list(local_ips)
        _net_cache["tailscale"] = dict(tailscale) if isinstance(tailscale, dict) else tailscale
        _net_cache["hostname"] = hostname
    return local_ips, tailscale, hostname


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
    local_ips, tailscale, hostname = await asyncio.to_thread(_cached_network_snapshot)

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
