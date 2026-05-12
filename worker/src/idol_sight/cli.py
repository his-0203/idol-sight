"""Typer-based command-line entrypoint."""

from __future__ import annotations

import json
import logging
import os
from datetime import UTC, datetime
from typing import Any

import typer

from idol_sight.collectors.channel_stats import ChannelStatsCollector
from idol_sight.collectors.dc import DcCollector
from idol_sight.collectors.hanteo import HanteoCollector
from idol_sight.collectors.instiz import InstizCollector
from idol_sight.collectors.melon import MelonChartCollector
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


# Member popularity 계산용 raw fetch.
#
# 한 row 당 멤버 1명 + (그룹 채널 + 솔로 채널) 신호 집계. 핵심은 영상 attribution:
# 멤버를 영상과 잇는 두 가지 신호를 OR 로 합친다.
#   1) v.title LIKE '%이름%' — 기존 방식. Korean name 부분 매칭.
#   2) v.tags JSON 내부에 이름이 정확히 있을 때 — MiiWAN 한정으로 collector 가
#      채우는 컬럼 (migration 0050). m.name (한글) 또는 m.name_en (영문) 둘
#      다 case-insensitive 비교. 팬은 #마하진 / #mahajin 양쪽 사용하므로
#      둘 다 잡아야 한다.
#
# `v.tags IS NOT NULL` guard 가 필요한 이유: SQLite/D1 의 json_each(NULL) 은
# 'malformed JSON' 에러를 낸다. tags 컬럼이 비어있는(다른 그룹) row 도 같은
# 쿼리로 통과해야 하므로 NULL 분기 필수.
#
# OR/EXISTS 로 합쳐도 COUNT(*) 와 AVG 는 row 수 기준이라 자동으로 dedupe 됨
# (영상 1개에 title + tag 양쪽 매칭 → 1회만 카운트).
_MEMBER_POP_FETCH_SQL = """
SELECT m.id, m.name,
  COALESCE((
    SELECT MAX(cs.subscribers) FROM youtube_channel_stats cs
    WHERE cs.channel_id = m.yt_channel_id
  ), 0) AS solo_subscribers,
  COALESCE((
    SELECT AVG(s2.views) FROM youtube_video_stats s2
    JOIN youtube_videos v2 ON v2.video_id = s2.video_id
    WHERE v2.group_key = m.group_key
      AND (
        v2.title LIKE '%' || m.name || '%'
        OR (
          v2.tags IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM json_each(v2.tags) je
            WHERE LOWER(je.value) = LOWER(m.name)
               OR LOWER(je.value) = LOWER(m.name_en)
          )
        )
      )
  ), 0) AS group_video_avg_views,
  (
    SELECT COUNT(*) FROM youtube_videos v3
    WHERE v3.group_key = m.group_key
      AND (
        v3.title LIKE '%' || m.name || '%'
        OR (
          v3.tags IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM json_each(v3.tags) je
            WHERE LOWER(je.value) = LOWER(m.name)
               OR LOWER(je.value) = LOWER(m.name_en)
          )
        )
      )
  ) AS group_video_mention_count,
  (
    SELECT COUNT(*) FROM community_posts cp
    WHERE cp.group_key = m.group_key
      AND cp.title LIKE '%' || m.name || '%'
  ) + (
    SELECT COUNT(*) FROM naver_articles na
    WHERE na.group_key = m.group_key
      AND COALESCE(na.is_excluded, 0) = 0
      AND na.title LIKE '%' || m.name || '%'
  ) AS comm_mentions
FROM members m
WHERE m.group_key = ? AND m.active = 1
""".strip()


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
def aggregate(
    snapshot_at: str | None = typer.Option(
        None,
        "--snapshot-at",
        help=(
            "UTC timestamp like 2026-05-07T12:00:00Z. Defaults to current "
            "UTC hour. Pass the same value across consecutive aggregate "
            "runs (with melon-chart between) so the snapshot row is the "
            "same one — the on-conflict COALESCE in agg_summary then "
            "preserves the melon UPDATE while the second aggregate "
            "recomputes health scores."
        ),
    ),
    skip_derived: bool = typer.Option(
        False,
        "--skip-derived",
        help=(
            "Skip agg_group_combined / compute_velocity / compute_reactivity. "
            "Use on the 2nd aggregate in the melon-chart sandwich: only "
            "agg_summary (ON CONFLICT COALESCE preserves melon) and "
            "agg_health_scores need to rerun after the melon UPDATE. "
            "Saves ~5min by skipping the velocity step that processes "
            "every recent video sequentially against D1."
        ),
    ),
) -> None:
    settings = load_settings()
    client = _make_d1_client(settings)
    snap = snapshot_at or datetime.now(UTC).strftime("%Y-%m-%dT%H:00:00Z")
    _run_aggregate(client, snap=snap, skip_derived=skip_derived)


