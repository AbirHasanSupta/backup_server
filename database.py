import sqlite3
import time as _time
from config import DB_PATH


def get_conn():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


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
            CREATE TABLE devices (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id      TEXT    UNIQUE,
                device_name    TEXT    NOT NULL,
                device_ip      TEXT    NOT NULL,
                status         TEXT    NOT NULL DEFAULT 'accepted',
                first_seen     INTEGER NOT NULL,
                last_seen      INTEGER NOT NULL,
                files_backed_up INTEGER NOT NULL DEFAULT 0
            )
        """)
        # Copy data, handle missing device_id by using device_ip as fallback
        conn.execute("""
            INSERT OR IGNORE INTO devices (id, device_id, device_name, device_ip, status, first_seen, last_seen, files_backed_up)
            SELECT id, COALESCE(device_id, device_ip), device_name, device_ip, status, first_seen, last_seen, files_backed_up
            FROM devices_old
        """)
        conn.execute("DROP TABLE devices_old")

    # 2. Create devices table if not exists
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS devices (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id      TEXT    UNIQUE,
            device_name    TEXT    NOT NULL,
            device_ip      TEXT    NOT NULL,
            status         TEXT    NOT NULL DEFAULT 'accepted',
            first_seen     INTEGER NOT NULL,
            last_seen      INTEGER NOT NULL,
            files_backed_up INTEGER NOT NULL DEFAULT 0
        )
        """
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
            CREATE TABLE files (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id     TEXT,
                external_id   TEXT,
                path          TEXT    NOT NULL,
                size          INTEGER NOT NULL,
                modified_time INTEGER NOT NULL,
                sha256        TEXT,
                uploaded_time INTEGER NOT NULL,
                device_ip     TEXT,
                UNIQUE(device_id, path)
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
        CREATE TABLE IF NOT EXISTS files (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id     TEXT,
            external_id   TEXT,
            path          TEXT    NOT NULL,
            size          INTEGER NOT NULL,
            modified_time INTEGER NOT NULL,
            sha256        TEXT,
            uploaded_time INTEGER NOT NULL,
            device_ip     TEXT,
            UNIQUE(device_id, path)
        )
        """
    )

    # Ensure indexes exist
    conn.execute("CREATE INDEX IF NOT EXISTS idx_files_path_meta ON files(path, size, modified_time)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_files_device_path ON files(device_id, path)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_files_device_ip ON files(device_ip)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_devices_status_seen ON devices(status, last_seen)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_devices_device_id ON devices(device_id)")

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
    
    # Check by (device_id, path) - most efficient if device_id is present
    device_groups = {}
    for item in items:
        did = item.get("device_id") or ""
        if did not in device_groups:
            device_groups[did] = []
        device_groups[did].append(item)
    
    for did, group in device_groups.items():
        paths = [i["path"] for i in group]
        placeholders = ",".join(["?"] * len(paths))
        if did:
            # Check with device_id OR where device_id is NULL (for legacy migration)
            rows = conn.execute(
                f"SELECT path, size, modified_time, external_id FROM files WHERE (device_id=? OR device_id IS NULL) AND path IN ({placeholders})",
                [did] + paths
            ).fetchall()
        else:
            rows = conn.execute(
                f"SELECT path, size, modified_time, external_id FROM files WHERE device_id IS NULL AND path IN ({placeholders})",
                paths
            ).fetchall()
            
        # Match rows back to items
        row_map = {} # path -> list of rows
        eid_map = {} # external_id -> list of rows
        for r in rows:
            p = (r["path"] or "").replace("\\", "/")
            if p not in row_map: row_map[p] = []
            row_map[p].append(r)
            if r["external_id"]:
                if r["external_id"] not in eid_map: eid_map[r["external_id"]] = []
                eid_map[r["external_id"]].append(r)
            
        for item in group:
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
                # We use the ORIGINAL item["path"] for the key to match what upload.py expects,
                # but it should be consistent anyway.
                present_keys.add(f"{item['path']}|{m}|{s}")

    conn.close()
    return present_keys


def insert_file(path, size, modified_time, uploaded_time, device_ip=None, external_id=None, sha256=None, device_id=None):
    conn = get_conn()
    path = (path or "").replace("\\", "/")
    # If we have device_id, we can use it for a more specific update
    if device_id:
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

def upsert_device(device_name: str, device_ip: str, device_id: str | None = None) -> None:
    """Insert a new device or update its name/last_seen."""
    now = int(_time.time())
    conn = get_conn()
    if device_id:
        conn.execute(
            """
            INSERT INTO devices (device_id, device_name, device_ip, status, first_seen, last_seen)
            VALUES (?, ?, ?, 'accepted', ?, ?)
            ON CONFLICT(device_id) DO UPDATE SET
                device_name = excluded.device_name,
                device_ip   = excluded.device_ip,
                last_seen   = excluded.last_seen,
                status      = 'accepted'
            """,
            (device_id, device_name, device_ip, now, now),
        )
    else:
        # Legacy fallback: try to update by IP if device_id is missing
        res = conn.execute("UPDATE devices SET device_name=?, last_seen=? WHERE device_ip=? AND device_id IS NULL", 
                         (device_name, now, device_ip))
        if res.rowcount == 0:
            conn.execute(
                """
                INSERT INTO devices (device_name, device_ip, status, first_seen, last_seen)
                VALUES (?, ?, 'accepted', ?, ?)
                """,
                (device_name, device_ip, now, now),
            )
    conn.commit()
    conn.close()
    
    # Recalculate file count immediately
    touch_device(device_ip, device_id)


def touch_device(device_ip: str, device_id: str | None = None, files_delta: int = 1) -> None:
    """Update last_seen timestamp and recalculate file counter for a device."""
    now = int(_time.time())
    conn = get_conn()
    
    # If device_id is missing, try to resolve it from the devices table
    if not device_id:
        row = conn.execute("SELECT device_id FROM devices WHERE device_ip = ? AND device_id IS NOT NULL LIMIT 1", (device_ip,)).fetchone()
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
