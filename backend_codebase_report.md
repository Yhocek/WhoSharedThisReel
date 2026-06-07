## Reviewer Notes

**Boot confirmed:** Yes. The app still imports cleanly (18 routes registered, including the new `/ws` endpoint) and both `test_phase2.py` and `test_phase3_engine.py` pass fully. 

**Round timer:** A round timer task is scheduled via `GameTaskManager` at the beginning of each round using `asyncio.sleep(settings.round_duration_ms)`. If it fires, it force-closes the round by executing an atomic conditional update (`answered=False`) to zero out scores for any pending players, then triggers `_resolve_round`. If all players answer early, `submit_answer` explicitly cancels the timer by name using the `task_manager` before triggering `_resolve_round`.

**Double-resolution guard:** I used an in-memory lock `_resolved_rounds = set()` inside `_resolve_round`. Since the backend runs as a single worker process, checking and adding `f"{room_id}_{round_no}"` to this local set guarantees that the round resolution logic will execute exactly once, even if "all answered" and "timer fired" perfectly race.

**Live run:** No. The backend has only been run against the local test suites. It has not been run end-to-end against a real Supabase instance with real WebSockets.

**Anything not done or uncertain:** 
- The single-worker constraint makes the in-memory `GameTaskManager` and double-resolution lock safe. If the app is later scaled to multiple workers, these will need to be replaced with a Redis-backed scheduler/lock as documented in `ARCHITECTURE.md`.
- No new heavy dependencies (like Redis/Celery) were introduced, strictly honoring the single-worker architecture requested.

## backend/ARCHITECTURE.md

```markdown
# WhoSharedThisReel — Architecture Decisions

This document records the foundational architecture and security decisions for the WhoSharedThisReel backend.

## Architecture Decision B3: No Direct Client-Supabase Connection
**Clients NEVER connect to Supabase directly.** 

All client traffic goes exclusively through the FastAPI backend, which alone holds the `service_role` key and manages database interactions.
- The Supabase `anon` key is backend-only and must **never** be shipped to any client.
- RLS policies on tables are intentionally permissive (e.g., `USING (true)`) because the database is not the security boundary.
- The security boundary is the FastAPI backend, which enforces authorization via short-lived room session tokens checked at the router level.

## Live Game Updates via FastAPI WebSocket
Because Architecture B3 prohibits clients from connecting to Supabase directly, Supabase Realtime is not used. Instead, the backend pushes live game updates itself using a native FastAPI WebSocket channel. 
- Clients connect to the WebSocket endpoint and authenticate using their room session token.
- Game events (`round_start`, `round_result`, `game_end`) are broadcasted via the backend's ConnectionManager.

## Single-Worker Constraint
Because the WebSocket connections, `ConnectionManager`, and `GameTaskManager` (which tracks round timers) store state in-memory, **the backend must run as a single worker process**. 

Running multiple uvicorn workers (e.g., via gunicorn) will silently break WebSocket broadcasts (since they only reach players connected to the same worker) and in-process round-task tracking.

*Future Scaling Item:* Introduce a shared backplane (e.g., Redis pub/sub) for WebSockets and task tracking if multi-worker deployment is required.

```

## database/migrations/001_phase1_rooms.sql

```sql
-- ============================================================
-- Migration 001: Phase 1 — Room, Session & Player Infrastructure
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- PROFILES (extends Supabase auth.users for registered players)
-- ============================================================
CREATE TABLE public.profiles (
    id           UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 2 AND 30),
    avatar_url   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- RLS DECISION PENDING — These policies are provisional.
-- SELECT USING (true) means world-readable; real authorization is enforced
-- by session token validation in FastAPI routers. Owner must decide whether
-- to tighten RLS or keep app-level auth as the sole gate.
CREATE POLICY "profiles_select_all"
    ON public.profiles FOR SELECT USING (true);

CREATE POLICY "profiles_update_own"
    ON public.profiles FOR UPDATE USING (auth.uid() = id);

-- ============================================================
-- ROOMS
-- ============================================================
CREATE TYPE room_status AS ENUM ('waiting', 'playing', 'finished', 'expired');

CREATE TABLE public.rooms (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code        CHAR(6),
    host_id     UUID,
    status      room_status NOT NULL DEFAULT 'waiting',
    max_players SMALLINT NOT NULL DEFAULT 8 CHECK (max_players BETWEEN 2 AND 12),
    round_count SMALLINT NOT NULL DEFAULT 10 CHECK (round_count IN (10, 20, 30, 50, 100)),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '3 hours'),

    CONSTRAINT rooms_code_unique UNIQUE (code)
);

CREATE INDEX idx_rooms_code_active ON public.rooms(code) WHERE status NOT IN ('expired', 'finished');
CREATE INDEX idx_rooms_expires_at ON public.rooms(expires_at);

ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;

-- RLS DECISION PENDING — see profiles comment above.
CREATE POLICY "rooms_select_all"
    ON public.rooms FOR SELECT USING (true);

CREATE POLICY "rooms_service_role"
    ON public.rooms FOR ALL USING (auth.role() = 'service_role');

-- ============================================================
-- ROOM PLAYERS
-- ============================================================
CREATE TYPE player_type AS ENUM ('anonymous', 'registered');

CREATE TABLE public.room_players (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id      UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
    user_id      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 2 AND 30),
    player_type  player_type NOT NULL,
    is_host      BOOLEAN NOT NULL DEFAULT false,
    is_connected BOOLEAN NOT NULL DEFAULT true,
    joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT unique_registered_player UNIQUE (room_id, user_id)
);

CREATE INDEX idx_room_players_room ON public.room_players(room_id);

ALTER TABLE public.room_players ENABLE ROW LEVEL SECURITY;

-- RLS DECISION PENDING — see profiles comment above.
CREATE POLICY "room_players_select_all"
    ON public.room_players FOR SELECT USING (true);

CREATE POLICY "room_players_service_role"
    ON public.room_players FOR ALL USING (auth.role() = 'service_role');

```

## database/migrations/002_phase2_reels.sql

```sql
-- ============================================================
-- Migration 002: Phase 2 — Reels, Vault & Compliance Schema
-- ============================================================
-- Enforces Meta oEmbed/OG compliance boundaries:
--   R1: Mandatory source_url, provider
--   R2/R3: creator attribution path guaranteed by CHECK
--   R5: thumbnail_fetched_at drives CDN re-fetch logic
-- ============================================================

-- ============================================================
-- REELS (canonical Reel metadata store)
-- ============================================================
CREATE TABLE public.reels (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- R1: Mandatory source URL — the canonical public Instagram Reel link
    source_url           TEXT NOT NULL,

    -- Creator attribution fields (post-Nov-2025 oEmbed deprecation aware)
    -- At least one MUST be non-null (enforced by CHECK below)
    creator_handle       VARCHAR(255),       -- e.g. "@username" or "username"
    creator_url          VARCHAR(2048),      -- fallback: full profile URL

    -- R1: Provider label — hardcoded to Instagram for compliance
    provider             VARCHAR(64) NOT NULL DEFAULT 'Instagram',

    -- Thumbnail (short-lived CDN link — R5 freshness enforcement)
    thumbnail_url        VARCHAR(2048),
    thumbnail_fetched_at TIMESTAMPTZ,        -- NULL = never fetched

    -- oEmbed embed HTML (the iframe payload from the API)
    oembed_html          TEXT,

    -- Caption extracted from OG metadata (for optional tag suggestions)
    caption              TEXT,

    -- User-assigned tags (source of truth per hard constraints)
    user_tags            TEXT[] DEFAULT '{}',

    -- Ingestion metadata
    ingested_by          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- ============================================================
    -- CONSTRAINT: R2/R3 Compliance — Unbroken Attribution Path
    -- At least one of creator_handle or creator_url must be non-null.
    -- This guarantees the reveal screen always has a valid attribution
    -- target, regardless of oEmbed API deprecation state.
    -- ============================================================
    CONSTRAINT reels_creator_attribution_required
        CHECK (creator_handle IS NOT NULL OR creator_url IS NOT NULL),

    -- Prevent duplicate Reel URLs per user (same user can't ingest the same Reel twice)
    CONSTRAINT reels_unique_per_user UNIQUE (source_url, ingested_by),

    -- Validate source_url looks like an Instagram Reel URL
    -- Accepts: /reel/CODE, /reels/CODE, /p/CODE (legacy shortcodes)
    CONSTRAINT reels_valid_instagram_url
        CHECK (
            source_url ~ '^https://(www\.)?instagram\.com/(reel|reels|p)/[A-Za-z0-9_-]+/?(\?.*)?$'
        )
);

-- Fast lookup by source_url for deduplication checks
CREATE INDEX idx_reels_source_url ON public.reels(source_url);

-- Fast lookup by ingested_by for Vault listing
CREATE INDEX idx_reels_ingested_by ON public.reels(ingested_by);

-- Partial index: reels needing thumbnail refresh (stale > 1 hour or never fetched)
CREATE INDEX idx_reels_stale_thumbnails
    ON public.reels(id)
    WHERE thumbnail_url IS NULL
       OR thumbnail_fetched_at IS NULL
       OR thumbnail_fetched_at < (now() - INTERVAL '1 hour');

ALTER TABLE public.reels ENABLE ROW LEVEL SECURITY;

-- RLS DECISION PENDING — These policies are provisional.
-- SELECT USING (true) means world-readable; real authorization is enforced
-- by session token validation in FastAPI routers. All backend writes go
-- through the service_role client (bypasses RLS). Owner must decide whether
-- to tighten RLS or keep app-level auth as the sole gate.
CREATE POLICY "reels_select_all"
    ON public.reels FOR SELECT
    USING (true);

CREATE POLICY "reels_service_role"
    ON public.reels FOR ALL
    USING (auth.role() = 'service_role');


-- ============================================================
-- VAULT_REELS (links reels to rooms for game pool selection)
-- ============================================================
CREATE TABLE public.vault_reels (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id     UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
    reel_id     UUID NOT NULL REFERENCES public.reels(id) ON DELETE CASCADE,
    player_id   UUID NOT NULL REFERENCES public.room_players(id) ON DELETE CASCADE,
    selected_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- A reel can only be added to a room's pool once
    CONSTRAINT vault_reels_unique_per_room UNIQUE (room_id, reel_id)
);

CREATE INDEX idx_vault_reels_room ON public.vault_reels(room_id);
CREATE INDEX idx_vault_reels_player ON public.vault_reels(player_id);

ALTER TABLE public.vault_reels ENABLE ROW LEVEL SECURITY;

-- RLS DECISION PENDING — see reels comment above.
CREATE POLICY "vault_reels_select_room_members"
    ON public.vault_reels FOR SELECT USING (true);

CREATE POLICY "vault_reels_service_role"
    ON public.vault_reels FOR ALL
    USING (auth.role() = 'service_role');


-- ============================================================
-- ROUND_TELEMETRY (Phase 3 game analytics — schema laid now)
-- ============================================================
CREATE TABLE public.round_telemetry (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id          UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
    round_no         SMALLINT NOT NULL CHECK (round_no >= 1),
    reel_id          UUID NOT NULL REFERENCES public.reels(id) ON DELETE RESTRICT,
    reel_owner_id    UUID NOT NULL REFERENCES public.room_players(id) ON DELETE CASCADE,
    player_id        UUID NOT NULL REFERENCES public.room_players(id) ON DELETE CASCADE,
    chosen_player_id UUID REFERENCES public.room_players(id) ON DELETE SET NULL,
    reaction_ms      INTEGER CHECK (reaction_ms IS NULL OR (reaction_ms >= 0 AND reaction_ms <= 10000)),
    is_correct       BOOLEAN NOT NULL DEFAULT false,
    answered         BOOLEAN NOT NULL DEFAULT false,
    score            INTEGER NOT NULL DEFAULT 0 CHECK (score >= 0 AND score <= 1000),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- One telemetry row per player per round
    CONSTRAINT telemetry_unique_per_round UNIQUE (room_id, round_no, player_id)
);

CREATE INDEX idx_telemetry_room ON public.round_telemetry(room_id);
CREATE INDEX idx_telemetry_room_round ON public.round_telemetry(room_id, round_no);

ALTER TABLE public.round_telemetry ENABLE ROW LEVEL SECURITY;

-- RLS DECISION PENDING — see reels comment above.
CREATE POLICY "telemetry_select_room_members"
    ON public.round_telemetry FOR SELECT USING (true);

CREATE POLICY "telemetry_service_role"
    ON public.round_telemetry FOR ALL
    USING (auth.role() = 'service_role');

```

