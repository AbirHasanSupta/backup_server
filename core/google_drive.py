"""Read-only access to publicly shared Google Drive folders."""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

from config import load_config

DRIVE_API = "https://www.googleapis.com/drive/v3"
FOLDER_MIME = "application/vnd.google-apps.folder"
EXPORT_FORMATS = {
    "application/vnd.google-apps.document": ("application/pdf", ".pdf"),
    "application/vnd.google-apps.spreadsheet": ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"),
    "application/vnd.google-apps.presentation": ("application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx"),
    "application/vnd.google-apps.drawing": ("application/pdf", ".pdf"),
}


def display_name(name: str, mime_type: str | None) -> str:
    export = EXPORT_FORMATS.get(mime_type or "")
    if export and not name.lower().endswith(export[1]):
        return f"{name}{export[1]}"
    return name


class GoogleDriveError(ValueError):
    pass


def folder_id_from_link(value: str) -> str:
    value = (value or "").strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{10,}", value):
        return value
    match = re.search(r"/folders/([A-Za-z0-9_-]+)", value)
    if not match:
        raise GoogleDriveError("Enter a Google Drive folder link.")
    return match.group(1)


def _api_key() -> str:
    key = str(load_config().get("GOOGLE_DRIVE_API_KEY") or os.environ.get("GOOGLE_DRIVE_API_KEY") or "").strip()
    if not key:
        raise GoogleDriveError("Google Drive support needs GOOGLE_DRIVE_API_KEY configured on the server/build.")
    return key


def _request(path: str, params: dict) -> dict:
    query = urllib.parse.urlencode({**params, "key": _api_key()})
    req = urllib.request.Request(f"{DRIVE_API}/{path}?{query}", headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as exc:
        try:
            data = json.loads(exc.read())
            message = data.get("error", {}).get("message") or str(exc)
        except Exception:
            message = str(exc)
        raise GoogleDriveError(f"Google Drive API: {message}") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise GoogleDriveError(f"Could not reach Google Drive: {exc}") from exc


def _file_fields() -> str:
    return "files(id,name,mimeType,size,modifiedTime,webViewLink,webContentLink,thumbnailLink),nextPageToken"


def list_children(folder_id: str) -> list[dict]:
    files: list[dict] = []
    page_token = None
    while True:
        params = {
            "q": f"'{folder_id}' in parents and trashed = false",
            "fields": _file_fields(),
            "pageSize": 1000,
            "orderBy": "folder,name",
            "supportsAllDrives": "true",
            "includeItemsFromAllDrives": "true",
        }
        if page_token:
            params["pageToken"] = page_token
        result = _request("files", params)
        files.extend(result.get("files", []))
        page_token = result.get("nextPageToken")
        if not page_token:
            return files


def get_file(file_id: str) -> dict:
    return _request(f"files/{urllib.parse.quote(file_id, safe='')}", {
        "fields": "id,name,mimeType,size,modifiedTime,webViewLink,webContentLink,exportLinks,thumbnailLink,parents",
        "supportsAllDrives": "true",
    })


def ensure_descendant(root_id: str, file_id: str) -> dict:
    """Return metadata only if file_id belongs to this folder's tree."""
    current = get_file(file_id)
    seen = {file_id}
    for _ in range(64):
        parents = current.get("parents") or []
        if root_id in parents:
            return current
        next_parent = next((parent for parent in parents if parent not in seen), None)
        if not next_parent:
            break
        seen.add(next_parent)
        current = get_file(next_parent)
    raise GoogleDriveError("This file is outside the shared Google Drive folder.")


def _ts(modified: str | None) -> int:
    if not modified:
        return 0
    from datetime import datetime
    try:
        return int(datetime.fromisoformat(modified.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return 0


def browse(folder_id: str, prefix: str = "") -> dict:
    target_id = folder_id
    display_prefix = ""
    if prefix:
        target_id, _, display_prefix = prefix.partition("/")
    children = list_children(target_id)
    folders, files = [], []
    for item in children:
        if item.get("mimeType") == FOLDER_MIME:
            rel = f"{display_prefix}/{item.get('name', '')}" if display_prefix else item.get("name", "")
            folders.append({"name": item.get("name", "Folder"), "path": f"{item['id']}/{rel}"})
        else:
            name = display_name(item.get("name", "file"), item.get("mimeType"))
            rel = f"{display_prefix}/{name}" if display_prefix else name
            files.append({
                "name": name,
                "path": f"{item['id']}/{rel}",
                "size": int(item.get("size") or 0),
                "modified_time": _ts(item.get("modifiedTime")),
                "mime_type": item.get("mimeType"),
                "drive_id": item["id"],
            })
    return {"folders": folders, "files": files}


def all_files(folder_id: str) -> list[dict]:
    output: list[dict] = []
    pending = [(folder_id, "")]
    while pending:
        current_id, parent_path = pending.pop()
        for item in list_children(current_id):
            name = display_name(item.get("name", "file"), item.get("mimeType"))
            rel = f"{parent_path}/{name}" if parent_path else name
            if item.get("mimeType") == FOLDER_MIME:
                pending.append((item["id"], rel))
            else:
                output.append({
                    "path": f"{item['id']}/{rel}", "name": name,
                    "size": int(item.get("size") or 0),
                    "modified_time": _ts(item.get("modifiedTime")),
                    "mime_type": item.get("mimeType"), "drive_id": item["id"],
                    "relative_path": rel,
                })
    return output

