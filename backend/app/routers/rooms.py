"""
WhoSharedThisReel — Rooms Router

API endpoints for room creation, joining, vault management, and leaving.

Endpoints:
    POST   /api/v1/rooms              — Create a new room (returns session token)
    POST   /api/v1/rooms/join         — Join a room by code (returns session token)
    GET    /api/v1/rooms/{room_id}    — Get room details + player list
    POST   /api/v1/rooms/{room_id}/vault  — Add a Reel to the room's pool
    DELETE /api/v1/rooms/{room_id}/leave  — Leave the room
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status, WebSocket, WebSocketDisconnect, Query
from supabase import Client as SupabaseClient

from app.dependencies import get_current_player, get_optional_user_id, get_supabase
from app.services.websocket_manager import manager
from app.services.token_service import decode_session_token
from app.schemas.room import (
    AddToVaultRequest,
    IngestAndVaultRequest,
    CreateRoomRequest,
    JoinRoomRequest,
    RoomCreatedResponse,
    RoomJoinedResponse,
    RoomResponse,
    PlayerResponse,
)
from app.schemas.reel import IngestReelRequest
from app.services import room_service
from app.services.room_service import DuplicateReelError
from app.services.reel_service import ingest_reel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/rooms", tags=["rooms"])


@router.post(
    "",
    response_model=RoomCreatedResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new room",
    description=(
        "Creates a new game room and adds the caller as the host. "
        "Returns a session token for subsequent authenticated requests."
    ),
)
async def create_room_endpoint(
    request: CreateRoomRequest,
    user_id: Optional[str] = Depends(get_optional_user_id),
    supabase: SupabaseClient = Depends(get_supabase),
) -> RoomCreatedResponse:
    """Create a new room and become the host."""
    try:
        result = await room_service.create_room(
            display_name=request.display_name,
            user_id=user_id,
            max_players=request.max_players,
            supabase=supabase,
        )
        return RoomCreatedResponse(**result)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )


@router.post(
    "/join",
    response_model=RoomJoinedResponse,
    summary="Join a room by code",
    description="Join an existing room using the 6-digit numeric room code.",
)
async def join_room_endpoint(
    request: JoinRoomRequest,
    user_id: Optional[str] = Depends(get_optional_user_id),
    supabase: SupabaseClient = Depends(get_supabase),
) -> RoomJoinedResponse:
    """Join a room by its 6-digit numeric code."""
    try:
        result = await room_service.join_room(
            room_code=request.room_code,
            display_name=request.display_name,
            user_id=user_id,
            supabase=supabase,
        )
        return RoomJoinedResponse(**result)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )


@router.get(
    "/{room_id}",
    response_model=RoomResponse,
    summary="Get room details",
    description="Get room details and the full player list.",
)
async def get_room_endpoint(
    room_id: str,
    player: dict = Depends(get_current_player),
    supabase: SupabaseClient = Depends(get_supabase),
) -> RoomResponse:
    """Get room details including player list."""
    if player["room_id"] != room_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not in this room.",
        )

    try:
        details = await room_service.get_room_details(
            room_id=room_id,
            supabase=supabase,
        )
        room_data = details["room"]
        players_data = [PlayerResponse(**p) for p in details["players"]]
        return RoomResponse(
            **room_data,
            players=players_data,
            vault_counts=details.get("vault_counts", {}),
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e),
        )


@router.post(
    "/{room_id}/reels",
    status_code=status.HTTP_201_CREATED,
    summary="Ingest a Reel and add to room vault",
    description=(
        "Combined endpoint: ingests a public Instagram Reel URL, "
        "then atomically adds it to this room's game pool. "
        "Prevents orphan reels from partial failures."
    ),
)
async def ingest_and_vault_endpoint(
    room_id: str,
    request: IngestAndVaultRequest,
    player: dict = Depends(get_current_player),
    user_id: Optional[str] = Depends(get_optional_user_id),
    supabase: SupabaseClient = Depends(get_supabase),
) -> dict:
    """Ingest a Reel URL and add it to the room vault in one call."""
    if player["room_id"] != room_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not in this room.",
        )

    # Step 1: Ingest the reel
    try:
        ingest_request = IngestReelRequest(
            source_url=request.source_url,
            user_tags=request.user_tags,
        )
        result = await ingest_reel(
            request=ingest_request,
            user_id=None,  # Anonymous for now (B3: no Supabase auth on client)
            supabase=supabase,
            player_id=player["sub"],
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(e),
        )

    reel_id = result.reel.id

    # Step 2: Add to vault
    try:
        vault_entry = await room_service.add_reel_to_vault(
            room_id=room_id,
            player_id=player["sub"],
            player_type=player["type"],
            user_id=user_id,
            reel_id=reel_id,
            supabase=supabase,
        )
    except DuplicateReelError:
        return {
            "status": "already_added",
            "reel_id": reel_id,
            "is_new": result.is_new,
        }
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )

    # Broadcast event so all clients update their pool status
    try:
        await manager.broadcast_to_room(room_id, {
            "event": "pool_updated",
            "player_id": player["sub"],
            "action": "added"
        })
    except Exception as e:
        logger.warning("Failed to broadcast pool_updated event: %s", str(e))

    return {
        "status": "ingested_and_added",
        "reel_id": reel_id,
        "vault_reel_id": vault_entry["id"],
        "is_new": result.is_new,
    }


@router.post(
    "/{room_id}/vault",
    status_code=status.HTTP_201_CREATED,
    summary="Add Reel to room vault",
    description="Add an ingested Reel to this room's game pool.",
)
async def add_to_vault_endpoint(
    room_id: str,
    request: AddToVaultRequest,
    player: dict = Depends(get_current_player),
    user_id: Optional[str] = Depends(get_optional_user_id),
    supabase: SupabaseClient = Depends(get_supabase),
) -> dict:
    """Add a Reel to the room's vault."""
    if player["room_id"] != room_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not in this room.",
        )

    try:
        result = await room_service.add_reel_to_vault(
            room_id=room_id,
            player_id=player["sub"],
            player_type=player["type"],
            user_id=user_id,
            reel_id=request.reel_id,
            supabase=supabase,
        )
        # Broadcast event so all clients update their pool status
        try:
            await manager.broadcast_to_room(room_id, {
                "event": "pool_updated",
                "player_id": player["sub"],
                "action": "added"
            })
        except Exception as e:
            logger.warning("Failed to broadcast pool_updated event: %s", str(e))

        return {"status": "added", "vault_reel_id": result["id"]}
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )


