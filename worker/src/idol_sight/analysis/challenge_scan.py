"""주간 바이럴 챌린지 발굴+측정 오케스트레이션.
설계: docs/superpowers/specs/2026-06-02-weekly-viral-challenges-design.md
순수 헬퍼(파싱·랭크·시각·UPSERT)와 오케스트레이터(run_challenge_scan, 별도 task)로 구성.
"""
from __future__ import annotations

import datetime as _dt
import json
import logging
from dataclasses import dataclass, field

log = logging.getLogger(__name__)

KPOP_WEIGHT = 1.3   # kpop 태그 랭크 가중


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
