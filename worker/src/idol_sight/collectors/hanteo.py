"""Hanteo chart collector via hanteonews.com news articles.

The hanteochart.com SPA renders chart data only after JS hydration with a
protected API key — it cannot be scraped reliably even with a real browser.
Instead we read **hanteonews.com**, hanteo's official news site, which
publishes weekly chart announcements as plain SSR HTML articles.

Strategy:
1. Fetch the chart category landing page → extract recent article URLs.
2. For each article, fetch + look for our seeded groups by name.
3. When a group matches, extract the album title and the most recent
   "판매량 N장" / "음반 지수 N점" near it.
4. UPSERT into hanteo_weekly keyed on (week_start, group_key, album).

The user only needs **초동 판매량** (first-week album sales). Hanteo
publishes those in weekly chart articles for ~30 days after release, so a
weekly fetch is enough.

Wiring:
- collect(group) is a no-op (orchestrator-friendly stub).
- collect_global() does the real work; called by analyze-weekly.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from datetime import date, timedelta
from time import perf_counter
from typing import Any

from scrapling import Fetcher

from idol_sight.collectors.base import CollectionResult
from idol_sight.config import GroupConfig

log = logging.getLogger(__name__)

NEWS_BASE = "https://www.hanteonews.com"
CHART_LIST_URL = f"{NEWS_BASE}/ko/article/chart"
ARTICLE_URL_TPL = f"{NEWS_BASE}/ko/article/{{aid}}"

# Article selection — we only care about weekly summary posts. Daily ranking
# posts are titled "[일간랭킹: ...]" and skipped; they don't carry first-week
# (초동) sales context.
WEEKLY_TITLE_RE = re.compile(r"주간|월간|초동")
DAILY_TITLE_RE = re.compile(r"일간랭킹")

# Sales / index extraction. Hanteo's prose convention is:
#   "<artist>는 <album>으로 N월 K주 음반 지수 X점 (판매량 Y장)을 기록"
SALES_RE = re.compile(r"판매량\s*([0-9,]+)\s*장")
INDEX_RE = re.compile(r"음반\s*지수\s*([0-9,.]+)\s*점")
ALBUM_RE = re.compile(r"['‘’“”\"]([^'‘’“”\"]{2,80})['‘’“”\"]")
RANK_RE = re.compile(r"(\d+)\s*위")
ARTICLE_HREF_RE = re.compile(r'href="(/ko/article/(\d+))"')

# How many recent articles to scan. The chart landing page surfaces ~10-20.
MAX_ARTICLES = 30
# Window of characters scanned around each group-name occurrence.
CONTEXT_WINDOW = 600


def _week_bounds(today: date | None = None) -> tuple[str, str]:
    """Return (week_start, week_end) for the most recent Sunday-to-Saturday
    week ending strictly before today."""
    today = today or date.today()
    days_since_sunday = (today.weekday() + 1) % 7
    end = today - timedelta(days=days_since_sunday + 1)
    start = end - timedelta(days=6)
    return start.isoformat(), end.isoformat()


def _strip_tags(s: str) -> str:
    s = re.sub(r"<[^>]+>", " ", s)
    return re.sub(r"\s+", " ", s).strip()


class HanteoCollector:
    source = "hanteo"

    def __init__(
        self,
        fetcher: Any | None = None,
        groups_loader: Callable[[], list[dict]] | None = None,
    ):
        self._fetcher = fetcher or Fetcher
        # Returns [{"key": "plave", "name": "PLAVE", "name_kr": "플레이브"}, ...].
        self._groups_loader = groups_loader or (lambda: [])

    def collect(self, group: GroupConfig, since: str | None = None) -> CollectionResult:
        return CollectionResult(0, 0)

    def collect_global(self) -> CollectionResult:
        started = perf_counter()
        seeded = self._groups_loader()
        if not seeded:
            return CollectionResult(0, 0, errors=["no_groups_seeded"])

        # 1. Discover article URLs (skip daily rankings up front).
        list_html = self._fetch_html(CHART_LIST_URL)
        if not list_html:
            return CollectionResult(0, 0, errors=["chart_list_unreachable"])

        article_ids = self._discover_article_ids(list_html)
        if not article_ids:
            return CollectionResult(0, 0, errors=["no_articles"])

        # 2. Scan article bodies. Stop early if we've matched every group.
        week_start, week_end = _week_bounds()
        statements: list[tuple[str, list[Any]]] = []
        matched_keys: set[str] = set()

        for aid in article_ids[:MAX_ARTICLES]:
            html = self._fetch_html(ARTICLE_URL_TPL.format(aid=aid))
            if not html:
                continue
            text = _strip_tags(html)
            if DAILY_TITLE_RE.search(text[:300]):
                # Daily rankings — no 초동 data, skip.
                continue
            for g in seeded:
                if g["key"] in matched_keys:
                    continue
                other_names = [
                    n for og in seeded if og["key"] != g["key"]
                    for n in (og.get("name"), og.get("name_kr"))
                    if n and len(n) >= 2
                ]
                hit = self._match_group(text, g, other_names)
                if hit is None:
                    continue
                album, rank, sales, index = hit
                if sales is None and index is None:
                    continue
                statements.append((
                    """
                    INSERT INTO hanteo_weekly
                      (week_start, week_end, group_key, album, rank, sales, note)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(week_start, group_key, album) DO UPDATE SET
                      week_end=excluded.week_end,
                      rank=excluded.rank,
                      sales=excluded.sales,
                      note=excluded.note
                    """.strip(),
                    [
                        week_start, week_end, g["key"],
                        album or "",
                        rank, sales,
                        f"hanteonews/{aid}" + (f" idx={index}" if index else ""),
                    ],
                ))
                matched_keys.add(g["key"])

        runtime_ms = int((perf_counter() - started) * 1000)
        return CollectionResult(
            rows_inserted=len(matched_keys),
            rows_updated=0,
            statements=statements,
            runtime_ms=runtime_ms,
        )

    # ─── helpers ─────────────────────────────────────────────────

    def _fetch_html(self, url: str) -> str | None:
        try:
            page = self._fetcher.get(url, impersonate="chrome131", stealthy_headers=True)
        except Exception as e:                        # noqa: BLE001
            log.warning("hanteonews fetch failed %s: %s", url, e)
            return None
        # Scrapling pages expose raw HTML differently across versions. Try
        # the common attribute names; accept any non-empty string.
        for attr in ("html_content", "body", "raw_html", "html"):
            v = getattr(page, attr, None)
            if isinstance(v, str) and v.strip():
                return v
        try:
            v = page.css("html")[0].html_content
            return v if isinstance(v, str) else None
        except Exception:                                  # noqa: BLE001
            return None

    @staticmethod
    def _discover_article_ids(list_html: str) -> list[str]:
        """Extract /ko/article/<id> hrefs from the chart landing page,
        de-duplicated and ordered by appearance (newest first)."""
        seen: set[str] = set()
        out: list[str] = []
        for m in ARTICLE_HREF_RE.finditer(list_html):
            aid = m.group(2)
            if aid not in seen:
                seen.add(aid)
                out.append(aid)
        return out

    @staticmethod
    def _match_group(
        text: str, g: dict, other_names: list[str] | None = None,
    ) -> tuple[str | None, int | None, int | None, float | None] | None:
        """Search `text` for a mention of group `g`. If found, return
        (album, rank, sales_count, index_value) extracted from the local
        window. Any of the values may be None when not present.

        Returns None entirely when the group name does not appear at all.

        ``other_names`` are the names of the OTHER tracked groups. In a
        multi-group article ("PLAVE 5만장 … ISEDOL 3만장") each group owns the
        text from its mention up to the next group's mention, so we clamp the
        extraction window to not cross another group's mention — otherwise the
        backward look-back reads the neighbour's trailing sales as ours."""
        candidates = [g.get("name"), g.get("name_kr")]
        candidates = [c for c in candidates if c and len(c) >= 2]
        idx = -1
        for cand in candidates:
            i = text.find(cand)
            if i >= 0:
                idx = i
                break
        if idx < 0:
            return None
        win_start = max(0, idx - 100)
        win_end = idx + CONTEXT_WINDOW
        for name in other_names or []:
            if not name or len(name) < 2:
                continue
            pos = text.find(name)
            while pos >= 0:
                if win_start <= pos < idx:
                    # Another group occupies our backward window — everything
                    # from it up to us is theirs. Drop the look-back entirely.
                    win_start = idx
                elif idx < pos < win_end:
                    win_end = pos       # stop before the next group's mention
                pos = text.find(name, pos + 1)
        win = text[win_start:win_end]
        sales_m = SALES_RE.search(win)
        index_m = INDEX_RE.search(win)
        album_m = ALBUM_RE.search(win)
        rank_m = RANK_RE.search(win)
        sales = None
        if sales_m:
            try:
                sales = int(sales_m.group(1).replace(",", ""))
            except ValueError:
                sales = None
        index = None
        if index_m:
            try:
                index = float(index_m.group(1).replace(",", ""))
            except ValueError:
                index = None
        rank: int | None = None
        if rank_m:
            try:
                r = int(rank_m.group(1))
                # Hanteo charts top out around 200; reject obviously bogus
                # numbers from unrelated text.
                if 1 <= r <= 200:
                    rank = r
            except ValueError:
                rank = None
        album = album_m.group(1).strip() if album_m else None
        return album, rank, sales, index
