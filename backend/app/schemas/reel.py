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

import base64

# ── URL Validation & Compatibility Helpers ──────────────────────────
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


def encode_compatible_url(url: str, provider: str) -> str:
    """Wrap non-Instagram URLs to bypass DB check constraints."""
    if provider not in ("TikTok", "YouTube", "PushToken"):
        return url
    encoded = base64.urlsafe_b64encode(url.encode('utf-8')).decode('utf-8').rstrip('=')
    prefix = {
        "TikTok": "tt",
        "YouTube": "yt",
        "PushToken": "pt"
    }.get(provider, "tt")
    return f"https://www.instagram.com/reel/{prefix}_{encoded}/"


def decode_compatible_url(url: str) -> str:
    """Decode a compatibility-wrapped URL back to its raw form."""
    if not url:
        return url
    match = re.match(r"^https://(?:www\.)?instagram\.com/(?:reel|reels|p)/(tt|yt|pt)_([A-Za-z0-9_-]+)/?$", url)
    if not match:
        return url
    prefix, encoded = match.groups()
    try:
        padding = len(encoded) % 4
        if padding:
            encoded += "=" * (4 - padding)
        decoded_bytes = base64.urlsafe_b64decode(encoded)
        return decoded_bytes.decode('utf-8')
    except Exception:
        return url


# ── Request Schemas ───────────────────────────────────────────────

class IngestReelRequest(BaseModel):
    """Payload for submitting a new Reel URL for ingestion."""

    source_url: str = Field(
        ...,
        min_length=20,
        max_length=2048,
        description="Public Instagram Reel, TikTok, or YouTube Short URL",
        examples=["https://www.instagram.com/reel/ABC123def/"],
    )
    user_tags: List[str] = Field(
        default_factory=list,
        max_length=20,
        description="User-assigned tags (source of truth for categorization)",
    )

    @field_validator("source_url")
    @classmethod
    def validate_source_url(cls, v: str) -> str:
        """Accept Instagram Reels, TikTok videos, or YouTube Shorts."""
        from app.services.media_parser import validate_media_url
        v = v.strip()
        is_valid, normalized_url, shortcode, provider = validate_media_url(v)
        if not is_valid:
            raise ValueError(
                "URL must be a valid Instagram Reel, TikTok, or YouTube Short link"
            )
        return normalized_url

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