## database/migrations/003_phase3_game.sql

```sql
-- ============================================================
-- Migration 003: Phase 3 — Game Engine State
-- ============================================================

CREATE TYPE game_phase AS ENUM ('starting', 'playback', 'reveal', 'finished');

-- Tracks the active state of a running match
CREATE TABLE public.game_state (
    room_id         UUID PRIMARY KEY REFERENCES public.rooms(id) ON DELETE CASCADE,
    current_round   SMALLINT NOT NULL DEFAULT 1 CHECK (current_round >= 1),
    phase           game_phase NOT NULL DEFAULT 'starting',
    
    -- The reel currently being played/guessed
    current_reel_id UUID REFERENCES public.reels(id) ON DELETE SET NULL,
    
    -- When the current round's timer expires (for client sync)
    round_ends_at   TIMESTAMPTZ,
    
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.game_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "game_state_select_all"
    ON public.game_state FOR SELECT USING (true);

CREATE POLICY "game_state_service_role"
    ON public.game_state FOR ALL USING (auth.role() = 'service_role');

```

## database/migrations/004_ownership_and_heartbeat.sql

```sql
-- ============================================================
-- Migration 004: Add ingested_by_player_id to reels
-- ============================================================
-- Enables ownership verification for anonymous players.
-- Registered players own reels via ingested_by (auth.users FK).
-- Anonymous players own reels via ingested_by_player_id (room_players FK).
-- Also adds last_heartbeat_at to room_players for disconnect detection.
-- ============================================================

-- Anonymous reel ownership: links a reel to the room_players.id that ingested it.
-- Nullable: existing rows and registered-user reels leave this NULL.
ALTER TABLE public.reels
    ADD COLUMN ingested_by_player_id UUID REFERENCES public.room_players(id) ON DELETE SET NULL;

CREATE INDEX idx_reels_ingested_by_player ON public.reels(ingested_by_player_id)
    WHERE ingested_by_player_id IS NOT NULL;

-- Heartbeat tracking for automatic disconnect detection (Fix 4).
-- Clients POST a lightweight heartbeat; a periodic sweep marks players
-- whose last_heartbeat_at exceeds the configured timeout as disconnected.
ALTER TABLE public.room_players
    ADD COLUMN last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX idx_room_players_heartbeat ON public.room_players(last_heartbeat_at)
    WHERE is_connected = true;

```

## backend/requirements.txt

```text
# ============================================================
# WhoSharedThisReel — Backend Dependencies
# ============================================================
# Core
fastapi==0.115.12
uvicorn[standard]==0.34.2
pydantic[email]==2.11.3
pydantic-settings==2.9.1

# Supabase
supabase==2.15.2

# Auth / JWT
python-jose[cryptography]==3.4.0

# HTTP client (for OG metadata fetching)
httpx==0.28.1

# HTML parsing (for OG meta tag extraction)
beautifulsoup4==4.13.4
lxml==5.4.0

# Rate limiting
slowapi==0.1.9

# Environment
python-dotenv==1.1.0

```

## backend/.env.example

```text
# ============================================================
# WhoSharedThisReel — Environment Configuration Template
# ============================================================
# Copy this file to .env and fill in values. NEVER commit .env.

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=eyJ...your-service-role-key...
# Backend-only. NEVER ship this to client apps (architecture decision B3).
SUPABASE_ANON_KEY=eyJ...your-anon-key...

# Session JWT
SESSION_SECRET=generate-a-32-byte-random-secret-here

# Meta App (for oEmbed API — optional, OG parsing works without it)
META_APP_ACCESS_TOKEN=

# CORS
CORS_ORIGINS=["http://localhost:8081","exp://localhost:8081"]

# Rate Limiting
RATE_LIMIT_ROOMS_CREATE=10/hour
RATE_LIMIT_REEL_INGEST=30/hour

# Thumbnail Freshness (seconds) — R5 compliance
THUMBNAIL_MAX_AGE_SECONDS=3600

# Server
HOST=0.0.0.0
PORT=8000
DEBUG=false

```

## backend/app/main.py

```python
"""
WhoSharedThisReel — FastAPI Application Entry Point

Configures:
  - Lifespan event handlers (startup/shutdown)
  - CORS middleware (mobile app + local dev origins)
  - Rate limiting (slowapi)
  - Router registration
  - Logging
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from app.config import settings
from app.routers import health, reels, game, rooms

# ── Logging ───────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.DEBUG if settings.debug else logging.INFO,
    format="%(asctime)s | %(name)-30s | %(levelname)-8s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)

# ── Rate Limiter ──────────────────────────────────────────────────
limiter = Limiter(key_func=get_remote_address)


# ── Lifespan ──────────────────────────────────────────────────────
async def heartbeat_sweep_task():
    """Background task to periodically sweep stale players."""
    import asyncio
    from app.services.room_service import sweep_stale_players
    from app.dependencies import get_supabase
    
    interval = settings.heartbeat_sweep_interval_seconds
    while True:
        try:
            await asyncio.sleep(interval)
            await sweep_stale_players(get_supabase())
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error("Error in heartbeat sweep task: %s", str(e))

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown event handlers."""
    import asyncio
    
    logger.info("WhoSharedThisReel API starting up")
    logger.info("CORS origins: %s", settings.cors_origins)
    logger.info("Round duration: %dms", settings.round_duration_ms)
    logger.info("Thumbnail max age: %ds", settings.thumbnail_max_age_seconds)
    logger.info("Heartbeat timeout: %ds (sweep every %ds)", settings.heartbeat_timeout_seconds, settings.heartbeat_sweep_interval_seconds)
    logger.info(
        "Meta oEmbed: %s",
        "configured" if settings.meta_app_access_token else "not configured (OG-only mode)",
    )
    
    sweep_task = asyncio.create_task(heartbeat_sweep_task())
    
    yield
    
    logger.info("WhoSharedThisReel API shutting down")
    sweep_task.cancel()
    try:
        await sweep_task
    except asyncio.CancelledError:
        pass


# ── FastAPI App ───────────────────────────────────────────────────
app = FastAPI(
    title="WhoSharedThisReel",
    description=(
        "A party game where friends pool Instagram Reels and compete "
        "to guess which friend shared each Reel."
    ),
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/docs" if settings.debug else None,
    redoc_url="/redoc" if settings.debug else None,
)

# Attach rate limiter to app state
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# ── CORS Middleware ───────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routers ───────────────────────────────────────────────────────
app.include_router(health.router)
app.include_router(rooms.router)
app.include_router(reels.router)
app.include_router(game.router)

# ── Global Exception Handler ─────────────────────────────────────
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """
    Catch-all exception handler.

    Prevents leaking stack traces or internal error details to clients.
    All unexpected errors return a generic 500 response.
    """
    logger.exception("Unhandled exception on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": "An internal error occurred. Please try again."},
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.debug,
    )

```

## backend/app/config.py

```python
"""
WhoSharedThisReel — Application Configuration

Reads all settings from environment variables via pydantic-settings.
No secrets are ever hardcoded. See .env.example for required vars.
"""

from __future__ import annotations

import json
from typing import ClassVar, List, Set

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application-wide settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── Supabase ──────────────────────────────────────────────
    supabase_url: str
    supabase_service_key: str
    supabase_anon_key: str = ""

    # ── Session JWT ───────────────────────────────────────────
    session_secret: str  # 32+ byte secret for HS256 signing

    # ── Meta / Instagram ──────────────────────────────────────
    meta_app_access_token: str = ""  # Optional: for oEmbed API

    # ── CORS ──────────────────────────────────────────────────
    cors_origins: List[str] = ["http://localhost:8081", "http://localhost:19006"]

    @field_validator("cors_origins", mode="before")
    @classmethod
    def parse_cors_origins(cls, v: str | List[str]) -> List[str]:
        if isinstance(v, str):
            try:
                parsed = json.loads(v)
                if isinstance(parsed, list):
                    return parsed
            except (json.JSONDecodeError, TypeError):
                pass
            return [origin.strip() for origin in v.split(",") if origin.strip()]
        return v

    # ── Rate Limiting ─────────────────────────────────────────
    rate_limit_rooms_create: str = "10/hour"
    rate_limit_reel_ingest: str = "30/hour"

    # ── Thumbnail Freshness (R5 compliance) ───────────────────
    thumbnail_max_age_seconds: int = 3600  # 1 hour default

    # ── Heartbeat (Automatic Disconnect Detection) ────────────
    heartbeat_timeout_seconds: int = 30
    heartbeat_sweep_interval_seconds: int = 15

    # ── Server ────────────────────────────────────────────────
    host: str = "0.0.0.0"
    port: int = 8000
    debug: bool = False

    # ── Constants (non-configurable game rules) ───────────────
    ALLOWED_ROUND_COUNTS: ClassVar[Set[int]] = {10, 20, 30, 50, 100}

    @property
    def max_score_per_round(self) -> int:
        return 1000

    @property
    def round_duration_ms(self) -> int:
        return 10000


# Singleton instance — import this everywhere
settings = Settings()  # type: ignore[call-arg]

```

