"""services/ws_service.py — Real-Time Event Dispatcher & WebSocket Broadcaster."""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List
from services.redis_service import publish_event

logger = logging.getLogger("backup_server.ws_service")


class WebSocketService:
    @staticmethod
    def _dispatch_local_personal(device_id: str, payload: dict):
        try:
            from routers.websocket_hub import manager
            try:
                loop = asyncio.get_running_loop()
                loop.create_task(manager.send_personal_message(device_id, payload))
            except RuntimeError:
                pass
        except Exception:
            pass

    @staticmethod
    def _dispatch_local_broadcast(payload: dict):
        try:
            from routers.websocket_hub import manager
            try:
                loop = asyncio.get_running_loop()
                loop.create_task(manager.broadcast(payload))
            except RuntimeError:
                pass
        except Exception:
            pass

    @staticmethod
    def notify_device(device_id: str, event_type: str, data: Dict[str, Any]) -> None:
        """Send targeted real-time event to a specific device room."""
        channel = f"channel:{device_id}"
        payload = {"event": event_type, "data": data}
        redis_ok = publish_event(channel, payload)
        if not redis_ok:
            WebSocketService._dispatch_local_personal(device_id, payload)

    @staticmethod
    def broadcast_event(event_type: str, data: Dict[str, Any]) -> None:
        """Broadcast real-time event to all connected devices and desktop control centers."""
        channel = "channel:broadcast"
        payload = {"event": event_type, "data": data}
        redis_ok = publish_event(channel, payload)
        if not redis_ok:
            WebSocketService._dispatch_local_broadcast(payload)

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

    @staticmethod
    def notify_file_uploaded(device_id: str, relative_path: str, size: int, device_total_files: int = 0, device_total_size: int = 0) -> None:
        WebSocketService.broadcast_event("file_uploaded", {
            "device_id": device_id,
            "relative_path": relative_path,
            "size": size,
            "device_total_files": device_total_files,
            "device_total_size": device_total_size,
        })

    @staticmethod
    def notify_new_share(
        target_device_ids: List[str],
        group_id: str,
        caption: str | None,
        shared_by: str,
        shared_by_device_id: str,
        post_kind: str | None = None,
    ) -> None:
        event_data = {
            "group_id": group_id,
            "caption": caption,
            "shared_by": shared_by,
            "shared_by_device_id": shared_by_device_id,
            "post_kind": post_kind,
        }
        for target_id in target_device_ids:
            WebSocketService.notify_device(target_id, "new_share", event_data)
        WebSocketService.broadcast_event("new_post", event_data)

    @staticmethod
    def notify_new_reaction(media_id: int, reaction: str, device_id: str, counts: Dict[str, int] | None = None) -> None:
        WebSocketService.broadcast_event("new_reaction", {
            "media_id": media_id,
            "reaction": reaction,
            "device_id": device_id,
            "counts": counts or {},
        })

    @staticmethod
    def notify_new_comment(media_id: int, comment: str, device_id: str, total_comments: int = 0) -> None:
        WebSocketService.broadcast_event("new_comment", {
            "media_id": media_id,
            "comment": comment,
            "device_id": device_id,
            "total_comments": total_comments,
        })

    @staticmethod
    def notify_preview_ready(cache_key: str, path: str) -> None:
        WebSocketService.broadcast_event(f"preview_ready:{cache_key}", {"ready": True, "path": path})

    @staticmethod
    def notify_rewind_ready(source_id: str, year: int, month: int | None, path: str) -> None:
        WebSocketService.broadcast_event(f"rewind_ready:{source_id}", {"ready": True, "year": year, "month": month, "path": path})

    @staticmethod
    def notify_typing(media_id: int, device_id: str, username: str | None, is_typing: bool) -> None:
        WebSocketService.broadcast_event("typing_status", {
            "media_id": media_id,
            "device_id": device_id,
            "username": username,
            "is_typing": is_typing,
        })

    @staticmethod
    def notify_read_receipt(media_id: int, device_id: str, read_at: int) -> None:
        WebSocketService.broadcast_event("read_receipt", {
            "media_id": media_id,
            "device_id": device_id,
            "read_at": read_at,
        })


ws_service = WebSocketService()

