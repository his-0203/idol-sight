from unittest.mock import MagicMock

from idol_sight.llm.weekly import generate_weekly


def _stub_db():
    db = MagicMock()
    # Stub out the five context queries used by build_context().
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
    # The result is a list of statements ready for D1.batch().
    assert len(result.statements) == 1
    sql, params = result.statements[0]
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
    sql, params = result.statements[0]
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
    _sql, params = result.statements[0]
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
    titles = [params[4] for _sql, params in result.statements]
    assert "MiiWAN ok" in titles
    assert "PLAVE ok" in titles
    assert "MyRAKL leak" not in titles
    assert "no scope" not in titles
    assert len(result.statements) == 2


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
    _sql, params = result.statements[0]
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
