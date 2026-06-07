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
