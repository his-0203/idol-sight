"""Tests for analysis.yt_history_backfill."""

from idol_sight.analysis.yt_history_backfill import backfill_yt_history


class _FakeClient:
    def __init__(self, rows):
        self._rows = rows
        self.calls: list[tuple[str, list]] = []

    def execute(self, sql, params=None):
        self.calls.append((sql, params or []))
        return self._rows


def test_backfill_forward_fills_calendar_days_between_publications():
    """Same-day videos collapse to a single (videos, views) value, then
    that cumulative state is forward-filled across every calendar day
    until the next publication updates it. 2023-03-12 → 2023-04-01 is
    21 inclusive days, so we expect 21 rows: the first carrying the
    debut-day state (2 videos, 1.5M views), the last carrying the
    post-2nd-publication state (3 videos, 1.7M views)."""
    rows = [
        # debut day
        {"group_key": "plave", "pub_date": "2023-03-12", "views": 1_000_000},
        # second drop same day
        {"group_key": "plave", "pub_date": "2023-03-12", "views":   500_000},
        {"group_key": "plave", "pub_date": "2023-04-01", "views":   200_000},
    ]
    client = _FakeClient(rows)
    result = backfill_yt_history(client)

    # 31 - 12 + 1 = 20 March days from the 12th + 1 April day = 21.
    assert len(result.statements) == 21
    sql_a, params_a = result.statements[0]
    _,     params_z = result.statements[-1]
    assert "INSERT INTO agg_summary" in sql_a
    # Forward-fill is idempotent via UPDATE WHERE data_source clause.
    assert "ON CONFLICT(group_key, snapshot_at) DO UPDATE" in sql_a
    assert "data_source = 'backfill_estimate'" in sql_a

    # Debut day end-of-day state: 2 videos, sum 1.5M.
    assert params_a == ["plave", "2023-03-12T00:00:00Z", 2, 1_500_000]
    # Post-2nd-publication state: 3 videos, sum 1.7M.
    assert params_z == ["plave", "2023-04-01T00:00:00Z", 3, 1_700_000]

    # Mid-stretch row should carry the forward-filled debut state.
    mid = next(p for _s, p in result.statements
               if p[1] == "2023-03-20T00:00:00Z")
    assert mid == ["plave", "2023-03-20T00:00:00Z", 2, 1_500_000]


def test_backfill_handles_multiple_groups_independently():
    """Per-group cumulative counters reset across groups, and each
    group's forward-fill window is bounded by its own first/last
    publication — isedol with a single date contributes a single row,
    plave with two dates expands to a 21-day forward-fill."""
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
    assert len(by_group["plave"]) == 21         # 2023-03-12 → 2023-04-01
    assert len(by_group["isedol"]) == 1         # single publication
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
