"""월간 보고서 — 데이터 조립 + 자동 결론 (렌더는 monthly_render.py).

매월 초 전월 마감분을 덱으로 동결한다. 설계 원칙(스펙 2026-08-04):
- 스톡 지표 = UTC 월말 스냅샷(위버스만 KST day) / 플로우 = 월말 델타
  (일별 합산 금지 — 백필·결측에 취약) / avg_ccv = 방송별 평균의 월평균.
- 시계열·델타는 agg_summary ``data_source='live'`` 행만. NULL→0 변환 금지.
- 결론 문장은 전부 결정적 템플릿(R1~R7) — LLM 호출 없음.
- 판정은 확정월만(당월 진행 중 금지). 결측 섹션은 값 대신 사유를 남긴다.
"""

from __future__ import annotations

import calendar
import statistics
from typing import Any, Protocol

# ── 목표 밴드 — frontend/src/lib/miiwanKpi.ts PACE_BANDS 미러 ─────────────
# (볼트 'KPI·매출 가정치 레퍼런스' §5 확정 계획 수치. 변경 시 동반 갱신.)
PACE_BANDS: dict[str, dict[str, tuple[int, int]]] = {
    "2026-07": {"subscribers": (32000, 35000), "avg_ccv": (700, 760),
                "weverse_members": (4200, 4600), "weverse_membership": (70, 80)},
    "2026-08": {"subscribers": (37000, 45000), "avg_ccv": (850, 1050),
                "weverse_members": (4800, 5900), "weverse_membership": (130, 170)},
    "2026-09": {"subscribers": (43000, 55000), "avg_ccv": (1000, 1300),
                "weverse_members": (5600, 7200), "weverse_membership": (300, 400)},
    "2026-10": {"subscribers": (50000, 68000), "avg_ccv": (1200, 1600),
                "weverse_members": (6500, 8800), "weverse_membership": (450, 600)},
    "2026-11": {"subscribers": (62000, 80000), "avg_ccv": (1500, 1900),
                "weverse_members": (8000, 10400), "weverse_membership": (580, 770)},
    "2026-12": {"subscribers": (72000, 90000), "avg_ccv": (1600, 2000),
                "weverse_members": (9500, 11700), "weverse_membership": (700, 900)},
}

KPI_LABELS = {
    "subscribers": "YouTube 구독자",
    "avg_ccv": "평균 라이브 동접",
    "weverse_members": "위버스 가입자",
    "weverse_membership": "유료 멤버십",
}

TIER_LABELS = {1: "선두 그룹", 2: "추격 그룹", 3: "후발 그룹"}

TARGET = "miiwan"


# ── 순수 유틸 ──────────────────────────────────────────────────────────


def month_bounds(month: str) -> tuple[str, str]:
    """'2026-07' → (포함 시작, 배타 끝) UTC ISO."""
    y, m = int(month[:4]), int(month[5:7])
    ny, nm = (y + 1, 1) if m == 12 else (y, m + 1)
    return (f"{y:04d}-{m:02d}-01T00:00:00Z", f"{ny:04d}-{nm:02d}-01T00:00:00Z")


def prev_month(month: str) -> str:
    y, m = int(month[:4]), int(month[5:7])
    return f"{y - 1:04d}-12" if m == 1 else f"{y:04d}-{m - 1:02d}"


def month_last_day(month: str) -> str:
    y, m = int(month[:4]), int(month[5:7])
    return f"{y:04d}-{m:02d}-{calendar.monthrange(y, m)[1]:02d}"


def fmt_num(n: float | int | None) -> str:
    """기존 먼슬리 보고 표기 미러 — 10k 이상은 'X.Xk', 미만은 천단위 콤마."""
    if n is None:
        return "—"
    n = round(n)
    if abs(n) >= 10_000:
        return f"{n / 1000:.1f}k"
    return f"{n:,}"


def mom_phrase(cur: float | int | None, prev: float | int | None) -> str:
    """'28.6k (전월 27.9k)' — 전월 결측이면 '(전월 —)'."""
    return f"{fmt_num(cur)} (전월 {fmt_num(prev)})"


def band_verdict(actual: float, band: tuple[int, int]) -> str:
    """'below' | 'within' | 'above' — 경계 포함 within (miiwanKpi 계약)."""
    if actual < band[0]:
        return "below"
    if actual > band[1]:
        return "above"
    return "within"


# ── 자동 결론 (R1~R5) ─────────────────────────────────────────────────


