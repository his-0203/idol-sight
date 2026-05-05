"""TheQoo hot-list collector.

Scrapes ``theqoo.net/index.php?mid=hot`` (the site-wide hot board) and
filters by per-group context keywords. TheQoo sits behind Cloudflare's
browser challenge, so this collector is **Tier 2 from the start**: it
uses ``StealthyFetcher`` (a real headless browser) with
``solve_cloudflare=True``. There is no Tier-1 ``Fetcher`` fallback —
plain HTTP gets a CF interstitial more often than a useful page.

Each matched post emits two rows:

- ``community_posts`` — idempotent metadata keyed on ``url_hash``.
- ``community_post_stats`` — time-series snapshot keyed on
  ``(url_hash, snapshot_at)`` for engagement graphs.

Markup notes (verified against a 2026-05-04 capture):

- The hot list lives in ``table.bd_lst`` (or its ``sketchbook5_ajax``
  variant ``table.theqoo_board_table``).
- Each ``<tr>`` has ``td.title`` containing one or two anchors:
  the **first** ``<a>`` is the post link (``href="/hot/<srl>"``); a
  second ``a.replyNum`` carries the comment count.
- Notice rows carry ``class="notice ..."`` and must be skipped, as does
  the divider row ``tr.notice_expand``.
- ``td.m_no`` holds the view count (e.g. ``"12,630"``); ``td.time``
  holds either an ``HH:MM`` (today) or ``YY.MM.DD`` (older) timestamp.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from time import perf_counter
from typing import Any

from scrapling import StealthyFetcher

from idol_sight.collectors.base import CollectionResult
from idol_sight.config import GroupConfig
from idol_sight.utils.dates import parse_safe
from idol_sight.utils.url_hash import url_hash

log = logging.getLogger(__name__)

LIST_URL = "https://theqoo.net/index.php?mid=hot"


class TheQooCollector:
    source = "theqoo"

    def __init__(self, stealthy: Any | None = None):
        self._stealthy = stealthy or StealthyFetcher

    def collect(self, group: GroupConfig, since: str | None = None) -> CollectionResult:
        started = perf_counter()
        page = self._stealthy.fetch(
            LIST_URL,
            headless=True,
            network_idle=True,
            solve_cloudflare=True,
        )
        rows = self._parse(page)

        relevant = [
            r for r in rows
            if any(kw in r["title"] for kw in group.context_keywords)
        ]

        now_iso = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        statements: list[tuple[str, list[Any]]] = []

        for r in relevant:
            uh = url_hash(r["url"])
            posted = parse_safe(r.get("posted_at_raw", ""))
            posted_iso = posted.strftime("%Y-%m-%dT%H:%M:%SZ") if posted else None
            statements.append((
                """
                INSERT INTO community_posts
                  (url_hash, platform, group_key, title, url, posted_at, collected_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(url_hash) DO UPDATE SET
                  title=excluded.title
                """.strip(),
                [uh, "theqoo", group.key, r["title"][:500], r["url"], posted_iso, now_iso],
            ))
            statements.append((
                """
                INSERT INTO community_post_stats(url_hash, snapshot_at, views, likes, comments)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(url_hash, snapshot_at) DO UPDATE SET
                  views=excluded.views, likes=excluded.likes, comments=excluded.comments
                """.strip(),
                [uh, now_iso, r.get("views"), r.get("likes"), r.get("comments")],
            ))

        runtime_ms = int((perf_counter() - started) * 1000)
        return CollectionResult(
            rows_inserted=len(relevant), rows_updated=0,
            statements=statements, runtime_ms=runtime_ms,
        )

    @staticmethod
    def _parse(page: Any) -> list[dict[str, Any]]:
        """Extract title/url/views/comments from TheQoo hot-list rows.

        Robustness: try ``table.bd_lst tr`` first (current sketchbook5
        skin), then fall back to a bare ``table tr`` scan if TheQoo
        switches skins. Notice rows are filtered by class.
        """
        out: list[dict[str, Any]] = []

        rows = page.css("table.bd_lst tr")
        if not rows:
            rows = page.css("table.theqoo_board_table tr")
        if not rows:
            rows = page.css("table tr")

        for tr in rows:
            try:
                # Skip notice rows (class includes "notice" or "notice_expand").
                cls = (tr.attrib.get("class") or "")
                if "notice" in cls:
                    continue

                # Title cell — first non-replyNum anchor inside td.title.
                title_cells = tr.css("td.title")
                if not title_cells:
                    continue
                title_cell = title_cells[0]

                anchors = title_cell.css("a")
                if not anchors:
                    continue

                # Pick the first anchor that is NOT the comment-count badge.
                a = None
                for cand in anchors:
                    cand_cls = (cand.attrib.get("class") or "")
                    if "replyNum" in cand_cls:
                        continue
                    a = cand
                    break
                if a is None:
                    a = anchors[0]

                href = (a.attrib.get("href") or "").strip()
                if not href:
                    continue

                # The post anchor's visible text is just the title — using
                # the anchor's own text avoids picking up the comment badge.
                title = " ".join(a.get_all_text().split())
                if not title:
                    continue
                if href.startswith("/"):
                    href = f"https://theqoo.net{href}"

                # Comments — a.replyNum sibling inside td.title.
                comments: int | None = None
                reply_nodes = title_cell.css("a.replyNum")
                if reply_nodes:
                    raw = reply_nodes[0].get_all_text().strip().replace(",", "")
                    try:
                        comments = int(raw) if raw else None
                    except ValueError:
                        comments = None

                # Views — td.m_no (data row) or td.readNum (older skins).
                views: int | None = None
                view_nodes = tr.css("td.m_no") or tr.css("td.readNum")
                if view_nodes:
                    raw = view_nodes[0].get_all_text().strip().replace(",", "")
                    try:
                        views = int(raw) if raw else None
                    except ValueError:
                        views = None

                # Posted-at — td.time ("HH:MM" today, "YY.MM.DD" older).
                date_nodes = tr.css("td.time") or tr.css("td.date")
                posted = (
                    " ".join(date_nodes[0].get_all_text().split())
                    if date_nodes else ""
                )

                out.append({
                    "title": title,
                    "url": href,
                    "views": views,
                    "comments": comments,
                    "likes": None,
                    "posted_at_raw": posted,
                })
            except Exception as e:  # noqa: BLE001
                log.warning("theqoo row skipped: %s", e)
        return out
