"""services/thumbnail_service.py — High-Performance Thumbnail Generation & Caching."""

from __future__ import annotations

import os
from mimetypes import guess_type
from fastapi import HTTPException
from fastapi.responses import FileResponse

from thumbnail import get_image_thumbnail_path, get_video_thumbnail_path
from video_preview import is_video_path


class ThumbnailService:
    @staticmethod
    def get_thumbnail_response(file_path: str) -> FileResponse:
        """Return cached thumbnail file response with long-lived client cache headers."""
        if not os.path.isfile(file_path):
            raise HTTPException(status_code=404, detail="File not found")

        if is_video_path(file_path):
            thumb_path = get_video_thumbnail_path(file_path)
            if thumb_path and os.path.isfile(thumb_path):
                return FileResponse(
                    thumb_path,
                    media_type="image/jpeg",
                    headers={"Cache-Control": "public, max-age=604800, immutable"},
                )
            raise HTTPException(status_code=500, detail="Failed to generate video thumbnail")

        # Fast downscaled image thumbnail with caching
        thumb_path = get_image_thumbnail_path(file_path)
        if thumb_path and os.path.isfile(thumb_path):
            return FileResponse(
                thumb_path,
                media_type="image/jpeg",
                headers={"Cache-Control": "public, max-age=604800, immutable"},
            )

        media_type = guess_type(file_path)[0] or "image/jpeg"
        return FileResponse(
            file_path,
            media_type=media_type,
            headers={"Cache-Control": "public, max-age=86400, immutable"},
        )


thumbnail_service = ThumbnailService()
