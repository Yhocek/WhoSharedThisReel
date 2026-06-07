"""
Validation test for Phase 3 Game Engine logic.
Tests math formulas, pool-constrained assignment, and analytical aggregations.
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

    # TEST 2: Assignment Logic (pool-constrained)
    print("\nTEST 2: Pool-Constrained Round Assignment")
    player_ids = ["p1", "p2", "p3", "p4"]

    # 12 rounds, 4 players, each has 5 reels -> 3 each exactly
    pool_sizes = {"p1": 5, "p2": 5, "p3": 5, "p4": 5}
    rounds = assign_rounds_to_players(12, player_ids, pool_sizes)
    assert len(rounds) == 12
    counts = {p: rounds.count(p) for p in player_ids}
    assert all(c == 3 for c in counts.values())

    # 10 rounds, 4 players -> 2 base + 2 remainder, all have capacity
    rounds_10 = assign_rounds_to_players(10, player_ids, pool_sizes)
    counts_10 = {p: rounds_10.count(p) for p in player_ids}
    assert sum(counts_10.values()) == 10
    assert all(c >= 2 for c in counts_10.values())

    print("  OK: Assignment distributes rounds correctly")

    # TEST 2b: Assignment respects pool constraints
    print("\nTEST 2b: Assignment rejects when pool is insufficient")

    # Player p1 only has 2 reels but base allocation needs 3
    tight_pool = {"p1": 2, "p2": 5, "p3": 5, "p4": 5}
    try:
        assign_rounds_to_players(12, player_ids, tight_pool)
        print("  FAIL: Should have raised ValueError")
        assert False
    except ValueError as e:
        print(f"  OK: Correctly rejected: {e}")

    # TEST 2c: Remainder only goes to players with capacity
    print("\nTEST 2c: Remainder constrained by capacity")
    # 10 rounds, 4 players: base=2, remainder=2
    # p1 and p2 have exactly 2 reels (no capacity for extra)
    # p3 and p4 have 5 reels (have capacity)
    constrained_pool = {"p1": 2, "p2": 2, "p3": 5, "p4": 5}
    for _ in range(20):  # Run multiple times to test randomness
        result = assign_rounds_to_players(10, player_ids, constrained_pool)
        result_counts = {p: result.count(p) for p in player_ids}
        # p1 and p2 must have exactly 2 (no room for more)
        assert result_counts["p1"] == 2, f"p1 got {result_counts['p1']}, expected 2"
        assert result_counts["p2"] == 2, f"p2 got {result_counts['p2']}, expected 2"
        # p3 and p4 split the 2 remainder rounds
        assert result_counts["p3"] + result_counts["p4"] == 6
    print("  OK: Remainder correctly constrained by pool capacity")

    # TEST 3: Scoring Logic (updated to 10000ms)
    print("\nTEST 3: Scoring Math (MAX 1000, DURATION 10000)")
    assert calculate_score(0) == 1000       # Instant
    assert calculate_score(5000) == 750     # Halfway
    assert calculate_score(10000) == 500    # Last millisecond
    assert calculate_score(15000) == 500    # Exceeds max (clamped)
    assert calculate_score(-1000) == 1000   # Under zero (clamped)
    print("  OK: Scoring coefficients match expectations")

    # TEST 4: Match Analytics
    print("\nTEST 4: End-of-Match Analytics")
    room_id = uuid4()
    p1, p2, p3 = str(uuid4()), str(uuid4()), str(uuid4())
    participant_players = [p1, p2, p3]
    profiles = {
        p1: {"display_name": "Alice"},
        p2: {"display_name": "Bob"},
        p3: {"display_name": "Charlie"}
    }

    # Telemetry simulation — scores recalculated for 10000ms duration
    # p1 round 1: reaction_ms=2000, score = round((1 - (2000/10000)*0.5) * 1000) = round(0.9 * 1000) = 900
    # p2 round 1: reaction_ms=5000, score = round((1 - (5000/10000)*0.5) * 1000) = round(0.75 * 1000) = 750
    # p1 round 2: reaction_ms=3000, score = round((1 - (3000/10000)*0.5) * 1000) = round(0.85 * 1000) = 850
    records = [
        # Round 1 (Alice's reel)
        {"room_id": room_id, "round_no": 1, "player_id": p1, "reel_owner_id": p1, "chosen_player_id": p1, "reaction_ms": 2000, "is_correct": True, "score": 900, "answered": True},
        {"room_id": room_id, "round_no": 1, "player_id": p2, "reel_owner_id": p1, "chosen_player_id": p1, "reaction_ms": 5000, "is_correct": True, "score": 750, "answered": True},
        {"room_id": room_id, "round_no": 1, "player_id": p3, "reel_owner_id": p1, "chosen_player_id": p2, "reaction_ms": 8000, "is_correct": False, "score": 0, "answered": True},

        # Round 2 (Bob's reel)
        {"room_id": room_id, "round_no": 2, "player_id": p1, "reel_owner_id": p2, "chosen_player_id": p2, "reaction_ms": 3000, "is_correct": True, "score": 850, "answered": True},
        {"room_id": room_id, "round_no": 2, "player_id": p2, "reel_owner_id": p2, "chosen_player_id": p3, "reaction_ms": 4000, "is_correct": False, "score": 0, "answered": True},
        {"room_id": room_id, "round_no": 2, "player_id": p3, "reel_owner_id": p2, "chosen_player_id": None, "reaction_ms": None, "is_correct": False, "score": 0, "answered": False},  # Unanswered
    ]

    report = generate_match_report(room_id, records, participant_players, profiles)

    # Leaderboard checks
    # p1: 900 + 850 = 1750
    # p2: 750 + 0 = 750
    # p3: 0 + 0 = 0
    assert len(report.leaderboard) == 3
    assert report.leaderboard[0].player_id == UUID(p1)
    assert report.leaderboard[0].total_score == 1750
    assert report.leaderboard[1].player_id == UUID(p2)
    assert report.leaderboard[1].total_score == 750
    assert report.leaderboard[2].player_id == UUID(p3)
    assert report.leaderboard[2].total_score == 0

    # Fastest player:
    # p1: avg(2000, 3000) = 2500 -> Fastest
    # p2: avg(5000, 4000) = 4500
    # p3: avg(8000, 10000) = 9000 (unanswered = round_duration_ms = 10000)
    assert report.fastest_player_id == UUID(p1)
    assert report.fastest_avg_ms == 2500.0

    # Slowest player
    assert report.slowest_player_id == UUID(p3)
    assert report.slowest_avg_ms == 9000.0

    # Longest streak: p1 got 2 correct in a row
    assert report.longest_streak == 2
    assert report.longest_streak_player_id == UUID(p1)

    # Most Accurate Matchup:
    # p1 guessed p1 correctly (1/1)
    # p1 guessed p2 correctly (1/1)
    # p2 guessed p1 correctly (1/1)
    # p2 guessed p2 incorrectly (0/1)
    assert report.most_accurate_ratio == 1.0
    assert report.most_accurate_pair is not None

    # Verify is_short_match is gone from response
    assert not hasattr(report, "is_short_match") or "is_short_match" not in report.model_fields

    print("  OK: Analytics calculated correctly (Averages, Streaks, Matchups, Leaderboard)")
    print("============================================================")
    print("ALL PHASE 3 ENGINE TESTS PASSED")

if __name__ == "__main__":
    run_tests()
