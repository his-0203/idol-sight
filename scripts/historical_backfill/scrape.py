#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "requests>=2.32",
#     "beautifulsoup4>=4.12",
#     "scrapling[all]>=0.4",
# ]
# ///
"""
Historical backfill scraper for IDOL-SIGHT.

Usage:
    uv run scripts/historical_backfill/scrape.py --group plave
    uv run scripts/historical_backfill/scrape.py --group plave --dry-run
    uv run scripts/historical_backfill/scrape.py --group plave --stealth
    uv run scripts/historical_backfill/scrape.py --emit-sql plave

Sources tried (in priority order):
    1. Wayback Machine CDX API + snapshot fetch  (high success for older groups)
    2. Naver News via StealthyFetcher (Playwright) — unblocked with stealth
    3. Social Blade via StealthyFetcher — free tier = last ~14 days only

Naver News strategy:
    StealthyFetcher fetches search.naver.com with headless Chromium.
    Naver's Fender framework renders up to 10 articles per SSR page.
    We probe start=1, 11, 21, ... to find total article count.
    Binary search between last known good start and next probe for precision.

Social Blade strategy:
    Free tier only exposes last 14 days of daily subscriber data.
    Historical data (for debut windows) is behind login/paywall.
    Only rows within a group's debut window are emitted.

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
from urllib.parse import quote_plus

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
        "sb_handle": "owis_official",  # Social Blade uses different handle (OWISofficial = 404)
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


def parse_video_count_from_html(text: str) -> Optional[int]:
    """
    Extract total video count from a YouTube channel page HTML.

    Patterns tried (in order):
    1. videosCountText.runs[0].text  — older header format (e.g. PLAVE 2022-2023)
       {"videosCountText":{"runs":[{"text":"127"},{"text":" videos"}]}}
    2. metadataParts[*].text.content matching "N videos" — newer format (e.g. SKINZ 2024+)
       {"metadataParts":[{"text":{"content":"1.34K subscribers"}},{"text":{"content":"4 videos"}}]}
    3. Korean metadataParts: "동영상 N개" pattern

    Returns integer count or None if not found.
    Anti-fabrication: returns None rather than 0 if field is absent.
    """
    # Pattern 1: videosCountText with runs array
    m = re.search(
        r'"videosCountText"\s*:\s*\{"runs"\s*:\s*\[\{"text"\s*:\s*"(\d+)"',
        text,
    )
    if m:
        try:
            return int(m.group(1))
        except ValueError:
            pass

    # Pattern 2: metadataParts content "N videos" (English, newer format)
    m2 = re.search(
        r'"content"\s*:\s*"(\d[\d,.]*)\s+videos?"',
        text,
        re.IGNORECASE,
    )
    if m2:
        raw = m2.group(1).replace(",", "")
        try:
            return int(raw)
        except ValueError:
            pass

    # Pattern 3: Korean metadataParts "동영상 N개"
    m3 = re.search(
        r'"content"\s*:\s*"동영상\s*([\d,]+)개"',
        text,
    )
    if m3:
        raw = m3.group(1).replace(",", "")
        try:
            return int(raw)
        except ValueError:
            pass

    return None


def parse_total_views_from_html(text: str) -> Optional[int]:
    """
    Extract total channel view count from a YouTube channel /about page HTML.

    This field is ONLY available on the /about page, NOT on the home page.
    On the home page, viewCountText refers to individual video view counts.

    Patterns tried (in order):
    1. viewCountText.simpleText on /about page (English):
       {"viewCountText":{"simpleText":"7,474,945 views"},"joinedDateText":...}
       Distinguished from per-video viewCountText by proximity to "joinedDateText".
    2. Korean: "조회수 N회" in viewCountText

    Returns integer count or None if not found.
    Anti-fabrication: returns None rather than 0 if field is absent.
    """
    # Pattern 1: viewCountText adjacent to joinedDateText (about page marker)
    # This distinguishes channel total views from per-video views
    m = re.search(
        r'"viewCountText"\s*:\s*\{"simpleText"\s*:\s*"([\d,]+)\s*views?"\}'
        r'.{0,200}"joinedDateText"',
        text,
        re.DOTALL,
    )
    if m:
        raw = m.group(1).replace(",", "")
        try:
            return int(raw)
        except ValueError:
            pass

    # Pattern 2: joinedDateText first, then viewCountText (reverse order)
    m2 = re.search(
        r'"joinedDateText".{0,200}"viewCountText"\s*:\s*\{"simpleText"\s*:\s*"([\d,]+)\s*views?"\}',
        text,
        re.DOTALL,
    )
    if m2:
        raw = m2.group(1).replace(",", "")
        try:
            return int(raw)
        except ValueError:
            pass

    # Pattern 3: Korean format "조회수 N회"
    m3 = re.search(
        r'"simpleText"\s*:\s*"([\d,]+)\s*(?:조회수|회)"',
        text,
    )
    if m3:
        raw = m3.group(1).replace(",", "")
        try:
            return int(raw)
        except ValueError:
            pass

    return None


def normalize_count_korean(s: Optional[str]) -> Optional[int]:
    """
    Convert Korean/English number formats to integer.
    Examples: '1만' → 10000, '1.2천' → 1200, '1.5만' → 15000,
              '123,456' → 123456, '1.34K' → 1340
    Returns None if unparseable.
    """
    if not s:
        return None
    s = s.strip().lower().replace(",", "")
    try:
        if "만" in s:
            return int(float(s.replace("만", "")) * 10_000)
        elif "천" in s:
            return int(float(s.replace("천", "")) * 1_000)
        elif "k" in s:
            return int(float(s.replace("k", "")) * 1_000)
        elif "m" in s:
            return int(float(s.replace("m", "")) * 1_000_000)
        elif "b" in s:
            return int(float(s.replace("b", "")) * 1_000_000_000)
        else:
            return int(float(s))
    except ValueError:
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


def fetch_wayback_about_snapshot(handle: str, from_ts: str, to_ts: str,
                                  max_retries: int = 3) -> Optional[tuple[str, int, int, int]]:
    """
    Try to fetch a Wayback snapshot of the YouTube channel /about page.
    The /about page contains total channel views (viewCountText), which is
    NOT available on the home page (where viewCountText is per-video only).

    Returns (source_url, yt_subscribers, yt_total_videos, yt_total_views) or None.
    Any of the three int fields may be None individually if not parseable.
    """
    about_handle = f"{handle}/about"
    cdx_url = "https://web.archive.org/cdx/search/cdx"
    params = {
        "url": f"youtube.com/{about_handle}",
        "from": from_ts,
        "to": to_ts,
        "output": "json",
        "limit": "10",
        "fl": "timestamp,statuscode",
    }
    try:
        r = requests.get(cdx_url, params=params, headers=HEADERS, timeout=30)
        if r.status_code != 200 or not r.text.strip():
            return None
        data = r.json()
        snaps = [row[0] for row in data[1:] if row[1] == "200"]
        if not snaps:
            return None
    except Exception as e:
        print(f"  [about CDX] {type(e).__name__}: {e}", file=sys.stderr)
        return None

    for ts in snaps:
        about_url = f"https://web.archive.org/web/{ts}/https://www.youtube.com/{about_handle}"
        for attempt in range(max_retries):
            try:
                resp = requests.get(about_url, headers=HEADERS, timeout=40)
                if resp.status_code == 200:
                    html = resp.text
                    raw_subs = parse_subscriber_count_from_html(html)
                    subs = normalize_subs(raw_subs)
                    videos = parse_video_count_from_html(html)
                    views = parse_total_views_from_html(html)
                    if views is not None:
                        print(f"  [about] {ts}: subs={subs}, videos={videos}, views={views:,}", flush=True)
                        return about_url, subs, videos, views
                    else:
                        print(f"  [about] {ts}: no total views found", file=sys.stderr)
                        return None
                else:
                    print(f"  [about] {ts}: HTTP {resp.status_code}", file=sys.stderr)
            except Exception as e:
                print(f"  [about] {ts} attempt {attempt+1}: {type(e).__name__}", file=sys.stderr)
                if attempt < max_retries - 1:
                    time.sleep(5 * (attempt + 1))
        time.sleep(1.0)
    return None


def fetch_wayback_snapshot(
    handle: str,
    timestamp: str,
    max_retries: int = 3,
) -> Optional[dict]:
    """
    Fetch Wayback snapshot for handle at timestamp.
    Returns dict with keys: yt_subscribers, yt_total_videos, source_url
    or None on total failure.

    yt_total_views is NOT extracted here — it requires the /about page.
    Use fetch_wayback_about_snapshot() separately to get that field.
    """
    snap_url = f"https://web.archive.org/web/{timestamp}/https://www.youtube.com/{handle}"
    for attempt in range(max_retries):
        try:
            r = requests.get(snap_url, headers=HEADERS, timeout=40)
            if r.status_code == 200:
                html = r.text
                raw = parse_subscriber_count_from_html(html)
                count = normalize_subs(raw)
                videos = parse_video_count_from_html(html)
                if count is not None or videos is not None:
                    print(
                        f"→ subs={count}, videos={videos}",
                        flush=True,
                    )
                    return {
                        "yt_subscribers": count,
                        "yt_total_videos": videos,
                        "source_url": snap_url,
                    }
                else:
                    print(
                        f"  Snapshot {timestamp}: subs='{raw}' count=None, videos=None (no data visible)",
                        file=sys.stderr,
                    )
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
# Stealth scraping helpers (Scrapling + Playwright)
# ---------------------------------------------------------------------------

def normalize_subs_sb(s: Optional[str]) -> Optional[int]:
    """
    Convert Social Blade subscriber display value to integer.
    E.g. '1.15M' → 1150000, '67.3K' → 67300, '5.51K' → 5510.
    """
    if not s or s.strip() in ('--', '', '?', 'N/A'):
        return None
    s = s.strip().lower().replace(',', '')
    try:
        if 'k' in s:
            return round(float(s.replace('k', '')) * 1_000)
        elif 'm' in s:
            return round(float(s.replace('m', '')) * 1_000_000)
        elif 'b' in s:
            return round(float(s.replace('b', '')) * 1_000_000_000)
        else:
            return int(float(s))
    except ValueError:
        return None


def socialblade_history_stealth(handle: str) -> list[tuple[str, int]]:
    """
    Fetch daily subscriber data from Social Blade via StealthyFetcher.

    Returns list of (date_str, subscriber_count) tuples for dates within
    Social Blade's free-tier data window (last ~14 days).

    Social Blade free tier limitation: only last 14 days of daily data.
    Historical data (needed for debut windows) is behind paywall.
    This function returns whatever is available — callers filter by window.
    """
    from scrapling.fetchers import StealthyFetcher
    from bs4 import BeautifulSoup

    url = f"https://socialblade.com/youtube/handle/{handle}"
    print(f"  [SB] Fetching: {url}", flush=True)
    try:
        page = StealthyFetcher.fetch(url, headless=True, network_idle=True)
        if page.status not in (200,):
            print(f"  [SB] HTTP {page.status} — skipping", file=sys.stderr)
            return []
        soup = BeautifulSoup(page.html_content, 'html.parser')
        tables = soup.find_all('table')
        if not tables:
            print(f"  [SB] No table found — page may require login", file=sys.stderr)
            return []

        rows = tables[0].find_all('tr')
        data: list[tuple[str, int]] = []
        for row in rows[1:]:  # skip header
            cells = row.find_all('td')
            if not cells:
                continue
            date_text = cells[0].get_text(strip=True)
            date_match = re.search(r'(\d{4}-\d{2}-\d{2})', date_text)
            if not date_match:
                continue
            date_str = date_match.group(1)
            # cells[1] = daily change, cells[2] = total subscribers
            total_raw = cells[2].get_text(strip=True) if len(cells) > 2 else ''
            count = normalize_subs_sb(total_raw)
            if count is not None:
                data.append((date_str, count))
        print(f"  [SB] Got {len(data)} rows ({data[0][0] if data else 'none'} to {data[-1][0] if data else 'none'})")
        return data
    except Exception as e:
        print(f"  [SB] ERROR: {type(e).__name__}: {e}", file=sys.stderr)
        return []


def _naver_query_encode(query: str) -> str:
    """
    Encode a Naver search query for URL use.

    Naver's Fender framework expects:
    - Quoted phrases: "word" → %22word%22
    - Boolean OR: use pipe | encoded as %7C (NOT the word OR)
    - The word OR in the query string causes Fender to return "no results"

    Input may contain ' OR ' separators — these are converted to pipe.
    """
    # Replace ' OR ' with pipe character, then URL-encode the whole thing
    query_normalized = query.replace(' OR ', '|')
    return quote_plus(query_normalized)


def naver_news_count_stealth_with_browser(bpage, query: str, ds: str, de: str) -> Optional[int]:
    """
    Count Naver news articles using a pre-opened Playwright page.

    Called from scrape_group_stealth which manages the browser lifecycle.
    Reusing the same page across calls avoids repeated browser launch overhead.

    query: raw search string (e.g. '"플레이브" OR "PLAVE"')
    ds: start date 'YYYY.MM.DD'
    de: end date 'YYYY.MM.DD'

    Returns article count estimate. Accuracy:
    - 0: confirmed zero results (Fender shows "검색결과가 없습니다")
    - 1-10: exact (Fender SSR renders all articles on first page)
    - 11+: exact to ±10 (binary search narrows to nearest 10-article page boundary)
    - 1001+: capped at 1001 (probed up to start=1001 without finding empty)
    """
    query_enc = _naver_query_encode(query)

    def fetch_html(start: int) -> str:
        url = (
            "https://search.naver.com/search.naver"
            f"?where=news&query={query_enc}&sort=1&pd=3"
            f"&ds={ds}&de={de}&start={start}"
        )
        bpage.goto(url)
        bpage.wait_for_load_state('networkidle')
        return bpage.content()

    def count_articles(html: str) -> int:
        """Count SSR-rendered articles by Fender class marker."""
        return html.count('Daw8Xs3TT8ELqac9gpFp')

    def is_empty(html: str) -> bool:
        """True if Naver returned no results for this start offset."""
        return '검색결과가 없습니다' in html

    html1 = fetch_html(1)
    if is_empty(html1):
        return 0
    page1_count = count_articles(html1)
    if page1_count == 0:
        # Fender returned content but rendered 0 articles — treat as 0
        return 0

    # Fast-path: if page1 rendered fewer than 10, total ≤ 10
    if page1_count < 10:
        return page1_count

    # Exponential probe to find upper bound
    probes = [11, 21, 51, 101, 201, 501, 1001]
    last_good_start = 1
    for probe_start in probes:
        html = fetch_html(probe_start)
        if is_empty(html):
            # Total < probe_start. Binary-search between last_good and probe_start.
            lo, hi = last_good_start, probe_start
            while hi - lo > 10:
                mid = lo + ((hi - lo) // 10) * 10
                if mid == lo:
                    break
                html_mid = fetch_html(mid)
                if is_empty(html_mid):
                    hi = mid
                else:
                    lo = mid
            # lo is the last start where we got results; count its articles
            last_page_html = fetch_html(lo)
            return lo + count_articles(last_page_html) - 1
        last_good_start = probe_start

    # Reached start=1001 with results — over 1001 articles
    return 1001


def naver_news_count_stealth(query: str, ds: str, de: str) -> Optional[int]:
    """
    Standalone wrapper for naver_news_count_stealth_with_browser.
    Opens its own browser context — use only for one-off calls / smoke tests.
    For batch calls, use scrape_group_stealth which reuses the browser.
    """
    from playwright.sync_api import sync_playwright
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
            ctx = browser.new_context(viewport={'width': 1280, 'height': 900})
            bpage = ctx.new_page()
            result = naver_news_count_stealth_with_browser(bpage, query, ds, de)
            browser.close()
            return result
    except Exception as e:
        print(f"  [Naver] ERROR: {type(e).__name__}: {e}", file=sys.stderr)
        return None


def scrape_group_stealth(group_key: str, dry_run: bool = False) -> list[dict]:
    """
    Scrape historical data for one group using stealth fetchers.
    Extends the data from existing CSV (if present) with:
    - Naver News article counts (via StealthyFetcher + Playwright)
    - Social Blade subscriber data (free tier: last ~14 days)

    Returns merged list of Row dicts.
    """
    cfg = GROUPS[group_key]
    # Social Blade handle may differ from YouTube handle
    handle = cfg.get("sb_handle") or cfg["yt_handle"].lstrip('@')
    window_start = cfg["window_start"]
    window_end = cfg["window_end"]
    naver_query = cfg["naver_query"]

    print(f"\n{'='*60}")
    print(f"[STEALTH] Scraping {cfg['display_name']}")
    print(f"  Handle: {cfg['yt_handle']}")
    print(f"  Window: {window_start} ~ {window_end}")
    print(f"{'='*60}")

    # Load existing CSV rows (may have Wayback subs data)
    csv_path = SCRIPT_DIR / f"{group_key}.csv"
    existing: dict[str, dict] = {}
    if csv_path.exists():
        with open(csv_path, newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                existing[row["snapshot_date"]] = row

    # --- Source 1: Social Blade (subscriber snapshots, last ~14 days) ---
    print(f"\n[A] Social Blade subscriber data for @{handle}...")
    sb_data = socialblade_history_stealth(handle)
    sb_in_window = [
        (d, c) for d, c in sb_data
        if window_start <= d <= window_end
    ]
    print(f"    Total SB rows: {len(sb_data)}, in-window: {len(sb_in_window)}")

    for date_str, count in sb_in_window:
        if date_str not in existing or not existing[date_str].get("yt_subscribers"):
            sb_url = f"https://socialblade.com/youtube/handle/{handle}"
            existing.setdefault(date_str, {
                "snapshot_date": date_str,
                "yt_subscribers": "",
                "yt_total_videos": "",
                "yt_total_views": "",
                "naver_total_news": "",
                "subs_source": "",
                "news_source": "",
            })
            existing[date_str]["yt_subscribers"] = count
            existing[date_str]["subs_source"] = sb_url

    # --- Source 2: Naver News (weekly counts for all Mondays in window) ---
    print(f"\n[B] Naver News counts for '{naver_query}'...")
    mondays = mondays_in_range(window_start, window_end)
    print(f"    {len(mondays)} Mondays in window")
    naver_total = 0
    naver_errors = 0

    from playwright.sync_api import sync_playwright
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
            ctx = browser.new_context(viewport={'width': 1280, 'height': 900})
            bpage = ctx.new_page()

            for monday in mondays:
                date_str = monday.isoformat()
                sunday = monday + timedelta(days=6)
                ds = monday.strftime("%Y.%m.%d")
                de = sunday.strftime("%Y.%m.%d")

                # Skip if we already have news data for this date
                row = existing.get(date_str, {})
                if row.get("naver_total_news") not in ("", None):
                    print(f"  {date_str}: already has news ({row['naver_total_news']}), skip")
                    continue

                print(f"  {date_str} ({ds}~{de})...", end=" ", flush=True)
                try:
                    count = naver_news_count_stealth_with_browser(bpage, naver_query, ds, de)
                except Exception as e:
                    print(f"ERROR ({type(e).__name__})")
                    naver_errors += 1
                    # Try to recover: close and reopen page
                    try:
                        bpage.close()
                        bpage = ctx.new_page()
                    except Exception:
                        pass
                    continue

                if count is None:
                    print("→ None (error)")
                    naver_errors += 1
                    continue
                print(f"→ {count}")
                naver_total += 1

                naver_url = (
                    "https://search.naver.com/search.naver"
                    f"?where=news&query={_naver_query_encode(naver_query)}"
                    f"&sort=1&pd=3&ds={ds}&de={de}"
                )
                existing.setdefault(date_str, {
                    "snapshot_date": date_str,
                    "yt_subscribers": "",
                    "yt_total_videos": "",
                    "yt_total_views": "",
                    "naver_total_news": "",
                    "subs_source": "",
                    "news_source": "",
                })
                existing[date_str]["naver_total_news"] = count
                existing[date_str]["news_source"] = naver_url

                time.sleep(1.5)  # Polite delay between Naver requests

            browser.close()
    except Exception as e:
        print(f"\n  [Naver] Browser-level error: {type(e).__name__}: {e}", file=sys.stderr)

    print(f"\n  Naver: {naver_total} new counts retrieved, {naver_errors} errors")

    rows = sorted(existing.values(), key=lambda r: r["snapshot_date"])
    print(f"\nTotal rows for {group_key}: {len(rows)}")
    non_empty_subs = sum(1 for r in rows if r.get("yt_subscribers") not in ("", None))
    non_empty_vids = sum(1 for r in rows if r.get("yt_total_videos") not in ("", None))
    non_empty_views = sum(1 for r in rows if r.get("yt_total_views") not in ("", None))
    non_empty_news = sum(1 for r in rows if r.get("naver_total_news") not in ("", None, "0", 0))
    print(f"  Rows with yt_subscribers: {non_empty_subs}")
    print(f"  Rows with yt_total_videos: {non_empty_vids}")
    print(f"  Rows with yt_total_views: {non_empty_views}")
    print(f"  Rows with naver_total_news (>0): {non_empty_news}")

    return rows


# ---------------------------------------------------------------------------
# Main scraping logic
# ---------------------------------------------------------------------------

Row = dict  # keys: snapshot_date, yt_subscribers, yt_total_videos, yt_total_views,
            #       naver_total_news, subs_source, news_source


def scrape_group(group_key: str, dry_run: bool = False) -> list[Row]:
    """
    Scrape historical data for one group.
    Returns list of Row dicts.

    Extended in v2 to also extract yt_total_videos and yt_total_views.
    - yt_total_videos: parsed from channel home page (videosCountText or metadataParts)
    - yt_total_views: parsed from channel /about page (viewCountText adjacent to joinedDateText)
                      Only available when Wayback has archived the /about page.
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

    # Pre-load existing CSV rows so we can preserve naver_total_news and other
    # previously scraped data while updating with new Wayback fields.
    results: dict[str, Row] = {}  # keyed by snapshot_date
    csv_path = SCRIPT_DIR / f"{group_key}.csv"
    if csv_path.exists():
        with open(csv_path, newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                results[row["snapshot_date"]] = {
                    "snapshot_date": row["snapshot_date"],
                    "yt_subscribers": row.get("yt_subscribers", ""),
                    "yt_total_videos": row.get("yt_total_videos", ""),
                    "yt_total_views": row.get("yt_total_views", ""),
                    "naver_total_news": row.get("naver_total_news", ""),
                    "subs_source": row.get("subs_source", ""),
                    "news_source": row.get("news_source", ""),
                }
        print(f"  Loaded {len(results)} existing rows from {csv_path.name}")

    # Step 1: Get CDX snapshots for the channel home page
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
                existing_row = results.get(date_str)
                if existing_row is None:
                    # New row: create with all fields
                    results[date_str] = {
                        "snapshot_date": date_str,
                        "yt_subscribers": result["yt_subscribers"],
                        "yt_total_videos": result["yt_total_videos"],
                        "yt_total_views": "",
                        "naver_total_news": "",
                        "subs_source": result["source_url"],
                        "news_source": "",
                    }
                else:
                    # Update existing row: merge new Wayback data into existing row,
                    # preserving naver_total_news and other fields already present.
                    if result["yt_subscribers"] is not None:
                        existing_row["yt_subscribers"] = result["yt_subscribers"]
                        existing_row["subs_source"] = result["source_url"]
                    if result["yt_total_videos"] is not None:
                        existing_row["yt_total_videos"] = result["yt_total_videos"]
            else:
                print("→ no data")
            time.sleep(1.0)

    # Step 1b: Try to fetch /about page snapshots for total channel views
    # The /about page contains viewCountText with total channel views (not per-video).
    # This is separate from the home page and may not be archived.
    print(f"\n[1b] Querying Wayback CDX for {handle}/about (total channel views)...")
    about_result = fetch_wayback_about_snapshot(handle, from_ts, to_ts)
    if about_result:
        about_url, about_subs, about_videos, about_views = about_result
        # Find which snapshot date is closest to this about page
        # The about page timestamp may differ from home page timestamps
        # Store the views on the closest existing row or create a new one
        # Parse the about URL timestamp
        about_ts_match = re.search(r'/web/(\d{14})/', about_url)
        if about_ts_match:
            about_ts = about_ts_match.group(1)
            about_date = ts_to_date(about_ts).isoformat()
            if about_date in results:
                results[about_date]["yt_total_views"] = about_views
                # Also fill subs/videos if missing in existing row
                if about_subs is not None and not results[about_date].get("yt_subscribers"):
                    results[about_date]["yt_subscribers"] = about_subs
                    results[about_date]["subs_source"] = about_url
                if about_videos is not None and not results[about_date].get("yt_total_videos"):
                    results[about_date]["yt_total_videos"] = about_videos
                print(f"  [about] Applied total_views={about_views:,} to existing row {about_date}")
            else:
                # Create a new row for the about page date
                results[about_date] = {
                    "snapshot_date": about_date,
                    "yt_subscribers": about_subs,
                    "yt_total_videos": about_videos,
                    "yt_total_views": about_views,
                    "naver_total_news": "",
                    "subs_source": about_url,
                    "news_source": "",
                }
                print(f"  [about] Created new row {about_date}: subs={about_subs}, videos={about_videos}, views={about_views:,}")
    else:
        print(f"  [about] No /about page snapshot found for {handle} — yt_total_views will be NULL")

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
                "yt_total_videos": "",
                "yt_total_views": "",
                "naver_total_news": "",
                "subs_source": "no_snapshot",
                "news_source": "",
            }
        print(f"    Created {len(results)} empty rows")

    rows = sorted(results.values(), key=lambda r: r["snapshot_date"])
    print(f"\nTotal rows for {group_key}: {len(rows)}")
    non_empty_subs = sum(1 for r in rows if r.get("yt_subscribers") not in ("", None))
    non_empty_vids = sum(1 for r in rows if r.get("yt_total_videos") not in ("", None))
    non_empty_views = sum(1 for r in rows if r.get("yt_total_views") not in ("", None))
    print(f"  Rows with yt_subscribers: {non_empty_subs}")
    print(f"  Rows with yt_total_videos: {non_empty_vids}")
    print(f"  Rows with yt_total_views: {non_empty_views}")
    print(f"  Rows with naver_total_news: 0 (blocked)")

    return rows


