# /Users/user/Desktop/idol-sight/worker/tests/unit/test_cli_live_activity.py
# test_cli.py(CliRunner) 컨벤션 미러. build_live_activity 는 커맨드 본문에서
# 함수-로컬 import 되므로 SOURCE 모듈 속성을 monkeypatch 한다
# (idol_sight.analysis.live_activity.build_live_activity).
from typer.testing import CliRunner

from idol_sight.cli import app

runner = CliRunner()


def test_build_live_activity_help_present():
    res = runner.invoke(app, ["build-live-activity", "--help"])
    assert res.exit_code == 0
    assert "group" in res.output.lower()
    assert "miiwan" in res.output.lower()


def test_build_live_activity_invokes_builder_and_batches(monkeypatch):
    """build-live-activity 가 build_live_activity(client, group_key=, window_days=)
    를 호출하고 반환 statements 를 client.batch 로 적재, exit 0."""
    from unittest.mock import MagicMock

    import idol_sight.cli as cli

    fake_client = MagicMock()
    fake_client.batch.return_value = MagicMock(
        statements_executed=2, statements_sent=2)
    monkeypatch.setattr(cli, "load_settings", lambda: MagicMock())
    monkeypatch.setattr(cli, "_make_d1_client", lambda s: fake_client)

    fake_result = MagicMock(statements=[("DELETE FROM agg_live_activity", []),
                                        ("INSERT ...", [1])])
    build = MagicMock(return_value=fake_result)
    monkeypatch.setattr(
        "idol_sight.analysis.live_activity.build_live_activity", build)

    res = runner.invoke(app, ["build-live-activity", "--group", "miiwan"])
    assert res.exit_code == 0
    build.assert_called_once()
    args, kwargs = build.call_args
    assert args[0] is fake_client
    assert kwargs["group_key"] == "miiwan"
    assert kwargs["window_days"] == 56
    fake_client.batch.assert_called_once_with(fake_result.statements)


def test_build_live_activity_passes_window_days_override(monkeypatch):
    from unittest.mock import MagicMock

    import idol_sight.cli as cli

    fake_client = MagicMock()
    fake_client.batch.return_value = MagicMock(
        statements_executed=1, statements_sent=1)
    monkeypatch.setattr(cli, "load_settings", lambda: MagicMock())
    monkeypatch.setattr(cli, "_make_d1_client", lambda s: fake_client)
    build = MagicMock(return_value=MagicMock(statements=[("X", [])]))
    monkeypatch.setattr(
        "idol_sight.analysis.live_activity.build_live_activity", build)

    res = runner.invoke(
        app, ["build-live-activity", "--group", "miiwan", "--window-days", "28"])
    assert res.exit_code == 0
    assert build.call_args.kwargs["window_days"] == 28


def test_build_live_activity_exits_1_on_builder_error(monkeypatch):
    """build_live_activity 예외(예: 마이그레이션 미적용) → exit 1 + FAIL 메시지."""
    from unittest.mock import MagicMock

    import idol_sight.cli as cli

    monkeypatch.setattr(cli, "load_settings", lambda: MagicMock())
    monkeypatch.setattr(cli, "_make_d1_client", lambda s: MagicMock())

    def boom(*a, **k):
        raise RuntimeError("no such table: agg_live_activity")

    monkeypatch.setattr(
        "idol_sight.analysis.live_activity.build_live_activity", boom)

    res = runner.invoke(app, ["build-live-activity"])
    assert res.exit_code == 1
    assert "FAIL" in res.output


def test_build_live_activity_partial_write_exits_1(monkeypatch):
    """batch 부분쓰기(executed != sent) → exit 1 (backfill 패턴 미러)."""
    from unittest.mock import MagicMock

    import idol_sight.cli as cli

    fake_client = MagicMock()
    fake_client.batch.return_value = MagicMock(
        statements_executed=1, statements_sent=2)
    monkeypatch.setattr(cli, "load_settings", lambda: MagicMock())
    monkeypatch.setattr(cli, "_make_d1_client", lambda s: fake_client)
    monkeypatch.setattr(
        "idol_sight.analysis.live_activity.build_live_activity",
        MagicMock(return_value=MagicMock(statements=[("A", []), ("B", [])])))

    res = runner.invoke(app, ["build-live-activity"])
    assert res.exit_code == 1
    assert "partial live_activity write" in res.output
