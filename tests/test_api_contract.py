"""Public API schema and default browser-boundary regression tests."""

from __future__ import annotations

import warnings
import unittest

from fastapi.middleware.cors import CORSMiddleware
from server import app, create_app


class ApiContractTests(unittest.TestCase):
    def test_openapi_generation_has_no_duplicate_operation_warnings(self) -> None:
        contract_app = create_app("all")
        contract_app.openapi_schema = None
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            schema = contract_app.openapi()
        self.assertEqual([str(item.message) for item in caught], [])
        self.assertIn("/upload/chunk", schema["paths"])

    def test_default_cors_does_not_expose_browser_origins(self) -> None:
        cors = next(middleware for middleware in app.user_middleware if middleware.cls is CORSMiddleware)
        self.assertEqual(cors.kwargs["allow_origins"], [])
        self.assertFalse(cors.kwargs["allow_credentials"])


if __name__ == "__main__":
    unittest.main()
