"""Regression coverage for SQLite-to-Postgres trip-media migration."""

from __future__ import annotations

import contextlib
import io
import os
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from scripts import migrate_sqlite_to_postgres as migration


class _Cursor:
    def __init__(self, connection: "_Connection") -> None:
        self.connection = connection

    def __enter__(self) -> "_Cursor":
        return self

    def __exit__(self, *_args) -> None:
        return None

    def executemany(self, sql, rows, returning=False) -> None:
        self.connection.batches.append((sql, list(rows)))

    def execute(self, sql, params=None) -> None:
        self.connection.statements.append((sql, params))


class _Connection:
    def __init__(self) -> None:
        self.batches: list[tuple[str, list[list[object]]]] = []
        self.statements: list[tuple[str, object]] = []

    def cursor(self) -> _Cursor:
        return _Cursor(self)

    def commit(self) -> None:
        return None

    def rollback(self) -> None:
        return None


class TripMediaMigrationTests(unittest.TestCase):
    def test_trip_media_uses_the_linked_media_index_values(self) -> None:
        """Migrated rows retain distinct source/path keys instead of blanks."""
        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as tmp:
            path = tmp.name
        self.addCleanup(lambda: os.path.exists(path) and os.unlink(path))

        db = sqlite3.connect(path)
        db.executescript(
            """
            CREATE TABLE media_index (
                id INTEGER PRIMARY KEY,
                source_type TEXT NOT NULL,
                source_key TEXT NOT NULL,
                relative_path TEXT NOT NULL,
                size INTEGER NOT NULL,
                modified_time INTEGER NOT NULL,
                capture_time INTEGER,
                capture_source TEXT,
                cap_month INTEGER,
                cap_day INTEGER,
                cap_year INTEGER,
                indexed_at INTEGER NOT NULL,
                cap_lat REAL,
                cap_lon REAL,
                gps_checked INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE trip_media (trip_id INTEGER NOT NULL, media_id INTEGER NOT NULL);
            """
        )
        db.executemany(
            "INSERT INTO media_index VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (101, "phone", "device-a", "DCIM/a.jpg", 1, 2, 3, None, None, None, None, 4, None, None, 0),
                (102, "shared", "shared-1", "Albums/b.jpg", 5, 6, 7, None, None, None, None, 8, None, None, 0),
            ],
        )
        db.executemany("INSERT INTO trip_media VALUES (?, ?)", [(9, 101), (9, 102)])
        db.commit()
        db.close()

        pg = _Connection()
        # The migration emits progress glyphs that the Windows cp1252 test
        # console cannot encode, so keep its normal output out of this test.
        with contextlib.redirect_stdout(io.StringIO()):
            migration._migrate_one_db(path, pg, label="fixture")

        trip_batches = [rows for sql, rows in pg.batches if "INSERT INTO trip_media" in sql]
        self.assertEqual(len(trip_batches), 1)
        self.assertTrue(
            any("DELETE FROM trip_media" in sql for sql, _params in pg.statements),
            "A rerun must remove the legacy blank placeholder rows before import.",
        )
        self.assertEqual(
            trip_batches[0],
            [
                [9, 101, "phone", "device-a", "DCIM/a.jpg", 3],
                [9, 102, "shared", "shared-1", "Albums/b.jpg", 7],
            ],
        )


if __name__ == "__main__":
    unittest.main()