@router.delete(
    "/{room_id}/leave",
    summary="Leave the room",
    description="Mark yourself as disconnected and leave the room.",
)
async def leave_room_endpoint(
    room_id: str,
    player: dict = Depends(get_current_player),
    supabase: SupabaseClient = Depends(get_supabase),
) -> dict:
    """Leave the room."""
    if player["room_id"] != room_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not in this room.",
        )

    return await room_service.remove_player(
        room_id=room_id,
        player_id=player["sub"],
        supabase=supabase,
    )


@router.delete(
    "/{room_id}/vault/{reel_id}",
    summary="Remove a Reel from room vault",
    description="Remove a Reel you added from the room's game pool.",
)
async def remove_from_vault_endpoint(
    room_id: str,
    reel_id: str,
    player: dict = Depends(get_current_player),
    supabase: SupabaseClient = Depends(get_supabase),
) -> dict:
    """Remove a Reel from the room's vault."""
    if player["room_id"] != room_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not in this room.",
        )

    try:
        result = await room_service.remove_reel_from_vault(
            room_id=room_id,
            reel_id=reel_id,
            player_id=player["sub"],
            supabase=supabase,
        )
        # Broadcast event so all clients update their pool status
        try:
            await manager.broadcast_to_room(room_id, {
                "event": "pool_updated",
                "player_id": player["sub"],
                "action": "removed"
            })
        except Exception as e:
            logger.warning("Failed to broadcast pool_updated event: %s", str(e))

        return result
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )


@router.post(
    "/{room_id}/heartbeat",
    summary="Record client heartbeat",
    description="Record that the client is still connected to the room.",
)
async def heartbeat_endpoint(
    room_id: str,
    player: dict = Depends(get_current_player),
    supabase: SupabaseClient = Depends(get_supabase),
) -> dict:
    """Record client heartbeat."""
    if player["room_id"] != room_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not in this room.",
        )

    return await room_service.record_heartbeat(
        room_id=room_id,
        player_id=player["sub"],
        supabase=supabase,
    )


from pydantic import BaseModel
import httpx
import base64
import re
from datetime import datetime, timezone
from app.schemas.reel import encode_compatible_url


class InvitePlayerRequest(BaseModel):
    target_device_id: str
    room_code: str
    host_name: str


class RegisterPushRequest(BaseModel):
    device_id: str
    push_token: str
    display_name: str


async def send_expo_push_notification(push_token: str, title: str, body: str, data: dict = None):
    url = "https://exp.host/--/api/v2/push/send"
    payload = {
        "to": push_token,
        "sound": "default",
        "title": title,
        "body": body,
    }
    if data:
        payload["data"] = data

    async with httpx.AsyncClient() as client:
        try:
            res = await client.post(url, json=payload, timeout=5.0)
            logger.info("Push notification response status: %s", res.status_code)
            return res.status_code == 200
        except Exception as e:
            logger.exception("Failed to send Expo push notification: %s", e)
            return False


