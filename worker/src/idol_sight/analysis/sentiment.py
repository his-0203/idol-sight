"""Sentiment polarity classifier — Gemini-driven.

Each community post title gets bucketed into one of four polarity
classes. The classifier is intentionally cheap: title-only (no body),
batched up to ``BATCH`` titles per LLM call, and capped at ``LIMIT``
unclassified posts per group per run. Output is a list of D1 UPDATE
statements the caller batches alongside the rest of the analyse cycle.

Why title-only: we run this weekly across 8 groups × ~few-hundred
posts. Adding bodies would multiply tokens by 10-50× without a
proportional accuracy gain — title alone catches "논란"/"의혹"/"!" type
markers, which is what the BI cares about for triage.

Buckets
- positive    fan support, compliment, hype
- negative    criticism, complaint
- controversy 논란/scandal/leak — escalates risk_score downstream
- neutral     news, info, schedule
"""

from __future__ import annotations

import logging
from typing import Any, Protocol

log = logging.getLogger(__name__)

LIMIT_PER_GROUP = 200       # max unclassified rows per call
BATCH = 50                  # titles per LLM request

# JSON schema enforced via Gemini structured output.
SENTIMENT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "classifications": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "url_hash": {"type": "string"},
                    "sentiment": {
                        "type": "string",
                        "enum": ["positive", "negative",
                                 "controversy", "neutral"],
                    },
                },
                "required": ["url_hash", "sentiment"],
            },
        },
    },
    "required": ["classifications"],
}

PROMPT_SENTIMENT = """\
You are classifying Korean K-pop community post TITLES by sentiment
toward the named idol group. The titles come from DCInside, TheQoo,
and Instiz — sites where fans freely express opinion, including
slang, sarcasm, and abbreviations.

For each title classify into exactly one of:
  - positive    — clear fan support, compliment, hype, celebration
  - negative    — clear criticism, complaint, dissatisfaction
  - controversy — 논란, scandal, leak, 의혹, 사건, 폭로
  - neutral     — news, info, schedule, factual update

Rules:
  - Titles in Korean OR mixed Korean/English. Slang and abbreviations
    are fine — judge by the most likely fan reading.
  - When ambiguous, prefer 'neutral' over guessing.
  - 'controversy' is a STRONG label — only use it when there is a
    clear scandal/issue marker, not for ordinary criticism.
  - Output ONE classification per input post; preserve the url_hash
    EXACTLY as given (do not invent or modify).
"""


class _Executor(Protocol):
    def execute(
        self, sql: str, params: list[Any] | None = ...,
    ) -> list[dict[str, Any]]: ...


class _Gemini(Protocol):
    def generate(
        self, *, system_prompt: str, context: dict[str, Any],
        response_schema: dict[str, Any],
    ) -> dict[str, Any]: ...


def classify_for_group(
    client: _Executor,
    gemini: _Gemini,
    *,
    group_key: str,
    group_name_kr: str,
    limit: int = LIMIT_PER_GROUP,
) -> list[tuple[str, list[Any]]]:
    """Pull unclassified community_posts for the group, run Gemini in
    batches, return UPDATE statements. We cap at ``limit`` to bound
    token spend per group per run.
    """
    rows = client.execute(
        "SELECT url_hash, title FROM community_posts "
        "WHERE group_key=? AND sentiment IS NULL "
        "  AND title IS NOT NULL AND length(title) > 0 "
        "ORDER BY collected_at DESC LIMIT ?",
        [group_key, limit],
    )
    if not rows:
        return []

    statements: list[tuple[str, list[Any]]] = []
    for i in range(0, len(rows), BATCH):
        chunk = rows[i:i + BATCH]
        try:
            classifications = _call_gemini(gemini, group_name_kr, chunk)
        except Exception as e:  # noqa: BLE001
            log.warning("sentiment batch failed for %s [%d..%d]: %s",
                        group_key, i, i + len(chunk), e)
            continue
        # Index returned classifications by url_hash so we can match
        # cleanly even if the LLM reorders or drops items.
        by_hash = {c["url_hash"]: c["sentiment"] for c in classifications
                   if isinstance(c, dict) and c.get("sentiment")}
        for r in chunk:
            sentiment = by_hash.get(r["url_hash"])
            if sentiment is None:
                continue
            statements.append((
                "UPDATE community_posts SET sentiment=? WHERE url_hash=?",
                [sentiment, r["url_hash"]],
            ))
    return statements


def _call_gemini(
    gemini: _Gemini, group_name_kr: str, chunk: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    context = {
        "group": group_name_kr,
        "posts": [
            {"url_hash": r["url_hash"], "title": (r["title"] or "")[:200]}
            for r in chunk
        ],
    }
    parsed = gemini.generate(
        system_prompt=PROMPT_SENTIMENT,
        context=context,
        response_schema=SENTIMENT_SCHEMA,
    )
    items = parsed.get("classifications") or []
    return items if isinstance(items, list) else []


def update_negative_ratio_statements(
    client: _Executor, *, snapshot_at: str,
) -> list[tuple[str, list[Any]]]:
    """Compute (negative + controversy) / classified-only and write it
    onto agg_summary for the given snapshot. Skips groups with zero
    classified posts (negative_ratio stays at its DEFAULT 0).
    """
    rows = client.execute(
        "SELECT group_key, "
        "  SUM(CASE WHEN sentiment IN ('negative','controversy') THEN 1 ELSE 0 END) AS neg, "
        "  SUM(CASE WHEN sentiment IS NOT NULL THEN 1 ELSE 0 END) AS classified "
        "FROM community_posts GROUP BY group_key"
    )
    out: list[tuple[str, list[Any]]] = []
    for r in rows:
        classified = r.get("classified") or 0
        if classified <= 0:
            continue
        ratio = (r.get("neg") or 0) / classified
        out.append((
            "UPDATE agg_summary SET negative_ratio=? "
            "WHERE group_key=? AND snapshot_at=?",
            [round(ratio, 4), r["group_key"], snapshot_at],
        ))
    return out


__all__ = [
    "PROMPT_SENTIMENT",
    "SENTIMENT_SCHEMA",
    "classify_for_group",
    "update_negative_ratio_statements",
]
