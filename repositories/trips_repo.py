"""repositories/trips_repo.py — Trips & Reverse Geocoding Cache Repository."""

from __future__ import annotations

from typing import Any, Dict, List, Tuple
from repositories.base import execute_read_one, execute_read_query, execute_write, is_postgres
from database import (
    get_trips as db_get_trips,
    get_trip_media as db_get_trip_media,
    save_trip_clusters as db_save_trip_clusters,
    get_cached_geocode as db_get_cached_geocode,
    save_cached_geocode as db_save_cached_geocode,
)


def _lookup_media_by_ids(media_ids: List[int]) -> Dict[int, Dict[str, Any]]:
    """Batch-load media_index rows for the given ids."""
    by_id: Dict[int, Dict[str, Any]] = {}
    if not media_ids:
        return by_id
    # PG uses cap_time; SQLite media_index uses capture_time.
    cap_col = "cap_time" if is_postgres() else "capture_time"
    chunk_size = 500
    for i in range(0, len(media_ids), chunk_size):
        chunk = media_ids[i : i + chunk_size]
        placeholders = ",".join(["?"] * len(chunk))
        rows = execute_read_query(
            f"""
            SELECT id, source_type, source_key, relative_path, COALESCE({cap_col}, 0) AS cap_time
            FROM media_index
            WHERE id IN ({placeholders})
            """,
            tuple(chunk),
        )
        for row in rows:
            by_id[int(row["id"])] = row
    return by_id


def get_trips(source_id: str) -> List[Dict[str, Any]]:
    if is_postgres():
        sql = """
        SELECT t.id, t.source_id, t.title, t.start_time, t.end_time,
               t.center_lat, t.center_lon, t.media_count, t.cover_media_id,
               t.created_at,
               mi.relative_path AS cover_path, mi.source_type AS cover_source_type,
               mi.source_key AS cover_source_key
        FROM trips t
        LEFT JOIN media_index mi ON t.cover_media_id = mi.id
        WHERE t.source_id = ?
        ORDER BY t.start_time DESC
        """
        rows = execute_read_query(sql, (source_id,))
        video_exts = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".3gp", ".m4v", ".wmv"}

        counts_rows = execute_read_query(
            """
            SELECT tm.trip_id, COALESCE(mi.relative_path, tm.relative_path) AS relative_path
            FROM trip_media tm
            LEFT JOIN media_index mi ON tm.media_id = mi.id
            WHERE tm.trip_id IN (SELECT id FROM trips WHERE source_id = ?)
            """,
            (source_id,),
        )
        media_counts: Dict[int, list[int]] = {}
        for cr in counts_rows:
            # Match get_trip_media: skip unresolvable rows so badge == interior.
            path = (cr["relative_path"] or "").strip()
            if not path:
                continue
            tid = cr["trip_id"]
            path_l = path.lower()
            ext = ("." + path_l.rsplit(".", 1)[-1]) if "." in path_l else ""
            is_vid = ext in video_exts
            if tid not in media_counts:
                media_counts[tid] = [0, 0]  # [photo_count, video_count]
            if is_vid:
                media_counts[tid][1] += 1
            else:
                media_counts[tid][0] += 1

        trips = []
        for r in rows:
            cover_path = r.get("cover_path")
            ext = ("." + cover_path.rsplit(".", 1)[-1].lower()) if cover_path and "." in cover_path else ""
            cover_obj = None
            if cover_path:
                cover_obj = {
                    "id": r["cover_media_id"],
                    "relative_path": cover_path,
                    "source_type": r.get("cover_source_type") or "phone",
                    "source_id": r.get("cover_source_key") or source_id,
                    "is_video": ext in video_exts,
                }
            # Live junction counts when present so badge matches trip detail.
            # Empty junction → 0 (fixes Docker ghost badges from media_ids drop).
            if r["id"] in media_counts:
                p_cnt, v_cnt = media_counts[r["id"]]
                live_count = p_cnt + v_cnt
            else:
                p_cnt, v_cnt = 0, 0
                live_count = 0
            trips.append({
                "id": r["id"],
                "source_id": r["source_id"],
                "title": r["title"],
                "start_time": r["start_time"],
                "end_time": r["end_time"],
                "center_lat": r["center_lat"],
                "center_lon": r["center_lon"],
                "media_count": live_count,
                "photo_count": p_cnt,
                "video_count": v_cnt,
                "cover_media_id": r["cover_media_id"],
                "cover": cover_obj,
                "created_at": r["created_at"],
            })
        return trips
    return db_get_trips(source_id)


