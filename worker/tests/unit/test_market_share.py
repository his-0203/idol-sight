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
    # all-zero signals now contribute nothing → exactly 0
    assert miiwan.final == 0.0


# ─── P1 §3.1 SOV normalization bug + §3.5 Twitter removal ───────────────

def test_percentile_rank_all_equal_signal_injects_no_constant():
    """A cohort-wide tie (every group identical, incl. all-zero) carries no
    ranking information, so every element is None — NOT the old 0.5 constant
    that flattened the SOV distribution toward uniform.

    Pre-fix:  _percentile_rank([0, 0, 0])  == [0.5, 0.5, 0.5]
    Post-fix: _percentile_rank([0, 0, 0])  == [None, None, None]
    """
    from idol_sight.analysis.market_share import _percentile_rank
    assert _percentile_rank([0.0, 0.0, 0.0]) == [None, None, None]
    assert _percentile_rank([7.0, 7.0]) == [None, None]
    # Non-degenerate signals still rank normally (unchanged behavior).
    assert _percentile_rank([0.0, 1.0]) == [0.0, 1.0]


def test_compose_score_renormalizes_over_available_signals():
    """Unavailable signals (None rank) are dropped and the remaining weights
    re-normalized — they are NOT scored as a 0 contribution that would shrink
    every group's score by the dead signal's weight.
    """
    from idol_sight.analysis.market_share import _compose_score, SOV_WEIGHTS
    # Only yt_views present, ranked 1.0 → full 1.0 (weight renormalized to 1).
    only_yt = {"yt_views": 1.0, "community": None,
               "news": None, "subscribers": None}
    assert abs(_compose_score(only_yt) - 1.0) < 1e-9
    # yt_views 1.0 + community 0.0, rest dead → 0.33/(0.33+0.28) ≈ 0.541.
    two_live = {"yt_views": 1.0, "community": 0.0,
                "news": None, "subscribers": None}
    assert abs(_compose_score(two_live) - (0.33 / (0.33 + 0.28))) < 1e-9
    # No signal available → 0.0 (no constant injected).
    assert _compose_score({k: None for k in SOV_WEIGHTS}) == 0.0


def test_sov_weights_sum_to_one_and_exclude_twitter():
    """§3.5: twitter dropped, its 0.10 redistributed → 4 signals, sum 1.0."""
    from idol_sight.analysis.market_share import SOV_WEIGHTS
    assert "twitter" not in SOV_WEIGHTS
    assert set(SOV_WEIGHTS) == {"yt_views", "community", "news", "subscribers"}
    assert SOV_WEIGHTS == {
        "yt_views": 0.33, "community": 0.28, "news": 0.22, "subscribers": 0.17,
    }
    assert abs(sum(SOV_WEIGHTS.values()) - 1.0) < 1e-9


def test_sov_dead_signal_no_longer_flattens_distribution():
    """§3.1: when ONE signal is cohort-wide dead (news all-zero) and momentum
    is dead (all deltas 0), the remaining live signals' spread must be
    preserved, not compressed toward uniform by a 0.5 floor.

    Live cum signals rank A:B:C as 1.0:0.5:0.0 (values 1000:100:10), so the
    intended SOV is the clean 66.67 / 33.33 / 0 split (×0.6 cum weight, mom
    dead → 0).

    Pre-fix (news→0.5, twitter→0.5, mom all→0.5):
        A.final ≈ 47.33, B.final ≈ 33.33, C.final ≈ 19.33   (C floored up!)
    Post-fix (dead signals dropped):
        A.final == 40.0,  B.final == 20.0,  C.final == 0.0
    """
    rows = compute_market_share(
        week_start="2026-04-22", week_end="2026-04-28",
        groups=[
            {"key": "a", "yt_views": 1000, "comm_total": 1000, "news": 0,
             "subscribers": 1000,
             "delta_yt_views": 0, "delta_comm": 0, "delta_news": 0},
            {"key": "b", "yt_views": 100, "comm_total": 100, "news": 0,
             "subscribers": 100,
             "delta_yt_views": 0, "delta_comm": 0, "delta_news": 0},
            {"key": "c", "yt_views": 10, "comm_total": 10, "news": 0,
             "subscribers": 10,
             "delta_yt_views": 0, "delta_comm": 0, "delta_news": 0},
        ],
    )
    a = next(r for r in rows if r.group_key == "a")
    b = next(r for r in rows if r.group_key == "b")
    c = next(r for r in rows if r.group_key == "c")
    # Live-signal spread preserved (2 : 1 : 0), not flattened.
    assert abs(a.final - 40.0) < 0.01
    assert abs(b.final - 20.0) < 0.01
    assert c.final == 0.0
    # Dead news signal injects no floor: the bottom group stays at 0.
    assert abs(sum(r.final for r in rows) - 60.0) < 0.05  # mom dead → cum*0.6


