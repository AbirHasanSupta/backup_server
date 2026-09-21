"""services/feed_service.py — Unified Social Feed & Device Sharing Service."""

from __future__ import annotations

import os
from collections import OrderedDict
from typing import Any, Dict, List, Tuple

from repositories import device_repo, social_repo


class FeedService:
    @staticmethod
    def format_display_name(username: str | None, device_name: str | None, device_model: str | None = None) -> str | None:
        return device_repo.format_device_display_name(
            username=username,
            device_name=device_name,
            device_model=device_model,
            fallback="",
        ) or None

    def build_unified_feed(
        self,
        device_id: str,
        offset: int = 0,
        limit: int = 50,
    ) -> Tuple[List[Dict[str, Any]], bool, int]:
        """Build and paginate the unified device-to-device feed for this device."""
        video_exts = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".3gp", ".m4v", ".wmv"}

        # 1. Received shares and own sent shares
        received = social_repo.get_device_shares_for_target(device_id)
        sent = social_repo.get_device_shares_by_sharer(device_id)

        seen_share_ids = set()
        all_shares = []

        for s in received:
            if s["share_id"] not in seen_share_ids:
                seen_share_ids.add(s["share_id"])
                all_shares.append({**s, "is_own_post": s["shared_by_device_id"] == device_id})

        for s in sent:
            if s["share_id"] not in seen_share_ids:
                seen_share_ids.add(s["share_id"])
                all_shares.append({**s, "is_own_post": True})

        # Exclude shares dedicated strictly to Reels
        all_shares = [
            s for s in all_shares
            if s.get("post_kind") not in ("reel_repost", "reels_only")
        ]

        # Group shares by share_group_id
        groups: OrderedDict[str, dict] = OrderedDict()
        for s in all_shares:
            gid = s.get("share_group_id") or f"__solo__{s['share_id']}"
            if gid not in groups:
                shared_by = self.format_display_name(
                    s.get("shared_by_username"), s.get("shared_by_name")
                ) or s["shared_by_device_id"]

                groups[gid] = {
                    "group_id": gid,
                    "caption": s.get("group_caption") or s.get("caption"),
                    "shared_by": shared_by,
                    "shared_by_device_id": s["shared_by_device_id"],
                    "created_at": s["created_at"],
                    "is_own_post": s["is_own_post"],
                    "post_kind": s.get("post_kind"),
                    "post_title": s.get("post_title"),
                    "items": [],
                }

            ext = os.path.splitext(s["relative_path"])[1].lower()
            groups[gid]["items"].append({
                "share_id": s["share_id"],
                "media_id": s["media_id"],
                "path": s["relative_path"],
                "size": s["size"],
                "modified_time": s["modified_time"],
                "is_video": s["source_type"] in ("rewind", "rewind_shared") or ext in video_exts,
            })

        sorted_groups = sorted(groups.values(), key=lambda g: g["created_at"], reverse=True)
        for g in sorted_groups:
            g["items"].sort(key=lambda it: it["share_id"])

        all_media_ids = [item["media_id"] for g in sorted_groups for item in g["items"]]

        counts_map, user_map = social_repo.get_reactions_for_media_ids(all_media_ids, current_source_id=device_id)
        comment_counts = social_repo.get_comment_counts_for_media_ids(all_media_ids)

        posts = []
        for g in sorted_groups:
            anchor_mid = g["items"][0]["media_id"] if g["items"] else None
            posts.append({
                "kind": "share",
                "group_id": g["group_id"],
                "caption": g["caption"],
                "shared_by": g["shared_by"],
                "shared_by_device_id": g["shared_by_device_id"],
                "created_at": g["created_at"],
                "is_own_post": g["is_own_post"],
                "post_kind": g.get("post_kind"),
                "post_title": g.get("post_title"),
                "media_id": anchor_mid,
                "reaction_counts": counts_map.get(anchor_mid, {}) if anchor_mid else {},
                "user_reactions": user_map.get(anchor_mid, []) if anchor_mid else [],
                "comment_count": comment_counts.get(anchor_mid, 0) if anchor_mid else 0,
                "items": g["items"],
            })

        total = len(posts)
        page = posts[offset: offset + limit]
        has_more = (offset + limit) < total
        return page, has_more, total


feed_service = FeedService()
