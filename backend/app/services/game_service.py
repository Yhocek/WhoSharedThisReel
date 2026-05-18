"""
WhoSharedThisReel — Game State Service

Orchestrates the multiplayer game loop, writing state changes to Supabase
to trigger Realtime broadcasts to connected clients.
"""

from __future__ import annotations

import logging
import random
from datetime import datetime, timezone, timedelta
from typing import Optional, List, Dict, Any
from uuid import UUID

from supabase import Client as SupabaseClient

from app.config import settings
from app.models.enums import RoomStatus, GamePhase
from app.schemas.game import MatchReportResponse, SubmitAnswerResponse
from app.services.game_engine import (
    min_reels_per_player,
    assign_rounds_to_players,
    calculate_score,
    generate_match_report
)

logger = logging.getLogger(__name__)


def get_active_players(room_id: str, supabase: SupabaseClient) -> List[Dict[str, Any]]:
    """Get all connected players in the room."""
    result = supabase.table("room_players").select("id, display_name, user_id").eq("room_id", room_id).eq("is_connected", True).execute()
    return result.data or []


def get_player_reels(room_id: str, supabase: SupabaseClient) -> Dict[str, List[str]]:
    """
    Get all reels assigned to the room pool, grouped by player_id.
    Returns: { "player_id": ["reel_id_1", "reel_id_2", ...] }
    """
    result = supabase.table("vault_reels").select("player_id, reel_id").eq("room_id", room_id).execute()
    pool = {}
    for row in (result.data or []):
        pid = str(row["player_id"])
        pool.setdefault(pid, []).append(str(row["reel_id"]))
    return pool


async def start_match(room_id: str, round_count: int, host_id: str, supabase: SupabaseClient) -> dict:
    """
    Start the game. Validates pool size, assigns rounds, and initializes game_state.
    """
    # 1. Fetch active players
    players = get_active_players(room_id, supabase)
    if len(players) < 2:
        raise ValueError("Need at least 2 connected players to start.")
        
    player_ids = [str(p["id"]) for p in players]

    # 2. Validate Vault Pool
    min_reels = min_reels_per_player(round_count)
    pool = get_player_reels(room_id, supabase)
    
    deficient_players = []
    for p in players:
        pid = str(p["id"])
        if len(pool.get(pid, [])) < min_reels:
            deficient_players.append(p["display_name"])
            
    if deficient_players:
        names = ", ".join(deficient_players)
        raise ValueError(f"Game aborted: Deficient reels. Players needing more reels: {names}. Minimum required: {min_reels}.")

    # 3. Assign rounds
    round_owners = assign_rounds_to_players(round_count, player_ids)
    
    # 4. Select Reels (pop random from owner's pool)
    # Shuffle pools first
    for pid in pool:
        random.shuffle(pool[pid])
        
    match_reels = []
    for owner_id in round_owners:
        reel_id = pool[owner_id].pop()
        match_reels.append({"owner_id": owner_id, "reel_id": reel_id})

    # 5. Initialize game state & telemetry
    now = datetime.now(timezone.utc)
    
    # Lock room
    supabase.table("rooms").update({
        "status": RoomStatus.PLAYING.value,
        "round_count": round_count
    }).eq("id", room_id).execute()
    
    # Insert initial game_state
    first_round = match_reels[0]
    supabase.table("game_state").upsert({
        "room_id": room_id,
        "current_round": 1,
        "phase": GamePhase.STARTING.value,
        "current_reel_id": first_round["reel_id"],
        "updated_at": now.isoformat()
    }).execute()
    
    # Pre-generate telemetry for all rounds
    telemetry_inserts = []
    for i, mr in enumerate(match_reels):
        r_no = i + 1
        for pid in player_ids:
            telemetry_inserts.append({
                "room_id": room_id,
                "round_no": r_no,
                "reel_id": mr["reel_id"],
                "reel_owner_id": mr["owner_id"],
                "player_id": pid,
            })
            
    # Insert in batches to avoid payload limits
    batch_size = 100
    for i in range(0, len(telemetry_inserts), batch_size):
        batch = telemetry_inserts[i:i+batch_size]
        supabase.table("round_telemetry").insert(batch).execute()

    return {"status": "started", "round_count": round_count}


async def submit_answer(
    room_id: str, 
    round_no: int, 
    player_id: str, 
    chosen_player_id: str, 
    elapsed_ms: int,
    supabase: SupabaseClient
) -> SubmitAnswerResponse:
    """
    Process a player's guess for a round.
    """
    # 1. Fetch current telemetry for this round
    record = supabase.table("round_telemetry").select("id, reel_owner_id, answered").eq("room_id", room_id).eq("round_no", round_no).eq("player_id", player_id).maybe_single().execute()
    
    if not record.data:
        raise ValueError("Invalid round or player not in game.")
    if record.data["answered"]:
        raise ValueError("Already answered.")
        
    owner_id = str(record.data["reel_owner_id"])
    is_correct = (chosen_player_id == owner_id)
    
    # 2. Score
    score = 0
    if is_correct:
        score = calculate_score(elapsed_ms, settings.round_duration_ms, settings.max_score_per_round)
        
    # Clamp ms
    reaction_ms = max(0, min(elapsed_ms, settings.round_duration_ms))

    # 3. Update telemetry
    supabase.table("round_telemetry").update({
        "chosen_player_id": chosen_player_id,
        "reaction_ms": reaction_ms,
        "is_correct": is_correct,
        "score": score,
        "answered": True
    }).eq("id", record.data["id"]).execute()

    return SubmitAnswerResponse(
        success=True,
        score=score,
        is_correct=is_correct
    )


async def get_match_report(room_id: str, supabase: SupabaseClient) -> MatchReportResponse:
    """
    Generates the end of match analytics dashboard.
    """
    # 1. Check if game is finished or get total rounds
    room = supabase.table("rooms").select("round_count").eq("id", room_id).maybe_single().execute()
    if not room.data:
        raise ValueError("Room not found.")
        
    round_count = room.data["round_count"]
    is_short_match = round_count < settings.short_match_threshold

    # 2. Get active players and profiles
    players = get_active_players(room_id, supabase)
    active_player_ids = [str(p["id"]) for p in players]
    
    # Get avatars from profiles for registered users
    profiles = {}
    for p in players:
        pid = str(p["id"])
        display_name = p["display_name"]
        avatar_url = None
        if p.get("user_id"):
            prof = supabase.table("profiles").select("avatar_url").eq("id", p["user_id"]).maybe_single().execute()
            if prof.data:
                avatar_url = prof.data.get("avatar_url")
        profiles[pid] = {"display_name": display_name, "avatar_url": avatar_url}

    # 3. Fetch telemetry
    telemetry = supabase.table("round_telemetry").select("*").eq("room_id", room_id).order("round_no").execute()
    
    # 4. Engine generation
    return generate_match_report(
        room_id=UUID(room_id),
        telemetry_records=telemetry.data or [],
        active_player_ids=active_player_ids,
        player_profiles=profiles,
        is_short_match=is_short_match,
        round_duration_ms=settings.round_duration_ms
    )
