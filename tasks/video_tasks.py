"""tasks/video_tasks.py — Distributed Video Transcoding Workers."""

import os
import subprocess
import logging
from celery_app import celery_app
from ffmpeg_utils import resolve_ffmpeg_path

logger = logging.getLogger("backup_server.tasks.video")


@celery_app.task(
    bind=True,
    name="tasks.video_tasks.transcode_video_preview",
    max_retries=2,
    time_limit=300,
    soft_time_limit=240,
)
def transcode_video_preview(self, source_path: str, cache_path: str, cache_key: str):
    """Offload video preview generation to an isolated worker process."""
    if os.path.isfile(cache_path):
        return {"status": "already_exists", "cache_path": cache_path}

    ffmpeg_bin = resolve_ffmpeg_path()
    if not ffmpeg_bin:
        raise RuntimeError("FFmpeg executable not found on worker node.")

    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    tmp_path = f"{cache_path}.tmp-{self.request.id}.mp4"

    cmd = [
        ffmpeg_bin,
        "-y",
        "-i", source_path,
        "-vf", "scale='min(1080,iw)':-2",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-movflags", "+faststart",
        "-c:a", "aac",
        "-b:a", "128k",
        tmp_path,
    ]

    try:
        subprocess.run(
            cmd,
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        os.replace(tmp_path, cache_path)
        logger.info("Transcoded video preview successfully: %s", cache_path)

        # Publish WebSocket event if Redis is active
        try:
            from services.redis_service import publish_event
            publish_event(f"preview_ready:{cache_key}", {"ready": True, "path": cache_path})
        except Exception:
            pass

        return {"status": "completed", "cache_path": cache_path}
    except Exception as exc:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass
        logger.error("FFmpeg transcode failed for %s: %s", source_path, exc)
        raise self.retry(exc=exc, countdown=5)
