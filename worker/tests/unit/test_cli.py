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


def test_collect_known_source_returns_0():
    res = runner.invoke(app, ["collect", "--source", "naver", "--group", "plave"])
    assert res.exit_code == 0
    assert "not yet implemented" in res.output.lower()


def test_notify_fail_requires_job():
    res = runner.invoke(app, ["notify-fail"])
    assert res.exit_code != 0
