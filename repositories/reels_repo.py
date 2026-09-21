"""repositories/reels_repo.py — Reels Feed, Bookmarking, Reposts & Telemetry Repository."""

from __future__ import annotations

from typing import Any, Dict, List, Set, Tuple
from database import (
    get_or_create_media_id as db_get_or_create_media_id,
    get_or_create_library_reel_share as db_get_or_create_library_reel_share,
    bulk_get_or_create_library_reel_shares as db_bulk_get_or_create_library_reel_shares,
    save_reel as db_save_reel,
    unsave_reel as db_unsave_reel,
    toggle_save_reel as db_toggle_save_reel,
    get_saved_reel_ids as db_get_saved_reel_ids,
    get_saved_reels as db_get_saved_reels,
    get_liked_reels as db_get_liked_reels,
    get_reposted_reels as db_get_reposted_reels,
    repost_reel as db_repost_reel,
    cancel_repost as db_cancel_repost,
    get_repost_counts_for_media_ids as db_get_repost_counts_for_media_ids,
    get_user_reposted_media_ids as db_get_user_reposted_media_ids,
    get_user_reposted_info as db_get_user_reposted_info,
    get_reel_view_counts as db_get_reel_view_counts,
    get_reel_durations as db_get_reel_durations,
    record_reel_telemetry as db_record_reel_telemetry,
)


def get_or_create_media_id(source_type: str, source_key: str, relative_path: str, cap_time: int | None = None) -> int:
    return db_get_or_create_media_id(source_type, source_key, relative_path, cap_time)


def bulk_get_or_create_library_reel_shares(candidates: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return db_bulk_get_or_create_library_reel_shares(candidates)


def toggle_save_reel(device_id: str, reel_id: str, share_id: int, media_id: int | None = None) -> bool:
    return db_toggle_save_reel(device_id, reel_id, share_id, media_id)


def get_saved_reel_ids(device_id: str) -> Set[str]:
    return db_get_saved_reel_ids(device_id)


def get_saved_reels(device_id: str, offset: int = 0, limit: int = 50) -> List[Dict[str, Any]]:
    return db_get_saved_reels(device_id, offset, limit)


def get_liked_reels(device_id: str, offset: int = 0, limit: int = 50) -> List[Dict[str, Any]]:
    return db_get_liked_reels(device_id, offset, limit)


def get_reposted_reels(device_id: str, offset: int = 0, limit: int = 50) -> List[Dict[str, Any]]:
    return db_get_reposted_reels(device_id, offset, limit)


def repost_reel(device_id: str, share_id: int, target_device_ids: List[str], caption: str | None = None) -> Dict[str, Any]:
    return db_repost_reel(device_id, share_id, target_device_ids, caption)


def cancel_repost(device_id: str, share_id: int) -> Dict[str, Any]:
    return db_cancel_repost(device_id, share_id)


def get_repost_counts_for_media_ids(media_ids: List[int]) -> Dict[int, int]:
    return db_get_repost_counts_for_media_ids(media_ids)


def get_user_reposted_info(device_id: str) -> Tuple[Set[int], Set[int]]:
    return db_get_user_reposted_info(device_id)


def get_reel_view_counts(share_ids: List[int]) -> Dict[int, int]:
    return db_get_reel_view_counts(share_ids)


def get_reel_durations(share_ids: List[int]) -> Dict[int, float]:
    return db_get_reel_durations(share_ids)


def record_reel_telemetry(device_id: str, events: List[Dict[str, Any]]) -> int:
    return db_record_reel_telemetry(device_id, events)
