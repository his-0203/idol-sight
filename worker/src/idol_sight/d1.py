"""Cloudflare D1 HTTP API client.

D1 exposes a JSON REST endpoint per database. We hit only:
  POST /client/v4/accounts/{account_id}/d1/database/{db_id}/query
  POST /client/v4/accounts/{account_id}/d1/database/{db_id}/raw   # for multi-statement batches

Both accept JSON bodies and return Cloudflare's standard envelope
{success, errors, result}. We unwrap result[0].results into row dicts.
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
        self._url_raw = f"{API}/accounts/{account_id}/d1/database/{db_id}/raw"
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

    def batch(self, statements: list[tuple[str, list[Any]]]) -> BatchSummary:
        # Cloudflare D1 REST API does not accept array-body batches. We send
        # statements sequentially over a single keep-alive HTTP connection.
        executed = 0
        total_changes = 0
        with httpx.Client(timeout=self._timeout) as c:
            for sql, params in statements:
                r = self._post_with_retry(
                    c, self._url_query, {"sql": sql, "params": params or []},
                )
                r.raise_for_status()
                env = r.json()
                if not env.get("success"):
                    raise D1Error(_first_error(env))
                executed += 1
                for it in env.get("result") or []:
                    total_changes += (it.get("meta") or {}).get("changes", 0)
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
