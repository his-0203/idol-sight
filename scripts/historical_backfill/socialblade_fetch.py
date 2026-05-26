#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "requests>=2.32",
# ]
# ///
"""Social Blade Matrix API client for historical backfill.

Why this exists: Wayback Machine + production youtube_videos table
yielded sparse data for SKINZ/MYRAKL/OWIS pre-debut window. The user
subscribed to Social Blade Personal Premium Silver ($9.99) which
includes 5 API credits — enough to fetch full 3-year daily history
for all 4 backfilled groups (PLAVE/SKINZ/MYRAKL/OWIS).

API call pattern (1 credit per channel; 30-day cache for free re-runs):
  GET https://matrix.sbapis.com/b/youtube/statistics
      ?query=<handle>&history=archive
  Headers: clientid + token

Response (per the SocialBlade/socialblade-js TypeScript interfaces):
  data.daily: [ { date: "YYYY-MM-DD", subs: int, views: int }, ... ]
  data.statistics.total: { subscribers, views, uploads }   # current only

Daily array covers up to 3 years (YouTube specific limit). Each entry
is one calendar day. We filter to the per-group [debut-180d, debut+90d]
window and emit:
  - <group>_socialblade.csv  for human inspection
  - migrations/0023_socialblade_backfill.sql  with INSERT...VALUES
    blocks per group + the canonical ON CONFLICT UPSERT pattern.

Usage:
  export SOCIALBLADE_CLIENT_ID=<your_client_id>
  export SOCIALBLADE_TOKEN=<your_access_token>

  # Smoke test one group first to verify handle + response shape:
  uv run scripts/historical_backfill/socialblade_fetch.py --smoke plave

  # Then full run (consumes 4 credits):
  uv run scripts/historical_backfill/socialblade_fetch.py

  # Override handle if default is wrong:
  uv run scripts/historical_backfill/socialblade_fetch.py --handle myrakl=@myrakl

The script does NOT auto-apply the migration — review the generated SQL
manually, then `wrangler d1 migrations apply --local` to test.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import requests

API_URL = "https://matrix.sbapis.com/b/youtube/statistics"
USER_AGENT = "idol-sight historical backfill / Python requests"

# Per-group config. Handles are best guesses based on Wayback CDX results
# (PLAVE confirmed via prior scrape; SKINZ confirmed via prior scrape;
# MYRAKL/OWIS Wayback found 0 snapshots so handles are unverified).
# Override at runtime via --handle <key>=<handle> if Social Blade rejects.
GROUPS: list[dict[str, Any]] = [
    {"key": "plave",   "handle": "@plave_official",  "debut": "2023-03-12"},
    {"key": "skinz",   "handle": "@skinzofficial",   "debut": "2025-04-10"},
    {"key": "myrakl",  "handle": "@myrakl_official", "debut": "2026-01-26"},
    {"key": "owis",    "handle": "@owis_official",   "debut": "2026-03-23"},
    # WE GO-6 (위고식스) — pre-debut, debut date TBA. apply_window auto-
    # False because debut is None (normalize_daily short-circuits).
    {"key": "wegosix", "handle": "@wegosix",         "debut": None},
    # B:DAWN (비던) — debut 2026-05-06 (BEOM, Duri Entertainment).
    # Channel ID UCSIqs6OAVAedCmCo8GtVoHQ confirmed via groups seed
    # (migration 0002). Handle '@b_dawn_official' is a guess derived
    # from twitter_handles in the seed; if SB rejects, retry with the
    # bare channel ID (Matrix API accepts both):
    #   --handle bdawn=UCSIqs6OAVAedCmCo8GtVoHQ
    {"key": "bdawn",   "handle": "@b_dawn_official", "debut": "2026-05-06"},
    # UR:L (유아렐, uryael) — 샌드박스네트워크 첫 버추얼 아이돌. 데뷔
    # 2025-12-31 (Chemical Love). Channel ID UCLAA9TKj-EYf2RUl1gLB9pQ
    # 직접 시드 — handle '@URL-유아렐' 은 SocialBlade API 에 URL-encoded
    # 한글 핸들이 거절될 수 있어 channel ID 우선. V2.33.
    {"key": "uryael",  "handle": "UCLAA9TKj-EYf2RUl1gLB9pQ", "debut": "2025-12-31"},
]

WINDOW_BEFORE_DAYS = 180
WINDOW_AFTER_DAYS = 90

ROOT = Path(__file__).resolve().parent.parent.parent
OUT_DIR = ROOT / "scripts" / "historical_backfill"
MIGRATION_PATH = ROOT / "migrations" / "0023_socialblade_backfill.sql"


def fetch_daily(handle: str, client_id: str, token: str,
                history: str = "archive") -> dict[str, Any]:
    """One Matrix API call. Returns the inner `data` object on success.

    history: 'default' (cheapest, 1 credit, ~30 days) | 'extended'
             (more credits, ~1 year) | 'archive' (most credits, 3 years).
    Raises on transport errors, non-200 status, or {status.success: false}.
    """
    r = requests.get(
        API_URL,
        params={"query": handle, "history": history},
        headers={
            "clientid": client_id,
            "token": token,
            "User-Agent": USER_AGENT,
        },
        timeout=45,
    )
    r.raise_for_status()
    payload = r.json()
    status = payload.get("status") or {}
    if not status.get("success"):
        raise RuntimeError(f"API error: {json.dumps(status, ensure_ascii=False)}")
    data = payload.get("data") or {}
    return data


def normalize_daily(daily: list[dict[str, Any]],
                    debut_str: str | None = None,
                    apply_window: bool = False) -> list[dict[str, Any]]:
    """Normalize SB daily array to {date,subs,views}, sorted ASC.

    apply_window=True clips to [debut-180, debut+90] (the original
    backfill spec window). Default False keeps all rows since most
    of our credit-burn returned data outside that window but still
    valuable as recent live anchors.
    """
    lo = hi = None
    if apply_window and debut_str:
        debut = date.fromisoformat(debut_str)
        lo = debut - timedelta(days=WINDOW_BEFORE_DAYS)
        hi = debut + timedelta(days=WINDOW_AFTER_DAYS)
    out: list[dict[str, Any]] = []
    for entry in daily:
        date_str = str(entry.get("date") or "")[:10]
        if not date_str:
            continue
        try:
            d = date.fromisoformat(date_str)
        except ValueError:
            continue
        if lo and hi and not (lo <= d <= hi):
            continue
        out.append({
            "date": d.isoformat(),
            "subs": int(entry.get("subs") or 0),
            "views": int(entry.get("views") or 0),
        })
    out.sort(key=lambda r: r["date"])
    return out


def write_csv(group_key: str, rows: list[dict[str, Any]]) -> Path:
    path = OUT_DIR / f"{group_key}_socialblade.csv"
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["date", "yt_subscribers", "yt_total_views"])
        for r in rows:
            w.writerow([r["date"], r["subs"], r["views"]])
    return path


def emit_sql_block(group_key: str, rows: list[dict[str, Any]]) -> str:
    """One INSERT...VALUES block per group with canonical UPSERT.

    Skips views=0 entries to NULL (Social Blade returns 0 for unknown).
    Subscribers=0 is also coerced to NULL (a real channel never has 0
    subs after week 1; 0 indicates SB hasn't started tracking yet).
    """
    if not rows:
        return f"-- {group_key.upper()}: no rows in window — skip\n"

    def to_sql_int(v: int) -> str:
        return "NULL" if v <= 0 else str(v)

    values = ",\n  ".join(
        f"('{group_key}', '{r['date']}T00:00:00Z', NULL, "
        f"{to_sql_int(r['views'])}, {to_sql_int(r['subs'])}, "
        f"0, 0, 0, 0, 0, 0, 'backfill_estimate')"
        for r in rows
    )
    return f"""-- ============================================================
-- {group_key.upper()} Social Blade daily ({len(rows)} rows, {rows[0]['date']} ~ {rows[-1]['date']})
-- Source: GET /b/youtube/statistics?history=archive
-- ============================================================
INSERT INTO agg_summary
  (group_key, snapshot_at,
   yt_total_videos, yt_total_views, yt_subscribers,
   dc_total_posts, theqoo_posts, instiz_posts,
   naver_total_news, twitter_posts, controversy_count, data_source)
VALUES
  {values}
ON CONFLICT(group_key, snapshot_at) DO UPDATE SET
  yt_subscribers = COALESCE(excluded.yt_subscribers, agg_summary.yt_subscribers),
  yt_total_views = COALESCE(excluded.yt_total_views, agg_summary.yt_total_views),
  data_source    = excluded.data_source;
"""


def parse_handle_overrides(args: list[str]) -> dict[str, str]:
    """`--handle key=@new_handle` or `--handle key=channel_id`. Repeatable."""
    out: dict[str, str] = {}
    i = 0
    while i < len(args):
        if args[i] == "--handle" and i + 1 < len(args):
            kv = args[i + 1]
            if "=" in kv:
                k, v = kv.split("=", 1)
                out[k.strip()] = v.strip()
            i += 2
        else:
            i += 1
    return out


def run_smoke(group_key: str, client_id: str, token: str,
              handle_overrides: dict[str, str], history: str = "archive") -> None:
    """Fetch one group, dump full response shape to stderr for inspection."""
    g = next((x for x in GROUPS if x["key"] == group_key), None)
    if g is None:
        sys.exit(f"unknown group: {group_key}")
    handle = handle_overrides.get(group_key, g["handle"])
    print(f"[smoke {group_key}] fetching handle={handle!r} history={history}", file=sys.stderr)
    data = fetch_daily(handle, client_id, token, history=history)
    daily = data.get("daily") or []
    total = (data.get("statistics") or {}).get("total") or {}
    id_block = data.get("id") or {}
    print(json.dumps({
        "id": id_block,
        "total": total,
        "daily_len": len(daily),
        "daily_first": daily[0] if daily else None,
        "daily_last": daily[-1] if daily else None,
    }, indent=2, default=str), file=sys.stderr)
    if daily:
        all_rows = normalize_daily(daily, g["debut"], apply_window=False)
        win_rows = normalize_daily(daily, g["debut"], apply_window=True)
        # Always persist what we got — credit was paid, data is real.
        write_csv(g["key"], all_rows)
        print(f"[smoke {group_key}] all={len(all_rows)} window={len(win_rows)} "
              f"(window=[debut-{WINDOW_BEFORE_DAYS}, debut+{WINDOW_AFTER_DAYS}])",
              file=sys.stderr)
        print(f"[smoke {group_key}] CSV saved → {OUT_DIR / (group_key + '_socialblade.csv')}",
              file=sys.stderr)


def run_full(client_id: str, token: str,
             handle_overrides: dict[str, str],
             only_keys: list[str] | None = None,
             history: str = "archive",
             out_migration: Path | None = None) -> None:
    sql_blocks: list[str] = []
    summary: list[tuple[str, str, int]] = []  # (key, status, rows)
    targets = [g for g in GROUPS if (only_keys is None or g["key"] in only_keys)]
    for g in targets:
        handle = handle_overrides.get(g["key"], g["handle"])
        print(f"[{g['key']}] fetching handle={handle!r} history={history}", file=sys.stderr)
        try:
            data = fetch_daily(handle, client_id, token, history=history)
        except Exception as e:
            print(f"[{g['key']}] FAIL: {e}", file=sys.stderr)
            summary.append((g["key"], f"FAIL: {e}", 0))
            sql_blocks.append(f"-- {g['key'].upper()}: API error — {e}\n")
            continue

        daily = data.get("daily") or []
        all_rows = normalize_daily(daily, g["debut"], apply_window=False)
        win_rows = normalize_daily(daily, g["debut"], apply_window=True)
        # Persist all retrieved rows. The window is informational —
        # rows outside it (e.g. current state at D+400) are still
        # valid live anchors that complement the live collector.
        print(f"[{g['key']}] all={len(all_rows)} window={len(win_rows)}",
              file=sys.stderr)
        write_csv(g["key"], all_rows)
        sql_blocks.append(emit_sql_block(g["key"], all_rows))
        summary.append((g["key"], "OK", len(all_rows)))

    # Write migration file. --out-migration overrides for scoped reruns
    # (e.g. adding a single group without overwriting the original 0023).
    # Resolve the target path so relative_to(ROOT) works regardless of
    # whether the user passed an absolute or relative --out-migration.
    raw = out_migration if out_migration else MIGRATION_PATH
    target_path = raw if raw.is_absolute() else (ROOT / raw).resolve()
    target_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        rel_label = target_path.relative_to(ROOT)
    except ValueError:
        rel_label = target_path
    with target_path.open("w", encoding="utf-8") as f:
        f.write(f"-- {rel_label}\n")
        f.write("-- Social Blade Matrix API daily backfill — yt_subscribers + yt_total_views\n")
        f.write("-- per day for 4 K-POP groups across [debut-180, debut+90].\n")
        f.write("-- Generated by scripts/historical_backfill/socialblade_fetch.py.\n")
        f.write("-- Source: GET /b/youtube/statistics?history=archive\n")
        f.write("-- yt_total_videos는 daily 응답에 없어 NULL — Wayback (migration 0020) +\n")
        f.write("-- live collector가 채움.\n\n")
        for blk in sql_blocks:
            f.write(blk + "\n")

    print("\n=== summary ===", file=sys.stderr)
    for k, status, n in summary:
        print(f"  {k:<8} {status} ({n} rows)", file=sys.stderr)
    print(f"\nMigration written: {target_path}", file=sys.stderr)
    print(f"CSVs in: {OUT_DIR}", file=sys.stderr)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--smoke", help="fetch one group and print response shape")
    p.add_argument("--handle", action="append", default=[],
                   help="override handle: key=@handle (repeatable)")
    p.add_argument("--history", choices=["default", "extended", "archive"],
                   default="archive",
                   help="SB API history depth — cheaper costs less credits")
    p.add_argument("--only", action="append", default=[],
                   help="restrict to specific group keys (repeatable)")
    p.add_argument("--out-migration", default=None,
                   help="override migration output path (default = "
                        "migrations/0023_socialblade_backfill.sql). Use "
                        "this for scoped re-runs so you don't overwrite "
                        "the canonical 4-group migration.")
    args = p.parse_args()

    cid = os.environ.get("SOCIALBLADE_CLIENT_ID")
    tok = os.environ.get("SOCIALBLADE_TOKEN")
    if not cid or not tok:
        sys.exit("Set SOCIALBLADE_CLIENT_ID + SOCIALBLADE_TOKEN env vars")

    overrides: dict[str, str] = {}
    for kv in args.handle:
        if "=" in kv:
            k, v = kv.split("=", 1)
            overrides[k.strip()] = v.strip()

    if args.smoke:
        run_smoke(args.smoke, cid, tok, overrides, history=args.history)
    else:
        run_full(cid, tok, overrides,
                 only_keys=(args.only or None),
                 history=args.history,
                 out_migration=Path(args.out_migration) if args.out_migration else None)


if __name__ == "__main__":
    main()
