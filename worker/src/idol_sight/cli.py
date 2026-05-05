"""Typer-based command-line entrypoint."""

from __future__ import annotations

import json
import logging
import os
from datetime import UTC, datetime

import typer

from idol_sight.collectors.channel_stats import ChannelStatsCollector
from idol_sight.collectors.dc import DcCollector
from idol_sight.collectors.hanteo import HanteoCollector
from idol_sight.collectors.instiz import InstizCollector
from idol_sight.collectors.naver import NaverCollector
from idol_sight.collectors.theqoo import TheQooCollector
from idol_sight.collectors.twitter import TwitterCollector
from idol_sight.collectors.youtube import YouTubeCollector
from idol_sight.config import GroupConfig, Settings, load_settings
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
    base_kw = json.loads(r.get("context_keywords") or "[]")
    # Augment context keywords with active member names so cross-site
    # collectors (theqoo/instiz hot lists) match member-focused posts too,
    # not only ones that mention the group name. We dedupe to avoid bloat.
    member_rows = client.execute(
        "SELECT name FROM members WHERE group_key=? AND active=1",
        [key],
    )
    member_names = [m["name"] for m in member_rows if m.get("name")]
    seen: set[str] = set()
    merged: list[str] = []
    for kw in [*base_kw, *member_names]:
        if kw and kw not in seen:
            seen.add(kw)
            merged.append(kw)
    return GroupConfig(
        key=r["key"],
        name=r["name"], name_kr=r["name_kr"],
        debut_date=r.get("debut_date"),
        yt_channel_id=r.get("yt_channel_id"),
        dc_gallery_id=r.get("dc_gallery_id"),
        naver_query=r.get("naver_query"),
        context_keywords=merged,
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
        error=f"job failed at {datetime.now(UTC).isoformat()}",
    )
    typer.echo(f"notified: {job}")


@app.command(help="Build agg_summary for the current snapshot.")
def aggregate() -> None:
    from idol_sight.analysis.agg_summary import build_agg_summary
    settings = load_settings()
    client = _make_d1_client(settings)
    snap = datetime.now(UTC).strftime("%Y-%m-%dT%H:00:00Z")
    result = build_agg_summary(client, snapshot_at=snap)
    if result.statements:
        bs = client.batch(result.statements)
        if bs.statements_executed != bs.statements_sent:
            typer.echo(f"partial agg_summary write: "
                       f"{bs.statements_executed}/{bs.statements_sent}", err=True)
            raise typer.Exit(code=1)
    typer.echo(f"agg_summary upserted {len(result.statements)} groups at {snap}")


