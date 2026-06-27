#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Convert a manually-curated SocialBlade-style CSV into an agg_summary
INSERT migration block.

Why this exists: the SB Matrix API (socialblade_fetch.py) requires a
paid Personal Premium token. When that token is unavailable, the user
can manually copy daily history off the SocialBlade Premium UI ("Daily
Subscriber & View Count") and save as CSV — this script wraps the same
INSERT...ON CONFLICT pattern around that CSV so the resulting SQL can
go straight into a new migration file.

Input CSV format (header required):
    date,yt_subscribers,yt_total_views
    2026-03-07,0,0
    2026-03-08,12,150
    ...

Empty cells, "0", and "-" are all coerced to NULL (SB returns 0 when
tracking has not yet started for that day; a real channel can't have
0 subs once the first video is uploaded).

Usage:
    uv run scripts/historical_backfill/csv_to_migration.py \
        --group bdawn \
        --csv scripts/historical_backfill/bdawn_socialblade.csv \
        --out migrations/0039_bdawn_socialblade_backfill.sql

The script does NOT apply the migration. Review the SQL, then:
    cd frontend && wrangler d1 migrations apply idol-sight --local
"""
from __future__ import annotations

import argparse
import csv
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent


def coerce_int(raw: str) -> int | None:
    """Empty / dash / zero → None (NULL); else int."""
    s = (raw or "").strip()
    if s in {"", "-", "0"}:
        return None
    try:
        return int(s.replace(",", ""))
    except ValueError:
        return None


def load_csv(path: Path) -> list[dict[str, int | None]]:
    rows: list[dict[str, int | None]] = []
    with path.open(encoding="utf-8") as f:
        reader = csv.DictReader(f)
        required = {"date", "yt_subscribers", "yt_total_views"}
        if not required.issubset(set(reader.fieldnames or [])):
            sys.exit(
                f"CSV missing required columns. Need {sorted(required)}, "
                f"got {reader.fieldnames}"
            )
        for line, r in enumerate(reader, start=2):
            d = (r.get("date") or "").strip()
            try:
                # Validates ISO date and rejects obvious typos (e.g. 2026-13-40).
                date.fromisoformat(d)
            except ValueError:
                print(f"  skip line {line}: invalid date {d!r}", file=sys.stderr)
                continue
            rows.append({
                "date": d,
                "subs": coerce_int(r.get("yt_subscribers", "")),
                "views": coerce_int(r.get("yt_total_views", "")),
            })
    rows.sort(key=lambda r: r["date"])
    return rows


def emit_sql(group_key: str, rows: list[dict[str, int | None]],
             source_note: str) -> str:
    """Same UPSERT signature as socialblade_fetch.py emit_sql_block."""
    if not rows:
        return f"-- {group_key.upper()}: no rows in CSV — nothing to insert\n"

    def to_sql(v: int | None) -> str:
        return "NULL" if v is None or v <= 0 else str(v)

    values = ",\n  ".join(
        f"('{group_key}', '{r['date']}T00:00:00Z', NULL, "
        f"{to_sql(r['views'])}, {to_sql(r['subs'])}, "
        f"0, 0, 0, 0, 0, 'backfill_estimate')"
        for r in rows
    )
    first = rows[0]["date"]
    last = rows[-1]["date"]
    return f"""-- ============================================================
-- {group_key.upper()} Social Blade daily ({len(rows)} rows, {first} ~ {last})
-- Source: {source_note}
-- yt_total_videos는 SB daily에 없어 NULL — live collector가 나중에 채움.
-- ============================================================
INSERT INTO agg_summary
  (group_key, snapshot_at,
   yt_total_videos, yt_total_views, yt_subscribers,
   dc_total_posts, theqoo_posts, instiz_posts,
   naver_total_news, controversy_count, data_source)
VALUES
  {values}
ON CONFLICT(group_key, snapshot_at) DO UPDATE SET
  yt_subscribers = COALESCE(excluded.yt_subscribers, agg_summary.yt_subscribers),
  yt_total_views = COALESCE(excluded.yt_total_views, agg_summary.yt_total_views),
  data_source    = excluded.data_source;
"""


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--group", required=True,
                   help="group_key (e.g. 'bdawn'). Must match groups.key.")
    p.add_argument("--csv", required=True, type=Path,
                   help="path to CSV with date,yt_subscribers,yt_total_views")
    p.add_argument("--out", required=True, type=Path,
                   help="output migration .sql path "
                        "(e.g. migrations/0039_bdawn_socialblade_backfill.sql)")
    p.add_argument("--source-note",
                   default="Social Blade Premium UI manual export",
                   help="provenance string written into the SQL header")
    args = p.parse_args()

    csv_path = args.csv if args.csv.is_absolute() else (ROOT / args.csv).resolve()
    out_path = args.out if args.out.is_absolute() else (ROOT / args.out).resolve()

    if not csv_path.exists():
        sys.exit(f"CSV not found: {csv_path}")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    rows = load_csv(csv_path)
    print(f"loaded {len(rows)} rows from {csv_path}", file=sys.stderr)

    sql = emit_sql(args.group, rows, args.source_note)
    header = (
        f"-- {out_path.relative_to(ROOT) if str(out_path).startswith(str(ROOT)) else out_path}\n"
        f"-- {args.group.upper()} agg_summary backfill from manually exported CSV.\n"
        f"-- Generated by scripts/historical_backfill/csv_to_migration.py.\n"
        f"-- Source: {args.source_note}\n\n"
    )
    out_path.write_text(header + sql, encoding="utf-8")
    print(f"wrote migration → {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
