"""Share of Voice computation (spec §7.2 — V2 reformulation).

What used to be called "Market Share" was really *Share of Voice* (SOV)
— the share of the cohort's measured cross-platform attention, not the
share of the actual K-pop market (which has a defined denominator like
Circle Chart). The previous formula summed raw counts across signals
(yt_views + dc_posts + naver*100 …) which let a single 99%-weighted
signal (yt_views) dominate everything; PLAVE's reported 51% was largely
an artifact of that, not a reflection of real attention split.

V2 normalizes each signal independently before mixing them so that no
one source can dominate. Each component is converted to a unit-less
[0, 1] cohort rank (linear-interpolated percentile across the active
groups), then weighted, then re-normalized to a 0–100 share. A signal
whose cohort-wide values are all identical (including the all-zero case)
carries no ranking information, so it contributes nothing and the
remaining weights are re-normalized over the signals that are actually
available — it does NOT inject a uniform 0.5 constant that would flatten
the distribution toward uniform. Cumulative and momentum components stay
separate so the BI can show both "long-term standing" and "this-week
motion".

Input shape (per group):
  - yt_views, comm_total, news, subscribers (cumulative window)
  - delta_yt_views, delta_comm, delta_news (this-week motion)

Weights (sum = 1.0):
  yt_views 33%, comm 28%, news 22%, subscribers 17%

Output dataclass field names stay ``cum``/``mom``/``final`` so
downstream code (agg_market_share table, frontend) keeps working —
``ShareRow`` is now interpreted as SOV rather than market share.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

ALPHA_CUM = 0.6
BETA_MOM = 0.4

# Cohort-relative weights for the SOV mix. They must sum to 1.0.
# Twitter was dropped from the formula (collection is permanently dead);
# its old 0.10 weight is redistributed proportionally across the four
# surviving signals.
SOV_WEIGHTS = {
    "yt_views":    0.33,
    "community":   0.28,
    "news":        0.22,
    "subscribers": 0.17,
}
assert abs(sum(SOV_WEIGHTS.values()) - 1.0) < 1e-9


def _percentile_rank(values: list[float]) -> list[float | None]:
    """Linear percentile rank in [0, 1] preserving input order.

    Tied values get the average of their ranks. Returns a list aligned to
    ``values``. Empty list → empty list. Single value → [1.0] (it's the
    cohort's only point).

    If every value is identical (this includes the all-zero case — e.g. a
    signal nobody collected this week), the signal carries no ranking
    information: every element is ``None`` so callers can drop it instead
    of injecting a uniform 0.5 constant that would flatten the SOV
    distribution toward uniform.
    """
    n = len(values)
    if n == 0:
        return []
    if n == 1:
        return [1.0]
    if all(v == values[0] for v in values):
        return [None] * n
    indexed = sorted(range(n), key=lambda i: values[i])
    ranks: list[float | None] = [0.0] * n
    i = 0
    while i < n:
        j = i
        while j + 1 < n and values[indexed[j + 1]] == values[indexed[i]]:
            j += 1
        # Average rank for the tie group, normalized so max → 1.0.
        avg_rank = (i + j) / 2.0
        for k in range(i, j + 1):
            ranks[indexed[k]] = avg_rank / (n - 1)
        i = j + 1
    return ranks


def _compose_score(group_ranks: dict[str, float | None]) -> float:
    """Weighted average of the *available* normalized cohort ranks → SOV [0,1].

    A signal whose cohort-wide values are all identical (or all zero)
    yields a ``None`` rank (see ``_percentile_rank``) and is dropped here;
    the remaining weights are re-normalized over the signals that are
    actually present. If no signal is available the score is 0 (no
    constant is injected).
    """
    num = 0.0
    denom = 0.0
    for k, w in SOV_WEIGHTS.items():
        r = group_ranks.get(k)
        if r is None:
            continue
        num += w * r
        denom += w
    return num / denom if denom > 0 else 0.0


@dataclass
class ShareRow:
    week_start: str
    week_end: str
    group_key: str
    cum: float          # cumulative SOV share % (0-100)
    mom: float          # momentum SOV share % (0-100)
    final: float        # weighted final SOV share %


def compute_market_share(
    *,
    week_start: str,
    week_end: str,
    groups: list[dict[str, Any]],
) -> list[ShareRow]:
    """Compute SOV per group from cohort-relative percentile ranks.

    ``groups`` accepts two shapes for backwards compatibility:

    1. New (preferred): each item carries the raw cohort signals
       (yt_views, comm_total, news, subscribers,
       delta_yt_views, delta_comm, delta_news). The function computes
       per-signal percentile ranks across the cohort and mixes them per
       SOV_WEIGHTS.

    2. Legacy: items only carry ``cum_score``/``mom_score`` (single
       numbers). In that case we fall back to the v1 raw-sum
       normalization so existing tests keep passing.
    """
    if not groups:
        return []

    has_signals = any("yt_views" in g for g in groups)
    if has_signals:
        return _compute_sov(week_start, week_end, groups)
    return _compute_legacy(week_start, week_end, groups)


def _compute_sov(
    week_start: str, week_end: str, groups: list[dict[str, Any]],
) -> list[ShareRow]:
    keys = [g["key"] for g in groups]
    # Cumulative ranks
    cum_signal = {
        "yt_views":   [float(g.get("yt_views", 0) or 0) for g in groups],
        "community":  [float(g.get("comm_total", 0) or 0) for g in groups],
        "news":       [float(g.get("news", 0) or 0) for g in groups],
        "subscribers": [float(g.get("subscribers", 0) or 0) for g in groups],
    }
    cum_ranks = {sig: _percentile_rank(vals) for sig, vals in cum_signal.items()}

    # Momentum: delta of the high-volume signals only (yt/community/news).
    # Subscribers don't deliver useful weekly deltas yet — we'd be comparing
    # two snapshots that may both be empty — so it stays all-zero and is
    # dropped automatically by the all-equal → no-contribution rule.
    mom_signal = {
        "yt_views":   [max(float(g.get("delta_yt_views", 0) or 0), 0.0) for g in groups],
        "community":  [max(float(g.get("delta_comm", 0) or 0), 0.0) for g in groups],
        "news":       [max(float(g.get("delta_news", 0) or 0), 0.0) for g in groups],
        "subscribers": [0.0] * len(groups),
    }
    mom_ranks = {sig: _percentile_rank(vals) for sig, vals in mom_signal.items()}

    # Per-group cohort score, then re-normalize to a 0-100 share so the
    # cohort sums to 100% (zero-sum SOV).
    cum_scores = []
    mom_scores = []
    for i, _ in enumerate(keys):
        cum_scores.append(_compose_score({sig: cum_ranks[sig][i] for sig in SOV_WEIGHTS}))
        mom_scores.append(_compose_score({sig: mom_ranks[sig][i] for sig in SOV_WEIGHTS}))

    cum_total = sum(cum_scores) or 0.0
    mom_total = sum(mom_scores) or 0.0

    rows: list[ShareRow] = []
    for i, k in enumerate(keys):
        cum_pct = (cum_scores[i] / cum_total * 100.0) if cum_total > 0 else 0.0
        mom_pct = (mom_scores[i] / mom_total * 100.0) if mom_total > 0 else 0.0
        final = cum_pct * ALPHA_CUM + mom_pct * BETA_MOM
        rows.append(ShareRow(
            week_start=week_start, week_end=week_end, group_key=k,
            cum=round(cum_pct, 2), mom=round(mom_pct, 2),
            final=round(final, 2),
        ))
    return rows


def _compute_legacy(
    week_start: str, week_end: str, groups: list[dict[str, Any]],
) -> list[ShareRow]:
    cum_total = sum(g.get("cum_score", 0) for g in groups) or 0
    mom_total = sum(g.get("mom_score", 0) for g in groups) or 0

    rows: list[ShareRow] = []
    for g in groups:
        cum_pct = (g.get("cum_score", 0) / cum_total * 100.0) if cum_total > 0 else 0.0
        mom_pct = (g.get("mom_score", 0) / mom_total * 100.0) if mom_total > 0 else 0.0
        final = cum_pct * ALPHA_CUM + mom_pct * BETA_MOM
        rows.append(ShareRow(
            week_start=week_start, week_end=week_end,
            group_key=g["key"],
            cum=round(cum_pct, 2), mom=round(mom_pct, 2),
            final=round(final, 2),
        ))
    return rows


# ── v3.1(2026-08): 관심 규모 티어 ────────────────────────────────────────
# SoV final % 는 백분위 합성이라 "점유율" 표현에 부적합(천장 100/(0.5N)·규모
# 압축) — 헤드라인 지위를 은퇴하고, 화면에는 90일 조회 플로우의 log 갭
# 클러스터로 나눈 티어를 보조 표시한다(규칙 공개: 인접 log10 갭 ≥ 0.5
# 데케이드 = 규모 ~3.16배 차이에서 경계, 최대 3티어). % 시계열은 상세
# 화면·시계열 보존용으로 계속 산출한다.
TIER_GAP_DECADES = 0.5
TIER_MAX = 3

TIER_LABELS = {1: "선두 그룹", 2: "추격 그룹", 3: "후발 그룹"}


def compute_tiers(flows: Mapping[str, float]) -> dict[str, int]:
    """그룹별 90d 관심 플로우 → 티어(1=선두). 순수.

    log10(flow+1) 내림차순 정렬 후 인접 갭이 TIER_GAP_DECADES 이상인
    지점마다 티어 +1, TIER_MAX 에서 캡. flow 0(집계 전 포함)은 자연히
    최하위로 정렬된다. 빈 입력 → 빈 dict.
    """
    if not flows:
        return {}
    ordered = sorted(flows.items(), key=lambda kv: -(kv[1] or 0))
    tiers: dict[str, int] = {}
    tier = 1
    prev_log: float | None = None
    for key, flow in ordered:
        cur_log = math.log10((flow or 0) + 1)
        if prev_log is not None and (prev_log - cur_log) >= TIER_GAP_DECADES:
            tier = min(tier + 1, TIER_MAX)
        tiers[key] = tier
        prev_log = cur_log
    return tiers


def to_statements(
    rows: list[ShareRow], *, market_total: int,
    tiers: dict[str, int] | None = None,
    flows: dict[str, int] | None = None,
) -> list[tuple[str, list]]:
    """Convert rows to D1 INSERT statements for agg_market_share.

    v3.1: ``tiers``(group_key → 1..3)가 주어지면 tier·view_flow_90d 컬럼
    포함 확장 INSERT(0115·0116 적용 D1 전용 — 호출부가 컬럼 감지 후 전달).
    ``flows``는 티어 산정 근거인 90일 조회 증분(화면의 정량 앵커).
    None 이면 기존 7컬럼 INSERT(하위호환).
    """
    out: list[tuple[str, list]] = []
    for r in rows:
        if tiers is not None:
            out.append((
                """
                INSERT INTO agg_market_share
                  (week_start, week_end, group_key, cum, mom, final,
                   market_total, tier, view_flow_90d)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(week_start, group_key) DO UPDATE SET
                  week_end=excluded.week_end,
                  cum=excluded.cum, mom=excluded.mom, final=excluded.final,
                  market_total=excluded.market_total, tier=excluded.tier,
                  view_flow_90d=excluded.view_flow_90d
                """.strip(),
                [r.week_start, r.week_end, r.group_key,
                 r.cum, r.mom, r.final, market_total,
                 tiers.get(r.group_key),
                 (flows or {}).get(r.group_key)],
            ))
        else:
            out.append((
                """
                INSERT INTO agg_market_share
                  (week_start, week_end, group_key, cum, mom, final, market_total)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(week_start, group_key) DO UPDATE SET
                  week_end=excluded.week_end,
                  cum=excluded.cum, mom=excluded.mom, final=excluded.final,
                  market_total=excluded.market_total
                """.strip(),
                [r.week_start, r.week_end, r.group_key,
                 r.cum, r.mom, r.final, market_total],
            ))
    return out
