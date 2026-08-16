"""Static poster-frame thumbnails for video memory cards (single cached JPEG)."""

from __future__ import annotations

import hashlib
import os
import subprocess
import threading

from config import APP_DATA_DIR
from ffmpeg_utils import resolve_ffmpeg_path

DEFAULT_THUMBNAIL_CACHE_DIR = os.path.join(APP_DATA_DIR, "thumbnail_cache")
_lock = threading.Lock()


def _cache_dir() -> str:
    os.makedirs(DEFAULT_THUMBNAIL_CACHE_DIR, exist_ok=True)
    return DEFAULT_THUMBNAIL_CACHE_DIR


def _cache_key(source_path: str, mtime: float, size: int) -> str:
    raw = f"{source_path}:{mtime}:{size}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _run_options() -> dict:
    opts: dict = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "timeout": 20,
    }
    if os.name == "nt":
        opts["creationflags"] = subprocess.CREATE_NO_WINDOW
    return opts


def get_video_thumbnail_path(source_path: str) -> str | None:
    if not os.path.isfile(source_path):
        return None
    stat = os.stat(source_path)
    key = _cache_key(source_path, stat.st_mtime, stat.st_size)
    out_path = os.path.join(_cache_dir(), f"{key}.jpg")
    if os.path.isfile(out_path):
        return out_path

    ffmpeg = resolve_ffmpeg_path()
    if not ffmpeg:
        return None

    with _lock:
        if os.path.isfile(out_path):
            return out_path
        partial = out_path + ".partial"
        for seek in ("0.5", "0"):
            cmd = [
                ffmpeg, "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
                "-ss", seek, "-i", source_path,
                "-frames:v", "1", "-vf", "scale=480:-2",
                partial,
            ]
            try:
                subprocess.run(cmd, **_run_options(), check=True)
            except Exception:
                continue
            if os.path.isfile(partial) and os.path.getsize(partial) > 0:
                os.replace(partial, out_path)
                return out_path
        if os.path.isfile(partial):
            try:
                os.remove(partial)
            except OSError:
                pass
        return None