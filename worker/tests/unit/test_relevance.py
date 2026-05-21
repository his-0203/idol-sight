"""Tests for analysis.relevance — title-based filtering used by community
collectors. Codifies the behaviour we promise to ship:

  - long tokens (≥3 chars) match by substring as before
  - short tokens (<3 chars) require an anchor (group name or name_kr)
  - global spam phrases reject regardless of group match
  - empty / None titles never pass

The cross-group leak (e.g. the word "유니" matching STELLIVE *and*
OWIS for unrelated content) is the main regression this guards.
"""

from idol_sight.analysis.relevance import (
    GENERIC_KEYWORD_BLOCKLIST,
    GLOBAL_NEGATIVE_KEYWORDS,
    is_global_spam,
    is_relevant,
)
from idol_sight.config import GroupConfig


def _stellive() -> GroupConfig:
    # Mirrors 0002_seed.sql for STELLIVE, minus the 버추얼 token (which
    # 0012 strips). Includes the contentious "유니" short token.
    return GroupConfig(
        key="stellive", name="STELLIVE", name_kr="스텔라이브",
        debut_date="2023-03-08",
        yt_channel_id=None, dc_gallery_id=None, naver_query="스텔라이브",
        context_keywords=[
            "스텔라이브", "StelLive", "유니", "후야", "마시로", "리제",
        ],
        blacklist_phrases=[],
        twitter_handles=[],
    )


def _plave() -> GroupConfig:
    return GroupConfig(
        key="plave", name="PLAVE", name_kr="플레이브",
        debut_date="2023-03-12",
        yt_channel_id=None, dc_gallery_id="plave", naver_query="플레이브",
        context_keywords=["플레이브", "PLAVE", "노아", "예준", "하민"],
        blacklist_phrases=[],
        twitter_handles=[],
    )


def test_long_token_matches_substring():
    g = _plave()
    assert is_relevant("플레이브 신곡 발매", g) is True
    # Keyword matching is case-sensitive (matches collector's prior
    # behaviour). Both "PLAVE" and "플레이브" are seeded so K-pop
    # content always has at least one casing covered.
    assert is_relevant("PLAVE 컴백 d-7", g) is True
    assert is_relevant("plave 컴백 d-7", g) is False


def test_short_token_requires_anchor():
    g = _plave()  # "노아" is 2 chars
    # No anchor → short token alone should NOT match.
    assert is_relevant("노아 좋아함", g) is False
    # With anchor → match.
    assert is_relevant("플레이브 노아 직캠", g) is True


def test_unrelated_short_token_collision_rejected():
    """The dominant cross-group leak: '유니폼' matching STELLIVE because
    of the short '유니' token. With the length gate + anchor rule this
    must be rejected even though '유니' is a substring."""
    g = _stellive()
    assert is_relevant("축구 유니폼 추천", g) is False
    assert is_relevant("어벤져스 인피니티 유니버스", g) is False


def test_short_token_with_anchor_passes():
    g = _stellive()
    assert is_relevant("스텔라이브 유니 신곡", g) is True


def test_global_spam_rejected_even_with_match():
    g = _plave()
    # Spam phrase wins regardless of long-token match.
    assert is_relevant("플레이브 응원봉 양도합니다", g) is False
    assert is_relevant("[광고] PLAVE 굿즈", g) is False


def test_empty_title_never_passes():
    g = _plave()
    assert is_relevant("", g) is False
    assert is_relevant(None, g) is False  # type: ignore[arg-type]


def test_is_global_spam_phrases_present():
    # Spot-check that the curated list still flags representative noise.
    for phrase in ("양도", "팝니다", "[광고]"):
        assert phrase in "  ".join(GLOBAL_NEGATIVE_KEYWORDS)
    assert is_global_spam("응원봉 양도합니다") is True
    assert is_global_spam("일반 게시글") is False


def _miiwan_generic() -> GroupConfig:
    """Mirrors 0061's MiiWAN seed (post-V2.26): the generic '버추얼' and
    'IPX' tokens live alongside group-specific tokens, which is exactly
    the case that needs strict-mode protection in DC supplemental
    galleries."""
    return GroupConfig(
        key="miiwan", name="MiiWAN", name_kr="미완소년",
        debut_date="2026-06-01",
        yt_channel_id=None, dc_gallery_id="miiwansonyeon",
        naver_query="MiiWAN 미완소년",
        context_keywords=[
            "MiiWAN", "miiwan", "MIIWAN", "미완소년", "ㅁㅇㅅㄴ",
            "나이선", "임온", "마하진", "버추얼", "IPX",
        ],
        blacklist_phrases=[], twitter_handles=[],
    )


def test_generic_blocklist_canonical_tokens_present():
    """If anyone trims the blocklist, the strict-mode tests below would
    silently start passing for wrong reasons — fail loudly instead."""
    for t in ("버추얼", "IPX", "ABYSS", "VLAST", "Duri"):
        assert t in GENERIC_KEYWORD_BLOCKLIST


def test_strict_mode_demotes_generic_to_anchor_required():
    """A title that matches ONLY a generic blocklisted keyword (with no
    anchor) is accepted in legacy mode but rejected in strict mode —
    this is the V2.27.1 fix for vboyband 일반 글 false positives."""
    g = _miiwan_generic()
    legacy = is_relevant("버추얼 아이돌이 성공하려면 꼭 필요한 3가지", g)
    strict = is_relevant(
        "버추얼 아이돌이 성공하려면 꼭 필요한 3가지", g,
        strict_generic_blocklist=True,
    )
    assert legacy is True
    assert strict is False


def test_strict_mode_lets_generic_through_with_anchor():
    """Strict mode demotes generic tokens to anchor-required, not
    rejects-outright. '버추얼' alongside an anchor still matches."""
    g = _miiwan_generic()
    assert is_relevant(
        "미완소년 버추얼 아이돌 데뷔 임박", g,
        strict_generic_blocklist=True,
    ) is True


def test_strict_mode_does_not_affect_non_generic_keywords():
    """Group-specific tokens (멤버명, 그룹명) still match via the long-
    token fast path in strict mode — the gate only applies to entries in
    GENERIC_KEYWORD_BLOCKLIST."""
    g = _miiwan_generic()
    assert is_relevant("나이선 첫 라이브", g, strict_generic_blocklist=True) is True
    assert is_relevant("미완소년 화이팅", g, strict_generic_blocklist=True) is True
    assert is_relevant("ㅁㅇㅅㄴ 갤러리 생겼네", g, strict_generic_blocklist=True) is True


def test_strict_mode_default_off_preserves_legacy_callers():
    """is_relevant(title, group) without the strict kwarg must behave
    exactly like the legacy implementation — TheQoo / Instiz hot-board
    collectors depend on that."""
    g = _miiwan_generic()
    assert is_relevant("버추얼 트렌드 분석", g) is True  # legacy: '버추얼' fires
