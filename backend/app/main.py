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
