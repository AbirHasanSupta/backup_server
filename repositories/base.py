"""repositories/base.py — Unified SQL Execution Layer for SQLite & PostgreSQL."""

from __future__ import annotations

import contextlib
import logging
from typing import Any, Dict, List, Tuple
from core.config import load_config
from database import get_conn, get_read_conn

logger = logging.getLogger("backup_server.repositories")


def is_postgres() -> bool:
    return load_config().get("DATABASE_BACKEND") == "postgres"


def _adapt_sql(sql: str) -> str:
    """Adapt SQL placeholder format between SQLite (?) and PostgreSQL (%s)."""
    if is_postgres():
        return sql.replace("?", "%s")
    return sql


def execute_read_query(sql: str, params: Tuple | List = ()) -> List[Dict[str, Any]]:
    """Execute read-only SQL query and return list of dictionaries."""
    adapted_sql = _adapt_sql(sql)
    if is_postgres():
        try:
            from database_pg import get_pg_connection
            with get_pg_connection() as conn:
                with conn.cursor() as cur:
                    cur.execute(adapted_sql, params)
                    cols = [desc[0] for desc in cur.description] if cur.description else []
                    rows = cur.fetchall()
                    return [dict(zip(cols, row)) for row in rows]
        except Exception as exc:
            logger.warning("PostgreSQL read failed (%s), falling back to SQLite", exc)

    conn = get_read_conn()
    try:
        cur = conn.execute(sql, params)
        rows = cur.fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def execute_read_one(sql: str, params: Tuple | List = ()) -> Dict[str, Any] | None:
    """Execute read-only SQL query and return single row dict or None."""
    results = execute_read_query(sql, params)
    return results[0] if results else None


def execute_write(sql: str, params: Tuple | List = ()) -> int:
    """Execute write SQL statement and commit. Returns affected row count."""
    adapted_sql = _adapt_sql(sql)
    if is_postgres():
        try:
            from database_pg import get_pg_connection
            with get_pg_connection() as conn:
                with conn.cursor() as cur:
                    cur.execute(adapted_sql, params)
                    rowcount = cur.rowcount
                conn.commit()
                return rowcount
        except Exception as exc:
            logger.warning("PostgreSQL write failed (%s), falling back to SQLite", exc)

    conn = get_conn()
    try:
        cur = conn.execute(sql, params)
        conn.commit()
        return cur.rowcount
    finally:
        conn.close()
