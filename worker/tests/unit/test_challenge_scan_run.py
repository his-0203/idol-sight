from unittest.mock import MagicMock
import datetime as dt
from idol_sight.analysis.challenge_scan import (
    run_challenge_scan, measure_challenge, Challenge,
)
from idol_sight.llm.gemini import GroundedResult


def _now():
    return dt.datetime(2026, 6, 2, 5, 0, tzinfo=dt.timezone.utc).timestamp()


def test_measure_challenge_examples_from_verified_llm_candidates():
    # 예시 = LLM 제시 후보를 API 검증한 결과. MV(>60s)·미존재 제외, LLM 순서 보존,
    # 조회수 정렬 안 함(view=인기≠관련성). 지표(yt_recent_shorts)는 별도 검색 표본.
    ch = Challenge(name="C", tag="kpop", description="", origin="", hashtags=["#c"],
                   source_urls=[], confidence="high", miiwan_fit="",
                   candidate_video_ids=["mv", "s1", "ghost", "s2"])
    yt = MagicMock()
    yt.search_shorts.return_value = ["x"]              # 지표용 블라인드 검색
    table = {
        "x":  {"video_id": "x", "views": 10, "duration_sec": 30},
        "mv": {"video_id": "mv", "views": 9999, "duration_sec": 200},  # MV → 제외
        "s1": {"video_id": "s1", "views": 5, "duration_sec": 30},
        "s2": {"video_id": "s2", "views": 800, "duration_sec": 45},
        # "ghost" 는 videos.list 미반환 → 제외
    }
    yt.fetch_stats.side_effect = lambda ids: [table[i] for i in ids if i in table]
    measure_challenge(yt, ch, "2026-05-26T00:00:00Z")
    # s1(view 5) 이 s2(view 800) 보다 앞 → LLM 순서 보존, view 정렬 안 함
    assert ch.example_video_ids == ["s1", "s2"]
    assert ch.yt_recent_shorts == 1                    # 지표는 별도 검색 표본


def test_measure_challenge_no_candidates_leaves_empty():
    ch = Challenge(name="C", tag="kpop", description="", origin="", hashtags=["#c"],
                   source_urls=[], confidence="low", miiwan_fit="",
                   candidate_video_ids=[])
    yt = MagicMock()
    yt.search_shorts.return_value = []
    measure_challenge(yt, ch, "2026-05-26T00:00:00Z")
    assert ch.example_video_ids == []                  # 후보 없으면 링크 없음(MV·무관 금지)


def _gemini(challenges):
    g = MagicMock()
    g.generate_grounded.return_value = GroundedResult(text="리서치", sources=["http://s"])
    g.generate.return_value = {"challenges": challenges}
    return g


def _yt(ids, stats):
    y = MagicMock()
    y.search_shorts.return_value = ids
    y.fetch_stats.return_value = stats
    return y


def test_run_writes_ranked_challenges():
    gemini = _gemini([
        {"name": "K", "tag": "kpop", "description": "d", "origin": "o",
         "hashtags": ["#k"], "source_urls": ["http://s"], "confidence": "high",
         "miiwan_fit": "쉬움"},
    ])
    yt = _yt(["v1", "v2"], [{"video_id": "v1", "views": 500, "likes": 1,
                             "comments": 0, "title": "t"}])
    d1 = MagicMock()
    n = run_challenge_scan(gemini, yt, d1, now_epoch=_now(),
                           target_kpop=7, target_general=3)
    assert n == 1
    gemini.generate_grounded.assert_called_once()
    gemini.generate.assert_called_once()
    yt.search_shorts.assert_called_once()
    stmts = d1.batch.call_args[0][0]
    assert stmts[0][0].strip().upper().startswith("DELETE")
    assert any("INSERT INTO weekly_challenges" in s for s, _ in stmts)


def test_run_skips_when_no_challenges():
    gemini = _gemini([])
    yt = _yt([], [])
    d1 = MagicMock()
    n = run_challenge_scan(gemini, yt, d1, now_epoch=_now(),
                           target_kpop=7, target_general=3)
    assert n == 0
    d1.batch.assert_not_called()


def test_run_tolerates_measure_failure():
    gemini = _gemini([
        {"name": "K", "tag": "kpop", "description": "", "hashtags": ["#k"],
         "source_urls": [], "confidence": "low", "miiwan_fit": ""},
    ])
    yt = MagicMock()
    yt.search_shorts.side_effect = RuntimeError("quota")
    d1 = MagicMock()
    n = run_challenge_scan(gemini, yt, d1, now_epoch=_now(),
                           target_kpop=7, target_general=3)
    assert n == 1
    stmts = d1.batch.call_args[0][0]
    assert any("INSERT INTO weekly_challenges" in s for s, _ in stmts)


def test_run_skips_on_discovery_error():
    # grounding/discovery 실패는 비-치명 — 0 반환, 기존 주차 보존(배치 호출 없음).
    gemini = MagicMock()
    gemini.generate_grounded.side_effect = RuntimeError("grounding down")
    d1 = MagicMock()
    n = run_challenge_scan(gemini, MagicMock(), d1, now_epoch=_now(),
                           target_kpop=7, target_general=3)
    assert n == 0
    d1.batch.assert_not_called()
