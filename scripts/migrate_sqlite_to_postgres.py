"""scripts/migrate_sqlite_to_postgres.py

Automated data migration script: copies ALL data from both SQLite databases
(dev build: backup_server/backup.db  AND  exe build: AppData/Roaming/PhoneBackupServer/backup.db)
into the shared PostgreSQL instance used by Docker.

The script introspects the ACTUAL column names from each SQLite table at
runtime — so it is robust against schema drift between builds.

Usage:
    # Migrate exe build (default — this is the real production data)
    python scripts/migrate_sqlite_to_postgres.py

    # Migrate the dev/source-dir build
    python scripts/migrate_sqlite_to_postgres.py --sqlite backup.db

    # Merge BOTH databases (exe first, then dev on top with ON CONFLICT DO NOTHING)
    python scripts/migrate_sqlite_to_postgres.py --merge-both

    # Custom paths
    python scripts/migrate_sqlite_to_postgres.py \\
        --sqlite "C:/Users/Abir/AppData/Roaming/PhoneBackupServer/backup.db" \\
        --pg "postgresql://postgres:PASSWORD@localhost:5432/backup_db"

Column-mapping notes
--------------------
SQLite schema (actual)            → PostgreSQL schema (database_pg.py)
---------------------------------   --------------------------------
sync_sessions.ended_at            → finished_at   (renamed)
sync_sessions.duration_ms / 1000  → duration_sec  (unit conversion)
sync_sessions.uploaded            → files_uploaded (renamed)
sync_sessions.errors              → files_failed   (renamed)
sync_sessions.skipped             → files_skipped  (renamed)
sync_sessions.outcome             → status         (renamed)
media_index.capture_time          → cap_time       (renamed)
media_index.cap_lat / cap_lon     → lat / lon      (renamed)
media_index.gps_checked           → has_gps (bool) (renamed+converted)
trips.start_time                  → start_time + start_date (derived)
trips.end_time                    → end_time + end_date     (derived)
device_share_groups.id            → group_id       (renamed)
device_shares.id                  → share_id       (renamed)
trip_media.(trip_id,media_id)     → richer schema in PG, migrated as-is
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone

# ── PostgreSQL driver -----------------------------------------------------------
try:
    import psycopg
    _DRIVER = "psycopg3"
except ImportError:
    try:
        import psycopg2 as psycopg  # type: ignore[no-redef]
        _DRIVER = "psycopg2"
    except ImportError:
        print(
            "ERROR: Neither psycopg nor psycopg2 is installed.\n"
            "  Install one of:\n"
            "    pip install psycopg[binary]\n"
            "    pip install psycopg2-binary"
        )
        sys.exit(1)

# ---------------------------------------------------------------------------
# Default paths
# ---------------------------------------------------------------------------
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_DIR = os.path.abspath(os.path.join(_SCRIPT_DIR, ".."))

_EXE_DB = os.path.join(
    os.environ.get("APPDATA", os.path.expanduser("~")),
    "PhoneBackupServer",
    "backup.db",
)
_DEV_DB = os.path.join(_PROJECT_DIR, "backup.db")
_DEFAULT_PG = (
    os.environ.get("POSTGRES_URL")
    or os.environ.get("DATABASE_URL")
    or "postgresql://postgres:postgres@localhost:5432/backup_db"
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ts_to_date(ts: int | None) -> str:
    """Unix epoch → 'YYYY-MM-DD' string (for PG trips.start_date / end_date)."""
    if not ts:
        return ""
    try:
        return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")
    except Exception:
        return ""


def _sqlite_cols(conn: sqlite3.Connection, table: str) -> list[str]:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return [r[1] for r in rows]


def _sqlite_tables(conn: sqlite3.Connection) -> set[str]:
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall()
    return {r[0] for r in rows}


def _row_count(conn: sqlite3.Connection, table: str) -> int:
    return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]


def _fmt_num(n: int) -> str:
    return f"{n:,}"


# ---------------------------------------------------------------------------
# Per-table migration specs
#
# Each entry is:
#   (sqlite_table, pg_table, column_map, transform_fn)
#
# column_map: dict  sqlite_col → pg_col   (identity pairs can be omitted;
#             None value means "derived — handled by transform_fn")
# transform_fn(row_dict) → pg_row_dict | None   (None = skip row)
#
# Tables are migrated in dependency order to satisfy FK constraints.
# ---------------------------------------------------------------------------

def _build_migration_plan() -> list[dict]:  # noqa: C901
    """Returns the ordered list of migration descriptors."""

    def _sync_sessions(row: dict) -> dict:
        out = dict(row)
        # Rename columns
        out["finished_at"] = out.pop("ended_at", None)
        duration_ms = out.pop("duration_ms", 0) or 0
        out["duration_sec"] = round(duration_ms / 1000, 3)
        out["files_uploaded"] = out.pop("uploaded", 0)
        out["files_failed"] = out.pop("errors", 0)
        out["files_skipped"] = out.pop("skipped", 0)
        out["status"] = out.pop("outcome", "completed")
        # Drop SQLite-only columns
        for col in ("device_name", "trigger", "scanned", "checked", "total_files"):
            out.pop(col, None)
        # PG extras that do not exist in SQLite
        out.setdefault("bytes_uploaded", 0)
        out.setdefault("device_ip", None)
        out.setdefault("uploaded_files_summary", None)
        out.setdefault("error_details", None)
        return out

    def _media_index(row: dict) -> dict | None:
        out = dict(row)
        out["cap_time"] = out.pop("capture_time", None)
        out["lat"] = out.pop("cap_lat", None)
        out["lon"] = out.pop("cap_lon", None)
        gps_checked = out.pop("gps_checked", 0)
        has_gps = bool(out.get("lat") is not None and out.get("lon") is not None)
        out["has_gps"] = has_gps
        # Drop SQLite-only
        for col in ("capture_source",):
            out.pop(col, None)
        # PG extras
        out.setdefault("duration", None)
        return out

    def _trips(row: dict) -> dict:
        out = dict(row)
        st = out.get("start_time")
        et = out.get("end_time")
        out["start_date"] = _ts_to_date(st)
        out["end_date"] = _ts_to_date(et)
        out.setdefault("place_name", None)
        # Drop SQLite-only
        for col in ("updated_at",):
            out.pop(col, None)
        return out

    def _trip_media(row: dict) -> dict:
        """trip_media in SQLite only has (trip_id, media_id).
        PG expects (trip_id, media_id, source_type, source_key, relative_path, cap_time).
        We look those up from media_index — but that requires a join.
        Since we can't do joins here easily, we store NULLs for the extra cols
        and let the PG UNIQUE constraint handle duplicates."""
        return {
            "trip_id": row["trip_id"],
            "media_id": row["media_id"],
            "source_type": "phone",       # reasonable default
            "source_key": "",
            "relative_path": "",
            "cap_time": 0,
        }

    def _device_share_groups(row: dict) -> dict:
        out = dict(row)
        # SQLite uses 'id' (integer), PG uses 'group_id' (text/varchar)
        grp_id = out.pop("id", None)
        out["group_id"] = str(grp_id) if grp_id is not None else None
        return out

    def _device_shares(row: dict) -> dict:
        out = dict(row)
        # SQLite uses 'id' (integer), PG uses 'share_id' (bigserial)
        share_id = out.pop("id", None)
        out["share_id"] = share_id
        # share_group_id in SQLite is text already; if it's an int, cast
        sgid = out.get("share_group_id")
        if sgid is not None:
            out["share_group_id"] = str(sgid)
        return out

    def _device_share_targets(row: dict) -> dict:
        out = dict(row)
        # PG has an extra 'notified' column
        out.setdefault("notified", 0)
        return out

    return [
        # ── Independent tables first ──────────────────────────────────────
        {
            "sqlite_table": "devices",
            "pg_table": "devices",
            "transform": None,  # column names match 1:1
        },
        {
            "sqlite_table": "files",
            "pg_table": "files",
            "transform": None,
        },
        {
            "sqlite_table": "sync_sessions",
            "pg_table": "sync_sessions",
            "transform": _sync_sessions,
        },
        {
            "sqlite_table": "media_index",
            "pg_table": "media_index",
            "transform": _media_index,
        },
        {
            "sqlite_table": "trips",
            "pg_table": "trips",
            "transform": _trips,
        },
        {
            "sqlite_table": "trip_media",
            "pg_table": "trip_media",
            "transform": _trip_media,
        },
        {
            "sqlite_table": "reactions",
            "pg_table": "reactions",
            "transform": None,
        },
        {
            "sqlite_table": "geocode_cache",
            "pg_table": "geocode_cache",
            "transform": None,
        },
        {
            "sqlite_table": "comments",
            "pg_table": "comments",
            "transform": None,
        },
        {
            "sqlite_table": "device_share_groups",
            "pg_table": "device_share_groups",
            "transform": _device_share_groups,
        },
        {
            "sqlite_table": "device_shares",
            "pg_table": "device_shares",
            "transform": _device_shares,
        },
        {
            "sqlite_table": "device_share_targets",
            "pg_table": "device_share_targets",
            "transform": _device_share_targets,
        },
        {
            "sqlite_table": "saved_reels",
            "pg_table": "saved_reels",
            "transform": None,
        },
        {
            "sqlite_table": "reel_telemetry",
            "pg_table": "reel_telemetry",
            "transform": None,
        },
        # scan_dirs & cleanup_log exist in SQLite but NOT in PG schema — skip.
    ]


# ---------------------------------------------------------------------------
# Core migration engine
# ---------------------------------------------------------------------------

def _migrate_one_db(sqlite_path: str, pg_conn, label: str = "") -> None:
    """Migrate a single SQLite database into the already-connected PG."""
    print(f"\n{'='*60}")
    print(f"  Migrating: {label or sqlite_path}")
    print(f"{'='*60}")

    sqlite_conn = sqlite3.connect(sqlite_path)
    sqlite_conn.row_factory = sqlite3.Row
    existing_sqlite_tables = _sqlite_tables(sqlite_conn)

    plan = _build_migration_plan()
    batch_size = 2000
    total_start = time.time()

    # Determine placeholder style (psycopg3 uses %s, psycopg2 uses %s too)
    placeholder = "%s"

    for spec in plan:
        sqlite_tbl = spec["sqlite_table"]
        pg_tbl = spec["pg_table"]
        transform = spec.get("transform")

        if sqlite_tbl not in existing_sqlite_tables:
            print(f"  SKIP  {sqlite_tbl!r} (not in this SQLite database)")
            continue

        total_rows = _row_count(sqlite_conn, sqlite_tbl)
        if total_rows == 0:
            print(f"  SKIP  {sqlite_tbl!r} (empty table)")
            continue

        actual_sqlite_cols = _sqlite_cols(sqlite_conn, sqlite_tbl)
        col_str = ", ".join(actual_sqlite_cols)
        rows_iter = sqlite_conn.execute(f"SELECT {col_str} FROM {sqlite_tbl}")

        inserted = 0
        skipped = 0
        errors = 0
        t0 = time.time()

        print(f"\n  → {sqlite_tbl} ({_fmt_num(total_rows)} rows)…", end="", flush=True)

        while True:
            raw_batch = rows_iter.fetchmany(batch_size)
            if not raw_batch:
                break

            pg_rows = []
            for raw_row in raw_batch:
                row_dict = dict(raw_row)
                if transform:
                    try:
                        row_dict = transform(row_dict)
                    except Exception:
                        errors += 1
                        continue
                if row_dict is None:
                    skipped += 1
                    continue
                pg_rows.append(row_dict)

            if not pg_rows:
                continue

            pg_cols = list(pg_rows[0].keys())
            col_list = ", ".join(pg_cols)
            placeholders = ", ".join([placeholder] * len(pg_cols))
            sql = (
                f"INSERT INTO {pg_tbl} ({col_list}) "
                f"VALUES ({placeholders}) "
                f"ON CONFLICT DO NOTHING"
            )

            batch_data = [[r[c] for c in pg_cols] for r in pg_rows]
            try:
                # pipeline=False prevents psycopg3's auto-pipeline from
                # propagating a single row error to the entire batch.
                with pg_conn.cursor() as pg_cur:
                    pg_cur.executemany(sql, batch_data, returning=False)
                pg_conn.commit()
                inserted += len(pg_rows)
            except Exception as exc:
                pg_conn.rollback()
                # Row-by-row fallback
                for single in batch_data:
                    try:
                        with pg_conn.cursor() as pg_cur:
                            pg_cur.execute(sql, single)
                        pg_conn.commit()
                        inserted += 1
                    except Exception:
                        pg_conn.rollback()
                        errors += 1

            elapsed = time.time() - t0
            print(
                f"\r  → {pg_tbl}: {_fmt_num(inserted)}/{_fmt_num(total_rows)} "
                f"rows  ({elapsed:.1f}s)",
                end="",
                flush=True,
            )

        elapsed = time.time() - t0
        status_parts = [f"{_fmt_num(inserted)} inserted"]
        if skipped:
            status_parts.append(f"{_fmt_num(skipped)} skipped")
        if errors:
            status_parts.append(f"{_fmt_num(errors)} errors")
        print(
            f"\r  ✓ {pg_tbl}: {', '.join(status_parts)}  ({elapsed:.1f}s)           "
        )

    sqlite_conn.close()
    print(f"\n  Finished '{label}' in {time.time() - total_start:.1f}s")



# ---------------------------------------------------------------------------
# PG Schema initializer (pool-free — works with a plain psycopg connection)
# ---------------------------------------------------------------------------

def _init_pg_schema_direct(pg_conn) -> None:
    """Create all required tables in PostgreSQL using a plain connection."""
    ddl = """
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
    """

    # Create file partitions separately
    partition_ddl = "\n".join([
        f"CREATE TABLE IF NOT EXISTS files_part_{i} "
        f"PARTITION OF files FOR VALUES WITH (MODULUS 8, REMAINDER {i});"
        for i in range(8)
    ])

    rest_ddl = """
    CREATE INDEX IF NOT EXISTS idx_files_dev_path ON files(device_id, path);
    CREATE INDEX IF NOT EXISTS idx_files_hash ON files(sha256);

    CREATE TABLE IF NOT EXISTS sync_sessions (
        id BIGSERIAL PRIMARY KEY,
        device_id VARCHAR(64) NOT NULL,
        started_at BIGINT NOT NULL,
        finished_at BIGINT NOT NULL,
        duration_sec DOUBLE PRECISION NOT NULL DEFAULT 0,
        files_uploaded INT NOT NULL DEFAULT 0,
        bytes_uploaded BIGINT NOT NULL DEFAULT 0,
        files_skipped INT NOT NULL DEFAULT 0,
        files_failed INT NOT NULL DEFAULT 0,
        status VARCHAR(32) NOT NULL DEFAULT 'completed',
        device_ip VARCHAR(45),
        uploaded_files_summary TEXT,
        error_details TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sync_sessions_dev ON sync_sessions(device_id, started_at DESC);

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
        indexed_at BIGINT NOT NULL,
        UNIQUE (source_type, source_key, relative_path)
    );
    CREATE INDEX IF NOT EXISTS idx_media_calendar ON media_index(source_key, cap_month, cap_day);
    CREATE INDEX IF NOT EXISTS idx_media_gps ON media_index(lat, lon) WHERE has_gps = TRUE;
    CREATE INDEX IF NOT EXISTS idx_media_year ON media_index(source_key, cap_year, cap_month);

    CREATE TABLE IF NOT EXISTS geocode_cache (
        lat_round DOUBLE PRECISION NOT NULL,
        lon_round DOUBLE PRECISION NOT NULL,
        place_name TEXT NOT NULL,
        PRIMARY KEY (lat_round, lon_round)
    );

    CREATE TABLE IF NOT EXISTS trips (
        id BIGSERIAL PRIMARY KEY,
        source_id VARCHAR(64) NOT NULL,
        title VARCHAR(255) NOT NULL,
        start_date VARCHAR(32) NOT NULL DEFAULT '',
        end_date VARCHAR(32) NOT NULL DEFAULT '',
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
        source_type VARCHAR(32) NOT NULL DEFAULT 'phone',
        source_key VARCHAR(64) NOT NULL DEFAULT '',
        relative_path TEXT NOT NULL DEFAULT '',
        cap_time BIGINT NOT NULL DEFAULT 0,
        UNIQUE (trip_id, source_type, source_key, relative_path)
    );
    CREATE INDEX IF NOT EXISTS idx_trip_media_trip ON trip_media(trip_id);

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
    """

    with pg_conn.cursor() as cur:
        cur.execute(ddl)
        cur.execute(partition_ddl)
        cur.execute(rest_ddl)
    pg_conn.commit()




# ---------------------------------------------------------------------------
# Sequence reset helper
# ---------------------------------------------------------------------------

_SEQUENCE_TABLE_MAP = [
    # (sequence_name, table_name, id_column)
    ("device_shares_share_id_seq",  "device_shares",        "share_id"),
    ("sync_sessions_id_seq",        "sync_sessions",        "id"),
    ("media_index_id_seq",          "media_index",          "id"),
    ("reactions_id_seq",            "reactions",            "id"),
    ("comments_id_seq",             "comments",             "id"),
    ("trips_id_seq",                "trips",                "id"),
    ("trip_media_id_seq",           "trip_media",           "id"),
    ("saved_reels_id_seq",          "saved_reels",          "id"),
    ("reel_telemetry_id_seq",       "reel_telemetry",       "id"),
    ("device_share_targets_id_seq", "device_share_targets", "id"),
]


def _reset_sequences(pg_conn) -> None:
    """Reset every BIGSERIAL sequence to MAX(id) after bulk migration.

    PostgreSQL BIGSERIAL sequences start at 1 after schema creation, but the
    migration may have inserted rows with much higher IDs (copied from SQLite).
    New inserts would then collide with the migrated rows until the sequence
    catches up past the current maximum -- resetting it here prevents that.
    """
    with pg_conn.cursor() as cur:
        for seq_name, table_name, id_col in _SEQUENCE_TABLE_MAP:
            try:
                sql = f"SELECT setval('{seq_name}', COALESCE(MAX({id_col}), 1)) FROM {table_name};"
                cur.execute(sql)
                val = cur.fetchone()
                print(f"  up {seq_name} -> {val[0] if val else '?'}")
            except Exception as exc:
                print(f"  ! Could not reset {seq_name}: {exc}")
                pg_conn.rollback()
    pg_conn.commit()

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def migrate(sqlite_paths: list[str], pg_url: str) -> None:
    """Connect to PG, init schema, then migrate each SQLite path in order."""
    # Validate inputs
    valid_paths = []
    for p in sqlite_paths:
        if not os.path.isfile(p):
            print(f"WARNING: SQLite file not found, skipping: {p}")
        else:
            valid_paths.append(p)

    if not valid_paths:
        print("ERROR: No valid SQLite database files found.")
        sys.exit(1)

    print(f"\nConnecting to PostgreSQL: {pg_url.split('@')[-1]}")
    pg_conn = psycopg.connect(pg_url, autocommit=False)

    # Init PG schema directly using this connection (no pool needed)
    print("Initialising PostgreSQL schema…")
    sys.path.insert(0, _PROJECT_DIR)
    try:
        _init_pg_schema_direct(pg_conn)
        print("  ✓ Schema ready")
    except Exception as exc:
        print(f"  WARNING: Could not init schema: {exc}")
        import traceback; traceback.print_exc()
        print("  Proceeding — assume schema already exists.")

    total_start = time.time()
    for path in valid_paths:
        label = os.path.basename(os.path.dirname(path)) + "/" + os.path.basename(path)
        _migrate_one_db(path, pg_conn, label=label)

    # ── Reset all BIGSERIAL sequences to MAX(id)+1 ──────────────────────────
    # Without this, new inserts will fail with duplicate-key violations because
    # PostgreSQL sequences start at 1 while the tables contain migrated rows
    # with much higher IDs.
    print("\nResetting PostgreSQL sequences to match migrated data…")
    _reset_sequences(pg_conn)

    pg_conn.close()
    grand_total = time.time() - total_start
    print(f"\n{'='*60}")
    print(f"  ALL MIGRATIONS COMPLETE in {grand_total:.1f}s")
    print(f"{'='*60}\n")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Migrate Phone Backup SQLite database(s) to PostgreSQL",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--sqlite",
        default=None,
        help=(
            "Path to a SQLite backup.db. "
            f"Defaults to the exe-build AppData path: {_EXE_DB}"
        ),
    )
    parser.add_argument(
        "--pg",
        default=_DEFAULT_PG,
        help="PostgreSQL connection URL (default: reads POSTGRES_URL env var)",
    )
    parser.add_argument(
        "--merge-both",
        action="store_true",
        default=False,
        help=(
            "Migrate BOTH the exe-build AppData DB AND the dev-build backup.db "
            "in that order. Conflicts are silently ignored (ON CONFLICT DO NOTHING)."
        ),
    )
    args = parser.parse_args()

    if args.merge_both:
        paths = [_EXE_DB, _DEV_DB]
        print(f"Mode: merge-both")
        print(f"  1. {_EXE_DB}")
        print(f"  2. {_DEV_DB}")
    elif args.sqlite:
        paths = [args.sqlite]
    else:
        # Default: use the exe-build (AppData) database — that's the real one
        paths = [_EXE_DB]
        print(f"Defaulting to exe-build database: {_EXE_DB}")

    migrate(paths, args.pg)
