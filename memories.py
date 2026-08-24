"""Memories precomputation and daily media indexing module.

Precomputes capture dates (EXIF, ffprobe creation_time, or filesystem ctime)
into SQLite media_index cache for phone backups and tagged shared folders.
"""

from datetime import date, datetime, timedelta
import calendar
import concurrent.futures
import json
import os
import random
import subprocess
import threading
import time as time_module
from PIL import Image

try:
    # Bare Pillow cannot open HEIC/HEIF (the default capture format on most
    # iPhones and many Android phones) — without this, EXIF extraction for
    # those files always fails silently and falls back to the file's local
    # backup-copy time instead of the real capture date.
    import pillow_heif
    pillow_heif.register_heif_opener()
except Exception:
    pass

from config import load_config
from database import (
    batch_upsert_media_index_rows,
    clear_media_index,
    get_devices,
    get_distinct_cap_years,
    get_files_for_device,
    get_geotagged_media,
    get_media_for_day,
    get_media_for_days_multi,
    get_media_for_ymd_list,
    get_media_index_cache,
    get_media_index_stats,
    get_quiz_photo_pool,
    get_random_media_row,
    get_scan_dirs,
    get_year_wrapped_stats,
    prune_media_index,
    upsert_media_index_row,
    upsert_scan_dirs,
)
from state import add_log
from storage import full_path_in_root, resolve_backup_root
from video_preview import _ffprobe_path
from trips import trigger_background_clustering

IMAGE_EXTS = {
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif",
    ".bmp", ".tiff", ".tif", ".avif", ".svg",
}

VIDEO_EXTS = {
    ".mp4", ".mov", ".avi", ".mkv", ".webm", ".3gp",
    ".m4v", ".wmv", ".flv", ".ts", ".mts",
}

# Formats Android expo-image / typical ffmpeg still encodes can show without HEIF plugins.
CLIENT_DISPLAYABLE_STILL_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
CLIENT_ROULETTE_EXTS = CLIENT_DISPLAYABLE_STILL_EXTS | VIDEO_EXTS
CLIENT_FLASHBACK_EXTS = CLIENT_ROULETTE_EXTS


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


def _gps_dms_to_decimal(dms, ref: str) -> float | None:
    try:
        degrees, minutes, seconds = float(dms[0]), float(dms[1]), float(dms[2])
        decimal = degrees + minutes / 60.0 + seconds / 3600.0
        if ref in ("S", "W"):
            decimal = -decimal
        return decimal
    except Exception:
        return None


def _extract_image_exif_and_gps(full_path: str) -> tuple[int | None, tuple[float, float] | None]:
    cap_time = None
    gps_point = None
    try:
        with Image.open(full_path) as img:
            exif = img.getexif()
            if not exif:
                return None, None

            tags = dict(exif)
            try:
                tags.update(exif.get_ifd(0x8769))
            except Exception:
                pass
            for tag in (36867, 36868, 306):
                raw_val = tags.get(tag)
                if raw_val:
                    ts = _parse_date_str(str(raw_val))
                    if ts is not None:
                        cap_time = ts
                        break

            try:
                gps = exif.get_ifd(0x8825)
            except Exception:
                gps = None
            if gps:
                lat_dms = gps.get(2)
                lat_ref = gps.get(1)
                lon_dms = gps.get(4)
                lon_ref = gps.get(3)
                if lat_dms and lat_ref and lon_dms and lon_ref:
                    lat = _gps_dms_to_decimal(lat_dms, lat_ref)
                    lon = _gps_dms_to_decimal(lon_dms, lon_ref)
                    if lat is not None and lon is not None and not (lat == 0 and lon == 0):
                        gps_point = (round(lat, 6), round(lon, 6))
    except Exception:
        pass
    return cap_time, gps_point


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
        run_options = {
            "capture_output": True,
            "text": True,
            "timeout": 10,
            "stdin": subprocess.DEVNULL,
        }
        if os.name == "nt":
            run_options["creationflags"] = subprocess.CREATE_NO_WINDOW
        proc = subprocess.run(cmd, **run_options)
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


