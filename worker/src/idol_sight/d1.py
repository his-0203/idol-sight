"""Cloudflare D1 HTTP API client.

D1 exposes a JSON REST endpoint per database. We hit only:
  POST /client/v4/accounts/{account_id}/d1/database/{db_id}/query

The /query endpoint accepts two body shapes (verified against the current
Cloudflare API ref):
  - single:  {"sql": "...", "params": [...]}
  - batch:   {"batch": [{"sql": "...", "params": [...]}, ...]}

Both return Cloudflare's standard envelope {success, errors, result}. For a
single query, result has one entry; for a batch, result has one entry per
statement (in order). batch() uses the batch shape in chunks to collapse the
~15k sequential POSTs of a full organicity rebuild into ~150 requests, and
degrades to per-statement POSTs if the batch shape is rejected (HTTP 400).
"""

from __future__ import annotations

import random
import time
from dataclasses import dataclass
from typing import Any

import httpx

API = "https://api.cloudflare.com/client/v4"

# Transient HTTP statuses retried with exponential backoff. 429 is
# Cloudflare-side rate limiting (collect-hourly's 9-group fan-out hits
# this); 5xx covers brief D1 unavailability. Other 4xx (400/401/403/404)
# are deterministic client errors and fail fast.
#
# Tuning history:
#   v1 (4 attempts × 0.2s base, no jitter) — 8/9 matrix jobs passed but
#   one persistently throttled job fell off the cliff at ~1.4s total
#   wait. Bumped to 6 attempts × 0.5s base (worst case 15.5s total) plus
#   ±25% multiplicative jitter so concurrent matrix jobs don't retry in
#   lockstep and re-trigger the same rate-limit window together.
_TRANSIENT_STATUSES = frozenset({429, 500, 502, 503, 504})
_MAX_ATTEMPTS = 6
_BACKOFF_BASE = 0.5  # seconds; worst-case wait ~ 0.5+1+2+4+8 = 15.5s

# Statements per /query batch request. Kept conservative so the JSON body stays
# well under D1's ~1MB request limit even for organicity rows (each carries a
# signal_breakdown JSON blob, ~1-2KB) — 100 × ~2KB ≈ 200KB. Module-level so the
# orchestrator's behavior is one knob, and tests can shrink it.
_BATCH_CHUNK_SIZE = 100


class D1Error(RuntimeError):
    pass


@dataclass
class BatchSummary:
    statements_sent: int
    statements_executed: int
    total_changes: int


