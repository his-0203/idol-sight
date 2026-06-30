from idol_sight.analysis.news_filter import NewsFilter
from idol_sight.config import GroupConfig


def _bdawn() -> GroupConfig:
    return GroupConfig(
        key="bdawn", name="B:DAWN", name_kr="비던",
        debut_date=None,
        yt_channel_id=None, dc_gallery_id="bdawn", naver_query="B:DAWN 비던",
        context_keywords=["B:DAWN", "비던", "강호", "버추얼"],
        blacklist_phrases=["와이너리", "마을"],
        twitter_handles=[],
    )


def _plave() -> GroupConfig:
    return GroupConfig(
        key="plave", name="PLAVE", name_kr="플레이브",
        debut_date="2023-03-12",
        yt_channel_id=None, dc_gallery_id="plave", naver_query="플레이브",
        context_keywords=["플레이브", "PLAVE", "노아", "버추얼"],
        blacklist_phrases=[],
        twitter_handles=[],
    )


def _isedol() -> GroupConfig:
    return GroupConfig(
        key="isedol", name="ISEDOL", name_kr="이세계아이돌",
        debut_date=None,
        yt_channel_id=None, dc_gallery_id="isekaidol", naver_query="이세계아이돌",
        context_keywords=["이세계아이돌", "ISEDOL", "릴파", "버추얼", "왁타버스"],
        blacklist_phrases=[],
        twitter_handles=[],
    )


def _bthd() -> GroupConfig:
    return GroupConfig(
        key="bthd", name="BTHD", name_kr="비더후드",
        debut_date=None,
        yt_channel_id=None, dc_gallery_id="bthd", naver_query="BTHD",
        context_keywords=["BTHD", "비더후드", "버추얼"],
        blacklist_phrases=[],
        twitter_handles=[],
    )


def test_blocks_when_no_context_keyword():
    f = NewsFilter(_plave())
    r = f.evaluate(
        title="K-팝 시장 동향",
        snippet="2026년 K-팝 매출 분석",
        published_at="2026.05.04.",
    )
    assert not r.relevant
    assert r.reason == "no_context_keyword"


def test_allows_when_context_keyword_present():
    f = NewsFilter(_plave())
    r = f.evaluate(
        title="플레이브 신곡 발매",
        snippet="버추얼 아이돌 플레이브가 신곡을 발매했다.",
        published_at="2026.05.04.",
    )
    assert r.relevant


def test_blocks_unparseable_date():
    f = NewsFilter(_plave())
    r = f.evaluate(
        title="플레이브 신곡 발매",
        snippet="...",
        published_at="언젠가 곧 발매됨",
    )
    assert not r.relevant
    assert r.reason == "unparseable_date"


def test_blocks_before_debut_minus_year():
    f = NewsFilter(_plave())   # debut 2023-03-12
    r = f.evaluate(
        title="플레이브 관련",
        snippet="...",
        published_at="2020-01-01",
    )
    assert not r.relevant
    assert r.reason == "before_debut_minus_year"


def test_blocks_blacklist_phrase():
    f = NewsFilter(_bdawn())
    r = f.evaluate(
        title="비던 와이너리 신제품 출시",
        snippet="...",
        published_at="2026.05.04.",
    )
    assert not r.relevant
    assert r.reason and r.reason.startswith("blacklist:와이너리")


def test_pre_debut_group_skips_date_floor():
    f = NewsFilter(_bdawn())   # no debut_date
    r = f.evaluate(
        title="비던 데뷔 예정",
        snippet="버추얼 그룹 비던",
        published_at="2020-01-01",
    )
    assert r.relevant   # No debut → no floor


# ─── Cross-group leak guard (anchor + generic blocklist) ──────────────


def test_excludes_generic_only_match_without_anchor():
    """A B:DAWN article that only shares the genre word '버추얼' with
    ISEDOL — and never names ISEDOL — must NOT land in ISEDOL's feed."""
    f = NewsFilter(_isedol())
    r = f.evaluate(
        title="비던, 첫 미니앨범 발매",
        snippet="버추얼 보이그룹 비던이 데뷔 후 첫 미니앨범을 냈다.",
        published_at="2026.05.04.",
    )
    assert not r.relevant
    assert r.reason == "no_anchored_keyword"


def test_allows_generic_keyword_when_anchor_present():
    """'버추얼' is generic, but the group name anchors it → relevant."""
    f = NewsFilter(_isedol())
    r = f.evaluate(
        title="이세계아이돌, 버추얼 아이돌 대표주자로",
        snippet="버추얼 그룹 이세계아이돌이 신곡을 발표했다.",
        published_at="2026.05.04.",
    )
    assert r.relevant


def test_short_token_without_anchor_excluded():
    """'강호' (2-char member name) collides with 무협 일반어; without the
    group anchor it must not pass."""
    f = NewsFilter(_bdawn())
    r = f.evaluate(
        title="무협 강호를 평정한 절대고수",
        snippet="강호의 고수들이 모였다.",
        published_at="2026.05.04.",
    )
    assert not r.relevant
    assert r.reason == "no_anchored_keyword"


def test_longtoken_nongeneric_still_passes():
    """Regression: a normal long, non-generic keyword still matches."""
    f = NewsFilter(_isedol())
    r = f.evaluate(
        title="릴파, 솔로곡 공개",
        snippet="이세계아이돌 릴파가 신곡을 냈다.",
        published_at="2026.05.04.",
    )
    assert r.relevant


# ─── Arbitration score (primary-subject group wins) ──────────────────


def test_title_match_scores_higher_than_snippet_match():
    f = NewsFilter(_isedol())
    in_title = f.evaluate(
        title="이세계아이돌 컴백", snippet="가요계 소식",
        published_at="2026.05.04.",
    )
    in_snippet = f.evaluate(
        title="가요계 소식", snippet="이세계아이돌 컴백",
        published_at="2026.05.04.",
    )
    assert in_title.relevant and in_snippet.relevant
    assert in_title.score > in_snippet.score


def test_primary_subject_group_outscores_mentioned_group():
    """A BTHD-subject article that mentions ISEDOL once in the body must
    score higher for BTHD than for ISEDOL, so arbitration attributes it
    to BTHD only."""
    title = "BTHD 신곡 발표"
    snippet = "비더후드(BTHD)가 신곡을 발표했다. 이세계아이돌도 축하를 전했다."
    bthd = NewsFilter(_bthd()).evaluate(
        title=title, snippet=snippet, published_at="2026.05.04.")
    isedol = NewsFilter(_isedol()).evaluate(
        title=title, snippet=snippet, published_at="2026.05.04.")
    assert bthd.relevant and isedol.relevant
    assert bthd.score > isedol.score
