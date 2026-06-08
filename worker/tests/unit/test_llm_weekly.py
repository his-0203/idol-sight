from unittest.mock import MagicMock

from idol_sight.llm.weekly import generate_weekly


def _insert_stmts(result):
    """INSERT INTO insights statements only — generate_weekly now leads with a
    `DELETE FROM insights WHERE week_start=?` rebuild (idempotency), so tests
    that assert on the inserts must skip that leading DELETE."""
    return [(s, p) for s, p in result.statements if "INSERT INTO insights" in s]


def _stub_db():
    db = MagicMock()
    # Stub out the five context queries used by build_context() PLUS the
    # thirteen queries used by compute_group_signals() (called from inside
    # build_context post-Task 5). Empty rows for the diagnosis queries
    # keeps these legacy tests focused on ai_comment / ipx_action behavior.
    db.execute.side_effect = [
        # last 7d agg_summary
        [{"group_key": "plave", "yt_total_views": 160000000, "naver_total_news": 282}],
        # prev 7d
        [{"group_key": "plave", "yt_total_views": 159000000, "naver_total_news": 270}],
        # hanteo latest
        [{"group_key": "plave", "album": "Caligo Pt.2", "rank": 2, "sales": 991850}],
        # market_share latest
        [{"group_key": "plave", "final": 65.0}],
        # top news per group
        [{"group_key": "plave", "title": "PLAVE 신곡", "source": "naver"}],
        # compute_group_signals — 13 추가 쿼리, 모두 빈 결과
        [],   # last_7d (signals)
        [],   # prev_7d (signals)
        [],   # organicity
        [],   # group_events
        [],   # music_show_wins_log
        [],   # comm_kw_now
        [],   # comm_kw_past
        [],   # twitter
        [],   # irrelevant
        [],   # member_pop
        [],   # groups meta (rev 3)
        [],   # agg_summary history (rev 3)
        [],   # agg_market_share (2026-05-26 stub 활성화)
        [],   # hanteo_weekly sales (comeback_boost)
        [],   # youtube_videos weekly upload counts (comeback_boost)
        [],   # community_posts titles (community_keywords_topic)
    ]
    return db


def test_generate_weekly_calls_gemini_with_built_context():
    gemini = MagicMock()
    gemini.generate.return_value = {
        "items": [{
            "scope": "market", "type": "weekly",
            "title": "T", "body": "B",
            "source_refs": [{"table": "agg_summary", "pk": "plave|w", "label": "L"}],
        }],
    }

    db = _stub_db()
    result = generate_weekly(
        db=db, gemini=gemini,
        week_start="2026-04-22", week_end="2026-04-28",
    )

    gemini.generate.assert_called_once()
    # statements = [leading DELETE rebuild, INSERT...]. One item → one INSERT.
    assert result.statements[0][0].startswith("DELETE FROM insights")
    inserts = _insert_stmts(result)
    assert len(inserts) == 1
    sql, params = inserts[0]
    assert "INSERT INTO insights" in sql
    # ai_comment column must be present in the INSERT — frontend slot
    # depends on it. NULL is allowed but the column must be there.
    assert "ai_comment" in sql
    # source_refs_json column is JSON-encoded.
    import json
    refs = json.loads(params[6])
    assert refs[0]["pk"] == "plave|w"


def test_generate_weekly_inserts_null_ai_comment_when_absent():
    """LLM dropped the key entirely — INSERT must still succeed and
    bind NULL so the UI silently omits the AI badge."""
    gemini = MagicMock()
    gemini.generate.return_value = {
        "items": [{
            "scope": "miiwan", "type": "insight",
            "title": "T", "body": "B",
            "source_refs": [{"table": "agg_summary", "pk": "miiwan|w", "label": "L"}],
            # NOTE: no ai_comment key — Gemini occasionally drops it.
        }],
    }
    result = generate_weekly(
        db=_stub_db(), gemini=gemini,
        week_start="2026-04-22", week_end="2026-04-28",
    )
    sql, params = _insert_stmts(result)[0]
    # ai_comment is the 8th bound param after migration 0039.
    assert params[7] is None
    # Sanity: the column appears in the column list of the INSERT.
    assert "ai_comment" in sql


