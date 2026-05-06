#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "requests>=2.32",
#     "beautifulsoup4>=4.12",
# ]
# ///
"""
Historical backfill scraper for IDOL-SIGHT.

Usage:
    uv run scripts/historical_backfill/scrape.py --group plave
    uv run scripts/historical_backfill/scrape.py --group plave --dry-run
    uv run scripts/historical_backfill/scrape.py --emit-sql plave

Sources tried (in priority order):
    1. Wayback Machine CDX API + snapshot fetch  (high success for older groups)
    2. Naver News search (BLOCKED from this IP — 403 on all requests)

Anti-fabrication: every row written must trace to a real HTTP response.
Missing values are written as empty CSV cells — never interpolated.
"""

import argparse
import csv
import os
import re
import sys
import time
from datetime import date, timedelta
from pathlib import Path
from typing import Optional

import requests

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).parent

GROUPS: dict[str, dict] = {
    "plave": {
        "debut_date": "2023-03-12",
        "window_start": "2022-09-13",
        "window_end": "2023-06-10",
        "yt_handle": "@plave_official",
        "yt_channel_id": "UCPZIPuQPrfrUG9Xe_okEmQA",
        "naver_query": '"플레이브" OR "PLAVE"',
        "display_name": "PLAVE (플레이브)",
    },
    "skinz": {
        "debut_date": "2025-04-10",
        "window_start": "2024-10-12",
        "window_end": "2025-07-09",
        "yt_handle": "@SKINZOFFICIAL",
        "yt_channel_id": None,  # not yet determined
        "naver_query": '"스킨즈" OR "SKINZ"',
        "display_name": "SKINZ (스킨즈)",
    },
    "myrakl": {
        "debut_date": "2026-01-26",
        "window_start": "2025-07-30",
        "window_end": "2026-04-26",
        "yt_handle": "@myrakl_official",
        "yt_channel_id": None,
        "naver_query": '"마이라클" OR "MY:RAKL" OR "MYRAKL"',
        "display_name": "MY:RAKL",
    },
    "owis": {
        "debut_date": "2026-03-23",
        "window_start": "2025-09-24",
        "window_end": "2026-05-06",
        "yt_handle": "@OWISofficial",
        "yt_channel_id": None,
        "naver_query": '"오위스" OR "OWIS"',
        "display_name": "OWIS",
    },
}

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

# ---------------------------------------------------------------------------
# Wayback Machine helpers
# ---------------------------------------------------------------------------

def get_cdx_snapshots(handle: str, from_ts: str, to_ts: str, max_retries: int = 3) -> list[str]:
    """Return list of Wayback Machine timestamps for a YouTube channel handle."""
    url_pat = f"youtube.com/{handle}"
    cdx_url = "https://web.archive.org/cdx/search/cdx"
    params = {
        "url": url_pat,
        "from": from_ts,
        "to": to_ts,
        "output": "json",
        "limit": "200",
        "fl": "timestamp,statuscode",
    }
    for attempt in range(max_retries):
        try:
            r = requests.get(cdx_url, params=params, headers=HEADERS, timeout=45)
            if r.status_code == 200 and r.text.strip():
                data = r.json()
                snaps = [row[0] for row in data[1:] if row[1] == "200"]
                return snaps
            return []
        except Exception as e:
            print(f"  CDX attempt {attempt+1} failed: {type(e).__name__}: {e}", file=sys.stderr)
            if attempt < max_retries - 1:
                time.sleep(5 * (attempt + 1))
    return []


def parse_subscriber_count_from_html(text: str) -> Optional[str]:
    """
    Extract raw subscriber count string from a YouTube channel page HTML.
    Works for both Wayback Machine snapshots and live pages.

    Two patterns observed:
    1. subscriberCountText > simpleText  (most common, older format)
    2. metadataParts[*].text.content    (newer YouTube format, < ~5K subs)
    """
    # Pattern 1: subscriberCountText simpleText
    m = re.search(
        r'"subscriberCountText"\s*:\s*\{[^}]*"simpleText"\s*:\s*"([^"]+)"',
        text,
    )
    if m:
        return m.group(1)

    # Pattern 2: metadataParts content string matching subscriber pattern
    for m2 in re.finditer(r'"content"\s*:\s*"([^"]*subscriber[^"]*)"', text, re.IGNORECASE):
        val = m2.group(1)
        if re.search(r'[\d.,KkMmBb]', val):
            return val

    # Pattern 3: accessibility label
    m3 = re.search(
        r'"label"\s*:\s*"([\d.,]+\s*[KkMmBb]?\s*subscribers?)"',
        text,
        re.IGNORECASE,
    )
    if m3:
        return m3.group(1)

    return None


def normalize_subs(s: Optional[str]) -> Optional[int]:
    """Convert '91.3K subscribers' → 91300, '1.34K subscribers' → 1340, etc."""
    if not s:
        return None
    s = s.lower()
    # Remove all suffix text
    s = re.sub(r'\s*subscribers?\s*', '', s).replace(',', '').strip()
    try:
        if "k" in s:
            return int(float(s.replace("k", "")) * 1_000)
        elif "m" in s:
            return int(float(s.replace("m", "")) * 1_000_000)
        elif "b" in s:
            return int(float(s.replace("b", "")) * 1_000_000_000)
        elif "만" in s:
            return int(float(s.replace("만", "")) * 10_000)
        else:
            return int(float(s))
    except ValueError:
        return None


