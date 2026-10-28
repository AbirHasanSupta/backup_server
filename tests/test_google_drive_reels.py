"""Regression tests for online and offline Google Drive Reels behavior."""

from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, patch

from api.v1 import admin, feed, files, reels
from fastapi import HTTPException
from fastapi import Response
from starlette.requests import Request


class GoogleDriveReelSourceTests(unittest.TestCase):
    def test_new_admin_drive_share_defaults_to_reels(self) -> None:
        request = admin.AddSharedFolderRequest(path="https://drive.google.com/drive/folders/folder_id")

        self.assertTrue(request.available_in_reels)

    def test_disabled_drive_share_stays_offline_visible_but_not_online(self) -> None:
        entry = {
            "id": "drive-folder",
            "type": "google_drive",
            "drive_folder_id": "folder_id",
            "path": "https://drive.google.com/drive/folders/folder_id",
            "device_ids": ["phone"],
            "available_in_reels": False,
        }

        self.assertEqual(reels._online_shared_reel_entries([entry], "phone"), [])
        offline_sources = reels._visible_drive_sources([entry], "phone")
        self.assertEqual([source["drive_folder_id"] for source in offline_sources], ["folder_id"])

    def test_drive_video_catalog_filters_non_videos_and_caches_tree(self) -> None:
        reels._drive_reel_cache.clear()
        entry = {"id": "drive-folder", "drive_folder_id": "folder_id"}
        drive_files = [
            {
                "path": "video_id/Nested/movie.mp4",
                "name": "movie.mp4",
                "mime_type": "video/mp4",
                "size": 4096,
                "modified_time": 123,
            },
            {
                "path": "image_id/Nested/cover.jpg",
                "name": "cover.jpg",
                "mime_type": "image/jpeg",
                "size": 512,
                "modified_time": 124,
            },
        ]
        redis_values = {}

        class FakeRedis:
            def get(self, key):
                return redis_values.get(key)

            def setex(self, key, _ttl, value):
                redis_values[key] = value

        try:
            with (
                patch.object(reels, "drive_all_files", return_value=drive_files) as list_drive,
                patch("services.redis_service.get_redis_client", return_value=FakeRedis()),
            ):
                first = reels._drive_video_candidates(entry)
                # Simulate a different Gunicorn worker with an empty local cache.
                reels._drive_reel_cache.clear()
                second = reels._drive_video_candidates(entry)

            self.assertEqual(len(first), 1)
            self.assertEqual(first[0]["source_type"], "reel_shared")
            self.assertEqual(first[0]["source_key"], "drive-folder")
            self.assertEqual(first[0]["path"], "video_id/Nested/movie.mp4")
            self.assertEqual(second, first)
            list_drive.assert_called_once_with("folder_id")
        finally:
            reels._drive_reel_cache.clear()


class GoogleDriveReelEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def _call_endpoint(self, entry: dict, drive_candidates: list[dict]):
        catalog_row = {
            "source_type": "reel_shared",
            "source_key": entry["id"],
            "share_id": 17,
            "media_id": 29,
            "path": drive_candidates[0]["path"] if drive_candidates else "",
            "size": 4096,
            "modified_time": 123,
            "created_at": 123,
            "label": entry.get("label") or "Shared folder",
        }
        with (
            patch.object(reels, "verify_api_key_or_device_token"),
            patch.object(reels, "get_shared_dirs", return_value=[entry]),
            patch.object(reels.reels_repo, "get_recently_watched_reel_ids", return_value=(set(), set())),
            patch.object(reels, "_drive_video_candidates", return_value=drive_candidates) as catalog_drive,
            patch.object(reels.reels_repo, "bulk_get_or_create_library_reel_shares", return_value=[catalog_row]),
            patch.object(reels, "_schedule_reel_thumbnail_warm"),
            patch.object(reels.social_repo, "get_reactions_for_media_ids", return_value=({}, {})),
            patch.object(reels.social_repo, "get_comment_counts_for_media_ids", return_value={}),
            patch.object(reels.reels_repo, "get_repost_counts_for_media_ids", return_value={}),
            patch.object(reels.reels_repo, "get_user_reposted_info", return_value=(set(), set())),
            patch.object(reels.reels_repo, "get_saved_reel_ids", return_value=set()),
            patch.object(reels.reels_repo, "get_reel_view_counts", return_value={}),
            patch.object(reels.reels_repo, "get_reel_durations", return_value={}),
            patch.object(reels.reels_service, "calculate_bayesian_quality", return_value=0),
            patch.object(reels.reels_service, "deterministic_seed_jitter", return_value=0),
        ):
            response = await reels.get_shared_and_backups_reels(
                device_id="phone", source="shared", authorization="Bearer test"
            )
        return response, catalog_drive

    async def test_online_shared_shelf_contains_drive_video(self) -> None:
        entry = {
            "id": "drive-folder",
            "type": "google_drive",
            "drive_folder_id": "folder_id",
            "path": "https://drive.google.com/drive/folders/folder_id",
            "label": "Family Reels",
            "device_ids": ["phone"],
            "available_in_reels": True,
        }
        candidate = {
            "source_type": "reel_shared",
            "source_key": "drive-folder",
            "path": "video_id/movie.mp4",
            "size": 4096,
            "modified_time": 123,
        }

        result, drive_catalog = await self._call_endpoint(entry, [candidate])

        self.assertEqual(result["reels"][0]["library_source"], "reel_shared")
        self.assertEqual(result["reels"][0]["path"], candidate["path"])
        self.assertEqual(result["reels"][0]["shared_by"], "Family Reels")
        self.assertEqual(result["drive_sources"][0]["drive_folder_id"], "folder_id")
        drive_catalog.assert_called_once()

    async def test_admin_hidden_drive_folder_is_offline_sync_only(self) -> None:
        entry = {
            "id": "drive-folder",
            "type": "google_drive",
            "drive_folder_id": "folder_id",
            "path": "https://drive.google.com/drive/folders/folder_id",
            "device_ids": ["phone"],
            "available_in_reels": False,
        }

        result, drive_catalog = await self._call_endpoint(entry, [])

        self.assertEqual(result["reels"], [])
        self.assertEqual(result["drive_sources"][0]["id"], "drive-folder")
        drive_catalog.assert_not_called()


