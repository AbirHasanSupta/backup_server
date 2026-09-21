"""services/reels_service.py — HyperPulse Short Video Reels Algorithm & Feed Engine."""

from __future__ import annotations

import math
import os
import re
import time
from typing import Any, Dict, List, Tuple

from repositories import device_repo, reels_repo, social_repo
from core.config import get_shared_dirs

_REEL_VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".3gp", ".m4v", ".wmv"}
_REEL_HASHTAG_RE = re.compile(r"#[\w\d_-]+", re.UNICODE)
_REEL_EMOJI_RE = re.compile(
    r"[\U0001F300-\U0001F9FF]|[\U0001FA00-\U0001FAFF]|[\U00002700-\U000027BF]|[\U0001F600-\U0001F64F]|[\U0001F680-\U0001F6FF]",
    re.UNICODE,
)
_REEL_WORD_RE = re.compile(r"\b[a-zA-Z]{3,15}\b")
_REEL_STOPWORDS = {
    "the", "and", "this", "that", "with", "from", "for", "have", "you", "your",
    "was", "were", "are", "been", "will", "what", "when", "where", "who", "which",
    "there", "here", "just", "some", "like", "into", "than", "then", "more", "also",
    "about", "would", "could", "should", "their", "them", "these", "those", "post", "reel"
}


