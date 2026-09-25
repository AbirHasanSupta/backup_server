"""celery_app.py — Asynchronous Task Queue & Distributed Worker Configuration.

Routes heavy CPU/GPU background tasks away from the FastAPI API gateway into
isolated worker pools:
- Video preview transcoding (FFmpeg)
- Rewind Reel procedural montage rendering
- Daily EXIF/GPS media indexing and trip clustering
"""

import os
import sys

_app_root = os.path.abspath(os.path.dirname(__file__))
if _app_root not in sys.path:
    sys.path.insert(0, _app_root)
if "/app" not in sys.path and os.path.isdir("/app"):
    sys.path.insert(0, "/app")

from celery import Celery
from config import load_config

_cfg = load_config()
REDIS_URL = os.environ.get("REDIS_URL") or _cfg.get("REDIS_URL") or "redis://localhost:6379/0"

celery_app = Celery(
    "phone_backup_tasks",
    broker=REDIS_URL,
    backend=os.environ.get("CELERY_RESULT_BACKEND") or REDIS_URL.replace("/0", "/1"),
    include=[
        "tasks.video_tasks",
        "tasks.rewind_tasks",
        "tasks.indexing_tasks",
    ],
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
    task_time_limit=600,  # 10 min hard limit
    task_soft_time_limit=480,  # 8 min soft limit
    worker_prefetch_multiplier=1,  # Prevent worker hoard on heavy transcoding tasks
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    task_routes={
        "tasks.video_tasks.*": {"queue": "transcode_video"},
        "tasks.rewind_tasks.*": {"queue": "render_rewind"},
        "tasks.indexing_tasks.*": {"queue": "indexing_queue"},
    },
)
