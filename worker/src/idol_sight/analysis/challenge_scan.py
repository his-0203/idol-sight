"""주간 바이럴 챌린지 발굴+측정 오케스트레이션.
설계: docs/superpowers/specs/2026-06-02-weekly-viral-challenges-design.md
순수 헬퍼(파싱·랭크·시각·UPSERT)와 오케스트레이터(run_challenge_scan, 별도 task)로 구성.
"""
from __future__ import annotations

import datetime as _dt
import json
import logging
from dataclasses import dataclass, field

from idol_sight.llm.prompts import (
    CHALLENGE_DISCOVERY_PROMPT, CHALLENGE_STRUCTURE_SYSTEM, CHALLENGE_SCHEMA,
)

log = logging.getLogger(__name__)

KPOP_WEIGHT = 1.3   # kpop 태그 랭크 가중
SHORT_MAX_SEC = 60  # 예시 영상 = 진짜 숏츠 상한(초). MV/일반영상 배제 (is_short 기준과 동일)


@dataclass
class Challenge:
    name: str
    tag: str
    description: str
    origin: str
    hashtags: list[str]
    source_urls: list[str]
    confidence: str
    miiwan_fit: str
    yt_recent_shorts: int | None = None
    yt_total_views: int | None = None
    example_video_ids: list[str] = field(default_factory=list)
    score: float = 0.0
    rank: int | None = None


def parse_structured_challenges(payload: object) -> list[Challenge]:
    if not isinstance(payload, dict):
        return []
    items = payload.get("challenges")
    if not isinstance(items, list):
        return []
    out: list[Challenge] = []
    for it in items:
        if not isinstance(it, dict) or not it.get("name"):
            continue
        tag = it.get("tag")
        out.append(Challenge(
            name=str(it["name"]),
            tag="kpop" if tag == "kpop" else "general",
            description=str(it.get("description") or ""),
            origin=str(it.get("origin") or ""),
            hashtags=[str(h) for h in (it.get("hashtags") or []) if h],
            source_urls=[str(u) for u in (it.get("source_urls") or []) if u],
            confidence=str(it.get("confidence") or "low"),
            miiwan_fit=str(it.get("miiwan_fit") or ""),
        ))
    return out


def week_start_kst(now_epoch: float) -> str:
    """now(epoch sec) 가 속한 주의 KST 월요일 (YYYY-MM-DD)."""
    kst = _dt.datetime.fromtimestamp(now_epoch, tz=_dt.timezone.utc) + _dt.timedelta(hours=9)
    monday = kst.date() - _dt.timedelta(days=kst.weekday())
    return monday.isoformat()


def iso_days_ago(now_epoch: float, days: int) -> str:
    """RFC3339(UTC, Z) — YouTube publishedAfter 용."""
    t = _dt.datetime.fromtimestamp(now_epoch, tz=_dt.timezone.utc) - _dt.timedelta(days=days)
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def select_and_rank(
    challenges: list[Challenge], *, target_kpop: int, target_general: int,
) -> list[Challenge]:
    views = [c.yt_total_views or 0 for c in challenges]
    shorts = [c.yt_recent_shorts or 0 for c in challenges]
    mv = max(views) or 1
    ms = max(shorts) or 1
    for c in challenges:
        base = (c.yt_total_views or 0) / mv * 0.7 + (c.yt_recent_shorts or 0) / ms * 0.3
        c.score = base * (KPOP_WEIGHT if c.tag == "kpop" else 1.0)
    kpop = sorted([c for c in challenges if c.tag == "kpop"],
                  key=lambda c: c.score, reverse=True)[:target_kpop]
    general = sorted([c for c in challenges if c.tag == "general"],
                     key=lambda c: c.score, reverse=True)[:target_general]
    selected = sorted(kpop + general, key=lambda c: c.score, reverse=True)
    for i, c in enumerate(selected, 1):
        c.rank = i
    return selected


_INSERT_SQL = (
    "INSERT INTO weekly_challenges"
    " (week_start, rank, name, tag, description, origin, hashtags,"
    "  example_video_ids, yt_recent_shorts, yt_total_views, miiwan_fit,"
    "  source_urls, confidence, generated_at)"
    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
)


