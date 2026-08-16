"""Rewind Reel: server-side generation of short slideshow videos stitched
from media_index entries for a given device + year (optionally + month).

Mirrors video_preview.py's ffmpeg-binary resolution, subprocess tracking,
and single-job serialization so desktop shutdown can terminate children cleanly.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import threading

from config import APP_DATA_DIR, load_config
from database import get_media_for_year_month
from ffmpeg_utils import resolve_ffmpeg_path
from memories import VIDEO_EXTS, _shared_sources_for_device
from state import add_log

DEFAULT_REWIND_CACHE_DIR = os.path.join(APP_DATA_DIR, "rewind_cache")

REEL_WIDTH = 1080
REEL_HEIGHT = 1920
PHOTO_DURATION_SEC = 2.0
VIDEO_CLIP_SEC = 3.0
MAX_ITEMS = 12
FFMPEG_STEP_TIMEOUT_SEC = 30
FFMPEG_CONCAT_TIMEOUT_SEC = 60

# Stills Android + typical ffmpeg builds can encode without extra codecs.
REWIND_STILL_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}

_generation_lock = threading.Lock()
_active_jobs: set[str] = set()
_failed_jobs: set[str] = set()
# Serialize reel ffmpeg work — unbounded parallel encodes thrash CPU/disk.
_build_semaphore = threading.Semaphore(1)

_ffmpeg_process_guard = threading.Lock()
_active_ffmpeg_process: subprocess.Popen | None = None


def _cache_dir() -> str:
    directory = DEFAULT_REWIND_CACHE_DIR
    os.makedirs(directory, exist_ok=True)
    return directory


def _ffmpeg_path() -> str | None:
    return resolve_ffmpeg_path()


def _run_options() -> dict:
    opts: dict = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
    }
    if os.name == "nt":
        opts["creationflags"] = subprocess.CREATE_NO_WINDOW
    return opts


def _run_ffmpeg(cmd: list[str], timeout: float) -> None:
    """Run one ffmpeg child, tracking it for cooperative shutdown (like video_preview)."""
    global _active_ffmpeg_process
    process = subprocess.Popen(cmd, **_run_options())
    with _ffmpeg_process_guard:
        _active_ffmpeg_process = process
    try:
        try:
            process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            raise
        if process.returncode:
            raise subprocess.CalledProcessError(process.returncode, cmd)
    finally:
        with _ffmpeg_process_guard:
            if _active_ffmpeg_process is process:
                _active_ffmpeg_process = None


def terminate_active_rewind_ffmpeg() -> bool:
    """Stop the in-flight rewind ffmpeg child so shutdown leaves no orphans."""
    with _ffmpeg_process_guard:
        process = _active_ffmpeg_process
    if not process or process.poll() is not None:
        return False
    try:
        process.kill()
        process.wait(timeout=5)
    except Exception:
        return False
    return True


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


def _sample_evenly(items: list[dict], limit: int) -> list[dict]:
    """Spread picks across the year/month so a reel isn't just January."""
    if len(items) <= limit:
        return items
    if limit <= 1:
        return items[:1]
    step = (len(items) - 1) / (limit - 1)
    indices = sorted({min(len(items) - 1, int(round(i * step))) for i in range(limit)})
    picked = set(indices)
    for i in range(len(items)):
        if len(picked) >= limit:
            break
        picked.add(i)
    return [items[i] for i in sorted(picked)[:limit]]


def _is_rewind_usable(item: dict) -> bool:
    ext = os.path.splitext(item["relative_path"])[1].lower()
    return ext in VIDEO_EXTS or ext in REWIND_STILL_EXTS


def get_reel_items(device_id: str, year: int, month: int | None) -> list[dict]:
    shared_dirs = load_config().get("SHARED_DIRS", [])
    sources, _ = _shared_sources_for_device(device_id, shared_dirs)
    pool = get_media_for_year_month(sources, year, month, limit=max(MAX_ITEMS * 20, 200))
    usable = [it for it in pool if _is_rewind_usable(it)]
    return _sample_evenly(usable, MAX_ITEMS)


def get_rewind_status(device_id: str, year: int, month: int | None) -> dict:
    # DB / filesystem work outside the job-set lock.
    items = get_reel_items(device_id, year, month)
    if not items:
        return {"status": "none", "ready": False}

    job_key = _job_key(device_id, year, month)
    cache_key = _cache_key(device_id, year, month, items)
    path = _reel_path(cache_key)
    ready_on_disk = os.path.isfile(path)

    with _generation_lock:
        if ready_on_disk:
            return {"status": "ready", "ready": True}
        if job_key in _active_jobs:
            return {"status": "generating", "ready": False}
        if job_key in _failed_jobs:
            return {"status": "failed", "ready": False}
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
        f"pad={REEL_WIDTH}:{REEL_HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p"
    )
    common_out = [
        "-vf", vf,
        "-c:v", "libx264", "-preset", "fast", "-pix_fmt", "yuv420p",
        "-r", "30", "-an", "-movflags", "+faststart",
        seg_path,
    ]
    if is_video:
        cmd = [ffmpeg, "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
               "-i", src_path, "-t", str(VIDEO_CLIP_SEC), *common_out]
    else:
        cmd = [ffmpeg, "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
               "-loop", "1", "-framerate", "30", "-i", src_path, "-t", str(PHOTO_DURATION_SEC), *common_out]
    try:
        _run_ffmpeg(cmd, FFMPEG_STEP_TIMEOUT_SEC)
        return os.path.isfile(seg_path)
    except Exception as e:
        add_log(f"[Rewind] segment build failed for {src_path}: {e}")
        return False


def _build_reel_sync(device_id: str, year: int, month: int | None) -> None:
    job_key = _job_key(device_id, year, month)
    success = False
    try:
        with _build_semaphore:
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
                success = True
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
                    if not is_video and ext not in REWIND_STILL_EXTS:
                        continue
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
                    ffmpeg, "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
                    "-f", "concat", "-safe", "0", "-i", list_file,
                    "-c", "copy", "-movflags", "+faststart", out_path,
                ]
                _run_ffmpeg(concat_cmd, FFMPEG_CONCAT_TIMEOUT_SEC)
                success = os.path.isfile(out_path)
                add_log(f"[Rewind] built reel for {device_id} {year}/{month or 'all'} ({len(segments)} clips)")
            finally:
                shutil.rmtree(work_dir, ignore_errors=True)
    except Exception as e:
        add_log(f"[Rewind] build failed: {e}")
    finally:
        with _generation_lock:
            _active_jobs.discard(job_key)
            if success:
                _failed_jobs.discard(job_key)
            else:
                _failed_jobs.add(job_key)


def start_rewind_build(device_id: str, year: int, month: int | None) -> dict:
    job_key = _job_key(device_id, year, month)

    # Resolve readiness without holding the job-set lock across DB I/O.
    items = get_reel_items(device_id, year, month)
    if not items:
        return {"ok": False, "status": "none"}

    cache_key = _cache_key(device_id, year, month, items)
    if os.path.isfile(_reel_path(cache_key)):
        return {"ok": True, "status": "ready"}

    with _generation_lock:
        if job_key in _active_jobs:
            return {"ok": True, "status": "generating"}
        _failed_jobs.discard(job_key)
        _active_jobs.add(job_key)

    threading.Thread(
        target=_build_reel_sync,
        args=(device_id, year, month),
        daemon=True,
        name=f"rewind-{job_key}",
    ).start()
    return {"ok": True, "status": "generating"}
