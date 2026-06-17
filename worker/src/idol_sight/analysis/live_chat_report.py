"""라이브 채팅 리포트 빌더 — raw 채팅을 표본화해 Gemini 1회 호출로
대표 긍/부정 멘트 + 비율 추정 + 핵심 테마를 추출, live_chat_reports
INSERT statement 를 반환한다. sentiment.py 의 _Gemini DI 패턴을 따른다.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Protocol

log = logging.getLogger(__name__)

SAMPLE = 500          # LLM 에 넣을 최대 표본 수
MIN_LEN = 2           # 이보다 짧은 메시지(ㅋ, ! 등)는 노이즈로 제외

_REPEAT_RE = re.compile(r"(.)\1{4,}")   # 5자 이상 반복(도배) 감지


class _Gemini(Protocol):
    def generate(
        self, *, system_prompt: str, context: dict[str, Any],
        response_schema: dict[str, Any],
    ) -> dict[str, Any]: ...


REPORT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "positive_ratio": {"type": "number"},
        "negative_ratio": {"type": "number"},
        "positive_quotes": {"type": "array", "items": {"type": "object", "properties": {
            "quote": {"type": "string"}, "note": {"type": "string"}}, "required": ["quote"]}},
        "negative_quotes": {"type": "array", "items": {"type": "object", "properties": {
            "quote": {"type": "string"}, "note": {"type": "string"}}, "required": ["quote"]}},
        "positive_idx": {"type": "array", "items": {"type": "integer"}},
        "negative_idx": {"type": "array", "items": {"type": "integer"}},
        "themes": {"type": "array", "items": {"type": "object", "properties": {
            "label": {"type": "string"}, "polarity": {"type": "string"}},
            "required": ["label", "polarity"]}},
        "summary": {"type": "string"},
    },
    "required": ["positive_ratio", "negative_ratio",
                 "positive_quotes", "negative_quotes", "summary"],
}

PROMPT = """\
You are analysing the live-chat of a Korean K-pop group's YouTube live
broadcast. Messages are casual fan chat — slang, abbreviations, emoji,
and spam/repeats are common.

From the SAMPLE of chat messages, produce:
  - positive_ratio / negative_ratio: your best estimate of the share of
    the chat that is clearly positive vs clearly negative, as fractions
    of 0..1 (the rest is neutral/noise; the two need not sum to 1).
  - positive_quotes / negative_quotes: the 3-5 MOST representative real
    messages for each side. Quote them VERBATIM from the sample; do not
    invent or paraphrase.
  - positive_idx / negative_idx: classify EVERY clearly-positive and
    clearly-negative message by its 0-based position in the SAMPLE
    `messages` array. Return only the indices (integers), not the text.
    Put each index in at most one list; leave neutral/ambiguous ones out.
  - themes: a few recurring topics, each tagged polarity
    positive|negative|neutral.
  - summary: one or two Korean sentences capturing the overall reaction.

Judge by the most likely fan reading. When ambiguous, treat as neutral
(exclude from both ratios)."""


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "")).strip()


def _resolve_idx(idx: Any, texts: list[str]) -> list[str]:
    """LLM 이 준 표본 인덱스를 원문(verbatim)으로 해석. 범위 밖·비정수는 무시, 입력 순서 보존."""
    if not isinstance(idx, list):
        return []
    out: list[str] = []
    for i in idx:
        if isinstance(i, bool) or not isinstance(i, int):
            continue
        if 0 <= i < len(texts):
            out.append(texts[i])
    return out


def _sample(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """중복(정규화 기준)·도배·너무 짧은 메시지 제거 후, 시간순 균등 stride 로 SAMPLE 캡."""
    seen: set[str] = set()
    cleaned: list[dict[str, Any]] = []
    for m in messages:
        norm = _normalize(m.get("message", ""))
        if len(norm) < MIN_LEN or _REPEAT_RE.search(norm):
            continue
        if norm in seen:
            continue
        seen.add(norm)
        cleaned.append(m)
    if len(cleaned) <= SAMPLE:
        return cleaned
    step = len(cleaned) / SAMPLE
    return [cleaned[int(i * step)] for i in range(SAMPLE)]


def build_report(
    gemini: _Gemini,
    *,
    video_id: str,
    group_key: str,
    group_name_kr: str,
    title: str | None,
    ended_at: str | None,
    messages: list[dict[str, Any]],
    now_iso: str,
) -> tuple[str, list[Any]] | None:
    """표본 → Gemini 추출 → live_chat_reports UPSERT statement. 메시지 없으면 None."""
    if not messages:
        return None
    sample = _sample(messages)
    if not sample:
        return None
    context = {
        "group": group_name_kr,
        "messages": [_normalize(m.get("message", "")) for m in sample],
    }
    parsed = gemini.generate(
        system_prompt=PROMPT, context=context, response_schema=REPORT_SCHEMA)
    texts = context["messages"]
    report = {
        "positive": parsed.get("positive_quotes") or [],
        "negative": parsed.get("negative_quotes") or [],
        "positive_all": _resolve_idx(parsed.get("positive_idx"), texts),
        "negative_all": _resolve_idx(parsed.get("negative_idx"), texts),
        "themes": parsed.get("themes") or [],
        "summary": parsed.get("summary") or "",
    }
    sql = (
        "INSERT INTO live_chat_reports "
        "(video_id, group_key, title, ended_at, generated_at, total_messages, "
        " sampled, positive_ratio, negative_ratio, report_json) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(video_id) DO UPDATE SET "
        "generated_at=excluded.generated_at, total_messages=excluded.total_messages, "
        "sampled=excluded.sampled, positive_ratio=excluded.positive_ratio, "
        "negative_ratio=excluded.negative_ratio, report_json=excluded.report_json"
    )
    params = [
        video_id, group_key, title, ended_at, now_iso,
        len(messages), len(sample),
        _as_ratio(parsed.get("positive_ratio")),
        _as_ratio(parsed.get("negative_ratio")),
        json.dumps(report, ensure_ascii=False),
    ]
    return (sql, params)


def _as_ratio(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return round(max(0.0, min(1.0, f)), 4)


__all__ = ["build_report", "REPORT_SCHEMA", "PROMPT", "SAMPLE"]
