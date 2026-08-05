"""Typer-based command-line entrypoint."""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import UTC, datetime, timedelta
from typing import Any

import click
import typer

from idol_sight.analysis.challenge_scan import run_challenge_scan
from idol_sight.analysis.news_backfill import rearbitrate
from idol_sight.collectors.channel_stats import ChannelStatsCollector
from idol_sight.collectors.dc import DcCollector
from idol_sight.collectors.hanteo import HanteoCollector
from idol_sight.collectors.instiz import InstizCollector
from idol_sight.collectors.melon import MelonChartCollector
from idol_sight.collectors.naver import NaverCollector
from idol_sight.collectors.theqoo import TheQooCollector
from idol_sight.collectors.weverse_sheet import WeverseSheetCollector
from idol_sight.collectors.youtube import YouTubeCollector
from idol_sight.config import GroupConfig, Settings, load_settings
from idol_sight.d1 import D1Client
from idol_sight.llm.gemini import GeminiClient
from idol_sight.notify import notify_failure
from idol_sight.orchestrator import run_collector

app = typer.Typer(no_args_is_help=True, add_completion=False)


KNOWN_SOURCES = {
    "youtube", "naver", "dc", "theqoo", "instiz",
    "hanteo", "channel-stats", "weverse-sheet",
}
KNOWN_GROUPS = {
    "plave", "isedol", "stellive", "skinz",
    "myrakl", "miiwan", "owis", "bdawn", "wegosix",
    "uryael", "bthd", "hollin", "begritz",
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
    "weverse-sheet": WeverseSheetCollector,
}

