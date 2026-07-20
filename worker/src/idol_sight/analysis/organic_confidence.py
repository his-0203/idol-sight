"""Organic Trust Layer (V2.53) — 그룹별 organicity 신뢰 계수.

debut_window_video_organicity 전 영상 verdict 분포를 0~1 계수 하나로 압축해
인지도(awareness)·추정 코어(core_fan_estimate)가 유료 의심 할인에 쓰는 공용
신호. count 기반 단순 평균(V2.40 원칙, 조회수 가중 금지) + thin-sample
shrinkage(mig 0092 패턴, PRIOR=0.75/K=3). 채점 영상 0 → 1.0(무할인) —
판정 근거 없이 감점하지 않는다. prior 수렴이 아닌 이유: 미채점 그룹 전원이
25% 감점되는 부작용.
"""
from __future__ import annotations

from typing import Any, Protocol

__all__ = [
    "VERDICT_WEIGHTS",
    "CONFIDENCE_PRIOR",
    "CONFIDENCE_SHRINKAGE_K",
    "compute_organic_confidence",
    "load_organic_confidence",
]

VERDICT_WEIGHTS: dict[str, float] = {
    "organic_strong": 1.0,
    "organic": 1.0,
    "borderline": 0.7,
    "suspect": 0.4,
    "likely_paid": 0.15,
}
CONFIDENCE_PRIOR: float = 0.75
CONFIDENCE_SHRINKAGE_K: int = 3

# insufficient_data 는 표본 제외 (판정 불가 ≠ 유료 의심)
_VERDICTS_SQL = (
    "SELECT group_key, verdict FROM debut_window_video_organicity "
    "WHERE verdict != 'insufficient_data'"
)


def compute_organic_confidence(verdicts: list[str]) -> float:
    """verdict 리스트 → 신뢰 계수 (순수). 미지 verdict 는 표본에서 제외."""
    weights = [VERDICT_WEIGHTS[v] for v in verdicts if v in VERDICT_WEIGHTS]
    n = len(weights)
    if n == 0:
        return 1.0
    mean = sum(weights) / n
    conf = (n * mean + CONFIDENCE_SHRINKAGE_K * CONFIDENCE_PRIOR) / (
        n + CONFIDENCE_SHRINKAGE_K
    )
    return round(conf, 3)


class _Executor(Protocol):
    def execute(self, sql: str, params: list[Any] | None = ...) -> list[dict]: ...


def load_organic_confidence(client: _Executor) -> dict[str, float]:
    """그룹별 신뢰 계수. 채점 영상 없는 그룹은 키 부재 → 호출부에서 1.0."""
    by_group: dict[str, list[str]] = {}
    for r in client.execute(_VERDICTS_SQL):
        by_group.setdefault(r["group_key"], []).append(r["verdict"])
    return {k: compute_organic_confidence(v) for k, v in by_group.items()}
