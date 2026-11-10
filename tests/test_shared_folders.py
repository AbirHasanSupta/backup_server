"""Regression checks for nested shared roots used by memories."""

from __future__ import annotations

import os
import tempfile
import unittest

from core.shared_folders import non_overlapping_shared_folders


class NonOverlappingSharedFoldersTests(unittest.TestCase):
    def test_parent_root_replaces_nested_root_but_keeps_unrelated_roots(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            parent = os.path.join(temp_dir, "Documents")
            nested = os.path.join(parent, "Abir")
            sibling = os.path.join(temp_dir, "Photos")
            os.makedirs(nested)
            os.makedirs(sibling)
            entries = [
                {"id": "abir", "label": "Abir", "path": nested, "device_ids": ["phone"]},
                {"id": "documents", "label": "Documents", "path": parent, "device_ids": ["phone"]},
                {"id": "photos", "label": "Photos", "path": sibling, "device_ids": ["phone"]},
            ]

            result = non_overlapping_shared_folders(entries, "phone")

            self.assertEqual([entry["id"] for entry in result], ["documents", "photos"])

    def test_parent_not_shared_with_device_does_not_hide_nested_root(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            parent = os.path.join(temp_dir, "Documents")
            nested = os.path.join(parent, "Abir")
            os.makedirs(nested)
            entries = [
                {"id": "documents", "path": parent, "device_ids": ["other"]},
                {"id": "abir", "path": nested, "device_ids": ["phone"]},
            ]

            result = non_overlapping_shared_folders(entries, "phone")

            self.assertEqual([entry["id"] for entry in result], ["abir"])

    def test_unrelated_paths_with_common_prefix_are_not_treated_as_nested(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            documents = os.path.join(temp_dir, "Documents")
            documents_archive = os.path.join(temp_dir, "Documents Archive")
            os.makedirs(documents)
            os.makedirs(documents_archive)
            entries = [
                {"id": "documents", "path": documents, "device_ids": ["phone"]},
                {"id": "archive", "path": documents_archive, "device_ids": ["phone"]},
            ]

            result = non_overlapping_shared_folders(entries, "phone")

            self.assertEqual([entry["id"] for entry in result], ["documents", "archive"])

    def test_repeated_entry_reference_is_not_returned_twice(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            entry = {"id": "documents", "path": temp_dir, "device_ids": ["phone"]}

            result = non_overlapping_shared_folders([entry, entry], "phone")

            self.assertEqual([item["id"] for item in result], ["documents"])

    def test_empty_or_missing_device_tags_keep_existing_memory_access(self) -> None:
        entries = [
            {"id": "untagged", "path": "/unrelated/untagged", "device_ids": []},
            {"id": "legacy", "path": "/unrelated/legacy"},
        ]

        result = non_overlapping_shared_folders(entries, "phone")

        self.assertEqual([entry["id"] for entry in result], ["untagged", "legacy"])

    def test_google_drive_and_unlabeled_root_behavior_remain_independent(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            parent = os.path.join(temp_dir, "Documents")
            nested = os.path.join(parent, "Abir")
            os.makedirs(nested)
            entries = [
                {"id": "unlabeled-parent", "path": parent, "device_ids": ["phone"]},
                {"id": "abir", "label": "Abir", "path": nested, "device_ids": ["phone"]},
                {
                    "id": "drive",
                    "label": "Drive",
                    "type": "google_drive",
                    "path": "https://drive.google.com/folder/x",
                    "device_ids": ["phone"],
                },
            ]

            # Memories only supplied labeled entries to the selector before
            # overlap resolution; an unlabeled parent must not mask Abir.
            memories_entries = [entry for entry in entries if entry.get("label")]
            result = non_overlapping_shared_folders(memories_entries, "phone")

            self.assertEqual([entry["id"] for entry in result], ["abir", "drive"])


if __name__ == "__main__":
    unittest.main()
