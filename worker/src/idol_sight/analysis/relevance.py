"""Title-based relevance filtering for community collectors.

Why this exists: TheQoo and Instiz collectors apply per-group keyword
filtering with a naive ``any(kw in title for kw in context_keywords)``
substring match. That's fragile in two specific ways the operator keeps
running into:

1. **Short tokens collide with 일반어.** Two-character tokens like
   "유니"/"린"/"범"/"설" are valid member nicknames AND show up as
   substrings of unrelated common words (유니폼, 유니버스, 보이스, …).
   Substring-matching alone cannot disambiguate.
2. **Spam / 거래 / 도배 글** are picked up whenever the post happens to
   include the group name token. The collectors have no global negative
   list, so 양도/팝니다/[광고] posts ride straight into the BI feed.

This module fixes both with two complementary checks:

- ``is_relevant`` — keyword matching with a length gate. Tokens of
  length ≥ 3 match as before (safe enough). Tokens shorter than 3
  characters require co-occurrence with an "anchor" — the group's
  English name OR its Korean name — in the same title, so 'OWIS 유니'
  passes but '유니폼 추천' does not.
- ``GLOBAL_NEGATIVE_KEYWORDS`` — phrase list that rejects the post
  outright regardless of group match. Curated for K-pop community
  noise (양도, 팝니다, 광고, 도배 …).

Both checks are pure-Python and case-aware; group anchors are matched
case-insensitively for the English name to handle "PLAVE"/"plave"
collisions in the same title.
"""

from __future__ import annotations

from idol_sight.config import GroupConfig

# Keywords below this length need an anchor co-occurrence to be trusted.
# 3 was picked because "MV", "MR", "BL" and similar 2-char K-pop terms
# collide with too many unrelated common words; raising to 4 would
# exclude legitimate 3-char idol names like "노아"/"리코". Two-char
# tokens are still allowed — they just need anchor company.
SHORT_TOKEN_THRESHOLD = 3

# Phrases that mark a post as commercial/거래/광고/도배 noise. We match
# substring (case-insensitive) — these phrases are unambiguous enough
# that false-positives are rare. Adding "[광고]" as a single token
# catches the common moderator-prefixed ad posts.
GLOBAL_NEGATIVE_KEYWORDS: tuple[str, ...] = (
    "양도",
    "팝니다",
    "삽니다",
    "구해요",
    "[광고]",
    "[홍보]",
    "단톡",
    "도배",
    "어그로",
    "굿즈 거래",
    "택포",
    "직거래",
)


def is_global_spam(title: str) -> bool:
    """True if the title contains any global spam/광고/거래 phrase."""
    if not title:
        return False
    t = title.lower()
    return any(phrase.lower() in t for phrase in GLOBAL_NEGATIVE_KEYWORDS)


def _has_anchor(title: str, group: GroupConfig) -> bool:
    """True if the title contains the group's English or Korean name.

    The English name is matched case-insensitively because some posts
    use lowercase / mixed-case ('plave 신곡' vs 'PLAVE 신곡'). The
    Korean name is matched as-is — Hangul has no case fold concerns.
    """
    if not title:
        return False
    if group.name and group.name.lower() in title.lower():
        return True
    return bool(group.name_kr and group.name_kr in title)


def is_relevant(title: str, group: GroupConfig) -> bool:
    """Decide whether a community-board title is about ``group``.

    Rules (in order):
      1. Reject if the title contains any GLOBAL_NEGATIVE_KEYWORDS phrase.
      2. Accept if any context keyword of length ≥ 3 is a substring.
      3. Accept if the title has the group anchor (name/name_kr) AND any
         short context keyword (< 3 chars) is also present — this is
         the disambiguation gate that protects against '유니폼' →
         STELLIVE leaks.
      4. Otherwise reject.

    Empty titles never pass.
    """
    if not title:
        return False
    if is_global_spam(title):
        return False

    # Long-token fast path: any kw of length ≥ 3 → match.
    short_tokens: list[str] = []
    for kw in group.context_keywords:
        if not kw:
            continue
        if len(kw) >= SHORT_TOKEN_THRESHOLD:
            if kw in title:
                return True
        else:
            short_tokens.append(kw)

    # Short-token gated path: only count if the group anchor is also in
    # the title (disambiguation). Anchor presence alone is NOT enough —
    # we still want a context keyword to fire, otherwise unrelated
    # posts that happen to mention 'PLAVE' as a comparison would match.
    if short_tokens and _has_anchor(title, group):
        for kw in short_tokens:
            if kw in title:
                return True

    return False
