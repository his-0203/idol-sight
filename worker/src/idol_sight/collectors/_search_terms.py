"""Multi-query search-term expansion for text-based collectors.

Why this exists
---------------
The Naver collector historically issues a SINGLE search query per group
(``GroupConfig.naver_query`` — typically the operator-curated phrase like
``'MiiWAN 미완소년'``). Naver treats whitespace inside a search query as
AND, so that single fetch only surfaces articles that mention BOTH the
romanized AND Korean group name. Articles about specific members
(예: 마하진 솔로 라이브, 나이선 첫 방송) — which are abundant for
pre-debut groups whose name awareness is still building — are silently
filtered out at the search-engine layer, before any of our per-row
filters get a chance to evaluate them.

The fix is mechanical: instead of one query, run a small SET of
deliberately-anchored queries (group name on its own + each member name
combined with the Korean group anchor) and merge the results, deduping
on URL hash. To keep API-call growth bounded we cap the term count and
expose the cap to callers.

Anchor philosophy
-----------------
For pre-debut and small groups, plain "마하진" or "나이선" as a query
returns mostly unrelated content (similar Korean names across drama /
sport / older idols). Pre-pending the Korean group name as an anchor
("미완소년 마하진") preserves recall while curbing false positives.
The downstream :class:`NewsFilter` still re-evaluates each article, so
this helper only needs to be conservative about the query LIST — not
about per-article relevance.

Output is a list of strings, deduped (case-insensitive on the English
side, exact on Hangul), with the operator-curated ``naver_query`` always
first so the single-fetch behaviour is preserved on day one if a group
has no member metadata.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

# Canonical definition lives in analysis.relevance — re-exported here so
# legacy callers ``from idol_sight.collectors._search_terms import
# GENERIC_KEYWORD_BLOCKLIST`` continue working (and so the value can't
# drift between the search-expansion path and the is_relevant strict
# mode that DcCollector's supplemental fetch relies on).
from idol_sight.analysis.relevance import (
    GENERIC_KEYWORD_BLOCKLIST as _GENERIC_KEYWORD_BLOCKLIST,
)

# Per-name minimums. Hangul tokens of length 2 are kept (most idol names
# are 2-3 syllables). English / romanized tokens require length ≥ 3 to
# avoid "MV"/"BL"/"V" noise that collides with non-idol search results.
HANGUL_MIN = 2
LATIN_MIN = 3

# Default cap on returned queries. Each query is one Naver fetch, so the
# hourly Naver job cost grows linearly. 6 queries × 9 groups × 2 runs/day
# is ~108 fetches/day — well under Naver's anonymous browse threshold
# (no API key, no documented hard quota; we self-throttle via sleep in
# the collector wrapper anyway).
DEFAULT_MAX_TERMS = 6

# Tokens that are too generic to anchor a search even when they appear
# in context_keywords. These usually leak into a group's keyword list to
# tag the genre (버추얼) or agency (IPX, ABYSS, VLAST) — they would
# return tens of thousands of unrelated articles if dispatched as their
# own query. Re-exported from analysis.relevance so the search-expansion
# layer and the is_relevant strict mode share one source of truth.
GENERIC_KEYWORD_BLOCKLIST = _GENERIC_KEYWORD_BLOCKLIST


@dataclass(frozen=True)
class _Member:
    """Compact view of a row from D1's ``members`` table."""

    name: str | None
    name_en: str | None


def _is_hangul(ch: str) -> bool:
    """True for any character in the Hangul Syllables block."""
    return "가" <= ch <= "힣"


def _looks_hangul(s: str) -> bool:
    """True if the string contains any Hangul syllable. Mixed-script
    strings like '아카네 리제' still count as Hangul because the entire
    name is Korean even when written with a space."""
    return any(_is_hangul(c) for c in s)


def _passes_length_gate(token: str) -> bool:
    """Length gate that mirrors :mod:`analysis.relevance` philosophy.

    Hangul names: at least HANGUL_MIN syllables (default 2) — drops
    single-syllable nicknames that would collide too aggressively.

    Latin/romanized names: at least LATIN_MIN characters — drops
    "BL"/"MV"/"V" type stubs that fall out of fan convention.
    """
    t = token.strip()
    if not t:
        return False
    if _looks_hangul(t):
        # Strip whitespace for the count so '아카네 리제' (4 syllables
        # across two words) still passes.
        compact = "".join(ch for ch in t if not ch.isspace())
        return len(compact) >= HANGUL_MIN
    return len(t) >= LATIN_MIN


def _normalize(token: str) -> str:
    """Whitespace-collapsed lowercase form for dedupe — applied on
    EN/romanized strings only. Hangul never gets case-folded."""
    return " ".join(token.lower().split())


