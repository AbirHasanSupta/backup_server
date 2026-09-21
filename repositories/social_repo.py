"""repositories/social_repo.py — Device Shares, Comments & Reactions Repository."""

from __future__ import annotations

from typing import Any, Dict, List, Tuple
from database import (
    toggle_reaction as db_toggle_reaction,
    get_media_reactions as db_get_media_reactions,
    get_reactions_for_media_ids as db_get_reactions_for_media_ids,
    get_comment_counts_for_media_ids as db_get_comment_counts_for_media_ids,
    add_comment as db_add_comment,
    get_comments_for_media as db_get_comments_for_media,
    delete_comment as db_delete_comment,
    is_media_or_post_creator as db_is_media_or_post_creator,
    get_share_target_devices as db_get_share_target_devices,
    create_device_share as db_create_device_share,
    get_device_shares_for_target as db_get_device_shares_for_target,
    get_device_shares_by_sharer as db_get_device_shares_by_sharer,
    get_device_share_by_id as db_get_device_share_by_id,
    get_share_targets_for_group as db_get_share_targets_for_group,
    delete_device_share_group as db_delete_device_share_group,
    delete_device_share as db_delete_device_share,
    remove_share_group_target as db_remove_share_group_target,
    remove_share_target as db_remove_share_target,
    is_share_target as db_is_share_target,
    get_unseen_share_notifications as db_get_unseen_share_notifications,
    mark_share_notifications_seen as db_mark_share_notifications_seen,
    add_share_group_targets as db_add_share_group_targets,
    edit_device_share_group_caption as db_edit_device_share_group_caption,
    MAX_COMMENT_LENGTH,
)


def toggle_reaction(media_id: int, source_id: str, emoji: str) -> Dict[str, Any]:
    return db_toggle_reaction(media_id, source_id, emoji)


def get_media_reactions(media_id: int) -> Dict[str, Any]:
    return db_get_media_reactions(media_id)


def get_reactions_for_media_ids(media_ids: List[int], current_source_id: str | None = None) -> Tuple[Dict[int, Dict[str, int]], Dict[int, List[str]]]:
    return db_get_reactions_for_media_ids(media_ids, current_source_id)


def get_comment_counts_for_media_ids(media_ids: List[int]) -> Dict[int, int]:
    return db_get_comment_counts_for_media_ids(media_ids)


def add_comment(media_id: int, source_id: str, text: str) -> Dict[str, Any]:
    return db_add_comment(media_id, source_id, text)


def get_comments_for_media(media_id: int) -> List[Dict[str, Any]]:
    return db_get_comments_for_media(media_id)


def delete_comment(comment_id: int, source_id: str) -> bool:
    return db_delete_comment(comment_id, source_id)


def is_media_or_post_creator(media_id: int, device_id: str) -> bool:
    return db_is_media_or_post_creator(media_id, device_id)


def get_share_target_devices(device_id: str) -> List[Dict[str, Any]]:
    return db_get_share_target_devices(device_id)


def create_device_share(
    shared_by_device_id: str,
    target_device_ids: List[str],
    caption: str | None,
    items: List[Dict[str, Any]],
    post_kind: str | None = None,
    post_title: str | None = None,
    share_group_id: str | None = None,
) -> Dict[str, Any]:
    return db_create_device_share(
        shared_by_device_id, target_device_ids, caption, items, post_kind, post_title, share_group_id
    )


def get_device_shares_for_target(device_id: str) -> List[Dict[str, Any]]:
    return db_get_device_shares_for_target(device_id)


def get_device_shares_by_sharer(device_id: str) -> List[Dict[str, Any]]:
    return db_get_device_shares_by_sharer(device_id)


def get_device_share_by_id(share_id: int) -> Dict[str, Any] | None:
    return db_get_device_share_by_id(share_id)


def get_share_targets_for_group(group_id: str, device_id: str) -> List[Dict[str, Any]]:
    return db_get_share_targets_for_group(group_id, device_id)


def delete_device_share_group(group_id: str, device_id: str) -> bool:
    return db_delete_device_share_group(group_id, device_id)


def delete_device_share(share_id: int, device_id: str) -> bool:
    return db_delete_device_share(share_id, device_id)


def remove_share_group_target(group_id: str, target_device_id: str, requester_device_id: str) -> bool:
    return db_remove_share_group_target(group_id, target_device_id, requester_device_id)


def remove_share_target(share_id: int, target_device_id: str, requester_device_id: str) -> bool:
    return db_remove_share_target(share_id, target_device_id, requester_device_id)


def is_share_target(share_id: int, device_id: str) -> bool:
    return db_is_share_target(share_id, device_id)


def get_unseen_share_notifications(device_id: str) -> List[Dict[str, Any]]:
    return db_get_unseen_share_notifications(device_id)


def mark_share_notifications_seen(device_id: str, group_ids: List[str]) -> None:
    db_mark_share_notifications_seen(device_id, group_ids)


def add_share_group_targets(group_id: str, new_target_ids: List[str], requester_device_id: str) -> bool:
    return db_add_share_group_targets(group_id, new_target_ids, requester_device_id)


def edit_device_share_group_caption(group_id: str, requester_device_id: str, new_caption: str | None) -> bool:
    return db_edit_device_share_group_caption(group_id, requester_device_id, new_caption)
