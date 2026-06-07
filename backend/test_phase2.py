"""Quick validation test for Phase 2 code."""
import sys
import os

# Set env vars BEFORE any app imports (settings singleton loads at import time)
os.environ["SUPABASE_URL"] = "https://test.supabase.co"
os.environ["SUPABASE_SERVICE_KEY"] = "test-key"
os.environ["SUPABASE_ANON_KEY"] = "test-anon-key"
os.environ["SESSION_SECRET"] = "test-secret-key-that-is-32-bytes-long"

sys.path.insert(0, ".")

# Test 1: Schema imports
print("=" * 60)
print("TEST 1: Schema imports")
from app.schemas.reel import IngestReelRequest, INSTAGRAM_REEL_PATTERN
from app.models.enums import RoomStatus, PlayerType
print("  OK: All schemas and enums import cleanly")

# Test 2: URL validation regex
print("\nTEST 2: URL validation regex")
test_urls = [
    ("https://www.instagram.com/reel/ABC123/", True),
    ("https://instagram.com/reels/DEF456", True),
    ("https://www.instagram.com/p/GHI789/", True),
    ("https://www.instagram.com/reel/ABC-_123/", True),
    ("https://www.instagram.com/reel/ABC123/?igsh=abc", True),
    ("https://youtube.com/watch?v=abc", False),
    ("https://instagram.com/stories/user/123", False),
    ("http://www.instagram.com/reel/ABC123/", False),  # http not https
    ("not-a-url", False),
]

all_pass = True
for url, expected in test_urls:
    result = bool(INSTAGRAM_REEL_PATTERN.match(url))
    status = "PASS" if result == expected else "FAIL"
    if status == "FAIL":
        all_pass = False
    label = "VALID" if result else "REJECT"
    print(f"  [{status}] {url[:55]:55s} -> {label}")

# Test 3: Pydantic model validation
print("\nTEST 3: Pydantic model validation")
try:
    req = IngestReelRequest(
        source_url="https://www.instagram.com/reel/ABC123/",
        user_tags=["funny", "cats", "  FUNNY  "],  # Should dedupe + lowercase
    )
    print(f"  OK: Valid request parsed. Tags: {req.user_tags}")
except Exception as e:
    print(f"  FAIL: {e}")

try:
    bad_req = IngestReelRequest(source_url="https://youtube.com/watch?v=abc")
    print(f"  FAIL: Should have rejected YouTube URL")
except Exception as e:
    print(f"  OK: Rejected invalid URL: {type(e).__name__}")

# Test 4: URL normalizer
print("\nTEST 4: URL normalization")
from app.services.media_parser import validate_instagram_url
test_cases = [
    "https://www.instagram.com/reel/ABC123/",
    "https://instagram.com/reels/DEF456?igsh=xyz",
    "https://www.instagram.com/p/GHI789/",
]
for url in test_cases:
    is_valid, normalized, shortcode = validate_instagram_url(url)
    print(f"  {url}")
    print(f"    -> valid={is_valid}, shortcode={shortcode}, normalized={normalized}")

# Test 5: Service imports
print("\nTEST 5: Service imports")
from app.services.reel_service import ingest_reel, refresh_reel_thumbnail, ensure_thumbnails_fresh
from app.services.token_service import create_session_token, decode_session_token
from app.services.media_parser import fetch_og_metadata, refresh_thumbnail
print("  OK: All services import cleanly")

# Test 6: Token round-trip
print("\nTEST 6: Session token round-trip")
from datetime import datetime, timezone, timedelta

token = create_session_token(
    player_id="player-123",
    room_id="room-456",
    is_host=True,
    player_type="registered",
    expires_at=datetime.now(timezone.utc) + timedelta(hours=3),
)
decoded = decode_session_token(token)
print(f"  Token created: {token[:50]}...")
print(f"  Decoded: sub={decoded['sub']}, room_id={decoded['room_id']}, is_host={decoded['is_host']}")
assert decoded["sub"] == "player-123"
assert decoded["room_id"] == "room-456"
assert decoded["is_host"] is True
print("  OK: Token round-trip verified")

# Test 7: FastAPI app import
print("\nTEST 7: FastAPI app import")
from app.main import app
routes = [r.path for r in app.routes if hasattr(r, "path")]
print(f"  OK: App created with {len(routes)} routes:")
for r in routes:
    print(f"    {r}")

# Test 8: Config constants
print("\nTEST 8: Game constants")
from app.config import settings
print(f"  MAX_SCORE_PER_ROUND:   {settings.max_score_per_round}")
print(f"  ROUND_DURATION_MS:     {settings.round_duration_ms}")
print(f"  ALLOWED_ROUND_COUNTS:  {sorted(settings.ALLOWED_ROUND_COUNTS)}")
print(f"  THUMBNAIL_MAX_AGE:     {settings.thumbnail_max_age_seconds}s")
assert settings.round_duration_ms == 10000, f"Expected 10000, got {settings.round_duration_ms}"
assert settings.ALLOWED_ROUND_COUNTS == {10, 20, 30, 50, 100}

print("\n" + "=" * 60)
if all_pass:
    print("ALL TESTS PASSED")
else:
    print("SOME TESTS FAILED")
