"""Typer-based command-line entrypoint."""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone

import typer

from idol_sight.collectors.channel_stats import ChannelStatsCollector
from idol_sight.collectors.dc import DcCollector
from idol_sight.collectors.hanteo import HanteoCollector
from idol_sight.collectors.instiz import InstizCollector
from idol_sight.collectors.naver import NaverCollector
from idol_sight.collectors.theqoo import TheQooCollector
from idol_sight.collectors.twitter import TwitterCollector
from idol_sight.collectors.youtube import YouTubeCollector
from idol_sight.config import GroupConfig, load_settings, Settings
from idol_sight.d1 import D1Client
from idol_sight.notify import notify_failure
from idol_sight.orchestrator import run_collector

app = typer.Typer(no_args_is_help=True, add_completion=False)


KNOWN_SOURCES = {
    "youtube", "naver", "dc", "theqoo", "instiz", "twitter",
    "hanteo", "channel-stats",
}
KNOWN_GROUPS = {
    "plave", "isedol", "stellive", "skinz",
    "myrakl", "miiwan", "owis", "bdawn",
}

# Source → constructor.
_COLLECTORS = {
    "naver": NaverCollector,
    "instiz": InstizCollector,
    "theqoo": TheQooCollector,
    "dc": DcCollector,
    "youtube": YouTubeCollector,
    "channel-stats": ChannelStatsCollector,
    "hanteo": HanteoCollector,
    "twitter": TwitterCollector,
}

_INTERVALS_H = {
    "naver": 1, "twitter": 1,
    "dc": 6, "theqoo": 6, "instiz": 6, "youtube": 6, "channel-stats": 24,
    "hanteo": 168,
}


def _make_d1_client(settings: Settings) -> D1Client:
    return D1Client(
        account_id=settings.cf_account_id,
        db_id=settings.cf_d1_db_id,
        api_token=settings.cf_api_token,
    )


def _make_collector(source: str):
    cls = _COLLECTORS.get(source)
    if cls is None:
        raise NotImplementedError(f"unknown source {source!r}")
    settings = load_settings()
    if cls is YouTubeCollector or cls is ChannelStatsCollector:
        if not settings.yt_api_key:
            raise RuntimeError(f"{source} requires YT_API_KEY env")
        return cls(api_key=settings.yt_api_key)
    return cls()


def _load_group(client: D1Client, key: str) -> GroupConfig:
    rows = client.execute(
        "SELECT key, name, name_kr, debut_date, yt_channel_id, dc_gallery_id, "
        "  naver_query, context_keywords, blacklist_phrases, twitter_handles "
        "FROM groups WHERE key=? AND is_active=1",
        [key],
    )
    if not rows:
        raise RuntimeError(f"group {key!r} not in D1 or inactive")
    r = rows[0]
    return GroupConfig(
        key=r["key"],
        name=r["name"], name_kr=r["name_kr"],
        debut_date=r.get("debut_date"),
        yt_channel_id=r.get("yt_channel_id"),
        dc_gallery_id=r.get("dc_gallery_id"),
        naver_query=r.get("naver_query"),
        context_keywords=json.loads(r.get("context_keywords") or "[]"),
        blacklist_phrases=json.loads(r.get("blacklist_phrases") or "[]"),
        twitter_handles=json.loads(r.get("twitter_handles") or "[]"),
    )


@app.command(help="Run a collector for one (group, source) pair.")
def collect(
    source: str = typer.Option(..., "--source"),
    group: str = typer.Option(..., "--group"),
) -> None:
    if source not in KNOWN_SOURCES:
        typer.echo(f"unknown source: {source}", err=True)
        raise typer.Exit(code=2)
    if group not in KNOWN_GROUPS:
        typer.echo(f"unknown group: {group}", err=True)
        raise typer.Exit(code=2)

    settings = load_settings()
    client = _make_d1_client(settings)
    grp = _load_group(client, group)
    coll = _make_collector(source)

    summary = run_collector(
        client, coll, grp,
        expected_interval_h=_INTERVALS_H.get(source, 24),
    )

    typer.echo(f"[{summary.job}] status={summary.status} "
               f"inserted={summary.rows_inserted} updated={summary.rows_updated} "
               f"runtime_ms={summary.runtime_ms} "
               f"err={summary.error_msg or ''}")
    raise typer.Exit(code=0 if summary.status == "ok" else 1)


