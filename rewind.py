"""Rewind Reel: server-side generation of short slideshow videos stitched
from media_index entries for a given device + year (optionally + month).

Features:
- Ultra-fast parallel multi-threaded segment encoding (ultrafast still-image pipelines).
- Stratified temporal random sampling for diverse, non-repetitive reels on every generation.
- Rich multi-track background music library with multiple procedural ambient synthesizers
  and online royalty-free soundtracks.
- High-concurrency safe subprocess tracking and clean termination.
"""

from __future__ import annotations

import concurrent.futures
import hashlib
import os
import random
import shutil
import subprocess
import threading
import time
import urllib.request

from config import APP_DATA_DIR, load_config
from database import get_media_for_year_month
from ffmpeg_utils import resolve_ffmpeg_path
from memories import VIDEO_EXTS, _shared_sources_for_device
from state import add_log

DEFAULT_REWIND_CACHE_DIR = os.path.join(APP_DATA_DIR, "rewind_cache")
DEFAULT_MUSIC_CACHE_DIR = os.path.join(APP_DATA_DIR, "music_cache")


REEL_WIDTH = 1080
REEL_HEIGHT = 1920
PHOTO_DURATION_SEC = 2.0
VIDEO_CLIP_SEC = 3.0
MAX_ITEMS = 15
# Random pool size before temporal bucketing — large enough to cover a full year.
REEL_CANDIDATE_POOL = 400
FFMPEG_STEP_TIMEOUT_SEC = 30
FFMPEG_CONCAT_TIMEOUT_SEC = 90

# Stills Android + typical ffmpeg builds can encode without extra codecs.
REWIND_STILL_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}

# Verified direct royalty-free music sources (Creative Commons CC0 / CC-BY) — PRIORITIZED
PRIORITY_MUSIC_TRACKS = [
    {
        "name": "carefree.ogg",
        "url": "https://upload.wikimedia.org/wikipedia/commons/5/58/Kevin_MacLeod_-_Carefree.ogg",
    },
    {
        "name": "autumn_day.ogg",
        "url": "https://upload.wikimedia.org/wikipedia/commons/5/59/Kevin_MacLeod_-_Autumn_Day.ogg",
    },
    {
        "name": "life_of_riley.mp3",
        "url": "https://upload.wikimedia.org/wikipedia/commons/2/2e/Life_of_Riley_%28ISRC_USUAN1400054%29.mp3",
    },
    {
        "name": "monkeys_spinning_monkeys.ogg",
        "url": "https://upload.wikimedia.org/wikipedia/commons/3/37/Kevin_MacLeod_-_Monkeys_Spinning_Monkeys.ogg",
    },
    {
        "name": "fluffing_a_duck.ogg",
        "url": "https://upload.wikimedia.org/wikipedia/commons/c/c3/Kevin_MacLeod_-_Fluffing_a_Duck.ogg",
    },
    {
        "name": "canon_in_d.mp3",
        "url": "https://upload.wikimedia.org/wikipedia/commons/c/c6/Canon_in_D_Major_%28ISRC_USUAN1100301%29.mp3",
    },
]

