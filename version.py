"""Release-version discovery shared by the server and build tools.

The release version is the nearest semantic Git tag reachable from the current
commit. Tags may be written as ``vMAJOR.MINOR.PATCH`` or
``MAJOR.MINOR.PATCH``; callers receive the normalized value without the
optional leading ``v``.

Packaged applications do not include repository metadata, so build tools write
a generated ``VERSION`` file which is used as the frozen-app fallback.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path


_TAG_PATTERN = re.compile(r"^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$")
_UNKNOWN_VERSION = "0.0.0+unknown"


def _normalise(tag: str) -> str | None:
    match = _TAG_PATTERN.fullmatch(tag.strip())
    return match.group(1) if match else None


def _git_tag(project_root: Path) -> str | None:
    """Return the closest semantic release tag without failing app startup."""
    try:
        run_options: dict[str, object] = {
            "capture_output": True,
            "check": False,
            "text": True,
            "timeout": 2,
            "stdin": subprocess.DEVNULL,
        }
        if os.name == "nt":
            run_options["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = getattr(subprocess, "SW_HIDE", 0)
            run_options["startupinfo"] = startupinfo
        result = subprocess.run(
            [
                "git", "-C", str(project_root), "describe", "--tags", "--abbrev=0",
                "--match", "v[0-9]*", "--match", "[0-9]*",
            ],
            **run_options,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    return _normalise(result.stdout)


def _bundled_version() -> str | None:
    for directory in (Path(__file__).resolve().parent, Path(getattr(sys, "_MEIPASS", ""))):
        candidate = directory / "VERSION"
        try:
            version = _normalise(candidate.read_text(encoding="utf-8"))
        except OSError:
            continue
        if version:
            return version
    return None


def get_version() -> str:
    """Return the release version, preferring an explicit deployment override."""
    configured = _normalise(os.environ.get("PHONE_BACKUP_VERSION", ""))
    if configured:
        return configured
    if getattr(sys, "frozen", False):
        return _bundled_version() or _git_tag(Path(__file__).resolve().parent) or _UNKNOWN_VERSION
    project_root = Path(__file__).resolve().parent
    return _git_tag(project_root) or _bundled_version() or _UNKNOWN_VERSION


APP_VERSION = get_version()
