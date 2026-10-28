"""Helpers for selecting shared folders without overlapping filesystem roots."""

from __future__ import annotations

import os
from typing import Any

from core.path_utils import normalize_fs_path


def folder_is_shared_with_device(entry: dict[str, Any], device_id: str | None) -> bool:
    if not device_id:
        return True
    tags = entry.get("device_ids", ["all"])
    if tags is None:
        return True
    return isinstance(tags, list) and (not tags or "all" in tags or device_id in tags)


def non_overlapping_shared_folders(
    entries: list[dict[str, Any]], device_id: str | None = None
) -> list[dict[str, Any]]:
    """Keep only the outermost accessible local roots.

    If both ``Documents`` and ``Documents/Abir`` are shared with a device,
    the parent already exposes every file in the child. Keeping only the
    parent prevents duplicate media across library-style views. Google Drive
    entries have opaque roots and are intentionally left as independent
    sources.
    """
    eligible = [
        entry for entry in entries
        if entry.get("id") and folder_is_shared_with_device(entry, device_id)
    ]
    roots: dict[int, str] = {}
    for index, entry in enumerate(eligible):
        if entry.get("type") == "google_drive" or entry.get("kind") == "google_drive":
            continue
        path = normalize_fs_path(entry.get("path"))
        if path:
            roots[index] = os.path.normcase(os.path.realpath(os.path.abspath(path)))

    keep_indices: set[int] = set()
    kept_roots: list[str] = []
    ordered = sorted(
        range(len(eligible)),
        key=lambda i: (len(roots.get(i, "")) if i in roots else 10**9, i),
    )
    for index in ordered:
        entry = eligible[index]
        root = roots.get(index)
        if root:
            shadowed = False
            for parent in kept_roots:
                try:
                    if os.path.commonpath([parent, root]) == parent:
                        shadowed = True
                        break
                except ValueError:
                    continue
            if shadowed:
                continue
            kept_roots.append(root)
        keep_indices.add(index)

    # Preserve the configured order for stable UI labels and pagination.
    return [entry for index, entry in enumerate(eligible) if index in keep_indices]
