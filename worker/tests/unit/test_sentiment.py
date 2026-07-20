"""Tests for the sentiment classifier."""
from unittest.mock import MagicMock

from idol_sight.analysis.sentiment import (
    PROMPT_SENTIMENT,
    classify_for_group,
    update_negative_ratio_statements,
)


def _client(rows_by_query):
    client = MagicMock()

    def _execute(sql, params=None):
        for needle, rows in rows_by_query.items():
            if needle in sql:
                # Mimic D1 LIMIT — return all matched rows; the test
                # data is already small enough.
                return rows
        return []

    client.execute.side_effect = _execute
    return client


def _gemini_returning(mapping):
    """Fake Gemini that maps a list of url_hashes → sentiments by
    consulting the mapping dict.
    """
    g = MagicMock()

    def _generate(*, system_prompt, context, response_schema):
        out = []
        for p in context["posts"]:
            sent = mapping.get(p["url_hash"])
            if sent is None:
                continue
            out.append({"url_hash": p["url_hash"], "sentiment": sent})
        return {"classifications": out}

    g.generate.side_effect = _generate
    return g


def test_classify_emits_one_update_per_classified_post():
    posts = [
        {"url_hash": "h1", "title": "오늘 컴백 너무 좋다!!"},
        {"url_hash": "h2", "title": "[속보] 멤버 논란"},
        {"url_hash": "h3", "title": "공식 일정 안내"},
    ]
    client = _client({
        "FROM community_posts": posts,
    })
    gemini = _gemini_returning({
        "h1": "positive",
        "h2": "controversy",
        "h3": "neutral",
    })
    stmts = classify_for_group(
        client, gemini, group_key="plave", group_name_kr="플레이브",
    )
    assert len(stmts) == 3
    sentiments = {p[1][1]: p[1][0] for p in stmts}
    assert sentiments["h1"] == "positive"
    assert sentiments["h2"] == "controversy"
    assert sentiments["h3"] == "neutral"


def test_classify_skips_posts_the_llm_didnt_classify():
    """When the LLM omits a url_hash from its response we leave the
    sentiment NULL rather than guessing — better unknown than wrong.
    """
    posts = [
        {"url_hash": "h1", "title": "x"},
        {"url_hash": "h2", "title": "y"},
    ]
    client = _client({"FROM community_posts": posts})
    gemini = _gemini_returning({"h1": "positive"})  # h2 omitted
    stmts = classify_for_group(
        client, gemini, group_key="plave", group_name_kr="플레이브",
    )
    assert len(stmts) == 1
    assert stmts[0][1][1] == "h1"


def test_classify_swallows_batch_errors_and_continues():
    """One failing batch shouldn't break the whole group."""
    posts = [{"url_hash": f"h{i}", "title": f"t{i}"} for i in range(60)]
    client = _client({"FROM community_posts": posts})

    g = MagicMock()
    call = {"n": 0}

    def _generate(*, system_prompt, context, response_schema):
        call["n"] += 1
        if call["n"] == 1:
            raise RuntimeError("transient gemini 503")
        return {"classifications": [
            {"url_hash": p["url_hash"], "sentiment": "neutral"}
            for p in context["posts"]
        ]}

    g.generate.side_effect = _generate
    stmts = classify_for_group(
        client, g, group_key="plave", group_name_kr="플레이브",
    )
    # First batch (50) failed → 0 updates from it. Second batch (10) → 10.
    assert len(stmts) == 10


def test_prompt_sentiment_requires_concrete_incident():
    """V2.54: marker words alone (논란/이슈/의혹 etc.) must not be enough
    to trigger 'controversy' — the prompt has to spell out that the
    title needs to name a concrete incident."""
    assert "NOT sufficient" in PROMPT_SENTIMENT


def test_negative_ratio_skips_groups_with_zero_classified():
    client = _client({
        "FROM community_posts GROUP BY group_key": [
            {"group_key": "plave", "neg": 5,  "classified": 50},   # 10%
            {"group_key": "miiwan", "neg": 0, "classified": 0},     # nothing classified
            {"group_key": "isedol", "neg": 8,  "classified": 16},  # 50%
        ],
    })
    stmts = update_negative_ratio_statements(
        client, snapshot_at="2026-05-04T00:00:00Z",
    )
    keys = [params[1] for _sql, params in stmts]
    assert "plave" in keys and "isedol" in keys
    assert "miiwan" not in keys     # 0 classified → skip, default 0 stays

    plave_ratio = next(p[1][0] for p in stmts if p[1][1] == "plave")
    isedol_ratio = next(p[1][0] for p in stmts if p[1][1] == "isedol")
    assert abs(plave_ratio - 0.10) < 1e-6
    assert abs(isedol_ratio - 0.50) < 1e-6


def test_classify_returns_empty_when_no_unclassified_rows():
    client = _client({"FROM community_posts": []})
    gemini = MagicMock()
    stmts = classify_for_group(
        client, gemini, group_key="plave", group_name_kr="플레이브",
    )
    assert stmts == []
    gemini.generate.assert_not_called()
