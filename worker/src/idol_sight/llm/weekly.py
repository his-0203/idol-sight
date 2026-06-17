"""Generate weekly LLM insights and convert to D1 INSERT statements."""

from __future__ import annotations

import json
import logging
from datetime import UTC, date, datetime, timedelta
from typing import Any, Protocol

from idol_sight.analysis.weekly_diagnosis import (
    GroupSignals,
    compute_group_signals,
)
from idol_sight.collectors.base import CollectionResult
from idol_sight.llm.gemini import INSIGHT_OUTPUT_SCHEMA
from idol_sight.llm.prompts import PROMPT_WEEKLY

log = logging.getLogger(__name__)


class _Executor(Protocol):
    def execute(self, sql: str, params: list | None = ...) -> list[dict]: ...


class _Gemini(Protocol):
    def generate(self, *, system_prompt: str, context: dict, response_schema: dict) -> dict: ...


def build_context(
    db: _Executor,
    *,
    week_start: str,
    week_end: str,
    signals_by_group: dict[str, GroupSignals] | None = None,
    report_kind: str = "final",
) -> dict[str, Any]:
    """Weekly LLM 컨텍스트 빌더.

    signals_by_group:
      None 이면 (legacy 호출 경로) 이 함수 안에서 compute_group_signals 를
      호출 — 기존 동작 유지. cli.py 처럼 phase 를 분리한 호출자는 미리
      compute_group_signals 결과를 만들어 주입할 수 있다. 이 경우 step
      logging / latency 측정이 cli 단계에서 명확해진다.
    """
    last_7d = db.execute(
        "SELECT * FROM agg_summary WHERE substr(snapshot_at, 1, 10) BETWEEN ? AND ?",
        [week_start, week_end],
    )
    prev_start = _shift_iso_date(week_start, -7)
    prev_end = _shift_iso_date(week_end, -7)
    prev_7d = db.execute(
        "SELECT * FROM agg_summary WHERE substr(snapshot_at, 1, 10) BETWEEN ? AND ?",
        [prev_start, prev_end],
    )
    hanteo = db.execute(
        "SELECT week_start, week_end, group_key, album, rank, sales "
        "FROM hanteo_weekly WHERE week_end = ?",
        [week_end],
    )
    market = db.execute(
        "SELECT week_start, week_end, group_key, cum, mom, final "
        "FROM agg_market_share WHERE week_end = ?",
        [week_end],
    )
    top_news = db.execute(
        "SELECT group_key, title, source, published_at FROM naver_articles "
        "WHERE COALESCE(is_excluded,0)=0 "
        "  AND substr(published_at, 1, 10) BETWEEN ? AND ? "
        "ORDER BY published_at DESC LIMIT 40",
        [week_start, week_end],
    )
    # spec rev 2 Task 5: causal-diagnosis signals 동봉 — LLM 이 type='diagnosis'
    # 카드를 작성할 때 참조한다. signals_by_group 가 None 이면 여기서 직접
    # 호출 (legacy), 아니면 주입된 값 사용 (cli phase 분리).
    if signals_by_group is None:
        signals_by_group = compute_group_signals(
            db=db, week_start=week_start, week_end=week_end,
        )
    # production debug: workflow stdout 에 시그널 점등 통계 출력 —
    # type='diagnosis' 카드가 0개일 때 시그널 부족인지 LLM 무시인지 변별.
    _lit = {gk: len(gs.hypotheses) for gk, gs in signals_by_group.items()}
    _total_lit = sum(_lit.values())
    log.info(
        "causal_diagnosis: groups=%d hypotheses_lit=%d per_group=%s",
        len(signals_by_group), _total_lit, _lit,
    )
    # 데뷔 D-N ground-truth: LLM 이 데뷔일/카운트다운을 환각하지 않도록
    # groups.debut_date 를 생성 시각(KST) 기준 D-N label 로 변환해 주입한다.
    # (debut_countdown 가드는 prompts.py PROMPT_WEEKLY 참조.) "오늘"은
    # forward-looking ipx_action("오늘부터 D-N")에 맞춰 분석 주가 아닌
    # 생성 시각 기준.
    debut_rows = db.execute(
        "SELECT key, debut_date FROM groups "
        "WHERE debut_date IS NOT NULL AND is_active=1"
    )
    today_kst = (datetime.now(UTC) + timedelta(hours=9)).date()
    debut_countdown = _debut_countdown(debut_rows, today_kst)
    # 미완소년 소유자 OAuth(YouTube Analytics) 데이터 — 매일 갱신되는 30일
    # 롤링 국가 지표. 인사이트 LLM 이 해외 시청·유지율·오가닉·구독전환을
    # 근거로 ipx_action/insight 를 쓸 수 있게 ground-truth 로 주입한다.
    # (debut_countdown 과 같은 사전 가공 패턴 — raw 숫자 환각 차단.) miiwan
    # 전용이라 다른 그룹엔 행이 없고, 데이터 없으면 키 자체가 빠진다.
    owner_youtube = _fetch_owner_youtube(db, today_kst)
    ctx: dict[str, Any] = {
        "week": {"start": week_start, "end": week_end},
        "report_kind": report_kind,
        "debut_countdown": debut_countdown,
        "agg_summary_last_7d": last_7d,
        "agg_summary_prev_7d": prev_7d,
        "hanteo": hanteo,
        "market_share": market,
        "top_news_by_group": top_news,
        "signals_by_group": _serialize_signals_for_llm(signals_by_group),
    }
    if owner_youtube:
        ctx["miiwan_youtube"] = owner_youtube
    return ctx


