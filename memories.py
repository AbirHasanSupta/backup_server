"""Memories precomputation and daily media indexing module.

Precomputes capture dates (EXIF, ffprobe creation_time, or filesystem ctime)
into SQLite media_index cache for phone backups and tagged shared folders.
"""

from datetime import date, datetime, timedelta
import json
import os
import subprocess
import time as time_module
from PIL import Image

from config import load_config
from database import (
    get_devices,
    get_files_for_device,
    get_media_for_day,
    get_media_index_cache,
    prune_media_index,
    upsert_media_index_row,
)
from state import add_log
from storage import full_path_for
from video_preview import _ffprobe_path

IMAGE_EXTS = {
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif",
    ".bmp", ".tiff", ".tif", ".avif", ".svg",
}

VIDEO_EXTS = {
    ".mp4", ".mov", ".avi", ".mkv", ".webm", ".3gp",
    ".m4v", ".wmv", ".flv", ".ts", ".mts",
}


def _parse_date_str(val: str) -> int | None:
    """Parse common EXIF or ISO 8601 date strings into unix epoch seconds."""
    if not val or not isinstance(val, str):
        return None
    val = val.strip()

    # Common EXIF date formats
    for fmt in (
        "%Y:%m:%d %H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
        "%Y:%m:%d",
        "%Y-%m-%d",
    ):
        try:
            dt = datetime.strptime(val, fmt)
            return int(time_module.mktime(dt.timetuple()))
        except Exception:
            pass

    # ISO 8601 format (e.g. 2023-08-14T15:30:00.000000Z)
    try:
        iso_clean = val.rstrip("Z").split(".")[0].replace("T", " ")
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
            try:
                dt = datetime.strptime(iso_clean, fmt)
                return int(time_module.mktime(dt.timetuple()))
            except Exception:
                pass
    except Exception:
        pass

    return None


def _extract_image_exif_time(full_path: str) -> int | None:
    try:
        with Image.open(full_path) as img:
            exif = img.getexif()
            if not exif:
                return None
            # 36867 = DateTimeOriginal, 306 = DateTime, 36868 = DateTimeDigitized
            for tag in (36867, 306, 36868):
                raw_val = exif.get(tag)
                if raw_val:
                    ts = _parse_date_str(str(raw_val))
                    if ts is not None:
                        return ts
    except Exception:
        pass
    return None


