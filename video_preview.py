"""Low-latency video preview delivery and cache management.

The preview URL is deliberately always playable immediately: a cache miss streams
the original file with HTTP range support while an optimized MP4 is built in the
background only when the source actually needs one.  Already progressive,
Android-compatible MP4-family files stay on their original path permanently.

This avoids making playback depend on a full FFmpeg job, which can take tens of
seconds for a large video.  It also makes the aggressive client-side preloads
safe: only one background conversion can use CPU/disk at a time and duplicate
requests coalesce into one job.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import time
from collections import deque
from dataclasses import dataclass

from config import APP_DATA_DIR, load_config
from ffmpeg_utils import resolve_ffmpeg_path, resolve_ffprobe_path
from state import add_log


DEFAULT_PREVIEW_CACHE_DIR = os.path.join(APP_DATA_DIR, "video_preview_cache")


def _normalize_cache_dir(path: str | os.PathLike[str] | None) -> str:
    raw_path = os.fspath(path).strip() if path else DEFAULT_PREVIEW_CACHE_DIR
    return os.path.abspath(os.path.expanduser(raw_path))


def _configured_cache_dir() -> str:
    try:
        configured = load_config().get("VIDEO_PREVIEW_CACHE_DIR", DEFAULT_PREVIEW_CACHE_DIR)
    except Exception:
        configured = DEFAULT_PREVIEW_CACHE_DIR
    return _normalize_cache_dir(configured)


def _ensure_cache_dir(path: str | None = None) -> str:
    directory = _normalize_cache_dir(path or PREVIEW_CACHE_DIR)
    if os.path.exists(directory) and not os.path.isdir(directory):
        raise NotADirectoryError(f"Preview cache path is not a directory: {directory}")
    os.makedirs(directory, exist_ok=True)
    return directory


# This is intentionally a mutable in-process setting: desktop Settings can
# switch directories without requiring the Android client or preview URL to
# change.  A fresh app process initializes it from server_config.json.
PREVIEW_CACHE_DIR = _configured_cache_dir()
_ensure_cache_dir(PREVIEW_CACHE_DIR)
_cache_dir_guard = threading.RLock()
_retired_cache_dirs: set[str] = set()
# The versioned filename lets us identify output created by the current
# strategy without ever treating an arbitrary MP4 in a user-selected cache
# directory as ours.  v3 could contain full-size fast-start rewrites, so the
# direct-streaming policy uses a new generation and removes those old entries.
PREVIEW_CACHE_VERSION = 4
_CACHE_OUTPUT_RE = re.compile(rf"^v{PREVIEW_CACHE_VERSION}-[0-9a-f]{{64}}\.mp4$")
_LEGACY_CACHE_OUTPUT_RE = re.compile(r"^(?:[0-9a-f]{64}|v3-[0-9a-f]{64})\.mp4$")

VIDEO_EXTENSIONS = {
    ".mp4", ".mov", ".avi", ".mkv", ".webm", ".3gp", ".m4v", ".wmv", ".flv", ".ts", ".mts",
}

# Very small files do not benefit enough from a server-side optimized copy to
# justify another disk write.  The Android client already plays those directly.
PREVIEW_TRANSCODE_MIN_BYTES = 40 * 1024 * 1024

# Versioning prevents a cache made by an older encoding strategy from being
# mistaken for a current one.  Old entries are reclaimed by the LRU pruner.
DEFAULT_PREVIEW_CACHE_MAX_BYTES = 8 * 1024 * 1024 * 1024
MAX_PENDING_PREVIEW_JOBS = 24
ACTIVE_PREVIEW_INTENT_TTL_SECONDS = 8.0


@dataclass(frozen=True)
class _PreviewJob:
    source_path: str
    cache_path: str
    cache_key: str


class _ActivePreviewIntentTracker:
    """Correlate an Android active-video hint with its actual preview request.

    The Android protocol predates this server optimization and sends one warm
    request containing ``[current, previous, next]``.  The player instances all
    use the same GET URL, so a GET alone cannot reveal whether it is playing or
    merely preloading.  The first warm-path is therefore treated as a brief
    intent token; only its matching GET may generate a server cache.
    """

    def __init__(self) -> None:
        self._guard = threading.Lock()
        self._intents: dict[tuple[str, str], float] = {}
        self._recent_gets: dict[tuple[str, str], float] = {}

    @staticmethod
    def _key(scope: str, source_path: str) -> tuple[str, str]:
        return scope, os.path.abspath(source_path)

    def _prune_locked(self, now: float) -> None:
        expiry = now - ACTIVE_PREVIEW_INTENT_TTL_SECONDS
        self._intents = {key: until for key, until in self._intents.items() if until > now}
        self._recent_gets = {key: seen for key, seen in self._recent_gets.items() if seen > expiry}

    def arm(self, scope: str, source_path: str) -> bool:
        """Record an active-video intent and return True if its GET came first."""
        now = time.monotonic()
        key = self._key(scope, source_path)
        with self._guard:
            self._prune_locked(now)
            if key in self._recent_gets:
                self._recent_gets.pop(key, None)
                return True
            self._intents[key] = now + ACTIVE_PREVIEW_INTENT_TTL_SECONDS
            return False

    def consume_if_armed(self, scope: str, source_path: str) -> bool:
        """Return True exactly once for the active item's matching GET."""
        now = time.monotonic()
        key = self._key(scope, source_path)
        with self._guard:
            self._prune_locked(now)
            if key in self._intents:
                self._intents.pop(key, None)
                return True
            self._recent_gets[key] = now
            return False

    def clear(self) -> None:
        with self._guard:
            self._intents.clear()
            self._recent_gets.clear()