# 각 source의 expected_interval_h. crawl_meta에 기록되어 health-check이
# audit_freshness(threshold = interval_h * 4)로 stale 여부 판정.
# 실제 cron 주기와 정렬되어 있어야 false-positive 알림 없음.
#
# naver: 12h — `collect-hourly.yml` cron이 실제로는 '5 0,12 * * *' (하루 2회)
#   라서 12h. 파일 이름 historical, 변경하면 cron 분석 도구가 깨질 수 있어
#   유지 중. 1h → 12h 변경(2026-05-13): health-check 매번 9개 false STALE
#   naver:* 알림 → Discord 스팸 → 정렬.
# youtube: 6h — collect-daily가 매일 12:30 UTC 1회 + collect-6h가 6h 주기.
# channel-stats: 24h — collect-daily 1회만 수집.
# hanteo: 168h — `collect --source hanteo` 는 no-op 스텁(그룹별 수집 없음).
#   실수집은 collect-hanteo 전역 커맨드가 collect-daily 스텝에서 일간 실행
#   (crawl_meta 미기록 — melon-chart 와 같은 전역 수집 패턴).
_INTERVALS_H = {
    "naver": 12,
    "dc": 6, "theqoo": 6, "instiz": 6, "youtube": 6, "channel-stats": 24,
    "hanteo": 168,
    # weverse-sheet: 24h — collect-daily 1회만 수집 (시트는 하루 1회 갱신).
    "weverse-sheet": 24,
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
    if cls is WeverseSheetCollector:
        if not settings.miiwan_weverse_sheet_id:
            raise RuntimeError("weverse-sheet requires MIIWAN_WEVERSE_SHEET_ID env")
        return cls(sheet_id=settings.miiwan_weverse_sheet_id)
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


def _sov_inputs(client) -> list[dict]:
    """SoV(agg_market_share) 입력 조립 — v3(2026-08-04) 정확성 수리 3종.

    ① 뉴스 = ``naver_news_90d``(최근 90일 플로우, 0113) 우선 — 누적 스톡은
       활동 정지 그룹의 순위를 영구 유지시켰다(awareness v2와 동일 처방).
       컬럼 미적용 D1은 누적 폴백(graceful).
    ② '전 주' 앵커 = **~7일 전 최근접 스냅샷**. 기존 '직전 스냅샷'은
       aggregate가 하루 여러 번 돈 날에 몇 시간치 델타를 주간 모멘텀으로
       둔갑시켰다. 7일 전 스냅샷이 없으면(초기 이력) 직전 스냅샷 폴백.
    ③ 그룹별 ``category``('kpop'/'subculture') 태그 — 호출부가 도메인별
       독립 코호트로 백분위·재정규화한다(혼합 코호트 버그픽스).
    """
    model_by_key = {
        r["key"]: r.get("group_model")
        for r in client.execute("SELECT key, group_model FROM groups WHERE is_active=1")
    }

    def _category(model: str | None) -> str:
        # awareness._category_of 미러(해당 모듈 private — 규칙 변경 시 동반 갱신).
        return "subculture" if model in ("segmentary", "confederation") else "kpop"

    _COLS_LAST = ("SELECT group_key, yt_total_views, yt_subscribers, "
                  "dc_total_posts, theqoo_posts, instiz_posts, "
                  "naver_total_news{news90} "
                  "FROM agg_summary WHERE snapshot_at = "
                  "  (SELECT MAX(snapshot_at) FROM agg_summary)")
    _COLS_PREV = ("SELECT group_key, yt_total_views, dc_total_posts, "
                  "theqoo_posts, instiz_posts, naver_total_news{news90} "
                  "FROM agg_summary WHERE snapshot_at = ("
                  "  SELECT COALESCE("
                  "    (SELECT MAX(snapshot_at) FROM agg_summary "
                  "      WHERE snapshot_at <= datetime('now', '-6 days')),"
                  "    (SELECT MAX(snapshot_at) FROM agg_summary "
                  "      WHERE snapshot_at < (SELECT MAX(snapshot_at) FROM agg_summary))"
                  "  ))")
    try:
        rows_last = client.execute(_COLS_LAST.format(news90=", naver_news_90d"))
        rows_prev = client.execute(_COLS_PREV.format(news90=", naver_news_90d"))
        use_90d = True
    except Exception:
        rows_last = client.execute(_COLS_LAST.format(news90=""))
        rows_prev = client.execute(_COLS_PREV.format(news90=""))
        use_90d = False

    def _news(r: dict) -> int:
        if use_90d:
            return r.get("naver_news_90d") or 0
        return r.get("naver_total_news") or 0

    prev_by = {
        r["group_key"]: {
            "yt_views": r.get("yt_total_views") or 0,
            "comm_total": ((r.get("dc_total_posts") or 0)
                           + (r.get("theqoo_posts") or 0)
                           + (r.get("instiz_posts") or 0)),
            "news": _news(r),
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
            "category": _category(model_by_key.get(gk)),
            "yt_views":     r.get("yt_total_views") or 0,
            "comm_total":   comm_total,
            "news":         _news(r),
            "subscribers":  r.get("yt_subscribers") or 0,
            "delta_yt_views": (r.get("yt_total_views") or 0) - (prev.get("yt_views") or 0),
            "delta_comm":     comm_total - (prev.get("comm_total") or 0),
            "delta_news":     _news(r) - (prev.get("news") or 0),
        })
    return groups


def _sov_tiers(client, groups: list[dict]) -> tuple[dict[str, int], dict[str, int]]:
    """관심 규모 티어(v3.1) — 그룹별 90일 조회 플로우를 카테고리별
    log 갭 클러스터로 나눈다(market_share.compute_tiers).

    플로우 = 최신 조회수 − 창 내 그룹별 **최초** 스냅샷 조회수. 수집
    이력이 90일보다 짧은 그룹(중도 시드)은 가용 범위 증분으로 계산되고,
    증분 0(신규·집계 전)은 자연히 최하 티어로 간다.

    Returns:
        (tiers, flows) — flows 는 티어 산정 근거인 조회 증분 절대값
        (화면의 정량 앵커로 view_flow_90d 에 함께 적재).
    """
    from idol_sight.analysis.market_share import compute_tiers

    # 앵커는 조회수가 실재하는 행만 — 백필 행은 yt_total_views 가 NULL일
    # 수 있어(agg_summary NULL 규약) 0 취급하면 증분이 누적 전체로 부풀려
    # 진다(2026-08-04 plave 855M 오류 실측). NULL 앵커뿐인 그룹은 아래
    # anchor 부재 → 증분 0(집계 전 취급).
    anchor_rows = client.execute(
        "SELECT group_key, yt_total_views FROM ("
        "  SELECT group_key, yt_total_views, ROW_NUMBER() OVER ("
        "    PARTITION BY group_key ORDER BY snapshot_at ASC) AS rn "
        "  FROM agg_summary WHERE snapshot_at >= datetime('now', '-90 days')"
        "    AND yt_total_views IS NOT NULL"
        ") WHERE rn = 1")
    anchor = {r["group_key"]: r.get("yt_total_views") or 0 for r in anchor_rows}
    tiers: dict[str, int] = {}
    all_flows: dict[str, int] = {}
    for cat in ("kpop", "subculture"):
        flows = {
            g["key"]: (max(0, (g["yt_views"] or 0) - anchor[g["key"]])
                       if g["key"] in anchor else 0)
            for g in groups if g["category"] == cat
        }
        tiers.update(compute_tiers(flows))
        all_flows.update(flows)
    return tiers, all_flows


def _load_group(client: D1Client, key: str) -> GroupConfig:
    rows = client.execute(
        "SELECT key, name, name_kr, debut_date, yt_channel_id, dc_gallery_id, "
        "  naver_query, context_keywords, blacklist_phrases, twitter_handles, "
        "  dc_supplemental_galleries, "
        "  theqoo_supplemental_boards, instiz_supplemental_boards "
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
        dc_supplemental_galleries=json.loads(
            r.get("dc_supplemental_galleries") or "[]"
        ),
        theqoo_supplemental_boards=json.loads(
            r.get("theqoo_supplemental_boards") or "[]"
        ),
        instiz_supplemental_boards=json.loads(
            r.get("instiz_supplemental_boards") or "[]"
        ),
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
      5. agg_awareness (P2b)   (always — agg_summary derivative, graceful)
      6. agg_health_scores     (always)

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

        # V2.43: per-group growth trajectory (raw-pillar, self-history). Like
        # debut_window it doesn't read melon, so it lives in skip_derived branch.
        from idol_sight.analysis.growth_trajectory import build_growth_trajectory
        gt = build_growth_trajectory(client)
        if gt.statements:
            bs = client.batch(gt.statements)
            if bs.statements_executed != bs.statements_sent:
                typer.echo(f"partial growth_trajectory write: "
                           f"{bs.statements_executed}/{bs.statements_sent}", err=True)
                raise typer.Exit(code=1)
        typer.echo(f"growth_trajectory: wrote {len(gt.statements)} rows")

        # V2.46: 라이브 CCV 기반 팬 충성도. live_ccv_samples + 구독자로
        # 전환율 점수화. melon 미참조라 skip_derived 블록에 위치. health
        # score보다 먼저 실행되어 _recompute_health_scores가 읽는다.
        # V2.52: build 가 groups.ccv_ceiling_estimate(0095) 를 읽으므로,
        # 마이그레이션 미적용 시 throw 를 잡아 aggregate 전체(특히 이후의
        # _recompute_health_scores)가 죽지 않게 한다. frontend group API 의
        # ceiling .catch(()=>null) 와 대칭. 배포↔마이그레이션 graceful 규칙.
        from idol_sight.analysis.loyalty import build_fan_loyalty
        try:
            fl = build_fan_loyalty(client)
        except Exception as exc:
            typer.echo(f"[warn] fan_loyalty skipped (build 실패, 0095 미적용 가능): {exc}",
                       err=True)
            fl = None
        if fl is not None:
            if fl.statements:
                bs = client.batch(fl.statements)
                if bs.statements_executed != bs.statements_sent:
                    typer.echo(f"partial fan_loyalty write: "
                               f"{bs.statements_executed}/{bs.statements_sent}", err=True)
                    raise typer.Exit(code=1)
            typer.echo(f"fan_loyalty: wrote {len(fl.statements)} rows")
    else:
        typer.echo("skip-derived: agg_group_combined / velocity / reactivity skipped")

    # P2b: 인지도 지수(Awareness Index). agg_summary 파생(구독·조회·뉴스)이므로
    # health_scores 와 동일한 always-run 위치 — skip_derived 2nd aggregate 도
    # 갱신한다(agg_summary 가 melon COALESCE 로 재upsert 되는 샌드위치 패턴과
    # 정합). 카테고리(K-POP/서브컬처)별 분리 랭킹이며, 점수 산식 변경이 아닌
    # 신규 표시 지표다. 신규 수집 0 — agg_summary 최신 스냅샷 재가공.
    # V2.52 fan_loyalty 와 동일한 배포↔마이그레이션 graceful 규칙: 신규 테이블
    # agg_awareness(0097)가 아직 적용되지 않은 배포에서 build/INSERT throw 가
    # aggregate 전체(특히 이후의 _recompute_health_scores)를 죽이지 않도록
    # 감싼다(import 도 try 안 — P2b 점진 롤아웃 중 모듈/테이블 부재 모두 흡수).
    # 단, 부분쓰기 가드(statements_executed != statements_sent)의 typer.Exit 은
    # 재raise 해 하드 실패를 보존한다.
    try:
        from idol_sight.analysis.awareness import build_awareness
        aw = build_awareness(client, snapshot_at=snap)
        if aw.statements:
            bs = client.batch(aw.statements)
            if bs.statements_executed != bs.statements_sent:
                typer.echo(f"partial awareness write: "
                           f"{bs.statements_executed}/{bs.statements_sent}", err=True)
                raise typer.Exit(code=1)
        typer.echo(f"awareness: wrote {len(aw.statements)} rows")
    except typer.Exit:
        raise
    except Exception as exc:
        typer.echo(f"[warn] awareness skipped (build/write 실패, 0097 미적용 가능): {exc}",
                   err=True)

    # 전 그룹 추정 코어팬 (MarketOverview 참고용). youtube_video_stats 재가공이므로
    # awareness 와 동일한 always-run 위치. 신규 수집 0 — 기존 데이터 재가공.
    # 배포↔마이그레이션 graceful 규칙: agg_core_fan_estimate(0101) 미적용 시 throw 를
    # 잡아 aggregate 전체가 죽지 않게 한다. 부분쓰기 가드의 typer.Exit 은 재raise.
    try:
        from idol_sight.analysis.core_fan_estimate import build_core_fan_estimate
        cfe = build_core_fan_estimate(client, snapshot_at=snap)
        if cfe.statements:
            bs = client.batch(cfe.statements)
            if bs.statements_executed != bs.statements_sent:
                typer.echo(
                    f"partial core_fan_estimate write: "
                    f"{bs.statements_executed}/{bs.statements_sent}",
                    err=True,
                )
                raise typer.Exit(code=1)
        typer.echo(f"core_fan_estimate: wrote {len(cfe.statements)} rows")
    except typer.Exit:
        raise
    except Exception as exc:
        typer.echo(
            f"[warn] core_fan_estimate skipped (build/write 실패, 0101 미적용 가능): {exc}",
            err=True,
        )

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
    "build-awareness",
    help="Rebuild agg_awareness for one snapshot (P2b 인지도 지수, standalone).",
)
def build_awareness_cmd(
    snapshot_at: str | None = typer.Option(
        None,
        "--snapshot-at",
        help=(
            "UTC timestamp like 2026-05-07T12:00:00Z. Defaults to the latest "
            "agg_summary snapshot — awareness is an agg_summary derivative, so "
            "the current UTC hour would usually miss the snapshot. Pass an "
            "explicit value to rebuild a historical snapshot (time series)."
        ),
    ),
) -> None:
    """Standalone awareness rebuild. The daily path runs it inside
    ``_run_aggregate`` (agg_summary 직후); this command is for manual reruns /
    backfilling a past snapshot without re-running the whole aggregate."""
    from idol_sight.analysis.awareness import build_awareness
    settings = load_settings()
    client = _make_d1_client(settings)
    snap = snapshot_at
    if snap is None:
        latest = client.execute("SELECT MAX(snapshot_at) AS m FROM agg_summary")
        snap = (latest[0].get("m") if latest else None)
        if not snap:
            typer.echo("no agg_summary snapshot found", err=True)
            raise typer.Exit(code=1)
    aw = build_awareness(client, snapshot_at=snap)
    if aw.statements:
        bs = client.batch(aw.statements)
        if bs.statements_executed != bs.statements_sent:
            typer.echo(f"partial awareness write: "
                       f"{bs.statements_executed}/{bs.statements_sent}", err=True)
            raise typer.Exit(code=1)
    typer.echo(f"awareness: wrote {len(aw.statements)} rows at {snap}")


@app.command(
    "health-check",
    help="Report jobs whose last_success_at exceeds expected_interval * 4.",
)
def health_check() -> None:
    from idol_sight.cli_health import audit_freshness
    from idol_sight.notify import fmt_kst, notify_alert
    settings = load_settings()
    client = _make_d1_client(settings)
    stale = audit_freshness(client)
    if not stale:
        typer.echo("all jobs fresh")
        return
    webhook = settings.discord_webhook
    # 심각도 분리 — 정기 수집(crawl_meta) 정체만 job 실패(exit 1)로 알람.
    # 일회성 backfill 누락은 warning 으로만(exit 0) → 알람 피로/오탐 제거.
    critical = [s for s in stale if s.get("kind") != "backfill"]
    warnings = [s for s in stale if s.get("kind") == "backfill"]

    for s in warnings:
        msg = f"{s['job']}: never backfilled (one-shot — run backfill-yt-videos)"
        typer.echo(f"WARN: {msg}")
        notify_alert(webhook_url=webhook, title="backfill missing",
                     body=msg, severity="warn")

    for s in critical:
        last = fmt_kst(s.get("last_success_at"))
        age = s.get("age_h")
        age_str = f"{age:.1f}h" if isinstance(age, (int, float)) else "?"
        msg = f"{s['job']}: last_success_at={last} (age={age_str})"
        typer.echo(f"STALE: {msg}", err=True)
        notify_failure(webhook_url=webhook, job=s["job"], error=msg)

    if critical:
        raise typer.Exit(code=1)


def _filter_fresh_groups(
    candidates: list[str], fresh_keys: set[str],
) -> list[str]:
    """Return candidates with any group in fresh_keys removed.

    Preserves input order. Used by ``backfill-yt-videos`` to skip groups
    whose ``last_backfilled_at`` is within the freshness window.
    """
    return [g for g in candidates if g not in fresh_keys]


def _resolve_backfill_targets(
    client, *, group: str | None, force: bool, fresh_days: int,
) -> list[str]:
    """Decide which group keys this backfill run should walk.

    - ``group`` explicit → just that group (freshness ignored — explicit intent)
    - ``group=None`` + ``force=True`` → every KNOWN_GROUPS
    - ``group=None`` + ``fresh_days <= 0`` → every KNOWN_GROUPS
    - ``group=None`` + ``fresh_days > 0`` → KNOWN_GROUPS minus rows whose
      ``groups.last_backfilled_at`` is within the freshness window
    """
    if group:
        return [group]
    candidates = sorted(KNOWN_GROUPS)
    if force or fresh_days <= 0:
        return candidates
    fresh_rows = client.execute(
        "SELECT key FROM groups "
        "WHERE last_backfilled_at IS NOT NULL "
        "  AND julianday('now') - julianday(last_backfilled_at) < ?",
        [fresh_days],
    )
    fresh_keys = {r["key"] for r in fresh_rows}
    return _filter_fresh_groups(candidates, fresh_keys)


@app.command(
    "backfill-yt-videos",
    help="One-shot full-history walk of every active group's YouTube "
         "channel(s). Uses playlistItems.list paginated against the "
         "channel's uploads playlist (1 quota unit per page) to reach "
         "every video the channel ever posted, not just the latest 50. "
         "Run once per major group set or after schema changes; "
         "subsequent daily collect runs only top up new uploads. "
         "Default skips groups backfilled within --fresh-days (7); use "
         "--force or an explicit --group to bypass.",
)
def backfill_yt_videos_cmd(
    group: str | None = typer.Option(
        None, "--group",
        help="Single group key (e.g. 'isedol'). Bypasses freshness "
             "filter — explicit intent wins. Omit to walk every "
             "group in KNOWN_GROUPS filtered by --fresh-days.",
    ),
    force: bool = typer.Option(
        False, "--force",
        help="Skip the freshness check — walk all targets regardless "
             "of last_backfilled_at. Use when seed corrections require "
             "full re-walk.",
    ),
    fresh_days: int = typer.Option(
        7, "--fresh-days",
        help="Skip groups whose last_backfilled_at is within this "
             "many days. Default 7. Use 0 to walk everything (same as --force).",
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

    if group and group not in KNOWN_GROUPS:
        typer.echo(f"unknown group: {group}", err=True)
        raise typer.Exit(code=2)

    targets = _resolve_backfill_targets(
        client, group=group, force=force, fresh_days=fresh_days,
    )
    if not targets:
        typer.echo(f"all groups fresh (< {fresh_days}d); nothing to backfill")
        return

    typer.echo(f"backfill targets: {', '.join(targets)}")

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
        # Mark this group as backfilled (idempotent — re-runs just
        # advance the timestamp).
        client.execute(
            "UPDATE groups SET last_backfilled_at=? WHERE key=?",
            [datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"), group_key],
        )
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
    "youtube-analytics",
    help="미완소년 소유자 OAuth(YouTube Analytics)로 국가별 시청·유지율·"
         "구독전환을 수집해 agg_youtube_analytics* 에 적재. 미완소년 전용 — "
         "MIIWAN_YT_OAUTH_* 시크릿이 없으면 skip. 다른 그룹은 OAuth 없음.",
)
def youtube_analytics_cmd(
    group: str = typer.Option(
        "miiwan", "--group",
        help="OAuth 가 연결된 그룹 키. 현재는 miiwan 만 지원.",
    ),
) -> None:
    from idol_sight.collectors.youtube_analytics import (
        YouTubeAnalyticsCollector,
    )

    settings = load_settings()
    cid = settings.miiwan_yt_oauth_client_id
    secret = settings.miiwan_yt_oauth_client_secret
    refresh = settings.miiwan_yt_oauth_refresh_token
    if not (cid and secret and refresh):
        typer.echo(
            "MIIWAN_YT_OAUTH_* 미설정 — skip (정상: OAuth 미연결 그룹).")
        return

    client = _make_d1_client(settings)
    grp = _load_group(client, group)

    coll = YouTubeAnalyticsCollector(cid, secret, refresh)
    try:
        result = coll.collect(grp)
    except Exception as exc:  # noqa: BLE001 — 단일 그룹, 실패는 비치명적.
        typer.echo(f"[{group}] youtube-analytics FAIL: {exc}", err=True)
        raise typer.Exit(code=1) from exc

    if result.statements:
        client.batch(result.statements)
    typer.echo(
        f"[{group}] youtube-analytics: {result.rows_inserted} rows "
        f"({result.runtime_ms} ms)"
    )


@app.command(
    "backfill-targets",
    help="Print the list of group keys that need backfilling, as a JSON "
         "array. Used by the matrix workflow's setup job to compute "
         "stale-only matrix slots. Respects the same --group / --force "
         "/ --fresh-days semantics as backfill-yt-videos itself.",
)
def backfill_targets_cmd(
    group: str | None = typer.Option(
        None, "--group",
        help="Single group key — emits ['<group>']. Empty/None or 'all' "
             "emits the filtered set of KNOWN_GROUPS.",
    ),
    force: bool = typer.Option(False, "--force"),
    fresh_days: int = typer.Option(7, "--fresh-days"),
) -> None:
    settings = load_settings()
    client = _make_d1_client(settings)
    # Normalize 'all' / '' as None for the helper's contract.
    g = None if (not group or group == "all") else group
    if g is not None and g not in KNOWN_GROUPS:
        typer.echo(f"unknown group: {g}", err=True)
        raise typer.Exit(code=2)
    targets = _resolve_backfill_targets(
        client, group=g, force=force, fresh_days=fresh_days,
    )
    # Emit JSON array, single line, suitable for shell capture into
    # GITHUB_OUTPUT. Use json.dumps to ensure correct quoting.
    typer.echo(json.dumps(targets))


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
        "Fetch Melon 차트 (V2.25 — daily 또는 top100). chart_type=daily 시 "
        "agg_summary.melon_top100_peak/depth UPDATE; top100 시 UPDATE 생략. "
        "두 모드 모두 melon_chart_entries에 per-song INSERT (chart_type 명시)."
    ),
)
def melon_chart_run(
    snapshot_at: str | None = typer.Option(
        None,
        "--snapshot-at",
        help=(
            "UTC timestamp like 2026-05-18T21:00:00Z for the per-song "
            "melon_chart_entries rows. Defaults to current UTC hour. "
            "Pin to the aggregate sandwich's snap so entries align with "
            "the agg_summary row being updated."
        ),
    ),
    chart_date: str | None = typer.Option(
        None,
        "--chart-date",
        help=(
            "KST 차트 날짜 'YYYY-MM-DD'. 기본값 = chart_type에 맞춰 "
            "default_chart_date_kst. daily는 어제 KST, top100은 오늘 KST."
        ),
    ),
    chart_type: str = typer.Option(
        "daily",
        "--type",
        help="'daily' (06 KST, /chart/day) 또는 'top100' (22 KST, /chart).",
    ),
) -> None:
    settings = load_settings()
    client = _make_d1_client(settings)
    collector = MelonChartCollector(
        groups_loader=lambda: _load_active_groups(client),
    )
    result = collector.collect_global(
        snapshot_at=snapshot_at,
        chart_date=chart_date,
        chart_type=chart_type,
    )
    if result.errors:
        for e in result.errors:
            typer.echo(f"WARN: {e}", err=True)
    if result.statements:
        client.batch(result.statements)
    typer.echo(
        f"melon-chart({chart_type}): matched {result.rows_inserted} groups "
        f"in {result.runtime_ms}ms"
    )
    raise typer.Exit(code=0 if result.statements or not result.errors else 1)


@app.command(
    "melon-chart-backfill",
    help=(
        "V2.24 1회성 일간차트 백필. guyso.me 아카이브에서 [start..end] 범위의 "
        "일간차트를 가져와 비어있는 chart_date에만 INSERT. 멜론 공식이 dayTime "
        "파라미터를 무시해 직접 백필 불가하므로 3rd-party 아카이브 사용."
    ),
)
def melon_chart_backfill_cmd(
    start: str = typer.Option(
        ..., "--start",
        help="시작 chart_date (YYYY-MM-DD, inclusive).",
    ),
    end: str = typer.Option(
        ..., "--end",
        help="종료 chart_date (YYYY-MM-DD, inclusive).",
    ),
    top_n: int = typer.Option(
        100, "--top",
        help="rank 상위 N까지만 적재. forward collector와 정합 위해 default 100.",
    ),
    dry_run: bool = typer.Option(
        False, "--dry-run",
        help="D1 쓰기 없이 매칭 결과만 출력.",
    ),
) -> None:
    from idol_sight.collectors.melon_backfill import (
        build_backfill_statements,
        daterange,
        existing_chart_dates,
        fetch_guyso_daily,
    )

    settings = load_settings()
    client = _make_d1_client(settings)
    seeded = _load_active_groups(client)
    if not seeded:
        typer.echo("no active groups seeded", err=True)
        raise typer.Exit(code=1)

    dates = daterange(start, end)
    skip = existing_chart_dates(client, start, end)
    targets = [d for d in dates if d not in skip]
    typer.echo(
        f"backfill window: {start}..{end} ({len(dates)}d), "
        f"already filled: {len(skip)}, will fetch: {len(targets)}"
    )

    total_stmts = 0
    failed_dates: list[str] = []
    for d in targets:
        rows = fetch_guyso_daily(d)
        if rows is None:
            failed_dates.append(d)
            typer.echo(f"  {d}: FETCH FAILED", err=True)
            continue
        stmts = build_backfill_statements(d, rows, seeded, top_n=top_n)
        total_stmts += len(stmts)
        typer.echo(
            f"  {d}: parsed {len(rows)} entries → {len(stmts)} insert stmts"
        )
        if stmts and not dry_run:
            client.batch(stmts)

    typer.echo(
        f"melon-chart-backfill: {len(targets) - len(failed_dates)} dates "
        f"processed, {total_stmts} statements"
        + (" (DRY RUN, nothing written)" if dry_run else "")
    )
    if failed_dates:
        typer.echo(f"failed dates: {', '.join(failed_dates)}", err=True)
        raise typer.Exit(code=1)


@app.command("monthly-report",
             help="전월 월간 보고서 덱(종합 단일판) 생성 → monthly_reports 저장.")
def monthly_report_cmd(
    month: str | None = typer.Option(
        None, "--month", help="YYYY-MM (기본: 지난달). 재생성·백필용."),
) -> None:
    # 사전 렌더+동결 방식(스펙 2026-08-04): 이 리포는 소급 정정이 일상이라
    # 보고서는 생성 시점 스냅샷이어야 한다. 대상 월은 tick 지연에 안전한
    # '지난달' 앵커. v2(2026-08-04): 내부/투자사 2판 → 종합 단일판(edition
    # 'full', 사용자 결정) — A4 세로 페이지 체계.
    import json as _json

    from idol_sight.analysis.monthly_render import render_deck
    from idol_sight.analysis.monthly_report import build_monthly_data
    from idol_sight.notify import notify_alert

    settings = load_settings()
    client = _make_d1_client(settings)
    if not month:
        today = datetime.now(UTC).date()
        anchor = today.replace(day=1) - timedelta(days=1)
        month = f"{anchor.year:04d}-{anchor.month:02d}"
    now_iso = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")

    data = build_monthly_data(client, month)
    html_doc = render_deck(data, generated_at=now_iso)
    size = len(html_doc.encode("utf-8"))
    # D1 REST 바디 ~1MB 한계(d1.py) — 이스케이프 팽창 여유 두고 fail-fast.
    if size > 800_000:
        notify_alert(webhook_url=settings.discord_webhook,
                     title=f"월간 보고서 크기 초과 ({month})",
                     body=f"{size:,}B > 800KB — base64/시리즈 과다 여부 확인",
                     severity="warn")
        typer.echo(f"monthly-report: {size:,}B > 800KB", err=True)
        raise typer.Exit(code=1)
    meta = _json.dumps({"warnings": data["warnings"]}, ensure_ascii=False)
    client.batch([
        ("DELETE FROM monthly_reports WHERE month=?", [month]),
        ("INSERT INTO monthly_reports "
         "(month, edition, generated_at, html, size_bytes, meta_json) "
         "VALUES (?, 'full', ?, ?, ?, ?)",
         [month, now_iso, html_doc, size, meta]),
    ])
    notify_alert(webhook_url=settings.discord_webhook,
                 title=f"월간 보고서 준비됨 ({month})",
                 body=(f"종합판 생성 완료({size:,}B) — MiiWAN 개요에서 다운로드"
                       + (f" · 주의 {len(data['warnings'])}건"
                          if data["warnings"] else "")),
                 severity="info")
    typer.echo(f"monthly-report: {month} full={size:,}B "
               f"warnings={len(data['warnings'])}")


@app.command("collect-hanteo",
             help="Scan hanteonews weekly chart articles for seeded groups' "
                  "album sales (global; collect-daily step).")
def collect_hanteo() -> None:
    # hanteo 는 그룹별 collect() 가 no-op 스텁이라 매트릭스 소스로는 못
    # 돈다 — melon-chart 처럼 전역 스캔 1회가 실작업. 초동 기사는 발매 후
    # ~30일 노출되므로 일간 실행이면 유실 없이 잡힌다(UPSERT 멱등).
    settings = load_settings()
    client = _make_d1_client(settings)
    coll = HanteoCollector(groups_loader=lambda: _load_active_groups(client))
    result = coll.collect_global()
    for e in result.errors:
        typer.echo(f"WARN: {e}", err=True)
    if result.statements:
        client.batch(result.statements)
    typer.echo(
        f"collect-hanteo: {result.rows_inserted} rows in {result.runtime_ms}ms")
    raise typer.Exit(code=0 if result.statements or not result.errors else 1)


@app.command("collect-ccv",
             help="Sample YouTube live concurrent viewers for ccv_tracked groups.")
def collect_ccv(
    now: str | None = typer.Option(
        None, "--now", help="ISO8601 UTC sample time; default = current UTC."),
) -> None:
    from idol_sight.collectors.live_ccv import LiveCcvCollector
    settings = load_settings()
    if not settings.yt_api_key:
        typer.echo("YT_API_KEY unset", err=True)
        raise typer.Exit(code=2)
    client = _make_d1_client(settings)
    now_iso = now or datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    coll = LiveCcvCollector(
        api_key=settings.yt_api_key,
        groups_loader=lambda: _load_ccv_targets(client),
    )
    result = coll.collect_global(now_iso=now_iso)
    for e in result.errors:
        typer.echo(f"WARN: {e}", err=True)
    if result.statements:
        client.batch(result.statements)
    typer.echo(f"collect-ccv: {result.rows_inserted} live samples @ {now_iso}")
    raise typer.Exit(code=0 if result.statements or not result.errors else 1)


def _load_live_chat_candidates(client, *, group_key: str, since: str) -> list[str]:
    """since 이후 CCV 가 기록한 group_key 의 방송 중, 아직 리포트 없는 video_id."""
    rows = client.execute(
        "SELECT DISTINCT video_id FROM live_ccv_samples "
        "WHERE group_key=? AND sampled_at >= ? "
        "  AND video_id NOT IN (SELECT video_id FROM live_chat_reports)",
        [group_key, since],
    )
    return [r["video_id"] for r in rows if r.get("video_id")]


def _load_report_targets(client, *, group_key: str, video_id: str | None) -> list[dict]:
    """재생성 대상 리포트(video_id+meta). video_id 지정 시 그 방송만."""
    if video_id is not None:
        sql = ("SELECT video_id, title, ended_at FROM live_chat_reports "
               "WHERE group_key = ? AND video_id = ?")
        params = [group_key, video_id]
    else:
        sql = ("SELECT video_id, title, ended_at FROM live_chat_reports "
               "WHERE group_key = ? ORDER BY ended_at DESC")
        params = [group_key]
    return [dict(r) for r in client.execute(sql, params)]


def _load_stored_messages(client, video_id: str) -> list[dict]:
    """저장된 raw 채팅을 scraper 출력과 같은 모양으로 로드(재스크레이핑 없이 재분류)."""
    rows = client.execute(
        "SELECT msg_id, offset_ms, author, message FROM live_chat_messages "
        "WHERE video_id = ? ORDER BY offset_ms",
        [video_id],
    )
    return [dict(r) for r in rows]


@app.command("collect-live-chat",
             help="종료된 라이브 방송의 채팅 리플레이를 긁어 긍/부정 리포트 생성.")
def collect_live_chat(
    group: str = typer.Option("miiwan", "--group", help="대상 group_key."),
    now: str | None = typer.Option(None, "--now", help="ISO8601 UTC 기준 시각."),
    window_days: int = typer.Option(3, "--window-days", help="후보 탐색 윈도(재시도 상한)."),
    min_age_min: int = typer.Option(30, "--min-age-min", help="종료 후 최소 경과(분)."),
) -> None:
    from datetime import timedelta

    import httpx

    from idol_sight.analysis.live_chat_report import build_report
    from idol_sight.collectors.live_chat import (
        LiveChatReplayScraper,
        ended_broadcasts,
    )

    settings = load_settings()
    if not settings.yt_api_key:
        typer.echo("YT_API_KEY unset", err=True)
        raise typer.Exit(code=2)
    if not settings.gemini_api_key:
        typer.echo("GEMINI_API_KEY unset", err=True)
        raise typer.Exit(code=2)

    client = _make_d1_client(settings)
    now_dt = (datetime.fromisoformat(now.replace("Z", "+00:00")) if now
              else datetime.now(UTC))
    now_iso = now_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    since = (now_dt - timedelta(days=window_days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    grp = _load_group(client, group)

    candidates = _load_live_chat_candidates(client, group_key=group, since=since)
    if not candidates:
        typer.echo("collect-live-chat: no candidate broadcasts")
        raise typer.Exit(code=0)

    ended = ended_broadcasts(
        lambda: httpx.Client(timeout=30.0),
        api_key=settings.yt_api_key, video_ids=candidates,
        now_iso=now_iso, min_age_min=min_age_min,
    )

    scraper = LiveChatReplayScraper()
    gemini = GeminiClient(api_key=settings.gemini_api_key)
    reports = 0
    errors: list[str] = []
    for vid, meta in ended.items():
        try:
            msgs = scraper.scrape(vid)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"scrape {vid}: {exc}")
            continue
        if not msgs:
            continue
        raw_stmts = [(
            "INSERT INTO live_chat_messages "
            "(video_id, group_key, msg_id, offset_ms, author, message) "
            "VALUES (?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(video_id, msg_id) DO NOTHING",
            [vid, group, m["msg_id"], m["offset_ms"], m["author"], m["message"]],
        ) for m in msgs if m.get("msg_id")]
        if raw_stmts:
            client.batch(raw_stmts)
        try:
            stmt = build_report(
                gemini, video_id=vid, group_key=group,
                group_name_kr=grp.name_kr or grp.name, title=meta["title"],
                ended_at=meta["ended_at"], messages=msgs, now_iso=now_iso)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"report {vid}: {exc}")
            continue
        if stmt:
            client.batch([stmt])
            reports += 1

    for e in errors:
        typer.echo(f"WARN: {e}", err=True)
    typer.echo(f"collect-live-chat: {reports} report(s) from "
               f"{len(ended)} ended / {len(candidates)} candidate broadcasts")
    # 후보가 있었는데 전부 실패한 경우에만 비-0 (live_ccv sentinel 패턴)
    raise typer.Exit(code=1 if (ended and reports == 0 and errors) else 0)


@app.command(
    "rebuild-live-chat-reports",
    help="저장된 raw 채팅으로 기존 리포트를 재스크레이핑 없이 "
         "재분류·갱신(스키마 변경 후 백필).")
def rebuild_live_chat_reports(
    group: str = typer.Option("miiwan", "--group", help="대상 group_key."),
    video_id: str | None = typer.Option(
        None, "--video-id", help="특정 방송만(미지정 시 그룹 전체)."),
    now: str | None = typer.Option(None, "--now", help="ISO8601 UTC 기준 시각."),
) -> None:
    from idol_sight.analysis.live_chat_report import build_report

    settings = load_settings()
    if not settings.gemini_api_key:
        typer.echo("GEMINI_API_KEY unset", err=True)
        raise typer.Exit(code=2)

    client = _make_d1_client(settings)
    now_dt = (datetime.fromisoformat(now.replace("Z", "+00:00")) if now
              else datetime.now(UTC))
    now_iso = now_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    grp = _load_group(client, group)

    targets = _load_report_targets(client, group_key=group, video_id=video_id)
    if not targets:
        typer.echo("rebuild-live-chat-reports: no existing reports")
        raise typer.Exit(code=0)

    gemini = GeminiClient(api_key=settings.gemini_api_key)
    reports = 0
    errors: list[str] = []
    for t in targets:
        vid = t["video_id"]
        msgs = _load_stored_messages(client, vid)
        if not msgs:
            errors.append(f"no stored messages {vid}")
            continue
        try:
            stmt = build_report(
                gemini, video_id=vid, group_key=group,
                group_name_kr=grp.name_kr or grp.name, title=t.get("title"),
                ended_at=t.get("ended_at"), messages=msgs, now_iso=now_iso)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"report {vid}: {exc}")
            continue
        if stmt:
            client.batch([stmt])
            reports += 1

    for e in errors:
        typer.echo(f"WARN: {e}", err=True)
    typer.echo(f"rebuild-live-chat-reports: {reports} report(s) rebuilt "
               f"/ {len(targets)} target(s)")
    raise typer.Exit(code=1 if (reports == 0 and errors) else 0)


