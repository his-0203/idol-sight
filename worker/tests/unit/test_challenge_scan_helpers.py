import json
from idol_sight.analysis.challenge_scan import (
    Challenge, parse_structured_challenges, week_start_kst, iso_days_ago,
    select_and_rank, build_upsert_statements,
)


def test_parse_structured_challenges():
    payload = {"challenges": [
        {"name": "A", "tag": "kpop", "description": "d", "origin": "o",
         "hashtags": ["#a"], "source_urls": ["http://x"], "confidence": "high",
         "miiwan_fit": "쉬움"},
        {"name": "B", "tag": "general", "description": "", "hashtags": [],
         "source_urls": [], "confidence": "low", "miiwan_fit": ""},
    ]}
    chs = parse_structured_challenges(payload)
    assert len(chs) == 2
    assert chs[0].name == "A" and chs[0].tag == "kpop"
    assert chs[1].origin == ""
    assert parse_structured_challenges({}) == []
    assert parse_structured_challenges({"challenges": "nope"}) == []


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
