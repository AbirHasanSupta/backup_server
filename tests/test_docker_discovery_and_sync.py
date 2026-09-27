"""Regression tests for Docker discovery, sync history fields, and PG batch_check."""

from __future__ import annotations

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


class DiscoveryAdvertisementTests(unittest.TestCase):
    def tearDown(self) -> None:
        for key in ("ADVERTISED_IPS", "HOST_LAN_IPS", "ADVERTISED_PORT", "PORT"):
            os.environ.pop(key, None)
        import config
        config._config_cache = None
        config._config_cache_mtime = None

    def test_advertised_ips_preferred_and_bridge_filtered(self) -> None:
        os.environ["ADVERTISED_IPS"] = "192.168.1.50, 10.0.0.5"
        import config
        config._config_cache = None

        from network_info import get_all_local_ips, _is_docker_bridge_ip

        self.assertTrue(_is_docker_bridge_ip("172.18.0.2"))
        self.assertFalse(_is_docker_bridge_ip("192.168.1.50"))

        ips = get_all_local_ips()
        self.assertIn("192.168.1.50", ips)
        self.assertIn("10.0.0.5", ips)
        # Advertised LAN IPs must sort ahead of any residual bridge addresses.
        self.assertEqual(ips[0], "10.0.0.5")
        self.assertEqual(ips[1], "192.168.1.50")

    def test_discovery_port_uses_advertised_port(self) -> None:
        os.environ["ADVERTISED_PORT"] = "8000"
        os.environ["PORT"] = "80"
        import config
        config._config_cache = None
        config._config_cache_mtime = None

        from network_info import get_discovery_port

        self.assertEqual(get_discovery_port(), 8000)

    def test_desktop_custom_port_unchanged_without_advertised_env(self) -> None:
        """Desktop PORT=9000 must be advertised when ADVERTISED_PORT env is unset."""
        os.environ.pop("ADVERTISED_PORT", None)
        os.environ.pop("PORT", None)

        from network_info import get_discovery_port

        with mock.patch("config.load_config", return_value={"PORT": 9000, "ADVERTISED_PORT": 9000}):
            self.assertEqual(get_discovery_port(), 9000)


class SyncSessionNormalizationTests(unittest.TestCase):
    def test_insert_accepts_total_size_alias(self) -> None:
        from repositories import file_repo

        captured: dict = {}

        def fake_write(sql, params):
            captured["params"] = params
            return 1

        with mock.patch.object(file_repo, "is_postgres", return_value=True), \
             mock.patch.object(file_repo, "execute_write", side_effect=fake_write):
            file_repo.insert_sync_session({
                "device_id": "dev-1",
                "device_name": "Pixel",
                "started_at": 1_700_000_000_000,
                "ended_at": 1_700_000_060_000,
                "duration_ms": 60_000,
                "uploaded": 3,
                "skipped": 1,
                "errors": 0,
                "bytes_uploaded": 0,  # pydantic-style default must not block total_size
                "total_size": 12_345_678,
                "outcome": "completed",
            })

        # PG insert params: ..., files_uploaded, bytes_uploaded, files_skipped, files_failed, ...
        params = captured["params"]
        self.assertEqual(params[6], 3)           # files_uploaded
        self.assertEqual(params[7], 12_345_678)  # bytes_uploaded from total_size
        self.assertEqual(params[8], 1)           # files_skipped
        self.assertEqual(params[9], 0)           # files_failed

    def test_get_sync_sessions_normalizes_pg_rows(self) -> None:
        from repositories import file_repo

        rows = [{
            "device_id": "dev-1",
            "device_name": "Pixel",
            "started_at": 1_700_000_000_000,
            "duration_sec": 12.5,
            "files_uploaded": 7,
            "bytes_uploaded": 999,
            "files_skipped": 2,
            "files_failed": 1,
            "status": "completed",
        }]

        with mock.patch.object(file_repo, "is_postgres", return_value=True), \
             mock.patch.object(file_repo, "execute_read_query", return_value=rows):
            out = file_repo.get_sync_sessions(limit=10)

        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["file_count"], 7)
        self.assertEqual(out[0]["files_uploaded"], 7)
        self.assertEqual(out[0]["uploaded"], 7)
        self.assertEqual(out[0]["bytes_uploaded"], 999)
        self.assertEqual(out[0]["total_bytes"], 999)
        self.assertEqual(out[0]["duration_seconds"], 12.5)
        self.assertEqual(out[0]["errors"], 1)
        self.assertEqual(out[0]["skipped"], 2)


class BatchCheckPostgresTests(unittest.TestCase):
    def test_batch_check_uses_postgres_when_configured(self) -> None:
        from repositories import file_repo

        db_rows = [
            {"path": "DCIM/a.jpg", "size": 100, "modified_time": 50, "external_id": "eid-1"},
            {"path": "DCIM/b.jpg", "size": 200, "modified_time": 60, "external_id": None},
        ]
        items = [
            {"path": "DCIM/a.jpg", "size": 100, "modified_time": 50, "external_id": "eid-1", "device_id": "d1"},
            {"path": "DCIM/b.jpg", "size": 200, "modified_time": 60, "external_id": None, "device_id": "d1"},
            {"path": "DCIM/c.jpg", "size": 300, "modified_time": 70, "external_id": None, "device_id": "d1"},
        ]

        with mock.patch.object(file_repo, "is_postgres", return_value=True), \
             mock.patch.object(file_repo, "execute_read_query", return_value=db_rows) as read_mock, \
             mock.patch.object(file_repo, "db_batch_check_files") as sqlite_mock:
            present = file_repo.batch_check_files(items)

        sqlite_mock.assert_not_called()
        read_mock.assert_called()
        self.assertIn("DCIM/a.jpg|50|100", present)
        self.assertIn("DCIM/b.jpg|60|200", present)
        self.assertNotIn("DCIM/c.jpg|70|300", present)


if __name__ == "__main__":
    unittest.main()
