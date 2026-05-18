"""
WhoSharedThisReel — Application Configuration

Reads all settings from environment variables via pydantic-settings.
No secrets are ever hardcoded. See .env.example for required vars.
"""

from __future__ import annotations

import json
from typing import List

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
    cors_origins: List[str] = ["http://localhost:8081"]

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

    # ── Server ────────────────────────────────────────────────
    host: str = "0.0.0.0"
    port: int = 8000
    debug: bool = False

    # ── Constants (non-configurable game rules) ───────────────
    @property
    def max_score_per_round(self) -> int:
        return 1000

    @property
    def round_duration_ms(self) -> int:
        return 15000

    @property
    def short_match_threshold(self) -> int:
        return 5


# Singleton instance — import this everywhere
settings = Settings()  # type: ignore[call-arg]
