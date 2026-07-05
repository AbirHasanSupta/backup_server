import time
from fastapi import APIRouter, UploadFile, Form, Header, HTTPException
from config import API_KEY
from database import is_uploaded, insert_file
from storage import save_file

router = APIRouter()


def verify_auth(authorization: str):
    if authorization != f"Bearer {API_KEY}":
        raise HTTPException(status_code=401, detail="Unauthorized")


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
