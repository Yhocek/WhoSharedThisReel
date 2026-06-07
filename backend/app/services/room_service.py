"""
WhoSharedThisReel — Room & Lobby Service

Handles room lifecycle: creation, joining, vault management,
player disconnect/leave (unified), and heartbeat tracking.
"""

from __future__ import annotations

import logging
import random
import string
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any, List
from uuid import UUID

from supabase import Client as SupabaseClient

from app.config import settings
from app.models.enums import RoomStatus, PlayerType
from app.services.token_service import create_session_token

logger = logging.getLogger(__name__)


class DuplicateReelError(Exception):
    """Raised when a Reel is already in the room's vault."""
    pass


def _generate_room_code() -> str:
    """Generate a 6-digit numeric room code."""
    return "".join(random.choices(string.digits, k=6))


async def create_room(
    display_name: str,
    user_id: Optional[str],
    max_players: int,
    supabase: SupabaseClient,
) -> Dict[str, Any]:
    """
    Create a new room and add the host as the first player.

    Returns:
        Dict with room details and session token for the host.
    """
    # Generate a unique room code (retry on collision)
    for _ in range(10):
        code = _generate_room_code()
        existing = (
            supabase.table("rooms")
            .select("id")
            .eq("code", code)
            .neq("status", RoomStatus.EXPIRED.value)
            .neq("status", RoomStatus.FINISHED.value)
            .maybe_single()
            .execute()
        )
        if not existing or not existing.data:
            break
    else:
        raise ValueError("Could not generate a unique room code. Please try again.")

    expires_at = datetime.now(timezone.utc) + timedelta(hours=3)

    # Insert room
    room_result = (
        supabase.table("rooms")
        .insert({
            "code": code,
            "host_id": user_id,
            "status": RoomStatus.WAITING.value,
            "max_players": max_players,
            "round_count": 10,  # default, host changes at start
            "expires_at": expires_at.isoformat(),
        })
        .execute()
    )

    if not room_result.data:
        raise ValueError("Failed to create room.")

    room = room_result.data[0]
    room_id = room["id"]

    # Add host as first player
    player_type = PlayerType.REGISTERED.value if user_id else PlayerType.ANONYMOUS.value
    player_result = (
        supabase.table("room_players")
        .insert({
            "room_id": room_id,
            "user_id": user_id,
            "display_name": display_name,
            "player_type": player_type,
            "is_host": True,
            "is_connected": True,
        })
        .execute()
    )

    if not player_result.data:
        raise ValueError("Failed to add host to room.")

    player = player_result.data[0]
    player_id = player["id"]

    # Issue session token
    token = create_session_token(
        player_id=str(player_id),
        room_id=str(room_id),
        is_host=True,
        player_type=player_type,
        expires_at=expires_at,
    )

    return {
        "room_id": room_id,
        "room_code": code,
        "player_id": player_id,
        "session_token": token,
        "expires_at": expires_at.isoformat(),
    }


async def join_room(
    room_code: str,
    display_name: str,
    user_id: Optional[str],
    supabase: SupabaseClient,
) -> Dict[str, Any]:
    """
    Join an existing room by code.

    Returns:
        Dict with room details and session token for the joining player.
    """
    # Find the room
    room_result = (
        supabase.table("rooms")
        .select("id, code, host_id, status, max_players, expires_at")
        .eq("code", room_code.upper())
        .eq("status", RoomStatus.WAITING.value)
        .maybe_single()
        .execute()
    )

    if not room_result or not room_result.data:
        raise ValueError("Room not found or not accepting players.")

    room = room_result.data
    room_id = room["id"]

    # Check player count
    players_result = (
        supabase.table("room_players")
        .select("id", count="exact")
        .eq("room_id", room_id)
        .eq("is_connected", True)
        .execute()
    )
    current_count = players_result.count or 0

    if current_count >= room["max_players"]:
        raise ValueError("Room is full.")

    # Check for duplicate registered user
    if user_id:
        existing = (
            supabase.table("room_players")
            .select("id")
            .eq("room_id", room_id)
            .eq("user_id", user_id)
            .maybe_single()
            .execute()
        )
        if existing and existing.data:
            raise ValueError("You are already in this room.")

    # Add player
    player_type = PlayerType.REGISTERED.value if user_id else PlayerType.ANONYMOUS.value
    player_result = (
        supabase.table("room_players")
        .insert({
            "room_id": room_id,
            "user_id": user_id,
            "display_name": display_name,
            "player_type": player_type,
            "is_host": False,
            "is_connected": True,
        })
        .execute()
    )

    if not player_result.data:
        raise ValueError("Failed to join room.")

    player = player_result.data[0]
    player_id = player["id"]

    # Parse expires_at
    expires_at_str = room["expires_at"]
    if isinstance(expires_at_str, str):
        expires_at = datetime.fromisoformat(expires_at_str.replace("Z", "+00:00"))
    else:
        expires_at = expires_at_str

    # Issue session token
    token = create_session_token(
        player_id=str(player_id),
        room_id=str(room_id),
        is_host=False,
        player_type=player_type,
        expires_at=expires_at,
    )

    return {
        "room_id": room_id,
        "room_code": room["code"],
        "player_id": player_id,
        "session_token": token,
    }


