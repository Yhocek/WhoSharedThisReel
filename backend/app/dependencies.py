"""
WhoSharedThisReel — FastAPI Dependencies

Provides injectable dependencies for:
  - Supabase admin client (singleton, service_role)
  - Current player extraction from session token
  - Optional Supabase Auth user extraction (for registered users)
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import Depends, Header, HTTPException, status
from supabase import Client as SupabaseClient, create_client

from app.config import settings
from app.services.token_service import decode_session_token

logger = logging.getLogger(__name__)

# ── Supabase Admin Client (Singleton) ─────────────────────────────
# Uses service_role key — has full access, bypasses RLS.
# Created once at module load, reused across all requests.
_supabase_client: Optional[SupabaseClient] = None


def get_supabase() -> SupabaseClient:
    """
    Return the global Supabase admin client.

    This client uses the service_role key and bypasses RLS.
    It is shared across all requests (stateless, thread-safe).
    """
    global _supabase_client
    if _supabase_client is None:
        _supabase_client = create_client(
            settings.supabase_url,
            settings.supabase_service_key,
        )
    return _supabase_client


# ── Session Token Authentication ──────────────────────────────────

async def get_current_player(
    authorization: str = Header(..., description="Bearer <session_token>"),
) -> dict[str, Any]:
    """
    Extract and validate the room session token.

    Returns the decoded JWT payload containing:
      - sub: player_id
      - room_id: room UUID
      - is_host: bool
      - type: "anonymous" | "registered"

    Raises:
        HTTPException 401: If token is missing, malformed, or expired.
    """
    if not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization header must be: Bearer <token>",
        )

    token = authorization[7:]  # Strip "Bearer "
    payload = decode_session_token(token)

    if payload is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired session token.",
        )

    return payload


async def require_host(
    player: dict[str, Any] = Depends(get_current_player),
) -> dict[str, Any]:
    """
    Dependency that requires the current player to be the room host.

    Raises:
        HTTPException 403: If the player is not the host.
    """
    if not player.get("is_host", False):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the room host can perform this action.",
        )
    return player


# ── Optional Supabase Auth User ───────────────────────────────────

async def get_optional_user_id(
    authorization: Optional[str] = Header(None),
) -> Optional[str]:
    """
    Attempt to extract a user ID from the Authorization header.

    Strategy:
      1. Try Supabase JWT validation (registered users via Supabase Auth).
      2. Fall back to our session token's user_id claim.
      3. Return None if no valid auth is present (anonymous users).

    Returns:
        User UUID string, or None if no valid auth is present.
    """
    if not authorization or not authorization.startswith("Bearer "):
        return None

    token = authorization[7:]

    # Try Supabase JWT validation first (registered users)
    try:
        supabase = get_supabase()
        user_response = supabase.auth.get_user(token)
        if user_response and user_response.user:
            return user_response.user.id
    except Exception as e:
        logger.debug("Supabase JWT validation failed: %s", str(e))

    # Fall back to our session token
    payload = decode_session_token(token)
    if payload:
        return payload.get("user_id")

    return None