def is_video_path(path: str) -> bool:
    return os.path.splitext(path)[1].lower() in VIDEO_EXTENSIONS


def _cache_key_for_version(source_path: str, version: int) -> str:
    stat = os.stat(source_path)
    digest = hashlib.sha256(
        f"v{version}:{os.path.abspath(source_path)}:{stat.st_mtime_ns}:{stat.st_size}".encode("utf-8"),
    ).hexdigest()
    return digest


def _cache_key(source_path: str) -> str:
    return _cache_key_for_version(source_path, PREVIEW_CACHE_VERSION)


def _cache_path_for(source_path: str) -> tuple[str, str]:
    key = _cache_key(source_path)
    return key, os.path.join(PREVIEW_CACHE_DIR, f"v{PREVIEW_CACHE_VERSION}-{key}.mp4")


def _legacy_cache_paths_for(source_path: str) -> tuple[str, ...]:
    """Locate cache-file names from strategies superseded by direct streaming."""
    return (
        os.path.join(PREVIEW_CACHE_DIR, f"{_cache_key_for_version(source_path, 2)}.mp4"),
        os.path.join(PREVIEW_CACHE_DIR, f"v3-{_cache_key_for_version(source_path, 3)}.mp4"),
    )


def _is_complete_cache_file(name: str) -> bool:
    return bool(_CACHE_OUTPUT_RE.fullmatch(name))


def _is_legacy_cache_file(name: str) -> bool:
    return bool(_LEGACY_CACHE_OUTPUT_RE.fullmatch(name))


def _is_preview_artifact(name: str) -> bool:
    # Completed cache entries have a deterministic SHA-256 name.  The staging
    # files are created only by this module and include ".part" in the name.
    return (
        _is_complete_cache_file(name)
        or _is_legacy_cache_file(name)
        or (name.endswith(".mp4") and ".part" in name)
    )


def _safe_remove(path: str) -> None:
    try:
        os.remove(path)
    except FileNotFoundError:
        pass
    except OSError:
        # A live FFmpeg process can hold a temporary file open on Windows.  The
        # worker will remove its output once it notices a clear-cache request.
        pass


def _remove_legacy_cache_artifacts(directory: str) -> tuple[int, int]:
    """Discard cache files from the pre-v3 strategy, never user media files."""
    removed_files = removed_bytes = 0
    try:
        entries = tuple(os.scandir(directory))
    except OSError:
        return removed_files, removed_bytes
    for entry in entries:
        if not entry.is_file() or not _is_legacy_cache_file(entry.name):
            continue
        try:
            size = entry.stat().st_size
            os.remove(entry.path)
            removed_files += 1
            removed_bytes += size
        except OSError:
            pass
    return removed_files, removed_bytes


def _discard_cache_for_direct_source(source_path: str) -> None:
    """Remove redundant cache copies once a source is verified direct-safe."""
    key, cache_path = _cache_path_for(source_path)
    _preview_scheduler.cancel(key)
    _safe_remove(cache_path)
    for legacy_path in _legacy_cache_paths_for(source_path):
        _safe_remove(legacy_path)


