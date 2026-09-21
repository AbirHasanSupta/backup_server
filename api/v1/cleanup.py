"""api/v1/cleanup.py — Safe Phone Storage Free Up & Cleanup Audit Router."""

from __future__ import annotations

import asyncio
from pydantic import BaseModel
from fastapi import APIRouter, Header, HTTPException, Query, status

from core.security import verify_api_key_or_device_token
from repositories import device_repo
import database

router = APIRouter(tags=["Cleanup & Storage Optimization"])


class CleanupDeleteItem(BaseModel):
    path: str
    size: int
    file_id: int | None = None


class CleanupDeleteRequest(BaseModel):
    source_id: str
    files: list[CleanupDeleteItem]


@router.get("/cleanup/candidates")
@router.get("/api/cleanup/candidates")
async def cleanup_candidates(
    source_id: str,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, source_id, device_repo.verify_device_token)
    candidates = await asyncio.to_thread(database.get_cleanup_candidates, source_id)
    total_size = sum(c.get("size", 0) for c in candidates)
    return {
        "candidates": candidates,
        "total_size": total_size,
        "count": len(candidates),
    }


@router.post("/cleanup/delete")
@router.post("/api/cleanup/delete")
async def cleanup_delete(
    body: CleanupDeleteRequest,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, body.source_id, device_repo.verify_device_token)
    items = [
        {"path": f.path, "size": f.size, "file_id": f.file_id}
        for f in body.files
    ]
    result = await asyncio.to_thread(database.log_cleanup_deletions, body.source_id, items)
    dev_name = device_repo.get_device_display_name(body.source_id)
    freed_gb = result.get("total_bytes_freed", 0) / (1024 ** 3)
    database.add_log(
        f"🗑️  Cleanup: {dev_name} freed {freed_gb:.2f} GB ({len(body.files)} files)"
    )
    return result
