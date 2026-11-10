"""routers/websocket_hub.py — Real-Time WebSocket Gateway & Event Streamer.

Eliminates client-side polling for:
- Connection pairing approvals
- Active upload and sync progress tracking
- Instant feed post, comment, and reaction alerts
- Rewind reel and video preview readiness
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Dict, List

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from core.security import verify_api_key_or_device_token
from repositories import device_repo
from services.redis_service import get_redis_client, publish_event

logger = logging.getLogger("backup_server.websocket")
ws_router = APIRouter(tags=["WebSockets"])


class ConnectionManager:
    """Manages active in-process WebSocket connections by client_id."""

    def __init__(self):
        self._rooms: Dict[str, List[WebSocket]] = {}
        self._lock = asyncio.Lock()

    async def connect(self, client_id: str, websocket: WebSocket):
        await websocket.accept()
        async with self._lock:
            self._rooms.setdefault(client_id, []).append(websocket)
        logger.info("WebSocket client connected: %s", client_id)

    async def disconnect(self, client_id: str, websocket: WebSocket):
        async with self._lock:
            if client_id in self._rooms:
                if websocket in self._rooms[client_id]:
                    self._rooms[client_id].remove(websocket)
                if not self._rooms[client_id]:
                    del self._rooms[client_id]
        logger.info("WebSocket client disconnected: %s", client_id)

    async def send_personal_message(self, client_id: str, message: dict):
        async with self._lock:
            sockets = list(self._rooms.get(client_id, []))
        payload = json.dumps(message)
        for ws in sockets:
            try:
                await ws.send_text(payload)
            except Exception:
                pass

    async def broadcast(self, message: dict):
        async with self._lock:
            all_sockets = [ws for sockets in self._rooms.values() for ws in sockets]
        payload = json.dumps(message)
        for ws in all_sockets:
            try:
                await ws.send_text(payload)
            except Exception:
                pass


manager = ConnectionManager()


@ws_router.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    """Bidirectional WebSocket connection for live telemetry, sync events, and alerts."""
    # WebSockets do not pass through the HTTP route dependencies.  Authenticate
    # before accepting so an arbitrary LAN host cannot subscribe to another
    # device's room or publish live social events.
    try:
        verify_api_key_or_device_token(
            websocket.headers.get("authorization"),
            websocket.query_params.get("token"),
            client_id,
            device_repo.verify_device_token,
        )
    except HTTPException:
        await websocket.close(code=1008, reason="Unauthorized")
        return

    await manager.connect(client_id, websocket)

    # Subscribe to Redis channels for cross-process event broadcasting
    redis_client = get_redis_client()
    redis_task = None

    if redis_client:
        pubsub = redis_client.pubsub()
        pubsub.subscribe(f"channel:{client_id}", "channel:broadcast")

        async def redis_listener():
            try:
                while True:
                    msg = await asyncio.to_thread(pubsub.get_message, ignore_subscribe_messages=True, timeout=1.0)
                    if msg and msg.get("type") == "message":
                        raw_data = msg.get("data")
                        if isinstance(raw_data, bytes):
                            raw_data = raw_data.decode("utf-8", errors="replace")
                        if isinstance(raw_data, str):
                            await websocket.send_text(raw_data)
                    await asyncio.sleep(0.05)
            except Exception:
                pass
            finally:
                try:
                    pubsub.close()
                except Exception:
                    pass

        redis_task = asyncio.create_task(redis_listener())

    try:
        while True:
            data_text = await websocket.receive_text()
            try:
                data = json.loads(data_text)
                action = data.get("action")
                payload = data.get("payload", {})
                if action == "ping":
                    await websocket.send_text(json.dumps({"event": "pong", "timestamp": int(time.time())}))
                elif action == "typing":
                    media_id = payload.get("media_id")
                    if not isinstance(media_id, int) or media_id < 0:
                        continue
                    is_typing = payload.get("is_typing", True)
                    username = device_repo.get_device_display_name(client_id)
                    from services.ws_service import ws_service
                    ws_service.notify_typing(media_id, client_id, username, bool(is_typing))
                elif action == "read_receipt":
                    media_id = payload.get("media_id")
                    if not isinstance(media_id, int) or media_id < 0:
                        continue
                    read_at = payload.get("read_at") or int(time.time())
                    if not isinstance(read_at, int) or read_at < 0:
                        read_at = int(time.time())
                    from services.ws_service import ws_service
                    ws_service.notify_read_receipt(media_id, client_id, read_at)
            except json.JSONDecodeError:
                pass
    except WebSocketDisconnect:
        await manager.disconnect(client_id, websocket)
        if redis_task:
            redis_task.cancel()
    except Exception as exc:
        logger.warning("WebSocket error for %s: %s", client_id, exc)
        await manager.disconnect(client_id, websocket)
        if redis_task:
            redis_task.cancel()


@ws_router.websocket("/ws")
async def websocket_anonymous_endpoint(websocket: WebSocket):
    """Fallback anonymous WebSocket endpoint."""
    anon_id = f"anon_{id(websocket)}"
    await websocket_endpoint(websocket, anon_id)