def test_generate_weekly_inserts_null_ai_comment_when_empty_string():
    """Whitespace-only or empty ai_comment is normalized to NULL — the
    frontend `i.ai_comment && (...)` guard would otherwise render an
    empty AI badge."""
    gemini = MagicMock()
    gemini.generate.return_value = {
        "items": [{
            "scope": "market", "type": "insight",
            "title": "T", "body": "B",
            "ai_comment": "   ",
            "source_refs": [{"table": "agg_summary", "pk": "plave|w", "label": "L"}],
        }],
    }
    result = generate_weekly(
        db=_stub_db(), gemini=gemini,
        week_start="2026-04-22", week_end="2026-04-28",
    )
    _sql, params = _insert_stmts(result)[0]
    assert params[7] is None


def test_ipx_action_with_non_miiwan_scope_is_dropped():
    """V2.20.1 post-validation guard. Gemini occasionally violates the
    'ipx_action MUST be miiwan scope' prompt rule (Korean dashboards
    showed myrakl ipx_action cards on 2026-05-07). Schema has no enum
    enforcement, so we filter at the INSERT stage. Only ipx_action /
    non-miiwan combos are dropped — `insight` items for any group are
    fine; `ipx_action` for miiwan is fine.
    """
    gemini = MagicMock()
    gemini.generate.return_value = {
        "items": [
            # KEEP: ipx_action + miiwan scope
            {"scope": "miiwan", "type": "ipx_action",
             "title": "MiiWAN ok", "body": "B",
             "source_refs": [{"table": "agg_summary", "pk": "miiwan|w", "label": "L"}]},
            # DROP: ipx_action + non-miiwan scope
            {"scope": "myrakl", "type": "ipx_action",
             "title": "MyRAKL leak", "body": "B",
             "source_refs": [{"table": "agg_summary", "pk": "myrakl|w", "label": "L"}]},
            # KEEP: insight + non-miiwan (insights about other groups are OK)
            {"scope": "plave", "type": "insight",
             "title": "PLAVE ok", "body": "B",
             "source_refs": [{"table": "agg_summary", "pk": "plave|w", "label": "L"}]},
            # DROP: ipx_action + null/missing scope (defaults to "market")
            {"type": "ipx_action",
             "title": "no scope", "body": "B",
             "source_refs": [{"table": "agg_summary", "pk": "x|w", "label": "L"}]},
        ],
    }
    result = generate_weekly(
        db=_stub_db(), gemini=gemini,
        week_start="2026-04-22", week_end="2026-04-28",
    )
    titles = [params[4] for _sql, params in _insert_stmts(result)]
    assert "MiiWAN ok" in titles
    assert "PLAVE ok" in titles
    assert "MyRAKL leak" not in titles
    assert "no scope" not in titles
    assert len(_insert_stmts(result)) == 2


def test_generate_weekly_persists_ai_comment_when_present():
    """Happy path — when Gemini emits a 함의 평어, it ends up in the
    last bound parameter so D1 stores it as the ai_comment column."""
    gemini = MagicMock()
    gemini.generate.return_value = {
        "items": [{
            "scope": "miiwan", "type": "ipx_action",
            "title": "카운트다운 D-30",
            "body": "오늘부터 매일 18시 1컷 업로드.",
            "ai_comment": "운영 부담 분산 — 사전 제작본 5건 확보 권장.",
            "source_refs": [{"table": "agg_summary", "pk": "miiwan|w", "label": "L"}],
        }],
    }
    result = generate_weekly(
        db=_stub_db(), gemini=gemini,
        week_start="2026-04-22", week_end="2026-04-28",
    )
    _sql, params = _insert_stmts(result)[0]
    assert params[7] == "운영 부담 분산 — 사전 제작본 5건 확보 권장."