def _try_remove_empty_cache_dir(directory: str) -> bool:
    """Remove an old cache folder only when it is empty.

    Users may point the cache at an existing folder, so this deliberately never
    recursively removes a directory or any non-preview file the user owns.
    """
    try:
        os.rmdir(directory)
        return True
    except OSError:
        return False


def _cleanup_retired_cache_dirs() -> None:
    with _cache_dir_guard:
        candidates = tuple(_retired_cache_dirs)
        current_dir = PREVIEW_CACHE_DIR
    for directory in candidates:
        if directory == current_dir:
            with _cache_dir_guard:
                _retired_cache_dirs.discard(directory)
            continue
        if _try_remove_empty_cache_dir(directory):
            with _cache_dir_guard:
                _retired_cache_dirs.discard(directory)


def get_video_preview_cache_dir() -> str:
    """Return the currently active, dedicated preview-cache directory."""
    with _cache_dir_guard:
        return PREVIEW_CACHE_DIR


def relocate_video_preview_cache(new_directory: str) -> dict[str, int | bool | str]:
    """Move generated previews to a new directory without changing preview URLs.

    Queued jobs are cancelled and any active conversion is marked for discard so
    it cannot recreate a preview in the old directory.  Only this module's
    cache files move; if a user selected a folder containing other files, those
    files are left untouched and the old folder is removed only if empty.
    """
    global PREVIEW_CACHE_DIR

    target_dir = _normalize_cache_dir(new_directory)
    _ensure_cache_dir(target_dir)
    # v2 entries can be full-size fast-start rewrites.  They are intentionally
    # not migrated into the new strategy, which prevents old duplicates from
    # following a user to a newly selected cache folder.
    _remove_legacy_cache_artifacts(target_dir)
    with _cache_dir_guard:
        old_dir = PREVIEW_CACHE_DIR
        if os.path.normcase(old_dir) == os.path.normcase(target_dir):
            return {
                "old_dir": old_dir,
                "new_dir": target_dir,
                "moved_files": 0,
                "moved_bytes": 0,
                "failed_files": 0,
                "cancelled_jobs": 0,
                "old_dir_removed": False,
            }
        PREVIEW_CACHE_DIR = target_dir
        _retired_cache_dirs.add(old_dir)

    # There is only one worker, so marking its job for discard is sufficient to
    # prevent a late write into the previous folder after this migration.
    cancelled_jobs = _preview_scheduler.clear_pending()
    moved_files = moved_bytes = failed_files = 0
    try:
        entries = tuple(os.scandir(old_dir))
    except OSError:
        entries = ()

    for entry in entries:
        if not entry.is_file():
            continue
        if _is_complete_cache_file(entry.name):
            target_path = os.path.join(target_dir, entry.name)
            try:
                size = entry.stat().st_size
                # shutil.move performs an atomic rename on the same volume and
                # a copy/delete fallback when the user chose a different drive.
                if os.path.exists(target_path):
                    # The deterministic key identifies the same source version
                    # and preview strategy, so an existing destination already
                    # represents this cache item.
                    os.remove(entry.path)
                else:
                    shutil.move(entry.path, target_path)
                moved_files += 1
                moved_bytes += size
            except OSError:
                failed_files += 1
        elif _is_preview_artifact(entry.name):
            # Staging files cannot be useful after a move.  A live FFmpeg file
            # may remain locked briefly; the discarded worker removes it later.
            _safe_remove(entry.path)

    _cleanup_retired_cache_dirs()
    return {
        "old_dir": old_dir,
        "new_dir": target_dir,
        "moved_files": moved_files,
        "moved_bytes": moved_bytes,
        "failed_files": failed_files,
        "cancelled_jobs": cancelled_jobs,
        "old_dir_removed": not os.path.exists(old_dir),
    }


def _touch_cache_file(path: str) -> None:
    """Record LRU use without changing the mtime used in HTTP cache validators."""
    try:
        stat = os.stat(path)
        now = time.time()
        os.utime(path, (now, stat.st_mtime))
    except OSError:
        pass


