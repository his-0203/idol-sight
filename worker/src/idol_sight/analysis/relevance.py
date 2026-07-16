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

# Generic / agency / genre tokens that are too broad to anchor a match
# on their own even when length ≥ 3. '버추얼' matches every 버튜버 글,
# 'IPX' / 'ABYSS' / 'VLAST' / 'Duri' / 'ACCORD' / 'Bridge' are agency
# tokens shared across multiple groups, 'ama' is a 3-char fan slang that
# leaks too easily. When ``is_relevant`` is invoked with
# ``strict_generic_blocklist=True`` (DcCollector's supplemental fetch
# does this), these tokens are demoted to anchor-required even at
# ≥3-char length. The set is canonical here — _search_terms re-exports
# it for backward compat with naver query expansion.
GENERIC_KEYWORD_BLOCKLIST: frozenset[str] = frozenset({
    "버추얼", "virtual",
    "IPX", "ABYSS", "VLAST", "Bridge", "Duri", "ACCORD",
    "ama",
    # V2.32 — wegosix 멤버 "제로" 영문 표기. 일반어 ("zero gravity",
    # "zero waste", "zero-sum" 등) 충돌이 너무 잦아 anchor-required 로
    # demote. 한글 "제로" 는 2자 short-token 이라 SHORT_TOKEN_THRESHOLD
    # 가 자동 anchor-gate 하므로 별도 등재 불요.
    "Zero", "zero",
    # V2.33 — UR:L (uryael) 그룹/멤버 일반어 충돌 가드.
    #   "URL" / "url" — IT 용어 (모든 링크 안내 / 광고 메시지에 등장)
    #   "모카" — 음료명 (커피 모카) — 한글 2자라 short-token 이긴 하나
    #            "모카" 자체가 자주 등장하므로 strict 모드에서 한 번 더
    #            anchor 강제.
    #   "마냥" — 부사 ("마냥 좋다") — 한글 2자 short-token + 부사 출현
    #            빈도가 매우 높아 동일 가드.
    #   "Mocha" — 음료/색상 (latte mocha, mocha color) — 영문이라 short-
    #            token 아님 → 명시적 blocklist 필요.
    #   "Manyang" — 영문 발음 표기. 일반어 충돌은 낮지만 "many" prefix
    #            매칭 위험 (substring match) — 함께 등재.
    # primary (sandboxurl) fetch 는 group-scoped 이라 영향 없고
    # supplemental (vboyband) 에서만 anchor (UR:L / 유아렐) 동반 시 매치.
    "URL", "url", "Url",
    "모카", "Mocha",
    "마냥", "Manyang",
    # V2.x — hollin (홀린, WhOLLiN) 일반어 충돌 가드.
    #   "홀린" — 동사 홀리다 활용형 ("홀린 듯이") + 가수 효린(HYOLYN)
    #            음차 혼동. 일상어 출현이 매우 잦아 그룹명이지만 단독
    #            anchor 금지 → strict 모드 (vboyband supplemental) 에서
    #            WhOLLiN / 네이버웹툰 등 고유 anchor 동반 시에만 매치.
    #   "플레이리스트" / "Playlist" — 음악 재생목록 일반어. 소속사명이나
    #            anchor 로 쓰기엔 충돌이 커 demote.
    "홀린",
    "플레이리스트", "Playlist",
})

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


def has_anchor(title: str, group: GroupConfig) -> bool:
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


def is_relevant(
    title: str,
    group: GroupConfig,
    *,
    strict_generic_blocklist: bool = False,
) -> bool:
    """Decide whether a community-board title is about ``group``.

    Rules (in order):
      1. Reject if the title contains any GLOBAL_NEGATIVE_KEYWORDS phrase.
      2. Accept if any context keyword of length ≥ 3 (and NOT in the
         generic blocklist when ``strict_generic_blocklist`` is True) is
         a substring.
      3. Accept if the title has the group anchor (name/name_kr) AND any
         short context keyword (< 3 chars OR in the generic blocklist
         under strict mode) is also present.
      4. Otherwise reject.

    Empty titles never pass.

    Parameters
    ----------
    strict_generic_blocklist
        When True, keywords listed in ``GENERIC_KEYWORD_BLOCKLIST`` are
        demoted to anchor-required regardless of length. DcCollector's
        supplemental fetch (cross-group hub galleries like 'vboyband')
        sets this so '버추얼' / 'IPX' alone don't drag in unrelated
        버튜버 일반 글. Default False preserves legacy behaviour for
        hot-board collectors (theqoo / instiz) where the post-frequency
        and curated keyword lists are already tight enough.
    """
    if not title:
        return False
    if is_global_spam(title):
        return False

    blocked: frozenset[str] = (
        GENERIC_KEYWORD_BLOCKLIST if strict_generic_blocklist else frozenset()
    )

    # Long-token fast path: any kw of length ≥ 3 → match — UNLESS the
    # keyword is in the generic blocklist and we're in strict mode, in
    # which case it falls through to the short-token (anchor-required)
    # path so the disambiguation gate gets to evaluate it.
    short_tokens: list[str] = []
    for kw in group.context_keywords:
        if not kw:
            continue
        if len(kw) >= SHORT_TOKEN_THRESHOLD and kw not in blocked:
            if kw in title:
                return True
        else:
            short_tokens.append(kw)

    # Short-token gated path: only count if the group anchor is also in
    # the title (disambiguation). Anchor presence alone is NOT enough —
    # we still want a context keyword to fire, otherwise unrelated
    # posts that happen to mention 'PLAVE' as a comparison would match.
    if short_tokens and has_anchor(title, group):
        for kw in short_tokens:
            if kw in title:
                return True

    return False
