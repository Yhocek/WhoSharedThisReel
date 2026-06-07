"""
WhoSharedThisReel — Room Schemas

Pydantic models for room creation, joining, and lobby management.
"""

from __future__ import annotations

from typing import Optional, List
from uuid import UUID
from pydantic import BaseModel, Field, field_validator


class CreateRoomRequest(BaseModel):
    """Create a new game room."""
    display_name: str = Field(
        ..., min_length=2, max_length=30,
        description="Host's display name",
    )
    max_players: int = Field(
        default=8, ge=2, le=12,
        description="Maximum number of players (2-12)",
    )


class JoinRoomRequest(BaseModel):
    """Join an existing room by code."""
    room_code: str = Field(
        ..., min_length=6, max_length=6,
        description="6-character room code",
    )
    display_name: str = Field(
        ..., min_length=2, max_length=30,
        description="Player's display name",
    )

    @field_validator("room_code")
    @classmethod
    def normalize_room_code(cls, v: str) -> str:
        return v.strip().upper()


class AddToVaultRequest(BaseModel):
    """Add a Reel to the room's game pool."""
    reel_id: str = Field(..., description="UUID of the Reel to add")


class IngestAndVaultRequest(BaseModel):
    """Ingest a Reel URL and add it to the room's pool in one step."""
    source_url: str = Field(
        ..., min_length=20, max_length=2048,
        description="Public Instagram Reel URL",
    )
    user_tags: List[str] = Field(
        default_factory=list,
        max_length=20,
        description="Optional user-assigned tags",
    )


class PlayerResponse(BaseModel):
    """Player info within a room."""
    id: str
    display_name: str
    player_type: str
    is_host: bool
    is_connected: bool
    joined_at: Optional[str] = None


class RoomResponse(BaseModel):
    """Full room details including player list."""
    id: str
    code: str
    host_id: Optional[str] = None
    status: str
    max_players: int
    round_count: int
    created_at: Optional[str] = None
    expires_at: Optional[str] = None
    players: List[PlayerResponse] = Field(default_factory=list)


class RoomCreatedResponse(BaseModel):
    """Response after creating a room."""
    room_id: str
    room_code: str
    player_id: str
    session_token: str
    expires_at: str


class RoomJoinedResponse(BaseModel):
    """Response after joining a room."""
    room_id: str
    room_code: str
    player_id: str
    session_token: str