def _ready_cache_path(source_path: str) -> tuple[str, str] | None:
    key, path = _cache_path_for(source_path)
    try:
        if os.path.isfile(path) and os.path.getsize(path) > 0:
            _touch_cache_file(path)
            return key, path
    except OSError:
        pass
    return None


def _ffmpeg_path() -> str | None:
    return resolve_ffmpeg_path()


def _ffprobe_path() -> str | None:
    return resolve_ffprobe_path()


def _is_preview_candidate(source_path: str) -> bool:
    """Cheap admission test that never puts codec probing on the HTTP path."""
    return (
        is_video_path(source_path)
        and os.path.isfile(source_path)
        and os.path.getsize(source_path) >= PREVIEW_TRANSCODE_MIN_BYTES
        and _ffmpeg_path() is not None
    )


_ffmpeg_process_guard = threading.Lock()
_active_ffmpeg_process: subprocess.Popen | None = None


def _run_ffmpeg(command: list[str]) -> None:
    """Run the one cache FFmpeg job while allowing deterministic shutdown."""
    global _active_ffmpeg_process
    run_options: dict[str, object] = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.PIPE,
    }
    # A windowed desktop build must not flash a console when it launches FFmpeg.
    if os.name == "nt":
        run_options["creationflags"] = subprocess.CREATE_NO_WINDOW
    process = subprocess.Popen(command, **run_options)
    with _ffmpeg_process_guard:
        _active_ffmpeg_process = process
    try:
        _, stderr = process.communicate()
        if process.returncode:
            raise subprocess.CalledProcessError(process.returncode, command, stderr=stderr)
    finally:
        with _ffmpeg_process_guard:
            if _active_ffmpeg_process is process:
                _active_ffmpeg_process = None


def _terminate_active_ffmpeg() -> bool:
    """Stop the cache-only FFmpeg child so shutdown leaves no locked artifact."""
    with _ffmpeg_process_guard:
        process = _active_ffmpeg_process
    if not process or process.poll() is not None:
        return False
    try:
        process.terminate()
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)
    except OSError:
        return False
    return True


_MP4_LIKE_EXTENSIONS = {".mp4", ".mov", ".m4v", ".3gp"}


_probe_cache_lock = threading.Lock()
_probe_cache: dict[tuple[str, int, int], list[dict[str, object]] | None] = {}
_MAX_PROBE_CACHE_ENTRIES = 2048


def _probe_streams(source_path: str) -> list[dict[str, object]] | None:
    """Read just enough stream metadata to decide whether Android can play it.

    The result is cached in-memory by (path, mtime, size) to eliminate subprocess
    overhead for repeat requests.
    """
    try:
        stat = os.stat(source_path)
        cache_key = (os.path.abspath(source_path), stat.st_mtime_ns, stat.st_size)
    except OSError:
        return None

    with _probe_cache_lock:
        if cache_key in _probe_cache:
            return _probe_cache[cache_key]

    ffprobe_path = _ffprobe_path()
    if not ffprobe_path:
        return None
    try:
        run_options: dict[str, object] = {
            "check": True,
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.PIPE,
            "stderr": subprocess.DEVNULL,
            "text": True,
            "timeout": 10,
        }
        if os.name == "nt":
            run_options["creationflags"] = subprocess.CREATE_NO_WINDOW
        result = subprocess.run(
            [
                ffprobe_path,
                "-v", "error",
                "-show_entries", "stream=codec_type,codec_name,pix_fmt,width,height",
                "-of", "json",
                source_path,
            ],
            **run_options,
        )
        streams = json.loads(result.stdout).get("streams", [])
        res = streams if isinstance(streams, list) else None
        with _probe_cache_lock:
            if len(_probe_cache) >= _MAX_PROBE_CACHE_ENTRIES:
                for k in list(_probe_cache.keys())[:256]:
                    _probe_cache.pop(k, None)
            _probe_cache[cache_key] = res
        return res
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        return None


