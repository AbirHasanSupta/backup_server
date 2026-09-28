"""Redis response cache for Places & Trips (Docker). No-ops without Redis (desktop)."""

from __future__ import annotations

import os
from typing import Any

from config import load_config
from services.redis_service import cache_delete, cache_delete_prefix, cache_get, cache_set

# Places/trips change infrequently; refresh is explicit from the client.
_TTL_SECONDS = 7 * 24 * 3600


def _cache_enabled() -> bool:
    """Only use Redis response cache in Docker/postgres deployments (or when REDIS_URL is set).

    Desktop defaults REDIS_URL in config even with no Redis process; gating avoids
    pointless connection probes on every places/trips request.
    """
    if os.environ.get("REDIS_URL"):
        return True
    try:
        return load_config().get("DATABASE_BACKEND") == "postgres"
    except Exception:
        return False


def places_clusters_key(device_id: str) -> str:
    return f"places:clusters:{device_id}"


def places_items_key(device_id: str, cluster_key: str) -> str:
    return f"places:items:{device_id}:{cluster_key}"


def trips_list_key(source_id: str) -> str:
    return f"trips:list:{source_id}"


def trip_media_key(trip_id: int) -> str:
    return f"trips:media:{trip_id}"


def get_cached(key: str) -> Any | None:
    if not _cache_enabled():
        return None
    return cache_get(key)


def set_cached(key: str, value: Any) -> bool:
    if not _cache_enabled():
        return False
    return cache_set(key, value, ex_seconds=_TTL_SECONDS)


def invalidate_places(device_id: str | None = None) -> None:
    if not _cache_enabled():
        return
    if device_id:
        cache_delete(places_clusters_key(device_id))
        cache_delete_prefix(f"places:items:{device_id}:")
    else:
        cache_delete_prefix("places:clusters:")
        cache_delete_prefix("places:items:")


def invalidate_trips(source_id: str | None = None) -> None:
    if not _cache_enabled():
        return
    if source_id:
        cache_delete(trips_list_key(source_id))
        # Trip media keys are by trip id; wipe all media entries for simplicity.
        cache_delete_prefix("trips:media:")
    else:
        cache_delete_prefix("trips:list:")
        cache_delete_prefix("trips:media:")


def invalidate_all_for_device(device_id: str) -> None:
    invalidate_places(device_id)
    invalidate_trips(device_id)
