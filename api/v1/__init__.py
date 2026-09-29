"""api/v1/__init__.py — Master API v1 Router Aggregator."""

from __future__ import annotations

from fastapi import APIRouter

from api.v1.health import router as health_router
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

VALID_SERVICE_ROLES = frozenset({"all", "app", "sync"})


def normalize_service_role(role: str | None) -> str:
    """Return a supported SERVICE_ROLE value; unknown values fall back to monolith."""
    normalized = (role or "all").strip().lower()
    return normalized if normalized in VALID_SERVICE_ROLES else "all"


def build_v1_router(role: str = "all") -> APIRouter:
    """Assemble the v1 surface for a deployment role.

    ``all``  — desktop / local monolith (sync + social + admin).
    ``app``  — Docker interactive API (feed/reels/library/memories); no sync uploads.
    ``sync`` — Docker upload/sync API only (+ health ping).
    """
    role = normalize_service_role(role)
    router = APIRouter()
    router.include_router(health_router)

    if role == "sync":
        router.include_router(sync_router)
        return router

    router.include_router(auth_router)
    if role == "all":
        router.include_router(sync_router)
    router.include_router(files_router)
    router.include_router(feed_router)
    router.include_router(reels_router)
    router.include_router(memories_router)
    router.include_router(trips_router)
    router.include_router(cleanup_router)
    router.include_router(ws_router)
    router.include_router(admin_router)
    return router


# Default monolith aggregator for imports that expect a ready-made router.
v1_router = build_v1_router("all")
