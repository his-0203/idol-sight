from idol_sight.cli import _load_live_chat_candidates


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
