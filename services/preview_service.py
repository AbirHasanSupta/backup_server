"""services/preview_service.py — Low-Latency Video Preview Streaming & Cache Service."""

from __future__ import annotations

import os
from email.utils import formatdate
from mimetypes import guess_type
from typing import Generator

from fastapi import HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse

from video_preview import get_video_preview_path, is_video_path


class PreviewService:
    @staticmethod
    def is_video(path: str) -> bool:
        return is_video_path(path)

    @staticmethod
    def get_preview_path(source_path: str, schedule_missing: bool = True) -> str:
        return get_video_preview_path(source_path, schedule_missing=schedule_missing)

    @staticmethod
    def stream_file_range(path: str, request: Request, cache_control: str = "public, max-age=604800, immutable") -> StreamingResponse | FileResponse:
        """Serve media file supporting HTTP 206 Byte-Range streaming for smooth seeking."""
        if not os.path.isfile(path):
            raise HTTPException(status_code=404, detail="File not found")

        stat_res = os.stat(path)
        file_size = stat_res.st_size
        media_type = guess_type(path)[0] or "video/mp4"

        last_modified = formatdate(stat_res.st_mtime, usegmt=True)
        range_header = request.headers.get("range")

        if not range_header:
            return FileResponse(
                path,
                media_type=media_type,
                headers={
                    "Accept-Ranges": "bytes",
                    "Content-Length": str(file_size),
                    "Last-Modified": last_modified,
                    "Cache-Control": cache_control,
                },
            )

        try:
            byte_range = range_header.replace("bytes=", "").split("-")
            start = int(byte_range[0]) if byte_range[0] else 0
            end = int(byte_range[1]) if len(byte_range) > 1 and byte_range[1] else file_size - 1
            start = max(0, min(start, file_size - 1))
            end = max(start, min(end, file_size - 1))
        except Exception:
            raise HTTPException(status_code=416, detail="Requested Range Not Satisfiable")

        chunk_length = (end - start) + 1

        def file_iterator() -> Generator[bytes, None, None]:
            with open(path, "rb") as f:
                f.seek(start)
                remaining = chunk_length
                while remaining > 0:
                    read_bytes = min(remaining, 512 * 1024)
                    chunk = f.read(read_bytes)
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    yield chunk

        headers = {
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(chunk_length),
            "Last-Modified": last_modified,
            "Cache-Control": cache_control,
        }

        return StreamingResponse(
            file_iterator(),
            status_code=206,
            media_type=media_type,
            headers=headers,
        )


preview_service = PreviewService()