def test_sov_all_dead_momentum_injects_no_share():
    """§3.1: subscribers/twitter-style all-zero momentum rows must contribute
    no constant. With every delta 0, momentum carries no information → final
    is driven purely by the cumulative signals (final == cum * 0.6).

    Pre-fix: the all-zero mom signals scored 0.5 → mom_pct split the cohort
    50/50 (live 77.0 / dormant 23.0), lifting the dormant group's final.
    Post-fix: mom contributes 0 (live 60.0 / dormant 0.0).
    """
    rows = compute_market_share(
        week_start="2026-04-22", week_end="2026-04-28",
        groups=[
            {"key": "live",     "yt_views": 100, "comm_total": 100, "news": 100,
             "subscribers": 100,
             "delta_yt_views": 0, "delta_comm": 0, "delta_news": 0},
            {"key": "dormant",  "yt_views": 1,   "comm_total": 1,   "news": 1,
             "subscribers": 1,
             "delta_yt_views": 0, "delta_comm": 0, "delta_news": 0},
        ],
    )
    live = next(r for r in rows if r.group_key == "live")
    dormant = next(r for r in rows if r.group_key == "dormant")
    # cum: live 1.0 → 100%, dormant 0.0 → 0%. mom dead → 0 for both.
    assert live.mom == 0.0 and dormant.mom == 0.0
    assert abs(live.final - 60.0) < 0.01    # 100% cum * 0.6
    assert dormant.final == 0.0


def test_sov_normal_cohort_relative_rank_preserved():
    """§3.1 acceptance (3): an ordinary cohort with every signal live keeps
    its relative ranking after the fix. Distinct, monotonic signals → the
    same A > B > C order, now with twitter removed and re-weighted.

    Pre-fix (5 signals incl twitter, mom subscribers/twitter→0.5):
        A.final ≈ 61.33, B.final ≈ 33.33, C.final ≈ 5.33   (C floored up)
    Post-fix (4 signals, dead mom subscribers dropped):
        A.final == 66.67, B.final == 33.33, C.final == 0.0
    Ordering A > B > C is preserved across the change (intended).
    """
    rows = compute_market_share(
        week_start="2026-04-22", week_end="2026-04-28",
        groups=[
            {"key": "a", "yt_views": 1000, "comm_total": 1000, "news": 1000,
             "subscribers": 1000,
             "delta_yt_views": 100, "delta_comm": 100, "delta_news": 100},
            {"key": "b", "yt_views": 100, "comm_total": 100, "news": 100,
             "subscribers": 100,
             "delta_yt_views": 10, "delta_comm": 10, "delta_news": 10},
            {"key": "c", "yt_views": 10, "comm_total": 10, "news": 10,
             "subscribers": 10,
             "delta_yt_views": 1, "delta_comm": 1, "delta_news": 1},
        ],
    )
    a = next(r for r in rows if r.group_key == "a")
    b = next(r for r in rows if r.group_key == "b")
    c = next(r for r in rows if r.group_key == "c")
    assert a.final > b.final > c.final          # relative rank preserved
    assert abs(a.final - 66.67) < 0.01
    assert abs(b.final - 33.33) < 0.01
    assert c.final == 0.0
    assert abs(sum(r.final for r in rows) - 100.0) < 0.05