def _fallback_capture_time(full_path: str, fallback_mtime: int | None) -> tuple[int | None, str]:
    candidates = []
    if fallback_mtime:
        candidates.append(int(fallback_mtime))
    try:
        candidates.append(int(os.path.getctime(full_path)))
    except Exception:
        pass
    try:
        candidates.append(int(os.path.getmtime(full_path)))
    except Exception:
        pass
    if not candidates:
        return None, "fs_ctime"
    return min(candidates), "fs_ctime"


def extract_capture_time(full_path: str, ext: str, fallback_mtime: int | None = None) -> tuple[int | None, str]:
    ext_lower = ext.lower()
    if ext_lower in IMAGE_EXTS:
        ts, _gps = _extract_image_exif_and_gps(full_path)
        if ts is not None:
            return ts, "exif"
    elif ext_lower in VIDEO_EXTS:
        ts = _extract_video_creation_time(full_path)
        if ts is not None:
            return ts, "video"
    return _fallback_capture_time(full_path, fallback_mtime)


def _extract_media_row_metadata(item: dict) -> dict:
    """Extract EXIF/GPS/video timestamp metadata for a single media file."""
    full_path = item["full_path"]
    ext = item["ext"]
    mtime = item["modified_time"]
    size = item["size"]
    now_ts = item["now_ts"]

    cap_lat, cap_lon = None, None
    gps_checked = ext in IMAGE_EXTS

    if gps_checked:
        cap_time, gps = _extract_image_exif_and_gps(full_path)
        cap_source = "exif" if cap_time is not None else None
        if gps:
            cap_lat, cap_lon = gps
        if cap_time is None:
            cap_time, cap_source = _fallback_capture_time(full_path, mtime)
    elif ext in VIDEO_EXTS:
        cap_time = _extract_video_creation_time(full_path)
        cap_source = "video" if cap_time is not None else None
        if cap_time is None:
            cap_time, cap_source = _fallback_capture_time(full_path, mtime)
    else:
        cap_time, cap_source = _fallback_capture_time(full_path, mtime)

    cap_month, cap_day, cap_year = None, None, None
    if cap_time is not None:
        try:
            dt = datetime.fromtimestamp(cap_time)
            cap_month, cap_day, cap_year = dt.month, dt.day, dt.year
        except Exception:
            pass

    return {
        "source_type": item["source_type"],
        "source_key": item["source_key"],
        "relative_path": item["relative_path"],
        "size": size,
        "modified_time": mtime,
        "capture_time": cap_time,
        "capture_source": cap_source,
        "cap_month": cap_month,
        "cap_day": cap_day,
        "cap_year": cap_year,
        "indexed_at": now_ts,
        "cap_lat": cap_lat,
        "cap_lon": cap_lon,
        "gps_checked": gps_checked,
    }


def _resolve_worker_counts() -> tuple[int, int]:
    cfg = load_config()
    cpu = os.cpu_count() or 4
    default_image = min(32, cpu * 4)
    default_video = max(2, cpu)
    try:
        image_workers = int(cfg.get("MEMORIES_IMAGE_WORKERS") or default_image)
    except (TypeError, ValueError):
        image_workers = default_image
    try:
        video_workers = int(cfg.get("MEMORIES_VIDEO_WORKERS") or default_video)
    except (TypeError, ValueError):
        video_workers = default_video
    return max(2, image_workers), max(1, video_workers)


def _run_extraction(items: list[dict]) -> list[dict]:
    image_items = [it for it in items if it["ext"] in IMAGE_EXTS]
    video_items = [it for it in items if it["ext"] not in IMAGE_EXTS]
    image_workers, video_workers = _resolve_worker_counts()

    rows: list[dict] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=image_workers) as img_ex, \
         concurrent.futures.ThreadPoolExecutor(max_workers=video_workers) as vid_ex:
        futures = [img_ex.submit(_extract_media_row_metadata, it) for it in image_items]
        futures += [vid_ex.submit(_extract_media_row_metadata, it) for it in video_items]
        for fut in concurrent.futures.as_completed(futures):
            rows.append(fut.result())
    return rows


def _flush_rows(rows: list[dict]) -> None:
    batch_size = 500
    for i in range(0, len(rows), batch_size):
        batch_upsert_media_index_rows(rows[i:i + batch_size])


