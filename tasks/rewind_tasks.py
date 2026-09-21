"""tasks/rewind_tasks.py — Distributed Rewind Reel Rendering Workers."""

import logging
from celery_app import celery_app

logger = logging.getLogger("backup_server.tasks.rewind")


@celery_app.task(
    bind=True,
    name="tasks.rewind_tasks.render_rewind_reel",
    max_retries=1,
    time_limit=600,
    soft_time_limit=500,
)
def render_rewind_reel(self, source_id: str, year: int, month: int | None = None, music_id: str | None = None):
    """Offload heavy video slideshow & Ken Burns rendering to worker nodes."""
    from rewind import build_rewind_reel
    try:
        dest_path = build_rewind_reel(source_id, year, month, music_id)
        # Notify WebSocket room
        try:
            from services.redis_service import publish_event
            publish_event(f"rewind_ready:{source_id}", {"ready": True, "year": year, "month": month, "path": dest_path})
        except Exception:
            pass
        return {"status": "completed", "path": dest_path}
    except Exception as exc:
        logger.error("Rewind reel render failed for %s (%s-%s): %s", source_id, year, month, exc)
        if hasattr(self, "retry"):
            raise self.retry(exc=exc, countdown=10)
        raise exc


def dispatch_rewind_render(source_id: str, year: int, month: int | None = None, music_id: str | None = None):
    """Safely dispatch rewind build to Celery or async thread pool."""
    import threading
    try:
        from services.redis_service import get_redis_client
        if get_redis_client():
            render_rewind_reel.delay(source_id, year, month, music_id)
            return "celery"
    except Exception:
        pass

    def _fallback_run():
        try:
            render_rewind_reel(None, source_id, year, month, music_id)
        except Exception:
            pass

    threading.Thread(target=_fallback_run, daemon=True, name=f"rewind-{source_id[:8]}").start()
    return "thread"

