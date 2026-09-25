"""repositories/media_repo.py — Media Index & Calendar Repository."""

from __future__ import annotations

import time
from typing import Any, Dict, List, Set, Tuple
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
    get_scan_dirs as db_get_scan_dirs,
    upsert_scan_dirs as db_upsert_scan_dirs,
)


def _normalize_row(r: dict | None) -> dict | None:
    if not r:
        return None
    res = dict(r)
    # Map cap_time -> capture_time and vice versa
    if "cap_time" in res and "capture_time" not in res:
        res["capture_time"] = res["cap_time"]
    elif "capture_time" in res and "cap_time" not in res:
        res["cap_time"] = res["capture_time"]

    # Map lat/lon -> cap_lat/cap_lon and vice versa
    if "lat" in res and "cap_lat" not in res:
        res["cap_lat"] = res["lat"]
    elif "cap_lat" in res and "lat" not in res:
        res["lat"] = res["cap_lat"]

    if "lon" in res and "cap_lon" not in res:
        res["cap_lon"] = res["lon"]
    elif "cap_lon" in res and "lon" not in res:
        res["lon"] = res["cap_lon"]

    # Map has_gps -> gps_checked and vice versa
    if "has_gps" in res and "gps_checked" not in res:
        res["gps_checked"] = res["has_gps"]
    elif "gps_checked" in res and "has_gps" not in res:
        res["has_gps"] = res["gps_checked"]

    return res


def _build_source_filter(sources: list[tuple[str, str]] | list[str] | str) -> tuple[str, list[Any]]:
    if not sources:
        return "1=0", []
    if isinstance(sources, str):
        return "(source_key = ?)", [sources]
    if isinstance(sources, list):
        if not sources:
            return "1=0", []
        if isinstance(sources[0], tuple):
            clauses = []
            params: list[Any] = []
            for stype, skey in sources:
                clauses.append("(source_type = ? AND source_key = ?)")
                params.extend([stype, skey])
            return f"({' OR '.join(clauses)})", params
        elif isinstance(sources[0], str):
            placeholders = ",".join(["?"] * len(sources))
            return f"(source_key IN ({placeholders}))", list(sources)
    return "1=0", []


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
                r.get("cap_time") if r.get("cap_time") is not None else r.get("capture_time"),
                r.get("cap_year"),
                r.get("cap_month"),
                r.get("cap_day"),
                bool(r.get("has_gps") or r.get("gps_checked")),
                r.get("lat") if r.get("lat") is not None else r.get("cap_lat"),
                r.get("lon") if r.get("lon") is not None else r.get("cap_lon"),
                r.get("duration"),
            )
        return
    db_batch_upsert_media_index_rows(rows)


def get_media_index_cache(source_type: str, source_key: str) -> Dict[str, tuple[int, int, str | None, float | None, bool]]:
    if is_postgres():
        rows = execute_read_query(
            "SELECT relative_path, size, modified_time, lat, has_gps FROM media_index WHERE source_type = ? AND source_key = ?",
            (source_type, source_key),
        )
        return {
            r["relative_path"]: (
                r["size"],
                r["modified_time"],
                None,
                r.get("lat"),
                bool(r.get("has_gps")),
            )
            for r in rows
        }
    return db_get_media_index_cache(source_type, source_key)


def get_media_for_day(
    source_type_and_keys: list[tuple[str, str]] | list[str] | str,
    month: int,
    day: int,
    exclude_year: int | None = None,
) -> List[Dict[str, Any]]:
    if is_postgres():
        where_source, params = _build_source_filter(source_type_and_keys)
        if where_source == "1=0":
            return []
        params.extend([month, day])
        exclude_clause = ""
        if exclude_year is not None:
            exclude_clause = "AND (cap_year IS NULL OR cap_year != ?)"
            params.append(exclude_year)
        sql = f"""
        SELECT source_type, source_key, relative_path, size, modified_time,
               cap_time, cap_year, cap_month, cap_day, has_gps, lat, lon, duration
        FROM media_index
        WHERE {where_source}
          AND cap_month = ?
          AND cap_day = ?
          {exclude_clause}
        ORDER BY cap_time DESC, relative_path ASC
        """
        rows = execute_read_query(sql, params)
        return [_normalize_row(r) for r in rows if r]
    return db_get_media_for_day(source_type_and_keys, month, day, exclude_year or 0)