def _serialize_signals_for_llm(
    signals: dict[str, GroupSignals],
) -> dict[str, dict]:
    """GroupSignals dataclass → LLM-friendly JSON-safe dict.

    LLM 은 hypotheses 리스트와 meta_guards 리스트만 읽어 type='diagnosis'
    카드 작성에 사용한다. generate_weekly 의 signals_json INSERT 경로도
    이 dict 형태를 그대로 사용한다 (Hypothesis/Evidence 의 직접 attribute
    접근을 줄여 일관성 유지).
    """
    out: dict[str, dict] = {}
    for gk, gs in signals.items():
        out[gk] = {
            "hypotheses": [
                {
                    "key": h.key,
                    "confidence": h.confidence,
                    "evidence": [
                        {"key": e.key, "value": e.value, "label": e.label}
                        for e in h.evidence
                    ],
                }
                for h in gs.hypotheses
            ],
            "meta_guards": list(gs.meta_guards),
            "deltas": dict(gs.deltas),
            "organicity": gs.organicity,
        }
    return out


def _shift_iso_date(iso_date: str, days: int) -> str:
    d = date.fromisoformat(iso_date)
    return (d + timedelta(days=days)).isoformat()


def _debut_countdown(rows: list[dict], today: date) -> dict[str, dict]:
    """groups 행 [{key, debut_date}] → {key: {debut_date, days_to_debut, label}}.

    label: 데뷔 전(days>0)=D-{n}, 당일(0)=D-DAY, 데뷔 후(days<0)=D+{n}.
    debut_date 가 비어있는 행은 제외한다. LLM 이 데뷔 D-N·데뷔일을
    추정하지 않도록 ground-truth 를 컨텍스트로 넘기기 위한 변환.
    """
    out: dict[str, dict] = {}
    for r in rows:
        ds = r.get("debut_date")
        if not ds:
            continue
        days = (date.fromisoformat(ds) - today).days
        if days > 0:
            label = f"D-{days}"
        elif days == 0:
            label = "D-DAY"
        else:
            label = f"D+{abs(days)}"
        out[r["key"]] = {"debut_date": ds, "days_to_debut": days, "label": label}
    return out


# 소유자 YouTube 데이터 주입 파라미터. 데뷔 초기 소표본·롤링 노이즈 가드.
OWNER_YT_TOP_N = 8            # watch_share 상위 N개국만 (토큰 절약 + 롱테일 노이즈 차단)
OWNER_YT_STALE_DAYS = 7       # 최신 스냅샷이 이보다 오래되면 제외 (수집 중단 환각 방지)
OWNER_YT_MIN_WATCH_MINUTES = 60  # 절대 시청분 미만이면 소표본 플래그 (비율 폭증 차단)


