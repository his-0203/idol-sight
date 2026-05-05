"""Naver news collector.

Fetches search.naver.com results for the group's naver_query, parses each
article card, runs NewsFilter, and emits INSERTs for naver_articles. Rows
filtered out are still inserted with is_excluded=1 so filter rules can be
tuned later.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from time import perf_counter
from typing import Any
from urllib.parse import quote

from scrapling import Fetcher

from idol_sight.analysis.news_filter import NewsFilter
from idol_sight.collectors.base import CollectionResult
from idol_sight.config import GroupConfig
from idol_sight.utils.dates import parse_safe
from idol_sight.utils.url_hash import url_hash

log = logging.getLogger(__name__)


SEARCH_URL = "https://search.naver.com/search.naver?where=news&sm=tab_jum&query={q}"


class NaverCollector:
    source = "naver"

    def __init__(self, fetcher: Any | None = None):
        self._fetcher = fetcher or Fetcher

    def collect(self, group: GroupConfig, since: str | None = None) -> CollectionResult:
        if not group.naver_query:
            return CollectionResult(0, 0, errors=[f"{group.key}: no naver_query"])

        started = perf_counter()
        url = SEARCH_URL.format(q=quote(group.naver_query))
        page = self._fetcher.get(url, impersonate="chrome131", stealthy_headers=True)
        articles = self._parse(page)

        filt = NewsFilter(group)
        now_iso = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        statements: list[tuple[str, list[Any]]] = []
        inserted = 0

        for art in articles:
            verdict = filt.evaluate(
                title=art["title"], snippet=art.get("snippet", ""),
                published_at=art["published_at_raw"],
            )
            pub = parse_safe(art["published_at_raw"])
            pub_iso = pub.strftime("%Y-%m-%dT00:00:00Z") if pub else None

            statements.append((
                """
                INSERT INTO naver_articles
                  (url_hash, group_key, title, source, url, published_at,
                   is_excluded, exclude_reason, collected_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(url_hash) DO UPDATE SET
                  title=excluded.title,
                  is_excluded=excluded.is_excluded,
                  exclude_reason=excluded.exclude_reason
                """.strip(),
                [
                    url_hash(art["url"]),
                    group.key,
                    art["title"][:500],
                    art.get("press") or "",
                    art["url"],
                    pub_iso,
                    0 if verdict.relevant else 1,
                    verdict.reason,
                    now_iso,
                ],
            ))
            inserted += 1

        runtime_ms = int((perf_counter() - started) * 1000)
        return CollectionResult(
            rows_inserted=inserted, rows_updated=0,
            statements=statements, runtime_ms=runtime_ms,
        )

    @staticmethod
    def _parse(page: Any) -> list[dict[str, str]]:
        """Extract article cards from a Naver search results page.

        Naver's news tab uses dynamically-hashed class names (Daw8...,
        DuX2...) but the data-heatmap-target attributes (.tit/.body/.prof)
        are stable. We iterate every title link and locate its sibling
        metadata via the smallest ancestor that contains exactly one .tit
        and at least one .prof — i.e. one article's metadata block.

        Falls back to legacy `.news_wrap.api_ani_send` / `.news_area`
        markup if the new selectors return nothing, in case Naver A/B-tests
        a different layout per region/cookie.
        """
        out: list[dict[str, str]] = []

        title_links = page.css('a[data-heatmap-target=".tit"]')
        if title_links:
            for link in title_links:
                try:
                    container = NaverCollector._find_article_container(link)
                    if container is None:
                        continue
                    title = " ".join(link.get_all_text().split())
                    href = link.attrib.get("href", "").strip()
                    if not (title and href):
                        continue
                    press_nodes = container.css(".sds-comps-profile-info-title")
                    press = (
                        " ".join(press_nodes[0].get_all_text().split())
                        if press_nodes else ""
                    )
                    date_nodes = container.css(
                        ".sds-comps-profile-info-subtexts span.sds-comps-text-ellipsis-1"
                    )
                    pub_raw = date_nodes[0].get_all_text().strip() if date_nodes else ""
                    body_nodes = container.css('a[data-heatmap-target=".body"]')
                    snippet = (
                        " ".join(body_nodes[0].get_all_text().split())
                        if body_nodes else ""
                    )
                    out.append({
                        "title": title,
                        "url": href,
                        "press": press,
                        "published_at_raw": pub_raw,
                        "snippet": snippet,
                    })
                except Exception as e:  # noqa: BLE001
                    log.warning("naver card parse skipped: %s", e)
            return out

        # Legacy fallback for older Naver markup
        cards = page.css(".news_wrap.api_ani_send") or page.css(".news_area")
        for card in cards:
            try:
                a_nodes = card.css("a.news_tit") or card.css("a.tit")
                if not a_nodes:
                    continue
                a = a_nodes[0]
                title = (a.attrib.get("title") or a.get_all_text() or "").strip()
                href = a.attrib.get("href", "").strip()
                if not (title and href):
                    continue
                press_nodes = card.css(".press") or card.css(".info_group .info")
                press = press_nodes[0].get_all_text().strip() if press_nodes else ""
                date_nodes = (
                    card.css(".info_group span.info") or card.css("span.info")
                )
                pub_raw = date_nodes[0].get_all_text().strip() if date_nodes else ""
                snippet_nodes = card.css(".news_dsc")
                snippet = (
                    snippet_nodes[0].get_all_text().strip()
                    if snippet_nodes else ""
                )
                out.append({
                    "title": title, "url": href, "press": press,
                    "published_at_raw": pub_raw, "snippet": snippet,
                })
            except Exception as e:  # noqa: BLE001
                log.warning("naver legacy card parse skipped: %s", e)
        return out

    @staticmethod
    def _find_article_container(title_link: Any) -> Any | None:
        """Walk up from a `.tit` anchor to the smallest ancestor that scopes
        exactly one article (one `.tit`, at least one `.prof`)."""
        for anc in title_link.iterancestors():
            tits = anc.css('a[data-heatmap-target=".tit"]')
            profs = anc.css('a[data-heatmap-target=".prof"]')
            if len(tits) == 1 and len(profs) >= 1:
                return anc
        return None
