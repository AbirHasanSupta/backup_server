"""services/ws_service.py — Real-Time Event Dispatcher & WebSocket Broadcaster."""

from __future__ import annotations

import logging
from typing import Any, Dict
from services.redis_service import publish_event

logger = logging.getLogger("backup_server.ws_service")


class WebSocketService:
    @staticmethod
    def notify_device(device_id: str, event_type: str, data: Dict[str, Any]) -> None:
        """Send targeted real-time event to a specific device room."""
        channel = f"channel:{device_id}"
        payload = {"event": event_type, "data": data}
        publish_event(channel, payload)

    @staticmethod
    def broadcast_event(event_type: str, data: Dict[str, Any]) -> None:
        """Broadcast real-time event to all connected devices and desktop control centers."""
        channel = "channel:broadcast"
        payload = {"event": event_type, "data": data}
        publish_event(channel, payload)

    @staticmethod
    def notify_pairing_approved(device_id: str, token: str) -> None:
        WebSocketService.notify_device(device_id, "pairing_approved", {"token": token, "status": "accepted"})

    @staticmethod
    def notify_sync_progress(device_id: str, current: int, total: int, current_file: str = "") -> None:
        WebSocketService.broadcast_event("sync_progress", {
            "device_id": device_id,
            "current": current,
            "total": total,
            "current_file": current_file,
        })


ws_service = WebSocketService()
