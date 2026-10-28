"""Read-only access to publicly shared Google Drive folders."""

from __future__ import annotations

import json
import os
import re
import threading
import time
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
_DESCENDANT_CACHE_TTL = 300
_descendant_cache: dict[tuple[str, str], tuple[dict, float]] = {}
_descendant_cache_lock = threading.Lock()
_BROWSE_CACHE_TTL = 300
_browse_cache: dict[tuple[str, str, str], tuple[dict, float]] = {}
_browse_cache_lock = threading.Lock()
_folder_name_cache: dict[str, tuple[str, float]] = {}
_folder_name_cache_lock = threading.Lock()
_FOLDER_NAME_CACHE_TTL = 3600


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


def folder_name(folder_id: str) -> str | None:
    """Return the Drive folder's real name, caching it across API workers."""
    now = time.monotonic()
    with _folder_name_cache_lock:
        cached = _folder_name_cache.get(folder_id)
        if cached and cached[1] > now:
            return cached[0]
        _folder_name_cache.pop(folder_id, None)

    redis_key = f"google_drive:folder_name:{folder_id}"
    try:
        from services.redis_service import get_redis_client
        client = get_redis_client()
        if client:
            cached_name = client.get(redis_key)
            if cached_name:
                with _folder_name_cache_lock:
                    _folder_name_cache[folder_id] = (cached_name, now + _FOLDER_NAME_CACHE_TTL)
                return cached_name
    except Exception:
        pass

    name = str(get_file(folder_id).get("name") or "").strip()
    if not name:
        return None
    with _folder_name_cache_lock:
        _folder_name_cache[folder_id] = (name, now + _FOLDER_NAME_CACHE_TTL)
    try:
        from services.redis_service import get_redis_client
        client = get_redis_client()
        if client:
            client.setex(redis_key, _FOLDER_NAME_CACHE_TTL, name)
    except Exception:
        pass
    return name


def _remember_descendants(root_id: str, items: list[dict]) -> None:
    """Cache items listed directly beneath a verified shared Drive folder."""
    expires_at = time.monotonic() + _DESCENDANT_CACHE_TTL
    redis_items = {}
    with _descendant_cache_lock:
        for item in items:
            item_id = item.get("id")
            if item_id:
                _descendant_cache[(root_id, item_id)] = (item, expires_at)
                redis_items[item_id] = json.dumps(item)

    if not redis_items:
        return
    try:
        from services.redis_service import get_redis_client
        client = get_redis_client()
        if client:
            key = f"google_drive:descendants:{root_id}"
            with client.pipeline() as pipe:
                pipe.hset(key, mapping=redis_items)
                pipe.expire(key, _DESCENDANT_CACHE_TTL)
                pipe.execute()
    except Exception:
        # Redis is an optimization; the process-local cache still works.
        pass


def _cached_descendant(root_id: str, file_id: str) -> dict | None:
    key = (root_id, file_id)
    now = time.monotonic()
    with _descendant_cache_lock:
        cached = _descendant_cache.get(key)
        if cached and cached[1] > now:
            return cached[0]
        _descendant_cache.pop(key, None)

    try:
        from services.redis_service import get_redis_client
        client = get_redis_client()
        if client:
            payload = client.hget(f"google_drive:descendants:{root_id}", file_id)
            if payload:
                item = json.loads(payload)
                with _descendant_cache_lock:
                    _descendant_cache[key] = (item, now + _DESCENDANT_CACHE_TTL)
                return item
    except Exception:
        pass
    return None


def _browse_cache_key(root_id: str, folder_id: str, display_prefix: str) -> str:
    encoded_prefix = urllib.parse.quote(display_prefix, safe="")
    return f"google_drive:browse:{root_id}:{folder_id}:{encoded_prefix}"


def _cached_browse(root_id: str, folder_id: str, display_prefix: str) -> dict | None:
    key = (root_id, folder_id, display_prefix)
    now = time.monotonic()
    with _browse_cache_lock:
        cached = _browse_cache.get(key)
        if cached and cached[1] > now:
            return cached[0]
        _browse_cache.pop(key, None)

    try:
        from services.redis_service import get_redis_client
        client = get_redis_client()
        if client:
            payload = client.get(_browse_cache_key(*key))
            if payload:
                result = json.loads(payload)
                with _browse_cache_lock:
                    _browse_cache[key] = (result, now + _BROWSE_CACHE_TTL)
                return result
    except Exception:
        pass
    return None


def _remember_browse(root_id: str, folder_id: str, display_prefix: str, result: dict) -> None:
    key = (root_id, folder_id, display_prefix)
    expires_at = time.monotonic() + _BROWSE_CACHE_TTL
    with _browse_cache_lock:
        _browse_cache[key] = (result, expires_at)
    try:
        from services.redis_service import get_redis_client
        client = get_redis_client()
        if client:
            client.setex(_browse_cache_key(*key), _BROWSE_CACHE_TTL, json.dumps(result))
    except Exception:
        pass


def ensure_descendant(root_id: str, file_id: str) -> dict:
    """Return metadata only if file_id belongs to this folder's tree.

    Drive API key requests for publicly shared folders may omit ``parents``
    from file metadata. When that happens, verify membership by walking the
    folder tree from the shared root instead of rejecting a valid child. Items
    already returned by a listing of this root are cached, so normal browsing
    does not repeat that walk or make a separate metadata request.
    """
    cached = _cached_descendant(root_id, file_id)
    if cached:
        return cached

    current = get_file(file_id)
    seen = {file_id}
    for _ in range(64):
        parents = current.get("parents") or []
        if root_id in parents:
            _remember_descendants(root_id, [current])
            return current
        next_parent = next((parent for parent in parents if parent not in seen), None)
        if not next_parent:
            break
        seen.add(next_parent)
        current = get_file(next_parent)

    pending = [(root_id, 0)]
    seen_folders = {root_id}
    while pending:
        folder_id, depth = pending.pop()
        if depth >= 64:
            continue
        for child in list_children(folder_id):
            child_id = child.get("id")
            if child_id == file_id:
                _remember_descendants(root_id, [child])
                return child
            if (
                child_id
                and child.get("mimeType") == FOLDER_MIME
                and child_id not in seen_folders
            ):
                seen_folders.add(child_id)
                pending.append((child_id, depth + 1))

    raise GoogleDriveError("This file is outside the shared Google Drive folder.")


def _ts(modified: str | None) -> int:
    if not modified:
        return 0
    from datetime import datetime
    try:
        return int(datetime.fromisoformat(modified.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return 0


def browse(folder_id: str, prefix: str = "", *, root_id: str | None = None) -> dict:
    target_id = folder_id
    display_prefix = ""
    if prefix:
        target_id, _, display_prefix = prefix.partition("/")
    cache_root_id = root_id or folder_id
    cached = _cached_browse(cache_root_id, target_id, display_prefix)
    if cached is not None:
        return cached
    children = list_children(target_id)
    _remember_descendants(cache_root_id, children)
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
    result = {"folders": folders, "files": files}
    _remember_browse(cache_root_id, target_id, display_prefix, result)
    return result


def all_files(folder_id: str) -> list[dict]:
    output: list[dict] = []
    pending = [(folder_id, "")]
    while pending:
        current_id, parent_path = pending.pop()
        children = list_children(current_id)
        # The Reels catalog uses this same traversal to verify playback and
        # thumbnails. Remember every descendant against the shared root so
        # those requests do not need to crawl the Drive tree again.
        _remember_descendants(folder_id, children)
        for item in children:
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

