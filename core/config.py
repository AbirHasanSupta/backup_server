"""core/config.py — Central Typed Configuration Manager."""

from __future__ import annotations

"""Compatibility facade for the single authoritative configuration module.

Keeping two independent configuration caches caused modular services and the
desktop server to observe different values in the same process.  Re-exporting
the legacy module preserves its Windows migration/autostart behavior while
giving every layer one source of truth.
"""

from config import (
    APP_DATA_DIR,
    APP_NAME,
    CONFIG_FILE,
    DB_PATH,
    SHARED_DIRECT_POST_DIR,
    SHARED_QUIZ_DIR,
    SHARED_REWIND_DIR,
    get_shared_dirs,
    load_config,
    save_config,
)

__all__ = [
    "APP_DATA_DIR", "APP_NAME", "CONFIG_FILE", "DB_PATH",
    "SHARED_DIRECT_POST_DIR", "SHARED_QUIZ_DIR", "SHARED_REWIND_DIR",
    "get_shared_dirs", "load_config", "save_config",
]
