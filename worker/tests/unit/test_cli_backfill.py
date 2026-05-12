"""Tests for backfill_yt_videos_cmd freshness filter + checkpoint UPDATE.

The CLI is wrapped in a typer command; we test its core filter logic via a
helper extracted from the command. The helper takes the candidate targets +
a fresh-set query result and returns the filtered list.
"""

from unittest.mock import MagicMock

from idol_sight.cli import _filter_fresh_groups, _resolve_backfill_targets


def test_filter_fresh_groups_drops_groups_within_window():
    """Groups whose last_backfilled_at is within fresh_days are skipped."""
    candidates = ["plave", "isedol", "miiwan", "owis"]
    # plave + isedol returned by D1 as "recently backfilled"
    fresh_keys = {"plave", "isedol"}
    result = _filter_fresh_groups(candidates, fresh_keys)
    assert result == ["miiwan", "owis"]


def test_filter_fresh_groups_returns_all_when_none_fresh():
    """No fresh keys -> walk everyone."""
    candidates = ["plave", "isedol"]
    fresh_keys = set()
    assert _filter_fresh_groups(candidates, fresh_keys) == ["plave", "isedol"]


def test_filter_fresh_groups_preserves_order():
    """Output order matches input order (sorted KNOWN_GROUPS)."""
    candidates = ["bdawn", "isedol", "miiwan", "myrakl"]
    fresh_keys = {"miiwan"}
    assert _filter_fresh_groups(candidates, fresh_keys) == ["bdawn", "isedol", "myrakl"]


def test_resolve_backfill_targets_single_group_ignores_freshness():
    """When --group is given, freshness filter is bypassed (explicit intent)."""
    client = MagicMock()
    result = _resolve_backfill_targets(
        client, group="isedol", force=False, fresh_days=7,
    )
    assert result == ["isedol"]
    client.execute.assert_not_called()


def test_resolve_backfill_targets_all_groups_force_bypasses_freshness():
    """--force walks every group, no freshness query."""
    client = MagicMock()
    result = _resolve_backfill_targets(
        client, group=None, force=True, fresh_days=7,
    )
    assert result == sorted(["plave", "isedol", "stellive", "skinz",
                              "myrakl", "miiwan", "owis", "bdawn", "wegosix"])
    client.execute.assert_not_called()


def test_resolve_backfill_targets_all_groups_freshness_filters():
    """Default mode (no group, no force, fresh_days>0) queries DB and
    skips fresh groups."""
    client = MagicMock()
    client.execute.return_value = [{"key": "isedol"}, {"key": "plave"}]
    result = _resolve_backfill_targets(
        client, group=None, force=False, fresh_days=7,
    )
    assert "isedol" not in result
    assert "plave" not in result
    assert "miiwan" in result
    assert client.execute.called
    call_sql = client.execute.call_args[0][0]
    assert "last_backfilled_at" in call_sql
    assert "julianday" in call_sql


def test_resolve_backfill_targets_fresh_days_zero_means_walk_all():
    """fresh_days=0 means 'no skip', same effect as --force."""
    client = MagicMock()
    result = _resolve_backfill_targets(
        client, group=None, force=False, fresh_days=0,
    )
    assert len(result) == 9
    client.execute.assert_not_called()
