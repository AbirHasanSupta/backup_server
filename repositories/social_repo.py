"""repositories/social_repo.py — Device Shares, Comments & Reactions Repository."""

from __future__ import annotations

import time
from typing import Any, Dict, List, Tuple
from repositories.base import execute_read_one, execute_read_query, execute_write, is_postgres
from database import (
    toggle_reaction as db_toggle_reaction,
    get_media_reactions as db_get_media_reactions,
    get_reactions_for_media_ids as db_get_reactions_for_media_ids,
    get_comment_counts_for_media_ids as db_get_comment_counts_for_media_ids,
    add_comment as db_add_comment,
    get_comments_for_media as db_get_comments_for_media,
    delete_comment as db_delete_comment,
    is_media_or_post_creator as db_is_media_or_post_creator,
    get_share_target_devices as db_get_share_target_devices,
    create_device_share as db_create_device_share,
    get_device_shares_for_target as db_get_device_shares_for_target,
    get_device_shares_by_sharer as db_get_device_shares_by_sharer,
    get_device_share_by_id as db_get_device_share_by_id,
    get_share_targets_for_group as db_get_share_targets_for_group,
    delete_device_share_group as db_delete_device_share_group,
    delete_device_share as db_delete_device_share,
    remove_share_group_target as db_remove_share_group_target,
    remove_share_target as db_remove_share_target,
    is_share_target as db_is_share_target,
    get_unseen_share_notifications as db_get_unseen_share_notifications,
    mark_share_notifications_seen as db_mark_share_notifications_seen,
    add_share_group_targets as db_add_share_group_targets,
    edit_device_share_group_caption as db_edit_device_share_group_caption,
    MAX_COMMENT_LENGTH,
)


def toggle_reaction(media_id: int, source_id: str, emoji: str) -> Dict[str, Any]:
    if is_postgres():
        existing = execute_read_one(
            "SELECT id FROM reactions WHERE media_id = ? AND source_id = ? AND emoji = ?",
            (media_id, source_id, emoji),
        )
        if existing:
            execute_write("DELETE FROM reactions WHERE id = ?", (existing["id"],))
            action = "removed"
        else:
            now = int(time.time())
            execute_write(
                "INSERT INTO reactions (media_id, source_id, emoji, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
                (media_id, source_id, emoji, now),
            )
            action = "added"
        return {"action": action, **get_media_reactions(media_id)}
    return db_toggle_reaction(media_id, source_id, emoji)


def get_media_reactions(media_id: int) -> Dict[str, Any]:
    if is_postgres():
        rows = execute_read_query("SELECT emoji, COUNT(*) as count FROM reactions WHERE media_id = ? GROUP BY emoji", (media_id,))
        counts = {r["emoji"]: r["count"] for r in rows}
        return {"reactions": counts, "total": sum(counts.values())}
    return db_get_media_reactions(media_id)


def get_reactions_for_media_ids(media_ids: List[int], current_source_id: str | None = None) -> Tuple[Dict[int, Dict[str, int]], Dict[int, List[str]]]:
    if is_postgres():
        if not media_ids:
            return {}, {}
        placeholders = ",".join(["?"] * len(media_ids))
        rows = execute_read_query(f"SELECT media_id, emoji, source_id FROM reactions WHERE media_id IN ({placeholders})", media_ids)
        counts: Dict[int, Dict[str, int]] = {}
        user_reacts: Dict[int, List[str]] = {}
        for r in rows:
            mid = r["media_id"]
            em = r["emoji"]
            counts.setdefault(mid, {})
            counts[mid][em] = counts[mid].get(em, 0) + 1
            if current_source_id and r["source_id"] == current_source_id:
                user_reacts.setdefault(mid, []).append(em)
        return counts, user_reacts
    return db_get_reactions_for_media_ids(media_ids, current_source_id)


def get_comment_counts_for_media_ids(media_ids: List[int]) -> Dict[int, int]:
    if is_postgres():
        if not media_ids:
            return {}
        placeholders = ",".join(["?"] * len(media_ids))
        rows = execute_read_query(f"SELECT media_id, COUNT(*) as cnt FROM comments WHERE media_id IN ({placeholders}) GROUP BY media_id", media_ids)
        return {r["media_id"]: r["cnt"] for r in rows}
    return db_get_comment_counts_for_media_ids(media_ids)