@router.post(
    "/players/register-push",
    summary="Register player push token",
    description="Save the player's Expo push token under their persistent device ID in the reels database (bypassing DDL changes).",
)
async def register_push_endpoint(
    request: RegisterPushRequest,
    supabase: SupabaseClient = Depends(get_supabase),
) -> dict:
    """Register player push token."""
    compat_url = encode_compatible_url("https://push-token/" + request.device_id, "PushToken")

    # Check if a token for this device already exists
    existing = (
        supabase.table("reels")
        .select("id")
        .eq("source_url", compat_url)
        .eq("provider", "PushToken")
        .maybe_single()
        .execute()
    )

    payload = {
        "source_url": compat_url,
        "creator_handle": request.display_name,
        "creator_url": request.push_token,
        "provider": "PushToken",
        "updated_at": datetime.now(timezone.utc).isoformat()
    }

    if existing and existing.data:
        res = supabase.table("reels").update(payload).eq("id", existing.data["id"]).execute()
    else:
        payload["created_at"] = datetime.now(timezone.utc).isoformat()
        res = supabase.table("reels").insert(payload).execute()

    if not res.data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to register push token."
        )

    return {"success": True}


@router.post(
    "/{room_id}/invite",
    summary="Invite player to room",
    description="Send a push notification to invite a player by their device ID.",
)
async def invite_player_endpoint(
    room_id: str,
    request: InvitePlayerRequest,
    supabase: SupabaseClient = Depends(get_supabase),
) -> dict:
    """Invite a player to the room."""
    compat_url = encode_compatible_url("https://push-token/" + request.target_device_id, "PushToken")

    reel_res = (
        supabase.table("reels")
        .select("creator_url, creator_handle")
        .eq("source_url", compat_url)
        .eq("provider", "PushToken")
        .maybe_single()
        .execute()
    )

    if not reel_res or not reel_res.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Player push token not found."
        )

    push_token = reel_res.data.get("creator_url")
    if not push_token or not push_token.startswith("ExponentPushToken"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid push token associated with device."
        )

    success = await send_expo_push_notification(
        push_token=push_token,
        title="Who Shared This?",
        body=f"{request.host_name} invited you to play! Code: {request.room_code}",
        data={"roomId": room_id, "roomCode": request.room_code}
    )

    return {"success": success}


@router.delete(
    "/{room_id}/players/{target_player_id}",
    summary="Kick player from room (Host only)",
    description="Allow the host to remove a player from the lobby and disconnect their WebSocket connection.",
)
async def kick_player_endpoint(
    room_id: str,
    target_player_id: str,
    player: dict = Depends(get_current_player),
    supabase: SupabaseClient = Depends(get_supabase),
) -> dict:
    """Kick a player from the room."""
    if player["room_id"] != room_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not in this room.",
        )
    if not player.get("is_host"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the host can kick players.",
        )
    if player["sub"] == target_player_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You cannot kick yourself.",
        )

    # Delete the player from room_players
    supabase.table("room_players").delete().eq("room_id", room_id).eq("id", target_player_id).execute()

    # Close their WebSocket connection
    await manager.kick_player(room_id, target_player_id)

    # Broadcast update to the room
    await manager.broadcast_to_room(room_id, {
        "event": "pool_updated"
    })

    return {"status": "kicked"}


@router.websocket("/{room_id}/ws")
async def websocket_endpoint(
    websocket: WebSocket,
    room_id: str,
    token: str = Query(..., description="Session token"),
    supabase: SupabaseClient = Depends(get_supabase),
):
    """
    WebSocket endpoint for real-time game updates.
    Clients authenticate via token query parameter.
    """
    payload = decode_session_token(token)
    if not payload or payload.get("room_id") != room_id:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    player_id = payload["sub"]

    # Fetch player's display name and verify active registration
    player_row = (
        supabase.table("room_players")
        .select("display_name")
        .eq("id", player_id)
        .maybe_single()
        .execute()
    )
    if not player_row or not player_row.data:
        await websocket.close(code=4001, reason="Kicked/Not in room")
        return

    display_name = player_row.data.get("display_name", "???")

    await manager.connect(websocket, room_id, player_id)

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                import json
                msg = json.loads(raw)
                if msg.get("type") == "chat":
                    text = str(msg.get("text") or "")[:50]
                    if text.strip():
                        await manager.broadcast_to_room(room_id, {
                            "event": "chat",
                            "player_id": player_id,
                            "display_name": display_name,
                            "text": text.strip()
                        })
                elif msg.get("type") == "device_id":
                    device_id = str(msg.get("device_id") or "")
                    if device_id:
                        await manager.broadcast_to_room(room_id, {
                            "event": "device_id",
                            "player_id": player_id,
                            "device_id": device_id
                        })
            except Exception:
                pass
    except WebSocketDisconnect:
        await manager.disconnect(websocket, room_id, player_id, supabase)