def reindex_device(device_id: str) -> None:
    files = get_files_for_device(device_id)
    cache = get_media_index_cache("phone", device_id)
    try:
        device_root = resolve_backup_root(device_id)
    except Exception:
        return

    seen_paths: set[str] = set()
    now_ts = int(time_module.time())
    to_process: list[dict] = []

    for f in files:
        rel_path = f["path"]
        ext = os.path.splitext(rel_path)[1].lower()
        if ext not in IMAGE_EXTS and ext not in VIDEO_EXTS:
            continue

        size = f.get("size", 0)
        mtime = f.get("modified_time", 0)

        cached_entry = cache.get(rel_path)
        unchanged = cached_entry and cached_entry[0] == size and cached_entry[1] == mtime
        stale_fallback = cached_entry and cached_entry[2] == "fs_ctime"
        missing_gps = cached_entry and ext in IMAGE_EXTS and not cached_entry[4]
        if unchanged and not stale_fallback and not missing_gps:
            seen_paths.add(rel_path)
            continue

        try:
            full_path = full_path_in_root(device_root, rel_path)
        except Exception:
            continue
        if not os.path.isfile(full_path):
            continue
        seen_paths.add(rel_path)

        to_process.append({
            "source_type": "phone",
            "source_key": device_id,
            "relative_path": rel_path,
            "full_path": full_path,
            "size": size,
            "modified_time": mtime,
            "ext": ext,
            "now_ts": now_ts,
        })

    if to_process:
        _flush_rows(_run_extraction(to_process))

    prune_media_index("phone", device_id, seen_paths, existing_paths=set(cache.keys()))
    trigger_background_clustering(device_id)


def _rel_dirname(rel_path: str) -> str:
    idx = rel_path.rfind("/")
    return rel_path[:idx] if idx != -1 else ""


def _rel_to_abs(root_path: str, rel_path: str) -> str:
    return os.path.join(root_path, *rel_path.split("/"))


def reindex_shared(source_id: str, root_path: str) -> None:
    if not os.path.isdir(root_path):
        return

    cache = get_media_index_cache("shared", source_id)
    cached_dirs = get_scan_dirs("shared", source_id)
    dir_children: dict[str, list[str]] = {}
    for rel_path in cache:
        dir_children.setdefault(_rel_dirname(rel_path), []).append(rel_path)

    seen_paths: set[str] = set()
    dir_updates: dict[str, int] = {}
    now_ts = int(time_module.time())
    to_process: list[dict] = []

    stack: list[tuple[str, str]] = [("", root_path)]
    while stack:
        rel_dir, abs_dir = stack.pop()
        try:
            dstat = os.stat(abs_dir)
            entries = list(os.scandir(abs_dir))
        except Exception:
            continue

        dir_updates[rel_dir] = dstat.st_mtime_ns
        skip_files = cached_dirs.get(rel_dir) == dstat.st_mtime_ns

        if skip_files:
            for rel_path in dir_children.get(rel_dir, []):
                ext = os.path.splitext(rel_path)[1].lower()
                cached_entry = cache.get(rel_path)
                seen_paths.add(rel_path)
                stale_fallback = cached_entry[2] == "fs_ctime"
                missing_gps = ext in IMAGE_EXTS and not cached_entry[4]
                if not (stale_fallback or missing_gps):
                    continue
                full_path = _rel_to_abs(root_path, rel_path)
                if not os.path.isfile(full_path):
                    continue
                to_process.append({
                    "source_type": "shared",
                    "source_key": source_id,
                    "relative_path": rel_path,
                    "full_path": full_path,
                    "size": cached_entry[0],
                    "modified_time": cached_entry[1],
                    "ext": ext,
                    "now_ts": now_ts,
                })
        else:
            for entry in entries:
                if entry.is_dir(follow_symlinks=False):
                    continue
                ext = os.path.splitext(entry.name)[1].lower()
                if ext not in IMAGE_EXTS and ext not in VIDEO_EXTS:
                    continue
                try:
                    fstat = entry.stat(follow_symlinks=False)
                except Exception:
                    continue

                size = fstat.st_size
                mtime = int(fstat.st_mtime)
                rel_path = f"{rel_dir}/{entry.name}" if rel_dir else entry.name
                seen_paths.add(rel_path)

                cached_entry = cache.get(rel_path)
                unchanged = cached_entry and cached_entry[0] == size and cached_entry[1] == mtime
                stale_fallback = cached_entry and cached_entry[2] == "fs_ctime"
                missing_gps = cached_entry and ext in IMAGE_EXTS and not cached_entry[4]
                if unchanged and not stale_fallback and not missing_gps:
                    continue

                to_process.append({
                    "source_type": "shared",
                    "source_key": source_id,
                    "relative_path": rel_path,
                    "full_path": entry.path,
                    "size": size,
                    "modified_time": mtime,
                    "ext": ext,
                    "now_ts": now_ts,
                })

        for entry in entries:
            if entry.is_dir(follow_symlinks=False):
                child_rel = f"{rel_dir}/{entry.name}" if rel_dir else entry.name
                stack.append((child_rel, entry.path))

    if to_process:
        _flush_rows(_run_extraction(to_process))

    prune_media_index("shared", source_id, seen_paths, existing_paths=set(cache.keys()))
    upsert_scan_dirs("shared", source_id, dir_updates)


