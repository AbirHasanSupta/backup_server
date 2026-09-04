"""
Phone Backup Server - Desktop Application.
Wraps the FastAPI server in a polished customtkinter control center.

Run with:  python desktop_app.py
"""

from __future__ import annotations

import io
import json
import os
import platform
import shutil
import socket
import sys
import threading
import time
import traceback
from datetime import datetime
from tkinter import filedialog, messagebox
import tkinter as tk

from tkinterdnd2 import DND_FILES, TkinterDnD

import memories


# ── Windowed-PyInstaller guard ─────────────────────────────────────────────────
# When built with --windowed there is no console, so sys.stdout / sys.stderr are
# None. uvicorn's log formatter calls .isatty() on these streams before we can
# intercept it, causing a hard crash. Redirect to a silent in-memory sink.
class _NullStream(io.RawIOBase):
    """Silent stream: satisfies isatty(), write(), flush(), fileno()."""
    def isatty(self)   -> bool: return False
    def readable(self) -> bool: return False
    def writable(self) -> bool: return True
    def write(self, b):         return len(b) if isinstance(b, (bytes, bytearray)) else len(b.encode())
    def flush(self):            pass
    def fileno(self):           raise io.UnsupportedOperation("fileno")

if sys.stdout is None:
    sys.stdout = io.TextIOWrapper(_NullStream())
if sys.stderr is None:
    sys.stderr = io.TextIOWrapper(_NullStream())

import customtkinter as ctk
import uvicorn

_memories_daemon_started = False

# ── Local imports ──────────────────────────────────────────────────────────────
from state import (
    add_log,
    clear_logs,
    get_current_activity,
    get_logs,
    pending_connections,
    resolve_connection,
)
from config import load_config, save_config, is_autostart_enabled, set_autostart_enabled

try:
    import pystray
    from PIL import Image as _PILImage
except Exception:
    pystray = None
    _PILImage = None

from database import (
    get_devices,
    get_stats,
    get_sync_sessions,
    clear_sync_sessions,
    init_db,
    remove_device,
    create_device_share,
    get_device_shares_by_sharer,
    get_all_share_targets_for_sharer,
    get_share_targets_for_group,
    delete_device_share_group,
    remove_share_group_target,
    add_share_group_targets,
    edit_device_share_group_caption,
    set_device_username,
    upsert_device,
    search_files_for_device,
    update_share_group_items,
)

DESKTOP_SHARE_DEVICE_ID = "desktop-server"


def format_display_name(dev: dict) -> str:
    username = (dev.get("username") or "").strip()
    device_name = (dev.get("device_name") or "").strip()
    device_id = (dev.get("device_id") or dev.get("target_device_id") or "").strip()
    if username and device_name:
        return f"{username} ({device_name})"
    return username or device_name or device_id or "Unknown device"


def _ensure_desktop_device(name: str | None = None) -> None:
    """Register (or update) the desktop server as a known device so its posts
    show a proper display name in the phone feed instead of the raw device ID."""
    try:
        cfg = load_config()
        display_name = (name or cfg.get("DESKTOP_NAME") or "").strip() or platform.node() or "Desktop Server"
        upsert_device(
            device_name=display_name,
            device_ip="127.0.0.1",
            device_id=DESKTOP_SHARE_DEVICE_ID,
        )
    except Exception:
        pass


# ── Theme ──────────────────────────────────────────────────────────────────────
ctk.set_default_color_theme("blue")

# ── Palette Definitions ────────────────────────────────────────────────────────
_LIGHT_PALETTE = {
    "C_BG": "#F4F7FB",
    "C_SURFACE": "#FFFFFF",
    "C_ELEVATED": "#EDF2F7",
    "C_CARD": "#FFFFFF",
    "C_BORDER": "#E2E8F0",
    "C_ACCENT": "#2563EB",
    "C_ACCENT2": "#1D4ED8",
    "C_SUCCESS": "#059669",
    "C_ERROR": "#DC2626",
    "C_WARNING": "#D97706",
    "C_INFO": "#0891B2",
    "C_TEXT": "#0F172A",
    "C_MUTED": "#64748B",
    "C_HIGHLIGHT": "#2563EB",
    "C_SOFT_BLUE": "#EFF6FF",
    "C_SOFT_GREEN": "#ECFDF5",
    "C_SOFT_RED": "#FEF2F2",
    "C_SOFT_AMBER": "#FFFBEB",
    "C_SOFT_INFO": "#ECFEFF",
    "C_SOFT_BLUE_HOVER": "#DBEAFE",
    "C_SOFT_GREEN_HOVER": "#D1FAE5",
    "C_SOFT_RED_HOVER": "#FEE2E2",
    "C_SUCCESS_HOVER": "#047857",
    "C_SUCCESS_BORDER": "#A7F3D0",
    "C_ERROR_BORDER": "#FECACA",
    "C_WARNING_BORDER": "#FDE68A",
    "C_LOG_TS": "#475569",
}

_DARK_PALETTE = {
    "C_BG": "#0B1120",
    "C_SURFACE": "#111A2E",
    "C_ELEVATED": "#18233C",
    "C_CARD": "#111A2E",
    "C_BORDER": "#24324D",
    "C_ACCENT": "#60A5FA",
    "C_ACCENT2": "#3B82F6",
    "C_SUCCESS": "#34D399",
    "C_ERROR": "#F87171",
    "C_WARNING": "#FBBF24",
    "C_INFO": "#38BDF8",
    "C_TEXT": "#F8FAFC",
    "C_MUTED": "#94A3B8",
    "C_HIGHLIGHT": "#93C5FD",
    "C_SOFT_BLUE": "#1E2E4A",
    "C_SOFT_GREEN": "#13352C",
    "C_SOFT_RED": "#3B1D27",
    "C_SOFT_AMBER": "#382D16",
    "C_SOFT_INFO": "#133742",
    "C_SOFT_BLUE_HOVER": "#283C61",
    "C_SOFT_GREEN_HOVER": "#1A493D",
    "C_SOFT_RED_HOVER": "#4E2533",
    "C_SUCCESS_HOVER": "#059669",
    "C_SUCCESS_BORDER": "#065F46",
    "C_ERROR_BORDER": "#7F1D1D",
    "C_WARNING_BORDER": "#78350F",
    "C_LOG_TS": "#8193AC",
}

C_BG = _LIGHT_PALETTE["C_BG"]
C_SURFACE = _LIGHT_PALETTE["C_SURFACE"]
C_ELEVATED = _LIGHT_PALETTE["C_ELEVATED"]
C_CARD = _LIGHT_PALETTE["C_CARD"]
C_BORDER = _LIGHT_PALETTE["C_BORDER"]
C_ACCENT = _LIGHT_PALETTE["C_ACCENT"]
C_ACCENT2 = _LIGHT_PALETTE["C_ACCENT2"]
C_SUCCESS = _LIGHT_PALETTE["C_SUCCESS"]
C_ERROR = _LIGHT_PALETTE["C_ERROR"]
C_WARNING = _LIGHT_PALETTE["C_WARNING"]
C_INFO = _LIGHT_PALETTE["C_INFO"]
C_TEXT = _LIGHT_PALETTE["C_TEXT"]
C_MUTED = _LIGHT_PALETTE["C_MUTED"]
C_HIGHLIGHT = _LIGHT_PALETTE["C_HIGHLIGHT"]
C_SOFT_BLUE = _LIGHT_PALETTE["C_SOFT_BLUE"]
C_SOFT_GREEN = _LIGHT_PALETTE["C_SOFT_GREEN"]
C_SOFT_RED = _LIGHT_PALETTE["C_SOFT_RED"]
C_SOFT_AMBER = _LIGHT_PALETTE["C_SOFT_AMBER"]
C_SOFT_INFO = _LIGHT_PALETTE["C_SOFT_INFO"]
C_SOFT_BLUE_HOVER = _LIGHT_PALETTE["C_SOFT_BLUE_HOVER"]
C_SOFT_GREEN_HOVER = _LIGHT_PALETTE["C_SOFT_GREEN_HOVER"]
C_SOFT_RED_HOVER = _LIGHT_PALETTE["C_SOFT_RED_HOVER"]
C_SUCCESS_HOVER = _LIGHT_PALETTE["C_SUCCESS_HOVER"]
C_SUCCESS_BORDER = _LIGHT_PALETTE["C_SUCCESS_BORDER"]
C_ERROR_BORDER = _LIGHT_PALETTE["C_ERROR_BORDER"]
C_WARNING_BORDER = _LIGHT_PALETTE["C_WARNING_BORDER"]
C_LOG_TS = _LIGHT_PALETTE["C_LOG_TS"]

CURRENT_THEME = "light"


def _normalize_theme_mode(mode: str | None) -> str:
    return "dark" if str(mode).lower() == "dark" else "light"


def apply_theme(mode: str | None) -> str:
    global CURRENT_THEME
    CURRENT_THEME = _normalize_theme_mode(mode)
    palette = _DARK_PALETTE if CURRENT_THEME == "dark" else _LIGHT_PALETTE
    globals().update(palette)
    ctk.set_appearance_mode(CURRENT_THEME)
    return CURRENT_THEME


apply_theme(load_config().get("THEME_MODE", "light"))

# Module-level font references
FONT_TITLE:   ctk.CTkFont
FONT_SUBTITLE: ctk.CTkFont
FONT_SECTION: ctk.CTkFont
FONT_BODY:    ctk.CTkFont
FONT_BODY_B:  ctk.CTkFont
FONT_SMALL:   ctk.CTkFont
FONT_SMALL_B: ctk.CTkFont
FONT_MONO:    ctk.CTkFont
FONT_CAPTION: ctk.CTkFont


# ── Utility Helpers ────────────────────────────────────────────────────────────

def get_all_local_ips() -> list[str]:
    """Returns all active, non-loopback, non-link-local IPv4 addresses."""
    ips = set()

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
            import subprocess
            import re
            out = subprocess.check_output(
                ["ipconfig"],
                text=True,
                errors="ignore",
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                timeout=3,
            )
            for ip in re.findall(r"IPv4 Address[.\s]+:\s*([\d.]+)", out):
                if ip and not ip.startswith("127.") and not ip.startswith("169.254."):
                    ips.add(ip)
        except Exception:
            pass

    # Sort so that common LAN subnets (192.168.x.x, 10.x.x.x) come first
    def _sort_key(ip_str: str) -> tuple[int, str]:
        if ip_str.startswith("192.168."):
            return (0, ip_str)
        if ip_str.startswith("10."):
            return (1, ip_str)
        if ip_str.startswith("172."):
            return (2, ip_str)
        return (3, ip_str)

    res = sorted(ips, key=_sort_key)
    return res if res else ["127.0.0.1"]


def get_local_ip() -> str:
    ips = get_all_local_ips()
    return ips[0] if ips else "127.0.0.1"


def fmt_bytes(n: int | float) -> str:
    n = float(max(0, n or 0))
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024.0 or unit == "TB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024.0
    return f"{n:.1f} PB"


def fmt_ts(ts: int | None) -> str:
    if not ts:
        return "Never"
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d  %H:%M:%S")


def fmt_rel(ts: int | None) -> str:
    if not ts:
        return "Never"
    secs = int(time.time()) - ts
    if secs < 0:
        return "Just now"
    if secs < 60:
        return "Just now"
    if secs < 3600:
        return f"{secs // 60}m ago"
    if secs < 86400:
        return f"{secs // 3600}h ago"
    if secs < 86400 * 30:
        return f"{secs // 86400}d ago"
    return datetime.fromtimestamp(ts).strftime("%b %d, %Y")


def get_free_disk_space(path: str) -> tuple[int, int]:
    """Returns (free_bytes, total_bytes) for the volume hosting `path`."""
    try:
        if not path or not os.path.exists(path):
            path = os.path.expanduser("~")
        usage = shutil.disk_usage(path)
        return usage.free, usage.total
    except Exception:
        return 0, 0


def _resolve_asset(filename: str) -> str:
    """Return absolute path to an asset for both dev and PyInstaller bundle."""
    if getattr(sys, "frozen", False):
        base = sys._MEIPASS  # type: ignore[attr-defined]
    else:
        base = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, "assets", filename)


# ── Custom Confirmation Dialog ─────────────────────────────────────────────────

