from unittest.mock import patch
from typer.testing import CliRunner
from idol_sight.cli import app

runner = CliRunner()


@patch("idol_sight.cli.run_challenge_scan", return_value=5)
@patch("idol_sight.cli._make_d1_client")
@patch("idol_sight.cli.YouTubeCollector")
@patch("idol_sight.cli.GeminiClient")
def test_challenge_scan_invokes_run(gem, yt, d1, run, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "g")
    monkeypatch.setenv("YT_API_KEY", "y")
    res = runner.invoke(app, ["challenge-scan"])
    assert res.exit_code == 0, res.output
    assert "5" in res.output
    run.assert_called_once()
