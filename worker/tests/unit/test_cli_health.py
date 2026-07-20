from unittest.mock import MagicMock

import pytest

from idol_sight.cli_health import audit_freshness


def test_audit_returns_stale_jobs():
    """crawl_meta freshness — 정기 job 정체는 kind='job'(critical)."""
    crawl_rows = [
        {"job": "naver:plave",   "last_success_at": "2026-05-04T07:00:00Z",
         "expected_interval_h": 1},
        {"job": "dc:bdawn",      "last_success_at": "2026-04-01T00:00:00Z",
         "expected_interval_h": 6},
        {"job": "instiz:miiwan", "last_success_at": None,
         "expected_interval_h": 6},
    ]
    client = MagicMock()
    # First call: crawl_meta SELECT (existing). Second call: groups
    # SELECT for backfill staleness (new — return empty so we don't
    # cross-contaminate this test).
    client.execute.side_effect = [crawl_rows, []]
    stale = audit_freshness(client, now_iso="2026-05-04T08:00:00Z")
    stale_jobs = {s["job"] for s in stale}
    # naver:plave is fresh (1h < 4h); dc:bdawn and instiz:miiwan stale.
    assert stale_jobs == {"dc:bdawn", "instiz:miiwan"}
    # 심각도 분리 — 정기 수집 정체는 critical("job").
    assert all(s["kind"] == "job" for s in stale)


def test_audit_flags_only_never_backfilled_groups():
    """일회성 backfill: 한 번도 안 한(NULL) 그룹만 backfill 경고로 surface.
    이미 backfill 한 그룹은 오래돼도 재알람 안 함(14일 재알람 폐지)."""
    crawl_rows = []  # no crawl jobs stale
    # SQL 이 last_backfilled_at IS NULL 만 SELECT — mock 도 NULL 만 반환.
    backfill_rows = [
        {"key": "bdawn", "last_backfilled_at": None},   # never → warning
    ]
    client = MagicMock()
    client.execute.side_effect = [crawl_rows, backfill_rows]
    stale = audit_freshness(client, now_iso="2026-05-12T00:00:00Z")
    by_job = {s["job"]: s for s in stale}
    assert set(by_job) == {"backfill:bdawn"}
    # 심각도 분리 — backfill 누락은 warning("backfill"), exit 1 아님.
    assert by_job["backfill:bdawn"]["kind"] == "backfill"
    assert by_job["backfill:bdawn"]["age_h"] is None


def test_audit_handles_non_utc_now_iso():
    """now_iso with non-UTC offset still produces correct crawl_meta stale."""
    # 2026-05-12T09:00:00+09:00 == 2026-05-12T00:00:00Z (same instant)
    crawl_rows = [
        # 20d before 2026-05-12T00:00Z UTC, interval 6h → stale (> 24h).
        {"job": "dc:stellive", "last_success_at": "2026-04-22T00:00:00Z",
         "expected_interval_h": 6},
    ]
    client = MagicMock()
    client.execute.side_effect = [crawl_rows, []]
    stale = audit_freshness(client, now_iso="2026-05-12T09:00:00+09:00")
    assert any(s["job"] == "dc:stellive" for s in stale)


from idol_sight.cli import _load_active_groups_full, _recompute_health_scores


