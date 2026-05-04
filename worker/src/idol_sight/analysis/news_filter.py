"""Filter naver news articles for relevance.

Excludes articles that:
- Don't contain at least one context keyword (catches same-name false positives).
- Have unparseable publication dates.
- Were published more than a year before the group's debut.
- Match a blacklist phrase.

Excluded articles are still saved with is_excluded=1 + exclude_reason so we
can re-tune rules without re-crawling.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from idol_sight.config import GroupConfig
from idol_sight.utils.dates import parse_safe


@dataclass
class FilterResult:
    relevant: bool
    reason: str | None      # Set when relevant=False; one of:
                            # 'no_context_keyword' | 'unparseable_date'
                            # | 'before_debut_minus_year' | f'blacklist:{phrase}'


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

        if not any(kw in text for kw in self._group.context_keywords):
            return FilterResult(False, "no_context_keyword")

        pub = parse_safe(published_at)
        if pub is None:
            return FilterResult(False, "unparseable_date")

        if self._allow_after and pub.date() < self._allow_after:
            return FilterResult(False, "before_debut_minus_year")

        for bl in self._group.blacklist_phrases:
            if bl in text:
                return FilterResult(False, f"blacklist:{bl}")

        return FilterResult(True, None)
