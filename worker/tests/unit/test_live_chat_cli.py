from idol_sight.cli import (
    _load_live_chat_candidates,
    _load_report_targets,
    _load_stored_messages,
)


class _FakeD1:
    def __init__(self, rows):
        self.rows = rows
        self.queries = []

    def execute(self, sql, params=None):
        self.queries.append((sql, params))
        return self.rows


def test_candidates_query_filters_group_window_and_done():
    d1 = _FakeD1([{"video_id": "a"}, {"video_id": "b"}])
    out = _load_live_chat_candidates(d1, group_key="miiwan", since="2026-06-13T04:00:00Z")
    assert out == ["a", "b"]
    sql, params = d1.queries[0]
    assert "live_ccv_samples" in sql
    assert "NOT IN (SELECT video_id FROM live_chat_reports)" in sql
    assert params == ["miiwan", "2026-06-13T04:00:00Z"]


def test_candidates_skips_null_video_ids():
    d1 = _FakeD1([{"video_id": "a"}, {"video_id": None}])
    out = _load_live_chat_candidates(d1, group_key="miiwan", since="2026-06-13T04:00:00Z")
    assert out == ["a"]


def test_report_targets_all_for_group():
    d1 = _FakeD1([{"video_id": "a", "title": "T", "ended_at": "2026-06-16T01:00:00Z"}])
    out = _load_report_targets(d1, group_key="miiwan", video_id=None)
    assert out == [{"video_id": "a", "title": "T", "ended_at": "2026-06-16T01:00:00Z"}]
    sql, params = d1.queries[0]
    assert "FROM live_chat_reports" in sql and "group_key" in sql
    assert params == ["miiwan"]


def test_report_targets_single_video():
    d1 = _FakeD1([{"video_id": "a", "title": "T", "ended_at": None}])
    out = _load_report_targets(d1, group_key="miiwan", video_id="a")
    assert [r["video_id"] for r in out] == ["a"]
    sql, params = d1.queries[0]
    assert "video_id = ?" in sql
    assert params == ["miiwan", "a"]


def test_stored_messages_shape_and_order():
    d1 = _FakeD1([
        {"msg_id": "m1", "offset_ms": 2000, "author": "u", "message": "둘"},
        {"msg_id": "m0", "offset_ms": 1000, "author": "u", "message": "하나"},
    ])
    out = _load_stored_messages(d1, video_id="a")
    assert out == [
        {"msg_id": "m1", "offset_ms": 2000, "author": "u", "message": "둘"},
        {"msg_id": "m0", "offset_ms": 1000, "author": "u", "message": "하나"},
    ]
    sql, params = d1.queries[0]
    assert "FROM live_chat_messages" in sql and "ORDER BY offset_ms" in sql
    assert params == ["a"]
