"""repositories/trips_repo.py — Trips & Reverse Geocoding Cache Repository."""

from __future__ import annotations

from typing import Any, Dict, List, Tuple
from database import (
    get_trips as db_get_trips,
    get_trip_media as db_get_trip_media,
    save_trip_clusters as db_save_trip_clusters,
    get_cached_geocode as db_get_cached_geocode,
    save_cached_geocode as db_save_cached_geocode,
)


def get_trips(source_id: str) -> List[Dict[str, Any]]:
    return db_get_trips(source_id)


def get_trip_media(trip_id: int) -> Tuple[Dict[str, Any] | None, List[Dict[str, Any]]]:
    return db_get_trip_media(trip_id)


def save_trip_clusters(source_id: str, clusters: List[Dict[str, Any]]) -> None:
    db_save_trip_clusters(source_id, clusters)


def get_cached_geocode(lat: float, lon: float) -> str | None:
    return db_get_cached_geocode(lat, lon)


def save_cached_geocode(lat: float, lon: float, place_name: str) -> None:
    db_save_cached_geocode(lat, lon, place_name)
