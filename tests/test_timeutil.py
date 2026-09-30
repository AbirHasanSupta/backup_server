"""tests/test_timeutil.py — APP_TZ / client calendar helpers for On-This-Day."""

from __future__ import annotations

import os
import unittest
from datetime import date, datetime, timezone
from unittest import mock

from core import timeutil
from core.timeutil import (
    datetime_from_timestamp,
    naive_local_to_epoch,
    resolve_local_today,
    seconds_until_next_local_midnight,
)
from memories import _parse_date_str


class ResolveLocalTodayTests(unittest.TestCase):
    def tearDown(self) -> None:
        timeutil._zoneinfo.cache_clear()

    def test_prefers_explicit_local_date(self) -> None:
        self.assertEqual(
            resolve_local_today("2024-03-15", tz_offset_minutes=0),
            date(2024, 3, 15),
        )

    def test_invalid_local_date_falls_through(self) -> None:
        with mock.patch.dict(os.environ, {"APP_TZ": "", "TZ": ""}, clear=False):
            timeutil._zoneinfo.cache_clear()
            result = resolve_local_today("not-a-date", None)
            self.assertIsInstance(result, date)

    def test_default_tz_is_asia_dhaka_when_env_empty(self) -> None:
        with mock.patch.dict(os.environ, {"APP_TZ": "", "TZ": ""}, clear=False):
            timeutil._zoneinfo.cache_clear()
            self.assertEqual(timeutil.configured_tz_name(), "Asia/Dhaka")
            self.assertEqual(str(timeutil.configured_zone()), "Asia/Dhaka")

    def test_tz_offset_minutes_js_convention(self) -> None:
        fixed = datetime(2024, 6, 1, 20, 0, 0, tzinfo=timezone.utc)

        class _FixedDateTime(datetime):
            @classmethod
            def now(cls, tz=None):  # type: ignore[override]
                if tz is not None:
                    return fixed.astimezone(tz)
                return fixed.replace(tzinfo=None)

        with mock.patch("core.timeutil.datetime", _FixedDateTime):
            self.assertEqual(resolve_local_today(None, -360), date(2024, 6, 2))

    def test_app_tz_fallback(self) -> None:
        fixed = datetime(2024, 6, 1, 20, 0, 0, tzinfo=timezone.utc)

        class _FixedDateTime(datetime):
            @classmethod
            def now(cls, tz=None):  # type: ignore[override]
                if tz is not None:
                    return fixed.astimezone(tz)
                return fixed.replace(tzinfo=None)

        with mock.patch.dict(os.environ, {"APP_TZ": "Asia/Dhaka", "TZ": "UTC"}, clear=False):
            timeutil._zoneinfo.cache_clear()
            with mock.patch("core.timeutil.datetime", _FixedDateTime):
                self.assertEqual(resolve_local_today(), date(2024, 6, 2))


class TimestampHelpersTests(unittest.TestCase):
    def tearDown(self) -> None:
        timeutil._zoneinfo.cache_clear()

    def test_naive_local_to_epoch_uses_app_tz(self) -> None:
        with mock.patch.dict(os.environ, {"APP_TZ": "Asia/Dhaka"}, clear=False):
            timeutil._zoneinfo.cache_clear()
            dt = datetime(2024, 1, 1, 0, 30, 0)
            epoch = naive_local_to_epoch(dt)
            back = datetime_from_timestamp(epoch)
            self.assertEqual(back.hour, 0)
            self.assertEqual(back.minute, 30)

    def test_seconds_until_midnight_positive(self) -> None:
        self.assertGreater(seconds_until_next_local_midnight(), 0)


class ParseDateStrTests(unittest.TestCase):
    def tearDown(self) -> None:
        timeutil._zoneinfo.cache_clear()

    def test_zulu_iso_is_utc_not_app_tz_wallclock(self) -> None:
        with mock.patch.dict(os.environ, {"APP_TZ": "Asia/Dhaka"}, clear=False):
            timeutil._zoneinfo.cache_clear()
            # 18:00Z on June 1 == 00:00+06 on June 2 in Dhaka
            epoch = _parse_date_str("2024-06-01T18:00:00.000000Z")
            self.assertIsNotNone(epoch)
            local = datetime_from_timestamp(epoch)
            self.assertEqual(local.date(), date(2024, 6, 2))
            self.assertEqual(local.hour, 0)

    def test_naive_exif_keeps_wallclock_day_under_app_tz(self) -> None:
        with mock.patch.dict(os.environ, {"APP_TZ": "Asia/Dhaka"}, clear=False):
            timeutil._zoneinfo.cache_clear()
            epoch = _parse_date_str("2024:06:02 01:00:00")
            self.assertIsNotNone(epoch)
            local = datetime_from_timestamp(epoch)
            self.assertEqual(local.date(), date(2024, 6, 2))
            self.assertEqual(local.hour, 1)


if __name__ == "__main__":
    unittest.main()