def _growth_label(v: float | None) -> str:
    """growth_mom(소수) → 사람이 읽는 라벨. None=신규 진입(분모≈0, 측정 보류).

    데뷔 직후 신규국은 직전 30일 시청이 미미해 비율이 폭발하므로 collector 가
    None 으로 둔다 (youtube_analytics.py). 그 의미를 LLM 에 명시적으로 넘겨
    '0% 성장'으로 오독하지 않게 한다.
    """
    if v is None:
        return "신규(측정 보류)"
    pct = round(v * 100)
    return f"{'+' if pct >= 0 else '−'}{abs(pct)}%"


def _format_owner_youtube(
    rows: list[dict],
    today: date,
    *,
    top_n: int = OWNER_YT_TOP_N,
    stale_days: int = OWNER_YT_STALE_DAYS,
    min_watch_minutes: int = OWNER_YT_MIN_WATCH_MINUTES,
) -> dict | None:
    """agg_youtube_analytics_country 최신 스냅샷 행 → LLM ground-truth dict.

    raw 숫자를 그대로 넘기지 않고 사전 가공한다 (debut_countdown 패턴):
      - watch_share → 퍼센트, growth_mom → 라벨(None=신규 표기),
      - watch_minutes < min_watch_minutes 인 국가는 low_sample=True 플래그
        (비율 지표를 추세로 단정하지 못하게),
      - 최신 스냅샷이 stale_days 보다 오래되면 통째로 None (수집 중단 시
        옛 데이터를 '이번 주'로 환각하는 것 방지).
    데이터가 없거나 stale 이면 None — 호출부는 컨텍스트 키를 생략한다.
    """
    if not rows:
        return None
    snapshot_at = rows[0].get("snapshot_at")
    age_days: int | None = None
    if snapshot_at:
        snap_date = date.fromisoformat(snapshot_at[:10])
        age_days = (today - snap_date).days
        if age_days > stale_days:
            return None
    ranked = sorted(
        rows, key=lambda r: (r.get("watch_share") or 0.0), reverse=True,
    )[:top_n]
    countries: list[dict] = []
    for r in ranked:
        country = r.get("country")
        if not country:
            continue
        wm = r.get("watch_minutes")
        countries.append({
            "country": country,
            "watch_share_pct": round((r.get("watch_share") or 0.0) * 100, 1),
            "watch_minutes": wm,
            "retention_rel": (round(r["retention_rel"], 2)
                              if r.get("retention_rel") is not None else None),
            "organic_share_pct": (round(r["organic_share"] * 100)
                                  if r.get("organic_share") is not None else None),
            "sub_per_1k": (round(r["sub_per_1k"], 1)
                           if r.get("sub_per_1k") is not None else None),
            "growth_label": _growth_label(r.get("growth_mom")),
            "subs_gained": r.get("subs_gained"),
            "low_sample": (wm is not None and wm < min_watch_minutes),
        })
    if not countries:
        return None
    return {
        "window": "최근 30일 롤링 누적 (소유자 YouTube Analytics, 매일 갱신 — "
                  "주간 일~토/일~수 윈도우와 다른 시간축)",
        "snapshot_at": snapshot_at,
        "age_days": age_days,
        "note": "watch_share 는 해외 국가 간 상대 비중(합≈100%). 경쟁사는 "
                "OAuth 가 없어 이 데이터가 없으니 국가별 비교는 미완소년 "
                "자기 시계열로만. low_sample=true 국가는 표본 부족 — 추세 "
                "단정 금지.",
        "countries": countries,
    }


