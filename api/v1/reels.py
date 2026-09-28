"""api/v1/reels.py — HyperPulse Short Video Reels, Saved, Liked, Reposts & Telemetry Router."""

from __future__ import annotations

import asyncio
import math
import os
import threading
import time
from pydantic import BaseModel, Field
from fastapi import APIRouter, Header, HTTPException, Query, Request, status

from core.config import get_shared_dirs
from core.path_utils import normalize_fs_path
from core.security import verify_api_key_or_device_token
from repositories import device_repo, reels_repo, social_repo, file_repo
from repositories.base import is_postgres
from services.reels_service import reels_service
from storage.manager import get_storage

router = APIRouter(tags=["Reels"])

_REEL_VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".3gp", ".m4v", ".wmv"}

_reel_warm_lock = threading.Lock()
_reel_warm_active = False


def _schedule_reel_thumbnail_warm(items: list[dict], *, offset: int = 0, limit: int = 12) -> None:
    """Prefetch first-page reel thumbnails (Postgres/Docker only).

    Desktop/SQLite keeps prior behavior: no background ffmpeg on list endpoints.
    """
    global _reel_warm_active
    if offset != 0 or not items or not is_postgres():
        return

    sample = list(items[:limit])
    with _reel_warm_lock:
        if _reel_warm_active:
            return
        _reel_warm_active = True

    def _run() -> None:
        global _reel_warm_active
        try:
            from thumbnail import warm_thumbnails

            storage = get_storage()
            shared_roots: dict[str, str] = {}
            for entry in get_shared_dirs():
                eid = entry.get("id")
                if not eid:
                    continue
                root = os.path.abspath(normalize_fs_path(entry.get("path") or ""))
                if os.path.isdir(root):
                    shared_roots[str(eid)] = root

            paths: list[str] = []
            for item in sample:
                st = item.get("source_type") or ""
                sk = item.get("source_key") or ""
                rel = item.get("path") or item.get("relative_path") or ""
                if not rel:
                    continue
                try:
                    if st in ("reel_backup", "phone"):
                        full = storage.get_file_path(rel, device_id=sk)
                        if full and os.path.isfile(full):
                            paths.append(full)
                    elif st in ("reel_shared", "shared"):
                        root = shared_roots.get(str(sk))
                        if not root:
                            continue
                        safe_rel = os.path.normpath(str(rel).replace("\\", "/")).lstrip("/\\")
                        full_p = os.path.abspath(os.path.join(root, safe_rel))
                        try:
                            if os.path.commonpath([root, full_p]) != root:
                                continue
                        except ValueError:
                            continue
                        if os.path.isfile(full_p):
                            paths.append(full_p)
                except Exception:
                    continue
            warm_thumbnails(paths, limit=limit)
        except Exception:
            pass
        finally:
            with _reel_warm_lock:
                _reel_warm_active = False

    threading.Thread(target=_run, daemon=True, name="reel-thumb-warm").start()


class RepostRequest(BaseModel):
    device_id: str | None = None
    shared_by_device_id: str | None = None
    share_id: int
    target_device_ids: list[str]
    caption: str | None = None


class CancelRepostRequest(BaseModel):
    device_id: str
    share_id: int


class SaveReelRequest(BaseModel):
    device_id: str
    reel_id: str
    share_id: int
    media_id: int | None = None


class TelemetryEvent(BaseModel):
    share_id: int
    media_id: int | None = None
    watch_time_ms: int = 0
    duration_ms: int = 0
    completed: bool = False
    loop_count: int = 0


class TelemetryRequest(BaseModel):
    device_id: str
    events: list[dict] = Field(max_length=100)


def _is_video(path: str) -> bool:
    return os.path.splitext(path)[1].lower() in _REEL_VIDEO_EXTS


