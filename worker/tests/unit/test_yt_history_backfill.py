"""Tests for analysis.yt_history_backfill."""

from idol_sight.analysis.yt_history_backfill import backfill_yt_history


class _FakeClient:
    def __init__(self, rows):
        self._rows = rows
        self.calls: list[tuple[str, list]] = []

    def execute(self, sql, params=None):
        self.calls.append((sql, params or []))
        return self._rows


def test_backfill_emits_one_row_per_unique_publication_date():
    """Two videos on the same date should collapse to a single
    agg_summary row carrying the cumulative count + view sum at end
    of day. Videos across different dates should each produce their
    own row, with the cumulative state monotonically growing."""
    rows = [
        # debut day
        {"group_key": "plave", "pub_date": "2023-03-12", "views": 1_000_000},
        # second drop same day
        {"group_key": "plave", "pub_date": "2023-03-12", "views":   500_000},
        {"group_key": "plave", "pub_date": "2023-04-01", "views":   200_000},
    ]
    client = _FakeClient(rows)
    result = backfill_yt_history(client)

    assert len(result.statements) == 2
    sql_a, params_a = result.statements[0]
    sql_b, params_b = result.statements[1]
    assert "INSERT INTO agg_summary" in sql_a
    assert "ON CONFLICT(group_key, snapshot_at) DO NOTHING" in sql_a

    # Day 1: 2 videos, sum 1.5M views.
    assert params_a == ["plave", "2023-03-12T00:00:00Z", 2, 1_500_000]
    # Day 2: 3 videos cumulative, sum 1.7M views.
    assert params_b == ["plave", "2023-04-01T00:00:00Z", 3, 1_700_000]


def test_backfill_handles_multiple_groups_independently():
    rows = [
        {"group_key": "plave",  "pub_date": "2023-03-12", "views": 1_000_000},
        {"group_key": "isedol", "pub_date": "2021-12-17", "views":   500_000},
        {"group_key": "plave",  "pub_date": "2023-04-01", "views":   200_000},
    ]
    client = _FakeClient(rows)
    result = backfill_yt_history(client)

    by_group: dict[str, list] = {}
    for _sql, params in result.statements:
        by_group.setdefault(params[0], []).append(params)
    assert set(by_group.keys()) == {"plave", "isedol"}
    assert len(by_group["plave"]) == 2
    assert len(by_group["isedol"]) == 1
    # Per-group cumulative counters reset across groups.
    assert by_group["isedol"][0][2] == 1                  # cum_videos
    assert by_group["isedol"][0][3] == 500_000            # cum_views


def test_backfill_skips_videos_without_publication_date():
    """Rows whose published_at was NULL or empty should be excluded
    from the cumulative walk — otherwise the count would inflate by
    rows with no anchor in time."""
    rows = [
        {"group_key": "plave", "pub_date": "2023-03-12", "views": 1_000_000},
        {"group_key": "plave", "pub_date": None,         "views":   400_000},
        {"group_key": "plave", "pub_date": "",           "views":   400_000},
    ]
    client = _FakeClient(rows)
    result = backfill_yt_history(client)

    assert len(result.statements) == 1
    _, params = result.statements[0]
    assert params == ["plave", "2023-03-12T00:00:00Z", 1, 1_000_000]


def test_backfill_zero_views_when_stats_missing():
    """A video that's been seen by the videos collector but never had
    its stats refreshed should contribute 0 views to the cumulative
    sum, not None or NaN."""
    rows = [
        {"group_key": "miiwan", "pub_date": "2026-05-01", "views": 0},
        {"group_key": "miiwan", "pub_date": "2026-05-01", "views": None},
    ]
    client = _FakeClient(rows)
    result = backfill_yt_history(client)

    assert len(result.statements) == 1
    _, params = result.statements[0]
    assert params[2] == 2                                 # cum_videos
    assert params[3] == 0                                 # cum_views


def test_backfill_emits_no_rows_for_empty_input():
    client = _FakeClient([])
    result = backfill_yt_history(client)
    assert result.statements == []
    assert result.rows_inserted == 0
