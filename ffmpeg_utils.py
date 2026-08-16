"""Shared ffmpeg / ffprobe binary resolution for video_preview and rewind."""

from __future__ import annotations

import os
import shutil
import sys
from functools import lru_cache


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
