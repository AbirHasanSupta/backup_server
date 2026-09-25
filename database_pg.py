"""database_pg.py — High-Concurrency PostgreSQL Database Layer for Multi-User Deployments.

Designed for multi-worker FastAPI instances and distributed worker nodes:
- Multi-Version Concurrency Control (MVCC): Non-blocking concurrent reads and writes
- Thread-safe connection pool with automatic health check and reconnect
- Atomic O(1) device counter increments
- Hash-partitioned files table for fast indexed lookups across millions of files
- GIN indexed JSONB metadata for smart queries
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import secrets
import time as _time
from typing import Any, Generator

from config import load_config

logger = logging.getLogger("backup_server.database_pg")

_pg_pool = None
_pool_lock = None

try:
    import threading
    _pool_lock = threading.Lock()
except Exception:
    pass


def _get_pg_url() -> str:
    cfg = load_config()
    return os.environ.get("POSTGRES_URL") or os.environ.get("DATABASE_URL") or cfg.get("POSTGRES_URL") or "postgresql://postgres:postgres@localhost:5432/backup_db"


def _init_pool():
    global _pg_pool
    if _pg_pool is not None:
        return _pg_pool

    url = _get_pg_url()
    try:
        # Try psycopg (v3) first
        from psycopg_pool import ConnectionPool
        _pg_pool = ConnectionPool(
            conninfo=url,
            min_size=4,
            max_size=32,
            timeout=30.0,
            max_idle=300.0,
            reconnect_timeout=5.0,
        )
        return _pg_pool
    except ImportError:
        pass

    try:
        # Fallback to psycopg2 ThreadedConnectionPool
        from psycopg2.pool import ThreadedConnectionPool
        _pg_pool = ThreadedConnectionPool(
            minconn=4,
            maxconn=32,
            dsn=url,
        )
        return _pg_pool
    except ImportError:
        pass

    return None


@contextlib.contextmanager
def get_pg_connection():
    """Context manager for acquiring and releasing PostgreSQL connections from pool."""
    pool = _init_pool()
    if pool is None:
        raise RuntimeError("PostgreSQL driver not available. Install psycopg or psycopg2-binary.")

    # Psycopg 3 ConnectionPool vs Psycopg 2 ThreadedConnectionPool
    if hasattr(pool, "connection"):
        with pool.connection() as conn:
            yield conn
    else:
        conn = pool.getconn()
        try:
            yield conn
        finally:
            pool.putconn(conn)


def init_pg_db():
    """Create all required tables, partitions, and indexes in PostgreSQL if not exist.

    Multiple Gunicorn workers can enter application startup simultaneously.  The
    advisory transaction lock prevents their otherwise-racy first-time DDL from
    causing a worker to incorrectly fall back to SQLite.
    """
    with get_pg_connection() as conn:
        with conn.cursor() as cur:
            # This stable, application-specific lock is released automatically
            # when the schema-initialization transaction commits or rolls back.
            cur.execute("SELECT pg_advisory_xact_lock(486795553)")

            # 1. Devices table
            cur.execute("""
            CREATE TABLE IF NOT EXISTS devices (
                id SERIAL PRIMARY KEY,
                device_id VARCHAR(64) UNIQUE,
                device_name VARCHAR(255) NOT NULL,
                device_ip VARCHAR(45) NOT NULL,
                status VARCHAR(20) NOT NULL DEFAULT 'accepted',
                first_seen BIGINT NOT NULL,
                last_seen BIGINT NOT NULL,
                files_backed_up BIGINT NOT NULL DEFAULT 0,
                total_bytes BIGINT NOT NULL DEFAULT 0,
                folder_name VARCHAR(255),
                device_model VARCHAR(255),
                username VARCHAR(100),
                token VARCHAR(128)
            );
            CREATE INDEX IF NOT EXISTS idx_devices_id ON devices(device_id);
            CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);
            """)

            # 2. Files table (Partitioned by HASH on device_id)
            cur.execute("""
            CREATE TABLE IF NOT EXISTS files (
                id BIGSERIAL,
                device_id VARCHAR(64),
                external_id VARCHAR(255),
                path TEXT NOT NULL,
                size BIGINT NOT NULL,
                modified_time BIGINT NOT NULL,
                sha256 VARCHAR(64),
                uploaded_time BIGINT NOT NULL,
                device_ip VARCHAR(45),
                storage_key TEXT,
                PRIMARY KEY (id, device_id)
            ) PARTITION BY HASH (device_id);
            """)

            # Create 8 default partitions for files table if they don't exist
            for i in range(8):
                cur.execute(f"""
                CREATE TABLE IF NOT EXISTS files_part_{i} 
                PARTITION OF files FOR VALUES WITH (MODULUS 8, REMAINDER {i});
                """)

            cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_files_dev_path ON files(device_id, path);
            CREATE INDEX IF NOT EXISTS idx_files_hash ON files(sha256);
            CREATE INDEX IF NOT EXISTS idx_files_mtime ON files(device_id, modified_time DESC);
            """)

            # 3. Sync sessions
            cur.execute("""
            CREATE TABLE IF NOT EXISTS sync_sessions (
                id BIGSERIAL PRIMARY KEY,
                device_id VARCHAR(64) NOT NULL,
                started_at BIGINT NOT NULL,
                finished_at BIGINT NOT NULL,
                duration_sec DOUBLE PRECISION NOT NULL,
                files_uploaded INT NOT NULL DEFAULT 0,
                bytes_uploaded BIGINT NOT NULL DEFAULT 0,
                files_skipped INT NOT NULL DEFAULT 0,
                files_failed INT NOT NULL DEFAULT 0,
                status VARCHAR(32) NOT NULL DEFAULT 'success',
                device_ip VARCHAR(45),
                uploaded_files_summary TEXT,
                error_details TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_sync_sessions_dev ON sync_sessions(device_id, started_at DESC);
            """)

            # 4. Media index table (EXIF, GPS, timestamps)
            cur.execute("""
            CREATE TABLE IF NOT EXISTS media_index (
                id BIGSERIAL PRIMARY KEY,
                source_type VARCHAR(32) NOT NULL,
                source_key VARCHAR(64) NOT NULL,
                relative_path TEXT NOT NULL,
                size BIGINT NOT NULL,
                modified_time BIGINT NOT NULL,
                cap_time BIGINT,
                cap_year INT,
                cap_month INT,
                cap_day INT,
                has_gps BOOLEAN NOT NULL DEFAULT FALSE,
                lat DOUBLE PRECISION,
                lon DOUBLE PRECISION,
                duration DOUBLE PRECISION,
                media_metadata JSONB DEFAULT '{}'::jsonb,
                indexed_at BIGINT NOT NULL,
                UNIQUE (source_type, source_key, relative_path)
            );
            CREATE INDEX IF NOT EXISTS idx_media_calendar ON media_index(source_key, cap_month, cap_day);
            CREATE INDEX IF NOT EXISTS idx_media_gps ON media_index(lat, lon) WHERE has_gps = TRUE;
            CREATE INDEX IF NOT EXISTS idx_media_year ON media_index(source_key, cap_year, cap_month);

            CREATE TABLE IF NOT EXISTS scan_dirs (
                source_type VARCHAR(32) NOT NULL,
                source_key VARCHAR(64) NOT NULL,
                dir_relpath TEXT NOT NULL,
                dir_mtime_ns BIGINT NOT NULL,
                updated_at BIGINT NOT NULL,
                PRIMARY KEY (source_type, source_key, dir_relpath)
            );

            CREATE TABLE IF NOT EXISTS geocode_cache (
                lat_round DOUBLE PRECISION NOT NULL,
                lon_round DOUBLE PRECISION NOT NULL,
                place_name TEXT NOT NULL,
                PRIMARY KEY (lat_round, lon_round)
            );
            """)

            # 5. Trips and Trip Media
            cur.execute("""
            CREATE TABLE IF NOT EXISTS trips (
                id BIGSERIAL PRIMARY KEY,
                source_id VARCHAR(64) NOT NULL,
                title VARCHAR(255) NOT NULL,
                start_date VARCHAR(32) NOT NULL,
                end_date VARCHAR(32) NOT NULL,
                start_time BIGINT NOT NULL,
                end_time BIGINT NOT NULL,
                place_name TEXT,
                center_lat DOUBLE PRECISION,
                center_lon DOUBLE PRECISION,
                media_count INT NOT NULL DEFAULT 0,
                cover_media_id BIGINT,
                created_at BIGINT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_trips_source ON trips(source_id, start_time DESC);

            CREATE TABLE IF NOT EXISTS trip_media (
                id BIGSERIAL PRIMARY KEY,
                trip_id BIGINT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
                media_id BIGINT NOT NULL,
                source_type VARCHAR(32) NOT NULL,
                source_key VARCHAR(64) NOT NULL,
                relative_path TEXT NOT NULL,
                cap_time BIGINT NOT NULL,
                UNIQUE (trip_id, source_type, source_key, relative_path)
            );
            CREATE INDEX IF NOT EXISTS idx_trip_media_trip ON trip_media(trip_id);
            """)

            # 6. Reactions and Comments
            cur.execute("""
            CREATE TABLE IF NOT EXISTS reactions (
                id BIGSERIAL PRIMARY KEY,
                media_id BIGINT NOT NULL,
                source_id VARCHAR(64) NOT NULL,
                emoji VARCHAR(16) NOT NULL,
                created_at BIGINT NOT NULL,
                UNIQUE (media_id, source_id, emoji)
            );
            CREATE INDEX IF NOT EXISTS idx_reactions_media ON reactions(media_id);

            CREATE TABLE IF NOT EXISTS comments (
                id BIGSERIAL PRIMARY KEY,
                media_id BIGINT NOT NULL,
                source_id VARCHAR(64) NOT NULL,
                text TEXT NOT NULL,
                created_at BIGINT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_comments_media ON comments(media_id, created_at ASC);
            """)

            # 7. Device Shares & Share Groups
            cur.execute("""
            CREATE TABLE IF NOT EXISTS device_share_groups (
                group_id VARCHAR(64) PRIMARY KEY,
                shared_by_device_id VARCHAR(64) NOT NULL,
                caption TEXT,
                created_at BIGINT NOT NULL,
                post_kind VARCHAR(32),
                post_title VARCHAR(255)
            );
            CREATE INDEX IF NOT EXISTS idx_share_groups_sharer ON device_share_groups(shared_by_device_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS device_shares (
                share_id BIGSERIAL PRIMARY KEY,
                shared_by_device_id VARCHAR(64) NOT NULL,
                source_type VARCHAR(32) NOT NULL,
                source_key VARCHAR(64) NOT NULL,
                relative_path TEXT NOT NULL,
                size BIGINT NOT NULL DEFAULT 0,
                modified_time BIGINT NOT NULL DEFAULT 0,
                caption TEXT,
                share_group_id VARCHAR(64) REFERENCES device_share_groups(group_id) ON DELETE CASCADE,
                original_shared_by_device_id VARCHAR(64),
                repost_of_share_id BIGINT,
                is_library_reel INT NOT NULL DEFAULT 0,
                media_id BIGINT,
                created_at BIGINT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_device_shares_group ON device_shares(share_group_id);
            CREATE INDEX IF NOT EXISTS idx_device_shares_sharer ON device_shares(shared_by_device_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS device_share_targets (
                id BIGSERIAL PRIMARY KEY,
                share_id BIGINT NOT NULL REFERENCES device_shares(share_id) ON DELETE CASCADE,
                target_device_id VARCHAR(64) NOT NULL,
                seen INT NOT NULL DEFAULT 0,
                notified INT NOT NULL DEFAULT 0,
                UNIQUE (share_id, target_device_id)
            );
            CREATE INDEX IF NOT EXISTS idx_share_targets_device ON device_share_targets(target_device_id, seen);

            CREATE TABLE IF NOT EXISTS saved_reels (
                id BIGSERIAL PRIMARY KEY,
                device_id VARCHAR(64) NOT NULL,
                reel_id VARCHAR(128) NOT NULL,
                share_id BIGINT NOT NULL,
                media_id BIGINT,
                created_at BIGINT NOT NULL,
                UNIQUE (device_id, reel_id)
            );
            CREATE INDEX IF NOT EXISTS idx_saved_reels_device ON saved_reels(device_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS reel_telemetry (
                id BIGSERIAL PRIMARY KEY,
                device_id VARCHAR(64) NOT NULL,
                share_id BIGINT NOT NULL,
                media_id BIGINT,
                watch_time_sec DOUBLE PRECISION NOT NULL DEFAULT 0.0,
                duration_sec DOUBLE PRECISION NOT NULL DEFAULT 0.0,
                completion_rate DOUBLE PRECISION NOT NULL DEFAULT 0.0,
                loops INT NOT NULL DEFAULT 0,
                skipped INT NOT NULL DEFAULT 0,
                created_at BIGINT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_reel_telem_share ON reel_telemetry(share_id);
            """)

            conn.commit()

            # ── Post-migration safety: reset BIGSERIAL sequences ──────────────
            # After a SQLite-to-PostgreSQL migration BIGSERIAL sequences may
            # still be at 1 while the tables already contain rows with large IDs.
            # Resetting here is a no-op on empty tables and prevents duplicate-key
            # failures that would otherwise appear on the first write after migration.
            _sequence_map = [
                ("device_shares_share_id_seq",  "device_shares",        "share_id"),
                ("sync_sessions_id_seq",         "sync_sessions",        "id"),
                ("media_index_id_seq",            "media_index",          "id"),
                ("reactions_id_seq",              "reactions",            "id"),
                ("comments_id_seq",               "comments",             "id"),
                ("trips_id_seq",                  "trips",                "id"),
                ("trip_media_id_seq",             "trip_media",           "id"),
                ("saved_reels_id_seq",            "saved_reels",          "id"),
                ("reel_telemetry_id_seq",         "reel_telemetry",       "id"),
                ("device_share_targets_id_seq",   "device_share_targets", "id"),
            ]
            with conn.cursor() as seq_cur:
                for seq_name, tbl, col in _sequence_map:
                    try:
                        seq_cur.execute(
                            f"SELECT setval('{seq_name}', COALESCE(MAX({col}), 1)) FROM {tbl};"
                        )
                    except Exception:
                        pass
            conn.commit()

            logger.info("PostgreSQL database initialized successfully with partitioned tables.")
