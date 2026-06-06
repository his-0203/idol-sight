"""Unit tests for the ``aggregate`` CLI command's skip-derived branch.

Background: 2nd aggregate in the collect-daily/melon-chart sandwich was
running velocity (~4m), combined (~25s), and reactivity (~30s) AGAIN
even though none of them depend on the melon-chart UPDATE that ran in
between. The sandwich's only job is to re-upsert agg_summary (so the
COALESCE preserves melon) and recompute health_scores. Adding
``--skip-derived`` lets the 2nd run skip those middle three stages and
cuts a ~5min run down to <30s, eliminating chronic 10-min timeouts.
"""

from unittest.mock import MagicMock, patch

from idol_sight.cli import _recompute_health_scores, _run_aggregate


def _cohort_read_params(client):
    """The params of the agg_summary cohort read inside _recompute_health_scores."""
    for c in client.execute.call_args_list:
        if "FROM agg_summary WHERE snapshot_at = ?" in c.args[0]:
            return c.args[1]
    return None


def test_recompute_health_reads_cohort_at_passed_snap():
    """Regression: the cohort must be read at the snapshot being written, not
    MAX(snapshot_at) — otherwise a backfill/replay scores the historical snap
    row with the latest cohort."""
    client = MagicMock()
    client.execute.return_value = []
    _recompute_health_scores(client, "2026-01-01T00:00:00Z")
    assert _cohort_read_params(client) == ["2026-01-01T00:00:00Z"]


def test_recompute_health_read_snap_overrides_cohort_source():
    """analyze_weekly writes at a fresh weekly snap but reads the latest daily
    cohort — read_snap decouples the read snapshot from the write snapshot."""
    client = MagicMock()
    client.execute.return_value = []
    _recompute_health_scores(client, "WRITE_SNAP", read_snap="READ_SNAP")
    assert _cohort_read_params(client) == ["READ_SNAP"]


def _stub_build_result(statements=None):
    result = MagicMock()
    result.statements = statements or []
    return result


def _make_client():
    client = MagicMock()
    client.batch.return_value = MagicMock(
        statements_executed=0, statements_sent=0,
    )
    return client


@patch("idol_sight.cli._recompute_health_scores", return_value=9)
@patch("idol_sight.analysis.platform_reactivity.compute_reactivity")
@patch("idol_sight.analysis.video_velocity.compute_velocity")
@patch("idol_sight.analysis.group_combined.build_agg_group_combined")
@patch("idol_sight.analysis.agg_summary.build_agg_summary")
def test_skip_derived_skips_combined_velocity_reactivity(
    mock_summary, mock_combined, mock_velocity, mock_reactivity, mock_health,
):
    mock_summary.return_value = _stub_build_result()
    mock_combined.return_value = _stub_build_result()
    mock_velocity.return_value = _stub_build_result()
    mock_reactivity.return_value = []
    client = _make_client()

    _run_aggregate(client, snap="2026-05-12T00:00:00Z", skip_derived=True)

    mock_summary.assert_called_once()
    mock_health.assert_called_once_with(client, "2026-05-12T00:00:00Z")
    mock_combined.assert_not_called()
    mock_velocity.assert_not_called()
    mock_reactivity.assert_not_called()


@patch("idol_sight.cli._recompute_health_scores", return_value=9)
@patch("idol_sight.analysis.platform_reactivity.compute_reactivity")
@patch("idol_sight.analysis.video_velocity.compute_velocity")
@patch("idol_sight.analysis.group_combined.build_agg_group_combined")
@patch("idol_sight.analysis.agg_summary.build_agg_summary")
def test_default_runs_all_stages(
    mock_summary, mock_combined, mock_velocity, mock_reactivity, mock_health,
):
    mock_summary.return_value = _stub_build_result()
    mock_combined.return_value = _stub_build_result()
    mock_velocity.return_value = _stub_build_result()
    mock_reactivity.return_value = []
    client = _make_client()

    _run_aggregate(client, snap="2026-05-12T00:00:00Z")

    mock_summary.assert_called_once()
    mock_combined.assert_called_once()
    mock_velocity.assert_called_once()
    mock_reactivity.assert_called_once()
    mock_health.assert_called_once_with(client, "2026-05-12T00:00:00Z")


@patch("idol_sight.cli._recompute_health_scores", return_value=9)
@patch("idol_sight.analysis.debut_window.build_summary")
@patch("idol_sight.analysis.debut_window.build_video_organicity")
@patch("idol_sight.analysis.platform_reactivity.compute_reactivity")
@patch("idol_sight.analysis.video_velocity.compute_velocity")
@patch("idol_sight.analysis.group_combined.build_agg_group_combined")
@patch("idol_sight.analysis.agg_summary.build_agg_summary")
def test_default_runs_debut_window_stages(
    mock_summary, mock_combined, mock_velocity, mock_reactivity,
    mock_dw_video, mock_dw_summary, mock_health,
):
    mock_summary.return_value = _stub_build_result()
    mock_combined.return_value = _stub_build_result()
    mock_velocity.return_value = _stub_build_result()
    mock_reactivity.return_value = []
    mock_dw_video.return_value = _stub_build_result()
    mock_dw_summary.return_value = _stub_build_result()
    client = _make_client()

    _run_aggregate(client, snap="2026-05-12T00:00:00Z")

    mock_dw_video.assert_called_once_with(client)
    mock_dw_summary.assert_called_once_with(client)


@patch("idol_sight.cli._recompute_health_scores", return_value=9)
@patch("idol_sight.analysis.debut_window.build_summary")
@patch("idol_sight.analysis.debut_window.build_video_organicity")
@patch("idol_sight.analysis.platform_reactivity.compute_reactivity")
@patch("idol_sight.analysis.video_velocity.compute_velocity")
@patch("idol_sight.analysis.group_combined.build_agg_group_combined")
@patch("idol_sight.analysis.agg_summary.build_agg_summary")
def test_skip_derived_skips_debut_window_stages(
    mock_summary, mock_combined, mock_velocity, mock_reactivity,
    mock_dw_video, mock_dw_summary, mock_health,
):
    mock_summary.return_value = _stub_build_result()
    client = _make_client()

    _run_aggregate(client, snap="2026-05-12T00:00:00Z", skip_derived=True)

    mock_dw_video.assert_not_called()
    mock_dw_summary.assert_not_called()