def add_comment(media_id: int, source_id: str, text: str) -> Dict[str, Any]:
    if is_postgres():
        now = int(time.time())
        execute_write("INSERT INTO comments (media_id, source_id, text, created_at) VALUES (?, ?, ?, ?)", (media_id, source_id, text[:MAX_COMMENT_LENGTH], now))
        row = execute_read_one("SELECT * FROM comments WHERE media_id = ? AND source_id = ? AND created_at = ? ORDER BY id DESC LIMIT 1", (media_id, source_id, now))
        return row or {"media_id": media_id, "source_id": source_id, "text": text, "created_at": now}
    return db_add_comment(media_id, source_id, text)


def get_comments_for_media(media_id: int) -> List[Dict[str, Any]]:
    if is_postgres():
        sql = """
        SELECT c.id, c.media_id, c.source_id, c.text, c.created_at,
               d.device_name, d.device_model, d.username
        FROM comments c
        LEFT JOIN devices d ON d.device_id = c.source_id
        WHERE c.media_id = ?
        ORDER BY c.created_at ASC, c.id ASC
        """
        return execute_read_query(sql, (media_id,))
    return db_get_comments_for_media(media_id)


def delete_comment(comment_id: int, source_id: str) -> bool:
    if is_postgres():
        n = execute_write("DELETE FROM comments WHERE id = ? AND source_id = ?", (comment_id, source_id))
        return n > 0
    return db_delete_comment(comment_id, source_id)


def is_media_or_post_creator(media_id: int, device_id: str) -> bool:
    if is_postgres():
        row = execute_read_one("SELECT share_id FROM device_shares WHERE media_id = ? AND shared_by_device_id = ?", (media_id, device_id))
        return row is not None
    return db_is_media_or_post_creator(media_id, device_id)


def get_share_target_devices(device_id: str) -> List[Dict[str, Any]]:
    if is_postgres():
        return execute_read_query("SELECT device_id, device_name, device_model, username, status FROM devices WHERE device_id != ? AND status = 'accepted' ORDER BY last_seen DESC", (device_id,))
    return db_get_share_target_devices(device_id)


def create_device_share(
    shared_by_device_id: str,
    target_device_ids: List[str],
    caption: str | None,
    items: List[Dict[str, Any]],
    post_kind: str | None = None,
    post_title: str | None = None,
    share_group_id: str | None = None,
) -> Dict[str, Any]:
    if is_postgres():
        import uuid
        group_id = share_group_id or str(uuid.uuid4())
        now = int(time.time())
        execute_write(
            "INSERT INTO device_share_groups (group_id, shared_by_device_id, caption, created_at, post_kind, post_title) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
            (group_id, shared_by_device_id, caption, now, post_kind, post_title),
        )
        created_shares = []
        for item in items:
            sz = int(item.get("size") or 0)
            mt = int(item.get("modified_time") or 0)
            # Find or insert media_index
            m_row = execute_read_one(
                "SELECT id FROM media_index WHERE source_type = ? AND source_key = ? AND relative_path = ?",
                (item["source_type"], item["source_key"], item["relative_path"]),
            )
            if m_row:
                mid = m_row["id"]
            else:
                execute_write(
                    "INSERT INTO media_index (source_type, source_key, relative_path, size, modified_time, indexed_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
                    (item["source_type"], item["source_key"], item["relative_path"], sz, mt, now),
                )
                m_row = execute_read_one(
                    "SELECT id FROM media_index WHERE source_type = ? AND source_key = ? AND relative_path = ?",
                    (item["source_type"], item["source_key"], item["relative_path"]),
                )
                mid = m_row["id"] if m_row else 0

            execute_write(
                """
                INSERT INTO device_shares
                    (media_id, source_type, source_key, relative_path, size, modified_time,
                     caption, shared_by_device_id, created_at, share_group_id, is_library_reel)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
                """,
                (mid, item["source_type"], item["source_key"], item["relative_path"], sz, mt, caption, shared_by_device_id, now, group_id),
            )
            s_row = execute_read_one("SELECT share_id FROM device_shares WHERE share_group_id = ? AND relative_path = ? ORDER BY share_id DESC LIMIT 1", (group_id, item["relative_path"]))
            if s_row:
                sid = s_row["share_id"]
                created_shares.append(sid)
                for tid in target_device_ids:
                    execute_write(
                        "INSERT INTO device_share_targets (share_id, target_device_id, seen, notified) VALUES (?, ?, 0, 0) ON CONFLICT DO NOTHING",
                        (sid, tid),
                    )
        return {"share_group_id": group_id, "shares_created": len(created_shares)}
    return db_create_device_share(
        shared_by_device_id, target_device_ids, caption, items, post_kind, post_title, share_group_id
    )


