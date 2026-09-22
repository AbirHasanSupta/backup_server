"""Regression tests for concurrent PostgreSQL schema initialization."""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

from database_pg import init_pg_db


class PostgreSQLSchemaInitializationTests(unittest.TestCase):
    def test_schema_initialization_takes_the_advisory_lock_first(self) -> None:
        cursor = MagicMock()
        cursor_context = MagicMock()
        cursor_context.__enter__.return_value = cursor

        connection = MagicMock()
        connection.cursor.return_value = cursor_context
        connection_context = MagicMock()
        connection_context.__enter__.return_value = connection

        with patch("database_pg.get_pg_connection", return_value=connection_context):
            init_pg_db()

        self.assertEqual(
            cursor.execute.call_args_list[0].args[0],
            "SELECT pg_advisory_xact_lock(486795553)",
        )
        connection.commit.assert_called_once()


if __name__ == "__main__":
    unittest.main()
