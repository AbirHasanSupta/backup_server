"""
Phone Backup Server — Desktop Application
Wraps the FastAPI server in a native dark-mode GUI (customtkinter).

Run with:  python desktop_app.py
"""

from __future__ import annotations

import os
import socket
import sys
import threading
import time
from datetime import datetime
from tkinter import filedialog, messagebox

import customtkinter as ctk
import uvicorn

# ── Local imports ──────────────────────────────────────────────────────────────
# Import state first (no side-effects) so other modules can use it
from state import (
    add_log,
    clear_logs,
    get_logs,
    pending_connections,
    resolve_connection,
)
from config import load_config, save_config
from database import get_devices, get_stats, init_db, remove_device

# ── Theme ──────────────────────────────────────────────────────────────────────
ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("blue")

# Palette (mirrors the Android app's palette)
C_BG = "#090D1A"
C_SURFACE = "#0F1729"
C_ELEVATED = "#162033"
C_BORDER = "#1E2D45"
C_PRIMARY = "#6366F1"
C_SUCCESS = "#22C55E"
C_ERROR = "#EF4444"
C_WARNING = "#F59E0B"
C_TEXT = "#F1F5F9"
C_MUTED = "#64748B"

# Fonts are initialised inside BackupServerApp.__init__ (after the root window
# exists) and then assigned to these module-level names for shared use.
FONT_TITLE: ctk.CTkFont
FONT_SECTION: ctk.CTkFont
FONT_BODY: ctk.CTkFont
FONT_SMALL: ctk.CTkFont
FONT_MONO: ctk.CTkFont


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


# ──────────────────────────────────────────────────────────────────────────────
# Custom confirm dialog (avoids un-themed tk.messagebox)
# ──────────────────────────────────────────────────────────────────────────────

def confirm_dialog(parent, title: str, message: str) -> bool:
    result: list[bool] = [False]
    dlg = ctk.CTkToplevel(parent)
    dlg.title(title)
    dlg.geometry("380x180")
    dlg.resizable(False, False)
    dlg.attributes("-topmost", True)
    dlg.grab_set()

    ctk.CTkLabel(dlg, text=message, font=FONT_BODY, wraplength=340, justify="center").pack(
        expand=True, pady=(24, 12), padx=20
    )

    bf = ctk.CTkFrame(dlg, fg_color="transparent")
    bf.pack(fill="x", padx=20, pady=(0, 20))

    def _yes():
        result[0] = True
        dlg.destroy()

    def _no():
        dlg.destroy()

    ctk.CTkButton(bf, text="Cancel", fg_color=C_ELEVATED, hover_color=C_BORDER,
                  width=120, command=_no).pack(side="left")
    ctk.CTkButton(bf, text="Confirm", fg_color=C_ERROR, hover_color="#B91C1C",
                  width=120, command=_yes).pack(side="right")

    dlg.wait_window()
    return result[0]


# ──────────────────────────────────────────────────────────────────────────────
# Main Application
# ──────────────────────────────────────────────────────────────────────────────

