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

    run_options: dict[str, object] = {
        "capture_output": True,
        "text": True,
        "timeout": 2,
        "check": False,
        "stdin": subprocess.DEVNULL,
    }
    if os.name == "nt":
        run_options["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = getattr(subprocess, "SW_HIDE", 0)
        run_options["startupinfo"] = startupinfo
    try:
        result = subprocess.run(
            [binary, "status", "--json"],
            **run_options,
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


def _parse_advertised_ips() -> list[str]:
    """Host LAN IPs injected for Docker/container deployments (comma/space separated)."""
    import re

    raw = os.environ.get("ADVERTISED_IPS") or os.environ.get("HOST_LAN_IPS") or ""
    if not str(raw).strip():
        try:
            from config import load_config
            cfg_val = load_config().get("ADVERTISED_IPS") or ""
            raw = cfg_val if isinstance(cfg_val, str) else ",".join(str(x) for x in cfg_val)
        except Exception:
            raw = ""

    result: list[str] = []
    seen: set[str] = set()
    for part in re.split(r"[,;\s]+", str(raw).strip()):
        ip = part.strip().strip("[]")
        if not ip or ip in seen:
            continue
        if ip.startswith("127.") or ip.startswith("169.254."):
            continue
        seen.add(ip)
        result.append(ip)
    return result


def _is_docker_bridge_ip(ip: str) -> bool:
    """True for typical Docker/container bridge ranges that phones cannot reach.

    Note: 172.16.0.0/12 is also a valid private LAN range. Callers must only
    filter these when explicit ADVERTISED_IPS are provided.
    """
    if not ip.startswith("172."):
        return False
    try:
        second = int(ip.split(".")[1])
    except (IndexError, ValueError):
        return False
    # Docker default bridge + user-defined bridge pools commonly use 172.16–31.x
    return 16 <= second <= 31


def get_discovery_port() -> int:
    """Port phones should probe.

    Prefer an explicit ``ADVERTISED_PORT`` env (Docker/nginx published port).
    Otherwise use the process listen ``PORT`` so desktop custom ports stay intact.
    """
    raw = os.environ.get("ADVERTISED_PORT")
    if raw is not None and str(raw).strip():
        try:
            port = int(str(raw).strip())
            if 1 <= port <= 65535:
                return port
        except (TypeError, ValueError):
            pass

    for key in ("PORT",):
        raw = os.environ.get(key)
        if raw is not None and str(raw).strip():
            try:
                port = int(str(raw).strip())
                if 1 <= port <= 65535:
                    return port
            except (TypeError, ValueError):
                pass

    try:
        from config import load_config
        cfg = load_config()
        # Only honor config ADVERTISED_PORT when it came from env/override
        # (env path above) or equals the listen port after defaults sync.
        # Prefer listen PORT for desktop when no explicit advertise env is set.
        if os.environ.get("ADVERTISED_PORT"):
            port = int(cfg.get("ADVERTISED_PORT") or 0)
            if 1 <= port <= 65535:
                return port
        port = int(cfg.get("PORT") or 8000)
        if 1 <= port <= 65535:
            return port
    except Exception:
        pass
    return 8000


def get_all_local_ips() -> list[str]:
    """Return all discovered IPv4 addresses on LAN interfaces.

    In Docker, container-local probes often yield unreachable bridge IPs
    (172.x). Prefer explicitly advertised host LAN IPs when provided.
    """
    import platform
    import re
    import socket

    advertised = _parse_advertised_ips()
    ips: set[str] = set(advertised)

    # 1. Outbound socket probes
    for target in ("8.8.8.8", "1.1.1.1", "224.0.0.1"):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect((target, 80))
                outbound_ip = s.getsockname()[0]
                if outbound_ip and not outbound_ip.startswith("127.") and not outbound_ip.startswith("169.254."):
                    ips.add(outbound_ip)
        except Exception:
            pass

    # 2. Hostname getaddrinfo and gethostbyname_ex
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

    # 3. Windows ipconfig parsing / OS interface scanning
    if platform.system() == "Windows":
        try:
            run_opts: dict[str, object] = {
                "text": True,
                "errors": "ignore",
                "timeout": 3,
                "stdin": subprocess.DEVNULL,
            }
            if os.name == "nt":
                run_opts["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
                startupinfo = subprocess.STARTUPINFO()
                startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                startupinfo.wShowWindow = getattr(subprocess, "SW_HIDE", 0)
                run_opts["startupinfo"] = startupinfo
            out = subprocess.check_output(["ipconfig"], **run_opts)
            for ip in re.findall(r"IPv4 Address[.\s]+:\s*([\d.]+)", out):
                if ip and not ip.startswith("127.") and not ip.startswith("169.254."):
                    ips.add(ip)
        except Exception:
            pass

    # When the operator published host LAN IPs, drop unreachable Docker bridges
    # so discovery candidates are phone-reachable.
    if advertised:
        ips = {ip for ip in ips if not _is_docker_bridge_ip(ip) or ip in advertised}
        for ip in advertised:
            ips.add(ip)

    def _sort_key(ip_str: str) -> tuple[int, str]:
        if ip_str in advertised:
            return (-1, ip_str)
        if ip_str.startswith("192.168."):
            return (0, ip_str)
        if ip_str.startswith("10."):
            return (1, ip_str)
        if _is_docker_bridge_ip(ip_str):
            return (4, ip_str)
        if ip_str.startswith("172."):
            return (2, ip_str)
        return (3, ip_str)

    return sorted(ips, key=_sort_key)


