"""repositories/media_repo.py — Media Index & Calendar Repository."""

from __future__ import annotations

from typing import Any, Dict, List
from database import (
    upsert_media_index_row as db_upsert_media_index_row,
    batch_upsert_media_index_rows as db_batch_upsert_media_index_rows,
    get_media_index_cache as db_get_media_index_cache,
    get_media_for_day as db_get_media_for_day,
    get_media_for_days_multi as db_get_media_for_days_multi,
    get_media_for_year_month as db_get_media_for_year_month,
    get_media_for_ymd_list as db_get_media_for_ymd_list,
    get_distinct_cap_years as db_get_distinct_cap_years,
    get_year_wrapped_stats as db_get_year_wrapped_stats,
    get_quiz_photo_pool as db_get_quiz_photo_pool,
    get_random_media_row as db_get_random_media_row,
    get_geotagged_media as db_get_geotagged_media,
    prune_media_index as db_prune_media_index,
    clear_media_index as db_clear_media_index,
    get_media_index_stats as db_get_media_index_stats,
)


def upsert_media_index_row(
    source_type: str,
    source_key: str,
    relative_path: str,
    size: int,
    modified_time: int,
    cap_time: int | None,
    cap_year: int | None,
    cap_month: int | None,
    cap_day: int | None,
    has_gps: bool = False,
    lat: float | None = None,
    lon: float | None = None,
    duration: float | None = None,
) -> None:
    db_upsert_media_index_row(
        source_type, source_key, relative_path, size, modified_time,
        cap_time, cap_year, cap_month, cap_day, has_gps, lat, lon, duration
    )


def batch_upsert_media_index_rows(rows: List[Dict[str, Any]]) -> None:
    db_batch_upsert_media_index_rows(rows)


def get_media_index_cache(source_type: str, source_key: str) -> Dict[str, Dict[str, Any]]:
    return db_get_media_index_cache(source_type, source_key)


def get_media_for_day(source_key: str, month: int, day: int) -> List[Dict[str, Any]]:
    return db_get_media_for_day(source_key, month, day)


def get_media_for_days_multi(source_keys: List[str], month: int, day: int) -> List[Dict[str, Any]]:
    return db_get_media_for_days_multi(source_keys, month, day)


def get_media_for_year_month(source_key: str, year: int, month: int | None = None) -> List[Dict[str, Any]]:
    return db_get_media_for_year_month(source_key, year, month)


def get_media_for_ymd_list(source_keys: List[str], ymd_list: List[tuple]) -> List[Dict[str, Any]]:
    return db_get_media_for_ymd_list(source_keys, ymd_list)


def get_distinct_cap_years(source_keys: List[str]) -> List[int]:
    return db_get_distinct_cap_years(source_keys)


def get_year_wrapped_stats(source_keys: List[str], year: int) -> Dict[str, Any]:
    return db_get_year_wrapped_stats(source_keys, year)


def get_quiz_photo_pool(source_keys: List[str], min_years_spread: int = 3, pool_size: int = 40) -> List[Dict[str, Any]]:
    return db_get_quiz_photo_pool(source_keys, min_years_spread, pool_size)


def get_random_media_row(source_keys: List[str]) -> Dict[str, Any] | None:
    return db_get_random_media_row(source_keys)


def get_geotagged_media(source_key: str) -> List[Dict[str, Any]]:
    return db_get_geotagged_media(source_key)


def prune_media_index(source_type: str, source_key: str, valid_paths: set) -> int:
    return db_prune_media_index(source_type, source_key, valid_paths)


def clear_media_index(source_type: str, source_key: str) -> None:
    db_clear_media_index(source_type, source_key)


def get_media_index_stats() -> Dict[str, Any]:
    return db_get_media_index_stats()
