"""Authentication regression tests for the WebSocket room gateway."""

from __future__ import annotations

import asyncio
import unittest

from routers.websocket_hub import websocket_endpoint


class _UnauthorizedSocket:
    headers = {}
    query_params = {}

    def __init__(self) -> None:
        self.close_code = None
        self.connected = False

    async def close(self, code: int, reason: str = "") -> None:
        self.close_code = code

    async def accept(self) -> None:
        self.connected = True


class WebSocketSecurityTests(unittest.TestCase):
    def test_unauthenticated_client_is_rejected_before_accepting(self) -> None:
        socket = _UnauthorizedSocket()
        asyncio.run(websocket_endpoint(socket, "untrusted-device"))
        self.assertEqual(socket.close_code, 1008)
        self.assertFalse(socket.connected)


if __name__ == "__main__":
    unittest.main()