def kpi_judgments(month: str, actuals: dict[str, float | None]) -> dict[str, dict]:
    """지표별 {actual, band, verdict}. 실측·밴드 둘 다 있어야 판정."""
    bands = PACE_BANDS.get(month, {})
    out: dict[str, dict] = {}
    for key, label in KPI_LABELS.items():
        actual = actuals.get(key)
        band = bands.get(key)
        out[key] = {
            "label": label, "actual": actual, "band": band,
            "verdict": band_verdict(actual, band)
            if actual is not None and band else None,
        }
    return out


def kpi_headline(judgments: dict[str, dict]) -> str:
    """R1 — 판정 가능한 KPI들의 종합 헤드라인."""
    judged = {k: j for k, j in judgments.items() if j["verdict"]}
    if not judged:
        return "판정 가능한 KPI 없음 — 목표 밴드 정의 이전 구간"
    below = [j for j in judged.values() if j["verdict"] == "below"]
    above = [j for j in judged.values() if j["verdict"] == "above"]
    n = len(judged)
    if not below and len(above) >= 2:
        return f"{n}대 KPI 중 {len(above)}개가 목표 밴드 상단 초과 — 낙관 시나리오 페이스"
    if not below:
        return f"{n}대 KPI 모두 목표 밴드 내 — 계획 페이스 유지"
    if len(below) == 1:
        j = below[0]
        gap = j["band"][0] - j["actual"]
        return (f"{j['label']} 1개 미달({fmt_num(j['actual'])} vs 보수 "
                f"{fmt_num(j['band'][0])}, {fmt_num(gap)} 부족), 나머지는 밴드 내 이상")
    names = "·".join(j["label"] for j in below)
    return f"{n}대 KPI 중 {len(below)}개 미달({names}) — 페이스 점검 필요"


def kpi_line(j: dict, prev_actual: float | None) -> str:
    """R2 — 개별 KPI 문장."""
    base = f"{j['label']} {mom_phrase(j['actual'], prev_actual)}"
    if not j["verdict"]:
        return base
    lo, hi = j["band"]
    if j["verdict"] == "below":
        return f"{base} — 보수 하한 {fmt_num(lo)} 대비 {fmt_num(lo - j['actual'])} 부족"
    if j["verdict"] == "above":
        return f"{base} — 낙관 상단 {fmt_num(hi)} 초과 (+{fmt_num(j['actual'] - hi)})"
    return f"{base} — 밴드 {fmt_num(lo)}~{fmt_num(hi)} 내"


def tier_line(prev_tier: int | None, now_tier: int | None,
              flow_rank: int | None, team_count: int | None) -> str | None:
    """R3 — 티어 이동 문장. now 없으면 None."""
    if now_tier is None:
        return None
    now_label = TIER_LABELS.get(now_tier, f"T{now_tier}")
    if prev_tier is None:
        return f"관심 규모 티어 신규 산출: {now_label}"
    if now_tier < prev_tier:
        return f"관심 규모 티어 상승: {TIER_LABELS.get(prev_tier)} → {now_label}"
    if now_tier > prev_tier:
        return f"관심 규모 티어 하락: {TIER_LABELS.get(prev_tier)} → {now_label}"
    rank_part = (f" — 카테고리 내 조회 흐름 {flow_rank}위/{team_count}팀"
                 if flow_rank else "")
    return f"티어 유지({now_label}){rank_part}"


def cohort_rank_line(rank_now: int | None, rank_prev: int | None,
                     cohort_n: int, mult_now: float | None,
                     mult_prev: float | None) -> str | None:
    """R4 — 동시기 성장배수 순위 문장."""
    if rank_now is None:
        return None
    if rank_prev is not None and rank_now < rank_prev:
        return f"동시기 성장배수 {rank_prev}위 → {rank_now}위 (코호트 {cohort_n}팀 중)"
    if rank_prev is not None and rank_now > rank_prev:
        return f"동시기 성장배수 {rank_prev}위 → {rank_now}위 하락 (코호트 {cohort_n}팀 중)"
    mult_part = ""
    if mult_now is not None:
        mult_part = f" — 배수 {mult_now:.2f}x"
        if mult_prev is not None:
            mult_part += f" (전월 {mult_prev:.2f}x)"
    return f"동시기 {rank_now}위 (코호트 {cohort_n}팀 중){mult_part}"


