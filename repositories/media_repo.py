"""repositories/media_repo.py — Media Index & Calendar Repository."""

from __future__ import annotations

import time
from typing import Any, Dict, List
from repositories.base import execute_read_one, execute_read_query, execute_write, is_postgres
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
    if is_postgres():
        now = int(time.time())
        sql = """
        INSERT INTO media_index (source_type, source_key, relative_path, size, modified_time,
                                 cap_time, cap_year, cap_month, cap_day, has_gps, lat, lon, duration, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_type, source_key, relative_path) DO UPDATE SET
            size = EXCLUDED.size,
            modified_time = EXCLUDED.modified_time,
            cap_time = EXCLUDED.cap_time,
            cap_year = EXCLUDED.cap_year,
            cap_month = EXCLUDED.cap_month,
            cap_day = EXCLUDED.cap_day,
            has_gps = EXCLUDED.has_gps,
            lat = EXCLUDED.lat,
            lon = EXCLUDED.lon,
            duration = EXCLUDED.duration,
            indexed_at = EXCLUDED.indexed_at
        """
        execute_write(
            sql,
            (source_type, source_key, relative_path, size, modified_time, cap_time, cap_year, cap_month, cap_day, bool(has_gps), lat, lon, duration, now),
        )
        return
    db_upsert_media_index_row(
        source_type, source_key, relative_path, size, modified_time,
        cap_time, cap_year, cap_month, cap_day, has_gps, lat, lon, duration
    )


def batch_upsert_media_index_rows(rows: List[Dict[str, Any]]) -> None:
    if is_postgres():
        for r in rows:
            upsert_media_index_row(
                r["source_type"],
                r["source_key"],
                r["relative_path"],
                r.get("size", 0),
                r.get("modified_time", 0),
                r.get("cap_time") or r.get("capture_time"),
                r.get("cap_year"),
                r.get("cap_month"),
                r.get("cap_day"),
                bool(r.get("has_gps") or r.get("gps_checked")),
                r.get("lat") or r.get("cap_lat"),
                r.get("lon") or r.get("cap_lon"),
                r.get("duration"),
            )
        return
    db_batch_upsert_media_index_rows(rows)


def get_media_index_cache(source_type: str, source_key: str) -> Dict[str, Dict[str, Any]]:
    if is_postgres():
        rows = execute_read_query(
            "SELECT relative_path, size, modified_time, cap_time, cap_year, cap_month, cap_day, has_gps, lat, lon, duration FROM media_index WHERE source_type = ? AND source_key = ?",
            (source_type, source_key),
        )
        return {r["relative_path"]: r for r in rows}
    return db_get_media_index_cache(source_type, source_key)


def get_media_for_day(source_key: str, month: int, day: int) -> List[Dict[str, Any]]:
    if is_postgres():
        return execute_read_query(
            "SELECT * FROM media_index WHERE source_key = ? AND cap_month = ? AND cap_day = ? ORDER BY cap_time DESC",
            (source_key, month, day),
        )
    return db_get_media_for_day(source_key, month, day)


def get_media_for_days_multi(source_keys: List[str], month: int, day: int) -> List[Dict[str, Any]]:
    if is_postgres():
        if not source_keys:
            return []
        placeholders = ",".join(["?"] * len(source_keys))
        return execute_read_query(
            f"SELECT * FROM media_index WHERE source_key IN ({placeholders}) AND cap_month = ? AND cap_day = ? ORDER BY cap_time DESC",
            list(source_keys) + [month, day],
        )
    return db_get_media_for_days_multi(source_keys, month, day)


def get_media_for_year_month(source_key: str, year: int, month: int | None = None) -> List[Dict[str, Any]]:
    if is_postgres():
        if month:
            return execute_read_query(
                "SELECT * FROM media_index WHERE source_key = ? AND cap_year = ? AND cap_month = ? ORDER BY cap_time ASC",
                (source_key, year, month),
            )
        return execute_read_query(
            "SELECT * FROM media_index WHERE source_key = ? AND cap_year = ? ORDER BY cap_time ASC",
            (source_key, year),
        )
    return db_get_media_for_year_month(source_key, year, month)


def get_media_for_ymd_list(source_keys: List[str], ymd_list: List[tuple]) -> List[Dict[str, Any]]:
    return db_get_media_for_ymd_list(source_keys, ymd_list)


def get_distinct_cap_years(source_keys: List[str]) -> List[int]:
    if is_postgres():
        if not source_keys:
            return []
        placeholders = ",".join(["?"] * len(source_keys))
        rows = execute_read_query(
            f"SELECT DISTINCT cap_year FROM media_index WHERE source_key IN ({placeholders}) AND cap_year IS NOT NULL ORDER BY cap_year ASC",
            source_keys,
        )
        return [r["cap_year"] for r in rows if r.get("cap_year")]
    return db_get_distinct_cap_years(source_keys)


def get_year_wrapped_stats(source_keys: List[str], year: int) -> Dict[str, Any]:
    if is_postgres():
        if not source_keys:
            return {}
        placeholders = ",".join(["?"] * len(source_keys))
        rows = execute_read_query(
            f"SELECT COUNT(*) as total_media, COALESCE(SUM(size), 0) as total_size FROM media_index WHERE source_key IN ({placeholders}) AND cap_year = ?",
            list(source_keys) + [year],
        )
        return rows[0] if rows else {}
    return db_get_year_wrapped_stats(source_keys, year)


def get_quiz_photo_pool(source_keys: List[str], min_years_spread: int = 3, pool_size: int = 40) -> List[Dict[str, Any]]:
    return db_get_quiz_photo_pool(source_keys, min_years_spread, pool_size)


def get_random_media_row(source_keys: List[str]) -> Dict[str, Any] | None:
    if is_postgres():
        if not source_keys:
            return None
        placeholders = ",".join(["?"] * len(source_keys))
        return execute_read_one(
            f"SELECT * FROM media_index WHERE source_key IN ({placeholders}) ORDER BY RANDOM() LIMIT 1",
            source_keys,
        )
    return db_get_random_media_row(source_keys)


def get_geotagged_media(source_key: str) -> List[Dict[str, Any]]:
    if is_postgres():
        return execute_read_query(
            "SELECT * FROM media_index WHERE source_key = ? AND has_gps = TRUE ORDER BY cap_time DESC",
            (source_key,),
        )
    return db_get_geotagged_media(source_key)


def prune_media_index(source_type: str, source_key: str, valid_paths: set) -> int:
    return db_prune_media_index(source_type, source_key, valid_paths)


def clear_media_index(source_type: str, source_key: str) -> None:
    if is_postgres():
        execute_write("DELETE FROM media_index WHERE source_type = ? AND source_key = ?", (source_type, source_key))
        return
    db_clear_media_index(source_type, source_key)


def get_media_index_stats() -> Dict[str, Any]:
    if is_postgres():
        row = execute_read_one("SELECT COUNT(*) as total_indexed, COUNT(DISTINCT source_key) as total_sources FROM media_index")
        return row or {"total_indexed": 0, "total_sources": 0}
    return db_get_media_index_stats()
