from unittest.mock import MagicMock

from idol_sight.collectors import music_show as ms
from idol_sight.collectors.music_show import (
    FetchedArticle,
    QuerySpec,
    backfill_music_show_wins,
    build_queries,
    build_upsert_statements,
    fetch_all_articles,
    filter_cached,
    refresh_confirmation_status,
)
from idol_sight.llm.music_show import ExtractedWin

# --- build_queries -------------------------------------------------------


def test_build_queries_default_count():
    qs = build_queries()
    # 6 그룹 × 6 프로그램 × 2 alias (영/한) = 72 쿼리
    assert len(qs) == 72


def test_build_queries_covers_all_six_candidate_groups():
    qs = build_queries()
    gks = {q.target_group_key for q in qs}
    assert gks == {"plave", "skinz", "bdawn", "wegosix", "owis", "myrakl"}


def test_build_queries_includes_quoted_group_program_and_keyword():
    """쿼리는 그룹 alias + 프로그램명 + "1위" 키워드를 포함."""
    qs = build_queries(group_keys=["plave"])
    # 6 program × 2 alias = 12
    assert len(qs) == 12
    for q in qs:
        assert "1위" in q.query_string
        assert q.target_program in q.query_string
        # PLAVE 또는 플레이브 둘 중 하나 포함
        assert ("PLAVE" in q.query_string) or ("플레이브" in q.query_string)


def test_build_queries_skips_unknown_group_key():
    """alias 정의가 없는 group_key 는 skip (no crash)."""
    qs = build_queries(group_keys=["plave", "isedol_unknown"])
    # PLAVE 만 남고 unknown 은 누락
    gks = {q.target_group_key for q in qs}
    assert gks == {"plave"}


# --- filter_cached -------------------------------------------------------


def _art(uh: str) -> FetchedArticle:
    return FetchedArticle(
        url=f"https://example.com/{uh}",
        url_hash=uh,
        title="t", snippet="", press="", published_at_raw="",
    )


def test_filter_cached_separates_by_url_hash():
    arts = [_art("h1"), _art("h2"), _art("h3")]
    db = MagicMock()
    db.execute.return_value = [{"url_hash": "h1"}, {"url_hash": "h3"}]
    todo, cached = filter_cached(arts, db_client=db)
    assert {a.url_hash for a in todo} == {"h2"}
    assert {a.url_hash for a in cached} == {"h1", "h3"}


def test_filter_cached_handles_empty_db():
    arts = [_art("h1"), _art("h2")]
    db = MagicMock()
    db.execute.return_value = []
    todo, cached = filter_cached(arts, db_client=db)
    assert len(todo) == 2
    assert len(cached) == 0


def test_filter_cached_handles_empty_articles_skips_query():
    """입력이 비면 DB 호출 자체 skip (불필요한 query 절약)."""
    db = MagicMock()
    todo, cached = filter_cached([], db_client=db)
    assert todo == []
    assert cached == []
    db.execute.assert_not_called()


# --- fetch_all_articles --------------------------------------------------


def test_fetch_all_articles_dedupes_across_queries(monkeypatch):
    """같은 url 이 여러 쿼리에서 반환돼도 url_hash 단위로 1번만 유지."""
    queries = [
        QuerySpec("plave", "쇼챔피언", '"PLAVE" "쇼챔피언" 1위'),
        QuerySpec("plave", "엠카운트다운", '"PLAVE" "엠카운트다운" 1위'),
    ]
    common = [_art("h1")]
    monkeypatch.setattr(
        ms, "fetch_articles_for_query",
        lambda q, fetcher: common,
    )
    out = fetch_all_articles(
        queries, fetcher=MagicMock(),
        sleeper=lambda _: None, sleep_seconds=0,
    )
    assert len(out) == 1
    assert out[0].url_hash == "h1"


def test_fetch_all_articles_merges_distinct_results(monkeypatch):
    queries = [
        QuerySpec("plave", "쇼챔피언", '"PLAVE" "쇼챔피언" 1위'),
        QuerySpec("plave", "엠카운트다운", '"PLAVE" "엠카운트다운" 1위'),
    ]

    def fake_fetch(q, fetcher):
        if "쇼챔피언" in q.query_string:
            return [_art("h1"), _art("h2")]
        return [_art("h2"), _art("h3")]   # h2 중복 → dedupe

    monkeypatch.setattr(ms, "fetch_articles_for_query", fake_fetch)
    out = fetch_all_articles(
        queries, fetcher=MagicMock(),
        sleeper=lambda _: None, sleep_seconds=0,
    )
    assert {a.url_hash for a in out} == {"h1", "h2", "h3"}


def test_fetch_all_articles_sleeps_between_queries(monkeypatch):
    """마지막 쿼리 뒤에는 sleep 안 함 → sleep 호출 = (쿼리 수 - 1)."""
    queries = [
        QuerySpec("plave", "쇼챔피언", "q1"),
        QuerySpec("plave", "엠카운트다운", "q2"),
        QuerySpec("plave", "뮤직뱅크", "q3"),
    ]
    monkeypatch.setattr(
        ms, "fetch_articles_for_query",
        lambda q, fetcher: [],
    )
    sleep_calls: list[float] = []
    fetch_all_articles(
        queries, fetcher=MagicMock(),
        sleeper=lambda s: sleep_calls.append(s),
        sleep_seconds=1.5,
    )
    assert sleep_calls == [1.5, 1.5]


# --- build_upsert_statements ---------------------------------------------


def _win(article_id: str, **kw) -> ExtractedWin:
    base = dict(
        article_id=article_id,
        is_music_show_win=True,
        confidence=0.9,
        program="쇼챔피언",
        episode_date="2026-04-23",
        group_key="plave",
        song_title="Pump Up The Volume",
        reasoning="ok",
    )
    base.update(kw)
    return ExtractedWin(**base)


