"""scripts/migrate_sqlite_to_postgres.py

Automated data migration script to copy all devices, files, media indexes,
trips, reactions, comments, and shares from an existing SQLite backup.db into PostgreSQL.

Usage:
    python scripts/migrate_sqlite_to_postgres.py --sqlite backup.db --pg "postgresql://postgres:postgres@localhost:5432/backup_db"
"""

import argparse
import os
import sqlite3
import sys
import time

try:
    import psycopg
except ImportError:
    try:
        import psycopg2 as psycopg
    except ImportError:
        print("ERROR: Neither psycopg nor psycopg2 is installed. Run: pip install psycopg[binary] or pip install psycopg2-binary")
        sys.exit(1)


def migrate(sqlite_path: str, pg_url: str):
    if not os.path.isfile(sqlite_path):
        print(f"ERROR: SQLite database file not found at {sqlite_path}")
        sys.exit(1)

    print(f"Connecting to SQLite: {sqlite_path}")
    sqlite_conn = sqlite3.connect(sqlite_path)
    sqlite_conn.row_factory = sqlite3.Row

    print(f"Connecting to PostgreSQL: {pg_url}")
    pg_conn = psycopg.connect(pg_url)

    # Initialize target schema
    sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
    from database_pg import init_pg_db
    init_pg_db()

    tables_to_migrate = [
        ("devices", ["id", "device_id", "device_name", "device_ip", "status", "first_seen", "last_seen", "files_backed_up", "folder_name", "device_model", "username", "token"]),
        ("sync_sessions", ["id", "device_id", "started_at", "finished_at", "duration_sec", "files_uploaded", "bytes_uploaded", "files_skipped", "files_failed", "status", "device_ip", "uploaded_files_summary", "error_details"]),
        ("media_index", ["id", "source_type", "source_key", "relative_path", "size", "modified_time", "cap_time", "cap_year", "cap_month", "cap_day", "has_gps", "lat", "lon", "duration", "indexed_at"]),
        ("trips", ["id", "source_id", "title", "start_date", "end_date", "start_time", "end_time", "place_name", "center_lat", "center_lon", "media_count", "cover_media_id", "created_at"]),
        ("trip_media", ["id", "trip_id", "media_id", "source_type", "source_key", "relative_path", "cap_time"]),
        ("reactions", ["id", "media_id", "source_id", "emoji", "created_at"]),
        ("comments", ["id", "media_id", "source_id", "text", "created_at"]),
        ("device_share_groups", ["group_id", "shared_by_device_id", "caption", "created_at", "post_kind", "post_title"]),
        ("device_shares", ["share_id", "shared_by_device_id", "source_type", "source_key", "relative_path", "size", "modified_time", "caption", "share_group_id", "original_shared_by_device_id", "repost_of_share_id", "is_library_reel", "media_id", "created_at"]),
        ("device_share_targets", ["id", "share_id", "target_device_id", "seen", "notified"]),
        ("saved_reels", ["id", "device_id", "reel_id", "share_id", "media_id", "created_at"]),
        ("reel_telemetry", ["id", "device_id", "share_id", "media_id", "watch_time_sec", "duration_sec", "completion_rate", "loops", "skipped", "created_at"]),
        ("files", ["id", "device_id", "external_id", "path", "size", "modified_time", "sha256", "uploaded_time", "device_ip"]),
    ]

    total_start = time.time()

    with pg_conn.cursor() as pg_cur:
        for table_name, columns in tables_to_migrate:
            # Check if table exists in SQLite
            sqlite_cur = sqlite_conn.cursor()
            sqlite_cur.execute(f"SELECT name FROM sqlite_master WHERE type='table' AND name='{table_name}'")
            if not sqlite_cur.fetchone():
                print(f"Skipping {table_name} (not found in SQLite)")
                continue

            # Fetch table column info from SQLite to only select existing columns
            sqlite_cur.execute(f"PRAGMA table_info({table_name})")
            existing_sqlite_cols = {row["name"] for row in sqlite_cur.fetchall()}
            valid_cols = [col for col in columns if col in existing_sqlite_cols]

            if not valid_cols:
                continue

            col_names_str = ", ".join(valid_cols)
            sqlite_cur.execute(f"SELECT COUNT(*) FROM {table_name}")
            total_rows = sqlite_cur.fetchone()[0]

            print(f"Migrating {table_name}: {total_rows} rows...")
            sqlite_cur.execute(f"SELECT {col_names_str} FROM {table_name}")

            batch_size = 2000
            inserted = 0

            placeholders = ", ".join(["%s"] * len(valid_cols))
            insert_query = f"INSERT INTO {table_name} ({col_names_str}) VALUES ({placeholders}) ON CONFLICT DO NOTHING"

            while True:
                rows = sqlite_cur.fetchmany(batch_size)
                if not rows:
                    break

                batch_data = [[row[col] for col in valid_cols] for row in rows]
                pg_cur.executemany(insert_query, batch_data)
                pg_conn.commit()
                inserted += len(rows)
                print(f"  -> {table_name}: {inserted}/{total_rows} copied", end="\r")

            print(f"  ✓ {table_name}: {inserted} rows successfully migrated.")

    sqlite_conn.close()
    pg_conn.close()
    print(f"\nMigration completed in {time.time() - total_start:.2f} seconds.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Migrate Phone Backup SQLite database to PostgreSQL")
    parser.add_argument("--sqlite", default="backup.db", help="Path to SQLite backup.db")
    parser.add_argument("--pg", default=os.environ.get("POSTGRES_URL") or "postgresql://postgres:postgres@localhost:5432/backup_db", help="PostgreSQL connection string")
    args = parser.parse_args()
    migrate(args.sqlite, args.pg)
