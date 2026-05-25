"""Generate weekly LLM insights and convert to D1 INSERT statements."""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
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


def build_context(db: _Executor, *, week_start: str, week_end: str) -> dict[str, Any]:
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
    # 카드를 작성할 때 참조한다. compute_group_signals 가 내부적으로 10개의
    # 추가 쿼리를 실행한다 (총 build_context 쿼리 수 = 5 + 10 = 15).
    signals_by_group = compute_group_signals(
        db=db, week_start=week_start, week_end=week_end,
    )
    return {
        "week": {"start": week_start, "end": week_end},
        "agg_summary_last_7d": last_7d,
        "agg_summary_prev_7d": prev_7d,
        "hanteo": hanteo,
        "market_share": market,
        "top_news_by_group": top_news,
        "signals_by_group": _serialize_signals_for_llm(signals_by_group),
    }


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
    from datetime import date, timedelta
    d = date.fromisoformat(iso_date)
    return (d + timedelta(days=days)).isoformat()


def generate_weekly(
    *,
    db: _Executor,
    gemini: _Gemini,
    week_start: str,
    week_end: str,
) -> CollectionResult:
    ctx = build_context(db, week_start=week_start, week_end=week_end)
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
    signals_by_group: dict[str, dict] = ctx.get("signals_by_group", {}) or {}

    now_iso = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    statements: list[tuple[str, list]] = []
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
        # scope 가 signals_by_group 에 없거나 hypotheses 가 비어있으면 NULL.
        signals_json: str | None = None
        if item.get("type") == "diagnosis":
            scope = item.get("scope") or "market"
            gs = signals_by_group.get(scope)
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
               source_refs_json, ai_comment, signals_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            ],
        ))

    return CollectionResult(
        rows_inserted=len(items), rows_updated=0,
        statements=statements,
    )
