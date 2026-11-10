"""tests/test_desktop_server_display_name.py

Verify that reels and posts shared by the desktop server display the server name
(DESKTOP_NAME) instead of 'Unknown device' across both Feed and Reels APIs.
"""

from __future__ import annotations

import asyncio
import json
import unittest

from server import create_app
from config import load_config
from repositories import device_repo
from services.reels_service import reels_service
from services.feed_service import feed_service


def _request(app, method: str, path: str, body=None, headers=None):
    raw_path, _, query_string = path.partition("?")
    headers_list = []
    if headers:
        for k, v in headers.items():
            headers_list.append((k.lower().encode("latin1"), str(v).encode("latin1")))

    req_body = b""
    if isinstance(body, dict):
        req_body = json.dumps(body).encode("utf-8")
        headers_list.append((b"content-type", b"application/json"))
        headers_list.append((b"content-length", str(len(req_body)).encode("latin1")))
    elif isinstance(body, bytes):
        req_body = body
        headers_list.append((b"content-length", str(len(req_body)).encode("latin1")))

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method.upper(),
        "path": raw_path,
        "raw_path": raw_path.encode("ascii"),
        "query_string": query_string.encode("ascii"),
        "headers": headers_list,
        "client": ("127.0.0.1", 12345),
        "server": ("127.0.0.1", 8000),
    }

    response_status = 200
    response_headers = {}
    response_body = bytearray()

    async def receive():
        return {"type": "http.request", "body": req_body, "more_body": False}

    async def send(message):
        nonlocal response_status, response_headers, response_body
        if message["type"] == "http.response.start":
            response_status = message["status"]
            response_headers = {k.decode("latin1"): v.decode("latin1") for k, v in message.get("headers", [])}
        elif message["type"] == "http.response.body":
            response_body.extend(message.get("body", b""))

    asyncio.run(app(scope, receive, send))
    return response_status, response_headers, bytes(response_body)


class DesktopServerDisplayNameTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from database import init_db
        init_db()
        cls.app = create_app("all")
        cfg = load_config()
        cls.api_key = cfg.get("API_KEY", "")
        cls.headers = {"Authorization": f"Bearer {cls.api_key}"} if cls.api_key else {}
        cls.expected_server_name = (cfg.get("DESKTOP_NAME") or "").strip() or "Desktop Server"

        # Ensure desktop device row is properly registered
        device_repo.ensure_desktop_device()

        # Register a test mobile device
        cls.test_device_id = "test-mobile-name-chk"
        device_repo.upsert_device(
            device_name="Test Galaxy",
            device_ip="192.168.1.55",
            device_id=cls.test_device_id,
            device_model="Galaxy S23",
        )
        cls.test_token = device_repo.ensure_device_token(cls.test_device_id)

    def test_get_device_display_name_desktop_server(self):
        """desktop-server identifier must return the configured DESKTOP_NAME, never 'Unknown device'."""
        name = device_repo.get_device_display_name("desktop-server")
        self.assertEqual(name, self.expected_server_name)
        self.assertNotEqual(name, "Unknown device")

    def test_format_device_display_name_with_desktop_id(self):
        """format_device_display_name must recognize desktop-server."""
        name = device_repo.format_device_display_name(None, None, device_id="desktop-server")
        self.assertEqual(name, self.expected_server_name)

        name_fb = device_repo.format_device_display_name(None, None, fallback="desktop-server")
        self.assertEqual(name_fb, self.expected_server_name)

    def test_create_server_post_and_verify_feed_and_reels_display_name(self):
        """Posts created by desktop-server must show DESKTOP_NAME in both Feed and Reels."""
        import tempfile, os
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
            f.write(b"MOCK_VIDEO_DATA_FOR_DISPLAY_NAME_TEST")
            tmp_video = f.name

        try:
            # Create a post from the desktop server to the test mobile device
            post_payload = {
                "file_paths": [tmp_video],
                "target_device_ids": [self.test_device_id],
                "caption": "Reel name test",
                "shared_by_device_id": "desktop-server",
            }
            status, _, body = _request(self.app, "POST", "/api/admin/posts/create", body=post_payload, headers=self.headers)
            self.assertEqual(status, 200, body.decode("utf-8", "ignore"))

            # 1. Check Reels Feed
            reels, _, total = reels_service.build_reels_feed(self.test_device_id)
            self.assertGreater(total, 0)
            server_reels = [r for r in reels if r.get("shared_by_device_id") == "desktop-server"]
            self.assertGreater(len(server_reels), 0)
            for r in server_reels:
                self.assertEqual(r["shared_by"], self.expected_server_name)
                self.assertEqual(r["original_author"]["display_name"], self.expected_server_name)
                self.assertNotEqual(r["shared_by"], "Unknown device")
                self.assertNotEqual(r["original_author"]["display_name"], "Unknown device")

            # 2. Check Unified Feed
            posts, _, feed_total = feed_service.build_unified_feed(self.test_device_id, 0, 50)
            self.assertGreater(feed_total, 0)
            server_posts = [p for p in posts if p.get("shared_by_device_id") == "desktop-server"]
            self.assertGreater(len(server_posts), 0)
            for p in server_posts:
                self.assertEqual(p["shared_by"], self.expected_server_name)
                self.assertNotEqual(p["shared_by"], "Unknown device")

            # 3. Check HTTP /api/reels endpoint
            reel_status, _, reel_body = _request(
                self.app,
                "GET",
                f"/api/reels?device_id={self.test_device_id}&limit=10",
                headers={"Authorization": f"Bearer {self.test_token}"},
            )
            self.assertEqual(reel_status, 200)
            reel_data = json.loads(reel_body)
            http_server_reels = [r for r in reel_data.get("reels", []) if r.get("shared_by_device_id") == "desktop-server"]
            self.assertGreater(len(http_server_reels), 0)
            for r in http_server_reels:
                self.assertEqual(r["shared_by"], self.expected_server_name)
                self.assertEqual(r["original_author"]["display_name"], self.expected_server_name)

            # 4. Check HTTP /api/feed endpoint
            feed_status, _, feed_body = _request(
                self.app,
                "GET",
                f"/api/feed?device_id={self.test_device_id}&limit=50",
                headers={"Authorization": f"Bearer {self.test_token}"},
            )
            self.assertEqual(feed_status, 200)
            feed_data = json.loads(feed_body)
            http_server_posts = [p for p in feed_data.get("items", []) if p.get("shared_by_device_id") == "desktop-server"]
            self.assertGreater(len(http_server_posts), 0)
            for p in http_server_posts:
                self.assertEqual(p["shared_by"], self.expected_server_name)

        finally:
            if os.path.exists(tmp_video):
                try:
                    os.remove(tmp_video)
                except OSError:
                    pass


if __name__ == "__main__":
    unittest.main()
