import datetime as dt
import json
from unittest.mock import MagicMock

from idol_sight.analysis.challenge_scan import (
    POOL_CAP,
    SEED_QUERIES,
    Challenge,
    discover_candidate_videos,
    measure_challenge,
    run_challenge_scan,
)


def _now():
    return dt.datetime(2026, 6, 2, 5, 0, tzinfo=dt.UTC).timestamp()


def test_measure_challenge_examples_from_verified_llm_candidates():
    # 예시 = LLM 제시 후보를 API 검증한 결과. MV(>60s)·미존재 제외, LLM 순서 보존,
    # 조회수 정렬 안 함(view=인기≠관련성). 지표(yt_recent_shorts)는 별도 검색 표본.
    ch = Challenge(name="C", tag="dance", description="", origin="", hashtags=["#c"],
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


def test_measure_challenge_relevance_fallback_when_no_candidates():
    # LLM 후보 없음 → 'name 챌린지' relevance 검색 폴백 → ≤60s 검증분을 예시로.
    ch = Challenge(name="Catch Catch", tag="dance", description="", origin="",
                   hashtags=["#x"], source_urls=[], confidence="high", miiwan_fit="",
                   candidate_video_ids=[])
    yt = MagicMock()
    # 1차=지표(viewCount), 2차=예시 폴백(relevance)
    yt.search_shorts.side_effect = [["m1"], ["rel1", "mvlong", "rel2"]]
    table = {
        "m1":     {"video_id": "m1", "views": 100, "duration_sec": 30},
        "rel1":   {"video_id": "rel1", "views": 5, "duration_sec": 30},
        "mvlong": {"video_id": "mvlong", "views": 999, "duration_sec": 200},  # MV → 제외
        "rel2":   {"video_id": "rel2", "views": 7, "duration_sec": 40},
    }
    yt.fetch_stats.side_effect = lambda ids: [table[i] for i in ids if i in table]
    measure_challenge(yt, ch, "2026-05-26T00:00:00Z")
    assert ch.example_video_ids == ["rel1", "rel2"]       # 관련성 순서, MV 제외
    assert yt.search_shorts.call_args_list[1].kwargs.get("order") == "relevance"


def test_measure_challenge_empty_when_nothing_found():
    ch = Challenge(name="C", tag="dance", description="", origin="", hashtags=["#c"],
                   source_urls=[], confidence="low", miiwan_fit="",
                   candidate_video_ids=[])
    yt = MagicMock()
    yt.search_shorts.return_value = []      # 지표·폴백 모두 빈 결과
    yt.fetch_stats.return_value = []
    measure_challenge(yt, ch, "2026-05-26T00:00:00Z")
    assert ch.example_video_ids == []        # 그래도 없으면 링크 없음(프런트가 검색링크 보장)


_VID = "aaaaaaaaaaa"   # 실제 YouTube id 처럼 11자


def _pool_yt(pool_stats):
    """discover 의 broad 검색 + 측정용 yt mock. fetch_stats 는 항상 pool_stats 반환."""
    y = MagicMock()
    y.search_shorts.return_value = [_VID]
    y.fetch_stats.return_value = pool_stats
    return y


_POOL = [{"video_id": _VID, "title": "MEOVV - X 챌린지", "channel": "MEOVV",
          "views": 100000, "duration_sec": 30}]


def test_discover_sleeps_between_seeds():
    # burst 레이트리밋(429) 완화 — 시드 호출 사이에 간격을 둔다(마지막 제외).
    yt = MagicMock()
    yt.search_shorts.return_value = [_VID]
    yt.fetch_stats.return_value = [{"video_id": _VID, "views": 1, "duration_sec": 30}]
    slept: list[float] = []
    discover_candidate_videos(yt, _now(), sleep=slept.append)
    assert len(slept) == len(SEED_QUERIES) - 1


def test_pool_cap_raised_for_longtail():
    # V2 — 이미 모은 풀을 더 많이 LLM 에 전달(추가 API 호출 0). 롱테일 포착.
    assert POOL_CAP == 150


def test_run_logs_funnel_counts(caplog):
    # V2 관측성 — 어느 단계가 깎는지 다음 run 에서 확정하기 위한 카운트 로그.
    import logging
    gemini = MagicMock()
    gemini.generate.return_value = {"challenges": [
        {"name": "MEOVV - X 챌린지", "tag": "dance", "description": "d", "hashtags": ["#m"],
         "example_video_ids": [_VID], "confidence": "high", "miiwan_fit": "쉬움",
         "momentum": "rising"},
    ]}
    yt = _pool_yt(_POOL)
    d1 = MagicMock()
    with caplog.at_level(logging.INFO, logger="idol_sight.analysis.challenge_scan"):
        run_challenge_scan(gemini, yt, d1, now_epoch=_now())
    text = caplog.text
    assert "pool=" in text and "classified=" in text
    assert "pool_grounded=" in text and "selected=" in text


def test_run_discovers_classifies_and_writes():
    gemini = MagicMock()
    gemini.generate.return_value = {"challenges": [
        {"name": "MEOVV - X 챌린지", "tag": "dance", "description": "d", "hashtags": ["#m"],
         "example_video_ids": [_VID], "confidence": "high", "miiwan_fit": "쉬움",
         "momentum": "rising"},
    ]}
    yt = _pool_yt(_POOL)
    d1 = MagicMock()
    n = run_challenge_scan(gemini, yt, d1, now_epoch=_now())
    assert n == 1
    gemini.generate.assert_called_once()            # 분류 1회
    stmts = d1.batch.call_args[0][0]
    assert stmts[0][0].strip().upper().startswith("DELETE")
    ins = [p for s, p in stmts if "INSERT INTO weekly_challenges" in s][0]
    assert json.loads(ins[7]) == [_VID]             # 예시는 바이럴 풀의 영상


def test_run_skips_when_pool_empty():
    gemini = MagicMock()
    yt = MagicMock()
    yt.search_shorts.return_value = []
    yt.fetch_stats.return_value = []
    d1 = MagicMock()
    n = run_challenge_scan(gemini, yt, d1, now_epoch=_now())
    assert n == 0
    gemini.generate.assert_not_called()             # 풀 없으면 분류도 안 함
    d1.batch.assert_not_called()


def test_run_drops_challenge_not_grounded_in_pool():
    # 분류가 풀에 없는 video_id 를 가리키면 버린다(니치/환각 차단).
    gemini = MagicMock()
    gemini.generate.return_value = {"challenges": [
        {"name": "Fake - Y 챌린지", "tag": "dance", "hashtags": [],
         "example_video_ids": ["zzzzzzzzzzz"], "confidence": "low",
         "miiwan_fit": "", "momentum": "unknown"},
    ]}
    yt = _pool_yt(_POOL)
    d1 = MagicMock()
    n = run_challenge_scan(gemini, yt, d1, now_epoch=_now())
    assert n == 0
    d1.batch.assert_not_called()


def test_run_skips_on_classify_error():
    gemini = MagicMock()
    gemini.generate.side_effect = RuntimeError("classify boom")
    yt = _pool_yt(_POOL)
    d1 = MagicMock()
    n = run_challenge_scan(gemini, yt, d1, now_epoch=_now())
    assert n == 0
    d1.batch.assert_not_called()