@app.command(
    "build-live-activity",
    help=(
        "MiiWAN 찐팬 활동량 지표 산출 (P2a). 저장된 live_chat_messages"
        "(방송별 고유 챗터·챗터당 메시지·분당 피크·재방문) + youtube_video_stats"
        "(추정 관여 팬/적극 코어/시청 전환) 재가공으로 agg_live_activity / "
        "agg_live_activity_summary 에 멱등 rebuild. 신규 수집 0 — 기존 데이터 "
        "재가공. live_chat 데이터가 있는 그룹만 실질 산출 = miiwan."
    ),
)
def build_live_activity_cmd(
    group: str = typer.Option(
        "miiwan", "--group",
        help="대상 group_key. 현재 live_chat 수집은 miiwan 만.",
    ),
    window_days: int = typer.Option(
        56, "--window-days",
        help="코어팬·추정 영상 참여 윈도(일). 설계 기본 56.",
    ),
) -> None:
    from idol_sight.analysis.live_activity import build_live_activity

    settings = load_settings()
    client = _make_d1_client(settings)
    try:
        result = build_live_activity(
            client, group_key=group, window_days=window_days,
        )
    except Exception as exc:  # noqa: BLE001 — 단일 그룹, 마이그레이션 미적용 등 비치명적.
        typer.echo(f"[{group}] build-live-activity FAIL: {exc}", err=True)
        raise typer.Exit(code=1) from exc

    if result.statements:
        bs = client.batch(result.statements)
        if bs.statements_executed != bs.statements_sent:
            typer.echo(
                f"partial live_activity write: "
                f"{bs.statements_executed}/{bs.statements_sent}",
                err=True,
            )
            raise typer.Exit(code=1)
    typer.echo(
        f"[{group}] build-live-activity: wrote {len(result.statements)} rows"
    )


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


