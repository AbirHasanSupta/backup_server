"""api/v1/trips.py — Smart GPS Trip & Cluster Discovery Router."""

from __future__ import annotations

import asyncio
from fastapi import APIRouter, Header, HTTPException, Query, status

from core.security import verify_api_key_or_device_token
from repositories import device_repo, trips_repo
from services.trips_service import trips_service

router = APIRouter(tags=["Trips"])


@router.get("/api/trips")
@router.get("/trips")
async def list_trips(
    device_id: str | None = None,
    source_id: str | None = None,
    authorization: str = Header(None),
    token: str = Query(None),
):
    target_id = source_id or device_id
    if not target_id:
        raise HTTPException(status_code=400, detail="Missing device_id / source_id")
    verify_api_key_or_device_token(authorization, token, target_id, device_repo.verify_device_token)
    trips = await asyncio.to_thread(trips_service.get_device_trips, target_id)
    return {"trips": trips}


@router.get("/api/trips/{trip_id}/media")
@router.get("/trips/{trip_id}/media")
async def get_trip_media(
    trip_id: int,
    device_id: str | None = None,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    trip, media = await asyncio.to_thread(trips_service.get_trip_media, trip_id)
    if not trip:
        raise HTTPException(status_code=404, detail="Trip not found")
    return {"trip": trip, "media": media}


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
    return {"ok": True, "clusters_found": len(clusters), "trips": trips}
