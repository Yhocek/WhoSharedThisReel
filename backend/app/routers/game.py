"""
WhoSharedThisReel — Game Router

API endpoints for starting the game, submitting answers,
disconnecting mid-match, and generating reports.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from supabase import Client as SupabaseClient
from typing import Dict, Any

from app.dependencies import get_supabase, get_current_player
from app.schemas.game import (
    StartGameRequest,
    SubmitAnswerRequest,
    SubmitAnswerResponse,
    MatchReportResponse,
)
from app.services import game_service, room_service

router = APIRouter(prefix="/api/v1/rooms", tags=["game"])


@router.post("/{room_id}/start")
async def start_game(
    room_id: str,
    request: StartGameRequest,
    player: dict = Depends(get_current_player),
    supabase: SupabaseClient = Depends(get_supabase),
) -> dict:
    """Start the match and assign reels (Host only)."""
    if not player.get("is_host"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the host can start the game.",
        )

    try:
        return await game_service.start_match(
            room_id=room_id,
            round_count=request.round_count,
            host_id=player["sub"],
            supabase=supabase,
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except Exception as e:
        import logging
        logging.getLogger(__name__).error("Error starting game", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to start game. Please try again.",
        )


@router.post(
    "/{room_id}/rounds/{round_no}/answer",
    response_model=SubmitAnswerResponse,
)
async def submit_answer(
    room_id: str,
    round_no: int,
    request: SubmitAnswerRequest,
    player: dict = Depends(get_current_player),
    supabase: SupabaseClient = Depends(get_supabase),
) -> SubmitAnswerResponse:
    """Submit an answer for the active round."""
    if player["room_id"] != room_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not in this room.",
        )

    try:
        return await game_service.submit_answer(
            room_id=room_id,
            round_no=round_no,
            player_id=player["sub"],
            chosen_player_id=str(request.chosen_player_id),
            elapsed_ms=request.elapsed_ms,
            supabase=supabase,
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to submit answer. Please try again.",
        )


@router.post("/{room_id}/disconnect")
async def disconnect_from_game(
    room_id: str,
    player: dict = Depends(get_current_player),
    supabase: SupabaseClient = Depends(get_supabase),
) -> dict:
    """
    Disconnect from an active match.

    Marks the player as disconnected and zeros out all their
    unanswered rounds (score 0 per spec).
    """
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


@router.get("/{room_id}/report", response_model=MatchReportResponse)
async def get_report(
    room_id: str,
    player: dict = Depends(get_current_player),
    supabase: SupabaseClient = Depends(get_supabase),
) -> MatchReportResponse:
    """Fetch End-of-Match analytics report."""
    if player["room_id"] != room_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not in this room.",
        )

    try:
        return await game_service.get_match_report(room_id, supabase)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e),
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to generate report. Please try again.",
        )