def test_prompt_weekly_includes_diagnosis_guidelines():
    """PROMPT_WEEKLY 에 _DIAGNOSIS_GUIDELINES 섹션이 들어있는지 sanity."""
    from idol_sight.llm.prompts import PROMPT_WEEKLY
    # 가설 카탈로그 enum 의 핵심 키들이 프롬프트에 노출돼 있어야 함.
    for kw in ("organic_growth", "paid_youtube_ads", "subscriber_purchase",
               "comeback_cycle", "controversy_spike",
               "platform_concentrated_promo", "member_centric_spike"):
        assert kw in PROMPT_WEEKLY
    # type='diagnosis' 카드 형식 설명이 있어야 함.
    assert "diagnosis" in PROMPT_WEEKLY
    # 단정 어조 금지 가드 (가능성/의심/시사 사용 유도)
    assert "가능성" in PROMPT_WEEKLY or "의심" in PROMPT_WEEKLY
    # Streisand 가드
    assert "Streisand" in PROMPT_WEEKLY or "검수" in PROMPT_WEEKLY


def test_prompt_weekly_covers_all_canonical_hypotheses():
    """PROMPT_WEEKLY 가 HYPOTHESIS_KEYS 의 10 가설 모두 substring 으로 포함.

    weekly_diagnosis 의 enum 이 단일 source of truth — prompt drift 방지.
    한 가설이 enum block 에서 누락되면 LLM 이 그 가설명을 발명하거나 omit 한다.
    """
    from idol_sight.analysis.weekly_diagnosis import HYPOTHESIS_KEYS
    from idol_sight.llm.prompts import PROMPT_WEEKLY
    for key in HYPOTHESIS_KEYS:
        assert key in PROMPT_WEEKLY, f"hypothesis {key!r} missing from prompt"


def test_prompt_weekly_diagnosis_operational_guards():
    """type='diagnosis' 카드의 핵심 운영 가드 표현이 모두 substring 으로 존재.

    Streisand 가드 (controversy_spike), subscriber_purchase 검증 어려움 명시,
    MiiWAN scope ipx_action 자동 변환 규칙. 이 표현들이 drift 로 빠지면
    운영 안전망이 사라진다.
    """
    from idol_sight.llm.prompts import PROMPT_WEEKLY
    # Streisand 가드 — controversy 카드 false positive 대응
    assert "Streisand 회피" in PROMPT_WEEKLY
    # subscriber_purchase 검증 어려움 명시 — 단정 회피
    # ("검증 어려운\n  가설" 처럼 줄바꿈으로 분리될 수 있어 핵심 어구만 확인)
    assert "검증 어려운" in PROMPT_WEEKLY
    # MiiWAN scope → ipx_action 자동 변환 규칙
    assert "ipx_action" in PROMPT_WEEKLY


def _stub_db_with_signals():
    """build_context 의 기존 5 + compute_group_signals 의 13 쿼리 stub."""
    db = MagicMock()
    db.execute.side_effect = [
        # build_context 의 기존 5 쿼리
        [{"group_key": "plave", "yt_total_views": 200_000_000, "yt_subscribers": 1_200_000,
          "yt_likes_total": 2_000_000, "yt_comments_total": 300_000,
          "naver_total_news": 350,
          "dc_total_posts": 5000, "theqoo_posts": 2000, "instiz_posts": 1000,
          "controversy_count": 1, "negative_ratio": 0.04,
          "reactivity_dc": 1.5, "reactivity_theqoo": 1.4, "reactivity_instiz": 1.3,
          "reactivity_naver": 1.5, "reactivity_sample": 5,
          "data_source": "live"}],   # last_7d
        [{"group_key": "plave", "yt_total_views": 175_000_000, "yt_subscribers": 1_000_000,
          "yt_likes_total": 1_800_000, "yt_comments_total": 280_000,
          "naver_total_news": 280,
          "dc_total_posts": 3000, "theqoo_posts": 1500, "instiz_posts": 700,
          "data_source": "live"}],   # prev_7d
        [{"group_key": "plave", "album": "X", "rank": 2, "sales": 991_850}],
        [{"group_key": "plave", "final": 65.0}],
        [{"group_key": "plave", "title": "n", "source": "naver"}],
        # compute_group_signals 의 추가 13 쿼리 — 빈 결과 또는 minimal
        [],   # last_7d
        [],   # prev_7d
        [],   # organicity
        [],   # group_events
        [],   # music_show_wins_log
        [],   # comm_kw_now
        [],   # comm_kw_past
        [],   # twitter
        [],   # irrelevant
        [],   # member_pop
        [],   # groups meta (rev 3)
        [],   # agg_summary history (rev 3)
        [],   # agg_market_share (2026-05-26 stub 활성화)
        [],   # hanteo_weekly sales (comeback_boost)
        [],   # youtube_videos weekly upload counts (comeback_boost)
        [],   # community_posts titles (community_keywords_topic)
    ]
    return db