def _authorize_share_access(share_id: int, device_id: str) -> dict:
    share = social_repo.get_device_share_by_id(share_id)
    if not share:
        raise HTTPException(status_code=404, detail="Share not found")
    if share.get("is_library_reel"):
        if share["source_type"] == "reel_backup" and share["source_key"] == device_id:
            return share
        if share["source_type"] == "reel_shared":
            for entry in get_shared_dirs():
                if entry.get("id") == share["source_key"]:
                    tags = entry.get("device_ids", ["all"])
                    if not tags or "all" in tags or device_id in tags:
                        return share
    if not (share["shared_by_device_id"] == device_id or social_repo.is_share_target(share_id, device_id)):
        raise HTTPException(status_code=403, detail="Share not available for this device")
    return share


def _library_reel_label_for_device(source_type: str, source_key: str, device_id: str) -> str | None:
    if source_type == "reel_backup":
        return "My backup" if source_key == device_id else None
    if source_type == "reel_shared":
        for entry in get_shared_dirs():
            if entry.get("id") == source_key:
                tags = entry.get("device_ids", ["all"])
                if (not tags or "all" in tags or device_id in tags) and entry.get("available_in_reels", entry.get("available_in_reel", True)):
                    return entry.get("label") or "Shared folder"
    return None


@router.get("/api/reels")
@router.get("/reels")
async def get_reels_feed(
    device_id: str,
    offset: int = 0,
    limit: int = 30,
    seed: int = 0,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    # The service uses the synchronous repository layer.  Never execute its
    # PostgreSQL work in Uvicorn's event-loop thread: one slow feed query used
    # to delay unrelated uploads and video streams handled by that worker.
    reels, has_more, total = await asyncio.to_thread(reels_service.build_reels_feed, device_id, offset, limit, seed)
    return {"reels": reels, "has_more": has_more, "total": total}


@router.get("/api/reels/shared-backups")
@router.get("/reels/shared-backups")
async def get_shared_and_backups_reels(
    device_id: str,
    source: str | None = None,
    offset: int = 0,
    limit: int = 50,
    seed: int = 0,
    authorization: str = Header(None),
    token: str = Query(None),
):
    device_id = (device_id or "").strip()
    source = (source or "").strip().lower()
    if source not in ("", "backups", "shared"):
        raise HTTPException(status_code=400, detail="source must be 'backups' or 'shared'")
    offset = max(0, offset)
    limit = max(1, min(100, limit))
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)

    # Shared folders are indexed by the leader-elected memory scanner.
    # Recursive os.walk() calls against a Windows bind mount are extremely
    # slow and were repeated for every client page/scroll.  Read the durable
    # PostgreSQL index instead; its scanner handles filesystem changes off the
    # interactive request path.
    shared_entries = [
        entry for entry in get_shared_dirs()
        if entry.get("id")
        and (not entry.get("device_ids", ["all"]) or "all" in entry.get("device_ids", ["all"]) or device_id in entry.get("device_ids", ["all"]))
        and entry.get("available_in_reels", entry.get("available_in_reel", True))
    ]
    shared_labels = {
        str(entry["id"]): entry.get("label") or "Shared folder"
        for entry in shared_entries
    }

    async def _catalog_page(page_offset: int, page_limit: int) -> list[dict]:
        """Load only one catalog page; never materialize a whole library to scroll."""
        async def _backups() -> list[dict]:
            rows = await asyncio.to_thread(
                file_repo.get_video_files_for_device, device_id, page_limit, page_offset
            )
            return [{
                "source_type": "reel_backup", "source_key": device_id,
                "path": row["path"], "size": row.get("size", 0),
                "modified_time": row.get("modified_time", 0), "label": "My backup",
            } for row in rows]

        async def _shared() -> list[dict]:
            rows = await asyncio.to_thread(
                reels_repo.get_indexed_shared_video_candidates,
                list(shared_labels), page_limit, page_offset,
            )
            return [{
                "source_type": "reel_shared", "source_key": row["source_key"],
                "path": row["path"], "size": row.get("size", 0),
                "modified_time": row.get("modified_time", 0),
                "label": shared_labels.get(str(row["source_key"]), "Shared folder"),
            } for row in rows]

        if source == "backups":
            return await _backups()
        if source == "shared":
            return await _shared()

        # Legacy callers without a source receive a stable merged page.  Read
        # only enough from each catalog to form that page, in parallel.
        fetch_to = page_offset + page_limit
        backup_rows, shared_rows = await asyncio.gather(
            _backups() if page_offset == 0 else asyncio.to_thread(
                file_repo.get_video_files_for_device, device_id, fetch_to, 0
            ),
            _shared() if page_offset == 0 else asyncio.to_thread(
                reels_repo.get_indexed_shared_video_candidates, list(shared_labels), fetch_to, 0
            ),
        )
        if page_offset:
            backup_rows = [{
                "source_type": "reel_backup", "source_key": device_id,
                "path": row["path"], "size": row.get("size", 0),
                "modified_time": row.get("modified_time", 0), "label": "My backup",
            } for row in backup_rows]
            shared_rows = [{
                "source_type": "reel_shared", "source_key": row["source_key"],
                "path": row["path"], "size": row.get("size", 0),
                "modified_time": row.get("modified_time", 0),
                "label": shared_labels.get(str(row["source_key"]), "Shared folder"),
            } for row in shared_rows]
        merged = [*backup_rows, *shared_rows]
        merged.sort(key=lambda row: (-int(row.get("modified_time") or 0), str(row["source_type"]), str(row["path"])))
        return merged[page_offset:page_offset + page_limit]

    # Mirror the main personalized feed's no-repeat guarantee in the private
    # backup/shared shelves.  These remain independently personalized by the
    # phone, but an already watched underlying media item is not recycled.
    watched_share_ids, watched_media_ids = await asyncio.to_thread(
        reels_repo.get_recently_watched_reel_ids,
        device_id,
    )
    materialized: list[dict] = []
    scan_offset = offset
    has_more_candidates = False
    # A run of previously watched items must not leave a short page or cause a
    # duplicate on the next request.  Advance the server cursor past every
    # scanned candidate, but only materialize the requested page size.
    while len(materialized) < limit:
        remaining = limit - len(materialized)
        candidate_page = await _catalog_page(scan_offset, remaining + 1)
        has_more_candidates = len(candidate_page) > remaining
        candidates = candidate_page[:remaining]
        if not candidates:
            break
        scan_offset += len(candidates)
        catalog_rows = await asyncio.to_thread(
            reels_repo.bulk_get_or_create_library_reel_shares, candidates
        )
        materialized.extend(
            item for item in catalog_rows
            if item["share_id"] not in watched_share_ids
            and (not item.get("media_id") or item["media_id"] not in watched_media_ids)
        )
        if len(materialized) >= limit or not has_more_candidates:
            break

    materialized = materialized[:limit]
    _schedule_reel_thumbnail_warm(materialized, offset=offset)
    media_ids = [r["media_id"] for r in materialized]
    share_ids = [r["share_id"] for r in materialized]
    (
        reactions_result, comment_counts, repost_counts, reposted_result,
        saved_ids, view_counts, durations_map,
    ) = await asyncio.gather(
        asyncio.to_thread(social_repo.get_reactions_for_media_ids, media_ids, device_id),
        asyncio.to_thread(social_repo.get_comment_counts_for_media_ids, media_ids),
        asyncio.to_thread(reels_repo.get_repost_counts_for_media_ids, media_ids),
        asyncio.to_thread(reels_repo.get_user_reposted_info, device_id),
        asyncio.to_thread(reels_repo.get_saved_reel_ids, device_id),
        asyncio.to_thread(reels_repo.get_reel_view_counts, share_ids),
        asyncio.to_thread(reels_repo.get_reel_durations, share_ids),
    )
    counts_map, user_map = reactions_result
    user_reposted_media, user_reposted_shares = reposted_result
    now_ts = int(time.time())

    reels = []
    for r in materialized:
        catalog_key = f"library:{r['source_type']}:{r['source_key']}:{r['share_id']}"
        author_id = f"library:{r['source_type']}:{r['source_key']}"
        reels.append({
            "reel_id": catalog_key,
            "share_id": r["share_id"],
            "media_id": r["media_id"],
            "path": r["path"],
            "shared_by": r["label"],
            "shared_by_device_id": author_id,
            "is_repost": False,
            "user_has_reposted": r["media_id"] in user_reposted_media or r["share_id"] in user_reposted_shares,
            "original_author": {"device_id": author_id, "name": r["label"], "username": None, "display_name": r["label"]},
            "reposted_by": None,
            "caption": None,
            "created_at": r["modified_time"] or r["created_at"],
            "reaction_counts": counts_map.get(r["media_id"], {}),
            "user_reactions": user_map.get(r["media_id"], []),
            "comment_count": comment_counts.get(r["media_id"], 0),
            "repost_count": repost_counts.get(r["media_id"], 0),
            "view_count": view_counts.get(r["share_id"], 0),
            "duration": durations_map.get(r["share_id"], 0.0),
            "quality_score": round(reels_service.calculate_bayesian_quality(
                sum(counts_map.get(r["media_id"], {}).values()),
                comment_counts.get(r["media_id"], 0),
                repost_counts.get(r["media_id"], 0),
                view_counts.get(r["share_id"], 0),
            ), 4),
            "tokens": [],
            "size": r["size"],
            "is_own_post": False,
            "is_saved": catalog_key in saved_ids,
            "is_unseen": False,
            "group_id": None,
            "library_source": r["source_type"],
        })

    def _catalog_rank(reel: dict) -> float:
        created_at = reel.get("created_at") or now_ts
        age_days = max(0.0, (now_ts - created_at) / 86400.0)
        recency = math.exp(-age_days / 30.0)
        quality = reel.get("quality_score") or 0.0
        source_jitter = reels_service.deterministic_seed_jitter(f"catalog:{reel['reel_id']}", seed) * 0.30
        source_boost = 0.03 if reel.get("library_source") == "reel_shared" else 0.0
        return recency * 0.50 + quality * 0.25 + source_boost + source_jitter

    reels.sort(key=_catalog_rank, reverse=True)
    return {
        "reels": reels,
        "has_more": has_more_candidates,
        "total": len(reels),
        # The client must advance past filtered watched rows as well as the
        # visible page, otherwise they are fetched again after every scroll.
        "next_offset": scan_offset,
    }