def fetch_wayback_snapshot(handle: str, timestamp: str, max_retries: int = 3) -> Optional[tuple[int, str]]:
    """
    Fetch Wayback snapshot for handle at timestamp.
    Returns (subscriber_count, source_url) or None on failure.
    """
    snap_url = f"https://web.archive.org/web/{timestamp}/https://www.youtube.com/{handle}"
    for attempt in range(max_retries):
        try:
            r = requests.get(snap_url, headers=HEADERS, timeout=40)
            if r.status_code == 200:
                raw = parse_subscriber_count_from_html(r.text)
                count = normalize_subs(raw)
                if count is not None:
                    return count, snap_url
                else:
                    print(f"  Snapshot {timestamp}: parsed='{raw}' count=None (no subs visible)", file=sys.stderr)
                    return None
            else:
                print(f"  Snapshot {timestamp}: HTTP {r.status_code}", file=sys.stderr)
                return None
        except Exception as e:
            print(f"  Snapshot {timestamp} attempt {attempt+1}: {type(e).__name__}", file=sys.stderr)
            if attempt < max_retries - 1:
                time.sleep(5 * (attempt + 1))
    return None


# ---------------------------------------------------------------------------
# Date helpers
# ---------------------------------------------------------------------------

def mondays_in_range(start: str, end: str) -> list[date]:
    """Return all Mondays between start and end date strings (inclusive)."""
    d = date.fromisoformat(start)
    end_d = date.fromisoformat(end)
    # Move to next Monday if not already Monday (weekday 0)
    while d.weekday() != 0:
        d += timedelta(days=1)
    result = []
    while d <= end_d:
        result.append(d)
        d += timedelta(weeks=1)
    return result


def ts_to_date(ts: str) -> date:
    """Convert Wayback timestamp '20230325173246' → date(2023, 3, 25)."""
    return date(int(ts[:4]), int(ts[4:6]), int(ts[6:8]))


def find_nearest_monday(d: date) -> date:
    """Round a date to the nearest Monday."""
    offset = d.weekday()  # 0=Mon, 6=Sun
    if offset <= 3:
        return d - timedelta(days=offset)
    else:
        return d + timedelta(days=(7 - offset))


# ---------------------------------------------------------------------------
# Main scraping logic
# ---------------------------------------------------------------------------

Row = dict  # keys: snapshot_date, yt_subscribers, naver_total_news, subs_source, news_source


def scrape_group(group_key: str, dry_run: bool = False) -> list[Row]:
    """
    Scrape historical data for one group.
    Returns list of Row dicts.
    """
    cfg = GROUPS[group_key]
    handle = cfg["yt_handle"]
    window_start = cfg["window_start"]
    window_end = cfg["window_end"]

    print(f"\n{'='*60}")
    print(f"Scraping {cfg['display_name']}")
    print(f"  Handle: {handle}")
    print(f"  Window: {window_start} ~ {window_end}")
    print(f"{'='*60}")

    results: dict[str, Row] = {}  # keyed by snapshot_date

    # Step 1: Get CDX snapshots for the channel
    from_ts = window_start.replace("-", "")
    to_ts = window_end.replace("-", "")
    print(f"\n[1] Querying Wayback CDX for {handle}...")
    snapshots = get_cdx_snapshots(handle, from_ts, to_ts)
    print(f"    Found {len(snapshots)} status-200 snapshots")

    if snapshots:
        time.sleep(1.0)
        for ts in snapshots:
            snap_date = ts_to_date(ts)
            date_str = snap_date.isoformat()
            print(f"  Fetching snapshot {ts} ({date_str})...", end=" ", flush=True)
            result = fetch_wayback_snapshot(handle, ts)
            if result:
                count, source_url = result
                print(f"→ {count:,}")
                # If we already have a row for this date, keep the one with data
                if date_str not in results or results[date_str]["yt_subscribers"] is None:
                    results[date_str] = {
                        "snapshot_date": date_str,
                        "yt_subscribers": count,
                        "naver_total_news": "",
                        "subs_source": source_url,
                        "news_source": "",
                    }
            else:
                print("→ no subs data")
            time.sleep(1.0)

    # Step 2: Naver News (currently blocked from this IP — 403 on all requests)
    # All requests return 403 "검색 서비스 이용이 제한되었습니다."
    # We skip Naver and leave naver_total_news blank for all rows.
    # (Documented in SOURCES.md)
    print("\n[2] Naver News: BLOCKED from this IP (403 on all search.naver.com requests)")
    print("    → naver_total_news left empty for all rows")

    # Step 3: Ensure we have rows for all Mondays in window (even if data is empty)
    # We only add Monday rows if we have NO data at all from Wayback —
    # the point is to record actual scraped data, not create empty rows.
    # If Wayback had snapshots, we only emit those.
    # If Wayback had NO snapshots, we emit an empty skeleton just for the window
    # (useful to show the gap explicitly without fabricating data).
    if not results:
        print(f"\n[3] No Wayback snapshots — creating empty skeleton for window")
        mondays = mondays_in_range(window_start, window_end)
        for d in mondays:
            date_str = d.isoformat()
            results[date_str] = {
                "snapshot_date": date_str,
                "yt_subscribers": "",
                "naver_total_news": "",
                "subs_source": "no_snapshot",
                "news_source": "",
            }
        print(f"    Created {len(results)} empty rows")

    rows = sorted(results.values(), key=lambda r: r["snapshot_date"])
    print(f"\nTotal rows for {group_key}: {len(rows)}")
    non_empty_subs = sum(1 for r in rows if r["yt_subscribers"] != "")
    print(f"  Rows with yt_subscribers: {non_empty_subs}")
    print(f"  Rows with naver_total_news: 0 (blocked)")

    return rows


