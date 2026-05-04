from unittest.mock import MagicMock

from idol_sight.llm.weekly import generate_weekly


def test_generate_weekly_calls_gemini_with_built_context():
    gemini = MagicMock()
    gemini.generate.return_value = {
        "items": [{
            "scope": "market", "type": "weekly",
            "title": "T", "body": "B",
            "source_refs": [{"table": "agg_summary", "pk": "plave|w", "label": "L"}],
        }],
    }

    db = MagicMock()
    # Stub out the four context queries used by build_context().
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

    result = generate_weekly(
        db=db, gemini=gemini,
        week_start="2026-04-22", week_end="2026-04-28",
    )

    gemini.generate.assert_called_once()
    # The result is a list of statements ready for D1.batch().
    assert len(result.statements) == 1
    sql, params = result.statements[0]
    assert "INSERT INTO insights" in sql
    # source_refs_json column is JSON-encoded.
    import json
    refs = json.loads(params[6])
    assert refs[0]["pk"] == "plave|w"