def build_upsert_statements(
    week_start: str, challenges: list[Challenge], generated_at: str,
) -> list[tuple[str, list]]:
    stmts: list[tuple[str, list]] = [
        ("DELETE FROM weekly_challenges WHERE week_start = ?", [week_start]),
    ]
    for c in challenges:
        stmts.append((_INSERT_SQL, [
            week_start, c.rank, c.name, c.tag, c.description, c.origin,
            json.dumps(c.hashtags, ensure_ascii=False),
            json.dumps(c.example_video_ids, ensure_ascii=False),
            c.yt_recent_shorts, c.yt_total_views, c.miiwan_fit,
            json.dumps(c.source_urls, ensure_ascii=False),
            c.confidence, generated_at,
        ]))
    return stmts


def measure_challenge(yt, ch: Challenge, published_after: str) -> None:
    """YouTube 키워드 검색으로 ch 의 측정 필드를 in-place 채움. 실패는 무시(미측정)."""
    query = ch.hashtags[0] if ch.hashtags else ch.name
    try:
        ids = yt.search_shorts(query=query, published_after=published_after)
        if not ids:
            return
        # 조회수 합산과 숏폼 수의 표본 윈도우를 일치시킨다 (videos.list 는 50개/콜).
        stats = yt.fetch_stats(ids)
        ch.yt_recent_shorts = len(ids)
        ch.yt_total_views = sum((s.get("views") or 0) for s in stats)
        # 예시 영상은 '진짜 숏츠'(0<dur<=60s) 만 — videoDuration=short 는 <4분이라
        # MV·티저가 섞이고 조회수순 1위가 흔히 공식 MV다. 길이로 강하게 배제하고
        # 그 안에서 조회수순 상위 3개를 챌린지 예시로 쓴다. 숏츠가 없으면 링크 없음.
        shorts = [s for s in stats
                  if 0 < (s.get("duration_sec") or 0) <= SHORT_MAX_SEC]
        shorts.sort(key=lambda s: s.get("views") or 0, reverse=True)
        ch.example_video_ids = [s["video_id"] for s in shorts[:3] if s.get("video_id")]
    except Exception as e:  # noqa: BLE001 — 후보별 측정 실패는 치명적이지 않음
        log.warning("measure failed for %r: %s", ch.name, e)


def run_challenge_scan(
    gemini, yt, d1, *, now_epoch: float, target_kpop: int = 7, target_general: int = 3,
) -> int:
    """발굴→구조화→측정→랭크→UPSERT. 저장한 챌린지 수 반환.
    발굴(grounded+structure) 실패는 비-치명: 로그 후 0 반환(기존 주차 보존)."""
    try:
        grounded = gemini.generate_grounded(prompt=CHALLENGE_DISCOVERY_PROMPT)
        structured = gemini.generate(
            system_prompt=CHALLENGE_STRUCTURE_SYSTEM,
            context={"grounded_text": grounded.text, "sources": grounded.sources},
            response_schema=CHALLENGE_SCHEMA,
        )
    except Exception as e:  # noqa: BLE001 — 발굴 실패는 비-치명(그 주 스킵)
        log.warning("challenge-scan: discovery failed (%s); preserving prior week", e)
        return 0
    challenges = parse_structured_challenges(structured)
    if not challenges:
        log.warning("challenge-scan: no challenges discovered; preserving prior week")
        return 0
    published_after = iso_days_ago(now_epoch, 7)
    for ch in challenges:
        measure_challenge(yt, ch, published_after)
    selected = select_and_rank(challenges, target_kpop=target_kpop,
                               target_general=target_general)
    week_start = week_start_kst(now_epoch)
    generated_at = _dt.datetime.fromtimestamp(now_epoch, tz=_dt.timezone.utc)\
        .strftime("%Y-%m-%dT%H:%M:%SZ")
    d1.batch(build_upsert_statements(week_start, selected, generated_at))
    return len(selected)
