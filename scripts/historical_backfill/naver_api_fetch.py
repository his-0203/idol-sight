#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "requests>=2.32",
# ]
# ///
"""Naver News Search API fetcher → weekly counts CSV → SQL UPSERT.

Why this exists: scripts/historical_backfill/scrape.py (Stealthy Naver
search) hit 1001+ lower-bound flags and was rate-limited / brittle. The
official Naver Open API for News Search returns up to 1000 most-recent
articles per query with reliable pubDate fields. Aggregating by week
gives us weekly article counts for ~1-2 years of recent history.

Endpoint: GET https://openapi.naver.com/v1/search/news.json
  Headers: X-Naver-Client-Id, X-Naver-Client-Secret
  Params:  query, display (1-100), start (1-1000), sort=date

Response:
  {"total": int, "start": int, "display": int, "items": [
    {"title": "...", "originallink": "...", "link": "...",
     "description": "...", "pubDate": "Mon, 06 May 2026 14:23:00 +0900"},
    ...
  ]}

Free tier: 25,000 queries/day. We use ~10 paginated calls per group
(100 items × 10 pages = 1000 items max), ×8 groups = 80 calls. Trivial.

Usage:
  export NAVER_CLIENT_ID=<dev console id>
  export NAVER_CLIENT_SECRET=<dev console secret>

  uv run scripts/historical_backfill/naver_api_fetch.py
  uv run scripts/historical_backfill/naver_api_fetch.py --smoke plave

Generated artifacts:
  scripts/historical_backfill/<group>_naver_api.csv  — week_start, count
  migrations/0025_naver_api_backfill.sql            — UPSERT block per group

Coverage limit: 1000 most-recent articles per query. For high-volume
groups (PLAVE), this typically covers ~6-12 months. For low-volume
(MYRAKL/OWIS), it covers most of channel history. Anti-fabrication: we
report total_returned vs total_available — the gap tells you how much
of pre-window history is not retrievable via this API.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from collections import Counter
from datetime import date, datetime, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any

import requests

API_URL = "https://openapi.naver.com/v1/search/news.json"
USER_AGENT = "idol-sight historical naver backfill / Python requests"

# Same group config used by socialblade_fetch.py — keep in sync.
GROUPS: list[dict[str, str]] = [
    {"key": "plave",    "query": '"플레이브" OR "PLAVE"',  "debut": "2023-03-12"},
    {"key": "skinz",    "query": '"SKINZ" OR "스킨즈"',    "debut": "2025-04-10"},
    {"key": "myrakl",   "query": '"MY:RAKL" OR "마이라클"', "debut": "2026-01-26"},
    {"key": "owis",     "query": '"OWIS" OR "오위스"',      "debut": "2026-03-23"},
    {"key": "miiwan",   "query": '"MiiWAN" OR "미이완"',    "debut": "2026-06-01"},
    {"key": "bdawn",    "query": '"B:DAWN" OR "비던"',      "debut": "2026-05-04"},
    {"key": "isedol",   "query": '"이세계아이돌" OR "ISEGYE IDOL"', "debut": "2021-12-17"},
    {"key": "stellive", "query": '"스텔라이브" OR "STELLIVE"',       "debut": "2022-10-16"},
]

PER_PAGE = 100         # max display per Naver API call
MAX_PAGES = 10         # max start: 1, 101, 201, ..., 901 → 1000 items total
ROOT = Path(__file__).resolve().parent.parent.parent
OUT_DIR = ROOT / "scripts" / "historical_backfill"
MIGRATION_PATH = ROOT / "migrations" / "0025_naver_api_backfill.sql"


def fetch_articles(query: str, client_id: str, client_secret: str) -> dict[str, Any]:
    """Fetch up to 1000 articles for the query (paginated). Returns
    {"total": int, "items": [...]}.

    Sort=date so we walk newest-first and can stop early if pubDate
    stops being useful (we walk all 1000 anyway since 100/page is fast).
    """
    items: list[dict[str, Any]] = []
    total: int | None = None
    headers = {
        "X-Naver-Client-Id": client_id,
        "X-Naver-Client-Secret": client_secret,
        "User-Agent": USER_AGENT,
    }
    for page in range(MAX_PAGES):
        start = page * PER_PAGE + 1
        if start > 1000:
            break
        r = requests.get(
            API_URL,
            params={
                "query": query,
                "display": PER_PAGE,
                "start": start,
                "sort": "date",
            },
            headers=headers,
            timeout=30,
        )
        if r.status_code == 400 and "max start" in r.text.lower():
            # Naver returns 400 with "Invalid start parameter" beyond
            # the channel's actual page count — normal, not an error.
            break
        r.raise_for_status()
        payload = r.json()
        total = payload.get("total", total)
        chunk = payload.get("items") or []
        if not chunk:
            break
        items.extend(chunk)
        if len(chunk) < PER_PAGE:
            break
    return {"total": total or 0, "items": items}


def _to_date(pubdate_str: str) -> date | None:
    """Parse RFC 2822 pubDate to date in UTC. Naver returns +0900;
    we convert to KST (the same date as the published-on calendar
    day in Korea, which is the natural bucket for weekly news cadence).
    """
    if not pubdate_str:
        return None
    try:
        dt = parsedate_to_datetime(pubdate_str)
    except (TypeError, ValueError):
        return None
    return dt.date()


def _week_start(d: date) -> date:
    """Monday of the week containing d (ISO week)."""
    return d - timedelta(days=d.weekday())


def bucket_weekly(items: list[dict[str, Any]]) -> dict[date, int]:
    """Bucket items by Monday-anchored ISO week. Returns {monday: count}."""
    counter: Counter[date] = Counter()
    for it in items:
        d = _to_date(it.get("pubDate") or "")
        if d is None:
            continue
        counter[_week_start(d)] += 1
    return dict(counter)


def write_csv(group_key: str, weekly: dict[date, int], total: int) -> Path:
    """Write CSV with one row per weekly bucket plus a metadata row."""
    path = OUT_DIR / f"{group_key}_naver_api.csv"
    rows = sorted(weekly.items())
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["# total_available_per_naver_api", total])
        w.writerow(["# total_retrieved", sum(weekly.values())])
        w.writerow(["week_start_monday", "naver_total_news"])
        for d, n in rows:
            w.writerow([d.isoformat(), n])
    return path


def emit_sql_block(group_key: str, weekly: dict[date, int]) -> str:
    if not weekly:
        return f"-- {group_key.upper()}: no articles returned\n"
    rows = sorted(weekly.items())
    values = ",\n  ".join(
        f"('{group_key}', '{d.isoformat()}T00:00:00Z', NULL, NULL, NULL, "
        f"0, 0, 0, {n}, 0, 0, 'backfill_exact')"
        for d, n in rows
    )
    return f"""-- ============================================================
