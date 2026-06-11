"""
WhoSharedThisReel — Game State Service

Orchestrates the multiplayer game loop, writing state changes to Supabase
to trigger Realtime broadcasts to connected clients.
"""

from __future__ import annotations

import logging
import random
from collections import Counter
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

# In-memory lock to prevent double-resolution of a round
_resolved_rounds: set[str] = set()


def get_active_players(room_id: str, supabase: SupabaseClient) -> List[Dict[str, Any]]:
    """Get all connected players in the room."""
    result = (
        supabase.table("room_players")
        .select("id, display_name, user_id")
        .eq("room_id", room_id)
        .eq("is_connected", True)
        .execute()
    )
    return result.data or []


def get_all_players(room_id: str, supabase: SupabaseClient) -> List[Dict[str, Any]]:
    """Get ALL players in the room (including disconnected)."""
    result = (
        supabase.table("room_players")
        .select("id, display_name, user_id, is_connected")
        .eq("room_id", room_id)
        .execute()
    )
    return result.data or []


def get_player_reels(room_id: str, supabase: SupabaseClient) -> Dict[str, List[str]]:
    """
    Get all reels assigned to the room pool, grouped by player_id.
    Returns: { "player_id": ["reel_id_1", "reel_id_2", ...] }
    """
    result = (
        supabase.table("vault_reels")
        .select("player_id, reel_id")
        .eq("room_id", room_id)
        .execute()
    )
    pool: Dict[str, List[str]] = {}
    for row in (result.data or []):
        pid = str(row["player_id"])
        pool.setdefault(pid, []).append(str(row["reel_id"]))
    return pool


def get_reel_source_urls(reel_ids: List[str], supabase: SupabaseClient) -> Dict[str, str]:
    """
    Look up source_url for a list of reel IDs.
    Returns: { "reel_id": "https://instagram.com/reel/..." }
    """
    if not reel_ids:
        return {}
    result = (
        supabase.table("reels")
        .select("id, source_url")
        .in_("id", reel_ids)
        .execute()
    )
    from app.schemas.reel import decode_compatible_url
    return {str(row["id"]): decode_compatible_url(row["source_url"]) for row in (result.data or [])}


def get_reels_details(reel_ids: List[str], supabase: SupabaseClient) -> Dict[str, Dict[str, Any]]:
    """
    Look up detailed fields (source_url, thumbnail_url, provider) for a list of reel IDs.
    """
    if not reel_ids:
        return {}
    result = (
        supabase.table("reels")
        .select("id, source_url, thumbnail_url, provider")
        .in_("id", reel_ids)
        .execute()
    )
    from app.schemas.reel import decode_compatible_url
    details = {}
    for row in (result.data or []):
        details[str(row["id"])] = {
            "url": decode_compatible_url(row["source_url"]),
            "thumbnail_url": row.get("thumbnail_url"),
            "provider": row.get("provider", "Instagram")
        }
    return details


