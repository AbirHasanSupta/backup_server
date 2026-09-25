"""repositories/trips_repo.py — Trips & Reverse Geocoding Cache Repository."""

from __future__ import annotations

import math
from typing import Any, Dict, List, Tuple
from repositories.base import execute_read_one, execute_read_query, execute_write, is_postgres
from database import (
    get_trips as db_get_trips,
    get_trip_media as db_get_trip_media,
    save_trip_clusters as db_save_trip_clusters,
    get_cached_geocode as db_get_cached_geocode,
    save_cached_geocode as db_save_cached_geocode,
)


def get_trips(source_id: str) -> List[Dict[str, Any]]:
    if is_postgres():
        sql = """
        SELECT t.id, t.source_id, t.title, t.start_time, t.end_time,
               t.center_lat, t.center_lon, t.media_count, t.cover_media_id,
               t.created_at,
               mi.relative_path AS cover_path, mi.source_type AS cover_source_type,
               mi.source_key AS cover_source_key
        FROM trips t
        LEFT JOIN media_index mi ON t.cover_media_id = mi.id
        WHERE t.source_id = ?
        ORDER BY t.start_time DESC
        """
        rows = execute_read_query(sql, (source_id,))
        video_exts = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".3gp", ".m4v", ".wmv"}

        counts_rows = execute_read_query(
            """
            SELECT tm.trip_id, COALESCE(mi.relative_path, tm.relative_path) AS relative_path
            FROM trip_media tm
            LEFT JOIN media_index mi ON tm.media_id = mi.id
            WHERE tm.trip_id IN (SELECT id FROM trips WHERE source_id = ?)
            """,
            (source_id,),
        )
        media_counts: Dict[int, list[int]] = {}
        for cr in counts_rows:
            tid = cr["trip_id"]
            path = (cr["relative_path"] or "").lower()
            ext = ("." + path.rsplit(".", 1)[-1]) if "." in path else ""
            is_vid = ext in video_exts
            if tid not in media_counts:
                media_counts[tid] = [0, 0]  # [photo_count, video_count]
            if is_vid:
                media_counts[tid][1] += 1
            else:
                media_counts[tid][0] += 1

        trips = []
        for r in rows:
            cover_path = r.get("cover_path")
            ext = ("." + cover_path.rsplit(".", 1)[-1].lower()) if cover_path and "." in cover_path else ""
            cover_obj = None
            if cover_path:
                cover_obj = {
                    "id": r["cover_media_id"],
                    "relative_path": cover_path,
                    "source_type": r.get("cover_source_type") or "phone",
                    "source_id": r.get("cover_source_key") or source_id,
                    "is_video": ext in video_exts,
                }
            p_cnt, v_cnt = media_counts.get(r["id"], [r["media_count"], 0])
            trips.append({
                "id": r["id"],
                "source_id": r["source_id"],
                "title": r["title"],
                "start_time": r["start_time"],
                "end_time": r["end_time"],
                "center_lat": r["center_lat"],
                "center_lon": r["center_lon"],
                "media_count": r["media_count"],
                "photo_count": p_cnt,
                "video_count": v_cnt,
                "cover_media_id": r["cover_media_id"],
                "cover": cover_obj,
                "created_at": r["created_at"],
            })
        return trips
    return db_get_trips(source_id)


