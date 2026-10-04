"""services/ws_service.py — Real-Time Event Dispatcher & WebSocket Broadcaster."""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from typing import Any, Dict, List
from services.redis_service import publish_event

logger = logging.getLogger("backup_server.ws_service")

# Coalesce per-file upload WS storms during bulk sync so app workers / Redis
# are not woken thousands of times per minute while the user browses.
_UPLOAD_COALESCE_SECONDS = 2.0
_upload_lock = threading.Lock()
_upload_pending: dict[str, dict[str, Any]] = {}
_upload_timer: threading.Timer | None = None


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
    def _flush_coalesced_uploads() -> None:
        global _upload_timer
        with _upload_lock:
            pending = dict(_upload_pending)
            _upload_pending.clear()
            timer = _upload_timer
            _upload_timer = None

        if timer is not None:
            try:
                timer.cancel()
            except Exception:
                pass

        for device_id, entry in pending.items():
            try:
                WebSocketService.broadcast_event("file_uploaded", {
                    "device_id": device_id,
                    "relative_path": entry.get("relative_path") or "",
                    "size": int(entry.get("size") or 0),
                    "device_total_files": int(entry.get("device_total_files") or 0),
                    "device_total_size": int(entry.get("device_total_size") or 0),
                    "batched_count": int(entry.get("batched_count") or 1),
                })
            except Exception:
                logger.debug("Failed to flush coalesced upload event for %s", device_id, exc_info=True)

    @staticmethod
    def flush_coalesced_uploads() -> None:
        """Flush any pending coalesced upload events immediately (e.g. session end)."""
        WebSocketService._flush_coalesced_uploads()

    @staticmethod
    def notify_file_uploaded(
        device_id: str,
        relative_path: str,
        size: int,
        device_total_files: int = 0,
        device_total_size: int = 0,
    ) -> None:
        """Broadcast upload completion, coalesced across bulk sync bursts."""
        global _upload_timer
        with _upload_lock:
            entry = _upload_pending.get(device_id) or {
                "batched_count": 0,
                "size": 0,
                "relative_path": relative_path,
            }
            entry["batched_count"] = int(entry.get("batched_count") or 0) + 1
            entry["relative_path"] = relative_path
            entry["size"] = size
            entry["device_total_files"] = device_total_files
            entry["device_total_size"] = device_total_size
            entry["updated_at"] = time.time()
            _upload_pending[device_id] = entry

            if _upload_timer is None:
                timer = threading.Timer(
                    _UPLOAD_COALESCE_SECONDS,
                    WebSocketService._flush_coalesced_uploads,
                )
                timer.daemon = True
                _upload_timer = timer
                timer.start()

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
    def notify_new_reaction(media_id: int, reaction: str, device_id: str, counts: Dict[str, int] | None = None, scope: str = "post") -> None:
        WebSocketService.broadcast_event("new_reaction", {
            "media_id": media_id,
            "reaction": reaction,
            "device_id": device_id,
            "counts": counts or {},
            "scope": scope,
        })

    @staticmethod
    def notify_new_comment(media_id: int, comment: str, device_id: str, total_comments: int = 0, scope: str = "post") -> None:
        WebSocketService.broadcast_event("new_comment", {
            "media_id": media_id,
            "comment": comment,
            "device_id": device_id,
            "total_comments": total_comments,
            "scope": scope,
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
