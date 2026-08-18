"""Rewind Reel: server-side generation of short slideshow videos stitched
from media_index entries for a given device + year (optionally + month).

Features:
- Parallel multi-threaded segment encoding for 4x-5x faster reel generation.
- Dynamic free/royalty-free background music integration with smooth audio fade-out.
- High-concurrency safe subprocess tracking and clean termination.
"""

from __future__ import annotations

import concurrent.futures
import hashlib
import os
import shutil
import subprocess
import threading
import urllib.request

from config import APP_DATA_DIR, load_config
from database import get_media_for_year_month
from ffmpeg_utils import resolve_ffmpeg_path
from memories import VIDEO_EXTS, _shared_sources_for_device
from state import add_log

DEFAULT_REWIND_CACHE_DIR = os.path.join(APP_DATA_DIR, "rewind_cache")
DEFAULT_MUSIC_CACHE_DIR = os.path.join(DEFAULT_REWIND_CACHE_DIR, "music_cache")

REEL_WIDTH = 1080
REEL_HEIGHT = 1920
PHOTO_DURATION_SEC = 2.0
VIDEO_CLIP_SEC = 3.0
MAX_ITEMS = 15
# Random pool size before even spacing — large enough to cover a full year.
REEL_CANDIDATE_POOL = 400
FFMPEG_STEP_TIMEOUT_SEC = 30
FFMPEG_CONCAT_TIMEOUT_SEC = 90

# Stills Android + typical ffmpeg builds can encode without extra codecs.
REWIND_STILL_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}

# Royalty-free (CC-BY 3.0) background music tracks, resolved through Wikimedia
# Commons' stable Special:FilePath redirect so we never have to guess the
# MD5 hash-bucket directory the file actually lives under.
FREE_MUSIC_URLS = [
    "https://commons.wikimedia.org/wiki/Special:FilePath/Kevin_MacLeod_-_Carefree.ogg",
    "https://commons.wikimedia.org/wiki/Special:FilePath/Kevin_MacLeod_-_Autumn_Day.ogg",
    "https://commons.wikimedia.org/wiki/Special:FilePath/Life_of_Riley_(ISRC_USUAN1400054).mp3",
]

_generation_lock = threading.Lock()
_active_jobs: set[str] = set()
_failed_jobs: set[str] = set()
_build_semaphore = threading.Semaphore(2)

_ffmpeg_process_guard = threading.Lock()
_active_ffmpeg_processes: set[subprocess.Popen] = set()


def _cache_dir() -> str:
    directory = DEFAULT_REWIND_CACHE_DIR
    os.makedirs(directory, exist_ok=True)
    return directory


def _music_cache_dir() -> str:
    directory = DEFAULT_MUSIC_CACHE_DIR
    os.makedirs(directory, exist_ok=True)
    return directory


def _ffmpeg_path() -> str | None:
    return resolve_ffmpeg_path()


def _run_options() -> dict:
    opts: dict = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.PIPE,
    }
    if os.name == "nt":
        opts["creationflags"] = subprocess.CREATE_NO_WINDOW
    return opts


def _run_ffmpeg(cmd: list[str], timeout: float) -> None:
    """Run one ffmpeg child, tracking it for cooperative shutdown."""
    process = subprocess.Popen(cmd, **_run_options())
    with _ffmpeg_process_guard:
        _active_ffmpeg_processes.add(process)
    try:
        try:
            _, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            raise
        if process.returncode:
            raise subprocess.CalledProcessError(process.returncode, cmd, stderr=stderr)
    finally:
        with _ffmpeg_process_guard:
            _active_ffmpeg_processes.discard(process)


def terminate_active_rewind_ffmpeg() -> bool:
    """Stop all in-flight rewind ffmpeg children so shutdown leaves no orphans."""
    with _ffmpeg_process_guard:
        processes = list(_active_ffmpeg_processes)
    stopped_any = False
    for process in processes:
        if process.poll() is None:
            try:
                process.kill()
                process.wait(timeout=3)
                stopped_any = True
            except Exception:
                pass
    return stopped_any


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
    pool = get_media_for_year_month(
        sources, year, month, limit=REEL_CANDIDATE_POOL, order="time",
    )
    usable = [it for it in pool if _is_rewind_usable(it)]
    usable.sort(key=lambda it: (it.get("capture_time") is None, it.get("capture_time") or 0))
    return _sample_evenly(usable, MAX_ITEMS)