## backend/app/dependencies.py

```python
"""
WhoSharedThisReel — FastAPI Dependencies

Provides injectable dependencies for:
  - Supabase admin client (singleton, service_role)
  - Current player extraction from session token
  - Optional Supabase Auth user extraction (for registered users)
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import Depends, Header, HTTPException, status
from supabase import Client as SupabaseClient, create_client

from app.config import settings
from app.services.token_service import decode_session_token

logger = logging.getLogger(__name__)

# ── Supabase Admin Client (Singleton) ─────────────────────────────
# Uses service_role key — has full access, bypasses RLS.
# Created once at module load, reused across all requests.
_supabase_client: Optional[SupabaseClient] = None


def get_supabase() -> SupabaseClient:
    """
    Return the global Supabase admin client.

    This client uses the service_role key and bypasses RLS.
    It is shared across all requests (stateless, thread-safe).
    """
    global _supabase_client
    if _supabase_client is None:
        _supabase_client = create_client(
            settings.supabase_url,
            settings.supabase_service_key,
        )
    return _supabase_client


# ── Session Token Authentication ──────────────────────────────────

async def get_current_player(
    authorization: str = Header(..., description="Bearer <session_token>"),
) -> dict[str, Any]:
    """
    Extract and validate the room session token.

    Returns the decoded JWT payload containing:
      - sub: player_id
      - room_id: room UUID
      - is_host: bool
      - type: "anonymous" | "registered"

    Raises:
        HTTPException 401: If token is missing, malformed, or expired.
    """
    if not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization header must be: Bearer <token>",
        )

    token = authorization[7:]  # Strip "Bearer "
    payload = decode_session_token(token)

    if payload is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired session token.",
        )

    return payload


async def require_host(
    player: dict[str, Any] = Depends(get_current_player),
) -> dict[str, Any]:
    """
    Dependency that requires the current player to be the room host.

    Raises:
        HTTPException 403: If the player is not the host.
    """
    if not player.get("is_host", False):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the room host can perform this action.",
        )
    return player


# ── Optional Supabase Auth User ───────────────────────────────────

async def get_optional_user_id(
    authorization: Optional[str] = Header(None),
) -> Optional[str]:
    """
    Attempt to extract a user ID from the Authorization header.

    Strategy:
      1. Try Supabase JWT validation (registered users via Supabase Auth).
      2. Fall back to our session token's user_id claim.
      3. Return None if no valid auth is present (anonymous users).

    Returns:
        User UUID string, or None if no valid auth is present.
    """
    if not authorization or not authorization.startswith("Bearer "):
        return None

    token = authorization[7:]

    # Try Supabase JWT validation first (registered users)
    try:
        supabase = get_supabase()
        user_response = supabase.auth.get_user(token)
        if user_response and user_response.user:
            return user_response.user.id
    except Exception as e:
        logger.debug("Supabase JWT validation failed: %s", str(e))

    # Fall back to our session token
    payload = decode_session_token(token)
    if payload:
        return payload.get("user_id")

    return None

```

## backend/app/models/enums.py

```python
"""
WhoSharedThisReel — Domain Enumerations

Python-side mirrors of the Postgres ENUM types.
"""

from enum import Enum


class RoomStatus(str, Enum):
    WAITING = "waiting"
    PLAYING = "playing"
    FINISHED = "finished"
    EXPIRED = "expired"


class PlayerType(str, Enum):
    ANONYMOUS = "anonymous"
    REGISTERED = "registered"


class GamePhase(str, Enum):
    STARTING = "starting"
    PLAYBACK = "playback"
    REVEAL = "reveal"
    FINISHED = "finished"

```

## backend/app/schemas/reel.py

```python
"""
WhoSharedThisReel — Reel Schemas

Pydantic models for Reel ingestion, response, and thumbnail refresh.
All input validation happens here — the service layer trusts these shapes.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

# ── URL Validation ────────────────────────────────────────────────
# Matches: https://www.instagram.com/reel/CODE/
#          https://instagram.com/reels/CODE?igsh=...
#          https://www.instagram.com/p/CODE/
INSTAGRAM_REEL_PATTERN = re.compile(
    r"^https://(www\.)?instagram\.com/(reel|reels|p)/([A-Za-z0-9_-]+)/?\??.*$"
)


def extract_shortcode(url: str) -> str:
    """Extract the Reel shortcode from a validated Instagram URL."""
    match = INSTAGRAM_REEL_PATTERN.match(url)
    if not match:
        raise ValueError(f"Invalid Instagram Reel URL: {url}")
    return match.group(3)


# ── Request Schemas ───────────────────────────────────────────────

class IngestReelRequest(BaseModel):
    """Payload for submitting a new Reel URL for ingestion."""

    source_url: str = Field(
        ...,
        min_length=20,
        max_length=2048,
        description="Public Instagram Reel URL",
        examples=["https://www.instagram.com/reel/ABC123def/"],
    )
    user_tags: List[str] = Field(
        default_factory=list,
        max_length=20,
        description="User-assigned tags (source of truth for categorization)",
    )

    @field_validator("source_url")
    @classmethod
    def validate_instagram_url(cls, v: str) -> str:
        """R1 compliance: Reject any URL that isn't a valid Instagram Reel."""
        # Normalize: strip whitespace, remove trailing fragments
        v = v.strip()
        # Remove tracking parameters but keep the core URL
        if not INSTAGRAM_REEL_PATTERN.match(v):
            raise ValueError(
                "URL must be a valid Instagram Reel link "
                "(e.g., https://www.instagram.com/reel/ABC123/)"
            )
        return v

    @field_validator("user_tags")
    @classmethod
    def validate_tags(cls, v: List[str]) -> List[str]:
        """Sanitize tags: lowercase, strip, deduplicate, max 10 chars each."""
        cleaned = []
        seen = set()
        for tag in v:
            tag = tag.strip().lower()[:50]
            if tag and tag not in seen:
                cleaned.append(tag)
                seen.add(tag)
        return cleaned[:20]


class RefreshThumbnailRequest(BaseModel):
    """Request to force re-fetch a Reel's thumbnail."""
    reel_id: str = Field(..., description="UUID of the Reel to refresh")


# ── Response Schemas ──────────────────────────────────────────────

class ReelResponse(BaseModel):
    """Full Reel record returned to clients."""

    id: str
    source_url: str
    creator_handle: Optional[str] = None
    creator_url: Optional[str] = None
    provider: str = "Instagram"
    thumbnail_url: Optional[str] = None
    thumbnail_fresh: bool = False  # Computed: is thumbnail_fetched_at recent?
    oembed_html: Optional[str] = None
    caption: Optional[str] = None
    user_tags: List[str] = Field(default_factory=list)
    created_at: Optional[datetime] = None


class ReelIngestionResult(BaseModel):
    """Response after successfully ingesting a Reel."""

    reel: ReelResponse
    is_new: bool = True  # False if the Reel already existed for this user
    metadata_source: str = "og_meta"  # "og_meta" | "oembed" | "cached"


class ThumbnailRefreshResult(BaseModel):
    """Response after refreshing a Reel's thumbnail."""

    reel_id: str
    thumbnail_url: Optional[str] = None
    fetched_at: Optional[datetime] = None
    success: bool = True
    error: Optional[str] = None


class ReelListResponse(BaseModel):
    """Paginated list of Reels (Vault listing)."""

    reels: List[ReelResponse]
    total: int
    page: int
    page_size: int

```

## backend/app/schemas/game.py

```python
"""
WhoSharedThisReel — Game Schemas

Pydantic models for game state transitions, submitting guesses,
and returning the end-of-match analytical reports.
"""

from __future__ import annotations

from typing import Optional, Dict, List
from uuid import UUID
from pydantic import BaseModel, Field, field_validator


class StartGameRequest(BaseModel):
    """Host starts the match, specifying total rounds."""
    round_count: int = Field(..., description="Total number of rounds (10, 20, 30, 50, or 100)")

    @field_validator("round_count")
    @classmethod
    def validate_round_count(cls, v: int) -> int:
        allowed = {10, 20, 30, 50, 100}
        if v not in allowed:
            raise ValueError(f"round_count must be one of {sorted(allowed)}")
        return v


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

    longest_streak_player_id: Optional[UUID]
    longest_streak: int

    fastest_player_id: Optional[UUID]
    fastest_avg_ms: Optional[float]

    slowest_player_id: Optional[UUID]
    slowest_avg_ms: Optional[float]

    most_accurate_pair: Optional[Dict[str, str]]  # {"guesser_id": ..., "owner_id": ...}
    most_accurate_ratio: Optional[float]

    leaderboard: List[LeaderboardEntry]

```

## backend/app/schemas/room.py

```python
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

```

## backend/app/services/token_service.py

