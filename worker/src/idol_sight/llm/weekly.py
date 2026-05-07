"""Generate weekly LLM insights and convert to D1 INSERT statements."""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from typing import Any, Protocol

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
    return {
        "week": {"start": week_start, "end": week_end},
        "agg_summary_last_7d": last_7d,
        "agg_summary_prev_7d": prev_7d,
        "hanteo": hanteo,
        "market_share": market,
        "top_news_by_group": top_news,
    }


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
        statements.append((
            """
            INSERT INTO insights
              (generated_at, week_start, scope, type, title, body, source_refs_json, ai_comment)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """.strip(),
            [
                now_iso, week_start,
                item.get("scope") or "market",
                item.get("type") or "insight",
                (item.get("title") or "")[:200],
                item.get("body") or "",
                json.dumps(item.get("source_refs") or [], ensure_ascii=False),
                ai_comment,
            ],
        ))

    return CollectionResult(
        rows_inserted=len(items), rows_updated=0,
        statements=statements,
    )