def get_device_shares_for_target(device_id: str) -> List[Dict[str, Any]]:
    if is_postgres():
        sql = """
        SELECT ds.share_id, ds.media_id, ds.source_type, ds.source_key,
               ds.relative_path, ds.size, ds.modified_time, ds.caption,
               ds.shared_by_device_id, ds.created_at, ds.share_group_id,
               ds.original_shared_by_device_id, ds.repost_of_share_id,
               d.device_name AS shared_by_name, d.username AS shared_by_username,
               orig_d.device_name AS orig_shared_by_name, orig_d.username AS orig_shared_by_username,
               COALESCE(dsg.caption, ds.caption) AS group_caption,
               dsg.post_kind AS post_kind, dsg.post_title AS post_title,
               t.seen AS seen
        FROM device_share_targets t
        JOIN device_shares ds ON ds.share_id = t.share_id
        LEFT JOIN devices d ON d.device_id = ds.shared_by_device_id
        LEFT JOIN devices orig_d ON orig_d.device_id = ds.original_shared_by_device_id
        LEFT JOIN device_share_groups dsg ON dsg.group_id = ds.share_group_id
        WHERE t.target_device_id = ?
        ORDER BY ds.created_at DESC, ds.share_id ASC
        """
        return execute_read_query(sql, (device_id,))
    return db_get_device_shares_for_target(device_id)


def get_device_shares_by_sharer(device_id: str) -> List[Dict[str, Any]]:
    if is_postgres():
        sql = """
        SELECT ds.share_id, ds.media_id, ds.source_type, ds.source_key,
               ds.relative_path, ds.size, ds.modified_time, ds.caption,
               ds.shared_by_device_id, ds.created_at, ds.share_group_id,
               ds.original_shared_by_device_id, ds.repost_of_share_id,
               d.device_name AS shared_by_name, d.username AS shared_by_username,
               orig_d.device_name AS orig_shared_by_name, orig_d.username AS orig_shared_by_username,
               COALESCE(dsg.caption, ds.caption) AS group_caption,
               dsg.post_kind AS post_kind, dsg.post_title AS post_title,
               1 AS seen
        FROM device_shares ds
        LEFT JOIN devices d ON d.device_id = ds.shared_by_device_id
        LEFT JOIN devices orig_d ON orig_d.device_id = ds.original_shared_by_device_id
        LEFT JOIN device_share_groups dsg ON dsg.group_id = ds.share_group_id
        WHERE ds.shared_by_device_id = ?
        ORDER BY ds.created_at DESC, ds.share_id ASC
        """
        return execute_read_query(sql, (device_id,))
    return db_get_device_shares_by_sharer(device_id)


def get_device_share_by_id(share_id: int) -> Dict[str, Any] | None:
    if is_postgres():
        sql = """
        SELECT ds.share_id, ds.media_id, ds.source_type, ds.source_key,
               ds.relative_path, ds.size, ds.modified_time, ds.caption,
               ds.shared_by_device_id, ds.created_at, ds.share_group_id,
               ds.original_shared_by_device_id, ds.repost_of_share_id,
               d.device_name AS shared_by_name, d.username AS shared_by_username,
               orig_d.device_name AS orig_shared_by_name, orig_d.username AS orig_shared_by_username,
               COALESCE(dsg.caption, ds.caption) AS group_caption,
               dsg.post_kind AS post_kind, dsg.post_title AS post_title
        FROM device_shares ds
        LEFT JOIN devices d ON d.device_id = ds.shared_by_device_id
        LEFT JOIN devices orig_d ON orig_d.device_id = ds.original_shared_by_device_id
        LEFT JOIN device_share_groups dsg ON dsg.group_id = ds.share_group_id
        WHERE ds.share_id = ?
        """
        return execute_read_one(sql, (share_id,))
    return db_get_device_share_by_id(share_id)


def get_share_targets_for_group(group_id: str, device_id: str | None = None) -> List[Dict[str, Any]]:
    if is_postgres():
        sql = """
        SELECT DISTINCT dst.target_device_id, d.device_name, d.device_model, d.username
        FROM device_shares ds
        JOIN device_share_targets dst ON dst.share_id = ds.share_id
        LEFT JOIN devices d ON d.device_id = dst.target_device_id
        WHERE ds.share_group_id = ?
        """
        return execute_read_query(sql, (group_id,))
    return db_get_share_targets_for_group(group_id, device_id)


