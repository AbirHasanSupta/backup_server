"""api/v1/websockets.py — Real-Time WebSocket Endpoint."""

from __future__ import annotations

from fastapi import APIRouter
from routers.websocket_hub import ws_router, manager

router = ws_router
