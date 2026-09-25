"""api/v1/__init__.py — Master API v1 Router Aggregator."""

from __future__ import annotations

from fastapi import APIRouter

from api.v1.auth import router as auth_router
from api.v1.sync import router as sync_router
from api.v1.files import router as files_router
from api.v1.feed import router as feed_router
from api.v1.reels import router as reels_router
from api.v1.memories import router as memories_router
from api.v1.trips import router as trips_router
from api.v1.cleanup import router as cleanup_router
from api.v1.websockets import router as ws_router
from api.v1.admin import router as admin_router

v1_router = APIRouter()

# Include all subrouters
v1_router.include_router(auth_router)
v1_router.include_router(sync_router)
v1_router.include_router(files_router)
v1_router.include_router(feed_router)
v1_router.include_router(reels_router)
v1_router.include_router(memories_router)
v1_router.include_router(trips_router)
v1_router.include_router(cleanup_router)
v1_router.include_router(ws_router)
v1_router.include_router(admin_router)
