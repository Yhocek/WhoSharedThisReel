"""
Validation test for Phase 3 Game Engine logic.
Tests math formulas, randomized equal-share assignment, and analytical aggregations.
"""
import sys
import os
import random
from uuid import uuid4, UUID

# Setup environment before imports
os.environ["SUPABASE_URL"] = "https://test.supabase.co"
os.environ["SUPABASE_SERVICE_KEY"] = "test-key"
os.environ["SESSION_SECRET"] = "test-secret"
os.environ["CORS_ORIGINS"] = '["*"]'

from app.services.game_engine import (
    min_reels_per_player,
    assign_rounds_to_players,
    calculate_score,
    generate_match_report
)

def run_tests():
    print("============================================================")
    
    # TEST 1: Min Reels
    print("TEST 1: Min Reels Math")
    assert min_reels_per_player(10) == 5
    assert min_reels_per_player(11) == 6
    assert min_reels_per_player(3) == 2
    print("  OK: Min reels calculation is correct")

    # TEST 2: Assignment Logic
    print("\nTEST 2: Equal-Share Round Assignment")
    player_ids = ["p1", "p2", "p3", "p4"]
    
    # 12 rounds, 4 players -> 3 each exactly
    rounds = assign_rounds_to_players(12, player_ids)
    assert len(rounds) == 12
    counts = {p: rounds.count(p) for p in player_ids}
    assert all(c == 3 for c in counts.values())
    
    # 10 rounds, 4 players -> 2 each exactly, plus 2 random
    rounds_10 = assign_rounds_to_players(10, player_ids)
    counts_10 = {p: rounds_10.count(p) for p in player_ids}
    assert sum(counts_10.values()) == 10
    assert all(c >= 2 for c in counts_10.values())
    
    print("  OK: Assignment distributes rounds correctly")

    # TEST 3: Scoring Logic
    print("\nTEST 3: Scoring Math (MAX 1000, DURATION 15000)")
    assert calculate_score(0) == 1000  # Instant
    assert calculate_score(7500) == 750  # Halfway
    assert calculate_score(15000) == 500  # Last millisecond
    assert calculate_score(20000) == 500  # Exceeds max
    assert calculate_score(-1000) == 1000 # Under zero
    print("  OK: Scoring coefficients match expectations")

    # TEST 4: Match Analytics
    print("\nTEST 4: End-of-Match Analytics")
    room_id = uuid4()
    p1, p2, p3 = str(uuid4()), str(uuid4()), str(uuid4())
    active_players = [p1, p2, p3]
    profiles = {
        p1: {"display_name": "Alice"},
        p2: {"display_name": "Bob"},
        p3: {"display_name": "Charlie"}
    }
    
    # Telemetry simulation
    records = [
        # Round 1 (Alice's reel)
        {"room_id": room_id, "round_no": 1, "player_id": p1, "reel_owner_id": p1, "chosen_player_id": p1, "reaction_ms": 2000, "is_correct": True, "score": 933, "answered": True},
        {"room_id": room_id, "round_no": 1, "player_id": p2, "reel_owner_id": p1, "chosen_player_id": p1, "reaction_ms": 5000, "is_correct": True, "score": 833, "answered": True},
        {"room_id": room_id, "round_no": 1, "player_id": p3, "reel_owner_id": p1, "chosen_player_id": p2, "reaction_ms": 10000, "is_correct": False, "score": 0, "answered": True},
        
        # Round 2 (Bob's reel)
        {"room_id": room_id, "round_no": 2, "player_id": p1, "reel_owner_id": p2, "chosen_player_id": p2, "reaction_ms": 3000, "is_correct": True, "score": 900, "answered": True},
        {"room_id": room_id, "round_no": 2, "player_id": p2, "reel_owner_id": p2, "chosen_player_id": p3, "reaction_ms": 4000, "is_correct": False, "score": 0, "answered": True},
        {"room_id": room_id, "round_no": 2, "player_id": p3, "reel_owner_id": p2, "chosen_player_id": None, "reaction_ms": None, "is_correct": False, "score": 0, "answered": False}, # Unanswered
    ]
    
    report = generate_match_report(room_id, records, active_players, profiles, is_short_match=True)
    
    # Leaderboard checks
    assert len(report.leaderboard) == 3
    assert report.leaderboard[0].player_id == UUID(p1) # 1833
    assert report.leaderboard[0].total_score == 1833
    assert report.leaderboard[1].player_id == UUID(p2) # 833
    assert report.leaderboard[2].player_id == UUID(p3) # 0
    
    # Fastest player:
    # p1: avg(2000, 3000) = 2500 -> Fastest
    # p2: avg(5000, 4000) = 4500
    # p3: avg(10000, 15000) = 12500
    assert report.fastest_player_id == UUID(p1)
    assert report.fastest_avg_ms == 2500.0
    
    # Slowest player
    assert report.slowest_player_id == UUID(p3)
    assert report.slowest_avg_ms == 12500.0
    
    # Longest streak: p1 got 2 correct in a row
    assert report.longest_streak == 2
    assert report.longest_streak_player_id == UUID(p1)
    
    # Most Accurate Matchup: 
    # p1 guessed p1 correctly (1/1)
    # p1 guessed p2 correctly (1/1)
    # p2 guessed p1 correctly (1/1)
    # p2 guessed p2 incorrectly (0/1)
    assert report.most_accurate_ratio == 1.0
    # Both p1->p1 and p1->p2 have 1 correct guess out of 1.
    assert report.most_accurate_pair is not None
    
    print("  OK: Analytics calculated correctly (Averages, Streaks, Matchups, Leaderboard)")
    print("============================================================")
    print("ALL PHASE 3 ENGINE TESTS PASSED")

if __name__ == "__main__":
    run_tests()