class ReelsService:
    @staticmethod
    def extract_reel_tokens(caption: str | None) -> List[str]:
        if not caption:
            return []
        tokens: set[str] = set()
        for ht in _REEL_HASHTAG_RE.findall(caption):
            tokens.add(ht.lower())
        for em in _REEL_EMOJI_RE.findall(caption):
            tokens.add(em)
        for w in _REEL_WORD_RE.findall(caption.lower()):
            if w not in _REEL_STOPWORDS:
                tokens.add(w)
        return sorted(tokens)[:15]

    @staticmethod
    def calculate_bayesian_quality(reactions: int, comments: int, reposts: int, views: int) -> float:
        weighted_engage = (reactions * 1.0) + (comments * 1.8) + (reposts * 2.5)
        volume_score = min(1.0, math.log1p(weighted_engage) / math.log1p(30.0))
        if views <= 0:
            return volume_score
        k_prior = 5.0
        prior_rate = 0.08
        smoothed_rate = (weighted_engage + k_prior * prior_rate) / (views + k_prior)
        rate_score = min(1.0, smoothed_rate / 0.25)
        return round(0.55 * volume_score + 0.45 * rate_score, 4)

    @staticmethod
    def deterministic_seed_jitter(key: str, seed: int) -> float:
        h = 2166136261
        combined = f"{key}_{seed}"
        for b in combined.encode("utf-8"):
            h = ((h ^ b) * 16777619) & 0xFFFFFFFF
        return ((h % 10000) / 10000.0)

    def build_reels_feed(
        self,
        device_id: str,
        offset: int = 0,
        limit: int = 30,
        seed: int = 0,
    ) -> Tuple[List[Dict[str, Any]], bool, int]:
        saved_ids = reels_repo.get_saved_reel_ids(device_id)
        received = social_repo.get_device_shares_for_target(device_id)

        seen_share_ids = set()
        all_shares = []
        for s in received:
            if s["shared_by_device_id"] != device_id and s["share_id"] not in seen_share_ids:
                seen_share_ids.add(s["share_id"])
                all_shares.append({**s, "is_own_post": False})

        def _is_video(s):
            ext = os.path.splitext(s["relative_path"])[1].lower()
            return s["source_type"] in ("rewind", "rewind_shared") or ext in _REEL_VIDEO_EXTS

        reel_shares = [s for s in all_shares if _is_video(s)]
        media_ids = [s["media_id"] for s in reel_shares if s.get("media_id")]

        counts_map, user_map = social_repo.get_reactions_for_media_ids(media_ids, current_source_id=device_id)
        comment_counts = social_repo.get_comment_counts_for_media_ids(media_ids)
        repost_counts = reels_repo.get_repost_counts_for_media_ids(media_ids)
        user_reposted_media, user_reposted_shares = reels_repo.get_user_reposted_info(device_id)
        share_ids = [s["share_id"] for s in reel_shares]
        view_counts = reels_repo.get_reel_view_counts(share_ids)
        durations_map = reels_repo.get_reel_durations(share_ids)
        now_ts = int(time.time())

        reels = []
        for s in reel_shares:
            is_repost = s.get("post_kind") == "reel_repost" or bool(s.get("original_shared_by_device_id"))
            orig_id = s.get("original_shared_by_device_id") or s["shared_by_device_id"]
            orig_name = s.get("orig_shared_by_name") if s.get("original_shared_by_device_id") else s.get("shared_by_name")
            orig_username = s.get("orig_shared_by_username") if s.get("original_shared_by_device_id") else s.get("shared_by_username")
            reposter_name = s.get("shared_by_name")
            reposter_username = s.get("shared_by_username")

            has_reposted = (
                (s.get("media_id") in user_reposted_media if s.get("media_id") else False)
                or (s["share_id"] in user_reposted_shares)
                or (s.get("post_kind") == "reel_repost" and s.get("shared_by_device_id") == device_id)
            )

            total_rx = sum(counts_map.get(s["media_id"], {}).values()) if s.get("media_id") else 0
            comm_cnt = comment_counts.get(s["media_id"], 0) if s.get("media_id") else 0
            rep_cnt = repost_counts.get(s["media_id"], 0) if s.get("media_id") else 0
            v_cnt = view_counts.get(s["share_id"], 0)
            q_score = self.calculate_bayesian_quality(total_rx, comm_cnt, rep_cnt, v_cnt)
            cap_text = s.get("group_caption") or s.get("caption")
            tokens = self.extract_reel_tokens(cap_text)

            shared_by = device_repo.format_device_display_name(
                s.get("shared_by_username"), s.get("shared_by_name")
            ) or s["shared_by_device_id"]

            reels.append({
                "reel_id": str(s["share_id"]),
                "share_id": s["share_id"],
                "media_id": s.get("media_id"),
                "path": s["relative_path"],
                "shared_by": shared_by,
                "shared_by_device_id": s["shared_by_device_id"],
                "is_repost": is_repost,
                "user_has_reposted": has_reposted,
                "original_author": {
                    "device_id": orig_id,
                    "name": orig_name,
                    "username": orig_username,
                    "display_name": device_repo.format_device_display_name(orig_username, orig_name) or orig_id,
                },
                "reposted_by": {
                    "device_id": s["shared_by_device_id"],
                    "name": reposter_name,
                    "username": reposter_username,
                    "display_name": device_repo.format_device_display_name(reposter_username, reposter_name) or s["shared_by_device_id"],
                } if is_repost else None,
                "caption": cap_text,
                "created_at": s["created_at"],
                "reaction_counts": counts_map.get(s["media_id"], {}) if s.get("media_id") else {},
                "user_reactions": user_map.get(s["media_id"], []) if s.get("media_id") else [],
                "comment_count": comm_cnt,
                "repost_count": rep_cnt,
                "view_count": v_cnt,
                "duration": durations_map.get(s["share_id"], 0.0),
                "quality_score": round(q_score, 4),
                "tokens": tokens,
                "size": s.get("size") or 0,
                "is_own_post": s["is_own_post"],
                "is_saved": str(s["share_id"]) in saved_ids,
                "is_unseen": not bool(s.get("seen", 1)),
                "group_id": s.get("share_group_id"),
            })

        def _candidate_rank(r):
            is_unseen = 1 if r["is_unseen"] else 0
            created_at = r.get("created_at") or now_ts
            age_days = max(0.0, (now_ts - created_at) / 86400.0)
            recency = math.exp(-age_days / 14.0)
            q = r.get("quality_score", 0.0)
            jitter = self.deterministic_seed_jitter(str(r["reel_id"]), seed) * 0.30
            social_boost = 0.08 if r.get("is_repost") else 0.0
            return (10000.0 if is_unseen else 0.0) + (recency * 0.40) + (q * 0.35) + social_boost + jitter

        reels.sort(key=_candidate_rank, reverse=True)
        total = len(reels)
        page = reels[offset: offset + limit]
        has_more = (offset + limit) < total
        return page, has_more, total


reels_service = ReelsService()