def _extract_video_creation_time(full_path: str) -> int | None:
    ffprobe = _ffprobe_path()
    if not ffprobe:
        return None
    try:
        cmd = [
            ffprobe,
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            full_path,
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        if proc.returncode != 0 or not proc.stdout:
            return None
        data = json.loads(proc.stdout)
        tags = data.get("format", {}).get("tags", {})
        if isinstance(tags, dict):
            for key, val in tags.items():
                if key.lower() in ("creation_time", "date", "date-time"):
                    ts = _parse_date_str(str(val))
                    if ts is not None:
                        return ts
    except Exception:
        pass
    return None


def extract_capture_time(full_path: str, ext: str) -> tuple[int | None, str]:
    """Extract capture epoch timestamp and source label from file metadata."""
    ext_lower = ext.lower()
    if ext_lower in IMAGE_EXTS:
        ts = _extract_image_exif_time(full_path)
        if ts is not None:
            return ts, "exif"
    elif ext_lower in VIDEO_EXTS:
        ts = _extract_video_creation_time(full_path)
        if ts is not None:
            return ts, "video"

    # Fallback to filesystem creation time
    try:
        ctime = int(os.path.getctime(full_path))
        return ctime, "fs_ctime"
    except Exception:
        return None, "fs_ctime"


def reindex_device(device_id: str) -> None:
    files = get_files_for_device(device_id)
    cache = get_media_index_cache("phone", device_id)
    seen_paths: set[str] = set()
    now_ts = int(time_module.time())

    for f in files:
        rel_path = f["path"]
        ext = os.path.splitext(rel_path)[1].lower()
        if ext not in IMAGE_EXTS and ext not in VIDEO_EXTS:
            continue

        try:
            full_path = full_path_for(rel_path, device_id)
        except Exception:
            continue

        if not os.path.isfile(full_path):
            continue

        size = f.get("size", 0)
        mtime = f.get("modified_time", 0)
        seen_paths.add(rel_path)

        cached_entry = cache.get(rel_path)
        if cached_entry and cached_entry == (size, mtime):
            continue

        cap_time, cap_source = extract_capture_time(full_path, ext)
        cap_month, cap_day, cap_year = None, None, None
        if cap_time is not None:
            try:
                dt = datetime.fromtimestamp(cap_time)
                cap_month, cap_day, cap_year = dt.month, dt.day, dt.year
            except Exception:
                pass

        upsert_media_index_row(
            source_type="phone",
            source_key=device_id,
            relative_path=rel_path,
            size=size,
            modified_time=mtime,
            capture_time=cap_time,
            capture_source=cap_source,
            cap_month=cap_month,
            cap_day=cap_day,
            cap_year=cap_year,
            indexed_at=now_ts,
        )

    prune_media_index("phone", device_id, seen_paths)


def reindex_shared(source_id: str, root_path: str) -> None:
    if not os.path.isdir(root_path):
        return
    cache = get_media_index_cache("shared", source_id)
    seen_paths: set[str] = set()
    now_ts = int(time_module.time())

    for root, _, filenames in os.walk(root_path):
        for name in filenames:
            ext = os.path.splitext(name)[1].lower()
            if ext not in IMAGE_EXTS and ext not in VIDEO_EXTS:
                continue

            full_path = os.path.join(root, name)
            try:
                stat = os.stat(full_path)
            except Exception:
                continue

            size = stat.st_size
            mtime = int(stat.st_mtime)
            rel_path = os.path.relpath(full_path, root_path).replace("\\", "/")
            seen_paths.add(rel_path)

            cached_entry = cache.get(rel_path)
            if cached_entry and cached_entry == (size, mtime):
                continue

            cap_time, cap_source = extract_capture_time(full_path, ext)
            cap_month, cap_day, cap_year = None, None, None
            if cap_time is not None:
                try:
                    dt = datetime.fromtimestamp(cap_time)
                    cap_month, cap_day, cap_year = dt.month, dt.day, dt.year
                except Exception:
                    pass

            upsert_media_index_row(
                source_type="shared",
                source_key=source_id,
                relative_path=rel_path,
                size=size,
                modified_time=mtime,
                capture_time=cap_time,
                capture_source=cap_source,
                cap_month=cap_month,
                cap_day=cap_day,
                cap_year=cap_year,
                indexed_at=now_ts,
            )

    prune_media_index("shared", source_id, seen_paths)


def reindex_all() -> None:
    add_log("[Memories] Starting indexing scan...")
    try:
        devices = get_devices()
        for d in devices:
            dev_id = d.get("device_id")
            if dev_id:
                try:
                    reindex_device(dev_id)
                except Exception as e:
                    add_log(f"[Memories] Error reindexing device {dev_id}: {e}")

        shared_dirs = load_config().get("SHARED_DIRS", [])
        for s in shared_dirs:
            sid = s.get("id")
            spath = s.get("path")
            if sid and spath:
                try:
                    reindex_shared(sid, spath)
                except Exception as e:
                    add_log(f"[Memories] Error reindexing shared dir {sid}: {e}")
        add_log("[Memories] Indexing scan completed.")
    except Exception as e:
        add_log(f"[Memories] Indexing scan failed: {e}")


def startup_scan_loop() -> None:
    reindex_all()
    while True:
        try:
            now = datetime.now()
            tomorrow = datetime.combine(now.date() + timedelta(days=1), datetime.min.time())
            sleep_sec = max(10, (tomorrow - now).total_seconds() + 2)
            time_module.sleep(sleep_sec)
            reindex_all()
        except Exception as e:
            add_log(f"[Memories] Daemon loop error: {e}")
            time_module.sleep(300)


def get_todays_memories(device_id: str) -> dict:
    today = date.today()
    sources = [("phone", device_id)]

    shared_dirs = load_config().get("SHARED_DIRS", [])
    shared_labels = {}
    for d in shared_dirs:
        sid = d.get("id")
        label = d.get("label")
        tagged = d.get("device_ids", [])
        if sid and label:
            shared_labels[sid] = label
            if isinstance(tagged, list) and (device_id in tagged or "all" in tagged):
                sources.append(("shared", sid))

    rows = get_media_for_day(sources, today.month, today.day, exclude_year=today.year)

    grouped: dict[int, list[dict]] = {}
    for r in rows:
        yr = r.get("cap_year")
        if yr is None:
            continue
        ext = os.path.splitext(r["relative_path"])[1].lower()
        is_video = ext in VIDEO_EXTS
        s_type = r["source_type"]
        s_key = r["source_key"]
        s_label = "Phone Backup" if s_type == "phone" else shared_labels.get(s_key, "Shared Folder")

        item = {
            "source_type": s_type,
            "source_id": s_key,
            "source_label": s_label,
            "relative_path": r["relative_path"],
            "size": r["size"],
            "capture_time": r["capture_time"],
            "is_video": is_video,
        }
        grouped.setdefault(yr, []).append(item)

    sorted_years = sorted(grouped.keys(), reverse=True)
    groups = []
    for yr in sorted_years:
        years_ago = today.year - yr
        groups.append({
            "year": yr,
            "years_ago": years_ago,
            "items": grouped[yr],
        })

    return {
        "today": {"month": today.month, "day": today.day},
        "groups": groups,
    }