async def get_room_details(
    room_id: str,
    supabase: SupabaseClient,
) -> Dict[str, Any]:
    """Get room details including the player list."""
    room_result = (
        supabase.table("rooms")
        .select("id, code, host_id, status, max_players, round_count, created_at, expires_at")
        .eq("id", room_id)
        .maybe_single()
        .execute()
    )

    if not room_result or not room_result.data:
        raise ValueError("Room not found.")

    players_result = (
        supabase.table("room_players")
        .select("id, display_name, player_type, is_host, is_connected, joined_at")
        .eq("room_id", room_id)
        .execute()
    )

    return {
        "room": room_result.data if room_result else None,
        "players": players_result.data or [],
    }


async def add_reel_to_vault(
    room_id: str,
    player_id: str,
    player_type: str,
    user_id: Optional[str],
    reel_id: str,
    supabase: SupabaseClient,
) -> Dict[str, Any]:
    """
    Add a Reel to the room's vault_reels pool.

    Ownership check (Fix 1):
      - Registered player: reel.ingested_by must match user_id.
      - Anonymous player: reel.ingested_by_player_id must match player_id.
    A reel with neither owner field matching is rejected.

    The Reel must already exist in the reels table.
    A Reel can only be added to a room once (enforced by DB constraint).
    """
    # Fetch reel with ownership fields
    reel = (
        supabase.table("reels")
        .select("id, ingested_by, ingested_by_player_id")
        .eq("id", reel_id)
        .maybe_single()
        .execute()
    )
    if not reel or not reel.data:
        raise ValueError("Reel not found.")

    reel_data = reel.data

    # Ownership verification
    if player_type == PlayerType.REGISTERED.value:
        # Registered player: verify ingested_by matches their user_id
        if not user_id:
            raise ValueError("Registered player must have a user_id.")
        reel_owner = reel_data.get("ingested_by")
        if reel_owner != user_id:
            raise ValueError(
                "You can only add Reels you ingested. "
                "This Reel was not ingested by your account."
            )
    else:
        # Anonymous player: verify ingested_by_player_id matches their player_id
        reel_player_owner = reel_data.get("ingested_by_player_id")
        if reel_player_owner != player_id:
            raise ValueError(
                "You can only add Reels you ingested. "
                "This Reel was not ingested by your session."
            )

    # Insert into vault_reels
    try:
        result = (
            supabase.table("vault_reels")
            .insert({
                "room_id": room_id,
                "reel_id": reel_id,
                "player_id": player_id,
            })
            .execute()
        )
    except Exception as e:
        if "vault_reels_unique_per_room" in str(e):
            raise DuplicateReelError("This Reel is already in the room's pool.")
        raise

    if not result.data:
        raise ValueError("Failed to add Reel to vault.")

    return result.data[0]


