import os
import sqlite3
import secrets
import threading
import time as _time
from config import DB_PATH

_local = threading.local()


class _PooledConnection:
    """Thread-local connection wrapper that keeps connections open across calls

    within the same thread while exposing standard sqlite3.Connection methods.
    """
    __slots__ = ("_conn",)

    def __init__(self, conn: sqlite3.Connection):
        self._conn = conn

    def __getattr__(self, name):
        return getattr(self._conn, name)

    def __setattr__(self, name, value):
        if name == "_conn":
            super().__setattr__(name, value)
        else:
            setattr(self._conn, name, value)

    def cursor(self, *args, **kwargs):
        return self._conn.cursor(*args, **kwargs)

    def execute(self, *args, **kwargs):
        return self._conn.execute(*args, **kwargs)

    def executemany(self, *args, **kwargs):
        return self._conn.executemany(*args, **kwargs)

    def commit(self):
        return self._conn.commit()

    def rollback(self):
        return self._conn.rollback()

    def close(self):
        # Do not destroy connection; retain in thread-local cache for reuse
        pass

    def real_close(self):
        try:
            self._conn.close()
        except Exception:
            pass



def _create_raw_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA cache_size=-262144")
    conn.execute("PRAGMA mmap_size=2147483648")
    conn.execute("PRAGMA temp_store=MEMORY")
    return conn


def get_conn() -> _PooledConnection:
    conn = getattr(_local, "conn", None)
    if conn is not None:
        try:
            # Health check to ensure connection is live
            conn._conn.total_changes
            return conn
        except Exception:
            try:
                conn.real_close()
            except Exception:
                pass
            _local.conn = None

    raw_conn = _create_raw_conn()
    pooled = _PooledConnection(raw_conn)
    _local.conn = pooled
    return pooled



