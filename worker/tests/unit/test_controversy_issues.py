"""Tests for V2.55 controversy issue clustering (analysis/controversy_issues)."""
from datetime import UTC, datetime
from unittest.mock import MagicMock

from idol_sight.analysis.controversy_issues import (
    SEVERITY_WEIGHTS,
    build_for_group,
    effective_weight,
    is_stale,
    parse_issues,
)

# ─── parse_issues (순수) ─────────────────────────────────────────────────


def test_parse_issues_keeps_valid_and_drops_ghosts():
    parsed = {
        "issues": [
            {"label": "재판 관련", "severity": "high", "post_hashes": ["a", "b"]},
            {"label": "  ", "severity": "low", "post_hashes": ["c"]},  # empty label
            {"label": "무해", "severity": "bogus", "post_hashes": ["d"]},  # bad sev
            {"label": "빈 해시", "severity": "medium", "post_hashes": []},  # no hashes
            {"label": "정상", "severity": "low", "post_hashes": ["e"]},
        ],
    }
    out = parse_issues(parsed)
    assert [i["label"] for i in out] == ["재판 관련", "정상"]
    assert out[0]["severity"] == "high"


def test_parse_issues_handles_malformed_input():
    assert parse_issues({}) == []
    assert parse_issues({"issues": None}) == []
    assert parse_issues({"issues": ["notadict", 3]}) == []


def test_parse_issues_filters_non_string_hashes():
    parsed = {"issues": [
        {"label": "x", "severity": "high", "post_hashes": ["a", 5, None, "b"]},
    ]}
    out = parse_issues(parsed)
    assert out[0]["post_hashes"] == ["a", "b"]


# ─── effective_weight (순수) ─────────────────────────────────────────────


def test_effective_weight_sums_severity():
    issues = [
        {"severity": "high"}, {"severity": "medium"}, {"severity": "low"},
    ]
    # 3 + 2 + 1
    assert effective_weight(issues) == 6.0
    assert effective_weight([]) == 0.0
    assert SEVERITY_WEIGHTS == {"low": 1, "medium": 2, "high": 3}


# ─── is_stale (순수) ─────────────────────────────────────────────────────


def test_is_stale_threshold():
    now = datetime(2026, 7, 20, 12, 0, 0, tzinfo=UTC)
    assert is_stale(None, now=now) is True
    assert is_stale("", now=now) is True
    assert is_stale("garbage", now=now) is True
    # 7일 전 = fresh, 9일 전 = stale (경계 8일).
    assert is_stale("2026-07-13T12:00:00Z", now=now) is False
    assert is_stale("2026-07-11T11:00:00Z", now=now) is True
    # Z 없는 naive 값도 처리(now tz 부여).
    assert is_stale("2026-07-19T12:00:00", now=now) is False


# ─── build_for_group (I/O) ───────────────────────────────────────────────


def _client(rows):
    client = MagicMock()

    def _execute(sql, params=None):
        if "FROM community_posts" in sql:
            return rows
        return []

    client.execute.side_effect = _execute
    return client


def _gemini(issues):
    g = MagicMock()
    g.generate.side_effect = lambda **_: {"issues": issues}
    return g


def test_build_emits_upsert_with_weight():
    rows = [
        {"url_hash": "a", "title": "재판 1심"},
        {"url_hash": "b", "title": "재판 항소"},
    ]
    gemini = _gemini([
        {"label": "재판", "severity": "high", "post_hashes": ["a", "b"]},
    ])
    stmts = build_for_group(
        _client(rows), gemini,
        group_key="isedol", group_name_kr="이세돌", computed_at="2026-07-20T00:00:00Z",
    )
    assert len(stmts) == 1
    sql, params = stmts[0]
    assert "INSERT INTO controversy_issues" in sql
    # params: [group_key, computed_at, issue_count, effective_weight, issues_json]
    assert params[0] == "isedol"
    assert params[2] == 1          # 1 issue
    assert params[3] == 3.0        # high weight
    assert "재판" in params[4]


def test_build_deletes_when_no_posts():
    gemini = _gemini([])
    stmts = build_for_group(
        _client([]), gemini,
        group_key="stellive", group_name_kr="스텔라이브", computed_at="t",
    )
    assert len(stmts) == 1
    sql, params = stmts[0]
    assert "DELETE FROM controversy_issues" in sql
    assert params == ["stellive"]
    gemini.generate.assert_not_called()


def test_build_keeps_row_on_gemini_failure():
    rows = [{"url_hash": "a", "title": "x"}]
    gemini = MagicMock()
    gemini.generate.side_effect = RuntimeError("boom")
    stmts = build_for_group(
        _client(rows), gemini,
        group_key="g", group_name_kr="g", computed_at="t",
    )
    # 기존 행 유지 = 아무 statement 도 내지 않음(DELETE 도 안 함).
    assert stmts == []
