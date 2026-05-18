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
