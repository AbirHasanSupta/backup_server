"""
Phone Backup Server - Desktop Application.
Wraps the FastAPI server in a polished customtkinter control center.

Run with:  python desktop_app.py
"""

from __future__ import annotations

import io
import os
import socket
import sys
import threading
import time
import traceback
from datetime import datetime
from tkinter import filedialog, messagebox
import tkinter as tk

# ── Windowed-PyInstaller guard ─────────────────────────────────────────────────
# When built with --windowed there is no console, so sys.stdout / sys.stderr are
# None.  uvicorn's log formatter calls .isatty() on these streams before we can
# intercept it, causing a hard crash.  Redirect to a silent in-memory sink.
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

# ── Local imports ──────────────────────────────────────────────────────────────
from state import (
    add_log,
    clear_logs,
    get_current_activity,
    get_logs,
    pending_connections,
    resolve_connection,
)
from config import load_config, save_config
from database import get_devices, get_stats, get_sync_sessions, clear_sync_sessions, init_db, remove_device

# ── Theme ──────────────────────────────────────────────────────────────────────
ctk.set_default_color_theme("blue")

# ── Palette ────────────────────────────────────────────────────────────────────
C_BG        = "#F5F7FB"
C_SURFACE   = "#FFFFFF"
C_ELEVATED  = "#F9FBFD"
C_CARD      = "#FFFFFF"
C_BORDER    = "#DCE5EE"
C_ACCENT    = "#2563EB"
C_ACCENT2   = "#1D4ED8"
C_SUCCESS   = "#059669"
C_ERROR     = "#DC2626"
C_WARNING   = "#D97706"
C_INFO      = "#0891B2"
C_TEXT      = "#102033"
C_MUTED     = "#637487"
C_HIGHLIGHT = "#2563EB"
C_SOFT_BLUE = "#E8F0FF"
C_SOFT_GREEN = "#E4F8EF"
C_SOFT_RED = "#FDECEC"
C_SOFT_AMBER = "#FFF4DE"
C_SOFT_INFO = "#E2F6FA"
C_SOFT_BLUE_HOVER = "#DCEBFF"
C_SOFT_GREEN_HOVER = "#CEF1E0"
C_SOFT_RED_HOVER = "#F8D7D7"
C_SUCCESS_HOVER = "#047857"
C_SUCCESS_BORDER = "#A7E6C5"
C_ERROR_BORDER = "#F4B4B4"
C_WARNING_BORDER = "#F4D69D"
C_LOG_TS = "#3A5070"

_LIGHT_PALETTE = {
    "C_BG": "#F5F7FB",
    "C_SURFACE": "#FFFFFF",
    "C_ELEVATED": "#F9FBFD",
    "C_CARD": "#FFFFFF",
    "C_BORDER": "#DCE5EE",
    "C_ACCENT": "#2563EB",
    "C_ACCENT2": "#1D4ED8",
    "C_SUCCESS": "#059669",
    "C_ERROR": "#DC2626",
    "C_WARNING": "#D97706",
    "C_INFO": "#0891B2",
    "C_TEXT": "#102033",
    "C_MUTED": "#637487",
    "C_HIGHLIGHT": "#2563EB",
    "C_SOFT_BLUE": "#E8F0FF",
    "C_SOFT_GREEN": "#E4F8EF",
    "C_SOFT_RED": "#FDECEC",
    "C_SOFT_AMBER": "#FFF4DE",
    "C_SOFT_INFO": "#E2F6FA",
    "C_SOFT_BLUE_HOVER": "#DCEBFF",
    "C_SOFT_GREEN_HOVER": "#CEF1E0",
    "C_SOFT_RED_HOVER": "#F8D7D7",
    "C_SUCCESS_HOVER": "#047857",
    "C_SUCCESS_BORDER": "#A7E6C5",
    "C_ERROR_BORDER": "#F4B4B4",
    "C_WARNING_BORDER": "#F4D69D",
    "C_LOG_TS": "#3A5070",
}

_DARK_PALETTE = {
    "C_BG": "#0B1220",
    "C_SURFACE": "#121C2E",
    "C_ELEVATED": "#172338",
    "C_CARD": "#121C2E",
    "C_BORDER": "#2A3B55",
    "C_ACCENT": "#60A5FA",
    "C_ACCENT2": "#3B82F6",
    "C_SUCCESS": "#34D399",
    "C_ERROR": "#F87171",
    "C_WARNING": "#FBBF24",
    "C_INFO": "#22D3EE",
    "C_TEXT": "#F4F7FB",
    "C_MUTED": "#A9B7C8",
    "C_HIGHLIGHT": "#93C5FD",
    "C_SOFT_BLUE": "#1C355A",
    "C_SOFT_GREEN": "#123A2B",
    "C_SOFT_RED": "#451C25",
    "C_SOFT_AMBER": "#433213",
    "C_SOFT_INFO": "#123746",
    "C_SOFT_BLUE_HOVER": "#244672",
    "C_SOFT_GREEN_HOVER": "#164833",
    "C_SOFT_RED_HOVER": "#57212C",
    "C_SUCCESS_HOVER": "#10B981",
    "C_SUCCESS_BORDER": "#1D6B4B",
    "C_ERROR_BORDER": "#7F2A38",
    "C_WARNING_BORDER": "#725018",
    "C_LOG_TS": "#7890AE",
}

CURRENT_THEME = "light"


def _normalize_theme_mode(mode: str | None) -> str:
    return "dark" if str(mode).lower() == "dark" else "light"


def apply_theme(mode: str | None) -> str:
    global CURRENT_THEME
    CURRENT_THEME = _normalize_theme_mode(mode)
    globals().update(_DARK_PALETTE if CURRENT_THEME == "dark" else _LIGHT_PALETTE)
    ctk.set_appearance_mode(CURRENT_THEME)
    return CURRENT_THEME


apply_theme(load_config().get("THEME_MODE", "light"))

# Module-level font references (populated after root window exists)
FONT_TITLE:   ctk.CTkFont
FONT_SECTION: ctk.CTkFont
FONT_BODY:    ctk.CTkFont
FONT_SMALL:   ctk.CTkFont
FONT_MONO:    ctk.CTkFont
FONT_CAPTION: ctk.CTkFont


# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────

def get_local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def fmt_bytes(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} PB"


def fmt_ts(ts: int | None) -> str:
    if not ts:
        return "Never"
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d  %H:%M:%S")


def fmt_rel(ts: int | None) -> str:
    if not ts:
        return "Never"
    secs = int(time.time()) - ts
    if secs < 60:
        return "Just now"
    if secs < 3600:
        return f"{secs // 60}m ago"
    if secs < 86400:
        return f"{secs // 3600}h ago"
    return f"{secs // 86400}d ago"


def _resolve_asset(filename: str) -> str:
    """Return absolute path to an asset, works for both dev and PyInstaller bundle."""
    if getattr(sys, "frozen", False):
        base = sys._MEIPASS  # type: ignore[attr-defined]
    else:
        base = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, "assets", filename)


# ──────────────────────────────────────────────────────────────────────────────
# Custom Confirm Dialog
# ──────────────────────────────────────────────────────────────────────────────

def confirm_dialog(parent, title: str, message: str) -> bool:
    result: list[bool] = [False]
    dlg = ctk.CTkToplevel(parent)
    dlg.title(title)

    # Center on parent
    dlg_w, dlg_h = 400, 200
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
        dlg, text=message, font=FONT_BODY, wraplength=360,
        justify="center", text_color=C_TEXT,
    ).pack(expand=True, pady=(28, 12), padx=24)

    bf = ctk.CTkFrame(dlg, fg_color="transparent")
    bf.pack(fill="x", padx=24, pady=(0, 24))

    def _yes():
        result[0] = True
        dlg.destroy()

    def _no():
        dlg.destroy()

    ctk.CTkButton(
        bf, text="Cancel", fg_color=C_ELEVATED, hover_color=C_BORDER,
        text_color=C_TEXT, border_width=1, border_color=C_BORDER, width=130, height=38,
        font=FONT_BODY, command=_no,
    ).pack(side="left")
    ctk.CTkButton(
        bf, text="Confirm", fg_color=C_SOFT_RED, hover_color=C_SOFT_RED_HOVER,
        text_color=C_ERROR, border_width=1, border_color=C_ERROR_BORDER,
        width=130, height=38, font=FONT_BODY, command=_yes,
    ).pack(side="right")

    dlg.wait_window()
    return result[0]


