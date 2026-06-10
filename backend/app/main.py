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
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
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

# ── Serve Web Client ──────────────────────────────────────────────
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
async def serve_home():
    return FileResponse(os.path.join("static", "index.html"))


# ── Static Info Pages (App Store Requirements) ───────────────────
HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{title} - WhoSharedThisVideo?</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap" rel="stylesheet">
    <style>
        body {{
            font-family: 'Outfit', sans-serif;
            background-color: #0A0A0F;
            color: #E2E2E9;
            line-height: 1.6;
            margin: 0;
            padding: 40px 20px;
            display: flex;
            justify-content: center;
        }}
        .container {{
            max-width: 700px;
            width: 100%;
            background-color: #16161F;
            border: 1px solid #2A2A3A;
            border-radius: 24px;
            padding: 40px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
        }}
        h1 {{
            font-weight: 800;
            color: #FFFFFF;
            font-size: 32px;
            margin-top: 0;
            margin-bottom: 8px;
        }}
        .subtitle {{
            color: #888899;
            font-size: 14px;
            text-transform: uppercase;
            letter-spacing: 2px;
            margin-bottom: 30px;
        }}
        h2 {{
            color: #FFFFFF;
            font-size: 20px;
            font-weight: 600;
            margin-top: 30px;
            margin-bottom: 12px;
            border-bottom: 1px solid #2A2A3A;
            padding-bottom: 8px;
        }}
        p, li {{
            color: #B3B3C2;
            font-size: 16px;
        }}
        ul {{
            padding-left: 20px;
        }}
        li {{
            margin-bottom: 10px;
        }}
        .footer {{
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid #2A2A3A;
            font-size: 13px;
            color: #666677;
            text-align: center;
        }}
    </style>
</head>
<body>
    <div class="container">
        <h1>{title}</h1>
        <div class="subtitle">WhoSharedThisVideo? Party Game</div>
        {content}
        <div class="footer">
            &copy; {year} WhoSharedThisVideo? All rights reserved.
        </div>
    </div>
</body>
</html>
"""

PRIVACY_CONTENT = """
<p>Your privacy is important to us. This privacy statement explains the personal data we process, how we process it, and for what purposes.</p>

<h2>1. Information We Collect</h2>
<p>WhoSharedThisVideo? is designed to be played with minimal friction. We do not require account registration or email signups.</p>
<ul>
    <li><strong>Player Nicknames:</strong> To join or create a game room, you provide a temporary nickname. This is only stored for the duration of the game session.</li>
    <li><strong>Shared Video Links:</strong> To play, you submit links to public Instagram Reels or TikTok videos. These links are stored in the active game room so players can guess who shared them.</li>
</ul>

<h2>2. No Analytics and No Tracking</h2>
<p>We do not use any third-party tracking services, advertising SDKs, cookies, or analytics tools in the mobile application. We do not track your location or device identifiers.</p>

<h2>3. Data Storage and Retention</h2>
<p>Your game sessions are processed using Supabase. All game rooms, player nicknames, and shared links are temporary. They are automatically deleted from our database after the game room becomes inactive.</p>

<h2>4. Sharing of Information</h2>
<p>We do not sell, trade, or share your data with any third parties. Shared links are only visible to other players in the same game room during the active match.</p>

<h2>5. Children's Privacy</h2>
<p>Our service does not collect any personally identifiable information. We comply with COPPA and global child safety standards. If you are under 13, you do not need to register to play this game.</p>

<h2>6. Contact Us</h2>
<p>If you have any questions about this Privacy Policy, please contact us at <strong>support@whosharedthisvideo.app</strong>.</p>
"""

TERMS_CONTENT = """
<p>By using the WhoSharedThisVideo? mobile application, you agree to comply with and be bound by the following terms of use.</p>

<h2>1. User License</h2>
<p>We grant you a personal, non-exclusive, non-transferable, revocable license to use the app for personal, non-commercial entertainment purposes.</p>

<h2>2. Acceptable Content</h2>
<p>When sharing Instagram Reels or TikTok video links, you agree not to submit links containing content that is illegal, defamatory, hateful, or sexually explicit. You represent that you are submitting publicly available URLs.</p>

<h2>3. Disclaimer of Warranties</h2>
<p>The application is provided "as is" and "as available". We make no warranties, expressed or implied, regarding the reliability, uptime, or availability of the backend services.</p>

<h2>4. Age Requirement</h2>
<p>By using this service, you represent that you are at least 13 years of age, or have the consent of a parent or legal guardian.</p>

<h2>5. Modifications to Service</h2>
<p>We reserve the right to modify or discontinue, temporarily or permanently, the application or any backend services with or without notice.</p>
"""

@app.get("/privacy", response_class=HTMLResponse)
async def privacy_policy():
    from datetime import datetime
    return HTML_TEMPLATE.format(
        title="Privacy Policy",
        content=PRIVACY_CONTENT,
        year=datetime.now().year
    )

@app.get("/terms", response_class=HTMLResponse)
async def terms_of_service():
    from datetime import datetime
    return HTML_TEMPLATE.format(
        title="Terms of Service",
        content=TERMS_CONTENT,
        year=datetime.now().year
    )


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
