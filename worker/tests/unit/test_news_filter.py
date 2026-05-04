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
