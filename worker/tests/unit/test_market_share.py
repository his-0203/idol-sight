from idol_sight.analysis.market_share import compute_market_share


def test_shares_sum_to_100_for_active_groups():
    rows = compute_market_share(
        week_start="2026-04-22", week_end="2026-04-28",
        groups=[
            {"key": "plave",  "cum_score": 1000, "mom_score": 100},
            {"key": "isedol", "cum_score": 200,  "mom_score": 50},
            {"key": "owis",   "cum_score": 100,  "mom_score": 20},
        ],
    )
    assert len(rows) == 3
    final_total = sum(r.final for r in rows)
    assert abs(final_total - 100.0) < 0.01


def test_returns_zero_for_groups_with_zero_score():
    rows = compute_market_share(
        week_start="2026-04-22", week_end="2026-04-28",
        groups=[
            {"key": "plave",  "cum_score": 1000, "mom_score": 100},
            {"key": "miiwan", "cum_score": 0,    "mom_score": 0},
        ],
    )
    assert rows[1].final == 0.0


def test_cum_60_mom_40_weighting():
    rows = compute_market_share(
        week_start="2026-04-22", week_end="2026-04-28",
        groups=[
            {"key": "a", "cum_score": 1000, "mom_score": 0},     # all cumulative
            {"key": "b", "cum_score": 0,    "mom_score": 100},   # all momentum
        ],
    )
    a, b = rows
    assert abs(a.cum - 100.0) < 0.01
    assert abs(b.mom - 100.0) < 0.01
    # final = cum*0.6 + mom*0.4
    assert abs(a.final - 60.0) < 0.01
    assert abs(b.final - 40.0) < 0.01


def test_to_statements_emits_one_per_group():
    from idol_sight.analysis.market_share import to_statements
    rows = compute_market_share(
        week_start="2026-04-22", week_end="2026-04-28",
        groups=[
            {"key": "plave", "cum_score": 1000, "mom_score": 100},
        ],
    )
    statements = to_statements(rows, market_total=10_000)
    assert len(statements) == 1
    sql, params = statements[0]
    assert "agg_market_share" in sql
    assert params[2] == "plave"
    assert params[6] == 10_000