def _is_android_direct_compatible(source_path: str) -> bool:
    """Return True for a conservative, directly playable MP4-family source."""
    if os.path.splitext(source_path)[1].lower() not in _MP4_LIKE_EXTENSIONS:
        return False
    streams = _probe_streams(source_path)
    if not streams:
        return False
    video_streams = [stream for stream in streams if stream.get("codec_type") == "video"]
    audio_streams = [stream for stream in streams if stream.get("codec_type") == "audio"]
    if len(video_streams) != 1:
        return False
    video = video_streams[0]
    # H.264 / HEVC (H.265) video plus AAC/MP3/Opus audio have full native hardware decode on Android.
    codec_name = str(video.get("codec_name") or "").lower()
    pix_fmt = str(video.get("pix_fmt") or "").lower()
    if codec_name not in {"h264", "hevc", "h265"} or pix_fmt not in {"yuv420p", "yuvj420p", "yuv420p10le"}:
        return False
    return all(str(stream.get("codec_name") or "").lower() in {"aac", "mp3", "opus"} for stream in audio_streams)


def _is_direct_streamable(source_path: str) -> bool:
    """Return whether the source meets the server's direct-play codec policy."""
    return _is_android_direct_compatible(source_path)


def _transcode_preview(source_path: str, output_path: str) -> None:
    """Create a compact, progressive H.264/AAC fallback preview."""
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    ffmpeg_path = _ffmpeg_path()
    if not ffmpeg_path:
        raise FileNotFoundError("ffmpeg executable not found")

    temp_path = f"{output_path}.encode.part.mp4"
    _safe_remove(temp_path)
    # Leave capacity for HTTP requests and the desktop app while the single
    # background job is encoding.  One job prevents preload fan-out from
    # multiplying disk reads and CPU contention.
    threads = str(max(1, min(6, (os.cpu_count() or 2) - 1)))
    try:
        _run_ffmpeg([
            ffmpeg_path, "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
            "-i", source_path,
            "-map", "0:v:0", "-map", "0:a?",
            "-c:v", "libx264", "-preset", "superfast", "-crf", "29",
            "-vf", "scale='min(1280,iw)':-2,format=yuv420p",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "96k", "-ac", "2",
            "-movflags", "+faststart", "-threads", threads,
            temp_path,
        ])
        os.replace(temp_path, output_path)
    finally:
        _safe_remove(temp_path)


def _build_preview(source_path: str, output_path: str) -> None:
    """Create a fallback only when the original is not Android-compatible."""
    _transcode_preview(source_path, output_path)


def _cache_limit_bytes() -> int:
    try:
        configured = int(load_config().get("VIDEO_PREVIEW_CACHE_MAX_BYTES", DEFAULT_PREVIEW_CACHE_MAX_BYTES))
        return max(0, configured)
    except (TypeError, ValueError):
        return DEFAULT_PREVIEW_CACHE_MAX_BYTES


def _prune_preview_cache() -> tuple[int, int]:
    """Bound the cache with an LRU eviction pass; 0 means no automatic limit."""
    limit = _cache_limit_bytes()
    if limit == 0:
        return 0, 0
    try:
        entries = []
        total = 0
        for entry in os.scandir(PREVIEW_CACHE_DIR):
            if not entry.is_file() or not _is_complete_cache_file(entry.name):
                continue
            try:
                stat = entry.stat()
            except OSError:
                continue
            entries.append((stat.st_atime, entry.path, stat.st_size))
            total += stat.st_size

        removed_files = removed_bytes = 0
        for _, path, size in sorted(entries):
            if total <= limit:
                break
            try:
                os.remove(path)
            except OSError:
                continue
            total -= size
            removed_files += 1
            removed_bytes += size
        return removed_files, removed_bytes
    except OSError:
        return 0, 0


