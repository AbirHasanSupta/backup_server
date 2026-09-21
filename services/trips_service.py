"""services/trips_service.py — Smart Trip Clustering & Reverse Geocoding Service."""

from __future__ import annotations

from typing import Any, Dict, List, Tuple
from repositories import trips_repo
from trips import cluster_source_media, trigger_background_clustering


class TripsService:
    @staticmethod
    def get_device_trips(source_id: str) -> List[Dict[str, Any]]:
        return trips_repo.get_trips(source_id)

    @staticmethod
    def get_trip_media(trip_id: int) -> Tuple[Dict[str, Any] | None, List[Dict[str, Any]]]:
        return trips_repo.get_trip_media(trip_id)

    @staticmethod
    def recluster(source_id: str) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        clusters = cluster_source_media(source_id)
        trips = trips_repo.get_trips(source_id)
        return clusters, trips

    @staticmethod
    def schedule_clustering(source_id: str | None = None) -> None:
        trigger_background_clustering(source_id)


trips_service = TripsService()