def test_upsert_writes_cache_for_every_record_and_log_only_for_wins():
    """win=true 면 cache + wins_log 둘 다, win=false 면 cache 만."""
    win = _win("h1")
    miss = _win(
        "h2", is_music_show_win=False, program=None,
        episode_date=None, group_key=None, song_title=None,
        confidence=0.3,
    )
    fetched_by_id = {
        "h1": _art("h1"),
        "h2": _art("h2"),
    }
    stmts = build_upsert_statements(
        [win, miss],
        fetched_by_id=fetched_by_id,
        now_iso="2026-05-07T00:00:00Z",
    )
    sqls = [s for s, _ in stmts]
    cache_count = sum(1 for s in sqls if "music_show_extraction_cache" in s)
    log_count = sum(1 for s in sqls if "music_show_wins_log" in s)
    assert cache_count == 2          # win + miss 각각 1번씩
    assert log_count == 1            # win 만


def test_upsert_skips_when_fetched_article_missing():
    """fetched_by_id 에 없는 article_id 는 skip (warning + drop)."""
    win = _win("h_missing")
    stmts = build_upsert_statements(
        [win],
        fetched_by_id={},   # 비어 있음
        now_iso="2026-05-07T00:00:00Z",
    )
    assert stmts == []


def test_upsert_log_row_has_pending_status_and_full_fields():
    """wins_log row 는 status='pending' 으로 시작, 모든 5요소 채움."""
    win = _win("h1", confidence=0.95)
    fetched_by_id = {"h1": _art("h1")}
    stmts = build_upsert_statements(
        [win], fetched_by_id=fetched_by_id, now_iso="2026-05-07T00:00:00Z",
    )
    log_stmt = next((s, p) for s, p in stmts if "music_show_wins_log" in s)
    sql, params = log_stmt
    assert "'pending'" in sql
    # params 순서: group_key, program, episode_date, song_title,
    #             source_url, url_hash, snippet, confidence, extracted_at.
    assert params[0] == "plave"
    assert params[1] == "쇼챔피언"
    assert params[2] == "2026-04-23"
    assert params[3] == "Pump Up The Volume"
    assert params[4] == "https://example.com/h1"
    assert params[5] == "h1"
    assert params[7] == 0.95


# --- refresh_confirmation_status -----------------------------------------


def test_refresh_confirmation_status_calls_promote_sql():
    """db_client.batch 로 promote-to-confirmed SQL 한 번 실행."""
    db = MagicMock()
    db.batch.return_value = MagicMock(rows_written=3)
    promoted = refresh_confirmation_status(
        db_client=db, now_iso="2026-05-07T00:00:00Z",
    )
    assert promoted == 3
    db.batch.assert_called_once()
    [(stmts,), _kwargs] = [db.batch.call_args.args, db.batch.call_args.kwargs]
    assert len(stmts) == 1
    sql, params = stmts[0]
    assert "UPDATE music_show_wins_log" in sql
    assert "status = 'confirmed'" in sql
    assert "EXISTS" in sql.upper()
    assert params == ["2026-05-07T00:00:00Z"]


# --- backfill_music_show_wins (end-to-end with fakes) --------------------


def test_backfill_end_to_end_with_fakes(monkeypatch):
    """전체 파이프라인의 happy path:
       2개 query → fetch → 1 cached + 2 todo → LLM extract (1 win + 1 miss)
       → cache 2 + wins_log 1 statement 생성.
    """
    # 1) build_queries → 2 쿼리만 사용하도록 group/program 축소
    queries_built = build_queries(group_keys=["plave"], programs=["쇼챔피언"])
    assert len(queries_built) == 2   # 영/한 alias

    # 2) fetch_all_articles 가 3 개 article 반환하도록 patch
    fetched = [_art("h_cached"), _art("h_new1"), _art("h_new2")]
    monkeypatch.setattr(
        ms, "fetch_all_articles",
        lambda *a, **k: fetched,
    )

    # 3) DB cache 가 h_cached 만 가지고 있음
    db = MagicMock()
    db.execute.return_value = [{"url_hash": "h_cached"}]

    # 4) Gemini fake — 2개 todo article 중 h_new1 = win, h_new2 = miss
    fake_gemini = MagicMock()
    fake_gemini.generate.return_value = {
        "items": [
            {
                "article_id": "h_new1",
                "is_music_show_win": True,
                "program": "쇼챔피언",
                "episode_date": "2026-04-23",
                "group_key": "plave",
                "confidence": 0.9,
                "reasoning": "쇼챔피언 1위 명시",
            },
            {
                "article_id": "h_new2",
                "is_music_show_win": False,
                "confidence": 0.3,
                "reasoning": "음원 차트 1위 언급, 음방 아님",
            },
        ],
    }

    result = backfill_music_show_wins(
        fetcher=MagicMock(),
        gemini_client=fake_gemini,
        db_client=db,
        group_keys=["plave"],
        programs=["쇼챔피언"],
        sleeper=lambda _: None,
        sleep_seconds=0,
        now_iso="2026-05-07T00:00:00Z",
    )

    # cache 2 (h_new1, h_new2) + wins_log 1 (h_new1) = 3 statements
    sqls = [s for s, _ in result.statements]
    cache_count = sum(1 for s in sqls if "music_show_extraction_cache" in s)
    log_count = sum(1 for s in sqls if "music_show_wins_log" in s)
    assert cache_count == 2
    assert log_count == 1
    # rows_inserted 는 win=true 인 record 수 (1)
    assert result.rows_inserted == 1
    # LLM 은 1번 call (todo 2 < batch_size 8)
    fake_gemini.generate.assert_called_once()
