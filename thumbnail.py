"""Static poster-frame thumbnails for video memory cards (single cached JPEG)."""

from __future__ import annotations

import hashlib
import os
import subprocess
import threading

from config import APP_DATA_DIR
from ffmpeg_utils import resolve_ffmpeg_path
from state import add_log

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
        "stderr": subprocess.PIPE,
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
        last_err = None
        for seek in ("0.5", "0"):
            cmd = [
                ffmpeg, "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
                "-ss", seek, "-i", source_path,
                "-frames:v", "1", "-vf", "scale=480:-2",
                # ".partial" isn't a recognized image extension — without an
                # explicit muxer, ffmpeg can't guess the output format and
                # exits before writing anything.
                "-f", "mjpeg",
                partial,
            ]
            try:
                subprocess.run(cmd, **_run_options(), check=True)
            except Exception as e:
                last_err = e
                continue
            if os.path.isfile(partial) and os.path.getsize(partial) > 0:
                os.replace(partial, out_path)
                return out_path
        if last_err is not None:
            stderr = getattr(last_err, "stderr", None)
            stderr_text = stderr.decode("utf-8", "replace").strip()[-500:] if isinstance(stderr, bytes) else ""
            add_log(f"[Thumbnail] failed for {source_path}: {last_err} :: {stderr_text}")
        if os.path.isfile(partial):
            try:
                os.remove(partial)
            except OSError:
                pass
        return None


# ─── Cache management helpers (used by desktop_app settings + shutdown) ────────

def get_thumbnail_cache_stats() -> dict:
    """Return {files, bytes} for the thumbnail cache directory."""
    cache_dir = _cache_dir()
    total_files = 0
    total_bytes = 0
    try:
        for name in os.listdir(cache_dir):
            p = os.path.join(cache_dir, name)
            if os.path.isfile(p):
                total_files += 1
                try:
                    total_bytes += os.path.getsize(p)
                except OSError:
                    pass
    except OSError:
        pass
    return {"files": total_files, "bytes": total_bytes}


def clear_thumbnail_cache() -> dict:
    """Delete all files in the thumbnail cache directory.
    Returns {files, bytes} of what was removed.
    """
    import shutil
    cache_dir = _cache_dir()
    removed_files = 0
    removed_bytes = 0
    try:
        for name in os.listdir(cache_dir):
            p = os.path.join(cache_dir, name)
            try:
                if os.path.isfile(p):
                    size = os.path.getsize(p)
                    os.remove(p)
                    removed_files += 1
                    removed_bytes += size
                elif os.path.isdir(p):
                    shutil.rmtree(p, ignore_errors=True)
            except OSError:
                pass
    except OSError:
        pass
    return {"files": removed_files, "bytes": removed_bytes}