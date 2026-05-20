"""guyso.me 백필 결과를 wrangler d1 execute용 SQL 파일로 dump.

CF_API_TOKEN이 로컬에 없어서 cli.py를 못 돌릴 때, wrangler OAuth로
적재할 수 있도록 INSERT 문만 만들어준다. 1회성 도구.

Usage:
    uv run python scripts/backfill_to_sql.py \
        --start 2024-01-01 --end 2026-02-17 \
        --output /tmp/melon_backfill.sql
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import date, timedelta

from idol_sight.collectors.melon_backfill import (
    build_backfill_statements,
    daterange,
    fetch_guyso_daily,
)


GROUPS = [
    {"key": "bdawn", "name": "B:DAWN", "name_kr": "비던"},
    {"key": "isedol", "name": "ISEDOL", "name_kr": "이세계아이돌"},
    {"key": "miiwan", "name": "MiiWAN", "name_kr": "미완소년"},
    {"key": "myrakl", "name": "MY:RAKL", "name_kr": "미라클"},
    {"key": "owis", "name": "OWIS", "name_kr": "오위스"},
    {"key": "plave", "name": "PLAVE", "name_kr": "플레이브"},
    {"key": "skinz", "name": "SKINZ", "name_kr": "스킨즈"},
    {"key": "stellive", "name": "STELLIVE", "name_kr": "스텔라이브"},
    {"key": "wegosix", "name": "WE GO-6", "name_kr": "위고식스"},
]


def _quote(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def _render(stmt: tuple[str, list]) -> str:
    sql, params = stmt
    out = []
    pi = 0
    for ch in sql:
        if ch == "?":
            out.append(_quote(params[pi]))
            pi += 1
        else:
            out.append(ch)
    return "".join(out) + ";"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", required=True)
    ap.add_argument("--end", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--top-n", type=int, default=100)
    args = ap.parse_args()

    dates = daterange(args.start, args.end)
    print(f"window: {args.start}..{args.end} ({len(dates)} days)")

    total_stmts = 0
    failed: list[str] = []
    per_group: dict[str, int] = {}
    started = time.time()

    with open(args.output, "w") as f:
        for i, d in enumerate(dates, 1):
            rows = fetch_guyso_daily(d)
            if rows is None:
                failed.append(d)
                if i % 50 == 0 or i == len(dates):
                    print(f"  [{i}/{len(dates)}] {d}: FETCH FAILED")
                continue
            stmts = build_backfill_statements(d, rows, GROUPS, top_n=args.top_n)
            for s in stmts:
                f.write(_render(s) + "\n")
                gk = s[1][1]
                per_group[gk] = per_group.get(gk, 0) + 1
            total_stmts += len(stmts)
            if i % 50 == 0 or i == len(dates):
                elapsed = time.time() - started
                eta = elapsed / i * (len(dates) - i)
                print(
                    f"  [{i}/{len(dates)}] {d}: {len(stmts)} stmts "
                    f"(total {total_stmts}, elapsed {elapsed:.0f}s, "
                    f"eta {eta:.0f}s)",
                    flush=True,
                )

    print()
    print(f"--- SUMMARY ---")
    print(f"  total statements: {total_stmts}")
    print(f"  output: {args.output}")
    print(f"  failed dates ({len(failed)}): {failed[:10]}{'...' if len(failed) > 10 else ''}")
    print(f"  per-group matches:")
    for k in sorted(per_group):
        print(f"    {k}: {per_group[k]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