def _format_owner_audience(
    channel_row: dict | None,
    demo_rows: list[dict],
    *,
    top_n: int = 6,
) -> dict | None:
    """시청자 구성(migration 0091) → LLM dict.

    - 구독/비구독 시청 비중 (returning 시청자 대체재): 코어 팬 vs 신규 유입.
    - 연령×성별 상위 분포: 굿즈·타겟 코어팬 결정 입력.
    둘 다 없으면 None.
    """
    out: dict = {}
    if channel_row and channel_row.get("subscribed_watch_share") is not None:
        out["subscribed_watch_share_pct"] = round(
            channel_row["subscribed_watch_share"] * 100)
        unsub = channel_row.get("unsubscribed_watch_share")
        if unsub is not None:
            out["unsubscribed_watch_share_pct"] = round(unsub * 100)
    if demo_rows:
        ranked = sorted(
            demo_rows, key=lambda r: (r.get("viewer_pct") or 0.0), reverse=True,
        )[:top_n]
        top = [
            {"age_group": r.get("age_group"), "gender": r.get("gender"),
             "viewer_pct": round(r.get("viewer_pct") or 0.0, 1)}
            for r in ranked if r.get("age_group") and r.get("gender")
        ]
        if top:
            out["top_demographics"] = top
    return out or None


def _fetch_owner_audience(db: _Executor) -> dict | None:
    """최신 채널 구독 분리 + 인구통계 조회 → _format_owner_audience.

    migration 0091 미적용 시 컬럼/테이블이 없어 throw 할 수 있으므로 호출부
    (_fetch_owner_youtube) 가 try/except 로 graceful degrade 한다.
    """
    channel = db.execute(
        "SELECT subscribed_watch_share, unsubscribed_watch_share, snapshot_at "
        "FROM agg_youtube_analytics WHERE group_key='miiwan' "
        "ORDER BY snapshot_at DESC LIMIT 1",
        [],
    )
    demo = db.execute(
        "SELECT age_group, gender, viewer_pct "
        "FROM agg_youtube_analytics_demographics "
        "WHERE group_key='miiwan' "
        "  AND snapshot_at=(SELECT MAX(snapshot_at) "
        "                   FROM agg_youtube_analytics_demographics "
        "                   WHERE group_key='miiwan') "
        "ORDER BY viewer_pct DESC",
        [],
    )
    return _format_owner_audience(channel[0] if channel else None, demo)


def _fetch_owner_youtube(db: _Executor, today: date) -> dict | None:
    """미완소년 최신 스냅샷 국가 지표 조회 후 _format_owner_youtube 로 가공.

    국가 데이터가 있으면 시청자 구성(audience: 구독분리·인구통계)도 덧붙인다.
    """
    rows = db.execute(
        "SELECT country, watch_share, growth_mom, retention_rel, sub_per_1k, "
        "       watch_minutes, organic_share, subs_gained, snapshot_at "
        "FROM agg_youtube_analytics_country "
        "WHERE group_key='miiwan' "
        "  AND snapshot_at=(SELECT MAX(snapshot_at) "
        "                   FROM agg_youtube_analytics_country "
        "                   WHERE group_key='miiwan') "
        "ORDER BY watch_share DESC",
        [],
    )
    owner = _format_owner_youtube(rows, today)
    if owner is None:
        return None
    try:
        audience = _fetch_owner_audience(db)
    except Exception as exc:  # noqa: BLE001 — 0091 미적용 시 graceful degrade.
        log.info("owner audience skip (migration 0091?): %s", exc)
        audience = None
    if audience:
        owner["audience"] = audience
    return owner


