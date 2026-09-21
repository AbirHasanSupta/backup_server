"""core/security.py — Timing-Safe Authentication & Token Verification."""

from __future__ import annotations

import hmac
import secrets
from fastapi import Header, HTTPException, status
from core.config import load_config


def extract_bearer_token(authorization: str | None) -> str | None:
    if not authorization or not isinstance(authorization, str) or not authorization.startswith("Bearer "):
        return None
    return authorization[7:].strip()


def verify_api_key_or_device_token(
    authorization: str | None = None,
    token_param: str | None = None,
    device_id: str | None = None,
    device_token_verifier = None,
) -> None:
    """Validate Bearer header or query token against global API key or device token."""
    token = extract_bearer_token(authorization) or token_param
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing authorization token",
        )

    cfg = load_config()
    current_global_key = cfg.get("API_KEY", "")

    # Constant-time comparison for global API key
    if hmac.compare_digest(token, current_global_key):
        return

    # Check device-specific token if device_id and verifier supplied
    if device_id and device_token_verifier:
        if device_token_verifier(device_id, token):
            return

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Unauthorized: invalid token",
    )


def generate_secure_token() -> str:
    return secrets.token_urlsafe(32)