# Multiple procedurally synthesized ambient music styles (offline fallback, optimized for phone speakers)
SYNTH_PRESETS = [
    {
        "filename": "ambient_warm_acoustic.m4a",
        "filter": "[0:a][1:a][2:a][3:a]amix=inputs=4:dropout_transition=0,lowpass=f=3500,volume=0.85[a]",
        "inputs": [
            "sine=frequency=261.63:sample_rate=44100:duration=50",  # C4
            "sine=frequency=329.63:sample_rate=44100:duration=50",  # E4
            "sine=frequency=392.00:sample_rate=44100:duration=50",  # G4
            "sine=frequency=523.25:sample_rate=44100:duration=50",  # C5
        ],
    },
    {
        "filename": "ambient_dreamy_nostalgia.m4a",
        "filter": "[0:a][1:a][2:a][3:a]amix=inputs=4:dropout_transition=0,lowpass=f=3200,volume=0.85[a]",
        "inputs": [
            "sine=frequency=220.00:sample_rate=44100:duration=50",  # A3
            "sine=frequency=261.63:sample_rate=44100:duration=50",  # C4
            "sine=frequency=329.63:sample_rate=44100:duration=50",  # E4
            "sine=frequency=440.00:sample_rate=44100:duration=50",  # A4
        ],
    },
    {
        "filename": "ambient_lofi_pad.m4a",
        "filter": "[0:a][1:a][2:a][3:a]amix=inputs=4:dropout_transition=0,lowpass=f=2800,volume=0.90[a]",
        "inputs": [
            "sine=frequency=174.61:sample_rate=44100:duration=50",  # F3
            "sine=frequency=220.00:sample_rate=44100:duration=50",  # A3
            "sine=frequency=261.63:sample_rate=44100:duration=50",  # C4
            "sine=frequency=329.63:sample_rate=44100:duration=50",  # E4 (Fmaj7)
        ],
    },
    {
        "filename": "ambient_uplifting_horizon.m4a",
        "filter": "[0:a][1:a][2:a][3:a]amix=inputs=4:dropout_transition=0,lowpass=f=3800,volume=0.85[a]",
        "inputs": [
            "sine=frequency=196.00:sample_rate=44100:duration=50",  # G3
            "sine=frequency=246.94:sample_rate=44100:duration=50",  # B3
            "sine=frequency=293.66:sample_rate=44100:duration=50",  # D4
            "sine=frequency=392.00:sample_rate=44100:duration=50",  # G4
        ],
    },
    {
        "filename": "ambient_calm_waters.m4a",
        "filter": "[0:a][1:a][2:a][3:a]amix=inputs=4:dropout_transition=0,lowpass=f=3200,volume=0.85[a]",
        "inputs": [
            "sine=frequency=164.81:sample_rate=44100:duration=50",  # E3
            "sine=frequency=246.94:sample_rate=44100:duration=50",  # B3
            "sine=frequency=329.63:sample_rate=44100:duration=50",  # E4
            "sine=frequency=392.00:sample_rate=44100:duration=50",  # G4 (Em7)
        ],
    },
]


