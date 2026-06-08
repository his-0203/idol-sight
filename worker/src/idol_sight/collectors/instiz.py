"""Instiz hot-list collector.

Scrapes the instiz `/pt` (인기글 / hot) board, filters by per-group
context keywords (Korean name typically), and emits two rows per match:

- ``community_posts`` — idempotent metadata row keyed on ``url_hash``.
- ``community_post_stats`` — time-series snapshot keyed on
  ``(url_hash, snapshot_at)`` so we can graph engagement over time.

The hot list does not surface view counts in the static HTML (instiz
hydrates them via Ajax), so ``views`` is left ``None``; the comment count
is captured from the ``.cmt`` badge. ``posted_at`` is unavailable on the
realchart layout, so the field is left ``None`` and falls back to
``collected_at`` for ordering.

Tier 1 uses the regular ``Fetcher`` with chrome impersonation; if that
returns no rows (instiz occasionally serves an empty error page or a
Cloudflare challenge), we fall back to ``StealthyFetcher`` which spins up
a real browser.

V2.28 (2026-05-21): primary `/pt` 외에 ``group.instiz_supplemental_boards``
의 게시판들도 fetch. supplemental fetch 만 ``is_relevant(...,
strict_generic_blocklist=True)`` 를 적용 — primary 는 종전과 같이
strict=False. (검증 배경은 ``docs/superpowers/specs/2026-05-21-
community-search-collectors-design.md`` §0 참고.)
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from time import perf_counter
from typing import Any

from scrapling import Fetcher, StealthyFetcher

from idol_sight.analysis.relevance import is_relevant
from idol_sight.collectors.base import CollectionResult
from idol_sight.config import GroupConfig
from idol_sight.utils.dates import kst_to_utc, parse_safe
from idol_sight.utils.url_hash import url_hash

log = logging.getLogger(__name__)

LIST_URL_TPL = "https://www.instiz.net/{path}"
PRIMARY_PATH = "pt"


class InstizCollector:
    source = "instiz"

    def __init__(self, fetcher: Any | None = None, stealthy: Any | None = None):
        self._fetcher = fetcher or Fetcher
        self._stealthy = stealthy or StealthyFetcher

    def _fetch_board(self, path: str) -> Any:
        """Tier-1 Fetcher with chrome impersonation, fallback to
        StealthyFetcher if the first attempt yields no parseable rows
        (Cloudflare interstitial / empty error page)."""
        url = LIST_URL_TPL.format(path=path)
        page = self._fetcher.get(url, impersonate="chrome131", stealthy_headers=True)
        if not self._parse(page):
            log.info("instiz tier-1 returned 0 rows for %r; falling back to stealthy", path)
            page = self._stealthy.fetch(url, headless=True, network_idle=True)
        return page

    def collect(self, group: GroupConfig, since: str | None = None) -> CollectionResult:
        started = perf_counter()
        rows_all: list[dict[str, Any]] = []
        errors: list[str] = []

        # Primary `/pt` board — legacy filter.
        try:
            primary_rows = [
                r for r in self._parse(self._fetch_board(PRIMARY_PATH))
                if is_relevant(r["title"], group)
            ]
            rows_all.extend(primary_rows)
        except Exception as e:  # noqa: BLE001
            errors.append(f"{group.key}: instiz primary {PRIMARY_PATH!r}: {e}")

        # Supplemental boards — strict mode (cross-group hubs).
        for path in group.instiz_supplemental_boards or []:
            try:
                sup_rows = [
                    r for r in self._parse(self._fetch_board(path))
                    if is_relevant(
                        r["title"], group, strict_generic_blocklist=True,
                    )
                ]
                rows_all.extend(sup_rows)
            except Exception as e:  # noqa: BLE001
                errors.append(f"{group.key}: instiz supplemental {path!r}: {e}")

        # Dedupe by url_hash.
        seen: set[str] = set()
        relevant: list[tuple[str, dict[str, Any]]] = []
        for r in rows_all:
            uh = url_hash(r["url"])
            if uh in seen:
                continue
            seen.add(uh)
            relevant.append((uh, r))

        now_iso = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        statements: list[tuple[str, list[Any]]] = []

        for uh, r in relevant:
            posted = kst_to_utc(parse_safe(r.get("posted_at_raw", "")))
            posted_iso = posted.strftime("%Y-%m-%dT%H:%M:%SZ") if posted else None
            statements.append((
                """
                INSERT INTO community_posts
                  (url_hash, platform, group_key, title, url, posted_at, collected_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(url_hash) DO UPDATE SET
                  title=excluded.title
                """.strip(),
                [uh, "instiz", group.key, r["title"][:500], r["url"], posted_iso, now_iso],
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
            statements=statements, errors=errors, runtime_ms=runtime_ms,
        )

    @staticmethod
    def _parse(page: Any) -> list[dict[str, Any]]:
        """Extract title/url/comments from instiz hot-list rows.

        The realchart layout used by `/pt` wraps each entry in a
        ``.realchart_item`` div containing a single ``<a>`` whose children
        are ``.itsme.rank`` (rank #), ``.post_title`` (title text, may
        contain icon ``<i>`` children), and an optional ``.cmt`` badge.

        Falls back to the legacy ``td.subject a`` table layout that older
        instiz boards (e.g. ``/name``) still use, so the same collector can
        target either if the hot URL changes.
        """
        out: list[dict[str, Any]] = []

        # Modern realchart layout (current /pt hot list).
        items = page.css(".realchart_item")
        if items:
            for it in items:
                try:
                    anchors = it.css("a")
                    if not anchors:
                        continue
                    a = anchors[0]
                    href = (a.attrib.get("href") or "").strip()
                    if not href:
                        continue
                    if href.startswith("/"):
                        href = f"https://www.instiz.net{href}"

                    title_nodes = it.css(".post_title")
                    if title_nodes:
                        title = " ".join(title_nodes[0].get_all_text().split())
                    else:
                        title = " ".join(a.get_all_text().split())
                    if not title:
                        continue

                    comments = None
                    cmt_nodes = it.css(".cmt")
                    if cmt_nodes:
                        try:
                            comments = int(
                                cmt_nodes[0].get_all_text().strip().replace(",", "")
                            )
                        except ValueError:
                            comments = None

                    out.append({
                        "title": title,
                        "url": href,
                        "views": None,
                        "comments": comments,
                        "likes": None,
                        "posted_at_raw": "",
                    })
                except Exception as e:  # noqa: BLE001
                    log.warning("instiz realchart row skipped: %s", e)
            if out:
                return out

        # Legacy table fallback (instiz `/name` and similar boards).
        for tr in page.css("table tr"):
            try:
                link_nodes = (
                    tr.css("td.subject a")
                    or tr.css("a.subject")
                    or tr.css("td.listsubject a")
                )
                if not link_nodes:
                    continue
                a = link_nodes[0]
                title = " ".join(a.get_all_text().split())
                href = (a.attrib.get("href") or "").strip()
                if not (title and href):
                    continue
                if href.startswith("/"):
                    href = f"https://www.instiz.net{href}"

                views = None
                view_nodes = tr.css("td.cnt") or tr.css("td.hit")
                if view_nodes:
                    try:
                        views = int(
                            view_nodes[0].get_all_text().strip().replace(",", "")
                        )
                    except ValueError:
                        views = None

                date_nodes = tr.css("td.date") or tr.css("td.regdate") or tr.css("td.listno")
                posted = (
                    date_nodes[0].get_all_text().strip() if date_nodes else ""
                )

                out.append({
                    "title": title,
                    "url": href,
                    "views": views,
                    "comments": None,
                    "likes": None,
                    "posted_at_raw": posted,
                })
            except Exception as e:  # noqa: BLE001
                log.warning("instiz legacy row skipped: %s", e)
        return out