def _quote_if_needed(term: str) -> str:
    """Wrap multi-word phrases in double quotes so Naver treats them as
    a literal phrase rather than splitting on whitespace into AND.

    Single-word terms are returned unmodified (Naver indexes them as
    single tokens already; quoting them just adds noise to the URL).
    """
    t = term.strip()
    if not t:
        return t
    if " " in t and not (t.startswith('"') and t.endswith('"')):
        return f'"{t}"'
    return t


def expand_search_terms(
    *,
    name: str,
    name_kr: str,
    naver_query: str | None,
    members: Iterable[dict | _Member] | None = None,
    aliases: Iterable[str] | None = None,
    max_terms: int = DEFAULT_MAX_TERMS,
) -> list[str]:
    """Return the de-duped query list for one group.

    Parameters
    ----------
    name, name_kr
        The English / Korean group names. Both are required for anchor
        construction; ``name_kr`` is preferred as the member-query
        anchor because Naver news indexes Korean copy more reliably.
    naver_query
        Operator-curated baseline query. Always emitted first when
        present — preserves day-one parity with the legacy single-fetch
        path. ``None`` is allowed for groups that haven't been seeded
        with one yet; in that case the group name(s) become the
        baseline.
    members
        Iterable of ``{"name": str, "name_en": str}`` dicts (or
        :class:`_Member` records) — typically the rows from
        ``SELECT name, name_en FROM members WHERE active=1``.
    aliases
        Optional extra hand-curated tokens (e.g. one-off stage names
        that aren't in the members table). Same length-gate rules
        apply.
    max_terms
        Hard cap on returned queries. The first ``max_terms`` survivors
        are kept; later additions are dropped. Set higher if a specific
        group genuinely needs fan-club aliases queried separately.

    Returns
    -------
    list[str]
        Deduped query list, ordered by importance (group anchors first,
        then per-member combos). Suitable to feed straight into the
        Naver search URL — the caller is responsible for URL-encoding.
    """
    out: list[str] = []
    seen_norm: set[str] = set()

    def _add(term: str) -> bool:
        """Add ``term`` if novel and within cap. Return True if added."""
        if not term or not term.strip():
            return False
        n = _normalize(term)
        if n in seen_norm:
            return False
        if len(out) >= max_terms:
            return False
        seen_norm.add(n)
        out.append(term.strip())
        return True

    # 1. Operator-curated baseline. We pass it through verbatim — the
    #    operator may have already constructed an "OR"-joined Naver
    #    expression for groups whose Korean name collides with common
    #    words (see wegosix: '위고식스 OR "WE GO-6" OR wegosix').
    if naver_query and naver_query.strip():
        _add(naver_query.strip())

    # 2. Bare group anchors as a fallback / ANDed pair. We always quote
    #    multi-word names so Naver treats them as a phrase.
    if name_kr:
        _add(_quote_if_needed(name_kr))
    if name and _normalize(name) != _normalize(name_kr or ""):
        _add(_quote_if_needed(name))

    # 3. Pick a Korean anchor for member-combo queries — name_kr first,
    #    fall back to name. (B:DAWN's '비던' is 2 syllables but valid;
    #    the length gate doesn't apply to anchors, only to leaf tokens.)
    anchor = (name_kr or name or "").strip()

    # 4. Per-member queries. Korean name preferred (Hangul is cheaper to
    #    disambiguate in Naver); romanized name added if it survives the
    #    length gate AND differs from the Korean form. Each member
    #    contributes at most TWO queries (KR-anchored, EN-anchored).
    member_pairs = list(members or [])
    for m in member_pairs:
        if isinstance(m, _Member):
            kr, en = m.name, m.name_en
        else:
            kr = m.get("name") if isinstance(m, dict) else None
            en = m.get("name_en") if isinstance(m, dict) else None

        # 4a. KR member combined with KR anchor: '미완소년 마하진'.
        if kr and _passes_length_gate(kr) and anchor:
            combo = f"{anchor} {kr}".strip()
            _add(_quote_if_needed(combo))

        # 4b. EN member combined with KR anchor: '미완소년 Mahajin'.
        #     Only emitted when EN differs meaningfully from KR — many
        #     ISEDOL/STELLIVE members have romanizations that are just
        #     the Hangul transliteration and add no recall.
        if (en and _passes_length_gate(en) and anchor
                and (not kr or _normalize(en) != _normalize(kr))):
            combo = f"{anchor} {en}".strip()
            _add(_quote_if_needed(combo))

    # 5. Aliases (hand-curated, e.g. fan-club names). Length-gated like
    #    member tokens, blocked from generic-keyword pollution.
    for alias in aliases or []:
        if not alias:
            continue
        if alias.strip() in GENERIC_KEYWORD_BLOCKLIST:
            continue
        if not _passes_length_gate(alias):
            continue
        _add(_quote_if_needed(alias.strip()))

    return out


__all__ = [
    "expand_search_terms",
    "DEFAULT_MAX_TERMS",
    "HANGUL_MIN",
    "LATIN_MIN",
    "GENERIC_KEYWORD_BLOCKLIST",
]