_reindex_lock = threading.Lock()


def _do_reindex_all() -> None:
    add_log("[Memories] Starting indexing scan...")
    try:
        tasks: list[tuple[str, str, str | None]] = []
        for d in get_devices():
            dev_id = d.get("device_id")
            if dev_id:
                tasks.append(("device", dev_id, None))

        shared_dirs = load_config().get("SHARED_DIRS", [])
        for s in shared_dirs:
            sid = s.get("id")
            spath = s.get("path")
            if sid and spath:
                tasks.append(("shared", sid, spath))

        def _run_task(task: tuple[str, str, str | None]) -> None:
            kind, key, path = task
            try:
                if kind == "device":
                    reindex_device(key)
                else:
                    reindex_shared(key, path)
            except Exception as e:
                add_log(f"[Memories] Error reindexing {kind} {key}: {e}")

        max_workers = min(4, max(1, len(tasks)))
        if tasks:
            with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
                list(executor.map(_run_task, tasks))

        add_log("[Memories] Indexing scan completed.")
        trigger_background_clustering()
    except Exception as e:
        add_log(f"[Memories] Indexing scan failed: {e}")


def reindex_all() -> None:
    if not _reindex_lock.acquire(blocking=False):
        add_log("[Memories] Skipped scan: another indexing run is already in progress.")
        return
    try:
        _do_reindex_all()
    finally:
        _reindex_lock.release()


def reset_and_reindex_all() -> dict:
    """Clear the media_index/scan_dirs cache entirely and rebuild it from scratch."""
    if not _reindex_lock.acquire(blocking=True, timeout=10):
        add_log("[Memories] Reset skipped: indexing already in progress.")
        return {"ok": False, "error": "Indexing already in progress, try again shortly."}
    try:
        cleared = clear_media_index()
        add_log(f"[Memories] Memory index cleared ({cleared} rows). Starting full rescan...")
        _do_reindex_all()
        return {"ok": True, "cleared": cleared}
    finally:
        _reindex_lock.release()


def get_memory_index_stats() -> dict:
    return get_media_index_stats()


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


def _shared_sources_for_device(device_id: str, shared_dirs: list) -> tuple[list[tuple[str, str]], dict[str, str]]:
    sources = [("phone", device_id)]
    shared_labels = {}
    for d in shared_dirs:
        sid = d.get("id")
        label = d.get("label")
        tagged = d.get("device_ids", [])
        if sid and label:
            shared_labels[sid] = label
            if isinstance(tagged, list) and (device_id in tagged or "all" in tagged):
                sources.append(("shared", sid))
    return sources, shared_labels


def _build_day_memories(
    device_id: str,
    target_date: date,
    sources: list[tuple[str, str]],
    shared_labels: dict[str, str],
) -> dict:
    rows = get_media_for_day(sources, target_date.month, target_date.day, exclude_year=target_date.year)

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
        groups.append({
            "year": yr,
            "years_ago": target_date.year - yr,
            "items": grouped[yr],
        })

    return {
        "date": {"month": target_date.month, "day": target_date.day, "year": target_date.year},
        "groups": groups,
    }


