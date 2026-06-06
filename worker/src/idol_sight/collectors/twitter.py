"""Twitter collector with nitter pool + syndication oembed fallback.

Order of attempts:
1. nitter_instances (round-robin). First one that returns >0 tweets wins.
2. syndication.twitter.com oembed (lightweight, public).
3. Give up: return CollectionResult with errors=['all_twitter_paths_blocked'].
   Orchestrator translates that into crawl_meta status='failed'.

We never raise from collect(). Twitter is best-effort by design.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from datetime import UTC, datetime
from time import perf_counter
from typing import Any

import httpx
from scrapling import Fetcher

from idol_sight.collectors.base import CollectionResult
from idol_sight.config import GroupConfig

log = logging.getLogger(__name__)

# A tweet permalink is .../status/<digits>; trailing fragments (#m), query
# params (?ref_src=…) and sub-paths (/photo/1) must be stripped or they corrupt
# the tweet_id PRIMARY KEY and break ON CONFLICT dedup (same tweet → new id
# every run, inflating row counts).
_STATUS_RE = re.compile(r"/status/(\d+)")


def _extract_tweet_id(href: str | None) -> str | None:
    """Return the numeric tweet id from a nitter/twitter href, or None."""
    m = _STATUS_RE.search(href or "")
    return m.group(1) if m else None

DEFAULT_NITTER_INSTANCES = [
    "https://nitter.net",
    "https://nitter.privacydev.net",
    "https://nitter.poast.org",
    "https://nitter.cz",
    "https://nitter.unixfox.eu",
]
OEMBED_URL = "https://publish.twitter.com/oembed"


class TwitterCollector:
    source = "twitter"

    def __init__(
        self,
        nitter_instances: list[str] | None = None,
        fetcher: Any | None = None,
        http_factory: Callable[[], Any] | None = None,
    ):
        self._instances = nitter_instances or DEFAULT_NITTER_INSTANCES
        self._fetcher = fetcher or Fetcher
        self._http_factory = http_factory or (lambda: httpx.Client(timeout=15.0))

    def collect(self, group: GroupConfig, since: str | None = None) -> CollectionResult:
        if not group.twitter_handles:
            return CollectionResult(0, 0)

        started = perf_counter()
        statements: list[tuple[str, list[Any]]] = []
        rows_inserted = 0
        now_iso = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")

        for handle in group.twitter_handles:
            tweets = self._try_nitter(handle)
            if not tweets:
                tweets = self._try_oembed(handle)
            for t in tweets:
                statements.append((
                    """
                    INSERT INTO twitter_posts
                      (tweet_id, group_key, author_handle, title, url,
                       posted_at, collected_at, type)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(tweet_id) DO UPDATE SET
                      title=excluded.title, type=excluded.type
                    """.strip(),
                    [
                        t["tweet_id"], group.key, handle,
                        (t.get("text") or "")[:500],
                        t["url"], t.get("posted_at"),
                        now_iso, t.get("type", "content"),
                    ],
                ))
                rows_inserted += 1

        errors: list[str] = []
        if rows_inserted == 0:
            errors.append("all_twitter_paths_blocked")

        runtime_ms = int((perf_counter() - started) * 1000)
        return CollectionResult(
            rows_inserted=rows_inserted, rows_updated=0,
            statements=statements, errors=errors, runtime_ms=runtime_ms,
        )

    def _try_nitter(self, handle: str) -> list[dict[str, Any]]:
        for base in self._instances:
            try:
                page = self._fetcher.get(
                    f"{base.rstrip('/')}/{handle}",
                    impersonate="chrome131", stealthy_headers=True,
                )
                tweets = self._parse_nitter(page, handle)
                if tweets:
                    return tweets
            except Exception as e:           # noqa: BLE001
                log.warning("nitter %s failed: %s", base, e)
        return []

    def _try_oembed(self, handle: str) -> list[dict[str, Any]]:
        # oembed needs a tweet URL — without that we can't enumerate. Best-
        # effort: hit the user's profile and parse for any tweet ids in the
        # public-facing redirect chain. Often returns nothing useful in 2026,
        # but we attempt before giving up.
        try:
            with self._http_factory() as client:
                # We don't know a specific tweet URL, but oembed accepts
                # profile URLs in some clients. Use it as a liveness check.
                r = client.get(
                    OEMBED_URL,
                    params={"url": f"https://twitter.com/{handle}"},
                )
                r.raise_for_status()
                _ = r.json()
                # If we got 200 + JSON the handle is public, but oembed of a
                # profile URL doesn't yield tweet rows. Return empty.
                return []
        except Exception as e:                # noqa: BLE001
            log.warning("oembed fallback failed: %s", e)
            return []

    @staticmethod
    def _parse_nitter(page: Any, handle: str) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for item in page.css(".timeline-item"):
            link = item.css(".tweet-link")
            content = item.css(".tweet-content")
            date_node = item.css(".tweet-date")
            if not link:
                continue
            href = link[0].attrib.get("href", "")
            tid = _extract_tweet_id(href)
            if not tid:
                continue
            text = (content[0].get_all_text() if content else "").strip()
            posted_raw = date_node[0].attrib.get("title") if date_node else None
            url = f"https://twitter.com/{handle}/status/{tid}"
            out.append({
                "tweet_id": tid,
                "url": url,
                "text": text,
                "posted_at": posted_raw,
                "type": _classify_tweet(text),
            })
        return out


def _classify_tweet(text: str) -> str:
    t = (text or "").lower()
    if any(kw in t for kw in ("논란", "controversy", "사과", "apologize")):
        return "controversy"
    if any(kw in t for kw in ("뉴스", "press", "신곡", "발매", "release")):
        return "news"
    if any(kw in t for kw in ("콘서트", "concert", "팬미팅", "fan meeting", "이벤트", "event")):
        return "event"
    return "content"