def get_media_for_days_multi(
    source_type_and_keys: list[tuple[str, str]] | list[str] | str,
    month_day_pairs: list[tuple[int, int]],
) -> List[Dict[str, Any]]:
    if is_postgres():
        if not month_day_pairs:
            return []
        where_source, params = _build_source_filter(source_type_and_keys)
        if where_source == "1=0":
            return []
        day_clauses = []
        for m, d in month_day_pairs:
            day_clauses.append("(cap_month = ? AND cap_day = ?)")
            params.extend([m, d])
        where_days = " OR ".join(day_clauses)
        sql = f"""
        SELECT source_type, source_key, relative_path, size, modified_time,
               cap_time, cap_year, cap_month, cap_day, has_gps, lat, lon, duration
        FROM media_index
        WHERE {where_source}
          AND ({where_days})
        ORDER BY cap_time DESC, relative_path ASC
        """
        rows = execute_read_query(sql, params)
        return [_normalize_row(r) for r in rows if r]
    return db_get_media_for_days_multi(source_type_and_keys, month_day_pairs)


def get_media_for_year_window(
    source_type_and_keys: list[tuple[str, str]] | list[str] | str,
    year: int,
    month_day_pairs: list[tuple[int, int]],
) -> List[Dict[str, Any]]:
    if is_postgres():
        if not month_day_pairs:
            return []
        where_source, params = _build_source_filter(source_type_and_keys)
        if where_source == "1=0":
            return []
        day_clauses = []
        for m, d in month_day_pairs:
            day_clauses.append("(cap_month = ? AND cap_day = ?)")
            params.extend([m, d])
        where_days = " OR ".join(day_clauses)
        params.append(year)
        sql = f"""
        SELECT source_type, source_key, relative_path, size, modified_time,
               cap_time, cap_year, cap_month, cap_day, has_gps, lat, lon, duration
        FROM media_index
        WHERE {where_source}
          AND ({where_days})
          AND cap_year = ?
        ORDER BY cap_time DESC, relative_path ASC
        """
        rows = execute_read_query(sql, params)
        return [_normalize_row(r) for r in rows if r]
    from database import get_media_for_year_window as db_get_media_for_year_window
    return db_get_media_for_year_window(source_type_and_keys, year, month_day_pairs)


def get_media_for_ymd_list(
    source_type_and_keys: list[tuple[str, str]] | list[str] | str,
    ymd_list: list[tuple[int, int, int]],
) -> List[Dict[str, Any]]:
    if is_postgres():
        if not ymd_list:
            return []
        where_source, params = _build_source_filter(source_type_and_keys)
        if where_source == "1=0":
            return []
        ymd_clauses = []
        for y, m, d in ymd_list:
            ymd_clauses.append("(cap_year = ? AND cap_month = ? AND cap_day = ?)")
            params.extend([y, m, d])
        where_ymd = " OR ".join(ymd_clauses)
        sql = f"""
        SELECT source_type, source_key, relative_path, size, modified_time,
               cap_time, cap_year, cap_month, cap_day, has_gps, lat, lon, duration
        FROM media_index
        WHERE {where_source}
          AND ({where_ymd})
        ORDER BY cap_time DESC, relative_path ASC
        """
        rows = execute_read_query(sql, params)
        return [_normalize_row(r) for r in rows if r]
    return db_get_media_for_ymd_list(source_type_and_keys, ymd_list)