def get_todays_memories(device_id: str) -> dict:
    today = date.today()
    shared_dirs = load_config().get("SHARED_DIRS", [])
    sources, shared_labels = _shared_sources_for_device(device_id, shared_dirs)
    day_data = _build_day_memories(device_id, today, sources, shared_labels)

    return {
        "today": {"month": today.month, "day": today.day},
        "groups": day_data["groups"],
    }


def get_recent_memories(device_id: str, days: int = 7) -> dict:
    today = date.today()
    shared_dirs = load_config().get("SHARED_DIRS", [])
    sources, shared_labels = _shared_sources_for_device(device_id, shared_dirs)

    num_days = max(1, days)
    target_dates = [today - timedelta(days=offset) for offset in range(num_days)]
    month_day_pairs = [(d.month, d.day) for d in target_dates]

    # Fetch media for all requested days in a single batched query
    all_rows = get_media_for_days_multi(sources, month_day_pairs)

    rows_by_md: dict[tuple[int, int], list[dict]] = {}
    for r in all_rows:
        m = r.get("cap_month")
        d = r.get("cap_day")
        if m is not None and d is not None:
            rows_by_md.setdefault((m, d), []).append(r)

    result_days = []
    for offset, target_date in enumerate(target_dates):
        day_rows = rows_by_md.get((target_date.month, target_date.day), [])
        valid_rows = [
            r for r in day_rows
            if r.get("cap_year") is None or r.get("cap_year") != target_date.year
        ]

        grouped: dict[int, list[dict]] = {}
        for r in valid_rows:
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
            groups.append({
                "year": yr,
                "years_ago": target_date.year - yr,
                "items": grouped[yr],
            })

        result_days.append({
            "date": {"month": target_date.month, "day": target_date.day, "year": target_date.year},
            "days_ago": offset,
            "is_today": offset == 0,
            "groups": groups,
        })

    return {"days": result_days}


# ─── Random Flashback ────────────────────────────────────────────────────────

FLASHBACK_YEARS_AGO = [1, 2, 3, 5, 7, 10]
FLASHBACK_WEIGHTS = [5, 4, 3, 2, 1, 1]
FLASHBACK_WINDOW_DAYS = 4


def _safe_anniversary(year: int, month: int, day: int) -> date:
    """Clamp day for months that don't have that day (e.g. Feb 29 → Feb 28)."""
    max_day = calendar.monthrange(year, month)[1]
    return date(year, month, min(day, max_day))


def get_random_flashback(device_id: str) -> dict | None:
    """Pick one random media item from roughly 'N years ago this week',
    weighted toward more recent years so flashbacks feel closer to home."""
    today = date.today()
    shared_dirs = load_config().get("SHARED_DIRS", [])
    sources, shared_labels = _shared_sources_for_device(device_id, shared_dirs)

    candidates: list[tuple[int, int, list[dict]]] = []
    for years_ago, weight in zip(FLASHBACK_YEARS_AGO, FLASHBACK_WEIGHTS):
        target_year = today.year - years_ago
        anchor = _safe_anniversary(target_year, today.month, today.day)
        ymd_list = []
        for offset in range(-FLASHBACK_WINDOW_DAYS, FLASHBACK_WINDOW_DAYS + 1):
            d = anchor + timedelta(days=offset)
            ymd_list.append((d.year, d.month, d.day))

        rows = get_media_for_ymd_list(sources, ymd_list)
        rows = [
            r for r in rows
            if os.path.splitext(r["relative_path"])[1].lower() in CLIENT_FLASHBACK_EXTS
        ]
        if rows:
            candidates.append((years_ago, weight, rows))

    if not candidates:
        return None

    weights = [c[1] for c in candidates]
    years_ago, _, rows = random.choices(candidates, weights=weights, k=1)[0]
    row = random.choice(rows)

    ext = os.path.splitext(row["relative_path"])[1].lower()
    is_video = ext in VIDEO_EXTS
    s_type = row["source_type"]
    s_key = row["source_key"]
    s_label = "Phone Backup" if s_type == "phone" else shared_labels.get(s_key, "Shared Folder")

    return {
        "source_type": s_type,
        "source_id": s_key,
        "source_label": s_label,
        "relative_path": row["relative_path"],
        "size": row["size"],
        "capture_time": row["capture_time"],
        "is_video": is_video,
        "year": row["cap_year"],
        "years_ago": years_ago,
    }