_generation_lock = threading.Lock()
_active_jobs: set[str] = set()
_failed_jobs: set[str] = set()
_build_semaphore = threading.Semaphore(max(2, min(4, (os.cpu_count() or 4) // 2)))

_ffmpeg_process_guard = threading.Lock()
_active_ffmpeg_processes: set[subprocess.Popen] = set()

_music_fetch_lock = threading.Lock()

# Pointer tracking for latest generated reels per job_key (device_id:year:month)
_latest_reels_lock = threading.Lock()
_latest_reels: dict[str, str] = {}


def _cache_dir() -> str:
    directory = DEFAULT_REWIND_CACHE_DIR
    os.makedirs(directory, exist_ok=True)
    return directory


def _music_cache_dir() -> str:
    directory = DEFAULT_MUSIC_CACHE_DIR
    os.makedirs(directory, exist_ok=True)
    # Migrate any legacy files from rewind_cache/music_cache if they exist
    legacy_dir = os.path.join(DEFAULT_REWIND_CACHE_DIR, "music_cache")
    if os.path.isdir(legacy_dir) and os.path.abspath(legacy_dir) != os.path.abspath(directory):
        try:
            for fname in os.listdir(legacy_dir):
                src = os.path.join(legacy_dir, fname)
                dst = os.path.join(directory, fname)
                if os.path.isfile(src) and not os.path.exists(dst):
                    shutil.copy2(src, dst)
        except Exception:
            pass
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


def _cache_key(device_id: str, year: int, month: int | None, items: list[dict], nonce: str | None = None) -> str:
    sig = "|".join(
        f"{it['source_type']}:{it['source_key']}:{it['relative_path']}:{it['modified_time']}"
        for it in items
    )
    raw = f"{device_id}:{year}:{month or 0}:{sig}:{nonce or ''}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def _reel_path(cache_key: str) -> str:
    return os.path.join(_cache_dir(), f"reel_{cache_key}.mp4")


def _job_key(device_id: str, year: int, month: int | None) -> str:
    return f"{device_id}:{year}:{month or 0}"


def _pointer_file(job_key: str) -> str:
    safe_key = job_key.replace(":", "_")
    return os.path.join(_cache_dir(), f"latest_{safe_key}.txt")


def _get_latest_reel_path(device_id: str, year: int, month: int | None) -> str | None:
    job_key = _job_key(device_id, year, month)
    with _latest_reels_lock:
        if job_key in _latest_reels:
            p = _latest_reels[job_key]
            if os.path.isfile(p) and os.path.getsize(p) > 0:
                return p

    # Check pointer file on disk
    ptr = _pointer_file(job_key)
    if os.path.isfile(ptr):
        try:
            with open(ptr, "r", encoding="utf-8") as f:
                path = f.read().strip()
            if os.path.isfile(path) and os.path.getsize(path) > 0:
                with _latest_reels_lock:
                    _latest_reels[job_key] = path
                return path
        except Exception:
            pass
    return None


def _set_latest_reel_path(device_id: str, year: int, month: int | None, path: str) -> None:
    job_key = _job_key(device_id, year, month)
    with _latest_reels_lock:
        _latest_reels[job_key] = path
    ptr = _pointer_file(job_key)
    try:
        with open(ptr, "w", encoding="utf-8") as f:
            f.write(path)
    except Exception:
        pass


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


def _sample_with_temporal_diversity(items: list[dict], limit: int = MAX_ITEMS) -> list[dict]:
    """Sample media items across the timeframe with random variation while

    maintaining full chronological spread and timeline coverage.
    """
    if not items:
        return []
    if len(items) <= limit:
        return sorted(items, key=lambda it: (it.get("capture_time") is None, it.get("capture_time") or 0))

    # Divide candidate items into `limit` temporal buckets
    bucket_size = len(items) / float(limit)
    selected = []
    for i in range(limit):
        start_idx = int(i * bucket_size)
        end_idx = int((i + 1) * bucket_size)
        bucket = items[start_idx:max(start_idx + 1, end_idx)]
        if bucket:
            # Pick a random candidate from this temporal slice
            chosen = random.choice(bucket)
            selected.append(chosen)

    # Sort chosen items chronologically for smooth story progression
    selected.sort(key=lambda it: (it.get("capture_time") is None, it.get("capture_time") or 0))
    return selected


def _is_rewind_usable(item: dict) -> bool:
    ext = os.path.splitext(item["relative_path"])[1].lower()
    return ext in VIDEO_EXTS or ext in REWIND_STILL_EXTS


def get_reel_items(device_id: str, year: int, month: int | None, randomize: bool = False) -> list[dict]:
    shared_dirs = load_config().get("SHARED_DIRS", [])
    sources, _ = _shared_sources_for_device(device_id, shared_dirs)
    pool = get_media_for_year_month(
        sources, year, month, limit=REEL_CANDIDATE_POOL, order="time",
    )
    usable = [it for it in pool if _is_rewind_usable(it)]
    usable.sort(key=lambda it: (it.get("capture_time") is None, it.get("capture_time") or 0))
    if not usable:
        return []
    return _sample_with_temporal_diversity(usable, MAX_ITEMS)


def get_rewind_status(device_id: str, year: int, month: int | None) -> dict:
    job_key = _job_key(device_id, year, month)

    with _generation_lock:
        if job_key in _active_jobs:
            return {"status": "generating", "ready": False}

    latest_path = _get_latest_reel_path(device_id, year, month)
    if latest_path and os.path.isfile(latest_path) and os.path.getsize(latest_path) > 0:
        return {"status": "ready", "ready": True}

    with _generation_lock:
        if job_key in _failed_jobs:
            return {"status": "failed", "ready": False}

    # Check if any items exist for this timeframe
    shared_dirs = load_config().get("SHARED_DIRS", [])
    sources, _ = _shared_sources_for_device(device_id, shared_dirs)
    pool = get_media_for_year_month(sources, year, month, limit=5, order="time")
    if not pool:
        return {"status": "none", "ready": False}

    return {"status": "not_generated", "ready": False}


def get_rewind_path(device_id: str, year: int, month: int | None) -> str | None:
    latest_path = _get_latest_reel_path(device_id, year, month)
    if latest_path and os.path.isfile(latest_path) and os.path.getsize(latest_path) > 0:
        return latest_path
    return None


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
    if is_video:
        cmd = [
            ffmpeg, "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
            "-i", src_path,
            "-t", str(VIDEO_CLIP_SEC),
            "-vf", vf,
            "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
            "-r", "30", "-threads", "2", "-an", "-movflags", "+faststart",
            "-f", "mp4",
            seg_path,
        ]
    else:
        cmd = [
            ffmpeg, "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
            "-loop", "1", "-framerate", "30", "-i", src_path,
            "-t", str(PHOTO_DURATION_SEC),
            "-vf", vf,
            "-c:v", "libx264", "-preset", "ultrafast", "-tune", "stillimage", "-g", "30", "-pix_fmt", "yuv420p",
            "-r", "30", "-threads", "2", "-an", "-movflags", "+faststart",
            "-f", "mp4",
            seg_path,
        ]
    try:
        _run_ffmpeg(cmd, FFMPEG_STEP_TIMEOUT_SEC)
        return os.path.isfile(seg_path) and os.path.getsize(seg_path) > 0
    except Exception as e:
        add_log(f"[Rewind] segment build failed for {src_path}: {_describe_ffmpeg_error(e)}")
        return False


def _get_or_fetch_background_music(ffmpeg: str, chosen_index: int | None = None) -> str | None:
    """Prioritize real royalty-free music tracks first; fall back to high-volume procedural soundscapes."""
    music_dir = _music_cache_dir()

    # 1. ALWAYS PRIORITIZE REAL ROYALTY-FREE MUSIC TRACKS FIRST
    total_priority = len(PRIORITY_MUSIC_TRACKS)
    if chosen_index is None:
        chosen_index = random.randint(0, total_priority - 1)

    target_track = PRIORITY_MUSIC_TRACKS[chosen_index % total_priority]
    downloaded_path = os.path.join(music_dir, target_track["name"])

    # If already cached and valid, return immediately
    if os.path.isfile(downloaded_path) and os.path.getsize(downloaded_path) > 1000:
        return downloaded_path

    with _music_fetch_lock:
        if os.path.isfile(downloaded_path) and os.path.getsize(downloaded_path) > 1000:
            return downloaded_path

        # Try downloading the chosen track first, then others if it fails
        candidate_tracks = [target_track] + [t for t in PRIORITY_MUSIC_TRACKS if t != target_track]
        for track in candidate_tracks:
            track_path = os.path.join(music_dir, track["name"])
            if os.path.isfile(track_path) and os.path.getsize(track_path) > 1000:
                return track_path

            tmp_path = f"{track_path}.part-{os.getpid()}-{threading.get_ident()}"
            try:
                req = urllib.request.Request(
                    track["url"],
                    headers={"User-Agent": "PhoneBackupServer/3.1.0 (https://github.com/AbirHasanSupta/backup_server; supta@local.net)"},
                )
                with urllib.request.urlopen(req, timeout=15) as response:
                    if response.status == 200:
                        with open(tmp_path, "wb") as f:
                            f.write(response.read())
                        if os.path.isfile(tmp_path) and os.path.getsize(tmp_path) > 1000:
                            os.replace(tmp_path, track_path)
                            add_log(f"[Rewind] fetched priority music: {track['name']}")
                            return track_path
            except Exception as e:
                add_log(f"[Rewind] warning downloading {track['name']}: {e}")
            finally:
                if os.path.isfile(tmp_path):
                    try:
                        os.remove(tmp_path)
                    except OSError:
                        pass

        # 2. Check if any procedural ambient soundscape is cached
        for preset in SYNTH_PRESETS:
            p = os.path.join(music_dir, preset["filename"])
            if os.path.isfile(p) and os.path.getsize(p) > 1000:
                return p

        # 3. Synthesize procedural ambient preset as last resort
        synth_idx = random.randint(0, len(SYNTH_PRESETS) - 1)
        fallback_preset = SYNTH_PRESETS[synth_idx]
        fallback_path = os.path.join(music_dir, fallback_preset["filename"])
        try:
            cmd_inputs = []
            for inp in fallback_preset["inputs"]:
                cmd_inputs.extend(["-f", "lavfi", "-i", inp])
            synth_cmd = [
                ffmpeg, "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
                *cmd_inputs,
                "-filter_complex", fallback_preset["filter"],
                "-map", "[a]",
                "-c:a", "aac", "-b:a", "128k",
                fallback_path,
            ]
            _run_ffmpeg(synth_cmd, timeout=15)
            if os.path.isfile(fallback_path) and os.path.getsize(fallback_path) > 1000:
                add_log(f"[Rewind] synthesized ambient soundscape: {fallback_preset['filename']}")
                return fallback_path
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

            items = get_reel_items(device_id, year, month, randomize=True)
            if not items:
                add_log(f"[Rewind] no items available for {device_id} {year}/{month or 'all'}")
                return

            nonce = f"{int(time.time())}-{random.randint(1000, 9999)}"
            cache_key = _cache_key(device_id, year, month, items, nonce=nonce)
            out_path = _reel_path(cache_key)

            work_dir = os.path.join(_cache_dir(), f"tmp_{cache_key}")
            os.makedirs(work_dir, exist_ok=True)
            list_file = os.path.join(work_dir, "concat.txt")
            concat_video = os.path.join(work_dir, "concat_raw.mp4")
            partial_out = out_path + ".partial"

            try:
                if os.path.isfile(partial_out):
                    try:
                        os.remove(partial_out)
                    except OSError:
                        pass

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
                    add_log("[Rewind] no usable files found — aborting reel build")
                    return

                # Build segments in parallel across CPU cores using ultrafast presets
                max_workers = max(2, min(8, os.cpu_count() or 4))
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

                # Concat segments into single video with fast direct stream copy
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

                # Calculate total reel duration
                total_duration = 0.0
                for idx, _, _, is_vid in valid_work:
                    if idx in segment_results:
                        total_duration += VIDEO_CLIP_SEC if is_vid else PHOTO_DURATION_SEC

                # Select prioritized background music track
                music_track = _get_or_fetch_background_music(ffmpeg)
                if music_track and os.path.isfile(music_track):
                    fade_start = max(0.5, total_duration - 2.0)
                    mux_cmd = [
                        ffmpeg, "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
                        "-i", concat_video,
                        "-i", music_track,
                        "-c:v", "copy",
                        "-filter_complex", f"[1:a]volume=0.90,afade=t=in:st=0:d=0.8,afade=t=out:st={fade_start:.2f}:d=2.0[a]",
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
                    _set_latest_reel_path(device_id, year, month, out_path)
                    success = True
                    add_log(f"🎬 Built reel for {device_id} {year}/{month or 'all'} ({len(segments)} clips)")
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

    shared_dirs = load_config().get("SHARED_DIRS", [])
    sources, _ = _shared_sources_for_device(device_id, shared_dirs)
    pool = get_media_for_year_month(sources, year, month, limit=5, order="time")
    if not pool:
        return {"ok": False, "status": "none"}

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
    """Return {files, bytes} for generated reel videos in the rewind cache directory (excluding persistent music files)."""
    cache_dir = _cache_dir()
    total_files = 0
    total_bytes = 0
    try:
        for name in os.listdir(cache_dir):
            if name == "music_cache":
                continue
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
    """Delete generated reel videos and temporary directories in the rewind cache directory.
    The music library (music_cache) is strictly preserved and NEVER deleted on server shutdown or cache clearance.
    Returns {files, bytes} of what was removed.
    Also clears the in-memory job sets and reel pointers so stale state is not carried over.
    """
    cache_dir = _cache_dir()
    removed_files = 0
    removed_bytes = 0
    try:
        for name in os.listdir(cache_dir):
            if name == "music_cache":
                continue
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

    # Clear in-memory job state and pointers
    with _generation_lock:
        _active_jobs.clear()
        _failed_jobs.clear()
    with _latest_reels_lock:
        _latest_reels.clear()

    return {"files": removed_files, "bytes": removed_bytes}