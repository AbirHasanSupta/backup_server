"""Trip clustering and album generation module.

Clusters media items on capture_time proximity (gap < 36-48h) and geographical
proximity (within ~50km), reverse-geocodes cluster centroids to place names,
and generates auto-curated trip album records.
"""

from datetime import datetime
import json
import math
import threading
import time
import urllib.request
import urllib.error

from database import (
    get_conn,
    get_devices,
    get_trips,
    get_trip_media,
    save_trip_clusters,
    get_cached_geocode,
    save_cached_geocode,
)
from state import add_log

MIN_TRIP_MEDIA_COUNT = 5
MAX_TIME_GAP_SECONDS = 36 * 3600  # 36 hours between consecutive shots
MAX_DISTANCE_KM = 50.0  # 50 km proximity threshold

_last_geocode_time = 0.0
_geocode_lock = threading.Lock()


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return r * c


def reverse_geocode(lat: float, lon: float) -> str | None:
    """Reverse geocode (lat, lon) to a city/region name with local cache and rate limiting."""
    lat_round = round(lat, 2)
    lon_round = round(lon, 2)

    cached = get_cached_geocode(lat_round, lon_round)
    if cached is not None:
        return cached if cached != "" else None

    global _last_geocode_time
    with _geocode_lock:
        now = time.time()
        elapsed = now - _last_geocode_time
        if elapsed < 1.1:
            time.sleep(1.1 - elapsed)
        _last_geocode_time = time.time()

        url = (
            f"https://nominatim.openstreetmap.org/reverse?format=jsonv2"
            f"&lat={lat_round}&lon={lon_round}&zoom=14&addressdetails=1"
        )
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "PhoneBackupServer/1.0",
                "Accept-Language": "en",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=8) as resp:
                if resp.status == 200:
                    data = json.loads(resp.read().decode("utf-8"))
                    addr = data.get("address", {})
                    # Pick best place name
                    place = (
                        addr.get("city")
                        or addr.get("town")
                        or addr.get("village")
                        or addr.get("municipality")
                        or addr.get("city_district")
                        or addr.get("suburb")
                        or addr.get("county")
                        or addr.get("state")
                        or addr.get("country")
                    )
                    if not place and data.get("display_name"):
                        parts = [p.strip() for p in data["display_name"].split(",") if p.strip()]
                        if parts:
                            place = parts[0]

                    if place:
                        save_cached_geocode(lat_round, lon_round, place)
                        return place
        except Exception as e:
            add_log(f"[Trips] Reverse geocode lookup error for ({lat_round}, {lon_round}): {e}")

    save_cached_geocode(lat_round, lon_round, "")
    return None


def generate_trip_title(start_time: int, end_time: int, place_name: str | None) -> str:
    """Generate a descriptive title like 'Weekend in Kyoto' or 'Trip to Paris'."""
    dt_start = datetime.fromtimestamp(start_time)
    duration_days = max(0.0, (end_time - start_time) / 86400.0)
    start_weekday = dt_start.weekday()  # Monday is 0, Sunday is 6; Friday=4, Sat=5, Sun=6

    if place_name:
        if duration_days <= 1.2:
            return f"Day in {place_name}"
        if duration_days <= 3.5 and start_weekday in (4, 5, 6):
            return f"Weekend in {place_name}"
        return f"Trip to {place_name}"

    month_str = dt_start.strftime("%B %Y")
    return f"Trip in {month_str}"