# ─── Year Wrapped ─────────────────────────────────────────────────────────────

def get_wrapped(device_id: str, year: int) -> dict:
    shared_dirs = load_config().get("SHARED_DIRS", [])
    sources, _ = _shared_sources_for_device(device_id, shared_dirs)
    rows = get_year_wrapped_stats(sources, year)

    photos = 0
    videos = 0
    total_size = 0
    month_counts = {m: 0 for m in range(1, 13)}

    for r in rows:
        ext = os.path.splitext(r["relative_path"])[1].lower()
        if ext in VIDEO_EXTS:
            videos += 1
        else:
            photos += 1
        total_size += r.get("size", 0) or 0
        m = r.get("cap_month")
        if m and 1 <= m <= 12:
            month_counts[m] += 1

    total = photos + videos
    busiest_month = max(month_counts, key=lambda m: month_counts[m]) if total > 0 else None
    if busiest_month is not None and month_counts[busiest_month] == 0:
        busiest_month = None

    return {
        "year": year,
        "total": total,
        "photos": photos,
        "videos": videos,
        "total_size": total_size,
        "busiest_month": busiest_month,
        "busiest_month_count": month_counts.get(busiest_month, 0) if busiest_month is not None else 0,
        # String keys so JSON clients don't depend on int-key coercion.
        "month_counts": {str(m): month_counts[m] for m in range(1, 13)},
    }


# ─── Guess the Year ───────────────────────────────────────────────────────────

QUIZ_DEFAULT_COUNT = 10
QUIZ_OPTION_COUNT = 4
QUIZ_MIN_DISTINCT_YEARS = 3
QUIZ_DISPLAYABLE_EXTS = CLIENT_DISPLAYABLE_STILL_EXTS


def get_quiz_photos(source_type: str, source_key: str, count: int = 10) -> list[dict]:
    """Thin wrapper matching the public name from the feature spec."""
    pool = get_quiz_photo_pool([(source_type, source_key)])
    photo_pool = [
        r for r in pool
        if os.path.splitext(r["relative_path"])[1].lower() in QUIZ_DISPLAYABLE_EXTS
    ]
    if len(photo_pool) <= count:
        return photo_pool
    return random.sample(photo_pool, count)


def get_quiz_round(device_id: str, count: int = QUIZ_DEFAULT_COUNT) -> dict:
    shared_dirs = load_config().get("SHARED_DIRS", [])
    sources, _ = _shared_sources_for_device(device_id, shared_dirs)
    distinct_years = get_distinct_cap_years(sources)
    if len(distinct_years) < QUIZ_MIN_DISTINCT_YEARS:
        return {"items": []}

    pool = get_quiz_photo_pool(sources)
    photo_pool = [
        r for r in pool
        if os.path.splitext(r["relative_path"])[1].lower() in QUIZ_DISPLAYABLE_EXTS
    ]

    if len(photo_pool) < 2:
        return {"items": []}

    round_size = min(max(1, count), len(photo_pool))
    chosen = random.sample(photo_pool, round_size)

    items = []
    for row in chosen:
        correct_year = row["cap_year"]
        wrong_pool = [y for y in distinct_years if y != correct_year]

        if len(wrong_pool) >= QUIZ_OPTION_COUNT - 1:
            wrong_years = random.sample(wrong_pool, QUIZ_OPTION_COUNT - 1)
        else:
            wrong_years = list(wrong_pool)
            jitter = 1
            guard = 0
            while len(wrong_years) < QUIZ_OPTION_COUNT - 1 and guard < 40:
                offset = jitter if jitter % 2 else -jitter
                candidate = correct_year + offset
                jitter += 1
                guard += 1
                if candidate != correct_year and candidate not in wrong_years:
                    wrong_years.append(candidate)

        options = wrong_years + [correct_year]
        random.shuffle(options)

        items.append({
            "source_type": row["source_type"],
            "source_id": row["source_key"],
            "relative_path": row["relative_path"],
            "correct_year": correct_year,
            "capture_time": row.get("capture_time"),
            "options": options,
        })

    return {"items": items}