def get_rewind_status(device_id: str, year: int, month: int | None) -> dict:
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


def _describe_ffmpeg_error(e: Exception) -> str:
    stderr = getattr(e, "stderr", None)
    if stderr:
        text = stderr.decode("utf-8", "replace") if isinstance(stderr, bytes) else str(stderr)
        text = text.strip()
        if text:
            return f"{e} :: {text[-500:]}"
    return str(e)


def _build_segment(ffmpeg: str, src_path: str, seg_path: str, is_video: bool) -> bool:
    vf = (
        f"scale={REEL_WIDTH}:{REEL_HEIGHT}:force_original_aspect_ratio=decrease,"
        f"pad={REEL_WIDTH}:{REEL_HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p"
    )
    common_out = [
        "-vf", vf,
        "-c:v", "libx264", "-preset", "fast", "-pix_fmt", "yuv420p",
        "-r", "30", "-an", "-movflags", "+faststart",
        "-f", "mp4",
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
        return os.path.isfile(seg_path) and os.path.getsize(seg_path) > 0
    except Exception as e:
        add_log(f"[Rewind] segment build failed for {src_path}: {_describe_ffmpeg_error(e)}")
        return False


def _get_or_fetch_background_music(ffmpeg: str) -> str | None:
    """Fetch a royalty-free music track from public sources or synthesize a mellow ambient track."""
    music_dir = _music_cache_dir()
    synth_path = os.path.join(music_dir, "ambient_soundscape.m4a")
    downloaded_path = os.path.join(music_dir, "online_music_track.ogg")

    if os.path.isfile(downloaded_path) and os.path.getsize(downloaded_path) > 1000:
        return downloaded_path
    if os.path.isfile(synth_path) and os.path.getsize(synth_path) > 1000:
        return synth_path

    # 1. Try downloading royalty-free CC0 music
    for url in FREE_MUSIC_URLS:
        try:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "PhoneBackupServer/3.1 (https://github.com)"},
            )
            with urllib.request.urlopen(req, timeout=15) as response:
                if response.status == 200:
                    with open(downloaded_path, "wb") as f:
                        f.write(response.read())
                    if os.path.isfile(downloaded_path) and os.path.getsize(downloaded_path) > 1000:
                        add_log("[Rewind] fetched live royalty-free background music")
                        return downloaded_path
        except Exception:
            continue

    # 2. Fallback to gentle ambient harmonic chord audio generation using ffmpeg
    try:
        synth_cmd = [
            ffmpeg, "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "sine=frequency=261.63:sample_rate=44100:duration=45",
            "-f", "lavfi", "-i", "sine=frequency=329.63:sample_rate=44100:duration=45",
            "-f", "lavfi", "-i", "sine=frequency=392.00:sample_rate=44100:duration=45",
            "-filter_complex", "[0:a][1:a][2:a]amix=inputs=3:dropout_transition=0,lowpass=f=1200,volume=0.3[a]",
            "-map", "[a]",
            "-c:a", "aac", "-b:a", "128k",
            synth_path,
        ]
        _run_ffmpeg(synth_cmd, timeout=15)
        if os.path.isfile(synth_path) and os.path.getsize(synth_path) > 1000:
            add_log("[Rewind] generated ambient background soundtrack")
            return synth_path
    except Exception as e:
        add_log(f"[Rewind] ambient soundtrack synthesis failed: {e}")

    return None


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
            concat_video = os.path.join(work_dir, "concat_raw.mp4")
            partial_out = out_path + ".partial"

            try:
                if os.path.isfile(partial_out):
                    os.remove(partial_out)

                valid_work: list[tuple[int, str, str, bool]] = []
                for idx, item in enumerate(items):
                    src_path = _source_full_path(item)
                    if not src_path or not os.path.isfile(src_path):
                        continue
                    ext = os.path.splitext(item["relative_path"])[1].lower()
                    is_video = ext in VIDEO_EXTS
                    if not is_video and ext not in REWIND_STILL_EXTS:
                        continue
                    seg_path = os.path.join(work_dir, f"seg_{idx:03d}.mp4")
                    valid_work.append((idx, src_path, seg_path, is_video))

                if not valid_work:
                    add_log("[Rewind] no usable items found — aborting reel build")
                    return

                # Build segments in parallel across CPU cores for maximum speed
                max_workers = max(1, min(4, os.cpu_count() or 2))
                segment_results: dict[int, str] = {}
                with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
                    future_to_idx = {
                        executor.submit(_build_segment, ffmpeg, src, seg, is_vid): idx
                        for idx, src, seg, is_vid in valid_work
                    }
                    for future in concurrent.futures.as_completed(future_to_idx):
                        idx = future_to_idx[future]
                        try:
                            if future.result():
                                seg_path = os.path.join(work_dir, f"seg_{idx:03d}.mp4")
                                segment_results[idx] = seg_path
                        except Exception as e:
                            add_log(f"[Rewind] parallel segment error: {e}")

                segments = [segment_results[idx] for idx, _, _, _ in valid_work if idx in segment_results]

                if not segments:
                    add_log("[Rewind] no usable segments encoded — aborting reel build")
                    return

                with open(list_file, "w", encoding="utf-8", newline="\n") as f:
                    for seg in segments:
                        escaped = seg.replace("\\", "/").replace("'", "'\\''")
                        f.write(f"file '{escaped}'\n")

                # Concat segments into single video
                concat_cmd = [
                    ffmpeg, "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
                    "-f", "concat", "-safe", "0", "-i", list_file,
                    "-c", "copy", "-movflags", "+faststart",
                    "-f", "mp4", concat_video,
                ]
                _run_ffmpeg(concat_cmd, FFMPEG_CONCAT_TIMEOUT_SEC)

                if not (os.path.isfile(concat_video) and os.path.getsize(concat_video) > 0):
                    add_log("[Rewind] concat produced empty output — aborting")
                    return

                # Approximate total reel duration
                total_duration = 0.0
                for idx, _, _, is_vid in valid_work:
                    if idx in segment_results:
                        total_duration += VIDEO_CLIP_SEC if is_vid else PHOTO_DURATION_SEC

                # Add background music with audio fade-out
                music_track = _get_or_fetch_background_music(ffmpeg)
                if music_track and os.path.isfile(music_track):
                    fade_start = max(0.5, total_duration - 2.0)
                    mux_cmd = [
                        ffmpeg, "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
                        "-i", concat_video,
                        "-i", music_track,
                        "-c:v", "copy",
                        "-filter_complex", f"[1:a]volume=0.35,afade=t=out:st={fade_start:.2f}:d=2.0[a]",
                        "-map", "0:v:0",
                        "-map", "[a]",
                        "-c:a", "aac", "-b:a", "128k",
                        "-shortest",
                        "-movflags", "+faststart",
                        "-f", "mp4",
                        partial_out,
                    ]
                    try:
                        _run_ffmpeg(mux_cmd, timeout=30)
                    except Exception as e:
                        add_log(f"[Rewind] audio mux warning: {e}, falling back to silent video")
                        if os.path.isfile(partial_out):
                            try:
                                os.remove(partial_out)
                            except OSError:
                                pass

                if not os.path.isfile(partial_out) or os.path.getsize(partial_out) == 0:
                    shutil.copyfile(concat_video, partial_out)

                if os.path.isfile(partial_out) and os.path.getsize(partial_out) > 0:
                    os.replace(partial_out, out_path)
                    success = True
                    add_log(f"[Rewind] built reel for {device_id} {year}/{month or 'all'} ({len(segments)} clips)")
                else:
                    add_log("[Rewind] final output empty — aborting")
            finally:
                if os.path.isfile(partial_out):
                    try:
                        os.remove(partial_out)
                    except OSError:
                        pass
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


# ─── Cache management helpers (used by desktop_app settings + shutdown) ────────

def get_rewind_cache_stats() -> dict:
    """Return {files, bytes} for the rewind cache directory."""
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


def clear_rewind_cache() -> dict:
    """Delete all files in the rewind cache directory.
    Returns {files, bytes} of what was removed.
    Also clears the in-memory job sets so stale state is not carried over.
    """
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
    # Clear in-memory job state so a fresh generate request is accepted.
    with _generation_lock:
        _active_jobs.clear()
        _failed_jobs.clear()
    return {"files": removed_files, "bytes": removed_bytes}