"""Orchestrate a single (collector, group) run.

Lifecycle:
    1. record_attempt → crawl_meta status='running'
    2. collector.collect(group) → CollectionResult or raise
    3a. on success:
        - if result.errors and rows_inserted == 0: record_failure
          (silent-fail guard — see below)
        - else: client.batch(result.statements) → BatchSummary
          - if statements_executed == statements_sent: record_success
          - else: record_failure with 'partial: N/M' message
    3b. on raise: record_failure

Silent-fail guard
-----------------
Several collectors (dc, theqoo, instiz, twitter) catch fetch exceptions
internally and accumulate them in ``result.errors`` while still returning
a CollectionResult — historically the orchestrator treated those runs as
``status='ok'`` with no error_msg, masking real failures. Discovered
2026-05-25 when dc:skinz timed out three Page.goto attempts (60s each)
but was logged as ok/inserted=0 for the affected cycle. Now: any
collector that returns a non-empty ``errors`` AND zero ``rows_inserted``
is reclassified as failed so alerts.yml / Discord pick it up. Partial
runs (some rows + some errors, e.g. primary OK but a supplemental hub
failed) stay as 'ok' — those did write data.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from time import perf_counter

from idol_sight.collectors.base import Collector
from idol_sight.config import GroupConfig
from idol_sight.d1 import D1Client
from idol_sight.meta import record_attempt, record_failure, record_success


@dataclass
class RunSummary:
    job: str
    status: str                         # 'ok' | 'failed'
    rows_inserted: int = 0
    rows_updated: int = 0
    runtime_ms: int = 0
    error_msg: str | None = None


def _now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def run_collector(
    client: D1Client,
    collector: Collector,
    group: GroupConfig,
    *,
    expected_interval_h: int,
) -> RunSummary:
    job = f"{collector.source}:{group.key}"
    started = perf_counter()
    record_attempt(
        client, job=job, group_key=group.key, source=collector.source,
        expected_interval_h=expected_interval_h, now=_now_iso(),
    )

    # The recovery boundary must cover the D1 write too: with chunked batch
    # writes a failed chunk RAISES (D1Error / exhausted-retry HTTP error)
    # instead of returning executed<sent, so client.batch() has to be inside
    # this try or the exception escapes uncaught — record_failure never runs and
    # crawl_meta stays status='running' with no alert.
    try:
        result = collector.collect(group)

        if result.errors and result.rows_inserted == 0:
            # Silent fail: collector swallowed an exception (fetch timeout,
            # robot challenge, board moved, etc.) and returned an empty
            # result. Without this guard the run would record status='ok' /
            # error_msg=NULL and silently mask the problem.
            runtime_ms = int((perf_counter() - started) * 1000)
            msg = "; ".join(result.errors)[:1500]
            record_failure(client, job=job, now=_now_iso(), runtime_ms=runtime_ms, error_msg=msg)
            return RunSummary(job=job, status="failed", runtime_ms=runtime_ms, error_msg=msg)

        if result.statements:
            summary = client.batch(result.statements)
            if summary.statements_executed != summary.statements_sent:
                runtime_ms = int((perf_counter() - started) * 1000)
                msg = f"partial: {summary.statements_executed}/{summary.statements_sent}"
                record_failure(
                    client, job=job, now=_now_iso(), runtime_ms=runtime_ms, error_msg=msg,
                )
                return RunSummary(
                    job=job, status="failed", runtime_ms=runtime_ms, error_msg=msg,
                )
    except Exception as exc:                     # noqa: BLE001 — orchestrator is the recovery boundary
        runtime_ms = int((perf_counter() - started) * 1000)
        msg = f"{type(exc).__name__}: {exc}"[:1500]
        record_failure(client, job=job, now=_now_iso(), runtime_ms=runtime_ms, error_msg=msg)
        return RunSummary(job=job, status="failed", runtime_ms=runtime_ms, error_msg=msg)

    runtime_ms = int((perf_counter() - started) * 1000)
    record_success(
        client, job=job, now=_now_iso(), runtime_ms=runtime_ms,
        rows_inserted=result.rows_inserted, rows_updated=result.rows_updated,
    )
    return RunSummary(
        job=job, status="ok",
        rows_inserted=result.rows_inserted, rows_updated=result.rows_updated,
        runtime_ms=runtime_ms,
    )
