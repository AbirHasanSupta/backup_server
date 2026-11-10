"""Regression tests for bounded, device-scoped resumable upload storage."""

from __future__ import annotations

import hashlib
import os
import tempfile
import time
import unittest
import uuid

from storage.local import LocalStorageBackend


class ResumableStorageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.storage = LocalStorageBackend(self.temp_dir.name)
        self.upload_id = f"upload_{uuid.uuid4().hex}"
        self.device_id = "device-resumable-test"

    def tearDown(self) -> None:
        self.storage.cleanup_chunks(self.upload_id, self.device_id)
        self.temp_dir.cleanup()

    def test_resume_status_is_device_scoped_and_assembly_is_atomic(self) -> None:
        data = b"first-part" * 700 + b"last-part"
        split_at = len(data) // 2
        digest = hashlib.sha256(data).hexdigest()

        self.storage.save_chunk(self.upload_id, 1, data[split_at:], self.device_id)
        self.assertEqual(
            self.storage.get_chunk_status(self.upload_id, 2, self.device_id)["received_chunks"], [1]
        )
        self.assertEqual(
            self.storage.get_chunk_status(self.upload_id, 2, "another-device")["received_chunks"], []
        )

        self.storage.save_chunk(self.upload_id, 0, data[:split_at], self.device_id)
        path, actual_digest = self.storage.assemble_chunks(
            self.upload_id, "camera/resume.bin", 2, len(data), self.device_id, digest
        )
        with open(path, "rb") as assembled:
            self.assertEqual(assembled.read(), data)
        self.assertEqual(actual_digest, digest)
        self.assertEqual(self.storage.get_chunk_status(self.upload_id, 2, self.device_id)["received_chunks"], [])

    def test_checksum_failure_does_not_publish_a_file(self) -> None:
        data = b"untrusted data"
        self.storage.save_chunk(self.upload_id, 0, data, self.device_id)
        target = self.storage.get_file_path("camera/bad.bin", self.device_id)

        with self.assertRaisesRegex(ValueError, "SHA-256"):
            self.storage.assemble_chunks(
                self.upload_id, "camera/bad.bin", 1, len(data), self.device_id, "0" * 64
            )
        self.assertFalse(os.path.exists(target))

    def test_expired_partial_sessions_are_collected(self) -> None:
        self.storage.save_chunk(self.upload_id, 0, b"stale", self.device_id)
        chunks_dir = self.storage._get_chunks_dir(self.upload_id, self.device_id)
        stale_at = time.time() - 120
        os.utime(chunks_dir, (stale_at, stale_at))

        self.assertEqual(self.storage.cleanup_expired_chunks(60), 1)
        self.assertEqual(self.storage.get_chunk_status(self.upload_id, 1, self.device_id)["received_chunks"], [])


if __name__ == "__main__":
    unittest.main()
