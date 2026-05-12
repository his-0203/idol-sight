"""Tests for backfill_yt_videos_cmd freshness filter + checkpoint UPDATE.

The CLI is wrapped in a typer command; we test its core filter logic via a
helper extracted from the command. The helper takes the candidate targets +
a fresh-set query result and returns the filtered list.
"""

import pytest

from idol_sight.cli import _filter_fresh_groups


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
