"""api/v1/feed.py — Social Feed, Shared Folders & Post Sharing Router."""

from __future__ import annotations

import asyncio
import base64
import json
import mimetypes
import os
import shutil
import time
import uuid
from pydantic import BaseModel
from fastapi import APIRouter, Header, HTTPException, Query, Request, status
from fastapi.responses import FileResponse

from core.config import APP_DATA_DIR, SHARED_DIRECT_POST_DIR, SHARED_QUIZ_DIR, SHARED_REWIND_DIR, get_shared_dirs
from core.security import verify_api_key_or_device_token
from repositories import device_repo, social_repo
from services.feed_service import feed_service
from services.preview_service import preview_service
from services.thumbnail_service import thumbnail_service
from storage.manager import get_storage
import rewind

router = APIRouter(tags=["Social Feed & Shares"])

QUIZ_SHARE_MAX_TOTAL = 30
QUIZ_SHARE_MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_POST_FILES = 300
DIRECT_POST_MAX_FILES = 300
DIRECT_POST_MAX_FILE_BYTES = 100 * 1024 * 1024


class ReactRequest(BaseModel):
    source_id: str
    emoji: str


class CommentRequest(BaseModel):
    source_id: str
    text: str


class CommentDeleteRequest(BaseModel):
    source_id: str


class ShareItem(BaseModel):
    source_type: str
    source_key: str
    relative_path: str
    size: int = 0
    modified_time: int = 0


class CreateShareRequest(BaseModel):
    shared_by_device_id: str
    target_device_ids: list[str]
    caption: str | None = None
    items: list[ShareItem]
    post_kind: str | None = None
    post_title: str | None = None


class EditCaptionRequest(BaseModel):
    caption: str | None = None


class AddTargetRequest(BaseModel):
    device_id: str


class RemoveTargetRequest(BaseModel):
    device_id: str


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


def _resolve_share_path(share: dict) -> str:
    source_type = share["source_type"]
    source_key = share["source_key"]
    relative_path = share["relative_path"]
    storage = get_storage()

    if source_type in ("phone", "reel_backup"):
        return storage.get_file_path(relative_path, device_id=source_key)
    if source_type == "desktop":
        return relative_path
    if source_type in ("shared", "reel_shared"):
        found = None
        for entry in get_shared_dirs():
            if entry.get("id") == source_key:
                found = entry
                break
        if not found:
            raise HTTPException(status_code=404, detail="Shared source not found")
        root = os.path.abspath(found["path"])
        if not os.path.isdir(root):
            raise HTTPException(status_code=404, detail="Shared directory not found on server")
        safe_rel = os.path.normpath(relative_path.replace("\\", "/"))
        full_p = os.path.abspath(os.path.join(root, safe_rel))
        if os.path.commonpath([root, full_p]) != root:
            raise HTTPException(status_code=400, detail="Invalid path")
        return full_p
    if source_type == "rewind":
        year_str, _, month_str = relative_path.partition("-")
        path = rewind.get_rewind_path(source_key, int(year_str), int(month_str) if month_str else None)
        if not path:
            raise HTTPException(status_code=404, detail="Reel not ready")
        return path
    if source_type == "rewind_shared":
        full_p = os.path.abspath(relative_path)
        if os.path.commonpath([SHARED_REWIND_DIR, full_p]) != SHARED_REWIND_DIR:
            raise HTTPException(status_code=400, detail="Invalid path")
        return full_p
    if source_type == "quiz_shared":
        full_p = os.path.abspath(relative_path)
        if os.path.commonpath([SHARED_QUIZ_DIR, full_p]) != SHARED_QUIZ_DIR:
            raise HTTPException(status_code=400, detail="Invalid path")
        return full_p
    if source_type == "direct_post_shared":
        full_p = os.path.abspath(relative_path)
        if os.path.commonpath([SHARED_DIRECT_POST_DIR, full_p]) != SHARED_DIRECT_POST_DIR:
            raise HTTPException(status_code=400, detail="Invalid path")
        return full_p
    raise HTTPException(status_code=400, detail="Unknown share source type")


