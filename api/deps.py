"""api/deps.py — FastAPI Dependency Injection Components."""

from __future__ import annotations

from typing import Optional
from fastapi import Header, HTTPException, Query, status
from core.security import verify_api_key_or_device_token
from repositories.device_repo import verify_device_token, is_device_known, get_device_by_id


def get_current_device_auth(
    authorization: Optional[str] = Header(None),
    token: Optional[str] = Query(None),
    device_id: Optional[str] = None,
) -> None:
    """Validate global API key or scoped per-device token."""
    verify_api_key_or_device_token(
        authorization=authorization,
        token_param=token,
        device_id=device_id,
        device_token_verifier=verify_device_token,
    )


def verify_known_device_guard(device_id: str) -> None:
    """Ensure device exists and is in accepted status."""
    device = get_device_by_id(device_id)
    if not device or device.get("status") != "accepted":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Device not recognized or removed from server",
        )