def get_trip_media(trip_id: int) -> Tuple[Dict[str, Any] | None, List[Dict[str, Any]]]:
    if is_postgres():
        trip = execute_read_one(
            """
            SELECT id, source_id, title, start_time, end_time,
                   center_lat, center_lon, media_count, cover_media_id, created_at
            FROM trips WHERE id = ?
            """,
            (trip_id,),
        )
        if not trip:
            return None, []
        media_rows = execute_read_query(
            """
            SELECT tm.id, tm.trip_id, tm.media_id,
                   COALESCE(mi.source_type, tm.source_type) AS source_type,
                   COALESCE(mi.source_key, tm.source_key) AS source_key,
                   COALESCE(mi.relative_path, tm.relative_path) AS relative_path,
                   COALESCE(mi.size, 0) AS size,
                   COALESCE(mi.modified_time, 0) AS modified_time,
                   COALESCE(mi.cap_time, tm.cap_time) AS capture_time,
                   mi.lat AS cap_lat, mi.lon AS cap_lon, mi.cap_year
            FROM trip_media tm
            LEFT JOIN media_index mi ON mi.id = tm.media_id
            WHERE tm.trip_id = ?
            ORDER BY COALESCE(mi.cap_time, tm.cap_time) ASC, tm.id ASC
            """,
            (trip_id,),
        )
        video_exts = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".3gp", ".m4v", ".wmv"}
        media_items = []
        for r in media_rows:
            path = (r["relative_path"] or "").strip()
            if not path:
                continue
            ext = ("." + path.rsplit(".", 1)[-1].lower()) if "." in path else ""
            media_items.append({
                "id": r["media_id"],
                "trip_media_id": r["id"],
                "source_type": r["source_type"],
                "source_id": r["source_key"],
                "relative_path": path,
                "size": r["size"],
                "modified_time": r["modified_time"],
                "capture_time": r["capture_time"],
                "cap_lat": r["cap_lat"],
                "cap_lon": r["cap_lon"],
                "cap_year": r["cap_year"],
                "is_video": ext in video_exts,
            })
        # Keep response media_count aligned with the items we actually return.
        trip = dict(trip)
        trip["media_count"] = len(media_items)
        return trip, media_items
    return db_get_trip_media(trip_id)


