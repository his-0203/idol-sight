"""Naver news collector.

Fetches search.naver.com results for a *list* of derived queries (group
name + per-member combinations), parses each article card, dedupes
results across queries by URL hash, runs NewsFilter, and emits INSERTs
for naver_articles. Rows filtered out are still inserted with
is_excluded=1 so filter rules can be tuned later.

Multi-query expansion
---------------------
Historical behaviour was a single fetch per group, using the operator-
curated ``GroupConfig.naver_query`` verbatim. That single phrase is
ANDed by Naver, so member-only articles (예: "마하진 솔로 라이브") are
rejected at the search-engine layer.

The collector now derives a small set of queries through
:func:`idol_sight.collectors._search_terms.expand_search_terms` —
typically the original ``naver_query`` plus per-member combos like
``"미완소년 마하진"`` — and merges the parsed cards across queries.
The query cap (``DEFAULT_MAX_TERMS``) keeps fetch growth bounded; a
per-query ``sleep_seconds`` (default 1.0) avoids thundering Naver.

To keep callers backward-compatible with the single-query path, an
``additional_queries`` parameter on :meth:`collect` is **not** required
— if member metadata isn't supplied, the collector falls back to a
single-fetch run identical to the old behaviour.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterable
from datetime import UTC, datetime
from time import perf_counter, sleep
from typing import Any
from urllib.parse import quote

from scrapling import Fetcher

from idol_sight.analysis.news_filter import NewsFilter
from idol_sight.collectors._search_terms import (
    DEFAULT_MAX_TERMS,
    expand_search_terms,
)
from idol_sight.collectors.base import CollectionResult
from idol_sight.config import GroupConfig
from idol_sight.utils.dates import parse_safe
from idol_sight.utils.url_hash import url_hash

log = logging.getLogger(__name__)


SEARCH_URL = "https://search.naver.com/search.naver?where=news&sm=tab_jum&query={q}"

# Upsert with cross-group arbitration. url_hash is the PK, so one article
# is one row owned by exactly one group. When several groups collect the
# same round-up article, ownership settles on the relevant group with the
# highest NewsFilter score (the primary subject), and a relevant verdict
# beats a previously-excluded one — independent of collection order.
#
# "Takeover" predicate: the incoming row is relevant AND (the stored row
# is currently excluded OR the incoming score is strictly higher). Title
# and collected_at always refresh (same article); group ownership and the
# relevance verdict only move on takeover.
NAVER_ARTICLES_UPSERT_SQL = """
INSERT INTO naver_articles
  (url_hash, group_key, title, source, url, published_at,
   is_excluded, exclude_reason, collected_at, match_score)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(url_hash) DO UPDATE SET
  group_key = CASE
    WHEN excluded.is_excluded = 0
         AND (naver_articles.is_excluded = 1
              OR excluded.match_score > naver_articles.match_score)
    THEN excluded.group_key ELSE naver_articles.group_key END,
  is_excluded = CASE
    WHEN excluded.is_excluded = 0
         AND (naver_articles.is_excluded = 1
              OR excluded.match_score > naver_articles.match_score)
    THEN excluded.is_excluded ELSE naver_articles.is_excluded END,
  exclude_reason = CASE
    WHEN excluded.is_excluded = 0
         AND (naver_articles.is_excluded = 1
              OR excluded.match_score > naver_articles.match_score)
    THEN excluded.exclude_reason ELSE naver_articles.exclude_reason END,
  match_score = CASE
    WHEN excluded.is_excluded = 0
         AND (naver_articles.is_excluded = 1
              OR excluded.match_score > naver_articles.match_score)
    THEN excluded.match_score ELSE naver_articles.match_score END,
  title = excluded.title,
  collected_at = excluded.collected_at
