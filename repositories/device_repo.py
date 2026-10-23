"""repositories/device_repo.py — Device Repository."""

from __future__ import annotations

import re
import time
from typing import Any, Dict, List
from repositories.base import execute_read_one, execute_read_query, execute_write, is_postgres
from database import (
    format_device_display_name as db_format_device_display_name,
    get_devices as db_get_devices,
    get_device_by_id as db_get_device_by_id,
    upsert_device as db_upsert_device,
    remove_device as db_remove_device,
    touch_device as db_touch_device,
    touch_device_and_get_stats as db_touch_device_and_get_stats,
    get_device_stats as db_get_device_stats,
    ensure_device_token as db_ensure_device_token,
    verify_device_token as db_verify_device_token,
    set_device_username as db_set_device_username,
    is_device_known as db_is_device_known,
    get_device_folder_name as db_get_device_folder_name,
    find_device_by_name_model as db_find_device_by_name_model,
    merge_device_id as db_merge_device_id,
    get_device_display_name as db_get_device_display_name,
)


def get_device_display_name(identifier: str | None, fallback: str | None = None) -> str:
    """Look up a device or source by device_id, device_ip, or shared folder ID,
    and return its human-readable display name (e.g. 'Abir (Redmi Note 10s)').
    """
    if not identifier:
        return fallback or "Unknown device"

    identifier_str = str(identifier).strip()
    if not identifier_str:
        return fallback or "Unknown device"

    if identifier_str == "desktop-server":
        try:
            from config import load_config
            cfg = load_config()
            return (cfg.get("DESKTOP_NAME") or "").strip() or "Desktop Server"
        except Exception:
            return "Desktop Server"

    if is_postgres():
        try:
            row = execute_read_one(
                "SELECT username, device_name, device_model, device_id, device_ip FROM devices WHERE device_id = ? OR device_ip = ? LIMIT 1",
                (identifier_str, identifier_str),
            )
            if row:
                return format_device_display_name(row, fallback=fallback or identifier_str)
        except Exception:
            pass
    else:
        try:
            return db_get_device_display_name(identifier_str, fallback)
        except Exception:
            pass

    # Check shared folders
    try:
        from config import get_shared_dirs
        shared_dirs = get_shared_dirs()
        for entry in shared_dirs:
            if entry.get("id") == identifier_str:
                label = entry.get("label") or entry.get("path")
                return f"Shared: {label}" if label else identifier_str
    except Exception:
        pass

    return fallback or identifier_str


def format_device_display_name(
    dev: dict | str | None = None,
    device_name: str | None = None,
    device_model: str | None = None,
    *,
    username: str | None = None,
    device_id: str | None = None,
    fallback: str | None = None,
) -> str:
    """Flexible device display name formatter supporting (username, device_name, device_model), (dict), or kwargs."""
    if isinstance(dev, str):
        u = username or dev
        dn = device_name
        dm = device_model
        return db_format_device_display_name(username=u, device_name=dn, device_model=dm, fallback=fallback)
    elif isinstance(dev, dict):
        return db_format_device_display_name(dev, username=username, device_name=device_name, device_model=device_model, device_id=device_id, fallback=fallback)
    else:
        return db_format_device_display_name(username=username, device_name=device_name, device_model=device_model, device_id=device_id, fallback=fallback)


def get_devices() -> List[Dict[str, Any]]:
    if is_postgres():
        return execute_read_query("SELECT * FROM devices ORDER BY last_seen DESC")
    return db_get_devices()


def get_device_by_id(device_id: str) -> Dict[str, Any] | None:
    if is_postgres():
        return execute_read_one("SELECT * FROM devices WHERE device_id = ?", (device_id,))
    return db_get_device_by_id(device_id)