class _FakeHealthClient:
    """debut_confirmed 게이트(V2.53) 검증용 SQL 라우팅 FakeClient.

    raise_on_confirmed=True 면 debut_confirmed 포함 SELECT 에서 raise 해
    mig 0105 미적용 D1(컬럼 부재) 상황을 재현한다.
    """

    def __init__(self, groups, cohort, raise_on_confirmed=False,
                 controversy_rows=None, raise_on_controversy=False):
        self._groups = groups
        self._cohort = cohort
        self._raise_on_confirmed = raise_on_confirmed
        self._controversy_rows = controversy_rows or []
        self._raise_on_controversy = raise_on_controversy
        self.batched = []

    def execute(self, sql, params=None):
        if "FROM groups WHERE is_active=1" in sql:
            if "debut_confirmed" in sql:
                if self._raise_on_confirmed:
                    raise Exception("no such column: debut_confirmed")
                return [dict(g) for g in self._groups]
            # 폴백 SELECT — debut_confirmed 컬럼 없이 반환.
            return [
                {k: v for k, v in g.items() if k != "debut_confirmed"}
                for g in self._groups
            ]
        if "FROM agg_summary WHERE snapshot_at = ?" in sql:
            return self._cohort
        if "FROM controversy_issues" in sql:
            if self._raise_on_controversy:
                raise Exception("no such table: controversy_issues")
            return self._controversy_rows
        if "FROM youtube_videos" in sql:
            return [{"n": 0}]
        # hanteo_weekly / music_show_wins_log / agg_fan_loyalty → 빈 결과.
        return []

    def batch(self, stmts):
        self.batched = list(stmts)
        return MagicMock(statements_executed=len(stmts), statements_sent=len(stmts))


def _cohort_row(key):
    return {
        "group_key": key, "yt_subscribers": 100000, "yt_total_views": 5000000,
        "yt_likes_total": 10000, "yt_comments_total": 1000,
        "dc_total_posts": 100, "theqoo_posts": 10, "instiz_posts": 10,
        "naver_total_news": 20, "controversy_count": 0, "negative_ratio": 0.0,
        "music_show_wins": 0, "melon_top100_peak": None,
        "melon_top100_depth": None,
    }


def _grade_of(batched, key):
    """INSERT 문 params: [group_key, snap, total, raw_total, grade, ...]."""
    for _sql, params in batched:
        if params[0] == key:
            return params[4]
    return None


def test_load_active_groups_full_falls_back_when_column_missing():
    """debut_confirmed 포함 SELECT 실패 → 기존 SELECT 폴백, 그룹 로드 성공.
    폴백 행은 debut_confirmed 키가 없어 전 그룹 확정(=1) 취급된다."""
    groups = [{
        "key": "bthd", "name": "BTHD", "name_kr": "비트하드",
        "debut_date": "2026-06-26", "group_model": "corporate",
        "debut_confirmed": 0,
    }]
    client = _FakeHealthClient(groups, cohort=[], raise_on_confirmed=True)
    rows = _load_active_groups_full(client)
    assert [r["key"] for r in rows] == ["bthd"]
    assert all("debut_confirmed" not in r for r in rows)
    # .get("debut_confirmed", 1) → 1 = 확정 취급.
    assert all(r.get("debut_confirmed", 1) == 1 for r in rows)


def test_recompute_records_pre_for_unconfirmed_debut_group():
    """컬럼 존재 + debut_confirmed=0 그룹은 과거 debut_date 여도 PRE 기록."""
    groups = [{
        "key": "bthd", "name": "BTHD", "name_kr": "비트하드",
        "debut_date": "2026-06-26", "group_model": "corporate",
        "debut_confirmed": 0,
    }]
    client = _FakeHealthClient(groups, cohort=[_cohort_row("bthd")])
    _recompute_health_scores(client, "2026-07-20T00:00:00Z")
    assert _grade_of(client.batched, "bthd") == "PRE"


# ─── V2.55 controversy_issues weight 배선 ────────────────────────────────

import json
from datetime import UTC, datetime, timedelta


def _confirmed_group(key):
    return {
        "key": key, "name": key.upper(), "name_kr": key,
        "debut_date": "2024-01-01", "group_model": "corporate",
        "debut_confirmed": 1,
    }


def _risk_of(batched, key):
    """INSERT params[6] = breakdown_json → risk = risk_factor * 15."""
    for _sql, params in batched:
        if params[0] == key:
            return json.loads(params[6])["risk"]
    return None


def _cohort_with_controversy(key, count):
    row = _cohort_row(key)
    row["controversy_count"] = count
    return row