def cluster_source_media(source_id: str) -> list[dict]:
    """
    Cluster all geotagged media for source_id based on time and spatial proximity.
    Persists qualifying trip records (>= 5 media items) to the database.
    """
    conn = get_conn()
    rows = conn.execute(
        """
        SELECT id, source_type, source_key, relative_path, size, modified_time,
               capture_time, cap_lat, cap_lon
        FROM media_index
        WHERE source_key = ?
          AND cap_lat IS NOT NULL
          AND cap_lon IS NOT NULL
          AND capture_time IS NOT NULL
        ORDER BY capture_time ASC
        """,
        (source_id,),
    ).fetchall()
    conn.close()

    if not rows:
        # No geotagged media: clear existing trips for this source
        save_trip_clusters(source_id, [])
        return []

    items = [dict(r) for r in rows]

    # Cluster media chronologically
    clusters: list[list[dict]] = []
    current_cluster: list[dict] = []

    for it in items:
        if not current_cluster:
            current_cluster.append(it)
            continue

        prev = current_cluster[-1]
        time_gap = (it["capture_time"] or 0) - (prev["capture_time"] or 0)

        # Spatial distance to cluster centroid
        c_lats = [x["cap_lat"] for x in current_cluster]
        c_lons = [x["cap_lon"] for x in current_cluster]
        c_lat = sum(c_lats) / len(c_lats)
        c_lon = sum(c_lons) / len(c_lons)
        dist_km = _haversine_km(it["cap_lat"], it["cap_lon"], c_lat, c_lon)

        if time_gap <= MAX_TIME_GAP_SECONDS and dist_km <= MAX_DISTANCE_KM:
            current_cluster.append(it)
        else:
            clusters.append(current_cluster)
            current_cluster = [it]

    if current_cluster:
        clusters.append(current_cluster)

    # Filter by minimum threshold and format trip records
    image_exts = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}
    qualifying_clusters = []

    for c in clusters:
        if len(c) < MIN_TRIP_MEDIA_COUNT:
            continue

        c_lats = [x["cap_lat"] for x in c]
        c_lons = [x["cap_lon"] for x in c]
        center_lat = round(sum(c_lats) / len(c_lats), 6)
        center_lon = round(sum(c_lons) / len(c_lons), 6)

        times = [x["capture_time"] for x in c if x.get("capture_time")]
        start_time = min(times)
        end_time = max(times)

        # Pick cover media: prefer first image, fallback to first item
        cover_id = None
        for it in c:
            path = it["relative_path"].lower()
            ext = ("." + path.rsplit(".", 1)[-1]) if "." in path else ""
            if ext in image_exts:
                cover_id = it["id"]
                break
        if not cover_id and c:
            cover_id = c[0]["id"]

        place_name = reverse_geocode(center_lat, center_lon)
        title = generate_trip_title(start_time, end_time, place_name)

        qualifying_clusters.append({
            "title": title,
            "start_time": start_time,
            "end_time": end_time,
            "center_lat": center_lat,
            "center_lon": center_lon,
            "media_count": len(c),
            "cover_media_id": cover_id,
            "media_ids": [x["id"] for x in c],
        })

    # Save to database idempotently
    save_trip_clusters(source_id, qualifying_clusters)
    if qualifying_clusters:
        add_log(f"[Trips] Generated {len(qualifying_clusters)} trip album(s) for source {source_id}")

    return qualifying_clusters


def cluster_all_devices() -> None:
    """Run trip clustering for all registered devices."""
    devices = get_devices()
    for d in devices:
        did = d.get("device_id")
        if did:
            try:
                cluster_source_media(did)
            except Exception as e:
                add_log(f"[Trips] Clustering failed for device {did}: {e}")


_debounce_timers: dict[str, threading.Timer] = {}
_timer_lock = threading.Lock()


def trigger_background_clustering(source_id: str | None = None) -> None:
    """Trigger background clustering with a 3-second debounce window."""
    def _run():
        if source_id:
            try:
                cluster_source_media(source_id)
            except Exception as e:
                add_log(f"[Trips] Background clustering failed for {source_id}: {e}")
        else:
            cluster_all_devices()

    with _timer_lock:
        key = source_id or "__all__"
        if key in _debounce_timers:
            _debounce_timers[key].cancel()

        timer = threading.Timer(3.0, _run)
        timer.daemon = True
        _debounce_timers[key] = timer
        timer.start()
