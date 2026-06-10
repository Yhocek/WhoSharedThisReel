"""
WhoSharedThisReel — Core Game Engine Algorithms

Pure functional logic for pool-constrained round assignment,
scoring coefficients, and end-of-match analytical aggregations.
"""

from __future__ import annotations

import math
import random
from collections import defaultdict
from typing import List, Dict, Any, Optional
from uuid import UUID

from app.schemas.game import MatchReportResponse, LeaderboardEntry


def min_reels_per_player(round_count: int) -> int:
    """Calculate the minimum required reels per player for a given round count."""
    return math.ceil(round_count / 2)


def assign_rounds_to_players(
    round_count: int,
    player_ids: List[str],
    pool_sizes: Dict[str, int],
) -> List[str]:
    """
    Pool-constrained equal-share randomization.

    Every player gets a base number of rounds (round_count // n).
    Remaining rounds are distributed only to players whose pool can
    absorb the extra assignment. Raises ValueError if the total pool
    cannot cover round_count or any individual player would exceed
    their available Reel count.

    Args:
        round_count: Total rounds to assign.
        player_ids: List of player ID strings.
        pool_sizes: Mapping of player_id -> number of Reels they contributed.

    Returns:
        List of owner IDs, one per round, in shuffled order.

    Raises:
        ValueError: If pool cannot satisfy the assignment.
    """
    n = len(player_ids)
    if n == 0:
        return []

    # Check total pool can cover round_count
    total_reels = sum(pool_sizes.get(pid, 0) for pid in player_ids)
    if total_reels < round_count:
        raise ValueError(
            f"Not enough Reels in the pool. Need {round_count} but only "
            f"{total_reels} available across all players."
        )

    base = round_count // n
    remainder = round_count % n

    # Verify every player can handle at least the base allocation
    for pid in player_ids:
        available = pool_sizes.get(pid, 0)
        if available < base:
            raise ValueError(
                f"Player {pid} has {available} Reels but needs at least "
                f"{base} for {round_count} rounds with {n} players."
            )

    # Build base assignments
    assignment_counts: Dict[str, int] = {pid: base for pid in player_ids}

    # Distribute remainder only to players who have capacity
    if remainder:
        eligible = [
            pid for pid in player_ids
            if pool_sizes.get(pid, 0) > assignment_counts[pid]
        ]
        if len(eligible) < remainder:
            raise ValueError(
                f"Cannot distribute {remainder} remainder rounds — only "
                f"{len(eligible)} players have capacity for extra rounds."
            )
        extras = random.sample(eligible, remainder)
        for pid in extras:
            assignment_counts[pid] += 1

    # Final safety check: no player exceeds their pool
    for pid, count in assignment_counts.items():
        available = pool_sizes.get(pid, 0)
        if count > available:
            raise ValueError(
                f"Assignment failed: player {pid} assigned {count} rounds "
                f"but only has {available} Reels."
            )

    # Flatten to ordered list and shuffle
    owners: List[str] = []
    for pid, count in assignment_counts.items():
        owners += [pid] * count

    random.shuffle(owners)
    return owners


def calculate_score(
    reaction_ms: int,
    round_duration_ms: int = 10000,
    max_score: int = 1000,
) -> int:
    """
    Calculate score based on reaction time.

    Faster == closer to MAX_SCORE. Max time == MAX_SCORE * 0.5.
    Formula: score = round( (1 - (reaction_ms / round_duration_ms) * 0.5) * MAX_SCORE )
    """
    if reaction_ms < 0:
        reaction_ms = 0
    if reaction_ms > round_duration_ms:
        reaction_ms = round_duration_ms

    coefficient = 1.0 - ((reaction_ms / round_duration_ms) * 0.5)
    return round(coefficient * max_score)