def quadrant_move_line(prev_q: str | None, now_q: str | None,
                       labels: dict[str, str]) -> str | None:
    """R5 — 분면 변경 시에만 문장, 유지면 None(노이즈 억제)."""
    if not now_q or not prev_q or prev_q == now_q:
        return None
    return f"포지션 이동: {labels.get(prev_q, prev_q)} → {labels.get(now_q, now_q)}"


def spike_note(daily_gains: list[tuple[str, int]],
               events: list[dict]) -> str | None:
    """R6 — 일별 순증 스파이크 각주. daily_gains = [(day, gain)]."""
    gains = [g for _, g in daily_gains if g > 0]
    if len(gains) < 7:
        return None
    med = statistics.median(gains)
    peak_day, peak = max(daily_gains, key=lambda x: x[1])
    if med <= 0 or peak <= med * 5:
        return None
    near = [e for e in events
            if abs((_day_ord(e["event_date"]) - _day_ord(peak_day))) <= 3]
    total = sum(gains)
    share = round(peak / total * 100) if total else 0
    if near:
        return (f"{peak_day[5:]} '{near[0]['title']}' 효과로 단기 스파이크 — "
                f"월 순증의 {share}%가 해당 일에 집중")
    return f"{peak_day[5:]} 원인 미상 스파이크(확인 필요) — 월 순증의 {share}% 집중"


def _day_ord(day: str) -> int:
    y, m, d = int(day[:4]), int(day[5:7]), int(day[8:10])
    return y * 372 + m * 31 + d


# ── D1 조립 ───────────────────────────────────────────────────────────


class _Executor(Protocol):
    def execute(self, sql: str, params: list | None = ...) -> list[dict]: ...


def _eom_summary(client: _Executor, month: str, group: str = TARGET) -> dict | None:
    """월말(배타 끝 이전 마지막) live 스냅샷 행."""
    _, end = month_bounds(month)
    rows = client.execute(
        "SELECT * FROM agg_summary WHERE group_key=? AND data_source='live' "
        "AND snapshot_at < ? ORDER BY snapshot_at DESC LIMIT 1",
        [group, end])
    return rows[0] if rows else None


def _avg_ccv(client: _Executor, month: str) -> dict:
    start, end = month_bounds(month)
    rows = client.execute(
        "SELECT video_id, AVG(concurrent_viewers) AS avg_v, "
        "MAX(concurrent_viewers) AS peak_v, MIN(sampled_at) AS started "
        "FROM live_ccv_samples WHERE group_key=? "
        "GROUP BY video_id HAVING MIN(sampled_at) >= ? AND MIN(sampled_at) < ? "
        "ORDER BY started ASC",
        [TARGET, start, end])
    avgs = [r["avg_v"] for r in rows if r.get("avg_v") is not None]
    return {
        "broadcasts": [
            {"started": r["started"][:10], "avg": round(r["avg_v"]),
             "peak": r["peak_v"]} for r in rows if r.get("avg_v") is not None],
        "avg": round(statistics.mean(avgs)) if avgs else None,
        "peak": max((r["peak_v"] or 0) for r in rows) if rows else None,
        "count": len(rows),
    }


def _weverse_eom(client: _Executor, month: str) -> dict | None:
    """월말 위버스 행(KST day 기준 — 유일한 예외). 월말 행 부재 시 그 달
    마지막 존재 행 + as_of 로 각주 재료 제공."""
    last_day = month_last_day(month)
    rows = client.execute(
        "SELECT day, total_members, digital_membership FROM weverse_stats "
        "WHERE group_key=? AND day <= ? ORDER BY day DESC LIMIT 1",
        [TARGET, last_day])
    if not rows or not rows[0]["day"].startswith(month):
        return None
    r = rows[0]
    return {"day": r["day"], "members": r["total_members"],
            "membership": r["digital_membership"],
            "partial": r["day"] != last_day}


def _daily_series(client: _Executor, months: list[str],
                  group: str = TARGET) -> list[dict]:
    """일별 구독 시계열(live) — 차트용. months = 연속된 월 리스트."""
    start, _ = month_bounds(months[0])
    _, end = month_bounds(months[-1])
    return client.execute(
        "SELECT substr(snapshot_at, 1, 10) AS day, MAX(yt_subscribers) AS subs "
        "FROM agg_summary WHERE group_key=? AND data_source='live' "
        "AND snapshot_at >= ? AND snapshot_at < ? AND yt_subscribers IS NOT NULL "
        "GROUP BY substr(snapshot_at, 1, 10) ORDER BY day ASC",
        [group, start, end])