def _trip_media_items_from_cluster(source_id: str, cluster: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Build denormalized trip_media rows from cluster `items` or `media_ids`.

    Clustering (`trips.cluster_source_media`) only emits `media_ids`. Postgres
    trip_media requires source_type/source_key/relative_path/cap_time, so look
    those up from media_index — matching the SQLite junction insert path.

    Rows without a resolvable relative_path are dropped: PG UNIQUE
    (trip_id, source_type, source_key, relative_path) would collapse empties
    into a single row and get_trip_media would skip them anyway.
    """
    items = cluster.get("items")
    if items:
        prepared: List[Dict[str, Any]] = []
        missing_ids: List[int] = []
        for item in items:
            try:
                mid = int(item.get("media_id") or 0)
            except (TypeError, ValueError):
                continue
            if not mid:
                continue
            try:
                cap_time = int(item.get("cap_time") or item.get("capture_time") or 0)
            except (TypeError, ValueError):
                cap_time = 0
            rel = (item.get("relative_path") or "").strip()
            entry = {
                "media_id": mid,
                "source_type": item.get("source_type") or "phone",
                "source_key": item.get("source_key") or source_id,
                "relative_path": rel,
                "cap_time": cap_time,
            }
            prepared.append(entry)
            if not rel:
                missing_ids.append(mid)

        if missing_ids:
            by_id = _lookup_media_by_ids(missing_ids)
            for entry in prepared:
                if entry["relative_path"]:
                    continue
                row = by_id.get(entry["media_id"])
                if not row:
                    continue
                entry["relative_path"] = (row.get("relative_path") or "").strip()
                if not entry.get("source_type"):
                    entry["source_type"] = row.get("source_type") or "phone"
                if not entry.get("source_key"):
                    entry["source_key"] = row.get("source_key") or source_id
                if not entry.get("cap_time"):
                    try:
                        entry["cap_time"] = int(row.get("cap_time") or 0)
                    except (TypeError, ValueError):
                        entry["cap_time"] = 0

        return [e for e in prepared if e["relative_path"]]

    raw_ids = cluster.get("media_ids") or []
    media_ids: List[int] = []
    for mid in raw_ids:
        if mid is None:
            continue
        try:
            media_ids.append(int(mid))
        except (TypeError, ValueError):
            continue
    if not media_ids:
        return []

    by_id = _lookup_media_by_ids(media_ids)
    out: List[Dict[str, Any]] = []
    seen: set[int] = set()
    for mid in media_ids:
        if mid in seen:
            continue
        seen.add(mid)
        row = by_id.get(mid)
        if not row:
            continue
        rel = (row.get("relative_path") or "").strip()
        if not rel:
            continue
        try:
            cap_time = int(row.get("cap_time") or 0)
        except (TypeError, ValueError):
            cap_time = 0
        out.append({
            "media_id": mid,
            "source_type": row.get("source_type") or "phone",
            "source_key": row.get("source_key") or source_id,
            "relative_path": rel,
            "cap_time": cap_time,
        })
    return out


def save_trip_clusters(source_id: str, clusters: List[Dict[str, Any]]) -> None:
    if is_postgres():
        _save_trip_clusters_postgres(source_id, clusters)
        return
    db_save_trip_clusters(source_id, clusters)


def _save_trip_clusters_postgres(source_id: str, clusters: List[Dict[str, Any]]) -> None:
    """Replace a source's trips atomically.

    A phone may retry ``/trips/recluster`` while an earlier request is still
    geocoding.  These calls can land on different Gunicorn workers, so issuing
    individual delete/insert statements lets the later request delete a trip
    between the earlier request's parent and ``trip_media`` inserts.  Hold a
    transaction-scoped PostgreSQL advisory lock and use one connection for the
    complete replacement to make that interleaving impossible.
    """
    from database_pg import get_pg_connection

    with get_pg_connection() as conn:
        try:
            with conn.cursor() as cur:
                    # The lock is scoped to this source, so separate devices
                    # can still recluster concurrently.  It is released on
                    # commit/rollback even if a request is interrupted.
                    cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (source_id,))
                    cur.execute(
                        "DELETE FROM trip_media WHERE trip_id IN (SELECT id FROM trips WHERE source_id = %s)",
                        (source_id,),
                    )
                    cur.execute("DELETE FROM trips WHERE source_id = %s", (source_id,))

                    for cluster in clusters:
                        media_items = _trip_media_items_from_cluster(source_id, cluster)
                        # Persist the count of rows we actually insert, not
                        # the cluster's claim, so badges match trip detail.
                        if not media_items:
                            continue
                        cover_id = cluster.get("cover_media_id")
                        try:
                            cover_id = int(cover_id) if cover_id is not None else None
                        except (TypeError, ValueError):
                            cover_id = None
                        media_id_set = {item["media_id"] for item in media_items}
                        if cover_id not in media_id_set:
                            cover_id = media_items[0]["media_id"]

                        cur.execute(
                            """
                            INSERT INTO trips
                                (source_id, title, start_date, end_date, start_time, end_time,
                                 place_name, center_lat, center_lon, media_count, cover_media_id, created_at)
                            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                            RETURNING id
                            """,
                            (
                                source_id,
                                cluster.get("title", "Trip"),
                                cluster.get("start_date", ""),
                                cluster.get("end_date", ""),
                                cluster.get("start_time", 0),
                                cluster.get("end_time", 0),
                                cluster.get("place_name"),
                                cluster.get("center_lat"),
                                cluster.get("center_lon"),
                                len(media_items),
                                cover_id,
                                int(cluster.get("created_at", 0) or 0),
                            ),
                        )
                        trip_id = cur.fetchone()[0]
                        cur.executemany(
                            """
                            INSERT INTO trip_media
                                (trip_id, media_id, source_type, source_key, relative_path, cap_time)
                            VALUES (%s, %s, %s, %s, %s, %s)
                            ON CONFLICT DO NOTHING
                            """,
                            [
                                (
                                    trip_id,
                                    item["media_id"],
                                    item["source_type"],
                                    item["source_key"],
                                    item["relative_path"],
                                    item["cap_time"],
                                )
                                for item in media_items
                            ],
                        )
            conn.commit()
        except Exception:
            conn.rollback()
            # Do not fall back to SQLite here: this replacement uses the
            # PostgreSQL trip schema and a partial fallback would leave the
            # two databases disagreeing.  The caller receives the actual
            # database failure instead.
            raise


def get_cached_geocode(lat: float, lon: float) -> str | None:
    if is_postgres():
        lat_round = round(lat, 2)
        lon_round = round(lon, 2)
        row = execute_read_one(
            "SELECT place_name FROM geocode_cache WHERE lat_round = ? AND lon_round = ?",
            (lat_round, lon_round),
        )
        return row["place_name"] if row else None
    return db_get_cached_geocode(lat, lon)


def save_cached_geocode(lat: float, lon: float, place_name: str) -> None:
    if is_postgres():
        lat_round = round(lat, 2)
        lon_round = round(lon, 2)
        execute_write(
            "INSERT INTO geocode_cache (lat_round, lon_round, place_name) VALUES (?, ?, ?) ON CONFLICT (lat_round, lon_round) DO UPDATE SET place_name = EXCLUDED.place_name",
            (lat_round, lon_round, place_name),
        )
        return
    db_save_cached_geocode(lat, lon, place_name)
