"""services/media_service.py — Memories, Flashbacks, Quiz & Wrapped Service."""

from __future__ import annotations

import random
from datetime import date, datetime
from typing import Any, Dict, List, Tuple

from repositories import media_repo, device_repo
from memories import get_todays_memories, get_recent_memories


class MediaService:
    @staticmethod
    def get_memories_today(device_id: str) -> Dict[str, Any]:
        return get_todays_memories(device_id)

    @staticmethod
    def get_memories_recent(device_id: str, days_back: int = 7) -> Dict[str, Any]:
        return get_recent_memories(device_id, days=days_back)

    @staticmethod
    def get_flashback(device_id: str) -> Dict[str, Any] | None:
        sources = [device_id]
        row = media_repo.get_random_media_row(sources)
        if not row:
            return None
        return {
            "source_type": row["source_type"],
            "source_key": row["source_key"],
            "relative_path": row["relative_path"],
            "cap_time": row.get("cap_time"),
            "cap_year": row.get("cap_year"),
        }

    @staticmethod
    def get_wrapped_stats(device_id: str, year: int) -> Dict[str, Any]:
        return media_repo.get_year_wrapped_stats([device_id], year)

    @staticmethod
    def get_quiz_items(device_id: str, count: int = 5) -> List[Dict[str, Any]]:
        sources = [device_id]
        pool = media_repo.get_quiz_photo_pool(sources, min_years_spread=2, pool_size=30)
        if len(pool) < count:
            pool = media_repo.get_quiz_photo_pool(sources, min_years_spread=1, pool_size=30)
        
        all_years = media_repo.get_distinct_cap_years(sources)
        if len(all_years) < 2:
            current_year = date.today().year
            all_years = list(range(current_year - 5, current_year + 1))

        selected = random.sample(pool, min(count, len(pool)))
        quiz_items = []

        for item in selected:
            correct_year = item["cap_year"]
            other_years = [y for y in all_years if y != correct_year]
            distractors = random.sample(other_years, min(3, len(other_years)))
            options = sorted([correct_year] + distractors)
            quiz_items.append({
                "source_type": item["source_type"],
                "source_key": item["source_key"],
                "relative_path": item["relative_path"],
                "correct_year": correct_year,
                "options": options,
            })

        return quiz_items


media_service = MediaService()
