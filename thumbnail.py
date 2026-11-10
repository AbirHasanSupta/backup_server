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

# Bounded semaphore allows multiple video thumbnails to generate in parallel.
# This module is loaded once in every Gunicorn process, so Docker supplies a
# small explicit value instead of multiplying the old CPU-count-based limit by
# every API worker during a cold gallery load.
try:
    _max_thumbnail_workers = int(os.environ.get("THUMBNAIL_WORKERS", max(2, min(8, os.cpu_count() or 4))))
except (TypeError, ValueError):
    _max_thumbnail_workers = max(2, min(8, os.cpu_count() or 4))
_max_thumbnail_workers = max(1, min(_max_thumbnail_workers, os.cpu_count() or 4))
_thumbnail_semaphore = threading.Semaphore(_max_thumbnail_workers)

# In-flight deduplication so concurrent requests for the exact same video share results
_inflight_lock = threading.Lock()
_inflight: dict[str, threading.Event] = {}


def _cache_dir() -> str:
    os.makedirs(DEFAULT_THUMBNAIL_CACHE_DIR, exist_ok=True)
    return DEFAULT_THUMBNAIL_CACHE_DIR


def _stable_path_token(source_path: str) -> str:
    """Identity that survives Windows↔Docker path remaps on the same mount.

    Prefer device+inode when available so `D:\\PhoneBackup\\...` and
    `/backup_storage/...` share one thumbnail cache entry. Fall back to a
    slash-normalized path string when inode is unavailable (e.g. some
    network/FAT mounts report st_ino == 0).
    """
    try:
        st = os.stat(source_path)
        if getattr(st, "st_ino", 0):
            return f"ino:{st.st_dev}:{st.st_ino}"
    except OSError:
        pass
    return source_path.replace("\\", "/").lower()


def _cache_key(source_path: str, mtime: float, size: int, *, prefix: str = "") -> str:
    raw = f"{prefix}{_stable_path_token(source_path)}:{mtime}:{size}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _run_options() -> dict:
    opts: dict = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.PIPE,
        "timeout": 20,
    }
    if os.name == "nt":
        opts["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = getattr(subprocess, "SW_HIDE", 0)
        opts["startupinfo"] = startupinfo
    return opts


def get_video_thumbnail_path(source_path: str) -> str | None:
    if not os.path.isfile(source_path):
        return None
    try:
        stat = os.stat(source_path)
    except OSError:
        return None

    key = _cache_key(source_path, stat.st_mtime, stat.st_size)
    out_path = os.path.join(_cache_dir(), f"{key}.jpg")
    if os.path.isfile(out_path):
        return out_path

    ffmpeg = resolve_ffmpeg_path()
    if not ffmpeg:
        return None

    # Deduplicate concurrent requests for the identical video
    event = None
    is_owner = False
    with _inflight_lock:
        if os.path.isfile(out_path):
            return out_path
        if key in _inflight:
            event = _inflight[key]
        else:
            event = threading.Event()
            _inflight[key] = event
            is_owner = True

    # If another thread is already building this exact thumbnail, wait for it
    if event and not is_owner:
        event.wait(timeout=20)
        return out_path if os.path.isfile(out_path) else None

    # We are the worker for this key
    try:
        with _thumbnail_semaphore:
            if os.path.isfile(out_path):
                return out_path

            partial = f"{out_path}.part-{os.getpid()}-{threading.get_ident()}"
            last_err = None
            for seek in ("0.5", "0"):
                cmd = [
                    ffmpeg, "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
                    "-ss", seek, "-i", source_path,
                    "-frames:v", "1",
                    "-vf", "scale=480:-2:flags=fast_bilinear",
                    "-threads", "1",
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
    finally:
        with _inflight_lock:
            evt = _inflight.pop(key, None)
            if evt:
                evt.set()


def get_image_thumbnail_path(source_path: str, max_size: int = 512) -> str | None:
    """Generate and return a fast, lightweight JPEG thumbnail for image files using Pillow."""
    if not os.path.isfile(source_path):
        return None
    try:
        stat = os.stat(source_path)
    except OSError:
        return None

    key = _cache_key(source_path, stat.st_mtime, stat.st_size, prefix=f"img_{max_size}_")
    out_path = os.path.join(_cache_dir(), f"{key}.jpg")
    if os.path.isfile(out_path):
        return out_path

    event = None
    is_owner = False
    with _inflight_lock:
        if os.path.isfile(out_path):
            return out_path
        if key in _inflight:
            event = _inflight[key]
        else:
            event = threading.Event()
            _inflight[key] = event
            is_owner = True

    if event and not is_owner:
        event.wait(timeout=10)
        return out_path if os.path.isfile(out_path) else None

    try:
        with _thumbnail_semaphore:
            if os.path.isfile(out_path):
                return out_path

            partial = f"{out_path}.part-{os.getpid()}-{threading.get_ident()}"
            try:
                import PIL.Image
                import PIL.ImageOps

                with PIL.Image.open(source_path) as img:
                    try:
                        img = PIL.ImageOps.exif_transpose(img)
                    except Exception:
                        pass
                    if img.mode not in ("RGB", "L"):
                        img = img.convert("RGB")
                    img.thumbnail((max_size, max_size), getattr(PIL.Image.Resampling, "BILINEAR", PIL.Image.BILINEAR))
                    img.save(partial, format="JPEG", quality=80, optimize=True)

                if os.path.isfile(partial) and os.path.getsize(partial) > 0:
                    os.replace(partial, out_path)
                    return out_path
            except Exception as e:
                pass
            finally:
                if os.path.isfile(partial):
                    try:
                        os.remove(partial)
                    except OSError:
                        pass
            return None
    finally:
        with _inflight_lock:
            evt = _inflight.pop(key, None)
            if evt:
                evt.set()


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


def warm_thumbnails(paths: list[str], limit: int = 12) -> None:
    """Best-effort prefetch of thumbnails (used after share/reel materialization)."""
    from video_preview import is_video_path

    for source_path in paths[: max(0, limit)]:
        try:
            if not source_path or not os.path.isfile(source_path):
                continue
            if is_video_path(source_path):
                get_video_thumbnail_path(source_path)
            else:
                get_image_thumbnail_path(source_path)
        except Exception:
            continue
