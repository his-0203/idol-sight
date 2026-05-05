from typer.testing import CliRunner

from idol_sight.cli import app

runner = CliRunner()


def test_collect_subcommand_exists():
    res = runner.invoke(app, ["collect", "--help"])
    assert res.exit_code == 0
    assert "source" in res.output.lower()
    assert "group" in res.output.lower()


def test_collect_unknown_source_returns_2():
    res = runner.invoke(app, ["collect", "--source", "BADSOURCE", "--group", "plave"])
    assert res.exit_code == 2
    assert "unknown source" in res.output.lower()


def test_collect_naver_dispatches_orchestrator(monkeypatch):
    """`collect --source naver --group plave` constructs NaverCollector,
    loads GroupConfig from D1, runs orchestrator, and exits 0."""
    from unittest.mock import MagicMock

    import idol_sight.cli as cli

    fake_group = MagicMock(name="GroupConfig", key="plave")
    monkeypatch.setattr(cli, "_load_group", lambda client, key: fake_group)
    monkeypatch.setattr(cli, "_make_d1_client", lambda settings: MagicMock())
    monkeypatch.setattr(cli, "_make_collector",
                        lambda src: MagicMock(source=src))
    monkeypatch.setattr(cli, "load_settings", lambda: MagicMock())

    fake_summary = MagicMock(status="ok", rows_inserted=10, rows_updated=0,
                             runtime_ms=123, error_msg=None)
    run_called = MagicMock(return_value=fake_summary)
    monkeypatch.setattr(cli, "run_collector", run_called)

    res = runner.invoke(app, ["collect", "--source", "naver", "--group", "plave"])
    assert res.exit_code == 0
    run_called.assert_called_once()


def test_collect_failure_exits_nonzero(monkeypatch):
    from unittest.mock import MagicMock

    import idol_sight.cli as cli

    fake_group = MagicMock(name="GroupConfig", key="plave")
    monkeypatch.setattr(cli, "_load_group", lambda client, key: fake_group)
    monkeypatch.setattr(cli, "_make_d1_client", lambda settings: MagicMock())
    monkeypatch.setattr(cli, "_make_collector",
                        lambda src: MagicMock(source=src))
    monkeypatch.setattr(cli, "load_settings", lambda: MagicMock())
    fake_summary = MagicMock(status="failed", rows_inserted=0, rows_updated=0,
                             runtime_ms=200, error_msg="cloudflare")
    monkeypatch.setattr(cli, "run_collector", lambda *a, **kw: fake_summary)

    res = runner.invoke(app, ["collect", "--source", "naver", "--group", "plave"])
    assert res.exit_code == 1


def test_notify_fail_requires_job():
    res = runner.invoke(app, ["notify-fail"])
    assert res.exit_code != 0


def test_collect_youtube_dispatches_youtube_collector(monkeypatch):
    from unittest.mock import MagicMock

    import idol_sight.cli as cli

    fake_group = MagicMock(name="GroupConfig", key="plave")
    monkeypatch.setattr(cli, "_load_group", lambda c, k: fake_group)
    monkeypatch.setattr(cli, "_make_d1_client", lambda s: MagicMock())
    monkeypatch.setattr(cli, "_make_collector", lambda src: MagicMock(source=src))

    fake_summary = MagicMock(status="ok", rows_inserted=10, rows_updated=0,
                             runtime_ms=200, error_msg=None)
    monkeypatch.setattr(cli, "run_collector", lambda *a, **kw: fake_summary)

    res = runner.invoke(app, ["collect", "--source", "youtube", "--group", "plave"])
    assert res.exit_code == 0


def test_analyze_weekly_subcommand_present():
    res = runner.invoke(app, ["analyze-weekly", "--help"])
    assert res.exit_code == 0
    assert "weekly" in res.output.lower()
