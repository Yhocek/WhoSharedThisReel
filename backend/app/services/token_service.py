"""
WhoSharedThisReel — Session Token Service

Issues and validates short-lived JWTs for room sessions.
These tokens identify players (including anonymous ones) within a room
and carry authorization claims (is_host, player_type).

Separate from Supabase Auth — this is our own session layer for
ephemeral room participation.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional

from jose import JWTError, jwt
from jose.exceptions import ExpiredSignatureError

from app.config import settings

logger = logging.getLogger(__name__)

ALGORITHM = "HS256"


def create_session_token(
    player_id: str,
    room_id: str,
    is_host: bool,
    player_type: str,
    expires_at: datetime,
) -> str:
    """
    Create a room session JWT.

    Args:
        player_id: room_players.id UUID.
        room_id: rooms.id UUID.
        is_host: Whether this player is the room host.
        player_type: "anonymous" or "registered".
        expires_at: Room expiry time (token expires when room expires).

    Returns:
        Signed JWT string.
    """
    payload = {
        "sub": player_id,
        "room_id": room_id,
        "is_host": is_host,
        "type": player_type,
        "iat": datetime.now(timezone.utc).timestamp(),
        "exp": expires_at.timestamp(),
    }
    return jwt.encode(payload, settings.session_secret, algorithm=ALGORITHM)


def decode_session_token(token: str) -> Optional[dict[str, Any]]:
    """
    Decode and validate a room session JWT.

    Returns:
        Decoded payload dict, or None if invalid/expired.
    """
    try:
        payload = jwt.decode(
            token,
            settings.session_secret,
            algorithms=[ALGORITHM],
        )
        return payload
    except ExpiredSignatureError:
        try:
            # Decode without verifying expiration to inspect room_id
            payload = jwt.decode(
                token,
                settings.session_secret,
                algorithms=[ALGORITHM],
                options={"verify_exp": False}
            )
            room_id = payload.get("room_id")
            if room_id:
                from app.dependencies import get_supabase
                supabase = get_supabase()
                room = (
                    supabase.table("rooms")
                    .select("status")
                    .eq("id", room_id)
                    .maybe_single()
                    .execute()
                )
                if room and room.data and room.data.get("status") in ("playing", "finished"):
                    return payload
        except Exception as e:
            logger.warning("Fallback decode for expired token failed: %s", str(e))
        return None
    except JWTError as e:
        logger.warning("Session token validation failed: %s", str(e))
        return None

