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


def _sov_fake_client(has_90d=True):
    """_sov_inputs 용 FakeClient — agg_summary 최신/전주 + groups 모델."""
    from unittest.mock import MagicMock
    latest = [
        {"group_key": "plave", "yt_total_views": 1000, "yt_subscribers": 500,
         "dc_total_posts": 10, "theqoo_posts": 0, "instiz_posts": 0,
         "naver_total_news": 300, "naver_news_90d": 40},
        {"group_key": "isedol", "yt_total_views": 2000, "yt_subscribers": 800,
         "dc_total_posts": 20, "theqoo_posts": 0, "instiz_posts": 0,
         "naver_total_news": 100, "naver_news_90d": 10},
    ]
    prev = [
        {"group_key": "plave", "yt_total_views": 900, "dc_total_posts": 8,
         "theqoo_posts": 0, "instiz_posts": 0,
         "naver_total_news": 290, "naver_news_90d": 35},
    ]
    client = MagicMock()
    def _execute(sql, params=None):
        if "naver_news_90d" in sql and not has_90d:
            raise RuntimeError("no such column: naver_news_90d")
        if "FROM groups" in sql:
            return [{"key": "plave", "group_model": "corporate"},
                    {"key": "isedol", "group_model": "segmentary"}]
        if "-6 days" in sql or "snapshot_at <" in sql:
            return prev
        if "agg_summary" in sql:
            return latest
        return []
    client.execute.side_effect = _execute
    return client


def test_sov_inputs_uses_90d_news_and_tags_category():
    """v3(2026-08): 뉴스 신호 = naver_news_90d 우선, 그룹별 category 태그
    (도메인별 분리 계산용 — K-POP/서브컬처 혼합 코호트 버그픽스)."""
    import idol_sight.cli as cli
    groups = {g["key"]: g for g in cli._sov_inputs(_sov_fake_client())}
    assert groups["plave"]["news"] == 40          # 90d, 누적(300) 아님
    assert groups["plave"]["delta_news"] == 5     # 40 - 35
    assert groups["plave"]["category"] == "kpop"
    assert groups["isedol"]["category"] == "subculture"


def test_sov_inputs_falls_back_without_90d_column():
    """0113 미적용 D1: 누적 뉴스로 폴백(graceful)."""
    import idol_sight.cli as cli
    groups = {g["key"]: g for g in cli._sov_inputs(_sov_fake_client(has_90d=False))}
    assert groups["plave"]["news"] == 300
    assert groups["plave"]["delta_news"] == 10    # 300 - 290


def test_sov_inputs_prev_anchor_is_weekly():
    """모멘텀의 '전 주' = ~7일 전 최근접 스냅샷(직전 스냅샷 아님 — 몇 시간치
    델타가 주간 모멘텀으로 둔갑하던 결함 수정)."""
    import idol_sight.cli as cli
    client = _sov_fake_client()
    cli._sov_inputs(client)
    prev_sqls = [c.args[0] for c in client.execute.call_args_list
                 if "agg_summary" in c.args[0] and "-6 days" in c.args[0]]
    assert prev_sqls, "weekly-anchored prev query not issued"


def test_sov_tiers_computed_per_category_from_90d_flow():
    """티어는 90일 조회 플로우(창 내 최초 스냅샷 대비 증분)로 카테고리별
    독립 산정 — K-POP 갭이 서브컬처 티어에 영향 없음."""
    from unittest.mock import MagicMock
    import idol_sight.cli as cli

    groups = [
        {"key": "plave", "category": "kpop", "yt_views": 100_000_000},
        {"key": "miiwan", "category": "kpop", "yt_views": 3_000_000},
        {"key": "isedol", "category": "subculture", "yt_views": 50_000_000},
    ]
    client = MagicMock()
    client.execute.return_value = [
        {"group_key": "plave", "yt_total_views": 40_000_000},   # flow 60M
        {"group_key": "miiwan", "yt_total_views": 2_900_000},   # flow 100K
        {"group_key": "isedol", "yt_total_views": 49_000_000},  # flow 1M
    ]
    tiers, flows = cli._sov_tiers(client, groups)
    assert tiers["plave"] == 1
    assert tiers["miiwan"] == 2       # 60M vs 100K = 2.8 데케이드 갭
    assert tiers["isedol"] == 1       # 서브컬처 단독 코호트 → T1
    assert flows["plave"] == 60_000_000   # 근거 플로우도 함께 반환(정량 앵커)
    assert flows["miiwan"] == 100_000
    sql = client.execute.call_args.args[0]
    assert "-90 days" in sql and "rn = 1" in sql.replace("rn=1", "rn = 1")


def test_sov_tiers_null_anchor_does_not_inflate_flow():
    """백필 행의 NULL 조회수 앵커를 0 취급하면 증분=누적 전체로 부풀려짐
    (plave 855M 실측 버그). 앵커 쿼리는 IS NOT NULL 필터, 앵커 부재
    그룹은 증분 0."""
    from unittest.mock import MagicMock
    import idol_sight.cli as cli

    groups = [{"key": "plave", "category": "kpop", "yt_views": 855_000_000},
              {"key": "ghost", "category": "kpop", "yt_views": 10_000}]
    client = MagicMock()
    client.execute.return_value = [
        {"group_key": "plave", "yt_total_views": 800_000_000},
        # ghost: 창 내 non-NULL 앵커 없음 → anchor 미포함
    ]
    tiers, flows = cli._sov_tiers(client, groups)
    assert flows["plave"] == 55_000_000
    assert flows["ghost"] == 0
    assert "IS NOT NULL" in client.execute.call_args.args[0]