class BackupServerApp(ctk.CTk):

    PAGES = ["dashboard", "devices", "settings", "logs"]
    PAGE_ICONS = {"dashboard": "📊", "devices": "📱", "settings": "⚙️", "logs": "📋"}

    def __init__(self):
        super().__init__()

        # Fonts must be created after the root window exists
        global FONT_TITLE, FONT_SECTION, FONT_BODY, FONT_SMALL, FONT_MONO
        FONT_TITLE = ctk.CTkFont(size=22, weight="bold")
        FONT_SECTION = ctk.CTkFont(size=13, weight="bold")
        FONT_BODY = ctk.CTkFont(size=13)
        FONT_SMALL = ctk.CTkFont(size=11)
        FONT_MONO = ctk.CTkFont(size=12, family="Consolas")

        self.title("Phone Backup Server")
        self.geometry("1060x680")
        self.minsize(820, 540)

        # Server control
        self._uvicorn_server: uvicorn.Server | None = None
        self._server_thread: threading.Thread | None = None
        self._server_running = False
        self._current_page: str | None = None

        # Build layout
        self._setup_grid()
        self._build_sidebar()
        self._build_statusbar()
        self._build_content_area()  # must come after sidebar (uses self._frames_container)

        # Navigate to dashboard
        self._show_page("dashboard")

        # Background polling
        self.after(500, self._poll_pending_connections)
        self.after(6000, self._auto_refresh)

        # Start server immediately
        self._start_server()

        # Graceful close
        self.protocol("WM_DELETE_WINDOW", self._on_close)

    # ─── Grid setup ──────────────────────────────────────────────────────────

    def _setup_grid(self):
        self.grid_columnconfigure(1, weight=1)
        self.grid_rowconfigure(0, weight=1)

    # ─── Sidebar ─────────────────────────────────────────────────────────────

    def _build_sidebar(self):
        sb = ctk.CTkFrame(self, width=210, corner_radius=0, fg_color=C_SURFACE)
        sb.grid(row=0, column=0, rowspan=2, sticky="nsew")
        sb.grid_propagate(False)
        sb.pack_propagate(False)

        # Logo
        logo = ctk.CTkFrame(sb, fg_color="transparent")
        logo.pack(fill="x", padx=18, pady=(28, 20))
        ctk.CTkLabel(logo, text="☁️", font=ctk.CTkFont(size=44)).pack()
        ctk.CTkLabel(logo, text="Phone Backup", font=ctk.CTkFont(size=17, weight="bold"),
                     text_color=C_TEXT).pack()
        ctk.CTkLabel(logo, text="Server Console", font=FONT_SMALL,
                     text_color=C_MUTED).pack(pady=(2, 0))

        # Divider
        ctk.CTkFrame(sb, height=1, fg_color=C_BORDER).pack(fill="x", padx=16, pady=6)

        # Nav buttons
        self._nav_btns: dict[str, ctk.CTkButton] = {}
        for page in self.PAGES:
            icon = self.PAGE_ICONS[page]
            btn = ctk.CTkButton(
                sb,
                text=f"  {icon}   {page.title()}",
                anchor="w",
                corner_radius=10,
                height=44,
                fg_color="transparent",
                hover_color=C_ELEVATED,
                text_color=C_MUTED,
                font=ctk.CTkFont(size=14),
                command=lambda p=page: self._show_page(p),
            )
            btn.pack(fill="x", padx=12, pady=3)
            self._nav_btns[page] = btn

        # Bottom: server toggle
        ctk.CTkFrame(sb, height=1, fg_color=C_BORDER).pack(fill="x", padx=16, pady=6, side="bottom")
        self._toggle_btn = ctk.CTkButton(
            sb,
            text="⏹  Stop Server",
            fg_color="#7F1D1D",
            hover_color="#991B1B",
            height=42,
            command=self._toggle_server,
        )
        self._toggle_btn.pack(fill="x", padx=12, pady=(0, 16), side="bottom")

    # ─── Status bar ──────────────────────────────────────────────────────────

    def _build_statusbar(self):
        bar = ctk.CTkFrame(self, height=38, corner_radius=0, fg_color=C_SURFACE)
        bar.grid(row=1, column=1, sticky="ew")
        bar.grid_propagate(False)

        self._dot_lbl = ctk.CTkLabel(bar, text="●", text_color=C_SUCCESS,
                                      font=ctk.CTkFont(size=14))
        self._dot_lbl.pack(side="left", padx=(14, 4), pady=10)

        self._status_lbl = ctk.CTkLabel(bar, text="Starting…", font=FONT_SMALL,
                                         text_color=C_TEXT)
        self._status_lbl.pack(side="left", pady=10)

        self._addr_lbl = ctk.CTkLabel(bar, text="", font=FONT_MONO, text_color=C_MUTED)
        self._addr_lbl.pack(side="right", padx=14, pady=10)

    def _set_status(self, running: bool, addr: str = ""):
        if running:
            self._dot_lbl.configure(text_color=C_SUCCESS)
            self._status_lbl.configure(text="Server Running")
            self._addr_lbl.configure(text=addr)
        else:
            self._dot_lbl.configure(text_color=C_ERROR)
            self._status_lbl.configure(text="Server Stopped")
            self._addr_lbl.configure(text="")

    # ─── Content frames ───────────────────────────────────────────────────────

    def _build_content_area(self):
        container = ctk.CTkFrame(self, corner_radius=0, fg_color="transparent")
        container.grid(row=0, column=1, sticky="nsew")
        container.grid_columnconfigure(0, weight=1)
        container.grid_rowconfigure(0, weight=1)
        self._frames_container = container

        self._pages: dict[str, ctk.CTkFrame] = {
            "dashboard": self._build_dashboard(container),
            "devices":   self._build_devices(container),
            "settings":  self._build_settings(container),
            "logs":      self._build_logs(container),
        }
        for f in self._pages.values():
            f.grid(row=0, column=0, sticky="nsew")

    # ─── Page: Dashboard ─────────────────────────────────────────────────────

    def _build_dashboard(self, parent) -> ctk.CTkFrame:
        frame = ctk.CTkFrame(parent, fg_color="transparent")

        # Title
        ctk.CTkLabel(frame, text="Dashboard", font=FONT_TITLE, text_color=C_TEXT).pack(
            anchor="w", padx=28, pady=(22, 16)
        )

        # Stat cards row
        cards = ctk.CTkFrame(frame, fg_color="transparent")
        cards.pack(fill="x", padx=28)

        self._s_files   = self._stat_card(cards, "📦", "Total Files", "—")
        self._s_devices = self._stat_card(cards, "📱", "Devices", "—")
        self._s_size    = self._stat_card(cards, "💾", "Total Size", "—")
        self._s_last    = self._stat_card(cards, "🕐", "Last Backup", "—")

        # Divider + log preview
        ctk.CTkFrame(frame, height=1, fg_color=C_BORDER).pack(fill="x", padx=28, pady=(20, 0))
        ctk.CTkLabel(frame, text="Recent Activity", font=FONT_SECTION,
                     text_color=C_MUTED).pack(anchor="w", padx=28, pady=(12, 6))

        self._dash_log = ctk.CTkTextbox(
            frame, state="disabled", fg_color=C_SURFACE,
            border_color=C_BORDER, border_width=1,
            font=FONT_MONO, text_color=C_TEXT
        )
        self._dash_log.pack(fill="both", expand=True, padx=28, pady=(0, 20))

        return frame

    def _stat_card(self, parent, icon, label, value) -> ctk.CTkLabel:
        card = ctk.CTkFrame(parent, fg_color=C_ELEVATED, corner_radius=14,
                            border_width=1, border_color=C_BORDER)
        card.pack(side="left", fill="both", expand=True, padx=6, pady=4)

        ctk.CTkLabel(card, text=icon, font=ctk.CTkFont(size=30)).pack(pady=(18, 4))
        val_lbl = ctk.CTkLabel(card, text=value, font=ctk.CTkFont(size=24, weight="bold"),
                               text_color=C_PRIMARY)
        val_lbl.pack()
        ctk.CTkLabel(card, text=label, font=FONT_SMALL, text_color=C_MUTED).pack(pady=(2, 16))
        return val_lbl

    def _refresh_dashboard(self):
        try:
            stats = get_stats()
            devices = get_devices()

            self._s_files.configure(text=f"{stats['total_files']:,}")
            self._s_devices.configure(text=str(len(devices)))
            self._s_size.configure(text=fmt_bytes(stats["total_size_bytes"] or 0))
            self._s_last.configure(text=fmt_rel(stats.get("last_backup_time")))

            logs = get_logs()[-15:]
            self._dash_log.configure(state="normal")
            self._dash_log.delete("1.0", "end")
            for entry in reversed(logs):
                ts = datetime.fromtimestamp(entry["time"]).strftime("%H:%M:%S")
                self._dash_log.insert("end", f"[{ts}]  {entry['message']}\n")
            self._dash_log.configure(state="disabled")
        except Exception:
            pass

    # ─── Page: Devices ────────────────────────────────────────────────────────

    def _build_devices(self, parent) -> ctk.CTkFrame:
        frame = ctk.CTkFrame(parent, fg_color="transparent")

        hdr = ctk.CTkFrame(frame, fg_color="transparent")
        hdr.pack(fill="x", padx=28, pady=(22, 0))

        ctk.CTkLabel(hdr, text="Connected Devices", font=FONT_TITLE,
                     text_color=C_TEXT).pack(side="left")
        ctk.CTkButton(hdr, text="↻  Refresh", width=110,
                      command=self._refresh_devices).pack(side="right")

        ctk.CTkFrame(frame, height=1, fg_color=C_BORDER).pack(fill="x", padx=28, pady=12)

        self._devices_scroll = ctk.CTkScrollableFrame(
            frame, fg_color="transparent", label_text=""
        )
        self._devices_scroll.pack(fill="both", expand=True, padx=20, pady=(0, 16))

        return frame

    def _refresh_devices(self):
        for w in self._devices_scroll.winfo_children():
            w.destroy()

        devices = get_devices()

        if not devices:
            ctk.CTkLabel(
                self._devices_scroll,
                text=(
                    "📱\n\nNo devices connected yet.\n\n"
                    "Open Phone Backup on your Android device,\n"
                    "go to Settings → Server, and tap Discover\n"
                    "or enter this machine's IP address."
                ),
                font=FONT_BODY,
                text_color=C_MUTED,
                justify="center",
            ).pack(pady=60)
            return

        for dev in devices:
            self._device_card(self._devices_scroll, dev)

    def _device_card(self, parent, dev: dict):
        card = ctk.CTkFrame(parent, fg_color=C_ELEVATED, corner_radius=14,
                            border_width=1, border_color=C_BORDER)
        card.pack(fill="x", padx=8, pady=6)
        card.grid_columnconfigure(1, weight=1)

        # Icon
        ctk.CTkLabel(card, text="📱", font=ctk.CTkFont(size=34)).grid(
            row=0, column=0, rowspan=2, padx=(18, 10), pady=18
        )

        # Name
        ctk.CTkLabel(card, text=dev["device_name"],
                     font=ctk.CTkFont(size=15, weight="bold"),
                     text_color=C_TEXT).grid(row=0, column=1, sticky="sw", padx=4, pady=(16, 2))

        # Details
        info = (
            f"IP: {dev['device_ip']}  ·  "
            f"Files: {dev['files_backed_up']:,}  ·  "
            f"Last: {fmt_rel(dev['last_seen'])}  ·  "
            f"Since: {fmt_ts(dev['first_seen'])[:10]}"
        )
        ctk.CTkLabel(card, text=info, font=FONT_SMALL, text_color=C_MUTED).grid(
            row=1, column=1, sticky="nw", padx=4, pady=(0, 16)
        )

        # Remove button
        dev_id = dev["id"]
        dev_name = dev["device_name"]

        def do_remove(did=dev_id, dname=dev_name):
            if confirm_dialog(
                self,
                "Remove Device",
                f"Remove '{dname}' from the device list?\n\n"
                "The device can reconnect if it still has the correct API key.",
            ):
                remove_device(did)
                add_log(f"🗑️  Removed device: {dname}")
                self._refresh_devices()

        ctk.CTkButton(
            card, text="Remove", width=96, height=34,
            fg_color="#7F1D1D", hover_color="#991B1B",
            command=do_remove,
        ).grid(row=0, column=2, rowspan=2, padx=16)

    # ─── Page: Settings ───────────────────────────────────────────────────────

    def _build_settings(self, parent) -> ctk.CTkFrame:
        frame = ctk.CTkFrame(parent, fg_color="transparent")

        ctk.CTkLabel(frame, text="Settings", font=FONT_TITLE, text_color=C_TEXT).pack(
            anchor="w", padx=28, pady=(22, 16)
        )

        scroll = ctk.CTkScrollableFrame(frame, fg_color="transparent", label_text="")
        scroll.pack(fill="both", expand=True, padx=20, pady=(0, 16))

        cfg = load_config()

        def section(text):
            ctk.CTkLabel(scroll, text=text, font=FONT_SECTION,
                         text_color=C_MUTED).pack(anchor="w", padx=8, pady=(18, 6))

        def labeled_entry(label, default="") -> ctk.CTkEntry:
            ctk.CTkLabel(scroll, text=label, font=FONT_BODY,
                         text_color=C_TEXT).pack(anchor="w", padx=8, pady=(6, 2))
            e = ctk.CTkEntry(scroll, height=40, fg_color=C_ELEVATED,
                             border_color=C_BORDER, text_color=C_TEXT)
            e.insert(0, default)
            e.pack(fill="x", padx=8, pady=(0, 4))
            return e

        # ── Server ──────────────────────────────────────────────────────────
        section("SERVER")
        self._e_host = labeled_entry("Listen IP  (0.0.0.0 = all interfaces)",
                                      cfg.get("HOST", "0.0.0.0"))
        self._e_port = labeled_entry("Port", str(cfg.get("PORT", 8000)))

        # ── Storage ─────────────────────────────────────────────────────────
        section("STORAGE")
        self._e_root = labeled_entry("Backup Root Folder", cfg.get("BACKUP_ROOT", ""))

        browse_btn = ctk.CTkButton(
            scroll, text="📂  Browse…", width=130, anchor="w",
            fg_color=C_ELEVATED, hover_color=C_BORDER,
            command=self._browse_root,
        )
        browse_btn.pack(anchor="w", padx=8, pady=4)

        # ── Security ────────────────────────────────────────────────────────
        section("SECURITY")
        self._e_key = labeled_entry("API Key  (must match Android app)", cfg.get("API_KEY", ""))

        ctk.CTkLabel(scroll, text="Require Approval for New Devices",
                     font=FONT_BODY, text_color=C_TEXT).pack(anchor="w", padx=8, pady=(12, 4))

        sw_row = ctk.CTkFrame(scroll, fg_color="transparent")
        sw_row.pack(anchor="w", padx=8, pady=(0, 4))

        self._sw_approval = ctk.CTkSwitch(sw_row, text="", width=50)
        self._sw_approval.pack(side="left")
        if cfg.get("REQUIRE_APPROVAL", True):
            self._sw_approval.select()
        ctk.CTkLabel(sw_row, text="Show accept/reject dialog when a device first connects",
                     font=FONT_SMALL, text_color=C_MUTED).pack(side="left", padx=10)

        # ── Save ────────────────────────────────────────────────────────────
        ctk.CTkButton(
            scroll, text="💾   Save & Restart Server", height=46,
            font=ctk.CTkFont(size=14, weight="bold"),
            command=self._save_settings,
        ).pack(fill="x", padx=8, pady=(24, 4))

        ctk.CTkLabel(
            scroll,
            text="The server will restart automatically to apply changes.",
            font=FONT_SMALL, text_color=C_MUTED,
        ).pack(anchor="w", padx=8, pady=(0, 24))

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
            "HOST": self._e_host.get().strip() or "0.0.0.0",
            "PORT": port,
            "BACKUP_ROOT": self._e_root.get().strip(),
            "API_KEY": self._e_key.get().strip() or "YOUR_SECRET_KEY",
            "REQUIRE_APPROVAL": bool(self._sw_approval.get()),
        }
        save_config(cfg)
        add_log("⚙️  Settings saved — restarting server…")
        self._restart_server()

    # ─── Page: Logs ───────────────────────────────────────────────────────────

    def _build_logs(self, parent) -> ctk.CTkFrame:
        frame = ctk.CTkFrame(parent, fg_color="transparent")

        hdr = ctk.CTkFrame(frame, fg_color="transparent")
        hdr.pack(fill="x", padx=28, pady=(22, 0))

        ctk.CTkLabel(hdr, text="Activity Logs", font=FONT_TITLE,
                     text_color=C_TEXT).pack(side="left")

        btn_row = ctk.CTkFrame(hdr, fg_color="transparent")
        btn_row.pack(side="right")
        ctk.CTkButton(btn_row, text="↻  Refresh", width=100,
                      command=self._refresh_logs).pack(side="left", padx=4)
        ctk.CTkButton(btn_row, text="🗑️  Clear", width=90,
                      fg_color=C_ELEVATED, hover_color=C_BORDER,
                      command=self._clear_logs).pack(side="left")

        ctk.CTkFrame(frame, height=1, fg_color=C_BORDER).pack(fill="x", padx=28, pady=12)

        self._log_box = ctk.CTkTextbox(
            frame, state="disabled", fg_color=C_SURFACE,
            border_color=C_BORDER, border_width=1,
            font=FONT_MONO, text_color=C_TEXT,
        )
        self._log_box.pack(fill="both", expand=True, padx=28, pady=(0, 20))

        return frame

    def _refresh_logs(self):
        logs = get_logs()
        self._log_box.configure(state="normal")
        self._log_box.delete("1.0", "end")
        for entry in reversed(logs):
            ts = datetime.fromtimestamp(entry["time"]).strftime("%H:%M:%S")
            self._log_box.insert("end", f"[{ts}]  {entry['message']}\n")
        self._log_box.configure(state="disabled")

    def _clear_logs(self):
        clear_logs()
        self._refresh_logs()

    # ─── Navigation ───────────────────────────────────────────────────────────

    def _show_page(self, page: str):
        for name, btn in self._nav_btns.items():
            if name == page:
                btn.configure(fg_color=C_ELEVATED, text_color=C_TEXT)
            else:
                btn.configure(fg_color="transparent", text_color=C_MUTED)

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

    # ─── Auto-refresh ─────────────────────────────────────────────────────────

    def _refresh_settings(self):
        """Re-populate Settings fields from the current saved config."""
        cfg = load_config()
        for entry, key, default in [
            (self._e_host, "HOST", "0.0.0.0"),
            (self._e_port, "PORT", "8000"),
            (self._e_root, "BACKUP_ROOT", ""),
            (self._e_key,  "API_KEY",     "YOUR_SECRET_KEY"),
        ]:
            entry.delete(0, "end")
            entry.insert(0, str(cfg.get(key, default)))
        if cfg.get("REQUIRE_APPROVAL", True):
            self._sw_approval.select()
        else:
            self._sw_approval.deselect()

    def _auto_refresh(self):
        if self._current_page == "dashboard":
            self._refresh_dashboard()
        elif self._current_page == "devices":
            self._refresh_devices()
        elif self._current_page == "logs":
            self._refresh_logs()
        self.after(2000, self._auto_refresh)

    # ─── Server control ───────────────────────────────────────────────────────

    def _start_server(self):
        """
        Reload all modules in dependency order so that any config changes
        (BACKUP_ROOT, API_KEY, PORT, …) take full effect on restart.
        Load order: config → storage → upload → server
        """
        import importlib
        import sys

        # Reload in strict dependency order so each layer sees fresh values
        for mod_name in ("config", "storage", "database", "upload", "server"):
            if mod_name in sys.modules:
                importlib.reload(sys.modules[mod_name])

        from server import app as fastapi_app
        from config import HOST, PORT

        ucfg = uvicorn.Config(fastapi_app, host=HOST, port=PORT, log_level="warning")
        self._uvicorn_server = uvicorn.Server(ucfg)

        def _run():
            self._uvicorn_server.run()

        self._server_thread = threading.Thread(target=_run, daemon=True)
        self._server_thread.start()
        self._server_running = True

        local_ip = get_local_ip()
        addr = f"http://{local_ip}:{PORT}"
        self.after(0, lambda: self._set_status(True, addr))
        self.after(0, lambda: self._toggle_btn.configure(
            text="⏹  Stop Server", fg_color="#7F1D1D", hover_color="#991B1B"
        ))
        add_log(f"🚀 Server started  →  {addr}")


    def _stop_server(self):
        if self._uvicorn_server:
            self._uvicorn_server.should_exit = True
        self._server_running = False
        self.after(0, lambda: self._set_status(False))
        self.after(0, lambda: self._toggle_btn.configure(
            text="▶  Start Server", fg_color="#14532D", hover_color="#166534"
        ))
        add_log("⏹  Server stopped")

    def _restart_server(self):
        self._stop_server()
        self.after(3500, self._start_server)  # give uvicorn time to release port

    def _toggle_server(self):
        if self._server_running:
            self._stop_server()
        else:
            self._start_server()

    # ─── Connection approval ──────────────────────────────────────────────────

    def _poll_pending_connections(self):
        """Check every 500 ms for new connection requests from Android devices."""
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
        dlg.geometry("460x330")
        dlg.resizable(False, False)
        dlg.attributes("-topmost", True)
        dlg.grab_set()

        # Icon + headline
        ctk.CTkLabel(dlg, text="📱", font=ctk.CTkFont(size=52)).pack(pady=(26, 6))
        ctk.CTkLabel(dlg, text="New Device Wants to Connect",
                     font=ctk.CTkFont(size=17, weight="bold"),
                     text_color=C_TEXT).pack()

        # Info card
        info = ctk.CTkFrame(dlg, fg_color=C_ELEVATED, corner_radius=12,
                            border_width=1, border_color=C_BORDER)
        info.pack(fill="x", padx=36, pady=18)

        for label, val in [("Device Name", device_name), ("IP Address", device_ip),
                            ("Time", datetime.now().strftime("%H:%M:%S"))]:
            row = ctk.CTkFrame(info, fg_color="transparent")
            row.pack(fill="x", padx=16, pady=5)
            ctk.CTkLabel(row, text=label, font=FONT_SMALL,
                         text_color=C_MUTED, width=100, anchor="w").pack(side="left")
            ctk.CTkLabel(row, text=val, font=FONT_BODY,
                         text_color=C_TEXT, anchor="w").pack(side="left")

        # Auto-reject countdown label
        countdown_lbl = ctk.CTkLabel(dlg, text="Auto-reject in 30s",
                                      font=FONT_SMALL, text_color=C_MUTED)
        countdown_lbl.pack(pady=(0, 8))

        resolved = [False]
        countdown_val = [30]

        def tick():
            if resolved[0] or not dlg.winfo_exists():
                return
            countdown_val[0] -= 1
            if countdown_val[0] <= 0:
                _reject()
                return
            countdown_lbl.configure(text=f"Auto-reject in {countdown_val[0]}s")
            dlg.after(1000, tick)

        def _accept():
            if resolved[0]:
                return
            resolved[0] = True
            resolve_connection(req_id, True)
            add_log(f"✅ Accepted: {device_name} ({device_ip})")
            self._refresh_devices()
            dlg.destroy()

        def _reject():
            if resolved[0]:
                return
            resolved[0] = True
            resolve_connection(req_id, False)
            add_log(f"❌ Rejected: {device_name} ({device_ip})")
            if dlg.winfo_exists():
                dlg.destroy()

        # Buttons
        btns = ctk.CTkFrame(dlg, fg_color="transparent")
        btns.pack(fill="x", padx=36, pady=(4, 24))

        ctk.CTkButton(
            btns, text="✕  Reject",
            fg_color="#7F1D1D", hover_color="#991B1B",
            height=44, font=ctk.CTkFont(size=14, weight="bold"),
            command=_reject,
        ).pack(side="left", expand=True, padx=(0, 8))

        ctk.CTkButton(
            btns, text="✓  Accept",
            fg_color="#14532D", hover_color="#166534",
            height=44, font=ctk.CTkFont(size=14, weight="bold"),
            command=_accept,
        ).pack(side="right", expand=True, padx=(8, 0))

        dlg.after(1000, tick)
        self.bell()  # Flash taskbar / play system sound

    # ─── Window close ─────────────────────────────────────────────────────────

    def _on_close(self):
        if messagebox.askyesno("Quit", "Stop the backup server and quit?"):
            self._stop_server()
            self.after(600, self.destroy)


# ──────────────────────────────────────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # Ensure DB is up to date before launching
    init_db()
    app = BackupServerApp()
    app.mainloop()
