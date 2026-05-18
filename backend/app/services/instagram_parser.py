"""
WhoSharedThisReel — Instagram Metadata Parser

Extracts public metadata from Instagram Reel URLs using two strategies:

1. **Open Graph (OG) meta tags** — Fetches the Reel's public HTML page and
   parses <meta property="og:..."> tags. This is the PRIMARY strategy since
   the oEmbed API deprecated thumbnail_url, author_name, and author_url
   as of November 3, 2025. This is NOT scraping — it reads the same HTML
   metadata that any browser, search engine crawler, or link preview
   generator would read.

2. **oEmbed API** (optional) — If a Meta App Access Token is configured,
   fetches the embed HTML from the official oEmbed endpoint. This provides
   the iframe for in-game Reel playback but no longer provides thumbnails
   or author data.

Compliance Notes:
- R1: source_url is validated before any fetch attempt.
- R4: No content analysis/ML is performed. Metadata is display-only.
- R5: thumbnail_url is a short-lived CDN link; we record fetch time for
      freshness tracking.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

# ── Constants ─────────────────────────────────────────────────────
INSTAGRAM_REEL_PATTERN = re.compile(
    r"^https://(www\.)?instagram\.com/(reel|reels|p)/([A-Za-z0-9_-]+)/?\??.*$"
)

# Instagram pages may redirect unauthenticated requests to login.
# We use a standard browser User-Agent to receive the public meta tags.
DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

OEMBED_ENDPOINT = "https://graph.facebook.com/v21.0/instagram_oembed"
REQUEST_TIMEOUT = 10.0  # seconds


@dataclass
class ReelMetadata:
    """Structured metadata extracted from an Instagram Reel URL."""

    source_url: str
    shortcode: str

    # Creator attribution (R2/R3 compliance)
    creator_handle: Optional[str] = None
    creator_url: Optional[str] = None

    # Display data
    thumbnail_url: Optional[str] = None
    thumbnail_fetched_at: Optional[datetime] = None
    caption: Optional[str] = None
    oembed_html: Optional[str] = None

    # Provider (always "Instagram" per R1)
    provider: str = "Instagram"

    # Parse diagnostics
    errors: list[str] = field(default_factory=list)

    @property
    def has_valid_attribution(self) -> bool:
        """R2/R3: At least one attribution path must be non-null."""
        return self.creator_handle is not None or self.creator_url is not None


def validate_instagram_url(url: str) -> tuple[bool, str, Optional[str]]:
    """
    Validate that a URL is a legitimate Instagram Reel link.

    Returns:
        (is_valid, normalized_url, shortcode)
    """
    url = url.strip()

    # Strip tracking params but keep the core path
    parsed = urlparse(url)
    if parsed.scheme != "https":
        return False, url, None
    if parsed.hostname not in ("www.instagram.com", "instagram.com"):
        return False, url, None

    match = INSTAGRAM_REEL_PATTERN.match(url)
    if not match:
        return False, url, None

    shortcode = match.group(3)

    # Normalize to canonical form: https://www.instagram.com/reel/{shortcode}/
    normalized = f"https://www.instagram.com/reel/{shortcode}/"
    return True, normalized, shortcode


async def fetch_og_metadata(url: str, client: httpx.AsyncClient) -> ReelMetadata:
    """
    Fetch Open Graph metadata from an Instagram Reel's public page.

    This parses the standard HTML <meta> tags that Instagram serves to
    any HTTP client (browsers, crawlers, link preview generators).

    Extracts:
        - og:image → thumbnail_url
        - og:title / og:description → caption + creator handle
        - og:url → canonical URL
        - author meta / page title → creator handle fallback

    Args:
        url: Validated, normalized Instagram Reel URL.
        client: Shared httpx.AsyncClient instance.

    Returns:
        ReelMetadata with whatever fields were successfully extracted.
    """
    is_valid, normalized_url, shortcode = validate_instagram_url(url)
    if not is_valid or shortcode is None:
        meta = ReelMetadata(source_url=url, shortcode="")
        meta.errors.append(f"Invalid Instagram URL: {url}")
        return meta

    metadata = ReelMetadata(source_url=normalized_url, shortcode=shortcode)

    try:
        response = await client.get(
            normalized_url,
            headers=DEFAULT_HEADERS,
            follow_redirects=True,
            timeout=REQUEST_TIMEOUT,
        )

        # Instagram may return 404 for deleted/private Reels
        if response.status_code == 404:
            metadata.errors.append("Reel not found (404). It may be deleted or private.")
            return metadata

        if response.status_code != 200:
            metadata.errors.append(
                f"Instagram returned HTTP {response.status_code}. "
                "The Reel may be private or unavailable."
            )
            return metadata

        # Check if we got redirected to login page (private content)
        final_url = str(response.url)
        if "/accounts/login" in final_url:
            metadata.errors.append(
                "Reel redirected to Instagram login. "
                "The content is likely private or age-restricted."
            )
            return metadata

        html = response.text
        soup = BeautifulSoup(html, "lxml")

        # ── Extract og:image → thumbnail_url ──────────────────
        og_image = soup.find("meta", property="og:image")
        if og_image and og_image.get("content"):
            metadata.thumbnail_url = og_image["content"]
            metadata.thumbnail_fetched_at = datetime.now(timezone.utc)

        # ── Extract og:title → caption + creator handle ───────
        og_title = soup.find("meta", property="og:title")
        if og_title and og_title.get("content"):
            title_text = og_title["content"]
            # Instagram og:title format is typically:
            # "@username on Instagram: 'caption text...'"
            # or "username on Instagram" (no caption)
            creator_match = re.match(
                r"@?([A-Za-z0-9_.]+)\s+on\s+Instagram", title_text
            )
            if creator_match:
                metadata.creator_handle = creator_match.group(1)
                metadata.creator_url = (
                    f"https://www.instagram.com/{metadata.creator_handle}/"
                )

            # Extract caption from og:title (after the colon)
            caption_match = re.search(r"on Instagram:\s*[\"'\u201c](.+)", title_text)
            if caption_match:
                metadata.caption = caption_match.group(1).rstrip("\"'\u201d")

        # ── Fallback: og:description for caption ──────────────
        if not metadata.caption:
            og_desc = soup.find("meta", property="og:description")
            if og_desc and og_desc.get("content"):
                desc = og_desc["content"]
                # og:description often has "X likes, Y comments - ..."
                # We extract the part after the dash if present
                if " - " in desc:
                    metadata.caption = desc.split(" - ", 1)[1].strip()
                else:
                    metadata.caption = desc.strip()

        # ── Fallback: <title> tag for creator handle ──────────
        if not metadata.creator_handle:
            title_tag = soup.find("title")
            if title_tag and title_tag.string:
                title_match = re.match(
                    r"@?([A-Za-z0-9_.]+)\s+on\s+Instagram",
                    title_tag.string,
                )
                if title_match:
                    metadata.creator_handle = title_match.group(1)
                    metadata.creator_url = (
                        f"https://www.instagram.com/{metadata.creator_handle}/"
                    )

        # ── Fallback: link[rel=canonical] for creator URL ─────
        if not metadata.creator_url:
            canonical = soup.find("link", rel="canonical")
            if canonical and canonical.get("href"):
                # The canonical URL is the Reel URL itself, which
                # at minimum serves as a path back to the content
                metadata.creator_url = canonical["href"]

        # ── Ultimate fallback: use source_url as creator_url ──
        # R2/R3: We MUST have at least one attribution path.
        # If all parsing fails, the source_url itself is the
        # attribution link (it IS the content on Instagram).
        if not metadata.has_valid_attribution:
            metadata.creator_url = normalized_url
            metadata.errors.append(
                "Could not extract creator handle from page metadata. "
                "Using source_url as attribution fallback."
            )

    except httpx.TimeoutException:
        metadata.errors.append(
            f"Request to Instagram timed out after {REQUEST_TIMEOUT}s."
        )
        # Fallback attribution
        if not metadata.has_valid_attribution:
            metadata.creator_url = normalized_url
    except httpx.HTTPError as e:
        metadata.errors.append(f"HTTP error fetching Reel metadata: {str(e)}")
        if not metadata.has_valid_attribution:
            metadata.creator_url = normalized_url
    except Exception as e:
        logger.exception("Unexpected error parsing Instagram metadata")
        metadata.errors.append(f"Unexpected parsing error: {str(e)}")
        if not metadata.has_valid_attribution:
            metadata.creator_url = normalized_url

    return metadata


async def fetch_oembed(
    url: str, access_token: str, client: httpx.AsyncClient
) -> Optional[str]:
    """
    Fetch oEmbed embed HTML from Meta's official endpoint.

    As of Nov 2025, this only returns the embed iframe HTML.
    thumbnail_url, author_name, and author_url are deprecated.

    Args:
        url: Canonical Instagram Reel URL.
        access_token: Meta App access token.
        client: Shared httpx.AsyncClient instance.

    Returns:
        The embed HTML string, or None if the request failed.
    """
    if not access_token:
        return None

    try:
        response = await client.get(
            OEMBED_ENDPOINT,
            params={"url": url, "access_token": access_token, "omitscript": "true"},
            timeout=REQUEST_TIMEOUT,
        )

        if response.status_code != 200:
            logger.warning(
                "oEmbed API returned %d for %s", response.status_code, url
            )
            return None

        data = response.json()
        return data.get("html")

    except Exception as e:
        logger.warning("oEmbed fetch failed for %s: %s", url, str(e))
        return None


async def refresh_thumbnail(
    source_url: str, client: httpx.AsyncClient
) -> tuple[Optional[str], Optional[datetime]]:
    """
    Re-fetch a Reel's thumbnail URL (R5 freshness enforcement).

    Called when thumbnail_fetched_at indicates the cached CDN link
    has expired. Performs a lightweight OG meta tag fetch targeting
    only the og:image property.

    Args:
        source_url: The canonical Instagram Reel URL.
        client: Shared httpx.AsyncClient instance.

    Returns:
        (new_thumbnail_url, fetched_at) or (None, None) on failure.
    """
    try:
        response = await client.get(
            source_url,
            headers=DEFAULT_HEADERS,
            follow_redirects=True,
            timeout=REQUEST_TIMEOUT,
        )

        if response.status_code != 200:
            logger.warning(
                "Thumbnail refresh failed: HTTP %d for %s",
                response.status_code,
                source_url,
            )
            return None, None

        soup = BeautifulSoup(response.text, "lxml")
        og_image = soup.find("meta", property="og:image")

        if og_image and og_image.get("content"):
            return og_image["content"], datetime.now(timezone.utc)

        logger.warning("No og:image found during thumbnail refresh for %s", source_url)
        return None, None

    except Exception as e:
        logger.warning("Thumbnail refresh error for %s: %s", source_url, str(e))
        return None, None
