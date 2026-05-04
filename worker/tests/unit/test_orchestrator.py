from unittest.mock import MagicMock

from idol_sight.collectors.base import CollectionResult
from idol_sight.config import GroupConfig
from idol_sight.orchestrator import run_collector


def _group():
    return GroupConfig(
        key="plave", name="PLAVE", name_kr="플레이브",
        debut_date="2023-03-12",
        yt_channel_id=None, dc_gallery_id="plave",
        naver_query="플레이브",
        context_keywords=["플레이브"], blacklist_phrases=[],
        twitter_handles=[],
    )


def test_run_collector_records_attempt_then_success():
    collector = MagicMock()
    collector.source = "naver"
    collector.collect.return_value = CollectionResult(
        rows_inserted=10, rows_updated=2,
        statements=[("INSERT INTO naver_articles VALUES (?)", ["x"])],
        runtime_ms=123,
    )
    client = MagicMock()
    client.batch.return_value = MagicMock(
        statements_sent=1, statements_executed=1, total_changes=10,
    )

    summary = run_collector(client, collector, _group(), expected_interval_h=1)

    # crawl_meta upserts: attempt then success.
    assert client.execute.call_count == 2
    attempt_sql = client.execute.call_args_list[0][0][0]
    success_sql = client.execute.call_args_list[1][0][0]
    assert "running" in attempt_sql
    assert "ok" in success_sql

    # Batch was sent.
    client.batch.assert_called_once()
    assert summary.status == "ok"
    assert summary.rows_inserted == 10


def test_run_collector_records_failure_on_exception():
    collector = MagicMock()
    collector.source = "dc"
    collector.collect.side_effect = RuntimeError("cloudflare blocked")
    client = MagicMock()

    summary = run_collector(client, collector, _group(), expected_interval_h=6)

    # Attempt then failure.
    assert client.execute.call_count == 2
    failure_sql = client.execute.call_args_list[1][0][0]
    assert "failed" in failure_sql
    failure_params = client.execute.call_args_list[1][0][1]
    assert "cloudflare blocked" in str(failure_params)

    # No batch (collector raised before producing statements).
    client.batch.assert_not_called()
    assert summary.status == "failed"


def test_run_collector_records_partial_when_batch_drops_rows():
    collector = MagicMock()
    collector.source = "naver"
    collector.collect.return_value = CollectionResult(
        rows_inserted=10, rows_updated=0,
        statements=[("INSERT", []), ("INSERT", [])],
    )
    client = MagicMock()
    client.batch.return_value = MagicMock(
        statements_sent=2, statements_executed=1, total_changes=1,
    )

    summary = run_collector(client, collector, _group(), expected_interval_h=1)
    # Treated as failure because not all statements landed.
    assert summary.status == "failed"
    assert "partial" in (summary.error_msg or "").lower()
