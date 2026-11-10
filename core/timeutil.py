"""Timezone-aware calendar helpers for On-This-Day and display formatting.

Prefer an explicit client calendar day, then APP_TZ/TZ, then Asia/Dhaka
(project default), then UTC only if zoneinfo data is unavailable.
"""

from __future__ import annotations

import os
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

# Household default when APP_TZ/TZ are unset (Docker image / desktop without .env).
DEFAULT_APP_TZ = "Asia/Dhaka"


@lru_cache(maxsize=4)
def _zoneinfo(name: str) -> ZoneInfo | None:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError, TypeError):
        return None


def configured_tz_name() -> str:
    name = (os.environ.get("APP_TZ") or os.environ.get("TZ") or "").strip()
    return name or DEFAULT_APP_TZ


def configured_zone() -> ZoneInfo:
    zone = _zoneinfo(configured_tz_name())
    if zone is not None:
        return zone
    # Fall back to the project default if APP_TZ/TZ is an unknown zone name.
    fallback = _zoneinfo(DEFAULT_APP_TZ)
    if fallback is not None:
        return fallback
    return ZoneInfo("UTC")


def resolve_local_today(
    local_date: str | None = None,
    tz_offset_minutes: int | None = None,
) -> date:
    """Resolve the caller's calendar 'today'.

    Priority:
      1. ``local_date`` ISO ``YYYY-MM-DD`` from the client
      2. ``tz_offset_minutes`` (JS ``Date.getTimezoneOffset()``: minutes *behind* UTC)
      3. ``APP_TZ`` / ``TZ`` / Asia/Dhaka default
    """
    if local_date:
        try:
            return date.fromisoformat(str(local_date).strip()[:10])
        except ValueError:
            pass

    if tz_offset_minutes is not None:
        try:
            offset = int(tz_offset_minutes)
            utc_now = datetime.now(timezone.utc)
            # JS getTimezoneOffset: UTC = local + offset → local = UTC - offset
            local_now = utc_now - timedelta(minutes=offset)
            return local_now.date()
        except (TypeError, ValueError, OverflowError):
            pass

    return datetime.now(configured_zone()).date()


def datetime_from_timestamp(ts: int | float) -> datetime:
    """Convert a Unix epoch to a timezone-aware datetime in APP_TZ/Dhaka."""
    return datetime.fromtimestamp(float(ts), tz=configured_zone())


def naive_local_to_epoch(dt: datetime) -> int:
    """Treat a naive datetime as wall-clock time in APP_TZ/Dhaka.

    EXIF/DateTimeOriginal strings have no zone; interpreting them in the
    configured app calendar keeps capture-day buckets aligned with On-This-Day.
    """
    if dt.tzinfo is not None:
        return int(dt.timestamp())
    return int(dt.replace(tzinfo=configured_zone()).timestamp())


def local_now() -> datetime:
    """Current wall-clock time in APP_TZ/Dhaka."""
    return datetime.now(configured_zone())


def seconds_until_next_local_midnight() -> float:
    """Seconds until the next local (APP_TZ/Dhaka) midnight, plus a small buffer."""
    now = local_now()
    tomorrow = datetime.combine(
        now.date() + timedelta(days=1),
        datetime.min.time(),
        tzinfo=now.tzinfo,
    )
    return max(10.0, (tomorrow - now).total_seconds() + 2.0)


def format_local_ampm(ts: int | float | None, *, with_seconds: bool = False) -> str:
    """Format a Unix timestamp in local/APP_TZ time with 12-hour AM/PM clock."""
    if ts is None:
        return ""
    try:
        dt = datetime_from_timestamp(ts)
        pattern = "%Y-%m-%d  %I:%M:%S %p" if with_seconds else "%Y-%m-%d  %I:%M %p"
        return dt.strftime(pattern)
    except (OSError, OverflowError, ValueError, TypeError):
        return ""


def format_time_ampm(ts: int | float | None, *, with_seconds: bool = False) -> str:
    """Format only the time portion with AM/PM."""
    if ts is None:
        return ""
    try:
        dt = datetime_from_timestamp(ts)
        pattern = "%I:%M:%S %p" if with_seconds else "%I:%M %p"
        return dt.strftime(pattern)
    except (OSError, OverflowError, ValueError, TypeError):
        return ""
