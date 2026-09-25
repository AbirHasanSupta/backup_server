"""api/v1/sync.py — Differential Sync, Chunked Upload & Session History Router."""

from __future__ import annotations

import asyncio
import hmac
import re
import time

from pydantic import BaseModel, ConfigDict, Field
from fastapi import APIRouter, File, Form, Header, HTTPException, Query, Request, UploadFile, status

from core.security import verify_api_key_or_device_token
from core.locks import acquire_lock
from core.config import load_config
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


class CompleteChunkedUploadRequest(BaseModel):
    upload_id: str = Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    relative_path: str = Field(min_length=1, max_length=4096)
    total_chunks: int = Field(ge=1)
    modified_time: int = Field(ge=0)
    size: int = Field(ge=0)
    external_id: str | None = None
    sha256: str | None = None
    device_id: str | None = None


class SyncSessionRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    device_id: str | None = None
    device_name: str | None = None
    started_at: int | None = None
    ended_at: int | None = None
    finished_at: int | None = None
    duration_ms: int | float | None = None
    duration_sec: float | None = None
    trigger: str | None = "manual"
    outcome: str | None = None
    status: str | None = None
    scanned: int = 0
    checked: int = 0
    uploaded: int = 0
    files_uploaded: int = 0
    bytes_uploaded: int = 0
    skipped: int = 0
    files_skipped: int = 0
    errors: int = 0
    files_failed: int = 0
    total_files: int = 0
    device_ip: str | None = None
    uploaded_files: list[str] | None = None
    error_details: list[str] | None = None


def _validate_chunk_parameters(upload_id: str, chunk_index: int, total_chunks: int) -> None:
    cfg = load_config()
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", upload_id or ""):
        raise HTTPException(status_code=422, detail="Invalid upload_id")
    max_chunks = max(1, int(cfg.get("MAX_UPLOAD_CHUNKS", 131072)))
    if not 1 <= total_chunks <= max_chunks:
        raise HTTPException(status_code=422, detail=f"total_chunks must be between 1 and {max_chunks}")
    if not 0 <= chunk_index < total_chunks:
        raise HTTPException(status_code=422, detail="chunk_index is outside the upload range")