def write_csv(group_key: str, rows: list[Row]) -> Path:
    """Write rows to CSV file. Returns path.

    Extended in v2 to include yt_total_videos and yt_total_views columns.
    Added to the right of existing columns for backward compatibility.
    Readers should treat missing columns as NULL.
    """
    csv_path = SCRIPT_DIR / f"{group_key}.csv"
    fieldnames = [
        "snapshot_date", "yt_subscribers", "naver_total_news",
        "subs_source", "news_source",
        "yt_total_videos", "yt_total_views",  # new columns (v2)
    ]
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
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
    """Read CSV and print SQL INSERT block for the group.

    Extended in v2 to emit yt_total_videos and yt_total_views from CSV.
    ON CONFLICT clause now COALESCEs all three YouTube columns.
    """
    rows = read_csv(group_key)
    cfg = GROUPS[group_key]

    # Filter to rows that have at least one data column
    data_rows = [
        r for r in rows
        if r.get("yt_subscribers") or r.get("naver_total_news")
        or r.get("yt_total_videos") or r.get("yt_total_views")
    ]
    if not data_rows:
        print(f"-- WARNING: no data rows for {group_key} — no INSERT generated", file=sys.stderr)
        return

    news_rows = sum(1 for r in data_rows if int(r.get("naver_total_news") or 0) > 0)
    subs_rows = sum(1 for r in data_rows if r.get("yt_subscribers"))
    vids_rows = sum(1 for r in data_rows if r.get("yt_total_videos"))
    views_rows = sum(1 for r in data_rows if r.get("yt_total_views"))
    print(f"-- ============================================================")
    print(f"-- {group_key.upper()} backfill via scrape.py (Wayback + Naver stealth + Social Blade)")
    print(f"-- debut {cfg['debut_date']}, window {cfg['window_start']} ~ {cfg['window_end']}")
    print(f"-- yt_subscribers rows: {subs_rows} (Wayback Machine + Social Blade free tier)")
    print(f"-- yt_total_videos rows: {vids_rows} (Wayback Machine channel home page)")
    print(f"-- yt_total_views rows: {views_rows} (Wayback Machine channel /about page)")
    print(f"-- naver_total_news rows with >0: {news_rows} (StealthyFetcher/Playwright)")
    print(f"-- See scripts/historical_backfill/SOURCES.md for per-row provenance.")
    print(f"-- ============================================================")
    print(f"INSERT INTO agg_summary")
    print(f"  (group_key, snapshot_at,")
    print(f"   yt_total_videos, yt_total_views, yt_subscribers,")
    print(f"   dc_total_posts, theqoo_posts, instiz_posts,")
    print(f"   naver_total_news, controversy_count, data_source)")
    print(f"VALUES")

    value_lines = []
    for row in data_rows:
        subs = row.get("yt_subscribers", "")
        news = row.get("naver_total_news", "")
        videos = row.get("yt_total_videos", "")
        views = row.get("yt_total_views", "")
        subs_val = int(subs) if subs else "NULL"
        news_val = int(news) if news else 0
        videos_val = int(videos) if videos else "NULL"
        views_val = int(views) if views else "NULL"
        snap_date = row["snapshot_date"]
        snapshot_at = f"{snap_date}T00:00:00Z"
        value_lines.append(
            f"  ('{group_key}', '{snapshot_at}', {videos_val}, {views_val}, {subs_val},"
            f"\n   0, 0, 0, {news_val}, 0, 'backfill_estimate')"
        )

    print(",\n".join(value_lines))
    print("ON CONFLICT(group_key, snapshot_at) DO UPDATE SET")
    print("  yt_subscribers   = COALESCE(excluded.yt_subscribers, agg_summary.yt_subscribers),")
    print("  yt_total_videos  = COALESCE(excluded.yt_total_videos, agg_summary.yt_total_videos),")
    print("  yt_total_views   = COALESCE(excluded.yt_total_views, agg_summary.yt_total_views),")
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
    parser.add_argument("--stealth", action="store_true",
                        help="Use StealthyFetcher (Playwright) for Naver News + Social Blade")

    args = parser.parse_args()

    if args.emit_sql:
        emit_sql(args.emit_sql)
    elif args.group:
        if args.stealth:
            rows = scrape_group_stealth(args.group, dry_run=args.dry_run)
        else:
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
