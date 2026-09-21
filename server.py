"""server.py — High-Concurrency Async API Server Gateway."""

from __future__ import annotations

import asyncio
import logging
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager

import anyio
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.v1 import v1_router
from config import load_config
from database import init_db
from upload import router as legacy_router
from routers.websocket_hub import ws_router
from version import APP_VERSION
import memories

logger = logging.getLogger("backup_server")


def _configured_cors_origins() -> list[str]:
    """Parse an explicit browser-origin allowlist without affecting native clients."""
    configured = load_config().get("CORS_ORIGINS", "")
    if isinstance(configured, list):
        return [str(origin).strip() for origin in configured if str(origin).strip()]
    return [origin.strip() for origin in str(configured).split(",") if origin.strip()]


@asynccontextmanager
async def lifespan(app: FastAPI):
    # High-throughput thread pool for file I/O and CPU offloading
    token_limit = max(200, (os.cpu_count() or 4) * 30)
    anyio.to_thread.current_default_thread_limiter().total_tokens = token_limit
    executor = ThreadPoolExecutor(max_workers=token_limit)
    asyncio.get_running_loop().set_default_executor(executor)

    cfg = load_config()

    # Multi-backend Database Initialization (Postgres with SQLite fallback)
    if cfg.get("DATABASE_BACKEND") == "postgres":
        try:
            from database_pg import init_pg_db
            init_pg_db()
            logger.info("PostgreSQL multi-user database backend initialized.")
        except Exception as e:
            logger.warning("Failed to initialize PostgreSQL (%s), falling back to SQLite.", e)
            init_db()
    else:
        init_db()

    # Redis Connection Warmup
    try:
        from services.redis_service import get_redis_client
        r = get_redis_client()
        if r:
            logger.info("Redis cache and distributed lock cluster connected.")
    except Exception as e:
        logger.info("Running in standalone in-memory mode (Redis disabled): %s", e)

    # Background memory index startup scan
    threading.Thread(target=memories.startup_scan_loop, daemon=True, name="MemoryScanLoop").start()

    async def cleanup_expired_upload_sessions() -> None:
        """Keep interrupted resumable uploads from becoming permanent cache data."""
        from storage.manager import get_storage
        while True:
            try:
                ttl = max(60, int(load_config().get("UPLOAD_SESSION_TTL_SECONDS", 24 * 60 * 60)))
                removed = await asyncio.to_thread(get_storage().cleanup_expired_chunks, ttl)
                if removed:
                    logger.info("Removed %s expired resumable upload session(s).", removed)
            except Exception as exc:
                logger.warning("Expired upload-session cleanup failed: %s", exc)
            await asyncio.sleep(60 * 60)

    cleanup_task = asyncio.create_task(cleanup_expired_upload_sessions())

    try:
        yield
    finally:
        cleanup_task.cancel()
        try:
            await cleanup_task
        except asyncio.CancelledError:
            pass
        executor.shutdown(wait=False)


app = FastAPI(
    title="Phone Backup Server Pro",
    description="High-concurrency, multi-user media backup & social streaming server",
    version=APP_VERSION,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    # A wildcard origin combined with credential support is both unsafe and
    # rejected by browsers.  Android uses native networking, so a secure empty
    # browser allowlist is the correct standalone default.
    allow_origins=_configured_cors_origins(),
    allow_credentials=bool(load_config().get("CORS_ALLOW_CREDENTIALS", False)) and bool(_configured_cors_origins()),
    allow_methods=["*"],
    allow_headers=["*"],
)

# 1. Primary Clean Layered Architecture Router (v1)
app.include_router(v1_router)
app.include_router(v1_router, prefix="/api/v1")

# 2. WebSocket Event Gateway
app.include_router(ws_router)

# 3. Fallback Legacy Router.  Keep unversioned compatibility endpoints live
# for existing desktop/mobile installations, but exclude the duplicate route
# definitions from OpenAPI so generated clients and docs have one operation ID
# per public v1 operation.
app.include_router(legacy_router, include_in_schema=False)


if __name__ == "__main__":
    cfg = load_config()
    uvicorn.run(
        "server:app",
        host=cfg.get("HOST", "0.0.0.0"),
        port=int(cfg.get("PORT", 8000)),
        workers=int(cfg.get("WORKERS", 1)),
        access_log=False,
    )