class _PreviewScheduler:
    """Small priority queue that serializes expensive preview work.

    A request for a preview is higher priority than the optional warm endpoint.
    Both are de-duplicated by cache key, so all of the Android preloader paths
    point to the same one conversion.
    """

    def __init__(self) -> None:
        self._condition = threading.Condition()
        self._priority_jobs: deque[_PreviewJob] = deque()
        self._warm_jobs: deque[_PreviewJob] = deque()
        self._known_keys: set[str] = set()
        self._running_job: _PreviewJob | None = None
        self._discard_keys: set[str] = set()
        self._stop_event = threading.Event()
        self._worker = threading.Thread(target=self._run, name="video-preview-worker", daemon=True)
        self._worker.start()

    def stop(self, timeout: float = 5.0) -> None:
        self._stop_event.set()
        with self._condition:
            self._condition.notify_all()
        terminated = _terminate_active_ffmpeg()
        self._worker.join(timeout=timeout if not terminated else timeout + 3)

    def submit(self, source_path: str, *, priority: bool) -> str:
        if not _is_preview_candidate(source_path):
            return "source"
        ready = _ready_cache_path(source_path)
        if ready:
            return "ready"
        key, cache_path = _cache_path_for(source_path)
        job = _PreviewJob(source_path=source_path, cache_path=cache_path, cache_key=key)
        with self._condition:
            if key in self._known_keys:
                # A file-list warm-up may have queued this item before the user
                # actually opened it.  Promote it without adding duplicate work.
                if priority:
                    try:
                        self._warm_jobs.remove(job)
                    except ValueError:
                        pass
                    else:
                        self._priority_jobs.append(job)
                return "queued"
            pending = len(self._priority_jobs) + len(self._warm_jobs)
            if pending >= MAX_PENDING_PREVIEW_JOBS:
                # Preserve room for an explicit playback request by dropping
                # the oldest speculative warm-up when possible.
                if priority and self._warm_jobs:
                    displaced = self._warm_jobs.popleft()
                    self._known_keys.discard(displaced.cache_key)
                else:
                    return "queue_full"
            self._known_keys.add(key)
            (self._priority_jobs if priority else self._warm_jobs).append(job)
            self._condition.notify()
        return "queued"

    def snapshot(self) -> dict[str, int | str | None]:
        with self._condition:
            return {
                "queued": len(self._priority_jobs) + len(self._warm_jobs),
                "running": os.path.basename(self._running_job.source_path) if self._running_job else None,
            }

    def clear_pending(self) -> int:
        with self._condition:
            removed = len(self._priority_jobs) + len(self._warm_jobs)
            self._priority_jobs.clear()
            self._warm_jobs.clear()
            self._known_keys = {self._running_job.cache_key} if self._running_job else set()
            if self._running_job:
                self._discard_keys.add(self._running_job.cache_key)
            return removed

    def cancel(self, cache_key: str) -> int:
        """Cancel a queued job, or discard an active job's eventual output."""
        with self._condition:
            removed = 0
            retained_priority: deque[_PreviewJob] = deque()
            for job in self._priority_jobs:
                if job.cache_key == cache_key:
                    removed += 1
                else:
                    retained_priority.append(job)
            retained_warm: deque[_PreviewJob] = deque()
            for job in self._warm_jobs:
                if job.cache_key == cache_key:
                    removed += 1
                else:
                    retained_warm.append(job)
            self._priority_jobs = retained_priority
            self._warm_jobs = retained_warm
            if self._running_job and self._running_job.cache_key == cache_key:
                self._discard_keys.add(cache_key)
            else:
                self._known_keys.discard(cache_key)
            return removed

    def _take_next_job(self) -> _PreviewJob | None:
        with self._condition:
            while not self._stop_event.is_set() and not self._priority_jobs and not self._warm_jobs:
                self._condition.wait()
            if self._stop_event.is_set():
                return None
            job = self._priority_jobs.popleft() if self._priority_jobs else self._warm_jobs.popleft()
            self._running_job = job
            return job

    def _finish_job(self, job: _PreviewJob) -> bool:
        with self._condition:
            discard = job.cache_key in self._discard_keys
            self._discard_keys.discard(job.cache_key)
            self._known_keys.discard(job.cache_key)
            self._running_job = None
            return discard

    def _run(self) -> None:
        while True:
            job = self._take_next_job()
            if job is None:
                return
            discard = False
            try:
                # Do not populate an old cache key if a shared source changed
                # while it was queued.  Queue the current version instead.
                if _cache_key(job.source_path) != job.cache_key:
                    self.submit(job.source_path, priority=True)
                    continue
                if _is_direct_streamable(job.source_path):
                    # Its original MP4 meets the direct-play policy, so a
                    # cached copy would only duplicate it.  This probe runs
                    # only on the background worker, never before the HTTP
                    # response.
                    _discard_cache_for_direct_source(job.source_path)
                    continue
                if not _ready_cache_path(job.source_path):
                    _build_preview(job.source_path, job.cache_path)
                    _touch_cache_file(job.cache_path)
                    add_log(f"Video preview cached: {os.path.basename(job.source_path)}")
                    _prune_preview_cache()
            except FileNotFoundError:
                pass
            except (OSError, subprocess.SubprocessError) as exc:
                add_log(f"Video preview skipped for {os.path.basename(job.source_path)}: {exc}")
            finally:
                discard = self._finish_job(job)
                if discard:
                    _safe_remove(job.cache_path)
                _cleanup_retired_cache_dirs()