def test_generate_weekly_serializes_signals_json_when_diagnosis():
    """type='diagnosis' 카드는 signals_json 컬럼에 GroupSignals payload 직렬화."""
    from unittest.mock import patch

    from idol_sight.analysis.weekly_diagnosis import (
        Evidence,
        GroupSignals,
        Hypothesis,
    )

    gemini = MagicMock()
    gemini.generate.return_value = {
        "items": [{
            "scope": "plave", "type": "diagnosis",
            "title": "PLAVE paid 의심", "body": "본문",
            "ai_comment": "함의",
            "source_refs": [{"table": "agg_summary", "pk": "plave|w", "label": "L"}],
        }],
    }
    db = _stub_db_with_signals()    # 새 stub: build_context 가 signals 도 채움

    # compute_group_signals 가 실제 데이터 흐름에서 빈 결과를 받을 때 hypotheses
    # 가 비기 쉬워, 직렬화 검증을 위해 패치로 1개 시그널 강제 점등 케이스를
    # 주입한다. (real compute_group_signals 의 동작은 weekly_diagnosis 의
    # 자체 test 가 검증)
    fake_signals = {
        "plave": GroupSignals(
            group_key="plave",
            hypotheses=[
                Hypothesis(
                    key="paid_youtube_ads",
                    confidence="high",
                    evidence=[
                        Evidence(key="views_z", value=2.5, label="조회 z=2.5"),
                    ],
                ),
                Hypothesis(
                    key="subscriber_purchase",
                    confidence="medium",
                    evidence=[
                        Evidence(key="subs_z", value=2.6, label="구독 z=2.6"),
                    ],
                ),
            ],
            meta_guards=["irrelevant_high"],
            deltas={"subs_z": 2.6, "views_z": 2.5, "news_z": 0.4},
            organicity={"paid_ratio": 0.55},
        ),
    }
    with patch(
        "idol_sight.llm.weekly.compute_group_signals",
        return_value=fake_signals,
    ):
        result = generate_weekly(
            db=db, gemini=gemini,
            week_start="2026-04-22", week_end="2026-04-28",
        )
    sql, params = _insert_stmts(result)[0]
    # signals_json 컬럼이 INSERT 에 포함돼 있어야 함
    assert "signals_json" in sql
    # signals_json 은 9번째 bind param (index 8); 마지막(index 9)은 report_kind.
    signals_json_value = params[8]
    assert signals_json_value is not None
    import json
    payload = json.loads(signals_json_value)
    assert "hypothesis_primary" in payload
    assert payload["hypothesis_primary"] == "paid_youtube_ads"
    assert payload["hypothesis_alternative"] == "subscriber_purchase"
    assert payload["confidence"] == "high"
    assert payload["meta_guards"] == ["irrelevant_high"]
    assert isinstance(payload["evidence"], list)


def test_generate_weekly_signals_json_null_for_non_diagnosis():
    """type='insight' 카드는 signals_json NULL."""
    gemini = MagicMock()
    gemini.generate.return_value = {
        "items": [{
            "scope": "market", "type": "weekly",
            "title": "T", "body": "B",
            "source_refs": [{"table": "agg_summary", "pk": "plave|w", "label": "L"}],
        }],
    }
    result = generate_weekly(
        db=_stub_db_with_signals(), gemini=gemini,
        week_start="2026-04-22", week_end="2026-04-28",
    )
    sql, params = _insert_stmts(result)[0]
    assert "signals_json" in sql
    assert params[8] is None  # signals_json at index 8; report_kind is index 9