# ──────────────────────────────────────────────────────────────────────────────
# Animated Breathing Dot
# ──────────────────────────────────────────────────────────────────────────────

class BreathingDot(ctk.CTkCanvas):
    """A small canvas that pulses between two colours to show server status."""

    _PERIOD = 1800  # ms for one full breath cycle

    def __init__(self, parent, size: int = 10, **kwargs):
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

    def _lerp_color(self, t: float) -> str:
        """Interpolate hex color between _color_off and _color_on."""
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


# ──────────────────────────────────────────────────────────────────────────────
# Main Application
# ──────────────────────────────────────────────────────────────────────────────

class BackupServerApp(ctk.CTk):

    PAGES      = ["dashboard", "devices", "settings", "logs", "history"]
    PAGE_ICONS = {
        "dashboard": "󰕇",   # fallback to text if font missing
        "devices":   "󰄛",
        "settings":  "󰒓",
        "logs":      "󰉩",
        "history":   "H",
    }
    PAGE_LABELS = {
        "dashboard": "Dashboard",
        "devices":   "Devices",
        "settings":  "Settings",
        "logs":      "Logs",
        "history":   "Sync History",
    }
    PAGE_EMOJI = {
        "dashboard": "D",
        "devices":   "P",
        "settings":  "S",
        "logs":      "L",
        "history":   "H",
    }

    def __init__(self):
        super().__init__()

        # Fonts
        global FONT_TITLE, FONT_SECTION, FONT_BODY, FONT_SMALL, FONT_MONO, FONT_CAPTION
        FONT_TITLE   = ctk.CTkFont(family="Segoe UI", size=26, weight="bold")
        FONT_SECTION = ctk.CTkFont(family="Segoe UI", size=11, weight="bold")
        FONT_BODY    = ctk.CTkFont(family="Segoe UI", size=13)
        FONT_SMALL   = ctk.CTkFont(family="Segoe UI", size=11)
        FONT_MONO    = ctk.CTkFont(family="Consolas",  size=12)
        FONT_CAPTION = ctk.CTkFont(family="Segoe UI", size=10)

        self.title("Phone Backup Server")
        self.geometry("1160x720")
        self.minsize(900, 600)
        self.configure(fg_color=C_BG)

        # Try to set window icon
        _ico = _resolve_asset("icon.ico")
        if os.path.exists(_ico):
            try:
                self.iconbitmap(_ico)
            except Exception:
                pass

        # Server state
        self._uvicorn_server: uvicorn.Server | None = None
        self._server_thread:  threading.Thread | None = None
        self._server_running  = False
        self._current_page:   str | None = None
        self._current_addr:   str = ""
        self._server_start_time: float | None = None
        self._device_card_widgets: dict[str, dict] = {}
        self._theme_rebuild_after_id: str | None = None

        # Build layout
        self._setup_grid()
        self._build_sidebar()
        self._build_statusbar()
        self._build_content_area()

        self._show_page("dashboard")

        # Polling loops
        self.after(500,  self._poll_pending_connections)
        self.after(2000, self._auto_refresh)
        self.after(1000, self._tick_uptime)

        # Auto-start server
        self._start_server()

        self.protocol("WM_DELETE_WINDOW", self._on_close)

    # ─── Grid ────────────────────────────────────────────────────────────────

    def _setup_grid(self):
        self.grid_columnconfigure(1, weight=1)
        self.grid_rowconfigure(0, weight=1)

    # ─── Sidebar ─────────────────────────────────────────────────────────────

    def _build_sidebar(self):
        sb = ctk.CTkFrame(self, width=236, corner_radius=0, fg_color=C_SURFACE)
        sb.grid(row=0, column=0, rowspan=2, sticky="nsew")
        sb.grid_propagate(False)
        sb.pack_propagate(False)

        # ── Logo / header bar ────────────────────────────────────────────────
        header = ctk.CTkFrame(sb, height=138, fg_color=C_SURFACE, corner_radius=0)
        header.pack(fill="x")
        header.pack_propagate(False)

        logo = ctk.CTkFrame(header, width=54, height=54, fg_color=C_SOFT_BLUE, corner_radius=16)
        logo.pack(pady=(22, 8))
        logo.pack_propagate(False)
        ctk.CTkLabel(
            logo, text="PB", font=ctk.CTkFont(family="Segoe UI", size=17, weight="bold"),
            text_color=C_ACCENT,
        ).pack(expand=True)

        ctk.CTkLabel(
            header, text="Phone Backup",
            font=ctk.CTkFont(family="Segoe UI", size=16, weight="bold"),
            text_color=C_TEXT,
        ).pack()
        ctk.CTkLabel(
            header, text="SERVER CONSOLE",
            font=ctk.CTkFont(family="Segoe UI", size=9, weight="bold"),
            text_color=C_ACCENT,
        ).pack(pady=(2, 0))

        ctk.CTkFrame(sb, height=1, fg_color=C_BORDER, corner_radius=0).pack(fill="x")

        # ── Nav items ────────────────────────────────────────────────────────
        nav_container = ctk.CTkFrame(sb, fg_color="transparent")
        nav_container.pack(fill="x", padx=10, pady=(14, 0))

        self._nav_btns:   dict[str, ctk.CTkButton] = {}
        self._nav_accents: dict[str, ctk.CTkFrame]  = {}

        for page in self.PAGES:
            emoji = self.PAGE_EMOJI[page]
            label = self.PAGE_LABELS[page]

            row = ctk.CTkFrame(nav_container, fg_color="transparent", height=46)
            row.pack(fill="x", pady=3)
            row.pack_propagate(False)

            # Left accent strip (hidden by default)
            accent = ctk.CTkFrame(row, width=3, fg_color=C_ACCENT, corner_radius=2)
            accent.pack(side="left", fill="y", padx=(0, 6))
            accent.pack_propagate(False)
            self._nav_accents[page] = accent

            btn = ctk.CTkButton(
                row,
                text=f" {emoji}   {label}",
                anchor="w",
                corner_radius=12,
                height=42,
                fg_color="transparent",
                hover_color=C_ELEVATED,
                text_color=C_MUTED,
                font=ctk.CTkFont(family="Segoe UI", size=13),
                command=lambda p=page: self._show_page(p),
            )
            btn.pack(side="left", fill="both", expand=True)
            self._nav_btns[page] = btn

        # ── Bottom controls ──────────────────────────────────────────────────
        ctk.CTkFrame(sb, height=1, fg_color=C_BORDER).pack(
            fill="x", padx=14, pady=14, side="bottom"
        )
        self._toggle_btn = ctk.CTkButton(
            sb,
            text="Stop Server",
            fg_color=C_SOFT_RED,
            hover_color=C_SOFT_RED_HOVER,
            text_color=C_ERROR,
            border_width=1,
            border_color=C_ERROR_BORDER,
            height=44,
            corner_radius=14,
            font=ctk.CTkFont(family="Segoe UI", size=13, weight="bold"),
            command=self._toggle_server,
        )
        self._toggle_btn.pack(fill="x", padx=14, pady=(0, 18), side="bottom")
        self._configure_server_button()

    # ─── Status bar ──────────────────────────────────────────────────────────

    def _build_statusbar(self):
        bar = ctk.CTkFrame(self, height=44, corner_radius=0, fg_color=C_SURFACE)
        bar.grid(row=1, column=1, sticky="ew")
        bar.grid_propagate(False)

        left = ctk.CTkFrame(bar, fg_color="transparent")
        left.pack(side="left", fill="y", padx=(16, 0))

        # Animated dot
        self._dot = BreathingDot(left, size=10)
        self._dot.pack(side="left", padx=(0, 8), pady=15)

        self._status_lbl = ctk.CTkLabel(
            left, text="Starting",
            font=ctk.CTkFont(family="Segoe UI", size=12, weight="bold"),
            text_color=C_TEXT,
        )
        self._status_lbl.pack(side="left")

        self._activity_lbl = ctk.CTkLabel(
            left, text="", font=FONT_SMALL, text_color=C_HIGHLIGHT,
        )
        self._activity_lbl.pack(side="left", padx=(12, 0))

        right = ctk.CTkFrame(bar, fg_color="transparent")
        right.pack(side="right", fill="y", padx=16)

        self._uptime_lbl = ctk.CTkLabel(
            right, text="", font=FONT_MONO, text_color=C_MUTED,
        )
        self._uptime_lbl.pack(side="right", padx=(8, 0))

        self._addr_lbl = ctk.CTkLabel(
            right, text="", font=FONT_MONO, text_color=C_HIGHLIGHT,
        )
        self._addr_lbl.pack(side="right")

        # Separator
        ctk.CTkFrame(bar, width=1, fg_color=C_BORDER).pack(side="right", fill="y", pady=8)

    def _set_status(self, running: bool, addr: str = ""):
        self._current_addr = addr if running else ""
        self._dot.set_running(running)
        if running:
            self._status_lbl.configure(text="Server Running", text_color=C_SUCCESS)
            self._addr_lbl.configure(text=addr)
        else:
            self._status_lbl.configure(text="Server Stopped", text_color=C_ERROR)
            self._addr_lbl.configure(text="")
            self._uptime_lbl.configure(text="")
            self._activity_lbl.configure(text="")

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

    def _rebuild_shell(self):
        page = self._current_page or "dashboard"
        for widget in self.grid_slaves():
            widget.destroy()
        self._device_card_widgets = {}
        self._last_dash_logs = []
        self._last_logs_cache = []
        self._last_logs_query = ""
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
            if activity:
                self._activity_lbl.configure(text=activity["message"][:90])
            else:
                self._activity_lbl.configure(text="")
            self._uptime_lbl.configure(text=f"Uptime {h:02d}:{m:02d}:{s:02d}")
        self.after(1000, self._tick_uptime)

    # ─── Content area ─────────────────────────────────────────────────────────

    def _build_content_area(self):
        container = ctk.CTkFrame(self, corner_radius=0, fg_color=C_BG)
        container.grid(row=0, column=1, sticky="nsew")
        container.grid_columnconfigure(0, weight=1)
        container.grid_rowconfigure(0, weight=1)
        self._frames_container = container

        self._pages: dict[str, ctk.CTkFrame] = {
            "dashboard": self._build_dashboard(container),
            "devices":   self._build_devices(container),
            "settings":  self._build_settings(container),
            "logs":      self._build_logs(container),
            "history":   self._build_history(container),
        }
        for f in self._pages.values():
            f.grid(row=0, column=0, sticky="nsew")

    # ─── Shared UI helpers ────────────────────────────────────────────────────

    def _page_header(self, parent, title: str, subtitle: str = "") -> ctk.CTkFrame:
        hdr = ctk.CTkFrame(parent, fg_color="transparent")
        hdr.pack(fill="x", padx=32, pady=(30, 0))
        ctk.CTkLabel(
            hdr, text=title, font=FONT_TITLE, text_color=C_TEXT, anchor="w",
        ).pack(side="left", fill="y")
        if subtitle:
            ctk.CTkLabel(
                hdr, text=subtitle, font=FONT_SMALL, text_color=C_MUTED,
            ).pack(side="left", padx=(14, 0), pady=(8, 0))
        return hdr

    def _divider(self, parent):
        ctk.CTkFrame(parent, height=1, fg_color=C_BORDER).pack(
            fill="x", padx=32, pady=(16, 0)
        )

    def _section_label(self, parent, text: str):
        ctk.CTkLabel(
            parent, text=text.upper(),
            font=FONT_SECTION, text_color=C_MUTED,
        ).pack(anchor="w", padx=32, pady=(20, 7))

    # ─── Page: Dashboard ─────────────────────────────────────────────────────

    def _build_dashboard(self, parent) -> ctk.CTkFrame:
        frame = ctk.CTkFrame(parent, fg_color=C_BG)

        self._page_header(frame, "Dashboard", "Live overview")
        self._divider(frame)

        # ── Stat cards ────────────────────────────────────────────────────
        cards_row = ctk.CTkFrame(frame, fg_color="transparent")
        cards_row.pack(fill="x", padx=25, pady=(20, 0))

        card_defs = [
            ("F", "Total Files",   C_ACCENT,   "_s_files",   self._open_backup_root),
            ("P", "Devices",       C_INFO,     "_s_devices", lambda: self._show_page("devices")),
            ("S", "Total Size",    C_WARNING,  "_s_size",    None),
            ("T", "Last Backup",   C_SUCCESS,  "_s_last",    None),
        ]
        for icon, label, color, attr, command in card_defs:
            lbl = self._stat_card(cards_row, icon, label, "-", color, command)
            setattr(self, attr, lbl)

        # ── Recent activity ───────────────────────────────────────────────
        self._section_label(frame, "Recent Activity")

        log_frame = ctk.CTkFrame(
            frame, fg_color=C_SURFACE,
            corner_radius=18, border_width=1, border_color=C_BORDER,
        )
        log_frame.pack(fill="both", expand=True, padx=32, pady=(8, 26))

        self._dash_log = ctk.CTkTextbox(
            log_frame, state="disabled", fg_color="transparent",
            border_width=0, font=FONT_MONO, text_color=C_TEXT,
            wrap="word",
        )
        self._dash_log.pack(fill="both", expand=True, padx=4, pady=4)
        self._setup_log_tags(self._dash_log)

        return frame

    def _stat_card(self, parent, icon: str, label: str, value: str, accent: str, command=None) -> ctk.CTkLabel:
        inner = ctk.CTkFrame(
            parent,
            fg_color=C_CARD,
            corner_radius=18,
            border_width=1,
            border_color=C_BORDER,
        )
        inner.pack(side="left", fill="both", expand=True, padx=7, pady=4)

        # Icon badge uses soft tints so the cards match the Android app.
        _BADGE_TINTS = {
            C_ACCENT:  C_SOFT_BLUE,
            C_ACCENT2: C_SOFT_BLUE,
            C_INFO:    C_SOFT_INFO,
            C_WARNING: C_SOFT_AMBER,
            C_SUCCESS: C_SOFT_GREEN,
        }
        badge = ctk.CTkFrame(
            inner,
            width=44, height=44,
            fg_color=_BADGE_TINTS.get(accent, C_ELEVATED),
            corner_radius=14,
        )
        badge.pack(pady=(18, 2))
        badge.pack_propagate(False)
        ctk.CTkLabel(badge, text=icon, font=ctk.CTkFont(size=20)).pack(expand=True)

        val_lbl = ctk.CTkLabel(
            inner, text=value,
            font=ctk.CTkFont(family="Segoe UI", size=24, weight="bold"),
            text_color=accent,
        )
        val_lbl.pack(pady=(2, 0))
        ctk.CTkLabel(
            inner, text=label, font=FONT_SMALL, text_color=C_MUTED,
        ).pack(pady=(0, 18))

        # Hover effect
        def _enter(e):
            inner.configure(fg_color=C_ELEVATED, border_color=accent)
        def _leave(e):
            inner.configure(fg_color=C_CARD, border_color=C_BORDER)
        
        inner.bind("<Enter>", _enter)
        inner.bind("<Leave>", _leave)
        # Bind to children too so hover doesn't flicker
        for child in inner.winfo_children():
            child.bind("<Enter>", _enter)
            child.bind("<Leave>", _leave)
        if command:
            self._bind_click_tree(inner, command)

        return val_lbl

    def _bind_click_tree(self, widget, command):
        try:
            widget.configure(cursor="hand2")
        except Exception:
            pass
        widget.bind("<Button-1>", lambda _event: command(), add="+")
        for child in widget.winfo_children():
            self._bind_click_tree(child, command)

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
        """Configure colour tags on a CTkTextbox's internal tk.Text widget."""
        txt: tk.Text = box._textbox
        txt.tag_config("success", foreground=C_SUCCESS)
        txt.tag_config("error",   foreground=C_ERROR)
        txt.tag_config("warning", foreground=C_WARNING)
        txt.tag_config("info",    foreground=C_INFO)
        txt.tag_config("muted",   foreground=C_MUTED)
        txt.tag_config("ts",      foreground=C_LOG_TS)

    def _insert_log_line(self, box: ctk.CTkTextbox, entry: dict):
        """Insert one log entry with coloured tags into box."""
        box.configure(state="normal")
        ts = datetime.fromtimestamp(entry["time"]).strftime("%H:%M:%S")
        msg: str = entry["message"]

        txt: tk.Text = box._textbox
        txt.insert("end", f"[{ts}]  ", ("ts",))

        lower_msg = msg.lower()
        if any(word in lower_msg for word in ("accepted", "started", "saved")):
            tag = "success"
        elif any(word in lower_msg for word in ("error", "rejected", "removed", "occupied")):
            tag = "error"
        elif "warning" in lower_msg:
            tag = "warning"
        elif any(word in lower_msg for word in ("server", "device", "backup", "file")):
            tag = "info"
        else:
            tag = "muted"

        txt.insert("end", msg + "\n", (tag,))
        box.configure(state="disabled")

    def _refresh_dashboard(self):
        try:
            stats   = get_stats()
            devices = get_devices()

            self._s_files.configure(text=f"{stats['total_files']:,}")
            self._s_devices.configure(text=str(len(devices)))
            self._s_size.configure(text=fmt_bytes(stats["total_size_bytes"] or 0))
            self._s_last.configure(text=fmt_rel(stats.get("last_backup_time")))

            logs = get_logs()[-20:]
            # Simple differential update for logs to reduce flicker
            if not hasattr(self, "_last_dash_logs"):
                self._last_dash_logs = []

            if logs != self._last_dash_logs:
                self._dash_log.configure(state="normal")
                self._dash_log.delete("1.0", "end")
                self._dash_log.configure(state="disabled")
                for entry in reversed(logs):
                    self._insert_log_line(self._dash_log, entry)
                self._last_dash_logs = logs.copy()
        except Exception:
            pass

    # ─── Page: Devices ────────────────────────────────────────────────────────

    def _build_devices(self, parent) -> ctk.CTkFrame:
        frame = ctk.CTkFrame(parent, fg_color=C_BG)

        hdr = self._page_header(frame, "Connected Devices")
        ctk.CTkButton(
            hdr, text="Refresh", width=110, height=36,
            fg_color=C_SOFT_BLUE, hover_color=C_SOFT_BLUE_HOVER,
            text_color=C_ACCENT,
            border_width=1, border_color=C_BORDER,
            corner_radius=12,
            command=self._refresh_devices,
        ).pack(side="right")

        self._divider(frame)

        self._devices_scroll = ctk.CTkScrollableFrame(
            frame, fg_color="transparent", label_text="",
        )
        self._devices_scroll.pack(fill="both", expand=True, padx=22, pady=(10, 16))

        return frame

    def _refresh_devices(self):
        devices = get_devices()

        # Clear empty state if it was showing
        if hasattr(self, "_devices_empty_widget") and self._devices_empty_widget:
            if devices:
                self._devices_empty_widget.destroy()
                self._devices_empty_widget = None

        if not devices:
            if hasattr(self, "_devices_empty_widget") and self._devices_empty_widget:
                return
            for w in self._devices_scroll.winfo_children():
                w.destroy()
            self._device_card_widgets.clear()

            self._devices_empty_widget = ctk.CTkFrame(
                self._devices_scroll, fg_color=C_SURFACE,
                corner_radius=22, border_width=1, border_color=C_BORDER,
            )
            self._devices_empty_widget.pack(fill="x", padx=8, pady=30)
            ctk.CTkLabel(
                self._devices_empty_widget, text="PB",
                font=ctk.CTkFont(family="Segoe UI", size=30, weight="bold"),
                text_color=C_ACCENT,
            ).pack(pady=(36, 4))
            ctk.CTkLabel(
                self._devices_empty_widget, text="No devices connected yet",
                font=ctk.CTkFont(family="Segoe UI", size=16, weight="bold"),
                text_color=C_TEXT,
            ).pack()
            ctk.CTkLabel(
                self._devices_empty_widget,
                text=(
                    "Open Phone Backup on your Android device,\n"
                    "go to Settings > Server, and tap Discover\n"
                    "or enter this machine's IP address."
                ),
                font=FONT_BODY, text_color=C_MUTED, justify="center",
            ).pack(pady=(8, 36))
            return

        current_ids = {str(dev["id"]) for dev in devices}

        # Remove dead widgets
        for did in list(self._device_card_widgets.keys()):
            if did not in current_ids:
                self._device_card_widgets[did]["outer"].destroy()
                del self._device_card_widgets[did]

        # Update or create
        for dev in devices:
            did = str(dev["id"])
            if did in self._device_card_widgets:
                self._update_device_card(did, dev)
            else:
                self._device_card_widgets[did] = self._device_card(self._devices_scroll, dev)

    def _update_device_card(self, did: str, dev: dict):
        widgets = self._device_card_widgets[did]
        # Update last seen pill
        last_seen_text = fmt_rel(dev["last_seen"])
        pill_color = C_SUCCESS if dev.get("last_seen") and (int(time.time()) - dev["last_seen"]) < 300 else C_MUTED
        _PILL_TINTS = {C_SUCCESS: C_SOFT_GREEN, C_MUTED: C_ELEVATED}

        widgets["pill"].configure(fg_color=_PILL_TINTS.get(pill_color, C_ELEVATED))
        widgets["pill_lbl"].configure(text=f"  {last_seen_text}  ", text_color=pill_color)

        # Update chips
        widgets["chip_ip"].configure(text=f"  IP {dev['device_ip']}  ")
        widgets["chip_files"].configure(text=f"  {dev['files_backed_up']:,} files  ")

    def _device_card(self, parent, dev: dict) -> dict:
        card = ctk.CTkFrame(
            parent,
            fg_color=C_SURFACE,
            corner_radius=18,
            border_width=1,
            border_color=C_BORDER,
        )
        card.pack(fill="x", padx=8, pady=6)
        card.grid_columnconfigure(1, weight=1)

        # ── Phone icon with badge ──────────────────────────────────────────
        icon_wrap = ctk.CTkFrame(
            card, width=56, height=56, fg_color=C_SOFT_BLUE,
            corner_radius=14,
        )
        icon_wrap.grid(row=0, column=0, rowspan=2, padx=(18, 12), pady=18)
        icon_wrap.grid_propagate(False)
        ctk.CTkLabel(
            icon_wrap, text="P", font=ctk.CTkFont(family="Segoe UI", size=22, weight="bold"),
            text_color=C_ACCENT,
        ).pack(expand=True)

        # ── Name ──────────────────────────────────────────────────────────
        name_row = ctk.CTkFrame(card, fg_color="transparent")
        name_row.grid(row=0, column=1, sticky="sw", padx=4, pady=(18, 2))

        ctk.CTkLabel(
            name_row, text=dev["device_name"],
            font=ctk.CTkFont(family="Segoe UI", size=15, weight="bold"),
            text_color=C_TEXT,
        ).pack(side="left")

        # Last-seen pill badge
        last_seen_text = fmt_rel(dev["last_seen"])
        pill_color = C_SUCCESS if dev.get("last_seen") and (int(time.time()) - dev["last_seen"]) < 300 else C_MUTED
        _PILL_TINTS = {C_SUCCESS: C_SOFT_GREEN, C_MUTED: C_ELEVATED}
        pill = ctk.CTkFrame(name_row, fg_color=_PILL_TINTS.get(pill_color, C_ELEVATED), corner_radius=8)
        pill.pack(side="left", padx=(10, 0))
        pill_lbl = ctk.CTkLabel(
            pill, text=f"  {last_seen_text}  ",
            font=FONT_CAPTION, text_color=pill_color,
        )
        pill_lbl.pack()

        # ── Details row ───────────────────────────────────────────────────
        details_row = ctk.CTkFrame(card, fg_color="transparent")
        details_row.grid(row=1, column=1, sticky="nw", padx=4, pady=(0, 18))

        _CHIP_TINTS = {
            C_INFO:   C_SOFT_INFO,
            C_ACCENT: C_SOFT_BLUE,
            C_MUTED:  C_ELEVATED,
        }

        # IP Chip
        chip_ip_f = ctk.CTkFrame(details_row, fg_color=_CHIP_TINTS[C_INFO], corner_radius=8)
        chip_ip_f.pack(side="left", padx=(0, 8))
        chip_ip = ctk.CTkLabel(chip_ip_f, text=f"  IP {dev['device_ip']}  ", font=FONT_CAPTION, text_color=C_INFO)
        chip_ip.pack()

        # Files Chip
        chip_files_f = ctk.CTkFrame(details_row, fg_color=_CHIP_TINTS[C_ACCENT], corner_radius=8)
        chip_files_f.pack(side="left", padx=(0, 8))
        chip_files = ctk.CTkLabel(chip_files_f, text=f"  {dev['files_backed_up']:,} files  ", font=FONT_CAPTION, text_color=C_ACCENT)
        chip_files.pack()

        def open_folder(event=None):
            import re
            from config import load_config
            root = os.path.abspath(load_config()["BACKUP_ROOT"])
            # Prefer the stable, human-readable folder_name set at registration.
            # Fall back to a sanitized device_id for legacy devices that predate
            # the folder_name column.
            folder_name = dev.get("folder_name")
            device_id   = dev.get("device_id")
            if folder_name:
                device_folder = os.path.join(root, folder_name)
            elif device_id:
                safe_device_id = re.sub(r'[<>:"|?*]', "_", device_id).strip()
                device_folder = os.path.join(root, safe_device_id)
            else:
                device_folder = root

            try:
                os.makedirs(device_folder, exist_ok=True)
                os.startfile(device_folder)
            except Exception:
                if os.path.exists(root):
                    os.startfile(root)

        chip_files_f.bind("<Button-1>", open_folder)
        chip_files.bind("<Button-1>", open_folder)
        chip_files_f.configure(cursor="hand2")
        chip_files.configure(cursor="hand2")


        # Date Chip
        chip_date_f = ctk.CTkFrame(details_row, fg_color=_CHIP_TINTS[C_MUTED], corner_radius=8)
        chip_date_f.pack(side="left", padx=(0, 8))
        ctk.CTkLabel(chip_date_f, text=f"  since {fmt_ts(dev['first_seen'])[:10]}  ", font=FONT_CAPTION, text_color=C_MUTED).pack()

        # ── Remove button ─────────────────────────────────────────────────
        dev_id   = dev["id"]
        dev_name = dev["device_name"]

        def do_remove(did=dev_id, dname=dev_name):
            if confirm_dialog(
                self,
                "Remove Device",
                f"Remove '{dname}' from the device list?\n\n"
                "Backups from this device will be rejected until it connects again.",
            ):
                remove_device(did)
                add_log(f"Removed device: {dname}")
                self._refresh_devices()

        ctk.CTkButton(
            card, text="Remove", width=90, height=34,
            fg_color=C_SOFT_RED, hover_color=C_SOFT_RED_HOVER,
            text_color=C_ERROR, border_width=1, border_color=C_ERROR_BORDER,
            font=FONT_SMALL, corner_radius=8,
            command=do_remove,
        ).grid(row=0, column=2, rowspan=2, padx=16)

        return {
            "outer": card,
            "pill": pill,
            "pill_lbl": pill_lbl,
            "chip_ip": chip_ip,
            "chip_files": chip_files
        }

    # ─── Page: Settings ───────────────────────────────────────────────────────

    def _build_settings(self, parent) -> ctk.CTkFrame:
        frame = ctk.CTkFrame(parent, fg_color=C_BG)

        self._page_header(frame, "Settings", "Server configuration")
        self._divider(frame)

        scroll = ctk.CTkScrollableFrame(frame, fg_color="transparent", label_text="")
        scroll.pack(fill="both", expand=True, padx=22, pady=(6, 16))

        cfg = load_config()

        def settings_card(title: str) -> ctk.CTkFrame:
            ctk.CTkLabel(
                scroll, text=title.upper(),
                font=FONT_SECTION, text_color=C_MUTED,
            ).pack(anchor="w", padx=8, pady=(20, 6))
            card = ctk.CTkFrame(
                scroll, fg_color=C_SURFACE,
                corner_radius=18, border_width=1, border_color=C_BORDER,
            )
            card.pack(fill="x", padx=8, pady=(0, 4))
            return card

        def labeled_entry(card, label: str, default: str = "", placeholder: str = "") -> ctk.CTkEntry:
            row = ctk.CTkFrame(card, fg_color="transparent")
            row.pack(fill="x", padx=18, pady=(14, 0))
            ctk.CTkLabel(row, text=label, font=FONT_BODY, text_color=C_TEXT).pack(anchor="w")
            e = ctk.CTkEntry(
                card, height=44, fg_color=C_ELEVATED,
                border_color=C_BORDER, border_width=1,
                text_color=C_TEXT, corner_radius=12,
                placeholder_text=placeholder,
            )
            e.insert(0, default)
            e.pack(fill="x", padx=18, pady=(6, 14))
            return e

        # ── SERVER ────────────────────────────────────────────────────────
        app_card = settings_card("Appearance")
        theme_row = ctk.CTkFrame(app_card, fg_color="transparent")
        theme_row.pack(fill="x", padx=18, pady=18)

        self._sw_dark_mode = ctk.CTkSwitch(
            theme_row, text="", width=52, height=26,
            button_color=C_ACCENT, progress_color=C_ACCENT,
            command=lambda: self.after(0, self._apply_theme_from_settings),
        )
        self._sw_dark_mode.pack(side="left")
        if _normalize_theme_mode(cfg.get("THEME_MODE")) == "dark":
            self._sw_dark_mode.select()

        theme_copy = ctk.CTkFrame(theme_row, fg_color="transparent")
        theme_copy.pack(side="left", fill="x", expand=True, padx=12)
        ctk.CTkLabel(
            theme_copy, text="Dark mode",
            font=FONT_BODY, text_color=C_TEXT,
        ).pack(anchor="w")
        ctk.CTkLabel(
            theme_copy,
            text="Changes the desktop console appearance immediately.",
            font=FONT_SMALL, text_color=C_MUTED,
        ).pack(anchor="w", pady=(2, 0))

        srv_card = settings_card("Server")
        self._e_host = labeled_entry(srv_card, "Listen IP  (0.0.0.0 = all interfaces)",
                                     cfg.get("HOST", "0.0.0.0"), "0.0.0.0")
        self._e_port = labeled_entry(srv_card, "Port",
                                     str(cfg.get("PORT", 8000)), "8000")

        # ── STORAGE ───────────────────────────────────────────────────────
        stor_card = settings_card("Storage")
        self._e_root = labeled_entry(stor_card, "Backup Root Folder",
                                     cfg.get("BACKUP_ROOT", ""), "e.g. D:\\PhoneBackup")

        browse_row = ctk.CTkFrame(stor_card, fg_color="transparent")
        browse_row.pack(fill="x", padx=18, pady=(0, 14))
        ctk.CTkButton(
            browse_row, text="Browse", width=140, height=38,
            fg_color=C_SOFT_BLUE, hover_color=C_SOFT_BLUE_HOVER,
            text_color=C_ACCENT,
            border_width=1, border_color=C_BORDER,
            corner_radius=12, font=FONT_BODY,
            command=self._browse_root,
        ).pack(side="left")

        # ── SECURITY ──────────────────────────────────────────────────────
        sec_card = settings_card("Security")
        self._e_key = labeled_entry(sec_card, "API Key  (must match Android app)",
                                    cfg.get("API_KEY", ""), "Enter secret key")

        sw_row = ctk.CTkFrame(sec_card, fg_color="transparent")
        sw_row.pack(fill="x", padx=18, pady=(6, 18))

        self._sw_approval = ctk.CTkSwitch(
            sw_row, text="", width=52, height=26,
            button_color=C_ACCENT, progress_color=C_ACCENT,
        )
        self._sw_approval.pack(side="left")
        if cfg.get("REQUIRE_APPROVAL", True):
            self._sw_approval.select()

        ctk.CTkLabel(
            sw_row,
            text="Require approval for new device connections",
            font=FONT_BODY, text_color=C_TEXT,
        ).pack(side="left", padx=12)

        # ── Save button ───────────────────────────────────────────────────
        ctk.CTkButton(
            scroll, text="Save and Restart Server", height=50,
            font=ctk.CTkFont(family="Segoe UI", size=14, weight="bold"),
            fg_color=C_ACCENT, hover_color=C_ACCENT2,
            corner_radius=14,
            command=self._save_settings,
        ).pack(fill="x", padx=8, pady=(24, 4))

        ctk.CTkLabel(
            scroll,
            text="Server will restart automatically to apply changes.",
            font=FONT_SMALL, text_color=C_MUTED,
        ).pack(anchor="w", padx=8, pady=(4, 24))

        return frame

    def _browse_root(self):
        folder = filedialog.askdirectory(title="Select Backup Root Folder")
        if folder:
            self._e_root.delete(0, "end")
            self._e_root.insert(0, folder)

    def _save_settings(self):
        try:
            port = int(self._e_port.get().strip() or "8000")
        except ValueError:
            messagebox.showerror("Invalid Port", "Port must be a number.")
            return

        cfg = {
            "HOST":             self._e_host.get().strip() or "0.0.0.0",
            "PORT":             port,
            "BACKUP_ROOT":      self._e_root.get().strip(),
            "API_KEY":          self._e_key.get().strip() or "YOUR_SECRET_KEY",
            "REQUIRE_APPROVAL": bool(self._sw_approval.get()),
            "THEME_MODE":       "dark" if bool(self._sw_dark_mode.get()) else "light",
        }
        save_config(cfg)
        add_log("Settings saved - restarting server")
        self._restart_server()

    def _apply_theme_from_settings(self):
        mode = "dark" if bool(self._sw_dark_mode.get()) else "light"
        cfg = load_config()
        cfg["THEME_MODE"] = mode
        save_config(cfg)
        apply_theme(mode)
        add_log(f"Theme changed to {mode}")
        if self._theme_rebuild_after_id:
            try:
                self.after_cancel(self._theme_rebuild_after_id)
            except Exception:
                pass
        self._theme_rebuild_after_id = self.after(150, self._finish_theme_rebuild)

    def _finish_theme_rebuild(self):
        self._theme_rebuild_after_id = None
        self._rebuild_shell()

    # ─── Page: Logs ───────────────────────────────────────────────────────────

    def _build_logs(self, parent) -> ctk.CTkFrame:
        frame = ctk.CTkFrame(parent, fg_color=C_BG)

        hdr = self._page_header(frame, "Activity Logs")

        # Right-side controls
        ctrl = ctk.CTkFrame(hdr, fg_color="transparent")
        ctrl.pack(side="right")

        # Filter entry
        self._log_filter = ctk.CTkEntry(
            ctrl, width=190, height=36, placeholder_text="Filter logs",
            fg_color=C_ELEVATED, border_color=C_BORDER, border_width=1,
            text_color=C_TEXT, corner_radius=12,
        )
        self._log_filter.pack(side="left", padx=(0, 8))
        self._log_filter.bind("<KeyRelease>", lambda e: self._refresh_logs())

        ctk.CTkButton(
            ctrl, text="Refresh", width=100, height=36,
            fg_color=C_SOFT_BLUE, hover_color=C_SOFT_BLUE_HOVER,
            text_color=C_ACCENT,
            border_width=1, border_color=C_BORDER,
            corner_radius=12,
            command=self._refresh_logs,
        ).pack(side="left", padx=(0, 6))

        ctk.CTkButton(
            ctrl, text="Clear", width=90, height=36,
            fg_color=C_SOFT_RED, hover_color=C_SOFT_RED_HOVER,
            text_color=C_ERROR,
            border_width=1, border_color=C_ERROR_BORDER,
            corner_radius=12,
            command=self._clear_logs,
        ).pack(side="left")

        self._divider(frame)

        log_wrap = ctk.CTkFrame(
            frame, fg_color=C_SURFACE,
            corner_radius=18, border_width=1, border_color=C_BORDER,
        )
        log_wrap.pack(fill="both", expand=True, padx=32, pady=(12, 26))

        self._log_box = ctk.CTkTextbox(
            log_wrap, state="disabled", fg_color="transparent",
            border_width=0, font=FONT_MONO, text_color=C_TEXT, wrap="word",
        )
        self._log_box.pack(fill="both", expand=True, padx=4, pady=4)
        self._setup_log_tags(self._log_box)

        return frame

    def _refresh_logs(self):
        query = ""
        try:
            query = self._log_filter.get().lower().strip()
        except Exception:
            pass

        logs = get_logs()
        if query:
            logs = [e for e in logs if query in e["message"].lower()]

        # Differential update for logs
        if not hasattr(self, "_last_logs_cache"):
            self._last_logs_cache = []
        if not hasattr(self, "_last_logs_query"):
            self._last_logs_query = ""

        if logs != self._last_logs_cache or query != self._last_logs_query:
            self._log_box.configure(state="normal")
            self._log_box.delete("1.0", "end")
            self._log_box.configure(state="disabled")
            for entry in reversed(logs):
                self._insert_log_line(self._log_box, entry)
            self._last_logs_cache = logs.copy()
            self._last_logs_query = query

    def _clear_logs(self):
        clear_logs()
        self._refresh_logs()

    # ─── Page: Sync History ───────────────────────────────────────────────────

    def _build_history(self, parent) -> ctk.CTkFrame:
        frame = ctk.CTkFrame(parent, fg_color=C_BG)
        hdr = self._page_header(frame, "Sync History", "Per-session audit trail from all devices")

        ctrl = ctk.CTkFrame(hdr, fg_color="transparent")
        ctrl.pack(side="right")

        self._hist_device_var = tk.StringVar(value="All Devices")
        self._hist_device_menu = ctk.CTkOptionMenu(
            ctrl,
            variable=self._hist_device_var,
            values=["All Devices"],
            width=160, height=36,
            fg_color=C_ELEVATED,
            button_color=C_ELEVATED,
            button_hover_color=C_SOFT_BLUE,
            text_color=C_TEXT,
            dropdown_fg_color=C_SURFACE,
            dropdown_text_color=C_TEXT,
            dropdown_hover_color=C_SOFT_BLUE,
            corner_radius=12,
            command=lambda _: self._refresh_history(force=True),
        )
        self._hist_device_menu.pack(side="left", padx=(0, 8))

        ctk.CTkButton(
            ctrl, text="Refresh", width=100, height=36,
            fg_color=C_SOFT_BLUE, hover_color=C_SOFT_BLUE_HOVER,
            text_color=C_ACCENT,
            border_width=1, border_color=C_BORDER,
            corner_radius=12,
            command=lambda: self._refresh_history(force=True),
        ).pack(side="left", padx=(0, 6))

        ctk.CTkButton(
            ctrl, text="Clear", width=90, height=36,
            fg_color=C_SOFT_RED, hover_color=C_SOFT_RED_HOVER,
            text_color=C_ERROR,
            border_width=1, border_color=C_ERROR_BORDER,
            corner_radius=12,
            command=self._clear_history,
        ).pack(side="left")

        self._divider(frame)

        # Single fixed-height banner label — updated in-place, never destroyed
        self._hist_banner = ctk.CTkFrame(
            frame, fg_color=C_SURFACE,
            corner_radius=14, border_width=1, border_color=C_BORDER,
            height=44,
        )
        self._hist_banner.pack(fill="x", padx=32, pady=(14, 0))
        self._hist_banner.pack_propagate(False)
        self._hist_banner_lbl = ctk.CTkLabel(
            self._hist_banner,
            text="Navigate to this page to load history",
            font=FONT_SMALL, text_color=C_MUTED,
        )
        self._hist_banner_lbl.pack(expand=True)

        # Scrollable card area — uses grid inside so cards are compact
        self._hist_scroll = ctk.CTkScrollableFrame(
            frame, fg_color="transparent", label_text="",
        )
        self._hist_scroll.pack(fill="both", expand=True, padx=22, pady=(10, 16))
        self._hist_scroll.grid_columnconfigure(0, weight=1)

        # Fingerprint string cache (prevents full redraw when data unchanged)
        self._hist_cache_key: str = ""
        self._hist_sessions_cache: list[dict] = []
        return frame

    @staticmethod
    def _history_cache_key(sessions: list[dict]) -> str:
        return "|".join(
            f"{s.get('id','')}:{s.get('outcome','')}:{s.get('uploaded',0)}"
            for s in sessions
        )

    def _refresh_history(self, force: bool = False):
        try:
            # ── Device filter ─────────────────────────────────────────────────
            devices = get_devices()
            device_names = ["All Devices"] + [
                d.get("device_name") or d.get("device_id") or "Unknown"
                for d in devices
            ]
            device_id_map = {
                (d.get("device_name") or d.get("device_id") or "Unknown"): d.get("device_id")
                for d in devices
            }
            current = self._hist_device_var.get()
            self._hist_device_menu.configure(values=device_names)
            if current not in device_names:
                self._hist_device_var.set("All Devices")
            selected   = self._hist_device_var.get()
            filter_id  = device_id_map.get(selected) if selected != "All Devices" else None
            sessions   = get_sync_sessions(device_id=filter_id, limit=100)

            # ── Early exit if nothing changed ─────────────────────────────────
            new_key = self._history_cache_key(sessions)
            if not force and new_key == self._hist_cache_key:
                return
            self._hist_cache_key     = new_key
            self._hist_sessions_cache = sessions

            # ── Banner: update label text in-place (no destroy = no blink) ───
            if not sessions:
                self._hist_banner_lbl.configure(
                    text="No sessions yet — records appear here after the Android app syncs",
                    text_color=C_MUTED,
                )
            else:
                total_up   = sum(s.get("uploaded",    0) for s in sessions)
                total_err  = sum(s.get("errors",      0) for s in sessions)
                total_ms   = sum(s.get("duration_ms", 0) for s in sessions)
                n_done     = sum(1 for s in sessions if s.get("outcome") == "completed")
                n_fail     = sum(1 for s in sessions if s.get("outcome") in ("failed", "force_stopped"))

                def _bd(ms):
                    secs = ms // 1000
                    if secs < 60:  return f"{secs}s"
                    m = secs // 60; return f"{m}m {secs % 60}s"

                parts = [
                    f"Sessions: {len(sessions)}",
                    f"Uploaded: {total_up:,}",
                    f"Completed: {n_done}",
                    f"Time: {_bd(total_ms)}",
                ]
                if total_err:  parts.append(f"Errors: {total_err}")
                if n_fail:     parts.append(f"Interrupted: {n_fail}")
                self._hist_banner_lbl.configure(
                    text="   ·   ".join(parts),
                    text_color=C_TEXT,
                )

            # ── Card list: destroy only when data changed (already past early-exit) ──
            for w in self._hist_scroll.winfo_children():
                w.destroy()

            if not sessions:
                empty = ctk.CTkFrame(
                    self._hist_scroll, fg_color=C_SURFACE,
                    corner_radius=16, border_width=1, border_color=C_BORDER,
                )
                empty.grid(row=0, column=0, sticky="ew", padx=8, pady=24)
                ctk.CTkLabel(
                    empty, text="No sync sessions yet",
                    font=ctk.CTkFont(family="Segoe UI", size=15, weight="bold"),
                    text_color=C_TEXT,
                ).pack(pady=(22, 4))
                ctk.CTkLabel(
                    empty,
                    text="Each time the Android app completes, stops, or fails a sync,\na record is posted here automatically.",
                    font=FONT_BODY, text_color=C_MUTED, justify="center",
                ).pack(pady=(0, 22))
                return

            OUTCOME_CFG = {
                "completed":    ("Completed",    C_SUCCESS, C_SOFT_GREEN),
                "stopped":      ("Stopped",      C_WARNING, C_SOFT_AMBER),
                "force_stopped":("Force stopped",C_ERROR,   C_SOFT_RED),
                "failed":       ("Failed",       C_ERROR,   C_SOFT_RED),
            }
            OUTCOME_ICON = {
                "completed": "✅", "stopped": "⏹",
                "force_stopped": "⚡", "failed": "❌",
            }

            def _fmt_ts(ts):
                try:    return datetime.fromtimestamp(ts / 1000).strftime("%b %d  %H:%M")
                except: return ""

            def _fmt_dur(ms):
                secs = max(0, ms // 1000)
                if secs < 60:  return f"{secs}s"
                m, s = divmod(secs, 60)
                if m  < 60:  return f"{m}m {s}s" if s else f"{m}m"
                h, mr = divmod(m, 60)
                return f"{h}h {mr}m" if mr else f"{h}h"

            for row_idx, sess in enumerate(sessions):
                outcome      = sess.get("outcome", "completed")
                label, fg, bg = OUTCOME_CFG.get(outcome, ("Unknown", C_ACCENT, C_SOFT_BLUE))
                icon         = OUTCOME_ICON.get(outcome, "🔄")
                device_label = sess.get("device_name") or sess.get("device_id") or "Unknown device"
                started_ts   = sess.get("started_at", 0)
                trigger      = sess.get("trigger", "manual")
                uploaded     = sess.get("uploaded",    0)
                skipped      = sess.get("skipped",     0)
                errors       = sess.get("errors",      0)
                scanned      = sess.get("scanned",     0)
                dur_ms       = sess.get("duration_ms", 0)

                # Card — grid-based so height is driven only by content
                card = ctk.CTkFrame(
                    self._hist_scroll,
                    fg_color=C_SURFACE,
                    corner_radius=12,
                    border_width=1,
                    border_color=C_BORDER,
                )
                card.grid(row=row_idx, column=0, sticky="ew", padx=8, pady=4)
                card.grid_columnconfigure(1, weight=1)

                # Left accent strip — column 0, sticky ns keeps it flush
                accent_bar = ctk.CTkFrame(card, width=5, fg_color=fg, corner_radius=0)
                accent_bar.grid(row=0, column=0, rowspan=2, sticky="ns")

                # Body — column 1
                body = ctk.CTkFrame(card, fg_color="transparent")
                body.grid(row=0, column=1, sticky="ew", padx=(12, 14), pady=(9, 9))
                body.grid_columnconfigure(0, weight=1)

                # Top row: badge · auto-chip · device-name · timestamp
                top = ctk.CTkFrame(body, fg_color="transparent")
                top.grid(row=0, column=0, sticky="ew")
                top.grid_columnconfigure(2, weight=1)   # device name stretches

                badge_pill = ctk.CTkFrame(top, fg_color=bg, corner_radius=999)
                badge_pill.grid(row=0, column=0, sticky="w")
                ctk.CTkLabel(
                    badge_pill,
                    text=f"{icon}  {label}",
                    font=ctk.CTkFont(family="Segoe UI", size=10, weight="bold"),
                    text_color=fg,
                ).pack(padx=9, pady=2)

                col_off = 1
                if trigger == "auto":
                    auto_pill = ctk.CTkFrame(
                        top, fg_color=C_ELEVATED, corner_radius=999,
                        border_width=1, border_color=C_BORDER,
                    )
                    auto_pill.grid(row=0, column=col_off, sticky="w", padx=(5, 0))
                    ctk.CTkLabel(
                        auto_pill, text="AUTO",
                        font=ctk.CTkFont(family="Segoe UI", size=8, weight="bold"),
                        text_color=C_MUTED,
                    ).pack(padx=7, pady=2)
                    col_off = 2

                ctk.CTkLabel(
                    top, text=device_label,
                    font=ctk.CTkFont(family="Segoe UI", size=12, weight="bold"),
                    text_color=C_TEXT, anchor="w",
                ).grid(row=0, column=col_off, sticky="w", padx=(8, 0))

                ctk.CTkLabel(
                    top, text=_fmt_ts(started_ts),
                    font=FONT_SMALL, text_color=C_MUTED, anchor="e",
                ).grid(row=0, column=3, sticky="e", padx=(8, 0))

                # Stats row: inline chips
                chips = ctk.CTkFrame(body, fg_color="transparent")
                chips.grid(row=1, column=0, sticky="w", pady=(5, 0))

                chip_defs = [
                    (f"⬆︎ {uploaded:,} uploaded", C_SUCCESS if uploaded else C_MUTED),
                    (f"✓ {skipped:,} already saved",   C_MUTED),
                    (f"⏱ {_fmt_dur(dur_ms)}",          C_MUTED),
                ]
                if errors:
                    chip_defs.insert(2, (f"✗ {errors} errors", C_ERROR))
                if scanned:
                    chip_defs.append((f"⊙ {scanned:,} scanned", C_MUTED))

                for ci, (txt, clr) in enumerate(chip_defs):
                    ctk.CTkLabel(
                        chips, text=txt,
                        font=ctk.CTkFont(family="Segoe UI", size=11),
                        text_color=clr,
                    ).grid(row=0, column=ci, padx=(0, 14), sticky="w")

        except Exception:
            traceback.print_exc()

    def _clear_history(self):
        if not confirm_dialog(self, "Clear Sync History",
                              "This will permanently delete all sync session records from the server database."):
            return
        selected = self._hist_device_var.get()
        devices  = get_devices()
        device_id_map = {
            (d.get("device_name") or d.get("device_id") or "Unknown"): d.get("device_id")
            for d in devices
        }
        filter_id = device_id_map.get(selected) if selected != "All Devices" else None
        clear_sync_sessions(device_id=filter_id)
        self._hist_cache_key = ""
        self._hist_sessions_cache = []
        self._refresh_history(force=True)


    # ─── Navigation ───────────────────────────────────────────────────────────

    def _show_page(self, page: str):
        for name, btn in self._nav_btns.items():
            accent = self._nav_accents[name]
            if name == page:
                btn.configure(fg_color=C_SOFT_BLUE, text_color=C_ACCENT, font=ctk.CTkFont(family="Segoe UI", size=13, weight="bold"))
                accent.configure(fg_color=C_ACCENT)
            else:
                btn.configure(fg_color="transparent", text_color=C_MUTED, font=ctk.CTkFont(family="Segoe UI", size=13))
                accent.configure(fg_color="transparent")

        self._pages[page].tkraise()
        self._current_page = page

        if page == "dashboard":
            self._refresh_dashboard()
        elif page == "devices":
            self._refresh_devices()
        elif page == "settings":
            self._refresh_settings()
        elif page == "logs":
            self._refresh_logs()
        elif page == "history":
            self._refresh_history(force=True)

    # ─── Auto-refresh ─────────────────────────────────────────────────────────

    def _refresh_settings(self):
        cfg = load_config()
        for entry, key, default in [
            (self._e_host, "HOST",        "0.0.0.0"),
            (self._e_port, "PORT",        "8000"),
            (self._e_root, "BACKUP_ROOT", ""),
            (self._e_key,  "API_KEY",     "YOUR_SECRET_KEY"),
        ]:
            entry.delete(0, "end")
            entry.insert(0, str(cfg.get(key, default)))
        if cfg.get("REQUIRE_APPROVAL", True):
            self._sw_approval.select()
        else:
            self._sw_approval.deselect()
        if _normalize_theme_mode(cfg.get("THEME_MODE")) == "dark":
            self._sw_dark_mode.select()
        else:
            self._sw_dark_mode.deselect()

    def _auto_refresh(self):
        if self._current_page == "dashboard":
            self._refresh_dashboard()
        elif self._current_page == "devices":
            self._refresh_devices()
        elif self._current_page == "logs":
            self._refresh_logs()
        elif self._current_page == "history":
            self._refresh_history()
        self.after(2000, self._auto_refresh)

    # ─── Server control ───────────────────────────────────────────────────────

    def _start_server(self):
        """Reload modules in dependency order and start uvicorn."""
        import importlib

        for mod_name in ("config", "storage", "database", "upload", "server"):
            if mod_name in sys.modules:
                importlib.reload(sys.modules[mod_name])

        from server import app as fastapi_app
        from config import HOST, PORT

        # Pre-flight check: is the port already in use?
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s.bind((HOST, PORT))
            except socket.error:
                messagebox.showerror(
                    "Port Conflict",
                    f"Port {PORT} is already in use by another application.\n\n"
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
            log_config=None,   # disable uvicorn's default logging; avoids
                               # isatty() crash when stdout/stderr are None
                               # (windowed PyInstaller build)
        )
        self._uvicorn_server = uvicorn.Server(ucfg)

        def _run():
            try:
                self._uvicorn_server.run()
            except Exception as e:
                add_log(f"Server runtime error: {e}")

        self._server_thread = threading.Thread(target=_run, daemon=True)
        self._server_thread.start()
        self._server_running  = True
        self._server_start_time = time.time()

        local_ip = get_local_ip()
        addr = f"http://{local_ip}:{PORT}"
        self.after(0, lambda: self._set_status(True, addr))
        self.after(0, self._configure_server_button)
        add_log(f"Server started - {addr}")

    def _stop_server(self):
        if self._uvicorn_server:
            self._uvicorn_server.should_exit = True
        self._server_running    = False
        self._server_start_time = None
        self.after(0, lambda: self._set_status(False))
        self.after(0, self._configure_server_button)
        add_log("Server stopped")

    def _restart_server(self):
        self._stop_server()
        self.after(3500, self._start_server)

    def _toggle_server(self):
        if self._server_running:
            self._stop_server()
        else:
            self._start_server()

    # ─── Connection approval ──────────────────────────────────────────────────

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
        dlg.title("New Connection Request")

        # Center on main window
        dlg_w, dlg_h = 480, 420
        self.update_idletasks()
        x = self.winfo_x() + (self.winfo_width() // 2) - (dlg_w // 2)
        y = self.winfo_y() + (self.winfo_height() // 2) - (dlg_h // 2)
        dlg.geometry(f"{dlg_w}x{dlg_h}+{x}+{y}")

        dlg.resizable(False, False)
        dlg.attributes("-topmost", True)
        dlg.grab_set()
        dlg.configure(fg_color=C_SURFACE)

        # Header
        hdr = ctk.CTkFrame(dlg, fg_color=C_SURFACE, corner_radius=0)
        hdr.pack(fill="x")
        badge = ctk.CTkFrame(hdr, width=62, height=62, fg_color=C_SOFT_BLUE, corner_radius=18)
        badge.pack(pady=(24, 8))
        badge.pack_propagate(False)
        ctk.CTkLabel(
            badge, text="P", font=ctk.CTkFont(family="Segoe UI", size=28, weight="bold"),
            text_color=C_ACCENT,
        ).pack(expand=True)
        ctk.CTkLabel(
            hdr, text="New Device Wants to Connect",
            font=ctk.CTkFont(family="Segoe UI", size=17, weight="bold"),
            text_color=C_TEXT,
        ).pack(pady=(0, 18))

        # Thin accent line
        ctk.CTkFrame(dlg, height=2, fg_color=C_ACCENT, corner_radius=0).pack(fill="x")

        # Info card
        info = ctk.CTkFrame(
            dlg, fg_color=C_ELEVATED, corner_radius=16,
            border_width=1, border_color=C_BORDER,
        )
        info.pack(fill="x", padx=28, pady=20)

        for icon, label, val in [
            ("Device", "Device Name", device_name),
            ("IP", "IP Address",  device_ip),
            ("Time", "Time",        datetime.now().strftime("%H:%M:%S")),
        ]:
            row = ctk.CTkFrame(info, fg_color="transparent")
            row.pack(fill="x", padx=16, pady=6)
            ctk.CTkLabel(
                row, text=f"{icon}  {label}", font=FONT_SMALL,
                text_color=C_MUTED, width=120, anchor="w",
            ).pack(side="left")
            ctk.CTkLabel(
                row, text=val, font=FONT_BODY,
                text_color=C_TEXT, anchor="w",
            ).pack(side="left")

        # Countdown bar + label
        countdown_frame = ctk.CTkFrame(dlg, fg_color="transparent")
        countdown_frame.pack(fill="x", padx=28, pady=(0, 8))

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
            add_log(f"Accepted: {device_name} ({device_ip})")
            self._refresh_devices()
            dlg.destroy()

        def _reject():
            if resolved[0]:
                return
            resolved[0] = True
            resolve_connection(req_id, False)
            add_log(f"Rejected: {device_name} ({device_ip})")
            if dlg.winfo_exists():
                dlg.destroy()

        # Buttons
        btns = ctk.CTkFrame(dlg, fg_color="transparent")
        btns.pack(fill="x", padx=28, pady=(4, 24))

        ctk.CTkButton(
            btns, text="Reject",
            fg_color=C_SOFT_RED, hover_color=C_SOFT_RED_HOVER,
            text_color=C_ERROR, border_width=1, border_color=C_ERROR_BORDER,
            height=48, font=ctk.CTkFont(size=14, weight="bold"),
            corner_radius=12, command=_reject,
        ).pack(side="left", expand=True, padx=(0, 8))

        ctk.CTkButton(
            btns, text="Accept",
            fg_color=C_SUCCESS, hover_color=C_SUCCESS_HOVER,
            text_color="#FFFFFF",
            height=48, font=ctk.CTkFont(size=14, weight="bold"),
            corner_radius=12, command=_accept,
        ).pack(side="right", expand=True, padx=(8, 0))

        dlg.after(1000, tick)
        self.bell()

    # ─── Window close ─────────────────────────────────────────────────────────

    def _on_close(self):
        if messagebox.askyesno("Quit", "Stop the backup server and quit?"):
            self._stop_server()
            self._dot.stop()
            self.after(600, self.destroy)


# ──────────────────────────────────────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    init_db()
    app = BackupServerApp()
    app.mainloop()