@app.command(name="challenge-scan", help="주간 바이럴 챌린지 발굴+측정 후 D1 저장.")
def challenge_scan() -> None:
    settings = load_settings()
    if not settings.gemini_api_key:
        raise typer.BadParameter("GEMINI_API_KEY required")
    if not settings.yt_api_key:
        raise typer.BadParameter("YT_API_KEY required")
    client = _make_d1_client(settings)
    gemini = GeminiClient(api_key=settings.gemini_api_key)
    yt = YouTubeCollector(api_key=settings.yt_api_key)
    n = run_challenge_scan(gemini, yt, client, now_epoch=time.time())
    typer.echo(f"challenge-scan: wrote {n} challenges")


@app.command("analyze-weekly", help="Run weekly analysis: hanteo, market_share, member_pop, llm.")
def analyze_weekly(
    week_start: str = typer.Option(..., "--week-start", help="YYYY-MM-DD (Sunday)"),
    week_end: str = typer.Option(
        ..., "--week-end",
        help="YYYY-MM-DD (Saturday for final, Wed for interim)"),
    kind: str = typer.Option(
        "final", "--kind", click_type=click.Choice(["final", "interim"]),
        help="final (일=완결주 결산) | interim (수=중간점검)"),
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
    if getattr(hanteo_result, "errors", None):
        typer.echo(f"hanteo errors: {hanteo_result.errors}")

    # 2. Share of Voice (formerly "market share") — V2 reformulation.
    # Each signal (yt_views/community/news/subscribers) is now
    # converted to a percentile rank across the cohort and mixed via
    # SOV_WEIGHTS so that no single high-volume signal dominates. The
    # data layout: take the latest agg_summary snapshot per group as
    # "this week" and the most recent strictly-older snapshot as
    # "previous week" so we can compute deltas for the momentum mix.
    # On the first run there is only one snapshot → mom inputs are 0
    # and final ≈ cum (still a valid SOV picture).
    from idol_sight.analysis.market_share import compute_market_share, to_statements
    groups = _sov_inputs(client)
    # v3: 카테고리별 독립 코호트 — 혼합 백분위는 K-POP/서브컬처 분리
    # 하드 룰 위반이었고(합이 100이 안 되는 원인), 서브컬처 등락이 K-POP
    # 점수를 흔드는 코호트 의존성을 만들었다. 도메인 내 합 = 각 100.
    share_rows = []
    for cat in ("kpop", "subculture"):
        share_rows += compute_market_share(
            week_start=week_start, week_end=week_end,
            groups=[g for g in groups if g["category"] == cat])
    market_total = sum(g["yt_views"] for g in groups)  # legacy "market_total" column
    # v3.1: 관심 규모 티어 + 근거 플로우 — 0115·0116 적용 D1에서만(감지, graceful).
    try:
        client.execute("SELECT tier, view_flow_90d FROM agg_market_share LIMIT 1")
        tiers, flows = _sov_tiers(client, groups)
    except Exception:
        tiers, flows = None, None
    market_stmts = to_statements(
        share_rows, market_total=market_total, tiers=tiers, flows=flows)
    if market_stmts:
        client.batch(market_stmts)
    typer.echo(f"sov: wrote {len(market_stmts)} rows")

    # 2.5. Health Score per group (writes agg_health_scores).
    # V2.19.2: extracted to _recompute_health_scores so the daily
    # ``aggregate`` cmd can refresh on the same cadence. analyze_weekly
    # writes at the fresh weekly ``snap`` but the cohort lives in the latest
    # daily agg_summary snapshot, so we read that one explicitly (the daily
    # path instead reads/writes the same pinned snapshot — see read_snap).
    latest_agg = client.execute("SELECT MAX(snapshot_at) AS m FROM agg_summary")
    read_snap = (latest_agg[0].get("m") if latest_agg else None) or snap
    n_health = _recompute_health_scores(client, snap, read_snap=read_snap)
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

        # 4.5. V2.55 Controversy issue clustering — 감성 분류 직후. 그룹별
        #      14일 윈도우 controversy 글을 실제 사건 단위 이슈로 dedup 해
        #      effective_weight 를 controversy_issues(mig 0108)에 저장한다.
        #      다음 health 재계산(_recompute_health_scores, stale 8일 가드)이
        #      count 대신 이 weight 로 감점 — 커뮤니티 볼륨이 아닌 이슈 심각도
        #      기반. try/except 로 감싸 실패해도 analyze 전체는 안 죽는다.
        try:
            from idol_sight.analysis.controversy_issues import (
                build_for_group as build_controversy,
            )
            ci_gemini = GeminiClient(api_key=settings.gemini_api_key)
            ci_stmts: list = []
            for g in _load_active_groups(client):
                ci_stmts.extend(build_controversy(
                    client, ci_gemini,
                    group_key=g["key"],
                    group_name_kr=g.get("name_kr") or g["key"],
                    computed_at=snap,
                ))
            if ci_stmts:
                client.batch(ci_stmts)
            typer.echo(f"controversy_issues: wrote {len(ci_stmts)} rows")
        except Exception as exc:  # noqa: BLE001
            typer.echo(f"controversy_issues: skipped ({exc})", err=True)
    else:
        typer.echo("sentiment: skipped (GEMINI_API_KEY unset)")

    # 5. LLM weekly insights
    if settings.gemini_api_key:
        import time as _time

        from idol_sight.analysis.weekly_diagnosis import compute_group_signals
        from idol_sight.llm.gemini import GeminiClient
        from idol_sight.llm.weekly import generate_weekly

        # phase 5a — causal-diagnosis signals (13 SQL). 기존엔 build_context
        # 안에서 호출돼 step logging / latency 가 LLM context 빌드와 섞여
        # 있었다 (backlog item). cli 단계로 분리해 두 phase 의 비용을 분리
        # 측정 + 향후 cache / skip 결정에 활용.
        _t0 = _time.monotonic()
        signals_by_group = compute_group_signals(
            db=client, week_start=week_start, week_end=week_end,
        )
        _lit_total = sum(len(gs.hypotheses) for gs in signals_by_group.values())
        typer.echo(
            f"llm: signals computed in {_time.monotonic() - _t0:.1f}s "
            f"(groups={len(signals_by_group)} hypotheses_lit={_lit_total})"
        )

        # phase 5b — LLM 호출 (signals 주입).
        gemini = GeminiClient(api_key=settings.gemini_api_key)
        _t1 = _time.monotonic()
        weekly = generate_weekly(
            db=client, gemini=gemini,
            week_start=week_start, week_end=week_end,
            signals_by_group=signals_by_group,
            report_kind=kind,
        )
        if weekly.statements:
            client.batch(weekly.statements)
        typer.echo(
            f"llm: wrote {weekly.rows_inserted} insights "
            f"(LLM phase {_time.monotonic() - _t1:.1f}s)"
        )
    else:
        typer.echo("llm: skipped (GEMINI_API_KEY unset)")


def _load_active_groups(client) -> list[dict]:
    return client.execute(
        "SELECT key, name, name_kr FROM groups WHERE is_active=1"
    )


def _load_ccv_targets(client) -> list[dict]:
    return client.execute(
        "SELECT key, yt_channel_id FROM groups "
        "WHERE ccv_tracked=1 AND yt_channel_id IS NOT NULL"
    )


def _recompute_health_scores(
    client, snap: str, *, read_snap: str | None = None,
) -> int:
    """Recompute agg_health_scores for every active group, WRITTEN at ``snap``.

    The cohort is read from the agg_summary snapshot ``read_snap`` (defaults to
    ``snap``). The daily ``aggregate`` path writes and reads the same pinned
    snapshot, so the default is correct — and reading at ``snap`` rather than
    MAX(snapshot_at) keeps backfill/replay correct (a historical recompute used
    to score the snap row with the *latest* cohort). analyze_weekly writes at a
    fresh weekly ``snap`` while the cohort lives in the latest daily snapshot,
    so it passes ``read_snap`` = that latest snapshot explicitly.

    Extracted from analyze_weekly so the daily ``aggregate`` cmd can refresh
    health scores on the same cadence as agg_summary.
    """
    from datetime import date

    from idol_sight.analysis.health_score import (
        compute_dynamic_refs,
        compute_health_score,
        compute_live_metrics,
        hanteo_standing_value,
    )
    cohort_snap = read_snap or snap
    cohort_rows = client.execute(
        "SELECT group_key, yt_subscribers, yt_total_views, "
        "  yt_likes_total, yt_comments_total, "
        "  dc_total_posts, theqoo_posts, instiz_posts, "
        "  naver_total_news, controversy_count, negative_ratio, "
        "  music_show_wins, melon_top100_peak, melon_top100_depth "
        "FROM agg_summary WHERE snapshot_at = ?",
        [cohort_snap],
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

    # V2.56: 최신 앨범 초동 × 180d 반감기 감쇠(hanteo_standing_value). 기존
    # all-time MAX(sales) 는 감쇠가 없어 초동을 영구 보존하고 초동/임의 주차를
    # 혼동했다(캘리브레이션 리포트 §C). hanteo_weekly 는 현재 0행 — 빈 결과면
    # {} 반환, 다운스트림은 missing 을 0 으로 처리(불변).
    hanteo_rows = client.execute(
        "SELECT group_key, week_start, week_end, album, sales "
        "FROM hanteo_weekly WHERE sales IS NOT NULL"
    )
    hanteo_by_key = hanteo_standing_value(hanteo_rows, today=date.today())
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

    # V2.46: 충성도 점수 주입용 조회. basis='scored'(방송 2회+) 만 Health 에
    # 반영 — 단발(low_confidence)·insufficient 는 신호가 얇아 점수 보류(카드
    # 표시는 별개). 테이블 미적용(migration 0084 전)이면 graceful — health
    # 스코어링이 통째로 죽지 않게 빈 dict 로 폴백.
    # V2.52: PLAVE 는 COALESCE 로 score_ceiling(Weverse 포함 천장) 우선.
    try:
        loyalty_rows = client.execute(
            "SELECT group_key, COALESCE(score_ceiling, score) AS score "
            "FROM agg_fan_loyalty "
            "WHERE basis='scored' AND COALESCE(score_ceiling, score) IS NOT NULL"
        )
        loyalty_by_key = {r["group_key"]: r["score"] for r in loyalty_rows}
    except Exception as exc:
        typer.echo(f"[warn] loyalty fallback (agg_fan_loyalty 조회 실패): {exc}", err=True)
        loyalty_by_key = {}

    # V2.55: 이슈 dedup weight 주입용 조회. 테이블 미적용(mig 0108 전)이면
    # graceful — 빈 dict 폴백 → 전 그룹 count 기반 감점(불변). computed_at 이
    # STALE_DAYS(8일)보다 오래된 행은 신뢰하지 않고 None → count 폴백.
    from idol_sight.analysis.controversy_issues import is_stale
    controversy_weight_by_key: dict[str, float] = {}
    try:
        _now = datetime.now(UTC)
        ci_rows = client.execute(
            "SELECT group_key, computed_at, effective_weight "
            "FROM controversy_issues"
        )
        for r in ci_rows:
            if is_stale(r.get("computed_at"), now=_now):
                continue
            controversy_weight_by_key[r["group_key"]] = float(
                r.get("effective_weight") or 0
            )
    except Exception as exc:
        typer.echo(f"[warn] controversy_issues fallback (조회 실패): {exc}", err=True)
        controversy_weight_by_key = {}

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
            "loyalty_score": loyalty_by_key.get(g["key"]),  # None → 2신호 경로
        }
        score = compute_health_score(
            g["key"], agg_dict, g.get("debut_date"),
            refs=dyn_refs, group_model=g.get("group_model"),
            live_metrics=live_metrics,
            debut_confirmed=g.get("debut_confirmed", 1),
            controversy_weight=controversy_weight_by_key.get(g["key"]),
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

    V2.53: debut_confirmed(잠정 앵커 게이트)도 함께 SELECT 시도한다. mig
    0105 미적용 D1(컬럼 부재)이면 예외가 나므로 기존 SELECT 로 폴백한다 —
    이 경우 debut_confirmed 키가 없어 호출부의 .get(..., 1) 로 전 그룹이
    확정(=1) 취급되어 하위 호환이 유지된다.
    """
    try:
        return client.execute(
            "SELECT key, name, name_kr, debut_date, group_model, "
            "debut_confirmed "
            "FROM groups WHERE is_active=1"
        )
    except Exception:
        return client.execute(
            "SELECT key, name, name_kr, debut_date, group_model "
            "FROM groups WHERE is_active=1"
        )


def _shift_date(iso_date: str, days: int) -> str:
    from datetime import date, timedelta
    return (date.fromisoformat(iso_date) + timedelta(days=days)).isoformat()


@app.command(
    name="reeval-naver-relevance",
    help="Backfill: re-arbitrate naver_articles group ownership with the "
         "anchor-gated NewsFilter. Re-evaluates each stored title against "
         "every active group and re-owns it to the highest-scoring group, "
         "excluding rows no group can anchor. Use --dry-run to preview.",
)
def reeval_naver_relevance(
    dry_run: bool = typer.Option(
        False, "--dry-run", help="Print change counts without writing."),
) -> None:
    settings = load_settings()
    client = _make_d1_client(settings)

    active = client.execute("SELECT key FROM groups WHERE is_active=1")
    groups = [_load_group(client, r["key"]) for r in active]

    rows = client.execute(
        "SELECT url_hash, title, published_at, group_key, is_excluded, "
        "match_score FROM naver_articles"
    )
    updates = rearbitrate(rows, groups)
    by_hash = {r["url_hash"]: r for r in rows}

    statements: list[tuple[str, list[Any]]] = []
    reattributed = newly_excluded = restored = 0
    for u in updates:
        before = by_hash[u.url_hash]
        b_key = before.get("group_key")
        b_excl = int(before.get("is_excluded") or 0)
        b_score = int(before.get("match_score") or 0)
        if (u.group_key == b_key and u.is_excluded == b_excl
                and u.match_score == b_score):
            continue
        if u.group_key != b_key:
            reattributed += 1
        if u.is_excluded == 1 and b_excl == 0:
            newly_excluded += 1
        if u.is_excluded == 0 and b_excl == 1:
            restored += 1
        statements.append((
            "UPDATE naver_articles SET group_key=?, is_excluded=?, "
            "exclude_reason=?, match_score=? WHERE url_hash=?",
            [u.group_key, u.is_excluded, u.reason, u.match_score, u.url_hash],
        ))

    typer.echo(
        f"reeval-naver-relevance: rows={len(rows)} changed={len(statements)} "
        f"reattributed={reattributed} newly_excluded={newly_excluded} "
        f"restored={restored} dry_run={dry_run}"
    )
    if dry_run or not statements:
        return
    summary = client.batch(statements)
    typer.echo(
        f"applied {summary.statements_executed}/{summary.statements_sent} "
        f"total_changes={summary.total_changes}"
    )


def main() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
    app()


if __name__ == "__main__":
    main()