async def start_match(
    room_id: str,
    round_count: int,
    host_id: str,
    supabase: SupabaseClient,
) -> dict:
    """
    Start the game. Validates pool size, assigns rounds constrained by
    each player's actual Reel count, and initializes game_state.

    All validation happens BEFORE any DB writes to avoid leaving the
    room in a corrupted half-initialized state.
    """
    # Clear any old resolution locks for this room
    for lock in list(_resolved_rounds):
        if lock.startswith(f"{room_id}_"):
            _resolved_rounds.discard(lock)
    # ── Phase 1: Pure validation (no DB writes) ───────────────

    # 1. Fetch active players
    players = get_active_players(room_id, supabase)
    if len(players) < 2:
        raise ValueError("Need at least 2 connected players to start.")

    player_ids = [str(p["id"]) for p in players]

    # 2. Validate Vault Pool
    min_reels = min_reels_per_player(round_count)
    pool = get_player_reels(room_id, supabase)

    # Build pool_sizes for the constrained assignment
    pool_sizes: Dict[str, int] = {}
    deficient_players = []
    for p in players:
        pid = str(p["id"])
        count = len(pool.get(pid, []))
        pool_sizes[pid] = count
        if count < min_reels:
            deficient_players.append(p["display_name"])

    if deficient_players:
        names = ", ".join(deficient_players)
        raise ValueError(
            f"Game aborted: Deficient reels. Players needing more reels: "
            f"{names}. Minimum required: {min_reels}."
        )

    # 3. Assign rounds (constrained by actual pool sizes)
    # This raises ValueError if assignment is impossible.
    round_owners = assign_rounds_to_players(round_count, player_ids, pool_sizes)

    # 4. Post-assignment safety: verify no player exceeds their pool
    owner_counts = Counter(round_owners)
    for pid, assigned in owner_counts.items():
        available = pool_sizes.get(pid, 0)
        if assigned > available:
            raise ValueError(
                f"Assignment error: player assigned {assigned} rounds but "
                f"only has {available} Reels. This should not happen."
            )

    # 5. Select Reels (pop random from each owner's pool)
    for pid in pool:
        random.shuffle(pool[pid])

    match_reels = []
    for owner_id in round_owners:
        if not pool.get(owner_id):
            raise ValueError(
                f"Pool exhausted for player {owner_id} during Reel selection."
            )
        reel_id = pool[owner_id].pop()
        match_reels.append({"owner_id": owner_id, "reel_id": reel_id})

    # Look up details for all selected reels
    selected_reel_ids = [mr["reel_id"] for mr in match_reels]
    reels_details = get_reels_details(selected_reel_ids, supabase)

    # ── Phase 2: DB writes (all validation passed) ────────────
    now = datetime.now(timezone.utc)

    # Lock room
    supabase.table("rooms").update({
        "status": RoomStatus.PLAYING.value,
        "round_count": round_count,
    }).eq("id", room_id).execute()

    # Insert initial game_state
    first_round = match_reels[0]
    supabase.table("game_state").upsert({
        "room_id": room_id,
        "current_round": 1,
        "phase": GamePhase.STARTING.value,
        "current_reel_id": first_round["reel_id"],
        "updated_at": now.isoformat(),
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
        batch = telemetry_inserts[i:i + batch_size]
        supabase.table("round_telemetry").insert(batch).execute()

    # Broadcast round_start event and schedule timer
    from app.services.websocket_manager import manager
    from app.services.game_task_manager import task_manager
    
    # Cancel any existing tasks for the room
    task_manager.cancel_room_tasks(room_id)
    
    player_options = [{"id": p, "name": next((x["display_name"] for x in players if str(x["id"]) == p), "Unknown")} for p in player_ids]
    ends_at = (now + timedelta(milliseconds=settings.round_duration_ms)).isoformat()
    
    # Update game_state with ends_at for the first round
    try:
        supabase.table("game_state").update({
            "round_ends_at": ends_at,
            "updated_at": now.isoformat()
        }).eq("room_id", room_id).execute()
    except Exception as db_err:
        logger.error("Failed to update initial round_ends_at in game_state: %s", db_err)
    
    first_reel_id = first_round["reel_id"]
    first_detail = reels_details.get(first_reel_id, {})
    task_manager.spawn(room_id, manager.broadcast_to_room(room_id, {
        "event": "round_start",
        "round_no": 1,
        "reel_id": first_reel_id,
        "reel_url": first_detail.get("url", ""),
        "thumbnail_url": first_detail.get("thumbnail_url"),
        "provider": first_detail.get("provider", "Instagram"),
        "options": player_options,
        "round_duration_ms": settings.round_duration_ms,
        "round_ends_at": ends_at
    }), "broadcast_start")

    # Schedule the round timer
    async def round_timer(r_no: int, sbase: SupabaseClient):
        import asyncio
        await asyncio.sleep(settings.round_duration_ms / 1000.0)
        
        # Timer fired. Auto-fail unanswered telemetry
        sbase.table("round_telemetry").update({
            "answered": True,
            "is_correct": False,
            "score": 0
        }).eq("room_id", room_id).eq("round_no", r_no).eq("answered", False).execute()
        
        await _resolve_round(room_id, r_no, sbase)
        
    task_manager.spawn(room_id, round_timer(1, supabase), "timer_1")

    return {"status": "started", "round_count": round_count}


async def submit_answer(
    room_id: str,
    round_no: int,
    player_id: str,
    chosen_player_id: str,
    elapsed_ms: int,
    supabase: SupabaseClient,
) -> SubmitAnswerResponse:
    """
    Process a player's guess for a round.

    Uses conditional UPDATE (answered=False) to prevent double-write
    race conditions from rapid taps or retries.
    """
    # 1. Fetch the telemetry record to get reel_owner_id
    record = (
        supabase.table("round_telemetry")
        .select("id, reel_owner_id")
        .eq("room_id", room_id)
        .eq("round_no", round_no)
        .eq("player_id", player_id)
        .maybe_single()
        .execute()
    )

    if not record or not record.data:
        raise ValueError("Invalid round or player not in game.")

    owner_id = str(record.data["reel_owner_id"])
    is_correct = (chosen_player_id == owner_id)

    # 2. Score
    score = 0
    if is_correct:
        score = calculate_score(
            elapsed_ms,
            settings.round_duration_ms,
            settings.max_score_per_round,
        )

    # Clamp ms
    reaction_ms = max(0, min(elapsed_ms, settings.round_duration_ms))

    # 3. Atomic conditional UPDATE — only succeeds if not already answered
    result = (
        supabase.table("round_telemetry")
        .update({
            "chosen_player_id": chosen_player_id,
            "reaction_ms": reaction_ms,
            "is_correct": is_correct,
            "score": score,
            "answered": True,
        })
        .eq("id", record.data["id"])
        .eq("answered", False)
        .execute()
    )

    if not result.data:
        raise ValueError("Already answered.")

    # Check if round is complete (all connected players answered)
    await check_active_round_completion(room_id, round_no, supabase)

    return SubmitAnswerResponse(
        success=True,
        score=score,
        is_correct=is_correct,
    )

async def check_active_round_completion(room_id: str, round_no: int, supabase: SupabaseClient):
    """Check if all connected players have answered, and if so, trigger resolution."""
    from app.services.game_task_manager import task_manager
    active_players = get_active_players(room_id, supabase)
    active_ids = {str(p["id"]) for p in active_players}
    
    if active_ids:
        telemetry = (
            supabase.table("round_telemetry")
            .select("player_id, answered")
            .eq("room_id", room_id)
            .eq("round_no", round_no)
            .in_("player_id", list(active_ids))
            .execute()
        )
        all_answered = all(r.get("answered", False) for r in (telemetry.data or []))
        if all_answered:
            # Cancel the timer so it doesn't fire late
            task_manager.cancel_task(room_id, f"timer_{round_no}")
            task_manager.spawn(room_id, _resolve_round(room_id, round_no, supabase), f"resolve_{round_no}")

async def _resolve_round(room_id: str, round_no: int, supabase: SupabaseClient):
    """Broadcast round_result, handle game_end vs next-round, and schedule next round."""
    lock_key = f"{room_id}_{round_no}"
    if lock_key in _resolved_rounds:
        return  # Already resolved
    _resolved_rounds.add(lock_key)

    from app.services.websocket_manager import manager
    from app.services.game_task_manager import task_manager
    import asyncio
    
    try:
        active_players = get_active_players(room_id, supabase)
        active_ids = {str(p["id"]) for p in active_players}
        
        telemetry = (
            supabase.table("round_telemetry")
            .select("player_id, answered, score, reel_owner_id")
            .eq("room_id", room_id)
            .eq("round_no", round_no)
            .execute()
        )
        records = telemetry.data or []
        
        if records:
            owner_id = str(records[0]["reel_owner_id"])
            scores = {str(r["player_id"]): r["score"] for r in records}
            
            # Calculate cumulative scores for all players up to this round
            cum_telemetry = (
                supabase.table("round_telemetry")
                .select("player_id, score")
                .eq("room_id", room_id)
                .lte("round_no", round_no)
                .execute()
            )
            cum_records = cum_telemetry.data or []
            from collections import defaultdict
            cumulative_scores = defaultdict(int)
            for r in cum_records:
                pid = str(r["player_id"])
                cumulative_scores[pid] += r["score"]
                
            # Build sorted leaderboard list using ALL players (including disconnected)
            all_players = get_all_players(room_id, supabase)
            leaderboard_data = []
            for p in all_players:
                pid = str(p["id"])
                leaderboard_data.append({
                    "player_id": pid,
                    "name": p["display_name"],
                    "score": cumulative_scores[pid]
                })
            leaderboard_data.sort(key=lambda x: x["score"], reverse=True)
            
            # Broadcast round_result
            await manager.broadcast_to_room(room_id, {
                "event": "round_result",
                "round_no": round_no,
                "owner_id": owner_id,
                "scores": scores,
                "leaderboard": leaderboard_data
            })
            
        # Check if it was the last round
        room = supabase.table("rooms").select("round_count").eq("id", room_id).maybe_single().execute()
        round_count = room.data.get("round_count", 0) if room and room.data else 0
        
        if round_no >= round_count:
            # Game over
            supabase.table("rooms").update({"status": RoomStatus.FINISHED.value}).eq("id", room_id).execute()
            # 4-second delay so clients can show final round break standings
            await asyncio.sleep(4)
            await manager.broadcast_to_room(room_id, {
                "event": "game_end"
            })
            task_manager.cancel_room_tasks(room_id)
        else:
            # Advance to next round
            next_round = round_no + 1
            next_telemetry = (
                supabase.table("round_telemetry")
                .select("reel_id")
                .eq("room_id", room_id)
                .eq("round_no", next_round)
                .limit(1)
                .execute()
            )
            
            if next_telemetry.data:
                next_reel_id = next_telemetry.data[0]["reel_id"]
                # Look up details for the next reel
                next_reels_details = get_reels_details([next_reel_id], supabase)
                next_detail = next_reels_details.get(next_reel_id, {})
                next_reel_url = next_detail.get("url", "")
                next_thumbnail_url = next_detail.get("thumbnail_url")
                next_provider = next_detail.get("provider", "Instagram")
                
                # 4-second delay to let clients show results
                await asyncio.sleep(4)
                
                # Build player options using ALL players (including disconnected)
                all_players = get_all_players(room_id, supabase)
                player_options = [{"id": str(p["id"]), "name": p["display_name"]} for p in all_players]
                
                # Schedule next round
                now = datetime.now(timezone.utc)
                ends_at = (now + timedelta(milliseconds=settings.round_duration_ms)).isoformat()
                
                # Update game_state with the next round details and round_ends_at
                try:
                    supabase.table("game_state").update({
                        "current_round": next_round,
                        "current_reel_id": next_reel_id,
                        "round_ends_at": ends_at,
                        "updated_at": now.isoformat()
                    }).eq("room_id", room_id).execute()
                except Exception as db_err:
                    logger.error("Failed to update round_ends_at in game_state: %s", db_err)
                
                await manager.broadcast_to_room(room_id, {
                    "event": "round_start",
                    "round_no": next_round,
                    "reel_id": next_reel_id,
                    "reel_url": next_reel_url,
                    "thumbnail_url": next_thumbnail_url,
                    "provider": next_provider,
                    "options": player_options,
                    "round_duration_ms": settings.round_duration_ms,
                    "round_ends_at": ends_at
                })
                
                # Schedule the new round timer
                async def round_timer(r_no: int, sbase: SupabaseClient):
                    import asyncio
                    await asyncio.sleep(settings.round_duration_ms / 1000.0)
                    sbase.table("round_telemetry").update({
                        "answered": True,
                        "is_correct": False,
                        "score": 0
                    }).eq("room_id", room_id).eq("round_no", r_no).eq("answered", False).execute()
                    await _resolve_round(room_id, r_no, sbase)
                    
                task_manager.spawn(room_id, round_timer(next_round, supabase), f"timer_{next_round}")
            else:
                # Safety fallback: if next round telemetry doesn't exist, end the game!
                logger.warning("No telemetry for next round %s in room %s. Ending game early.", next_round, room_id)
                supabase.table("rooms").update({"status": RoomStatus.FINISHED.value}).eq("id", room_id).execute()
                await manager.broadcast_to_room(room_id, {
                    "event": "game_end"
                })
                task_manager.cancel_room_tasks(room_id)
    except Exception as e:
        logger.error("Error in _resolve_round for room %s round %s: %s", room_id, round_no, e, exc_info=True)
        # Force game over to prevent players from getting stuck in a hanging game
        try:
            supabase.table("rooms").update({"status": RoomStatus.FINISHED.value}).eq("id", room_id).execute()
            await manager.broadcast_to_room(room_id, {
                "event": "game_end"
            })
            task_manager.cancel_room_tasks(room_id)
        except Exception:
            pass


async def get_match_report(
    room_id: str,
    supabase: SupabaseClient,
) -> MatchReportResponse:
    """
    Generates the end of match analytics dashboard.

    Uses ALL players who have telemetry records (including disconnected
    ones) so that scores from rounds they played are preserved.
    """
    # 1. Get round_count from room
    room = (
        supabase.table("rooms")
        .select("round_count")
        .eq("id", room_id)
        .maybe_single()
        .execute()
    )
    if not room or not room.data:
        raise ValueError("Room not found.")

    # 2. Fetch all telemetry
    telemetry = (
        supabase.table("round_telemetry")
        .select("*")
        .eq("room_id", room_id)
        .order("round_no")
        .execute()
    )
    records = telemetry.data or []

    # 3. Derive participant list from telemetry (includes disconnected players)
    participant_ids = list({str(r["player_id"]) for r in records})

    # 4. Build profiles from ALL players (connected + disconnected)
    all_players = get_all_players(room_id, supabase)
    profiles: Dict[str, Dict[str, Any]] = {}
    for p in all_players:
        pid = str(p["id"])
        display_name = p["display_name"]
        avatar_url = None
        if p.get("user_id"):
            prof = (
                supabase.table("profiles")
                .select("avatar_url")
                .eq("id", p["user_id"])
                .maybe_single()
                .execute()
            )
            if prof and prof.data:
                avatar_url = prof.data.get("avatar_url")
        profiles[pid] = {"display_name": display_name, "avatar_url": avatar_url}

    # 5. Engine generation
    return generate_match_report(
        room_id=UUID(room_id),
        telemetry_records=records,
        participant_player_ids=participant_ids,
        player_profiles=profiles,
        round_duration_ms=settings.round_duration_ms,
    )
