"""Backfill re-arbitration of already-stored naver_articles.

naver_articles stores only the title (no snippet), so the backfill
re-evaluates each row's title against *every* active group and re-owns
the article to the highest-scoring relevant group — fixing rows that
leaked into the wrong group's PR/리스크 feed before the anchor gate
existed. Rows that no group can anchor are excluded in place.
"""

from idol_sight.analysis.news_backfill import rearbitrate
from idol_sight.config import GroupConfig


def _isedol() -> GroupConfig:
    return GroupConfig(
        key="isedol", name="ISEDOL", name_kr="이세계아이돌",
        debut_date=None, yt_channel_id=None, dc_gallery_id="isekaidol",
        naver_query="이세계아이돌",
        context_keywords=["이세계아이돌", "ISEDOL", "릴파", "버추얼", "왁타버스"],
        blacklist_phrases=[], twitter_handles=[],
    )


def _bdawn() -> GroupConfig:
    return GroupConfig(
        key="bdawn", name="B:DAWN", name_kr="비던",
        debut_date=None, yt_channel_id=None, dc_gallery_id="bdawn",
        naver_query="B:DAWN 비던",
        context_keywords=["B:DAWN", "비던", "강호", "버추얼"],
        blacklist_phrases=[], twitter_handles=[],
    )


def _bthd() -> GroupConfig:
    return GroupConfig(
        key="bthd", name="BTHD", name_kr="비더후드",
        debut_date=None, yt_channel_id=None, dc_gallery_id="bthd",
        naver_query="BTHD",
        context_keywords=["BTHD", "비더후드", "버추얼"],
        blacklist_phrases=[], twitter_handles=[],
    )


def test_reattributes_leaked_article_to_true_group():
    rows = [{
        "url_hash": "u1", "title": "비던, 첫 미니앨범 발매",
        "published_at": "2026.05.04.", "group_key": "isedol",
    }]
    ups = rearbitrate(rows, [_isedol(), _bdawn()])
    assert len(ups) == 1
    u = ups[0]
    assert u.url_hash == "u1"
    assert u.group_key == "bdawn"
    assert u.is_excluded == 0
    assert u.match_score > 0


def test_excludes_generic_only_leak_keeping_current_owner():
    rows = [{
        "url_hash": "u2", "title": "버추얼 아이돌 시장 동향 분석",
        "published_at": "2026.05.04.", "group_key": "isedol",
    }]
    ups = rearbitrate(rows, [_isedol(), _bdawn(), _bthd()])
    u = ups[0]
    assert u.is_excluded == 1
    assert u.group_key == "isedol"          # no group can anchor → keep owner
    assert u.reason == "no_anchored_keyword"
    assert u.match_score == 0


def test_keeps_current_owner_on_score_tie():
    rows = [{
        "url_hash": "u3", "title": "이세계아이돌·BTHD 합동 콘서트",
        "published_at": "2026.05.04.", "group_key": "isedol",
    }]
    # bthd listed first; both score equally on a title mention → the
    # current owner (isedol) must be kept rather than flip-flopping.
    ups = rearbitrate(rows, [_bthd(), _isedol()])
    assert ups[0].group_key == "isedol"


def test_relevant_keeps_owner_when_no_higher_scorer():
    rows = [{
        "url_hash": "u4", "title": "이세계아이돌 릴파 솔로 발표",
        "published_at": "2026.05.04.", "group_key": "isedol",
    }]
    ups = rearbitrate(rows, [_isedol(), _bdawn(), _bthd()])
    u = ups[0]
    assert u.group_key == "isedol"
    assert u.is_excluded == 0
    assert u.match_score > 0