@router.get("/feed")
@router.get("/api/feed")
async def get_feed(
    device_id: str,
    offset: int = 0,
    limit: int = 50,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    posts, has_more, total = feed_service.build_unified_feed(device_id, offset, limit)
    return {"items": posts, "has_more": has_more, "total": total}


@router.get("/shared/list")
async def list_shared_folders(
    device_id: str | None = None,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    all_dirs = get_shared_dirs()
    if not device_id:
        return {"shared_dirs": all_dirs}

    accessible = []
    for entry in all_dirs:
        tags = entry.get("device_ids", ["all"])
        if "all" in tags or device_id in tags:
            accessible.append(entry)
    return {"shared_dirs": accessible}


@router.get("/api/share/devices")
@router.get("/share/devices")
async def list_share_target_devices(
    device_id: str,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    devices = social_repo.get_share_target_devices(device_id)
    for d in devices:
        d["display_name"] = feed_service.format_display_name(d.get("username"), d.get("device_name"))
    return {"devices": devices}


@router.post("/api/media/{media_id}/react")
@router.post("/media/{media_id}/react")
async def react_media(
    media_id: int,
    body: ReactRequest,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, body.source_id, device_repo.verify_device_token)
    res = social_repo.toggle_reaction(media_id, body.source_id, body.emoji.strip())
    try:
        from services.ws_service import ws_service
        ws_service.notify_new_reaction(
            media_id=media_id,
            reaction=body.emoji.strip(),
            device_id=body.source_id,
            counts=res.get("reaction_counts", {}),
        )
    except Exception:
        pass
    return res


@router.get("/api/media/{media_id}/reactions")
@router.get("/media/{media_id}/reactions")
async def get_media_reactions(
    media_id: int,
    device_id: str | None = None,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    res = social_repo.get_media_reactions(media_id)
    for r in res.get("reactions", []):
        r["display_name"] = feed_service.format_display_name(r.get("username"), r.get("device_name")) or r["source_id"]
        r["is_own"] = device_id is not None and r["source_id"] == device_id
    return res


@router.get("/api/media/{media_id}/comments")
@router.get("/media/{media_id}/comments")
async def list_comments(
    media_id: int,
    device_id: str | None = None,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    comments = social_repo.get_comments_for_media(media_id)
    is_creator = social_repo.is_media_or_post_creator(media_id, device_id) if device_id else False
    for c in comments:
        c["is_own"] = device_id is not None and c["source_id"] == device_id
        c["can_delete"] = c["is_own"] or is_creator
        c["display_name"] = feed_service.format_display_name(c.get("username"), c.get("device_name"))
    return {"comments": comments}


@router.post("/api/media/{media_id}/comments")
@router.post("/media/{media_id}/comments")
async def add_comment(
    media_id: int,
    body: CommentRequest,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, body.source_id, device_repo.verify_device_token)
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Comment cannot be empty")
    comment = social_repo.add_comment(media_id, body.source_id, text[:2000])
    comment["is_own"] = True
    comment["can_delete"] = True
    comment["display_name"] = feed_service.format_display_name(comment.get("username"), comment.get("device_name")) or body.source_id

    try:
        from services.ws_service import ws_service
        ws_service.notify_new_comment(
            media_id=media_id,
            comment=text[:2000],
            device_id=body.source_id,
        )
    except Exception:
        pass

    return comment



@router.post("/api/comments/{comment_id}/delete")
@router.post("/comments/{comment_id}/delete")
async def delete_comment(
    comment_id: int,
    body: CommentDeleteRequest,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, body.source_id, device_repo.verify_device_token)
    ok = social_repo.delete_comment(comment_id, body.source_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Comment not found or not yours")
    return {"ok": True}


@router.post("/api/share/create")
@router.post("/share/create")
async def create_share_post(
    body: CreateShareRequest,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, body.shared_by_device_id, device_repo.verify_device_token)
    if not body.items:
        raise HTTPException(status_code=400, detail="No items to share")
    if not body.target_device_ids:
        raise HTTPException(status_code=400, detail="No target devices")

    items = [it.model_dump() for it in body.items]
    res = social_repo.create_device_share(
        body.shared_by_device_id,
        body.target_device_ids,
        body.caption,
        items,
        body.post_kind,
        body.post_title,
    )
    try:
        from services.ws_service import ws_service
        shared_by = device_repo.get_device_display_name(body.shared_by_device_id)
        ws_service.notify_new_share(
            target_device_ids=body.target_device_ids,
            group_id=res.get("group_id", ""),
            caption=body.caption,
            shared_by=shared_by,
            shared_by_device_id=body.shared_by_device_id,
            post_kind=body.post_kind,
        )
    except Exception:
        pass
    return res



@router.post("/api/share/direct-post/create")
@router.post("/share/direct-post/create")
async def create_direct_post(
    request: Request,
    authorization: str = Header(None),
    token: str = Query(None),
):
    content_type = (request.headers.get("content-type") or "").lower()
    raw_files_data: list[tuple[str, bytes]] = []

    if "application/json" in content_type:
        body = await request.json()
        shared_by_device_id = str(body.get("shared_by_device_id") or "")
        targets = body.get("target_device_ids") or []
        caption = str(body.get("caption") or "").strip()[:2000]
        json_files = body.get("files") or []
        for idx, file_obj in enumerate(json_files):
            fname = str(file_obj.get("name") or f"file_{idx + 1}")
            b64_str = file_obj.get("base64") or file_obj.get("data") or ""
            if "," in b64_str:
                b64_str = b64_str.split(",", 1)[1]
            raw_files_data.append((fname, base64.b64decode(b64_str)))
    else:
        form = await request.form()
        shared_by_device_id = str(form.get("shared_by_device_id") or "")
        target_raw = form.get("target_device_ids")
        targets = json.loads(target_raw) if isinstance(target_raw, str) else (target_raw or [])
        caption = str(form.get("caption") or "").strip()[:2000]
        uploads = form.getlist("files")
        for idx, upload in enumerate(uploads):
            if hasattr(upload, "read"):
                content = await upload.read()
                original_name = getattr(upload, "filename", None) or f"file_{idx + 1}"
            elif isinstance(upload, bytes):
                content = upload
                original_name = f"file_{idx + 1}"
            else:
                continue
            raw_files_data.append((original_name, content))

    verify_api_key_or_device_token(authorization, token, shared_by_device_id, device_repo.verify_device_token)
    if not raw_files_data:
        raise HTTPException(status_code=400, detail="No files provided")
    if not targets:
        raise HTTPException(status_code=400, detail="No target devices")

    persisted_paths = []
    share_items = []
    try:
        for idx, (orig_name, content) in enumerate(raw_files_data):
            safe_name = os.path.basename(str(orig_name).replace("\\", "/")) or f"file_{idx + 1}"
            _, ext = os.path.splitext(safe_name)
            ext = ext.lower() if ext else ".bin"
            dest = os.path.join(SHARED_DIRECT_POST_DIR, f"{uuid.uuid4().hex}{ext}")
            with open(dest, "wb") as f:
                f.write(content)
            persisted_paths.append(dest)
            share_items.append({
                "source_type": "direct_post_shared",
                "source_key": shared_by_device_id,
                "relative_path": dest,
                "size": len(content),
                "modified_time": int(time.time()),
            })

        return social_repo.create_device_share(
            shared_by_device_id,
            targets,
            caption or None,
            share_items,
        )
    except Exception:
        for p in persisted_paths:
            try:
                os.remove(p)
            except OSError:
                pass
        raise


@router.post("/api/share/quiz/create")
@router.post("/share/quiz/create")
async def create_quiz_post(
    request: Request,
    authorization: str = Header(None),
    token: str = Query(None),
):
    body = await request.json()
    shared_by_device_id = str(body.get("shared_by_device_id") or "")
    targets = body.get("target_device_ids") or []
    caption = str(body.get("caption") or "")
    score = int(body.get("score", 0))
    total = int(body.get("total", 0))
    quiz_data = body.get("quiz_data") or {}
    images_b64 = body.get("images_base64") or []

    verify_api_key_or_device_token(authorization, token, shared_by_device_id, device_repo.verify_device_token)
    if not images_b64:
        raise HTTPException(status_code=400, detail="No quiz images provided")
    if not targets:
        raise HTTPException(status_code=400, detail="No target devices")

    group_id = str(uuid.uuid4())
    persisted_paths = []
    share_items = []
    try:
        meta_path = os.path.join(SHARED_QUIZ_DIR, f"{group_id}.json")
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump({"score": score, "total": total, "items": quiz_data.get("items", [])}, f)

        for img_str in images_b64:
            if "," in img_str:
                img_str = img_str.split(",", 1)[1]
            content = base64.b64decode(img_str)
            dest = os.path.join(SHARED_QUIZ_DIR, f"{uuid.uuid4().hex}.png")
            with open(dest, "wb") as f:
                f.write(content)
            persisted_paths.append(dest)
            share_items.append({
                "source_type": "quiz_shared",
                "source_key": shared_by_device_id,
                "relative_path": dest,
                "size": len(content),
                "modified_time": int(time.time()),
            })

        return social_repo.create_device_share(
            shared_by_device_id,
            targets,
            caption.strip() or None,
            share_items,
            "quiz",
            f"{score}/{total}",
            group_id,
        )
    except Exception:
        for p in persisted_paths:
            try:
                os.remove(p)
            except OSError:
                pass
        try:
            os.remove(os.path.join(SHARED_QUIZ_DIR, f"{group_id}.json"))
        except OSError:
            pass
        raise


@router.get("/api/share/group/{group_id}/targets")
@router.get("/share/group/{group_id}/targets")
async def get_share_group_targets(
    group_id: str,
    device_id: str,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    targets = social_repo.get_share_targets_for_group(group_id, device_id)
    for t in targets:
        t["display_name"] = feed_service.format_display_name(t.get("username"), t.get("device_name"))
    return {"targets": targets}


@router.post("/api/share/group/{group_id}/delete")
@router.post("/share/group/{group_id}/delete")
async def delete_share_group(
    group_id: str,
    device_id: str,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    ok = social_repo.delete_device_share_group(group_id, device_id)
    if not ok:
        raise HTTPException(status_code=403, detail="Not authorized or group not found")
    return {"ok": True}


@router.post("/api/share/group/{group_id}/remove_target")
@router.post("/share/group/{group_id}/remove_target")
async def remove_share_group_target(
    group_id: str,
    body: RemoveTargetRequest,
    device_id: str,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    ok = social_repo.remove_share_group_target(group_id, body.device_id, device_id)
    if not ok:
        raise HTTPException(status_code=403, detail="Not authorized or group not found")
    return {"ok": True}


@router.post("/api/share/group/{group_id}/add_target")
@router.post("/share/group/{group_id}/add_target")
async def add_share_group_target(
    group_id: str,
    body: AddTargetRequest,
    device_id: str,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    ok = social_repo.add_share_group_targets(group_id, [body.device_id], device_id)
    if not ok:
        raise HTTPException(status_code=403, detail="Not authorized or group not found")
    return {"ok": True}


@router.post("/api/share/group/{group_id}/edit_caption")
@router.post("/share/group/{group_id}/edit_caption")
async def edit_share_group_caption(
    group_id: str,
    body: EditCaptionRequest,
    device_id: str,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    caption = (body.caption or "").strip() or None
    ok = social_repo.edit_device_share_group_caption(group_id, device_id, caption)
    if not ok:
        raise HTTPException(status_code=403, detail="Not authorized or group not found")
    return {"ok": True, "caption": caption}


@router.post("/api/share/{share_id}/delete")
@router.post("/share/{share_id}/delete")
async def delete_share_by_id(
    share_id: int,
    device_id: str,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    ok = social_repo.delete_device_share(share_id, device_id)
    if not ok:
        raise HTTPException(status_code=403, detail="Not authorized or share not found")
    return {"ok": True}


@router.post("/api/share/{share_id}/remove_target")
@router.post("/share/{share_id}/remove_target")
async def remove_share_target(
    share_id: int,
    body: RemoveTargetRequest,
    device_id: str,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    ok = social_repo.remove_share_target(share_id, body.device_id, device_id)
    if not ok:
        raise HTTPException(status_code=403, detail="Not authorized or share not found")
    return {"ok": True}


@router.get("/api/share/{share_id}/download")
@router.get("/share/{share_id}/download")
async def download_share_item(
    share_id: int,
    request: Request,
    device_id: str,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    share = _authorize_share_access(share_id, device_id)
    path = _resolve_share_path(share)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="File not found")
    return preview_service.stream_file_range(path, request)


@router.get("/api/share/{share_id}/preview")
@router.get("/share/{share_id}/preview")
async def preview_share_item(
    share_id: int,
    request: Request,
    device_id: str,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    share = _authorize_share_access(share_id, device_id)
    path = _resolve_share_path(share)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="File not found")
    if not preview_service.is_video(path):
        raise HTTPException(status_code=400, detail="Preview is only available for video files")
    cached = preview_service.get_preview_path(path, schedule_missing=True)
    cache_ctrl = "public, max-age=604800, immutable" if cached != path else "private, max-age=86400"
    return preview_service.stream_file_range(cached, request, cache_control=cache_ctrl)


@router.get("/api/share/{share_id}/thumbnail")
@router.get("/share/{share_id}/thumbnail")
async def thumbnail_share_item(
    share_id: int,
    device_id: str,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    share = _authorize_share_access(share_id, device_id)
    path = _resolve_share_path(share)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="File not found")
    return thumbnail_service.get_thumbnail_response(path)


@router.get("/api/notifications/pending")
@router.get("/notifications/pending")
async def get_pending_notifications(
    device_id: str,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    posts = social_repo.get_unseen_share_notifications(device_id)
    for p in posts:
        p["shared_by"] = feed_service.format_display_name(p.get("shared_by_username"), p.get("shared_by_name")) or p["shared_by_device_id"]
    return {"posts": posts}


@router.post("/api/notifications/seen")
@router.post("/notifications/seen")
async def mark_notifications_seen(
    request: Request,
    authorization: str = Header(None),
    token: str = Query(None),
):
    body = await request.json()
    device_id = str(body.get("device_id") or "")
    group_ids = body.get("group_ids") or []
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    social_repo.mark_share_notifications_seen(device_id, group_ids)
    return {"ok": True}
