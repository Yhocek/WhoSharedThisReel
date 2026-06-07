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
from app.services.media_parser import (
    validate_media_url,
    fetch_media_metadata,
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
    is_valid, normalized_url, shortcode, provider = validate_media_url(request.source_url)
    if not is_valid or shortcode is None:
        raise ValueError(
            "Invalid video URL. Expected a public Instagram Reel or TikTok URL."
        )

    # ── Step 2: Fetch metadata (moved up to resolve canonical URLs) ──
    async with httpx.AsyncClient() as client:
        metadata = await fetch_media_metadata(normalized_url, client)

        # Log any non-fatal parse warnings
        for error in metadata.errors:
            logger.warning("Media parse warning for %s: %s", normalized_url, error)

        # ── Step 3: Fetch oEmbed HTML (optional, Instagram only) ──
        oembed_html = None
        if provider == "Instagram" and settings.meta_app_access_token:
            oembed_html = await fetch_oembed(
                normalized_url, settings.meta_app_access_token, client
            )
            if oembed_html:
                metadata.oembed_html = oembed_html

    # Use resolved canonical source URL for deduplication and persistence
    resolved_source_url = metadata.source_url or normalized_url

    # ── Step 4: Deduplication check ───────────────────────────
    # Registered users: dedup by (source_url, ingested_by)
    # Anonymous users: dedup by (source_url, ingested_by_player_id)
    query = (
        supabase.table("reels")
        .select("*")
        .eq("source_url", resolved_source_url)
    )
    if user_id:
        query = query.eq("ingested_by", str(user_id))
    elif player_id:
        query = query.eq("ingested_by_player_id", player_id)
    else:
        query = query.is_("ingested_by", "null").is_("ingested_by_player_id", "null")

    existing = query.maybe_single().execute()

    if existing and existing.data:
        logger.info(
            "Duplicate Reel detected: %s for user %s", resolved_source_url, user_id
        )
        return ReelIngestionResult(
            reel=_row_to_reel_response(existing.data),
            is_new=False,
            metadata_source="cached",
        )

    # ── Step 5: Enforce attribution compliance ────────────────
    # R2/R3: The CHECK constraint in Postgres will reject inserts
    # where BOTH creator_handle AND creator_url are NULL. The parser
    # already applies fallback logic, but we double-check here.
    if not metadata.has_valid_attribution:
        # Ultimate fallback: the source URL itself IS attribution
        metadata.creator_url = resolved_source_url
        logger.warning(
            "Attribution fallback triggered for %s — using source_url",
            resolved_source_url,
        )

    # ── Step 6: Persist to Supabase ───────────────────────────
    insert_payload = {
        "source_url": resolved_source_url,
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

    if not reel_result or not reel_result.data:
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
