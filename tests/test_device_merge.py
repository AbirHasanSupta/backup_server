import unittest
import uuid
from repositories import device_repo


class DeviceMergeTests(unittest.TestCase):
    def test_is_device_known_does_not_cross_match_by_ip_when_device_id_provided(self):
        # A known device exists
        devs = device_repo.get_devices()
        self.assertTrue(len(devs) > 0, "Expected at least one device in DB")
        known_dev = devs[0]
        known_id = known_dev["device_id"]
        known_ip = known_dev["device_ip"]

        # Known ID must be recognized
        self.assertTrue(device_repo.is_device_known(known_ip, known_id))

        # A brand new ID arriving from the SAME IP must NOT be recognized as known
        new_unregistered_id = f"test_unregistered_{uuid.uuid4().hex[:8]}"
        self.assertFalse(device_repo.is_device_known(known_ip, new_unregistered_id))

    def test_find_device_by_name_model_matches_safely(self):
        unique_name = f"Test Phone {uuid.uuid4().hex[:6]}"
        unique_model = f"Model-{uuid.uuid4().hex[:4]}"
        test_id = f"test_dev_{uuid.uuid4().hex[:8]}"

        device_repo.upsert_device(unique_name, "127.0.0.1", test_id, unique_model, "TestUser")

        try:
            # Exact match
            found = device_repo.find_device_by_name_model(unique_name, unique_model)
            self.assertIsNotNone(found)
            self.assertEqual(found["device_id"], test_id)

            # Case-insensitive / whitespace trimmed match
            found_case = device_repo.find_device_by_name_model(f" {unique_name.lower()} ", f" {unique_model.upper()} ")
            self.assertIsNotNone(found_case)
            self.assertEqual(found_case["device_id"], test_id)

            # Without model, should return None for safety
            self.assertIsNone(device_repo.find_device_by_name_model(unique_name, None))
            self.assertIsNone(device_repo.find_device_by_name_model(unique_name, ""))
        finally:
            device_repo.remove_device(test_id)


if __name__ == "__main__":
    unittest.main()
