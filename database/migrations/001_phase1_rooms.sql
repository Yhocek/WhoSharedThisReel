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
