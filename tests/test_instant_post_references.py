"""tests/test_instant_post_references.py

Unit tests verifying:
1. Posting to devices via file path references (zero copy, instant).
2. Items retain source_type='desktop' and reference existing files on disk.
3. No duplicate file bytes are copied to SHARED_DIRECT_POST_DIR.
4. Adding file paths to existing post groups via /items/add-paths.
5. Direct post JSON endpoint with file_paths.
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
import unittest

from server import create_app
from config import SHARED_DIRECT_POST_DIR, load_config
from repositories import device_repo, social_repo


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


class InstantPostReferencesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = create_app("all")
        cfg = load_config()
        cls.api_key = cfg.get("API_KEY", "")
        cls.headers = {"Authorization": f"Bearer {cls.api_key}"} if cls.api_key else {}

        # Register a test target device
        cls.target_device_id = "test-target-phone-1"
        device_repo.upsert_device(
            device_name="Test Phone",
            device_ip="192.168.1.100",
            device_id=cls.target_device_id,
            device_model="Pixel 8",
        )
        device_repo.upsert_device(
            device_name="Desktop Server",
            device_ip="127.0.0.1",
            device_id="desktop-server",
        )

    def setUp(self):
        # Create temporary sample media files
        self.temp_dir = tempfile.mkdtemp()
        self.file1 = os.path.join(self.temp_dir, "large_sample_video.mp4")
        with open(self.file1, "wb") as f:
            f.write(b"SAMPLE_VIDEO_CONTENT_BYTE_DATA_FOR_TESTING")

        self.file2 = os.path.join(self.temp_dir, "high_res_photo.jpg")
        with open(self.file2, "wb") as f:
            f.write(b"SAMPLE_IMAGE_CONTENT_BYTE_DATA_FOR_TESTING")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_create_admin_post_by_file_paths_instant(self):
        """Admin post by file paths must reference paths without copying bytes."""
        payload = {
            "file_paths": [self.file1, self.file2],
            "target_device_ids": [self.target_device_id],
            "caption": "Instant test post",
            "shared_by_device_id": "desktop-server",
        }

        # Check files before in SHARED_DIRECT_POST_DIR
        initial_direct_files = set(os.listdir(SHARED_DIRECT_POST_DIR)) if os.path.isdir(SHARED_DIRECT_POST_DIR) else set()

        status, _, body = _request(self.app, "POST", "/api/admin/posts/create", body=payload, headers=self.headers)
        self.assertEqual(status, 200, body.decode("utf-8", "ignore"))
        data = json.loads(body)
        self.assertTrue(data.get("ok"))
        self.assertEqual(data.get("count"), 2)

        # Verify NO files were copied to SHARED_DIRECT_POST_DIR
        after_direct_files = set(os.listdir(SHARED_DIRECT_POST_DIR)) if os.path.isdir(SHARED_DIRECT_POST_DIR) else set()
        self.assertEqual(initial_direct_files, after_direct_files, "No files should be copied to shared_direct_posts")

        # Verify post items in database
        group_id = data.get("group_id") or data.get("share_group_id")
        shares = social_repo.get_device_shares_by_sharer("desktop-server")
        group_shares = [s for s in shares if (s.get("share_group_id") or str(s.get("share_id"))) == group_id]
        self.assertEqual(len(group_shares), 2)

        for s in group_shares:
            self.assertEqual(s.get("source_type"), "desktop")
            self.assertIn(s.get("relative_path"), [self.file1, self.file2])

    def test_add_paths_to_existing_post(self):
        """Adding file paths to an existing post must succeed without re-uploading."""
        # First create a post
        status, _, body = _request(self.app, "POST", "/api/admin/posts/create", body={
            "file_paths": [self.file1],
            "target_device_ids": [self.target_device_id],
            "caption": "Post to edit",
        }, headers=self.headers)
        self.assertEqual(status, 200)
        group_id = json.loads(body).get("group_id")

        # Add second file path to this post
        status_add, _, body_add = _request(self.app, "POST", f"/api/admin/posts/{group_id}/items/add-paths", body={
            "file_paths": [self.file2],
        }, headers=self.headers)
        self.assertEqual(status_add, 200)
        data_add = json.loads(body_add)
        self.assertTrue(data_add.get("ok"))
        self.assertEqual(data_add.get("total_items"), 2)

    def test_direct_post_create_json_with_file_paths(self):
        """Standard direct-post endpoint must accept file_paths without copying."""
        payload = {
            "shared_by_device_id": "desktop-server",
            "target_device_ids": [self.target_device_id],
            "caption": "Direct post with paths",
            "file_paths": [self.file1],
        }
        status, _, body = _request(self.app, "POST", "/api/share/direct-post/create", body=payload, headers=self.headers)
        self.assertEqual(status, 200, body.decode("utf-8", "ignore"))
        data = json.loads(body)
        self.assertTrue(data.get("ok"))


if __name__ == "__main__":
    unittest.main()
