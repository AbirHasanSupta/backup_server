"""repositories/reels_repo.py — Reels Feed, Bookmarking, Reposts & Telemetry Repository."""

from __future__ import annotations

import time
from typing import Any, Dict, List, Set, Tuple
from repositories.base import execute_read_one, execute_read_query, execute_write, is_postgres
from database import (
    get_or_create_media_id as db_get_or_create_media_id,
    get_or_create_library_reel_share as db_get_or_create_library_reel_share,
    bulk_get_or_create_library_reel_shares as db_bulk_get_or_create_library_reel_shares,
    save_reel as db_save_reel,
    unsave_reel as db_unsave_reel,
    toggle_save_reel as db_toggle_save_reel,
    get_saved_reel_ids as db_get_saved_reel_ids,
    get_saved_reels as db_get_saved_reels,
    get_liked_reels as db_get_liked_reels,
    get_reposted_reels as db_get_reposted_reels,
    repost_reel as db_repost_reel,
    cancel_repost as db_cancel_repost,
    get_repost_counts_for_media_ids as db_get_repost_counts_for_media_ids,
    get_user_reposted_media_ids as db_get_user_reposted_media_ids,
    get_user_reposted_info as db_get_user_reposted_info,
    get_reel_view_counts as db_get_reel_view_counts,
    get_reel_durations as db_get_reel_durations,
    record_reel_telemetry as db_record_reel_telemetry,
)


_VIDEO_PATH_PATTERNS = ("%.mp4", "%.mov", "%.avi", "%.mkv", "%.webm", "%.3gp", "%.m4v", "%.wmv")
RECENT_WATCH_WINDOW_SECONDS = 30 * 24 * 60 * 60


def get_indexed_shared_video_candidates(
    source_keys: str | List[str],
    limit: int | None = None,
    offset: int = 0,
) -> List[Dict[str, Any]]:
    """Read a shared-folder reel catalog from ``media_index`` instead of walking the mount.

    Bind-mounted Windows folders have high metadata latency in Docker.  The
    leader-elected memory index already maintains this catalog, so scrolling
    should be a database read, not another recursive filesystem scan.
    """
    keys = [str(source_keys)] if isinstance(source_keys, str) else [str(key) for key in source_keys if key]
    if is_postgres() and keys:
        path_predicates = " OR ".join(["LOWER(relative_path) LIKE ?"] * len(_VIDEO_PATH_PATTERNS))
        key_placeholders = ", ".join(["?"] * len(keys))
        sql = f"""
            SELECT source_key, relative_path AS path, size, modified_time
            FROM media_index
            WHERE source_type = ? AND source_key IN ({key_placeholders}) AND ({path_predicates})
            ORDER BY modified_time DESC, source_key ASC, relative_path ASC
        """
        params: tuple[Any, ...] = ("shared", *keys, *_VIDEO_PATH_PATTERNS)
        if limit is not None:
            sql += " LIMIT ? OFFSET ?"
            params += (max(1, int(limit)), max(0, int(offset)))
        return execute_read_query(sql, params)
    return []


def get_or_create_media_id(source_type: str, source_key: str, relative_path: str, cap_time: int | None = None) -> int:
    if is_postgres():
        row = execute_read_one(
            "SELECT id FROM media_index WHERE source_type = ? AND source_key = ? AND relative_path = ?",
            (source_type, source_key, relative_path),
        )
        if row:
            return row["id"]
        now = int(time.time())
        execute_write(
            "INSERT INTO media_index (source_type, source_key, relative_path, size, modified_time, cap_time, indexed_at) VALUES (?, ?, ?, 0, 0, ?, ?) ON CONFLICT DO NOTHING",
            (source_type, source_key, relative_path, cap_time, now),
        )
        row = execute_read_one(
            "SELECT id FROM media_index WHERE source_type = ? AND source_key = ? AND relative_path = ?",
            (source_type, source_key, relative_path),
        )
        return row["id"] if row else 0
    return db_get_or_create_media_id(source_type, source_key, relative_path, cap_time)