def delete_device_share_group(group_id: str, device_id: str) -> bool:
    if is_postgres():
        n = execute_write("DELETE FROM device_share_groups WHERE group_id = ? AND shared_by_device_id = ?", (group_id, device_id))
        return n > 0
    return db_delete_device_share_group(group_id, device_id)


def delete_device_share(share_id: int, device_id: str) -> bool:
    if is_postgres():
        n = execute_write("DELETE FROM device_shares WHERE share_id = ? AND shared_by_device_id = ?", (share_id, device_id))
        return n > 0
    return db_delete_device_share(share_id, device_id)


def remove_share_group_target(group_id: str, target_device_id: str, requester_device_id: str) -> bool:
    if is_postgres():
        execute_write(
            """
            DELETE FROM device_share_targets
            WHERE target_device_id = ?
              AND share_id IN (
                  SELECT ds.share_id FROM device_shares ds
                  JOIN device_share_groups dsg ON dsg.group_id = ds.share_group_id
                  WHERE dsg.group_id = ? AND dsg.shared_by_device_id = ?
              )
            """,
            (target_device_id, group_id, requester_device_id),
        )
        return True
    return db_remove_share_group_target(group_id, target_device_id, requester_device_id)


def remove_share_target(share_id: int, target_device_id: str, requester_device_id: str) -> bool:
    if is_postgres():
        execute_write(
            """
            DELETE FROM device_share_targets
            WHERE target_device_id = ?
              AND share_id IN (
                  SELECT share_id FROM device_shares WHERE share_id = ? AND shared_by_device_id = ?
              )
            """,
            (target_device_id, share_id, requester_device_id),
        )
        return True
    return db_remove_share_target(share_id, target_device_id, requester_device_id)


def is_share_target(share_id: int, device_id: str) -> bool:
    if is_postgres():
        row = execute_read_one("SELECT 1 FROM device_share_targets WHERE share_id = ? AND target_device_id = ?", (share_id, device_id))
        return row is not None
    return db_is_share_target(share_id, device_id)


def get_unseen_share_notifications(device_id: str) -> List[Dict[str, Any]]:
    if is_postgres():
        sql = """
        SELECT dsg.group_id, dsg.caption, dsg.post_kind, dsg.post_title,
               dsg.created_at, dsg.shared_by_device_id,
               d.device_name AS shared_by_name, d.username AS shared_by_username,
               COUNT(DISTINCT ds.share_id) AS item_count
        FROM device_share_targets t
        JOIN device_shares ds ON ds.share_id = t.share_id
        JOIN device_share_groups dsg ON dsg.group_id = ds.share_group_id
        LEFT JOIN devices d ON d.device_id = dsg.shared_by_device_id
        WHERE t.target_device_id = ? AND t.seen = 0
        GROUP BY dsg.group_id, d.device_name, d.username
        ORDER BY dsg.created_at DESC
        """
        return execute_read_query(sql, (device_id,))
    return db_get_unseen_share_notifications(device_id)


def mark_share_notifications_seen(device_id: str, group_ids: List[str]) -> None:
    if is_postgres():
        if not group_ids:
            return
        placeholders = ",".join(["?"] * len(group_ids))
        execute_write(
            f"""
            UPDATE device_share_targets
            SET seen = 1
            WHERE target_device_id = ?
              AND share_id IN (
                  SELECT ds.share_id FROM device_shares ds WHERE ds.share_group_id IN ({placeholders})
              )
            """,
            [device_id] + list(group_ids),
        )
        return
    db_mark_share_notifications_seen(device_id, group_ids)


def add_share_group_targets(group_id: str, new_target_ids: List[str], requester_device_id: str) -> bool:
    if is_postgres():
        grp = execute_read_one("SELECT group_id FROM device_share_groups WHERE group_id = ? AND shared_by_device_id = ?", (group_id, requester_device_id))
        if not grp:
            return False
        shares = execute_read_query("SELECT share_id FROM device_shares WHERE share_group_id = ?", (group_id,))
        for s in shares:
            for tid in new_target_ids:
                execute_write(
                    "INSERT INTO device_share_targets (share_id, target_device_id, seen, notified) VALUES (?, ?, 0, 0) ON CONFLICT DO NOTHING",
                    (s["share_id"], tid),
                )
        return True
    return db_add_share_group_targets(group_id, new_target_ids, requester_device_id)


