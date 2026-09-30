"""tests/test_ws_upload_coalesce.py — bulk-upload WS event coalescing."""

from __future__ import annotations

import unittest
from unittest import mock

from services import ws_service as ws_mod


class UploadCoalesceTests(unittest.TestCase):
    def setUp(self) -> None:
        with ws_mod._upload_lock:
            ws_mod._upload_pending.clear()
            if ws_mod._upload_timer is not None:
                try:
                    ws_mod._upload_timer.cancel()
                except Exception:
                    pass
                ws_mod._upload_timer = None

    def tearDown(self) -> None:
        self.setUp()

    def test_coalesce_then_flush_emits_once_with_batch_count(self) -> None:
        events = []

        def _capture(event_type, data):
            events.append((event_type, dict(data)))

        with mock.patch.object(ws_mod.WebSocketService, "broadcast_event", side_effect=_capture):
            # Prevent the 2s timer from racing the explicit flush.
            with mock.patch("services.ws_service.threading.Timer") as timer_cls:
                timer = mock.Mock()
                timer_cls.return_value = timer
                ws_mod.ws_service.notify_file_uploaded("dev-a", "a.jpg", 10, 1, 10)
                ws_mod.ws_service.notify_file_uploaded("dev-a", "b.jpg", 20, 2, 30)
                ws_mod.ws_service.flush_coalesced_uploads()

        self.assertEqual(len(events), 1)
        event_type, data = events[0]
        self.assertEqual(event_type, "file_uploaded")
        self.assertEqual(data["device_id"], "dev-a")
        self.assertEqual(data["batched_count"], 2)
        self.assertEqual(data["relative_path"], "b.jpg")
        self.assertEqual(data["device_total_files"], 2)
        self.assertEqual(data["device_total_size"], 30)

    def test_flush_is_idempotent_when_empty(self) -> None:
        with mock.patch.object(ws_mod.WebSocketService, "broadcast_event") as broadcast:
            ws_mod.ws_service.flush_coalesced_uploads()
            broadcast.assert_not_called()


if __name__ == "__main__":
    unittest.main()
