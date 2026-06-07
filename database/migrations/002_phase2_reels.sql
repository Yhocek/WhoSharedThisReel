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