@router.post("/api/reels/telemetry")
@router.post("/reels/telemetry")
async def record_telemetry(
    body: TelemetryRequest,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, body.device_id, device_repo.verify_device_token)
    inserted = await asyncio.to_thread(reels_repo.record_reel_telemetry, body.device_id, body.events)
    return {"ok": True, "recorded": inserted}


@router.post("/api/reels/repost")
@router.post("/reels/repost")
async def repost_reel(
    body: RepostRequest,
    authorization: str = Header(None),
    token: str = Query(None),
):
    device_id = body.device_id or body.shared_by_device_id
    if not device_id:
        raise HTTPException(status_code=400, detail="device_id is required")
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    _authorize_share_access(body.share_id, device_id)
    res = reels_repo.repost_reel(device_id, body.share_id, body.target_device_ids, body.caption)
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error", "Failed to repost reel"))
    return res


@router.post("/api/reels/repost/cancel")
@router.post("/reels/repost/cancel")
async def cancel_repost(
    body: CancelRepostRequest,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, body.device_id, device_repo.verify_device_token)
    res = reels_repo.cancel_repost(body.device_id, body.share_id)
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error", "Failed to cancel repost"))
    return res


@router.post("/api/reels/save")
@router.post("/reels/save")
async def toggle_save_reel(
    body: SaveReelRequest,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, body.device_id, device_repo.verify_device_token)
    _authorize_share_access(body.share_id, body.device_id)
    try:
        saved = reels_repo.toggle_save_reel(body.device_id, body.reel_id, body.share_id, body.media_id)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    return {"ok": True, "saved": saved, "reel_id": body.reel_id}