def confirm_dialog(parent, title: str, message: str, destructive: bool = True) -> bool:
    result: list[bool] = [False]
    dlg = ctk.CTkToplevel(parent)
    dlg.title(title)

    dlg_w, dlg_h = 420, 210
    parent.update_idletasks()
    px = parent.winfo_x()
    py = parent.winfo_y()
    pw = parent.winfo_width()
    ph = parent.winfo_height()
    x = px + (pw // 2) - (dlg_w // 2)
    y = py + (ph // 2) - (dlg_h // 2)
    dlg.geometry(f"{dlg_w}x{dlg_h}+{x}+{y}")

    dlg.resizable(False, False)
    dlg.attributes("-topmost", True)
    dlg.grab_set()
    dlg.configure(fg_color=C_SURFACE)

    ctk.CTkLabel(
        dlg, text=message, font=FONT_BODY, wraplength=370,
        justify="center", text_color=C_TEXT,
    ).pack(expand=True, pady=(24, 12), padx=24)

    bf = ctk.CTkFrame(dlg, fg_color="transparent")
    bf.pack(fill="x", padx=24, pady=(0, 22))

    def _yes():
        result[0] = True
        dlg.destroy()

    def _no():
        dlg.destroy()

    ctk.CTkButton(
        bf, text="Cancel", fg_color=C_ELEVATED, hover_color=C_BORDER,
        text_color=C_TEXT, border_width=1, border_color=C_BORDER, width=130, height=38,
        font=FONT_BODY_B, corner_radius=10, command=_no,
    ).pack(side="left")

    confirm_bg = C_SOFT_RED if destructive else C_SOFT_BLUE
    confirm_hover = C_SOFT_RED_HOVER if destructive else C_SOFT_BLUE_HOVER
    confirm_text = C_ERROR if destructive else C_ACCENT
    confirm_border = C_ERROR_BORDER if destructive else C_BORDER

    ctk.CTkButton(
        bf, text="Confirm", fg_color=confirm_bg, hover_color=confirm_hover,
        text_color=confirm_text, border_width=1, border_color=confirm_border,
        width=130, height=38, font=FONT_BODY_B, corner_radius=10, command=_yes,
    ).pack(side="right")

    dlg.wait_window()
    return result[0]


# ── Animated Breathing Dot ────────────────────────────────────────────────────

class BreathingDot(ctk.CTkCanvas):
    """Pulsing status dot that animates smoothly between two colors."""

    _PERIOD = 1800  # ms for a full pulse

    def __init__(self, parent, size: int = 12, **kwargs):
        super().__init__(
            parent, width=size, height=size,
            highlightthickness=0, bd=0,
            bg=C_SURFACE, **kwargs,
        )
        self._size = size
        self._color_on  = C_SUCCESS
        self._color_off = C_SOFT_GREEN
        self._step = 0
        self._running = True
        self._after_id: str | None = None
        self._oval = self.create_oval(1, 1, size - 1, size - 1, fill=self._color_on, outline="")
        self._animate()

    def set_running(self, running: bool):
        self._color_on  = C_SUCCESS if running else C_ERROR
        self._color_off = C_SOFT_GREEN if running else C_SOFT_RED

    def update_background(self, bg_color: str):
        self.configure(bg=bg_color)

    def _lerp_color(self, t: float) -> str:
        def parse(h: str):
            h = h.lstrip("#")
            return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

        r0, g0, b0 = parse(self._color_off)
        r1, g1, b1 = parse(self._color_on)
        r = int(r0 + (r1 - r0) * t)
        g = int(g0 + (g1 - g0) * t)
        b = int(b0 + (b1 - b0) * t)
        return f"#{r:02x}{g:02x}{b:02x}"

    def _animate(self):
        if not self._running or not self.winfo_exists():
            return
        import math
        t = (math.sin(self._step * math.pi / (self._PERIOD / 50)) + 1) / 2
        color = self._lerp_color(t)
        self.itemconfig(self._oval, fill=color)
        self._step += 1
        self._after_id = self.after(50, self._animate)

    def stop(self):
        self._running = False
        if self._after_id:
            try:
                self.after_cancel(self._after_id)
            except Exception:
                pass
            self._after_id = None

    def destroy(self):
        self.stop()
        super().destroy()


# ── Dynamic Canvas Icons ──────────────────────────────────────────────────────

class NavigationIcon(ctk.CTkCanvas):
    """High-DPI vector icons rendered cleanly via Tkinter Canvas."""

    def __init__(self, parent, kind: str, color: str, background: str, size: int = 18):
        super().__init__(
            parent, width=size, height=size, highlightthickness=0, bd=0,
            bg=background,
        )
        self._kind = kind
        self._color = color
        self._background = background
        self._size = size
        self._draw()

    def update_colors(self, color: str, background: str):
        self._color = color
        self._background = background
        self.configure(bg=background)
        self._draw()

    def _draw(self):
        self.delete("all")
        color = self._color
        s = self._size / 18.0
        line = {"fill": color, "width": max(1.5, 1.7 * s), "capstyle": "round", "joinstyle": "round", "tags": "icon"}

        if self._kind == "dashboard":
            for x, y in ((2, 2), (10, 2), (2, 10), (10, 10)):
                self.create_rectangle(x * s, y * s, (x + 6) * s, (y + 6) * s, outline=color, width=1.5 * s, tags="icon")
        elif self._kind == "devices":
            self.create_rectangle(5 * s, 1.5 * s, 13 * s, 16.5 * s, outline=color, width=1.6 * s, tags="icon")
            self.create_line(8 * s, 14.2 * s, 10 * s, 14.2 * s, **line)
            self.create_line(7.5 * s, 3.5 * s, 10.5 * s, 3.5 * s, **line)
        elif self._kind == "folders":
            self.create_line(2 * s, 5 * s, 7 * s, 5 * s, 8.5 * s, 3 * s, 14 * s, 3 * s, **line)
            self.create_line(2 * s, 5 * s, 2 * s, 15 * s, 16 * s, 15 * s, 16 * s, 5 * s, 2 * s, 5 * s, **line)
        elif self._kind == "settings":
            self.create_oval(5.3 * s, 5.3 * s, 12.7 * s, 12.7 * s, outline=color, width=1.6 * s, tags="icon")
            self.create_oval(7.8 * s, 7.8 * s, 10.2 * s, 10.2 * s, fill=color, outline="", tags="icon")
            for x1, y1, x2, y2 in ((9, 1.5, 9, 4), (9, 14, 9, 16.5), (1.5, 9, 4, 9), (14, 9, 16.5, 9)):
                self.create_line(x1 * s, y1 * s, x2 * s, y2 * s, **line)
        elif self._kind == "logs":
            self.create_rectangle(3 * s, 1.5 * s, 15 * s, 16.5 * s, outline=color, width=1.5 * s, tags="icon")
            self.create_line(6 * s, 6 * s, 12 * s, 6 * s, **line)
            self.create_line(6 * s, 9.5 * s, 12 * s, 9.5 * s, **line)
            self.create_line(6 * s, 13 * s, 10 * s, 13 * s, **line)
        elif self._kind == "history":
            self.create_oval(2 * s, 2 * s, 16 * s, 16 * s, outline=color, width=1.6 * s, tags="icon")
            self.create_line(9 * s, 5 * s, 9 * s, 9.2 * s, 12.2 * s, 11 * s, **line)
        elif self._kind == "storage":
            self.create_oval(3 * s, 2 * s, 15 * s, 6.5 * s, outline=color, width=1.5 * s, tags="icon")
            self.create_line(3 * s, 4.2 * s, 3 * s, 14 * s, 15 * s, 14 * s, 15 * s, 4.2 * s, **line)
            self.create_arc(3 * s, 9 * s, 15 * s, 15 * s, start=0, extent=180, style="arc", outline=color, width=1.5 * s, tags="icon")
        elif self._kind in ("share", "post_to_devices"):
            self.create_rectangle(2 * s, 8 * s, 16 * s, 16.5 * s, outline=color, width=1.5 * s, tags="icon")
            self.create_line(9 * s, 2 * s, 9 * s, 11 * s, **line)
            self.create_line(5.5 * s, 5.5 * s, 9 * s, 2 * s, 12.5 * s, 5.5 * s, **line)
        elif self._kind == "posts":
            self.create_rectangle(2 * s, 2 * s, 16 * s, 16 * s, outline=color, width=1.5 * s, tags="icon")
            self.create_line(5 * s, 6 * s, 13 * s, 6 * s, **line)
            self.create_line(5 * s, 9.5 * s, 13 * s, 9.5 * s, **line)
            self.create_line(5 * s, 13 * s, 9.5 * s, 13 * s, **line)
        else:  # file default
            self.create_line(4.5 * s, 1.5 * s, 11.5 * s, 1.5 * s, 15 * s, 5 * s, 15 * s, 16.5 * s, 4.5 * s, 16.5 * s, 4.5 * s, 1.5 * s, **line)
            self.create_line(11.5 * s, 1.5 * s, 11.5 * s, 5 * s, 15 * s, 5 * s, **line)


# ── Main Application ──────────────────────────────────────────────────────────

class BackupServerApp(ctk.CTk, TkinterDnD.DnDWrapper):

    PAGES = ["dashboard", "devices", "post_to_devices", "posts", "shared_folders", "settings", "logs", "history"]
    PAGE_LABELS = {
        "dashboard": "Dashboard",
        "devices":   "Devices",
        "post_to_devices": "Post to Devices",
        "posts":     "Posts",
        "shared_folders": "Shared Folders",
        "settings":  "Settings",
        "logs":      "Logs",
        "history":   "Sync History",
    }
    PAGE_NAV_ICONS = {
        "dashboard": "dashboard",
        "devices": "devices",
        "post_to_devices": "share",
        "posts": "posts",
        "shared_folders": "folders",
        "settings": "settings",
        "logs": "logs",
        "history": "history",
    }

    def __init__(self):
        super().__init__()
        self.TkdndVersion = TkinterDnD._require(self)

        # Typography hierarchy
        global FONT_TITLE, FONT_SUBTITLE, FONT_SECTION, FONT_BODY, FONT_BODY_B, FONT_SMALL, FONT_SMALL_B, FONT_MONO, FONT_CAPTION
        FONT_TITLE    = ctk.CTkFont(family="Segoe UI Variable Display", size=24, weight="bold")
        FONT_SUBTITLE = ctk.CTkFont(family="Segoe UI Variable Text", size=13)
        FONT_SECTION  = ctk.CTkFont(family="Segoe UI Variable Text", size=10, weight="bold")
        FONT_BODY     = ctk.CTkFont(family="Segoe UI Variable Text", size=13)
        FONT_BODY_B   = ctk.CTkFont(family="Segoe UI Variable Text", size=13, weight="bold")
        FONT_SMALL    = ctk.CTkFont(family="Segoe UI Variable Text", size=11)
        FONT_SMALL_B  = ctk.CTkFont(family="Segoe UI Variable Text", size=11, weight="bold")
        FONT_MONO     = ctk.CTkFont(family="Consolas", size=11)
        FONT_CAPTION  = ctk.CTkFont(family="Segoe UI Variable Text", size=10)

        self.title("Phone Backup Server")
        self.geometry("1280x800")
        self.minsize(1000, 660)
        self.configure(fg_color=C_BG)

        # App Icon
        _ico = _resolve_asset("icon.ico")
        if os.path.exists(_ico):
            try:
                self.iconbitmap(_ico)
            except Exception:
                pass

        # Server & Runtime State
        self._uvicorn_server: uvicorn.Server | None = None
        self._server_thread:  threading.Thread | None = None
        self._server_running  = False
        self._current_page:   str | None = None
        self._current_addr:   str = ""
        self._server_start_time: float | None = None

        # Caching & Differential update states
        self._device_card_widgets: dict[str, dict] = {}
        self._post_card_widgets:   dict[str, dict] = {}
        self._shared_folder_card_widgets: dict[str, dict] = {}
        self._last_dash_logs: list[dict] = []
        self._last_logs_cache: list[dict] = []
        self._last_logs_query: str = ""
        self._hist_cache_key: str = ""
        self._hist_sessions_cache: list[dict] = []

        # Shared Dirs & Posting State
        self._shared_dirs: list[dict] = list(load_config().get("SHARED_DIRS", []))
        self._shared_dirs_save_after_id: str | None = None
        self._post_selected_files: list[str] = []
        self._post_device_vars: dict[str, tk.BooleanVar] = {}
        self._posts_search_after_id: str | None = None
        self._devices_search_after_id: str | None = None
        self._shared_search_after_id: str | None = None
        self._theme_rebuild_after_id: str | None = None

        # In-flight refresh guards — prevent stacking on rapid page switches
        self._refresh_in_flight: dict[str, bool] = {}
        self._devices_empty_widget: ctk.CTkFrame | None = None

        # Pagination state for Posts and History
        self._posts_page: int = 0
        self._posts_page_size: int = 25
        self._posts_all_matched: list = []
        self._hist_page: int = 0
        self._hist_page_size: int = 30
        self._hist_all_sessions: list = []

        # Chunked-render cancel handles (prevent stacked after() calls)
        self._posts_chunk_after_id: str | None = None
        self._hist_chunk_after_id:  str | None = None
        self._post_devices_filter_after_id: str | None = None

        # Settings Draft & System Tray
        self._settings_draft: dict[str, object] | None = None
        self._tray_icon = None
        self._tray_thread: threading.Thread | None = None
        self._tray_enabled = bool(load_config().get("MINIMIZE_TO_TRAY", True))
        self.bind("<Unmap>", self._on_minimize)

        # Build Layout Architecture
        self._setup_grid()
        self._build_sidebar()
        self._build_statusbar()
        self._build_content_area()

        # Show Initial Page
        self._show_page("dashboard")

        # Start background polling
        self.after(500,  self._poll_pending_connections)
        self.after(3000, self._auto_refresh)
        self.after(1000, self._tick_uptime)

        # Launch Server
        self._start_server()
        self.after(2500, _ensure_desktop_device)

        self.protocol("WM_DELETE_WINDOW", self._on_close)

    # ─── Grid ────────────────────────────────────────────────────────────────

    def _setup_grid(self):
        self.grid_columnconfigure(1, weight=1)
        self.grid_rowconfigure(0, weight=1)

    # ─── Sidebar Navigation ──────────────────────────────────────────────────

    def _build_sidebar(self):
        """Build the clean modern sidebar with vector icons, state card and copy tool."""
        sidebar = ctk.CTkFrame(
            self, width=220, corner_radius=0, fg_color=C_SURFACE,
            border_width=0,
        )
        sidebar.grid(row=0, column=0, rowspan=2, sticky="nsew")
        sidebar.grid_propagate(False)
        sidebar.pack_propagate(False)

        # Brand Header
        brand = ctk.CTkFrame(sidebar, height=88, fg_color="transparent")
        brand.pack(fill="x", padx=14, pady=(12, 0))
        brand.pack_propagate(False)

        brand_row = ctk.CTkFrame(brand, fg_color="transparent")
        brand_row.pack(fill="x", pady=(8, 0))
        mark = ctk.CTkFrame(
            brand_row, width=38, height=38, fg_color=C_SOFT_BLUE, corner_radius=11,
        )
        mark.pack(side="left")
        mark.pack_propagate(False)
        ctk.CTkLabel(
            mark, text="PB", font=ctk.CTkFont(family="Segoe UI Variable Display", size=14, weight="bold"),
            text_color=C_ACCENT,
        ).pack(expand=True)

        brand_copy = ctk.CTkFrame(brand_row, fg_color="transparent")
        brand_copy.pack(side="left", fill="x", expand=True, padx=(10, 0), pady=(1, 0))
        ctk.CTkLabel(
            brand_copy, text="Phone Backup",
            font=ctk.CTkFont(family="Segoe UI Variable Display", size=14, weight="bold"),
            text_color=C_TEXT, anchor="w",
        ).pack(fill="x")
        ctk.CTkLabel(
            brand_copy, text="SERVER CONSOLE",
            font=ctk.CTkFont(family="Segoe UI Variable Text", size=8, weight="bold"),
            text_color=C_ACCENT, anchor="w",
        ).pack(fill="x", pady=(1, 0))

        ctk.CTkLabel(
            sidebar, text="WORKSPACE",
            font=FONT_SECTION, text_color=C_MUTED, anchor="w",
        ).pack(fill="x", padx=20, pady=(10, 4))

        nav_container = ctk.CTkFrame(sidebar, fg_color="transparent")
        nav_container.pack(fill="x", padx=8)

        self._nav_btns: dict[str, ctk.CTkButton] = {}
        self._nav_accents: dict[str, ctk.CTkFrame] = {}
        self._nav_rows: dict[str, ctk.CTkFrame] = {}
        self._nav_icon_tiles: dict[str, ctk.CTkFrame] = {}
        self._nav_icons: dict[str, NavigationIcon] = {}

        for page in self.PAGES:
            row = ctk.CTkFrame(nav_container, fg_color="transparent", height=42, corner_radius=10)
            row.pack(fill="x", pady=2)
            row.pack_propagate(False)
            self._nav_rows[page] = row

            icon_tile = ctk.CTkFrame(
                row, width=30, height=30, fg_color=C_ELEVATED, corner_radius=8,
            )
            icon_tile.pack(side="left", padx=(6, 2), pady=6)
            icon_tile.pack_propagate(False)
            nav_icon = NavigationIcon(
                icon_tile, self.PAGE_NAV_ICONS[page], C_MUTED, C_ELEVATED, size=16,
            )
            nav_icon.pack(expand=True)
            self._bind_click_tree(icon_tile, lambda p=page: self._show_page(p))
            self._nav_icon_tiles[page] = icon_tile
            self._nav_icons[page] = nav_icon

            btn = ctk.CTkButton(
                row, text=self.PAGE_LABELS[page], anchor="w",
                corner_radius=8, height=36, fg_color="transparent",
                hover_color=C_ELEVATED, text_color=C_MUTED,
                font=ctk.CTkFont(family="Segoe UI Variable Text", size=12),
                command=lambda p=page: self._show_page(p),
            )
            btn.pack(side="left", fill="both", expand=True, padx=(2, 6), pady=3)
            self._nav_btns[page] = btn

            accent = ctk.CTkFrame(row, width=3, fg_color="transparent", corner_radius=2)
            accent.pack(side="right", fill="y", pady=8, padx=(0, 2))
            self._nav_accents[page] = accent

        # Sidebar Footer
        footer = ctk.CTkFrame(sidebar, fg_color="transparent")
        footer.pack(side="bottom", fill="x", padx=10, pady=(6, 12))

        server_summary = ctk.CTkFrame(
            footer, fg_color=C_ELEVATED, corner_radius=12, border_width=1, border_color=C_BORDER,
        )
        server_summary.pack(fill="x", pady=(0, 8))

        top_sum = ctk.CTkFrame(server_summary, fg_color="transparent")
        top_sum.pack(fill="x", padx=10, pady=(8, 2))
        self._sidebar_state_lbl = ctk.CTkLabel(
            top_sum, text="Server starting…",
            font=ctk.CTkFont(family="Segoe UI Variable Text", size=11, weight="bold"),
            text_color=C_TEXT, anchor="w",
        )
        self._sidebar_state_lbl.pack(side="left")

        self._sidebar_endpoint_lbl = ctk.CTkLabel(
            server_summary, text="Preparing connection",
            font=ctk.CTkFont(family="Segoe UI Variable Text", size=10),
            text_color=C_MUTED, anchor="w",
        )
        self._sidebar_endpoint_lbl.pack(fill="x", padx=10, pady=(0, 4))

        ep_row = ctk.CTkFrame(server_summary, fg_color="transparent")
        ep_row.pack(fill="x", padx=10, pady=(0, 8))
        self._sidebar_copy_btn = ctk.CTkButton(
            ep_row, text="Copy URL", width=72, height=24,
            fg_color=C_SOFT_BLUE, hover_color=C_SOFT_BLUE_HOVER, text_color=C_ACCENT,
            font=FONT_CAPTION, corner_radius=6, border_width=1, border_color=C_BORDER,
            command=self._copy_server_url,
        )
        self._sidebar_copy_btn.pack(side="left")

        self._toggle_btn = ctk.CTkButton(
            footer, text="Stop Server", fg_color=C_SOFT_RED,
            hover_color=C_SOFT_RED_HOVER, text_color=C_ERROR,
            border_width=1, border_color=C_ERROR_BORDER, height=38,
            corner_radius=10, font=FONT_BODY_B,
            command=self._toggle_server,
        )
        self._toggle_btn.pack(fill="x")
        self._configure_server_button()

    # ─── Status Bar ──────────────────────────────────────────────────────────

    def _build_statusbar(self):
        """Top-level live status bar displaying health, background jobs, and uptime."""
        bar = ctk.CTkFrame(
            self, height=52, corner_radius=0, fg_color=C_SURFACE,
            border_width=0,
        )
        bar.grid(row=1, column=1, sticky="ew")
        bar.grid_propagate(False)

        ctk.CTkFrame(bar, height=1, fg_color=C_BORDER, corner_radius=0).pack(
            fill="x", side="top"
        )
        left = ctk.CTkFrame(bar, fg_color="transparent")
        left.pack(side="left", fill="y", padx=(20, 0))

        self._dot = BreathingDot(left, size=11)
        self._dot.pack(side="left", padx=(0, 8), pady=16)
        self._status_lbl = ctk.CTkLabel(
            left, text="Starting",
            font=ctk.CTkFont(family="Segoe UI Variable Text", size=13, weight="bold"),
            text_color=C_TEXT,
        )
        self._status_lbl.pack(side="left")

        self._activity_pill = ctk.CTkFrame(
            left, fg_color=C_SOFT_BLUE, corner_radius=8,
            border_width=1, border_color=C_BORDER,
        )
        self._activity_pill.pack(side="left", padx=(12, 0))
        self._activity_lbl = ctk.CTkLabel(
            self._activity_pill, text="Ready",
            font=ctk.CTkFont(family="Segoe UI Variable Text", size=11),
            text_color=C_ACCENT,
        )
        self._activity_lbl.pack(padx=8, pady=2)

        right = ctk.CTkFrame(bar, fg_color="transparent")
        right.pack(side="right", fill="y", padx=20)
        self._uptime_lbl = ctk.CTkLabel(
            right, text="",
            font=ctk.CTkFont(family="Segoe UI Variable Text", size=11),
            text_color=C_MUTED,
        )
        self._uptime_lbl.pack(side="right", padx=(12, 0))

        self._addr_lbl = ctk.CTkLabel(
            right, text="",
            font=ctk.CTkFont(family="Segoe UI Variable Text", size=12, weight="bold"),
            text_color=C_HIGHLIGHT,
        )
        self._addr_lbl.pack(side="right")

    def _set_status(self, running: bool, addr: str = ""):
        self._current_addr = addr if running else ""
        self._dot.set_running(running)
        if running:
            self._status_lbl.configure(text="Server Online", text_color=C_SUCCESS)
            self._addr_lbl.configure(text=addr)
            self._sidebar_state_lbl.configure(text="Server Online", text_color=C_SUCCESS)
            self._sidebar_endpoint_lbl.configure(text=addr or "Listening for devices")
            self._sidebar_copy_btn.configure(state="normal")
        else:
            self._status_lbl.configure(text="Server Offline", text_color=C_ERROR)
            self._addr_lbl.configure(text="")
            self._uptime_lbl.configure(text="")
            self._activity_lbl.configure(text="Stopped")
            self._sidebar_state_lbl.configure(text="Server Offline", text_color=C_ERROR)
            self._sidebar_endpoint_lbl.configure(text="Start server to accept connections")
            self._sidebar_copy_btn.configure(state="disabled")

    def _configure_server_button(self):
        if self._server_running:
            self._toggle_btn.configure(
                text="Stop Server", fg_color=C_SOFT_RED, hover_color=C_SOFT_RED_HOVER,
                text_color=C_ERROR, border_width=1, border_color=C_ERROR_BORDER,
            )
        else:
            self._toggle_btn.configure(
                text="Start Server", fg_color=C_SOFT_GREEN, hover_color=C_SOFT_GREEN_HOVER,
                text_color=C_SUCCESS, border_width=1, border_color=C_SUCCESS_BORDER,
            )

    def _copy_server_url(self):
        if self._current_addr:
            self._copy_to_clipboard(self._current_addr, self._sidebar_copy_btn, "Copied!")

    def _copy_to_clipboard(self, text: str, status_widget=None, msg: str = "Copied!"):
        self.clipboard_clear()
        self.clipboard_append(text)
        if status_widget and hasattr(status_widget, "configure"):
            original_text = status_widget.cget("text")
            status_widget.configure(text=msg)
            self.after(1400, lambda: status_widget.configure(text=original_text) if status_widget.winfo_exists() else None)

    def _rebuild_shell(self):
        page = self._current_page or "dashboard"
        for widget in self.grid_slaves():
            widget.destroy()
        self._device_card_widgets = {}
        self._last_dash_logs = []
        self._last_logs_cache = []
        self._last_logs_query = ""
        # Reset lazy-page cache so all pages are rebuilt fresh after a theme change
        self._pages = {}
        self.configure(fg_color=C_BG)
        self._setup_grid()
        self._build_sidebar()
        self._build_statusbar()
        self._build_content_area()
        self._show_page(page if page in self.PAGES else "dashboard")
        self._set_status(self._server_running, self._current_addr)
        self._configure_server_button()

    def _tick_uptime(self):
        if self._server_running and self._server_start_time:
            elapsed = int(time.time() - self._server_start_time)
            h = elapsed // 3600
            m = (elapsed % 3600) // 60
            s = elapsed % 60
            activity = get_current_activity()
            if activity and activity.get("message"):
                msg = activity["message"]
                if len(msg) > 75:
                    msg = msg[:72] + "…"
                self._activity_lbl.configure(text=msg)
                self._activity_pill.configure(fg_color=C_SOFT_BLUE)
            else:
                self._activity_lbl.configure(text="Ready")
                self._activity_pill.configure(fg_color=C_ELEVATED)
            self._uptime_lbl.configure(text=f"Uptime {h:02d}:{m:02d}:{s:02d}")
        self.after(1000, self._tick_uptime)

    # ─── Content Area ────────────────────────────────────────────────────────

    def _build_content_area(self):
        container = ctk.CTkFrame(self, corner_radius=0, fg_color=C_BG)
        container.grid(row=0, column=1, sticky="nsew")
        container.grid_columnconfigure(0, weight=1)
        container.grid_rowconfigure(0, weight=1)
        self._frames_container = container

        # Lazy loading: pages are built on first visit, not all at startup.
        self._pages: dict[str, ctk.CTkFrame] = {}
        self._page_builders = {
            "dashboard":       self._build_dashboard,
            "devices":         self._build_devices,
            "post_to_devices": self._build_post_to_devices,
            "posts":           self._build_posts,
            "shared_folders":  self._build_shared_folders,
            "settings":        self._build_settings,
            "logs":            self._build_logs,
            "history":         self._build_history,
        }

    # ─── Shared UI Helpers ───────────────────────────────────────────────────

    def _page_header(self, parent, title: str, subtitle: str = "") -> ctk.CTkFrame:
        hdr = ctk.CTkFrame(parent, fg_color="transparent")
        hdr.pack(fill="x", padx=32, pady=(20, 0))
        title_stack = ctk.CTkFrame(hdr, fg_color="transparent")
        title_stack.pack(side="left", fill="y")
        ctk.CTkLabel(
            title_stack, text=title, font=FONT_TITLE, text_color=C_TEXT, anchor="w",
        ).pack(fill="x")
        if subtitle:
            ctk.CTkLabel(
                title_stack, text=subtitle, font=FONT_SUBTITLE, text_color=C_MUTED, anchor="w",
            ).pack(fill="x", pady=(2, 0))
        return hdr

    def _divider(self, parent):
        ctk.CTkFrame(parent, height=1, fg_color=C_BORDER).pack(
            fill="x", padx=32, pady=(12, 0)
        )

    def _section_label(self, parent, text: str):
        ctk.CTkLabel(
            parent, text=text.upper(),
            font=FONT_SECTION, text_color=C_MUTED,
        ).pack(anchor="w", padx=32, pady=(16, 6))

    def _bind_click_tree(self, widget, command):
        try:
            widget.configure(cursor="hand2")
        except Exception:
            pass
        widget.bind("<Button-1>", lambda _event: command(), add="+")
        for child in widget.winfo_children():
            self._bind_click_tree(child, command)

    # ─── Page: Dashboard ─────────────────────────────────────────────────────

    def _build_dashboard(self, parent) -> ctk.CTkFrame:
        frame = ctk.CTkFrame(parent, fg_color=C_BG)

        hdr = self._page_header(frame, "Dashboard", "System health and backup overview")
        quick_actions = ctk.CTkFrame(hdr, fg_color="transparent")
        quick_actions.pack(side="right", pady=(2, 0))

        ctk.CTkButton(
            quick_actions, text="Share files", width=110, height=34,
            fg_color=C_ACCENT, hover_color=C_ACCENT2, corner_radius=10,
            font=FONT_SMALL_B, command=lambda: self._show_page("post_to_devices"),
        ).pack(side="left", padx=(0, 8))
        ctk.CTkButton(
            quick_actions, text="Shared folders", width=116, height=34,
            fg_color=C_SOFT_BLUE, hover_color=C_SOFT_BLUE_HOVER, text_color=C_ACCENT,
            border_width=1, border_color=C_BORDER, corner_radius=10,
            font=FONT_SMALL_B, command=lambda: self._show_page("shared_folders"),
        ).pack(side="left")
        self._divider(frame)

        # ── Stat Cards ────────────────────────────────────────────────────────
        cards_row = ctk.CTkFrame(frame, fg_color="transparent")
        cards_row.pack(fill="x", padx=26, pady=(14, 0))

        card_defs = [
            ("file", "Total Files", C_ACCENT, "_s_files", self._open_backup_root),
            ("devices", "Connected Devices", C_INFO, "_s_devices", lambda: self._show_page("devices")),
            ("storage", "Total Backup Size", C_WARNING, "_s_size", None),
            ("history", "Last Backup Activity", C_SUCCESS, "_s_last", lambda: self._show_page("history")),
        ]
        for icon, label, color, attr, command in card_defs:
            lbl = self._stat_card(cards_row, icon, label, "-", color, command)
            setattr(self, attr, lbl)

        # ── Quick Action Tiles ────────────────────────────────────────────────
        quick_row = ctk.CTkFrame(frame, fg_color="transparent")
        quick_row.pack(fill="x", padx=32, pady=(14, 0))
        for title, detail, action in (
            ("Manage Devices", "Inspect paired devices, browse files, or edit names.", lambda: self._show_page("devices")),
            ("Posts & Shares", "Search sent posts, edit captions, and adjust recipients.", lambda: self._show_page("posts")),
            ("Shared Locations", "Configure PC folders available for device restore.", lambda: self._show_page("shared_folders")),
        ):
            action_card = ctk.CTkFrame(
                quick_row, fg_color=C_SURFACE, corner_radius=12,
                border_width=1, border_color=C_BORDER,
            )
            action_card.pack(side="left", fill="x", expand=True, padx=4)
            ctk.CTkLabel(action_card, text=title, font=FONT_BODY_B, text_color=C_TEXT, anchor="w").pack(fill="x", padx=14, pady=(10, 1))
            ctk.CTkLabel(action_card, text=detail, font=FONT_CAPTION, text_color=C_MUTED, anchor="w", justify="left", wraplength=220).pack(fill="x", padx=14, pady=(0, 10))
            self._bind_click_tree(action_card, action)

        # ── Recent Activity Feed ──────────────────────────────────────────────
        self._section_label(frame, "Live Activity Log")

        log_frame = ctk.CTkFrame(
            frame, fg_color=C_SURFACE,
            corner_radius=14, border_width=1, border_color=C_BORDER,
        )
        log_frame.pack(fill="both", expand=True, padx=32, pady=(4, 16))

        self._dash_log = ctk.CTkTextbox(
            log_frame, state="disabled", fg_color="transparent",
            border_width=0, font=FONT_MONO, text_color=C_TEXT,
            wrap="word",
        )
        self._dash_log.pack(fill="both", expand=True, padx=6, pady=6)
        self._setup_log_tags(self._dash_log)

        return frame

    def _stat_card(self, parent, icon: str, label: str, value: str, accent: str, command=None) -> ctk.CTkLabel:
        inner = ctk.CTkFrame(
            parent,
            fg_color=C_CARD,
            corner_radius=14,
            border_width=1,
            border_color=C_BORDER,
        )
        inner.pack(side="left", fill="both", expand=True, padx=6, pady=4)

        _BADGE_TINTS = {
            C_ACCENT:  C_SOFT_BLUE,
            C_ACCENT2: C_SOFT_BLUE,
            C_INFO:    C_SOFT_INFO,
            C_WARNING: C_SOFT_AMBER,
            C_SUCCESS: C_SOFT_GREEN,
        }
        badge = ctk.CTkFrame(
            inner, width=36, height=36,
            fg_color=_BADGE_TINTS.get(accent, C_ELEVATED),
            corner_radius=10,
        )
        badge.pack(anchor="w", padx=14, pady=(12, 4))
        badge.pack_propagate(False)
        NavigationIcon(
            badge, icon, accent, _BADGE_TINTS.get(accent, C_ELEVATED), size=16,
        ).pack(expand=True)

        val_lbl = ctk.CTkLabel(
            inner, text=value,
            font=ctk.CTkFont(family="Segoe UI Variable Display", size=22, weight="bold"),
            text_color=C_TEXT, anchor="w",
        )
        val_lbl.pack(anchor="w", padx=14, pady=(0, 0))
        ctk.CTkLabel(
            inner, text=label, font=FONT_SMALL, text_color=C_MUTED, anchor="w",
        ).pack(fill="x", padx=14, pady=(1, 12))

        def _enter(e):
            inner.configure(fg_color=C_ELEVATED, border_color=accent)
        def _leave(e):
            inner.configure(fg_color=C_CARD, border_color=C_BORDER)

        inner.bind("<Enter>", _enter)
        inner.bind("<Leave>", _leave)
        for child in inner.winfo_children():
            child.bind("<Enter>", _enter)
            child.bind("<Leave>", _leave)
        if command:
            self._bind_click_tree(inner, command)

        return val_lbl

    def _open_backup_root(self):
        root = str(load_config().get("BACKUP_ROOT", "")).strip()
        if not root:
            messagebox.showwarning("Backup Folder", "Choose a backup root folder in Settings first.")
            self._show_page("settings")
            return

        root = os.path.abspath(os.path.expanduser(os.path.expandvars(root)))
        try:
            os.makedirs(root, exist_ok=True)
            os.startfile(root)  # type: ignore[attr-defined]
        except Exception as exc:
            messagebox.showerror("Backup Folder", f"Could not open backup folder:\n{exc}")

    def _setup_log_tags(self, box: ctk.CTkTextbox):
        txt: tk.Text = box._textbox
        txt.tag_config("success", foreground=C_SUCCESS)
        txt.tag_config("error",   foreground=C_ERROR)
        txt.tag_config("warning", foreground=C_WARNING)
        txt.tag_config("info",    foreground=C_INFO)
        txt.tag_config("muted",   foreground=C_MUTED)
        txt.tag_config("ts",      foreground=C_LOG_TS)

    def _insert_log_line(self, box: ctk.CTkTextbox, entry: dict):
        box.configure(state="normal")
        ts = datetime.fromtimestamp(entry["time"]).strftime("%H:%M:%S")
        msg: str = entry["message"]

        txt: tk.Text = box._textbox
        txt.insert("end", f"[{ts}]  ", ("ts",))

        lower_msg = msg.lower()
        if any(word in lower_msg for word in ("accepted", "started", "saved", "completed", "rebuilt", "cleared")):
            tag = "success"
        elif any(word in lower_msg for word in ("error", "rejected", "removed", "occupied", "failed")):
            tag = "error"
        elif "warning" in lower_msg:
            tag = "warning"
        elif any(word in lower_msg for word in ("server", "device", "backup", "file", "upload")):
            tag = "info"
        else:
            tag = "muted"

        txt.insert("end", msg + "\n", (tag,))
        box.configure(state="disabled")

    def _refresh_dashboard(self):
        if self._refresh_in_flight.get("dashboard"):
            return
        self._refresh_in_flight["dashboard"] = True

        def _fetch():
            try:
                stats   = get_stats()
                devices = [d for d in get_devices() if d.get("device_id") != DESKTOP_SHARE_DEVICE_ID]
            except Exception:
                stats, devices = None, []
            # get_logs() reads in-memory state — safe to call from either thread
            logs = get_logs()[-25:]
            try:
                self.after(0, lambda: _render(stats, devices, logs))
            except RuntimeError:
                self._refresh_in_flight["dashboard"] = False

        def _render(stats, devices, logs):
            self._refresh_in_flight["dashboard"] = False
            try:
                if stats:
                    self._s_files.configure(text=f"{stats['total_files']:,}")
                    self._s_devices.configure(text=str(len(devices)))
                    self._s_size.configure(text=fmt_bytes(stats["total_size_bytes"] or 0))
                    self._s_last.configure(text=fmt_rel(stats.get("last_backup_time")))
                # Fast change detection: compare length + last timestamp (avoids O(n) list equality)
                last_ts = logs[-1]["time"] if logs else 0
                cached_ts = self._last_dash_logs[-1]["time"] if self._last_dash_logs else -1
                if len(logs) != len(self._last_dash_logs) or last_ts != cached_ts:
                    self._dash_log.configure(state="normal")
                    self._dash_log.delete("1.0", "end")
                    self._dash_log.configure(state="disabled")
                    for entry in reversed(logs):
                        self._insert_log_line(self._dash_log, entry)
                    self._last_dash_logs = logs.copy()
            except Exception:
                pass

        threading.Thread(target=_fetch, daemon=True).start()

    # ─── Page: Connected Devices ─────────────────────────────────────────────

    def _build_devices(self, parent) -> ctk.CTkFrame:
        frame = ctk.CTkFrame(parent, fg_color=C_BG)

        hdr = self._page_header(frame, "Connected Devices", "Devices paired with this backup server")
        controls = ctk.CTkFrame(hdr, fg_color="transparent")
        controls.pack(side="right")

        self._devices_search_var = tk.StringVar()
        self._device_filter = ctk.CTkEntry(
            controls, textvariable=self._devices_search_var, width=260, height=36,
            placeholder_text="Search name, model, IP, or ID…",
            fg_color=C_ELEVATED, border_color=C_BORDER, border_width=1,
            text_color=C_TEXT, corner_radius=10, font=FONT_BODY,
        )
        self._device_filter.pack(side="left", padx=(0, 8))
        self._devices_search_var.trace_add("write", lambda *_: self._schedule_devices_refresh())

        ctk.CTkButton(
            controls, text="Refresh", width=86, height=36,
            fg_color=C_SOFT_BLUE, hover_color=C_SOFT_BLUE_HOVER,
            text_color=C_ACCENT, border_width=1, border_color=C_BORDER,
            corner_radius=10, font=FONT_SMALL_B,
            command=self._refresh_devices,
        ).pack(side="right")

        self._divider(frame)
        self._devices_summary = ctk.CTkLabel(
            frame, text="", font=FONT_SMALL, text_color=C_MUTED, anchor="w",
        )
        self._devices_summary.pack(fill="x", padx=34, pady=(10, 0))

        self._devices_scroll = ctk.CTkScrollableFrame(
            frame, fg_color="transparent", label_text="",
        )
        self._devices_scroll.pack(fill="both", expand=True, padx=28, pady=(6, 16))

        return frame

    def _schedule_devices_refresh(self):
        if self._devices_search_after_id:
            try:
                self.after_cancel(self._devices_search_after_id)
            except Exception:
                pass
        self._devices_search_after_id = self.after(300, self._refresh_devices)

    def _edit_device_username(self, dev: dict):
        device_id = dev.get("device_id")
        if not device_id:
            return
        dialog = ctk.CTkInputDialog(
            text=f"Set a display name for \"{dev.get('device_name', 'this device')}\":",
            title="Set Device Display Name",
        )
        result = dialog.get_input()
        if result is None:
            return
        set_device_username(device_id, result.strip())
        add_log(f"Display name updated for {dev.get('device_name')}: {result.strip() or '(cleared)'}")
        did = str(dev.get("id"))
        if did in self._device_card_widgets:
            self._device_card_widgets[did]["outer"].destroy()
            del self._device_card_widgets[did]
        self._refresh_devices()

    def _refresh_devices(self):
        self._devices_search_after_id = None
        if self._refresh_in_flight.get("devices"):
            return
        self._refresh_in_flight["devices"] = True

        def _fetch():
            try:
                all_devices = [d for d in get_devices() if d.get("device_id") != DESKTOP_SHARE_DEVICE_ID]
            except Exception:
                all_devices = []
            try:
                self.after(0, lambda: _render(all_devices))
            except RuntimeError:
                self._refresh_in_flight["devices"] = False

        def _render(all_devices):
            self._refresh_in_flight["devices"] = False
            query = ""
            try:
                query = self._devices_search_var.get().strip().casefold()
            except (AttributeError, tk.TclError):
                pass

            devices = all_devices
            if query:
                devices = [
                    device for device in all_devices
                    if query in " ".join(str(device.get(key) or "") for key in (
                        "device_name", "username", "device_model", "device_ip", "device_id",
                    )).casefold()
                ]

            if hasattr(self, "_devices_summary"):
                total = len(all_devices)
                self._devices_summary.configure(
                    text=(f"{len(devices)} of {total} paired device{'s' if total != 1 else ''}" if query else
                          f"{total} paired device{'s' if total != 1 else ''}")
                )

            if self._devices_empty_widget and self._devices_empty_widget.winfo_exists():
                if devices:
                    self._devices_empty_widget.destroy()
                    self._devices_empty_widget = None

            if not devices:
                if self._devices_empty_widget and self._devices_empty_widget.winfo_exists():
                    return
                for w in self._devices_scroll.winfo_children():
                    w.destroy()
                self._device_card_widgets.clear()

                self._devices_empty_widget = ctk.CTkFrame(
                    self._devices_scroll, fg_color=C_SURFACE,
                    corner_radius=18, border_width=1, border_color=C_BORDER,
                )
                self._devices_empty_widget.pack(fill="x", padx=6, pady=24)
                empty_title = "No matching devices found" if query else "No devices connected yet"
                empty_message = (
                    "Try searching by another term or clear the filter." if query else
                    "Open Phone Backup on your Android device,\n"
                    "go to Settings > Server, and tap Discover\n"
                    f"or enter this machine's address: {self._current_addr or get_local_ip()}"
                )
                ctk.CTkLabel(
                    self._devices_empty_widget, text="PB",
                    font=ctk.CTkFont(family="Segoe UI", size=26, weight="bold"),
                    text_color=C_ACCENT,
                ).pack(pady=(30, 4))
                ctk.CTkLabel(
                    self._devices_empty_widget, text=empty_title,
                    font=FONT_BODY_B, text_color=C_TEXT,
                ).pack()
                ctk.CTkLabel(
                    self._devices_empty_widget, text=empty_message,
                    font=FONT_BODY, text_color=C_MUTED, justify="center",
                ).pack(pady=(6, 30))
                return

            current_ids = {str(dev["id"]) for dev in devices}
            for did in list(self._device_card_widgets.keys()):
                if did not in current_ids:
                    try:
                        self._device_card_widgets[did]["outer"].destroy()
                    except Exception:
                        pass
                    del self._device_card_widgets[did]

            for dev in devices:
                did = str(dev["id"])
                if did in self._device_card_widgets:
                    self._update_device_card(did, dev)
                else:
                    self._device_card_widgets[did] = self._device_card(self._devices_scroll, dev)

        threading.Thread(target=_fetch, daemon=True).start()

    def _update_device_card(self, did: str, dev: dict):
        widgets = self._device_card_widgets[did]
        last_seen = dev.get("last_seen")
        is_online = bool(last_seen and (int(time.time()) - last_seen) < 300)
        pill_color = C_SUCCESS if is_online else C_MUTED
        pill_bg = C_SOFT_GREEN if is_online else C_ELEVATED
        last_seen_text = "Online now" if is_online else fmt_rel(last_seen)

        widgets["pill"].configure(fg_color=pill_bg)
        widgets["pill_lbl"].configure(text=f"  {last_seen_text}  ", text_color=pill_color)
        widgets["chip_ip"].configure(text=f"  IP {dev['device_ip']}  ")
        widgets["chip_files"].configure(text=f"  {dev['files_backed_up']:,} files  ")

    @staticmethod
    def _device_backup_folder(dev: dict) -> str:
        import re
        configured_root = str(load_config().get("BACKUP_ROOT", "")).strip()
        if not configured_root:
            return ""
        root = os.path.abspath(configured_root)
        folder_name = dev.get("folder_name")
        device_id = dev.get("device_id")
        if folder_name:
            return os.path.join(root, folder_name)
        if device_id:
            return os.path.join(root, re.sub(r'[<>:"|?*]', "_", str(device_id)).strip())
        return root

    def _open_device_backup_folder(self, dev: dict):
        folder = self._device_backup_folder(dev)
        if not folder:
            messagebox.showwarning("Device Backup Folder", "Choose a backup root folder in Settings first.")
            return
        try:
            os.makedirs(folder, exist_ok=True)
            os.startfile(folder)  # type: ignore[attr-defined]
        except Exception as exc:
            messagebox.showerror("Device Backup Folder", f"Could not open backup folder:\n{exc}")

    def _open_post_composer_for_device(self, device_id: str):
        self._show_page("post_to_devices")
        if hasattr(self, "_post_device_filter_var"):
            self._post_device_filter_var.set("")
        self._refresh_post_devices_list()
        recipient = self._post_device_vars.get(device_id)
        if recipient:
            recipient.set(True)

    def _open_device_files_dialog(self, dev: dict):
        """Search and inspect backed-up files for a device with category filters."""
        device_id = str(dev.get("device_id") or "")
        if not device_id:
            return
        dialog = ctk.CTkToplevel(self)
        dialog.title(f"Backup Files · {format_display_name(dev)}")
        dialog.geometry("900x640")
        dialog.minsize(720, 480)
        dialog.transient(self)
        dialog.configure(fg_color=C_BG)

        header = ctk.CTkFrame(dialog, fg_color="transparent")
        header.pack(fill="x", padx=24, pady=(18, 0))
        ctk.CTkLabel(
            header, text=format_display_name(dev), font=FONT_TITLE,
            text_color=C_TEXT, anchor="w",
        ).pack(side="left")
        ctk.CTkButton(
            header, text="Open backup folder", width=140, height=34,
            fg_color=C_SOFT_BLUE, hover_color=C_SOFT_BLUE_HOVER, text_color=C_ACCENT,
            border_width=1, border_color=C_BORDER, corner_radius=9, font=FONT_SMALL_B,
            command=lambda: self._open_device_backup_folder(dev),
        ).pack(side="right")
        ctk.CTkLabel(
            dialog, text="Search and explore indexed backup records on this PC.",
            font=FONT_SUBTITLE, text_color=C_MUTED, anchor="w",
        ).pack(fill="x", padx=24, pady=(2, 10))

        # Search Controls
        search_card = ctk.CTkFrame(dialog, fg_color=C_SURFACE, corner_radius=12, border_width=1, border_color=C_BORDER)
        search_card.pack(fill="x", padx=24, pady=(0, 10))
        query_var = tk.StringVar()
        entry = ctk.CTkEntry(
            search_card, textvariable=query_var,
            placeholder_text="Search files, folders, or extensions (e.g. DCIM, .mp4, camera)…",
            height=38, fg_color=C_ELEVATED, border_color=C_BORDER, font=FONT_BODY,
        )
        entry.pack(side="left", fill="x", expand=True, padx=10, pady=10)

        cat_var = tk.StringVar(value="All")
        cat_menu = ctk.CTkOptionMenu(
            search_card, variable=cat_var, values=["All", "Photos", "Videos", "Audio", "Docs"],
            width=110, height=38, fg_color=C_ELEVATED, button_color=C_BORDER,
            text_color=C_TEXT, dropdown_fg_color=C_SURFACE,
            command=lambda _val: render_results(),
        )
        cat_menu.pack(side="right", padx=(0, 10), pady=10)

        status = ctk.CTkLabel(search_card, text="", font=FONT_SMALL, text_color=C_MUTED)
        status.pack(side="right", padx=(0, 10))

        results = ctk.CTkScrollableFrame(dialog, fg_color="transparent", label_text="")
        results.pack(fill="both", expand=True, padx=20, pady=(0, 16))
        search_after_id: str | None = None

        def copy_path(path: str, btn):
            self._copy_to_clipboard(path, btn, "Copied!")

        def open_file(path: str):
            root = self._device_backup_folder(dev)
            if not root:
                messagebox.showwarning("Open File", "Choose a backup root folder in Settings first.")
                return
            safe_relative = str(path).replace("\\", "/").lstrip("/")
            full_path = os.path.abspath(os.path.join(root, *safe_relative.split("/")))
            try:
                if os.path.commonpath([root, full_path]) != root:
                    raise ValueError("Invalid backup path")
                if not os.path.exists(full_path):
                    messagebox.showinfo("File not found", "This file is recorded in the backup index but is not currently on disk.")
                    return
                os.startfile(full_path)  # type: ignore[attr-defined]
            except Exception as exc:
                messagebox.showerror("Open File", f"Could not open file:\n{exc}")

        def render_results():
            nonlocal search_after_id
            search_after_id = None
            for child in results.winfo_children():
                child.destroy()
            query = query_var.get().strip()
            category = cat_var.get()

            if not query and category == "All":
                status.configure(text="Enter search")
                ctk.CTkLabel(results, text="Type a search query or select a category to browse records.", font=FONT_BODY, text_color=C_MUTED).pack(pady=40)
                return

            # Show searching indicator immediately
            status.configure(text="Searching…")
            ctk.CTkLabel(results, text="Searching…", font=FONT_BODY, text_color=C_MUTED).pack(pady=40)

            def _do_search():
                try:
                    rows = search_files_for_device(device_id, query or "", limit=500)
                except Exception:
                    rows = []

                # Category filter (pure Python — no I/O)
                if category == "Photos":
                    exts = (".jpg", ".jpeg", ".png", ".heic", ".webp", ".gif", ".bmp", ".dng")
                    rows = [r for r in rows if str(r.get("path", "")).lower().endswith(exts)]
                elif category == "Videos":
                    exts = (".mp4", ".mov", ".mkv", ".avi", ".3gp", ".webm", ".ts")
                    rows = [r for r in rows if str(r.get("path", "")).lower().endswith(exts)]
                elif category == "Audio":
                    exts = (".mp3", ".m4a", ".aac", ".flac", ".wav", ".ogg", ".opus")
                    rows = [r for r in rows if str(r.get("path", "")).lower().endswith(exts)]
                elif category == "Docs":
                    exts = (".pdf", ".doc", ".docx", ".txt", ".xlsx", ".csv", ".zip")
                    rows = [r for r in rows if str(r.get("path", "")).lower().endswith(exts)]

                if not dialog.winfo_exists():
                    return
                dialog.after(0, lambda: _show_results(rows))

            def _show_results(rows):
                if not results.winfo_exists():
                    return
                for child in results.winfo_children():
                    child.destroy()
                status.configure(text=f"{len(rows)} file{'s' if len(rows) != 1 else ''}" + (" (max 500)" if len(rows) == 500 else ""))
                if not rows:
                    ctk.CTkLabel(results, text="No backed-up files match your search criteria.", font=FONT_BODY, text_color=C_MUTED).pack(pady=40)
                    return

                for row in rows:
                    path = str(row.get("path") or "")
                    item = ctk.CTkFrame(results, fg_color=C_SURFACE, corner_radius=10, border_width=1, border_color=C_BORDER)
                    item.pack(fill="x", padx=4, pady=3)

                    copy_box = ctk.CTkFrame(item, fg_color="transparent")
                    copy_box.pack(side="left", fill="both", expand=True, padx=12, pady=8)
                    ctk.CTkLabel(copy_box, text=os.path.basename(path) or path, font=FONT_BODY_B, text_color=C_TEXT, anchor="w").pack(fill="x")
                    ctk.CTkLabel(copy_box, text=path, font=FONT_CAPTION, text_color=C_MUTED, anchor="w").pack(fill="x", pady=(1, 0))
                    ctk.CTkLabel(copy_box, text=f"{fmt_bytes(int(row.get('size') or 0))}  ·  modified {fmt_ts(row.get('modified_time'))}", font=FONT_CAPTION, text_color=C_MUTED, anchor="w").pack(fill="x", pady=(1, 0))

                    actions = ctk.CTkFrame(item, fg_color="transparent")
                    actions.pack(side="right", padx=10, pady=8)
                    cp_btn = ctk.CTkButton(actions, text="Copy path", width=76, height=28, fg_color="transparent", hover_color=C_ELEVATED, text_color=C_ACCENT, border_width=1, border_color=C_BORDER, corner_radius=7, font=FONT_CAPTION)
                    cp_btn.configure(command=lambda p=path, b=cp_btn: copy_path(p, b))
                    cp_btn.pack(side="left", padx=(0, 6))
                    ctk.CTkButton(actions, text="Open", width=58, height=28, fg_color=C_SOFT_BLUE, hover_color=C_SOFT_BLUE_HOVER, text_color=C_ACCENT, border_width=1, border_color=C_BORDER, corner_radius=7, font=FONT_CAPTION, command=lambda p=path: open_file(p)).pack(side="left")

            threading.Thread(target=_do_search, daemon=True).start()

        def schedule_search(*_):
            nonlocal search_after_id
            if search_after_id:
                try:
                    dialog.after_cancel(search_after_id)
                except Exception:
                    pass
            search_after_id = dialog.after(160, render_results)

        query_var.trace_add("write", schedule_search)
        entry.focus_set()
        render_results()

    def _device_card(self, parent, dev: dict) -> dict:
        card = ctk.CTkFrame(
            parent,
            fg_color=C_SURFACE,
            corner_radius=14,
            border_width=1,
            border_color=C_BORDER,
        )
        card.pack(fill="x", padx=6, pady=5)
        card.grid_columnconfigure(1, weight=1)

        # Phone Icon Badge
        icon_wrap = ctk.CTkFrame(
            card, width=48, height=48, fg_color=C_SOFT_BLUE,
            corner_radius=12,
        )
        icon_wrap.grid(row=0, column=0, rowspan=3, padx=(16, 10), pady=14)
        icon_wrap.grid_propagate(False)
        NavigationIcon(icon_wrap, "devices", C_ACCENT, C_SOFT_BLUE, size=20).pack(expand=True)

        # Name Row
        name_row = ctk.CTkFrame(card, fg_color="transparent")
        name_row.grid(row=0, column=1, sticky="sw", padx=4, pady=(14, 2))

        ctk.CTkLabel(
            name_row, text=format_display_name(dev),
            font=FONT_BODY_B, text_color=C_TEXT,
        ).pack(side="left")

        edit_name_btn = ctk.CTkButton(
            name_row, text="✎", width=22, height=22, corner_radius=6,
            fg_color=C_ELEVATED, hover_color=C_SOFT_BLUE, text_color=C_MUTED,
            font=ctk.CTkFont(size=11),
            command=lambda d=dev: self._edit_device_username(d),
        )
        edit_name_btn.pack(side="left", padx=(8, 0))

        # Online Status Pill
        last_seen = dev.get("last_seen")
        is_online = bool(last_seen and (int(time.time()) - last_seen) < 300)
        pill_color = C_SUCCESS if is_online else C_MUTED
        pill_bg = C_SOFT_GREEN if is_online else C_ELEVATED
        last_seen_text = "Online now" if is_online else fmt_rel(last_seen)

        pill = ctk.CTkFrame(name_row, fg_color=pill_bg, corner_radius=6)
        pill.pack(side="left", padx=(8, 0))
        pill_lbl = ctk.CTkLabel(
            pill, text=f"  {last_seen_text}  ",
            font=FONT_CAPTION, text_color=pill_color,
        )
        pill_lbl.pack()

        # Details Chips
        details_row = ctk.CTkFrame(card, fg_color="transparent")
        details_row.grid(row=1, column=1, sticky="nw", padx=4, pady=(0, 6))

        # IP Chip
        chip_ip_f = ctk.CTkFrame(details_row, fg_color=C_SOFT_INFO, corner_radius=6)
        chip_ip_f.pack(side="left", padx=(0, 6))
        chip_ip = ctk.CTkLabel(chip_ip_f, text=f"  IP {dev['device_ip']}  ", font=FONT_CAPTION, text_color=C_INFO)
        chip_ip.pack()

        # Files Chip
        chip_files_f = ctk.CTkFrame(details_row, fg_color=C_SOFT_BLUE, corner_radius=6)
        chip_files_f.pack(side="left", padx=(0, 6))
        chip_files = ctk.CTkLabel(chip_files_f, text=f"  {dev['files_backed_up']:,} files  ", font=FONT_CAPTION, text_color=C_ACCENT)
        chip_files.pack()

        # Model / Date Chip
        model = str(dev.get("device_model") or "").strip()
        if model:
            chip_mod_f = ctk.CTkFrame(details_row, fg_color=C_ELEVATED, corner_radius=6)
            chip_mod_f.pack(side="left", padx=(0, 6))
            ctk.CTkLabel(chip_mod_f, text=f"  {model}  ", font=FONT_CAPTION, text_color=C_MUTED).pack()

        chip_date_f = ctk.CTkFrame(details_row, fg_color=C_ELEVATED, corner_radius=6)
        chip_date_f.pack(side="left", padx=(0, 6))
        ctk.CTkLabel(chip_date_f, text=f"  since {fmt_ts(dev['first_seen'])[:10]}  ", font=FONT_CAPTION, text_color=C_MUTED).pack()

        # Actions Row
        actions_row = ctk.CTkFrame(card, fg_color="transparent")
        actions_row.grid(row=2, column=1, sticky="w", padx=4, pady=(0, 14))
        ctk.CTkButton(
            actions_row, text="Browse files", width=92, height=28,
            fg_color=C_SOFT_BLUE, hover_color=C_SOFT_BLUE_HOVER, text_color=C_ACCENT,
            border_width=1, border_color=C_BORDER, corner_radius=7, font=FONT_CAPTION,
            command=lambda d=dev: self._open_device_files_dialog(d),
        ).pack(side="left", padx=(0, 6))
        ctk.CTkButton(
            actions_row, text="Open folder", width=88, height=28,
            fg_color="transparent", hover_color=C_ELEVATED, text_color=C_ACCENT,
            border_width=1, border_color=C_BORDER, corner_radius=7, font=FONT_CAPTION,
            command=lambda d=dev: self._open_device_backup_folder(d),
        ).pack(side="left", padx=(0, 6))
        ctk.CTkButton(
            actions_row, text="Send post", width=84, height=28,
            fg_color="transparent", hover_color=C_ELEVATED, text_color=C_ACCENT,
            border_width=1, border_color=C_BORDER, corner_radius=7, font=FONT_CAPTION,
            command=lambda did=dev.get("device_id"): self._open_post_composer_for_device(str(did or "")),
        ).pack(side="left")

        # Remove Button
        dev_id   = dev["id"]
        dev_name = format_display_name(dev)

        def do_remove(did=dev_id, dname=dev_name):
            if confirm_dialog(
                self,
                "Remove Device",
                f"Remove '{dname}' from paired devices?\n\n"
                "New backups from this device will require approval before connecting again.",
            ):
                remove_device(did)
                add_log(f"Removed device: {dname}")
                self._refresh_devices()

        ctk.CTkButton(
            card, text="Remove", width=84, height=32,
            fg_color=C_SOFT_RED, hover_color=C_SOFT_RED_HOVER,
            text_color=C_ERROR, border_width=1, border_color=C_ERROR_BORDER,
            font=FONT_SMALL_B, corner_radius=8,
            command=do_remove,
        ).grid(row=0, column=2, rowspan=3, padx=16)

        return {
            "outer": card,
            "pill": pill,
            "pill_lbl": pill_lbl,
            "chip_ip": chip_ip,
            "chip_files": chip_files
        }

    # ─── Page: Post to Devices (Composer) ────────────────────────────────────

    def _build_post_to_devices(self, parent) -> ctk.CTkFrame:
        frame = ctk.CTkFrame(parent, fg_color=C_BG)
        header = self._page_header(frame, "Post to Devices", "Send files and photos directly to device feeds")
        ctk.CTkButton(
            header, text="Manage posts", width=110, height=34,
            fg_color=C_SOFT_BLUE, hover_color=C_SOFT_BLUE_HOVER, text_color=C_ACCENT,
            border_width=1, border_color=C_BORDER, corner_radius=9, font=FONT_SMALL_B,
            command=lambda: self._show_page("posts"),
        ).pack(side="right", pady=(2, 0))
        self._divider(frame)

        work_area = ctk.CTkFrame(frame, fg_color="transparent")
        work_area.pack(fill="both", expand=True, padx=32, pady=(14, 16))
        work_area.grid_columnconfigure(0, weight=3)
        work_area.grid_columnconfigure(1, weight=2)
        work_area.grid_rowconfigure(0, weight=1)

        # Left Column: File Drop & Selection
        left = ctk.CTkFrame(work_area, fg_color=C_SURFACE, corner_radius=14, border_width=1, border_color=C_BORDER)
        left.grid(row=0, column=0, sticky="nsew", padx=(0, 8))

        self._post_drop_zone = ctk.CTkFrame(
            left, fg_color=C_ELEVATED, corner_radius=12, border_width=2, border_color=C_BORDER, height=100,
        )
        self._post_drop_zone.pack(fill="x", padx=16, pady=(16, 8))
        self._post_drop_zone.pack_propagate(False)
        ctk.CTkLabel(self._post_drop_zone, text="Drag & drop files here, or", font=FONT_BODY, text_color=C_MUTED).pack(pady=(16, 4))
        ctk.CTkButton(
            self._post_drop_zone, text="Browse Files", width=130, height=32,
            fg_color=C_SOFT_BLUE, hover_color=C_SOFT_BLUE_HOVER, text_color=C_ACCENT,
            border_width=1, border_color=C_BORDER, corner_radius=8, font=FONT_SMALL_B,
            command=self._browse_post_files,
        ).pack()
        self._post_drop_zone.drop_target_register(DND_FILES)
        self._post_drop_zone.dnd_bind("<<Drop>>", self._on_files_dropped)

        list_header = ctk.CTkFrame(left, fg_color="transparent")
        list_header.pack(fill="x", padx=16, pady=(4, 6))
        ctk.CTkLabel(list_header, text="SELECTED FILES", font=FONT_SECTION, text_color=C_MUTED, anchor="w").pack(side="left")
        self._post_files_count = ctk.CTkLabel(list_header, text="0 files", font=FONT_CAPTION, text_color=C_MUTED, anchor="e")
        self._post_files_count.pack(side="right")

        self._post_files_list_frame = ctk.CTkScrollableFrame(
            left, fg_color=C_ELEVATED, corner_radius=10, border_width=1, border_color=C_BORDER, label_text="",
        )
        self._post_files_list_frame.pack(fill="both", expand=True, padx=16, pady=(0, 12))

        # Right Column: Post Metadata & Recipients
        right = ctk.CTkFrame(work_area, fg_color=C_SURFACE, corner_radius=14, border_width=1, border_color=C_BORDER)
        right.grid(row=0, column=1, sticky="nsew", padx=(8, 0))

        ctk.CTkLabel(right, text="CAPTION / MESSAGE", font=FONT_SECTION, text_color=C_MUTED, anchor="w").pack(fill="x", padx=16, pady=(16, 6))
        self._post_caption_box = ctk.CTkTextbox(
            right, height=64, fg_color=C_ELEVATED, corner_radius=9, border_width=1, border_color=C_BORDER, font=FONT_BODY,
        )
        self._post_caption_box.pack(fill="x", padx=16)

        dev_header = ctk.CTkFrame(right, fg_color="transparent")
        dev_header.pack(fill="x", padx=16, pady=(14, 6))
        ctk.CTkLabel(dev_header, text="RECIPIENT DEVICES", font=FONT_SECTION, text_color=C_MUTED, anchor="w").pack(side="left")

        self._post_device_filter_var = tk.StringVar()
        post_device_search = ctk.CTkEntry(
            dev_header, textvariable=self._post_device_filter_var, width=140, height=26,
            placeholder_text="Filter devices…",
            fg_color=C_ELEVATED, border_color=C_BORDER, font=FONT_CAPTION,
        )
        post_device_search.pack(side="right")
        self._post_device_filter_var.trace_add("write", lambda *_: self._schedule_post_devices_refresh())

        self._post_devices_frame = ctk.CTkScrollableFrame(
            right, fg_color=C_ELEVATED, corner_radius=10, border_width=1, border_color=C_BORDER, label_text="",
        )
        self._post_devices_frame.pack(fill="both", expand=True, padx=16, pady=(0, 10))

        self._post_btn = ctk.CTkButton(
            right, text="Post to Devices", height=40,
            fg_color=C_ACCENT, hover_color=C_ACCENT2, text_color="#FFFFFF",
            corner_radius=10, font=FONT_BODY_B,
            command=self._post_files_to_devices,
        )
        self._post_btn.pack(fill="x", padx=16, pady=(0, 16))

        return frame

    def _browse_post_files(self):
        paths = filedialog.askopenfilenames(title="Select Files to Post")
        for p in paths:
            if p not in self._post_selected_files:
                self._post_selected_files.append(p)
        self._refresh_post_files_list()

    def _on_files_dropped(self, event):
        for p in self.tk.splitlist(event.data):
            if os.path.isfile(p) and p not in self._post_selected_files:
                self._post_selected_files.append(p)
        self._refresh_post_files_list()

    def _remove_post_file(self, path: str):
        if path in self._post_selected_files:
            self._post_selected_files.remove(path)
        self._refresh_post_files_list()

    def _move_post_file(self, index: int, delta: int):
        new_index = index + delta
        if 0 <= new_index < len(self._post_selected_files):
            self._post_selected_files[index], self._post_selected_files[new_index] = \
                self._post_selected_files[new_index], self._post_selected_files[index]
        self._refresh_post_files_list()

    def _refresh_post_files_list(self):
        _saved_files_scroll = 0.0
        try:
            _saved_files_scroll = self._post_files_list_frame._parent_canvas.yview()[0]
        except Exception:
            pass
        for w in self._post_files_list_frame.winfo_children():
            w.destroy()
        count = len(self._post_selected_files)
        paths = list(self._post_selected_files)

        def _measure():
            sizes = {}
            for p in paths:
                try:
                    sizes[p] = os.path.getsize(p) if os.path.isfile(p) else 0
                except OSError:
                    sizes[p] = 0
            total = sum(sizes.values())
            try:
                self.after(0, lambda: _render(sizes, total))
            except RuntimeError:
                pass

        def _render(sizes, total):
            if not self._post_files_list_frame.winfo_exists():
                return
            self._post_files_count.configure(
                text=f"{count} file{'s' if count != 1 else ''} · {fmt_bytes(total)}"
            )
            if not paths:
                ctk.CTkLabel(self._post_files_list_frame, text="No files queued for posting.",
                             font=FONT_SMALL, text_color=C_MUTED).pack(pady=28)
                return
            last = len(paths) - 1
            for i, path in enumerate(paths):
                row = ctk.CTkFrame(self._post_files_list_frame, fg_color="transparent")
                row.pack(fill="x", pady=2)
                fname = os.path.basename(path) or path
                size_txt = fmt_bytes(sizes[path]) if sizes.get(path) else ""
                ctk.CTkLabel(row, text=f"{fname}  ({size_txt})", font=FONT_SMALL,
                             text_color=C_TEXT, anchor="w").pack(side="left", fill="x", expand=True, padx=(4, 6))
                ctk.CTkButton(
                    row, text="✕", width=24, height=24, fg_color="transparent",
                    hover_color=C_SOFT_RED, text_color=C_MUTED, corner_radius=6,
                    font=FONT_CAPTION, command=lambda p=path: self._remove_post_file(p),
                ).pack(side="right", padx=2)
                ctk.CTkButton(
                    row, text="▼", width=24, height=24, fg_color="transparent",
                    hover_color=C_ELEVATED, text_color=C_MUTED, corner_radius=6,
                    font=FONT_CAPTION, state="disabled" if i == last else "normal",
                    command=lambda idx=i: self._move_post_file(idx, 1),
                ).pack(side="right", padx=2)
                ctk.CTkButton(
                    row, text="▲", width=24, height=24, fg_color="transparent",
                    hover_color=C_ELEVATED, text_color=C_MUTED, corner_radius=6,
                    font=FONT_CAPTION, state="disabled" if i == 0 else "normal",
                    command=lambda idx=i: self._move_post_file(idx, -1),
                ).pack(side="right", padx=2)
            if _saved_files_scroll > 0:
                try:
                    self._post_files_list_frame._parent_canvas.yview_moveto(_saved_files_scroll)
                except Exception:
                    pass

        threading.Thread(target=_measure, daemon=True).start()

    def _refresh_post_devices_list(self):
        # Clear debounce handle
        self._post_devices_filter_after_id = None

        previously_selected = {
            did for did, var in self._post_device_vars.items()
            if var.get()
        }
        query = ""
        try:
            query = self._post_device_filter_var.get().strip().casefold()
        except (AttributeError, tk.TclError):
            pass

        def _fetch():
            try:
                all_devs = [d for d in get_devices() if d.get("device_id") != DESKTOP_SHARE_DEVICE_ID]
            except Exception:
                all_devs = []
            try:
                self.after(0, lambda: _render(all_devs))
            except RuntimeError:
                pass

        def _render(all_devs):
            if not self._post_devices_frame.winfo_exists():
                return
            _saved_dev_scroll = 0.0
            try:
                _saved_dev_scroll = self._post_devices_frame._parent_canvas.yview()[0]
            except Exception:
                pass
            for w in self._post_devices_frame.winfo_children():
                w.destroy()
            self._post_device_vars.clear()

            devices = all_devs
            if query:
                devices = [
                    dev for dev in all_devs
                    if query in " ".join((format_display_name(dev), str(dev.get("device_model") or ""), str(dev.get("device_id") or ""))).casefold()
                ]

            if not devices:
                ctk.CTkLabel(self._post_devices_frame, text="No matching devices" if query else "No connected devices", font=FONT_SMALL, text_color=C_MUTED).pack(pady=20)
                return

            def _toggle_all():
                v = all_var.get()
                for var in self._post_device_vars.values():
                    var.set(v)

            all_var = tk.BooleanVar(value=bool(devices) and all(dev.get("device_id") in previously_selected for dev in devices))
            ctk.CTkCheckBox(
                self._post_devices_frame, text="Select All Devices", variable=all_var,
                font=FONT_SMALL_B, text_color=C_TEXT, border_color=C_BORDER, fg_color=C_ACCENT,
                command=_toggle_all,
            ).pack(anchor="w", padx=8, pady=(4, 6))
            ctk.CTkFrame(self._post_devices_frame, height=1, fg_color=C_BORDER).pack(fill="x", padx=6, pady=(0, 6))

            for dev in devices:
                did = dev.get("device_id")
                var = tk.BooleanVar(value=did in previously_selected)
                ctk.CTkCheckBox(
                    self._post_devices_frame, text=format_display_name(dev),
                    variable=var, font=FONT_SMALL, text_color=C_TEXT,
                    border_color=C_BORDER, fg_color=C_ACCENT,
                ).pack(anchor="w", padx=8, pady=3)
                self._post_device_vars[did] = var
            if _saved_dev_scroll > 0:
                try:
                    self._post_devices_frame._parent_canvas.yview_moveto(_saved_dev_scroll)
                except Exception:
                    pass

        threading.Thread(target=_fetch, daemon=True).start()

    def _post_files_to_devices(self):
        if not self._post_selected_files:
            messagebox.showwarning("No files", "Select at least one file to post.")
            return
        targets = [did for did, var in self._post_device_vars.items() if var.get()]
        if not targets:
            messagebox.showwarning("No devices", "Choose at least one device to post to.")
            return
        caption = self._post_caption_box.get("1.0", "end").strip()
        files = list(self._post_selected_files)
        self._post_btn.configure(state="disabled", text="Posting…")

        def _run():
            _ensure_desktop_device()
            items = []
            for path in files:
                try:
                    items.append({
                        "source_type": "desktop",
                        "source_key": DESKTOP_SHARE_DEVICE_ID,
                        "relative_path": os.path.abspath(path),
                        "size": os.path.getsize(path),
                        "modified_time": int(os.path.getmtime(path)),
                    })
                except Exception:
                    continue
            result = create_device_share(DESKTOP_SHARE_DEVICE_ID, targets, caption, items) if items else {"ok": False}

            def _finish():
                self._post_btn.configure(state="normal", text="Post to Devices")
                if result.get("ok"):
                    self._post_selected_files.clear()
                    self._post_caption_box.delete("1.0", "end")
                    self._refresh_post_files_list()
                    # Post list is only loaded when navigating to the posts tab;
                    # invalidate the cache key so it refreshes on next visit.
                    self._posts_cache_key = ""
                    messagebox.showinfo("Posted Successfully", f"Shared {result['count']} file(s) with {len(targets)} device(s).")
                else:
                    messagebox.showerror("Failed", "Could not post the selected files.")

            self.after(0, _finish)

        threading.Thread(target=_run, daemon=True).start()

    # ─── Page: Posts & Shares Manager ────────────────────────────────────────

    def _build_posts(self, parent) -> ctk.CTkFrame:
        frame = ctk.CTkFrame(parent, fg_color=C_BG)
        header = self._page_header(
            frame, "Posts & Shares", "Search, inspect, and manage posts created by this server",
        )
        ctk.CTkButton(
            header, text="+ Create post", width=116, height=34,
            fg_color=C_ACCENT, hover_color=C_ACCENT2, corner_radius=9, font=FONT_SMALL_B,
            command=lambda: self._show_page("post_to_devices"),
        ).pack(side="right", pady=(2, 0))
        self._divider(frame)

        filters = ctk.CTkFrame(frame, fg_color=C_SURFACE, corner_radius=12, border_width=1, border_color=C_BORDER)
        filters.pack(fill="x", padx=32, pady=(12, 8))
        filters.grid_columnconfigure(0, weight=1)

        self._posts_search_var = tk.StringVar()
        self._posts_date_var = tk.StringVar()
        self._posts_device_filter_var = tk.StringVar(value="All devices")
        self._posts_device_filter_ids: dict[str, str | None] = {"All devices": None}

        ctk.CTkLabel(filters, text="SEARCH POSTS", font=FONT_SECTION, text_color=C_MUTED).grid(row=0, column=0, sticky="w", padx=(14, 6), pady=(8, 2))
        ctk.CTkLabel(filters, text="RECIPIENT", font=FONT_SECTION, text_color=C_MUTED).grid(row=0, column=1, sticky="w", padx=(6, 6), pady=(8, 2))
        ctk.CTkLabel(filters, text="DATE", font=FONT_SECTION, text_color=C_MUTED).grid(row=0, column=2, sticky="w", padx=(6, 6), pady=(8, 2))

        search = ctk.CTkEntry(
            filters, textvariable=self._posts_search_var,
            placeholder_text="Caption, file name, path, or recipient…",
            height=34, fg_color=C_ELEVATED, border_color=C_BORDER, font=FONT_BODY,
        )
        search.grid(row=1, column=0, sticky="ew", padx=(14, 6), pady=(0, 10))

        self._posts_device_filter_menu = ctk.CTkOptionMenu(
            filters, variable=self._posts_device_filter_var, values=["All devices"],
            width=180, height=34, fg_color=C_ELEVATED, button_color=C_BORDER,
            text_color=C_TEXT, dropdown_fg_color=C_SURFACE,
            command=lambda _value: self._refresh_post_posts_list(_show_loading=True),
        )
        self._posts_device_filter_menu.grid(row=1, column=1, sticky="ew", padx=6, pady=(0, 10))

        date_entry = ctk.CTkEntry(
            filters, textvariable=self._posts_date_var,
            placeholder_text="YYYY-MM",
            width=110, height=34, fg_color=C_ELEVATED, border_color=C_BORDER, font=FONT_BODY,
        )
        date_entry.grid(row=1, column=2, sticky="ew", padx=6, pady=(0, 10))

        ctk.CTkButton(
            filters, text="Clear", width=64, height=34,
            fg_color="transparent", hover_color=C_ELEVATED, text_color=C_ACCENT,
            border_width=1, border_color=C_BORDER, corner_radius=8, font=FONT_SMALL_B,
            command=self._clear_post_filters,
        ).grid(row=1, column=3, padx=(0, 6), pady=(0, 10))

        ctk.CTkButton(
            filters, text="Refresh", width=74, height=34,
            fg_color=C_SOFT_BLUE, hover_color=C_SOFT_BLUE_HOVER, text_color=C_ACCENT,
            border_width=1, border_color=C_BORDER, corner_radius=8, font=FONT_SMALL_B,
            command=self._refresh_post_posts_list,
        ).grid(row=1, column=4, padx=(0, 14), pady=(0, 10))

        self._posts_count_label = ctk.CTkLabel(
            frame, text="0 posts", font=FONT_SMALL, text_color=C_MUTED, anchor="w",
        )
        self._posts_count_label.pack(fill="x", padx=34, pady=(0, 4))
        self._post_posts_frame = ctk.CTkScrollableFrame(frame, fg_color="transparent", label_text="")
        self._post_posts_frame.pack(fill="both", expand=True, padx=28, pady=(0, 4))

        # Pagination bar
        pg_bar = ctk.CTkFrame(frame, fg_color="transparent", height=40)
        pg_bar.pack(fill="x", padx=28, pady=(0, 12))
        pg_bar.pack_propagate(False)

        self._posts_prev_btn = ctk.CTkButton(
            pg_bar, text="← Prev", width=80, height=32,
            fg_color=C_ELEVATED, hover_color=C_BORDER, text_color=C_TEXT,
            border_width=1, border_color=C_BORDER, corner_radius=8, font=FONT_SMALL_B,
            command=self._posts_prev_page, state="disabled",
        )
        self._posts_prev_btn.pack(side="left")

        self._posts_page_lbl = ctk.CTkLabel(
            pg_bar, text="", font=FONT_SMALL, text_color=C_MUTED,
        )
        self._posts_page_lbl.pack(side="left", padx=12)

        self._posts_next_btn = ctk.CTkButton(
            pg_bar, text="Next →", width=80, height=32,
            fg_color=C_ELEVATED, hover_color=C_BORDER, text_color=C_TEXT,
            border_width=1, border_color=C_BORDER, corner_radius=8, font=FONT_SMALL_B,
            command=self._posts_next_page, state="disabled",
        )
        self._posts_next_btn.pack(side="left")

        self._posts_search_var.trace_add("write", lambda *_: self._schedule_posts_refresh())
        self._posts_date_var.trace_add("write", lambda *_: self._schedule_posts_refresh())
        return frame

    def _show_posts_loading_state(self):
        """Show a loading indicator in the posts list immediately — called before the DB fetch starts."""
        if not hasattr(self, "_post_posts_frame") or not self._post_posts_frame.winfo_exists():
            return
        # Cancel any in-progress chunked render
        old_render_id = getattr(self, "_posts_chunk_after_id", None)
        if old_render_id:
            try:
                self.after_cancel(old_render_id)
            except Exception:
                pass
            self._posts_chunk_after_id = None
        for w in self._post_posts_frame.winfo_children():
            w.destroy()
        try:
            self._post_posts_frame._parent_canvas.yview_moveto(0)
        except Exception:
            pass
        # Muted "loading" placeholder — visible instantly
        loading = ctk.CTkFrame(
            self._post_posts_frame, fg_color=C_SURFACE,
            corner_radius=12, border_width=1, border_color=C_BORDER,
        )
        loading.pack(fill="x", padx=4, pady=16)
        ctk.CTkLabel(
            loading, text="Loading posts…",
            font=FONT_BODY, text_color=C_MUTED,
        ).pack(pady=28)
        try:
            self._posts_count_label.configure(text="Loading…")
            self._posts_prev_btn.configure(state="disabled")
            self._posts_next_btn.configure(state="disabled")
            self._posts_page_lbl.configure(text="")
        except Exception:
            pass

    def _show_history_loading_state(self):
        """Show a loading indicator in the history list immediately — called before the DB fetch starts."""
        if not hasattr(self, "_hist_scroll") or not self._hist_scroll.winfo_exists():
            return
        # Cancel any in-progress chunked render
        old_hist_chunk = getattr(self, "_hist_chunk_after_id", None)
        if old_hist_chunk:
            try:
                self.after_cancel(old_hist_chunk)
            except Exception:
                pass
            self._hist_chunk_after_id = None
        for w in self._hist_scroll.winfo_children():
            w.destroy()
        loading = ctk.CTkFrame(
            self._hist_scroll, fg_color=C_SURFACE,
            corner_radius=12, border_width=1, border_color=C_BORDER,
        )
        loading.pack(fill="x", padx=4, pady=16)
        ctk.CTkLabel(
            loading, text="Loading history…",
            font=FONT_BODY, text_color=C_MUTED,
        ).pack(pady=28)
        try:
            self._hist_banner_lbl.configure(text="Loading…", text_color=C_MUTED)
            self._hist_count_label.configure(text="")
            self._hist_prev_btn.configure(state="disabled")
            self._hist_next_btn.configure(state="disabled")
            self._hist_page_lbl.configure(text="")
        except Exception:
            pass

    def _schedule_posts_refresh(self):
        if self._posts_search_after_id:
            try:
                self.after_cancel(self._posts_search_after_id)
            except Exception:
                pass
        # 300 ms debounce — avoids DB fetch on every keystroke
        self._posts_search_after_id = self.after(300, self._refresh_post_posts_list)

    def _schedule_post_devices_refresh(self):
        """Debounced refresh for the recipient-device list in the Post composer."""
        after_id = getattr(self, "_post_devices_filter_after_id", None)
        if after_id:
            try:
                self.after_cancel(after_id)
            except Exception:
                pass
        self._post_devices_filter_after_id = self.after(200, self._refresh_post_devices_list)

    def _clear_post_filters(self):
        self._posts_search_var.set("")
        self._posts_date_var.set("")
        self._posts_device_filter_var.set("All devices")
        self._refresh_post_posts_list(_show_loading=True)

    def _refresh_post_posts_list(self, force: bool = False, _show_loading: bool = False, _preserve_scroll: bool = False):
        self._posts_search_after_id = None
        if self._refresh_in_flight.get("posts"):
            return
        self._refresh_in_flight["posts"] = True

        # Show skeleton immediately when explicitly requested (e.g. button press / filter clear)
        if _show_loading:
            self._show_posts_loading_state()

        # Snapshot filter state on main thread (safe)
        text_query  = self._posts_search_var.get().strip().casefold()
        date_query  = self._posts_date_var.get().strip()
        dev_label   = self._posts_device_filter_var.get()

        def _fetch():
            """Run ALL DB work off the main thread."""
            try:
                rows    = get_device_shares_by_sharer(DESKTOP_SHARE_DEVICE_ID)
                devices = [d for d in get_devices() if d.get("device_id") != DESKTOP_SHARE_DEVICE_ID]
                # Single bulk query replaces N individual get_share_targets_for_group calls
                all_targets = get_all_share_targets_for_sharer(DESKTOP_SHARE_DEVICE_ID)
            except Exception:
                rows, devices, all_targets = [], [], {}

            # Group rows by share_group_id
            groups: dict[str, list[dict]] = {}
            order:  list[str] = []
            for r in rows:
                gid = r.get("share_group_id") or str(r["share_id"])
                if gid not in groups:
                    groups[gid] = []
                    order.append(gid)
                groups[gid].append(r)

            # Build post specs using pre-fetched targets — no per-group DB queries
            post_specs: list[tuple] = []
            for gid in order:
                items   = groups[gid]
                head    = items[0]
                targets = all_targets.get(gid, [])
                target_ids   = {t.get("target_device_id") for t in targets}
                target_names = [format_display_name(t) for t in targets]
                post_specs.append((gid, items, head, target_ids, target_names))

            try:
                self.after(0, lambda: _render(post_specs, devices))
            except RuntimeError:
                # tk not yet in main loop or already destroyed; unlock the guard
                # so the next navigation to this page triggers a fresh fetch.
                self._refresh_in_flight["posts"] = False

        def _render(post_specs, devices):
            """Back on main thread: update dropdown, filter, paginate, render."""
            self._refresh_in_flight["posts"] = False

            # Cache key check: skip re-render only if data is truly unchanged AND
            # the list already has real cards (not just the loading placeholder).
            cache_sig = f"{text_query}|{date_query}|{dev_label}|" + "|".join(
                f"{gid}:{len(items)}:{sorted(list(tids))}" for gid, items, _, tids, _ in post_specs
            )
            loading_showing = (
                not self._posts_all_matched  # no data cached yet
                or (
                    hasattr(self, "_post_posts_frame")
                    and self._post_posts_frame.winfo_exists()
                    and len(self._post_posts_frame.winfo_children()) <= 1
                )
            )
            if not force and not loading_showing and getattr(self, "_posts_cache_key", None) == cache_sig:
                return
            self._posts_cache_key = cache_sig

            # Update device filter dropdown
            labels: dict[str, str | None] = {"All devices": None}
            for dev in devices:
                did = dev.get("device_id")
                if not did:
                    continue
                lbl = format_display_name(dev)
                if lbl in labels:
                    lbl = f"{lbl} ({did[-6:]})"
                labels[lbl] = did
            self._posts_device_filter_ids = labels
            try:
                self._posts_device_filter_menu.configure(values=list(labels))
                if dev_label not in labels:
                    self._posts_device_filter_var.set("All devices")
            except Exception:
                pass

            selected_did = labels.get(self._posts_device_filter_var.get())

            # Filter
            matched: list[tuple] = []
            for gid, items, head, target_ids, target_names in post_specs:
                created_at = int(head.get("created_at") or 0)
                date_text  = datetime.fromtimestamp(created_at).strftime("%Y-%m-%d") if created_at else ""
                caption    = head.get("group_caption") or head.get("caption") or ""
                item_paths = [str(item.get("relative_path") or "") for item in items]
                sf = [caption, date_text, *target_names, *target_ids]
                for p in item_paths:
                    sf.extend((p, os.path.basename(p), os.path.dirname(p)))
                searchable = "\n".join(str(v or "") for v in sf).casefold()
                if selected_did and selected_did not in target_ids:
                    continue
                if date_query and not date_text.startswith(date_query):
                    continue
                if text_query and text_query not in searchable:
                    continue
                matched.append((gid, items, head, target_ids, target_names, date_text, created_at, caption, item_paths))

            # Store for pagination
            self._posts_all_matched = matched
            if not _preserve_scroll:
                self._posts_page = 0   # new filter → back to page 0
            self._posts_render_page(reset_scroll=not _preserve_scroll)

        threading.Thread(target=_fetch, daemon=True).start()

    def _posts_render_page(self, reset_scroll: bool = True):
        """Render the current page of matched posts without blocking the UI."""
        matched    = self._posts_all_matched
        page       = self._posts_page
        page_size  = self._posts_page_size
        total      = len(matched)
        num_pages  = max(1, (total + page_size - 1) // page_size)
        page       = max(0, min(page, num_pages - 1))
        self._posts_page = page

        start = page * page_size
        end   = min(start + page_size, total)
        page_items = matched[start:end]

        # ── Skip rebuild if page content is unchanged (e.g. auto-refresh with no real changes) ──
        current_gids = [spec[0] for spec in page_items]
        rendered_gids = list(self._post_card_widgets.keys())
        if not reset_scroll and current_gids == rendered_gids:
            # Data identical, just update labels and restore scroll — no card rebuild needed
            try:
                self._posts_count_label.configure(
                    text=f"{total} post{'s' if total != 1 else ''}" if total else "0 posts"
                )
                page_from = start + 1 if total else 0
                pg_txt = f"Page {page + 1} / {num_pages}  ({page_from}–{end} of {total})" if num_pages > 1 else (f"{total} post{'s' if total != 1 else ''}" if total else "")
                self._posts_page_lbl.configure(text=pg_txt)
                self._posts_prev_btn.configure(state="normal" if page > 0 else "disabled")
                self._posts_next_btn.configure(state="normal" if page < num_pages - 1 else "disabled")
            except Exception:
                pass
            return

        # ── Clear existing cards ──────────────────────────────────────────────
        # Cancel any in-progress chunked render before wiping the frame
        old_render_id = getattr(self, "_posts_chunk_after_id", None)
        if old_render_id:
            try:
                self.after_cancel(old_render_id)
            except Exception:
                pass
            self._posts_chunk_after_id = None

        saved_scroll = 0.0
        if not reset_scroll:
            try:
                saved_scroll = self._post_posts_frame._parent_canvas.yview()[0]
            except Exception:
                pass

        for w in self._post_posts_frame.winfo_children():
            w.destroy()
        self._post_card_widgets.clear()
        if reset_scroll:
            try:
                self._post_posts_frame._parent_canvas.yview_moveto(0)
            except Exception:
                pass

        # Update count + pagination labels
        try:
            self._posts_count_label.configure(
                text=f"{total} post{'s' if total != 1 else ''}"
                if total else "0 posts"
            )
            page_from = start + 1 if total else 0
            pg_txt = f"Page {page + 1} / {num_pages}  ({page_from}–{end} of {total})" if num_pages > 1 else (f"{total} post{'s' if total != 1 else ''}" if total else "")
            self._posts_page_lbl.configure(text=pg_txt)
            self._posts_prev_btn.configure(state="normal" if page > 0 else "disabled")
            self._posts_next_btn.configure(state="normal" if page < num_pages - 1 else "disabled")
        except Exception:
            pass

        if total == 0:
            ctk.CTkLabel(
                self._post_posts_frame, text="No posts match your filters.",
                font=FONT_BODY, text_color=C_MUTED,
            ).pack(pady=36)
            return

        # ── Chunked rendering: build cards in small batches so the UI stays
        #    responsive. Each batch yields back to the event loop via after(0).
        _CHUNK = 15  # cards per batch

        def _render_chunk(items_remaining: list):
            if not self._post_posts_frame.winfo_exists():
                return
            batch = items_remaining[:_CHUNK]
            rest  = items_remaining[_CHUNK:]
            for spec in batch:
                self._build_post_card(*spec)
            if rest:
                self._posts_chunk_after_id = self.after(0, lambda: _render_chunk(rest))
            else:
                self._posts_chunk_after_id = None
                if not reset_scroll and saved_scroll > 0:
                    try:
                        self._post_posts_frame._parent_canvas.yview_moveto(saved_scroll)
                    except Exception:
                        pass

        _render_chunk(list(page_items))

    def _posts_prev_page(self):
        self._posts_page = max(0, self._posts_page - 1)
        self._posts_render_page()

    def _posts_next_page(self):
        total     = len(self._posts_all_matched)
        num_pages = max(1, (total + self._posts_page_size - 1) // self._posts_page_size)
        self._posts_page = min(self._posts_page + 1, num_pages - 1)
        self._posts_render_page()

    def _build_post_card(self, gid, items, head, target_ids, target_names, date_text, created_at, caption, item_paths):
        """Render a single post card into the posts scroll frame."""
        if not self._post_posts_frame.winfo_exists():
            return
        card = ctk.CTkFrame(
            self._post_posts_frame, fg_color=C_SURFACE,
            corner_radius=8, border_width=1, border_color=C_BORDER,
        )
        card.pack(fill="x", padx=4, pady=3)

        top = ctk.CTkFrame(card, fg_color="transparent")
        top.pack(fill="x", padx=12, pady=(7, 1))
        caption_lbl = ctk.CTkLabel(
            top, text=caption or "(no caption)",
            font=FONT_BODY_B, text_color=C_TEXT, anchor="w",
        )
        caption_lbl.pack(side="left", fill="x", expand=True)
        timestamp = f"{date_text}  ·  {fmt_rel(created_at)}" if date_text else fmt_rel(created_at)
        ctk.CTkLabel(top, text=timestamp, font=FONT_CAPTION, text_color=C_MUTED, anchor="e").pack(side="right")

        target_display = ", ".join(target_names) or "No devices"
        author = head.get("sharer_device_id") or "Desktop"
        meta_lbl = ctk.CTkLabel(
            card,
            text=f"{len(items)} file{'s' if len(items) != 1 else ''}   •   {author}   •   Shared with: {target_display}",
            font=FONT_SMALL, text_color=C_MUTED, anchor="w",
        )
        meta_lbl.pack(fill="x", padx=12, pady=(0, 4))

        self._post_card_widgets[gid] = {"caption_lbl": caption_lbl, "meta_lbl": meta_lbl}

        btn_row = ctk.CTkFrame(card, fg_color="transparent")
        btn_row.pack(fill="x", padx=12, pady=(0, 7))
        ctk.CTkButton(
            btn_row, text="Edit Caption", width=100, height=28,
            fg_color="transparent", hover_color=C_ELEVATED, text_color=C_ACCENT,
            border_width=1, border_color=C_BORDER, corner_radius=7, font=FONT_CAPTION,
            command=lambda g=gid: self._open_edit_caption_dialog(
                g,
                next((e[7] for e in self._posts_all_matched if e[0] == g), None),
            ),
        ).pack(side="left", padx=(0, 6))
        ctk.CTkButton(
            btn_row, text="Edit Files", width=90, height=28,
            fg_color="transparent", hover_color=C_ELEVATED, text_color=C_ACCENT,
            border_width=1, border_color=C_BORDER, corner_radius=7, font=FONT_CAPTION,
            command=lambda g=gid: self._open_edit_files_dialog(
                g,
                next((e[1] for e in self._posts_all_matched if e[0] == g), []),
            ),
        ).pack(side="left", padx=(0, 6))
        ctk.CTkButton(
            btn_row, text="Manage Access", width=110, height=28,
            fg_color="transparent", hover_color=C_ELEVATED, text_color=C_ACCENT,
            border_width=1, border_color=C_BORDER, corner_radius=7, font=FONT_CAPTION,
            command=lambda g=gid: self._open_manage_access_dialog(g),
        ).pack(side="left", padx=(0, 6))
        ctk.CTkButton(
            btn_row, text="Delete", width=80, height=28,
            fg_color="transparent", hover_color=C_SOFT_RED, text_color=C_ERROR,
            border_width=1, border_color=C_ERROR_BORDER, corner_radius=7, font=FONT_CAPTION,
            command=lambda g=gid: self._delete_post(g),
        ).pack(side="left")

    def _open_edit_caption_dialog(self, group_id: str, current_caption: str | None):
        dialog = ctk.CTkToplevel(self)
        dialog.title("Edit Caption")
        dialog.geometry("400x240")
        dialog.minsize(360, 200)
        dialog.transient(self)
        dialog.grab_set()
        dialog.configure(fg_color=C_SURFACE)

        ctk.CTkLabel(dialog, text="EDIT POST CAPTION", font=FONT_SECTION, text_color=C_MUTED, anchor="w").pack(fill="x", padx=18, pady=(16, 6))
        box = ctk.CTkTextbox(dialog, height=96, fg_color=C_ELEVATED, corner_radius=9, border_width=1, border_color=C_BORDER, font=FONT_BODY)
        box.pack(fill="both", expand=True, padx=18)
        box.insert("1.0", current_caption or "")

        def _save():
            edit_device_share_group_caption(group_id, DESKTOP_SHARE_DEVICE_ID, box.get("1.0", "end").strip())
            dialog.destroy()
            self._refresh_post_card(group_id)

        ctk.CTkButton(
            dialog, text="Save Caption", height=36,
            fg_color=C_ACCENT, hover_color=C_ACCENT2, text_color="#FFFFFF",
            corner_radius=8, font=FONT_BODY_B,
            command=_save,
        ).pack(fill="x", padx=18, pady=16)

    def _open_manage_access_dialog(self, group_id: str):
        dialog = ctk.CTkToplevel(self)
        dialog.title("Manage Post Access")
        dialog.geometry("480x560")
        dialog.minsize(400, 420)
        dialog.transient(self)
        dialog.configure(fg_color=C_BG)

        loading_lbl = ctk.CTkLabel(dialog, text="Loading…", font=FONT_BODY, text_color=C_MUTED)
        loading_lbl.pack(expand=True)

        def _fetch():
            try:
                current = {t["target_device_id"] for t in get_share_targets_for_group(group_id, DESKTOP_SHARE_DEVICE_ID)}
                devices = [dev for dev in get_devices()
                           if dev.get("device_id") and dev.get("device_id") != DESKTOP_SHARE_DEVICE_ID]
            except Exception:
                current, devices = set(), []
            if dialog.winfo_exists():
                dialog.after(0, lambda: _build(current, devices))

        def _build(current, devices):
            if not dialog.winfo_exists():
                return
            loading_lbl.destroy()
            dialog.grab_set()

            ctk.CTkLabel(dialog, text="Manage Post Recipients", font=FONT_TITLE,
                         text_color=C_TEXT, anchor="w").pack(fill="x", padx=22, pady=(18, 0))
            ctk.CTkLabel(dialog, text="Select which devices can view and download this post.",
                         font=FONT_SUBTITLE, text_color=C_MUTED, anchor="w").pack(fill="x", padx=22, pady=(2, 10))

            panel = ctk.CTkFrame(dialog, fg_color=C_SURFACE, corner_radius=12,
                                 border_width=1, border_color=C_BORDER)
            panel.pack(fill="both", expand=True, padx=20, pady=(0, 12))

            vars_map: dict[str, tk.BooleanVar] = {}
            for dev in devices:
                did = str(dev["device_id"])
                vars_map[did] = tk.BooleanVar(value=did in current)

            top_controls = ctk.CTkFrame(panel, fg_color="transparent")
            top_controls.pack(fill="x", padx=14, pady=(12, 6))
            all_var = tk.BooleanVar(value=bool(devices) and all(var.get() for var in vars_map.values()))

            def select_all():
                for var in vars_map.values():
                    var.set(all_var.get())
                render_devices()

            ctk.CTkCheckBox(
                top_controls, text="Select All", variable=all_var,
                font=FONT_SMALL_B, text_color=C_TEXT, border_color=C_BORDER, fg_color=C_ACCENT,
                command=select_all,
            ).pack(side="left")

            search_var = tk.StringVar()
            ctk.CTkEntry(
                top_controls, textvariable=search_var, width=180, height=30,
                placeholder_text="Filter devices…",
                fg_color=C_ELEVATED, border_color=C_BORDER, font=FONT_SMALL,
            ).pack(side="right")

            scroll = ctk.CTkScrollableFrame(panel, fg_color=C_ELEVATED, corner_radius=9,
                                            border_width=1, border_color=C_BORDER, label_text="")
            scroll.pack(fill="both", expand=True, padx=14, pady=(0, 12))

            def sync_all_state():
                all_var.set(bool(devices) and all(var.get() for var in vars_map.values()))

            def render_devices(*_):
                for child in scroll.winfo_children():
                    child.destroy()
                query = search_var.get().strip().casefold()
                matched = [
                    dev for dev in devices
                    if not query or query in " ".join((
                        format_display_name(dev),
                        str(dev.get("device_model") or ""),
                        str(dev.get("device_id") or ""),
                    )).casefold()
                ]
                if not matched:
                    ctk.CTkLabel(scroll, text="No devices match search.",
                                 font=FONT_SMALL, text_color=C_MUTED).pack(pady=20)
                    return
                for dev in matched:
                    did = str(dev["device_id"])
                    row = ctk.CTkFrame(scroll, fg_color="transparent")
                    row.pack(fill="x", padx=6, pady=2)
                    ctk.CTkCheckBox(
                        row, text=format_display_name(dev), variable=vars_map[did],
                        font=FONT_SMALL, text_color=C_TEXT, border_color=C_BORDER, fg_color=C_ACCENT,
                        command=sync_all_state,
                    ).pack(side="left")
                    model = str(dev.get("device_model") or "")
                    if model:
                        ctk.CTkLabel(row, text=model, font=FONT_CAPTION, text_color=C_MUTED).pack(side="right")

            search_var.trace_add("write", render_devices)
            render_devices()

            def _save():
                selected = {did for did, v in vars_map.items() if v.get()}
                to_add = list(selected - current)
                to_remove = current - selected
                if to_add:
                    add_share_group_targets(group_id, to_add, DESKTOP_SHARE_DEVICE_ID)
                for did in to_remove:
                    remove_share_group_target(group_id, did, DESKTOP_SHARE_DEVICE_ID)
                dialog.destroy()
                self._refresh_post_card(group_id)

            footer = ctk.CTkFrame(dialog, fg_color="transparent")
            footer.pack(fill="x", padx=20, pady=(0, 16))
            ctk.CTkButton(
                footer, text="Cancel", width=100, height=36,
                fg_color="transparent", hover_color=C_ELEVATED, text_color=C_TEXT,
                border_width=1, border_color=C_BORDER, corner_radius=8, font=FONT_BODY_B,
                command=dialog.destroy,
            ).pack(side="left")
            ctk.CTkButton(
                footer, text="Save Recipients", width=140, height=36,
                fg_color=C_ACCENT, hover_color=C_ACCENT2, corner_radius=8, font=FONT_BODY_B,
                command=_save,
            ).pack(side="right")

        threading.Thread(target=_fetch, daemon=True).start()

    def _refresh_post_card(self, group_id: str):
        try:
            scroll_pos = self._post_posts_frame._parent_canvas.yview()[0]
        except Exception:
            scroll_pos = 0.0

        def _fetch():
            try:
                rows    = [r for r in get_device_shares_by_sharer(DESKTOP_SHARE_DEVICE_ID)
                           if r.get("share_group_id") == group_id]
                targets = get_share_targets_for_group(group_id, DESKTOP_SHARE_DEVICE_ID)
            except Exception:
                rows, targets = [], []
            self.after(0, lambda: _apply(rows, targets))

        def _apply(rows, targets):
            if not rows:
                return
            head         = rows[0]
            target_names = [format_display_name(t) for t in targets]
            target_ids   = {t.get("target_device_id") for t in targets}
            created_at   = int(head.get("created_at") or 0)
            date_text    = datetime.fromtimestamp(created_at).strftime("%Y-%m-%d") if created_at else ""
            caption      = head.get("group_caption") or head.get("caption") or ""
            item_paths   = [str(r.get("relative_path") or "") for r in rows]

            for i, entry in enumerate(self._posts_all_matched):
                if entry[0] == group_id:
                    self._posts_all_matched[i] = (
                        group_id, rows, head, target_ids, target_names,
                        date_text, created_at, caption, item_paths,
                    )
                    break

            widgets = self._post_card_widgets.get(group_id)
            if widgets:
                try:
                    widgets["caption_lbl"].configure(text=caption or "(no caption)")
                    author         = head.get("sharer_device_id") or "Desktop"
                    target_display = ", ".join(target_names) or "No devices"
                    widgets["meta_lbl"].configure(
                        text=f"{len(rows)} file{'s' if len(rows) != 1 else ''}   •   {author}   •   Shared with: {target_display}"
                    )
                except Exception:
                    pass

            try:
                self._post_posts_frame._parent_canvas.yview_moveto(scroll_pos)
            except Exception:
                pass

        threading.Thread(target=_fetch, daemon=True).start()

    def _open_edit_files_dialog(self, group_id: str, items: list[dict]):
        dialog = ctk.CTkToplevel(self)
        dialog.title("Edit Post Files")
        dialog.geometry("520x520")
        dialog.minsize(420, 400)
        dialog.transient(self)
        dialog.grab_set()
        dialog.configure(fg_color=C_SURFACE)

        file_list: list[dict] = [
            {
                "source_type":   it.get("source_type", "desktop"),
                "source_key":    it.get("source_key", DESKTOP_SHARE_DEVICE_ID),
                "relative_path": it.get("relative_path", ""),
                "size":          int(it.get("size") or 0),
                "modified_time": int(it.get("modified_time") or 0),
            }
            for it in items
        ]

        ctk.CTkLabel(
            dialog, text="EDIT POST FILES", font=FONT_SECTION, text_color=C_MUTED, anchor="w",
        ).pack(fill="x", padx=18, pady=(16, 4))

        list_frame = ctk.CTkScrollableFrame(
            dialog, fg_color=C_ELEVATED, corner_radius=10,
            border_width=1, border_color=C_BORDER, label_text="",
        )
        list_frame.pack(fill="both", expand=True, padx=18, pady=(0, 8))

        def _render():
            for w in list_frame.winfo_children():
                w.destroy()
            if not file_list:
                ctk.CTkLabel(
                    list_frame, text="No files — add files below.",
                    font=FONT_SMALL, text_color=C_MUTED,
                ).pack(pady=24)
                return
            last = len(file_list) - 1
            for i, item in enumerate(file_list):
                path     = item["relative_path"]
                fname    = os.path.basename(path) or path
                size_txt = fmt_bytes(item["size"]) if item["size"] else ""
                row = ctk.CTkFrame(list_frame, fg_color="transparent")
                row.pack(fill="x", pady=2)
                ctk.CTkLabel(
                    row,
                    text=f"{fname}  ({size_txt})" if size_txt else fname,
                    font=FONT_SMALL, text_color=C_TEXT, anchor="w",
                ).pack(side="left", fill="x", expand=True, padx=(4, 6))
                ctk.CTkButton(
                    row, text="✕", width=24, height=24, fg_color="transparent",
                    hover_color=C_SOFT_RED, text_color=C_MUTED, corner_radius=6,
                    font=FONT_CAPTION, command=lambda idx=i: _remove(idx),
                ).pack(side="right", padx=2)
                ctk.CTkButton(
                    row, text="▼", width=24, height=24, fg_color="transparent",
                    hover_color=C_ELEVATED, text_color=C_MUTED, corner_radius=6,
                    font=FONT_CAPTION,
                    state="disabled" if i == last else "normal",
                    command=lambda idx=i: _move(idx, 1),
                ).pack(side="right", padx=2)
                ctk.CTkButton(
                    row, text="▲", width=24, height=24, fg_color="transparent",
                    hover_color=C_ELEVATED, text_color=C_MUTED, corner_radius=6,
                    font=FONT_CAPTION,
                    state="disabled" if i == 0 else "normal",
                    command=lambda idx=i: _move(idx, -1),
                ).pack(side="right", padx=2)

        def _remove(idx: int):
            if 0 <= idx < len(file_list):
                file_list.pop(idx)
            _render()

        def _move(idx: int, delta: int):
            new_idx = idx + delta
            if 0 <= new_idx < len(file_list):
                file_list[idx], file_list[new_idx] = file_list[new_idx], file_list[idx]
            _render()

        def _add_files():
            paths = filedialog.askopenfilenames(parent=dialog, title="Add Files to Post")
            for p in paths:
                abs_p = os.path.abspath(p)
                if any(f["relative_path"] == abs_p for f in file_list):
                    continue
                try:
                    file_list.append({
                        "source_type":   "desktop",
                        "source_key":    DESKTOP_SHARE_DEVICE_ID,
                        "relative_path": abs_p,
                        "size":          os.path.getsize(p),
                        "modified_time": int(os.path.getmtime(p)),
                    })
                except Exception:
                    pass
            _render()

        def _save():
            if not file_list:
                messagebox.showwarning("No files", "Post must have at least one file.", parent=dialog)
                return
            save_btn.configure(state="disabled", text="Saving…")
            snapshot = list(file_list)

            def _run():
                ok = update_share_group_items(group_id, DESKTOP_SHARE_DEVICE_ID, snapshot)

                def _finish():
                    save_btn.configure(state="normal", text="Save Changes")
                    if ok:
                        self._refresh_post_card(group_id)
                        dialog.destroy()
                    else:
                        messagebox.showerror("Error", "Failed to save file changes.", parent=dialog)

                self.after(0, _finish)

            threading.Thread(target=_run, daemon=True).start()

        _render()

        btn_row = ctk.CTkFrame(dialog, fg_color="transparent")
        btn_row.pack(fill="x", padx=18, pady=(0, 16))

        ctk.CTkButton(
            btn_row, text="+ Add Files", width=100, height=34,
            fg_color=C_SOFT_BLUE, hover_color=C_SOFT_BLUE_HOVER, text_color=C_ACCENT,
            border_width=1, border_color=C_BORDER, corner_radius=8, font=FONT_SMALL_B,
            command=_add_files,
        ).pack(side="left", padx=(0, 8))

        save_btn = ctk.CTkButton(
            btn_row, text="Save Changes", height=34,
            fg_color=C_ACCENT, hover_color=C_ACCENT2, text_color="#FFFFFF",
            corner_radius=8, font=FONT_BODY_B, command=_save,
        )
        save_btn.pack(side="right")

    def _delete_post(self, group_id: str):
        if not confirm_dialog(self, "Delete Post", "Delete this post from all device feeds permanently?"):
            return
        delete_device_share_group(group_id, DESKTOP_SHARE_DEVICE_ID)
        self._refresh_post_posts_list()

    # ─── Page: Shared Folders ────────────────────────────────────────────────

    def _build_shared_folders(self, parent) -> ctk.CTkFrame:
        frame = ctk.CTkFrame(parent, fg_color=C_BG)

        header = self._page_header(
            frame, "Shared Folders", "Share PC folders with paired Android devices for file restore",
        )
        controls = ctk.CTkFrame(header, fg_color="transparent")
        controls.pack(side="right")

        self._shared_dirs_filter_var = tk.StringVar()
        shared_search = ctk.CTkEntry(
            controls, textvariable=self._shared_dirs_filter_var, width=220, height=34,
            placeholder_text="Search shared folders…",
            fg_color=C_ELEVATED, border_color=C_BORDER, border_width=1,
            text_color=C_TEXT, corner_radius=9, font=FONT_BODY,
        )
        shared_search.pack(side="left", padx=(0, 8))
        self._shared_dirs_filter_var.trace_add("write", lambda *_: self._schedule_shared_dirs_refresh())

        ctk.CTkButton(
            controls, text="+ Add folder", width=110, height=34,
            fg_color=C_ACCENT, hover_color=C_ACCENT2, corner_radius=9,
            font=FONT_SMALL_B, command=self._add_shared_folder,
        ).pack(side="left")
        self._divider(frame)

        work_area = ctk.CTkFrame(frame, fg_color="transparent")
        work_area.pack(fill="both", expand=True, padx=32, pady=(14, 16))

        card = ctk.CTkFrame(
            work_area, fg_color=C_SURFACE,
            corner_radius=14, border_width=1, border_color=C_BORDER,
        )
        card.pack(fill="both", expand=True)

        list_header = ctk.CTkFrame(card, fg_color="transparent")
        list_header.pack(fill="x", padx=16, pady=(14, 6))
        ctk.CTkLabel(
            list_header, text="SHARED LOCATIONS",
            font=FONT_SECTION, text_color=C_MUTED, anchor="w",
        ).pack(side="left")
        self._shared_dirs_count = ctk.CTkLabel(
            list_header, text="0 folders",
            font=FONT_CAPTION, text_color=C_MUTED, anchor="e",
        )
        self._shared_dirs_count.pack(side="right")

        self._shared_dirs_list_frame = ctk.CTkScrollableFrame(
            card, fg_color=C_ELEVATED, corner_radius=10,
            border_width=1, border_color=C_BORDER, label_text="",
        )
        self._shared_dirs_list_frame.pack(
            fill="both", expand=True, padx=16, pady=(0, 14)
        )

        return frame

    def _schedule_shared_dirs_refresh(self):
        if self._shared_search_after_id:
            try:
                self.after_cancel(self._shared_search_after_id)
            except Exception:
                pass
        self._shared_search_after_id = self.after(300, self._refresh_shared_dirs_list)

    @staticmethod
    def _shared_folder_display_path(path: str, max_length: int = 70) -> str:
        path = str(path or "")
        if len(path) <= max_length:
            return path
        prefix = max_length // 3
        suffix = max_length - prefix - 1
        return f"{path[:prefix]}…{path[-suffix:]}"

    def _queue_shared_dirs_save(self):
        if self._shared_dirs_save_after_id:
            try:
                self.after_cancel(self._shared_dirs_save_after_id)
            except Exception:
                pass
        self._shared_dirs_save_after_id = self.after(350, self._flush_shared_dirs_save)

    def _flush_shared_dirs_save(self):
        self._shared_dirs_save_after_id = None
        self._save_shared_dirs_to_config()

    def _refresh_shared_dirs_list(self):
        self._shared_search_after_id = None
        if self._refresh_in_flight.get("shared_dirs"):
            return
        self._refresh_in_flight["shared_dirs"] = True

        query = ""
        try:
            query = self._shared_dirs_filter_var.get().strip().casefold()
        except (AttributeError, tk.TclError):
            pass

        def _fetch():
            try:
                devices = [d for d in get_devices() if d.get("device_id") != DESKTOP_SHARE_DEVICE_ID]
            except Exception:
                devices = []
            try:
                fresh = list(load_config().get("SHARED_DIRS", []))
            except Exception:
                fresh = None
            try:
                self.after(0, lambda: _render(devices, fresh))
            except RuntimeError:
                self._refresh_in_flight["shared_dirs"] = False

        def _render(devices, fresh=None):
            self._refresh_in_flight["shared_dirs"] = False
            if fresh is not None:
                self._shared_dirs = fresh
            if not self._shared_dirs_list_frame.winfo_exists():
                return
            _saved_shared_scroll = 0.0
            try:
                _saved_shared_scroll = self._shared_dirs_list_frame._parent_canvas.yview()[0]
            except Exception:
                pass
            for w in self._shared_dirs_list_frame.winfo_children():
                w.destroy()
            self._shared_folder_card_widgets.clear()

            matching_entries = [
                (idx, entry) for idx, entry in enumerate(self._shared_dirs)
                if not query or query in " ".join((str(entry.get("label") or ""), str(entry.get("path") or ""))).casefold()
            ]

            count_label = getattr(self, "_shared_dirs_count", None)
            if count_label:
                count = len(self._shared_dirs)
                count_label.configure(
                    text=(f"{len(matching_entries)} of {count} folder{'s' if count != 1 else ''}" if query else
                          f"{count} folder{'s' if count != 1 else ''}")
                )

            if not self._shared_dirs:
                ctk.CTkLabel(
                    self._shared_dirs_list_frame,
                    text="No shared folders added yet. Click + Add Folder to share files with paired devices.",
                    font=FONT_BODY, text_color=C_MUTED, justify="center", wraplength=440,
                ).pack(expand=True, pady=32)
                return

            if not matching_entries:
                ctk.CTkLabel(
                    self._shared_dirs_list_frame,
                    text="No shared folders match your search query.",
                    font=FONT_BODY, text_color=C_MUTED,
                ).pack(expand=True, pady=32)
                return

            device_names = {str(d.get("device_id")): format_display_name(d) for d in devices if d.get("device_id")}

            for idx, entry in matching_entries:
                row = ctk.CTkFrame(
                    self._shared_dirs_list_frame,
                    fg_color=C_SURFACE, corner_radius=10,
                    border_width=1, border_color=C_BORDER,
                )
                row.pack(fill="x", pady=(0, 6))
                row.grid_columnconfigure(1, weight=1)

                icon_badge = ctk.CTkFrame(row, width=38, height=38, fg_color=C_SOFT_BLUE, corner_radius=8)
                icon_badge.grid(row=0, column=0, rowspan=3, padx=(10, 0), pady=10)
                icon_badge.grid_propagate(False)
                NavigationIcon(icon_badge, "folders", C_ACCENT, C_SOFT_BLUE, size=16).pack(expand=True)

                lbl_var = tk.StringVar(value=entry.get("label", f"Folder {idx + 1}"))
                lbl_entry = ctk.CTkEntry(
                    row, textvariable=lbl_var, height=26,
                    fg_color=C_SURFACE, border_color=C_BORDER, border_width=1,
                    text_color=C_TEXT, corner_radius=6, font=FONT_BODY_B,
                )
                lbl_entry.grid(row=0, column=1, sticky="ew", padx=(8, 8), pady=(8, 2))

                def _on_label_change(var=lbl_var, i=idx):
                    if i < len(self._shared_dirs):
                        self._shared_dirs[i]["label"] = var.get()
                        self._queue_shared_dirs_save()
                lbl_var.trace_add("write", lambda *_, fn=_on_label_change: fn())
                lbl_entry.bind("<FocusOut>", lambda _event: self._flush_shared_dirs_save())

                path_text = self._shared_folder_display_path(entry.get("path", ""))
                ctk.CTkLabel(
                    row, text=path_text, font=FONT_SMALL, text_color=C_MUTED, anchor="w",
                ).grid(row=1, column=1, sticky="ew", padx=(8, 8), pady=(0, 2))

                tagged = set(entry.get("device_ids", []))
                if "all" in tagged:
                    access_text = f"Access: All paired devices ({len(devices)})"
                    access_color = C_SUCCESS
                elif not tagged:
                    access_text = "Access: No devices selected"
                    access_color = C_MUTED
                else:
                    names = [device_names.get(str(device_id), str(device_id)[-6:]) for device_id in tagged]
                    display_names = ", ".join(names[:3])
                    if len(names) > 3:
                        display_names += f" +{len(names) - 3}"
                    access_text = f"Access: {display_names}"
                    access_color = C_ACCENT

                access_lbl = ctk.CTkLabel(
                    row, text=access_text, font=FONT_CAPTION, text_color=access_color, anchor="w",
                )
                access_lbl.grid(row=2, column=1, sticky="ew", padx=(8, 8), pady=(1, 10))

                folder_id = entry.get("id")
                if folder_id:
                    self._shared_folder_card_widgets[folder_id] = {
                        "access_lbl": access_lbl,
                        "device_names": device_names,
                        "devices": devices,
                    }

                actions = ctk.CTkFrame(row, fg_color="transparent")
                actions.grid(row=0, column=2, rowspan=3, padx=(0, 10), pady=10)
                ctk.CTkButton(
                    actions, text="Manage access", width=104, height=26,
                    fg_color=C_SOFT_BLUE, hover_color=C_SOFT_BLUE_HOVER, text_color=C_ACCENT,
                    border_width=1, border_color=C_BORDER, corner_radius=7, font=FONT_CAPTION,
                    command=lambda i=idx: self._open_shared_folder_access_dialog(i),
                ).pack(pady=(0, 4))
                ctk.CTkButton(
                    actions, text="Open", width=104, height=26,
                    fg_color="transparent", hover_color=C_ELEVATED, text_color=C_ACCENT,
                    border_width=1, border_color=C_BORDER, corner_radius=7, font=FONT_CAPTION,
                    command=lambda p=entry.get("path", ""): self._open_shared_folder_on_disk(str(p)),
                ).pack(pady=(0, 4))
                ctk.CTkButton(
                    actions, text="Remove", width=104, height=26,
                    fg_color=C_SOFT_RED, hover_color=C_SOFT_RED_HOVER,
                    text_color=C_ERROR, border_width=1, border_color=C_ERROR_BORDER,
                    font=FONT_CAPTION, corner_radius=7,
                    command=lambda i=idx: self._remove_shared_folder(i),
                ).pack()
            if _saved_shared_scroll > 0:
                try:
                    self._shared_dirs_list_frame._parent_canvas.yview_moveto(_saved_shared_scroll)
                except Exception:
                    pass

        threading.Thread(target=_fetch, daemon=True).start()

    def _open_shared_folder_on_disk(self, path: str):
        if not path:
            return
        try:
            if not os.path.isdir(path):
                messagebox.showinfo("Shared Folder", "This folder is not currently available at the specified path.")
                return
            os.startfile(path)  # type: ignore[attr-defined]
        except Exception as exc:
            messagebox.showerror("Shared Folder", f"Could not open folder:\n{exc}")

    def _open_shared_folder_access_dialog(self, idx: int):
        if not 0 <= idx < len(self._shared_dirs):
            return
        entry = self._shared_dirs[idx]
        entry_id = entry.get("id")  # stable identity; idx can shift if folders are removed

        dialog = ctk.CTkToplevel(self)
        dialog.title("Manage Folder Access")
        dialog.geometry("480x560")
        dialog.minsize(400, 420)
        dialog.transient(self)
        dialog.configure(fg_color=C_BG)

        loading_lbl = ctk.CTkLabel(dialog, text="Loading…", font=FONT_BODY, text_color=C_MUTED)
        loading_lbl.pack(expand=True)

        def _fetch():
            try:
                devices = [d for d in get_devices() if d.get("device_id") != DESKTOP_SHARE_DEVICE_ID and d.get("device_id")]
            except Exception:
                devices = []
            if dialog.winfo_exists():
                dialog.after(0, lambda: _build(devices))

        def _build(devices):
            if not dialog.winfo_exists():
                return
            loading_lbl.destroy()
            dialog.grab_set()

            try:
                self._shared_dirs = list(load_config().get("SHARED_DIRS", []))
            except Exception:
                pass
            current_idx = next(
                (i for i, e in enumerate(self._shared_dirs) if e.get("id") == entry_id),
                None,
            )
            if current_idx is None:
                dialog.destroy()
                return
            live_entry = self._shared_dirs[current_idx]
            current = set(live_entry.get("device_ids", []))

            ctk.CTkLabel(dialog, text="Folder Access Permissions", font=FONT_TITLE, text_color=C_TEXT, anchor="w").pack(fill="x", padx=22, pady=(18, 0))
            ctk.CTkLabel(dialog, text=live_entry.get("label") or live_entry.get("path") or "Shared folder", font=FONT_SUBTITLE, text_color=C_MUTED, anchor="w").pack(fill="x", padx=22, pady=(2, 12))

            panel = ctk.CTkFrame(dialog, fg_color=C_SURFACE, corner_radius=12, border_width=1, border_color=C_BORDER)
            panel.pack(fill="both", expand=True, padx=20, pady=(0, 14))

            all_var = tk.BooleanVar(value="all" in current)
            all_row = ctk.CTkFrame(panel, fg_color="transparent")
            all_row.pack(fill="x", padx=14, pady=(12, 6))

            all_checkbox = ctk.CTkCheckBox(
                all_row, text="Allow all paired devices to restore this folder", variable=all_var,
                font=FONT_BODY_B, text_color=C_TEXT, border_color=C_BORDER, fg_color=C_ACCENT,
            )
            all_checkbox.pack(side="left")
            ctk.CTkLabel(all_row, text=f"{len(devices)} device{'s' if len(devices) != 1 else ''}", font=FONT_CAPTION, text_color=C_MUTED).pack(side="right")

            ctk.CTkLabel(panel, text="INDIVIDUAL ACCESS", font=FONT_SECTION, text_color=C_MUTED, anchor="w").pack(fill="x", padx=14, pady=(10, 4))
            devices_frame = ctk.CTkScrollableFrame(panel, fg_color=C_ELEVATED, corner_radius=9, border_width=1, border_color=C_BORDER, label_text="")
            devices_frame.pack(fill="both", expand=True, padx=14, pady=(0, 12))

            selected_vars: dict[str, tk.BooleanVar] = {}
            checkboxes: list[ctk.CTkCheckBox] = []

            if not devices:
                ctk.CTkLabel(devices_frame, text="No devices paired yet.", font=FONT_SMALL, text_color=C_MUTED).pack(pady=28)

            for device in devices:
                device_id = str(device["device_id"])
                var = tk.BooleanVar(value=device_id in current)
                selected_vars[device_id] = var
                checkbox = ctk.CTkCheckBox(
                    devices_frame, text=format_display_name(device), variable=var,
                    font=FONT_SMALL, text_color=C_TEXT, border_color=C_BORDER, fg_color=C_ACCENT,
                )
                checkbox.pack(anchor="w", padx=8, pady=4)
                checkboxes.append(checkbox)

            def sync_individual_state(*_):
                state = "disabled" if all_var.get() else "normal"
                for checkbox in checkboxes:
                    checkbox.configure(state=state)

            all_var.trace_add("write", sync_individual_state)
            sync_individual_state()

            footer = ctk.CTkFrame(dialog, fg_color="transparent")
            footer.pack(fill="x", padx=20, pady=(0, 16))
            ctk.CTkButton(
                footer, text="Cancel", width=100, height=36,
                fg_color="transparent", hover_color=C_ELEVATED, text_color=C_TEXT,
                border_width=1, border_color=C_BORDER, corner_radius=8, font=FONT_BODY_B,
                command=dialog.destroy,
            ).pack(side="left")

            def save_access():
                try:
                    self._shared_dirs = list(load_config().get("SHARED_DIRS", []))
                except Exception:
                    pass
                resolved_idx = next(
                    (i for i, e in enumerate(self._shared_dirs) if e.get("id") == entry_id),
                    None,
                )
                if resolved_idx is None:
                    dialog.destroy()
                    return
                self._shared_dirs[resolved_idx]["device_ids"] = (
                    ["all"] if all_var.get() else [did for did, v in selected_vars.items() if v.get()]
                )
                self._save_shared_dirs_to_config()
                self._refresh_shared_folder_card(entry_id)
                dialog.destroy()

            ctk.CTkButton(
                footer, text="Save Access", width=130, height=36,
                fg_color=C_ACCENT, hover_color=C_ACCENT2, corner_radius=8, font=FONT_BODY_B,
                command=save_access,
            ).pack(side="right")

        threading.Thread(target=_fetch, daemon=True).start()

    def _refresh_shared_folder_card(self, entry_id: str):
        try:
            self._shared_dirs = list(load_config().get("SHARED_DIRS", []))
        except Exception:
            return
        entry = next((e for e in self._shared_dirs if e.get("id") == entry_id), None)
        if not entry:
            return
        widgets = self._shared_folder_card_widgets.get(entry_id)
        if not widgets:
            return
        access_lbl   = widgets.get("access_lbl")
        device_names = widgets.get("device_names", {})
        devices      = widgets.get("devices", [])
        if not access_lbl or not access_lbl.winfo_exists():
            return
        tagged = set(entry.get("device_ids", []))
        if "all" in tagged:
            access_text  = f"Access: All paired devices ({len(devices)})"
            access_color = C_SUCCESS
        elif not tagged:
            access_text  = "Access: No devices selected"
            access_color = C_MUTED
        else:
            names = [device_names.get(str(did), str(did)[-6:]) for did in tagged]
            display_names = ", ".join(names[:3])
            if len(names) > 3:
                display_names += f" +{len(names) - 3}"
            access_text  = f"Access: {display_names}"
            access_color = C_ACCENT
        try:
            access_lbl.configure(text=access_text, text_color=access_color)
        except Exception:
            pass

    def _save_shared_dirs_to_config(self):
        try:
            cfg = load_config()
            cfg["SHARED_DIRS"] = list(self._shared_dirs)
            save_config(cfg)
        except Exception as e:
            print(f"[DesktopApp] Error saving shared dirs: {e}")

    def _add_shared_folder(self):
        folder = filedialog.askdirectory(title="Select Folder to Share with Devices")
        if not folder:
            return
        folder = os.path.abspath(folder)
        if any(os.path.abspath(d.get("path", "")) == folder for d in self._shared_dirs):
            messagebox.showinfo("Shared Folders", "This folder is already shared.")
            return

        new_id = f"shared_{len(self._shared_dirs)}"
        existing_ids = {d.get("id") for d in self._shared_dirs}
        counter = 0
        while new_id in existing_ids:
            counter += 1
            new_id = f"shared_{len(self._shared_dirs) + counter}"
        label = os.path.basename(folder) or folder
        self._shared_dirs.append({"id": new_id, "label": label, "path": folder, "device_ids": []})
        self._save_shared_dirs_to_config()
        self._refresh_shared_dirs_list()

    def _remove_shared_folder(self, idx: int):
        if 0 <= idx < len(self._shared_dirs):
            removed = self._shared_dirs.pop(idx)
            add_log(f"Removed shared folder: {removed.get('label', '')}")
            self._save_shared_dirs_to_config()
            self._refresh_shared_dirs_list()

    # ─── Page: Settings ───────────────────────────────────────────────────────

    def _read_settings_draft(self) -> dict[str, object] | None:
        required_widgets = (
            "_e_host", "_e_port", "_e_root", "_e_key", "_e_preview_cache_dir", "_e_desktop_name",
            "_sw_approval", "_sw_dark_mode", "_sw_autostart", "_sw_tray",
        )
        if not all(hasattr(self, name) for name in required_widgets):
            return None
        try:
            return {
                "HOST": self._e_host.get(),
                "PORT": self._e_port.get(),
                "BACKUP_ROOT": self._e_root.get(),
                "API_KEY": self._e_key.get(),
                "DESKTOP_NAME": self._e_desktop_name.get(),
                "VIDEO_PREVIEW_CACHE_DIR": self._e_preview_cache_dir.get(),
                "REQUIRE_APPROVAL": bool(self._sw_approval.get()),
                "THEME_MODE": "dark" if bool(self._sw_dark_mode.get()) else "light",
                "START_WITH_WINDOWS": bool(self._sw_autostart.get()),
                "MINIMIZE_TO_TRAY": bool(self._sw_tray.get()),
            }
        except (AttributeError, tk.TclError):
            return None

    def _settings_view_config(self) -> dict:
        cfg = dict(load_config())
        if self._settings_draft:
            cfg.update(self._settings_draft)
        return cfg

    def _remember_settings_draft(self, _event=None):
        if self._settings_draft is None:
            return
        draft = self._read_settings_draft()
        if draft:
            self._settings_draft = draft

    def _build_settings(self, parent) -> ctk.CTkFrame:
        frame = ctk.CTkFrame(parent, fg_color=C_BG)

        self._page_header(frame, "Settings", "Server configuration, security, and cache maintenance")
        self._divider(frame)

        scroll = ctk.CTkScrollableFrame(frame, fg_color="transparent", label_text="")
        scroll.pack(fill="both", expand=True, padx=28, pady=(4, 16))

        cfg = self._settings_view_config()

        def settings_card(title: str) -> ctk.CTkFrame:
            ctk.CTkLabel(
                scroll, text=title.upper(),
                font=FONT_SECTION, text_color=C_MUTED,
            ).pack(anchor="w", padx=6, pady=(16, 4))
            card = ctk.CTkFrame(
                scroll, fg_color=C_SURFACE,
                corner_radius=14, border_width=1, border_color=C_BORDER,
            )
            card.pack(fill="x", padx=6, pady=(0, 4))
            return card

        def labeled_entry(card, label: str, default: str = "", placeholder: str = "", show: str = "") -> ctk.CTkEntry:
            row = ctk.CTkFrame(card, fg_color="transparent")
            row.pack(fill="x", padx=16, pady=(12, 0))
            ctk.CTkLabel(row, text=label, font=FONT_BODY_B, text_color=C_TEXT).pack(anchor="w")
            e = ctk.CTkEntry(
                card, height=40, fg_color=C_ELEVATED,
                border_color=C_BORDER, border_width=1,
                text_color=C_TEXT, corner_radius=10,
                placeholder_text=placeholder,
                show=show,
            )
            e.insert(0, default)
            e.pack(fill="x", padx=16, pady=(4, 12))
            return e

        # ── 1. APPEARANCE ─────────────────────────────────────────────────────
        app_card = settings_card("Appearance")
        theme_row = ctk.CTkFrame(app_card, fg_color="transparent")
        theme_row.pack(fill="x", padx=16, pady=14)

        self._sw_dark_mode = ctk.CTkSwitch(
            theme_row, text="", width=48, height=24,
            button_color=C_ACCENT, progress_color=C_ACCENT,
            command=lambda: self.after(0, self._apply_theme_from_settings),
        )
        self._sw_dark_mode.pack(side="left")
        if _normalize_theme_mode(cfg.get("THEME_MODE")) == "dark":
            self._sw_dark_mode.select()

        theme_copy = ctk.CTkFrame(theme_row, fg_color="transparent")
        theme_copy.pack(side="left", fill="x", expand=True, padx=10)
        ctk.CTkLabel(theme_copy, text="Dark Mode", font=FONT_BODY_B, text_color=C_TEXT).pack(anchor="w")
        ctk.CTkLabel(theme_copy, text="Switch between dark and light appearance.", font=FONT_CAPTION, text_color=C_MUTED).pack(anchor="w")

        # ── 2. SERVER & NETWORK ───────────────────────────────────────────────
        srv_card = settings_card("Server & Network")
        self._e_host = labeled_entry(srv_card, "Listen Address (0.0.0.0 listens on all interfaces)", cfg.get("HOST", "0.0.0.0"), "0.0.0.0")
        self._e_port = labeled_entry(srv_card, "Port", str(cfg.get("PORT", 8000)), "8000")
        self._e_desktop_name = labeled_entry(srv_card, "Server Display Name (shown as author in mobile feed)", cfg.get("DESKTOP_NAME", "") or "", "e.g. My PC")

        # Network Interfaces Info
        net_row = ctk.CTkFrame(srv_card, fg_color=C_ELEVATED, corner_radius=8)
        net_row.pack(fill="x", padx=16, pady=(0, 12))
        ips_str = ",  ".join(get_all_local_ips())
        ctk.CTkLabel(net_row, text=f"Available IPv4 Interfaces:  {ips_str}", font=FONT_CAPTION, text_color=C_MUTED).pack(anchor="w", padx=10, pady=6)

        # ── 3. STORAGE PATHS ──────────────────────────────────────────────────
        stor_card = settings_card("Storage")
        self._e_root = labeled_entry(stor_card, "Backup Root Directory", cfg.get("BACKUP_ROOT", ""), "e.g. D:\\PhoneBackup")

        browse_row = ctk.CTkFrame(stor_card, fg_color="transparent")
        browse_row.pack(fill="x", padx=16, pady=(0, 12))
        ctk.CTkButton(
            browse_row, text="Browse Folder", width=120, height=34,
            fg_color=C_SOFT_BLUE, hover_color=C_SOFT_BLUE_HOVER, text_color=C_ACCENT,
            border_width=1, border_color=C_BORDER, corner_radius=8, font=FONT_SMALL_B,
            command=self._browse_root,
        ).pack(side="left", padx=(0, 8))

        free_b, total_b = get_free_disk_space(cfg.get("BACKUP_ROOT", ""))
        self._disk_space_lbl = ctk.CTkLabel(
            browse_row, text=f"Free disk space: {fmt_bytes(free_b)} of {fmt_bytes(total_b)}",
            font=FONT_SMALL, text_color=C_MUTED,
        )
        self._disk_space_lbl.pack(side="left", padx=6)

        # ── 4. CACHES & MAINTENANCE ───────────────────────────────────────────
        cache_card = settings_card("Caches & Index Maintenance")

        try:
            from video_preview import get_video_preview_cache_dir
            active_cache_dir = get_video_preview_cache_dir()
        except Exception:
            active_cache_dir = cfg.get("VIDEO_PREVIEW_CACHE_DIR", os.path.join(os.path.dirname(__file__), "video_preview_cache"))

        cache_path_row = ctk.CTkFrame(cache_card, fg_color="transparent")
        cache_path_row.pack(fill="x", padx=16, pady=(12, 0))
        ctk.CTkLabel(cache_path_row, text="Video Preview Cache Directory", font=FONT_BODY_B, text_color=C_TEXT).pack(anchor="w")

        cache_path_input_row = ctk.CTkFrame(cache_card, fg_color="transparent")
        cache_path_input_row.pack(fill="x", padx=16, pady=(4, 0))
        self._e_preview_cache_dir = ctk.CTkEntry(
            cache_path_input_row, height=38, fg_color=C_ELEVATED,
            border_color=C_BORDER, border_width=1, text_color=C_TEXT,
            corner_radius=9, font=FONT_BODY,
        )
        self._e_preview_cache_dir.insert(0, active_cache_dir)
        self._e_preview_cache_dir.pack(side="left", fill="x", expand=True)
        ctk.CTkButton(
            cache_path_input_row, text="Browse", width=84, height=38,
            fg_color=C_SOFT_BLUE, hover_color=C_SOFT_BLUE_HOVER, text_color=C_ACCENT,
            border_width=1, border_color=C_BORDER, corner_radius=9, font=FONT_SMALL_B,
            command=self._browse_preview_cache_dir,
        ).pack(side="right", padx=(8, 0))

        # Maintenance Rows: Video Previews, Rewind Reel, Thumbnails, Memories
        def cache_item_row(title: str, subtitle_var: tk.StringVar, btn_text: str, command):
            row = ctk.CTkFrame(cache_card, fg_color="transparent")
            row.pack(fill="x", padx=16, pady=10)
            copy_box = ctk.CTkFrame(row, fg_color="transparent")
            copy_box.pack(side="left", fill="x", expand=True)
            ctk.CTkLabel(copy_box, text=title, font=FONT_BODY_B, text_color=C_TEXT).pack(anchor="w")
            ctk.CTkLabel(copy_box, textvariable=subtitle_var, font=FONT_CAPTION, text_color=C_MUTED, wraplength=420, justify="left").pack(anchor="w", pady=(1, 0))
            btn = ctk.CTkButton(
                row, text=btn_text, width=116, height=34,
                fg_color=C_SOFT_RED, hover_color=C_SOFT_RED_HOVER,
                text_color=C_ERROR, border_width=1, border_color=C_ERROR_BORDER,
                corner_radius=8, font=FONT_SMALL_B, command=command,
            )
            btn.pack(side="right", padx=(10, 0))
            return btn

        self._preview_cache_status_var = tk.StringVar(value="Checking cache…")
        self._preview_cache_clear_button = cache_item_row("Optimized Video Previews", self._preview_cache_status_var, "Clean Cache", self._clear_video_preview_cache)

        self._rewind_cache_status_var = tk.StringVar(value="Checking cache…")
        self._rewind_cache_clear_button = cache_item_row("Rewind Reel Videos", self._rewind_cache_status_var, "Clean Cache", self._clear_rewind_cache)

        self._thumb_cache_status_var = tk.StringVar(value="Checking cache…")
        self._thumb_cache_clear_button = cache_item_row("Thumbnail Images", self._thumb_cache_status_var, "Clean Cache", self._clear_thumbnail_cache)

        self._memory_index_status_var = tk.StringVar(value="Checking index…")
        self._memory_index_clear_button = cache_item_row("Memory Index (On This Day / Flashbacks)", self._memory_index_status_var, "Clean & Reindex", self._clean_and_reindex_memories)

        # ── 5. SECURITY ───────────────────────────────────────────────────────
        sec_card = settings_card("Security")
        key_wrap = ctk.CTkFrame(sec_card, fg_color="transparent")
        key_wrap.pack(fill="x", padx=16, pady=(12, 0))
        ctk.CTkLabel(key_wrap, text="API Secret Key (must match mobile app)", font=FONT_BODY_B, text_color=C_TEXT).pack(anchor="w")

        key_input_row = ctk.CTkFrame(sec_card, fg_color="transparent")
        key_input_row.pack(fill="x", padx=16, pady=(4, 10))
        self._e_key = ctk.CTkEntry(
            key_input_row, height=38, fg_color=C_ELEVATED,
            border_color=C_BORDER, border_width=1, text_color=C_TEXT,
            corner_radius=9, font=FONT_BODY, show="●",
        )
        self._e_key.insert(0, cfg.get("API_KEY", ""))
        self._e_key.pack(side="left", fill="x", expand=True)

        self._key_visible = False
        def toggle_key_vis():
            self._key_visible = not self._key_visible
            self._e_key.configure(show="" if self._key_visible else "●")
            key_vis_btn.configure(text="Hide" if self._key_visible else "Show")

        key_vis_btn = ctk.CTkButton(
            key_input_row, text="Show", width=64, height=38,
            fg_color=C_ELEVATED, hover_color=C_BORDER, text_color=C_TEXT,
            border_width=1, border_color=C_BORDER, corner_radius=9, font=FONT_SMALL_B,
            command=toggle_key_vis,
        )
        key_vis_btn.pack(side="right", padx=(8, 0))

        key_copy_btn = ctk.CTkButton(
            key_input_row, text="Copy", width=64, height=38,
            fg_color=C_SOFT_BLUE, hover_color=C_SOFT_BLUE_HOVER, text_color=C_ACCENT,
            border_width=1, border_color=C_BORDER, corner_radius=9, font=FONT_SMALL_B,
            command=lambda: self._copy_to_clipboard(self._e_key.get(), key_copy_btn, "Copied!"),
        )
        key_copy_btn.pack(side="right", padx=(8, 0))

        sw_row = ctk.CTkFrame(sec_card, fg_color="transparent")
        sw_row.pack(fill="x", padx=16, pady=(4, 14))
        self._sw_approval = ctk.CTkSwitch(
            sw_row, text="", width=48, height=24,
            button_color=C_ACCENT, progress_color=C_ACCENT,
        )
        self._sw_approval.pack(side="left")
        if cfg.get("REQUIRE_APPROVAL", True):
            self._sw_approval.select()
        ctk.CTkLabel(sw_row, text="Require approval prompt for new device pairings", font=FONT_BODY, text_color=C_TEXT).pack(side="left", padx=10)
        self._sw_approval.configure(command=self._remember_settings_draft)

        # ── 6. STARTUP & SYSTEM TRAY ──────────────────────────────────────────
        startup_card = settings_card("Startup & Behavior")

        sw_row2 = ctk.CTkFrame(startup_card, fg_color="transparent")
        sw_row2.pack(fill="x", padx=16, pady=(10, 6))
        self._sw_autostart = ctk.CTkSwitch(
            sw_row2, text="", width=48, height=24,
            button_color=C_ACCENT, progress_color=C_ACCENT,
        )
        self._sw_autostart.pack(side="left")
        if cfg.get("START_WITH_WINDOWS", False):
            self._sw_autostart.select()
        ctk.CTkLabel(sw_row2, text="Start automatically with Windows", font=FONT_BODY, text_color=C_TEXT).pack(side="left", padx=10)
        self._sw_autostart.configure(command=self._remember_settings_draft)

        sw_row3 = ctk.CTkFrame(startup_card, fg_color="transparent")
        sw_row3.pack(fill="x", padx=16, pady=(6, 14))
        self._sw_tray = ctk.CTkSwitch(
            sw_row3, text="", width=48, height=24,
            button_color=C_ACCENT, progress_color=C_ACCENT,
        )
        self._sw_tray.pack(side="left")
        if cfg.get("MINIMIZE_TO_TRAY", True):
            self._sw_tray.select()
        ctk.CTkLabel(sw_row3, text="Minimize to system tray on minimize", font=FONT_BODY, text_color=C_TEXT).pack(side="left", padx=10)
        self._sw_tray.configure(command=self._remember_settings_draft)

        for entry_widget in (
            self._e_host, self._e_port, self._e_root, self._e_key,
            self._e_preview_cache_dir, self._e_desktop_name,
        ):
            entry_widget.bind("<KeyRelease>", self._remember_settings_draft, add="+")

        # ── Save Button ───────────────────────────────────────────────────────
        ctk.CTkButton(
            scroll, text="Save Settings & Restart Server", height=46,
            font=FONT_BODY_B, fg_color=C_ACCENT, hover_color=C_ACCENT2,
            corner_radius=10, command=self._save_settings,
        ).pack(fill="x", padx=6, pady=(20, 4))

        ctk.CTkLabel(
            scroll, text="Server will restart automatically to apply network and port configuration.",
            font=FONT_CAPTION, text_color=C_MUTED, anchor="w",
        ).pack(anchor="w", padx=8, pady=(0, 20))

        def _bg_refresh_cache_statuses():
            for fn in (
                self._refresh_video_preview_cache_status,
                self._refresh_rewind_cache_status,
                self._refresh_thumbnail_cache_status,
                self._refresh_memory_index_status,
            ):
                try:
                    fn()
                except Exception:
                    pass

        threading.Thread(target=_bg_refresh_cache_statuses, daemon=True).start()

        return frame

    def _browse_root(self):
        folder = filedialog.askdirectory(title="Select Backup Root Folder")
        if folder:
            self._e_root.delete(0, "end")
            self._e_root.insert(0, folder)
            free_b, total_b = get_free_disk_space(folder)
            if hasattr(self, "_disk_space_lbl"):
                self._disk_space_lbl.configure(text=f"Free disk space: {fmt_bytes(free_b)} of {fmt_bytes(total_b)}")
            self._remember_settings_draft()

    def _browse_preview_cache_dir(self):
        current_dir = self._e_preview_cache_dir.get().strip()
        folder = filedialog.askdirectory(
            title="Select Video Preview Cache Directory",
            initialdir=current_dir if os.path.isdir(current_dir) else None,
        )
        if folder:
            self._e_preview_cache_dir.delete(0, "end")
            self._e_preview_cache_dir.insert(0, folder)
            self._remember_settings_draft()

    def _refresh_video_preview_cache_status(self):
        status_var = getattr(self, "_preview_cache_status_var", None)
        if status_var is None:
            return

        def _fetch():
            try:
                from video_preview import get_video_preview_cache_stats
                stats = get_video_preview_cache_stats()
                cached = f"{stats['files']} cached files · {fmt_bytes(int(stats['bytes']))}"
                limit = int(stats.get("limit_bytes", 0))
                limit_text = "unlimited" if limit == 0 else fmt_bytes(limit)
                activity = ""
                if stats.get("running"):
                    activity = f" · optimizing {stats['running']}"
                elif stats.get("queued"):
                    activity = f" · {stats['queued']} queued"
                text = f"{cached} (limit {limit_text}){activity}"
            except Exception:
                text = "Preview cache stats unavailable."
            if getattr(self, "_preview_cache_status_var", None) is status_var:
                self.after(0, lambda: status_var.set(text))

        threading.Thread(target=_fetch, daemon=True).start()

    def _clear_video_preview_cache(self):
        if not confirm_dialog(
            self, "Clean Video Preview Cache",
            "Remove all server-generated video previews?\n\nOriginal backups are not affected.",
        ):
            return

        button = getattr(self, "_preview_cache_clear_button", None)
        if button:
            button.configure(state="disabled", text="Cleaning…")

        def _clean():
            try:
                from video_preview import clear_video_preview_cache
                result = clear_video_preview_cache()
                removed = fmt_bytes(int(result["bytes"]))
                message = f"Removed {result['files']} cached preview file(s) ({removed})."
            except Exception as exc:
                message = f"Could not clean preview cache: {exc}"

            def _finish():
                if button and button.winfo_exists():
                    button.configure(state="normal", text="Clean Cache")
                self._refresh_video_preview_cache_status()
                messagebox.showinfo("Video Preview Cache", message)

            self.after(0, _finish)

        threading.Thread(target=_clean, daemon=True).start()

    def _refresh_rewind_cache_status(self):
        status_var = getattr(self, "_rewind_cache_status_var", None)
        if status_var is None:
            return

        def _fetch():
            try:
                from rewind import get_rewind_cache_stats
                stats = get_rewind_cache_stats()
                text = f"{stats['files']} files · {fmt_bytes(int(stats['bytes']))}"
            except Exception:
                text = "Rewind cache stats unavailable."
            if getattr(self, "_rewind_cache_status_var", None) is status_var:
                self.after(0, lambda: status_var.set(text))

        threading.Thread(target=_fetch, daemon=True).start()

    def _clear_rewind_cache(self):
        if not confirm_dialog(
            self, "Clean Rewind Reel Cache",
            "Remove all server-generated Rewind Reel videos?\n\nOriginal backups are not affected.",
        ):
            return

        button = getattr(self, "_rewind_cache_clear_button", None)
        if button:
            button.configure(state="disabled", text="Cleaning…")

        def _clean():
            try:
                from rewind import clear_rewind_cache
                result = clear_rewind_cache()
                message = f"Removed {result['files']} rewind file(s) ({fmt_bytes(int(result['bytes']))})."
            except Exception as exc:
                message = f"Could not clean rewind cache: {exc}"

            def _finish():
                if button and button.winfo_exists():
                    button.configure(state="normal", text="Clean Cache")
                self._refresh_rewind_cache_status()
                messagebox.showinfo("Rewind Reel Cache", message)

            self.after(0, _finish)

        threading.Thread(target=_clean, daemon=True).start()

    def _refresh_thumbnail_cache_status(self):
        status_var = getattr(self, "_thumb_cache_status_var", None)
        if status_var is None:
            return

        def _fetch():
            try:
                from thumbnail import get_thumbnail_cache_stats
                stats = get_thumbnail_cache_stats()
                text = f"{stats['files']} images · {fmt_bytes(int(stats['bytes']))}"
            except Exception:
                text = "Thumbnail cache stats unavailable."
            if getattr(self, "_thumb_cache_status_var", None) is status_var:
                self.after(0, lambda: status_var.set(text))

        threading.Thread(target=_fetch, daemon=True).start()

    def _clear_thumbnail_cache(self):
        if not confirm_dialog(
            self, "Clean Thumbnail Cache",
            "Remove all cached video thumbnail images?\n\nOriginal backups are not affected.",
        ):
            return

        button = getattr(self, "_thumb_cache_clear_button", None)
        if button:
            button.configure(state="disabled", text="Cleaning…")

        def _clean():
            try:
                from thumbnail import clear_thumbnail_cache
                result = clear_thumbnail_cache()
                message = f"Removed {result['files']} thumbnail file(s) ({fmt_bytes(int(result['bytes']))})."
            except Exception as exc:
                message = f"Could not clean thumbnail cache: {exc}"

            def _finish():
                if button and button.winfo_exists():
                    button.configure(state="normal", text="Clean Cache")
                self._refresh_thumbnail_cache_status()
                messagebox.showinfo("Thumbnail Cache", message)

            self.after(0, _finish)

        threading.Thread(target=_clean, daemon=True).start()

    def _refresh_memory_index_status(self):
        status_var = getattr(self, "_memory_index_status_var", None)
        if status_var is None:
            return

        def _fetch():
            try:
                import memories
                stats = memories.get_memory_index_stats()
                last = stats.get("last_indexed_at")
                last_txt = datetime.fromtimestamp(last).strftime("%Y-%m-%d %H:%M") if last else "never"
                text = f"{stats['files']:,} indexed files · last run {last_txt}"
            except Exception:
                text = "Memory index stats unavailable."
            if getattr(self, "_memory_index_status_var", None) is status_var:
                self.after(0, lambda: status_var.set(text))

        threading.Thread(target=_fetch, daemon=True).start()

    def _clean_and_reindex_memories(self):
        if not confirm_dialog(
            self, "Clean & Reindex Memory Index",
            "Reset the memory index and rebuild it from disk?\n\nOriginal backups are not affected.",
            destructive=False,
        ):
            return

        button = getattr(self, "_memory_index_clear_button", None)
        if button:
            button.configure(state="disabled", text="Reindexing…")

        def _run():
            try:
                import memories
                result = memories.reset_and_reindex_all()
                if result.get("ok"):
                    n = result["cleared"]
                    message = f"Cleared {n} entries and successfully rebuilt the memory index."
                else:
                    message = result.get("error", "Could not reset the memory index.")
            except Exception as exc:
                message = f"Could not reset memory index: {exc}"

            def _finish():
                if button and button.winfo_exists():
                    button.configure(state="normal", text="Clean & Reindex")
                self._refresh_memory_index_status()
                messagebox.showinfo("Memory Index", message)

            self.after(0, _finish)

        threading.Thread(target=_run, daemon=True).start()

    def _save_settings(self):
        try:
            port = int(self._e_port.get().strip() or "8000")
        except ValueError:
            messagebox.showerror("Invalid Port", "Port must be a valid number.")
            return
        if not 1 <= port <= 65535:
            messagebox.showerror("Invalid Port", "Port must be between 1 and 65535.")
            return

        preview_cache_dir_value = self._e_preview_cache_dir.get().strip()
        if not preview_cache_dir_value:
            messagebox.showerror("Invalid Preview Cache Folder", "Choose a directory for video previews.")
            return
        preview_cache_dir = os.path.abspath(os.path.expanduser(preview_cache_dir_value))
        try:
            os.makedirs(preview_cache_dir, exist_ok=True)
        except OSError as exc:
            messagebox.showerror("Preview Cache Folder", f"Cannot create or access that folder:\n{exc}")
            return

        cfg = {
            "HOST":             self._e_host.get().strip() or "0.0.0.0",
            "PORT":             port,
            "BACKUP_ROOT":      self._e_root.get().strip(),
            "API_KEY":          self._e_key.get().strip() or "YOUR_SECRET_KEY",
            "REQUIRE_APPROVAL": bool(self._sw_approval.get()),
            "THEME_MODE":       "dark" if bool(self._sw_dark_mode.get()) else "light",
            "VIDEO_PREVIEW_CACHE_DIR": preview_cache_dir,
            "SHARED_DIRS":      list(self._shared_dirs),
            "START_WITH_WINDOWS": bool(self._sw_autostart.get()),
            "MINIMIZE_TO_TRAY": bool(self._sw_tray.get()),
            "DESKTOP_NAME":     self._e_desktop_name.get().strip() or platform.node() or "Desktop Server",
        }
        save_config(cfg)
        _ensure_desktop_device(cfg["DESKTOP_NAME"])
        if not set_autostart_enabled(cfg["START_WITH_WINDOWS"]):
            if not cfg["START_WITH_WINDOWS"]:
                self._sw_autostart.deselect()
        self._tray_enabled = cfg["MINIMIZE_TO_TRAY"]
        self._settings_draft = None

        try:
            from video_preview import get_video_preview_cache_dir
            previous_cache_dir = get_video_preview_cache_dir()
        except Exception:
            previous_cache_dir = preview_cache_dir

        if os.path.normcase(os.path.abspath(previous_cache_dir)) != os.path.normcase(preview_cache_dir):
            self._relocate_video_preview_cache_async(preview_cache_dir)

        add_log("Settings saved - restarting server")
        self._restart_server()

    def _relocate_video_preview_cache_async(self, destination: str):
        def _move():
            try:
                from video_preview import relocate_video_preview_cache
                result = relocate_video_preview_cache(destination)
                add_log(
                    f"Video preview cache moved: {result['moved_files']} file(s), {fmt_bytes(int(result['moved_bytes']))}"
                )
            except Exception as exc:
                add_log(f"Video preview cache move error: {exc}")
            finally:
                self.after(0, self._refresh_video_preview_cache_status)

        threading.Thread(target=_move, daemon=True).start()

    def _apply_theme_from_settings(self):
        mode = "dark" if bool(self._sw_dark_mode.get()) else "light"
        self._settings_draft = self._read_settings_draft()
        cfg = load_config()
        cfg["THEME_MODE"] = mode
        save_config(cfg)
        apply_theme(mode)
        add_log(f"Theme switched to {mode} mode")
        if self._theme_rebuild_after_id:
            try:
                self.after_cancel(self._theme_rebuild_after_id)
            except Exception:
                pass
        self._theme_rebuild_after_id = self.after(140, self._finish_theme_rebuild)

    def _finish_theme_rebuild(self):
        self._theme_rebuild_after_id = None
        self._rebuild_shell()

    # ─── Page: Activity Logs ──────────────────────────────────────────────────

    def _build_logs(self, parent) -> ctk.CTkFrame:
        frame = ctk.CTkFrame(parent, fg_color=C_BG)

        hdr = self._page_header(frame, "Activity Logs", "Live event stream and server operation logs")
        ctrl = ctk.CTkFrame(hdr, fg_color="transparent")
        ctrl.pack(side="right")

        self._log_filter = ctk.CTkEntry(
            ctrl, width=200, height=34, placeholder_text="Filter logs…",
            fg_color=C_ELEVATED, border_color=C_BORDER, border_width=1,
            text_color=C_TEXT, corner_radius=9, font=FONT_BODY,
        )
        self._log_filter.pack(side="left", padx=(0, 8))
        self._log_filter.bind("<KeyRelease>", lambda e: self._refresh_logs())

        ctk.CTkButton(
            ctrl, text="Copy All", width=74, height=34,
            fg_color=C_SOFT_BLUE, hover_color=C_SOFT_BLUE_HOVER, text_color=C_ACCENT,
            border_width=1, border_color=C_BORDER, corner_radius=8, font=FONT_SMALL_B,
            command=self._copy_all_logs,
        ).pack(side="left", padx=(0, 6))

        ctk.CTkButton(
            ctrl, text="Clear", width=68, height=34,
            fg_color=C_SOFT_RED, hover_color=C_SOFT_RED_HOVER, text_color=C_ERROR,
            border_width=1, border_color=C_ERROR_BORDER, corner_radius=8, font=FONT_SMALL_B,
            command=self._clear_logs,
        ).pack(side="left")

        self._divider(frame)

        log_wrap = ctk.CTkFrame(
            frame, fg_color=C_SURFACE,
            corner_radius=14, border_width=1, border_color=C_BORDER,
        )
        log_wrap.pack(fill="both", expand=True, padx=32, pady=(10, 16))

        self._log_box = ctk.CTkTextbox(
            log_wrap, state="disabled", fg_color="transparent",
            border_width=0, font=FONT_MONO, text_color=C_TEXT, wrap="word",
        )
        self._log_box.pack(fill="both", expand=True, padx=6, pady=6)
        self._setup_log_tags(self._log_box)

        return frame

    def _copy_all_logs(self):
        logs = get_logs()
        txt = "\n".join(f"[{datetime.fromtimestamp(e['time']).strftime('%Y-%m-%d %H:%M:%S')}] {e['message']}" for e in logs)
        self.clipboard_clear()
        self.clipboard_append(txt)
        messagebox.showinfo("Logs", "All activity logs copied to clipboard.")

    def _refresh_logs(self):
        query = ""
        try:
            query = self._log_filter.get().lower().strip()
        except Exception:
            pass

        def _fetch():
            logs = get_logs()
            if query:
                logs = [e for e in logs if query in e["message"].lower()]
            logs = logs[-500:]
            try:
                self.after(0, lambda: _render(logs, query))
            except RuntimeError:
                pass

        def _render(logs, q):
            last_ts = logs[-1]["time"] if logs else 0
            cached_ts = self._last_logs_cache[-1]["time"] if self._last_logs_cache else -1
            if (len(logs) == len(self._last_logs_cache) and last_ts == cached_ts
                    and q == self._last_logs_query):
                return
            self._log_box.configure(state="normal")
            self._log_box.delete("1.0", "end")
            self._log_box.configure(state="disabled")
            for entry in reversed(logs):
                self._insert_log_line(self._log_box, entry)
            self._last_logs_cache = logs.copy()
            self._last_logs_query = q

        threading.Thread(target=_fetch, daemon=True).start()

    def _clear_logs(self):
        clear_logs()
        self._refresh_logs()

    # ─── Page: Sync History ───────────────────────────────────────────────────

    def _build_history(self, parent) -> ctk.CTkFrame:
        frame = ctk.CTkFrame(parent, fg_color=C_BG)
        hdr = self._page_header(frame, "Sync History", "Per-session backup audit trail and performance stats")

        ctrl = ctk.CTkFrame(hdr, fg_color="transparent")
        ctrl.pack(side="right")

        self._hist_device_var = tk.StringVar(value="All Devices")
        self._hist_device_menu = ctk.CTkOptionMenu(
            ctrl,
            variable=self._hist_device_var,
            values=["All Devices"],
            width=160, height=34,
            fg_color=C_ELEVATED,
            button_color=C_ELEVATED,
            button_hover_color=C_SOFT_BLUE,
            text_color=C_TEXT,
            dropdown_fg_color=C_SURFACE,
            dropdown_text_color=C_TEXT,
            dropdown_hover_color=C_SOFT_BLUE,
            corner_radius=9,
            command=lambda _: self._refresh_history(force=True, _show_loading=True),
        )
        self._hist_device_menu.pack(side="left", padx=(0, 8))

        ctk.CTkButton(
            ctrl, text="Refresh", width=80, height=34,
            fg_color=C_SOFT_BLUE, hover_color=C_SOFT_BLUE_HOVER,
            text_color=C_ACCENT, border_width=1, border_color=C_BORDER,
            corner_radius=8, font=FONT_SMALL_B,
            command=lambda: self._refresh_history(force=True, _show_loading=True),
        ).pack(side="left", padx=(0, 6))

        ctk.CTkButton(
            ctrl, text="Clear", width=74, height=34,
            fg_color=C_SOFT_RED, hover_color=C_SOFT_RED_HOVER,
            text_color=C_ERROR, border_width=1, border_color=C_ERROR_BORDER,
            corner_radius=8, font=FONT_SMALL_B,
            command=self._clear_history,
        ).pack(side="left")

        self._divider(frame)

        # Summary Metric Banner
        self._hist_banner = ctk.CTkFrame(
            frame, fg_color=C_SURFACE,
            corner_radius=12, border_width=1, border_color=C_BORDER,
            height=42,
        )
        self._hist_banner.pack(fill="x", padx=32, pady=(12, 0))
        self._hist_banner.pack_propagate(False)
        self._hist_banner_lbl = ctk.CTkLabel(
            self._hist_banner,
            text="Load history records…",
            font=FONT_BODY_B, text_color=C_MUTED,
        )
        self._hist_banner_lbl.pack(expand=True)

        self._hist_count_label = ctk.CTkLabel(
            frame, text="0 sessions", font=FONT_SMALL, text_color=C_MUTED, anchor="w",
        )
        self._hist_count_label.pack(fill="x", padx=34, pady=(8, 0))

        self._hist_scroll = ctk.CTkScrollableFrame(
            frame, fg_color="transparent", label_text="",
        )
        self._hist_scroll.pack(fill="both", expand=True, padx=28, pady=(4, 4))
        self._hist_scroll.grid_columnconfigure(0, weight=1)

        # Pagination bar
        hist_pg_bar = ctk.CTkFrame(frame, fg_color="transparent", height=40)
        hist_pg_bar.pack(fill="x", padx=28, pady=(0, 12))
        hist_pg_bar.pack_propagate(False)

        self._hist_prev_btn = ctk.CTkButton(
            hist_pg_bar, text="← Prev", width=80, height=32,
            fg_color=C_ELEVATED, hover_color=C_BORDER, text_color=C_TEXT,
            border_width=1, border_color=C_BORDER, corner_radius=8, font=FONT_SMALL_B,
            command=self._hist_prev_page, state="disabled",
        )
        self._hist_prev_btn.pack(side="left")

        self._hist_page_lbl = ctk.CTkLabel(
            hist_pg_bar, text="", font=FONT_SMALL, text_color=C_MUTED,
        )
        self._hist_page_lbl.pack(side="left", padx=12)

        self._hist_next_btn = ctk.CTkButton(
            hist_pg_bar, text="Next →", width=80, height=32,
            fg_color=C_ELEVATED, hover_color=C_BORDER, text_color=C_TEXT,
            border_width=1, border_color=C_BORDER, corner_radius=8, font=FONT_SMALL_B,
            command=self._hist_next_page, state="disabled",
        )
        self._hist_next_btn.pack(side="left")

        return frame

    @staticmethod
    def _history_device_options(devices: list[dict]) -> tuple[list[str], dict[str, str | None]]:
        names = [format_display_name(d) for d in devices]
        duplicate_counts = {name: names.count(name) for name in set(names)}
        values = ["All Devices"]
        device_id_map: dict[str, str | None] = {}

        for index, device in enumerate(devices):
            base = names[index]
            device_id = device.get("device_id")
            if duplicate_counts[base] > 1:
                suffix = str(device_id or device.get("id") or index + 1)[-6:]
                label = f"{base} · {suffix}"
            else:
                label = base
            while label in device_id_map:
                label = f"{label} · {index + 1}"
            values.append(label)
            device_id_map[label] = device_id
        return values, device_id_map

    @staticmethod
    def _history_cache_key(sessions: list[dict]) -> str:
        fields = (
            "id", "outcome", "uploaded", "skipped", "errors", "scanned",
            "duration_ms", "started_at", "device_name", "device_id", "trigger",
        )
        return "|".join(repr(tuple(session.get(field) for field in fields)) for session in sessions)

    def _refresh_history(self, force: bool = False, _show_loading: bool = False):
        if self._refresh_in_flight.get("history"):
            return
        self._refresh_in_flight["history"] = True

        # Show skeleton immediately when explicitly requested
        if _show_loading:
            self._show_history_loading_state()

        selected = self._hist_device_var.get()
        dev_map = getattr(self, "_hist_device_id_map", {})
        filter_id = dev_map.get(selected) if selected != "All Devices" else None

        def _fetch():
            try:
                devices = get_devices()
                device_names, device_id_map = self._history_device_options(devices)
                fid = device_id_map.get(selected) if selected != "All Devices" else None
                sessions = get_sync_sessions(device_id=fid, limit=500)
            except Exception:
                devices, device_names, device_id_map, sessions = [], ["All Devices"], {}, []

            try:
                self.after(0, lambda: _render(device_names, device_id_map, sessions))
            except RuntimeError:
                self._refresh_in_flight["history"] = False

        def _render(device_names, device_id_map, sessions):
            self._refresh_in_flight["history"] = False
            self._hist_device_id_map = device_id_map
            current = self._hist_device_var.get()
            try:
                self._hist_device_menu.configure(values=device_names)
                if current not in device_names:
                    self._hist_device_var.set("All Devices")
            except Exception:
                pass

            new_key = self._history_cache_key(sessions)
            loading_showing = (
                not self._hist_all_sessions
                or (
                    hasattr(self, "_hist_scroll")
                    and self._hist_scroll.winfo_exists()
                    and len(self._hist_scroll.winfo_children()) <= 1
                )
            )
            if not force and not loading_showing and new_key == self._hist_cache_key:
                return
            self._hist_cache_key = new_key
            self._hist_sessions_cache = sessions
            self._hist_all_sessions = sessions

            if not sessions:
                self._hist_banner_lbl.configure(
                    text="No sync sessions recorded yet — records appear after mobile backups.",
                    text_color=C_MUTED,
                )
            else:
                total_up  = sum(s.get("uploaded",    0) for s in sessions)
                total_err = sum(s.get("errors",      0) for s in sessions)
                total_ms  = sum(s.get("duration_ms", 0) for s in sessions)
                n_done    = sum(1 for s in sessions if s.get("outcome") == "completed")
                n_fail    = sum(1 for s in sessions if s.get("outcome") in ("failed", "force_stopped"))

                def _bd(ms):
                    secs = max(0, ms // 1000)
                    if secs < 60: return f"{secs}s"
                    mins = secs // 60
                    return f"{mins}m {secs % 60}s" if (secs % 60) else f"{mins}m"

                parts = [
                    f"Sessions: {len(sessions)}",
                    f"Uploaded: {total_up:,}",
                    f"Completed: {n_done}",
                    f"Total Time: {_bd(total_ms)}",
                ]
                if total_err: parts.append(f"Errors: {total_err}")
                if n_fail:    parts.append(f"Interrupted: {n_fail}")
                self._hist_banner_lbl.configure(
                    text="   •   ".join(parts),
                    text_color=C_TEXT,
                )

            self._hist_page = 0
            self._hist_render_page()

        threading.Thread(target=_fetch, daemon=True).start()

    def _hist_render_page(self):
        sessions   = self._hist_all_sessions
        page       = self._hist_page
        page_size  = self._hist_page_size
        total      = len(sessions)
        num_pages  = max(1, (total + page_size - 1) // page_size)
        page       = max(0, min(page, num_pages - 1))
        self._hist_page = page

        start = page * page_size
        end   = min(start + page_size, total)
        page_sessions = sessions[start:end]

        try:
            self._hist_count_label.configure(
                text=f"{total} session{'s' if total != 1 else ''}" if total else "0 sessions"
            )
            page_from = start + 1 if total else 0
            pg_txt = f"Page {page + 1} / {num_pages}  ({page_from}–{end} of {total})" if num_pages > 1 else (f"{total} session{'s' if total != 1 else ''}" if total else "")
            self._hist_page_lbl.configure(text=pg_txt)
            self._hist_prev_btn.configure(state="normal" if page > 0 else "disabled")
            self._hist_next_btn.configure(state="normal" if page < num_pages - 1 else "disabled")
        except Exception:
            pass

        # Cancel any in-progress chunked render
        old_hist_chunk = getattr(self, "_hist_chunk_after_id", None)
        if old_hist_chunk:
            try:
                self.after_cancel(old_hist_chunk)
            except Exception:
                pass
            self._hist_chunk_after_id = None

        for w in self._hist_scroll.winfo_children():
            w.destroy()
        try:
            self._hist_scroll._parent_canvas.yview_moveto(0)
        except Exception:
            pass

        if not sessions:
            empty = ctk.CTkFrame(
                self._hist_scroll, fg_color=C_SURFACE,
                corner_radius=14, border_width=1, border_color=C_BORDER,
            )
            empty.grid(row=0, column=0, sticky="ew", padx=6, pady=24)
            ctk.CTkLabel(
                empty, text="No sync sessions found",
                font=FONT_BODY_B, text_color=C_TEXT,
            ).pack(pady=(20, 2))
            ctk.CTkLabel(
                empty,
                text="Completed and interrupted backup runs from Android devices will be cataloged here.",
                font=FONT_BODY, text_color=C_MUTED, justify="center",
            ).pack(pady=(0, 20))
            return

        OUTCOME_CFG = {
            "completed":    ("Completed",    C_SUCCESS, C_SOFT_GREEN),
            "stopped":      ("Stopped",      C_WARNING, C_SOFT_AMBER),
            "force_stopped":("Force stopped",C_ERROR,   C_SOFT_RED),
            "failed":       ("Failed",       C_ERROR,   C_SOFT_RED),
        }

        def _fmt_ts(ts):
            try:    return datetime.fromtimestamp(ts / 1000).strftime("%b %d, %H:%M")
            except: return ""

        def _fmt_dur(ms):
            secs = max(0, ms // 1000)
            if secs < 60: return f"{secs}s"
            mins = secs // 60
            return f"{mins}m {secs % 60}s" if (secs % 60) else f"{mins}m"

        def _build_hist_card(sess):
            """Build a single lightweight history session card."""
            outcome = sess.get("outcome", "completed")
            label, fg, bg = OUTCOME_CFG.get(outcome, ("Unknown", C_ACCENT, C_SOFT_BLUE))
            device_label = sess.get("device_name") or sess.get("device_id") or "Unknown device"
            started_ts   = sess.get("started_at", 0)
            trigger      = sess.get("trigger", "manual")
            uploaded     = sess.get("uploaded",    0)
            skipped      = sess.get("skipped",     0)
            errors       = sess.get("errors",      0)
            dur_ms       = sess.get("duration_ms", 0)

            stat_items = []
            if uploaded:
                stat_items.append(f"⬆ {uploaded:,}")
            if skipped:
                stat_items.append(f"✓ {skipped:,}")
            if not uploaded and not skipped:
                stat_items.append("0 files")
            if errors:
                stat_items.append(f"✗ {errors}")
            if dur_ms:
                stat_items.append(_fmt_dur(dur_ms))
            stats_clr = C_ERROR if errors else (C_SUCCESS if uploaded else C_MUTED)
            trigger_txt = "  AUTO" if trigger == "auto" else ""
            stats_str = "  •  ".join(stat_items)

            # Single flat frame — no nested body frame, no accent bar frame
            card = ctk.CTkFrame(
                self._hist_scroll, fg_color=C_SURFACE,
                corner_radius=6, border_width=1, border_color=C_BORDER,
            )
            card.pack(fill="x", padx=4, pady=1)
            card.grid_columnconfigure(2, weight=1)

            # Outcome badge (column 0)
            badge = ctk.CTkFrame(card, fg_color=bg, corner_radius=5, width=72)
            badge.grid(row=0, column=0, padx=(6, 4), pady=5, sticky="w")
            badge.grid_propagate(False)
            ctk.CTkLabel(
                badge, text=label,
                font=ctk.CTkFont(family="Segoe UI Variable Text", size=9, weight="bold"),
                text_color=fg,
            ).pack(expand=True)

            # Device name (column 1)
            ctk.CTkLabel(
                card, text=device_label + trigger_txt,
                font=FONT_SMALL_B, text_color=C_TEXT, anchor="w",
            ).grid(row=0, column=1, padx=(0, 8), pady=5, sticky="w")

            # Stats (column 2, expands)
            ctk.CTkLabel(
                card, text=stats_str,
                font=FONT_SMALL, text_color=stats_clr, anchor="w",
            ).grid(row=0, column=2, padx=0, pady=5, sticky="ew")

            # Timestamp (column 3, right-aligned)
            ctk.CTkLabel(
                card, text=_fmt_ts(started_ts),
                font=FONT_CAPTION, text_color=C_MUTED, anchor="e",
            ).grid(row=0, column=3, padx=(4, 10), pady=5, sticky="e")

        # Chunked rendering — 20 rows per batch for fast page loads
        _HIST_CHUNK = 20

        def _render_hist_chunk(items_remaining: list):
            if not self._hist_scroll.winfo_exists():
                return
            for sess in items_remaining[:_HIST_CHUNK]:
                _build_hist_card(sess)
            rest = items_remaining[_HIST_CHUNK:]
            if rest:
                self._hist_chunk_after_id = self.after(0, lambda: _render_hist_chunk(rest))
            else:
                self._hist_chunk_after_id = None

        _render_hist_chunk(list(page_sessions))

    def _hist_prev_page(self):
        self._hist_page = max(0, self._hist_page - 1)
        self._hist_render_page()

    def _hist_next_page(self):
        total     = len(self._hist_all_sessions)
        num_pages = max(1, (total + self._hist_page_size - 1) // self._hist_page_size)
        self._hist_page = min(self._hist_page + 1, num_pages - 1)
        self._hist_render_page()

    def _clear_history(self):
        if not confirm_dialog(self, "Clear Sync History", "Permanently delete sync session records from the database?"):
            return
        selected = self._hist_device_var.get()
        dev_map = getattr(self, "_hist_device_id_map", {})
        filter_id = dev_map.get(selected) if selected != "All Devices" else None

        self._show_history_loading_state()

        def _do_clear():
            try:
                clear_sync_sessions(device_id=filter_id)
            except Exception:
                pass
            def _finish():
                self._hist_cache_key = ""
                self._hist_sessions_cache = []
                self._hist_all_sessions = []
                self._refresh_history(force=True)
            self.after(0, _finish)

        threading.Thread(target=_do_clear, daemon=True).start()

    # ─── Navigation ───────────────────────────────────────────────────────────

    def _show_page(self, page: str):
        # ── Lazy build: construct the frame only on first visit ───────────────
        if page not in self._pages:
            builder = self._page_builders.get(page)
            if builder is None:
                return
            frame = builder(self._frames_container)
            frame.grid(row=0, column=0, sticky="nsew")
            self._pages[page] = frame

        # Raise immediately so the UI feels instant
        self._pages[page].tkraise()
        self._current_page = page

        for name, btn in self._nav_btns.items():
            accent = self._nav_accents[name]
            if name == page:
                self._nav_rows[name].configure(fg_color=C_SOFT_BLUE)
                self._nav_icon_tiles[name].configure(fg_color=C_SOFT_BLUE)
                self._nav_icons[name].update_colors(C_ACCENT, C_SOFT_BLUE)
                btn.configure(
                    fg_color="transparent", hover_color=C_SOFT_BLUE, text_color=C_ACCENT,
                    font=FONT_BODY_B,
                )
                accent.configure(fg_color=C_ACCENT)
            else:
                self._nav_rows[name].configure(fg_color="transparent")
                self._nav_icon_tiles[name].configure(fg_color=C_ELEVATED)
                self._nav_icons[name].update_colors(C_MUTED, C_ELEVATED)
                btn.configure(
                    fg_color="transparent", hover_color=C_ELEVATED, text_color=C_MUTED,
                    font=FONT_BODY,
                )
                accent.configure(fg_color="transparent")

        # Only trigger the refresh for the page we just navigated to.
        if page == "dashboard":
            self._refresh_dashboard()
        elif page == "devices":
            self._refresh_devices()
        elif page == "post_to_devices":
            self._refresh_post_files_list()
            self._refresh_post_devices_list()
        elif page == "posts":
            # Cancel any in-progress chunked render before resetting guard
            old_chunk = getattr(self, "_posts_chunk_after_id", None)
            if old_chunk:
                try:
                    self.after_cancel(old_chunk)
                except Exception:
                    pass
                self._posts_chunk_after_id = None
            self._refresh_in_flight["posts"] = False
            self._posts_cache_key = ""
            self._show_posts_loading_state()
            self.after(0, self._refresh_post_posts_list)
        elif page == "shared_folders":
            self._refresh_shared_dirs_list()
        elif page == "settings":
            self._refresh_settings()
        elif page == "logs":
            self.after(0, self._refresh_logs)
        elif page == "history":
            # Cancel any in-progress chunked render before resetting guard
            old_hist_chunk = getattr(self, "_hist_chunk_after_id", None)
            if old_hist_chunk:
                try:
                    self.after_cancel(old_hist_chunk)
                except Exception:
                    pass
                self._hist_chunk_after_id = None
            self._refresh_in_flight["history"] = False
            self._hist_cache_key = ""
            self._show_history_loading_state()
            self.after(0, lambda: self._refresh_history(force=True))

    # ─── Auto-Refresh Loop ────────────────────────────────────────────────────

    def _refresh_settings(self):
        cfg = self._settings_view_config()
        for entry_widget, key, default in [
            (self._e_host, "HOST",        "0.0.0.0"),
            (self._e_port, "PORT",        "8000"),
            (self._e_root, "BACKUP_ROOT", ""),
            (self._e_key,  "API_KEY",     "YOUR_SECRET_KEY"),
            (self._e_desktop_name, "DESKTOP_NAME", ""),
        ]:
            entry_widget.delete(0, "end")
            entry_widget.insert(0, str(cfg.get(key, default) or ""))

        if cfg.get("REQUIRE_APPROVAL", True):
            self._sw_approval.select()
        else:
            self._sw_approval.deselect()

        if _normalize_theme_mode(cfg.get("THEME_MODE")) == "dark":
            self._sw_dark_mode.select()
        else:
            self._sw_dark_mode.deselect()

    def _auto_refresh(self):
        # Only the active page is refreshed; all other pages are skipped entirely.
        # shared_folders, settings, post_to_devices are user-driven and not polled.
        page = self._current_page
        if page == "dashboard":
            self._refresh_dashboard()
        elif page == "devices":
            self._refresh_devices()
        elif page == "posts":
            # Skip when user is typing (debounce pending) or a fetch is already running
            if not self._posts_search_after_id and not self._refresh_in_flight.get("posts"):
                self._refresh_post_posts_list(_preserve_scroll=True)
        elif page == "logs":
            self._refresh_logs()
        elif page == "history":
            if not self._refresh_in_flight.get("history"):
                self._refresh_history()
        self.after(3000, self._auto_refresh)

    # ─── Server Lifecycle Control ─────────────────────────────────────────────

    def _start_server(self):
        import importlib

        try:
            from rewind import terminate_active_rewind_ffmpeg
            terminate_active_rewind_ffmpeg()
        except Exception:
            pass

        try:
            if "video_preview" in sys.modules:
                sys.modules["video_preview"].stop_preview_scheduler()
        except Exception:
            pass

        for mod_name in (
            "config", "storage", "database", "ffmpeg_utils",
            "video_preview", "memories", "rewind", "upload", "server",
        ):
            if mod_name in sys.modules:
                importlib.reload(sys.modules[mod_name])

        from server import app as fastapi_app
        from config import HOST, PORT

        # Pre-flight port check
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s.bind((HOST, PORT))
            except socket.error:
                messagebox.showerror(
                    "Port Conflict",
                    f"Port {PORT} is already in use by another program.\n\n"
                    "Please choose a different port in Settings."
                )
                add_log(f"Error: Port {PORT} is occupied.")
                self._server_running = False
                self.after(0, lambda: self._set_status(False))
                self.after(0, self._configure_server_button)
                return

        ucfg = uvicorn.Config(
            fastapi_app, host=HOST, port=PORT,
            log_level="warning",
            log_config=None,
            timeout_keep_alive=15,
        )
        self._uvicorn_server = uvicorn.Server(ucfg)

        def _run():
            try:
                self._uvicorn_server.run()
            except Exception as e:
                add_log(f"Server error: {e}")

        self._server_thread = threading.Thread(target=_run, daemon=True)
        self._server_thread.start()
        self._server_running = True
        self._server_start_time = time.time()

        global _memories_daemon_started
        if not _memories_daemon_started:
            _memories_daemon_started = True
            threading.Thread(target=memories.startup_scan_loop, daemon=True).start()

        local_ips = get_all_local_ips()
        primary_ip = local_ips[0] if local_ips else "127.0.0.1"
        addr = f"http://{primary_ip}:{PORT}"
        self.after(0, lambda: self._set_status(True, addr))
        self.after(0, self._configure_server_button)

        if len(local_ips) > 1:
            alt_ips = ", ".join(local_ips[1:])
            add_log(f"Server started - {addr} (also reachable on: {alt_ips})")
        else:
            add_log(f"Server started - {addr}")

        self._start_udp_discovery_responder(PORT)

    def _start_udp_discovery_responder(self, port: int):
        self._stop_udp_discovery_responder()
        try:
            udp_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            udp_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            udp_sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            udp_sock.bind(("0.0.0.0", port))
            udp_sock.settimeout(2.0)
            self._udp_sock = udp_sock

            def _build_discovery_payload() -> bytes:
                cfg = load_config()
                return json.dumps({
                    "status": "ok",
                    "server_id": cfg.get("SERVER_ID", ""),
                    "name": cfg.get("DESKTOP_NAME") or socket.gethostname(),
                    "hostname": f"{socket.gethostname()}.local",
                    "version": "4.3.2",
                    "all_ips": get_all_local_ips(),
                    "port": port,
                }).encode("utf-8")

            def _udp_loop():
                last_heartbeat = 0.0
                while getattr(self, "_server_running", False) and getattr(self, "_udp_sock", None):
                    now = time.time()
                    # Periodic mesh network heartbeat (every 25s) to keep switch/bridge MAC tables fresh
                    if now - last_heartbeat >= 25.0:
                        last_heartbeat = now
                        try:
                            payload = _build_discovery_payload()
                            local_ips = get_all_local_ips()
                            targets = {"255.255.255.255", "224.0.0.1"}
                            for lip in local_ips:
                                parts = lip.split(".")
                                if len(parts) == 4 and not lip.startswith("127."):
                                    prefix = ".".join(parts[:3])
                                    targets.add(f"{prefix}.255")
                                    targets.add(f"{prefix}.1")
                            for tgt in targets:
                                try:
                                    udp_sock.sendto(payload, (tgt, port))
                                except Exception:
                                    pass
                        except Exception:
                            pass

                    try:
                        data, addr = udp_sock.recvfrom(2048)
                        if not data:
                            continue
                        msg = data.decode("utf-8", errors="ignore")
                        if "PING" in msg or "DISCOVER" in msg or "backup" in msg.lower():
                            resp = _build_discovery_payload()
                            udp_sock.sendto(resp, addr)
                    except socket.timeout:
                        continue
                    except (socket.error, OSError):
                        break
                    except Exception:
                        pass

            self._udp_thread = threading.Thread(target=_udp_loop, daemon=True)
            self._udp_thread.start()
        except Exception:
            pass

    def _stop_udp_discovery_responder(self):
        sock = getattr(self, "_udp_sock", None)
        if sock:
            try:
                sock.close()
            except Exception:
                pass
            self._udp_sock = None

    def _stop_server(self):
        self._stop_udp_discovery_responder()
        if self._uvicorn_server:
            self._uvicorn_server.should_exit = True
        try:
            from rewind import terminate_active_rewind_ffmpeg
            if terminate_active_rewind_ffmpeg():
                add_log("Terminated in-flight Rewind Reel encode.")
        except Exception:
            pass
        self._server_running = False
        self._server_start_time = None
        self.after(0, lambda: self._set_status(False))
        self.after(0, self._configure_server_button)
        add_log("Server stopped")

    def _restart_server(self):
        self._stop_server()
        self._wait_for_server_thread_exit(self._start_server)

    def _wait_for_server_thread_exit(self, on_stopped, deadline=None):
        if deadline is None:
            deadline = time.time() + 8.0
        thread = self._server_thread
        if thread is None or not thread.is_alive() or time.time() >= deadline:
            self.after(100, on_stopped)
            return
        self.after(150, lambda: self._wait_for_server_thread_exit(on_stopped, deadline))

    def _toggle_server(self):
        if self._server_running:
            self._stop_server()
        else:
            self._start_server()

    # ─── Connection Approval Modal ────────────────────────────────────────────

    def _poll_pending_connections(self):
        for req_id, conn in list(pending_connections.items()):
            if not conn.get("_shown", False):
                conn["_shown"] = True
                self.after(
                    0,
                    lambda r=req_id, n=conn["name"], ip=conn["ip"]:
                    self._show_approval_dialog(r, n, ip),
                )
        self.after(500, self._poll_pending_connections)

    def _show_approval_dialog(self, req_id: str, device_name: str, device_ip: str):
        dlg = ctk.CTkToplevel(self)
        dlg.title("New Device Connection Request")

        dlg_w, dlg_h = 480, 420
        self.update_idletasks()
        x = self.winfo_x() + (self.winfo_width() // 2) - (dlg_w // 2)
        y = self.winfo_y() + (self.winfo_height() // 2) - (dlg_h // 2)
        dlg.geometry(f"{dlg_w}x{dlg_h}+{x}+{y}")

        dlg.resizable(False, False)
        dlg.attributes("-topmost", True)
        dlg.grab_set()
        dlg.configure(fg_color=C_SURFACE)

        hdr = ctk.CTkFrame(dlg, fg_color=C_SURFACE, corner_radius=0)
        hdr.pack(fill="x")
        badge = ctk.CTkFrame(hdr, width=56, height=56, fg_color=C_SOFT_BLUE, corner_radius=16)
        badge.pack(pady=(22, 6))
        badge.pack_propagate(False)
        NavigationIcon(badge, "devices", C_ACCENT, C_SOFT_BLUE, size=24).pack(expand=True)

        ctk.CTkLabel(
            hdr, text="New Device Wants to Pair",
            font=ctk.CTkFont(family="Segoe UI Variable Display", size=17, weight="bold"),
            text_color=C_TEXT,
        ).pack(pady=(0, 14))

        ctk.CTkFrame(dlg, height=2, fg_color=C_ACCENT, corner_radius=0).pack(fill="x")

        info = ctk.CTkFrame(
            dlg, fg_color=C_ELEVATED, corner_radius=12,
            border_width=1, border_color=C_BORDER,
        )
        info.pack(fill="x", padx=26, pady=16)

        for label, val in [
            ("Device Name", device_name),
            ("IP Address",  device_ip),
            ("Time",        datetime.now().strftime("%H:%M:%S")),
        ]:
            row = ctk.CTkFrame(info, fg_color="transparent")
            row.pack(fill="x", padx=16, pady=5)
            ctk.CTkLabel(row, text=label, font=FONT_SMALL, text_color=C_MUTED, width=110, anchor="w").pack(side="left")
            ctk.CTkLabel(row, text=val, font=FONT_BODY_B, text_color=C_TEXT, anchor="w").pack(side="left")

        countdown_frame = ctk.CTkFrame(dlg, fg_color="transparent")
        countdown_frame.pack(fill="x", padx=26, pady=(0, 8))

        countdown_lbl = ctk.CTkLabel(
            countdown_frame, text="Auto-reject in 30s",
            font=FONT_SMALL, text_color=C_MUTED,
        )
        countdown_lbl.pack(side="right")

        progress = ctk.CTkProgressBar(
            countdown_frame, height=4, fg_color=C_ELEVATED,
            progress_color=C_WARNING, corner_radius=2,
        )
        progress.set(1.0)
        progress.pack(side="left", fill="x", expand=True, padx=(0, 12))

        resolved     = [False]
        countdown_val = [30]

        def tick():
            if resolved[0] or not dlg.winfo_exists():
                return
            countdown_val[0] -= 1
            if countdown_val[0] <= 0:
                _reject()
                return
            ratio = countdown_val[0] / 30
            color = C_WARNING if ratio > 0.4 else C_ERROR
            progress.configure(progress_color=color)
            progress.set(ratio)
            countdown_lbl.configure(text=f"Auto-reject in {countdown_val[0]}s")
            dlg.after(1000, tick)

        def _accept():
            if resolved[0]:
                return
            resolved[0] = True
            resolve_connection(req_id, True)
            add_log(f"Accepted connection: {device_name} ({device_ip})")
            self._refresh_devices()
            dlg.destroy()

        def _reject():
            if resolved[0]:
                return
            resolved[0] = True
            resolve_connection(req_id, False)
            add_log(f"Rejected connection: {device_name} ({device_ip})")
            if dlg.winfo_exists():
                dlg.destroy()

        btns = ctk.CTkFrame(dlg, fg_color="transparent")
        btns.pack(fill="x", padx=26, pady=(4, 20))

        ctk.CTkButton(
            btns, text="Reject",
            fg_color=C_SOFT_RED, hover_color=C_SOFT_RED_HOVER,
            text_color=C_ERROR, border_width=1, border_color=C_ERROR_BORDER,
            height=44, font=FONT_BODY_B,
            corner_radius=10, command=_reject,
        ).pack(side="left", expand=True, padx=(0, 6))

        ctk.CTkButton(
            btns, text="Accept Connection",
            fg_color=C_SUCCESS, hover_color=C_SUCCESS_HOVER,
            text_color="#FFFFFF",
            height=44, font=FONT_BODY_B,
            corner_radius=10, command=_accept,
        ).pack(side="right", expand=True, padx=(6, 0))

        dlg.after(1000, tick)
        self.bell()

    # ─── System Tray ──────────────────────────────────────────────────────────

    def _on_minimize(self, event=None):
        if event is not None and event.widget is not self:
            return
        if str(self.state()) != "iconic":
            return
        if not self._tray_enabled or pystray is None:
            return
        self.withdraw()
        self._ensure_tray_icon()

    def _ensure_tray_icon(self):
        if self._tray_icon is not None:
            return
        icon_path = _resolve_asset("icon.ico")
        try:
            image = _PILImage.open(icon_path) if os.path.exists(icon_path) else _PILImage.new("RGB", (64, 64), "blue")
        except Exception:
            image = _PILImage.new("RGB", (64, 64), "blue")

        menu = pystray.Menu(
            pystray.MenuItem("Open Phone Backup Server", self._tray_restore, default=True),
            pystray.MenuItem("Quit", self._tray_quit),
        )
        self._tray_icon = pystray.Icon("PhoneBackupServer", image, "Phone Backup Server", menu)
        self._tray_thread = threading.Thread(target=self._tray_icon.run, daemon=True)
        self._tray_thread.start()

    def _tray_restore(self, icon=None, item=None):
        self.after(0, self._restore_from_tray)

    def _restore_from_tray(self):
        if self._tray_icon is not None:
            self._tray_icon.stop()
            self._tray_icon = None
        self.deiconify()
        self.state("normal")
        self.lift()
        self.focus_force()

    def _tray_quit(self, icon=None, item=None):
        if self._tray_icon is not None:
            self._tray_icon.stop()
            self._tray_icon = None
        self.after(0, self._force_close)

    def _force_close(self):
        self.deiconify()
        self._on_close()

    # ─── Window Close ─────────────────────────────────────────────────────────

    def _on_close(self):
        if messagebox.askyesno("Quit", "Stop the backup server and quit?"):
            if self._tray_icon is not None:
                try:
                    self._tray_icon.stop()
                except Exception:
                    pass
                self._tray_icon = None
            try:
                self._dot.stop()
            except Exception:
                pass
            self._stop_server()

            def _background_cleanup():
                try:
                    from rewind import terminate_active_rewind_ffmpeg
                    terminate_active_rewind_ffmpeg()
                except Exception:
                    pass
                try:
                    from video_preview import clear_video_preview_cache
                    clear_video_preview_cache()
                except Exception:
                    pass
                try:
                    from rewind import clear_rewind_cache
                    clear_rewind_cache()
                except Exception:
                    pass
                try:
                    from thumbnail import clear_thumbnail_cache
                    clear_thumbnail_cache()
                except Exception:
                    pass

            threading.Thread(target=_background_cleanup, daemon=True).start()
            self.after(100, self.destroy)


# ── Entry Point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import multiprocessing
    multiprocessing.freeze_support()

    init_db()
    _cfg = load_config()
    if bool(_cfg.get("START_WITH_WINDOWS", False)) != is_autostart_enabled():
        set_autostart_enabled(bool(_cfg.get("START_WITH_WINDOWS", False)))
    app = BackupServerApp()
    app.mainloop()