def get_media_for_year_month(
    source_type_and_keys: list[tuple[str, str]] | list[str] | str,
    year: int,
    month: int | None = None,
    limit: int = 20,
    *,
    order: str = "time",
) -> List[Dict[str, Any]]:
    if is_postgres():
        where_source, params = _build_source_filter(source_type_and_keys)
        if where_source == "1=0":
            return []
        params.append(year)
        month_clause = ""
        if month:
            month_clause = "AND cap_month = ?"
            params.append(month)
        order_sql = "ORDER BY RANDOM()" if order == "random" else "ORDER BY cap_time ASC"
        limit_sql = ""
        if limit is not None and limit > 0:
            limit_sql = "LIMIT ?"
            params.append(limit)
        sql = f"""
        SELECT source_type, source_key, relative_path, size, modified_time,
               cap_time, cap_year, cap_month, cap_day, has_gps, lat, lon, duration
        FROM media_index
        WHERE {where_source} AND cap_year = ? {month_clause}
        {order_sql}
        {limit_sql}
        """
        rows = execute_read_query(sql, params)
        return [_normalize_row(r) for r in rows if r]
    return db_get_media_for_year_month(source_type_and_keys, year, month, limit=limit, order=order)


def get_distinct_cap_years(
    source_type_and_keys: list[tuple[str, str]] | list[str] | str,
) -> List[int]:
    if is_postgres():
        where_source, params = _build_source_filter(source_type_and_keys)
        if where_source == "1=0":
            return []
        sql = f"""
        SELECT DISTINCT cap_year
        FROM media_index
        WHERE {where_source} AND cap_year IS NOT NULL
        ORDER BY cap_year ASC
        """
        rows = execute_read_query(sql, params)
        return [int(r["cap_year"]) for r in rows if r.get("cap_year") is not None]
    return db_get_distinct_cap_years(source_type_and_keys)


def get_year_wrapped_stats(
    source_type_and_keys: list[tuple[str, str]] | list[str] | str,
    year: int,
) -> List[Dict[str, Any]]:
    if is_postgres():
        where_source, params = _build_source_filter(source_type_and_keys)
        if where_source == "1=0":
            return []
        params.append(year)
        sql = f"""
        SELECT relative_path, size, cap_month
        FROM media_index
        WHERE {where_source} AND cap_year = ?
        """
        return execute_read_query(sql, params)
    return db_get_year_wrapped_stats(source_type_and_keys, year)


def get_quiz_photo_pool(
    source_type_and_keys: list[tuple[str, str]] | list[str] | str,
    limit: int = 800,
) -> List[Dict[str, Any]]:
    if is_postgres():
        where_source, params = _build_source_filter(source_type_and_keys)
        if where_source == "1=0":
            return []
        params.append(max(1, limit))
        sql = f"""
        SELECT source_type, source_key, relative_path, cap_year, cap_time
        FROM media_index
        WHERE {where_source} AND cap_year IS NOT NULL
        ORDER BY RANDOM()
        LIMIT ?
        """
        rows = execute_read_query(sql, params)
        return [_normalize_row(r) for r in rows if r]
    return db_get_quiz_photo_pool(source_type_and_keys, limit=limit)


def get_random_media_row(
    source_type_and_keys: list[tuple[str, str]] | list[str] | str,
    allowed_exts: set[str] | None = None,
) -> Dict[str, Any] | None:
    if is_postgres():
        where_source, params = _build_source_filter(source_type_and_keys)
        if where_source == "1=0":
            return None
        ext_clause = ""
        if allowed_exts:
            ext_parts = []
            for ext in sorted(allowed_exts):
                ext_parts.append("LOWER(relative_path) LIKE ?")
                params.append(f"%{ext.lower()}")
            ext_clause = f"AND ({' OR '.join(ext_parts)})"
        sql = f"""
        SELECT source_type, source_key, relative_path, size, cap_time, cap_year, lat, lon, has_gps, duration
        FROM media_index
        WHERE {where_source}
        {ext_clause}
        ORDER BY RANDOM()
        LIMIT 1
        """
        row = execute_read_one(sql, params)
        return _normalize_row(row)
    return db_get_random_media_row(source_type_and_keys, allowed_exts=allowed_exts)


def get_random_media_item(source_type: str, source_key: str) -> Dict[str, Any] | None:
    return get_random_media_row([(source_type, source_key)])


