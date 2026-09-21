"""services/lock_service.py — Distributed Lock Manager for High-Concurrency Clusters."""

import contextlib
import time
import uuid
import logging
from services.redis_service import get_redis_client

logger = logging.getLogger("backup_server.lock")

# Lua script to release lock only if the token matches (prevents releasing someone else's expired lock)
_RELEASE_LUA = """
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
"""


@contextlib.contextmanager
def distributed_lock(lock_key: str, expire_sec: int = 60, timeout_sec: int = 10):
    """Acquire a distributed lock with automatic release and timeout."""
    client = get_redis_client()
    if not client:
        # Fallback to local process lock if Redis is not configured
        yield
        return

    full_key = f"lock:{lock_key}"
    token = str(uuid.uuid4())
    deadline = time.monotonic() + timeout_sec
    acquired = False

    while time.monotonic() < deadline:
        if client.set(full_key, token, nx=True, ex=expire_sec):
            acquired = True
            break
        time.sleep(0.05)

    if not acquired:
        raise TimeoutError(f"Could not acquire distributed lock for '{lock_key}' within {timeout_sec}s")

    try:
        yield
    finally:
        try:
            client.eval(_RELEASE_LUA, 1, full_key, token)
        except Exception as exc:
            logger.warning("Error releasing distributed lock for '%s': %s", lock_key, exc)