@router.get("/api/reels/saved")
@router.get("/reels/saved")
async def get_saved_reels(
    device_id: str,
    offset: int = 0,
    limit: int = 50,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    saved_rows = reels_repo.get_saved_reels(device_id, offset, limit)
    media_ids = [s["media_id"] for s in saved_rows if s.get("media_id")]

    counts_map, user_map = social_repo.get_reactions_for_media_ids(media_ids, current_source_id=device_id)
    comment_counts = social_repo.get_comment_counts_for_media_ids(media_ids)
    repost_counts = reels_repo.get_repost_counts_for_media_ids(media_ids)
    user_reposted_media, user_reposted_shares = reels_repo.get_user_reposted_info(device_id)

    reels = []
    for s in saved_rows:
        is_library_reel = bool(s.get("is_library_reel"))
        library_label = _library_reel_label_for_device(
            s.get("source_type") or "", s.get("source_key") or "", device_id
        ) if is_library_reel else None
        if is_library_reel and not library_label:
            continue
        if not is_library_reel and s["shared_by_device_id"] == device_id:
            continue
        orig_id = s.get("original_shared_by_device_id") or s["shared_by_device_id"]
        if not is_library_reel and orig_id == device_id:
            continue
        if is_library_reel:
            orig_id = f"library:{s['source_type']}:{s['source_key']}"

        is_repost = s.get("post_kind") == "reel_repost" or bool(s.get("original_shared_by_device_id"))
        orig_name = s.get("orig_shared_by_name") if s.get("original_shared_by_device_id") else s.get("shared_by_name")
        orig_username = s.get("orig_shared_by_username") if s.get("original_shared_by_device_id") else s.get("shared_by_username")
        reposter_name = s.get("shared_by_name")
        reposter_username = s.get("shared_by_username")

        has_reposted = (
            (s.get("media_id") in user_reposted_media if s.get("media_id") else False)
            or (s["share_id"] in user_reposted_shares)
            or (s.get("post_kind") == "reel_repost" and s.get("shared_by_device_id") == device_id)
        )

        display_name = library_label if is_library_reel else (device_repo.format_device_display_name(s.get("shared_by_username"), s.get("shared_by_name")) or s["shared_by_device_id"])

        reels.append({
            "reel_id": str(s["reel_id"]),
            "share_id": s["share_id"],
            "media_id": s.get("media_id"),
            "path": s["relative_path"],
            "shared_by": display_name,
            "shared_by_device_id": orig_id if is_library_reel else s["shared_by_device_id"],
            "is_repost": is_repost,
            "user_has_reposted": has_reposted,
            "original_author": {
                "device_id": orig_id,
                "name": library_label if is_library_reel else orig_name,
                "username": None if is_library_reel else orig_username,
                "display_name": library_label if is_library_reel else (device_repo.format_device_display_name(orig_username, orig_name) or orig_id),
            },
            "reposted_by": {
                "device_id": s["shared_by_device_id"],
                "name": reposter_name,
                "username": reposter_username,
                "display_name": device_repo.format_device_display_name(reposter_username, reposter_name) or s["shared_by_device_id"],
            } if is_repost else None,
            "caption": s.get("group_caption") or s.get("caption"),
            "created_at": s["created_at"],
            "saved_at": s.get("saved_at"),
            "reaction_counts": counts_map.get(s["media_id"], {}) if s.get("media_id") else {},
            "user_reactions": user_map.get(s["media_id"], []) if s.get("media_id") else [],
            "comment_count": comment_counts.get(s["media_id"], 0) if s.get("media_id") else 0,
            "repost_count": repost_counts.get(s["media_id"], 0) if s.get("media_id") else 0,
            "is_own_post": False,
            "is_saved": True,
            "group_id": s.get("share_group_id"),
        })

    total = len(reels)
    _schedule_reel_thumbnail_warm(
        [
            {
                "source_type": s.get("source_type"),
                "source_key": s.get("source_key"),
                "path": s.get("relative_path"),
            }
            for s in saved_rows
        ],
        offset=offset,
    )
    return {"reels": reels, "has_more": (offset + limit) < total or len(saved_rows) == limit, "total": total}


@router.get("/api/reels/liked")
@router.get("/reels/liked")
async def get_liked_reels(
    device_id: str,
    offset: int = 0,
    limit: int = 50,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    liked_rows = reels_repo.get_liked_reels(device_id, offset, limit)
    video_rows = [s for s in liked_rows if _is_video(s.get("relative_path", ""))]
    media_ids = [s["media_id"] for s in video_rows if s.get("media_id")]

    saved_ids = reels_repo.get_saved_reel_ids(device_id)
    counts_map, user_map = social_repo.get_reactions_for_media_ids(media_ids, current_source_id=device_id)
    comment_counts = social_repo.get_comment_counts_for_media_ids(media_ids)
    repost_counts = reels_repo.get_repost_counts_for_media_ids(media_ids)
    user_reposted_media, user_reposted_shares = reels_repo.get_user_reposted_info(device_id)

    reels = []
    for s in video_rows:
        is_library_reel = bool(s.get("is_library_reel"))
        library_label = _library_reel_label_for_device(
            s.get("source_type") or "", s.get("source_key") or "", device_id
        ) if is_library_reel else None
        if is_library_reel and not library_label:
            continue
        if not is_library_reel and s["shared_by_device_id"] == device_id:
            continue
        orig_id = s.get("original_shared_by_device_id") or s["shared_by_device_id"]
        if not is_library_reel and orig_id == device_id:
            continue

        reel_id = f"library:{s['source_type']}:{s['source_key']}:{s['share_id']}" if is_library_reel else str(s["share_id"])
        if is_library_reel:
            orig_id = f"library:{s['source_type']}:{s['source_key']}"

        is_repost = s.get("post_kind") == "reel_repost" or bool(s.get("original_shared_by_device_id"))
        orig_name = s.get("orig_shared_by_name") if s.get("original_shared_by_device_id") else s.get("shared_by_name")
        orig_username = s.get("orig_shared_by_username") if s.get("original_shared_by_device_id") else s.get("shared_by_username")
        reposter_name = s.get("shared_by_name")
        reposter_username = s.get("shared_by_username")

        has_reposted = (
            (s.get("media_id") in user_reposted_media if s.get("media_id") else False)
            or (s["share_id"] in user_reposted_shares)
            or (s.get("post_kind") == "reel_repost" and s.get("shared_by_device_id") == device_id)
        )

        display_name = library_label if is_library_reel else (device_repo.format_device_display_name(s.get("shared_by_username"), s.get("shared_by_name")) or s["shared_by_device_id"])

        reels.append({
            "reel_id": reel_id,
            "share_id": s["share_id"],
            "media_id": s.get("media_id"),
            "path": s["relative_path"],
            "shared_by": display_name,
            "shared_by_device_id": orig_id if is_library_reel else s["shared_by_device_id"],
            "is_repost": is_repost,
            "user_has_reposted": has_reposted,
            "original_author": {
                "device_id": orig_id,
                "name": library_label if is_library_reel else orig_name,
                "username": None if is_library_reel else orig_username,
                "display_name": library_label if is_library_reel else (device_repo.format_device_display_name(orig_username, orig_name) or orig_id),
            },
            "reposted_by": {
                "device_id": s["shared_by_device_id"],
                "name": reposter_name,
                "username": reposter_username,
                "display_name": device_repo.format_device_display_name(reposter_username, reposter_name) or s["shared_by_device_id"],
            } if is_repost else None,
            "caption": s.get("group_caption") or s.get("caption"),
            "created_at": s["created_at"],
            "liked_at": s.get("liked_at"),
            "liked_emoji": s.get("liked_emoji"),
            "reaction_counts": counts_map.get(s["media_id"], {}) if s.get("media_id") else {},
            "user_reactions": user_map.get(s["media_id"], []) if s.get("media_id") else [],
            "comment_count": comment_counts.get(s["media_id"], 0) if s.get("media_id") else 0,
            "repost_count": repost_counts.get(s["media_id"], 0) if s.get("media_id") else 0,
            "is_own_post": False,
            "is_saved": reel_id in saved_ids,
            "group_id": s.get("share_group_id"),
        })

    total = len(reels)
    _schedule_reel_thumbnail_warm(
        [
            {
                "source_type": s.get("source_type"),
                "source_key": s.get("source_key"),
                "path": s.get("relative_path"),
            }
            for s in video_rows
        ],
        offset=offset,
    )
    return {"reels": reels, "has_more": (offset + limit) < total or len(liked_rows) == limit, "total": total}


@router.get("/api/reels/reposted")
@router.get("/reels/reposted")
async def get_reposted_reels(
    device_id: str,
    offset: int = 0,
    limit: int = 50,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    reposted_rows = reels_repo.get_reposted_reels(device_id, offset, limit)
    video_rows = [s for s in reposted_rows if _is_video(s.get("relative_path", ""))]
    media_ids = [s["media_id"] for s in video_rows if s.get("media_id")]

    saved_ids = reels_repo.get_saved_reel_ids(device_id)
    counts_map, user_map = social_repo.get_reactions_for_media_ids(media_ids, current_source_id=device_id)
    comment_counts = social_repo.get_comment_counts_for_media_ids(media_ids)
    repost_counts = reels_repo.get_repost_counts_for_media_ids(media_ids)

    reels = []
    for s in video_rows:
        orig_id = s.get("original_shared_by_device_id") or s["shared_by_device_id"]
        if orig_id == device_id:
            continue
        is_repost = s.get("post_kind") == "reel_repost" or bool(s.get("original_shared_by_device_id")) or bool(s.get("repost_of_share_id"))
        if not is_repost:
            continue

        orig_name = s.get("orig_shared_by_name") if s.get("original_shared_by_device_id") else s.get("shared_by_name")
        orig_username = s.get("orig_shared_by_username") if s.get("original_shared_by_device_id") else s.get("shared_by_username")
        reposter_name = s.get("shared_by_name")
        reposter_username = s.get("shared_by_username")

        reels.append({
            "reel_id": str(s["share_id"]),
            "share_id": s["share_id"],
            "media_id": s.get("media_id"),
            "path": s["relative_path"],
            "shared_by": device_repo.format_device_display_name(s.get("shared_by_username"), s.get("shared_by_name")) or s["shared_by_device_id"],
            "shared_by_device_id": s["shared_by_device_id"],
            "is_repost": True,
            "user_has_reposted": True,
            "original_author": {
                "device_id": orig_id,
                "name": orig_name,
                "username": orig_username,
                "display_name": device_repo.format_device_display_name(orig_username, orig_name) or orig_id,
            },
            "reposted_by": {
                "device_id": s["shared_by_device_id"],
                "name": reposter_name,
                "username": reposter_username,
                "display_name": device_repo.format_device_display_name(reposter_username, reposter_name) or s["shared_by_device_id"],
            },
            "caption": s.get("group_caption") or s.get("caption"),
            "created_at": s["created_at"],
            "reposted_at": s.get("reposted_at"),
            "reaction_counts": counts_map.get(s["media_id"], {}) if s.get("media_id") else {},
            "user_reactions": user_map.get(s["media_id"], []) if s.get("media_id") else [],
            "comment_count": comment_counts.get(s["media_id"], 0) if s.get("media_id") else 0,
            "repost_count": repost_counts.get(s["media_id"], 0) if s.get("media_id") else 0,
            "is_own_post": False,
            "is_saved": str(s["share_id"]) in saved_ids,
            "group_id": s.get("share_group_id"),
        })

    total = len(reels)
    return {"reels": reels, "has_more": (offset + limit) < total or len(reposted_rows) == limit, "total": total}
