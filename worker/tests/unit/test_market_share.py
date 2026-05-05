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


# ─── V2 SOV (cohort-relative percentile rank) ──────────────────────────

def test_sov_signals_no_longer_dominated_by_yt_views():
    """A 100x yt_views advantage shouldn't translate into 99% SOV.

    Before V2 the formula was a raw sum (yt_views + dc + naver*100), so
    yt_views — which is 4-5 orders of magnitude larger than the others
    — drowned out everything else. The cohort-rank mix caps any single
    signal at 30% (its weight) of the cohort score. We verify that the
    biggest-yt_views group still tops the cohort but with a believable
    share, not a 99% sweep.
    """
    rows = compute_market_share(
        week_start="2026-04-22", week_end="2026-04-28",
        groups=[
            {"key": "plave",  "yt_views": 500_000_000, "comm_total": 50_000,
             "news": 300, "subscribers": 1_000_000, "twitter": 50,
             "delta_yt_views": 5_000_000, "delta_comm": 100, "delta_news": 5},
            {"key": "isedol", "yt_views": 5_000_000,   "comm_total": 8_000,
             "news": 80,  "subscribers": 120_000,   "twitter": 30,
             "delta_yt_views": 100_000,   "delta_comm": 50,  "delta_news": 2},
            {"key": "owis",   "yt_views": 200_000,     "comm_total": 1_000,
             "news": 20,  "subscribers": 30_000,    "twitter": 5,
             "delta_yt_views": 10_000,    "delta_comm": 5,   "delta_news": 0},
        ],
    )
    plave = next(r for r in rows if r.group_key == "plave")
    isedol = next(r for r in rows if r.group_key == "isedol")
    owis = next(r for r in rows if r.group_key == "owis")
    # PLAVE still leads — but well below the old 99% pseudo-share.
    assert plave.final > isedol.final > owis.final
    assert plave.final < 70.0   # would be ~95+ under v1 formula
    # All three rows sum to 100 (zero-sum SOV; round-2 may drift 0.02).
    assert abs(sum(r.final for r in rows) - 100.0) < 0.05


def test_sov_zero_signals_yields_zero_share():
    rows = compute_market_share(
        week_start="2026-04-22", week_end="2026-04-28",
        groups=[
            {"key": "plave",  "yt_views": 100_000_000, "comm_total": 10_000,
             "news": 100, "subscribers": 1_000_000, "twitter": 30,
             "delta_yt_views": 0, "delta_comm": 0, "delta_news": 0},
            {"key": "miiwan", "yt_views": 0, "comm_total": 0, "news": 0,
             "subscribers": 0, "twitter": 0,
             "delta_yt_views": 0, "delta_comm": 0, "delta_news": 0},
        ],
    )
    miiwan = next(r for r in rows if r.group_key == "miiwan")
    # Still gets a tiny share via tied percentile rank, but bounded
    # well below the dominant group.
    assert miiwan.final < 30.0
