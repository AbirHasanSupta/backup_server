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
        now = int(time.time())
        results = []
        for c in candidates:
            st = c.get("source_type") or ""
            sk = c.get("source_key") or ""
            rp = c.get("path") or c.get("relative_path") or ""
            sz = int(c.get("size") or 0)
            mt = int(c.get("modified_time") or 0)
            created_at = mt or now
            row = execute_read_one(
                "SELECT share_id, media_id, created_at FROM device_shares WHERE is_library_reel = 1 AND source_type = ? AND source_key = ? AND relative_path = ?",
                (st, sk, rp),
            )
            if row:
                results.append({**c, "share_id": row["share_id"], "media_id": row["media_id"], "created_at": row["created_at"]})
            else:
                mid = get_or_create_media_id(st, sk, rp, mt)
                execute_write(
                    """
                    INSERT INTO device_shares
                        (media_id, source_type, source_key, relative_path, size, modified_time,
                         shared_by_device_id, created_at, is_library_reel)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
                    """,
                    (mid, st, sk, rp, sz, mt, f"library:{st}:{sk}", created_at),
                )
                new_row = execute_read_one(
                    "SELECT share_id FROM device_shares WHERE is_library_reel = 1 AND source_type = ? AND source_key = ? AND relative_path = ? ORDER BY share_id DESC LIMIT 1",
                    (st, sk, rp),
                )
                sid = new_row["share_id"] if new_row else 0
                results.append({**c, "share_id": sid, "media_id": mid, "created_at": created_at})
        return results
    return db_bulk_get_or_create_library_reel_shares(candidates)


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
               d.device_name AS shared_by_name, d.username AS shared_by_username
        FROM saved_reels sr
        JOIN device_shares ds ON ds.share_id = sr.share_id
        LEFT JOIN devices d ON d.device_id = ds.shared_by_device_id
        WHERE sr.device_id = ?
        ORDER BY sr.created_at DESC
        LIMIT ? OFFSET ?
        """
        return execute_read_query(sql, (device_id, limit, offset))
    return db_get_saved_reels(device_id, offset, limit)


def get_liked_reels(device_id: str, offset: int = 0, limit: int = 50) -> List[Dict[str, Any]]:
    if is_postgres():
        sql = """
        SELECT DISTINCT r.media_id, r.created_at AS liked_at,
               ds.share_id, ds.source_type, ds.source_key, ds.relative_path,
               ds.size, ds.modified_time, ds.caption, ds.shared_by_device_id,
               ds.created_at, ds.share_group_id,
               d.device_name AS shared_by_name, d.username AS shared_by_username
        FROM reactions r
        JOIN device_shares ds ON ds.media_id = r.media_id
        LEFT JOIN devices d ON d.device_id = ds.shared_by_device_id
        WHERE r.source_id = ? AND r.emoji = '❤️'
        ORDER BY r.created_at DESC
        LIMIT ? OFFSET ?
        """
        return execute_read_query(sql, (device_id, limit, offset))
    return db_get_liked_reels(device_id, offset, limit)


def get_reposted_reels(device_id: str, offset: int = 0, limit: int = 50) -> List[Dict[str, Any]]:
    if is_postgres():
        sql = """
        SELECT ds.share_id, ds.media_id, ds.source_type, ds.source_key,
               ds.relative_path, ds.size, ds.modified_time, ds.caption,
               ds.shared_by_device_id, ds.created_at, ds.repost_of_share_id,
               d.device_name AS shared_by_name, d.username AS shared_by_username
        FROM device_shares ds
        LEFT JOIN devices d ON d.device_id = ds.shared_by_device_id
        WHERE ds.shared_by_device_id = ? AND ds.repost_of_share_id IS NOT NULL
        ORDER BY ds.created_at DESC
        LIMIT ? OFFSET ?
        """
        return execute_read_query(sql, (device_id, limit, offset))
    return db_get_reposted_reels(device_id, offset, limit)


def repost_reel(device_id: str, share_id: int, target_device_ids: List[str], caption: str | None = None) -> Dict[str, Any]:
    return db_repost_reel(device_id, share_id, target_device_ids, caption)


def cancel_repost(device_id: str, share_id: int) -> Dict[str, Any]:
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


def get_reel_view_counts(share_ids: List[int]) -> Dict[int, int]:
    if is_postgres():
        if not share_ids:
            return {}
        placeholders = ",".join(["?"] * len(share_ids))
        rows = execute_read_query(
            f"SELECT share_id, COUNT(*) as views FROM reel_telemetry WHERE share_id IN ({placeholders}) GROUP BY share_id",
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
            f"SELECT share_id, duration_sec FROM reel_telemetry WHERE share_id IN ({placeholders}) AND duration_sec > 0",
            share_ids,
        )
        return {r["share_id"]: r["duration_sec"] for r in rows}
    return db_get_reel_durations(share_ids)


def record_reel_telemetry(device_id: str, events: List[Dict[str, Any]]) -> int:
    if is_postgres():
        now = int(time.time())
        count = 0
        for ev in events:
            execute_write(
                """
                INSERT INTO reel_telemetry (device_id, share_id, media_id, watch_time_sec, duration_sec, completion_rate, loops, skipped, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    device_id,
                    ev.get("share_id", 0),
                    ev.get("media_id"),
                    float(ev.get("watch_time_sec", 0.0)),
                    float(ev.get("duration_sec", 0.0)),
                    float(ev.get("completion_rate", 0.0)),
                    int(ev.get("loops", 0)),
                    1 if ev.get("skipped") else 0,
                    now,
                ),
            )
            count += 1
        return count
    return db_record_reel_telemetry(device_id, events)