```python
"""
WhoSharedThisReel — Session Token Service

Issues and validates short-lived JWTs for room sessions.
These tokens identify players (including anonymous ones) within a room
and carry authorization claims (is_host, player_type).

Separate from Supabase Auth — this is our own session layer for
ephemeral room participation.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional

from jose import JWTError, jwt

from app.config import settings

logger = logging.getLogger(__name__)

ALGORITHM = "HS256"


def create_session_token(
    player_id: str,
    room_id: str,
    is_host: bool,
    player_type: str,
    expires_at: datetime,
) -> str:
    """
    Create a room session JWT.

    Args:
        player_id: room_players.id UUID.
        room_id: rooms.id UUID.
        is_host: Whether this player is the room host.
        player_type: "anonymous" or "registered".
        expires_at: Room expiry time (token expires when room expires).

    Returns:
        Signed JWT string.
    """
    payload = {
        "sub": player_id,
        "room_id": room_id,
        "is_host": is_host,
        "type": player_type,
        "iat": datetime.now(timezone.utc).timestamp(),
        "exp": expires_at.timestamp(),
    }
    return jwt.encode(payload, settings.session_secret, algorithm=ALGORITHM)


def decode_session_token(token: str) -> Optional[dict[str, Any]]:
    """
    Decode and validate a room session JWT.

    Returns:
        Decoded payload dict, or None if invalid/expired.
    """
    try:
        payload = jwt.decode(
            token,
            settings.session_secret,
            algorithms=[ALGORITHM],
        )
        return payload
    except JWTError as e:
        logger.warning("Session token validation failed: %s", str(e))
        return None

```

## backend/app/services/instagram_parser.py

```python
"""
WhoSharedThisReel — Instagram Metadata Parser

Extracts public metadata from Instagram Reel URLs using two strategies:

1. **Open Graph (OG) meta tags** — Fetches the Reel's public HTML page and
   parses <meta property="og:..."> tags. This is the PRIMARY strategy since
   the oEmbed API deprecated thumbnail_url, author_name, and author_url
   as of November 3, 2025. This is NOT scraping — it reads the same HTML
   metadata that any browser, search engine crawler, or link preview
   generator would read.

2. **oEmbed API** (optional) — If a Meta App Access Token is configured,
   fetches the embed HTML from the official oEmbed endpoint. This provides
   the iframe for in-game Reel playback but no longer provides thumbnails
   or author data.

Compliance Notes:
- R1: source_url is validated before any fetch attempt.
- R4: No content analysis/ML is performed. Metadata is display-only.
- R5: thumbnail_url is a short-lived CDN link; we record fetch time for
      freshness tracking.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

# ── Constants ─────────────────────────────────────────────────────
INSTAGRAM_REEL_PATTERN = re.compile(
    r"^https://(www\.)?instagram\.com/(reel|reels|p)/([A-Za-z0-9_-]+)/?\??.*$"
)

# Instagram pages may redirect unauthenticated requests to login.
# We use a standard browser User-Agent to receive the public meta tags.
DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

OEMBED_ENDPOINT = "https://graph.facebook.com/v21.0/instagram_oembed"
REQUEST_TIMEOUT = 10.0  # seconds


@dataclass
class ReelMetadata:
    """Structured metadata extracted from an Instagram Reel URL."""

    source_url: str
    shortcode: str

    # Creator attribution (R2/R3 compliance)
    creator_handle: Optional[str] = None
    creator_url: Optional[str] = None

    # Display data
    thumbnail_url: Optional[str] = None
    thumbnail_fetched_at: Optional[datetime] = None
    caption: Optional[str] = None
    oembed_html: Optional[str] = None

    # Provider (always "Instagram" per R1)
    provider: str = "Instagram"

    # Parse diagnostics
    errors: list[str] = field(default_factory=list)

    @property
    def has_valid_attribution(self) -> bool:
        """R2/R3: At least one attribution path must be non-null."""
        return self.creator_handle is not None or self.creator_url is not None


def validate_instagram_url(url: str) -> tuple[bool, str, Optional[str]]:
    """
    Validate that a URL is a legitimate Instagram Reel link.

    Returns:
        (is_valid, normalized_url, shortcode)
    """
    url = url.strip()

    # Strip tracking params but keep the core path
    parsed = urlparse(url)
    if parsed.scheme != "https":
        return False, url, None
    if parsed.hostname not in ("www.instagram.com", "instagram.com"):
        return False, url, None

    match = INSTAGRAM_REEL_PATTERN.match(url)
    if not match:
        return False, url, None

    shortcode = match.group(3)

    # Normalize to canonical form: https://www.instagram.com/reel/{shortcode}/
    normalized = f"https://www.instagram.com/reel/{shortcode}/"
    return True, normalized, shortcode


async def fetch_og_metadata(url: str, client: httpx.AsyncClient) -> ReelMetadata:
    """
    Fetch Open Graph metadata from an Instagram Reel's public page.

    This parses the standard HTML <meta> tags that Instagram serves to
    any HTTP client (browsers, crawlers, link preview generators).

    Extracts:
        - og:image → thumbnail_url
        - og:title / og:description → caption + creator handle
        - og:url → canonical URL
        - author meta / page title → creator handle fallback

    Args:
        url: Validated, normalized Instagram Reel URL.
        client: Shared httpx.AsyncClient instance.

    Returns:
        ReelMetadata with whatever fields were successfully extracted.
    """
    is_valid, normalized_url, shortcode = validate_instagram_url(url)
    if not is_valid or shortcode is None:
        meta = ReelMetadata(source_url=url, shortcode="")
        meta.errors.append(f"Invalid Instagram URL: {url}")
        return meta

    metadata = ReelMetadata(source_url=normalized_url, shortcode=shortcode)

    try:
        response = await client.get(
            normalized_url,
            headers=DEFAULT_HEADERS,
            follow_redirects=True,
            timeout=REQUEST_TIMEOUT,
        )

        # Instagram may return 404 for deleted/private Reels
        if response.status_code == 404:
            metadata.errors.append("Reel not found (404). It may be deleted or private.")
            return metadata

        if response.status_code != 200:
            metadata.errors.append(
                f"Instagram returned HTTP {response.status_code}. "
                "The Reel may be private or unavailable."
            )
            return metadata

        # Check if we got redirected to login page (private content)
        final_url = str(response.url)
        if "/accounts/login" in final_url:
            metadata.errors.append(
                "Reel redirected to Instagram login. "
                "The content is likely private or age-restricted."
            )
            return metadata

        html = response.text
        soup = BeautifulSoup(html, "lxml")

        # ── Extract og:image → thumbnail_url ──────────────────
        og_image = soup.find("meta", property="og:image")
        if og_image and og_image.get("content"):
            metadata.thumbnail_url = og_image["content"]
            metadata.thumbnail_fetched_at = datetime.now(timezone.utc)

        # ── Extract og:title → caption + creator handle ───────
        og_title = soup.find("meta", property="og:title")
        if og_title and og_title.get("content"):
            title_text = og_title["content"]
            # Instagram og:title format is typically:
            # "@username on Instagram: 'caption text...'"
            # or "username on Instagram" (no caption)
            creator_match = re.match(
                r"@?([A-Za-z0-9_.]+)\s+on\s+Instagram", title_text
            )
            if creator_match:
                metadata.creator_handle = creator_match.group(1)
                metadata.creator_url = (
                    f"https://www.instagram.com/{metadata.creator_handle}/"
                )

            # Extract caption from og:title (after the colon)
            caption_match = re.search(r"on Instagram:\s*[\"'\u201c](.+)", title_text)
            if caption_match:
                metadata.caption = caption_match.group(1).rstrip("\"'\u201d")

        # ── Fallback: og:description for caption ──────────────
        if not metadata.caption:
            og_desc = soup.find("meta", property="og:description")
            if og_desc and og_desc.get("content"):
                desc = og_desc["content"]
                # og:description often has "X likes, Y comments - ..."
                # We extract the part after the dash if present
                if " - " in desc:
                    metadata.caption = desc.split(" - ", 1)[1].strip()
                else:
                    metadata.caption = desc.strip()

        # ── Fallback: <title> tag for creator handle ──────────
        if not metadata.creator_handle:
            title_tag = soup.find("title")
            if title_tag and title_tag.string:
                title_match = re.match(
                    r"@?([A-Za-z0-9_.]+)\s+on\s+Instagram",
                    title_tag.string,
                )
                if title_match:
                    metadata.creator_handle = title_match.group(1)
                    metadata.creator_url = (
                        f"https://www.instagram.com/{metadata.creator_handle}/"
                    )

        # ── Fallback: link[rel=canonical] for creator URL ─────
        if not metadata.creator_url:
            canonical = soup.find("link", rel="canonical")
            if canonical and canonical.get("href"):
                # The canonical URL is the Reel URL itself, which
                # at minimum serves as a path back to the content
                metadata.creator_url = canonical["href"]

        # ── Ultimate fallback: use source_url as creator_url ──
        # R2/R3: We MUST have at least one attribution path.
        # If all parsing fails, the source_url itself is the
        # attribution link (it IS the content on Instagram).
        if not metadata.has_valid_attribution:
            metadata.creator_url = normalized_url
            metadata.errors.append(
                "Could not extract creator handle from page metadata. "
                "Using source_url as attribution fallback."
            )

    except httpx.TimeoutException:
        metadata.errors.append(
            f"Request to Instagram timed out after {REQUEST_TIMEOUT}s."
        )
        # Fallback attribution
        if not metadata.has_valid_attribution:
            metadata.creator_url = normalized_url
    except httpx.HTTPError as e:
        metadata.errors.append(f"HTTP error fetching Reel metadata: {str(e)}")
        if not metadata.has_valid_attribution:
            metadata.creator_url = normalized_url
    except Exception as e:
        logger.exception("Unexpected error parsing Instagram metadata")
        metadata.errors.append(f"Unexpected parsing error: {str(e)}")
        if not metadata.has_valid_attribution:
            metadata.creator_url = normalized_url

    return metadata


async def fetch_oembed(
    url: str, access_token: str, client: httpx.AsyncClient
) -> Optional[str]:
    """
    Fetch oEmbed embed HTML from Meta's official endpoint.

    As of Nov 2025, this only returns the embed iframe HTML.
    thumbnail_url, author_name, and author_url are deprecated.

    Args:
        url: Canonical Instagram Reel URL.
        access_token: Meta App access token.
        client: Shared httpx.AsyncClient instance.

    Returns:
        The embed HTML string, or None if the request failed.
    """
    if not access_token:
        return None

    try:
        response = await client.get(
            OEMBED_ENDPOINT,
            params={"url": url, "access_token": access_token, "omitscript": "true"},
            timeout=REQUEST_TIMEOUT,
        )

        if response.status_code != 200:
            logger.warning(
                "oEmbed API returned %d for %s", response.status_code, url
            )
            return None

        data = response.json()
        return data.get("html")

    except Exception as e:
        logger.warning("oEmbed fetch failed for %s: %s", url, str(e))
        return None


async def refresh_thumbnail(
    source_url: str, client: httpx.AsyncClient
) -> tuple[Optional[str], Optional[datetime]]:
    """
    Re-fetch a Reel's thumbnail URL (R5 freshness enforcement).

    Called when thumbnail_fetched_at indicates the cached CDN link
    has expired. Performs a lightweight OG meta tag fetch targeting
    only the og:image property.

    Args:
        source_url: The canonical Instagram Reel URL.
        client: Shared httpx.AsyncClient instance.

    Returns:
        (new_thumbnail_url, fetched_at) or (None, None) on failure.
    """
    try:
        response = await client.get(
            source_url,
            headers=DEFAULT_HEADERS,
            follow_redirects=True,
            timeout=REQUEST_TIMEOUT,
        )

        if response.status_code != 200:
            logger.warning(
                "Thumbnail refresh failed: HTTP %d for %s",
                response.status_code,
                source_url,
            )
            return None, None

        soup = BeautifulSoup(response.text, "lxml")
        og_image = soup.find("meta", property="og:image")

        if og_image and og_image.get("content"):
            return og_image["content"], datetime.now(timezone.utc)

        logger.warning("No og:image found during thumbnail refresh for %s", source_url)
        return None, None

    except Exception as e:
        logger.warning("Thumbnail refresh error for %s: %s", source_url, str(e))
        return None, None

```

