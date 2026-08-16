"""Memories precomputation and daily media indexing module.

Precomputes capture dates (EXIF, ffprobe creation_time, or filesystem ctime)
into SQLite media_index cache for phone backups and tagged shared folders.
"""

from datetime import date, datetime, timedelta
import calendar
import json
import os
import random
import subprocess
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
    get_devices,
    get_distinct_cap_years,
    get_files_for_device,
    get_media_for_day,
    get_media_for_ymd_list,
    get_media_index_cache,
    get_quiz_photo_pool,
    get_random_media_row,
    get_year_wrapped_stats,
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


def _extract_image_exif_time(full_path: str) -> int | None:
    try:
        with Image.open(full_path) as img:
            exif = img.getexif()
            if not exif:
                return None
            tags = dict(exif)
            # DateTimeOriginal (36867) and DateTimeDigitized (36868) live in the
            # Exif sub-IFD (tag 0x8769), not the top-level IFD0 that getexif()
            # returns directly — without this, EXIF capture time is almost
            # always missed and files fall back to filesystem time.
            try:
                tags.update(exif.get_ifd(0x8769))
            except Exception:
                pass
            # 36867 = DateTimeOriginal, 36868 = DateTimeDigitized, 306 = DateTime
            for tag in (36867, 36868, 306):
                raw_val = tags.get(tag)
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


def extract_capture_time(full_path: str, ext: str, fallback_mtime: int | None = None) -> tuple[int | None, str]:
    """Extract capture epoch timestamp and source label from file metadata.

    fallback_mtime, when given, is the file's modified time as reported by
    the originating device/uploader. Most transfer paths preserve mtime from
    the original file, while the local filesystem's creation time only
    reflects when this copy landed on the backup server — so mtime is a far
    better last-resort proxy for the real capture date than local ctime.
    """
    ext_lower = ext.lower()
    if ext_lower in IMAGE_EXTS:
        ts = _extract_image_exif_time(full_path)
        if ts is not None:
            return ts, "exif"
    elif ext_lower in VIDEO_EXTS:
        ts = _extract_video_creation_time(full_path)
        if ts is not None:
            return ts, "video"

    # Fallback: prefer the originating device's modified time when available,
    # otherwise fall back to this local copy's filesystem creation time.
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
        unchanged = cached_entry and cached_entry[0] == size and cached_entry[1] == mtime
        # Retry extraction if we previously only got the fallback timestamp —
        # covers files re-indexed after fixing HEIC support or after ffmpeg
        # becomes available, for both images and videos.
        stale_fallback = cached_entry and cached_entry[2] == "fs_ctime" and (ext in IMAGE_EXTS or ext in VIDEO_EXTS)
        if unchanged and not stale_fallback:
            continue

        cap_time, cap_source = extract_capture_time(full_path, ext, fallback_mtime=mtime)
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
            unchanged = cached_entry and cached_entry[0] == size and cached_entry[1] == mtime
            stale_fallback = cached_entry and cached_entry[2] == "fs_ctime" and (ext in IMAGE_EXTS or ext in VIDEO_EXTS)
            if unchanged and not stale_fallback:
                continue

            cap_time, cap_source = extract_capture_time(full_path, ext, fallback_mtime=mtime)
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

    result_days = []
    for offset in range(max(1, days)):
        target_date = today - timedelta(days=offset)
        day_data = _build_day_memories(device_id, target_date, sources, shared_labels)
        result_days.append({
            "date": day_data["date"],
            "days_ago": offset,
            "is_today": offset == 0,
            "groups": day_data["groups"],
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