def test_generate_weekly_empty_items_emits_no_statements():
    """No accepted items → no DELETE, no INSERT, so an empty/failed LLM run
    can't wipe the week's existing insights (the rebuild DELETE is guarded)."""
    gemini = MagicMock()
    gemini.generate.return_value = {"items": []}
    result = generate_weekly(
        db=_stub_db(), gemini=gemini,
        week_start="2026-04-22", week_end="2026-04-28",
    )
    assert result.statements == []


def test_generate_weekly_interim_kind_threads_to_delete_and_insert():
    """report_kind='interim' 이면 DELETE 가 kind 스코프이고 INSERT 의
    report_kind 컬럼 값이 'interim' 이어야 한다 (수=중간점검 / 일=결산 공존)."""
    gemini = MagicMock()
    gemini.generate.return_value = {
        "items": [{
            "scope": "miiwan", "type": "weekly",
            "title": "T", "body": "B",
            "source_refs": [{"table": "agg_summary", "pk": "miiwan|w", "label": "L"}],
        }],
    }
    result = generate_weekly(
        db=_stub_db(), gemini=gemini,
        week_start="2026-06-07", week_end="2026-06-10",
        report_kind="interim",
    )
    # 1) DELETE 는 kind 스코프 — 같은 week_start 의 final 카드를 안 지운다.
    del_sql, del_params = result.statements[0]
    assert del_sql.startswith("DELETE FROM insights")
    assert "report_kind" in del_sql
    assert del_params == ["2026-06-07", "interim"]
    # 2) INSERT 의 report_kind 값 = 'interim' (마지막 바인드 파라미터).
    sql, params = _insert_stmts(result)[0]
    assert "report_kind" in sql
    assert params[-1] == "interim"
    # 3) 컨텍스트에 report_kind 가 주입돼 LLM 이 프레이밍할 수 있다.
    ctx = gemini.generate.call_args.kwargs["context"]
    assert ctx["report_kind"] == "interim"


def test_generate_weekly_defaults_to_final_kind():
    """report_kind 미지정(수동 dispatch / 일요일 결산 기본) → 'final'."""
    gemini = MagicMock()
    gemini.generate.return_value = {
        "items": [{
            "scope": "market", "type": "weekly", "title": "T", "body": "B",
            "source_refs": [{"table": "agg_summary", "pk": "plave|w", "label": "L"}],
        }],
    }
    result = generate_weekly(
        db=_stub_db(), gemini=gemini,
        week_start="2026-04-22", week_end="2026-04-28",
    )
    del_sql, del_params = result.statements[0]
    assert del_params == ["2026-04-22", "final"]
    sql, params = _insert_stmts(result)[0]
    assert params[-1] == "final"


def test_debut_countdown_labels():
    from datetime import date
    from idol_sight.llm.weekly import _debut_countdown
    rows = [
        {"key": "miiwan", "debut_date": "2026-06-16"},  # 미래 → D-8
        {"key": "plave",  "debut_date": "2023-03-12"},  # 과거 → D+...
        {"key": "owis",   "debut_date": "2026-06-08"},  # 당일 → D-DAY
        {"key": "nodate", "debut_date": None},          # 무시
    ]
    out = _debut_countdown(rows, date(2026, 6, 8))
    assert out["miiwan"] == {"debut_date": "2026-06-16", "days_to_debut": 8, "label": "D-8"}
    assert out["owis"]["label"] == "D-DAY"
    assert out["owis"]["days_to_debut"] == 0
    assert out["plave"]["label"].startswith("D+")
    assert out["plave"]["days_to_debut"] < 0
    assert "nodate" not in out  # debut_date None 은 제외


def test_debut_countdown_empty():
    from datetime import date
    from idol_sight.llm.weekly import _debut_countdown
    assert _debut_countdown([], date(2026, 6, 8)) == {}
