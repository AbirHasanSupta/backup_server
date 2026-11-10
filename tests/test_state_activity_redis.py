"""tests/test_state_activity_redis.py — Cross-process activity mirror for sync/app split."""

from __future__ import annotations

import json
import unittest
from unittest import mock

import state


class _FakeRedis:
    def __init__(self):
        self.hash: dict[str, str] = {}
        self.list: list[str] = []

    def pipeline(self):
        return self

    def rpush(self, key, value):
        assert key == state._REDIS_LOGS_LIST
        self.list.append(value)
        return self

    def ltrim(self, key, start, end):
        assert key == state._REDIS_LOGS_LIST
        # emulate Redis LTRIM with negative indexes
        if start < 0:
            start = max(0, len(self.list) + start)
        if end < 0:
            end = len(self.list) + end
        self.list = self.list[start : end + 1]
        return self

    def execute(self):
        return []

    def lrange(self, key, start, end):
        assert key == state._REDIS_LOGS_LIST
        if end == -1:
            end = len(self.list) - 1
        return list(self.list[start : end + 1])

    def delete(self, key):
        if key == state._REDIS_LOGS_LIST:
            self.list.clear()
        if key == state._REDIS_ACTIVITY_HASH:
            self.hash.clear()

    def hset(self, key, field, value):
        assert key == state._REDIS_ACTIVITY_HASH
        self.hash[field] = value

    def hdel(self, key, *fields):
        assert key == state._REDIS_ACTIVITY_HASH
        for field in fields:
            self.hash.pop(field, None)

    def hgetall(self, key):
        assert key == state._REDIS_ACTIVITY_HASH
        return dict(self.hash)


class StateActivityRedisTests(unittest.TestCase):
    def setUp(self):
        state.clear_logs()
        with state._activity_lock:
            state._active_activities.clear()

    def tearDown(self):
        state.clear_logs()
        with state._activity_lock:
            state._active_activities.clear()

    def test_activity_and_logs_round_trip_via_redis(self):
        fake = _FakeRedis()
        with mock.patch.object(state, "_redis", return_value=fake):
            state.set_current_activity("Uploading a.jpg", "10.0.0.2", "device-a")
            state.add_log("Uploading: a.jpg (device-a)")

            # Simulate app-api process with empty local buffers reading Redis.
            with state._activity_lock:
                state._active_activities.clear()
            with state._logs_lock:
                state._logs.clear()

            activity = state.get_current_activity()
            self.assertIsNotNone(activity)
            self.assertEqual(activity["message"], "Uploading a.jpg")
            self.assertEqual(activity["device_id"], "device-a")

            logs = state.get_logs()
            self.assertEqual(len(logs), 1)
            self.assertIn("Uploading: a.jpg", logs[0]["message"])

            state.set_current_activity(None, "10.0.0.2", "device-a")
            self.assertIsNone(state.get_current_activity())
            self.assertNotIn("device-a", fake.hash)

    def test_local_fallback_without_redis(self):
        with mock.patch.object(state, "_redis", return_value=None):
            state.set_current_activity("Local only", None, "dev-1")
            state.add_log("hello")
            self.assertEqual(state.get_current_activity()["device_id"], "dev-1")
            self.assertEqual(state.get_logs()[-1]["message"], "hello")


if __name__ == "__main__":
    unittest.main()
