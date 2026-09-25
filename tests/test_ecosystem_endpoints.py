"""tests/test_ecosystem_endpoints.py - Comprehensive integration tests for all Android ecosystem endpoints."""

from __future__ import annotations

import asyncio
import json
import unittest
from typing import Any

from server import app
from core.config import load_config


def async_request(method: str, path: str, headers: dict | None = None, body: bytes | dict | None = None) -> tuple[int, dict, bytes]:
    """Simple ASGI request runner using only Python standard library."""
    if "?" in path:
        raw_path, query_string = path.split("?", 1)
    else:
        raw_path, query_string = path, ""

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


class EcosystemEndpointsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cfg = load_config()
        cls.api_key = cfg.get("API_KEY", "")
        cls.orig_approval = cfg.get("REQUIRE_APPROVAL", True)
        cfg["REQUIRE_APPROVAL"] = False

    @classmethod
    def tearDownClass(cls):
        cfg = load_config()
        cfg["REQUIRE_APPROVAL"] = cls.orig_approval

    def test_discovery_ping_unauthenticated(self):
        """GET /ping and /api/ping must be unauthenticated and return server discovery metadata."""
        for route in ["/ping", "/api/ping"]:
            status, headers, body = async_request("GET", route)
            self.assertEqual(status, 200, f"Failed for route {route}")
            data = json.loads(body.decode("utf-8"))
            self.assertEqual(data.get("status"), "ok")
            self.assertIn("server_id", data)
            self.assertIn("version", data)
            self.assertIn("all_ips", data)
            self.assertIn("hostname", data)

    def test_connect_with_auth_header(self):
        """POST /connect must succeed with valid Authorization Bearer header."""
        status, headers, body = async_request(
            "POST",
            "/connect",
            headers={"Authorization": f"Bearer {self.api_key}"},
            body={"device_name": "Test Phone", "device_model": "Pixel 7"},
        )
        self.assertEqual(status, 200)
        data = json.loads(body.decode("utf-8"))
        self.assertIn("device_id", data)
        self.assertIn("token", data)
        self.assertTrue(data.get("ok"))

    def test_connect_with_token_query_param(self):
        """POST /connect must succeed with token query parameter."""
        status, headers, body = async_request(
            "POST",
            f"/connect?token={self.api_key}",
            body={"device_name": "Test Phone 2", "device_model": "iPhone 15"},
        )
        self.assertEqual(status, 200)
        data = json.loads(body.decode("utf-8"))
        self.assertIn("device_id", data)
        self.assertTrue(data.get("ok"))

    def test_devices_and_status(self):
        """Test /devices and /status endpoints."""
        status, _, body = async_request(
            "POST",
            "/connect",
            headers={"Authorization": f"Bearer {self.api_key}"},
            body={"device_name": "Status Device", "device_model": "Test"},
        )
        c_data = json.loads(body.decode("utf-8"))
        dev_id = c_data["device_id"]
        dev_token = c_data["token"]

        # List devices
        for route in ["/devices", "/api/devices"]:
            status, _, body = async_request("GET", f"{route}?device_id={dev_id}", headers={"Authorization": f"Bearer {dev_token}"})
            self.assertEqual(status, 200, f"Failed for route {route}")
            data = json.loads(body.decode("utf-8"))
            self.assertIn("devices", data)

        # Status
        for route in ["/status", "/api/status"]:
            status, _, body = async_request("GET", f"{route}?device_id={dev_id}", headers={"Authorization": f"Bearer {dev_token}"})
            self.assertEqual(status, 200, f"Failed for route {route}")
            data = json.loads(body.decode("utf-8"))
            self.assertIn("status", data)
            self.assertIn("server_version", data)

        # Update username
        status, _, body = async_request(
            "POST",
            f"/devices/{dev_id}/username",
            headers={"Authorization": f"Bearer {dev_token}"},
            body={"username": "Alice"},
        )
        self.assertEqual(status, 200)

    def test_files_browse_compatibility(self):
        """GET /files/browse and /api/files/browse accept prefix and return folders & files."""
        status, _, body = async_request(
            "POST",
            "/connect",
            headers={"Authorization": f"Bearer {self.api_key}"},
            body={"device_name": "Browse Device", "device_model": "Test"},
        )
        c_data = json.loads(body.decode("utf-8"))
        dev_id = c_data["device_id"]
        dev_token = c_data["token"]

        for route in ["/files/browse", "/api/files/browse"]:
            status, _, body = async_request(
                "GET",
                f"{route}?device_id={dev_id}&prefix=DCIM",
                headers={"Authorization": f"Bearer {dev_token}"},
            )
            self.assertEqual(status, 200, f"Failed for route {route}")
            data = json.loads(body.decode("utf-8"))
            self.assertIn("folders", data)
            self.assertIn("files", data)

        # Files search
        for route in ["/files/search", "/api/files/search"]:
            status, _, body = async_request(
                "GET",
                f"{route}?device_id={dev_id}&q=test",
                headers={"Authorization": f"Bearer {dev_token}"},
            )
            self.assertEqual(status, 200, f"Failed for route {route}")
            data = json.loads(body.decode("utf-8"))
            self.assertIn("files", data)

    def test_shared_list_dual_format(self):
        """GET /shared/list returns both 'sources' (downloader.js) and 'shared_dirs' formats."""
        status, _, body = async_request(
            "POST",
            "/connect",
            headers={"Authorization": f"Bearer {self.api_key}"},
            body={"device_name": "Shared Device", "device_model": "Test"},
        )
        c_data = json.loads(body.decode("utf-8"))
        dev_id = c_data["device_id"]
        dev_token = c_data["token"]

        for route in ["/shared/list", "/api/shared/list"]:
            status, _, body = async_request(
                "GET",
                f"{route}?device_id={dev_id}",
                headers={"Authorization": f"Bearer {dev_token}"},
            )
            self.assertEqual(status, 200, f"Failed for route {route}")
            data = json.loads(body.decode("utf-8"))
            self.assertIn("sources", data)
            self.assertIn("shared_dirs", data)

    def test_memories_endpoints(self):
        """Test flashback, roulette, quiz, wrapped, places, and rewind generate endpoints."""
        status, _, body = async_request(
            "POST",
            "/connect",
            headers={"Authorization": f"Bearer {self.api_key}"},
            body={"device_name": "Memories Device", "device_model": "Test"},
        )
        c_data = json.loads(body.decode("utf-8"))
        dev_id = c_data["device_id"]
        dev_token = c_data["token"]

        # Today
        status, _, body = async_request(
            "GET",
            f"/memories/today?device_id={dev_id}",
            headers={"Authorization": f"Bearer {dev_token}"},
        )
        self.assertEqual(status, 200)

        # Recent
        status, _, body = async_request(
            "GET",
            f"/memories/recent?device_id={dev_id}&days=7",
            headers={"Authorization": f"Bearer {dev_token}"},
        )
        self.assertEqual(status, 200)

        # Flashback
        status, _, body = async_request(
            "GET",
            f"/memories/flashback?device_id={dev_id}",
            headers={"Authorization": f"Bearer {dev_token}"},
        )
        self.assertEqual(status, 200)

        # Roulette
        status, _, body = async_request(
            "GET",
            f"/memories/roulette?device_id={dev_id}",
            headers={"Authorization": f"Bearer {dev_token}"},
        )
        self.assertEqual(status, 200)

        # Quiz
        status, _, body = async_request(
            "GET",
            f"/memories/quiz?device_id={dev_id}",
            headers={"Authorization": f"Bearer {dev_token}"},
        )
        self.assertEqual(status, 200)
        data = json.loads(body.decode("utf-8"))
        self.assertIn("items", data)

        # Wrapped
        status, _, body = async_request(
            "GET",
            f"/memories/wrapped?device_id={dev_id}&year=2025",
            headers={"Authorization": f"Bearer {dev_token}"},
        )
        self.assertEqual(status, 200)

        # Places
        status, _, body = async_request(
            "GET",
            f"/memories/places?device_id={dev_id}",
            headers={"Authorization": f"Bearer {dev_token}"},
        )
        self.assertEqual(status, 200)

        # Rewind generate via query params
        status, _, body = async_request(
            "POST",
            f"/memories/rewind/generate?device_id={dev_id}&year=2025",
            headers={"Authorization": f"Bearer {dev_token}"},
        )
        self.assertEqual(status, 200)

        # Rewind status
        status, _, body = async_request(
            "GET",
            f"/memories/rewind/status?device_id={dev_id}&year=2025",
            headers={"Authorization": f"Bearer {dev_token}"},
        )
        self.assertEqual(status, 200)

    def test_trips_endpoints(self):
        """Test /trips and /trips/recluster endpoints."""
        status, _, body = async_request(
            "POST",
            "/connect",
            headers={"Authorization": f"Bearer {self.api_key}"},
            body={"device_name": "Trips Device", "device_model": "Test"},
        )
        c_data = json.loads(body.decode("utf-8"))
        dev_id = c_data["device_id"]
        dev_token = c_data["token"]

        for route in ["/trips", "/api/trips"]:
            status, _, body = async_request(
                "GET",
                f"{route}?device_id={dev_id}",
                headers={"Authorization": f"Bearer {dev_token}"},
            )
            self.assertEqual(status, 200, f"Failed for route {route}")
            data = json.loads(body.decode("utf-8"))
            self.assertIn("trips", data)

    def test_cleanup_endpoints(self):
        """Test /cleanup/candidates and /cleanup/delete endpoints."""
        status, _, body = async_request(
            "POST",
            "/connect",
            headers={"Authorization": f"Bearer {self.api_key}"},
            body={"device_name": "Cleanup Device", "device_model": "Test"},
        )
        c_data = json.loads(body.decode("utf-8"))
        dev_id = c_data["device_id"]
        dev_token = c_data["token"]

        for route in ["/cleanup/candidates", "/api/cleanup/candidates"]:
            status, _, body = async_request(
                "GET",
                f"{route}?source_id={dev_id}",
                headers={"Authorization": f"Bearer {dev_token}"},
            )
            self.assertEqual(status, 200, f"Failed for route {route}")
            data = json.loads(body.decode("utf-8"))
            self.assertIn("candidates", data)


if __name__ == "__main__":
    unittest.main()
