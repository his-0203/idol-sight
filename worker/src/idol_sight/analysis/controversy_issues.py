"""Controversy issue clustering — Gemini-driven dedup (V2.55).

V2.54 감점 구조 결함(같은 이슈를 글 N건으로 얘기하면 N번 감점 — 감점이
이슈 심각도가 아니라 커뮤니티 볼륨에 비례)을 교정한다. 그룹별 14일 윈도우
controversy 글을 실제 사건·의혹 단위 이슈로 묶고, 이슈마다 severity 를
매겨 ``effective_weight = Σ severity weight`` 를 산출한다. health 산식 v3
(``health_score._controversy_factor``)이 이 weight 를 count 대신 읽어
``max(0.6, 1 - weight/10)`` 으로 감점한다.

설계: sentiment.py 의 형제 구조를 따른다 — _Executor/_Gemini Protocol,
structured-output 스키마, 모듈 레벨 PROMPT 상수, D1 statement 리스트 반환.
순수 로직(weight 합산·응답 파싱·stale 판정)은 I/O 와 분리해 LLM 없이 단위
테스트 가능하게 둔다.

배치 위치: analyze_weekly 감성 분류 직후. 산출 행은 신규 테이블
``controversy_issues`` (mig 0108, group_key PK, replace)에 그룹당 최신 1행만
저장. 글 0건 그룹은 행 DELETE(신호 소멸). Gemini 실패 시 기존 행 유지(다음
런 stale 가드가 처리) + warning 로그 + 다른 그룹 계속.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from typing import Any, Protocol

log = logging.getLogger(__name__)

WINDOW_DAYS = 14            # controversy 글 집계 윈도우
LIMIT_PER_GROUP = 200      # 그룹당 최대 글 수 (토큰 상한)

# health 폴백 전환 임계 — computed_at 이 이보다 오래되면 stale 로 보고
# count 기반 폴백을 태운다. analyze 가 2회 이상 결번(≈2주 주기) 나야 도달.
STALE_DAYS = 8

# severity → weight. spec ②: high=법적분쟁·안전사고·계약파기·대형폭로(3),
# medium=유출·표절시비·운영사고(2), low=팬덤갈등·경미한시비(1).
SEVERITY_WEIGHTS: dict[str, int] = {"low": 1, "medium": 2, "high": 3}

# Gemini structured output 스키마.
ISSUE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "issues": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "severity": {
                        "type": "string",
                        "enum": ["low", "medium", "high"],
                    },
                    "post_hashes": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                },
                "required": ["label", "severity", "post_hashes"],
            },
        },
    },
    "required": ["issues"],
}

PROMPT_CONTROVERSY = """\
You are grouping Korean K-pop community post TITLES that were already
flagged as 'controversy' for one idol group into distinct real-world
ISSUES, so downstream risk scoring counts each incident ONCE instead of
once per post.

Cluster titles that discuss the SAME real event, allegation, or dispute
into a single issue. Two titles about the same lawsuit belong to one
issue even if worded differently; two titles about unrelated incidents
are two issues.

For each issue output:
  - label        — one short Korean line naming the incident.
  - post_hashes  — the url_hashes of the titles belonging to this issue.
  - severity:
      high   — 법적 분쟁·안전 사고·계약 파기·대형 폭로 (weight 3)
      medium — 유출·표절 시비·운영 사고 (weight 2)
      low    — 팬덤 간 갈등·경미한 시비 (weight 1)

Rules:
  - A title that does NOT refer to a concrete real incident (잡담, 밈,
    막연한 질문) belongs to NO issue — leave it out entirely. This is a
    second-pass noise filter on top of the sentiment stage.
  - Preserve every url_hash EXACTLY as given; never invent or modify one.
  - When severity is ambiguous, choose the LOWER tier.
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


# ─── Pure logic (LLM 없이 단위 테스트 가능) ──────────────────────────────


