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
