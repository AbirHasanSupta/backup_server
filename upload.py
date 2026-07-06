import time
import socket
from fastapi import APIRouter, UploadFile, Form, Header, HTTPException
from config import API_KEY
from database import is_uploaded, insert_file, get_stats
from storage import save_file

router = APIRouter()

APP_VERSION = "1.0.0"


def verify_auth(authorization: str):
    if authorization != f"Bearer {API_KEY}":
        raise HTTPException(status_code=401, detail="Unauthorized")


@router.get("/ping")
async def ping():
    """Health-check endpoint used by the Android app for server discovery on LAN."""
    return {
        "status": "ok",
        "name": socket.gethostname(),
        "version": APP_VERSION,
    }


@router.get("/status")
async def status(authorization: str = Header(None)):
    """Returns backup statistics. Used by the future desktop UI."""
    verify_auth(authorization)
    stats = get_stats()
    return {
        "total_files": stats["total_files"],
        "total_size_bytes": stats["total_size_bytes"],
        "last_backup_time": stats["last_backup_time"],
    }


@router.post("/upload")
async def upload_file(
    file: UploadFile,
    relative_path: str = Form(...),
    modified_time: int = Form(...),
    size: int = Form(...),
    authorization: str = Header(None),
):
    verify_auth(authorization)

    if is_uploaded(relative_path, size, modified_time):
        return {"status": "skipped"}

    content = await file.read()
    save_file(relative_path, content)
    insert_file(relative_path, size, modified_time, int(time.time()))

    return {"status": "uploaded"}
