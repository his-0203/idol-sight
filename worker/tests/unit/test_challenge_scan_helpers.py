import json
from idol_sight.analysis.challenge_scan import (
    Challenge, parse_structured_challenges, week_start_kst, iso_days_ago,
    select_and_rank, build_upsert_statements, extract_video_id,
    build_discovery_prompt,
)


def test_parse_structured_challenges():
    payload = {"challenges": [
        {"name": "A", "tag": "kpop", "description": "d", "origin": "o",
         "hashtags": ["#a"],
         "source_urls": ["https://news.x/a", "[TF초점] 기사 제목 - Daum (2026)"],
         "confidence": "high", "miiwan_fit": "쉬움",
         "started_around": "2026-05-26경", "momentum": "rising",
         "valid_until": "~2026-06-12"},
        {"name": "B", "tag": "general", "description": "", "hashtags": [],
         "source_urls": [], "confidence": "low", "miiwan_fit": "",
         "momentum": "garbage"},
    ]}
    chs = parse_structured_challenges(payload)
    assert len(chs) == 2
    assert chs[0].name == "A" and chs[0].tag == "kpop"
    # source_urls: 실제 http URL 만, 기사 제목 문구는 버림 (깨진 링크 방지)
    assert chs[0].source_urls == ["https://news.x/a"]
    # 생애주기 파싱
    assert chs[0].started_around == "2026-05-26경"
    assert chs[0].momentum == "rising"
    assert chs[0].valid_until == "~2026-06-12"
    # 잘못된 momentum 값은 unknown 으로 정규화
    assert chs[1].momentum == "unknown"
    assert chs[1].origin == ""
    assert parse_structured_challenges({}) == []
    assert parse_structured_challenges({"challenges": "nope"}) == []


def test_build_discovery_prompt_injects_dates():
    import datetime as dt
    e = dt.datetime(2026, 6, 3, 5, 0, tzinfo=dt.timezone.utc).timestamp()  # KST 6/3
    p = build_discovery_prompt(e)
    assert "2026-06-03" in p        # 오늘
    assert "2026-05-27" in p        # 일주일 전
    assert "{today}" not in p       # 플레이스홀더가 모두 치환됨


def test_extract_video_id():
    assert extract_video_id("https://www.youtube.com/shorts/abcdefghijk") == "abcdefghijk"
    assert extract_video_id("https://youtu.be/12345678901") == "12345678901"
    assert extract_video_id("https://www.youtube.com/watch?v=ABCDEFGHIJK") == "ABCDEFGHIJK"
    assert extract_video_id("https://example.com/x") is None
    assert extract_video_id("") is None


def test_parse_extracts_example_urls_to_candidate_ids():
    payload = {"challenges": [{
        "name": "A", "tag": "kpop", "hashtags": [], "source_urls": [],
        "confidence": "high", "miiwan_fit": "",
        "example_urls": [
            "https://www.youtube.com/shorts/abcdefghijk",
            "https://youtu.be/12345678901",
            "https://example.com/not-youtube",                 # 파싱 안 됨 → 버림
            "https://www.youtube.com/shorts/abcdefghijk",      # 중복 → 제거
        ],
    }]}
    chs = parse_structured_challenges(payload)
    assert chs[0].candidate_video_ids == ["abcdefghijk", "12345678901"]
    # example_urls 없으면 후보 빈 리스트
    assert parse_structured_challenges(
        {"challenges": [{"name": "B", "tag": "general", "hashtags": [],
                         "source_urls": [], "confidence": "low", "miiwan_fit": ""}]}
    )[0].candidate_video_ids == []


def test_week_start_kst_monday():
    import datetime as dt
    e = dt.datetime(2026, 6, 2, 5, 0, tzinfo=dt.timezone.utc).timestamp()
    assert week_start_kst(e) == "2026-06-01"
    e2 = dt.datetime(2026, 6, 7, 22, 0, tzinfo=dt.timezone.utc).timestamp()
    assert week_start_kst(e2) == "2026-06-08"


def test_iso_days_ago():
    import datetime as dt
    e = dt.datetime(2026, 6, 8, 0, 0, tzinfo=dt.timezone.utc).timestamp()
    assert iso_days_ago(e, 7) == "2026-06-01T00:00:00Z"


def _ch(name, tag, views, shorts):
    c = Challenge(name=name, tag=tag, description="", origin="", hashtags=[],
                  source_urls=[], confidence="medium", miiwan_fit="")
    c.yt_total_views = views
    c.yt_recent_shorts = shorts
    return c


def test_select_and_rank_caps_per_tag_and_weights_kpop():
    chs = [
        _ch("k1", "kpop", 100, 10),
        _ch("k2", "kpop", 50, 5),
        _ch("g1", "general", 100, 10),
        _ch("g2", "general", 90, 9),
    ]
    sel = select_and_rank(chs, target_kpop=1, target_general=1)
    names = [c.name for c in sel]
    assert names == ["k1", "g1"]
    assert sel[0].rank == 1 and sel[1].rank == 2
    tie = select_and_rank([_ch("k", "kpop", 100, 10), _ch("g", "general", 100, 10)],
                          target_kpop=1, target_general=1)
    assert tie[0].name == "k"


def test_select_and_rank_unmeasured_sinks():
    measured = _ch("m", "general", 100, 10)
    un = _ch("u", "general", None, None)
    sel = select_and_rank([un, measured], target_kpop=5, target_general=5)
    assert sel[0].name == "m"


def test_build_upsert_statements_leads_with_delete():
    c = _ch("A", "kpop", 100, 10)
    c.rank = 1
    c.example_video_ids = ["v1"]
    stmts = build_upsert_statements("2026-06-01", [c], "2026-06-01T00:00:00Z")
    assert stmts[0][0].strip().upper().startswith("DELETE")
    assert stmts[0][1] == ["2026-06-01"]
    assert "INSERT INTO weekly_challenges" in stmts[1][0]
    params = stmts[1][1]
    assert json.loads(params[7]) == ["v1"]