## backend/app/services/reel_service.py

```python
"""
WhoSharedThisReel — Reel Ingestion Service

Orchestrates the full Reel ingestion pipeline:
  1. Validate incoming Instagram URL (schema-level + domain-level)
  2. Check for duplicate (same user + same URL)
  3. Fetch OG metadata from the public Reel page
  4. Optionally fetch oEmbed HTML if Meta token is configured
  5. Enforce R2/R3 attribution compliance
  6. Persist to Supabase with all constraints

Also handles:
  - Thumbnail freshness checks (R5 compliance)
  - On-demand thumbnail re-fetching for live game setup
  - Vault listing for registered users
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone, timedelta
from typing import Optional
from uuid import UUID

import httpx
from supabase import Client as SupabaseClient

from app.config import settings
from app.schemas.reel import (
    IngestReelRequest,
    ReelResponse,
    ReelIngestionResult,
    ThumbnailRefreshResult,
    ReelListResponse,
)
from app.services.instagram_parser import (
    validate_instagram_url,
    fetch_og_metadata,
    fetch_oembed,
    refresh_thumbnail,
)

logger = logging.getLogger(__name__)


def _row_to_reel_response(row: dict) -> ReelResponse:
    """Convert a Supabase row dict to a ReelResponse schema."""
    # Compute thumbnail freshness
    thumbnail_fresh = False
    if row.get("thumbnail_url") and row.get("thumbnail_fetched_at"):
        fetched_at = row["thumbnail_fetched_at"]
        if isinstance(fetched_at, str):
            fetched_at = datetime.fromisoformat(fetched_at.replace("Z", "+00:00"))
        age = datetime.now(timezone.utc) - fetched_at
        thumbnail_fresh = age.total_seconds() < settings.thumbnail_max_age_seconds

    return ReelResponse(
        id=row["id"],
        source_url=row["source_url"],
        creator_handle=row.get("creator_handle"),
        creator_url=row.get("creator_url"),
        provider=row.get("provider", "Instagram"),
        thumbnail_url=row.get("thumbnail_url"),
        thumbnail_fresh=thumbnail_fresh,
        oembed_html=row.get("oembed_html"),
        caption=row.get("caption"),
        user_tags=row.get("user_tags", []),
        created_at=row.get("created_at"),
    )


async def ingest_reel(
    request: IngestReelRequest,
    user_id: Optional[UUID],
    supabase: SupabaseClient,
    player_id: Optional[str] = None,
) -> ReelIngestionResult:
    """
    Full Reel ingestion pipeline.

    Steps:
        1. Validate + normalize the Instagram URL
        2. Check for existing duplicate (same user + URL)
        3. Fetch OG metadata (thumbnail, creator, caption)
        4. Fetch oEmbed HTML (if Meta token configured)
        5. Enforce attribution compliance (R2/R3)
        6. Insert into database

    Args:
        request: Validated IngestReelRequest from the router.
        user_id: UUID of the registered user, or None for anonymous.
        supabase: Supabase admin client (service_role).
        player_id: room_players.id for anonymous players (enables
                   ownership verification in add_reel_to_vault).

    Returns:
        ReelIngestionResult with the persisted Reel data.

    Raises:
        ValueError: If URL is invalid or Reel is inaccessible.
    """
    # ── Step 1: Validate URL ──────────────────────────────────
    is_valid, normalized_url, shortcode = validate_instagram_url(request.source_url)
    if not is_valid or shortcode is None:
        raise ValueError(
            "Invalid Instagram Reel URL. Expected format: "
            "https://www.instagram.com/reel/SHORTCODE/"
        )

    # ── Step 2: Deduplication check ───────────────────────────
    # Registered users: dedup by (source_url, ingested_by)
    # Anonymous users: dedup by (source_url, ingested_by_player_id)
    query = (
        supabase.table("reels")
        .select("*")
        .eq("source_url", normalized_url)
    )
    if user_id:
        query = query.eq("ingested_by", str(user_id))
    elif player_id:
        query = query.eq("ingested_by_player_id", player_id)
    else:
        query = query.is_("ingested_by", "null").is_("ingested_by_player_id", "null")

    existing = query.maybe_single().execute()

    if existing.data:
        logger.info(
            "Duplicate Reel detected: %s for user %s", normalized_url, user_id
        )
        return ReelIngestionResult(
            reel=_row_to_reel_response(existing.data),
            is_new=False,
            metadata_source="cached",
        )

    # ── Step 3: Fetch OG metadata ─────────────────────────────
    async with httpx.AsyncClient() as client:
        metadata = await fetch_og_metadata(normalized_url, client)

        # Log any non-fatal parse warnings
        for error in metadata.errors:
            logger.warning("OG parse warning for %s: %s", normalized_url, error)

        # ── Step 4: Fetch oEmbed HTML (optional) ──────────────
        oembed_html = None
        if settings.meta_app_access_token:
            oembed_html = await fetch_oembed(
                normalized_url, settings.meta_app_access_token, client
            )
            if oembed_html:
                metadata.oembed_html = oembed_html

    # ── Step 5: Enforce attribution compliance ────────────────
    # R2/R3: The CHECK constraint in Postgres will reject inserts
    # where BOTH creator_handle AND creator_url are NULL. The parser
    # already applies fallback logic, but we double-check here.
    if not metadata.has_valid_attribution:
        # Ultimate fallback: the source URL itself IS attribution
        metadata.creator_url = normalized_url
        logger.warning(
            "Attribution fallback triggered for %s — using source_url",
            normalized_url,
        )

    # ── Step 6: Persist to Supabase ───────────────────────────
    insert_payload = {
        "source_url": normalized_url,
        "creator_handle": metadata.creator_handle,
        "creator_url": metadata.creator_url,
        "provider": metadata.provider,
        "thumbnail_url": metadata.thumbnail_url,
        "thumbnail_fetched_at": (
            metadata.thumbnail_fetched_at.isoformat()
            if metadata.thumbnail_fetched_at
            else None
        ),
        "oembed_html": metadata.oembed_html,
        "caption": metadata.caption,
        "user_tags": request.user_tags,
        "ingested_by": str(user_id) if user_id else None,
        "ingested_by_player_id": player_id if (not user_id and player_id) else None,
    }

    result = supabase.table("reels").insert(insert_payload).execute()

    if not result.data:
        raise ValueError("Failed to persist Reel to database.")

    row = result.data[0]
    return ReelIngestionResult(
        reel=_row_to_reel_response(row),
        is_new=True,
        metadata_source="og_meta" if not oembed_html else "og_meta+oembed",
    )


async def refresh_reel_thumbnail(
    reel_id: str,
    supabase: SupabaseClient,
) -> ThumbnailRefreshResult:
    """
    Force re-fetch a Reel's thumbnail (R5 CDN freshness compliance).

    Called when:
      - thumbnail_fetched_at is older than THUMBNAIL_MAX_AGE_SECONDS
      - During live game setup to ensure all thumbnails are fresh
      - Explicitly by the user via the refresh endpoint

    Args:
        reel_id: UUID of the Reel to refresh.
        supabase: Supabase admin client.

    Returns:
        ThumbnailRefreshResult with the new URL and fetch time.
    """
    # Fetch the existing Reel record
    reel_result = (
        supabase.table("reels")
        .select("id, source_url, thumbnail_url, thumbnail_fetched_at")
        .eq("id", reel_id)
        .maybe_single()
        .execute()
    )

    if not reel_result.data:
        return ThumbnailRefreshResult(
            reel_id=reel_id,
            success=False,
            error="Reel not found.",
        )

    reel = reel_result.data
    source_url = reel["source_url"]

    # Perform the re-fetch
    async with httpx.AsyncClient() as client:
        new_thumb, fetched_at = await refresh_thumbnail(source_url, client)

    if not new_thumb:
        return ThumbnailRefreshResult(
            reel_id=reel_id,
            thumbnail_url=reel.get("thumbnail_url"),  # Keep old if refresh fails
            fetched_at=None,
            success=False,
            error="Failed to re-fetch thumbnail from Instagram.",
        )

    # Update the database
    supabase.table("reels").update({
        "thumbnail_url": new_thumb,
        "thumbnail_fetched_at": fetched_at.isoformat() if fetched_at else None,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", reel_id).execute()

    return ThumbnailRefreshResult(
        reel_id=reel_id,
        thumbnail_url=new_thumb,
        fetched_at=fetched_at,
        success=True,
    )


async def ensure_thumbnails_fresh(
    reel_ids: list[str],
    supabase: SupabaseClient,
) -> dict[str, ThumbnailRefreshResult]:
    """
    Batch-check and refresh stale thumbnails for a set of Reels.

    Called during live game setup (pre-match validation) to ensure
    every Reel in the game pool has a fresh, renderable thumbnail.

    R5 Compliance: Thumbnails older than THUMBNAIL_MAX_AGE_SECONDS
    are considered stale and will be re-fetched.

    Args:
        reel_ids: List of Reel UUIDs to check.
        supabase: Supabase admin client.

    Returns:
        Dict mapping reel_id → ThumbnailRefreshResult.
    """
    if not reel_ids:
        return {}

    # Fetch all reels in one query
    reels_result = (
        supabase.table("reels")
        .select("id, source_url, thumbnail_url, thumbnail_fetched_at")
        .in_("id", reel_ids)
        .execute()
    )

    if not reels_result.data:
        return {}

    max_age = timedelta(seconds=settings.thumbnail_max_age_seconds)
    now = datetime.now(timezone.utc)
    results: dict[str, ThumbnailRefreshResult] = {}

    async with httpx.AsyncClient() as client:
        for reel in reels_result.data:
            reel_id = reel["id"]

            # Check if thumbnail is fresh
            is_stale = True
            if reel.get("thumbnail_url") and reel.get("thumbnail_fetched_at"):
                fetched_at = reel["thumbnail_fetched_at"]
                if isinstance(fetched_at, str):
                    fetched_at = datetime.fromisoformat(
                        fetched_at.replace("Z", "+00:00")
                    )
                is_stale = (now - fetched_at) > max_age

            if not is_stale:
                # Thumbnail is fresh — no action needed
                results[reel_id] = ThumbnailRefreshResult(
                    reel_id=reel_id,
                    thumbnail_url=reel["thumbnail_url"],
                    fetched_at=reel.get("thumbnail_fetched_at"),
                    success=True,
                )
                continue

            # Thumbnail is stale or missing — re-fetch
            logger.info("Re-fetching stale thumbnail for reel %s", reel_id)
            new_thumb, fetched_at = await refresh_thumbnail(
                reel["source_url"], client
            )

            if new_thumb and fetched_at:
                # Update DB
                supabase.table("reels").update({
                    "thumbnail_url": new_thumb,
                    "thumbnail_fetched_at": fetched_at.isoformat(),
                    "updated_at": now.isoformat(),
                }).eq("id", reel_id).execute()

                results[reel_id] = ThumbnailRefreshResult(
                    reel_id=reel_id,
                    thumbnail_url=new_thumb,
                    fetched_at=fetched_at,
                    success=True,
                )
            else:
                results[reel_id] = ThumbnailRefreshResult(
                    reel_id=reel_id,
                    thumbnail_url=reel.get("thumbnail_url"),
                    success=False,
                    error="Re-fetch failed; keeping stale thumbnail if available.",
                )

    return results


async def list_user_reels(
    user_id: UUID,
    supabase: SupabaseClient,
    page: int = 1,
    page_size: int = 20,
) -> ReelListResponse:
    """
    List a registered user's Vault (their ingested Reels).

    Args:
        user_id: The authenticated user's UUID.
        supabase: Supabase admin client.
        page: 1-indexed page number.
        page_size: Items per page (max 50).

    Returns:
        Paginated ReelListResponse.
    """
    page_size = min(max(page_size, 1), 50)
    offset = (max(page, 1) - 1) * page_size

    # Count total
    count_result = (
        supabase.table("reels")
        .select("id", count="exact")
        .eq("ingested_by", str(user_id))
        .execute()
    )
    total = count_result.count or 0

    # Fetch page
    data_result = (
        supabase.table("reels")
        .select("*")
        .eq("ingested_by", str(user_id))
        .order("created_at", desc=True)
        .range(offset, offset + page_size - 1)
        .execute()
    )

    reels = [_row_to_reel_response(row) for row in (data_result.data or [])]

    return ReelListResponse(
        reels=reels,
        total=total,
        page=page,
        page_size=page_size,
    )

```