def upsert_device(
    device_name: str,
    device_ip: str,
    device_id: str | None = None,
    device_model: str | None = None,
    username: str | None = None,
) -> None:
    if is_postgres():
        now = int(time.time())
        target_id = device_id or device_ip
        row = execute_read_one("SELECT folder_name FROM devices WHERE device_id = ?", (target_id,))
        existing_folder = (row.get("folder_name") if row else "") or ""
        folder_name = existing_folder or re.sub(r'[<>:"/\\|?*]', "_", (device_name or "device").strip()).strip(". ") or "device"
        sql = """
        INSERT INTO devices (device_id, device_name, device_ip, status, first_seen, last_seen, device_model, username, folder_name)
        VALUES (?, ?, ?, 'accepted', ?, ?, ?, ?, ?)
        ON CONFLICT (device_id) DO UPDATE SET
            device_name = EXCLUDED.device_name,
            device_ip = EXCLUDED.device_ip,
            last_seen = EXCLUDED.last_seen,
            device_model = COALESCE(EXCLUDED.device_model, devices.device_model),
            username = COALESCE(EXCLUDED.username, devices.username),
            folder_name = COALESCE(NULLIF(devices.folder_name, ''), EXCLUDED.folder_name)
        """
        execute_write(sql, (target_id, device_name, device_ip, now, now, device_model, username, folder_name))
        return
    db_upsert_device(device_name, device_ip, device_id, device_model, username)


def touch_device(device_ip: str, device_id: str | None = None) -> None:
    if is_postgres():
        now = int(time.time())
        target_id = device_id or device_ip
        execute_write(
            "UPDATE devices SET last_seen = ? WHERE device_id = ? OR device_ip = ?",
            (now, target_id, target_id),
        )
        return
    db_touch_device(device_ip, device_id)


def touch_device_and_get_stats(
    device_ip: str,
    device_id: str | None = None,
    files_delta: int = 0,
    size_delta: int = 0,
) -> Dict[str, Any]:
    if is_postgres():
        now = int(time.time())
        target_id = device_id or device_ip
        execute_write(
            "UPDATE devices SET last_seen = ?, files_backed_up = files_backed_up + ?, total_bytes = total_bytes + ? WHERE device_id = ?",
            (now, files_delta, size_delta, target_id),
        )
        return get_device_stats(device_ip, device_id)
    return db_touch_device_and_get_stats(device_ip, device_id, files_delta, size_delta)


def get_device_stats(device_ip: str, device_id: str | None = None) -> Dict[str, Any]:
    if is_postgres():
        target = device_id or device_ip
        row = execute_read_one(
            "SELECT files_backed_up, total_bytes FROM devices WHERE device_id = ? OR device_ip = ?",
            (target, target),
        )
        if row:
            return {"total_files": row.get("files_backed_up") or 0, "total_size": row.get("total_bytes") or 0}
        return {"total_files": 0, "total_size": 0}
    return db_get_device_stats(device_ip, device_id)


def get_device_folder_name(device_id: str) -> str | None:
    if is_postgres():
        row = execute_read_one("SELECT folder_name, device_name FROM devices WHERE device_id = ?", (device_id,))
        if row:
            return row.get("folder_name") or re.sub(r'[<>:"/\\|?*]', "_", (row.get("device_name") or "device").strip()).strip(". ") or "device"
        return None
    return db_get_device_folder_name(device_id)


def is_device_known(device_ip: str, device_id: str | None = None) -> bool:
    if is_postgres():
        if device_id:
            row = execute_read_one("SELECT id FROM devices WHERE device_id = ? AND status = 'accepted'", (device_id,))
            return row is not None
        row = execute_read_one("SELECT id FROM devices WHERE device_ip = ? AND status = 'accepted'", (device_ip,))
        return row is not None
    return db_is_device_known(device_ip, device_id)


def ensure_device_token(device_id: str) -> str:
    if is_postgres():
        row = execute_read_one("SELECT token FROM devices WHERE device_id = ?", (device_id,))
        if row and row.get("token"):
            return row["token"]
        import secrets
        token = secrets.token_hex(32)
        execute_write("UPDATE devices SET token = ? WHERE device_id = ?", (token, device_id))
        return token
    return db_ensure_device_token(device_id)


def verify_device_token(device_id: str, token: str) -> bool:
    if is_postgres():
        if not device_id or not token:
            return False
        row = execute_read_one("SELECT token FROM devices WHERE device_id = ?", (device_id,))
        return bool(row and row.get("token") == token)
    return db_verify_device_token(device_id, token)


