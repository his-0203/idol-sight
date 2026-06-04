from unittest.mock import MagicMock

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
