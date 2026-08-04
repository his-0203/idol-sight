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
                        lambda src, **_: MagicMock(source=src))
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
                        lambda src, **_: MagicMock(source=src))
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
    monkeypatch.setattr(cli, "_make_collector", lambda src, **_: MagicMock(source=src))

    fake_summary = MagicMock(status="ok", rows_inserted=10, rows_updated=0,
                             runtime_ms=200, error_msg=None)
    monkeypatch.setattr(cli, "run_collector", lambda *a, **kw: fake_summary)

    res = runner.invoke(app, ["collect", "--source", "youtube", "--group", "plave"])
    assert res.exit_code == 0


def test_analyze_weekly_subcommand_present():
    res = runner.invoke(app, ["analyze-weekly", "--help"])
    assert res.exit_code == 0
    assert "weekly" in res.output.lower()


# --- backfill-music-show-wins -------------------------------------------


def test_backfill_music_show_wins_help_present():
    res = runner.invoke(app, ["backfill-music-show-wins", "--help"])
    assert res.exit_code == 0
    assert "1위" in res.output or "music" in res.output.lower()


def test_backfill_music_show_wins_requires_gemini_key(monkeypatch):
    """GEMINI_API_KEY 미설정 → exit code 2 + 명시적 에러."""
    from unittest.mock import MagicMock

    import idol_sight.cli as cli

    fake_settings = MagicMock(gemini_api_key=None)
    monkeypatch.setattr(cli, "load_settings", lambda: fake_settings)

    res = runner.invoke(app, ["backfill-music-show-wins"])
    assert res.exit_code == 2
    assert "GEMINI_API_KEY" in res.output


def test_backfill_music_show_wins_rejects_invalid_group(monkeypatch):
    from unittest.mock import MagicMock

    import idol_sight.cli as cli

    fake_settings = MagicMock(gemini_api_key="fake-key")
    monkeypatch.setattr(cli, "load_settings", lambda: fake_settings)

    res = runner.invoke(
        app, ["backfill-music-show-wins", "--group", "isedol"],
    )
    # ISEDOL 은 후보 6개 그룹에 없음 → 거부
    assert res.exit_code == 2
    assert "must be one of" in res.output


def test_collect_hanteo_runs_global_and_batches(monkeypatch):
    """`collect-hanteo`는 HanteoCollector.collect_global()을 호출하고
    statements를 D1 batch로 기록한다 (melon-chart 전역 수집 패턴)."""
    from unittest.mock import MagicMock

    import idol_sight.cli as cli
    from idol_sight.collectors.base import CollectionResult

    fake_client = MagicMock()
    monkeypatch.setattr(cli, "_make_d1_client", lambda settings: fake_client)
    monkeypatch.setattr(cli, "load_settings", lambda: MagicMock())
    monkeypatch.setattr(cli, "_load_active_groups",
                        lambda client: [{"key": "plave", "name": "PLAVE", "name_kr": "플레이브"}])

    result = CollectionResult(2, 0, statements=[("INSERT", ["x"]), ("INSERT", ["y"])])
    fake_coll = MagicMock()
    fake_coll.collect_global.return_value = result
    monkeypatch.setattr(cli, "HanteoCollector", lambda **kw: fake_coll)

    res = runner.invoke(app, ["collect-hanteo"])
    assert res.exit_code == 0
    fake_coll.collect_global.assert_called_once()
    fake_client.batch.assert_called_once_with(result.statements)


def test_collect_hanteo_fails_when_unreachable(monkeypatch):
    """기사 목록 fetch 실패(statements 없음 + errors)면 비-0 종료 —
    collect-daily 스텝이 빨갛게 떠서 조용한 결측을 막는다."""
    from unittest.mock import MagicMock

    import idol_sight.cli as cli
    from idol_sight.collectors.base import CollectionResult

    monkeypatch.setattr(cli, "_make_d1_client", lambda settings: MagicMock())
    monkeypatch.setattr(cli, "load_settings", lambda: MagicMock())
    monkeypatch.setattr(cli, "_load_active_groups", lambda client: [{"key": "plave"}])

    fake_coll = MagicMock()
    fake_coll.collect_global.return_value = CollectionResult(
        0, 0, errors=["chart_list_unreachable"])
    monkeypatch.setattr(cli, "HanteoCollector", lambda **kw: fake_coll)

    res = runner.invoke(app, ["collect-hanteo"])
    assert res.exit_code == 1