async def remove_reel_from_vault(
    room_id: str,
    reel_id: str,
    player_id: str,
    supabase: SupabaseClient,
) -> Dict[str, str]:
    """
    Remove a Reel from the room's vault.

    Only the player who added the Reel can remove it.
    """
    # Verify the vault entry exists and belongs to this player
    entry = (
        supabase.table("vault_reels")
        .select("id, player_id")
        .eq("room_id", room_id)
        .eq("reel_id", reel_id)
        .maybe_single()
        .execute()
    )

    if not entry or not entry.data:
        raise ValueError("Reel not found in this room's vault.")

    if str(entry.data["player_id"]) != player_id:
        raise ValueError("You can only remove Reels you added.")

    # Delete the vault entry
    supabase.table("vault_reels").delete().eq("id", entry.data["id"]).execute()

    logger.info(
        "Player %s removed reel %s from room %s vault.",
        player_id,
        reel_id,
        room_id,
    )

    return {"status": "removed", "reel_id": reel_id}


async def remove_player(
    room_id: str,
    player_id: str,
    supabase: SupabaseClient,
) -> Dict[str, str]:
    """
    Unified leave/disconnect handler (Fix 3).

    Handles both explicit leave (lobby) and mid-match disconnect:
      - Always sets is_connected = False.
      - If the room is currently 'playing', also zeros out all
        unanswered telemetry rows for this player (score 0 per spec).
      - If the room is 'waiting', no telemetry exists yet — just disconnect.

    Both DELETE /leave and POST /disconnect route through this function.
    """
    # Check room status to decide whether to zero telemetry
    room_result = (
        supabase.table("rooms")
        .select("status")
        .eq("id", room_id)
        .maybe_single()
        .execute()
    )

    # Mark player as disconnected
    supabase.table("room_players").update({
        "is_connected": False,
    }).eq("room_id", room_id).eq("id", player_id).execute()

    # If room is playing, zero out unanswered rounds for this player
    if room_result and room_result.data and room_result.data.get("status") == RoomStatus.PLAYING.value:
        supabase.table("round_telemetry").update({
            "answered": True,
            "is_correct": False,
            "score": 0,
        }).eq("room_id", room_id).eq("player_id", player_id).eq("answered", False).execute()

        logger.info(
            "Player %s disconnected from active match in room %s — remaining rounds zeroed.",
            player_id,
            room_id,
        )
        
        # Issue 3: Re-check round completion now that a player has left
        gs = supabase.table("game_state").select("current_round").eq("room_id", room_id).maybe_single().execute()
        if gs and gs.data:
            round_no = gs.data["current_round"]
            from app.services.game_service import check_active_round_completion
            from app.services.game_task_manager import task_manager
            task_manager.spawn(room_id, check_active_round_completion(room_id, round_no, supabase), f"recheck_{round_no}")
    else:
        logger.info(
            "Player %s left room %s (room not in playing state).",
            player_id,
            room_id,
        )

    return {"status": "disconnected"}


async def record_heartbeat(
    room_id: str,
    player_id: str,
    supabase: SupabaseClient,
) -> Dict[str, str]:
    """
    Record a heartbeat from a connected client.

    Updates last_heartbeat_at to now(). The sweep task uses this
    to detect clients that have gone silent.
    """
    supabase.table("room_players").update({
        "last_heartbeat_at": datetime.now(timezone.utc).isoformat(),
        "is_connected": True,
    }).eq("room_id", room_id).eq("id", player_id).execute()

    return {"status": "ok"}


async def sweep_stale_players(supabase: SupabaseClient) -> int:
    """
    Disconnect players whose last heartbeat exceeds the configured timeout.

    Called periodically by the heartbeat sweep background task.
    Returns the number of players disconnected.

    For each stale player found:
      - Calls remove_player to handle disconnect + telemetry zeroing.
    """
    timeout = settings.heartbeat_timeout_seconds
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=timeout)).isoformat()

    # Find all connected players whose heartbeat is stale
    stale_result = (
        supabase.table("room_players")
        .select("id, room_id")
        .eq("is_connected", True)
        .lt("last_heartbeat_at", cutoff)
        .execute()
    )

    stale_players = stale_result.data or []
    if not stale_players:
        return 0

    disconnected = 0
    for player in stale_players:
        try:
            await remove_player(
                room_id=str(player["room_id"]),
                player_id=str(player["id"]),
                supabase=supabase,
            )
            disconnected += 1
        except Exception as e:
            logger.error(
                "Failed to disconnect stale player %s: %s",
                player["id"],
                str(e),
            )

    logger.info("Heartbeat sweep: disconnected %d stale players.", disconnected)
    return disconnected
