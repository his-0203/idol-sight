"""Hanteo weekly album chart collector.

Hanteo is unlike per-group sources — the chart is global. We fetch once and
fan out to every seeded group whose `name` appears as the artist.

Wiring:
- collect(group) is a no-op (orchestrator-friendly stub).
- collect_global() does the real work; called by the analyze-weekly workflow.
"""

from __future__ import annotations

from datetime import date, timedelta
from time import perf_counter
from typing import Any, Callable

from scrapling import StealthyFetcher

from idol_sight.collectors.base import CollectionResult
from idol_sight.config import GroupConfig

LIST_URL = "https://www.hanteochart.com/?fc=albums&sub=weekly"


def _week_bounds(today: date | None = None) -> tuple[str, str]:
    """Return (week_start, week_end) ISO dates for the most recent
    Sunday-to-Saturday week ending strictly before today."""
    today = today or date.today()
    days_since_sunday = (today.weekday() + 1) % 7
    end = today - timedelta(days=days_since_sunday + 1)
    start = end - timedelta(days=6)
    return start.isoformat(), end.isoformat()


class HanteoCollector:
    source = "hanteo"

    def __init__(
        self,
        stealthy: Any | None = None,
        groups_loader: Callable[[], list[dict]] | None = None,
    ):
        self._stealthy = stealthy or StealthyFetcher
        # Returns [{"key": "plave", "name": "PLAVE"}, ...] for active groups.
        self._groups_loader = groups_loader or (lambda: [])

    def collect(self, group: GroupConfig, since: str | None = None) -> CollectionResult:
        # Per-group is a stub. Real work lives in collect_global().
        return CollectionResult(0, 0)

    def collect_global(self) -> CollectionResult:
        started = perf_counter()
        page = self._stealthy.fetch(
            LIST_URL,
            headless=True, network_idle=True,
            block_resources=True, solve_cloudflare=True,
        )
        rows = self._parse(page)
        seeded = self._groups_loader()

        # Map artist text → group key by case-insensitive substring on group name.
        idx = {(g.get("name") or "").upper(): g["key"] for g in seeded}

        week_start, week_end = _week_bounds()

        statements: list[tuple[str, list[Any]]] = []
        matched = 0
        for r in rows:
            artist_upper = (r.get("artist") or "").upper()
            gk = None
            for name_upper, key in idx.items():
                if name_upper and name_upper in artist_upper:
                    gk = key
                    break
            if gk is None:
                continue
            statements.append((
                """
                INSERT INTO hanteo_weekly
                  (week_start, week_end, group_key, album, rank, sales, note)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(week_start, group_key, album) DO UPDATE SET
                  week_end=excluded.week_end,
                  rank=excluded.rank,
                  sales=excluded.sales
                """.strip(),
                [
                    week_start, week_end, gk,
                    r.get("album") or "",
                    r.get("rank"), r.get("sales"),
                    None,
                ],
            ))
            matched += 1

        runtime_ms = int((perf_counter() - started) * 1000)
        return CollectionResult(
            rows_inserted=matched, rows_updated=0,
            statements=statements, runtime_ms=runtime_ms,
        )

    @staticmethod
    def _parse(page: Any) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        # Hanteo's box / row container varies. Try multiple selectors.
        boxes = (
            page.css(".search_chart_year_top10_unit_box1")
            or page.css(".chart_unit_row")
            or page.css("li.list-group-item")
        )
        for box in boxes:
            rank_node = box.css(".rank") or box.css(".chart-rank") or box.css("span.r")
            album_node = box.css(".album_name") or box.css(".album")
            artist_node = box.css(".artist_name") or box.css(".artist")
            sales_node = box.css(".sales") or box.css(".count")
            if not (rank_node and album_node and artist_node):
                continue
            try:
                rank = int((rank_node[0].text or "0").strip())
            except ValueError:
                continue
            sales_s = (sales_node[0].text or "").strip() if sales_node else ""
            try:
                sales = int(sales_s.replace(",", "")) if sales_s else None
            except ValueError:
                sales = None
            out.append({
                "rank": rank,
                "album": (album_node[0].text or "").strip(),
                "artist": (artist_node[0].text or "").strip(),
                "sales": sales,
            })
        return out
