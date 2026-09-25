"""repositories/trips_repo.py — Trips & Reverse Geocoding Cache Repository."""

from __future__ import annotations

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
        SELECT id, source_id, title, start_date, end_date, start_time, end_time,
               place_name, center_lat, center_lon, media_count, cover_media_id, created_at
        FROM trips
        WHERE source_id = ?
        ORDER BY start_time DESC
        """
        return execute_read_query(sql, (source_id,))
    return db_get_trips(source_id)


def get_trip_media(trip_id: int) -> Tuple[Dict[str, Any] | None, List[Dict[str, Any]]]:
    if is_postgres():
        trip = execute_read_one("SELECT * FROM trips WHERE id = ?", (trip_id,))
        if not trip:
            return None, []
        media = execute_read_query(
            """
            SELECT tm.id as trip_media_id, tm.trip_id, tm.media_id, tm.source_type, tm.source_key,
                   tm.relative_path, tm.cap_time, mi.lat, mi.lon, mi.has_gps
            FROM trip_media tm
            LEFT JOIN media_index mi ON mi.id = tm.media_id
            WHERE tm.trip_id = ?
            ORDER BY tm.cap_time ASC, tm.id ASC
            """,
            (trip_id,),
        )
        return trip, media
    return db_get_trip_media(trip_id)


def save_trip_clusters(source_id: str, clusters: List[Dict[str, Any]]) -> None:
    if is_postgres():
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
        return
    db_save_trip_clusters(source_id, clusters)


def get_cached_geocode(lat: float, lon: float) -> str | None:
    if is_postgres():
        lat_round = round(lat, 3)
        lon_round = round(lon, 3)
        row = execute_read_one(
            "SELECT place_name FROM geocode_cache WHERE lat_round = ? AND lon_round = ?",
            (lat_round, lon_round),
        )
        return row["place_name"] if row else None
    return db_get_cached_geocode(lat, lon)


def save_cached_geocode(lat: float, lon: float, place_name: str) -> None:
    if is_postgres():
        lat_round = round(lat, 3)
        lon_round = round(lon, 3)
        execute_write(
            "INSERT INTO geocode_cache (lat_round, lon_round, place_name) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
            (lat_round, lon_round, place_name),
        )
        return
    db_save_cached_geocode(lat, lon, place_name)