## backend/app/services/game_engine.py

```python
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
        leaderboard_entries.append(LeaderboardEntry(
            rank=0,  # calculated below
            player_id=UUID(pid),
            display_name=profile.get("display_name", "Unknown"),
            total_score=player_scores[pid],
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

```

## backend/app/services/game_service.py

```python
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
    
    task_manager.spawn(room_id, manager.broadcast_to_room(room_id, {
        "event": "round_start",
        "round_no": 1,
        "reel_id": first_round["reel_id"],
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

    if not record.data:
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

# In-memory lock to prevent double-resolution of a round
_resolved_rounds: set[str] = set()

async def _resolve_round(room_id: str, round_no: int, supabase: SupabaseClient):
    """Broadcast round_result, handle game_end vs next-round, and schedule next round."""
    lock_key = f"{room_id}_{round_no}"
    if lock_key in _resolved_rounds:
        return  # Already resolved
    _resolved_rounds.add(lock_key)

    from app.services.websocket_manager import manager
    from app.services.game_task_manager import task_manager
    import asyncio
    
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
        
        # Broadcast round_result
        await manager.broadcast_to_room(room_id, {
            "event": "round_result",
            "round_no": round_no,
            "owner_id": owner_id,
            "scores": scores
        })
        
    # Check if it was the last round
    room = supabase.table("rooms").select("round_count").eq("id", room_id).maybe_single().execute()
    round_count = room.data.get("round_count", 0) if room.data else 0
    
    if round_no >= round_count:
        # Game over
        supabase.table("rooms").update({"status": RoomStatus.FINISHED.value}).eq("id", room_id).execute()
        task_manager.cancel_room_tasks(room_id)
        await manager.broadcast_to_room(room_id, {
            "event": "game_end"
        })
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
            # Update game_state
            supabase.table("game_state").update({
                "current_round": next_round,
                "current_reel_id": next_reel_id,
                "updated_at": datetime.now(timezone.utc).isoformat()
            }).eq("room_id", room_id).execute()
            
            # Small delay to let clients show results
            await asyncio.sleep(5)
            
            # Schedule next round
            now = datetime.now(timezone.utc)
            ends_at = (now + timedelta(milliseconds=settings.round_duration_ms)).isoformat()
            player_options = [{"id": str(p["id"]), "name": p["display_name"]} for p in active_players]
            
            await manager.broadcast_to_room(room_id, {
                "event": "round_start",
                "round_no": next_round,
                "reel_id": next_reel_id,
                "options": player_options,
                "round_duration_ms": settings.round_duration_ms,
                "round_ends_at": ends_at
            })
            
            # Schedule the new round timer
            async def round_timer(r_no: int, sbase: SupabaseClient):
                await asyncio.sleep(settings.round_duration_ms / 1000.0)
                sbase.table("round_telemetry").update({
                    "answered": True,
                    "is_correct": False,
                    "score": 0
                }).eq("room_id", room_id).eq("round_no", r_no).eq("answered", False).execute()
                await _resolve_round(room_id, r_no, sbase)
                
            task_manager.spawn(room_id, round_timer(next_round, supabase), f"timer_{next_round}")


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
    if not room.data:
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
            if prof.data:
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

```

## backend/app/services/room_service.py

