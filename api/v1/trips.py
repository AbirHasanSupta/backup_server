"""api/v1/trips.py — Smart GPS Trip & Cluster Discovery Router."""

from __future__ import annotations

import asyncio
from fastapi import APIRouter, Header, HTTPException, Query

from core.security import verify_api_key_or_device_token
from repositories import device_repo
from services import places_trips_cache
from services.trips_service import trips_service

router = APIRouter(tags=["Trips"])


@router.get("/api/trips")
@router.get("/trips")
async def list_trips(
    device_id: str | None = None,
    source_id: str | None = None,
    refresh: int = Query(0),
    authorization: str = Header(None),
    token: str = Query(None),
):
    target_id = source_id or device_id
    if not target_id:
        raise HTTPException(status_code=400, detail="Missing device_id / source_id")
    verify_api_key_or_device_token(authorization, token, target_id, device_repo.verify_device_token)
    cache_key = places_trips_cache.trips_list_key(target_id)
    if not refresh:
        cached = places_trips_cache.get_cached(cache_key)
        if cached is not None:
            return cached
    trips = await asyncio.to_thread(trips_service.get_device_trips, target_id)
    payload = {"trips": trips}
    places_trips_cache.set_cached(cache_key, payload)
    return payload


@router.get("/api/trips/{trip_id}/media")
@router.get("/trips/{trip_id}/media")
async def get_trip_media(
    trip_id: int,
    device_id: str | None = None,
    refresh: int = Query(0),
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    cache_key = places_trips_cache.trip_media_key(trip_id)
    if not refresh:
        cached = places_trips_cache.get_cached(cache_key)
        if cached is not None:
            return cached
    trip, media = await asyncio.to_thread(trips_service.get_trip_media, trip_id)
    if not trip:
        raise HTTPException(status_code=404, detail="Trip not found")
    payload = {"trip": trip, "media": media}
    places_trips_cache.set_cached(cache_key, payload)
    return payload


@router.post("/api/trips/recluster")
@router.post("/trips/recluster")
async def recluster_trips(
    source_id: str | None = None,
    device_id: str | None = None,
    authorization: str = Header(None),
    token: str = Query(None),
):
    target_id = source_id or device_id
    if not target_id:
        raise HTTPException(status_code=400, detail="Missing source_id / device_id")
    verify_api_key_or_device_token(authorization, token, target_id, device_repo.verify_device_token)
    clusters, trips = await asyncio.to_thread(trips_service.recluster, target_id)
    # Recluster rewrites trips only — places clusters are unchanged.
    places_trips_cache.invalidate_trips(target_id)
    payload = {"ok": True, "clusters_found": len(clusters), "trips": trips}
    places_trips_cache.set_cached(places_trips_cache.trips_list_key(target_id), {"trips": trips})
    return payload
