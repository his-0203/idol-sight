"""주간 바이럴 챌린지 발굴+측정 오케스트레이션.
설계: docs/superpowers/specs/2026-06-02-weekly-viral-challenges-design.md
순수 헬퍼(파싱·랭크·시각·UPSERT)와 오케스트레이터(run_challenge_scan, 별도 task)로 구성.
"""
from __future__ import annotations

import datetime as _dt
import json
import logging
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from time import sleep as _time_sleep

from idol_sight.llm.prompts import CHALLENGE_CLASSIFY_SYSTEM, CHALLENGE_SCHEMA

log = logging.getLogger(__name__)

# 측정 기반 발굴 시드 — 실제 바이럴 K-POP 챌린지/밈 숏츠를 폭넓게 끌어온다.
SEED_QUERIES = (
    "케이팝 챌린지", "아이돌 챌린지", "kpop dance challenge",
    "아이돌 밈", "kpop idol meme",
)
POOL_CAP = 150  # LLM 분류에 넘길 후보 영상 상한(조회수 상위) — 롱테일 포착 위해 상향(V2)
SEED_DELAY_SEC = 1.0  # 시드 검색 사이 간격 — 429 burst 레이트리밋 완화

# YouTube URL → 11자 video_id. shorts/ · watch?v= · youtu.be/ · live/ 지원.
_YT_ID_RE = re.compile(
    r"(?:youtube\.com/(?:shorts/|watch\?v=|live/|embed/)|youtu\.be/)([A-Za-z0-9_-]{11})"
)


def extract_video_id(url: str) -> str | None:
    """YouTube URL 에서 video_id 추출. 못 찾으면 None."""
    m = _YT_ID_RE.search(url or "")
    return m.group(1) if m else None


def _is_http_url(s: str) -> bool:
    """실제 http(s) URL 인지 (기사 제목·설명 문구 배제용)."""
    return s.startswith("http://") or s.startswith("https://")


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
    # 생애주기: momentum(추세)만 유지. started_around(시작 시점)·valid_until
    # (유효 기한)은 LLM 추정 근거가 없어 제거(2026-06) — brief 에 날짜/시계열이
    # 없고, valid_until 은 미래 예측이라 측정으로 검증 불가.
    momentum: str = "unknown"   # rising | peaking | declining | unknown
    # LLM 이 제시한 챌린지 클립 후보 (URL→video_id, 검증 전). measure 에서 API 검증.
    candidate_video_ids: list[str] = field(default_factory=list)
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
        # 챌린지 클립 후보(video_id). 분류(B)는 example_video_ids 로 raw id 를,
        # 구버전/grounding 은 example_urls 로 URL 을 줄 수 있어 둘 다 흡수. 중복 제거.
        cand: list[str] = []
        for v in (it.get("example_video_ids") or []):
            vid = str(v).strip()
            if re.fullmatch(r"[A-Za-z0-9_-]{11}", vid) and vid not in cand:
                cand.append(vid)
        for u in (it.get("example_urls") or []):
            vid = extract_video_id(str(u))
            if vid and vid not in cand:
                cand.append(vid)
        mom = it.get("momentum")
        out.append(Challenge(
            name=str(it["name"]),
            tag="meme" if tag == "meme" else "dance",
            description=str(it.get("description") or ""),
            origin=str(it.get("origin") or ""),
            hashtags=[str(h) for h in (it.get("hashtags") or []) if h],
            # 출처는 실제 http(s) URL 만 — 기사 제목/설명 문구는 버림(깨진 링크 방지).
            source_urls=[str(u) for u in (it.get("source_urls") or []) if _is_http_url(str(u))],
            confidence=str(it.get("confidence") or "low"),
            miiwan_fit=str(it.get("miiwan_fit") or ""),
            momentum=mom if mom in ("rising", "peaking", "declining") else "unknown",
            candidate_video_ids=cand,
        ))
    return out