```python
"""
WhoSharedThisReel — Room & Lobby Service

Handles room lifecycle: creation, joining, vault management,
player disconnect/leave (unified), and heartbeat tracking.
"""

from __future__ import annotations

import logging
import random
import string
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any, List
from uuid import UUID

from supabase import Client as SupabaseClient

from app.config import settings
from app.models.enums import RoomStatus, PlayerType
from app.services.token_service import create_session_token

logger = logging.getLogger(__name__)


def _generate_room_code() -> str:
    """Generate a 6-character alphanumeric room code (uppercase)."""
    return "".join(random.choices(string.ascii_uppercase + string.digits, k=6))


async def create_room(
    display_name: str,
    user_id: Optional[str],
    max_players: int,
    supabase: SupabaseClient,
) -> Dict[str, Any]:
    """
    Create a new room and add the host as the first player.

    Returns:
        Dict with room details and session token for the host.
    """
    # Generate a unique room code (retry on collision)
    for _ in range(10):
        code = _generate_room_code()
        existing = (
            supabase.table("rooms")
            .select("id")
            .eq("code", code)
            .neq("status", RoomStatus.EXPIRED.value)
            .neq("status", RoomStatus.FINISHED.value)
            .maybe_single()
            .execute()
        )
        if not existing or not existing.data:
            break
    else:
        raise ValueError("Could not generate a unique room code. Please try again.")

    expires_at = datetime.now(timezone.utc) + timedelta(hours=3)

    # Insert room
    room_result = (
        supabase.table("rooms")
        .insert({
            "code": code,
            "host_id": user_id,
            "status": RoomStatus.WAITING.value,
            "max_players": max_players,
            "round_count": 10,  # default, host changes at start
            "expires_at": expires_at.isoformat(),
        })
        .execute()
    )

    if not room_result.data:
        raise ValueError("Failed to create room.")

    room = room_result.data[0]
    room_id = room["id"]

    # Add host as first player
    player_type = PlayerType.REGISTERED.value if user_id else PlayerType.ANONYMOUS.value
    player_result = (
        supabase.table("room_players")
        .insert({
            "room_id": room_id,
            "user_id": user_id,
            "display_name": display_name,
            "player_type": player_type,
            "is_host": True,
            "is_connected": True,
        })
        .execute()
    )

    if not player_result.data:
        raise ValueError("Failed to add host to room.")

    player = player_result.data[0]
    player_id = player["id"]

    # Issue session token
    token = create_session_token(
        player_id=str(player_id),
        room_id=str(room_id),
        is_host=True,
        player_type=player_type,
        expires_at=expires_at,
    )

    return {
        "room_id": room_id,
        "room_code": code,
        "player_id": player_id,
        "session_token": token,
        "expires_at": expires_at.isoformat(),
    }


async def join_room(
    room_code: str,
    display_name: str,
    user_id: Optional[str],
    supabase: SupabaseClient,
) -> Dict[str, Any]:
    """
    Join an existing room by code.

    Returns:
        Dict with room details and session token for the joining player.
    """
    # Find the room
    room_result = (
        supabase.table("rooms")
        .select("id, code, host_id, status, max_players, expires_at")
        .eq("code", room_code.upper())
        .eq("status", RoomStatus.WAITING.value)
        .maybe_single()
        .execute()
    )

    if not room_result or not room_result.data:
        raise ValueError("Room not found or not accepting players.")

    room = room_result.data
    room_id = room["id"]

    # Check player count
    players_result = (
        supabase.table("room_players")
        .select("id", count="exact")
        .eq("room_id", room_id)
        .eq("is_connected", True)
        .execute()
    )
    current_count = players_result.count or 0

    if current_count >= room["max_players"]:
        raise ValueError("Room is full.")

    # Check for duplicate registered user
    if user_id:
        existing = (
            supabase.table("room_players")
            .select("id")
            .eq("room_id", room_id)
            .eq("user_id", user_id)
            .maybe_single()
            .execute()
        )
        if existing and existing.data:
            raise ValueError("You are already in this room.")

    # Add player
    player_type = PlayerType.REGISTERED.value if user_id else PlayerType.ANONYMOUS.value
    player_result = (
        supabase.table("room_players")
        .insert({
            "room_id": room_id,
            "user_id": user_id,
            "display_name": display_name,
            "player_type": player_type,
            "is_host": False,
            "is_connected": True,
        })
        .execute()
    )

    if not player_result.data:
        raise ValueError("Failed to join room.")

    player = player_result.data[0]
    player_id = player["id"]

    # Parse expires_at
    expires_at_str = room["expires_at"]
    if isinstance(expires_at_str, str):
        expires_at = datetime.fromisoformat(expires_at_str.replace("Z", "+00:00"))
    else:
        expires_at = expires_at_str

    # Issue session token
    token = create_session_token(
        player_id=str(player_id),
        room_id=str(room_id),
        is_host=False,
        player_type=player_type,
        expires_at=expires_at,
    )

    return {
        "room_id": room_id,
        "room_code": room["code"],
        "player_id": player_id,
        "session_token": token,
    }


async def get_room_details(
    room_id: str,
    supabase: SupabaseClient,
) -> Dict[str, Any]:
    """Get room details including the player list."""
    room_result = (
        supabase.table("rooms")
        .select("id, code, host_id, status, max_players, round_count, created_at, expires_at")
        .eq("id", room_id)
        .maybe_single()
        .execute()
    )

    if not room_result or not room_result.data:
        raise ValueError("Room not found.")

    players_result = (
        supabase.table("room_players")
        .select("id, display_name, player_type, is_host, is_connected, joined_at")
        .eq("room_id", room_id)
        .execute()
    )

    return {
        "room": room_result.data if room_result else None,
        "players": players_result.data or [],
    }


async def add_reel_to_vault(
    room_id: str,
    player_id: str,
    player_type: str,
    user_id: Optional[str],
    reel_id: str,
    supabase: SupabaseClient,
) -> Dict[str, Any]:
    """
    Add a Reel to the room's vault_reels pool.

    Ownership check (Fix 1):
      - Registered player: reel.ingested_by must match user_id.
      - Anonymous player: reel.ingested_by_player_id must match player_id.
    A reel with neither owner field matching is rejected.

    The Reel must already exist in the reels table.
    A Reel can only be added to a room once (enforced by DB constraint).
    """
    # Fetch reel with ownership fields
    reel = (
        supabase.table("reels")
        .select("id, ingested_by, ingested_by_player_id")
        .eq("id", reel_id)
        .maybe_single()
        .execute()
    )
    if not reel or not reel.data:
        raise ValueError("Reel not found.")

    reel_data = reel.data

    # Ownership verification
    if player_type == PlayerType.REGISTERED.value:
        # Registered player: verify ingested_by matches their user_id
        if not user_id:
            raise ValueError("Registered player must have a user_id.")
        reel_owner = reel_data.get("ingested_by")
        if reel_owner != user_id:
            raise ValueError(
                "You can only add Reels you ingested. "
                "This Reel was not ingested by your account."
            )
    else:
        # Anonymous player: verify ingested_by_player_id matches their player_id
        reel_player_owner = reel_data.get("ingested_by_player_id")
        if reel_player_owner != player_id:
            raise ValueError(
                "You can only add Reels you ingested. "
                "This Reel was not ingested by your session."
            )

    # Insert into vault_reels
    try:
        result = (
            supabase.table("vault_reels")
            .insert({
                "room_id": room_id,
                "reel_id": reel_id,
                "player_id": player_id,
            })
            .execute()
        )
    except Exception as e:
        if "vault_reels_unique_per_room" in str(e):
            raise ValueError("This Reel is already in the room's pool.")
        raise

    if not result.data:
        raise ValueError("Failed to add Reel to vault.")

    return result.data[0]


async def remove_player(
    room_id: str,
    player_id: str,
    supabase: SupabaseClient,
) -> Dict[str, str]:
    """
    Unified leave/disconnect handler (Fix 3).

    Handles both explicit leave (lobby) and mid-match disconnect:
      - Always sets is_connected = False.
      - If the room is currently 'playing', also zeros out all
        unanswered telemetry rows for this player (score 0 per spec).
      - If the room is 'waiting', no telemetry exists yet — just disconnect.

    Both DELETE /leave and POST /disconnect route through this function.
    """
    # Check room status to decide whether to zero telemetry
    room_result = (
        supabase.table("rooms")
        .select("status")
        .eq("id", room_id)
        .maybe_single()
        .execute()
    )

    # Mark player as disconnected
    supabase.table("room_players").update({
        "is_connected": False,
    }).eq("room_id", room_id).eq("id", player_id).execute()

    # If room is playing, zero out unanswered rounds for this player
    if room_result and room_result.data and room_result.data.get("status") == RoomStatus.PLAYING.value:
        supabase.table("round_telemetry").update({
            "answered": True,
            "is_correct": False,
            "score": 0,
        }).eq("room_id", room_id).eq("player_id", player_id).eq("answered", False).execute()

        logger.info(
            "Player %s disconnected from active match in room %s — remaining rounds zeroed.",
            player_id,
            room_id,
        )
        
        # Issue 3: Re-check round completion now that a player has left
        gs = supabase.table("game_state").select("current_round").eq("room_id", room_id).maybe_single().execute()
        if gs and gs.data:
            round_no = gs.data["current_round"]
            from app.services.game_service import check_active_round_completion
            from app.services.game_task_manager import task_manager
            task_manager.spawn(room_id, check_active_round_completion(room_id, round_no, supabase), f"recheck_{round_no}")
    else:
        logger.info(
            "Player %s left room %s (room not in playing state).",
            player_id,
            room_id,
        )

    return {"status": "disconnected"}


async def record_heartbeat(
    room_id: str,
    player_id: str,
    supabase: SupabaseClient,
) -> Dict[str, str]:
    """
    Record a heartbeat from a connected client.

    Updates last_heartbeat_at to now(). The sweep task uses this
    to detect clients that have gone silent.
    """
    supabase.table("room_players").update({
        "last_heartbeat_at": datetime.now(timezone.utc).isoformat(),
    }).eq("room_id", room_id).eq("id", player_id).eq("is_connected", True).execute()

    return {"status": "ok"}


async def sweep_stale_players(supabase: SupabaseClient) -> int:
    """
    Disconnect players whose last heartbeat exceeds the configured timeout.

    Called periodically by the heartbeat sweep background task.
    Returns the number of players disconnected.

    For each stale player found:
      - Calls remove_player to handle disconnect + telemetry zeroing.
    """
    timeout = settings.heartbeat_timeout_seconds
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=timeout)).isoformat()

    # Find all connected players whose heartbeat is stale
    stale_result = (
        supabase.table("room_players")
        .select("id, room_id")
        .eq("is_connected", True)
        .lt("last_heartbeat_at", cutoff)
        .execute()
    )

    stale_players = stale_result.data or []
    if not stale_players:
        return 0

    disconnected = 0
    for player in stale_players:
        try:
            await remove_player(
                room_id=str(player["room_id"]),
                player_id=str(player["id"]),
                supabase=supabase,
            )
            disconnected += 1
        except Exception as e:
            logger.error(
                "Failed to disconnect stale player %s: %s",
                player["id"],
                str(e),
            )

    logger.info("Heartbeat sweep: disconnected %d stale players.", disconnected)
    return disconnected

```

## backend/app/services/websocket_manager.py

```python
"""
WhoSharedThisReel — WebSocket Connection Manager

Manages active WebSocket connections per room to broadcast game events.
Also handles client disconnections to automatically remove them from the game.
"""

from __future__ import annotations

import logging
from typing import Dict, List, Any
from fastapi import WebSocket, WebSocketDisconnect

from supabase import Client as SupabaseClient
from app.services.room_service import remove_player

logger = logging.getLogger(__name__)


class ConnectionManager:
    def __init__(self):
        # Maps room_id -> list of active (WebSocket, player_id) tuples
        self.active_connections: Dict[str, List[tuple[WebSocket, str]]] = {}

    async def connect(self, websocket: WebSocket, room_id: str, player_id: str):
        await websocket.accept()
        if room_id not in self.active_connections:
            self.active_connections[room_id] = []
        self.active_connections[room_id].append((websocket, player_id))
        logger.info("Player %s connected to WebSocket in room %s", player_id, room_id)

    async def disconnect(self, websocket: WebSocket, room_id: str, player_id: str, supabase: SupabaseClient):
        if room_id in self.active_connections:
            # Remove the connection tuple
            self.active_connections[room_id] = [
                conn for conn in self.active_connections[room_id] if conn[0] != websocket
            ]
            if not self.active_connections[room_id]:
                del self.active_connections[room_id]
                
        logger.info("Player %s disconnected from WebSocket in room %s", player_id, room_id)
        
        # Trigger automatic removal and telemetry zeroing on disconnect
        try:
            await remove_player(room_id, player_id, supabase)
        except Exception as e:
            logger.error("Failed to cleanly remove player %s on disconnect: %s", player_id, e)

    async def broadcast_to_room(self, room_id: str, message: Dict[str, Any]):
        """Push a JSON message to all connected clients in a room."""
        if room_id not in self.active_connections:
            return
            
        disconnected = []
        for connection in self.active_connections[room_id]:
            ws, player_id = connection
            try:
                await ws.send_json(message)
            except Exception as e:
                logger.warning("Error broadcasting to player %s in room %s: %s", player_id, room_id, e)
                disconnected.append(connection)
                
        # Clean up any connections that threw errors during broadcast
        for ws, player_id in disconnected:
            if room_id in self.active_connections and (ws, player_id) in self.active_connections[room_id]:
                self.active_connections[room_id].remove((ws, player_id))

# Global singleton connection manager
manager = ConnectionManager()

```

