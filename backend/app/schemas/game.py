"""
WhoSharedThisReel — Game Schemas

Pydantic models for game state transitions, submitting guesses,
and returning the end-of-match analytical reports.
"""

from __future__ import annotations

from typing import Optional, Dict, List
from uuid import UUID
from pydantic import BaseModel, Field


class StartGameRequest(BaseModel):
    """Host starts the match, specifying total rounds."""
    round_count: int = Field(..., ge=3, le=30, description="Total number of rounds")


class SubmitAnswerRequest(BaseModel):
    """Player submits a guess."""
    chosen_player_id: UUID = Field(..., description="The player they guessed")
    elapsed_ms: int = Field(..., ge=0, description="Reaction time delta in ms")


class SubmitAnswerResponse(BaseModel):
    """Result of answer submission."""
    success: bool
    score: int
    is_correct: bool


class LeaderboardEntry(BaseModel):
    rank: int
    player_id: UUID
    display_name: str
    total_score: int
    avatar_url: Optional[str] = None


class MatchReportResponse(BaseModel):
    """End-of-Match analytics report."""
    room_id: UUID
    is_short_match: bool
    
    longest_streak_player_id: Optional[UUID]
    longest_streak: int
    
    fastest_player_id: Optional[UUID]
    fastest_avg_ms: Optional[float]
    
    slowest_player_id: Optional[UUID]
    slowest_avg_ms: Optional[float]
    
    most_accurate_pair: Optional[Dict[str, str]]  # {"guesser_id": ..., "owner_id": ...}
    most_accurate_ratio: Optional[float]
    
    leaderboard: List[LeaderboardEntry]