-- {group_key.upper()} Naver API weekly ({len(rows)} weeks, {rows[0][0].isoformat()} ~ {rows[-1][0].isoformat()})
-- Source: Naver Open API /v1/search/news.json sort=date
-- ============================================================
INSERT INTO agg_summary
  (group_key, snapshot_at,
   yt_total_videos, yt_total_views, yt_subscribers,
   dc_total_posts, theqoo_posts, instiz_posts,
   naver_total_news, twitter_posts, controversy_count, data_source)
VALUES
  {values}
ON CONFLICT(group_key, snapshot_at) DO UPDATE SET
  naver_total_news = excluded.naver_total_news,
  data_source      = CASE
    WHEN agg_summary.data_source = 'live' THEN 'live'
    ELSE excluded.data_source
  END;
"""


def run_smoke(group_key: str, cid: str, secret: str) -> None:
    g = next((x for x in GROUPS if x["key"] == group_key), None)
    if g is None:
        sys.exit(f"unknown group: {group_key}")
    print(f"[smoke {group_key}] query={g['query']!r}", file=sys.stderr)
    res = fetch_articles(g["query"], cid, secret)
    weekly = bucket_weekly(res["items"])
    print(json.dumps({
        "total_per_api": res["total"],
        "items_retrieved": len(res["items"]),
        "weeks_with_data": len(weekly),
        "first_week": min(weekly).isoformat() if weekly else None,
        "last_week": max(weekly).isoformat() if weekly else None,
        "max_count_per_week": max(weekly.values()) if weekly else 0,
    }, indent=2), file=sys.stderr)


def run_full(cid: str, secret: str, only: list[str] | None = None) -> None:
    sql_blocks: list[str] = []
    summary: list[tuple[str, str, int, int]] = []
    targets = [g for g in GROUPS if (only is None or g["key"] in only)]
    for g in targets:
        try:
            res = fetch_articles(g["query"], cid, secret)
        except Exception as e:
            print(f"[{g['key']}] FAIL: {e}", file=sys.stderr)
            summary.append((g["key"], f"FAIL: {e}", 0, 0))
            continue
        weekly = bucket_weekly(res["items"])
        write_csv(g["key"], weekly, res["total"])
        sql_blocks.append(emit_sql_block(g["key"], weekly))
        summary.append((g["key"], "OK", res["total"], len(weekly)))
        print(f"[{g['key']}] total={res['total']} retrieved={len(res['items'])} weeks={len(weekly)}",
              file=sys.stderr)

    MIGRATION_PATH.parent.mkdir(parents=True, exist_ok=True)
    with MIGRATION_PATH.open("w", encoding="utf-8") as f:
        f.write("-- migrations/0025_naver_api_backfill.sql\n")
        f.write("-- Naver Open API /v1/search/news.json — weekly article counts.\n")
        f.write("-- data_source='backfill_exact' since count comes from authoritative\n")
        f.write("-- API total + bucketed pubDates (no scraping noise).\n")
        f.write("-- Generated by scripts/historical_backfill/naver_api_fetch.py\n\n")
        for blk in sql_blocks:
            f.write(blk + "\n")

    print("\n=== summary ===", file=sys.stderr)
    for k, status, tot, wks in summary:
        print(f"  {k:<8} {status:<30} total={tot} weeks={wks}", file=sys.stderr)
    print(f"\nMigration written: {MIGRATION_PATH}", file=sys.stderr)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--smoke", help="fetch one group and print summary")
    p.add_argument("--only", action="append", default=[],
                   help="restrict to specific group keys (repeatable)")
    args = p.parse_args()

    cid = os.environ.get("NAVER_CLIENT_ID")
    secret = os.environ.get("NAVER_CLIENT_SECRET")
    if not cid or not secret:
        sys.exit("Set NAVER_CLIENT_ID + NAVER_CLIENT_SECRET env vars")

    if args.smoke:
        run_smoke(args.smoke, cid, secret)
    else:
        run_full(cid, secret, only=(args.only or None))


if __name__ == "__main__":
    main()
