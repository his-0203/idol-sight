from unittest.mock import MagicMock

from idol_sight.meta import record_attempt, record_success, record_failure


def test_record_attempt_upserts_meta_row():
    client = MagicMock()
    record_attempt(client, job="dc:plave", group_key="plave", source="dc",
                   expected_interval_h=6, now="2026-05-04T08:00:00Z")
    assert client.execute.called
    sql, params = client.execute.call_args[0]
    assert "crawl_meta" in sql
    assert "dc:plave" in params


def test_record_success_writes_status_ok():
    client = MagicMock()
    record_success(client, job="dc:plave", now="2026-05-04T08:01:00Z",
                   runtime_ms=1234, rows_inserted=10, rows_updated=2)
    sql, params = client.execute.call_args[0]
    assert "status" in sql.lower()
    assert "ok" in params
    assert 1234 in params


def test_record_failure_writes_status_failed_and_error_msg():
    client = MagicMock()
    record_failure(client, job="dc:plave", now="2026-05-04T08:01:00Z",
                   runtime_ms=500, error_msg="cloudflare blocked")
    sql, params = client.execute.call_args[0]
    assert "failed" in params
    assert "cloudflare blocked" in params
