"""Music show #1 win backfill collector.

Pipeline (this module orchestrates phases 2-3, 2-5 of the V2 backfill):

  build_queries                  ─── 2-3: 그룹×프로그램×"1위" 쿼리 빌더
    ↓ (per query)
  fetch_articles                 ─── 2-3: search.naver.com → article cards
    ↓ (cross-query dedupe by url_hash)
  filter_cached                  ─── 2-3: music_show_wins_log url_hash
                                       와 비교 → 이미 추출된 url skip
    ↓ (cache miss articles only)
  llm.music_show.extract_*       ─── 2-4: Gemini structured extraction
    ↓ (ExtractedWin list)
  build_upsert_statements        ─── 2-5: music_show_wins_log INSERT
    ↓
  refresh_confirmation_status    ─── 2-5: (program, episode_date,
                                       group_key) 별 ≥2 url 보도 시
                                       status='confirmed' 로 승격

Entry point for cli.py: ``backfill_music_show_wins(...)``.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from time import sleep
from typing import Any
from urllib.parse import quote

from idol_sight.collectors.base import CollectionResult
from idol_sight.collectors.naver import NaverCollector
from idol_sight.llm.gemini import GeminiClient
from idol_sight.llm.music_show import (
    GROUP_KEY_ENUM,
    PROGRAM_ENUM,
    extract_music_show_wins,
)
from idol_sight.utils.url_hash import url_hash

log = logging.getLogger(__name__)


SEARCH_URL = "https://search.naver.com/search.naver?where=news&sm=tab_jum&query={q}"

# Music-show backfill is one-shot per cron run, no real-time pressure.
# 1.5s/query is conservative — 36 queries (6 groups × 6 programs) ≈ 54s
# wall, well under any cron timeout.
DEFAULT_INTER_QUERY_SLEEP_S = 1.5

# LLM batch size — keep small so schema-validation failure on one
# batch doesn't waste a large window. 8/batch × ~50 todo articles =
# ~7 LLM calls per backfill run.
LLM_BATCH_SIZE = 8


# 음방 1위 검색 시 알리아스. 각 그룹 group_key 를 영문/한국어 표기
# 모두로 검색해야 일부 매체의 표기 차이를 cover. canonical block 의
# 한국어 표기 사용.
#
# 키 집합은 llm/music_show.GROUP_KEY_ENUM (LLM 이 emit 가능한 후보) 과
# 정확히 일치해야 한다 — 검색만 하고 emit 못 하면 데이터가 조용히 버려짐.
# test_music_show_collector.test_query_aliases_match_llm_enum 가 가드.
# (UR:L 은 2026-06 운영자 결정으로 음방 추적 제외 → 검색에서도 제거.)
_GROUP_QUERY_ALIASES: dict[str, list[str]] = {
    "plave":    ["PLAVE", "플레이브"],
    "skinz":    ["SKINZ", "스킨즈"],
    "bdawn":    ["B:DAWN", "비던"],
    "wegosix":  ["WE GO-6", "위고식스"],
    "owis":     ["OWIS", "오위스"],
    "myrakl":   ["MY:RAKL", "미라클"],
}


@dataclass(frozen=True)
class QuerySpec:
    """그룹×프로그램×alias 별 검색 쿼리 단위.

    동일 (group_key, program) 의 여러 alias 쿼리는 article 결과를
    union 한다 (cross-query dedupe by url_hash). target_group_key /
    target_program 은 후처리에서 LLM 결과를 cross-validate 할 때 활용
    가능하지만, 현재는 LLM 의 자체 추출만 신뢰 (canonical schema enum
    이 강제) — 단순 메타데이터로만 보존.
    """
    target_group_key: str
    target_program: str
    query_string: str


@dataclass(frozen=True)
class FetchedArticle:
    """search.naver.com 에서 파싱한 article + url_hash. 음방 백필
    파이프라인 내부 표현."""
    url: str
    url_hash: str
    title: str
    snippet: str
    press: str
    published_at_raw: str


def build_queries(
    *,
    group_keys: Iterable[str] = GROUP_KEY_ENUM,
    programs: Iterable[str] = PROGRAM_ENUM,
) -> list[QuerySpec]:
    """그룹×프로그램×alias×"1위" 쿼리 생성.

    - 6 group × 6 program × 2 alias (영/한) = 72 쿼리 (default).
    - alias 수는 _GROUP_QUERY_ALIASES 에 정의 (그룹별 다를 수 있음).
    - 한국어 표기와 프로그램명은 한국어 그대로 quote 후 search URL
      에 박는다 — Naver search 가 byte-level UTF-8 escaping 을 정확히
      읽으므로 추가 normalization 불필요.
    """
    out: list[QuerySpec] = []
    for gk in group_keys:
        aliases = _GROUP_QUERY_ALIASES.get(gk)
        if not aliases:
            log.warning("music_show: no aliases for group_key=%r, skip", gk)
            continue
        for prog in programs:
            for alias in aliases:
                qs = f'"{alias}" "{prog}" 1위'
                out.append(QuerySpec(
                    target_group_key=gk,
                    target_program=prog,
                    query_string=qs,
                ))
    return out


def fetch_articles_for_query(
    query: QuerySpec,
    *,
    fetcher: Any,
) -> list[FetchedArticle]:
    """단일 쿼리로 search.naver.com 호출 → FetchedArticle list.

    NaverCollector._parse 의 static method 를 그대로 재사용.
    NaverCollector 가 멤버 query expansion 까지 묶인 무거운 entry point
    인 반면, 우리는 단일 쿼리만 필요하므로 _parse 만 borrow.
    """
    url = SEARCH_URL.format(q=quote(query.query_string))
    try:
        page = fetcher.get(
            url,
            impersonate="chrome131",
            stealthy_headers=True,
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("music_show fetch failed q=%r: %s", query.query_string, exc)
        return []
    parsed = NaverCollector._parse(page)
    out: list[FetchedArticle] = []
    for art in parsed:
        u = (art.get("url") or "").strip()
        if not u:
            continue
        out.append(FetchedArticle(
            url=u,
            url_hash=url_hash(u),
            title=art.get("title", ""),
            snippet=art.get("snippet", ""),
            press=art.get("press", ""),
            published_at_raw=art.get("published_at_raw", ""),
        ))
    return out


def fetch_all_articles(
    queries: Iterable[QuerySpec],
    *,
    fetcher: Any,
    sleeper: Callable[[float], None] = sleep,
    sleep_seconds: float = DEFAULT_INTER_QUERY_SLEEP_S,
) -> list[FetchedArticle]:
    """모든 쿼리 fetch → cross-query dedupe (url_hash) → 단일 list.

    같은 기사가 여러 쿼리에서 hit 하는 게 정상 — 그게 verification
    의 "≥2 보도" 카운트 메커니즘이라 dedupe 는 url_hash 단위로만 한다
    (같은 url 만 1번). (group, program, episode_date) 단위 보도 수는
    다음 단계 (LLM 추출 후) 에서 카운트.
    """
    seen: set[str] = set()
    merged: list[FetchedArticle] = []
    qlist = list(queries)
    for idx, q in enumerate(qlist):
        for art in fetch_articles_for_query(q, fetcher=fetcher):
            if art.url_hash in seen:
                continue
            seen.add(art.url_hash)
            merged.append(art)
        # Sleep AFTER each fetch except the last.
        if sleep_seconds and idx + 1 < len(qlist):
            sleeper(sleep_seconds)
    log.info(
        "music_show fetch: queries=%d articles_unique=%d",
        len(qlist), len(merged),
    )
    return merged


def filter_cached(
    articles: Iterable[FetchedArticle],
    *,
    db_client: Any,
) -> tuple[list[FetchedArticle], list[FetchedArticle]]:
    """url_hash 캐싱: music_show_extraction_cache 에 이미 있는 url 은
    cached 로 분리. todo 만 LLM 호출 대상.

    cache 테이블 (migration 0049) 은 win=true / win=false 결과 모두
    저장하므로, false-negative 도 같은 url 이 다시 hit 해도 LLM 재호출
    안 한다.

    Returns:
        (todo, cached). todo 는 LLM 추출 필요, cached 는 이미 처리됨.
    """
    art_list = list(articles)
    if not art_list:
        return [], []
    rows = db_client.execute(
        "SELECT url_hash FROM music_show_extraction_cache"
    )
    cached_hashes: set[str] = {r["url_hash"] for r in rows if r.get("url_hash")}
    todo: list[FetchedArticle] = []
    cached: list[FetchedArticle] = []
    for art in art_list:
        if art.url_hash in cached_hashes:
            cached.append(art)
        else:
            todo.append(art)
    log.info(
        "music_show cache: todo=%d cached=%d (skipped LLM)",
        len(todo), len(cached),
    )
    return todo, cached


# ---------------------------------------------------------------------------
# 2-5: verification + DB upsert.
# ---------------------------------------------------------------------------


def build_upsert_statements(
    extracted: Iterable[Any],
    *,
    fetched_by_id: dict[str, FetchedArticle],
    now_iso: str,
) -> list[tuple[str, list[Any]]]:
    """ExtractedWin list → SQL statements.

    각 record 마다:
      1. `music_show_extraction_cache` 에 항상 UPSERT (win=true/false 무관)
         → 다음 백필 run 에서 같은 url 이 hit 해도 LLM 호출 skip.
      2. `is_music_show_win=True` 면 `music_show_wins_log` 에도 INSERT
         (status='pending' 으로 시작 — verification 단계에서 ≥2 url 보도
         만족하면 confirmed 로 승격).

    Args:
        extracted: ExtractedWin sequence.
        fetched_by_id: article_id → FetchedArticle. article_id 는 url_hash
            를 그대로 사용한다 (호출자가 보장).
        now_iso: 현재 시각 (extracted_at 컬럼용 ISO 8601).
    """
    stmts: list[tuple[str, list[Any]]] = []
    for win in extracted:
        art = fetched_by_id.get(win.article_id)
        if art is None:
            log.warning(
                "music_show upsert: missing FetchedArticle for id=%r — skip",
                win.article_id,
            )
            continue
        # 1) cache UPSERT — 모든 record 가 들어간다.
        stmts.append((
            """
            INSERT INTO music_show_extraction_cache
              (url_hash, has_win, confidence, extracted_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(url_hash) DO UPDATE SET
              has_win = excluded.has_win,
              confidence = excluded.confidence,
              extracted_at = excluded.extracted_at
            """.strip(),
            [
                art.url_hash,
                1 if win.is_music_show_win else 0,
                float(win.confidence),
                now_iso,
            ],
        ))
        # 2) win=true 인 경우만 wins_log INSERT.
        if win.is_music_show_win:
            stmts.append((
                """
                INSERT INTO music_show_wins_log
                  (group_key, program, episode_date, song_title,
                   source_url, url_hash, snippet, status, confidence,
                   extracted_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
                ON CONFLICT(url_hash) DO UPDATE SET
                  group_key = excluded.group_key,
                  program = excluded.program,
                  episode_date = excluded.episode_date,
                  song_title = excluded.song_title,
                  snippet = excluded.snippet,
                  confidence = excluded.confidence,
                  extracted_at = excluded.extracted_at
                """.strip(),
                [
                    win.group_key,
                    win.program,
                    win.episode_date,
                    win.song_title,
                    art.url,
                    art.url_hash,
                    art.snippet,
                    float(win.confidence),
                    now_iso,
                ],
            ))
    return stmts


# verification SQL: 같은 (program, episode_date, group_key) 가 별개의
# url_hash 로 ≥2 건 보도되어 있으면 status='pending' → 'confirmed' 로
# 승격. EXISTS 패턴 사용 — D1/SQLite tuple IN 보다 portable.
_PROMOTE_TO_CONFIRMED_SQL = """
UPDATE music_show_wins_log AS log
SET status = 'confirmed',
    confirmed_at = ?
WHERE status = 'pending'
  AND EXISTS (
    SELECT 1 FROM music_show_wins_log AS other
    WHERE other.program      = log.program
      AND other.episode_date = log.episode_date
      AND other.group_key    = log.group_key
      AND other.url_hash    != log.url_hash
      AND other.status      != 'rejected'
  )
""".strip()


def refresh_confirmation_status(
    *,
    db_client: Any,
    now_iso: str,
) -> int:
    """Pending → confirmed 승격을 1번 batch 로 실행.

    Returns:
        Promoted row count. 0 이면 신규 컨퍼메이션 없음.
    """
    summary = db_client.batch([
        (_PROMOTE_TO_CONFIRMED_SQL, [now_iso]),
    ])
    # BatchSummary exposes total_changes (rows affected). The old code read a
    # nonexistent `rows_written` attr via getattr default, so the promotion
    # count was permanently 0 regardless of how many rows were promoted.
    affected = getattr(summary, "total_changes", 0) or 0
    log.info("music_show verification: promoted_pending_to_confirmed≈%d", affected)
    return int(affected)


def backfill_music_show_wins(
    *,
    fetcher: Any,
    gemini_client: GeminiClient,
    db_client: Any,
    group_keys: Iterable[str] = GROUP_KEY_ENUM,
    programs: Iterable[str] = PROGRAM_ENUM,
    sleeper: Callable[[float], None] = sleep,
    sleep_seconds: float = DEFAULT_INTER_QUERY_SLEEP_S,
    now_iso: str | None = None,
    llm_batch_size: int = LLM_BATCH_SIZE,
) -> CollectionResult:
    """Top-level entry point — fetch → cache filter → LLM extract →
    UPSERT (cache + wins_log) → verification.

    cli.py 가 호출. 호출자는 fetcher / gemini_client / db_client 를
    실 인스턴스로 주입. 테스트는 모든 의존성을 fake 로 주입.
    """
    from datetime import UTC, datetime
    if now_iso is None:
        now_iso = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")

    queries = build_queries(group_keys=group_keys, programs=programs)
    articles = fetch_all_articles(
        queries,
        fetcher=fetcher,
        sleeper=sleeper,
        sleep_seconds=sleep_seconds,
    )
    todo, cached = filter_cached(articles, db_client=db_client)

    fetched_by_id: dict[str, FetchedArticle] = {a.url_hash: a for a in todo}
    extracted_total: list[Any] = []
    # LLM 호출은 batch 단위. schema validation 실패 시 한 batch 만 손해.
    for i in range(0, len(todo), llm_batch_size):
        batch = todo[i:i + llm_batch_size]
        articles_payload = [{
            "article_id": a.url_hash,
            "title": a.title,
            "snippet": a.snippet,
            "press": a.press,
            "published_at": a.published_at_raw,
        } for a in batch]
        try:
            extracted_total.extend(extract_music_show_wins(
                client=gemini_client,
                articles=articles_payload,
            ))
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "music_show LLM batch %d-%d failed: %s",
                i, i + len(batch), exc,
            )

    statements = build_upsert_statements(
        extracted_total,
        fetched_by_id=fetched_by_id,
        now_iso=now_iso,
    )

    # 본 백필에서 batch INSERT/UPSERT 를 cli.py 가 client.batch 로 한 번에
    # 실행한 다음 별도로 verification 을 호출하는 게 트랜잭션 의도상
    # 더 안전. CollectionResult 에 statements 만 담아 caller 에 위임.
    return CollectionResult(
        rows_inserted=sum(
            1 for w in extracted_total if w.is_music_show_win
        ),
        rows_updated=0,
        statements=statements,
        runtime_ms=0,
        errors=[],
    )