def generate_match_report(
    room_id: UUID,
    telemetry_records: List[Dict[str, Any]],
    participant_player_ids: List[str],
    player_profiles: Dict[str, Dict[str, str]],
    round_duration_ms: int = 10000,
) -> MatchReportResponse:
    """
    Generate End-of-Match analytics based on telemetry.

    telemetry_records must be sorted by round_no ascending.
    participant_player_ids includes ALL players who participated
    (including disconnected ones) — not just currently connected.
    """
    participant_set = set(participant_player_ids)

    # 1. Leaderboard & Averages
    player_scores = defaultdict(int)
    player_times = defaultdict(list)
    player_correct_counts = defaultdict(int)

    # 2. Longest Streak
    current_streaks = defaultdict(int)
    max_streaks = defaultdict(int)

    # 3. Most Accurate Matchup
    # map guesser_id -> owner_id -> [correct, total]
    matchups = defaultdict(lambda: defaultdict(lambda: [0, 0]))

    for record in telemetry_records:
        pid = str(record["player_id"])
        if pid not in participant_set:
            continue

        owner_id = str(record["reel_owner_id"])
        is_correct = record["is_correct"]
        score = record["score"]
        answered = record["answered"]

        # Reaction time for averages (unanswered = max duration)
        reaction_ms = record.get("reaction_ms")
        if not answered or reaction_ms is None:
            reaction_ms = round_duration_ms
        player_times[pid].append(reaction_ms)

        # Total score
        player_scores[pid] += score

        if is_correct:
            player_correct_counts[pid] += 1

        # Streak tracking
        if is_correct:
            current_streaks[pid] += 1
            if current_streaks[pid] > max_streaks[pid]:
                max_streaks[pid] = current_streaks[pid]
        else:
            current_streaks[pid] = 0

        # Matchup tracking (only if they answered)
        if answered and record.get("chosen_player_id"):
            matchups[pid][owner_id][1] += 1  # total guesses against this owner
            if is_correct:
                matchups[pid][owner_id][0] += 1

    # Finalize Leaderboard
    leaderboard_entries = []
    for pid in participant_set:
        profile = player_profiles.get(pid, {})
        avg_time = sum(player_times[pid]) / len(player_times[pid]) if player_times[pid] else 0.0
        leaderboard_entries.append(LeaderboardEntry(
            rank=0,  # calculated below
            player_id=UUID(pid),
            display_name=profile.get("display_name", "Unknown"),
            total_score=player_scores[pid],
            correct_count=player_correct_counts[pid],
            avg_reaction_ms=avg_time,
            avatar_url=profile.get("avatar_url")
        ))


    # Sort leaderboard by score desc
    leaderboard_entries.sort(key=lambda x: x.total_score, reverse=True)

    # Assign ranks with tie handling
    current_rank = 1
    for i, entry in enumerate(leaderboard_entries):
        if i > 0 and entry.total_score == leaderboard_entries[i-1].total_score:
            entry.rank = leaderboard_entries[i-1].rank
        else:
            entry.rank = current_rank
        current_rank += 1

    # Calculate Fastest / Slowest Player
    fastest_player = None
    slowest_player = None
    fastest_avg = float('inf')
    slowest_avg = -1.0

    for pid, times in player_times.items():
        if times:
            avg_time = sum(times) / len(times)
            if avg_time < fastest_avg:
                fastest_avg = avg_time
                fastest_player = UUID(pid)
            if avg_time > slowest_avg:
                slowest_avg = avg_time
                slowest_player = UUID(pid)

    # Longest Streak Player
    longest_streak_val = 0
    longest_streak_pid = None
    for pid, streak in max_streaks.items():
        if streak > longest_streak_val:
            longest_streak_val = streak
            longest_streak_pid = UUID(pid)

    # Most Accurate Matchup
    best_matchup_ratio = -1.0
    best_matchup_correct = -1
    best_matchup = None

    for guesser_id, owners in matchups.items():
        for owner_id, stats in owners.items():
            correct, total = stats
            if total > 0:
                ratio = correct / total
                # Tie breaker: greater absolute number of correct guesses
                if ratio > best_matchup_ratio or (ratio == best_matchup_ratio and correct > best_matchup_correct):
                    best_matchup_ratio = ratio
                    best_matchup_correct = correct
                    best_matchup = {"guesser_id": guesser_id, "owner_id": owner_id}

    return MatchReportResponse(
        room_id=room_id,
        longest_streak_player_id=longest_streak_pid,
        longest_streak=longest_streak_val,
        fastest_player_id=fastest_player,
        fastest_avg_ms=fastest_avg if fastest_player else None,
        slowest_player_id=slowest_player,
        slowest_avg_ms=slowest_avg if slowest_player else None,
        most_accurate_pair=best_matchup,
        most_accurate_ratio=best_matchup_ratio if best_matchup else None,
        leaderboard=leaderboard_entries
    )
