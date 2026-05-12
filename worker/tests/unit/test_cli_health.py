from unittest.mock import MagicMock

from idol_sight.cli_health import audit_freshness


def test_audit_returns_stale_jobs():
    """Existing crawl_meta freshness behavior unchanged."""
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


def test_audit_flags_backfill_stale_groups():
    """Groups whose last_backfilled_at is None or older than 14 days
    show up as 'backfill:<group>' stale entries."""
    crawl_rows = []  # no crawl jobs stale
    # Three groups: one stale (20d ago), one never backfilled.
    backfill_rows = [
        {"key": "stellive", "last_backfilled_at": "2026-04-22T00:00:00Z"},  # 20d → stale
        {"key": "bdawn",    "last_backfilled_at": None},                      # never → stale
    ]
    client = MagicMock()
    client.execute.side_effect = [crawl_rows, backfill_rows]
    stale = audit_freshness(client, now_iso="2026-05-12T00:00:00Z")
    stale_jobs = {s["job"] for s in stale}
    assert stale_jobs == {"backfill:stellive", "backfill:bdawn"}
    by_job = {s["job"]: s for s in stale}
    assert by_job["backfill:stellive"]["age_h"] is not None
    assert by_job["backfill:stellive"]["age_h"] > 14 * 24
    assert by_job["backfill:bdawn"]["age_h"] is None