def write_csv(group_key: str, rows: list[Row]) -> Path:
    """Write rows to CSV file. Returns path."""
    csv_path = SCRIPT_DIR / f"{group_key}.csv"
    fieldnames = ["snapshot_date", "yt_subscribers", "naver_total_news", "subs_source", "news_source"]
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    print(f"  Written: {csv_path}")
    return csv_path


def read_csv(group_key: str) -> list[Row]:
    """Read rows from CSV file."""
    csv_path = SCRIPT_DIR / f"{group_key}.csv"
    if not csv_path.exists():
        print(f"ERROR: {csv_path} not found. Run without --emit-sql first.", file=sys.stderr)
        sys.exit(1)
    rows = []
    with open(csv_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append(row)
    return rows


# ---------------------------------------------------------------------------
# SQL emission
# ---------------------------------------------------------------------------

def emit_sql(group_key: str) -> None:
    """Read CSV and print SQL INSERT block for the group."""
    rows = read_csv(group_key)
    cfg = GROUPS[group_key]

    # Filter to rows that have at least one data column
    data_rows = [r for r in rows if r.get("yt_subscribers") or r.get("naver_total_news")]
    if not data_rows:
        print(f"-- WARNING: no data rows for {group_key} — no INSERT generated", file=sys.stderr)
        return

    print(f"-- ============================================================")
    print(f"-- {group_key.upper()} backfill via scrape.py")
    print(f"-- debut {cfg['debut_date']}, window {cfg['window_start']} ~ {cfg['window_end']}")
    print(f"-- Source: Wayback Machine snapshots of youtube.com/{cfg['yt_handle']}")
    print(f"-- Naver News: BLOCKED (403 from scraper IP) — naver_total_news=0 for all rows")
    print(f"-- See scripts/historical_backfill/SOURCES.md for per-row provenance.")
    print(f"-- ============================================================")
    print(f"INSERT INTO agg_summary")
    print(f"  (group_key, snapshot_at,")
    print(f"   yt_total_videos, yt_total_views, yt_subscribers,")
    print(f"   dc_total_posts, theqoo_posts, instiz_posts,")
    print(f"   naver_total_news, twitter_posts, controversy_count, data_source)")
    print(f"VALUES")

    value_lines = []
    for row in data_rows:
        subs = row.get("yt_subscribers", "")
        news = row.get("naver_total_news", "")
        subs_val = int(subs) if subs else "NULL"
        news_val = int(news) if news else 0
        snap_date = row["snapshot_date"]
        snapshot_at = f"{snap_date}T00:00:00Z"
        value_lines.append(
            f"  ('{group_key}', '{snapshot_at}', NULL, NULL, {subs_val},"
            f"\n   0, 0, 0, {news_val}, 0, 0, 'backfill_estimate')"
        )

    print(",\n".join(value_lines))
    print("ON CONFLICT(group_key, snapshot_at) DO UPDATE SET")
    print("  yt_subscribers   = COALESCE(excluded.yt_subscribers, agg_summary.yt_subscribers),")
    print("  naver_total_news = CASE")
    print("    WHEN agg_summary.naver_total_news = 0 THEN excluded.naver_total_news")
    print("    ELSE agg_summary.naver_total_news")
    print("  END,")
    print("  data_source = excluded.data_source;")
    print()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Historical backfill scraper for IDOL-SIGHT")
    group_choices = list(GROUPS.keys())

    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--group", choices=group_choices, help="Scrape one group and write CSV")
    mode.add_argument("--emit-sql", dest="emit_sql", choices=group_choices,
                      help="Read existing CSV and print SQL INSERT block")

    parser.add_argument("--dry-run", action="store_true",
                        help="Preview results without writing CSV")

    args = parser.parse_args()

    if args.emit_sql:
        emit_sql(args.emit_sql)
    elif args.group:
        rows = scrape_group(args.group, dry_run=args.dry_run)
        if args.dry_run:
            print("\n[DRY RUN] Would write:")
            for r in rows:
                print(f"  {r}")
        else:
            write_csv(args.group, rows)
            print(f"\nDone. Run with --emit-sql {args.group} to generate SQL.")
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