def get_geotagged_media(
    source_type_and_keys: list[tuple[str, str]] | list[str] | str,
    limit: int = 5000,
) -> List[Dict[str, Any]]:
    if is_postgres():
        where_source, params = _build_source_filter(source_type_and_keys)
        if where_source == "1=0":
            return []
        params.append(max(1, limit))
        sql = f"""
        SELECT source_type, source_key, relative_path, size, cap_time, cap_year, lat, lon, has_gps
        FROM media_index
        WHERE {where_source} AND lat IS NOT NULL AND lon IS NOT NULL
        ORDER BY cap_time DESC
        LIMIT ?
        """
        rows = execute_read_query(sql, params)
        return [_normalize_row(r) for r in rows if r]
    return db_get_geotagged_media(source_type_and_keys, limit=limit)


def get_scan_dirs(source_type: str, source_key: str) -> Dict[str, int]:
    if is_postgres():
        rows = execute_read_query(
            "SELECT dir_relpath, dir_mtime_ns FROM scan_dirs WHERE source_type = ? AND source_key = ?",
            (source_type, source_key),
        )
        return {r["dir_relpath"]: r["dir_mtime_ns"] for r in rows}
    return db_get_scan_dirs(source_type, source_key)


def upsert_scan_dirs(source_type: str, source_key: str, dir_mtimes: Dict[str, int]) -> None:
    if not dir_mtimes:
        return
    if is_postgres():
        now = int(time.time())
        for rel, mtime in dir_mtimes.items():
            execute_write(
                """
                INSERT INTO scan_dirs (source_type, source_key, dir_relpath, dir_mtime_ns, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (source_type, source_key, dir_relpath) DO UPDATE SET
                    dir_mtime_ns = EXCLUDED.dir_mtime_ns,
                    updated_at = EXCLUDED.updated_at
                """,
                (source_type, source_key, rel, mtime, now),
            )
        return
    db_upsert_scan_dirs(source_type, source_key, dir_mtimes)


def prune_media_index(
    source_type: str,
    source_key: str,
    keep_paths: Set[str],
    existing_paths: Set[str] | None = None,
) -> None:
    if is_postgres():
        if existing_paths is None:
            rows = execute_read_query(
                "SELECT relative_path FROM media_index WHERE source_type = ? AND source_key = ?",
                (source_type, source_key),
            )
            existing_paths = {r["relative_path"] for r in rows}
        to_delete = existing_paths - keep_paths
        if to_delete:
            to_delete_list = list(to_delete)
            chunk_size = 500
            for i in range(0, len(to_delete_list), chunk_size):
                chunk = to_delete_list[i: i + chunk_size]
                placeholders = ",".join(["?"] * len(chunk))
                execute_write(
                    f"DELETE FROM media_index WHERE source_type = ? AND source_key = ? AND relative_path IN ({placeholders})",
                    [source_type, source_key] + chunk,
                )
        return
    db_prune_media_index(source_type, source_key, keep_paths, existing_paths)


def clear_media_index(source_type: str | None = None, source_key: str | None = None) -> int:
    if is_postgres():
        if source_type and source_key:
            row = execute_read_one("SELECT COUNT(*) AS c FROM media_index WHERE source_type = ? AND source_key = ?", (source_type, source_key))
            count = row["c"] if row else 0
            execute_write("DELETE FROM media_index WHERE source_type = ? AND source_key = ?", (source_type, source_key))
            return count
        row = execute_read_one("SELECT COUNT(*) AS c FROM media_index")
        count = row["c"] if row else 0
        execute_write("DELETE FROM media_index")
        return count
    if source_type and source_key:
        return db_clear_media_index()
    return db_clear_media_index()


def get_media_index_stats() -> Dict[str, Any]:
    if is_postgres():
        row = execute_read_one("SELECT COUNT(*) as c, MAX(indexed_at) as last_idx, COUNT(DISTINCT source_key) as total_sources FROM media_index")
        cnt = row["c"] if row else 0
        last_idx = row["last_idx"] if row else None
        return {
            "files": cnt,
            "total_indexed": cnt,
            "last_indexed_at": last_idx,
            "total_sources": row["total_sources"] if row else 0,
        }
    res = db_get_media_index_stats()
    res["total_indexed"] = res.get("files", 0)
    return res
