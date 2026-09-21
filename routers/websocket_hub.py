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
from typing import Dict, List

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
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
                if action == "ping":
                    await websocket.send_text(json.dumps({"event": "pong"}))
                elif action == "broadcast":
                    if redis_client:
                        publish_event("channel:broadcast", data.get("payload", {}))
                    else:
                        await manager.broadcast(data.get("payload", {}))
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