def _require_accepted_device(device_id: str | None) -> str:
    """Sync data is accepted only after the pairing/approval workflow completes."""
    if not device_id or not device_repo.is_device_known("", device_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Device not recognized or approved")
    return device_id


async def _read_chunk_body(request: Request, max_bytes: int) -> bytes:
    """Read a request body without allowing one request to exhaust server RAM."""
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > max_bytes:
                raise HTTPException(status_code=413, detail="Chunk exceeds the configured size limit")
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid Content-Length")

    data = bytearray()
    async for part in request.stream():
        data.extend(part)
        if len(data) > max_bytes:
            raise HTTPException(status_code=413, detail="Chunk exceeds the configured size limit")
    if not data:
        raise HTTPException(status_code=400, detail="Empty chunk payload")
    return bytes(data)


def _validate_declared_sha256(declared_sha: str | None, computed_sha: str) -> str:
    if declared_sha and not re.fullmatch(r"[a-fA-F0-9]{64}", declared_sha):
        raise HTTPException(status_code=422, detail="sha256 must be a 64-character hexadecimal digest")
    if declared_sha and not hmac.compare_digest(declared_sha.lower(), computed_sha.lower()):
        raise HTTPException(status_code=422, detail="Uploaded data does not match sha256")
    return declared_sha.lower() if declared_sha else computed_sha


def _validate_sha256_format(declared_sha: str | None) -> str | None:
    if declared_sha and not re.fullmatch(r"[a-fA-F0-9]{64}", declared_sha):
        raise HTTPException(status_code=422, detail="sha256 must be a 64-character hexadecimal digest")
    return declared_sha.lower() if declared_sha else None


@router.post("/files/check")
async def check_files(
    body: CheckFilesRequest,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, body.device_id, device_repo.verify_device_token)
    _require_accepted_device(body.device_id)

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
    device_id = _require_accepted_device(device_id)
    device_ip = request.client.host if request.client else "127.0.0.1"

    if sync_service.should_skip_upload(relative_path, size, modified_time, external_id, device_id, verify_disk):
        return sync_service.skipped_upload(device_ip, device_id)

    set_current_activity(f"Uploading {relative_path}", device_ip, device_id)
    dev_name = device_repo.get_device_display_name(device_id or device_ip)
    add_log(f"Uploading: {relative_path} ({dev_name})")

    storage = get_storage()
    expected_sha = _validate_sha256_format(sha256)
    try:
        _, saved_sha = await storage.save_async_stream(
            relative_path,
            request.stream(),
            device_id=device_id,
            expected_size=size,
            compute_sha256=True,
            expected_sha256=expected_sha,
        )
    except Exception as exc:
        add_log(f"Error saving {relative_path}: {exc}")
        raise
    finally:
        set_current_activity(None, device_ip, device_id)

    final_sha = _validate_declared_sha256(sha256, saved_sha)
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
    device_id = _require_accepted_device(device_id)
    device_ip = request.client.host if request.client else "127.0.0.1"

    if sync_service.should_skip_upload(relative_path, size, modified_time, external_id, device_id, verify_disk):
        return sync_service.skipped_upload(device_ip, device_id)

    set_current_activity(f"Uploading {relative_path}", device_ip, device_id)
    dev_name = device_repo.get_device_display_name(device_id or device_ip)
    add_log(f"Uploading: {relative_path} ({dev_name})")

    storage = get_storage()
    expected_sha = _validate_sha256_format(sha256)
    try:
        await file.seek(0)
        _, saved_sha = await asyncio.to_thread(
            storage.save_stream,
            relative_path,
            file.file,
            device_id=device_id,
            expected_size=size,
            compute_sha256=True,
            expected_sha256=expected_sha,
        )
    except Exception as exc:
        add_log(f"Error saving {relative_path}: {exc}")
        raise
    finally:
        set_current_activity(None, device_ip, device_id)

    final_sha = _validate_declared_sha256(sha256, saved_sha)
    return sync_service.finish_upload(
        relative_path, size, modified_time, device_ip, external_id, final_sha, device_id
    )


@router.post("/upload/chunk")
async def upload_file_chunk(
    request: Request,
    upload_id: str = Query(...),
    chunk_index: int = Query(...),
    total_chunks: int = Query(...),
    device_id: str | None = Query(None),
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    device_id = _require_accepted_device(device_id)
    _validate_chunk_parameters(upload_id, chunk_index, total_chunks)
    storage = get_storage()
    max_chunk_bytes = max(1, int(load_config().get("MAX_UPLOAD_CHUNK_BYTES", 8 * 1024 * 1024)))
    body_bytes = await _read_chunk_body(request, max_chunk_bytes)

    written = await asyncio.to_thread(
        storage.save_chunk, upload_id, chunk_index, body_bytes, device_id
    )
    return {
        "status": "chunk_saved",
        "upload_id": upload_id,
        "chunk_index": chunk_index,
        "total_chunks": total_chunks,
        "bytes_written": written,
    }


@router.get("/upload/chunk/{upload_id}")
async def get_chunked_upload_status(
    upload_id: str,
    total_chunks: int = Query(..., ge=1),
    device_id: str | None = Query(None),
    authorization: str = Header(None),
    token: str = Query(None),
):
    """Return persisted chunk indexes so interrupted uploads resume, not restart."""
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    device_id = _require_accepted_device(device_id)
    _validate_chunk_parameters(upload_id, 0, total_chunks)
    storage = get_storage()
    try:
        state = await asyncio.to_thread(storage.get_chunk_status, upload_id, total_chunks, device_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {
        "upload_id": upload_id,
        "total_chunks": total_chunks,
        "received_chunks": state["received_chunks"],
        "bytes_received": state["bytes_received"],
    }


@router.post("/upload/complete")
async def complete_chunked_upload(
    request: Request,
    body: CompleteChunkedUploadRequest,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, body.device_id, device_repo.verify_device_token)
    body.device_id = _require_accepted_device(body.device_id)
    _validate_chunk_parameters(body.upload_id, 0, body.total_chunks)
    device_ip = request.client.host if request.client else "127.0.0.1"

    # A completed response can be lost during a network handoff.  Do not make
    # the client rebuild the entire file in that case.
    if sync_service.should_skip_upload(
        body.relative_path, body.size, body.modified_time, body.external_id, body.device_id, verify_disk=True
    ):
        await asyncio.to_thread(get_storage().cleanup_chunks, body.upload_id, body.device_id)
        return sync_service.skipped_upload(device_ip, body.device_id)

    set_current_activity(f"Assembling {body.relative_path}", device_ip, body.device_id)
    dev_name = device_repo.get_device_display_name(body.device_id or device_ip)
    add_log(f"Assembling chunks: {body.relative_path} ({dev_name})")

    storage = get_storage()
    expected_sha = _validate_sha256_format(body.sha256)

    def assemble_under_lock():
        # Completion is the only destructive phase.  A lock prevents two
        # retries from racing to replace the same final path.
        with acquire_lock(f"resumable-upload:{body.device_id}:{body.upload_id}", expire_sec=7200, timeout_sec=30):
            return storage.assemble_chunks(
                body.upload_id, body.relative_path, body.total_chunks, body.size, body.device_id, expected_sha
            )

    try:
        _final_path, computed_sha = await asyncio.to_thread(assemble_under_lock)
    except Exception as exc:
        add_log(f"Error assembling {body.relative_path}: {exc}")
        raise HTTPException(status_code=400, detail=str(exc))
    finally:
        set_current_activity(None, device_ip, body.device_id)

    final_sha = _validate_declared_sha256(body.sha256, computed_sha)
    return sync_service.finish_upload(
        body.relative_path,
        body.size,
        body.modified_time,
        device_ip,
        body.external_id,
        final_sha,
        body.device_id,
    )


@router.delete("/upload/chunk/{upload_id}")
async def abort_chunked_upload(
    upload_id: str,
    device_id: str | None = Query(None),
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    device_id = _require_accepted_device(device_id)
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", upload_id or ""):
        raise HTTPException(status_code=422, detail="Invalid upload_id")
    storage = get_storage()
    await asyncio.to_thread(storage.cleanup_chunks, upload_id, device_id)
    return {"ok": True, "upload_id": upload_id}


@router.get("/sync/upload-cache")
async def get_upload_cache(
    device_id: str,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    device_id = _require_accepted_device(device_id)
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
    body.device_id = _require_accepted_device(body.device_id)
    session_data = body.model_dump()

    # Normalize fields
    now_ts = int(time.time() * 1000)
    started_at = session_data.get("started_at") or now_ts
    ended_at = session_data.get("ended_at") or session_data.get("finished_at") or now_ts
    session_data["started_at"] = started_at
    session_data["ended_at"] = ended_at
    session_data["finished_at"] = ended_at

    dur_ms = session_data.get("duration_ms")
    dur_sec = session_data.get("duration_sec")
    if dur_ms is None and dur_sec is not None:
        session_data["duration_ms"] = int(dur_sec * 1000)
    elif dur_ms is not None and dur_sec is None:
        session_data["duration_sec"] = dur_ms / 1000.0
    elif dur_ms is None and dur_sec is None:
        diff_ms = max(0, ended_at - started_at)
        session_data["duration_ms"] = diff_ms
        session_data["duration_sec"] = diff_ms / 1000.0

    uploaded = session_data.get("uploaded") or session_data.get("files_uploaded") or 0
    session_data["uploaded"] = uploaded
    session_data["files_uploaded"] = uploaded

    skipped = session_data.get("skipped") or session_data.get("files_skipped") or 0
    session_data["skipped"] = skipped
    session_data["files_skipped"] = skipped

    errors = session_data.get("errors") or session_data.get("files_failed") or 0
    session_data["errors"] = errors
    session_data["files_failed"] = errors

    outcome = session_data.get("outcome") or session_data.get("status") or "completed"
    session_data["outcome"] = outcome
    session_data["status"] = outcome

    if not session_data.get("device_name") and body.device_id:
        session_data["device_name"] = device_repo.get_device_display_name(body.device_id)

    file_repo.insert_sync_session(session_data)

    label = {"completed": "✅", "stopped": "⏹", "force_stopped": "⚡", "failed": "❌"}.get(outcome, "🔄")
    dev_name = session_data.get("device_name") or body.device_id or "unknown"
    add_log(
        f"{label} Sync session from {dev_name}: "
        f"{uploaded} uploaded, {skipped} skipped, {errors} errors — {outcome}"
    )

    if body.device_id and uploaded > 0:
        try:
            from trips import trigger_background_clustering
            trigger_background_clustering(body.device_id)
        except Exception:
            pass

    return {"ok": True}


@router.get("/sync/sessions")
async def list_sync_sessions(
    device_id: str,
    limit: int = 50,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    _require_accepted_device(device_id)
    sessions = file_repo.get_sync_sessions(device_id, limit)
    return {"device_id": device_id, "sessions": sessions}


@router.delete("/sync/sessions")
async def delete_sync_sessions(
    device_id: str,
    authorization: str = Header(None),
    token: str = Query(None),
):
    verify_api_key_or_device_token(authorization, token, device_id, device_repo.verify_device_token)
    _require_accepted_device(device_id)
    file_repo.clear_sync_sessions(device_id)
    return {"ok": True}
