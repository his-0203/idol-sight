"""Tests for V2.24 1회성 백필 (guyso.me archive).

build_backfill_statements / daterange / _parse_guyso_payload 의 매칭·필터·
synthetic snapshot_at 동작을 검증. fetch_guyso_daily 자체는 외부 HTTP라
테스트하지 않고 _parse_guyso_payload 만 검증.
"""

import json

import pytest

from idol_sight.collectors.melon_backfill import (
    _parse_guyso_payload,
    build_backfill_statements,
    daterange,
)


def _next_data_html(entries: list[dict]) -> str:
    """Synthesize a guyso.me-shaped __NEXT_DATA__ blob."""
    payload = {
        "props": {
            "pageProps": {
                "data": {
                    "date": "20260515",
                    "time": "2026-05-15T00:00:00",
                    "data": entries,
                }
            }
        }
    }
    return (
        '<script id="__NEXT_DATA__" type="application/json">'
        f"{json.dumps(payload)}"
        "</script>"
    )


def _entry(rank: int, sid: str, title: str, artists: list[str]) -> dict:
    return {
        "ranking": rank,
        "song": {
            "id": sid,
            "name": title,
            "artists": [{"name": a} for a in artists],
        },
    }


_PLAVE = {"key": "plave", "name": "PLAVE", "name_kr": "플레이브"}
_ISEDOL = {"key": "isedol", "name": "ISEGYE IDOL", "name_kr": "이세계아이돌"}


def test_parse_guyso_payload_extracts_normalized_rows():
    html = _next_data_html([
        _entry(1, "601719413", "소문의 낙원", ["AKMU (악뮤)"]),
        _entry(115, "601759751", "Born Savage", ["PLAVE"]),
    ])
    rows = _parse_guyso_payload(html)
    assert rows is not None
    assert len(rows) == 2
    r = rows[1]
    assert r["rank"] == 115
    assert r["song_id"] == "601759751"
    assert r["song_title"] == "Born Savage"
    assert r["artists"] == ["PLAVE"]


def test_parse_guyso_payload_returns_none_on_no_next_data():
    assert _parse_guyso_payload("<html>no next data</html>") is None


def test_parse_guyso_payload_returns_none_on_bad_json():
    bad = '<script id="__NEXT_DATA__" type="application/json">not json</script>'
    assert _parse_guyso_payload(bad) is None


def test_parse_guyso_payload_skips_entries_without_song_id():
    html = _next_data_html([
        {"ranking": 1, "song": {"id": None, "name": "x", "artists": []}},
        _entry(2, "999", "ok", ["A"]),
    ])
    rows = _parse_guyso_payload(html)
    assert rows == [{"rank": 2, "song_id": "999",
                     "song_title": "ok", "artists": ["A"]}]


def test_daterange_inclusive_ascending():
    assert daterange("2026-05-15", "2026-05-17") == [
        "2026-05-15", "2026-05-16", "2026-05-17",
    ]


def test_daterange_single_day():
    assert daterange("2026-05-15", "2026-05-15") == ["2026-05-15"]


def test_daterange_rejects_inverted_range():
    with pytest.raises(ValueError):
        daterange("2026-05-17", "2026-05-15")


def test_build_backfill_matches_seeded_groups_only():
    rows = [
        {"rank": 1, "song_id": "1", "song_title": "x", "artists": ["AKMU"]},
        {"rank": 5, "song_id": "2", "song_title": "Born Savage",
         "artists": ["PLAVE"]},
        {"rank": 9, "song_id": "3", "song_title": "다른노래",
         "artists": ["이세계아이돌"]},
    ]
    stmts = build_backfill_statements(
        "2026-05-15", rows, [_PLAVE, _ISEDOL], top_n=100,
    )
    # 1 PLAVE row + 1 ISEDOL row = 2 INSERTs; AKMU not seeded.
    assert len(stmts) == 2
    sids = {p[2] for _, p in stmts}
    assert sids == {"2", "3"}


def test_build_backfill_filters_top_n():
    rows = [
        {"rank": 50, "song_id": "A", "song_title": "in",  "artists": ["PLAVE"]},
        {"rank": 150, "song_id": "B", "song_title": "out", "artists": ["PLAVE"]},
    ]
    stmts = build_backfill_statements(
        "2026-05-15", rows, [_PLAVE], top_n=100,
    )
    assert len(stmts) == 1
    assert stmts[0][1][2] == "A"


def test_build_backfill_synthetic_snapshot_at_is_deterministic():
    rows = [{"rank": 1, "song_id": "A", "song_title": "x",
             "artists": ["PLAVE"]}]
    stmts1 = build_backfill_statements("2026-05-15", rows, [_PLAVE])
    stmts2 = build_backfill_statements("2026-05-15", rows, [_PLAVE])
    assert stmts1[0][1][0] == stmts2[0][1][0]
    assert stmts1[0][1][0] == "2026-05-15T00:00:00Z"


def test_build_backfill_chart_date_passed_through():
    rows = [{"rank": 1, "song_id": "A", "song_title": "x",
             "artists": ["PLAVE"]}]
    stmts = build_backfill_statements("2026-05-15", rows, [_PLAVE])
    # params layout: [snap, key, sid, title, rank, chart_date]
    assert stmts[0][1][5] == "2026-05-15"


def test_build_backfill_dedup_same_song_takes_best_rank():
    """동일 song_id가 여러 rank로 나타나면 최저(best) rank로 dedup."""
    rows = [
        {"rank": 50, "song_id": "A", "song_title": "x", "artists": ["PLAVE"]},
        {"rank": 10, "song_id": "A", "song_title": "x", "artists": ["PLAVE"]},
    ]
    stmts = build_backfill_statements("2026-05-15", rows, [_PLAVE])
    assert len(stmts) == 1
    # params: [snap, key, sid, title, rank, chart_date]
    assert stmts[0][1][4] == 10


def test_build_backfill_uses_daily_source_sql_literal():
    rows = [{"rank": 1, "song_id": "A", "song_title": "x",
             "artists": ["PLAVE"]}]
    stmts = build_backfill_statements("2026-05-15", rows, [_PLAVE])
    sql = stmts[0][0]
    assert "'daily'" in sql
    assert "ON CONFLICT" in sql
