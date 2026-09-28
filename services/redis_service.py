"""services/redis_service.py — High-Performance Distributed Caching & Pub/Sub Hub."""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from config import load_config

logger = logging.getLogger("backup_server.redis")

_redis_client = None
_redis_checked = False


def get_redis_client():
    """Return a thread-safe Redis client instance with connection pooling.

    Fails fast when Redis is unreachable so desktop (no Redis) does not stall
    on every cache lookup. After a failed probe, returns None for the process
    lifetime until the module is reloaded.
    """
    global _redis_client, _redis_checked
    if _redis_client is not None:
        return _redis_client
    if _redis_checked:
        return None

    _redis_checked = True
    try:
        import redis
        cfg = load_config()
        redis_url = os.environ.get("REDIS_URL") or cfg.get("REDIS_URL") or "redis://localhost:6379/0"
        # Short timeouts: desktop often has no Redis; never block request handlers.
        pool = redis.ConnectionPool.from_url(
            redis_url,
            max_connections=64,
            decode_responses=True,
            socket_connect_timeout=0.5,
            socket_timeout=0.5,
        )
        client = redis.Redis(connection_pool=pool)
        client.ping()
        _redis_client = client
        return _redis_client
    except Exception as exc:
        logger.info("Redis client unavailable: %s", exc)
        _redis_client = None
        return None



def publish_event(channel: str, message: dict | str) -> bool:
    """Broadcast an event payload across all server instances and connected WebSockets."""
    client = get_redis_client()
    if not client:
        return False
    try:
        payload = json.dumps(message) if isinstance(message, dict) else str(message)
        client.publish(channel, payload)
        return True
    except Exception as exc:
        logger.error("Failed to publish event to channel %s: %s", channel, exc)
        return False


def cache_set(key: str, value: Any, ex_seconds: int = 3600) -> bool:
    """Store JSON-serialized value in Redis cache."""
    client = get_redis_client()
    if not client:
        return False
    try:
        client.set(key, json.dumps(value), ex=ex_seconds)
        return True
    except Exception:
        return False


def cache_get(key: str) -> Any | None:
    """Retrieve JSON-deserialized value from Redis cache."""
    client = get_redis_client()
    if not client:
        return None
    try:
        val = client.get(key)
        if val is not None:
            return json.loads(val)
        return None
    except Exception:
        return None


def cache_delete(key: str) -> bool:
    client = get_redis_client()
    if not client:
        return False
    try:
        client.delete(key)
        return True
    except Exception:
        return False


def cache_delete_prefix(prefix: str) -> int:
    """Delete all keys matching prefix* (SCAN). No-op when Redis is unavailable."""
    client = get_redis_client()
    if not client:
        return 0
    deleted = 0
    try:
        cursor = 0
        pattern = f"{prefix}*"
        while True:
            cursor, keys = client.scan(cursor=cursor, match=pattern, count=200)
            if keys:
                deleted += int(client.delete(*keys))
            if cursor == 0:
                break
        return deleted
    except Exception:
        return deleted
