"""Helpers to upsert rows in the crawl_meta table."""

from __future__ import annotations

from typing import Protocol


class _Executor(Protocol):
    def execute(self, sql: str, params: list | None = ...) -> list[dict]: ...


_UPSERT_ATTEMPT = """
INSERT INTO crawl_meta(job, group_key, source, expected_interval_h,
                       last_attempt_at, status)
VALUES (?, ?, ?, ?, ?, 'running')
ON CONFLICT(job) DO UPDATE SET
  last_attempt_at=excluded.last_attempt_at,
  status='running',
  group_key=excluded.group_key,
  source=excluded.source,
  expected_interval_h=excluded.expected_interval_h
""".strip()


_UPSERT_SUCCESS = """
INSERT INTO crawl_meta(job, last_attempt_at, last_success_at, status,
                       runtime_ms, rows_inserted, rows_updated, error_msg)
VALUES (?, ?, ?, 'ok', ?, ?, ?, NULL)
ON CONFLICT(job) DO UPDATE SET
  last_success_at=excluded.last_success_at,
  status='ok',
  runtime_ms=excluded.runtime_ms,
  rows_inserted=excluded.rows_inserted,
  rows_updated=excluded.rows_updated,
  error_msg=NULL
""".strip()


_UPSERT_FAILURE = """
INSERT INTO crawl_meta(job, last_attempt_at, status, runtime_ms, error_msg)
VALUES (?, ?, 'failed', ?, ?)
ON CONFLICT(job) DO UPDATE SET
  status='failed',
  runtime_ms=excluded.runtime_ms,
  error_msg=excluded.error_msg
""".strip()


def record_attempt(client: _Executor, *, job: str, group_key: str, source: str,
                   expected_interval_h: int, now: str) -> None:
    client.execute(_UPSERT_ATTEMPT, [job, group_key, source, expected_interval_h, now])


def record_success(client: _Executor, *, job: str, now: str, runtime_ms: int,
                   rows_inserted: int, rows_updated: int) -> None:
    client.execute(_UPSERT_SUCCESS, [job, now, now, runtime_ms, rows_inserted, rows_updated])


def record_failure(client: _Executor, *, job: str, now: str, runtime_ms: int,
                   error_msg: str) -> None:
    client.execute(_UPSERT_FAILURE, [job, now, runtime_ms, error_msg])
