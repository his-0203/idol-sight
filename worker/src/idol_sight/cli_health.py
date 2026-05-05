"""Health-check audit: find jobs whose last_success_at is older than
expected_interval_h * 4. Returns a list of stale-job dicts. The CLI subcommand
in cli.py wraps this and notifies Discord on each."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Protocol


class _Executor(Protocol):
    def execute(self, sql: str, params: list | None = ...) -> list[dict]: ...


def audit_freshness(client: _Executor, *, now_iso: str | None = None) -> list[dict[str, Any]]:
    rows = client.execute(
        "SELECT job, last_success_at, expected_interval_h FROM crawl_meta"
    )
    now = (
        datetime.fromisoformat(now_iso.replace("Z", "+00:00"))
        if now_iso else datetime.now(UTC)
    )

    stale: list[dict[str, Any]] = []
    for r in rows:
        last = r.get("last_success_at")
        interval_h = r.get("expected_interval_h") or 24
        if not last:
            stale.append({**r, "age_h": None})
            continue
        try:
            last_dt = datetime.fromisoformat(str(last).replace("Z", "+00:00"))
        except ValueError:
            stale.append({**r, "age_h": None})
            continue
        age_h = (now - last_dt).total_seconds() / 3600
        if age_h > interval_h * 4:
            stale.append({**r, "age_h": age_h})
    return stale