@app.command("notify-fail", help="Send a failure notification to Discord.")
def notify_fail(job: str = typer.Option(..., "--job")) -> None:
    webhook = os.environ.get("DISCORD_WEBHOOK")
    if not webhook:
        typer.echo("DISCORD_WEBHOOK unset; nothing to send", err=True)
        raise typer.Exit(code=0)
    notify_failure(
        webhook_url=webhook,
        job=job,
        error=f"job failed at {datetime.now(timezone.utc).isoformat()}",
    )
    typer.echo(f"notified: {job}")


@app.command(help="Build agg_summary for the current snapshot.")
def aggregate() -> None:
    from idol_sight.analysis.agg_summary import build_agg_summary
    settings = load_settings()
    client = _make_d1_client(settings)
    snap = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:00:00Z")
    result = build_agg_summary(client, snapshot_at=snap)
    if result.statements:
        bs = client.batch(result.statements)
        if bs.statements_executed != bs.statements_sent:
            typer.echo(f"partial agg_summary write: "
                       f"{bs.statements_executed}/{bs.statements_sent}", err=True)
            raise typer.Exit(code=1)
    typer.echo(f"agg_summary upserted {len(result.statements)} groups at {snap}")


@app.command("health-check", help="Report jobs whose last_success_at is older than expected_interval * 4.")
def health_check() -> None:
    from idol_sight.cli_health import audit_freshness
    settings = load_settings()
    client = _make_d1_client(settings)
    stale = audit_freshness(client)
    if not stale:
        typer.echo("all jobs fresh")
        return
    webhook = settings.discord_webhook
    for s in stale:
        msg = f"{s['job']}: last_success_at={s.get('last_success_at') or 'never'} (age_h={s.get('age_h')})"
        typer.echo(f"STALE: {msg}", err=True)
        notify_failure(webhook_url=webhook, job=s["job"], error=msg)
    raise typer.Exit(code=1)


