"""Rewind Reel: server-side generation of short slideshow videos stitched
from media_index entries for a given device + year (optionally + month).

Mirrors video_preview.py's ffmpeg-binary resolution and cache-directory
conventions, but builds a new concatenated MP4 instead of transcoding a
single source file.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
import threading
from functools import lru_cache

from config import APP_DATA_DIR, load_config
from database import get_media_for_year_month
from memories import VIDEO_EXTS, _shared_sources_for_device
from state import add_log

DEFAULT_REWIND_CACHE_DIR = os.path.join(APP_DATA_DIR, "rewind_cache")

REEL_WIDTH = 1080
REEL_HEIGHT = 1920
PHOTO_DURATION_SEC = 2.0
VIDEO_CLIP_SEC = 3.0
MAX_ITEMS = 18
FFMPEG_STEP_TIMEOUT_SEC = 30
FFMPEG_CONCAT_TIMEOUT_SEC = 60

_generation_lock = threading.Lock()
_active_jobs: set[str] = set()


def _cache_dir() -> str:
    directory = DEFAULT_REWIND_CACHE_DIR
    os.makedirs(directory, exist_ok=True)
    return directory


@lru_cache(maxsize=1)
def _ffmpeg_path() -> str | None:
    executable = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    bundle_dir = getattr(sys, "_MEIPASS", None)
    if bundle_dir:
        bundled_path = os.path.join(bundle_dir, executable)
        if os.path.isfile(bundled_path):
            return bundled_path
    return shutil.which("ffmpeg")


def _run_options() -> dict:
    opts: dict = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    if os.name == "nt":
        opts["creationflags"] = subprocess.CREATE_NO_WINDOW
    return opts


def _cache_key(device_id: str, year: int, month: int | None, items: list[dict]) -> str:
    sig = "|".join(
        f"{it['source_type']}:{it['source_key']}:{it['relative_path']}:{it['modified_time']}"
        for it in items
    )
    raw = f"{device_id}:{year}:{month or 0}:{sig}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def _reel_path(cache_key: str) -> str:
    return os.path.join(_cache_dir(), f"reel_{cache_key}.mp4")


def _job_key(device_id: str, year: int, month: int | None) -> str:
    return f"{device_id}:{year}:{month or 0}"


def _shared_full_path(item: dict) -> str | None:
    shared_dirs = load_config().get("SHARED_DIRS", [])
    for s in shared_dirs:
        if s.get("id") == item["source_key"]:
            root = s.get("path")
            if root:
                return os.path.join(root, item["relative_path"])
    return None


def _source_full_path(item: dict) -> str | None:
    if item["source_type"] == "phone":
        from storage import full_path_for
        try:
            return full_path_for(item["relative_path"], device_id=item["source_key"])
        except Exception:
            return None
    return _shared_full_path(item)


def get_reel_items(device_id: str, year: int, month: int | None) -> list[dict]:
    shared_dirs = load_config().get("SHARED_DIRS", [])
    sources, _ = _shared_sources_for_device(device_id, shared_dirs)
    return get_media_for_year_month(sources, year, month, limit=MAX_ITEMS)


def get_rewind_status(device_id: str, year: int, month: int | None) -> dict:
    items = get_reel_items(device_id, year, month)
    if not items:
        return {"status": "none", "ready": False}

    cache_key = _cache_key(device_id, year, month, items)
    if os.path.isfile(_reel_path(cache_key)):
        return {"status": "ready", "ready": True}
    if _job_key(device_id, year, month) in _active_jobs:
        return {"status": "generating", "ready": False}
    return {"status": "not_generated", "ready": False}


def get_rewind_path(device_id: str, year: int, month: int | None) -> str | None:
    items = get_reel_items(device_id, year, month)
    if not items:
        return None
    cache_key = _cache_key(device_id, year, month, items)
    path = _reel_path(cache_key)
    return path if os.path.isfile(path) else None


def _build_segment(ffmpeg: str, src_path: str, seg_path: str, is_video: bool) -> bool:
    vf = (
        f"scale={REEL_WIDTH}:{REEL_HEIGHT}:force_original_aspect_ratio=decrease,"
        f"pad={REEL_WIDTH}:{REEL_HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1"
    )
    if is_video:
        cmd = [
            ffmpeg, "-y", "-i", src_path, "-t", str(VIDEO_CLIP_SEC),
            "-vf", vf, "-c:v", "libx264", "-preset", "fast", "-an", seg_path,
        ]
    else:
        cmd = [
            ffmpeg, "-y", "-loop", "1", "-i", src_path, "-t", str(PHOTO_DURATION_SEC),
            "-vf", vf, "-c:v", "libx264", "-preset", "fast", "-an", seg_path,
        ]
    try:
        subprocess.run(cmd, timeout=FFMPEG_STEP_TIMEOUT_SEC, check=True, **_run_options())
        return os.path.isfile(seg_path)
    except Exception as e:
        add_log(f"[Rewind] segment build failed for {src_path}: {e}")
        return False


def _build_reel_sync(device_id: str, year: int, month: int | None) -> None:
    job_key = _job_key(device_id, year, month)
    try:
        ffmpeg = _ffmpeg_path()
        if not ffmpeg:
            add_log("[Rewind] ffmpeg not found — cannot build reel")
            return

        items = get_reel_items(device_id, year, month)
        if not items:
            return

        cache_key = _cache_key(device_id, year, month, items)
        out_path = _reel_path(cache_key)
        if os.path.isfile(out_path):
            return

        work_dir = os.path.join(_cache_dir(), f"tmp_{cache_key}")
        os.makedirs(work_dir, exist_ok=True)
        list_file = os.path.join(work_dir, "concat.txt")

        try:
            segments = []
            for idx, item in enumerate(items):
                src_path = _source_full_path(item)
                if not src_path or not os.path.isfile(src_path):
                    continue

                ext = os.path.splitext(item["relative_path"])[1].lower()
                is_video = ext in VIDEO_EXTS
                seg_path = os.path.join(work_dir, f"seg_{idx:03d}.mp4")
                if _build_segment(ffmpeg, src_path, seg_path, is_video):
                    segments.append(seg_path)

            if not segments:
                add_log("[Rewind] no usable segments — aborting reel build")
                return

            with open(list_file, "w", encoding="utf-8") as f:
                for seg in segments:
                    escaped = seg.replace("'", "'\\''")
                    f.write(f"file '{escaped}'\n")

            concat_cmd = [
                ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", list_file,
                "-c", "copy", out_path,
            ]
            subprocess.run(concat_cmd, timeout=FFMPEG_CONCAT_TIMEOUT_SEC, check=True, **_run_options())
            add_log(f"[Rewind] built reel for {device_id} {year}/{month or 'all'} ({len(segments)} clips)")
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)
    except Exception as e:
        add_log(f"[Rewind] build failed: {e}")
    finally:
        with _generation_lock:
            _active_jobs.discard(job_key)


def start_rewind_build(device_id: str, year: int, month: int | None) -> dict:
    job_key = _job_key(device_id, year, month)
    with _generation_lock:
        if job_key in _active_jobs:
            return {"ok": True, "status": "generating"}

        status = get_rewind_status(device_id, year, month)
        if status["status"] == "ready":
            return {"ok": True, "status": "ready"}
        if status["status"] == "none":
            return {"ok": False, "status": "none"}

        _active_jobs.add(job_key)

    threading.Thread(target=_build_reel_sync, args=(device_id, year, month), daemon=True).start()
    return {"ok": True, "status": "generating"}
