"""TheQoo hot-list collector.

Scrapes ``theqoo.net/index.php?mid=hot`` (the site-wide hot board) and
filters by per-group context keywords. TheQoo sits behind Cloudflare's
browser challenge, so this collector is **Tier 2 from the start**: it
uses ``StealthyFetcher`` (a real headless browser) with
``solve_cloudflare=True``. There is no Tier-1 ``Fetcher`` fallback —
plain HTTP gets a CF interstitial more often than a useful page.

V2.28 (2026-05-21): primary hot board 외에 ``group.theqoo_supplemental_
boards`` 의 게시판들도 fetch 한다. 통합 게시판은 모든 그룹의 글이 섞여
있으므로 supplemental fetch 만 ``is_relevant(..., strict_generic_
blocklist=True)`` 를 적용 — primary 는 종전과 같이 strict=False.
(TheQoo / Instiz 검색이 자동화 차단된 검증 결과에 따라 디시 V2.27
supplemental galleries 패턴을 그대로 옮겨 옴. 자세한 배경은
``docs/superpowers/specs/2026-05-21-community-search-collectors-design.md``
§0 참고.)

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

from idol_sight.analysis.relevance import is_relevant
from idol_sight.collectors.base import CollectionResult
from idol_sight.config import GroupConfig
from idol_sight.utils.dates import parse_safe
from idol_sight.utils.url_hash import url_hash

log = logging.getLogger(__name__)

LIST_URL_TPL = "https://theqoo.net/index.php?mid={mid}"
PRIMARY_MID = "hot"


class TheQooCollector:
    source = "theqoo"

    def __init__(self, stealthy: Any | None = None):
        self._stealthy = stealthy or StealthyFetcher

    def _fetch_board(self, mid: str) -> Any:
        return self._stealthy.fetch(
            LIST_URL_TPL.format(mid=mid),
            headless=True,
            network_idle=True,
            solve_cloudflare=True,
        )

    def collect(self, group: GroupConfig, since: str | None = None) -> CollectionResult:
        started = perf_counter()
        rows_all: list[dict[str, Any]] = []
        errors: list[str] = []

        # Primary hot board — legacy filter (strict_generic_blocklist=False).
        try:
            primary_rows = [
                r for r in self._parse(self._fetch_board(PRIMARY_MID))
                if is_relevant(r["title"], group)
            ]
            rows_all.extend(primary_rows)
        except Exception as e:  # noqa: BLE001
            errors.append(f"{group.key}: theqoo primary board {PRIMARY_MID!r}: {e}")

        # Supplemental boards — strict mode (cross-group hubs).
        for mid in group.theqoo_supplemental_boards or []:
            try:
                sup_rows = [
                    r for r in self._parse(self._fetch_board(mid))
                    if is_relevant(
                        r["title"], group, strict_generic_blocklist=True,
                    )
                ]
                rows_all.extend(sup_rows)
            except Exception as e:  # noqa: BLE001
                errors.append(f"{group.key}: theqoo supplemental board {mid!r}: {e}")

        # Dedupe by url_hash — primary와 supplemental에 같은 글이
        # 동시에 매칭되면 한 번만 INSERT.
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
            statements=statements, errors=errors, runtime_ms=runtime_ms,
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