def set_device_username(device_id: str, username: str | None) -> None:
    if is_postgres():
        execute_write("UPDATE devices SET username = ? WHERE device_id = ?", (username, device_id))
        return
    db_set_device_username(device_id, username)


def remove_device(device_id: str) -> bool:
    if is_postgres():
        n = execute_write("DELETE FROM devices WHERE device_id = ?", (device_id,))
        return n > 0
    return db_remove_device(device_id)


def find_device_by_name_model(device_name: str, device_model: str | None) -> Dict[str, Any] | None:
    if not device_model or not device_model.strip():
        return None
    if is_postgres():
        sql = """
        SELECT * FROM devices
        WHERE TRIM(device_name) ILIKE TRIM(?)
          AND TRIM(device_model) ILIKE TRIM(?)
          AND status = 'accepted'
        ORDER BY last_seen DESC
        LIMIT 1
        """
        return execute_read_one(sql, (device_name.strip(), device_model.strip()))
    return db_find_device_by_name_model(device_name, device_model)


def merge_device_id(old_device_id: str, new_device_id: str, new_device_ip: str) -> Dict[str, int]:
    old_device_id = (old_device_id or "").strip()
    new_device_id = (new_device_id or "").strip()
    new_device_ip = (new_device_ip or "").strip()
    if not old_device_id or not new_device_id or old_device_id == new_device_id:
        return {"folder_tags": 0, "share_targets": 0, "shared_posts": 0, "saved_reels": 0}

    if is_postgres():
        from database_pg import get_pg_connection
        now = int(time.time())
        with get_pg_connection() as conn:
            with conn.cursor() as cur:
                # 1. Deduplicate colliding files: keep new uploads on path collision
                cur.execute(
                    """
                    DELETE FROM files
                    WHERE device_id = %s
                      AND path IN (SELECT path FROM files WHERE device_id = %s)
                    """,
                    (old_device_id, new_device_id),
                )
                cur.execute(
                    "UPDATE files SET device_id = %s WHERE device_id = %s",
                    (new_device_id, old_device_id),
                )
                cur.execute(
                    "UPDATE sync_sessions SET device_id = %s WHERE device_id = %s",
                    (new_device_id, old_device_id),
                )
                # cleanup_log if table exists
                cur.execute("SELECT to_regclass('public.cleanup_log')")
                row = cur.fetchone()
                if row and row[0] is not None:
                    cur.execute(
                        "UPDATE cleanup_log SET source_id = %s WHERE source_id = %s",
                        (new_device_id, old_device_id),
                    )
                # trips
                cur.execute(
                    "UPDATE trips SET source_id = %s WHERE source_id = %s",
                    (new_device_id, old_device_id),
                )
                # reactions: delete conflicting reactions from old_device_id
                cur.execute(
                    """
                    DELETE FROM reactions old_r
                    WHERE old_r.source_id = %s
                      AND EXISTS (
                          SELECT 1 FROM reactions new_r
                          WHERE new_r.media_id = old_r.media_id
                            AND new_r.emoji = old_r.emoji
                            AND new_r.scope = old_r.scope
                            AND new_r.source_id = %s
                      )
                    """,
                    (old_device_id, new_device_id),
                )
                cur.execute(
                    "UPDATE reactions SET source_id = %s WHERE source_id = %s",
                    (new_device_id, old_device_id),
                )
                # comments
                cur.execute(
                    "UPDATE comments SET source_id = %s WHERE source_id = %s",
                    (new_device_id, old_device_id),
                )

                # media_index: duplicate media resolution
                cur.execute(
                    """
                    SELECT old_m.id AS old_id, new_m.id AS new_id
                    FROM media_index old_m
                    JOIN media_index new_m
                      ON new_m.source_type = old_m.source_type
                     AND new_m.relative_path = old_m.relative_path
                    WHERE old_m.source_key = %s
                      AND new_m.source_key = %s
                      AND old_m.source_type IN ('phone', 'rewind', 'rewind_shared', 'quiz_shared', 'direct_post_shared', 'device', 'reel_backup')
                    """,
                    (old_device_id, new_device_id),
                )
                duplicate_media = cur.fetchall()
                for old_id, new_id in duplicate_media:
                    cur.execute("UPDATE device_shares SET media_id = %s WHERE media_id = %s", (old_id, new_id))
                    cur.execute("UPDATE trips SET cover_media_id = %s WHERE cover_media_id = %s", (old_id, new_id))
                    cur.execute(
                        """
                        INSERT INTO trip_media (trip_id, media_id)
                        SELECT trip_id, %s FROM trip_media WHERE media_id = %s
                        ON CONFLICT DO NOTHING
                        """,
                        (old_id, new_id),
                    )
                    cur.execute("DELETE FROM trip_media WHERE media_id = %s", (new_id,))
                    cur.execute(
                        """
                        INSERT INTO reactions (media_id, source_id, emoji, created_at, scope)
                        SELECT %s, source_id, emoji, created_at, scope FROM reactions WHERE media_id = %s
                        ON CONFLICT DO NOTHING
                        """,
                        (old_id, new_id),
                    )
                    cur.execute("DELETE FROM reactions WHERE media_id = %s", (new_id,))
                    cur.execute("UPDATE comments SET media_id = %s WHERE media_id = %s", (old_id, new_id))
                    cur.execute("UPDATE saved_reels SET media_id = %s WHERE media_id = %s", (old_id, new_id))
                    cur.execute("UPDATE reel_telemetry SET media_id = %s WHERE media_id = %s", (old_id, new_id))
                    cur.execute("DELETE FROM media_index WHERE id = %s", (new_id,))

                # Transfer remaining media_index source_key
                cur.execute(
                    """
                    UPDATE media_index SET source_key = %s
                    WHERE source_key = %s
                      AND source_type IN ('phone', 'rewind', 'rewind_shared', 'quiz_shared', 'direct_post_shared', 'device', 'reel_backup')
                    """,
                    (new_device_id, old_device_id),
                )

                # scan_dirs
                cur.execute(
                    """
                    DELETE FROM scan_dirs old_dir
                    WHERE old_dir.source_key = %s
                      AND EXISTS (
                          SELECT 1 FROM scan_dirs new_dir
                          WHERE new_dir.source_key = %s
                            AND new_dir.source_type = old_dir.source_type
                            AND new_dir.dir_relpath = old_dir.dir_relpath
                      )
                    """,
                    (old_device_id, new_device_id),
                )
                cur.execute(
                    "UPDATE scan_dirs SET source_key = %s WHERE source_key = %s",
                    (new_device_id, old_device_id),
                )

                # device_shares
                cur.execute(
                    """
                    SELECT COUNT(*) FROM device_shares
                    WHERE shared_by_device_id = %s OR (source_key = %s AND source_type IN ('phone', 'rewind', 'rewind_shared', 'quiz_shared', 'direct_post_shared', 'device', 'reel_backup'))
                    """,
                    (old_device_id, old_device_id),
                )
                shared_posts_row = cur.fetchone()
                shared_posts = shared_posts_row[0] if shared_posts_row else 0

                cur.execute(
                    "UPDATE device_shares SET shared_by_device_id = %s WHERE shared_by_device_id = %s",
                    (new_device_id, old_device_id),
                )
                cur.execute(
                    "UPDATE device_shares SET original_shared_by_device_id = %s WHERE original_shared_by_device_id = %s",
                    (new_device_id, old_device_id),
                )
                cur.execute(
                    """
                    UPDATE device_shares SET source_key = %s
                    WHERE source_key = %s
                      AND source_type IN ('phone', 'rewind', 'rewind_shared', 'quiz_shared', 'direct_post_shared', 'device', 'reel_backup')
                    """,
                    (new_device_id, old_device_id),
                )
                cur.execute(
                    "UPDATE device_share_groups SET shared_by_device_id = %s WHERE shared_by_device_id = %s",
                    (new_device_id, old_device_id),
                )

                # device_share_targets
                cur.execute(
                    "SELECT COUNT(*) FROM device_share_targets WHERE target_device_id = %s",
                    (old_device_id,),
                )
                share_targets_row = cur.fetchone()
                share_targets = share_targets_row[0] if share_targets_row else 0

                cur.execute(
                    """
                    UPDATE device_share_targets new_t
                    SET seen = 0
                    WHERE new_t.target_device_id = %s
                      AND EXISTS (
                          SELECT 1 FROM device_share_targets old_t
                          WHERE old_t.share_id = new_t.share_id
                            AND old_t.target_device_id = %s
                            AND old_t.seen = 0
                      )
                    """,
                    (new_device_id, old_device_id),
                )
                cur.execute(
                    """
                    DELETE FROM device_share_targets old_t
                    WHERE old_t.target_device_id = %s
                      AND EXISTS (
                          SELECT 1 FROM device_share_targets new_t
                          WHERE new_t.share_id = old_t.share_id
                            AND new_t.target_device_id = %s
                      )
                    """,
                    (old_device_id, new_device_id),
                )
                cur.execute(
                    "UPDATE device_share_targets SET target_device_id = %s WHERE target_device_id = %s",
                    (new_device_id, old_device_id),
                )

                # saved_reels
                cur.execute(
                    "SELECT COUNT(*) FROM saved_reels WHERE device_id = %s",
                    (old_device_id,),
                )
                saved_reels_row = cur.fetchone()
                saved_reels = saved_reels_row[0] if saved_reels_row else 0

                cur.execute(
                    """
                    DELETE FROM saved_reels old_s
                    WHERE old_s.device_id = %s
                      AND EXISTS (
                          SELECT 1 FROM saved_reels new_s
                          WHERE new_s.device_id = %s AND new_s.reel_id = old_s.reel_id
                      )
                    """,
                    (old_device_id, new_device_id),
                )
                cur.execute(
                    "UPDATE saved_reels SET device_id = %s WHERE device_id = %s",
                    (new_device_id, old_device_id),
                )

                # reel_telemetry
                cur.execute(
                    "UPDATE reel_telemetry SET device_id = %s WHERE device_id = %s",
                    (new_device_id, old_device_id),
                )

                # devices table:
                # Check if new_device_id already has a row in devices
                cur.execute("SELECT id, folder_name, username, token FROM devices WHERE device_id = %s", (new_device_id,))
                new_dev_row = cur.fetchone()

                if new_dev_row:
                    # new_device_id exists: merge folder_name, username, token, recalc file stats, delete old
                    cur.execute(
                        """
                        UPDATE devices
                        SET folder_name = COALESCE(NULLIF(devices.folder_name, ''), old_dev.folder_name),
                            username = COALESCE(NULLIF(devices.username, ''), old_dev.username),
                            first_seen = LEAST(devices.first_seen, old_dev.first_seen),
                            last_seen = %s,
                            device_ip = %s,
                            files_backed_up = (SELECT COUNT(*) FROM files WHERE files.device_id = %s),
                            total_bytes = (SELECT COALESCE(SUM(size), 0) FROM files WHERE files.device_id = %s)
                        FROM devices old_dev
                        WHERE devices.device_id = %s AND old_dev.device_id = %s
                        """,
                        (now, new_device_ip, new_device_id, new_device_id, new_device_id, old_device_id),
                    )
                    cur.execute("DELETE FROM devices WHERE device_id = %s", (old_device_id,))
                else:
                    # new_device_id does not exist yet in devices: update old row directly
                    cur.execute(
                        """
                        UPDATE devices
                        SET device_id = %s,
                            device_ip = %s,
                            last_seen = %s,
                            files_backed_up = (SELECT COUNT(*) FROM files WHERE files.device_id = %s),
                            total_bytes = (SELECT COALESCE(SUM(size), 0) FROM files WHERE files.device_id = %s)
                        WHERE device_id = %s
                        """,
                        (new_device_id, new_device_ip, now, new_device_id, new_device_id, old_device_id),
                    )

            conn.commit()

        from config import replace_device_id_in_shared_dirs
        folder_tags = replace_device_id_in_shared_dirs(old_device_id, new_device_id)
        return {
            "folder_tags": folder_tags,
            "share_targets": share_targets,
            "shared_posts": shared_posts,
            "saved_reels": saved_reels,
        }

    return db_merge_device_id(old_device_id, new_device_id, new_device_ip)