def bulk_get_or_create_library_reel_shares(candidates: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not candidates:
        return []
    if is_postgres():
        # PostgreSQL limits a single statement to 65,535 bind parameters.  The
        # catalog CTE uses six values per item, so split exceptionally large
        # libraries before constructing it.
        catalog_batch_size = 5_000
        if len(candidates) > catalog_batch_size:
            materialized: list[dict] = []
            for start in range(0, len(candidates), catalog_batch_size):
                materialized.extend(
                    bulk_get_or_create_library_reel_shares(candidates[start:start + catalog_batch_size])
                )
            return materialized
        # Catalog refreshes may contain thousands of videos.  The old loop did
        # up to five queries plus a commit per candidate, turning a first
        # scroll into thousands of network round trips.  One transaction also
        # makes materialization atomic from the caller's perspective.
        from database_pg import get_pg_connection

        now = int(time.time())
        normalized: list[tuple[str, str, str, int, int, int]] = []
        originals: dict[tuple[str, str, str], dict] = {}
        for candidate in candidates:
            source_type = str(candidate.get("source_type") or "")
            source_key = str(candidate.get("source_key") or "")
            relative_path = str(candidate.get("path") or candidate.get("relative_path") or "")
            if not source_type or not source_key or not relative_path:
                continue
            size = int(candidate.get("size") or 0)
            modified = int(candidate.get("modified_time") or 0)
            key = (source_type, source_key, relative_path)
            # A source can be listed twice by a misconfigured share; do not
            # manufacture duplicate shares for it.
            if key in originals:
                continue
            originals[key] = candidate
            normalized.append((source_type, source_key, relative_path, size, modified, modified or now))

        if not normalized:
            return []

        placeholders = ", ".join(["(%s, %s, %s, %s, %s, %s)"] * len(normalized))
        flat_params: list[Any] = [value for row in normalized for value in row]
        catalog_sql = (
            "WITH catalog(source_type, source_key, relative_path, size, modified_time, created_at) AS "
            f"(VALUES {placeholders}) "
        )

        with get_pg_connection() as conn:
            with conn.cursor() as cur:
                # This lock is held only while filling missing catalog rows.
                # It prevents two Gunicorn workers from both observing a
                # missing pre-existing library row and inserting it.
                cur.execute("SELECT pg_advisory_xact_lock(619830211)")
                cur.execute(
                    catalog_sql
                    + """
                    INSERT INTO media_index
                        (source_type, source_key, relative_path, size, modified_time, indexed_at)
                    SELECT source_type, source_key, relative_path, size, modified_time, %s
                    FROM catalog
                    ON CONFLICT(source_type, source_key, relative_path) DO UPDATE SET
                        size = EXCLUDED.size,
                        modified_time = EXCLUDED.modified_time,
                        indexed_at = EXCLUDED.indexed_at
                    """,
                    (*flat_params, now),
                )
                cur.execute(
                    catalog_sql
                    + """
                    INSERT INTO device_shares
                        (media_id, source_type, source_key, relative_path, size, modified_time,
                         shared_by_device_id, created_at, is_library_reel)
                    SELECT mi.id, c.source_type, c.source_key, c.relative_path, c.size, c.modified_time,
                           'library:' || c.source_type || ':' || c.source_key, c.created_at, 1
                    FROM catalog c
                    JOIN media_index mi ON mi.source_type = c.source_type
                        AND mi.source_key = c.source_key AND mi.relative_path = c.relative_path
                    LEFT JOIN device_shares ds ON ds.is_library_reel = 1
                        AND ds.source_type = c.source_type AND ds.source_key = c.source_key
                        AND ds.relative_path = c.relative_path
                    WHERE ds.share_id IS NULL
                    """,
                    flat_params,
                )
                cur.execute(
                    catalog_sql
                    + """
                    SELECT DISTINCT ON (c.source_type, c.source_key, c.relative_path)
                           c.source_type, c.source_key, c.relative_path,
                           ds.share_id, ds.media_id, ds.created_at
                    FROM catalog c
                    JOIN device_shares ds ON ds.is_library_reel = 1
                        AND ds.source_type = c.source_type AND ds.source_key = c.source_key
                        AND ds.relative_path = c.relative_path
                    ORDER BY c.source_type, c.source_key, c.relative_path, ds.share_id ASC
                    """,
                    flat_params,
                )
                rows = cur.fetchall()
            conn.commit()

        results = []
        for source_type, source_key, relative_path, share_id, media_id, created_at in rows:
            original = originals[(source_type, source_key, relative_path)]
            results.append({
                **original,
                "share_id": share_id,
                "media_id": media_id,
                "created_at": created_at,
            })
        return results
def get_or_create_library_reel_share(source_type: str, source_key: str, relative_path: str, size: int = 0, modified_time: int = 0) -> Dict[str, Any]:
    res = bulk_get_or_create_library_reel_shares([{"source_type": source_type, "source_key": source_key, "relative_path": relative_path, "size": size, "modified_time": modified_time}])
    return res[0] if res else {}


def save_reel(device_id: str, reel_id: str, share_id: int, media_id: int | None = None) -> bool:
    if is_postgres():
        now = int(time.time())
        execute_write(
            """
            INSERT INTO saved_reels (device_id, reel_id, share_id, media_id, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(device_id, reel_id) DO UPDATE SET
                share_id = EXCLUDED.share_id,
                media_id = COALESCE(EXCLUDED.media_id, saved_reels.media_id)
            """,
            (device_id, reel_id, share_id, media_id, now),
        )
        return True
    return db_save_reel(device_id, reel_id, share_id, media_id)


def unsave_reel(device_id: str, reel_id: str) -> bool:
    if is_postgres():
        n = execute_write("DELETE FROM saved_reels WHERE device_id = ? AND reel_id = ?", (device_id, str(reel_id)))
        return n > 0
    return db_unsave_reel(device_id, reel_id)


def toggle_save_reel(device_id: str, reel_id: str, share_id: int, media_id: int | None = None) -> bool:
    if is_postgres():
        row = execute_read_one("SELECT id FROM saved_reels WHERE device_id = ? AND reel_id = ?", (device_id, reel_id))
        if row:
            execute_write("DELETE FROM saved_reels WHERE id = ?", (row["id"],))
            return False
        now = int(time.time())
        execute_write(
            "INSERT INTO saved_reels (device_id, reel_id, share_id, media_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
            (device_id, reel_id, share_id, media_id, now),
        )
        return True
    return db_toggle_save_reel(device_id, reel_id, share_id, media_id)


def get_saved_reel_ids(device_id: str) -> Set[str]:
    if is_postgres():
        rows = execute_read_query("SELECT reel_id FROM saved_reels WHERE device_id = ?", (device_id,))
        return {r["reel_id"] for r in rows}
    return db_get_saved_reel_ids(device_id)


def get_saved_reels(device_id: str, offset: int = 0, limit: int = 50) -> List[Dict[str, Any]]:
    if is_postgres():
        sql = """
        SELECT sr.reel_id, sr.created_at AS saved_at,
               ds.share_id, ds.media_id, ds.source_type, ds.source_key,
               ds.relative_path, ds.size, ds.modified_time, ds.caption,
               ds.shared_by_device_id, ds.created_at, ds.share_group_id,
               ds.original_shared_by_device_id, ds.repost_of_share_id, ds.is_library_reel,
               d.device_name AS shared_by_name, d.username AS shared_by_username,
               orig_d.device_name AS orig_shared_by_name, orig_d.username AS orig_shared_by_username,
               COALESCE(dsg.caption, ds.caption) AS group_caption,
               dsg.post_kind AS post_kind, dsg.post_title AS post_title
        FROM saved_reels sr
        JOIN device_shares ds ON ds.share_id = sr.share_id
        LEFT JOIN devices d ON d.device_id = ds.shared_by_device_id
        LEFT JOIN devices orig_d ON orig_d.device_id = ds.original_shared_by_device_id
        LEFT JOIN device_share_groups dsg ON dsg.group_id = ds.share_group_id
        WHERE sr.device_id = ?
          AND (
            ds.is_library_reel = 1
            OR (
              ds.shared_by_device_id != ?
              AND (ds.original_shared_by_device_id IS NULL OR ds.original_shared_by_device_id != ?)
              AND EXISTS (SELECT 1 FROM device_share_targets dst WHERE dst.share_id = ds.share_id AND dst.target_device_id = ?)
            )
          )
        ORDER BY sr.created_at DESC
        LIMIT ? OFFSET ?
        """
        return execute_read_query(sql, (device_id, device_id, device_id, device_id, limit, offset))
    return db_get_saved_reels(device_id, offset, limit)


def get_liked_reels(device_id: str, offset: int = 0, limit: int = 50) -> List[Dict[str, Any]]:
    if is_postgres():
        sql = """
        SELECT ds.share_id, ds.share_id AS reel_id, MAX(r.created_at) AS liked_at, '❤️' AS liked_emoji,
               ds.media_id, ds.source_type, ds.source_key, ds.relative_path,
               ds.size, ds.modified_time, ds.caption, ds.shared_by_device_id,
               ds.created_at, ds.share_group_id,
               ds.original_shared_by_device_id, ds.repost_of_share_id, ds.is_library_reel,
               d.device_name AS shared_by_name, d.username AS shared_by_username,
               orig_d.device_name AS orig_shared_by_name, orig_d.username AS orig_shared_by_username,
               COALESCE(dsg.caption, ds.caption) AS group_caption,
               dsg.post_kind AS post_kind, dsg.post_title AS post_title
        FROM reactions r
        JOIN device_shares ds ON ds.media_id = r.media_id
        LEFT JOIN devices d ON d.device_id = ds.shared_by_device_id
        LEFT JOIN devices orig_d ON orig_d.device_id = ds.original_shared_by_device_id
        LEFT JOIN device_share_groups dsg ON dsg.group_id = ds.share_group_id
        WHERE r.source_id = ?
          AND r.scope = 'reel'
          AND (
            ds.is_library_reel = 1
            OR (
              ds.shared_by_device_id != ?
              AND (ds.original_shared_by_device_id IS NULL OR ds.original_shared_by_device_id != ?)
              AND EXISTS (SELECT 1 FROM device_share_targets dst WHERE dst.share_id = ds.share_id AND dst.target_device_id = ?)
            )
          )
        GROUP BY ds.share_id, ds.media_id, ds.source_type, ds.source_key, ds.relative_path, ds.size, ds.modified_time,
                 ds.caption, ds.shared_by_device_id, ds.created_at, ds.share_group_id,
                 ds.original_shared_by_device_id, ds.repost_of_share_id, ds.is_library_reel,
                 d.device_name, d.username, orig_d.device_name, orig_d.username, dsg.caption, dsg.post_kind, dsg.post_title
        ORDER BY liked_at DESC
        LIMIT ? OFFSET ?
        """
        return execute_read_query(sql, (device_id, device_id, device_id, device_id, limit, offset))
    return db_get_liked_reels(device_id, offset, limit)


def get_reposted_reels(device_id: str, offset: int = 0, limit: int = 50) -> List[Dict[str, Any]]:
    if is_postgres():
        sql = """
        SELECT ds.share_id, ds.share_id AS reel_id, ds.created_at AS reposted_at,
               ds.media_id, ds.source_type, ds.source_key, ds.relative_path,
               ds.size, ds.modified_time, ds.caption, ds.shared_by_device_id,
               ds.created_at, ds.share_group_id,
               ds.original_shared_by_device_id, ds.repost_of_share_id,
               d.device_name AS shared_by_name, d.username AS shared_by_username,
               orig_d.device_name AS orig_shared_by_name, orig_d.username AS orig_shared_by_username,
               COALESCE(dsg.caption, ds.caption) AS group_caption,
               dsg.post_kind AS post_kind, dsg.post_title AS post_title
        FROM device_shares ds
        JOIN device_share_groups dsg ON dsg.group_id = ds.share_group_id
        LEFT JOIN devices d ON d.device_id = ds.shared_by_device_id
        LEFT JOIN devices orig_d ON orig_d.device_id = ds.original_shared_by_device_id
        WHERE ds.shared_by_device_id = ?
          AND dsg.post_kind = 'reel_repost'
          AND (ds.original_shared_by_device_id IS NOT NULL AND ds.original_shared_by_device_id != ?)
        ORDER BY ds.created_at DESC
        LIMIT ? OFFSET ?
        """
        return execute_read_query(sql, (device_id, device_id, limit, offset))
    return db_get_reposted_reels(device_id, offset, limit)


def repost_reel(device_id: str, share_id: int, target_device_ids: List[str], caption: str | None = None) -> Dict[str, Any]:
    if is_postgres():
        import uuid as _uuid
        orig = execute_read_one(
            """
            SELECT ds.media_id, ds.source_type, ds.source_key, ds.relative_path,
                   ds.size, ds.modified_time, ds.caption, ds.shared_by_device_id,
                   ds.original_shared_by_device_id, ds.is_library_reel
            FROM device_shares ds
            WHERE ds.share_id = ?
            """,
            (int(share_id),),
        )
        if not orig:
            return {"ok": False, "error": "Reel to repost was not found."}

        orig_creator_id = orig["original_shared_by_device_id"] or orig["shared_by_device_id"]
        if orig["shared_by_device_id"] == device_id or orig_creator_id == device_id:
            return {"ok": False, "error": "You cannot repost your own reel."}

        valid_targets = [t for t in target_device_ids if t and t != device_id and t != orig_creator_id]
        if not valid_targets:
            return {"ok": False, "error": "No valid target devices selected for repost."}

        now_ts = int(time.time())
        group_id = str(_uuid.uuid4())
        execute_write(
            """
            INSERT INTO device_share_groups (group_id, shared_by_device_id, caption, created_at, post_kind)
            VALUES (?, ?, ?, ?, 'reel_repost')
            """,
            (group_id, device_id, caption or orig["caption"], now_ts),
        )

        execute_write(
            """
            INSERT INTO device_shares
                (media_id, source_type, source_key, relative_path, size, modified_time,
                 caption, shared_by_device_id, created_at, share_group_id,
                 original_shared_by_device_id, repost_of_share_id, is_library_reel)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            """,
            (
                orig["media_id"],
                orig["source_type"],
                orig["source_key"],
                orig["relative_path"],
                orig["size"],
                orig["modified_time"],
                caption or orig["caption"],
                device_id,
                now_ts,
                group_id,
                orig_creator_id,
                int(share_id),
            ),
        )

        new_share = execute_read_one(
            "SELECT share_id FROM device_shares WHERE share_group_id = ? ORDER BY share_id DESC LIMIT 1",
            (group_id,),
        )
        new_share_id = new_share["share_id"] if new_share else 0

        for t_id in valid_targets:
            execute_write(
                "INSERT INTO device_share_targets (share_id, target_device_id, seen, notified) VALUES (?, ?, 0, 0) ON CONFLICT DO NOTHING",
                (new_share_id, t_id),
            )

        return {
            "ok": True,
            "share_group_id": group_id,
            "share_id": new_share_id,
            "repost_of_share_id": int(share_id),
            "original_shared_by_device_id": orig_creator_id,
            "target_count": len(valid_targets),
        }
    return db_repost_reel(device_id, share_id, target_device_ids, caption)


def cancel_repost(device_id: str, share_id: int) -> Dict[str, Any]:
    if is_postgres():
        row = execute_read_one(
            """
            SELECT ds.share_id, ds.share_group_id, ds.media_id, ds.repost_of_share_id
            FROM device_shares ds
            JOIN device_share_groups dsg ON dsg.group_id = ds.share_group_id
            WHERE ds.share_id = ? AND ds.shared_by_device_id = ? AND dsg.post_kind = 'reel_repost'
            """,
            (int(share_id), device_id),
        )
        if not row:
            row = execute_read_one(
                """
                SELECT ds.share_id, ds.share_group_id, ds.media_id, ds.repost_of_share_id
                FROM device_shares ds
                JOIN device_share_groups dsg ON dsg.group_id = ds.share_group_id
                WHERE ds.shared_by_device_id = ?
                  AND dsg.post_kind = 'reel_repost'
                  AND ds.repost_of_share_id = ?
                """,
                (device_id, int(share_id)),
            )
        if not row:
            return {"ok": False, "error": "No active repost found for this reel."}

        grp_id = row["share_group_id"]
        execute_write("DELETE FROM device_share_groups WHERE group_id = ?", (grp_id,))
        return {"ok": True, "cancelled_share_group_id": grp_id, "media_id": row.get("media_id")}
    return db_cancel_repost(device_id, share_id)


def get_repost_counts_for_media_ids(media_ids: List[int]) -> Dict[int, int]:
    if is_postgres():
        if not media_ids:
            return {}
        placeholders = ",".join(["?"] * len(media_ids))
        rows = execute_read_query(
            f"SELECT media_id, COUNT(*) as cnt FROM device_shares WHERE repost_of_share_id IS NOT NULL AND media_id IN ({placeholders}) GROUP BY media_id",
            media_ids,
        )
        return {r["media_id"]: r["cnt"] for r in rows}
    return db_get_repost_counts_for_media_ids(media_ids)


def get_user_reposted_info(device_id: str) -> Tuple[Set[int], Set[int]]:
    if is_postgres():
        rows = execute_read_query("SELECT repost_of_share_id, media_id FROM device_shares WHERE shared_by_device_id = ? AND repost_of_share_id IS NOT NULL", (device_id,))
        share_ids = {r["repost_of_share_id"] for r in rows if r.get("repost_of_share_id")}
        media_ids = {r["media_id"] for r in rows if r.get("media_id")}
        return share_ids, media_ids
    return db_get_user_reposted_info(device_id)


def get_user_reposted_media_ids(device_id: str) -> Set[int]:
    _, media_ids = get_user_reposted_info(device_id)
    return media_ids


def get_recently_watched_reel_ids(
    device_id: str,
    *,
    since_seconds: int = RECENT_WATCH_WINDOW_SECONDS,
) -> Tuple[Set[int], Set[int]]:
    """Return recently watched share and media IDs for one viewer.

    ``share_id`` prevents a duplicate card from recurring, while ``media_id``
    prevents the same underlying video from bypassing the cooldown via a
    repost.  This is intentionally a server-side rule: local state alone can
    be stale after an app restart or while telemetry is waiting to flush.
    """
    if not device_id:
        return set(), set()
    cutoff = int(time.time()) - max(60, int(since_seconds))
    rows = execute_read_query(
        """
        SELECT DISTINCT share_id, media_id
        FROM reel_telemetry
        WHERE device_id = ? AND created_at >= ?
        """,
        (device_id, cutoff),
    )
    share_ids = {int(row["share_id"]) for row in rows if row.get("share_id") is not None}
    media_ids = {int(row["media_id"]) for row in rows if row.get("media_id") is not None}
    return share_ids, media_ids


def get_reel_view_counts(share_ids: List[int]) -> Dict[int, int]:
    if is_postgres():
        if not share_ids:
            return {}
        placeholders = ",".join(["?"] * len(share_ids))
        rows = execute_read_query(
            f"SELECT share_id, COUNT(*) as views FROM reel_telemetry WHERE share_id IN ({placeholders}) AND skipped = 0 GROUP BY share_id",
            share_ids,
        )
        return {r["share_id"]: r["views"] for r in rows}
    return db_get_reel_view_counts(share_ids)


def get_reel_durations(share_ids: List[int]) -> Dict[int, float]:
    if is_postgres():
        if not share_ids:
            return {}
        placeholders = ",".join(["?"] * len(share_ids))
        rows = execute_read_query(
            f"SELECT share_id, MAX(duration_sec) AS duration_sec FROM reel_telemetry WHERE share_id IN ({placeholders}) AND duration_sec > 0 GROUP BY share_id",
            share_ids,
        )
        return {r["share_id"]: r["duration_sec"] for r in rows}
    return db_get_reel_durations(share_ids)


def record_reel_telemetry(device_id: str, events: List[Dict[str, Any]]) -> int:
    if is_postgres():
        if not device_id or not events:
            return 0
        # Keep an untrusted client from using telemetry as a way to monopolize
        # a database worker.  The Android client normally flushes batches of 5.
        events = events[:100]
        now = int(time.time())
        values: list[tuple] = []
        for ev in events:
            if not isinstance(ev, dict):
                continue
            try:
                share_id = int(ev.get("share_id") or 0)
            except (TypeError, ValueError):
                continue
            if share_id <= 0:
                continue
            try:
                media_id = int(ev["media_id"]) if ev.get("media_id") is not None else None
            except (TypeError, ValueError):
                media_id = None
            try:
                watch_time = max(0.0, min(float(ev.get("watch_time_sec") or ev.get("watch_time") or 0.0), 8 * 60 * 60))
                duration = max(0.0, min(float(ev.get("duration_sec") or ev.get("duration") or 0.0), 8 * 60 * 60))
                completion = max(0.0, min(float(ev.get("completion_rate") or 0.0), 10.0))
                loops = max(0, min(int(ev.get("loops") or 0), 100))
            except (TypeError, ValueError):
                continue
            skipped = 1 if ev.get("skipped") else 0
            try:
                raw_ts = ev.get("timestamp")
                ts = int(raw_ts) if raw_ts is not None else now
                if ts > 10000000000:
                    ts = int(ts / 1000)
                if ts <= 0 or ts > now + 86400:
                    ts = now
            except (TypeError, ValueError):
                ts = now
            values.append((device_id, share_id, media_id, watch_time, duration, completion, loops, skipped, ts))

        if not values:
            return 0
        # The old implementation committed one insert per playback event.  A
        # single mobile flush then consumed many connections and made its own
        # watch-history write visible slowly.  Insert the batch atomically.
        from database_pg import get_pg_connection
        with get_pg_connection() as conn:
            with conn.cursor() as cur:
                cur.executemany(
                    """
                    INSERT INTO reel_telemetry (device_id, share_id, media_id, watch_time_sec, duration_sec, completion_rate, loops, skipped, created_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    values,
                )
            conn.commit()
        return len(values)
    return db_record_reel_telemetry(device_id, events)
