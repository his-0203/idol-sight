"""Typer-based command-line entrypoint."""

from __future__ import annotations

import json
import logging
import os
from datetime import UTC, datetime

import typer

from idol_sight.collectors.channel_stats import ChannelStatsCollector
from idol_sight.collectors.dc import DcCollector
from idol_sight.collectors.external_cohort import (
    ExternalCohortCollector,
    load_external_groups,
)
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
    "myrakl", "miiwan", "owis", "bdawn", "wegosix",
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


def _make_collector(source: str, *, d1: D1Client | None = None):
    cls = _COLLECTORS.get(source)
    if cls is None:
        raise NotImplementedError(f"unknown source {source!r}")
    settings = load_settings()
    if cls is YouTubeCollector or cls is ChannelStatsCollector:
        if not settings.yt_api_key:
            raise RuntimeError(f"{source} requires YT_API_KEY env")
        # Both collectors fan out across the group channel + active member
        # solo channels. We pass a closure that queries D1 for the member
        # channel IDs. ISEDOL/STELLIVE members are far more active on
        # personal channels, so without this loader the group totals
        # under-count subscribers/views by ~70× for those groups.
        client = d1 or _make_d1_client(settings)

        def members_loader(group_key: str) -> list[dict]:
            return client.execute(
                "SELECT yt_channel_id FROM members "
                "WHERE group_key=? AND active=1 AND yt_channel_id IS NOT NULL",
                [group_key],
            )

        return cls(api_key=settings.yt_api_key, members_loader=members_loader)
    if cls is NaverCollector:
        # Naver fans out across the group anchor + per-member queries
        # (V2.6 multi-query expansion — see _search_terms.py for the
        # expansion rules). The loader returns name + name_en for every
        # active member; the collector decides which subset to actually
        # search based on the length gate. Without this loader the
        # collector falls back to the single-fetch legacy behaviour.
        client = d1 or _make_d1_client(settings)

        def naver_members_loader(group_key: str) -> list[dict]:
            return client.execute(
                "SELECT name, name_en FROM members "
                "WHERE group_key=? AND active=1",
                [group_key],
            )

        return cls(members_loader=naver_members_loader)
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
    coll = _make_collector(source, d1=client)

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
    from idol_sight.notify import fmt_kst
    webhook = os.environ.get("DISCORD_WEBHOOK")
    if not webhook:
        typer.echo("DISCORD_WEBHOOK unset; nothing to send", err=True)
        raise typer.Exit(code=0)
    notify_failure(
        webhook_url=webhook,
        job=job,
        error=f"job failed at {fmt_kst(datetime.now(UTC))}",
    )
    typer.echo(f"notified: {job}")


