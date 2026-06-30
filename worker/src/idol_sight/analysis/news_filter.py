"""Filter naver news articles for relevance.

Excludes articles that:
- Don't contain at least one *trusted* context keyword. A keyword is
  trusted on its own only when it's ≥3 chars AND not a generic genre /
  agency token (버추얼, IPX …). Short or generic tokens count only when
  the group's anchor (name / name_kr) also appears in the text — this is
  what stops a B:DAWN / BTHD article that merely says "버추얼" from
  leaking into ISEDOL's feed. Mirrors the community-board gate in
  ``relevance.py`` (which was hardened long ago; the news path was not).
- Have unparseable publication dates.
- Were published more than a year before the group's debut.
- Match a blacklist phrase.

When an article IS relevant, ``FilterResult.score`` quantifies how
strongly it belongs to the group (title hits weigh more than snippet
hits, generic/short tokens only count when anchored). The collector uses
this to arbitrate multi-group round-up articles: a single article row is
attributed to the highest-scoring group so a story primarily about BTHD
does not also surface under ISEDOL.

Excluded articles are still saved with is_excluded=1 + exclude_reason so we
can re-tune rules without re-crawling.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from idol_sight.analysis.relevance import (
    GENERIC_KEYWORD_BLOCKLIST,
    SHORT_TOKEN_THRESHOLD,
    has_anchor,
)
from idol_sight.config import GroupConfig
from idol_sight.utils.dates import parse_safe

# A keyword found in the title is a much stronger subject signal than one
# buried in the snippet — weight accordingly so arbitration favours the
# group the headline is actually about.
TITLE_WEIGHT = 2
SNIPPET_WEIGHT = 1


@dataclass
class FilterResult:
    relevant: bool
    reason: str | None      # Set when relevant=False; one of:
                            # 'no_context_keyword' | 'no_anchored_keyword'
                            # | 'unparseable_date' | 'before_debut_minus_year'
                            # | f'blacklist:{phrase}'
    score: int = 0          # Subject-strength; only meaningful when relevant.


@dataclass
class _Match:
    relevant: bool
    reason: str | None
    score: int


class NewsFilter:
    def __init__(self, group: GroupConfig):
        self._group = group
        if group.debut_date:
            try:
                debut = datetime.fromisoformat(group.debut_date)
                self._allow_after = (debut - timedelta(days=365)).date()
            except ValueError:
                self._allow_after = None
        else:
            self._allow_after = None

    def evaluate(self, *, title: str, snippet: str, published_at: str) -> FilterResult:
        text = f"{title} {snippet}"

        match = self._match_keywords(title, snippet, text)
        if not match.relevant:
            return FilterResult(False, match.reason)

        pub = parse_safe(published_at)
        if pub is None:
            return FilterResult(False, "unparseable_date")

        if self._allow_after and pub.date() < self._allow_after:
            return FilterResult(False, "before_debut_minus_year")

        for bl in self._group.blacklist_phrases:
            if bl in text:
                return FilterResult(False, f"blacklist:{bl}")

        return FilterResult(True, None, match.score)

    def _match_keywords(self, title: str, snippet: str, text: str) -> _Match:
        """Anchored-keyword gate + subject score.

        A keyword is "trusted on its own" when it's long enough and not a
        generic genre/agency token. Short or generic tokens are trusted
        only when the group anchor co-occurs in the text. The article is
        relevant if any trusted-alone keyword matched, OR the anchor is
        present and at least one (any) keyword matched.
        """
        anchored = has_anchor(text, self._group)
        saw_any = False
        matched_trusted_alone = False
        score = 0

        for kw in self._group.context_keywords:
            if not kw or kw not in text:
                continue
            saw_any = True
            trusted_alone = (
                len(kw) >= SHORT_TOKEN_THRESHOLD
                and kw not in GENERIC_KEYWORD_BLOCKLIST
            )
            if trusted_alone:
                matched_trusted_alone = True
            if trusted_alone or anchored:
                score += TITLE_WEIGHT if kw in title else SNIPPET_WEIGHT

        if matched_trusted_alone or (anchored and saw_any):
            return _Match(True, None, score)
        if saw_any:
            return _Match(False, "no_anchored_keyword", 0)
        return _Match(False, "no_context_keyword", 0)
