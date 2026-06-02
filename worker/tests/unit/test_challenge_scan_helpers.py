import json
from idol_sight.analysis.challenge_scan import (
    Challenge, parse_structured_challenges, week_start_kst, iso_days_ago,
    select_and_rank, build_upsert_statements, extract_video_id,
    search_query_for,
)


def test_search_query_for_strips_operators():
    # '-'(YouTube 제외 연산자)·따옴표·괄호 제거 → '가수명 곡명 챌린지' 평문
    assert search_query_for('최예나 - "Catch Catch" 챌린지', "dance") == "최예나 Catch Catch 챌린지"
    assert (search_query_for("tripleS (트리플에스) - 'Baby Flower'", "dance")
            == "tripleS 트리플에스 Baby Flower 챌린지")
    assert search_query_for("거제 야호", "meme") == "거제 야호"   # 밈은 챌린지 미부착


def test_parse_structured_challenges():
    payload = {"challenges": [
        {"name": "A", "tag": "dance", "description": "d", "origin": "o",
         "hashtags": ["#a"],
         "source_urls": ["https://news.x/a", "[TF초점] 기사 제목 - Daum (2026)"],
         "confidence": "high", "miiwan_fit": "쉬움",
         "started_around": "2026-05-26경", "momentum": "rising",
         "valid_until": "~2026-06-12"},
        {"name": "B", "tag": "garbage_tag", "description": "", "hashtags": [],
         "source_urls": [], "confidence": "low", "miiwan_fit": "",
         "momentum": "garbage"},
    ]}
    chs = parse_structured_challenges(payload)
    assert len(chs) == 2
    assert chs[0].name == "A" and chs[0].tag == "dance"
    assert chs[1].tag == "dance"   # 알 수 없는 tag → dance 기본
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


def test_parse_reads_example_video_ids():
    # 분류(B)는 example_video_ids 로 raw id 를 준다 → candidate_video_ids.
    payload = {"challenges": [{
        "name": "G - S 챌린지", "tag": "dance", "hashtags": [], "source_urls": [],
        "confidence": "high", "miiwan_fit": "",
        "example_video_ids": ["abcdefghijk", "bad", "12345678901", "abcdefghijk"],
    }]}
    chs = parse_structured_challenges(payload)
    assert chs[0].candidate_video_ids == ["abcdefghijk", "12345678901"]  # 11자만, 중복 제거


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
        {"challenges": [{"name": "B", "tag": "meme", "hashtags": [],
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


def test_select_and_rank_guarantees_memes():
    # 밈은 조회수 낮아도 min_meme 만큼 보장. 댄스가 나머지. 전체 score 순 랭크.
    chs = [
        _ch("d1", "dance", 1000, 50),
        _ch("d2", "dance", 800, 40),
        _ch("d3", "dance", 600, 30),
        _ch("m1", "meme", 10, 1),
        _ch("m2", "meme", 5, 1),
    ]
    sel = select_and_rank(chs, total=4, min_meme=2)
    names = {c.name for c in sel}
    assert len(sel) == 4
    assert "m1" in names and "m2" in names      # 밈 2개 보장
    assert "d1" in names                          # 상위 댄스 포함
    assert sel[0].name == "d1"                    # 랭크는 score 순
    assert sel[0].rank == 1 and sel[-1].rank == len(sel)


def test_select_and_rank_total_cap_no_memes():
    chs = [_ch(f"d{i}", "dance", 100 - i, 10) for i in range(8)]
    sel = select_and_rank(chs, total=5, min_meme=3)   # 밈 없음 → 댄스 top5
    assert [c.name for c in sel] == ["d0", "d1", "d2", "d3", "d4"]


def test_select_and_rank_unmeasured_sinks():
    measured = _ch("m", "dance", 100, 10)
    un = _ch("u", "dance", None, None)
    sel = select_and_rank([un, measured], total=10, min_meme=3)
    assert sel[0].name == "m"


def test_build_upsert_statements_leads_with_delete():
    c = _ch("A", "dance", 100, 10)
    c.rank = 1
    c.example_video_ids = ["v1"]
    stmts = build_upsert_statements("2026-06-01", [c], "2026-06-01T00:00:00Z")
    assert stmts[0][0].strip().upper().startswith("DELETE")
    assert stmts[0][1] == ["2026-06-01"]
    assert "INSERT INTO weekly_challenges" in stmts[1][0]
    params = stmts[1][1]
    assert json.loads(params[7]) == ["v1"]