@app.command(help="Build agg_summary for the current snapshot.")
def aggregate() -> None:
    from idol_sight.analysis.agg_summary import build_agg_summary
    from idol_sight.analysis.group_combined import build_agg_group_combined
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

    # V2.5: build the dual-entity group/member combined views alongside.
    # Three rows per group (group_only / sum / weighted) so the UI can
    # toggle between "company-led media" and "members + group total"
    # views without re-querying.
    combined = build_agg_group_combined(client, snapshot_at=snap)
    if combined.statements:
        bs2 = client.batch(combined.statements)
        if bs2.statements_executed != bs2.statements_sent:
            typer.echo(f"partial agg_group_combined write: "
                       f"{bs2.statements_executed}/{bs2.statements_sent}", err=True)
            raise typer.Exit(code=1)
    n_groups = (len(combined.statements) // 3) if combined.statements else 0
    typer.echo(f"agg_group_combined: wrote {len(combined.statements)} rows "
               f"(3 methods × ~{n_groups} groups)")

    # V2.5: 24h velocity ratio per video. Reads youtube_video_stats
    # for any video published in the last 30 days that hasn't had its
    # first-24h count snapshotted yet, then recomputes the per-channel
    # leave-one-out mean and writes viral_velocity_ratio. Idempotent —
    # repeated runs keep the latest interpolation.
    from idol_sight.analysis.video_velocity import compute_velocity
    velocity = compute_velocity(client)
    if velocity.statements:
        client.batch(velocity.statements)
    typer.echo(f"velocity: updated {len(velocity.statements)} rows")

    # V2.5: cross-platform reactivity. Depends on viral_velocity_ratio
    # being populated, so it runs AFTER compute_velocity. For each
    # group's viral video, counts community/naver activity in the 24h
    # window before vs after publication; the per-platform mean ratio
    # tells us which platform is "reactive" (driven by comebacks) vs
    # "independent" (year-round chatter).
    from idol_sight.analysis.platform_reactivity import compute_reactivity
    reactivity_stmts = compute_reactivity(client, snapshot_at=snap)
    if reactivity_stmts:
        client.batch(reactivity_stmts)
    typer.echo(f"platform_reactivity: updated {len(reactivity_stmts)} groups")


@app.command(
    "health-check",
    help="Report jobs whose last_success_at exceeds expected_interval * 4.",
)
def health_check() -> None:
    from idol_sight.cli_health import audit_freshness
    from idol_sight.notify import fmt_kst
    settings = load_settings()
    client = _make_d1_client(settings)
    stale = audit_freshness(client)
    if not stale:
        typer.echo("all jobs fresh")
        return
    webhook = settings.discord_webhook
    for s in stale:
        last = fmt_kst(s.get("last_success_at"))
        age = s.get("age_h")
        age_str = f"{age:.1f}h" if isinstance(age, (int, float)) else "?"
        msg = f"{s['job']}: last_success_at={last} (age={age_str})"
        typer.echo(f"STALE: {msg}", err=True)
        notify_failure(webhook_url=webhook, job=s["job"], error=msg)
    raise typer.Exit(code=1)


@app.command(
    "backfill-yt-videos",
    help="One-shot full-history walk of every active group's YouTube "
         "channel(s). Uses playlistItems.list paginated against the "
         "channel's uploads playlist (1 quota unit per page) to reach "
         "every video the channel ever posted, not just the latest 50. "
         "Run once per major group set or after schema changes; "
         "subsequent daily collect runs only top up new uploads.",
)
def backfill_yt_videos_cmd(
    group: str | None = typer.Option(
        None, "--group",
        help="Single group key (e.g. 'isedol'). Omit to walk every "
             "group in KNOWN_GROUPS — but the all-groups path can run "
             "30+ min and may hit workflow timeouts; prefer scoped "
             "runs after channel_id seed corrections.",
    ),
) -> None:
    from idol_sight.collectors.youtube import YouTubeCollector

    settings = load_settings()
    client = _make_d1_client(settings)
    api_key = settings.yt_api_key
    if not api_key:
        typer.echo("YT_API_KEY not set", err=True)
        raise typer.Exit(code=2)

    def _members(group_key: str) -> list[dict[str, Any]]:
        rows = client.execute(
            "SELECT yt_channel_id FROM members "
            " WHERE group_key=? AND yt_channel_id IS NOT NULL "
            "   AND COALESCE(active, 1) = 1",
            [group_key],
        )
        return [{"yt_channel_id": r["yt_channel_id"]} for r in rows]

    if group:
        if group not in KNOWN_GROUPS:
            typer.echo(f"unknown group: {group}", err=True)
            raise typer.Exit(code=2)
        targets: list[str] = [group]
    else:
        targets = sorted(KNOWN_GROUPS)

    coll = YouTubeCollector(api_key, members_loader=_members)
    total_videos = 0
    total_groups = 0
    errors: list[str] = []
    for group_key in targets:
        grp = _load_group(client, group_key)
        if not grp.yt_channel_id:
            continue
        try:
            result = coll.collect(grp, full_history=True)
        except Exception as exc:
            errors.append(f"{group_key}: {exc}")
            typer.echo(f"[{group_key}] FAIL: {exc}", err=True)
            continue
        if result.statements:
            client.batch(result.statements)
        total_videos += result.rows_inserted
        total_groups += 1
        typer.echo(
            f"[{group_key}] {result.rows_inserted} videos walked "
            f"({result.runtime_ms} ms)"
        )
    typer.echo(
        f"backfill-yt-videos: {total_groups} groups, "
        f"{total_videos} total videos written"
    )
    if errors:
        typer.echo(f"errors: {errors}", err=True)
        raise typer.Exit(code=1)


@app.command(
    "backfill-yt-history",
    help="Synthesize historical agg_summary rows from youtube_videos for "
         "every active group. Idempotent — real collector snapshots always "
         "win via ON CONFLICT DO NOTHING.",
)
def backfill_yt_history_cmd() -> None:
    from idol_sight.analysis.yt_history_backfill import backfill_yt_history
    settings = load_settings()
    client = _make_d1_client(settings)
    result = backfill_yt_history(client)
    if result.statements:
        bs = client.batch(result.statements)
        if bs.statements_executed != bs.statements_sent:
            typer.echo(
                f"partial backfill write: "
                f"{bs.statements_executed}/{bs.statements_sent}",
                err=True,
            )
            raise typer.Exit(code=1)
    typer.echo(
        f"backfill-yt-history: {len(result.statements)} synthetic rows "
        f"emitted (existing real snapshots preserved)"
    )


@app.command(
    "external-cohort-run",
    help="Refresh external_metrics YT columns via the YouTube Data API. "
         "Spotify columns are left NULL (Premium-required policy 2026-02 "
         "blocks the API path; manual SQL refresh until alternative).",
)
def external_cohort_run() -> None:
    settings = load_settings()
    client = _make_d1_client(settings)
    groups = load_external_groups(client)
    if not groups:
        typer.echo("external-cohort-run: no active external_groups; skipping")
        return
    coll = ExternalCohortCollector(yt_api_key=settings.yt_api_key)
    result = coll.collect(groups)
    if result.errors:
        for e in result.errors:
            typer.echo(f"WARN: {e}", err=True)
    if result.statements:
        client.batch(result.statements)
    typer.echo(
        f"external-cohort: wrote {result.rows_inserted} rows in "
        f"{result.runtime_ms}ms"
    )
    raise typer.Exit(code=0 if result.statements else 1)


@app.command(
    "alerts-run",
    help="Evaluate alert rules and post fresh firings to Discord.",
)
def alerts_run(
    dry_run: bool = typer.Option(
        False, "--dry-run", help="Evaluate rules but don't post or persist.",
    ),
) -> None:
    """Hourly cron entry point. Cron schedules this lightly; the dedup
    table prevents repeat-firing within a milestone bucket.
    """
    from idol_sight.alerts import run_alerts
    settings = load_settings()
    client = _make_d1_client(settings)
    webhook = None if dry_run else settings.discord_webhook
    fired = run_alerts(client, webhook_url=webhook)
    if not fired:
        typer.echo("alerts: no new firings")
        return
    for a in fired:
        typer.echo(f"FIRED [{a.severity}] {a.alert_key} — {a.title}")


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

    # 2. Share of Voice (formerly "market share") — V2 reformulation.
    # Each signal (yt_views/community/news/subscribers/twitter) is now
    # converted to a percentile rank across the cohort and mixed via
    # SOV_WEIGHTS so that no single high-volume signal dominates. The
    # data layout: take the latest agg_summary snapshot per group as
    # "this week" and the most recent strictly-older snapshot as
    # "previous week" so we can compute deltas for the momentum mix.
    # On the first run there is only one snapshot → mom inputs are 0
    # and final ≈ cum (still a valid SOV picture).
    from idol_sight.analysis.market_share import compute_market_share, to_statements
    rows_last = client.execute(
        "SELECT group_key, yt_total_views, yt_subscribers, dc_total_posts, "
        "  theqoo_posts, instiz_posts, naver_total_news, twitter_posts "
        "FROM agg_summary WHERE snapshot_at = "
        "  (SELECT MAX(snapshot_at) FROM agg_summary)")
    rows_prev = client.execute(
        "SELECT group_key, yt_total_views, dc_total_posts, theqoo_posts, "
        "  instiz_posts, naver_total_news "
        "FROM agg_summary WHERE snapshot_at = ("
        "  SELECT MAX(snapshot_at) FROM agg_summary "
        "  WHERE snapshot_at < (SELECT MAX(snapshot_at) FROM agg_summary)"
        ")")
    prev_by = {
        r["group_key"]: {
            "yt_views": r.get("yt_total_views") or 0,
            "comm_total": ((r.get("dc_total_posts") or 0)
                           + (r.get("theqoo_posts") or 0)
                           + (r.get("instiz_posts") or 0)),
            "news": r.get("naver_total_news") or 0,
        }
        for r in rows_prev
    }
    groups = []
    for r in rows_last:
        gk = r["group_key"]
        comm_total = ((r.get("dc_total_posts") or 0)
                      + (r.get("theqoo_posts") or 0)
                      + (r.get("instiz_posts") or 0))
        prev = prev_by.get(gk, {})
        groups.append({
            "key": gk,
            "yt_views":     r.get("yt_total_views") or 0,
            "comm_total":   comm_total,
            "news":         r.get("naver_total_news") or 0,
            "subscribers":  r.get("yt_subscribers") or 0,
            "twitter":      r.get("twitter_posts") or 0,
            "delta_yt_views": (r.get("yt_total_views") or 0) - (prev.get("yt_views") or 0),
            "delta_comm":     comm_total - (prev.get("comm_total") or 0),
            "delta_news":     (r.get("naver_total_news") or 0) - (prev.get("news") or 0),
        })
    share_rows = compute_market_share(week_start=week_start, week_end=week_end,
                                       groups=groups)
    market_total = sum(g["yt_views"] for g in groups)  # legacy "market_total" column
    market_stmts = to_statements(share_rows, market_total=market_total)
    if market_stmts:
        client.batch(market_stmts)
    typer.echo(f"sov: wrote {len(market_stmts)} rows")

    # 2.5. Health Score per group (writes agg_health_scores).
    # V2 changes:
    #   - REF values are computed dynamically from the cohort's p90 so
    #     PLAVE no longer saturates while the rest land near 0.
    #   - Quality is the engagement rate (likes + 5·comments)/views,
    #     which actually measures fan interaction depth instead of
    #     channel size.
    # We build the cohort agg list FIRST (one query, all groups) so we
    # can derive a single set of refs, then evaluate each group against
    # it.
    from idol_sight.analysis.health_score import (
        compute_dynamic_refs,
        compute_health_score,
        compute_live_metrics,
    )
    cohort_rows = client.execute(
        "SELECT group_key, yt_subscribers, yt_total_views, "
        "  yt_likes_total, yt_comments_total, "
        "  dc_total_posts, theqoo_posts, instiz_posts, "
        "  naver_total_news, controversy_count, negative_ratio, "
        "  music_show_wins "
        "FROM agg_summary WHERE snapshot_at = "
        "  (SELECT MAX(snapshot_at) FROM agg_summary)"
    )
    cohort = [
        {
            "key": r["group_key"],
            "yt_subscribers": r.get("yt_subscribers") or 0,
            "yt_total_views": r.get("yt_total_views") or 0,
            "likes_total": r.get("yt_likes_total") or 0,
            "comments_total": r.get("yt_comments_total") or 0,
            "dc_total_posts": r.get("dc_total_posts") or 0,
            "theqoo_posts": r.get("theqoo_posts") or 0,
            "instiz_posts": r.get("instiz_posts") or 0,
            "naver_total_news": r.get("naver_total_news") or 0,
            "controversy_count": r.get("controversy_count") or 0,
            "negative_ratio": r.get("negative_ratio") or 0,
            "music_show_wins": r.get("music_show_wins") or 0,
        }
        for r in cohort_rows
    ]
    # V2.16: external K-pop benchmark cohort folded into the dynamic-REF
    # percentile so PLAVE no longer saturates against an 8-group cohort
    # that consists of itself. Pulls the latest external_metrics row per
    # active external group; if the table is empty (table missing or no
    # seed yet) we fall through to cohort-only refs — backwards compat.
    try:
        ext_rows = client.execute(
            "SELECT m.group_key, m.yt_subscribers, m.yt_total_views, "
            "  m.spotify_monthly_listeners "
            "FROM external_metrics m "
            "JOIN external_groups g ON g.key = m.group_key "
            "WHERE g.is_active = 1 AND m.snapshot_at = ("
            "  SELECT MAX(snapshot_at) FROM external_metrics "
            "  WHERE group_key = m.group_key)"
        )
    except Exception:  # noqa: BLE001 — table may not exist in tests
        ext_rows = []
    external_cohort = [
        {
            "yt_subscribers": r.get("yt_subscribers") or 0,
            "yt_total_views": r.get("yt_total_views") or 0,
            # external_metrics doesn't track naver news for K-pop
            # mainline; leave 0 so it doesn't depress news REF below
            # the internal cohort's level.
            "naver_total_news": 0,
        }
        for r in ext_rows
    ]
    dyn_refs = (
        compute_dynamic_refs(cohort, external_cohort=external_cohort)
        if cohort else None
    )
    cohort_by_key = {c["key"]: c for c in cohort}

    # Latest hanteo first-week sales per group (drives RitualVictory +
    # Mobilization in the 4-factor model). The hanteo collector only
    # captures groups whose initial-album article ran this week, so most
    # rows are absent — we default to 0.
    hanteo_rows = client.execute(
        "SELECT group_key, MAX(sales) AS sales FROM hanteo_weekly "
        "WHERE sales IS NOT NULL GROUP BY group_key"
    )
    hanteo_by_key = {r["group_key"]: (r.get("sales") or 0) for r in hanteo_rows}

    # Merge hanteo into cohort dicts so live-metrics detection sees the
    # hanteo column too. Without this the "hanteo" key would always look
    # dead and ritual / mobilization would lose it even when it has
    # signal for at least one group.
    for c in cohort:
        c["hanteo_sales"] = hanteo_by_key.get(c["key"], 0)
    live_metrics = compute_live_metrics(cohort) if cohort else None

    health_stmts: list = []
    for g in _load_active_groups_full(client):
        s = cohort_by_key.get(g["key"])
        if not s:
            continue
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
        agg_dict = {
            "yt_subscribers": s["yt_subscribers"],
            "yt_total_views": s["yt_total_views"],
            "likes_total": s["likes_total"],
            "comments_total": s["comments_total"],
            "dc_total_posts": s["dc_total_posts"],
            "theqoo_posts": s["theqoo_posts"],
            "instiz_posts": s["instiz_posts"],
            "naver_total_news": s["naver_total_news"],
            "controversy_count": s["controversy_count"],
            "negative_ratio": s.get("negative_ratio") or 0,
            "hanteo_sales": hanteo_by_key.get(g["key"], 0),
            "music_show_wins": s.get("music_show_wins") or 0,
            "v90_count": (v90[0].get("n", 0) if v90 else 0),
            "v30_count": (v30[0].get("n", 0) if v30 else 0),
        }
        score = compute_health_score(
            g["key"], agg_dict, g.get("debut_date"),
            refs=dyn_refs, group_model=g.get("group_model"),
            live_metrics=live_metrics,
        )
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
             score.label,
             # breakdown_json now carries both the legacy 6-component
             # breakdown (for the existing /api/health/spec contract)
             # and the V2.5 4-factor scores + the group_model the score
             # was computed under, all in one JSON blob so we don't need
             # a schema migration to expose them.
             json.dumps({
                 **score.breakdown,
                 "_factors":     score.factors,
                 "_group_model": score.group_model,
             }),
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

    # 4. Sentiment polarity classification — Gemini-driven, title-only.
    #    Capped at LIMIT_PER_GROUP per group per run so token spend
    #    stays bounded (~200 titles × 8 groups × 1 batch). The
    #    negative_ratio update on agg_summary lets the frontend show
    #    a one-glance polarity number per group without re-joining
    #    community_posts.
    if settings.gemini_api_key:
        from idol_sight.analysis.sentiment import (
            classify_for_group,
            update_negative_ratio_statements,
        )
        from idol_sight.llm.gemini import GeminiClient
        sent_gemini = GeminiClient(api_key=settings.gemini_api_key)
        sent_stmts: list = []
        for g in _load_active_groups(client):
            sent_stmts.extend(classify_for_group(
                client, sent_gemini,
                group_key=g["key"], group_name_kr=g.get("name_kr") or g["key"],
            ))
        if sent_stmts:
            client.batch(sent_stmts)
        # After UPDATEs land, recompute the rolled-up negative_ratio.
        ratio_stmts = update_negative_ratio_statements(client, snapshot_at=snap)
        if ratio_stmts:
            client.batch(ratio_stmts)
        typer.echo(f"sentiment: classified {len(sent_stmts)} posts, "
                   f"updated {len(ratio_stmts)} ratio rows")
    else:
        typer.echo("sentiment: skipped (GEMINI_API_KEY unset)")

    # 5. LLM weekly insights
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


def _load_active_groups_full(client) -> list[dict]:
    """Same as _load_active_groups but pulls debut_date and group_model
    too — needed by the 4-factor Health Score so it can apply the
    correct model-specific weights and skip pre-debut groups.
    """
    return client.execute(
        "SELECT key, name, name_kr, debut_date, group_model "
        "FROM groups WHERE is_active=1"
    )


def _shift_date(iso_date: str, days: int) -> str:
    from datetime import date, timedelta
    return (date.fromisoformat(iso_date) + timedelta(days=days)).isoformat()


def main() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
    app()


if __name__ == "__main__":
    main()
