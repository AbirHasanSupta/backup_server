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

    # ── Files table ──────────────────────────────────────────────────────────
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS files (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            path          TEXT    NOT NULL,
            size          INTEGER NOT NULL,
            modified_time INTEGER NOT NULL,
            uploaded_time INTEGER NOT NULL,
            device_ip     TEXT,
            UNIQUE(path, size, modified_time)
        )
        """
    )

    # ── Devices table ────────────────────────────────────────────────────────
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS devices (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            device_name    TEXT    NOT NULL,
            device_ip      TEXT    NOT NULL UNIQUE,
            status         TEXT    NOT NULL DEFAULT 'accepted',
            first_seen     INTEGER NOT NULL,
            last_seen      INTEGER NOT NULL,
            files_backed_up INTEGER NOT NULL DEFAULT 0
        )
        """
    )

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_files_path_meta "
        "ON files(path, size, modified_time)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_devices_status_seen "
        "ON devices(status, last_seen)"
    )

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


def is_uploaded_compatible(path, size, modified_time):
    conn = get_conn()
    if modified_time:
        row = conn.execute(
            "SELECT 1 FROM files WHERE path=? AND size=? AND modified_time=?",
            (path, size, modified_time),
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT 1 FROM files WHERE path=? AND size=?",
            (path, size),
        ).fetchone()
    conn.close()
    return row is not None


def insert_file(path, size, modified_time, uploaded_time, device_ip=None):
    conn = get_conn()
    conn.execute(
        "INSERT OR IGNORE INTO files (path, size, modified_time, uploaded_time, device_ip)"
        " VALUES (?, ?, ?, ?, ?)",
        (path, size, modified_time, uploaded_time, device_ip),
    )
    conn.commit()
    conn.close()


def get_stats():
    conn = get_conn()
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


# ─── Device helpers ────────────────────────────────────────────────────────────

def upsert_device(device_name: str, device_ip: str) -> None:
    """Insert a new device or update its name/last_seen if the IP already exists."""
    now = int(_time.time())
    conn = get_conn()
    conn.execute(
        """
        INSERT INTO devices (device_name, device_ip, status, first_seen, last_seen)
        VALUES (?, ?, 'accepted', ?, ?)
        ON CONFLICT(device_ip) DO UPDATE SET
            device_name = excluded.device_name,
            last_seen   = excluded.last_seen,
            status      = 'accepted'
        """,
        (device_name, device_ip, now, now),
    )
    conn.commit()
    conn.close()


def touch_device(device_ip: str, files_delta: int = 1) -> None:
    """Update last_seen timestamp and increment file counter for a device."""
    now = int(_time.time())
    conn = get_conn()
    conn.execute(
        """
        UPDATE devices
        SET last_seen = ?, files_backed_up = files_backed_up + ?
        WHERE device_ip = ?
        """,
        (now, files_delta, device_ip),
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


def is_device_known(device_ip: str) -> bool:
    conn = get_conn()
    row = conn.execute(
        "SELECT 1 FROM devices WHERE device_ip=? AND status='accepted'",
        (device_ip,),
    ).fetchone()
    conn.close()
    return row is not None