""".strip()

# Default delay between successive Naver fetches when a group expands to
# multiple queries. Naver doesn't publish an RPS limit for anonymous
# news search, but anecdotal observation puts soft-throttling around
# 5-6 RPS; 1s/query keeps us at ≤1 RPS even when the cap is raised.
DEFAULT_INTER_QUERY_SLEEP_S = 1.0


class NaverCollector:
    source = "naver"

    def __init__(
        self,
        fetcher: Any | None = None,
        members_loader: Callable[[str], list[dict]] | None = None,
        max_terms: int = DEFAULT_MAX_TERMS,
        sleep_seconds: float = DEFAULT_INTER_QUERY_SLEEP_S,
        sleeper: Callable[[float], None] = sleep,
    ):
        """Construct a Naver collector.

        Parameters
        ----------
        fetcher
            Scrapling fetcher (or test double). Defaults to the package
            singleton ``Fetcher``.
        members_loader
            Optional callable ``group_key -> list[{"name": str, "name_en": str}]``
            used to build the per-member query expansion. When omitted
            the collector falls back to a single-fetch run with only
            ``GroupConfig.naver_query`` — preserves day-one behaviour
            for callers that haven't wired members in.
        max_terms
            Hard cap on derived queries per call. See
            :data:`idol_sight.collectors._search_terms.DEFAULT_MAX_TERMS`.
        sleep_seconds
            Per-query inter-fetch delay (in seconds). Set to 0 in tests
            to skip the wait.
        sleeper
            Injectable replacement for :func:`time.sleep` (tests pass
            a no-op).
        """
        self._fetcher = fetcher or Fetcher
        self._members_loader = members_loader or (lambda _: [])
        self._max_terms = max_terms
        self._sleep_seconds = sleep_seconds
        self._sleeper = sleeper

    def collect(self, group: GroupConfig, since: str | None = None) -> CollectionResult:
        if not group.naver_query and not group.name_kr and not group.name:
            return CollectionResult(0, 0, errors=[f"{group.key}: no naver_query"])

        started = perf_counter()

        # Derive the query set. Members come from D1 via the injected
        # loader; aliases are mined opportunistically from
        # ``context_keywords`` (operator-curated baseline that may
        # already include fan-club / stage-name aliases).
        members = self._members_loader(group.key)
        queries = expand_search_terms(
            name=group.name,
            name_kr=group.name_kr,
            naver_query=group.naver_query,
            members=members,
            aliases=group.context_keywords,
            max_terms=self._max_terms,
        )
        if not queries:
            # Pre-V2.6 callers may have a group with naver_query=None;
            # mirror the legacy 'no naver_query' error to keep the
            # crawl_meta failure label stable for dashboards.
            return CollectionResult(0, 0, errors=[f"{group.key}: no naver_query"])

        # Cross-query dedupe — the hot stories about a debut comeback
        # show up under the group anchor AND every member combo. Without
        # this we'd emit N copies of the same article and waste D1 row
        # budget. Keying on url_hash matches the downstream INSERT key
        # exactly so we never accidentally count two fetches as
        # duplicates when they were really separate articles.
        seen_url_hashes: set[str] = set()
        merged_articles: list[dict[str, str]] = []
        fetched_queries = 0

        for q in queries:
            if not q:
                continue
            url = SEARCH_URL.format(q=quote(q))
            try:
                page = self._fetcher.get(
                    url,
                    impersonate="chrome131",
                    stealthy_headers=True,
                )
            except Exception as exc:  # noqa: BLE001
                # One bad query must NOT abort the rest of the group's
                # collection. We log + continue; the row count just
                # reflects whatever we already gathered.
                log.warning("naver fetch failed for q=%r: %s", q, exc)
                continue
            for art in self._parse(page):
                u = art.get("url") or ""
                if not u:
                    continue
                uh = url_hash(u)
                if uh in seen_url_hashes:
                    continue
                seen_url_hashes.add(uh)
                merged_articles.append(art)
            fetched_queries += 1
            # Sleep AFTER each fetch except the last. Tests pass a
            # zero-cost sleeper so this doesn't add real time there.
            if self._sleep_seconds and fetched_queries < len(queries):
                self._sleeper(self._sleep_seconds)

        log.debug(
            "naver group=%s queries=%d articles_unique=%d",
            group.key, fetched_queries, len(merged_articles),
        )

        filt = NewsFilter(group)
        now_iso = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        statements: list[tuple[str, list[Any]]] = []
        inserted = 0

        for art in merged_articles:
            verdict = filt.evaluate(
                title=art["title"], snippet=art.get("snippet", ""),
                published_at=art["published_at_raw"],
            )
            pub = parse_safe(art["published_at_raw"])
            pub_iso = pub.strftime("%Y-%m-%dT00:00:00Z") if pub else None

            statements.append((
                NAVER_ARTICLES_UPSERT_SQL,
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
                    verdict.score,
                ],
            ))
            inserted += 1

        runtime_ms = int((perf_counter() - started) * 1000)
        return CollectionResult(
            rows_inserted=inserted, rows_updated=0,
            statements=statements, runtime_ms=runtime_ms,
        )

    @staticmethod
    def _normalize_queries(queries: Iterable[str]) -> list[str]:
        """Helper for callers that want to inspect what would be fetched
        without actually performing the network calls."""
        return [q for q in queries if q and q.strip()]

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
