import sqlite3
from config import DB_PATH


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_conn()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL,
            size INTEGER NOT NULL,
            modified_time INTEGER NOT NULL,
            uploaded_time INTEGER NOT NULL,
            UNIQUE(path, size, modified_time)
        )
        """
    )
    conn.commit()
    conn.close()


def is_uploaded(path, size, modified_time):
    conn = get_conn()
    row = conn.execute(
        "SELECT 1 FROM files WHERE path=? AND size=? AND modified_time=?",
        (path, size, modified_time),
    ).fetchone()
    conn.close()
    return row is not None


def insert_file(path, size, modified_time, uploaded_time):
    conn = get_conn()
    conn.execute(
        "INSERT OR IGNORE INTO files (path, size, modified_time, uploaded_time) VALUES (?, ?, ?, ?)",
        (path, size, modified_time, uploaded_time),
    )
    conn.commit()
    conn.close()
