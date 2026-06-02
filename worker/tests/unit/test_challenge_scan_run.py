from unittest.mock import MagicMock
import datetime as dt
from idol_sight.analysis.challenge_scan import (
    run_challenge_scan, measure_challenge, Challenge,
)
from idol_sight.llm.gemini import GroundedResult


def _now():
    return dt.datetime(2026, 6, 2, 5, 0, tzinfo=dt.timezone.utc).timestamp()


def test_measure_challenge_examples_only_shorts():
    # videoDuration=short(<4분) 결과에 MV(200s)·롱폼이 섞여 와도, 예시는 ≤60s 숏츠만.
    yt = MagicMock()
    yt.search_shorts.return_value = ["mv", "s1", "s2", "nodur"]
    yt.fetch_stats.return_value = [
        {"video_id": "mv", "views": 9999, "duration_sec": 200, "title": "공식 MV"},
        {"video_id": "s1", "views": 500, "duration_sec": 30, "title": "챌린지"},
        {"video_id": "s2", "views": 800, "duration_sec": 45, "title": "챌린지2"},
        {"video_id": "nodur", "views": 7000, "duration_sec": 0, "title": "길이불명"},
    ]
    ch = Challenge(name="C", tag="kpop", description="", origin="", hashtags=["#c"],
                   source_urls=[], confidence="high", miiwan_fit="")
    measure_challenge(yt, ch, "2026-05-26T00:00:00Z")
    assert "mv" not in ch.example_video_ids       # MV(200s) 제외
    assert "nodur" not in ch.example_video_ids     # 길이불명(0) 제외
    assert ch.example_video_ids == ["s2", "s1"]    # 숏츠만, 조회수순
    assert ch.yt_recent_shorts == 4                # 카운트는 검색 표본 전체


def test_measure_challenge_no_shorts_leaves_empty():
    yt = MagicMock()
    yt.search_shorts.return_value = ["mv"]
    yt.fetch_stats.return_value = [{"video_id": "mv", "views": 9, "duration_sec": 240}]
    ch = Challenge(name="C", tag="kpop", description="", origin="", hashtags=["#c"],
                   source_urls=[], confidence="low", miiwan_fit="")
    measure_challenge(yt, ch, "2026-05-26T00:00:00Z")
    assert ch.example_video_ids == []              # 진짜 숏츠 없으면 링크 없음(MV 금지)


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