def _run_aggregate(client, snap: str, skip_derived: bool = False) -> None:
    """Run the daily aggregate pipeline against ``snap``.

    Stages in order:
      1. agg_summary           (always)
      2. agg_group_combined    (skipped when ``skip_derived``)
      3. video_velocity        (skipped when ``skip_derived``)
      4. platform_reactivity   (skipped when ``skip_derived``)
      5. agg_health_scores     (always)

    The 2nd aggregate in the collect-daily/melon-chart sandwich passes
    ``skip_derived=True`` because stages 2–4 don't read melon fields, so
    re-running them only burns the 10-min job budget.
    """
    from idol_sight.analysis.agg_summary import build_agg_summary
    result = build_agg_summary(client, snapshot_at=snap)
    if result.statements:
        bs = client.batch(result.statements)
        if bs.statements_executed != bs.statements_sent:
            typer.echo(f"partial agg_summary write: "
                       f"{bs.statements_executed}/{bs.statements_sent}", err=True)
            raise typer.Exit(code=1)
    typer.echo(f"agg_summary upserted {len(result.statements)} groups at {snap}")

    if not skip_derived:
        # V2.5: build the dual-entity group/member combined views alongside.
        # Three rows per group (group_only / sum / weighted) so the UI can
        # toggle between "company-led media" and "members + group total"
        # views without re-querying.
        from idol_sight.analysis.group_combined import build_agg_group_combined
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

        # V2.20: debut window organicity. Reads ±60d videos per group, scores
        # organic vs paid-viral via 3-signal composite. Independent of melon,
        # so lives inside the skip_derived branch — 2nd aggregate skips this.
        from idol_sight.analysis.debut_window import (
            build_summary as build_dw_summary,
        )
        from idol_sight.analysis.debut_window import (
            build_video_organicity,
        )
        dw_video = build_video_organicity(client)
        if dw_video.statements:
            bs = client.batch(dw_video.statements)
            if bs.statements_executed != bs.statements_sent:
                typer.echo(f"partial debut_window_video write: "
                           f"{bs.statements_executed}/{bs.statements_sent}", err=True)
                raise typer.Exit(code=1)
        typer.echo(f"debut_window_videos: wrote {len(dw_video.statements)} rows")

        dw_summary = build_dw_summary(client)
        if dw_summary.statements:
            bs = client.batch(dw_summary.statements)
            if bs.statements_executed != bs.statements_sent:
                typer.echo(f"partial debut_window_summary write: "
                           f"{bs.statements_executed}/{bs.statements_sent}", err=True)
                raise typer.Exit(code=1)
        typer.echo(f"debut_window_summary: wrote {len(dw_summary.statements)} rows")
    else:
        typer.echo("skip-derived: agg_group_combined / velocity / reactivity skipped")

    # V2.19.2: refresh agg_health_scores at the same daily cadence as
    # agg_summary so melon-chart UPDATEs (and any other agg_summary
    # change) surface on the dashboard within hours instead of waiting
    # for the next analyze-weekly Monday cron. The compute reads the
    # latest snapshot just produced above (or, in the melon-chart
    # workflow's sandwich pattern, the second aggregate call hits
    # ON CONFLICT and recomputes against the COALESCE-preserved row).
    n_health = _recompute_health_scores(client, snap)
    typer.echo(f"health_scores: wrote {n_health} rows")


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
    "melon-chart",
    help=(
        "Fetch Melon TOP 100 (realtime + daily) and update "
        "agg_summary.melon_top100_peak / melon_top100_depth."
    ),
)
def melon_chart_run() -> None:
    settings = load_settings()
    client = _make_d1_client(settings)
    collector = MelonChartCollector(
        groups_loader=lambda: _load_active_groups(client),
    )
    result = collector.collect_global()
    if result.errors:
        for e in result.errors:
            typer.echo(f"WARN: {e}", err=True)
    if result.statements:
        client.batch(result.statements)
    typer.echo(
        f"melon-chart: matched {result.rows_inserted} groups in "
        f"{result.runtime_ms}ms"
    )
    raise typer.Exit(code=0 if result.statements or not result.errors else 1)