def init_db():
    conn = get_conn()
    conn.row_factory = sqlite3.Row

    # 1. Migrate devices table if needed
    cursor = conn.execute("PRAGMA table_info(devices)")
    cols = {row['name'] for row in cursor.fetchall()}
    cursor = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='devices'")
    res = cursor.fetchone()
    sql = res[0] if res else ""

    if res and ("device_id" not in cols or "UNIQUE" in sql.split("device_ip")[1].split(",")[0].split("\n")[0].upper()):
        # Needs migration: either device_id column is missing, or device_ip still has UNIQUE constraint
        conn.execute("ALTER TABLE devices RENAME TO devices_old")
        conn.execute("""
                     CREATE TABLE devices
                     (
                         id              INTEGER PRIMARY KEY AUTOINCREMENT,
                         device_id       TEXT UNIQUE,
                         device_name     TEXT    NOT NULL,
                         device_ip       TEXT    NOT NULL,
                         status          TEXT    NOT NULL DEFAULT 'accepted',
                         first_seen      INTEGER NOT NULL,
                         last_seen       INTEGER NOT NULL,
                         files_backed_up INTEGER NOT NULL DEFAULT 0,
                         folder_name     TEXT,
                         device_model    TEXT
                     )
                     """)
        # Copy data, handle missing device_id by using device_ip as fallback
        conn.execute("""
                     INSERT
                     OR IGNORE INTO devices (id, device_id, device_name, device_ip, status, first_seen, last_seen, files_backed_up)
                     SELECT id,
                            COALESCE(device_id, device_ip),
                            device_name,
                            device_ip,
                            status,
                            first_seen,
                            last_seen,
                            files_backed_up
                     FROM devices_old
                     """)
        conn.execute("DROP TABLE devices_old")

    # 2. Create devices table if not exists
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS devices
        (
            id
            INTEGER
            PRIMARY
            KEY
            AUTOINCREMENT,
            device_id
            TEXT
            UNIQUE,
            device_name
            TEXT
            NOT
            NULL,
            device_ip
            TEXT
            NOT
            NULL,
            status
            TEXT
            NOT
            NULL
            DEFAULT
            'accepted',
            first_seen
            INTEGER
            NOT
            NULL,
            last_seen
            INTEGER
            NOT
            NULL,
            files_backed_up
            INTEGER
            NOT
            NULL
            DEFAULT
            0,
            folder_name
            TEXT,
            device_model
            TEXT,
            username
            TEXT
        )
        """
    )

    # 2b. Add folder_name / device_model columns to existing tables that predate them
    cursor = conn.execute("PRAGMA table_info(devices)")
    existing_cols = {row['name'] for row in cursor.fetchall()}
    if 'folder_name' not in existing_cols:
        conn.execute("ALTER TABLE devices ADD COLUMN folder_name TEXT")
    if 'device_model' not in existing_cols:
        conn.execute("ALTER TABLE devices ADD COLUMN device_model TEXT")
    if 'token' not in existing_cols:
        conn.execute("ALTER TABLE devices ADD COLUMN token TEXT")
    if 'username' not in existing_cols:
        conn.execute("ALTER TABLE devices ADD COLUMN username TEXT")

    # 2c. Back-fill folder_name for any pre-existing devices that have NULL there.
    #     We derive it the same way _make_folder_name() does so existing uploads
    #     (stored under device_id-named folders) start resolving to name-based
    #     folders on the next sync.  The old device_id folder on disk is NOT
    #     renamed — only NEW uploads go to the name folder.
    #     NOTE: we skip the rename to avoid breaking in-progress backups.
    null_folders = conn.execute(
        "SELECT device_id, device_name FROM devices WHERE folder_name IS NULL AND device_id IS NOT NULL"
    ).fetchall()
    import re as _re_init
    for _row in null_folders:
        _raw = (_row["device_name"] or "device").strip()
        _safe = _re_init.sub(r'[<>:"/\\|?*]', "_", _raw).strip(". ") or "device"
        conn.execute(
            "UPDATE devices SET folder_name = ? WHERE device_id = ?",
            (_safe, _row["device_id"]),
        )

    # 3. Migrate files table if needed
    cursor = conn.execute("PRAGMA table_info(files)")
    cols = {row['name'] for row in cursor.fetchall()}
    cursor = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='files'")
    res = cursor.fetchone()
    sql = res[0] if res else ""

    has_device_ip = 'device_ip' in cols
    has_proper_unique = "UNIQUE(device_id, path)" in sql or "UNIQUE (device_id, path)" in sql

    if res and (not has_device_ip or not has_proper_unique):
        conn.execute("ALTER TABLE files RENAME TO files_old")
        conn.execute("""
                     CREATE TABLE files
                     (
                         id            INTEGER PRIMARY KEY AUTOINCREMENT,
                         device_id     TEXT,
                         external_id   TEXT,
                         path          TEXT    NOT NULL,
                         size          INTEGER NOT NULL,
                         modified_time INTEGER NOT NULL,
                         sha256        TEXT,
                         uploaded_time INTEGER NOT NULL,
                         device_ip     TEXT,
                         UNIQUE (device_id, path)
                     )
                     """)
        # Build column list for SELECT based on what exists in old table
        old_cols = ['id', 'path', 'size', 'modified_time', 'uploaded_time']
        for c in ['device_id', 'external_id', 'sha256']:
            if c in cols: old_cols.append(c)

        select_cols = ", ".join(old_cols)
        insert_cols = ", ".join(old_cols)

        conn.execute(f"INSERT OR IGNORE INTO files ({insert_cols}) SELECT {select_cols} FROM files_old")
        conn.execute("DROP TABLE files_old")

    # 4. Create files table if not exists
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS files
        (
            id
            INTEGER
            PRIMARY
            KEY
            AUTOINCREMENT,
            device_id
            TEXT,
            external_id
            TEXT,
            path
            TEXT
            NOT
            NULL,
            size
            INTEGER
            NOT
            NULL,
            modified_time
            INTEGER
            NOT
            NULL,
            sha256
            TEXT,
            uploaded_time
            INTEGER
            NOT
            NULL,
            device_ip
            TEXT,
            UNIQUE
        (
            device_id,
            path
        )
            )
        """
    )

    # Ensure indexes exist
    conn.execute("CREATE INDEX IF NOT EXISTS idx_files_path_meta ON files(path, size, modified_time)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_files_device_path ON files(device_id, path)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_files_device_ip ON files(device_ip)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_devices_status_seen ON devices(status, last_seen)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_devices_device_id ON devices(device_id)")

    # 5. sync_sessions table — one row per completed/stopped/failed sync session
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS sync_sessions
        (
            id
            INTEGER
            PRIMARY
            KEY
            AUTOINCREMENT,
            device_id
            TEXT,
            device_name
            TEXT,
            started_at
            INTEGER
            NOT
            NULL,
            ended_at
            INTEGER
            NOT
            NULL,
            duration_ms
            INTEGER
            NOT
            NULL
            DEFAULT
            0,
            trigger
            TEXT
            NOT
            NULL
            DEFAULT
            'manual',
            outcome
            TEXT
            NOT
            NULL
            DEFAULT
            'completed',
            scanned
            INTEGER
            NOT
            NULL
            DEFAULT
            0,
            checked
            INTEGER
            NOT
            NULL
            DEFAULT
            0,
            uploaded
            INTEGER
            NOT
            NULL
            DEFAULT
            0,
            skipped
            INTEGER
            NOT
            NULL
            DEFAULT
            0,
            errors
            INTEGER
            NOT
            NULL
            DEFAULT
            0,
            total_files
            INTEGER
            NOT
            NULL
            DEFAULT
            0
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_device ON sync_sessions(device_id, started_at DESC)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_started ON sync_sessions(started_at DESC)")

    # 6. media_index table for memories precomputation
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS media_index
        (
            id
            INTEGER
            PRIMARY
            KEY
            AUTOINCREMENT,
            source_type
            TEXT
            NOT
            NULL,    -- 'phone' | 'shared'
            source_key
            TEXT
            NOT
            NULL,    -- device_id  | shared source id
            relative_path
            TEXT
            NOT
            NULL,
            size
            INTEGER
            NOT
            NULL,
            modified_time
            INTEGER
            NOT
            NULL,
            capture_time
            INTEGER, -- unix epoch seconds, nullable
            capture_source
            TEXT,    -- 'exif' | 'video' | 'fs_ctime'
            cap_month
            INTEGER,
            cap_day
            INTEGER,
            cap_year
            INTEGER,
            indexed_at
            INTEGER
            NOT
            NULL,
            UNIQUE
        (
            source_type,
            source_key,
            relative_path
        )
            )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_media_lookup ON media_index(source_type, source_key, cap_month, cap_day)"
    )

    # 6b. Add cap_lat / cap_lon columns to media_index for place clustering
    cursor = conn.execute("PRAGMA table_info(media_index)")
    media_cols = {row['name'] for row in cursor.fetchall()}
    if 'cap_lat' not in media_cols:
        conn.execute("ALTER TABLE media_index ADD COLUMN cap_lat REAL")
    if 'cap_lon' not in media_cols:
        conn.execute("ALTER TABLE media_index ADD COLUMN cap_lon REAL")
    if 'gps_checked' not in media_cols:
        conn.execute("ALTER TABLE media_index ADD COLUMN gps_checked INTEGER NOT NULL DEFAULT 0")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_media_geo ON media_index(source_type, source_key, cap_lat, cap_lon)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_media_ym ON media_index(source_type, source_key, cap_year, cap_month)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_files_uploaded ON files(device_id, uploaded_time)"
    )

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS scan_dirs (
            source_type TEXT NOT NULL,
            source_key TEXT NOT NULL,
            dir_relpath TEXT NOT NULL,
            dir_mtime_ns INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (source_type, source_key, dir_relpath)
        )
        """
    )

    # 7. One-time cleanup: remove stale duplicate file rows that may have
    #    accumulated from phone reinstalls before the insert_file deduplication
    #    fix was applied.  For each (device_ip, path) pair we keep only the row
    #    with the most recent uploaded_time (highest rowid as tie-breaker).
    #    Rows with no device_ip are left untouched.
    conn.execute(
        """
        DELETE
        FROM files
        WHERE device_ip IS NOT NULL
          AND rowid NOT IN (SELECT MAX(rowid)
                            FROM files
                            WHERE device_ip IS NOT NULL
                            GROUP BY device_ip, path)
        """
    )

    # 8. cleanup_log — tracks phone-side deletions after verified backup
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS cleanup_log
        (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            file_id     INTEGER,
            source_id   TEXT    NOT NULL,
            path        TEXT    NOT NULL,
            size_bytes  INTEGER NOT NULL,
            deleted_at  INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_cleanup_source_path ON cleanup_log(source_id, path)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_cleanup_deleted_at ON cleanup_log(source_id, deleted_at DESC)"
    )

    # 9. trips table for auto-generated trip albums
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS trips
        (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            source_id       TEXT    NOT NULL,
            title           TEXT    NOT NULL,
            start_time      INTEGER NOT NULL,
            end_time        INTEGER NOT NULL,
            center_lat      REAL    NOT NULL,
            center_lon      REAL    NOT NULL,
            media_count     INTEGER NOT NULL DEFAULT 0,
            cover_media_id  INTEGER,
            created_at      INTEGER NOT NULL,
            updated_at      INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_trips_source_start ON trips(source_id, start_time DESC)"
    )

    # 10. trip_media junction table
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS trip_media
        (
            trip_id   INTEGER NOT NULL,
            media_id  INTEGER NOT NULL,
            PRIMARY KEY (trip_id, media_id),
            FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE,
            FOREIGN KEY (media_id) REFERENCES media_index(id) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_trip_media_trip ON trip_media(trip_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_trip_media_media ON trip_media(media_id)"
    )
    trip_media_sql_row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='trip_media'"
    ).fetchone()
    trip_media_sql = (trip_media_sql_row[0] if trip_media_sql_row else "") or ""
    if trip_media_sql and "FOREIGN KEY" not in trip_media_sql.upper():
        conn.execute("PRAGMA foreign_keys=OFF")
        conn.execute("ALTER TABLE trip_media RENAME TO trip_media_old")
        conn.execute(
            """
            CREATE TABLE trip_media
            (
                trip_id   INTEGER NOT NULL,
                media_id  INTEGER NOT NULL,
                PRIMARY KEY (trip_id, media_id),
                FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE,
                FOREIGN KEY (media_id) REFERENCES media_index(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            INSERT OR IGNORE INTO trip_media (trip_id, media_id)
            SELECT trip_id, media_id FROM trip_media_old
            WHERE trip_id IN (SELECT id FROM trips)
              AND media_id IN (SELECT id FROM media_index)
            """
        )
        conn.execute("DROP TABLE trip_media_old")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_trip_media_trip ON trip_media(trip_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_trip_media_media ON trip_media(media_id)")
        conn.execute("PRAGMA foreign_keys=ON")

    # 11. reactions table for shared media reactions
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS reactions
        (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            media_id    INTEGER NOT NULL,
            source_id   TEXT    NOT NULL,
            emoji       TEXT    NOT NULL,
            created_at  INTEGER NOT NULL,
            UNIQUE (media_id, source_id, emoji)
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_reactions_media ON reactions(media_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_reactions_source ON reactions(source_id)"
    )

    # 12. geocode_cache table for cached reverse geocoding place names
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS geocode_cache
        (
            lat_round   REAL NOT NULL,
            lon_round   REAL NOT NULL,
            place_name  TEXT NOT NULL,
            PRIMARY KEY (lat_round, lon_round)
        )
        """
    )

    # 13. comments table for media comments (anchored on media_index.id, like reactions)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS comments
        (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            media_id    INTEGER NOT NULL,
            source_id   TEXT    NOT NULL,
            text        TEXT    NOT NULL,
            created_at  INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_comments_media ON comments(media_id, created_at)"
    )

    # 14. device_shares table for device-to-device file sharing (references to origin media)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS device_shares
        (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            media_id            INTEGER NOT NULL,
            source_type         TEXT    NOT NULL,
            source_key          TEXT    NOT NULL,
            relative_path       TEXT    NOT NULL,
            size                INTEGER NOT NULL DEFAULT 0,
            modified_time       INTEGER NOT NULL DEFAULT 0,
            caption             TEXT,
            shared_by_device_id TEXT    NOT NULL,
            created_at          INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_device_shares_media ON device_shares(media_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_device_shares_sharer ON device_shares(shared_by_device_id, created_at)"
    )

    # 15. device_share_targets: which devices each share is delivered to
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS device_share_targets
        (
            share_id         INTEGER NOT NULL,
            target_device_id TEXT    NOT NULL,
            seen             INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (share_id, target_device_id),
            FOREIGN KEY (share_id) REFERENCES device_shares(id) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_share_targets_device ON device_share_targets(target_device_id)"
    )

    # Migration: add seen to device_share_targets if not present
    existing_target_cols = {row[1] for row in conn.execute("PRAGMA table_info(device_share_targets)").fetchall()}
    if "seen" not in existing_target_cols:
        conn.execute("ALTER TABLE device_share_targets ADD COLUMN seen INTEGER NOT NULL DEFAULT 0")

    # 16. device_share_groups: one row per share call, groups multi-file posts together
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS device_share_groups
        (
            id                  TEXT    PRIMARY KEY,
            caption             TEXT,
            shared_by_device_id TEXT    NOT NULL,
            created_at          INTEGER NOT NULL,
            post_kind           TEXT,
            post_title          TEXT
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_share_groups_sharer ON device_share_groups(shared_by_device_id, created_at)"
    )

    # Migration: add share_group_id to device_shares if not present
    existing_cols = {row[1] for row in conn.execute("PRAGMA table_info(device_shares)").fetchall()}
    if "share_group_id" not in existing_cols:
        conn.execute("ALTER TABLE device_shares ADD COLUMN share_group_id TEXT")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_device_shares_group ON device_shares(share_group_id)"
        )

    # Migration: add post_kind/post_title to device_share_groups if not present
    existing_group_cols = {row[1] for row in conn.execute("PRAGMA table_info(device_share_groups)").fetchall()}
    if "post_kind" not in existing_group_cols:
        conn.execute("ALTER TABLE device_share_groups ADD COLUMN post_kind TEXT")
    if "post_title" not in existing_group_cols:
        conn.execute("ALTER TABLE device_share_groups ADD COLUMN post_title TEXT")

    conn.commit()
    conn.close()


# ─── File helpers ──────────────────────────────────────────────────────────────

def is_uploaded(path, size, modified_time):
    conn = get_conn()
    row = conn.execute(
        "SELECT 1 FROM files WHERE path=? AND size=? AND modified_time=?",
        (path, size, modified_time),
    ).fetchone()
    conn.close()
    return row is not None


def _metadata_matches(row, size, modified_time):
    """True when a DB file row represents the same file version."""
    row_size = row["size"]
    row_mtime = row["modified_time"]

    if row_size != size:
        return False

    # Some legacy/SAF entries can have no reliable mtime. In that case, size is
    # the best metadata match available; otherwise, require exact mtime.
    return not modified_time or not row_mtime or row_mtime == modified_time


def is_uploaded_compatible(path, size, modified_time, external_id=None, device_id=None):
    conn = get_conn()
    path = (path or "").replace("\\", "/")

    # Try by external_id first if available
    if external_id:
        if device_id:
            rows = conn.execute(
                "SELECT size, modified_time FROM files WHERE device_id=? AND path=? AND external_id=?",
                (device_id, path, external_id),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT size, modified_time FROM files WHERE device_id IS NULL AND path=? AND external_id=?",
                (path, external_id),
            ).fetchall()

        if any(_metadata_matches(row, size, modified_time) for row in rows):
            conn.close()
            return True

    # Then try by path/device_id
    if device_id:
        rows = conn.execute(
            "SELECT size, modified_time FROM files WHERE (device_id=? OR device_id IS NULL) AND path=?",
            (device_id, path),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT size, modified_time FROM files WHERE device_id IS NULL AND path=?",
            (path,),
        ).fetchall()
    conn.close()
    return any(_metadata_matches(row, size, modified_time) for row in rows)


def batch_check_files(items: list[dict]):
    """
    Checks a list of file metadata against the database in fewer queries.
    Each item in items: {"path": str, "size": int, "modified_time": int, "external_id": str, "device_id": str}
    Returns a set of keys (path|mtime|size) that are present in DB.
    """
    if not items:
        return set()

    conn = get_conn()
    present_keys = set()

    # Group by device_id
    device_groups: dict[str, list[dict]] = {}
    for item in items:
        did = item.get("device_id") or ""
        device_groups.setdefault(did, []).append(item)

    CHUNK_SIZE = 400
    for did, group in device_groups.items():
        for chunk_idx in range(0, len(group), CHUNK_SIZE):
            chunk = group[chunk_idx:chunk_idx + CHUNK_SIZE]
            paths = [i["path"] for i in chunk]
            placeholders = ",".join(["?"] * len(paths))
            if did:
                query = f"SELECT path, size, modified_time, external_id FROM files WHERE (device_id=? OR device_id IS NULL) AND path IN ({placeholders})"
                params = [did] + paths
            else:
                query = f"SELECT path, size, modified_time, external_id FROM files WHERE device_id IS NULL AND path IN ({placeholders})"
                params = paths

            rows = conn.execute(query, params).fetchall()

            # Match rows back to items
            row_map: dict[str, list] = {}
            eid_map: dict[str, list] = {}
            for r in rows:
                p = (r["path"] or "").replace("\\", "/")
                row_map.setdefault(p, []).append(r)
                if r["external_id"]:
                    eid_map.setdefault(r["external_id"], []).append(r)

            for item in chunk:
                p = (item["path"] or "").replace("\\", "/")
                s, m, eid = item["size"], item["modified_time"], item.get("external_id")
                found = False
                if eid and eid in eid_map:
                    found = any(
                        (r["path"] or "").replace("\\", "/") == p and _metadata_matches(r, s, m)
                        for r in eid_map[eid]
                    )
                elif p in row_map:
                    for r in row_map[p]:
                        if _metadata_matches(r, s, m):
                            found = True
                            break

                if found:
                    present_keys.add(f"{item['path']}|{m}|{s}")

    conn.close()
    return present_keys



def insert_file(path, size, modified_time, uploaded_time, device_ip=None, external_id=None, sha256=None,
                device_id=None):
    conn = get_conn()
    path = (path or "").replace("\\", "/")
    # If we have device_id, we can use it for a more specific update
    if device_id:
        # Before inserting, remove any stale rows for the same path from a
        # *different* device_id on the same device_ip.  This prevents duplicate
        # file counts when a phone is reinstalled and gets a new device_id
        # without triggering the normal reinstall-merge flow (e.g. the device
        # name changed slightly so find_device_by_name_model() found no match).
        if device_ip:
            conn.execute(
                "DELETE FROM files WHERE path = ? AND device_ip = ? AND device_id != ?",
                (path, device_ip, device_id),
            )
        conn.execute(
            "INSERT INTO files (device_id, path, size, modified_time, uploaded_time, device_ip, external_id, sha256)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
            " ON CONFLICT(device_id, path) DO UPDATE SET"
            "   size = excluded.size,"
            "   modified_time = excluded.modified_time,"
            "   uploaded_time = excluded.uploaded_time,"
            "   device_ip = excluded.device_ip,"
            "   external_id = excluded.external_id,"
            "   sha256 = excluded.sha256",
            (device_id, path, size, modified_time, uploaded_time, device_ip, external_id, sha256),
        )
    else:
        conn.execute(
            "INSERT OR REPLACE INTO files (path, size, modified_time, uploaded_time, device_ip, external_id, sha256)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (path, size, modified_time, uploaded_time, device_ip, external_id, sha256),
        )
    conn.commit()
    conn.close()


def remove_file_record(path, size, modified_time, device_id=None):
    conn = get_conn()
    if device_id:
        conn.execute(
            "DELETE FROM files WHERE (device_id=? OR device_id IS NULL) AND path=? AND size=? AND modified_time=?",
            (device_id, path, size, modified_time),
        )
    else:
        conn.execute(
            "DELETE FROM files WHERE device_id IS NULL AND path=? AND size=? AND modified_time=?",
            (path, size, modified_time),
        )
    conn.commit()
    conn.close()


def get_stats():
    conn = get_conn()
    # To be perfectly accurate, we could check disk here, but for thousands of files it's slow.
    # For now, we rely on the database being the source of truth for "known" files.
    # The sync algorithm already handles missing disk files by re-requesting them.
    row = conn.execute(
        "SELECT COUNT(*) as total_files,"
        "       COALESCE(SUM(size), 0) as total_size_bytes,"
        "       MAX(uploaded_time) as last_backup_time"
        " FROM files"
    ).fetchone()
    conn.close()
    return {
        "total_files": row["total_files"] or 0,
        "total_size_bytes": row["total_size_bytes"] or 0,
        "last_backup_time": row["last_backup_time"],
    }


def get_device_stats(device_ip: str, device_id: str | None = None) -> dict:
    conn = get_conn()
    if device_id:
        # Match both current device_id and any legacy records for this IP
        row = conn.execute(
            "SELECT COUNT(*) as total_files, COALESCE(SUM(size), 0) as total_size"
            " FROM files WHERE device_id = ? OR (device_id IS NULL AND device_ip = ?)",
            (device_id, device_ip)
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT COUNT(*) as total_files, COALESCE(SUM(size), 0) as total_size"
            " FROM files WHERE device_ip = ?",
            (device_ip,)
        ).fetchone()
    conn.close()
    return {
        "total_files": row["total_files"] or 0,
        "total_size": row["total_size"] or 0,
    }


# ─── Device helpers ────────────────────────────────────────────────────────────

def _make_folder_name(device_name: str) -> str:
    """Derive a safe, human-readable folder name from the device name.
    This is set once when the device is first registered and never changes,
    so the folder always reflects the device's name."""
    import re as _re
    name = (device_name or "device").strip()
    # Replace characters that are illegal in Windows/Linux directory names
    safe = _re.sub(r'[<>:"/\\|?*]', '_', name)
    safe = safe.strip('. ')  # no leading/trailing dots or spaces
    return safe or "device"


def upsert_device(
        device_name: str,
        device_ip: str,
        device_id: str | None = None,
        device_model: str | None = None,
        username: str | None = None,
) -> None:
    """Insert a new device or update its name/last_seen.

    folder_name is set ONCE on first insert and never updated afterward,
    so the on-disk backup folder always keeps the original device name.
    """
    now = int(_time.time())
    conn = get_conn()
    if device_id:
        # Check if a folder_name already exists for this device_id
        row = conn.execute(
            "SELECT folder_name FROM devices WHERE device_id = ?", (device_id,)
        ).fetchone()
        existing_folder = row["folder_name"] if row else None
        folder_name = existing_folder or _make_folder_name(device_name)

        conn.execute(
            """
            INSERT INTO devices (device_id, device_name, device_ip, status, first_seen, last_seen, folder_name,
                                 device_model, username)
            VALUES (?, ?, ?, 'accepted', ?, ?, ?, ?, ?) ON CONFLICT(device_id) DO
            UPDATE SET
                device_name = excluded.device_name,
                device_ip = excluded.device_ip,
                last_seen = excluded.last_seen,
                status = 'accepted',
                device_model = COALESCE (devices.device_model, excluded.device_model),
                folder_name = COALESCE (devices.folder_name, excluded.folder_name),
                username = COALESCE (excluded.username, devices.username)
            """,
            (device_id, device_name, device_ip, now, now, folder_name, device_model, username),
        )
    else:
        # Legacy fallback: try to update by IP if device_id is missing
        res = conn.execute(
            "UPDATE devices SET device_name=?, last_seen=? WHERE device_ip=? AND device_id IS NULL",
            (device_name, now, device_ip),
        )
        if res.rowcount == 0:
            folder_name = _make_folder_name(device_name)
            conn.execute(
                """
                INSERT INTO devices (device_name, device_ip, status, first_seen, last_seen, folder_name, device_model, username)
                VALUES (?, ?, 'accepted', ?, ?, ?, ?, ?)
                """,
                (device_name, device_ip, now, now, folder_name, device_model, username),
            )
    conn.commit()
    conn.close()

    if device_id:
        ensure_device_token(device_id)

    # Recalculate file count immediately
    touch_device(device_ip, device_id)


def set_device_username(device_id: str, username: str | None) -> None:
    conn = get_conn()
    conn.execute(
        "UPDATE devices SET username = ? WHERE device_id = ?",
        ((username or "").strip() or None, device_id),
    )
    conn.commit()
    conn.close()


def _generate_device_token() -> str:
    return secrets.token_urlsafe(32)


def ensure_device_token(device_id: str) -> str:
    """Return the per-device auth token, creating one if missing."""
    conn = get_conn()
    row = conn.execute(
        "SELECT token FROM devices WHERE device_id = ?", (device_id,)
    ).fetchone()
    if row and row["token"]:
        token = row["token"]
        conn.close()
        return token

    token = _generate_device_token()
    conn.execute(
        "UPDATE devices SET token = ? WHERE device_id = ?",
        (token, device_id),
    )
    conn.commit()
    conn.close()
    return token


def verify_device_token(device_id: str, token: str) -> bool:
    if not device_id or not token:
        return False
    conn = get_conn()
    row = conn.execute(
        "SELECT 1 FROM devices WHERE device_id = ? AND token = ? AND status = 'accepted'",
        (device_id, token),
    ).fetchone()
    conn.close()
    return row is not None


def get_files_for_device(device_id: str, prefix: str = "") -> list[dict]:
    conn = get_conn()
    if prefix:
        norm = prefix.strip("/")
        norm_dir = f"{norm}/%"
        rows = conn.execute(
            "SELECT path, size, modified_time, sha256, uploaded_time FROM files WHERE device_id = ? AND (path = ? OR path LIKE ?) ORDER BY path",
            (device_id, norm, norm_dir),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT path, size, modified_time, sha256, uploaded_time FROM files WHERE device_id = ? ORDER BY path",
            (device_id,),
        ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_files_browse(device_id: str, prefix: str) -> tuple[list[dict], list[dict]]:
    conn = get_conn()
    like_pattern = f"{prefix}%" if prefix else "%"
    rows = conn.execute(
        "SELECT path, size, modified_time, sha256, uploaded_time FROM files WHERE device_id = ? AND path LIKE ? ORDER BY path",
        (device_id, like_pattern),
    ).fetchall()
    conn.close()

    prefix_len = len(prefix)
    folders: dict[str, dict] = {}
    files: list[dict] = []
    for r in rows:
        path = r["path"]
        if prefix and not path.startswith(prefix):
            continue
        rest = path[prefix_len:]
        if not rest:
            continue
        slash_idx = rest.find("/")
        if slash_idx == -1:
            files.append(dict(r))
        else:
            folder_name = rest[:slash_idx]
            entry = folders.setdefault(
                folder_name,
                {"name": folder_name, "path": prefix + folder_name, "file_count": 0, "total_size": 0},
            )
            entry["file_count"] += 1
            entry["total_size"] += r["size"] or 0

    return list(folders.values()), files


def search_files_for_device(device_id: str, query: str, limit: int = 500) -> list[dict]:
    conn = get_conn()
    escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    rows = conn.execute(
        "SELECT path, size, modified_time, sha256, uploaded_time FROM files "
        "WHERE device_id = ? AND path LIKE ? ESCAPE '\\' ORDER BY path LIMIT ?",
        (device_id, f"%{escaped}%", max(1, min(limit, 500))),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_device_folder_name(device_id: str) -> str | None:
    """Return the stable on-disk folder_name for a device_id, or None if not found."""
    conn = get_conn()
    row = conn.execute(
        "SELECT folder_name FROM devices WHERE device_id = ?", (device_id,)
    ).fetchone()
    conn.close()
    return row["folder_name"] if row else None


def find_device_by_name_model(
        device_name: str, device_model: str | None
) -> dict | None:
    """Find an existing accepted device by name AND model.
    Used to detect a reinstalled app that got a new device_id.
    Returns the full device row or None.

    We only attempt a match when device_model is available — name-only matches
    are too ambiguous (e.g. multiple "Android Device" entries from different
    phones) and could cause incorrect merges.
    """
    if not device_model:
        # Without a model identifier it's unsafe to auto-merge — bail out.
        return None
    conn = get_conn()
    row = conn.execute(
        "SELECT * FROM devices WHERE device_name=? AND device_model=? AND status='accepted' LIMIT 1",
        (device_name, device_model),
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def merge_device_id(old_device_id: str, new_device_id: str, new_device_ip: str) -> None:
    """Reassign all file records from old_device_id to new_device_id and update the
    devices row.  Called when a reinstalled app presents a new device_id but we
    detect it belongs to the same physical device (by name + model match).
    """
    now = int(_time.time())
    conn = get_conn()
    # Migrate file records
    conn.execute(
        "UPDATE files SET device_id = ? WHERE device_id = ?",
        (new_device_id, old_device_id),
    )
    # Update the device row — keep folder_name intact
    conn.execute(
        "UPDATE devices SET device_id=?, device_ip=?, last_seen=? WHERE device_id=?",
        (new_device_id, new_device_ip, now, old_device_id),
    )
    conn.commit()
    conn.close()


def touch_device(device_ip: str, device_id: str | None = None, files_delta: int = 1) -> None:
    """Update last_seen timestamp and recalculate file counter for a device."""
    now = int(_time.time())
    conn = get_conn()

    # If device_id is missing, try to resolve it from the devices table
    if not device_id:
        row = conn.execute("SELECT device_id FROM devices WHERE device_ip = ? AND device_id IS NOT NULL LIMIT 1",
                           (device_ip,)).fetchone()
        if row:
            device_id = row["device_id"]

    if device_id:
        conn.execute(
            "UPDATE devices SET last_seen = ?, device_ip = ? WHERE device_id = ?",
            (now, device_ip, device_id),
        )
        # Count files matching this device_id OR matching the IP if device_id was missing in old records
        row = conn.execute(
            "SELECT COUNT(*) as count FROM files WHERE device_id = ? OR (device_id IS NULL AND device_ip = ?)",
            (device_id, device_ip)
        ).fetchone()
        count = row["count"] or 0
        conn.execute(
            "UPDATE devices SET files_backed_up = ? WHERE device_id = ?",
            (count, device_id),
        )
    else:
        conn.execute(
            "UPDATE devices SET last_seen = ? WHERE device_ip = ?",
            (now, device_ip),
        )
        row = conn.execute(
            "SELECT COUNT(*) as count FROM files WHERE device_ip = ?",
            (device_ip,)
        ).fetchone()
        count = row["count"] or 0
        conn.execute(
            "UPDATE devices SET files_backed_up = ? WHERE device_ip = ?",
            (count, device_ip),
        )

    conn.commit()
    conn.close()


def get_devices() -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM devices WHERE status='accepted' ORDER BY last_seen DESC"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def remove_device(device_id: int) -> None:
    conn = get_conn()
    conn.execute("DELETE FROM devices WHERE id=?", (device_id,))
    conn.commit()
    conn.close()


def is_device_known(device_ip: str, device_id: str | None = None) -> bool:
    conn = get_conn()
    if device_id:
        row = conn.execute(
            "SELECT 1 FROM devices WHERE device_id=? AND status='accepted'",
            (device_id,),
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT 1 FROM devices WHERE device_ip=? AND status='accepted'",
            (device_ip,),
        ).fetchone()
    conn.close()
    return row is not None


# ─── Sync session helpers ──────────────────────────────────────────────────────

def insert_sync_session(
        device_id: str | None,
        device_name: str | None,
        started_at: int,
        ended_at: int,
        duration_ms: int,
        trigger: str,
        outcome: str,
        scanned: int = 0,
        checked: int = 0,
        uploaded: int = 0,
        skipped: int = 0,
        errors: int = 0,
        total_files: int = 0,
) -> int:
    """Insert one sync session record and return its new id."""
    conn = get_conn()
    cur = conn.execute(
        """
        INSERT INTO sync_sessions
        (device_id, device_name, started_at, ended_at, duration_ms,
         trigger, outcome, scanned, checked, uploaded, skipped, errors, total_files)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (device_id, device_name, started_at, ended_at, duration_ms,
         trigger, outcome, scanned, checked, uploaded, skipped, errors, total_files),
    )
    conn.commit()
    row_id = cur.lastrowid
    conn.close()
    return row_id


def get_sync_sessions(device_id: str | None = None, limit: int = 100) -> list[dict]:
    """Return sync sessions newest-first, optionally filtered by device."""
    conn = get_conn()
    if device_id:
        rows = conn.execute(
            "SELECT * FROM sync_sessions WHERE device_id=? ORDER BY started_at DESC LIMIT ?",
            (device_id, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM sync_sessions ORDER BY started_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def clear_sync_sessions(device_id: str | None = None) -> None:
    """Delete all sessions, or only those for a specific device."""
    conn = get_conn()
    if device_id:
        conn.execute("DELETE FROM sync_sessions WHERE device_id=?", (device_id,))
    else:
        conn.execute("DELETE FROM sync_sessions")
    conn.commit()
    conn.close()


# ─── Media Index / Memories helpers ──────────────────────────────────────────

def upsert_media_index_row(
        source_type: str,
        source_key: str,
        relative_path: str,
        size: int,
        modified_time: int,
        capture_time: int | None,
        capture_source: str | None,
        cap_month: int | None,
        cap_day: int | None,
        cap_year: int | None,
        indexed_at: int,
        cap_lat: float | None = None,
        cap_lon: float | None = None,
        gps_checked: bool = False,
) -> None:
    conn = get_conn()
    conn.execute(
        """
        INSERT INTO media_index (source_type, source_key, relative_path, size, modified_time,
                                 capture_time, capture_source, cap_month, cap_day, cap_year, indexed_at,
                                 cap_lat, cap_lon, gps_checked)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_type, source_key, relative_path) DO
        UPDATE SET
            size =excluded.size,
            modified_time=excluded.modified_time,
            capture_time=excluded.capture_time,
            capture_source=excluded.capture_source,
            cap_month=excluded.cap_month,
            cap_day=excluded.cap_day,
            cap_year=excluded.cap_year,
            indexed_at=excluded.indexed_at,
            cap_lat=excluded.cap_lat,
            cap_lon=excluded.cap_lon,
            gps_checked=excluded.gps_checked
        """,
        (
            source_type,
            source_key,
            relative_path,
            size,
            modified_time,
            capture_time,
            capture_source,
            cap_month,
            cap_day,
            cap_year,
            indexed_at,
            cap_lat,
            cap_lon,
            1 if gps_checked else 0,
        ),
    )
    conn.commit()
    conn.close()


def batch_upsert_media_index_rows(rows: list[dict]) -> None:
    """Bulk insert or update media_index entries in a single transaction."""
    if not rows:
        return
    conn = get_conn()
    params = [
        (
            r["source_type"],
            r["source_key"],
            r["relative_path"],
            r["size"],
            r["modified_time"],
            r.get("capture_time"),
            r.get("capture_source"),
            r.get("cap_month"),
            r.get("cap_day"),
            r.get("cap_year"),
            r.get("indexed_at"),
            r.get("cap_lat"),
            r.get("cap_lon"),
            1 if r.get("gps_checked") else 0,
        )
        for r in rows
    ]
    conn.executemany(
        """
        INSERT INTO media_index (source_type, source_key, relative_path, size, modified_time,
                                 capture_time, capture_source, cap_month, cap_day, cap_year, indexed_at,
                                 cap_lat, cap_lon, gps_checked)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_type, source_key, relative_path) DO UPDATE SET
            size = excluded.size,
            modified_time = excluded.modified_time,
            capture_time = excluded.capture_time,
            capture_source = excluded.capture_source,
            cap_month = excluded.cap_month,
            cap_day = excluded.cap_day,
            cap_year = excluded.cap_year,
            indexed_at = excluded.indexed_at,
            cap_lat = excluded.cap_lat,
            cap_lon = excluded.cap_lon,
            gps_checked = excluded.gps_checked
        """,
        params,
    )
    conn.commit()
    conn.close()


def get_media_index_stats() -> dict:
    conn = get_conn()
    row = conn.execute(
        "SELECT COUNT(*) AS c, MAX(indexed_at) AS last FROM media_index"
    ).fetchone()
    conn.close()
    return {"files": row["c"] or 0, "last_indexed_at": row["last"]}


def clear_media_index() -> int:
    conn = get_conn()
    row = conn.execute("SELECT COUNT(*) AS c FROM media_index").fetchone()
    count = row["c"] or 0
    conn.execute("DELETE FROM media_index")
    conn.execute("DELETE FROM scan_dirs")
    conn.commit()
    conn.close()
    return count


def get_media_index_cache(source_type: str, source_key: str) -> dict[str, tuple[int, int, str | None, float | None, bool]]:

    """Return {relative_path: (size, modified_time, capture_source, cap_lat, gps_checked)} for a given source."""
    conn = get_conn()
    rows = conn.execute(
        "SELECT relative_path, size, modified_time, capture_source, cap_lat, gps_checked FROM media_index WHERE source_type = ? AND source_key = ?",
        (source_type, source_key),
    ).fetchall()
    conn.close()
    return {r["relative_path"]: (r["size"], r["modified_time"], r["capture_source"], r["cap_lat"], bool(r["gps_checked"])) for r in rows}


def get_media_for_day(
        source_type_and_keys: list[tuple[str, str]],
        month: int,
        day: int,
        exclude_year: int,
) -> list[dict]:
    if not source_type_and_keys:
        return []
    conn = get_conn()
    or_clauses = []
    params: list = []
    for stype, skey in source_type_and_keys:
        or_clauses.append("(source_type = ? AND source_key = ?)")
        params.extend([stype, skey])

    where_source = " OR ".join(or_clauses)
    params.extend([month, day, exclude_year])

    sql = f"""
        SELECT source_type, source_key, relative_path, size, modified_time, capture_time, capture_source, cap_month, cap_day, cap_year
        FROM media_index
        WHERE ({where_source})
          AND cap_month = ?
          AND cap_day = ?
          AND (cap_year IS NULL OR cap_year != ?)
        ORDER BY capture_time DESC, relative_path ASC
    """
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_media_for_days_multi(
        source_type_and_keys: list[tuple[str, str]],
        month_day_pairs: list[tuple[int, int]],
) -> list[dict]:
    """Fetch media records for multiple (month, day) pairs in a single batched SQL query."""
    if not source_type_and_keys or not month_day_pairs:
        return []
    conn = get_conn()
    or_clauses = []
    params: list = []
    for stype, skey in source_type_and_keys:
        or_clauses.append("(source_type = ? AND source_key = ?)")
        params.extend([stype, skey])
    where_source = " OR ".join(or_clauses)

    day_clauses = []
    for m, d in month_day_pairs:
        day_clauses.append("(cap_month = ? AND cap_day = ?)")
        params.extend([m, d])
    where_days = " OR ".join(day_clauses)

    sql = f"""
        SELECT source_type, source_key, relative_path, size, modified_time, capture_time, capture_source, cap_month, cap_day, cap_year
        FROM media_index
        WHERE ({where_source})
          AND ({where_days})
        ORDER BY capture_time DESC, relative_path ASC
    """
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_media_for_year_window(
        source_type_and_keys: list[tuple[str, str]],
        year: int,
        month_day_pairs: list[tuple[int, int]],
) -> list[dict]:
    if not source_type_and_keys or not month_day_pairs:
        return []
    conn = get_conn()
    or_clauses = []
    params: list = []
    for stype, skey in source_type_and_keys:
        or_clauses.append("(source_type = ? AND source_key = ?)")
        params.extend([stype, skey])
    where_source = " OR ".join(or_clauses)

    day_clauses = []
    for m, d in month_day_pairs:
        day_clauses.append("(cap_month = ? AND cap_day = ?)")
        params.extend([m, d])
    where_days = " OR ".join(day_clauses)
    params.append(year)

    sql = f"""
        SELECT source_type, source_key, relative_path, size, modified_time, capture_time, capture_source, cap_month, cap_day, cap_year
        FROM media_index
        WHERE ({where_source})
          AND ({where_days})
          AND cap_year = ?
        ORDER BY capture_time DESC, relative_path ASC
    """
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_media_for_ymd_list(
        source_type_and_keys: list[tuple[str, str]],
        ymd_list: list[tuple[int, int, int]],
) -> list[dict]:
    """Match exact (year, month, day) triples — correct across year boundaries."""
    if not source_type_and_keys or not ymd_list:
        return []
    conn = get_conn()
    or_clauses = []
    params: list = []
    for stype, skey in source_type_and_keys:
        or_clauses.append("(source_type = ? AND source_key = ?)")
        params.extend([stype, skey])
    where_source = " OR ".join(or_clauses)

    day_clauses = []
    for y, m, d in ymd_list:
        day_clauses.append("(cap_year = ? AND cap_month = ? AND cap_day = ?)")
        params.extend([y, m, d])
    where_days = " OR ".join(day_clauses)

    sql = f"""
        SELECT source_type, source_key, relative_path, size, modified_time, capture_time, capture_source, cap_month, cap_day, cap_year
        FROM media_index
        WHERE ({where_source})
          AND ({where_days})
        ORDER BY capture_time DESC, relative_path ASC
    """
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_year_wrapped_stats(
        source_type_and_keys: list[tuple[str, str]],
        year: int,
) -> list[dict]:
    if not source_type_and_keys:
        return []
    conn = get_conn()
    or_clauses = []
    params: list = []
    for stype, skey in source_type_and_keys:
        or_clauses.append("(source_type = ? AND source_key = ?)")
        params.extend([stype, skey])
    where_source = " OR ".join(or_clauses)
    params.append(year)

    sql = f"""
        SELECT relative_path, size, cap_month
        FROM media_index
        WHERE ({where_source}) AND cap_year = ?
    """
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_media_for_year_month(
        source_type_and_keys: list[tuple[str, str]],
        year: int,
        month: int | None,
        limit: int = 20,
        *,
        order: str = "time",
) -> list[dict]:
    """Fetch media for a year (optionally month).

    order=\"time\": chronological (ASC) — used when the caller will subsample evenly.
    order=\"random\": random pool — avoids early-year bias when LIMIT truncates a large year.
    """
    if not source_type_and_keys:
        return []
    conn = get_conn()
    or_clauses = []
    params: list = []
    for stype, skey in source_type_and_keys:
        or_clauses.append("(source_type = ? AND source_key = ?)")
        params.extend([stype, skey])
    where_source = " OR ".join(or_clauses)
    params.append(year)

    month_clause = ""
    if month:
        month_clause = "AND cap_month = ?"
        params.append(month)

    order_sql = "ORDER BY RANDOM()" if order == "random" else "ORDER BY capture_time ASC"
    limit_sql = ""
    if limit is not None and limit > 0:
        limit_sql = "LIMIT ?"
        params.append(limit)

    sql = f"""
        SELECT source_type, source_key, relative_path, size, modified_time, capture_time, cap_month, cap_day, cap_year
        FROM media_index
        WHERE ({where_source}) AND cap_year = ? {month_clause}
        {order_sql}
        {limit_sql}
    """
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_distinct_cap_years(
        source_type_and_keys: list[tuple[str, str]],
) -> list[int]:
    if not source_type_and_keys:
        return []
    conn = get_conn()
    or_clauses = []
    params: list = []
    for stype, skey in source_type_and_keys:
        or_clauses.append("(source_type = ? AND source_key = ?)")
        params.extend([stype, skey])
    where_source = " OR ".join(or_clauses)
    sql = f"""
        SELECT DISTINCT cap_year
        FROM media_index
        WHERE ({where_source}) AND cap_year IS NOT NULL
        ORDER BY cap_year ASC
    """
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    return [int(r["cap_year"]) for r in rows if r["cap_year"] is not None]


def get_quiz_photo_pool(
        source_type_and_keys: list[tuple[str, str]],
        limit: int = 800,
) -> list[dict]:
    if not source_type_and_keys:
        return []
    conn = get_conn()
    or_clauses = []
    params: list = []
    for stype, skey in source_type_and_keys:
        or_clauses.append("(source_type = ? AND source_key = ?)")
        params.extend([stype, skey])
    where_source = " OR ".join(or_clauses)
    params.append(max(1, limit))

    # Cap the pool so huge libraries don't load the entire index into RAM.
    sql = f"""
        SELECT source_type, source_key, relative_path, cap_year
        FROM media_index
        WHERE ({where_source}) AND cap_year IS NOT NULL
        ORDER BY RANDOM()
        LIMIT ?
    """
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_random_media_row(
        source_type_and_keys: list[tuple[str, str]],
        allowed_exts: set[str] | None = None,
) -> dict | None:
    if not source_type_and_keys:
        return None
    conn = get_conn()
    or_clauses = []
    params: list = []
    for stype, skey in source_type_and_keys:
        or_clauses.append("(source_type = ? AND source_key = ?)")
        params.extend([stype, skey])
    where_source = " OR ".join(or_clauses)

    ext_clause = ""
    if allowed_exts:
        # Suffix match via GLOB on lowercased path (avoids matching ".jpg.bak").
        ext_parts = []
        for ext in sorted(allowed_exts):
            ext_parts.append("LOWER(relative_path) GLOB ?")
            params.append(f"*{ext.lower()}")
        ext_clause = f"AND ({' OR '.join(ext_parts)})"

    sql = f"""
        SELECT source_type, source_key, relative_path, size, capture_time, cap_year
        FROM media_index
        WHERE ({where_source})
        {ext_clause}
        ORDER BY RANDOM()
        LIMIT 1
    """
    row = conn.execute(sql, params).fetchone()
    conn.close()
    return dict(row) if row else None


def get_random_media_item(source_type: str, source_key: str) -> dict | None:
    """Public alias matching the feature-spec name."""
    return get_random_media_row([(source_type, source_key)])


def get_geotagged_media(
        source_type_and_keys: list[tuple[str, str]],
        limit: int = 5000,
) -> list[dict]:
    if not source_type_and_keys:
        return []
    conn = get_conn()
    or_clauses = []
    params: list = []
    for stype, skey in source_type_and_keys:
        or_clauses.append("(source_type = ? AND source_key = ?)")
        params.extend([stype, skey])
    where_source = " OR ".join(or_clauses)
    params.append(max(1, limit))

    sql = f"""
        SELECT source_type, source_key, relative_path, size, capture_time, cap_year, cap_lat, cap_lon
        FROM media_index
        WHERE ({where_source}) AND cap_lat IS NOT NULL AND cap_lon IS NOT NULL
        ORDER BY capture_time DESC
        LIMIT ?
    """
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def prune_media_index(
    source_type: str,
    source_key: str,
    keep_paths: set[str],
    existing_paths: set[str] | None = None,
) -> None:
    conn = get_conn()
    if existing_paths is None:
        rows = conn.execute(
            "SELECT relative_path FROM media_index WHERE source_type = ? AND source_key = ?",
            (source_type, source_key),
        ).fetchall()
        existing_paths = {r["relative_path"] for r in rows}
    to_delete = existing_paths - keep_paths
    if to_delete:
        to_delete_list = list(to_delete)
        chunk_size = 500
        for i in range(0, len(to_delete_list), chunk_size):
            chunk = to_delete_list[i: i + chunk_size]
            placeholders = ",".join(["?"] * len(chunk))
            conn.execute(
                f"DELETE FROM media_index WHERE source_type = ? AND source_key = ? AND relative_path IN ({placeholders})",
                [source_type, source_key] + chunk,
            )
        conn.commit()
    conn.close()


def get_scan_dirs(source_type: str, source_key: str) -> dict[str, int]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT dir_relpath, dir_mtime_ns FROM scan_dirs WHERE source_type = ? AND source_key = ?",
        (source_type, source_key),
    ).fetchall()
    conn.close()
    return {r["dir_relpath"]: r["dir_mtime_ns"] for r in rows}


def upsert_scan_dirs(source_type: str, source_key: str, dir_mtimes: dict[str, int]) -> None:
    if not dir_mtimes:
        return
    conn = get_conn()
    now_ts = int(_time.time())
    params = [
        (source_type, source_key, rel, mtime, now_ts)
        for rel, mtime in dir_mtimes.items()
    ]
    conn.executemany(
        """
        INSERT INTO scan_dirs (source_type, source_key, dir_relpath, dir_mtime_ns, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(source_type, source_key, dir_relpath) DO UPDATE SET
            dir_mtime_ns = excluded.dir_mtime_ns,
            updated_at = excluded.updated_at
        """,
        params,
    )

    rows = conn.execute(
        "SELECT dir_relpath FROM scan_dirs WHERE source_type = ? AND source_key = ?",
        (source_type, source_key),
    ).fetchall()
    stale = [r["dir_relpath"] for r in rows if r["dir_relpath"] not in dir_mtimes]
    if stale:
        chunk_size = 500
        for i in range(0, len(stale), chunk_size):
            chunk = stale[i:i + chunk_size]
            placeholders = ",".join(["?"] * len(chunk))
            conn.execute(
                f"DELETE FROM scan_dirs WHERE source_type = ? AND source_key = ? AND dir_relpath IN ({placeholders})",
                [source_type, source_key] + chunk,
            )
    conn.commit()
    conn.close()


# ─── Cleanup helpers ───────────────────────────────────────────────────────────

def get_cleaned_paths(source_id: str) -> set[str]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT path FROM cleanup_log WHERE source_id = ?",
        (source_id,),
    ).fetchall()
    conn.close()
    return {r["path"] for r in rows}


def get_cleanup_candidates(source_id: str) -> list[dict]:
    """Return backed-up files verified on disk that have not been cleaned yet."""
    from storage import file_exists

    cleaned = get_cleaned_paths(source_id)
    conn = get_conn()
    rows = conn.execute(
        "SELECT id, path, size, modified_time FROM files WHERE device_id = ?",
        (source_id,),
    ).fetchall()
    capture_rows = conn.execute(
        """
        SELECT relative_path, capture_time
        FROM media_index
        WHERE source_type = 'phone' AND source_key = ?
        """,
        (source_id,),
    ).fetchall()
    conn.close()

    capture_map = {r["relative_path"]: r["capture_time"] for r in capture_rows}
    candidates = []
    for row in rows:
        path = row["path"]
        if path in cleaned:
            continue
        size = row["size"]
        modified_time = row["modified_time"]
        if not is_uploaded_compatible(path, size, modified_time, device_id=source_id):
            continue
        if not file_exists(path, size, device_id=source_id):
            continue
        capture_time = capture_map.get(path)
        if capture_time is None:
            capture_time = modified_time
        candidates.append({
            "file_id": row["id"],
            "path": path,
            "size": size,
            "capture_time": capture_time,
        })
    return candidates


def log_cleanup_deletions(source_id: str, items: list[dict]) -> dict:
    """Record client-reported deletions. Returns per-file results + total bytes."""
    conn = get_conn()
    now_ts = int(_time.time())
    results = []
    total_freed = 0

    for item in items:
        path = (item.get("path") or item.get("relative_path") or "").strip()
        if not path:
            results.append({"path": "", "success": False, "error": "Missing path"})
            continue

        size = int(item.get("size") or item.get("size_bytes") or 0)
        file_id = item.get("file_id")

        if not file_id:
            row = conn.execute(
                "SELECT id FROM files WHERE device_id = ? AND path = ?",
                (source_id, path),
            ).fetchone()
            file_id = row["id"] if row else None

        existing = conn.execute(
            "SELECT 1 FROM cleanup_log WHERE source_id = ? AND path = ?",
            (source_id, path),
        ).fetchone()
        if existing:
            results.append({"path": path, "success": True, "already_logged": True})
            continue

        try:
            conn.execute(
                """
                INSERT INTO cleanup_log (file_id, source_id, path, size_bytes, deleted_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (file_id, source_id, path, size, now_ts),
            )
            total_freed += size
            results.append({"path": path, "success": True})
        except Exception as exc:
            results.append({"path": path, "success": False, "error": str(exc)})

    conn.commit()
    conn.close()
    return {"results": results, "total_bytes_freed": total_freed}


# ─── Trips helpers ─────────────────────────────────────────────────────────────

def get_trips(source_id: str) -> list[dict]:
    """Return all trip records for source_id sorted by start_time DESC, with cover details."""
    conn = get_conn()
    rows = conn.execute(
        """
        SELECT t.id, t.source_id, t.title, t.start_time, t.end_time,
               t.center_lat, t.center_lon, t.media_count, t.cover_media_id,
               t.created_at, t.updated_at,
               mi.relative_path AS cover_path, mi.source_type AS cover_source_type,
               mi.source_key AS cover_source_key
        FROM trips t
        LEFT JOIN media_index mi ON t.cover_media_id = mi.id
        WHERE t.source_id = ?
        ORDER BY t.start_time DESC
        """,
        (source_id,),
    ).fetchall()

    video_exts = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".3gp", ".m4v", ".wmv"}
    media_counts = {}
    counts_rows = conn.execute(
        """
        SELECT tm.trip_id, mi.relative_path
        FROM trip_media tm
        JOIN media_index mi ON tm.media_id = mi.id
        WHERE tm.trip_id IN (SELECT id FROM trips WHERE source_id = ?)
        """,
        (source_id,),
    ).fetchall()
    for cr in counts_rows:
        tid = cr["trip_id"]
        path = (cr["relative_path"] or "").lower()
        ext = ("." + path.rsplit(".", 1)[-1]) if "." in path else ""
        is_vid = ext in video_exts
        if tid not in media_counts:
            media_counts[tid] = [0, 0]  # [photo_count, video_count]
        if is_vid:
            media_counts[tid][1] += 1
        else:
            media_counts[tid][0] += 1

    conn.close()

    trips = []
    for r in rows:
        cover_path = r["cover_path"]
        ext = ("." + cover_path.rsplit(".", 1)[-1].lower()) if cover_path and "." in cover_path else ""
        cover_obj = None
        if cover_path:
            cover_obj = {
                "id": r["cover_media_id"],
                "relative_path": cover_path,
                "source_type": r["cover_source_type"] or "phone",
                "source_id": r["cover_source_key"] or source_id,
                "is_video": ext in video_exts,
            }
        p_cnt, v_cnt = media_counts.get(r["id"], (r["media_count"], 0))
        trips.append({
            "id": r["id"],
            "source_id": r["source_id"],
            "title": r["title"],
            "start_time": r["start_time"],
            "end_time": r["end_time"],
            "center_lat": r["center_lat"],
            "center_lon": r["center_lon"],
            "media_count": r["media_count"],
            "photo_count": p_cnt,
            "video_count": v_cnt,
            "cover_media_id": r["cover_media_id"],
            "cover": cover_obj,
            "created_at": r["created_at"],
            "updated_at": r["updated_at"],
        })
    return trips


def get_trip_media(trip_id: int) -> tuple[dict | None, list[dict]]:
    """Return the trip metadata and list of media items in the trip."""
    conn = get_conn()
    trip_row = conn.execute(
        """
        SELECT id, source_id, title, start_time, end_time,
               center_lat, center_lon, media_count, cover_media_id,
               created_at, updated_at
        FROM trips WHERE id = ?
        """,
        (trip_id,),
    ).fetchone()

    if not trip_row:
        conn.close()
        return None, []

    trip = dict(trip_row)
    media_rows = conn.execute(
        """
        SELECT mi.id, mi.source_type, mi.source_key, mi.relative_path, mi.size,
               mi.modified_time, mi.capture_time, mi.cap_lat, mi.cap_lon, mi.cap_year
        FROM trip_media tm
        JOIN media_index mi ON tm.media_id = mi.id
        WHERE tm.trip_id = ?
        ORDER BY mi.capture_time ASC, mi.relative_path ASC
        """,
        (trip_id,),
    ).fetchall()
    conn.close()

    video_exts = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".3gp", ".m4v", ".wmv"}
    media_items = []
    for r in media_rows:
        path = r["relative_path"]
        ext = ("." + path.rsplit(".", 1)[-1].lower()) if path and "." in path else ""
        media_items.append({
            "id": r["id"],
            "source_type": r["source_type"],
            "source_id": r["source_key"],
            "relative_path": r["relative_path"],
            "size": r["size"],
            "modified_time": r["modified_time"],
            "capture_time": r["capture_time"],
            "cap_lat": r["cap_lat"],
            "cap_lon": r["cap_lon"],
            "cap_year": r["cap_year"],
            "is_video": ext in video_exts,
        })

    return trip, media_items


def _haversine_distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    import math
    r = 6371.0  # Earth radius in kilometers
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return r * c


def save_trip_clusters(source_id: str, clusters: list[dict]) -> None:
    """
    Idempotently persist trip clusters for a source_id.
    Merges/updates existing trips if they match by time window and proximity,
    inserts new trips, and removes trips that no longer qualify.
    """
    conn = get_conn()
    now_ts = int(_time.time())

    # Get existing trips for this source_id
    existing_rows = conn.execute(
        "SELECT id, title, start_time, end_time, center_lat, center_lon FROM trips WHERE source_id = ?",
        (source_id,),
    ).fetchall()
    existing_trips = [dict(r) for r in existing_rows]

    matched_existing_ids = set()

    for c in clusters:
        title = c["title"]
        start_time = c["start_time"]
        end_time = c["end_time"]
        center_lat = c["center_lat"]
        center_lon = c["center_lon"]
        media_count = c["media_count"]
        cover_media_id = c.get("cover_media_id")
        media_ids = c.get("media_ids", [])

        # Look for matching existing trip: overlapping time within 48h and center within 35km
        matched_id = None
        for et in existing_trips:
            if et["id"] in matched_existing_ids:
                continue
            time_overlap = (start_time <= et["end_time"] + 172800) and (end_time >= et["start_time"] - 172800)
            if time_overlap:
                dist = _haversine_distance_km(center_lat, center_lon, et["center_lat"], et["center_lon"])
                if dist <= 35.0:
                    matched_id = et["id"]
                    matched_existing_ids.add(matched_id)
                    break

        if matched_id:
            # Update existing trip
            conn.execute(
                """
                UPDATE trips SET
                    title = ?,
                    start_time = ?,
                    end_time = ?,
                    center_lat = ?,
                    center_lon = ?,
                    media_count = ?,
                    cover_media_id = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (title, start_time, end_time, center_lat, center_lon, media_count, cover_media_id, now_ts, matched_id),
            )
            trip_id = matched_id
        else:
            # Insert new trip
            cur = conn.execute(
                """
                INSERT INTO trips (source_id, title, start_time, end_time, center_lat, center_lon,
                                   media_count, cover_media_id, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (source_id, title, start_time, end_time, center_lat, center_lon, media_count, cover_media_id, now_ts, now_ts),
            )
            trip_id = cur.lastrowid

        # Replace junction rows for trip_id
        conn.execute("DELETE FROM trip_media WHERE trip_id = ?", (trip_id,))
        if media_ids:
            trip_media_params = [(trip_id, mid) for mid in media_ids]
            conn.executemany(
                "INSERT OR IGNORE INTO trip_media (trip_id, media_id) VALUES (?, ?)",
                trip_media_params,
            )

    # Delete trips that no longer exist/qualify
    stale_ids = [et["id"] for et in existing_trips if et["id"] not in matched_existing_ids]
    if stale_ids:
        placeholders = ",".join(["?"] * len(stale_ids))
        conn.execute(f"DELETE FROM trip_media WHERE trip_id IN ({placeholders})", stale_ids)
        conn.execute(f"DELETE FROM trips WHERE id IN ({placeholders})", stale_ids)

    conn.commit()
    conn.close()


# ─── Reactions helpers ─────────────────────────────────────────────────────────

ALLOWED_REACTION_EMOJIS = frozenset({"❤️", "😂", "😮", "👍"})


def _normalize_reaction_emoji(emoji: str) -> str:
    cleaned = (emoji or "").strip()
    if cleaned == "❤":
        return "❤️"
    return cleaned


def toggle_reaction(media_id: int, source_id: str, emoji: str) -> dict:
    """Toggle a reaction on/off. Return status ('added'|'removed'), counts and user reactions."""
    emoji = _normalize_reaction_emoji(emoji)
    if emoji not in ALLOWED_REACTION_EMOJIS:
        raise ValueError("Unsupported reaction emoji")
    conn = get_conn()
    now_ts = int(_time.time())

    # Check if already exists
    existing = conn.execute(
        "SELECT id FROM reactions WHERE media_id = ? AND source_id = ? AND emoji = ?",
        (media_id, source_id, emoji),
    ).fetchone()

    if existing:
        conn.execute(
            "DELETE FROM reactions WHERE media_id = ? AND source_id = ? AND emoji = ?",
            (media_id, source_id, emoji),
        )
        status = "removed"
    else:
        conn.execute(
            "INSERT OR IGNORE INTO reactions (media_id, source_id, emoji, created_at) VALUES (?, ?, ?, ?)",
            (media_id, source_id, emoji, now_ts),
        )
        status = "added"

    conn.commit()

    # Get updated counts for media_id
    counts_rows = conn.execute(
        "SELECT emoji, COUNT(*) AS c FROM reactions WHERE media_id = ? GROUP BY emoji",
        (media_id,),
    ).fetchall()
    counts = {r["emoji"]: r["c"] for r in counts_rows}

    # Get user reactions
    user_rows = conn.execute(
        "SELECT emoji FROM reactions WHERE media_id = ? AND source_id = ?",
        (media_id, source_id),
    ).fetchall()
    user_reactions = [r["emoji"] for r in user_rows]

    conn.close()
    return {
        "status": status,
        "media_id": media_id,
        "emoji": emoji,
        "counts": counts,
        "user_reactions": user_reactions,
    }


def get_media_reactions(media_id: int) -> dict:
    """Return full reaction list and counts for a media item, with reactor display names."""
    conn = get_conn()
    rows = conn.execute(
        """
        SELECT r.id, r.media_id, r.source_id, r.emoji, r.created_at,
               d.device_name AS device_name, d.username AS username
        FROM reactions r
        LEFT JOIN devices d ON d.device_id = r.source_id
        WHERE r.media_id = ?
        ORDER BY r.created_at ASC
        """,
        (media_id,),
    ).fetchall()
    conn.close()

    reactions = [dict(r) for r in rows]
    counts: dict[str, int] = {}
    for r in reactions:
        counts[r["emoji"]] = counts.get(r["emoji"], 0) + 1

    return {
        "media_id": media_id,
        "reactions": reactions,
        "counts": counts,
    }


def get_reactions_for_media_ids(
    media_ids: list[int], current_source_id: str | None = None
) -> tuple[dict[int, dict[str, int]], dict[int, list[str]]]:
    """Bulk fetch reaction counts and current user reactions for a list of media IDs."""
    if not media_ids:
        return {}, {}

    conn = get_conn()
    counts_map: dict[int, dict[str, int]] = {}
    user_map: dict[int, list[str]] = {}

    chunk_size = 500
    for i in range(0, len(media_ids), chunk_size):
        chunk = media_ids[i:i + chunk_size]
        placeholders = ",".join(["?"] * len(chunk))

        # Fetch counts
        rows = conn.execute(
            f"SELECT media_id, emoji, COUNT(*) AS c FROM reactions WHERE media_id IN ({placeholders}) GROUP BY media_id, emoji",
            chunk,
        ).fetchall()
        for r in rows:
            mid = r["media_id"]
            counts_map.setdefault(mid, {})[r["emoji"]] = r["c"]

        # Fetch current user reactions if source_id provided
        if current_source_id:
            u_rows = conn.execute(
                f"SELECT media_id, emoji FROM reactions WHERE media_id IN ({placeholders}) AND source_id = ?",
                chunk + [current_source_id],
            ).fetchall()
            for r in u_rows:
                mid = r["media_id"]
                user_map.setdefault(mid, []).append(r["emoji"])

    conn.close()
    return counts_map, user_map


def get_or_create_media_id(
    source_type: str,
    source_key: str,
    relative_path: str,
    size: int = 0,
    modified_time: int = 0,
) -> int:
    """Return media_index.id for the given file, inserting a row if it doesn't exist."""
    conn = get_conn()
    row = conn.execute(
        "SELECT id FROM media_index WHERE source_type = ? AND source_key = ? AND relative_path = ?",
        (source_type, source_key, relative_path),
    ).fetchone()
    if row:
        mid = row["id"]
        conn.close()
        return mid

    now_ts = int(_time.time())
    cur = conn.execute(
        """
        INSERT INTO media_index (source_type, source_key, relative_path, size, modified_time, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_type, source_key, relative_path) DO NOTHING
        """,
        (source_type, source_key, relative_path, size, modified_time, now_ts),
    )
    conn.commit()
    if cur.rowcount == 1 and cur.lastrowid:
        mid = cur.lastrowid
        conn.close()
        return mid

    row2 = conn.execute(
        "SELECT id FROM media_index WHERE source_type = ? AND source_key = ? AND relative_path = ?",
        (source_type, source_key, relative_path),
    ).fetchone()
    conn.close()
    return row2["id"] if row2 else 0


# ─── Geocode Cache helpers ─────────────────────────────────────────────────────

def get_cached_geocode(lat: float, lon: float) -> str | None:
    lat_round = round(float(lat), 2)
    lon_round = round(float(lon), 2)
    conn = get_conn()
    row = conn.execute(
        "SELECT place_name FROM geocode_cache WHERE lat_round = ? AND lon_round = ?",
        (lat_round, lon_round),
    ).fetchone()
    conn.close()
    return row["place_name"] if row else None


def save_cached_geocode(lat: float, lon: float, place_name: str) -> None:
    lat_round = round(float(lat), 2)
    lon_round = round(float(lon), 2)
    conn = get_conn()
    conn.execute(
        "INSERT OR REPLACE INTO geocode_cache (lat_round, lon_round, place_name) VALUES (?, ?, ?)",
        (lat_round, lon_round, place_name),
    )
    conn.commit()
    conn.close()


# ─── Comments helpers ──────────────────────────────────────────────────────────

MAX_COMMENT_LENGTH = 2000


def add_comment(media_id: int, source_id: str, text: str) -> dict:
    """Insert a comment on a media item and return it with the commenter's device_name."""
    now_ts = int(_time.time())
    conn = get_conn()
    cur = conn.execute(
        "INSERT INTO comments (media_id, source_id, text, created_at) VALUES (?, ?, ?, ?)",
        (media_id, source_id, text, now_ts),
    )
    conn.commit()
    cid = cur.lastrowid
    row = conn.execute(
        "SELECT device_name FROM devices WHERE device_id = ? LIMIT 1",
        (source_id,),
    ).fetchone()
    conn.close()
    return {
        "id": cid,
        "media_id": media_id,
        "source_id": source_id,
        "device_name": row["device_name"] if row else None,
        "text": text,
        "created_at": now_ts,
    }


def get_comments_for_media(media_id: int) -> list[dict]:
    """Return all comments for a media item, oldest first, with commenter device_name."""
    conn = get_conn()
    rows = conn.execute(
        """
        SELECT c.id, c.media_id, c.source_id, c.text, c.created_at,
               d.device_name AS device_name, d.username AS username
        FROM comments c
        LEFT JOIN devices d ON d.device_id = c.source_id
        WHERE c.media_id = ?
        ORDER BY c.created_at ASC, c.id ASC
        """,
        (media_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_comment_counts_for_media_ids(media_ids: list[int]) -> dict[int, int]:
    """Bulk fetch comment counts for a list of media IDs (chunked to stay under SQLite's param cap)."""
    if not media_ids:
        return {}
    conn = get_conn()
    counts: dict[int, int] = {}
    chunk_size = 500
    for i in range(0, len(media_ids), chunk_size):
        chunk = media_ids[i:i + chunk_size]
        placeholders = ",".join(["?"] * len(chunk))
        rows = conn.execute(
            f"SELECT media_id, COUNT(*) AS c FROM comments WHERE media_id IN ({placeholders}) GROUP BY media_id",
            chunk,
        ).fetchall()
        for r in rows:
            counts[r["media_id"]] = r["c"]
    conn.close()
    return counts


def is_media_or_post_creator(media_id: int, device_id: str | None) -> bool:
    """Return True if device_id created the post or owns the media item."""
    if not device_id:
        return False
    conn = get_conn()
    # Check device_shares (shared_by_device_id)
    row = conn.execute(
        "SELECT 1 FROM device_shares WHERE media_id = ? AND shared_by_device_id = ? LIMIT 1",
        (media_id, device_id),
    ).fetchone()
    if row:
        conn.close()
        return True
    # Check media_index (source_type = 'device', source_key = device_id)
    row = conn.execute(
        "SELECT 1 FROM media_index WHERE id = ? AND source_type = 'device' AND source_key = ? LIMIT 1",
        (media_id, device_id),
    ).fetchone()
    conn.close()
    return bool(row)


def delete_comment(comment_id: int, source_id: str) -> bool:
    """Delete a comment if source_id is its author OR the creator of the post/media."""
    conn = get_conn()
    row = conn.execute(
        "SELECT media_id, source_id FROM comments WHERE id = ?",
        (comment_id,),
    ).fetchone()
    if not row:
        conn.close()
        return False
    media_id = row["media_id"]
    author_id = row["source_id"]
    if author_id != source_id:
        is_creator = False
        if conn.execute("SELECT 1 FROM device_shares WHERE media_id = ? AND shared_by_device_id = ? LIMIT 1", (media_id, source_id)).fetchone():
            is_creator = True
        elif conn.execute("SELECT 1 FROM media_index WHERE id = ? AND source_type = 'device' AND source_key = ? LIMIT 1", (media_id, source_id)).fetchone():
            is_creator = True
        if not is_creator:
            conn.close()
            return False

    cur = conn.execute("DELETE FROM comments WHERE id = ?", (comment_id,))
    conn.commit()
    conn.close()
    return cur.rowcount > 0


# ─── Device-to-device sharing helpers ──────────────────────────────────────────

def get_share_target_devices(exclude_device_id: str | None = None) -> list[dict]:
    """Return accepted devices as share targets. SAFE FIELDS ONLY — never expose token."""
    conn = get_conn()
    if exclude_device_id:
        rows = conn.execute(
            """
            SELECT device_id, device_name, device_model, username
            FROM devices
            WHERE status = 'accepted' AND device_id IS NOT NULL AND device_id != ?
            ORDER BY last_seen DESC
            """,
            (exclude_device_id,),
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT device_id, device_name, device_model, username
            FROM devices
            WHERE status = 'accepted' AND device_id IS NOT NULL
            ORDER BY last_seen DESC
            """
        ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def _cleanup_rewind_shared_files(share_ids: list[int]) -> None:
    """Delete persisted rewind-reel copies for the given share ids (best-effort)."""
    if not share_ids:
        return
    conn = get_conn()
    placeholders = ",".join("?" * len(share_ids))
    rows = conn.execute(
        f"SELECT relative_path FROM device_shares WHERE id IN ({placeholders}) AND source_type = 'rewind_shared'",
        share_ids,
    ).fetchall()
    conn.close()
    for r in rows:
        try:
            os.remove(r["relative_path"])
        except OSError:
            pass


def _cleanup_orphaned_media(media_ids: list[int]) -> None:
    """Delete reactions/comments for media_ids no longer referenced by any
    remaining device_shares row. media_id is a shared identity (feed + library),
    so a reaction/comment thread must only be removed once nothing still points
    at it. Must be called AFTER the owning device_shares row(s) are deleted.
    """
    unique_ids = sorted({m for m in media_ids if m is not None})
    if not unique_ids:
        return
    conn = get_conn()
    placeholders = ",".join("?" * len(unique_ids))
    still_used = {
        r["media_id"]
        for r in conn.execute(
            f"SELECT DISTINCT media_id FROM device_shares WHERE media_id IN ({placeholders})",
            unique_ids,
        ).fetchall()
    }
    orphaned = [mid for mid in unique_ids if mid not in still_used]
    if orphaned:
        o_placeholders = ",".join("?" * len(orphaned))
        conn.execute(f"DELETE FROM reactions WHERE media_id IN ({o_placeholders})", orphaned)
        conn.execute(f"DELETE FROM comments WHERE media_id IN ({o_placeholders})", orphaned)
    conn.commit()
    conn.close()


def create_device_share(
    shared_by_device_id: str,
    target_device_ids: list[str],
    caption: str | None,
    items: list[dict],
    post_kind: str | None = None,
    post_title: str | None = None,
) -> dict:
    """Create one share row per item, grouped under a single share_group_id.

    Each item is a dict with source_type, source_key, relative_path, size, modified_time.
    media_id is minted via get_or_create_media_id so feed + library share one identity.
    All items in one call share the same group_id UUID, making them appear as one post.
    """
    import uuid as _uuid

    items = [
        it for it in (items or [])
        if it.get("source_type") and it.get("source_key") and it.get("relative_path")
    ]
    targets = [t for t in (target_device_ids or []) if t and t != shared_by_device_id]
    if not items or not targets:
        return {"ok": False, "count": 0}

    conn = get_conn()
    now_ts = int(_time.time())
    cap = (caption or "").strip() or None

    # One group per share call
    group_id = str(_uuid.uuid4())
    kind = (post_kind or "").strip() or None
    title = (post_title or "").strip() or None
    conn.execute(
        "INSERT INTO device_share_groups (id, caption, shared_by_device_id, created_at, post_kind, post_title) VALUES (?, ?, ?, ?, ?, ?)",
        (group_id, cap, shared_by_device_id, now_ts, kind, title),
    )

    count = 0
    for it in items:
        source_type = it["source_type"]
        source_key = it["source_key"]
        relative_path = it["relative_path"]
        size = int(it.get("size") or 0)
        modified_time = int(it.get("modified_time") or 0)

        media_id = get_or_create_media_id(source_type, source_key, relative_path, size, modified_time)
        cur = conn.execute(
            """
            INSERT INTO device_shares
                (media_id, source_type, source_key, relative_path, size, modified_time,
                 caption, shared_by_device_id, created_at, share_group_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (media_id, source_type, source_key, relative_path, size, modified_time,
             cap, shared_by_device_id, now_ts, group_id),
        )
        share_id = cur.lastrowid
        conn.executemany(
            "INSERT OR IGNORE INTO device_share_targets (share_id, target_device_id) VALUES (?, ?)",
            [(share_id, t) for t in targets],
        )
        count += 1
    conn.commit()
    conn.close()
    return {"ok": True, "count": count, "group_id": group_id}


def edit_device_share_group_caption(group_id: str, requesting_device_id: str, caption: str | None) -> bool:
    conn = get_conn()
    row = conn.execute(
        "SELECT shared_by_device_id FROM device_share_groups WHERE id = ?",
        (group_id,),
    ).fetchone()
    if not row or row["shared_by_device_id"] != requesting_device_id:
        conn.close()
        return False
    cap = (caption or "").strip() or None
    conn.execute("UPDATE device_share_groups SET caption = ? WHERE id = ?", (cap, group_id))
    conn.execute("UPDATE device_shares SET caption = ? WHERE share_group_id = ?", (cap, group_id))
    conn.commit()
    conn.close()
    return True


def get_device_shares_for_target(target_device_id: str) -> list[dict]:
    """Return device-to-device shares delivered to a device, newest first, with group info."""
    conn = get_conn()
    rows = conn.execute(
        """
        SELECT ds.id AS share_id, ds.media_id, ds.source_type, ds.source_key,
               ds.relative_path, ds.size, ds.modified_time, ds.caption,
               ds.shared_by_device_id, ds.created_at, ds.share_group_id,
               d.device_name AS shared_by_name, d.username AS shared_by_username,
               COALESCE(dsg.caption, ds.caption) AS group_caption,
               dsg.post_kind AS post_kind, dsg.post_title AS post_title
        FROM device_share_targets t
        JOIN device_shares ds ON ds.id = t.share_id
        LEFT JOIN devices d ON d.device_id = ds.shared_by_device_id
        LEFT JOIN device_share_groups dsg ON dsg.id = ds.share_group_id
        WHERE t.target_device_id = ?
        ORDER BY ds.created_at DESC, ds.id ASC
        """,
        (target_device_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_device_shares_by_sharer(sharer_device_id: str) -> list[dict]:
    """Return device-to-device shares sent BY this device, newest first, with group info."""
    conn = get_conn()
    rows = conn.execute(
        """
        SELECT ds.id AS share_id, ds.media_id, ds.source_type, ds.source_key,
               ds.relative_path, ds.size, ds.modified_time, ds.caption,
               ds.shared_by_device_id, ds.created_at, ds.share_group_id,
               d.device_name AS shared_by_name, d.username AS shared_by_username,
               COALESCE(dsg.caption, ds.caption) AS group_caption,
               dsg.post_kind AS post_kind, dsg.post_title AS post_title
        FROM device_shares ds
        LEFT JOIN devices d ON d.device_id = ds.shared_by_device_id
        LEFT JOIN device_share_groups dsg ON dsg.id = ds.share_group_id
        WHERE ds.shared_by_device_id = ?
        ORDER BY ds.created_at DESC, ds.id ASC
        """,
        (sharer_device_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_unseen_share_notifications(target_device_id: str) -> list[dict]:
    """Return post groups shared TO this device that it has not yet been notified about."""
    conn = get_conn()
    rows = conn.execute(
        """
        SELECT dsg.id AS group_id, dsg.caption, dsg.post_kind, dsg.post_title,
               dsg.created_at, dsg.shared_by_device_id,
               d.device_name AS shared_by_name, d.username AS shared_by_username,
               COUNT(DISTINCT ds.id) AS item_count
        FROM device_share_targets t
        JOIN device_shares ds ON ds.id = t.share_id
        JOIN device_share_groups dsg ON dsg.id = ds.share_group_id
        LEFT JOIN devices d ON d.device_id = dsg.shared_by_device_id
        WHERE t.target_device_id = ? AND t.seen = 0
        GROUP BY dsg.id
        ORDER BY dsg.created_at DESC
        """,
        (target_device_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def mark_share_notifications_seen(target_device_id: str, group_ids: list[str]) -> None:
    """Mark the given post groups as seen/notified for this target device."""
    group_ids = [g for g in (group_ids or []) if g]
    if not group_ids:
        return
    conn = get_conn()
    placeholders = ",".join("?" for _ in group_ids)
    conn.execute(
        f"""
        UPDATE device_share_targets
        SET seen = 1
        WHERE target_device_id = ?
          AND share_id IN (
              SELECT ds.id FROM device_shares ds WHERE ds.share_group_id IN ({placeholders})
          )
        """,
        (target_device_id, *group_ids),
    )
    conn.commit()
    conn.close()


def get_share_targets_for_group(group_id: str, requesting_device_id: str = None) -> list[dict]:
    """Return all target devices that can see any share in a group. Owner-only if requesting_device_id is provided."""
    conn = get_conn()
    if requesting_device_id:
        row = conn.execute(
            "SELECT shared_by_device_id FROM device_share_groups WHERE id = ?",
            (group_id,),
        ).fetchone()
        if not row or row["shared_by_device_id"] != requesting_device_id:
            conn.close()
            return []
    rows = conn.execute(
        """
        SELECT DISTINCT dst.target_device_id, d.device_name, d.device_model, d.username
        FROM device_shares ds
        JOIN device_share_targets dst ON dst.share_id = ds.id
        LEFT JOIN devices d ON d.device_id = dst.target_device_id
        WHERE ds.share_group_id = ?
        """,
        (group_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def delete_device_share_group(group_id: str, requesting_device_id: str) -> bool:
    """Delete all shares belonging to a group. Only the original sharer may do this.

    Explicitly cleans up device_share_targets, device_shares, and device_share_groups.
    Returns True if rows were deleted, False if not authorized or not found.
    """
    conn = get_conn()
    row = conn.execute(
        "SELECT shared_by_device_id FROM device_share_groups WHERE id = ?",
        (group_id,),
    ).fetchone()
    if not row or row["shared_by_device_id"] != requesting_device_id:
        conn.close()
        return False
    share_ids = [
        r["id"]
        for r in conn.execute(
            "SELECT id FROM device_shares WHERE share_group_id = ?", (group_id,)
        ).fetchall()
    ]
    media_ids = [
        r["media_id"]
        for r in conn.execute(
            "SELECT media_id FROM device_shares WHERE share_group_id = ?", (group_id,)
        ).fetchall()
    ]
    if share_ids:
        placeholders = ",".join("?" * len(share_ids))
        conn.execute(f"DELETE FROM device_share_targets WHERE share_id IN ({placeholders})", share_ids)
    _cleanup_rewind_shared_files(share_ids)
    conn.execute("DELETE FROM device_shares WHERE share_group_id = ?", (group_id,))
    conn.execute("DELETE FROM device_share_groups WHERE id = ?", (group_id,))
    conn.commit()
    conn.close()
    _cleanup_orphaned_media(media_ids)
    return True


def delete_device_share(share_id: int, requesting_device_id: str) -> bool:
    """Delete a share (or its entire group if grouped). Owner-only."""
    conn = get_conn()
    row = conn.execute(
        "SELECT shared_by_device_id, share_group_id FROM device_shares WHERE id = ?",
        (share_id,),
    ).fetchone()
    if not row or row["shared_by_device_id"] != requesting_device_id:
        conn.close()
        return False
    group_id = row["share_group_id"]
    if group_id:
        conn.close()
        return delete_device_share_group(group_id, requesting_device_id)
    media_id = row["media_id"]
    conn.execute("DELETE FROM device_share_targets WHERE share_id = ?", (share_id,))
    _cleanup_rewind_shared_files([share_id])
    conn.execute("DELETE FROM device_shares WHERE id = ?", (share_id,))
    conn.commit()
    conn.close()
    _cleanup_orphaned_media([media_id])
    return True


def remove_share_group_target(group_id: str, target_device_id: str, requesting_device_id: str) -> bool:
    """Remove one target device from all shares in a group.

    Allowed if requesting_device_id is the original sharer OR if target_device_id == requesting_device_id (recipient hiding from own feed).
    Returns True if target was removed.
    """
    conn = get_conn()
    row = conn.execute(
        "SELECT shared_by_device_id FROM device_share_groups WHERE id = ?",
        (group_id,),
    ).fetchone()
    if not row:
        conn.close()
        return False
    if row["shared_by_device_id"] != requesting_device_id and target_device_id != requesting_device_id:
        conn.close()
        return False
    # Get all share_ids in this group
    share_ids = [
        r["share_id"]
        for r in conn.execute(
            "SELECT id AS share_id FROM device_shares WHERE share_group_id = ?", (group_id,)
        ).fetchall()
    ]
    if not share_ids:
        conn.close()
        return False
    placeholders = ",".join("?" * len(share_ids))
    conn.execute(
        f"DELETE FROM device_share_targets WHERE share_id IN ({placeholders}) AND target_device_id = ?",
        (*share_ids, target_device_id),
    )
    conn.commit()
    conn.close()
    return True


def add_share_group_targets(group_id: str, target_device_ids: list[str], requesting_device_id: str) -> bool:
    conn = get_conn()
    row = conn.execute(
        "SELECT shared_by_device_id FROM device_share_groups WHERE id = ?",
        (group_id,),
    ).fetchone()
    if not row or row["shared_by_device_id"] != requesting_device_id:
        conn.close()
        return False
    share_ids = [
        r["id"]
        for r in conn.execute(
            "SELECT id FROM device_shares WHERE share_group_id = ?", (group_id,)
        ).fetchall()
    ]
    targets = [t for t in (target_device_ids or []) if t and t != requesting_device_id]
    if not share_ids or not targets:
        conn.close()
        return False
    conn.executemany(
        "INSERT OR IGNORE INTO device_share_targets (share_id, target_device_id) VALUES (?, ?)",
        [(sid, t) for sid in share_ids for t in targets],
    )
    conn.commit()
    conn.close()
    return True


def remove_share_target(share_id: int, target_device_id: str, requesting_device_id: str) -> bool:
    """Remove one target device from a share. Owner or self-removal allowed."""
    conn = get_conn()
    row = conn.execute(
        "SELECT shared_by_device_id, share_group_id FROM device_shares WHERE id = ?",
        (share_id,),
    ).fetchone()
    if not row:
        conn.close()
        return False
    if row["shared_by_device_id"] != requesting_device_id and target_device_id != requesting_device_id:
        conn.close()
        return False
    group_id = row["share_group_id"]
    if group_id:
        conn.close()
        return remove_share_group_target(group_id, target_device_id, requesting_device_id)
    conn.execute(
        "DELETE FROM device_share_targets WHERE share_id = ? AND target_device_id = ?",
        (share_id, target_device_id),
    )
    conn.commit()
    conn.close()
    return True


def get_device_share_by_id(share_id: int) -> dict | None:
    """Return a single device share row (for serving/authorization), or None."""
    conn = get_conn()
    row = conn.execute(
        """
        SELECT id AS share_id, media_id, source_type, source_key, relative_path,
               size, modified_time, caption, shared_by_device_id, created_at, share_group_id
        FROM device_shares WHERE id = ?
        """,
        (share_id,),
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def is_share_target(share_id: int, device_id: str) -> bool:
    """Return True if device_id is a delivery target of the given share."""
    conn = get_conn()
    row = conn.execute(
        "SELECT 1 FROM device_share_targets WHERE share_id = ? AND target_device_id = ? LIMIT 1",
        (share_id, device_id),
    ).fetchone()
    conn.close()
    return row is not None