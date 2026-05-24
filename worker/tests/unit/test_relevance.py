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


# ------------------------------------------------------------------
# V2.30 (migration 0064) — group-keyword variant coverage.
#
# 이 블록은 운영자가 0064 에서 추가한 표기 변형 (영문 대소문자 / 콜론·
# 하이픈·공백 / 한글 초성) 이 실제로 매치 / 비매치를 보장하는지 회귀
# 가드한다. context_keywords 가 (의도와 다르게) 트리밍될 경우 여기서
# 즉시 깨진다.
# ------------------------------------------------------------------


def _wegosix_v230() -> GroupConfig:
    """WeGoSix post-V2.30 context_keywords (migration 0064)."""
    return GroupConfig(
        key="wegosix", name="WE GO-6", name_kr="위고식스",
        debut_date=None,
        yt_channel_id=None, dc_gallery_id="wegosix",
        naver_query='위고식스 OR "WE GO-6" OR wegosix',
        context_keywords=[
            "23rd Century Kids", "wegosix", "위고식스", "WE GO-6", "WEGO6",
            "WeGoSix", "WEGOSIX", "Wegosix", "WE GO 6", "WeGo6", "wego6",
            "we go six", "WE GO SIX", "위고6", "ㅇㄱㅅㅅ",
            "시우", "해일", "산호", "진휘", "우연",
        ],
        blacklist_phrases=[], twitter_handles=[],
    )


def _bdawn_v230() -> GroupConfig:
    """B:DAWN post-V2.30 context_keywords (migration 0064)."""
    return GroupConfig(
        key="bdawn", name="B:DAWN", name_kr="비던",
        debut_date="2026-05-06",
        yt_channel_id=None, dc_gallery_id="bdawn",
        naver_query="B:DAWN 비던 버추얼",
        context_keywords=[
            "B:DAWN", "b:dawn", "bdawn", "BDAWN", "Bdawn", "B-DAWN",
            "B DAWN", "비던", "ㅂㄷ",
            "BEOM", "범", "강호", "서도진", "임이온", "이한솔", "송우림",
            "Duri", "IPX", "버추얼",
        ],
        blacklist_phrases=[], twitter_handles=[],
    )


def _myrakl_v230() -> GroupConfig:
    """MY:RAKL post-V2.30 context_keywords (migration 0064)."""
    return GroupConfig(
        key="myrakl", name="MY:RAKL", name_kr="미라클",
        debut_date="2026-01-26",
        yt_channel_id=None, dc_gallery_id="myrakl",
        naver_query="MY:RAKL 미라클 버추얼",
        context_keywords=[
            "MY:RAKL", "my:rakl", "myrakl", "MYRAKL", "Myrakl", "MY RAKL",
            "마이라클", "미라클", "ㅁㄹㅋ",
            "새온", "유성", "하이든", "제하", "설", "ACCORD", "버추얼",
        ],
        blacklist_phrases=[], twitter_handles=[],
    )


def test_wegosix_case_and_separator_variants_match():
    g = _wegosix_v230()
    # 사용자 보고 케이스 (2026-05-25): 다양한 표기로 호명되는데 일부만 잡힘.
    # 0064 가 모든 변형을 시드하므로 아래 모두 long-token fast path 통과.
    for title in [
        "wegosix 데뷔 카운트다운",
        "WeGoSix 신곡 미리듣기",
        "wego6 멤버 직캠",
        "we go six 첫 컴백",
        "WE GO 6 무대 영상",
        "위고6 굿즈 공구",
        "ㅇㄱㅅㅅ 마이너 갤러리 신설됨",
    ]:
        assert is_relevant(title, g) is True, f"missed: {title}"


def test_bdawn_separator_variants_match():
    g = _bdawn_v230()
    # 콜론/하이픈/공백 변형 전부 long-token (3+ char) 자동 매치.
    for title in [
        "bdawn 데뷔 임박",
        "BDAWN 컴백 트레일러",
        "B-DAWN 첫 음방",
        "B DAWN 라이브 후기",
    ]:
        assert is_relevant(title, g) is True, f"missed: {title}"


def test_bdawn_short_choseong_requires_anchor():
    """'ㅂㄷ' (비던 초성, 2자) 는 short-token 으로 분류되어 anchor 동반
    시에만 매치된다. 일반어 충돌 (받침/부들부들 등) 자동 차단."""
    g = _bdawn_v230()
    # anchor 없이는 reject — 일반어 충돌 보호.
    assert is_relevant("받침 좋은 추천", g) is False
    assert is_relevant("ㅂㄷㅂㄷ 떨림", g) is False
    # anchor 동반 시 accept.
    assert is_relevant("B:DAWN ㅂㄷ 응원", g) is True
    assert is_relevant("비던 ㅂㄷ 컴백", g) is True


def test_myrakl_colon_and_short_choseong_variants_match():
    g = _myrakl_v230()
    # 콜론/공백/case 변형은 long-token fast path 통과.
    for title in [
        "myrakl 신곡 발매",
        "MYRAKL 라이브 후기",
        "MY RAKL 첫 컴백",
    ]:
        assert is_relevant(title, g) is True, f"missed: {title}"
    # 'ㅁㄹㅋ' 3자라 long-token fast path 자동 매치.
    assert is_relevant("ㅁㄹㅋ 새 티저 영상", g) is True


def test_isedol_hangul_collisions_intentionally_not_seeded():
    """ISEDOL 의 한글 풀명 '이세계아이돌' 외 짧은 별칭 (이세돌, 이세계)
    은 외부 명사 충돌 (바둑기사 / 만화 장르) 때문에 0064 에서 의도적으로
    제외. 해당 단어 단독으로는 매치되지 않아야 한다."""
    g = GroupConfig(
        key="isedol", name="ISEDOL", name_kr="이세계아이돌",
        debut_date="2021-12-17",
        yt_channel_id=None, dc_gallery_id="isekaidol",
        naver_query="이세계아이돌",
        context_keywords=[
            "이세계아이돌", "ISEGYE IDOL", "ISEDOL", "isedol", "Isedol",
            "릴파", "아이네", "징버거", "주르르", "고세구", "비챤",
            "버추얼", "왁타버스",
        ],
        blacklist_phrases=[], twitter_handles=[],
    )
    # 매치되어야 하는 변형
    assert is_relevant("isedol 신곡 라이브", g) is True
    assert is_relevant("Isedol 뮤비 분석", g) is True
    # 의도적으로 미시드된 충돌어는 매치되지 않아야 함
    assert is_relevant("이세돌 바둑 명국", g) is False
    assert is_relevant("이세계 만화 추천", g) is False