class D1Client:
    def __init__(self, account_id: str, db_id: str, api_token: str, timeout: float = 30.0):
        self._url_query = f"{API}/accounts/{account_id}/d1/database/{db_id}/query"
        self._headers = {
            "Authorization": f"Bearer {api_token}",
            "Content-Type": "application/json",
        }
        self._timeout = timeout

    def _post_with_retry(
        self, c: httpx.Client, url: str, payload: dict
    ) -> httpx.Response:
        last: httpx.Response | None = None
        for attempt in range(_MAX_ATTEMPTS):
            r = c.post(url, json=payload, headers=self._headers)
            last = r
            if r.status_code in _TRANSIENT_STATUSES and attempt < _MAX_ATTEMPTS - 1:
                base = _BACKOFF_BASE * (2 ** attempt)
                wait = base * (0.75 + 0.5 * random.random())
                time.sleep(wait)
                continue
            return r
        assert last is not None
        return last

    def execute(self, sql: str, params: list[Any] | None = None) -> list[dict]:
        payload = {"sql": sql, "params": params or []}
        with httpx.Client(timeout=self._timeout) as c:
            r = self._post_with_retry(c, self._url_query, payload)
        r.raise_for_status()
        env = r.json()
        if not env.get("success"):
            raise D1Error(_first_error(env))
        result = env.get("result") or []
        if not result:
            return []
        return result[0].get("results") or []

    def _exec_one(
        self, c: httpx.Client, sql: str, params: list[Any] | None,
    ) -> int:
        """Run one statement via the single-query shape; return its changes.
        Raises D1Error on an API-level failure, httpx errors on HTTP failure."""
        r = self._post_with_retry(
            c, self._url_query, {"sql": sql, "params": params or []},
        )
        r.raise_for_status()
        env = r.json()
        if not env.get("success"):
            raise D1Error(_first_error(env))
        changes = 0
        for it in env.get("result") or []:
            changes += (it.get("meta") or {}).get("changes", 0)
        return changes

    def _batch_sequential(
        self, c: httpx.Client, chunk: list[tuple[str, list[Any]]],
    ) -> tuple[int, int]:
        executed = 0
        total_changes = 0
        for sql, params in chunk:
            total_changes += self._exec_one(c, sql, params)
            executed += 1
        return executed, total_changes

    def batch(self, statements: list[tuple[str, list[Any]]]) -> BatchSummary:
        """Execute statements in order, chunked into {batch:[...]} requests.

        Statements run in array order within a chunk and chunks run in order, so
        ordering guarantees (e.g. build_summary's leading DELETE before its
        upserts) hold. A chunk that the API rejects with HTTP 400 — i.e. the
        batch body shape isn't accepted, so nothing was applied — degrades to
        per-statement POSTs (for that and all later chunks); SQL/constraint
        errors instead surface as HTTP 200 + success:false and are raised.

        Contract: on success the returned BatchSummary always has
        statements_executed == statements_sent — any failure (chunk error,
        exhausted retry, or a successful response with fewer results than
        statements sent) RAISES. So callers can treat a normal return as "all
        applied"; the executed!=sent check at call sites is belt-and-suspenders.

        NOT atomic across chunks: a statement list longer than _BATCH_CHUNK_SIZE
        spans multiple requests, and an earlier chunk can commit before a later
        one raises. Callers must therefore be idempotent (UPSERT, or a leading
        DELETE rebuild) so a re-run / next cron heals any partial write. The only
        plain-INSERT callers (challenge_scan, llm.weekly insights) lead with a
        per-week DELETE for exactly this reason."""
        if not statements:
            return BatchSummary(0, 0, 0)
        executed = 0
        total_changes = 0
        use_batch = True
        with httpx.Client(timeout=self._timeout) as c:
            for i in range(0, len(statements), _BATCH_CHUNK_SIZE):
                chunk = statements[i:i + _BATCH_CHUNK_SIZE]
                if use_batch:
                    payload = {
                        "batch": [
                            {"sql": sql, "params": params or []}
                            for sql, params in chunk
                        ],
                    }
                    r = self._post_with_retry(c, self._url_query, payload)
                    if r.status_code != 400:
                        r.raise_for_status()
                        env = r.json()
                        if not env.get("success"):
                            raise D1Error(_first_error(env))
                        results = env.get("result") or []
                        if len(results) != len(chunk):
                            # success:true but fewer results than statements —
                            # an under-count we must not return silently (the
                            # call-site executed!=sent guard would catch it, but
                            # raising keeps the "return == all applied" contract).
                            raise D1Error(
                                f"batch under-count: {len(results)} results for "
                                f"{len(chunk)} statements",
                            )
                        executed += len(results)
                        for it in results:
                            total_changes += (it.get("meta") or {}).get("changes", 0)
                        continue
                    # HTTP 400 → batch shape rejected; nothing applied. Degrade
                    # permanently and re-run this chunk per-statement.
                    use_batch = False
                ex, ch = self._batch_sequential(c, chunk)
                executed += ex
                total_changes += ch
        return BatchSummary(
            statements_sent=len(statements),
            statements_executed=executed,
            total_changes=total_changes,
        )


def _first_error(env: dict) -> str:
    errs = env.get("errors") or []
    if errs and isinstance(errs[0], dict):
        return str(errs[0].get("message") or errs[0])
    return "unknown D1 error"