_preview_scheduler = _PreviewScheduler()
_active_preview_intents = _ActivePreviewIntentTracker()


def stop_preview_scheduler() -> None:
    _preview_scheduler.stop()

# v2 used unversioned names and v3 could contain full-size fast-start rewrites.
# Neither can be selected by v4, so reclaim them once when this module starts.
# The strict filename match preserves unrelated user media in a selected cache
# folder.
_legacy_files, _legacy_bytes = _remove_legacy_cache_artifacts(PREVIEW_CACHE_DIR)
if _legacy_files:
    add_log(f"Removed {_legacy_files} obsolete video preview cache file(s) ({_legacy_bytes} bytes)")


def schedule_video_preview(source_path: str, *, priority: bool = False) -> str:
    """Queue a cache build without ever blocking playback."""
    return _preview_scheduler.submit(source_path, priority=priority)


def arm_active_video_preview(scope: str, source_path: str) -> bool:
    """Arm exactly one current-video preview from a warm request.

    If its GET already arrived, queue the cache immediately.  Otherwise the
    next matching GET consumes this one-shot intent and queues it.
    """
    if _active_preview_intents.arm(scope, source_path):
        return schedule_video_preview(source_path, priority=True) == "queued"
    return False


def preview_request_is_active(scope: str, source_path: str) -> bool:
    """Consume a matching current-video intent for a preview GET request."""
    return _active_preview_intents.consume_if_armed(scope, source_path)


def get_video_preview_path(source_path: str, *, schedule_missing: bool = True) -> str:
    """Return a playable file now and optimize only when it is actually needed.

    The cache is used immediately for source formats that need compatibility
    transcoding.  On a miss, returning the source lets the existing
    range-streaming endpoint start playback in milliseconds; FFmpeg/FFprobe
    never sits on the request critical path.
    """
    if not os.path.isfile(source_path):
        raise FileNotFoundError(source_path)
    if not is_video_path(source_path):
        return source_path
    ready = _ready_cache_path(source_path)
    if ready:
        return ready[1]
    if schedule_missing:
        schedule_video_preview(source_path, priority=True)
    return source_path


def get_video_preview_cache_stats() -> dict[str, int | str | None]:
    """Return cache data for the desktop Settings page without touching media files."""
    file_count = total_bytes = 0
    try:
        for entry in os.scandir(PREVIEW_CACHE_DIR):
            if entry.is_file() and _is_complete_cache_file(entry.name):
                try:
                    total_bytes += entry.stat().st_size
                    file_count += 1
                except OSError:
                    pass
    except OSError:
        pass
    return {
        "files": file_count,
        "bytes": total_bytes,
        "limit_bytes": _cache_limit_bytes(),
        **_preview_scheduler.snapshot(),
    }


def clear_video_preview_cache() -> dict[str, int | bool]:
    """Clear cached previews and cancel queued work safely.

    The only process interrupted is the server's private FFmpeg cache worker;
    video playback itself streams directly and is unaffected.  Stopping the
    worker lets this function remove every generated cache artifact now.
    """
    _active_preview_intents.clear()
    cancelled_jobs = _preview_scheduler.clear_pending()
    terminated_process = _terminate_active_ffmpeg()
    removed_files = removed_bytes = 0
    with _cache_dir_guard:
        cache_dirs = (PREVIEW_CACHE_DIR, *_retired_cache_dirs)
    for cache_dir in cache_dirs:
        try:
            entries = tuple(os.scandir(cache_dir))
        except OSError:
            continue
        for entry in entries:
            if not entry.is_file():
                continue
            # Cache outputs and interrupted FFmpeg staging files are the full
            # set of generated artifacts.  Never touch unrelated user files if
            # they chose an existing directory as the cache location.
            if not _is_preview_artifact(entry.name):
                continue
            try:
                size = entry.stat().st_size
                os.remove(entry.path)
                removed_files += 1
                removed_bytes += size
            except OSError:
                pass
    _cleanup_retired_cache_dirs()
    return {
        "files": removed_files,
        "bytes": removed_bytes,
        "cancelled_jobs": cancelled_jobs,
        "terminated_active_conversion": terminated_process,
    }