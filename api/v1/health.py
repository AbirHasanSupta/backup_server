"""api/v1/health.py — Unauthenticated discovery & health probes."""

from __future__ import annotations

import asyncio
import socket

from fastapi import APIRouter

from core.config import load_config
from network_info import get_all_local_ips, get_tailscale_network_info
from version import APP_VERSION

router = APIRouter(tags=["Health"])


@router.get("/api/ping")
@router.get("/ping")
async def ping():
    """LAN discovery endpoint without auth."""
    from network_info import get_discovery_port

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
        "port": get_discovery_port(),
        "tailscale": tailscale,
    }
