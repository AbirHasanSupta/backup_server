"""api/v1/reels.py — HyperPulse Short Video Reels, Saved, Liked, Reposts & Telemetry Router."""

from __future__ import annotations

import math
import os
import time
from pydantic import BaseModel
from fastapi import APIRouter, Header, HTTPException, Query, Request, status

from core.config import get_shared_dirs
from core.security import verify_api_key_or_device_token
from repositories import device_repo, reels_repo, social_repo, file_repo
from services.reels_service import reels_service

router = APIRouter(tags=["Reels"])

_REEL_VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".3gp", ".m4v", ".wmv"}


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
    events: list[dict]


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
                    if "all" in tags or device_id in tags:
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
                if ("all" in tags or device_id in tags) and entry.get("available_in_reels", entry.get("available_in_reel", True)):
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
    reels, has_more, total = reels_service.build_reels_feed(device_id, offset, limit, seed)
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

    candidates: list[dict] = []
    if source != "shared":
        for f in file_repo.get_files_for_device(device_id):
            if not _is_video(f["path"]):
                continue
            candidates.append({
                "source_type": "reel_backup",
                "source_key": device_id,
                "path": f["path"],
                "size": f.get("size", 0),
                "modified_time": f.get("modified_time", 0),
                "label": "My backup",
            })

    if source != "backups":
        for entry in get_shared_dirs():
            if not entry.get("id"):
                continue
            tags = entry.get("device_ids", ["all"])
            if "all" not in tags and device_id not in tags:
                continue
            if not entry.get("available_in_reels", entry.get("available_in_reel", True)):
                continue
            root = os.path.abspath(entry.get("path") or "")
            if not os.path.isdir(root):
                continue
            for root_dir, _, files in os.walk(root):
                for fn in files:
                    if _is_video(fn):
                        full_p = os.path.join(root_dir, fn)
                        rel_p = os.path.relpath(full_p, root).replace("\\", "/")
                        try:
                            st = os.stat(full_p)
                            candidates.append({
                                "source_type": "reel_shared",
                                "source_key": entry["id"],
                                "path": rel_p,
                                "size": st.st_size,
                                "modified_time": int(st.st_mtime),
                                "label": entry.get("label") or "Shared folder",
                            })
                        except OSError:
                            pass

    materialized = reels_repo.bulk_get_or_create_library_reel_shares(candidates)
    media_ids = [r["media_id"] for r in materialized]
    counts_map, user_map = social_repo.get_reactions_for_media_ids(media_ids, current_source_id=device_id)
    comment_counts = social_repo.get_comment_counts_for_media_ids(media_ids)
    repost_counts = reels_repo.get_repost_counts_for_media_ids(media_ids)
    user_reposted_media, user_reposted_shares = reels_repo.get_user_reposted_info(device_id)
    saved_ids = reels_repo.get_saved_reel_ids(device_id)
    share_ids = [r["share_id"] for r in materialized]
    view_counts = reels_repo.get_reel_view_counts(share_ids)
    durations_map = reels_repo.get_reel_durations(share_ids)
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
    total = len(reels)
    return {"reels": reels[offset: offset + limit], "has_more": (offset + limit) < total, "total": total}


@router.post("/api/reels/telemetry")
@router.post("/reels/telemetry")
async def record_telemetry(
    body: TelemetryRequest,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, body.device_id, device_repo.verify_device_token)
    inserted = reels_repo.record_reel_telemetry(body.device_id, body.events)
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