def generate_weekly(
    *,
    db: _Executor,
    gemini: _Gemini,
    week_start: str,
    week_end: str,
    signals_by_group: dict[str, GroupSignals] | None = None,
    report_kind: str = "final",
) -> CollectionResult:
    """signals_by_group:
      None 이면 build_context 안에서 compute_group_signals 호출 (기존 동작).
      cli phase 분리 호출자는 미리 만든 signals 를 주입한다."""
    ctx = build_context(
        db,
        week_start=week_start,
        week_end=week_end,
        signals_by_group=signals_by_group,
        report_kind=report_kind,
    )
    parsed = gemini.generate(
        system_prompt=PROMPT_WEEKLY,
        context=ctx,
        response_schema=INSIGHT_OUTPUT_SCHEMA,
    )
    items = parsed.get("items") or []

    # V2.20.1 post-validation guard: ipx_action items MUST have
    # scope='miiwan' (the prompt says so, but Gemini schema has no enum
    # constraint and operators saw a myrakl ipx_action card on
    # 2026-05-07 despite V2.20 prompt hardening). Filter here at the
    # INSERT boundary so a single LLM regression can't repopulate the
    # dashboard with cross-group "action" cards. `insight` and `weekly`
    # types remain free to scope to any group.
    accepted: list[dict] = []
    dropped = 0
    for it in items:
        if (it.get("type") == "ipx_action"
                and (it.get("scope") or "market") != "miiwan"):
            dropped += 1
            continue
        accepted.append(it)
    if dropped:
        log.warning(
            "weekly: dropped %d non-miiwan ipx_action items "
            "(LLM violated scope constraint)", dropped,
        )
    items = accepted

    # spec rev 2 Task 5: type='diagnosis' 카드의 signals_json 직렬화에 사용.
    # (파라미터 signals_by_group[GroupSignals|None] 과 구분 — 여기선 ctx 의 직렬화 dict.)
    signals_for_cards: dict[str, dict] = ctx.get("signals_by_group", {}) or {}

    now_iso = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    # Lead with a per-week DELETE so this is a rebuild, not a blind append:
    # insights has no ON CONFLICT key, so a re-run (manual re-dispatch, or a
    # retry after a partial batch write) would otherwise duplicate the week's
    # cards. batch() preserves statement order, so the DELETE runs before the
    # INSERTs. (Same rebuild pattern as challenge_scan's weekly_challenges.)
    # Guard: only DELETE when there's something to insert, so an empty/failed
    # LLM run doesn't wipe the week's existing insights.
    statements: list[tuple[str, list]] = []
    if items:
        statements.append(
            ("DELETE FROM insights WHERE week_start = ? AND report_kind = ?",
             [week_start, report_kind]),
        )
    for item in items:
        # ai_comment is optional in the schema (migration 0039) and in
        # the LLM response. Empty strings are treated as missing too —
        # Gemini occasionally emits "" instead of dropping the key, and
        # downstream UI checks `i.ai_comment && (...)` so "" would render
        # an empty AI badge. Normalize to NULL.
        raw_ai_comment = item.get("ai_comment")
        ai_comment: str | None = None
        if isinstance(raw_ai_comment, str):
            stripped = raw_ai_comment.strip()
            ai_comment = stripped[:200] if stripped else None

        # signals_json: type='diagnosis' 카드만 GroupSignals payload 를
        # 직렬화. 다른 type (insight / weekly / ipx_action) 은 NULL.
        # scope 가 signals_for_cards 에 없거나 hypotheses 가 비어있으면 NULL.
        signals_json: str | None = None
        if item.get("type") == "diagnosis":
            scope = item.get("scope") or "market"
            gs = signals_for_cards.get(scope)
            if gs and gs.get("hypotheses"):
                hyps = gs["hypotheses"]
                primary = hyps[0]
                alternative = hyps[1] if len(hyps) > 1 else None
                payload = {
                    "hypothesis_primary":     primary["key"],
                    "hypothesis_alternative": alternative["key"] if alternative else None,
                    "confidence":             primary["confidence"],
                    "evidence":               primary["evidence"],
                    "meta_guards":            gs.get("meta_guards", []),
                }
                signals_json = json.dumps(payload, ensure_ascii=False)

        statements.append((
            """
            INSERT INTO insights
              (generated_at, week_start, scope, type, title, body,
               source_refs_json, ai_comment, signals_json, report_kind)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """.strip(),
            [
                now_iso, week_start,
                item.get("scope") or "market",
                item.get("type") or "insight",
                (item.get("title") or "")[:200],
                item.get("body") or "",
                json.dumps(item.get("source_refs") or [], ensure_ascii=False),
                ai_comment,
                signals_json,
                report_kind,
            ],
        ))

    return CollectionResult(
        rows_inserted=len(items), rows_updated=0,
        statements=statements,
    )