@app.command("analyze-weekly", help="Run weekly analysis: hanteo, market_share, member_pop, llm.")
def analyze_weekly(
    week_start: str = typer.Option(..., "--week-start", help="YYYY-MM-DD (Sunday)"),
    week_end: str   = typer.Option(..., "--week-end",   help="YYYY-MM-DD (Saturday)"),
) -> None:
    settings = load_settings()
    client = _make_d1_client(settings)
    snap = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:00:00Z")

    # 1. Hanteo (global fetch)
    hanteo_collector = HanteoCollector(
        groups_loader=lambda: _load_active_groups(client),
    )
    hanteo_result = hanteo_collector.collect_global()
    if hanteo_result.statements:
        client.batch(hanteo_result.statements)
    typer.echo(f"hanteo: matched {hanteo_result.rows_inserted} groups")

    # 2. Market share — read agg_summary windows + write agg_market_share
    from idol_sight.analysis.market_share import compute_market_share, to_statements
    rows_last = client.execute(
        "SELECT group_key, yt_total_views, dc_total_posts, theqoo_posts, "
        "  instiz_posts, naver_total_news "
        "FROM agg_summary WHERE substr(snapshot_at,1,10)=?", [week_end])
    rows_prev = client.execute(
        "SELECT group_key, yt_total_views, dc_total_posts FROM agg_summary "
        "WHERE substr(snapshot_at,1,10)=?", [_shift_date(week_end, -7)])
    cum_by = {r["group_key"]: (r["yt_total_views"] or 0) + (r["dc_total_posts"] or 0)
              + (r.get("theqoo_posts") or 0) + (r.get("instiz_posts") or 0)
              + (r.get("naver_total_news") or 0) * 100
              for r in rows_last}
    prev_by = {r["group_key"]: (r["yt_total_views"] or 0) + (r["dc_total_posts"] or 0)
               for r in rows_prev}
    groups = [{"key": k, "cum_score": cum_by[k],
               "mom_score": max(cum_by[k] - prev_by.get(k, 0), 0)}
              for k in cum_by]
    share_rows = compute_market_share(week_start=week_start, week_end=week_end,
                                       groups=groups)
    market_total = sum(g["cum_score"] for g in groups)
    market_stmts = to_statements(share_rows, market_total=market_total)
    if market_stmts:
        client.batch(market_stmts)
    typer.echo(f"market_share: wrote {len(market_stmts)} rows")

    # 3. Member popularity (one per active group)
    from idol_sight.analysis.member_popularity import (
        compute_member_popularity, to_statements as mp_to_statements,
    )
    member_stmts: list = []
    for g in _load_active_groups(client):
        members_raw = client.execute(
            "SELECT m.id, m.name, "
            "  COALESCE(MAX(c.subscribers),0) AS yt_score, "
            "  COALESCE((SELECT COUNT(*) FROM community_posts cp "
            "             WHERE cp.group_key = m.group_key "
            "               AND cp.title LIKE '%' || m.name || '%'), 0) AS comm_mentions, "
            "  COUNT(DISTINCT v.video_id) AS yt_videos, "
            "  COALESCE(AVG(s.views), 0) AS yt_avg_views "
            "FROM members m "
            "LEFT JOIN youtube_videos v ON v.channel_id = m.yt_channel_id "
            "LEFT JOIN youtube_video_stats s ON s.video_id = v.video_id "
            "LEFT JOIN youtube_channel_stats c ON c.channel_id = m.yt_channel_id "
            "WHERE m.group_key = ? AND m.active = 1 "
            "GROUP BY m.id",
            [g["key"]],
        )
        members = [
            {
                "name": m["name"],
                "yt_score": min(m["yt_score"] / 10_000, 100),
                "community_score": min(m["comm_mentions"], 100),
                "yt_videos": m["yt_videos"],
                "yt_avg_views": int(m["yt_avg_views"]),
                "yt_sufficient": m["yt_videos"] >= 3,
                "community_mentions": m["comm_mentions"],
            }
            for m in members_raw
        ]
        if not members:
            continue
        pop = compute_member_popularity(group_key=g["key"], members=members)
        id_lookup = {m["name"]: m["id"] for m in members_raw}
        member_stmts.extend(mp_to_statements(pop, snapshot_at=snap, member_id_lookup=id_lookup))
    if member_stmts:
        client.batch(member_stmts)
    typer.echo(f"member_popularity: wrote {len(member_stmts)} rows")

    # 4. LLM weekly insights
    if settings.gemini_api_key:
        from idol_sight.llm.gemini import GeminiClient
        from idol_sight.llm.weekly import generate_weekly
        gemini = GeminiClient(api_key=settings.gemini_api_key)
        weekly = generate_weekly(db=client, gemini=gemini,
                                  week_start=week_start, week_end=week_end)
        if weekly.statements:
            client.batch(weekly.statements)
        typer.echo(f"llm: wrote {weekly.rows_inserted} insights")
    else:
        typer.echo("llm: skipped (GEMINI_API_KEY unset)")


def _load_active_groups(client) -> list[dict]:
    return client.execute("SELECT key, name FROM groups WHERE is_active=1")


def _shift_date(iso_date: str, days: int) -> str:
    from datetime import date, timedelta
    return (date.fromisoformat(iso_date) + timedelta(days=days)).isoformat()


def main() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
    app()


if __name__ == "__main__":
    main()