def parse_issues(parsed: dict[str, Any]) -> list[dict[str, Any]]:
    """Gemini 응답을 검증된 이슈 리스트로 정규화한다.

    severity 가 알려진 tier 가 아니거나 label 이 비었거나 post_hashes 가
    비어 있으면(=아무 글도 안 묶인 유령 이슈) 버린다. 방어적 — 잘못된
    항목이 weight 합산을 오염시키지 않게 한다.
    """
    raw = parsed.get("issues") if isinstance(parsed, dict) else None
    if not isinstance(raw, list):
        return []
    issues: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        severity = item.get("severity")
        if severity not in SEVERITY_WEIGHTS:
            continue
        hashes = item.get("post_hashes")
        hashes = [h for h in hashes if isinstance(h, str)] if isinstance(
            hashes, list) else []
        if not hashes:
            continue
        label = item.get("label")
        if not isinstance(label, str) or not label.strip():
            continue
        issues.append({
            "label": label.strip(),
            "severity": severity,
            "post_hashes": hashes,
        })
    return issues


def effective_weight(issues: list[dict[str, Any]]) -> float:
    """Σ severity weight over clustered issues."""
    return float(sum(SEVERITY_WEIGHTS[i["severity"]] for i in issues))


def is_stale(computed_at: str | None, *, now: datetime,
             max_age_days: int = STALE_DAYS) -> bool:
    """computed_at 이 max_age_days 보다 오래됐거나 파싱 불가면 True.

    health 재계산이 stale 행을 신뢰하지 않고 count 폴백으로 넘어갈지
    판정한다. None/빈 값/파싱 실패는 모두 stale 취급(안전측).
    """
    if not computed_at:
        return True
    try:
        ts = datetime.fromisoformat(computed_at.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return True
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=now.tzinfo)
    return (now - ts) > timedelta(days=max_age_days)


# ─── I/O (statement 빌더) ────────────────────────────────────────────────


def build_for_group(
    client: _Executor,
    gemini: _Gemini,
    *,
    group_key: str,
    group_name_kr: str,
    computed_at: str,
    window_days: int = WINDOW_DAYS,
    limit: int = LIMIT_PER_GROUP,
) -> list[tuple[str, list[Any]]]:
    """그룹 1개의 controversy 이슈 클러스터링 → D1 statement 리스트.

    - 윈도우 내 controversy 글 0건 → 기존 행 DELETE(신호 소멸).
    - Gemini 예외 → 빈 리스트 반환(기존 행 유지, warning 로그). analyze
      전체는 계속.
    - 정상 → controversy_issues 에 그룹당 최신 1행 UPSERT.
    """
    rows = client.execute(
        "SELECT url_hash, title FROM community_posts "
        "WHERE group_key=? AND sentiment='controversy' "
        "  AND posted_at >= datetime('now', ?) "
        "  AND title IS NOT NULL AND length(title) > 0 "
        "ORDER BY posted_at DESC LIMIT ?",
        [group_key, f"-{window_days} days", limit],
    )
    if not rows:
        # 신호 소멸 — 이전 런의 행이 남아 health 를 계속 깎지 않게 제거.
        return [(
            "DELETE FROM controversy_issues WHERE group_key=?",
            [group_key],
        )]

    try:
        parsed = _call_gemini(gemini, group_name_kr, rows)
    except Exception as e:  # noqa: BLE001
        log.warning("controversy clustering failed for %s (%d posts): %s",
                    group_key, len(rows), e)
        return []

    issues = parse_issues(parsed)
    weight = effective_weight(issues)
    return [(
        "INSERT INTO controversy_issues "
        " (group_key, computed_at, issue_count, effective_weight, issues_json)"
        " VALUES (?, ?, ?, ?, ?)"
        " ON CONFLICT(group_key) DO UPDATE SET"
        "  computed_at=excluded.computed_at,"
        "  issue_count=excluded.issue_count,"
        "  effective_weight=excluded.effective_weight,"
        "  issues_json=excluded.issues_json",
        [group_key, computed_at, len(issues), weight, json.dumps(
            issues, ensure_ascii=False)],
    )]


def _call_gemini(
    gemini: _Gemini, group_name_kr: str, rows: list[dict[str, Any]],
) -> dict[str, Any]:
    context = {
        "group": group_name_kr,
        "posts": [
            {"url_hash": r["url_hash"], "title": (r["title"] or "")[:200]}
            for r in rows
        ],
    }
    return gemini.generate(
        system_prompt=PROMPT_CONTROVERSY,
        context=context,
        response_schema=ISSUE_SCHEMA,
    )


__all__ = [
    "ISSUE_SCHEMA",
    "PROMPT_CONTROVERSY",
    "SEVERITY_WEIGHTS",
    "STALE_DAYS",
    "WINDOW_DAYS",
    "build_for_group",
    "effective_weight",
    "is_stale",
    "parse_issues",
]
