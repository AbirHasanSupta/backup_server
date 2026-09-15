"""Private-network endpoint discovery for the backup server.

Tailscale is intentionally optional: a normal LAN-only installation must not
need its CLI installed.  WireGuard has no portable peer-discovery API, so its
endpoint is supplied manually by the client; it uses the exact same private
network connection mode.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time


_TAILSCALE_CACHE_SECONDS = 30.0
_tailscale_cache: dict = {"available": False, "ips": [], "dns_name": ""}
_tailscale_cache_until = 0.0
_tailscale_cache_lock = threading.Lock()


def _resolve_tailscale_binary() -> str | None:
    binary = shutil.which("tailscale")
    if binary:
        return binary

    if os.name == "nt":
        candidates = [
            os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "Tailscale", "tailscale.exe"),
            os.path.join(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"), "Tailscale", "tailscale.exe"),
            os.path.join(os.environ.get("ProgramW6432", r"C:\Program Files"), "Tailscale", "tailscale.exe"),
            os.path.join(os.environ.get("LOCALAPPDATA", ""), "Tailscale", "tailscale.exe"),
            os.path.join(os.environ.get("APPDATA", ""), "Tailscale", "tailscale.exe"),
        ]
        for c in candidates:
            if c and os.path.isfile(c):
                return c
    return None


def get_tailscale_network_info() -> dict:
    """Return this node's Tailscale addresses and MagicDNS name when available."""
    global _tailscale_cache, _tailscale_cache_until
    now = time.monotonic()
    with _tailscale_cache_lock:
        if now < _tailscale_cache_until:
            return dict(_tailscale_cache)

    binary = _resolve_tailscale_binary()
    if not binary:
        info = {"available": False, "ips": [], "dns_name": ""}
        with _tailscale_cache_lock:
            _tailscale_cache, _tailscale_cache_until = info, now + _TAILSCALE_CACHE_SECONDS
        return dict(info)

    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    try:
        result = subprocess.run(
            [binary, "status", "--json"],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
            creationflags=creationflags,
        )
        if result.returncode != 0:
            info = {"available": False, "ips": [], "dns_name": ""}
            with _tailscale_cache_lock:
                _tailscale_cache, _tailscale_cache_until = info, now + _TAILSCALE_CACHE_SECONDS
            return dict(info)
        status = json.loads(result.stdout)
        backend_state = status.get("BackendState")
        if backend_state and backend_state != "Running":
            info = {"available": False, "ips": [], "dns_name": ""}
            with _tailscale_cache_lock:
                _tailscale_cache, _tailscale_cache_until = info, now + _TAILSCALE_CACHE_SECONDS
            return dict(info)

        self_info = status.get("Self") or {}
        ips = [ip for ip in (self_info.get("TailscaleIPs") or []) if isinstance(ip, str) and ip]
        # Tailscale returns a trailing dot in its JSON DNS name.  Android URL
        # handling does not need it and saved profiles should have one stable form.
        dns_name = str(self_info.get("DNSName") or "").rstrip(".")
        info = {
            "available": bool(ips or dns_name),
            "ips": ips,
            "dns_name": dns_name,
        }
    except (OSError, ValueError, subprocess.SubprocessError):
        info = {"available": False, "ips": [], "dns_name": ""}

    with _tailscale_cache_lock:
        _tailscale_cache, _tailscale_cache_until = info, now + _TAILSCALE_CACHE_SECONDS
    return dict(info)

