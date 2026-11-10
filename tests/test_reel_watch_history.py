"""Unit tests for reel watch history feature."""

import unittest
from api.v1.reels import is_qualified_reel_watch
from repositories import reels_repo
import database


class TestReelWatchHistory(unittest.TestCase):
    def setUp(self):
        database.init_db()

    def test_qualification_rules(self):
        # 1. Videos > 20s: need 10s play
        self.assertTrue(is_qualified_reel_watch(10.0, 25.0))
        self.assertTrue(is_qualified_reel_watch(15.0, 30.0))
        self.assertFalse(is_qualified_reel_watch(9.9, 25.0))
        self.assertFalse(is_qualified_reel_watch(5.0, 21.0))

        # 2. Videos < 5s: any play (watch_sec > 0)
        self.assertTrue(is_qualified_reel_watch(0.1, 4.5))
        self.assertTrue(is_qualified_reel_watch(1.0, 3.0))
        self.assertFalse(is_qualified_reel_watch(0.0, 4.0))

        # 3. Otherwise (5s <= dur <= 20s): need 5s play
        self.assertTrue(is_qualified_reel_watch(5.0, 10.0))
        self.assertTrue(is_qualified_reel_watch(5.0, 20.0))
        self.assertTrue(is_qualified_reel_watch(5.0, 5.0))
        self.assertFalse(is_qualified_reel_watch(4.9, 10.0))
        self.assertFalse(is_qualified_reel_watch(4.9, 5.0))
        self.assertFalse(is_qualified_reel_watch(4.9, 20.0))

    def test_record_deduplication_and_delete(self):
        device_id = "test-device-history"
        reel_id = "test-reel-1"
        share_id = 999991

        # Clean any old test records
        reels_repo.delete_watch_history_item(device_id, reel_id, share_id)

        # 1. Record first time
        ok = reels_repo.record_watch_history(
            device_id=device_id,
            reel_id=reel_id,
            share_id=share_id,
            media_id=None,
            watch_time_sec=12.5,
            duration_sec=30.0,
        )
        self.assertTrue(ok)

        # Query raw table to verify 1 entry
        conn = database.get_read_conn()
        rows = conn.execute(
            "SELECT * FROM reel_watch_history WHERE device_id = ? AND reel_id = ?",
            (device_id, reel_id),
        ).fetchall()
        conn.close()
        self.assertEqual(len(rows), 1)
        self.assertAlmostEqual(rows[0]["watch_time_sec"], 12.5)

        # 2. Record second time with different watch time (deduplication check)
        ok2 = reels_repo.record_watch_history(
            device_id=device_id,
            reel_id=reel_id,
            share_id=share_id,
            media_id=None,
            watch_time_sec=25.0,
            duration_sec=30.0,
        )
        self.assertTrue(ok2)

        conn = database.get_read_conn()
        rows2 = conn.execute(
            "SELECT * FROM reel_watch_history WHERE device_id = ? AND reel_id = ?",
            (device_id, reel_id),
        ).fetchall()
        conn.close()
        # Must still be exactly 1 entry, updated
        self.assertEqual(len(rows2), 1)
        self.assertAlmostEqual(rows2[0]["watch_time_sec"], 25.0)

        # 3. Delete from watch history
        deleted = reels_repo.delete_watch_history_item(device_id, reel_id)
        self.assertTrue(deleted)

        conn = database.get_read_conn()
        rows3 = conn.execute(
            "SELECT * FROM reel_watch_history WHERE device_id = ? AND reel_id = ?",
            (device_id, reel_id),
        ).fetchall()
        conn.close()
        self.assertEqual(len(rows3), 0)

    def test_openapi_history_endpoints_registered(self):
        from server import create_app
        app = create_app("all")
        schema = app.openapi()
        self.assertIn("/api/reels/history", schema["paths"])
        self.assertIn("/api/reels/history/{reel_id}", schema["paths"])

    def test_api_endpoint_payload_handling(self):
        import asyncio
        from api.v1.reels import record_watch_history, WatchHistoryRequest, WatchHistoryEvent
        import config

        device_id = "test-device-payload"
        auth_header = f"Bearer {config.API_KEY}"

        # 1. Single reel_id numeric string with omitted share_id
        req1 = WatchHistoryRequest(
            device_id=device_id,
            reel_id="999992",
            watch_time_sec=11.0,
            duration_sec=25.0,
        )
        res1 = asyncio.run(record_watch_history(req1, authorization=auth_header))
        self.assertTrue(res1["ok"])
        self.assertEqual(res1["recorded"], 1)

        # 2. Batch events with mixed qualifications
        req2 = WatchHistoryRequest(
            device_id=device_id,
            events=[
                # Qualified (> 20s, 15s play)
                WatchHistoryEvent(reel_id="999993", share_id=999993, watch_time_sec=15.0, duration_sec=30.0),
                # Disqualified (> 20s, only 4s play)
                WatchHistoryEvent(reel_id="999994", share_id=999994, watch_time_sec=4.0, duration_sec=30.0),
                # Qualified (< 5s, 0.5s play)
                WatchHistoryEvent(reel_id="999995", share_id=999995, watch_time_sec=0.5, duration_sec=3.0),
            ]
        )
        res2 = asyncio.run(record_watch_history(req2, authorization=auth_header))
        self.assertTrue(res2["ok"])
        self.assertEqual(res2["recorded"], 2)  # 2 of 3 qualified

        # Cleanup
        for sid in [999992, 999993, 999994, 999995]:
            reels_repo.delete_watch_history_item(device_id, str(sid), sid)


if __name__ == "__main__":
    unittest.main()