def _weverse_series(client: _Executor, month: str) -> list[dict]:
    start = f"{month}-01"
    return client.execute(
        "SELECT day, total_members, digital_membership FROM weverse_stats "
        "WHERE group_key=? AND day >= ? AND day <= ? ORDER BY day ASC",
        [TARGET, start, month_last_day(month)])


def _tier_row(client: _Executor, month: str) -> dict | None:
    """월내 마지막 final 주(토요일 week_end)의 티어·flow + 카테고리 flow 순위."""
    last_day = month_last_day(month)
    rows = client.execute(
        "SELECT m.week_end, m.tier, m.view_flow_90d FROM agg_market_share m "
        "WHERE m.group_key=? AND m.week_end <= ? "
        "AND strftime('%w', m.week_end) = '6' "
        "ORDER BY m.week_end DESC LIMIT 1",
        [TARGET, last_day])
    if not rows:
        return None
    week_end = rows[0]["week_end"]
    peers = client.execute(
        "SELECT m.group_key, m.view_flow_90d FROM agg_market_share m "
        "JOIN groups g ON g.key = m.group_key "
        "WHERE m.week_end = ? AND g.group_model = 'corporate' "
        "ORDER BY m.view_flow_90d DESC",
        [week_end])
    rank = next((i + 1 for i, p in enumerate(peers)
                 if p["group_key"] == TARGET), None)
    all_kpop = client.execute(
        "SELECT m.group_key, m.tier, m.view_flow_90d FROM agg_market_share m "
        "JOIN groups g ON g.key = m.group_key "
        "WHERE m.week_end = ? AND g.group_model = 'corporate' "
        "ORDER BY m.view_flow_90d DESC",
        [week_end])
    return {"week_end": week_end, "tier": rows[0]["tier"],
            "flow": rows[0]["view_flow_90d"], "flow_rank": rank,
            "team_count": len(peers), "kpop_rows": all_kpop}


def _quadrant(client: _Executor, month: str) -> dict | None:
    """월말 스냅샷의 인지도×코어 좌표(K-POP 전 그룹) + MiiWAN 분면."""
    _, end = month_bounds(month)
    snap_rows = client.execute(
        "SELECT MAX(snapshot_at) AS s FROM agg_awareness WHERE snapshot_at < ?",
        [end])
    snap = snap_rows[0]["s"] if snap_rows else None
    if not snap:
        return None
    pts = client.execute(
        "SELECT a.group_key, a.awareness_score AS x, c.est_active_core AS y "
        "FROM agg_awareness a "
        "JOIN groups g ON g.key = a.group_key AND g.group_model='corporate' "
        "LEFT JOIN agg_core_fan_estimate c "
        "  ON c.group_key = a.group_key AND c.snapshot_at = a.snapshot_at "
        "WHERE a.snapshot_at = ? AND a.awareness_score IS NOT NULL "
        "AND c.est_active_core IS NOT NULL",
        [snap])
    if len(pts) < 3:
        return None
    xs = sorted(p["x"] for p in pts)
    ys = sorted(p["y"] for p in pts)
    mx, my = statistics.median(xs), statistics.median(ys)
    mine = next((p for p in pts if p["group_key"] == TARGET), None)

    def quad(p):
        return (("strong" if p["y"] >= my else "ad_driven") if p["x"] >= mx
                else ("niche" if p["y"] >= my else "low"))
    return {"snapshot": snap, "points": pts, "median_x": mx, "median_y": my,
            "mine_quadrant": quad(mine) if mine else None}