def week_start_kst(now_epoch: float) -> str:
    """now(epoch sec) 가 속한 주의 KST 월요일 (YYYY-MM-DD)."""
    kst = _dt.datetime.fromtimestamp(now_epoch, tz=_dt.UTC) + _dt.timedelta(hours=9)
    monday = kst.date() - _dt.timedelta(days=kst.weekday())
    return monday.isoformat()


def iso_days_ago(now_epoch: float, days: int) -> str:
    """RFC3339(UTC, Z) — YouTube publishedAfter 용."""
    t = _dt.datetime.fromtimestamp(now_epoch, tz=_dt.UTC) - _dt.timedelta(days=days)
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def _date_kst(now_epoch: float) -> str:
    """KST 달력 날짜 (YYYY-MM-DD)."""
    kst = _dt.datetime.fromtimestamp(now_epoch, tz=_dt.UTC) + _dt.timedelta(hours=9)
    return kst.date().isoformat()


def discover_candidate_videos(
    yt, now_epoch: float, *, pool_cap: int = POOL_CAP,
    sleep: Callable[[float], None] = _time_sleep,
) -> list[dict]:
    """최근 7일 YouTube 에서 조회수 높은 K-POP 챌린지/밈 숏츠 풀을 수집한다.
    실제 바이럴 데이터 → 여기 안 뜨는 니치는 자연 제외, 대형 신곡은 자동 포함.
    시드 검색 사이에 간격(SEED_DELAY_SEC)을 둬 429 burst 레이트리밋을 완화한다.
    반환: [{video_id, title, channel, views, duration_sec}, ...] 조회수 내림차순."""
    published_after = iso_days_ago(now_epoch, 7)
    seen: dict[str, dict] = {}
    last = len(SEED_QUERIES) - 1
    for i, q in enumerate(SEED_QUERIES):
        try:
            ids = yt.search_shorts(query=q, published_after=published_after,
                                   order="viewCount", max_results=50)
            for s in yt.fetch_stats(ids):
                vid = s.get("video_id")
                if vid and vid not in seen:
                    seen[vid] = s
        except Exception as e:  # noqa: BLE001 — 시드별 실패는 비-치명
            log.warning("discover seed %r failed: %s", q, e)
        if i < last:
            sleep(SEED_DELAY_SEC)
    pool = sorted(seen.values(), key=lambda s: s.get("views") or 0, reverse=True)
    return pool[:pool_cap]


def select_and_rank(
    challenges: list[Challenge], *, total: int = 10, min_meme: int = 3,
) -> list[Challenge]:
    """측정 점수로 상위 total 개 선정 + 랭크. 단 밈(비-댄스)은 조회수로 측정이 약해
    묻히기 쉬우므로 최소 min_meme 개를 보장한다 (있는 만큼). 전부 K-POP 아이돌."""
    views = [c.yt_total_views or 0 for c in challenges]
    shorts = [c.yt_recent_shorts or 0 for c in challenges]
    mv = max(views) or 1
    ms = max(shorts) or 1
    for c in challenges:
        c.score = (c.yt_total_views or 0) / mv * 0.7 + (c.yt_recent_shorts or 0) / ms * 0.3
    memes = sorted([c for c in challenges if c.tag == "meme"],
                   key=lambda c: c.score, reverse=True)
    guaranteed = memes[:min_meme]                       # 밈 최소 보장
    gids = {id(c) for c in guaranteed}
    rest = sorted([c for c in challenges if id(c) not in gids],
                  key=lambda c: c.score, reverse=True)
    selected = guaranteed + rest[: max(0, total - len(guaranteed))]
    selected.sort(key=lambda c: c.score, reverse=True)
    for i, c in enumerate(selected, 1):
        c.rank = i
    return selected


