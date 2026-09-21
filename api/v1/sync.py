"""api/v1/sync.py — Differential Sync, Chunked Upload & Session History Router."""

from __future__ import annotations

import asyncio
from pydantic import BaseModel
from fastapi import APIRouter, File, Form, Header, HTTPException, Query, Request, UploadFile, status

from core.security import verify_api_key_or_device_token
from repositories import device_repo, file_repo
from services.sync_service import sync_service
from storage.manager import get_storage
from state import add_log, set_current_activity

router = APIRouter(tags=["Sync & Upload"])


class CheckFilesItem(BaseModel):
    relative_path: str
    modified_time: int
    size: int
    external_id: str | None = None


class CheckFilesRequest(BaseModel):
    device_id: str | None = None
    verify_disk: bool = False
    files: list[CheckFilesItem]


class SyncSessionRequest(BaseModel):
    device_id: str | None = None
    started_at: int
    finished_at: int
    duration_sec: float
    files_uploaded: int
    bytes_uploaded: int
    files_skipped: int = 0
    files_failed: int = 0
    status: str = "success"
    device_ip: str | None = None
    uploaded_files: list[str] | None = None
    error_details: list[str] | None = None


@router.post("/files/check")
async def check_files(
    body: CheckFilesRequest,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, body.device_id, device_repo.verify_device_token)
    if body.device_id:
        if not device_repo.is_device_known("", body.device_id):
            raise HTTPException(status_code=403, detail="Device not recognized")

    file_dicts = [f.model_dump() for f in body.files]
    return sync_service.check_files(body.device_id or "", file_dicts, verify_disk=body.verify_disk)


@router.post("/upload/raw")
async def upload_file_raw(
    request: Request,
    relative_path: str,
    modified_time: int,
    size: int,
    external_id: str = None,
    sha256: str = None,
    device_id: str = None,
    verify_disk: bool = False,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    device_ip = request.client.host if request.client else "127.0.0.1"

    if sync_service.should_skip_upload(relative_path, size, modified_time, external_id, device_id, verify_disk):
        return sync_service.skipped_upload(device_ip, device_id)

    set_current_activity(f"Uploading {relative_path}", device_ip, device_id)
    dev_name = device_repo.get_device_display_name(device_id or device_ip)
    add_log(f"Uploading: {relative_path} ({dev_name})")

    storage = get_storage()
    try:
        _, saved_sha = await storage.save_async_stream(
            relative_path,
            request.stream(),
            device_id=device_id,
            expected_size=size,
            compute_sha256=not bool(sha256),
        )
    except Exception as exc:
        add_log(f"Error saving {relative_path}: {exc}")
        raise
    finally:
        set_current_activity(None, device_ip, device_id)

    final_sha = sha256 or saved_sha
    return sync_service.finish_upload(
        relative_path, size, modified_time, device_ip, external_id, final_sha, device_id
    )


@router.post("/upload")
async def upload_file_multipart(
    request: Request,
    file: UploadFile = File(...),
    relative_path: str = Form(...),
    modified_time: int = Form(...),
    size: int = Form(...),
    external_id: str = Form(None),
    sha256: str = Form(None),
    device_id: str = Form(None),
    verify_disk: bool = Form(False),
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    device_ip = request.client.host if request.client else "127.0.0.1"

    if sync_service.should_skip_upload(relative_path, size, modified_time, external_id, device_id, verify_disk):
        return sync_service.skipped_upload(device_ip, device_id)

    set_current_activity(f"Uploading {relative_path}", device_ip, device_id)
    dev_name = device_repo.get_device_display_name(device_id or device_ip)
    add_log(f"Uploading: {relative_path} ({dev_name})")

    storage = get_storage()
    try:
        await file.seek(0)
        _, saved_sha = await asyncio.to_thread(
            storage.save_stream,
            relative_path,
            file.file,
            device_id=device_id,
            expected_size=size,
            compute_sha256=not bool(sha256),
        )
    except Exception as exc:
        add_log(f"Error saving {relative_path}: {exc}")
        raise
    finally:
        set_current_activity(None, device_ip, device_id)

    final_sha = sha256 or saved_sha
    return sync_service.finish_upload(
        relative_path, size, modified_time, device_ip, external_id, final_sha, device_id
    )


@router.get("/sync/upload-cache")
async def get_upload_cache(
    device_id: str,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    files = file_repo.get_upload_cache(device_id)
    return {
        "device_id": device_id,
        "count": len(files),
        "files": files,
        "total_size": sum(f.get("size", 0) for f in files),
    }


@router.post("/sync/session")
async def record_sync_session(
    body: SyncSessionRequest,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, body.device_id, device_repo.verify_device_token)
    session_data = body.model_dump()
    file_repo.insert_sync_session(session_data)
    return {"ok": True}


@router.get("/sync/sessions")
async def list_sync_sessions(
    device_id: str,
    limit: int = 50,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    sessions = file_repo.get_sync_sessions(device_id, limit)
    return {"device_id": device_id, "sessions": sessions}


@router.delete("/sync/sessions")
async def delete_sync_sessions(
    device_id: str,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    file_repo.clear_sync_sessions(device_id)
    return {"ok": True}