@app.command(
    "health-check",
    help="Report jobs whose last_success_at exceeds expected_interval * 4.",
)
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
        last = s.get("last_success_at") or "never"
        age = s.get("age_h")
        msg = f"{s['job']}: last_success_at={last} (age_h={age})"
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
    snap = datetime.now(UTC).strftime("%Y-%m-%dT%H:00:00Z")

    # 1. Hanteo (global fetch)
    hanteo_collector = HanteoCollector(
        groups_loader=lambda: _load_active_groups(client),
    )
    hanteo_result = hanteo_collector.collect_global()
    if hanteo_result.statements:
        client.batch(hanteo_result.statements)
    typer.echo(f"hanteo: matched {hanteo_result.rows_inserted} groups")

    # 2. Market share — read agg_summary windows + write agg_market_share
    # NOTE: agg_summary is upserted on each collect cycle with snapshot_at=now,
    # not aligned to week_end. Use the latest snapshot per group as "this week"
    # and the most recent snapshot strictly older than that as "previous week".
    # On the first cycle there is only one snapshot → prev is empty → mom = cum.
    from idol_sight.analysis.market_share import compute_market_share, to_statements
    rows_last = client.execute(
        "SELECT group_key, yt_total_views, dc_total_posts, theqoo_posts, "
        "  instiz_posts, naver_total_news "
        "FROM agg_summary WHERE snapshot_at = "
        "  (SELECT MAX(snapshot_at) FROM agg_summary)")
    rows_prev = client.execute(
        "SELECT group_key, yt_total_views, dc_total_posts FROM agg_summary "
        "WHERE snapshot_at = ("
        "  SELECT MAX(snapshot_at) FROM agg_summary "
        "  WHERE snapshot_at < (SELECT MAX(snapshot_at) FROM agg_summary)"
        ")")
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

    # 2.5. Health Score per group (writes agg_health_scores)
    from idol_sight.analysis.health_score import compute_health_score
    health_stmts: list = []
    for g in _load_active_groups(client):
        sum_rows = client.execute(
            "SELECT yt_subscribers, yt_total_views, dc_total_posts, theqoo_posts, "
            "       instiz_posts, naver_total_news, controversy_count "
            "FROM agg_summary WHERE group_key=? AND snapshot_at=("
            "  SELECT MAX(snapshot_at) FROM agg_summary WHERE group_key=?)",
            [g["key"], g["key"]],
        )
        if not sum_rows:
            continue
        s = sum_rows[0]
        # Top 10 video views for quality score.
        top10 = client.execute(
            "SELECT vs.views FROM youtube_video_stats vs "
            "JOIN youtube_videos v ON v.video_id = vs.video_id "
            "WHERE v.group_key=? AND vs.snapshot_at = ("
            "  SELECT MAX(snapshot_at) FROM youtube_video_stats "
            "  WHERE video_id = vs.video_id) "
            "ORDER BY vs.views DESC LIMIT 10",
            [g["key"]],
        )
        # Recent video counts for the bonus.
        v90 = client.execute(
            "SELECT COUNT(*) AS n FROM youtube_videos "
            "WHERE group_key=? AND published_at >= datetime('now','-90 days')",
            [g["key"]],
        )
        v30 = client.execute(
            "SELECT COUNT(*) AS n FROM youtube_videos "
            "WHERE group_key=? AND published_at >= datetime('now','-30 days')",
            [g["key"]],
        )
        debut_rows = client.execute(
            "SELECT debut_date FROM groups WHERE key=?", [g["key"]]
        )
        debut_date = debut_rows[0].get("debut_date") if debut_rows else None
        agg_dict = {
            "yt_subscribers": s.get("yt_subscribers", 0),
            "yt_total_views": s.get("yt_total_views", 0),
            "yt_top10": top10,
            "dc_total_posts": s.get("dc_total_posts", 0),
            "theqoo_posts": s.get("theqoo_posts", 0),
            "instiz_posts": s.get("instiz_posts", 0),
            "naver_total_news": s.get("naver_total_news", 0),
            "controversy_count": s.get("controversy_count", 0),
            "v90_count": (v90[0].get("n", 0) if v90 else 0),
            "v30_count": (v30[0].get("n", 0) if v30 else 0),
        }
        score = compute_health_score(g["key"], agg_dict, debut_date)
        health_stmts.append((
            "INSERT INTO agg_health_scores"
            " (group_key, snapshot_at, total, raw_total, grade, label,"
            "  breakdown_json, bonus_json, quality_method)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
            " ON CONFLICT(group_key, snapshot_at) DO UPDATE SET"
            "  total=excluded.total, raw_total=excluded.raw_total,"
            "  grade=excluded.grade, label=excluded.label,"
            "  breakdown_json=excluded.breakdown_json,"
            "  bonus_json=excluded.bonus_json,"
            "  quality_method=excluded.quality_method",
            [g["key"], snap, score.total, score.raw_total, score.grade,
             score.label, json.dumps(score.breakdown),
             json.dumps(score.bonus), score.quality_method],
        ))
    if health_stmts:
        client.batch(health_stmts)
    typer.echo(f"health_scores: wrote {len(health_stmts)} rows")

    # 3. Member popularity (one per active group)
    from idol_sight.analysis.member_popularity import (
        compute_member_popularity,
    )
    from idol_sight.analysis.member_popularity import (
        to_statements as mp_to_statements,
    )
    member_stmts: list = []
    for g in _load_active_groups(client):
        # Strategy:
        # - yt_score: ① solo channel subscribers (10K=10pts, capped 100)
        #             ② if no solo channel, fall back to AVG views of group videos
        #                whose title mentions the member name (1M views=10pts).
        # - community_score: count of mentions across community_posts AND
        #                    naver_articles whose title contains member name.
        members_raw = client.execute(
            "SELECT m.id, m.name, "
            "  COALESCE(("
            "    SELECT MAX(cs.subscribers) FROM youtube_channel_stats cs "
            "    WHERE cs.channel_id = m.yt_channel_id"
            "  ), 0) AS solo_subscribers, "
            "  COALESCE(("
            "    SELECT AVG(s2.views) FROM youtube_video_stats s2 "
            "    JOIN youtube_videos v2 ON v2.video_id = s2.video_id "
            "    WHERE v2.group_key = m.group_key "
            "      AND v2.title LIKE '%' || m.name || '%'"
            "  ), 0) AS group_video_avg_views, "
            "  ("
            "    SELECT COUNT(*) FROM youtube_videos v3 "
            "    WHERE v3.group_key = m.group_key "
            "      AND v3.title LIKE '%' || m.name || '%'"
            "  ) AS group_video_mention_count, "
            "  ("
            "    SELECT COUNT(*) FROM community_posts cp "
            "    WHERE cp.group_key = m.group_key "
            "      AND cp.title LIKE '%' || m.name || '%'"
            "  ) + ("
            "    SELECT COUNT(*) FROM naver_articles na "
            "    WHERE na.group_key = m.group_key "
            "      AND COALESCE(na.is_excluded, 0) = 0 "
            "      AND na.title LIKE '%' || m.name || '%'"
            "  ) AS comm_mentions "
            "FROM members m "
            "WHERE m.group_key = ? AND m.active = 1",
            [g["key"]],
        )
        members = []
        for m in members_raw:
            solo_subs = m.get("solo_subscribers", 0) or 0
            group_avg = m.get("group_video_avg_views", 0) or 0
            video_mentions = m.get("group_video_mention_count", 0) or 0
            comm_mentions = m.get("comm_mentions", 0) or 0
            # YT score: solo channel takes precedence; otherwise group-video proxy.
            if solo_subs > 0:
                yt_score = min(solo_subs / 10_000.0, 100.0)
            else:
                yt_score = min(group_avg / 100_000.0, 100.0)  # 10M views=100
            comm_score = min(comm_mentions, 100)
            members.append({
                "name": m["name"],
                "yt_score": yt_score,
                "community_score": comm_score,
                "yt_videos": video_mentions,
                "yt_avg_views": int(group_avg),
                "yt_sufficient": video_mentions >= 3,
                "community_mentions": comm_mentions,
            })
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
    return client.execute(
        "SELECT key, name, name_kr FROM groups WHERE is_active=1"
    )


def _shift_date(iso_date: str, days: int) -> str:
    from datetime import date, timedelta
    return (date.fromisoformat(iso_date) + timedelta(days=days)).isoformat()


def main() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
    app()


if __name__ == "__main__":
    main()
