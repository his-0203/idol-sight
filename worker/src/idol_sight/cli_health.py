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

    # 심각도 분리 — 정기 수집(crawl_meta) 정체는 kind='job'(critical, exit 1).
    stale: list[dict[str, Any]] = []
    for r in rows:
        last = r.get("last_success_at")
        interval_h = r.get("expected_interval_h") or 24
        if not last:
            stale.append({**r, "age_h": None, "kind": "job"})
            continue
        try:
            last_dt = datetime.fromisoformat(str(last).replace("Z", "+00:00"))
        except ValueError:
            stale.append({**r, "age_h": None, "kind": "job"})
            continue
        age_h = (now - last_dt).total_seconds() / 3600
        if age_h > interval_h * 4:
            stale.append({**r, "age_h": age_h, "kind": "job"})

    # backfill staleness — youtube 전체 히스토리 backfill 은 *일회성* 작업이라
    # 14일 재알람은 false-positive(2026-05 health-check 만성 실패의 주원인).
    # 한 번도 안 한(last_backfilled_at IS NULL) 그룹만 kind='backfill'(warning)
    # 으로 surface — 신규 그룹 backfill 누락 신호. exit 1 안 시킴(cli 가 분기).
    backfill_rows = client.execute(
        "SELECT key, last_backfilled_at FROM groups "
        "WHERE COALESCE(is_active, 1) = 1 "
        "  AND last_backfilled_at IS NULL"
    )
    for r in backfill_rows:
        stale.append({
            "job": f"backfill:{r['key']}",
            "last_success_at": r.get("last_backfilled_at"),
            "expected_interval_h": None,
            "age_h": None,
            "kind": "backfill",
        })

    return stale