## backend/app/services/game_task_manager.py

```python
"""
WhoSharedThisReel — Game Task Manager

Tracks active background tasks per room (like round timers and progressions)
to prevent them from being garbage-collected, and to allow cancellation
when a round ends early or a game finishes.

Also provides a safe wrapper for tasks to ensure exceptions are logged
rather than silently swallowed.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Dict, Set, Callable, Coroutine, Any

logger = logging.getLogger(__name__)

class GameTaskManager:
    def __init__(self):
        # Maps room_id -> set of active asyncio Tasks
        self.tasks: Dict[str, Set[asyncio.Task]] = {}

    def _safe_task(self, coro: Coroutine[Any, Any, Any], room_id: str, name: str) -> Coroutine[Any, Any, Any]:
        """Wrap a coroutine to catch and log exceptions."""
        async def wrapper():
            try:
                await coro
            except asyncio.CancelledError:
                logger.info(f"Task '{name}' for room {room_id} was cancelled.")
                raise
            except Exception as e:
                logger.exception(f"Unhandled exception in task '{name}' for room {room_id}: {e}")
        return wrapper()

    def spawn(self, room_id: str, coro: Coroutine[Any, Any, Any], name: str = "unnamed_task") -> asyncio.Task:
        """
        Spawn a task tied to a room, keeping a reference to it.
        The task will automatically remove itself from tracking when done.
        """
        if room_id not in self.tasks:
            self.tasks[room_id] = set()
            
        safe_coro = self._safe_task(coro, room_id, name)
        task = asyncio.create_task(safe_coro, name=f"{room_id}_{name}")
        self.tasks[room_id].add(task)

        # Remove from set when done
        task.add_done_callback(lambda t: self._remove_task(room_id, t))
        return task

    def _remove_task(self, room_id: str, task: asyncio.Task):
        """Internal callback to remove a completed task."""
        if room_id in self.tasks:
            self.tasks[room_id].discard(task)
            if not self.tasks[room_id]:
                del self.tasks[room_id]

    def cancel_room_tasks(self, room_id: str):
        """Cancel all active tasks for a given room."""
        if room_id in self.tasks:
            tasks_to_cancel = list(self.tasks[room_id])
            for task in tasks_to_cancel:
                task.cancel()
            logger.info(f"Cancelled {len(tasks_to_cancel)} tasks for room {room_id}")

    def cancel_task(self, room_id: str, task_name_suffix: str):
        """Cancel a specific task by suffix for a given room."""
        if room_id in self.tasks:
            tasks_to_cancel = [
                t for t in self.tasks[room_id] 
                if t.get_name().endswith(f"_{task_name_suffix}")
            ]
            for task in tasks_to_cancel:
                task.cancel()
            if tasks_to_cancel:
                logger.info(f"Cancelled task {task_name_suffix} for room {room_id}")

# Global singleton task manager
task_manager = GameTaskManager()

```

## backend/app/routers/health.py

```python
"""
WhoSharedThisReel — Health Check Router
"""

from fastapi import APIRouter

router = APIRouter(tags=["health"])


@router.get("/api/v1/health", summary="Health check")
async def health_check() -> dict:
    """Basic health check endpoint."""
    return {"status": "ok", "service": "whosharedthisreel"}

```

## backend/app/routers/reels.py

```python
"""
WhoSharedThisReel — Reels Router

API endpoints for Reel ingestion, Vault management, and thumbnail refresh.

Endpoints:
    POST   /api/v1/reels/ingest            — Submit a Reel URL for ingestion
    GET    /api/v1/reels                    — List user's Vault (paginated)
    GET    /api/v1/reels/{reel_id}          — Get a single Reel
    POST   /api/v1/reels/{reel_id}/refresh  — Force thumbnail re-fetch (R5)
    POST   /api/v1/reels/ensure-fresh       — Batch thumbnail freshness check
"""

from __future__ import annotations

import logging
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status, Header
from supabase import Client as SupabaseClient

from app.dependencies import get_optional_user_id, get_supabase
from app.schemas.reel import (
    IngestReelRequest,
    ReelIngestionResult,
    ReelListResponse,
    ReelResponse,
    ThumbnailRefreshResult,
)
from app.services.reel_service import (
    ensure_thumbnails_fresh,
    ingest_reel,
    list_user_reels,
    refresh_reel_thumbnail,
)
from app.services.token_service import decode_session_token

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/reels", tags=["reels"])


@router.post(
    "/ingest",
    response_model=ReelIngestionResult,
    status_code=status.HTTP_201_CREATED,
    summary="Ingest a Reel URL",
    description=(
        "Submit a public Instagram Reel URL for metadata extraction and storage. "
        "Validates the URL, fetches OG metadata (thumbnail, creator, caption), "
        "and persists the record. Registered users get Vault storage; anonymous "
        "users get ephemeral room-scoped storage."
    ),
)
async def ingest_reel_endpoint(
    request: IngestReelRequest,
    user_id: Optional[str] = Depends(get_optional_user_id),
    authorization: Optional[str] = Header(None),
    supabase: SupabaseClient = Depends(get_supabase),
) -> ReelIngestionResult:
    """
    Ingest a new Reel into the system.

    R1 compliance: Rejects any URL that isn't a valid Instagram Reel link.
    R2/R3 compliance: Guarantees creator attribution is persisted.
    R5 compliance: Records thumbnail_fetched_at for CDN freshness tracking.
    """
    # Extract player_id from session token if present (for anonymous ownership)
    player_id = None
    if authorization and authorization.startswith("Bearer "):
        payload = decode_session_token(authorization[7:])
        if payload:
            player_id = payload.get("sub")

    try:
        result = await ingest_reel(
            request=request,
            user_id=UUID(user_id) if user_id else None,
            supabase=supabase,
            player_id=player_id,
        )
        return result
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(e),
        )
    except Exception as e:
        logger.exception("Reel ingestion failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to ingest Reel. Please try again.",
        )


@router.get(
    "",
    response_model=ReelListResponse,
    summary="List Vault Reels",
    description="Paginated list of the authenticated user's saved Reels (Vault).",
)
async def list_reels_endpoint(
    page: int = Query(1, ge=1, description="Page number (1-indexed)"),
    page_size: int = Query(20, ge=1, le=50, description="Items per page"),
    user_id: Optional[str] = Depends(get_optional_user_id),
    supabase: SupabaseClient = Depends(get_supabase),
) -> ReelListResponse:
    """List the current user's Vault Reels."""
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required to view Vault.",
        )

    return await list_user_reels(
        user_id=UUID(user_id),
        supabase=supabase,
        page=page,
        page_size=page_size,
    )


@router.get(
    "/{reel_id}",
    response_model=ReelResponse,
    summary="Get a single Reel",
    description="Retrieve metadata for a specific Reel by ID.",
)
async def get_reel_endpoint(
    reel_id: str,
    supabase: SupabaseClient = Depends(get_supabase),
) -> ReelResponse:
    """Get a single Reel's full metadata."""
    result = (
        supabase.table("reels")
        .select("*")
        .eq("id", reel_id)
        .maybe_single()
        .execute()
    )

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Reel not found.",
        )

    from app.services.reel_service import _row_to_reel_response

    return _row_to_reel_response(result.data)


@router.post(
    "/{reel_id}/refresh",
    response_model=ThumbnailRefreshResult,
    summary="Refresh Reel thumbnail",
    description=(
        "Force re-fetch of a Reel's thumbnail URL from Instagram. "
        "Used when the cached CDN link has expired (R5 compliance)."
    ),
)
async def refresh_thumbnail_endpoint(
    reel_id: str,
    supabase: SupabaseClient = Depends(get_supabase),
) -> ThumbnailRefreshResult:
    """
    Force re-fetch a Reel's thumbnail.

    R5 compliance: CDN URLs are short-lived. This endpoint allows
    on-demand refresh when the thumbnail_fetched_at indicates staleness.
    """
    result = await refresh_reel_thumbnail(reel_id=reel_id, supabase=supabase)
    if not result.success:
        # Still return 200 — the result object carries the error detail.
        # The old thumbnail (if any) is preserved.
        logger.warning("Thumbnail refresh failed for %s: %s", reel_id, result.error)
    return result


@router.post(
    "/ensure-fresh",
    response_model=dict[str, ThumbnailRefreshResult],
    summary="Batch thumbnail freshness check",
    description=(
        "Check and refresh stale thumbnails for a list of Reel IDs. "
        "Called during live game setup to guarantee all Reels in the "
        "game pool have renderable thumbnails."
    ),
)
async def ensure_fresh_endpoint(
    reel_ids: list[str],
    supabase: SupabaseClient = Depends(get_supabase),
) -> dict[str, ThumbnailRefreshResult]:
    """
    Batch-check thumbnail freshness for game setup.

    This is the critical R5 enforcement point: before a match starts,
    every Reel in the pool must have a fresh thumbnail. Stale or
    missing thumbnails are re-fetched on the spot.
    """
    if len(reel_ids) > 100:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Maximum 100 Reels per batch freshness check.",
        )

    return await ensure_thumbnails_fresh(reel_ids=reel_ids, supabase=supabase)

```

## backend/app/routers/rooms.py

```python
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
    description="Join an existing room using the 6-character room code.",
)
async def join_room_endpoint(
    request: JoinRoomRequest,
    user_id: Optional[str] = Depends(get_optional_user_id),
    supabase: SupabaseClient = Depends(get_supabase),
) -> RoomJoinedResponse:
    """Join a room by its 6-character code."""
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
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )

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
    await manager.connect(websocket, room_id, player_id)

    try:
        while True:
            # We don't expect messages from the client on this channel yet,
            # but we need to read to detect disconnects.
            await websocket.receive_text()
    except WebSocketDisconnect:
        await manager.disconnect(websocket, room_id, player_id, supabase)

```

## backend/app/routers/game.py

```python
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

```

## backend/test_phase2.py

```python
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
from app.services.instagram_parser import validate_instagram_url
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
from app.services.instagram_parser import fetch_og_metadata, refresh_thumbnail
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

```

## backend/test_phase3_engine.py

```python
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

```

