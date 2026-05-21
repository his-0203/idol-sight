from pathlib import Path
from unittest.mock import MagicMock

from scrapling.parser import Adaptor

from idol_sight.collectors.theqoo import TheQooCollector
from idol_sight.config import GroupConfig

FIXTURES = Path(__file__).parent / "fixtures"


def _plave() -> GroupConfig:
    return GroupConfig(
        key="plave", name="PLAVE", name_kr="플레이브",
        debut_date="2023-03-12",
        yt_channel_id=None, dc_gallery_id="plave", naver_query="플레이브",
        context_keywords=["플레이브", "PLAVE"],
        blacklist_phrases=[],
        twitter_handles=[],
    )


def _load_page():
    html = (FIXTURES / "theqoo_hotpost.html").read_text()
    return Adaptor(content=html, url="https://theqoo.net/hot")


def test_parses_theqoo_fixture():
    """Load a captured TheQoo hot-list HTML and verify post extraction."""
    stealthy = MagicMock()
    stealthy.fetch.return_value = _load_page()

    c = TheQooCollector(stealthy=stealthy)
    result = c.collect(_plave())

    stealthy.fetch.assert_called_once()
    assert result.rows_inserted >= 1
    # Each post creates 2 statements (community_posts + community_post_stats).
    assert len(result.statements) == 2 * result.rows_inserted

    # First INSERT must hit community_posts with platform='theqoo'.
    sql0, params0 = result.statements[0]
    sql1, params1 = result.statements[1]
    assert "community_posts" in sql0
    assert "theqoo" in params0
    assert "community_post_stats" in sql1
    # Sanity: the matched row mentions one of the context keywords.
    assert any(
        ("플레이브" in str(p)) or ("PLAVE" in str(p))
        for p in params0
    )


def test_supplemental_board_triggers_second_fetch():
    """V2.28: theqoo_supplemental_boards 가 비어 있지 않으면 primary
    (hot) + 보조 board 각각에 대해 stealthy.fetch 가 1 회씩 호출된다.
    같은 fixture 를 반환하더라도 supplemental fetch 는 strict mode 로
    필터되므로 통과 행 수가 primary 와 다를 수 있다 — 본 테스트는
    호출 횟수 / errors 비어있음만 검증."""
    stealthy = MagicMock()
    stealthy.fetch.return_value = _load_page()

    plave_with_supp = GroupConfig(
        key="plave", name="PLAVE", name_kr="플레이브",
        debut_date="2023-03-12",
        yt_channel_id=None, dc_gallery_id="plave", naver_query="플레이브",
        context_keywords=["플레이브", "PLAVE"],
        blacklist_phrases=[], twitter_handles=[],
        theqoo_supplemental_boards=["kpop"],
    )

    c = TheQooCollector(stealthy=stealthy)
    result = c.collect(plave_with_supp)

    # primary hot board + 1 supplemental board = 2 fetches.
    assert stealthy.fetch.call_count == 2
    assert result.errors == []


def test_supplemental_strict_mode_demotes_generic():
    """V2.28 + V2.27.1: supplemental fetch 는 strict_generic_blocklist=True
    이므로 '버추얼' 단독 매칭이 demote 된다. PLAVE 의 context_keywords 에
    의도적으로 '버추얼' 을 넣은 그룹으로 강제 비교 — 같은 fixture 에 대해
    primary 통과 행 수 ≥ supplemental 통과 행 수 가 성립해야 한다."""
    stealthy = MagicMock()
    stealthy.fetch.return_value = _load_page()

    # primary only
    g_no_supp = GroupConfig(
        key="g1", name="X", name_kr="엑스",
        debut_date=None, yt_channel_id=None,
        dc_gallery_id=None, naver_query=None,
        context_keywords=["버추얼"],  # generic-only
        blacklist_phrases=[], twitter_handles=[],
        theqoo_supplemental_boards=[],
    )
    # primary + supplemental
    g_with_supp = GroupConfig(
        key="g2", name="X", name_kr="엑스",
        debut_date=None, yt_channel_id=None,
        dc_gallery_id=None, naver_query=None,
        context_keywords=["버추얼"],
        blacklist_phrases=[], twitter_handles=[],
        theqoo_supplemental_boards=["kpop"],
    )

    c = TheQooCollector(stealthy=stealthy)
    only = c.collect(g_no_supp).rows_inserted
    # primary 와 supplemental 양쪽 모두 같은 fixture 라 supplemental 매칭
    # 0 + dedupe 가정 시 with_supp 결과는 only 와 동일해야 한다 (strict).
    # legacy 동작이면 supplemental 에서 추가 행이 잡혀 with_supp > only.
    with_supp = c.collect(g_with_supp).rows_inserted
    assert with_supp == only
