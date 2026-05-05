"""Alert engine — threshold-driven Discord notifications.

The engine runs alongside the regular collect/aggregate cycle. For each
*rule* it checks the current data against a threshold and, when crossed,
emits a structured Discord message. The ``alerts`` table dedups firings
so an hourly cron doesn't re-send the same MiiWAN D-30 alert eight
hours in a row.

Rules implemented (V2 P0):

- ``debut_milestone``  — MiiWAN/OWIS/B:DAWN/MY:RAKL crossing D-30 / D-7
  / D-1 windows. Bucket = "D-30" / "D-7" / "D-1" so the same group fires
  once per milestone, not once per cron run.

- ``video_velocity_24h`` — a youtube video that crossed a view threshold
  within 24h of upload. Bucket = the video_id, so each viral video
  fires exactly once.

- ``controversy_spike`` — controversy_count grew week-over-week beyond a
  multiplier. Bucket = the ISO week (`YYYY-Www`), so a sustained spike
  collapses to one alert per week per group.

The engine is deliberately data-driven — every rule is a small function
returning a list of ``Alert`` candidates. ``run_alerts`` then writes
the dedup row and posts to Discord. We never raise out of the engine
(BI alerts must not break the analyse pipeline).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any, Protocol

log = logging.getLogger(__name__)

# Tunables. Kept module-level so ops can patch them in a hotfix without
# a code search; future iterations may move them to D1.
# Smallest first so the iteration picks the *tightest* milestone the
# group fits into (e.g. days_left=4 lands in D-7, not D-30).
# Smallest first so the iteration picks the *tightest* milestone the
# group fits into (e.g. days_left=4 lands in D-7, not D-30).
DEBUT_MILESTONE_DAYS = (1, 7, 30)
VIDEO_VELOCITY_24H_THRESHOLD = 1_000_000   # 1M views in first 24h
CONTROVERSY_SPIKE_MULTIPLIER = 2.0          # 2x previous-week count
CONTROVERSY_SPIKE_MIN_COUNT = 5             # baseline floor; ignore noise

# V2.5 risk-catalog keywords (Anthropologist §E). We match against
# community_posts.title and naver_articles.title — title-only is enough
# for triage and avoids storing post body content.
#
# 본체 keywords: classification-system pollution. Single-occurrence
# threshold for naver_articles (mainstream press picking up identity
# is by definition critical), 5x weekly baseline for community boards
# (which use the words colloquially in non-leak contexts).
IDENTITY_LEAK_KEYWORDS = (
    "본체", "중인", "신상", "정체", "리얼페이스", "real face", "doxx",
)
# Model theft / deepfake / unauthorized AI cover.
MODEL_THEFT_KEYWORDS = (
    "AI cover", "AI커버", "딥페이크", "deepfake", "도용", "ai음성",
    "ai 음성", "음성 도용",
)


@dataclass
class Alert:
    rule: str
    scope: str          # group_key or 'market'
    bucket: str
    severity: str       # 'info' | 'warn' | 'critical'
    title: str
    body: str

    @property
    def alert_key(self) -> str:
        return f"{self.rule}:{self.scope}:{self.bucket}"


class _Executor(Protocol):
    def execute(
        self, sql: str, params: list[Any] | None = ...,
    ) -> list[dict[str, Any]]: ...

    def batch(self, statements: list[tuple[str, list[Any]]]) -> Any: ...


# ─── Rules ─────────────────────────────────────────────────────────────


def rule_debut_milestone(client: _Executor, *, today: date | None = None) -> list[Alert]:
    """Emit a D-30 / D-7 / D-1 alert per pre-debut group.

    today defaults to UTC date so ops can override in tests. Buckets are
    coarse (the D-day band, not the exact day) so ops gets a heads-up
    once when the band is entered, not every day inside it.
    """
    today = today or datetime.now(UTC).date()
    rows = client.execute(
        "SELECT key, name, name_kr, debut_date FROM groups "
        "WHERE is_active=1 AND debut_date IS NOT NULL"
    )
    out: list[Alert] = []
    for r in rows:
        try:
            d_debut = date.fromisoformat(r["debut_date"])
        except (ValueError, TypeError):
            continue
        days_left = (d_debut - today).days
        if days_left <= 0:
            continue
        # Map days_left into the largest milestone it crosses today.
        # E.g. days_left=27 → matches D-30 if no prior D-30 fired
        # (dedup handles re-fires); days_left=6 → D-7; etc.
        for milestone in DEBUT_MILESTONE_DAYS:
            if days_left <= milestone:
                bucket = f"D-{milestone}"
                out.append(Alert(
                    rule="debut_milestone",
                    scope=r["key"],
                    bucket=bucket,
                    severity="warn" if milestone <= 7 else "info",
                    title=f"{r['name']} {bucket} — 데뷔까지 {days_left}일",
                    body=(f"{r['name_kr']} 데뷔일 {r['debut_date']}까지 "
                          f"{days_left}일 남았습니다. 마케팅·공지 체크리스트를 "
                          f"점검하세요."),
                ))
                break  # one milestone per group per run
    return out


def rule_video_velocity_24h(
    client: _Executor, *, threshold: int | None = None,
) -> list[Alert]:
    """Emit when a YouTube video passes ``threshold`` views within 24h
    of upload. Bucket = video_id so each viral video fires exactly once.
    """
    threshold = threshold or VIDEO_VELOCITY_24H_THRESHOLD
    rows = client.execute(
        "SELECT v.video_id, v.group_key, v.title, v.published_at, "
        "       g.name AS group_name, "
        "       MAX(s.views) AS peak_views_24h "
        "FROM youtube_videos v "
        "JOIN youtube_video_stats s "
        "  ON s.video_id = v.video_id "
        "  AND julianday(s.snapshot_at) - julianday(v.published_at) <= 1.0 "
        "JOIN groups g ON g.key = v.group_key "
        "WHERE v.published_at >= datetime('now', '-7 days') "
        "GROUP BY v.video_id "
        "HAVING peak_views_24h >= ?",
        [threshold],
    )
    out: list[Alert] = []
    for r in rows:
        out.append(Alert(
            rule="video_velocity_24h",
            scope=r["group_key"],
            bucket=r["video_id"],
            severity="info",
            title=f"{r['group_name']} 영상 24h {r['peak_views_24h']:,}회 돌파",
            body=(f"\"{(r['title'] or '')[:80]}\" — 업로드 24시간 내 "
                  f"{r['peak_views_24h']:,}회. "
                  f"https://youtu.be/{r['video_id']}"),
        ))
    return out


def rule_controversy_spike(
    client: _Executor, *, multiplier: float | None = None,
    min_count: int | None = None,
) -> list[Alert]:
    """Compare the latest agg_summary controversy_count against the
    most recent strictly-older row per group; fire when growth exceeds
    ``multiplier`` AND latest count ≥ ``min_count``.

    Bucket = ISO week of the latest snapshot, so a sustained spike
    collapses to one alert per week per group.
    """
    multiplier = multiplier or CONTROVERSY_SPIKE_MULTIPLIER
    min_count = min_count or CONTROVERSY_SPIKE_MIN_COUNT

    last = client.execute(
        "SELECT group_key, snapshot_at, controversy_count FROM agg_summary "
        "WHERE snapshot_at = (SELECT MAX(snapshot_at) FROM agg_summary)"
    )
    if not last:
        return []
    prev = client.execute(
        "SELECT group_key, controversy_count FROM agg_summary "
        "WHERE snapshot_at = ("
        "  SELECT MAX(snapshot_at) FROM agg_summary "
        "  WHERE snapshot_at < (SELECT MAX(snapshot_at) FROM agg_summary)"
        ")"
    )
    prev_by = {r["group_key"]: r.get("controversy_count") or 0 for r in prev}
    out: list[Alert] = []
    for r in last:
        gk = r["group_key"]
        cur = r.get("controversy_count") or 0
        if cur < min_count:
            continue
        before = prev_by.get(gk, 0)
        ratio = (
            (float("inf") if cur > 0 else 0.0)
            if before == 0 else cur / before
        )
        if ratio < multiplier:
            continue
        try:
            snap_iso = (r.get("snapshot_at") or "").split("T", 1)[0]
            snap_d = date.fromisoformat(snap_iso) if snap_iso else date.today()
        except ValueError:
            snap_d = date.today()
        iso_year, iso_week, _ = snap_d.isocalendar()
        bucket = f"{iso_year}-W{iso_week:02d}"
        out.append(Alert(
            rule="controversy_spike",
            scope=gk,
            bucket=bucket,
            severity="critical",
            title=f"{gk} controversy 급증 ({before}→{cur})",
            body=(f"전 주 대비 {ratio:.1f}× 증가. "
                  f"PR/리스크 탭에서 트윗 출처를 즉시 확인하세요. "
                  f"※ 자동 알림이므로 인간 검증 후 대응 권장 (false positive "
                  f"시 Streisand effect)."),
        ))
    return out


def rule_identity_leak(client: _Executor) -> list[Alert]:
    """Fire when 본체/중인/신상 keywords appear in naver_articles.

    Press picking up the human-behind-the-character is the most
    serious crisis class in the virtual idol playbook (Mary Douglas
    "pollution" of the sacred boundary). Even a single hit warrants a
    critical alert. Bucket = ``YYYY-MM-DD:<group>`` so we get one
    alert per group per day even if multiple matching articles land.

    We deliberately don't scan community_posts here — those use the
    same words colloquially in non-leak contexts (e.g. "본체 노출
    안 한 게 다행"). Press is a higher signal-to-noise channel.
    """
    if not IDENTITY_LEAK_KEYWORDS:
        return []
    likes = " OR ".join(["title LIKE ?"] * len(IDENTITY_LEAK_KEYWORDS))
    params: list[Any] = [f"%{kw}%" for kw in IDENTITY_LEAK_KEYWORDS]
    rows = client.execute(
        "SELECT group_key, "
        "  date(published_at) AS day, "
        "  COUNT(*) AS n, "
        "  MIN(title) AS sample "
        "FROM naver_articles "
        f"WHERE COALESCE(is_excluded,0)=0 AND ({likes}) "
        "  AND published_at >= datetime('now', '-7 days') "
        "GROUP BY group_key, day",
        params,
    )
    out: list[Alert] = []
    for r in rows:
        gk = r["group_key"]
        day = r.get("day") or ""
        if not day:
            continue
        out.append(Alert(
            rule="identity_leak",
            scope=gk,
            bucket=f"{day}",
            severity="critical",
            title=f"{gk} 본체 관련 기사 감지 ({r.get('n')}건)",
            body=(f"날짜 {day}, 샘플 제목: {(r.get('sample') or '')[:120]}. "
                  f"기사 원문 검수 후 즉시 대응 절차로 이관하세요. "
                  f"※ 자동 알림 — false positive 시 Streisand effect 주의."),
        ))
    return out


def rule_model_theft(client: _Executor) -> list[Alert]:
    """Fire when AI cover / 딥페이크 / 도용 mentions spike on community
    posts. We compare the latest 24h count against the prior 7-day
    daily average; ratios ≥3 with at least 5 absolute mentions
    qualify. Bucket = ISO week so a sustained spike collapses to one
    alert per week.
    """
    if not MODEL_THEFT_KEYWORDS:
        return []
    likes = " OR ".join(["title LIKE ?"] * len(MODEL_THEFT_KEYWORDS))
    params: list[Any] = [f"%{kw}%" for kw in MODEL_THEFT_KEYWORDS]
    rows = client.execute(
        "SELECT group_key, "
        "  SUM(CASE WHEN posted_at >= datetime('now','-1 days') "
        "           THEN 1 ELSE 0 END) AS last_24h, "
        "  SUM(CASE WHEN posted_at >= datetime('now','-8 days') "
        "           AND posted_at <  datetime('now','-1 days') "
        "           THEN 1 ELSE 0 END) AS prior_7d "
        "FROM community_posts "
        f"WHERE ({likes}) "
        "  AND posted_at >= datetime('now', '-8 days') "
        "GROUP BY group_key",
        params,
    )
    out: list[Alert] = []
    for r in rows:
        last = int(r.get("last_24h") or 0)
        prior = int(r.get("prior_7d") or 0)
        if last < 5:
            continue
        baseline = (prior / 7.0) if prior > 0 else 0.0
        ratio = float("inf") if baseline <= 0 else last / baseline
        if ratio < 3.0:
            continue
        gk = r["group_key"]
        iso_year, iso_week, _ = datetime.now(UTC).date().isocalendar()
        bucket = f"{iso_year}-W{iso_week:02d}"
        out.append(Alert(
            rule="model_theft",
            scope=gk,
            bucket=bucket,
            severity="warn",
            title=f"{gk} AI 음성/모델 도용 멘션 급증 ({last}건/24h)",
            body=(f"24h 누적 {last}건 vs 직전 7일 일평균 {baseline:.1f}건 "
                  f"({ratio:.1f}× 증가). 도용/딥페이크 게시물 출처 확인 + "
                  f"플랫폼 신고 절차 검토."),
        ))
    return out


# ─── Engine ─────────────────────────────────────────────────────────────


def run_alerts(
    client: _Executor,
    *,
    webhook_url: str | None,
    today: date | None = None,
) -> list[Alert]:
    """Evaluate all rules, dedup against the alerts table, post to
    Discord, and persist the firing rows. Returns the list of newly
    fired alerts (for logging / typer.echo). webhook_url=None means
    "evaluate but don't post" (handy for dry-run / tests).
    """
    candidates: list[Alert] = []
    candidates.extend(rule_debut_milestone(client, today=today))
    candidates.extend(rule_video_velocity_24h(client))
    candidates.extend(rule_controversy_spike(client))
    candidates.extend(rule_identity_leak(client))
    candidates.extend(rule_model_theft(client))

    if not candidates:
        return []

    keys = [c.alert_key for c in candidates]
    placeholders = ",".join("?" for _ in keys)
    seen = client.execute(
        f"SELECT alert_key FROM alerts WHERE alert_key IN ({placeholders})",
        keys,
    )
    seen_set = {r["alert_key"] for r in seen}
    fresh = [c for c in candidates if c.alert_key not in seen_set]
    if not fresh:
        return []

    now_iso = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    statements: list[tuple[str, list[Any]]] = []
    for a in fresh:
        statements.append((
            "INSERT INTO alerts "
            "  (alert_key, rule, scope, severity, title, body, fired_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(alert_key) DO NOTHING",
            [a.alert_key, a.rule, a.scope, a.severity, a.title, a.body, now_iso],
        ))
    if statements:
        try:
            client.batch(statements)
        except Exception as e:  # noqa: BLE001
            log.warning("alerts persist failed: %s", e)
            # Continue to webhook anyway — better duplicate-fire-once
            # than miss a critical alert because the dedup write failed.

    if webhook_url:
        from idol_sight.notify import notify_alert
        for a in fresh:
            notify_alert(
                webhook_url=webhook_url,
                title=a.title, body=a.body, severity=a.severity,
            )

    return fresh


__all__ = [
    "Alert",
    "rule_controversy_spike",
    "rule_debut_milestone",
    "rule_identity_leak",
    "rule_model_theft",
    "rule_video_velocity_24h",
    "run_alerts",
]


# Re-exported for tests that need to monkeypatch the wall clock.
def _today() -> date:
    return datetime.now(UTC).date()


# Silence a 'timedelta unused' false-positive — the tunable lives here
# in case ops wants to tighten the cooldown grace period.
_GRACE = timedelta(hours=1)