class GoogleDriveShareCreationTests(unittest.IsolatedAsyncioTestCase):
    async def test_mobile_added_drive_folder_defaults_on_and_duplicate_keeps_setting(self) -> None:
        config = {"SHARED_DIRS": []}
        request = files.AddGoogleDriveFolderRequest(
            link="https://drive.google.com/drive/folders/folder_id"
        )
        with (
            patch.object(files, "verify_api_key_or_device_token"),
            patch.object(files, "load_config", return_value=config),
            patch.object(files, "save_config"),
            patch("core.google_drive.folder_id_from_link", return_value="folder_id"),
            patch("core.google_drive.get_file", return_value={"mimeType": "application/vnd.google-apps.folder", "name": "Drive"}),
            patch("core.google_drive.list_children", return_value=[]),
        ):
            created = await files.add_shared_google_drive_folder(request, device_id="phone")
            self.assertTrue(created["entry"]["available_in_reels"])

            created["entry"]["available_in_reels"] = False
            duplicate = await files.add_shared_google_drive_folder(request, device_id="phone")

        self.assertTrue(duplicate["existing"])
        self.assertFalse(duplicate["entry"]["available_in_reels"])

    async def test_admin_and_phone_key_endpoints_return_effective_configured_key(self) -> None:
        config = {"GOOGLE_DRIVE_API_KEY": "effective-drive-key"}
        with (
            patch.object(admin, "_auth") as admin_auth,
            patch.object(admin, "load_config", return_value=config),
            patch.object(files, "verify_api_key_or_device_token") as device_auth,
            patch.object(files, "load_config", return_value=config),
        ):
            admin_response = Response()
            phone_response = Response()
            admin_result = await admin.get_google_drive_api_key(
                admin_response, authorization="Bearer test", token=None
            )
            phone_result = await files.get_shared_google_drive_api_key(
                device_id="phone", response=phone_response, authorization="Bearer test", token=None
            )

        self.assertEqual(admin_result, {"api_key": "effective-drive-key", "configured": True})
        self.assertEqual(phone_result, admin_result)
        self.assertEqual(admin_response.headers["cache-control"], "no-store, private")
        self.assertEqual(phone_response.headers["cache-control"], "no-store, private")
        admin_auth.assert_called_once()
        device_auth.assert_called_once_with("Bearer test", None, "phone", files.device_repo.verify_device_token)


class GoogleDriveReelPlaybackTests(unittest.IsolatedAsyncioTestCase):
    async def test_drive_reel_preview_uses_descendant_checked_media_stream(self) -> None:
        share = {
            "source_type": "reel_shared",
            "source_key": "drive-folder",
            "relative_path": "file_id/Nested/movie.mp4",
            "is_library_reel": True,
        }
        metadata = {"mimeType": "video/mp4"}
        request = Request({"type": "http", "method": "GET", "path": "/", "headers": []})
        with (
            patch.object(feed, "verify_api_key_or_device_token"),
            patch.object(feed, "_authorize_share_access", return_value=share),
            patch.object(feed, "_library_drive_metadata", new=AsyncMock(return_value=("file_id", metadata))),
            patch("api.v1.files._drive_media_response", return_value="drive-stream") as media_response,
            patch.object(feed, "_resolve_share_path") as filesystem_path,
        ):
            result = await feed.preview_share_item(7, request, "phone")

        self.assertEqual(result, "drive-stream")
        media_response.assert_called_once_with("file_id", request, metadata)
        filesystem_path.assert_not_called()

    async def test_drive_reel_metadata_checks_root_membership_and_video_type(self) -> None:
        share = {
            "source_type": "reel_shared",
            "source_key": "drive-folder",
            "relative_path": "file_id/Nested/movie.mp4",
            "is_library_reel": True,
        }
        entry = {
            "id": "drive-folder",
            "type": "google_drive",
            "drive_folder_id": "root_id",
        }
        with (
            patch.object(feed, "get_shared_dirs", return_value=[entry]),
            patch("core.google_drive.ensure_descendant", return_value={"mimeType": "video/mp4"}) as check_descendant,
        ):
            result = await feed._library_drive_metadata(share)

        self.assertEqual(result, ("file_id", {"mimeType": "video/mp4"}))
        check_descendant.assert_called_once_with("root_id", "file_id")

        with (
            patch.object(feed, "get_shared_dirs", return_value=[entry]),
            patch("core.google_drive.ensure_descendant", return_value={"mimeType": "image/jpeg"}),
        ):
            with self.assertRaises(HTTPException) as error:
                await feed._library_drive_metadata(share)
        self.assertEqual(error.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
