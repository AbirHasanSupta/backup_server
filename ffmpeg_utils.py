"""Shared ffmpeg / ffprobe binary resolution for video_preview and rewind."""

from __future__ import annotations

import os
import shutil
import sys
from functools import lru_cache


def configured_ffmpeg_threads(default: int = 2) -> int:
    """Return a safe, deployment-configurable thread budget per FFmpeg child.

    FFmpeg otherwise chooses its own thread count.  With several Celery jobs
    running, that can multiply into dozens of runnable CPU threads and make
    interactive API requests slower rather than faster.  Docker sets the
    default to two; larger hosts can deliberately raise ``FFMPEG_THREADS``.
    """
    try:
        requested = int(os.environ.get("FFMPEG_THREADS", default))
    except (TypeError, ValueError):
        requested = default
    return max(1, min(requested, os.cpu_count() or default))


def configured_rewind_segment_workers(default: int = 2) -> int:
    """Bound the number of simultaneous FFmpeg segment encodes in one reel."""
    try:
        requested = int(os.environ.get("REWIND_SEGMENT_WORKERS", default))
    except (TypeError, ValueError):
        requested = default
    return max(1, min(requested, os.cpu_count() or default))


@lru_cache(maxsize=1)
def resolve_ffmpeg_path() -> str | None:
    """Prefer the ffmpeg binary bundled with the desktop application."""
    executable = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    bundle_dir = getattr(sys, "_MEIPASS", None)
    if bundle_dir:
        bundled_path = os.path.join(bundle_dir, executable)
        if os.path.isfile(bundled_path):
            return bundled_path
    return shutil.which("ffmpeg")


@lru_cache(maxsize=1)
def resolve_ffprobe_path() -> str | None:
    executable = "ffprobe.exe" if os.name == "nt" else "ffprobe"
    bundle_dir = getattr(sys, "_MEIPASS", None)
    if bundle_dir:
        bundled_path = os.path.join(bundle_dir, executable)
        if os.path.isfile(bundled_path):
            return bundled_path
    return shutil.which("ffprobe")
