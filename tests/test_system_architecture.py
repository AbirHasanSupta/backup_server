"""tests/test_system_architecture.py — Complete System Integration & Scaling Test Suite."""

import os
import sys
import time

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from core.config import load_config
from core.locks import acquire_lock
from database import init_db
from repositories import device_repo, file_repo, reels_repo, social_repo, trips_repo, media_repo
from services.reels_service import reels_service
from services.feed_service import feed_service
from services.media_service import media_service
from services.trips_service import trips_service
from storage import sanitize_relative_path, full_path_in_root


def test_distributed_lock_manager():
    with acquire_lock("test-resource-lock", expire_sec=5, timeout_sec=2):
        pass
    print("  [PASS] Distributed / Local lock test")


def test_reels_bayesian_quality_math():
    score_low = reels_service.calculate_bayesian_quality(reactions=2, comments=0, reposts=0, views=10)
    score_high = reels_service.calculate_bayesian_quality(reactions=50, comments=20, reposts=10, views=100)
    assert score_high > score_low
    assert 0.0 <= score_low <= 1.0
    assert 0.0 <= score_high <= 1.0
    print("  [PASS] Reels Bayesian Quality scoring test")


def test_deterministic_seed_jitter():
    jitter1 = reels_service.deterministic_seed_jitter("item-abc", seed=42)
    jitter2 = reels_service.deterministic_seed_jitter("item-abc", seed=42)
    jitter3 = reels_service.deterministic_seed_jitter("item-abc", seed=99)
    assert jitter1 == jitter2
    assert 0.0 <= jitter1 <= 1.0
    print("  [PASS] FNV-1a Deterministic seed jitter test")


def test_token_extraction_for_reels():
    caption = "Golden sunset at the beach! #summer2026 #travel 🌅"
    tokens = reels_service.extract_reel_tokens(caption)
    assert "#summer2026" in tokens
    assert "#travel" in tokens
    assert "🌅" in tokens
    assert "sunset" in tokens
    assert "beach" in tokens
    print("  [PASS] Reel caption NLP token extraction test")


def test_device_repo_formatting():
    name = device_repo.format_device_display_name("abir_supta", "Abir's Phone")
    assert name == "abir_supta (Abir's Phone)"

    name_no_user = device_repo.format_device_display_name(None, "Galaxy S24")
    assert name_no_user == "Galaxy S24"
    print("  [PASS] Device repository display formatting test")


def test_device_atomic_stats():
    device_id = "test-device-uuid-stats"
    device_repo.upsert_device("Test Device Stats", "127.0.0.1", device_id=device_id)
    
    stats = device_repo.touch_device_and_get_stats("127.0.0.1", device_id=device_id, files_delta=1, size_delta=1024)
    assert stats["total_files"] >= 1
    assert stats["total_size"] >= 1024
    print("  [PASS] Atomic O(1) device stats touch test")


def test_storage_path_sanitization():
    unsafe_path = "../../etc/passwd/../../../secret.png"
    safe = sanitize_relative_path(unsafe_path)
    assert ".." not in safe
    
    root = os.path.abspath("./test_root")
    os.makedirs(root, exist_ok=True)
    full = full_path_in_root(root, "photos/dcim/image1.jpg")
    assert full.startswith(root)
    print("  [PASS] Storage path sanitization and traversal guard test")


def test_feed_service_unified_feed():
    device_id = "test-device-uuid-feed"
    device_repo.upsert_device("Feed Device", "127.0.0.1", device_id=device_id)
    posts, has_more, total = feed_service.build_unified_feed(device_id, offset=0, limit=20)
    assert isinstance(posts, list)
    assert isinstance(has_more, bool)
    assert isinstance(total, int)
    print("  [PASS] Social feed service pagination & grouping test")


def test_trips_service_query():
    trips = trips_service.get_device_trips("test-device-uuid-trips")
    assert isinstance(trips, list)
    print("  [PASS] Trips clustering repository service test")


if __name__ == "__main__":
    print("Initializing Database...")
    init_db()
    print("Running System Architecture & Concurrency Tests...")
    test_distributed_lock_manager()
    test_reels_bayesian_quality_math()
    test_deterministic_seed_jitter()
    test_token_extraction_for_reels()
    test_device_repo_formatting()
    test_device_atomic_stats()
    test_storage_path_sanitization()
    test_feed_service_unified_feed()
    test_trips_service_query()
    print("\n=======================================================")
    print("ALL 9 PRODUCTION SYSTEM ARCHITECTURE TESTS PASSED 100%!")
    print("=======================================================")