def edit_device_share_group_caption(group_id: str, requester_device_id: str, new_caption: str | None) -> bool:
    if is_postgres():
        n = execute_write(
            "UPDATE device_share_groups SET caption = ? WHERE group_id = ? AND shared_by_device_id = ?",
            (new_caption, group_id, requester_device_id),
        )
        if n > 0:
            execute_write("UPDATE device_shares SET caption = ? WHERE share_group_id = ?", (new_caption, group_id))
            return True
        return False
    return db_edit_device_share_group_caption(group_id, requester_device_id, new_caption)


def get_all_share_targets_for_sharer(sharer_device_id: str) -> Dict[str, List[Dict[str, Any]]]:
    if is_postgres():
        rows = execute_read_query(
            """
            SELECT DISTINCT ds.share_group_id,
                   dst.target_device_id,
                   d.device_name, d.device_model, d.username
            FROM device_share_groups dsg
            JOIN device_shares ds ON ds.share_group_id = dsg.group_id
            JOIN device_share_targets dst ON dst.share_id = ds.share_id
            LEFT JOIN devices d ON d.device_id = dst.target_device_id
            WHERE dsg.shared_by_device_id = ?
            """,
            (sharer_device_id,),
        )
        groups: Dict[str, List[Dict[str, Any]]] = {}
        for r in rows:
            gid = r.get("share_group_id")
            if gid:
                groups.setdefault(gid, []).append(r)
        return groups
    from database import get_all_share_targets_for_sharer as db_get_all_share_targets_for_sharer
    return db_get_all_share_targets_for_sharer(sharer_device_id)


def update_share_group_items(group_id: str, requesting_device_id: str, new_items: List[Dict[str, Any]]) -> bool:
    if is_postgres():
        row = execute_read_one(
            "SELECT shared_by_device_id, caption, created_at FROM device_share_groups WHERE group_id = ?",
            (group_id,),
        )
        if not row or row["shared_by_device_id"] != requesting_device_id:
            return False

        target_rows = execute_read_query(
            """
            SELECT DISTINCT dst.target_device_id
            FROM device_shares ds
            JOIN device_share_targets dst ON dst.share_id = ds.share_id
            WHERE ds.share_group_id = ?
            """,
            (group_id,),
        )
        targets = [r["target_device_id"] for r in target_rows]

        old_rows = execute_read_query("SELECT share_id FROM device_shares WHERE share_group_id = ?", (group_id,))
        old_ids = [r["share_id"] for r in old_rows]
        if old_ids:
            ph = ",".join(["?"] * len(old_ids))
            execute_write(f"DELETE FROM device_share_targets WHERE share_id IN ({ph})", old_ids)
            execute_write("DELETE FROM device_shares WHERE share_group_id = ?", (group_id,))

        cap = row.get("caption")
        now_ts = int(row.get("created_at") or time.time())

        from repositories.reels_repo import get_or_create_media_id
        for it in new_items:
            source_type = it["source_type"]
            source_key = it["source_key"]
            relative_path = it["relative_path"]
            sz = int(it.get("size") or 0)
            mt = int(it.get("modified_time") or 0)
            mid = get_or_create_media_id(source_type, source_key, relative_path, mt)

            execute_write(
                """
                INSERT INTO device_shares
                    (media_id, source_type, source_key, relative_path, size, modified_time,
                     caption, shared_by_device_id, created_at, share_group_id, is_library_reel)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
                """,
                (mid, source_type, source_key, relative_path, sz, mt, cap, requesting_device_id, now_ts, group_id),
            )
            s_row = execute_read_one(
                "SELECT share_id FROM device_shares WHERE share_group_id = ? AND relative_path = ? ORDER BY share_id DESC LIMIT 1",
                (group_id, relative_path),
            )
            if s_row:
                sid = s_row["share_id"]
                for tid in targets:
                    execute_write(
                        "INSERT INTO device_share_targets (share_id, target_device_id, seen, notified) VALUES (?, ?, 0, 0) ON CONFLICT DO NOTHING",
                        (sid, tid),
                    )
        return True
    from database import update_share_group_items as db_update_share_group_items
    return db_update_share_group_items(group_id, requesting_device_id, new_items)

