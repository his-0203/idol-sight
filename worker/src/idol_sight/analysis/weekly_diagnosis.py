"""Causal Diagnosis 오케스트레이션.

`weekly_diagnosis_signals` 의 raw 시그널 → 11개 가설 카탈로그 →
confidence → 메타가드 적용 → `GroupSignals` dataclass.

이 모듈은 DB 접근 추상화 (`_Executor` Protocol) 를 통해 raw row 만
의존한다. `compute_group_signals(db, week_start, week_end)` 가 진입점.

가설 카탈로그: spec 2026-05-25-causal-diagnosis-design.md rev 2 §3.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


HYPOTHESIS_KEYS: tuple[str, ...] = (
    "organic_growth",
    "paid_youtube_ads",
    "subscriber_purchase",
    "comeback_cycle",
    "broadcast_appearance",
    "community_word_of_mouth",
    "controversy_spike",
    "platform_concentrated_promo",
    "member_centric_spike",
    "insufficient_signal",
)

CONFIDENCE_LEVELS: tuple[str, ...] = ("high", "medium", "low")


@dataclass
class Evidence:
    key: str
    value: Any
    label: str


@dataclass
class Hypothesis:
    key: str
    confidence: str            # 'high' | 'medium' | 'low'
    evidence: list[Evidence] = field(default_factory=list)


@dataclass
class GroupSignals:
    group_key: str
    hypotheses: list[Hypothesis] = field(default_factory=list)
    meta_guards: list[str] = field(default_factory=list)
    deltas: dict[str, float] = field(default_factory=dict)
    organicity: dict[str, Any] | None = None


class _Executor(Protocol):
    def execute(self, sql: str, params: list | None = ...) -> list[dict]: ...