def _cohort(client: _Executor, month: str) -> dict:
    """최소 정직 버전 동시기 비교 — live+backfill_exact 구독으로 D-정렬
    성장배수. D0 결측(±3일 내 스냅샷 없음) 팀은 excluded 명시."""
    _, end = month_bounds(month)
    peers = ["myrakl", "owis", "bdawn", "bthd", "skinz"]
    debuts = {r["key"]: r["debut_date"][:10] for r in client.execute(
        "SELECT key, debut_date FROM groups WHERE debut_date IS NOT NULL")}
    if TARGET not in debuts:
        return {"rows": [], "excluded": [], "age_days": None}
    eom = client.execute(
        "SELECT MAX(substr(snapshot_at,1,10)) AS d FROM agg_summary "
        "WHERE group_key=? AND data_source='live' AND snapshot_at < ?",
        [TARGET, end])
    eom_day = eom[0]["d"] if eom and eom[0]["d"] else None
    if not eom_day:
        return {"rows": [], "excluded": [], "age_days": None}
    age = _day_ord(eom_day) - _day_ord(debuts[TARGET])

    def subs_at(group: str, day_center: str, tol: int = 3) -> int | None:
        rows = client.execute(
            "SELECT yt_subscribers, substr(snapshot_at,1,10) AS d FROM agg_summary "
            "WHERE group_key=? AND data_source IN ('live','backfill_exact') "
            "AND yt_subscribers IS NOT NULL "
            "AND substr(snapshot_at,1,10) BETWEEN date(?, ?) AND date(?, ?) "
            "ORDER BY ABS(julianday(substr(snapshot_at,1,10)) - julianday(?)) ASC "
            "LIMIT 1",
            [group, day_center, f"-{tol} days", day_center, f"+{tol} days",
             day_center])
        return rows[0]["yt_subscribers"] if rows else None

    rows_out, excluded = [], []
    for g in [TARGET] + peers:
        debut = debuts.get(g)
        if not debut:
            excluded.append({"group": g, "reason": "no_debut_date"})
            continue
        d0 = subs_at(g, debut)
        if not d0:
            excluded.append({"group": g, "reason": "no_d0_baseline"})
            continue
        at_day = _add_days(debut, age)
        at_val = subs_at(g, at_day)
        if at_val is None:
            excluded.append({"group": g, "reason": "no_at_day_value"})
            continue
        rows_out.append({"group": g, "d0": d0, "at": at_val,
                         "multiple": round(at_val / d0, 2)})
    ranked = sorted(rows_out, key=lambda r: -r["multiple"])
    for i, r in enumerate(ranked, 1):
        r["rank"] = i
    return {"rows": ranked, "excluded": excluded, "age_days": age}


def _add_days(day: str, n: int) -> str:
    import datetime as _dt
    d = _dt.date.fromisoformat(day) + _dt.timedelta(days=n)
    return d.isoformat()


def _latest_before(client: _Executor, table: str, month: str,
                   extra_where: str = "", params: list | None = None) -> str | None:
    _, end = month_bounds(month)
    rows = client.execute(
        f"SELECT MAX(snapshot_at) AS s FROM {table} "
        f"WHERE snapshot_at < ? AND group_key=? {extra_where}",
        [end, TARGET] + (params or []))
    return rows[0]["s"] if rows and rows[0]["s"] else None