_INSERT_SQL = (
    "INSERT INTO weekly_challenges"
    " (week_start, rank, name, tag, description, origin, hashtags,"
    "  example_video_ids, yt_recent_shorts, yt_total_views, miiwan_fit,"
    "  source_urls, confidence, generated_at,"
    "  momentum)"
    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
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
            c.momentum,
        ]))
    return stmts


def measure_challenge(yt, ch: Challenge, published_after: str) -> None:
    """ch 의 반응 규모 지표(yt_recent_shorts/yt_total_views)를 in-place 보강.
    해시태그 블라인드 검색 표본. 실패는 비-치명.
    (예시 영상 id 는 run_challenge_scan 이 pool-grounded candidate 에서 채운다.)"""
    query = ch.hashtags[0] if ch.hashtags else ch.name
    try:
        ids = yt.search_shorts(query=query, published_after=published_after)
        if ids:
            stats = yt.fetch_stats(ids)
            ch.yt_recent_shorts = len(ids)
            ch.yt_total_views = sum((s.get("views") or 0) for s in stats)
    except Exception as e:  # noqa: BLE001
        log.warning("metric measure failed for %r: %s", ch.name, e)


def run_challenge_scan(
    gemini, yt, d1, *, now_epoch: float, total: int = 10, min_meme: int = 3,
) -> int:
    """측정 기반 발굴(B): YouTube 바이럴 풀 → LLM 분류 → 측정·랭크 → UPSERT.
    저장한 챌린지 수 반환. 풀 없음/분류 실패/근거 없음은 비-치명(그 주 스킵)."""
    pool = discover_candidate_videos(yt, now_epoch)
    if not pool:
        log.warning("challenge-scan: no candidate videos; preserving prior week")
        return 0
    brief = [{"video_id": v.get("video_id"), "title": v.get("title"),
              "channel": v.get("channel"), "views": v.get("views")} for v in pool]
    try:
        structured = gemini.generate(
            system_prompt=CHALLENGE_CLASSIFY_SYSTEM,
            context={"today": _date_kst(now_epoch), "videos": brief},
            response_schema=CHALLENGE_SCHEMA,
        )
    except Exception as e:  # noqa: BLE001
        log.warning("challenge-scan: classify failed (%s); preserving prior week", e)
        return 0

    poolmap = {v.get("video_id"): v for v in pool}
    parsed = parse_structured_challenges(structured)
    # 바이럴 풀에 근거(영상 1개+) 없는 분류는 버림 → 니치/환각 차단.
    challenges = [c for c in parsed
                  if any(vid in poolmap for vid in c.candidate_video_ids)]
    if not challenges:
        log.warning(
            "challenge-scan: no pool-grounded challenges (pool=%d classified=%d); "
            "preserving prior week", len(pool), len(parsed),
        )
        return 0

    published_after = iso_days_ago(now_epoch, 7)
    for ch in challenges:
        # Surface up to 3 concrete example clips. candidate_video_ids that are
        # in the viral pool are exactly the grounded videos the LLM cited for
        # this challenge — promote them so the frontend shows real examples
        # instead of only a "search on YouTube" link.
        ch.example_video_ids = [
            vid for vid in ch.candidate_video_ids if vid in poolmap
        ][:3]
        measure_challenge(yt, ch, published_after)

    selected = select_and_rank(challenges, total=total, min_meme=min_meme)
    week_start = week_start_kst(now_epoch)
    generated_at = _dt.datetime.fromtimestamp(now_epoch, tz=_dt.UTC)\
        .strftime("%Y-%m-%dT%H:%M:%SZ")
    d1.batch(build_upsert_statements(week_start, selected, generated_at))
    # V2 관측성 — 어느 단계가 깎는지 측정(다음 run 의 V3 풀 다양화 판단 근거).
    log.info(
        "challenge-scan funnel: pool=%d classified=%d pool_grounded=%d selected=%d",
        len(pool), len(parsed), len(challenges), len(selected),
    )
    return len(selected)
