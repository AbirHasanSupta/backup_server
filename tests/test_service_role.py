"""tests/test_service_role.py — SERVICE_ROLE router isolation & nginx sync split."""

from __future__ import annotations

import asyncio
import json
import unittest
from pathlib import Path

from api.v1 import build_v1_router, normalize_service_role
from server import create_app


def _openapi_paths(app_or_router) -> set[str]:
    """Collect public paths from an app OpenAPI schema or a throwaway mount."""
    if hasattr(app_or_router, "openapi") and callable(app_or_router.openapi):
        return set(app_or_router.openapi().get("paths", {}).keys())
    from fastapi import FastAPI
    tmp = FastAPI()
    tmp.include_router(app_or_router)
    return set(tmp.openapi().get("paths", {}).keys())


def _async_request(app, method: str, path: str) -> tuple[int, dict, dict]:
    if "?" in path:
        raw_path, query_string = path.split("?", 1)
    else:
        raw_path, query_string = path, ""

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method.upper(),
        "path": raw_path,
        "raw_path": raw_path.encode("ascii"),
        "query_string": query_string.encode("ascii"),
        "headers": [],
        "client": ("127.0.0.1", 12345),
        "server": ("127.0.0.1", 8000),
    }

    response_status = 200
    response_headers: dict[str, str] = {}
    response_body = bytearray()

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        nonlocal response_status, response_headers, response_body
        if message["type"] == "http.response.start":
            response_status = message["status"]
            response_headers = {
                k.decode("latin1"): v.decode("latin1") for k, v in message.get("headers", [])
            }
        elif message["type"] == "http.response.body":
            response_body.extend(message.get("body", b""))

    async def run():
        await app(scope, receive, send)

    asyncio.run(run())
    payload: dict = {}
    if response_body:
        try:
            payload = json.loads(response_body.decode("utf-8"))
        except Exception:
            payload = {}
    return response_status, response_headers, payload


class ServiceRoleTests(unittest.TestCase):
    def test_normalize_service_role(self):
        self.assertEqual(normalize_service_role("ALL"), "all")
        self.assertEqual(normalize_service_role("app"), "app")
        self.assertEqual(normalize_service_role("sync"), "sync")
        self.assertEqual(normalize_service_role("weird"), "all")
        self.assertEqual(normalize_service_role(None), "all")

    def test_sync_router_exposes_upload_not_feed(self):
        paths = _openapi_paths(build_v1_router("sync"))
        self.assertIn("/upload", paths)
        self.assertIn("/files/check", paths)
        self.assertIn("/ping", paths)
        self.assertNotIn("/feed", paths)
        self.assertNotIn("/reels", paths)
        self.assertNotIn("/memories/today", paths)

    def test_app_router_exposes_feed_not_sync_upload(self):
        paths = _openapi_paths(build_v1_router("app"))
        self.assertIn("/feed", paths)
        self.assertIn("/reels", paths)
        self.assertIn("/files/list", paths)
        self.assertIn("/ping", paths)
        self.assertNotIn("/upload", paths)
        self.assertNotIn("/files/check", paths)
        self.assertNotIn("/sync/session", paths)

    def test_all_router_includes_both(self):
        paths = _openapi_paths(build_v1_router("all"))
        self.assertIn("/upload", paths)
        self.assertIn("/feed", paths)
        self.assertIn("/ping", paths)

    def test_sync_app_header_and_ping(self):
        app = create_app("sync")
        status, headers, body = _async_request(app, "GET", "/ping")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("x-service-role"), "sync")
        self.assertEqual(body.get("status"), "ok")
        paths = _openapi_paths(app)
        self.assertIn("/upload", paths)
        self.assertNotIn("/feed", paths)

    def test_app_role_header(self):
        app = create_app("app")
        status, headers, body = _async_request(app, "GET", "/ping")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("x-service-role"), "app")
        self.assertEqual(body.get("status"), "ok")
        paths = _openapi_paths(build_v1_router("app"))
        self.assertNotIn("/upload", paths)

    def test_app_role_keeps_admin_sync_history(self):
        """Admin /api/sync/history must remain on app-api after the sync split."""
        paths = _openapi_paths(create_app("app"))
        self.assertIn("/api/sync/history", paths)
        self.assertIn("/api/sync/history/clear", paths)
        # Phone upload session API is sync-only (v1), not on app aggregator.
        self.assertNotIn("/sync/session", paths)

    def test_nginx_routes_sync_to_sync_upstream(self):
        conf = Path(__file__).resolve().parents[1] / "nginx" / "nginx.conf"
        text = conf.read_text(encoding="utf-8")
        self.assertIn("upstream sync_upstream", text)
        self.assertIn("upstream app_upstream", text)
        self.assertIn("server sync_api:8000", text)
        self.assertIn("server api:8000", text)
        self.assertIn("location = /files/check", text)
        self.assertIn("location = /api/v1/files/check", text)
        self.assertIn("location ^~ /upload", text)
        self.assertIn("location ^~ /api/v1/upload", text)
        self.assertIn("location ^~ /sync/", text)
        self.assertIn("proxy_pass http://sync_upstream", text)
        self.assertIn("proxy_pass http://app_upstream", text)
        # Admin sync history must stay on app-api (not phone /sync/*).
        self.assertNotRegex(text, r"location\s+\^~\s+/api/sync/")
        self.assertIn("/api/sync/history", text)
        self.assertRegex(
            text,
            r"location /\s*\{[^}]*proxy_pass http://app_upstream;",
        )

    def test_compose_defines_sync_api_service(self):
        compose = Path(__file__).resolve().parents[1] / "docker-compose.yml"
        text = compose.read_text(encoding="utf-8")
        self.assertIn("sync_api:", text)
        self.assertIn("SERVICE_ROLE=sync", text)
        self.assertIn("SERVICE_ROLE=app", text)
        self.assertIn("SYNC_GUNICORN_WORKERS", text)
        self.assertIn("SYNC_API_THREADPOOL_WORKERS", text)


if __name__ == "__main__":
    unittest.main()
