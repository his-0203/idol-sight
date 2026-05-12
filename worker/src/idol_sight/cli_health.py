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

    # V2.21: backfill staleness — groups whose last_backfilled_at is
    # NULL or older than BACKFILL_ALERT_DAYS surface as 'backfill:<group>'
    # entries so the operator gets the same Discord ping channel.
    BACKFILL_ALERT_DAYS = 14
    backfill_rows = client.execute(
        "SELECT key, last_backfilled_at FROM groups "
        "WHERE COALESCE(is_active, 1) = 1 "
        "  AND (last_backfilled_at IS NULL "
        "       OR julianday(?) - julianday(last_backfilled_at) > ?)",
        [now.strftime("%Y-%m-%dT%H:%M:%SZ"), BACKFILL_ALERT_DAYS],
    )
    for r in backfill_rows:
        last_bf = r.get("last_backfilled_at")
        if not last_bf:
            age_h_val: float | None = None
        else:
            try:
                last_dt = datetime.fromisoformat(str(last_bf).replace("Z", "+00:00"))
                age_h_val = (now - last_dt).total_seconds() / 3600
            except ValueError:
                age_h_val = None
        stale.append({
            "job": f"backfill:{r['key']}",
            "last_success_at": last_bf,
            "expected_interval_h": BACKFILL_ALERT_DAYS * 24,
            "age_h": age_h_val,
        })

    return stale
