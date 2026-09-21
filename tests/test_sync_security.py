"""Regression tests for sync authorization boundaries."""

from __future__ import annotations

import unittest

from fastapi import HTTPException
from api.v1.sync import _require_accepted_device


class SyncSecurityTests(unittest.TestCase):
    def test_missing_or_unapproved_device_cannot_use_sync_routes(self) -> None:
        for device_id in (None, "unapproved-device-for-test"):
            with self.assertRaises(HTTPException) as raised:
                _require_accepted_device(device_id)
            self.assertEqual(raised.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
