"""
WhoSharedThisReel — Media Metadata Parser

Extracts public metadata from Instagram Reel URLs and TikTok video URLs.
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

TIKTOK_URL_PATTERN = re.compile(
    r"^https://(?:[a-zA-Z0-9-]+\.)?tiktok\.com/([A-Za-z0-9_./@-]+)$", re.IGNORECASE
)

YOUTUBE_URL_PATTERN = re.compile(
    r"^https://(?:[a-zA-Z0-9-]+\.)?youtube\.com/shorts/([A-Za-z0-9_-]+)/?\??.*$", re.IGNORECASE
)

YOUTUBE_BE_PATTERN = re.compile(
    r"^https://youtu\.be/([A-Za-z0-9_-]+)/?\??.*$", re.IGNORECASE
)

# Custom User-Agent for requests
DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

IG_OEMBED_ENDPOINT = "https://graph.facebook.com/v21.0/instagram_oembed"
REQUEST_TIMEOUT = 10.0  # seconds


@dataclass
class ReelMetadata:
    """Structured metadata extracted from a Reel or TikTok URL."""

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

    # Provider (e.g. "Instagram" or "TikTok")
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
    if not parsed.hostname or parsed.hostname not in ("www.instagram.com", "instagram.com"):
        return False, url, None

    match = INSTAGRAM_REEL_PATTERN.match(url)
    if not match:
        return False, url, None

    shortcode = match.group(3)

    # Normalize to canonical form: https://www.instagram.com/reel/{shortcode}/
    normalized = f"https://www.instagram.com/reel/{shortcode}/"
    return True, normalized, shortcode


def validate_tiktok_url(url: str) -> tuple[bool, str, Optional[str]]:
    url = url.strip()
    parsed = urlparse(url)
    if parsed.scheme != "https":
        return False, url, None
    if not parsed.hostname or "tiktok.com" not in parsed.hostname.lower():
        return False, url, None

    match = TIKTOK_URL_PATTERN.match(url)
    if not match:
        return False, url, None

    path = match.group(1)
    parts = path.strip("/").split("/")
    shortcode = parts[-1] if parts else "tiktok_video"

    normalized = f"https://{parsed.hostname}/{path.strip('/')}/"
    return True, normalized, shortcode


def validate_youtube_url(url: str) -> tuple[bool, str, Optional[str]]:
    url = url.strip()
    parsed = urlparse(url)
    if parsed.scheme != "https":
        return False, url, None
    if not parsed.hostname or not any(x in parsed.hostname.lower() for x in ("youtube.com", "youtu.be")):
        return False, url, None

    shortcode = None
    match = YOUTUBE_URL_PATTERN.match(url)
    if match:
        shortcode = match.group(1)
    else:
        match_be = YOUTUBE_BE_PATTERN.match(url)
        if match_be:
            shortcode = match_be.group(1)

    if not shortcode:
        return False, url, None

    normalized = f"https://www.youtube.com/shorts/{shortcode}"
    return True, normalized, shortcode


def validate_media_url(url: str) -> tuple[bool, str, Optional[str], str]:
    """
    Validate url against supported platforms.

    Returns:
        (is_valid, normalized_url, shortcode, provider)
    """
    is_ig, normalized_ig, shortcode_ig = validate_instagram_url(url)
    if is_ig:
        return True, normalized_ig, shortcode_ig, "Instagram"

    is_tt, normalized_tt, shortcode_tt = validate_tiktok_url(url)
    if is_tt:
        return True, normalized_tt, shortcode_tt, "TikTok"

    is_yt, normalized_yt, shortcode_yt = validate_youtube_url(url)
    if is_yt:
        return True, normalized_yt, shortcode_yt, "YouTube"

    return False, url, None, "Unknown"


async def fetch_og_metadata(url: str, client: httpx.AsyncClient) -> ReelMetadata:
    """
    Fetch Open Graph metadata from an Instagram Reel's public page.
    """
    is_valid, normalized_url, shortcode = validate_instagram_url(url)
    if not is_valid or shortcode is None:
        meta = ReelMetadata(source_url=url, shortcode="")
        meta.errors.append(f"Invalid Instagram URL: {url}")
        return meta

    metadata = ReelMetadata(source_url=normalized_url, shortcode=shortcode, provider="Instagram")

    try:
        response = await client.get(
            normalized_url,
            headers=DEFAULT_HEADERS,
            follow_redirects=True,
            timeout=REQUEST_TIMEOUT,
        )

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

        # Extract og:image
        og_image = soup.find("meta", property="og:image")
        if og_image and og_image.get("content"):
            metadata.thumbnail_url = og_image["content"]
            metadata.thumbnail_fetched_at = datetime.now(timezone.utc)

        # Extract og:title
        og_title = soup.find("meta", property="og:title")
        if og_title and og_title.get("content"):
            title_text = og_title["content"]
            creator_match = re.match(
                r"@?([A-Za-z0-9_.]+)\s+on\s+Instagram", title_text
            )
            if creator_match:
                metadata.creator_handle = creator_match.group(1)
                metadata.creator_url = f"https://www.instagram.com/{metadata.creator_handle}/"

            caption_match = re.search(r"on Instagram:\s*[\"'\u201c](.+)", title_text)
            if caption_match:
                metadata.caption = caption_match.group(1).rstrip("\"'\u201d")

        # Fallback caption
        if not metadata.caption:
            og_desc = soup.find("meta", property="og:description")
            if og_desc and og_desc.get("content"):
                desc = og_desc["content"]
                if " - " in desc:
                    metadata.caption = desc.split(" - ", 1)[1].strip()
                else:
                    metadata.caption = desc.strip()

        # Fallback creator handle
        if not metadata.creator_handle:
            title_tag = soup.find("title")
            if title_tag and title_tag.string:
                title_match = re.match(
                    r"@?([A-Za-z0-9_.]+)\s+on\s+Instagram",
                    title_tag.string,
                )
                if title_match:
                    metadata.creator_handle = title_match.group(1)
                    metadata.creator_url = f"https://www.instagram.com/{metadata.creator_handle}/"

        # Fallback creator url
        if not metadata.creator_url:
            canonical = soup.find("link", rel="canonical")
            if canonical and canonical.get("href"):
                metadata.creator_url = canonical["href"]

        if not metadata.has_valid_attribution:
            metadata.creator_url = normalized_url
            metadata.errors.append(
                "Could not extract creator handle from page metadata. "
                "Using source_url as attribution fallback."
            )

    except httpx.TimeoutException:
        metadata.errors.append(f"Request to Instagram timed out after {REQUEST_TIMEOUT}s.")
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


async def fetch_tiktok_metadata(url: str, client: httpx.AsyncClient) -> ReelMetadata:
    """
    Fetch metadata for a TikTok video using TikTok's public oEmbed endpoint.
    """
    is_valid, normalized_url, shortcode = validate_tiktok_url(url)
    if not is_valid or shortcode is None:
        meta = ReelMetadata(source_url=url, shortcode="", provider="TikTok")
        meta.errors.append(f"Invalid TikTok URL: {url}")
        return meta

    metadata = ReelMetadata(source_url=normalized_url, shortcode=shortcode, provider="TikTok")

    try:
        response = await client.get(
            "https://www.tiktok.com/oembed",
            params={"url": normalized_url},
            headers=DEFAULT_HEADERS,
            timeout=REQUEST_TIMEOUT,
        )

        if response.status_code != 200:
            metadata.errors.append(
                f"TikTok oEmbed returned HTTP {response.status_code}. "
                "The video may be private or unavailable."
            )
            metadata.creator_url = normalized_url
            return metadata

        data = response.json()

        # Extract attributes
        metadata.creator_handle = data.get("author_unique_id") or data.get("author_name")
        if data.get("author_url"):
            metadata.creator_url = data["author_url"]
        elif metadata.creator_handle:
            metadata.creator_url = f"https://www.tiktok.com/@{metadata.creator_handle}"

        metadata.thumbnail_url = data.get("thumbnail_url")
        if metadata.thumbnail_url:
            metadata.thumbnail_fetched_at = datetime.now(timezone.utc)

        metadata.caption = data.get("title")
        oembed_html = data.get("html")
        metadata.oembed_html = oembed_html

        # Extract canonical source URL from oEmbed HTML blockquote cite attribute
        if oembed_html:
            cite_match = re.search(r'cite="([^"]+)"', oembed_html)
            if cite_match:
                canonical_url = cite_match.group(1)
                metadata.source_url = canonical_url
                # Extract the video ID as the shortcode
                video_match = re.search(r'/video/(\d+)', canonical_url)
                if video_match:
                    metadata.shortcode = video_match.group(1)

        if not metadata.has_valid_attribution:
            metadata.creator_url = metadata.source_url
            metadata.errors.append(
                "Could not extract creator handle from TikTok oEmbed. "
                "Using source_url as attribution fallback."
            )

    except httpx.TimeoutException:
        metadata.errors.append(f"Request to TikTok oEmbed timed out after {REQUEST_TIMEOUT}s.")
        metadata.creator_url = metadata.source_url
    except Exception as e:
        logger.exception("Unexpected error parsing TikTok metadata")
        metadata.errors.append(f"Unexpected TikTok parsing error: {str(e)}")
        metadata.creator_url = metadata.source_url

    return metadata


async def fetch_youtube_metadata(url: str, client: httpx.AsyncClient) -> ReelMetadata:
    """
    Fetch metadata for a YouTube video using YouTube's public oEmbed endpoint.
    """
    is_valid, normalized_url, shortcode = validate_youtube_url(url)
    if not is_valid or shortcode is None:
        meta = ReelMetadata(source_url=url, shortcode="", provider="YouTube")
        meta.errors.append(f"Invalid YouTube URL: {url}")
        return meta

    metadata = ReelMetadata(source_url=normalized_url, shortcode=shortcode, provider="YouTube")

    try:
        response = await client.get(
            "https://www.youtube.com/oembed",
            params={"url": normalized_url, "format": "json"},
            headers=DEFAULT_HEADERS,
            timeout=REQUEST_TIMEOUT,
        )

        if response.status_code != 200:
            metadata.errors.append(
                f"YouTube oEmbed returned HTTP {response.status_code}. "
                "The video may be private or unavailable."
            )
            metadata.creator_url = normalized_url
            return metadata

        data = response.json()

        metadata.creator_handle = data.get("author_name")
        metadata.creator_url = data.get("author_url") or normalized_url
        metadata.thumbnail_url = data.get("thumbnail_url")
        if metadata.thumbnail_url:
            metadata.thumbnail_fetched_at = datetime.now(timezone.utc)

        metadata.caption = data.get("title")
        metadata.oembed_html = data.get("html")

        if not metadata.has_valid_attribution:
            metadata.creator_url = normalized_url

    except httpx.TimeoutException:
        metadata.errors.append(f"Request to YouTube oEmbed timed out after {REQUEST_TIMEOUT}s.")
        metadata.creator_url = normalized_url
    except Exception as e:
        logger.exception("Unexpected error parsing YouTube metadata")
        metadata.errors.append(f"Unexpected YouTube parsing error: {str(e)}")
        metadata.creator_url = normalized_url

    return metadata


async def fetch_media_metadata(
    url: str, client: httpx.AsyncClient
) -> ReelMetadata:
    """
    Unified entry point for fetching metadata.
    """
    is_valid, normalized_url, shortcode, provider = validate_media_url(url)
    if not is_valid:
        meta = ReelMetadata(source_url=url, shortcode="", provider=provider)
        meta.errors.append(f"Unsupported or invalid URL: {url}")
        return meta

    if provider == "TikTok":
        return await fetch_tiktok_metadata(normalized_url, client)
    elif provider == "YouTube":
        return await fetch_youtube_metadata(normalized_url, client)
    else:
        return await fetch_og_metadata(normalized_url, client)


async def fetch_oembed(
    url: str, access_token: str, client: httpx.AsyncClient
) -> Optional[str]:
    """
    Fetch oEmbed embed HTML from Meta's official endpoint for Instagram.
    """
    if not access_token:
        return None

    try:
        response = await client.get(
            IG_OEMBED_ENDPOINT,
            params={"url": url, "access_token": access_token, "omitscript": "true"},
            timeout=REQUEST_TIMEOUT,
        )

        if response.status_code != 200:
            logger.warning(
                "Instagram oEmbed API returned %d for %s", response.status_code, url
            )
            return None

        data = response.json()
        return data.get("html")

    except Exception as e:
        logger.warning("Instagram oEmbed fetch failed for %s: %s", url, str(e))
        return None


async def refresh_thumbnail(
    source_url: str, client: httpx.AsyncClient
) -> tuple[Optional[str], Optional[datetime]]:
    """
    Re-fetch a Reel's or TikTok's thumbnail URL (R5 freshness enforcement).
    """
    if "tiktok.com" in source_url.lower():
        try:
            response = await client.get(
                "https://www.tiktok.com/oembed",
                params={"url": source_url},
                headers=DEFAULT_HEADERS,
                timeout=REQUEST_TIMEOUT,
            )
            if response.status_code == 200:
                data = response.json()
                thumb = data.get("thumbnail_url")
                if thumb:
                    return thumb, datetime.now(timezone.utc)
        except Exception as e:
            logger.warning("TikTok thumbnail refresh failed for %s: %s", source_url, str(e))
        return None, None
    elif "youtube.com" in source_url.lower():
        try:
            response = await client.get(
                "https://www.youtube.com/oembed",
                params={"url": source_url, "format": "json"},
                headers=DEFAULT_HEADERS,
                timeout=REQUEST_TIMEOUT,
            )
            if response.status_code == 200:
                data = response.json()
                thumb = data.get("thumbnail_url")
                if thumb:
                    return thumb, datetime.now(timezone.utc)
        except Exception as e:
            logger.warning("YouTube thumbnail refresh failed for %s: %s", source_url, str(e))
        return None, None
    else:
        try:
            response = await client.get(
                source_url,
                headers=DEFAULT_HEADERS,
                follow_redirects=True,
                timeout=REQUEST_TIMEOUT,
            )

            if response.status_code != 200:
                logger.warning(
                    "Instagram Thumbnail refresh failed: HTTP %d for %s",
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
            logger.warning("Instagram Thumbnail refresh error for %s: %s", source_url, str(e))
            return None, None
