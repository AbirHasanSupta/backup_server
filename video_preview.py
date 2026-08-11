import hashlib
import os
import shutil
import subprocess
import threading

from config import APP_DATA_DIR

PREVIEW_CACHE_DIR = os.path.join(APP_DATA_DIR, "video_preview_cache")
os.makedirs(PREVIEW_CACHE_DIR, exist_ok=True)

VIDEO_EXTENSIONS = {
    ".mp4", ".mov", ".avi", ".mkv", ".webm", ".3gp", ".m4v", ".wmv", ".flv", ".ts", ".mts",
}

# Files below this size are streamed as-is; larger files get a fast-start transcode.
PREVIEW_TRANSCODE_MIN_BYTES = 40 * 1024 * 1024

_locks_guard = threading.Lock()
_preview_locks: dict[str, threading.Lock] = {}


def is_video_path(path: str) -> bool:
    return os.path.splitext(path)[1].lower() in VIDEO_EXTENSIONS


def _cache_key(source_path: str) -> str:
    stat = os.stat(source_path)
    digest = hashlib.sha256(
        f"{os.path.abspath(source_path)}:{stat.st_mtime_ns}:{stat.st_size}".encode("utf-8"),
    ).hexdigest()
    return digest


def _lock_for(key: str) -> threading.Lock:
    with _locks_guard:
        if key not in _preview_locks:
            _preview_locks[key] = threading.Lock()
        return _preview_locks[key]


def _ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def _transcode_preview(source_path: str, output_path: str) -> None:
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    temp_path = f"{output_path}.part"
    if os.path.exists(temp_path):
        os.remove(temp_path)

    cmd = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        source_path,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "28",
        "-vf",
        "scale='min(1280,iw)':-2",
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-movflags",
        "+faststart",
        "-threads",
        "0",
        temp_path,
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    os.replace(temp_path, output_path)


def get_video_preview_path(source_path: str) -> str:
    """
    Return a path suitable for streaming preview playback.
    Small videos are returned unchanged; large videos are transcoded once and cached.
    """
    if not os.path.isfile(source_path):
        raise FileNotFoundError(source_path)
    if not is_video_path(source_path):
        return source_path

    file_size = os.path.getsize(source_path)
    if file_size < PREVIEW_TRANSCODE_MIN_BYTES or not _ffmpeg_available():
        return source_path

    cache_key = _cache_key(source_path)
    cached_path = os.path.join(PREVIEW_CACHE_DIR, f"{cache_key}.mp4")
    if os.path.isfile(cached_path):
        return cached_path

    with _lock_for(cache_key):
        if os.path.isfile(cached_path):
            return cached_path
        _transcode_preview(source_path, cached_path)

    return cached_path
