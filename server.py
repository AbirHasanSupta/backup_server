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
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from api.v1 import build_v1_router, normalize_service_role
from config import load_config
from database import init_db
from version import APP_VERSION
import memories

logger = logging.getLogger("backup_server")

SERVICE_ROLE = normalize_service_role(os.environ.get("SERVICE_ROLE", "all"))


def _positive_int_env(name: str, default: int, *, minimum: int = 1, maximum: int = 256) -> int:
    """Read a bounded deployment tuning value without making startup fragile."""
    try:
        value = int(os.environ.get(name, default))
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(value, maximum))


def _configured_cors_origins() -> list[str]:
    """Parse an explicit browser-origin allowlist without affecting native clients."""
    configured = load_config().get("CORS_ORIGINS", "")
    if isinstance(configured, list):
        return [str(origin).strip() for origin in configured if str(origin).strip()]
    return [origin.strip() for origin in str(configured).split(",") if origin.strip()]


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Blocking filesystem/database work is shared by every request handled by
    # this Gunicorn worker.  The previous 120–200 thread setting *per worker*
    # created hundreds of runnable threads in a four-worker Docker deployment,
    # causing CPU and disk queue contention.  Keep a bounded pool per process;
    # deployments with demonstrably faster storage can raise it explicitly.
    role = normalize_service_role(getattr(app.state, "service_role", None) or SERVICE_ROLE)
    cfg = load_config()
    cpu = os.cpu_count() or 4
    default_threads = max(8, min(24, cpu * 2)) if cfg.get("DATABASE_BACKEND") == "postgres" else max(16, min(48, cpu * 3))
    token_limit = _positive_int_env("API_THREADPOOL_WORKERS", default_threads)
    anyio.to_thread.current_default_thread_limiter().total_tokens = token_limit
    executor = ThreadPoolExecutor(max_workers=token_limit)
    asyncio.get_running_loop().set_default_executor(executor)
    logger.info(
        "Configured API blocking-work pool with %s threads per process (SERVICE_ROLE=%s).",
        token_limit,
        role,
    )

    # Docker uses PostgreSQL exclusively.  Running the SQLite migration in all
    # four Gunicorn workers created avoidable lock contention and harmless but
    # alarming "duplicate column" startup warnings against the fallback file.
    # Keep SQLite initialization for desktop/local deployments only.
    if cfg.get("DATABASE_BACKEND") != "postgres":
        try:
            init_db()
        except Exception as e:
            logger.warning("SQLite schema initialization: %s", e)

    # Multi-backend Database Initialization (Postgres with SQLite fallback)
    if cfg.get("DATABASE_BACKEND") == "postgres":
        try:
            from database_pg import init_pg_db
            init_pg_db()
            logger.info("PostgreSQL multi-user database backend initialized.")
        except Exception as e:
            logger.warning("Failed to initialize PostgreSQL (%s), falling back to SQLite.", e)

    # Redis Connection Warmup
    try:
        from services.redis_service import get_redis_client
        r = get_redis_client()
        if r:
            logger.info("Redis cache and distributed lock cluster connected.")
    except Exception as e:
        logger.info("Running in standalone in-memory mode (Redis disabled): %s", e)

    # Background memory index: app/monolith only.  Sync workers must not compete
    # with upload I/O for EXIF/ffprobe scans.
    if role in ("all", "app"):
        threading.Thread(target=memories.startup_scan_loop, daemon=True, name="MemoryScanLoop").start()

    # Mirror desktop startup: surface the away-from-home Tailscale endpoint when
    # the CLI is present or Docker env overrides (TAILSCALE_*) are configured.
    try:
        from network_info import (
            format_endpoint_for_url,
            get_discovery_port,
            get_tailscale_network_info,
        )
        tailscale = get_tailscale_network_info()
        if tailscale.get("available"):
            endpoint = format_endpoint_for_url(
                tailscale.get("dns_name") or (tailscale.get("ips") or [""])[0]
            )
            if endpoint:
                logger.info(
                    "Tailscale remote endpoint: http://%s:%s",
                    endpoint,
                    get_discovery_port(),
                )
    except Exception:
        pass

    cleanup_task = None
    # Chunk staging lives with the sync surface.  App-only containers skip this.
    if role in ("all", "sync"):
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
        if cleanup_task is not None:
            cleanup_task.cancel()
            try:
                await cleanup_task
            except asyncio.CancelledError:
                pass
        executor.shutdown(wait=False)
        if role in ("all", "app"):
            try:
                memories.release_scan_leader_if_held()
            except Exception:
                pass


def create_app(service_role: str | None = None) -> FastAPI:
    """Build a FastAPI app for ``all`` (monolith), ``app``, or ``sync`` role."""
    role = normalize_service_role(service_role if service_role is not None else SERVICE_ROLE)

    application = FastAPI(
        title="Phone Backup Server Pro",
        description="High-concurrency, multi-user media backup & social streaming server",
        version=APP_VERSION,
        lifespan=lifespan,
    )
    application.state.service_role = role

    application.add_middleware(
        CORSMiddleware,
        # A wildcard origin combined with credential support is both unsafe and
        # rejected by browsers.  Android uses native networking, so a secure empty
        # browser allowlist is the correct standalone default.
        allow_origins=_configured_cors_origins(),
        allow_credentials=bool(load_config().get("CORS_ALLOW_CREDENTIALS", False)) and bool(_configured_cors_origins()),
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Identify which process answered (useful for nginx routing smoke tests).
    @application.middleware("http")
    async def _service_role_header(request, call_next):
        response = await call_next(request)
        response.headers["X-Service-Role"] = role
        return response

    v1 = build_v1_router(role)
    application.include_router(v1)
    application.include_router(v1, prefix="/api/v1")

    if role in ("all", "app"):
        from routers.websocket_hub import ws_router
        from upload import router as legacy_router

        # WebSocket Event Gateway
        application.include_router(ws_router)

        # Fallback Legacy Router.  Keep unversioned compatibility endpoints live
        # for existing desktop/mobile installations, but exclude the duplicate route
        # definitions from OpenAPI so generated clients and docs have one operation ID
        # per public v1 operation.
        # Note: when SERVICE_ROLE=app, legacy still registers historical /upload paths;
        # nginx routes those to sync_api so they are not exercised on app workers.
        application.include_router(legacy_router, include_in_schema=False)

        # Web Admin Panel — zero-build SPA served at /admin
        web_admin_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web_admin")
        if os.path.isdir(web_admin_dir):
            application.mount("/admin", StaticFiles(directory=web_admin_dir, html=True), name="web_admin")

            @application.get("/", include_in_schema=False)
            async def root_redirect():
                return RedirectResponse(url="/admin", status_code=302)

    return application


app = create_app()


if __name__ == "__main__":
    cfg = load_config()
    uvicorn.run(
        "server:app",
        host=cfg.get("HOST", "0.0.0.0"),
        port=int(cfg.get("PORT", 8000)),
        workers=int(cfg.get("WORKERS", 1)),
        access_log=False,
    )
