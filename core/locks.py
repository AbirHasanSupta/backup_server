"""core/locks.py — Distributed & Local Re-entrant Lock Manager."""

from __future__ import annotations

import contextlib
import time
import uuid
import logging
import threading
from core.config import load_config

logger = logging.getLogger("backup_server.locks")

_local_locks: dict[str, threading.Lock] = {}
_local_locks_guard = threading.Lock()

_RELEASE_LUA = """
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
"""


def _get_redis():
    try:
        from services.redis_service import get_redis_client
        return get_redis_client()
    except Exception:
        return None


@contextlib.contextmanager
def acquire_lock(lock_key: str, expire_sec: int = 60, timeout_sec: int = 10):
    """Acquire a distributed lock via Redis when available, or local thread lock fallback."""
    client = _get_redis()
    if client:
        full_key = f"lock:{lock_key}"
        token = str(uuid.uuid4())
        deadline = time.monotonic() + timeout_sec
        acquired = False

        while time.monotonic() < deadline:
            if client.set(full_key, token, nx=True, ex=expire_sec):
                acquired = True
                break
            time.sleep(0.04)

        if not acquired:
            raise TimeoutError(f"Could not acquire distributed lock for '{lock_key}' within {timeout_sec}s")

        try:
            yield
        finally:
            try:
                client.eval(_RELEASE_LUA, 1, full_key, token)
            except Exception as exc:
                logger.warning("Error releasing lock '%s': %s", lock_key, exc)
    else:
        with _local_locks_guard:
            if lock_key not in _local_locks:
                _local_locks[lock_key] = threading.Lock()
            lock = _local_locks[lock_key]

        acquired = lock.acquire(timeout=timeout_sec)
        if not acquired:
            raise TimeoutError(f"Could not acquire local lock for '{lock_key}' within {timeout_sec}s")
        try:
            yield
        finally:
            lock.release()
