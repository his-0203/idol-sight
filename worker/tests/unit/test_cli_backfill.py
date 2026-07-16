"""Tests for backfill_yt_videos_cmd freshness filter + checkpoint UPDATE.

The CLI is wrapped in a typer command; we test its core filter logic via a
helper extracted from the command. The helper takes the candidate targets +
a fresh-set query result and returns the filtered list.
"""

from unittest.mock import MagicMock

from idol_sight.cli import (
    _filter_fresh_groups,
    _resolve_backfill_targets,
    backfill_targets_cmd,
)


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
                              "myrakl", "miiwan", "owis", "bdawn", "wegosix",
                              "uryael", "bthd", "hollin", "begritz"])
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
    assert len(result) == 13
    client.execute.assert_not_called()


def test_backfill_targets_cmd_single_group_emits_single_element_array(capsys, monkeypatch):
    """--group=isedol → ["isedol"] regardless of freshness."""
    client = MagicMock()
    monkeypatch.setattr("idol_sight.cli._make_d1_client", lambda settings: client)
    monkeypatch.setattr("idol_sight.cli.load_settings", lambda: MagicMock())
    backfill_targets_cmd(group="isedol", force=False, fresh_days=7)
    out = capsys.readouterr().out.strip()
    assert out == '["isedol"]'


def test_backfill_targets_cmd_all_filters_fresh(capsys, monkeypatch):
    """group='all' applies freshness filter — fresh groups dropped from JSON."""
    client = MagicMock()
    client.execute.return_value = [{"key": "miiwan"}, {"key": "owis"}]
    monkeypatch.setattr("idol_sight.cli._make_d1_client", lambda settings: client)
    monkeypatch.setattr("idol_sight.cli.load_settings", lambda: MagicMock())
    backfill_targets_cmd(group="all", force=False, fresh_days=7)
    import json as _json
    out = _json.loads(capsys.readouterr().out.strip())
    assert "miiwan" not in out
    assert "owis" not in out
    assert "plave" in out
    assert len(out) == 11   # 13 KNOWN_GROUPS − 2 fresh


def test_backfill_targets_cmd_force_returns_all(capsys, monkeypatch):
    """--force bypasses freshness regardless of D1 state."""
    client = MagicMock()
    monkeypatch.setattr("idol_sight.cli._make_d1_client", lambda settings: client)
    monkeypatch.setattr("idol_sight.cli.load_settings", lambda: MagicMock())
    backfill_targets_cmd(group="all", force=True, fresh_days=7)
    import json as _json
    out = _json.loads(capsys.readouterr().out.strip())
    assert len(out) == 13
    client.execute.assert_not_called()


def test_backfill_targets_force_all_matches_known_groups_exactly(capsys, monkeypatch):
    """Regression guard: backfill-targets --group=all --force must return
    every KNOWN_GROUPS member. If someone adds a new group key in
    cli.py KNOWN_GROUPS without updating the workflow, this would still
    pass (matrix is dynamic now), but if someone narrows the CLI's
    candidate set, this catches it."""
    from idol_sight.cli import KNOWN_GROUPS
    client = MagicMock()
    monkeypatch.setattr("idol_sight.cli._make_d1_client", lambda settings: client)
    monkeypatch.setattr("idol_sight.cli.load_settings", lambda: MagicMock())
    backfill_targets_cmd(group="all", force=True, fresh_days=7)
    import json as _json
    out = set(_json.loads(capsys.readouterr().out.strip()))
    assert out == KNOWN_GROUPS
