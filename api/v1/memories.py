"""api/v1/memories.py — On-This-Day, Flashbacks, Quiz, Wrapped, Places & Rewind Video Router."""

from __future__ import annotations

import asyncio
import os
from datetime import date
from pydantic import BaseModel
from fastapi import APIRouter, Header, HTTPException, Query, Request, status

from core.security import verify_api_key_or_device_token
from repositories import device_repo
from services.preview_service import preview_service
import memories
import rewind

router = APIRouter(tags=["Memories & Rewind"])


class RewindGenerateRequest(BaseModel):
    device_id: str
    year: int
    month: int | None = None


@router.get("/memories/today")
@router.get("/api/memories/today")
async def get_memories_today(
    device_id: str,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    res = await asyncio.to_thread(memories.get_todays_memories, device_id)
    return res


@router.get("/memories/recent")
@router.get("/api/memories/recent")
async def get_memories_recent(
    device_id: str,
    days: int = 7,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    res = await asyncio.to_thread(memories.get_recent_memories, device_id, days)
    return res


@router.post("/memories/reindex")
@router.post("/api/memories/reindex")
async def trigger_reindex(
    device_id: str | None = None,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    if device_id:
        await asyncio.to_thread(memories.reindex_device, device_id)
    else:
        await asyncio.to_thread(memories.reindex_all)
    return {"ok": True, "message": "Reindex triggered"}


@router.get("/memories/flashback")
@router.get("/api/memories/flashback")
async def get_flashback(
    device_id: str,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    res = await asyncio.to_thread(memories.get_random_flashback, device_id)
    if not res:
        return {"flashback": None}
    return {"flashback": res}


@router.get("/memories/wrapped")
@router.get("/api/memories/wrapped")
async def get_wrapped(
    device_id: str,
    year: int | None = None,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    target_year = year or date.today().year
    res = await asyncio.to_thread(memories.get_wrapped, device_id, target_year)
    return res


@router.get("/memories/quiz")
@router.get("/api/memories/quiz")
async def get_quiz(
    device_id: str,
    count: int = 10,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    res = await asyncio.to_thread(memories.get_quiz_round, device_id, count)
    return res


@router.get("/memories/roulette")
@router.get("/api/memories/roulette")
async def get_roulette(
    device_id: str,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    res = await asyncio.to_thread(memories.get_roulette_item, device_id)
    if not res:
        return {"item": None}
    return {"item": res}


@router.get("/memories/places")
@router.get("/api/memories/places")
async def get_places(
    device_id: str,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    res = await asyncio.to_thread(memories.get_place_clusters, device_id)
    return res


@router.get("/memories/places/{cluster_key}")
@router.get("/api/memories/places/{cluster_key}")
async def get_place_details(
    cluster_key: str,
    device_id: str,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    res = await asyncio.to_thread(memories.get_place_items, device_id, cluster_key)
    return res


@router.post("/memories/rewind/generate")
@router.post("/api/memories/rewind/generate")
async def generate_rewind(
    body: RewindGenerateRequest,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, body.device_id, device_repo.verify_device_token)
    res = await asyncio.to_thread(rewind.start_rewind_build, body.device_id, body.year, body.month)
    return res


@router.get("/memories/rewind/status")
@router.get("/api/memories/rewind/status")
async def get_rewind_status(
    device_id: str,
    year: int,
    month: int | None = None,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    res = await asyncio.to_thread(rewind.get_rewind_status, device_id, year, month)
    return res


@router.get("/memories/rewind/stream")
@router.get("/api/memories/rewind/stream")
async def stream_rewind(
    device_id: str,
    year: int,
    request: Request,
    month: int | None = None,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    reel_path = await asyncio.to_thread(rewind.get_rewind_path, device_id, year, month)
    if not reel_path or not os.path.isfile(reel_path):
        raise HTTPException(status_code=404, detail="Rewind reel not found or not ready yet")
    return preview_service.stream_file_range(reel_path, request, cache_control="public, max-age=604800, immutable")