def test_recompute_uses_issue_weight_when_row_fresh():
    """fresh controversy_issues 행 → weight path. count=8 폴백(×0.6)보다 덜
    깎이는 weight 3(×0.7)이 반영돼야 한다."""
    groups = [_confirmed_group("isedol")]
    fresh = datetime.now(UTC).isoformat()
    client = _FakeHealthClient(
        groups, cohort=[_cohort_with_controversy("isedol", 8)],
        controversy_rows=[{
            "group_key": "isedol", "computed_at": fresh, "effective_weight": 3.0,
        }],
    )
    _recompute_health_scores(client, "2026-07-20T00:00:00Z")
    # weight 3 → factor 0.7 → risk 10.5.
    assert _risk_of(client.batched, "isedol") == pytest.approx(0.7 * 15)


def test_recompute_falls_back_when_row_stale():
    """8일 넘은 computed_at → stale → count 폴백(×0.6)."""
    groups = [_confirmed_group("isedol")]
    stale = (datetime.now(UTC) - timedelta(days=9)).isoformat()
    client = _FakeHealthClient(
        groups, cohort=[_cohort_with_controversy("isedol", 8)],
        controversy_rows=[{
            "group_key": "isedol", "computed_at": stale, "effective_weight": 3.0,
        }],
    )
    _recompute_health_scores(client, "2026-07-20T00:00:00Z")
    # count=8 폴백 → factor max(0.6, 1-6/10)=0.6 → risk 9.0.
    assert _risk_of(client.batched, "isedol") == pytest.approx(0.6 * 15)


def test_recompute_falls_back_when_table_absent():
    """mig 0108 미적용(테이블 부재 raise) → graceful, 전 그룹 count 폴백."""
    groups = [_confirmed_group("isedol")]
    client = _FakeHealthClient(
        groups, cohort=[_cohort_with_controversy("isedol", 8)],
        raise_on_controversy=True,
    )
    _recompute_health_scores(client, "2026-07-20T00:00:00Z")
    assert _risk_of(client.batched, "isedol") == pytest.approx(0.6 * 15)


# ─── V2.56 hanteo standing value(초동 + 180d 반감기) 배선 ─────────────────

def test_recompute_wires_decayed_hanteo_standing_into_agg():
    """hanteo_weekly 행 → hanteo_standing_value 감쇠 → agg_dict['hanteo_sales'].
    초동 800k, 반감기(180d) 경과 컴백 → ×0.5 = 400k 가 스코어러로 전달돼야 한다."""
    from datetime import date, timedelta
    from unittest.mock import patch

    from idol_sight.analysis import health_score as hs

    anchor = (date.today() - timedelta(days=180)).isoformat()

    class _HanteoClient(_FakeHealthClient):
        def execute(self, sql, params=None):
            if "FROM hanteo_weekly" in sql:
                return [{
                    "group_key": "plave", "week_start": anchor,
                    "week_end": anchor, "album": "A1", "sales": 800_000,
                }]
            return super().execute(sql, params)

    client = _HanteoClient(
        [_confirmed_group("plave")], cohort=[_cohort_row("plave")])

    captured: list[dict] = []
    orig = hs.compute_health_score

    def _spy(group_key, agg, debut_date, **kw):
        captured.append(dict(agg))
        return orig(group_key, agg, debut_date, **kw)

    with patch("idol_sight.analysis.health_score.compute_health_score",
               side_effect=_spy):
        _recompute_health_scores(client, "2026-07-20T00:00:00Z")

    assert captured, "compute_health_score not called"
    assert captured[0]["hanteo_sales"] == pytest.approx(400_000.0)


def test_recompute_hanteo_empty_yields_zero_standing():
    """hanteo_weekly 빈 결과(프로덕션 현황) → hanteo_sales = 0."""
    from unittest.mock import patch

    from idol_sight.analysis import health_score as hs

    client = _FakeHealthClient(
        [_confirmed_group("plave")], cohort=[_cohort_row("plave")])
    captured: list[dict] = []
    orig = hs.compute_health_score

    def _spy(group_key, agg, debut_date, **kw):
        captured.append(dict(agg))
        return orig(group_key, agg, debut_date, **kw)

    with patch("idol_sight.analysis.health_score.compute_health_score",
               side_effect=_spy):
        _recompute_health_scores(client, "2026-07-20T00:00:00Z")

    assert captured[0]["hanteo_sales"] == 0