def get_trip_media(trip_id: int) -> Tuple[Dict[str, Any] | None, List[Dict[str, Any]]]:
    if is_postgres():
        trip = execute_read_one(
            """
            SELECT id, source_id, title, start_time, end_time,
                   center_lat, center_lon, media_count, cover_media_id, created_at
            FROM trips WHERE id = ?
            """,
            (trip_id,),
        )
        if not trip:
            return None, []
        media_rows = execute_read_query(
            """
            SELECT tm.id, tm.trip_id, tm.media_id,
                   COALESCE(mi.source_type, tm.source_type) AS source_type,
                   COALESCE(mi.source_key, tm.source_key) AS source_key,
                   COALESCE(mi.relative_path, tm.relative_path) AS relative_path,
                   COALESCE(mi.size, 0) AS size,
                   COALESCE(mi.modified_time, 0) AS modified_time,
                   COALESCE(mi.cap_time, tm.cap_time) AS capture_time,
                   mi.lat AS cap_lat, mi.lon AS cap_lon, mi.cap_year
            FROM trip_media tm
            LEFT JOIN media_index mi ON mi.id = tm.media_id
            WHERE tm.trip_id = ?
            ORDER BY COALESCE(mi.cap_time, tm.cap_time) ASC, tm.id ASC
            """,
            (trip_id,),
        )
        video_exts = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".3gp", ".m4v", ".wmv"}
        media_items = []
        for r in media_rows:
            path = r["relative_path"]
            ext = ("." + path.rsplit(".", 1)[-1].lower()) if path and "." in path else ""
            media_items.append({
                "id": r["media_id"],
                "trip_media_id": r["id"],
                "source_type": r["source_type"],
                "source_id": r["source_key"],
                "relative_path": r["relative_path"],
                "size": r["size"],
                "modified_time": r["modified_time"],
                "capture_time": r["capture_time"],
                "cap_lat": r["cap_lat"],
                "cap_lon": r["cap_lon"],
                "cap_year": r["cap_year"],
                "is_video": ext in video_exts,
            })
        return trip, media_items
    return db_get_trip_media(trip_id)


def save_trip_clusters(source_id: str, clusters: List[Dict[str, Any]]) -> None:
    if is_postgres():
        # Clean existing trips for source
        old_trips = execute_read_query("SELECT id FROM trips WHERE source_id = ?", (source_id,))
        for ot in old_trips:
            execute_write("DELETE FROM trip_media WHERE trip_id = ?", (ot["id"],))
        execute_write("DELETE FROM trips WHERE source_id = ?", (source_id,))

        for c in clusters:
            execute_write(
                """
                INSERT INTO trips (source_id, title, start_date, end_date, start_time, end_time, place_name, center_lat, center_lon, media_count, cover_media_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    source_id,
                    c.get("title", "Trip"),
                    c.get("start_date", ""),
                    c.get("end_date", ""),
                    c.get("start_time", 0),
                    c.get("end_time", 0),
                    c.get("place_name"),
                    c.get("center_lat"),
                    c.get("center_lon"),
                    c.get("media_count", 0),
                    c.get("cover_media_id"),
                    int(c.get("created_at", 0)),
                ),
            )
            trip_row = execute_read_one(
                "SELECT id FROM trips WHERE source_id = ? AND start_time = ? ORDER BY id DESC LIMIT 1",
                (source_id, c.get("start_time", 0)),
            )
            if trip_row and "items" in c:
                trip_id = trip_row["id"]
                for item in c["items"]:
                    execute_write(
                        """
                        INSERT INTO trip_media (trip_id, media_id, source_type, source_key, relative_path, cap_time)
                        VALUES (?, ?, ?, ?, ?, ?)
                        ON CONFLICT DO NOTHING
                        """,
                        (
                            trip_id,
                            item.get("media_id", 0),
                            item.get("source_type", "phone"),
                            item.get("source_key", source_id),
                            item.get("relative_path", ""),
                            item.get("cap_time") or item.get("capture_time") or 0,
                        ),
                    )
        return
    db_save_trip_clusters(source_id, clusters)


def get_cached_geocode(lat: float, lon: float) -> str | None:
    if is_postgres():
        lat_round = round(lat, 2)
        lon_round = round(lon, 2)
        row = execute_read_one(
            "SELECT place_name FROM geocode_cache WHERE lat_round = ? AND lon_round = ?",
            (lat_round, lon_round),
        )
        return row["place_name"] if row else None
    return db_get_cached_geocode(lat, lon)


def save_cached_geocode(lat: float, lon: float, place_name: str) -> None:
    if is_postgres():
        lat_round = round(lat, 2)
        lon_round = round(lon, 2)
        execute_write(
            "INSERT INTO geocode_cache (lat_round, lon_round, place_name) VALUES (?, ?, ?) ON CONFLICT (lat_round, lon_round) DO UPDATE SET place_name = EXCLUDED.place_name",
            (lat_round, lon_round, place_name),
        )
        return
    db_save_cached_geocode(lat, lon, place_name)