def build_monthly_data(client: _Executor, month: str) -> dict[str, Any]:
    """덱 렌더 입력 전체 조립. 결측은 None/빈 리스트 + warnings 로 남긴다."""
    pm = prev_month(month)
    warnings: list[str] = []

    eom, eom_prev = _eom_summary(client, month), _eom_summary(client, pm)
    ccv, ccv_prev = _avg_ccv(client, month), _avg_ccv(client, pm)
    wv, wv_prev = _weverse_eom(client, month), _weverse_eom(client, pm)
    if wv and wv.get("partial"):
        warnings.append(f"위버스 월말 행 부재 — {wv['day']} 기준")
    if ccv["count"] <= 2:
        warnings.append(f"라이브 관측 방송 {ccv['count']}회 — 표본 부족")

    actuals = {
        "subscribers": eom.get("yt_subscribers") if eom else None,
        "avg_ccv": ccv["avg"],
        "weverse_members": wv["members"] if wv else None,
        "weverse_membership": wv["membership"] if wv else None,
    }
    prev_actuals = {
        "subscribers": eom_prev.get("yt_subscribers") if eom_prev else None,
        "avg_ccv": ccv_prev["avg"],
        "weverse_members": wv_prev["members"] if wv_prev else None,
        "weverse_membership": wv_prev["membership"] if wv_prev else None,
    }
    judgments = kpi_judgments(month, actuals)

    # 이벤트(월내 + 익월) — 공개 확정(high/medium)만. 투자사판 게이트 G4 는
    # 렌더에서 confidence·미공개 처리.
    _, end = month_bounds(month)
    events = client.execute(
        "SELECT event_date, event_type, title, confidence FROM group_events "
        "WHERE group_key=? AND event_date >= ? AND event_date < date(?, '+32 days') "
        "ORDER BY event_date ASC",
        [TARGET, f"{month}-01", end[:10]])

    subs_series = _daily_series(client, [prev_month(pm), pm, month])
    month_series = [r for r in subs_series if r["day"].startswith(month)]
    daily_gains = [
        (b["day"], (b["subs"] or 0) - (a["subs"] or 0))
        for a, b in zip(month_series, month_series[1:])
    ]
    spike = spike_note(daily_gains, [e for e in events
                                     if e["event_date"].startswith(month)])

    tier_now = _tier_row(client, month)
    tier_prev = _tier_row(client, pm)
    quad_now = _quadrant(client, month)
    quad_prev = _quadrant(client, pm)
    cohort = _cohort(client, month)
    cohort_prev = _cohort(client, pm)
    mine_now = next((r for r in cohort["rows"] if r["group"] == TARGET), None)
    mine_prev = next((r for r in cohort_prev["rows"] if r["group"] == TARGET), None)

    # 오디언스(월말 OAuth 스냅샷)
    demo_snap = _latest_before(client, "agg_youtube_analytics_demographics", month)
    demographics = client.execute(
        "SELECT age_group, gender, viewer_pct FROM agg_youtube_analytics_demographics "
        "WHERE group_key=? AND snapshot_at=?",
        [TARGET, demo_snap]) if demo_snap else []
    ctry_snap = _latest_before(client, "agg_youtube_analytics_country", month)
    countries = client.execute(
        "SELECT country, watch_share FROM agg_youtube_analytics_country "
        "WHERE group_key=? AND snapshot_at=? ORDER BY watch_share DESC LIMIT 8",
        [TARGET, ctry_snap]) if ctry_snap else []

    # 리스크(내부 A1): 월내 alerts + 논란 수
    alerts = client.execute(
        "SELECT rule, severity, title, fired_at FROM alerts "
        "WHERE scope=? AND fired_at >= ? AND fired_at < ? ORDER BY fired_at",
        [TARGET, f"{month}-01", end])
    # 내부 A2: 월내 final 인사이트 큐레이션(저장분 인용 — 신규 LLM 없음)
    insights = client.execute(
        "SELECT week_start, title, ai_comment FROM insights "
        "WHERE (scope=? OR type='ipx_action') AND ai_comment IS NOT NULL "
        "AND week_start >= ? AND week_start < ? "
        "AND COALESCE(report_kind,'final')='final' "
        "ORDER BY week_start DESC LIMIT 3",
        [TARGET, f"{month}-01", end[:10]])

    # 자연 유입 점수(팬덤 질) — 생성 시점 기준 참고 타일
    org = client.execute(
        "SELECT score FROM agg_fan_loyalty WHERE group_key=? LIMIT 1", [TARGET])

    news_delta = None
    if eom and eom_prev and eom.get("naver_total_news") is not None \
            and eom_prev.get("naver_total_news") is not None:
        news_delta = eom["naver_total_news"] - eom_prev["naver_total_news"]

    return {
        "month": month,
        "prev_month": pm,
        "warnings": warnings,
        "kpi": {"actuals": actuals, "prev": prev_actuals,
                "judgments": judgments, "headline": kpi_headline(judgments)},
        "subs_series": subs_series,
        "subs_gain": ((actuals["subscribers"] or 0)
                      - (prev_actuals["subscribers"] or 0))
        if actuals["subscribers"] and prev_actuals["subscribers"] else None,
        "spike_note": spike,
        "ccv": ccv, "ccv_prev": ccv_prev,
        "weverse": wv, "weverse_prev": wv_prev,
        "weverse_series": _weverse_series(client, month),
        "tier": tier_now, "tier_prev": tier_prev,
        "tier_line": tier_line(
            tier_prev["tier"] if tier_prev else None,
            tier_now["tier"] if tier_now else None,
            tier_now["flow_rank"] if tier_now else None,
            tier_now["team_count"] if tier_now else None),
        "quadrant": quad_now,
        "quadrant_move": quadrant_move_line(
            quad_prev["mine_quadrant"] if quad_prev else None,
            quad_now["mine_quadrant"] if quad_now else None,
            {"strong": "진성 강세", "niche": "니치 충성",
             "ad_driven": "광고형", "low": "축적 단계"}),
        "cohort": cohort,
        "cohort_line": cohort_rank_line(
            mine_now["rank"] if mine_now else None,
            mine_prev["rank"] if mine_prev else None,
            len(cohort["rows"]),
            mine_now["multiple"] if mine_now else None,
            mine_prev["multiple"] if mine_prev else None),
        "demographics": demographics,
        "countries": countries,
        "alerts": alerts,
        "insights": insights,
        "org_score": org[0]["score"] if org else None,
        "news_delta": news_delta,
        "controversy": eom.get("controversy_count") if eom else None,
        "events": events,
    }