@app.command(
    "backfill-music-show-wins",
    help=(
        "Backfill 음방 1위 events from Naver news + Gemini structured "
        "extraction. Caches all processed urls to avoid re-running LLM. "
        "Verifies via ≥2 url confirmation before status='confirmed'."
    ),
)
def backfill_music_show_wins_cmd(
    group: str = typer.Option(
        None, "--group",
        help="Single group_key filter (default: 6 candidates all).",
    ),
    dry_run: bool = typer.Option(
        False, "--dry-run",
        help="Run extraction but don't write D1.",
    ),
) -> None:
    """음방 1위 1회 백필 또는 주간 cron entry. Naver news search →
    Gemini structured extraction → music_show_wins_log + extraction_cache.
    같은 (program, episode_date, group_key) 가 별개 url 2건+ 보도되면
    status='confirmed' 로 승격. agg_summary.music_show_wins 합산은 cli
    의 다른 path (analyze-weekly) 에서 in-memory join 으로 별도 처리.
    """
    from scrapling import Fetcher

    from idol_sight.collectors.music_show import (
        GROUP_KEY_ENUM as _MS_GROUPS,
    )
    from idol_sight.collectors.music_show import (
        backfill_music_show_wins,
        refresh_confirmation_status,
    )
    from idol_sight.llm.gemini import GeminiClient

    settings = load_settings()
    if not settings.gemini_api_key:
        typer.echo(
            "ERROR: GEMINI_API_KEY required for music-show backfill",
            err=True,
        )
        raise typer.Exit(code=2)
    if group is not None and group not in _MS_GROUPS:
        typer.echo(
            f"ERROR: --group must be one of {list(_MS_GROUPS)!r}",
            err=True,
        )
        raise typer.Exit(code=2)

    client = _make_d1_client(settings)
    gemini = GeminiClient(api_key=settings.gemini_api_key)
    group_keys = [group] if group else list(_MS_GROUPS)

    now_iso = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    result = backfill_music_show_wins(
        fetcher=Fetcher,
        gemini_client=gemini,
        db_client=client,
        group_keys=group_keys,
        now_iso=now_iso,
    )

    if dry_run:
        typer.echo(
            f"DRY-RUN: {result.rows_inserted} new wins, "
            f"{len(result.statements)} statements (NOT written)"
        )
        for sql, params in result.statements[:5]:
            typer.echo(f"  - {sql.split()[0]} | {params[:5]}")
        return

    if result.statements:
        client.batch(result.statements)
        typer.echo(
            f"backfill-music-show-wins: wrote {len(result.statements)} stmts "
            f"({result.rows_inserted} new wins) for {len(group_keys)} groups"
        )
        promoted = refresh_confirmation_status(
            db_client=client, now_iso=now_iso,
        )
        typer.echo(
            f"  verification: promoted {promoted} pending → confirmed"
        )
    else:
        typer.echo("backfill-music-show-wins: no new statements")
    raise typer.Exit(code=0 if result.statements or not result.errors else 1)


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
    # V2.19.2: extracted to _recompute_health_scores so the daily
    # ``aggregate`` cmd can refresh on the same cadence. analyze_weekly
    # still calls it here so the Monday recompute uses the same logic
    # (dynamic refs from latest cohort + live-metrics + per-group score).
    n_health = _recompute_health_scores(client, snap)
    typer.echo(f"health_scores: wrote {n_health} rows")

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
        members_raw = client.execute(_MEMBER_POP_FETCH_SQL, [g["key"]])
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


def _recompute_health_scores(client, snap: str) -> int:
    """Recompute agg_health_scores for every active group at ``snap``.

    Reads the latest agg_summary snapshot (which carries any melon-chart
    UPDATE that landed since the previous compute), derives dynamic refs
    + live-metrics from the cohort, then writes one INSERT/UPSERT per
    group keyed on (group_key, snap).

    Extracted from analyze_weekly so the daily ``aggregate`` cmd can
    refresh health scores on the same cadence as agg_summary —
    previously analyze_weekly (Mondays) was the only writer, so daily
    melon-chart UPDATEs took up to 6 days to surface on the dashboard.
    """
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
        "  music_show_wins, melon_top100_peak, melon_top100_depth "
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
            "melon_top100_peak": r.get("melon_top100_peak"),
            "melon_top100_depth": r.get("melon_top100_depth"),
        }
        for r in cohort_rows
    ]
    dyn_refs = compute_dynamic_refs(cohort) if cohort else None
    cohort_by_key = {c["key"]: c for c in cohort}

    hanteo_rows = client.execute(
        "SELECT group_key, MAX(sales) AS sales FROM hanteo_weekly "
        "WHERE sales IS NOT NULL GROUP BY group_key"
    )
    hanteo_by_key = {r["group_key"]: (r.get("sales") or 0) for r in hanteo_rows}
    for c in cohort:
        c["hanteo_sales"] = hanteo_by_key.get(c["key"], 0)

    # 음방 1위 confirmed 카운트. status='confirmed' 만 카운트 — pending
    # (≥2 url 컨퍼메이션 미달) 은 hallucination 위험으로 점수 영향 차단.
    # 같은 (program, episode_date) 의 multi-source 보도가 verification
    # 용으로 여러 row 존재하므로 DISTINCT (program||'|'||episode_date)
    # 로 회차 단위 카운트.
    music_rows = client.execute(
        "SELECT group_key, "
        "COUNT(DISTINCT program || '|' || episode_date) AS wins "
        "FROM music_show_wins_log "
        "WHERE status='confirmed' "
        "GROUP BY group_key"
    )
    music_by_key = {
        r["group_key"]: int(r.get("wins") or 0) for r in music_rows
    }
    for c in cohort:
        c["music_show_wins"] = music_by_key.get(c["key"], 0)
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
            "music_show_wins": music_by_key.get(g["key"], 0),
            "melon_top100_peak": s.get("melon_top100_peak"),
            "melon_top100_depth": s.get("melon_top100_depth"),
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
             json.dumps({
                 **score.breakdown,
                 "_factors":     score.factors,
                 "_group_model": score.group_model,
             }),
             json.dumps(score.bonus), score.quality_method],
        ))
    if health_stmts:
        client.batch(health_stmts)
    return len(health_stmts)


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
