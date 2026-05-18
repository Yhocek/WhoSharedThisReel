"""
WhoSharedThisReel — Health Check Router
"""

from fastapi import APIRouter

router = APIRouter(tags=["health"])


@router.get("/api/v1/health", summary="Health check")
async def health_check() -> dict:
    """Basic health check endpoint."""
    return {"status": "ok", "service": "whosharedthisreel"}