# ─── Photo Roulette ───────────────────────────────────────────────────────────

def get_roulette_item(device_id: str) -> dict | None:
    shared_dirs = load_config().get("SHARED_DIRS", [])
    sources, shared_labels = _shared_sources_for_device(device_id, shared_dirs)
    row = get_random_media_row(sources, allowed_exts=CLIENT_ROULETTE_EXTS)
    if not row:
        return None

    ext = os.path.splitext(row["relative_path"])[1].lower()
    is_video = ext in VIDEO_EXTS
    s_type = row["source_type"]
    s_key = row["source_key"]
    s_label = "Phone Backup" if s_type == "phone" else shared_labels.get(s_key, "Shared Folder")

    return {
        "source_type": s_type,
        "source_id": s_key,
        "source_label": s_label,
        "relative_path": row["relative_path"],
        "size": row["size"],
        "capture_time": row["capture_time"],
        "is_video": is_video,
        "year": row["cap_year"],
    }


# ─── Place Clustering ──────────────────────────────────────────────────────────

PLACE_GRID_PRECISION = 2  # ~1.1km grid cells at the equator
PLACE_MIN_ITEMS = 2
PLACE_MAX_CLUSTERS = 40


def _place_key(lat: float, lon: float) -> tuple[float, float]:
    return (round(lat, PLACE_GRID_PRECISION), round(lon, PLACE_GRID_PRECISION))


def get_place_clusters(device_id: str) -> dict:
    shared_dirs = load_config().get("SHARED_DIRS", [])
    sources, _ = _shared_sources_for_device(device_id, shared_dirs)
    rows = get_geotagged_media(sources)

    clusters: dict[tuple[float, float], list[dict]] = {}
    for r in rows:
        key = _place_key(r["cap_lat"], r["cap_lon"])
        clusters.setdefault(key, []).append(r)

    results = []
    for (lat, lon), items in clusters.items():
        if len(items) < PLACE_MIN_ITEMS:
            continue
        items.sort(key=lambda it: it.get("capture_time") or 0, reverse=True)
        cover = items[0]
        ext = os.path.splitext(cover["relative_path"])[1].lower()
        results.append({
            "cluster_key": f"{lat}:{lon}",
            "lat": lat,
            "lon": lon,
            "count": len(items),
            "cover": {
                "source_type": cover["source_type"],
                "source_id": cover["source_key"],
                "relative_path": cover["relative_path"],
                "is_video": ext in VIDEO_EXTS,
            },
        })

    results.sort(key=lambda c: c["count"], reverse=True)
    return {"places": results[:PLACE_MAX_CLUSTERS]}


def get_place_items(device_id: str, cluster_key: str) -> dict:
    shared_dirs = load_config().get("SHARED_DIRS", [])
    sources, shared_labels = _shared_sources_for_device(device_id, shared_dirs)
    rows = get_geotagged_media(sources)

    try:
        lat_str, lon_str = cluster_key.split(":")
        target = (round(float(lat_str), PLACE_GRID_PRECISION), round(float(lon_str), PLACE_GRID_PRECISION))
    except Exception:
        return {"items": []}

    items = []
    for r in rows:
        if _place_key(r["cap_lat"], r["cap_lon"]) != target:
            continue
        ext = os.path.splitext(r["relative_path"])[1].lower()
        s_type = r["source_type"]
        s_key = r["source_key"]
        s_label = "Phone Backup" if s_type == "phone" else shared_labels.get(s_key, "Shared Folder")
        items.append({
            "source_type": s_type,
            "source_id": s_key,
            "source_label": s_label,
            "relative_path": r["relative_path"],
            "size": r["size"],
            "capture_time": r["capture_time"],
            "is_video": ext in VIDEO_EXTS,
            "year": r["cap_year"],
        })

    items.sort(key=lambda it: it.get("capture_time") or 0, reverse=True)
    return {"items": items}