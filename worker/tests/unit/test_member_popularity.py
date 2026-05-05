from idol_sight.analysis.member_popularity import compute_member_popularity


def _members(*items):
    """Helper: turn (name, yt_score, comm_score, yt_videos, yt_avg, mentions) tuples
    into the input dict shape."""
    out = []
    for name, yt, comm, vid, avg, ment in items:
        out.append({
            "name": name, "yt_score": yt, "community_score": comm,
            "yt_videos": vid, "yt_avg_views": avg, "community_mentions": ment,
            "yt_sufficient": vid >= 3,
        })
    return out


def test_balanced_group_has_low_hhi():
    pop = compute_member_popularity(
        group_key="plave",
        members=_members(
            ("노아", 50, 50, 5, 1_000_000, 100),
            ("예준", 50, 50, 5, 1_000_000, 100),
            ("하민", 50, 50, 5, 1_000_000, 100),
            ("밤비", 50, 50, 5, 1_000_000, 100),
            ("은호", 50, 50, 5, 1_000_000, 100),
        ),
    )
    assert pop.status == "ok"
    assert pop.hhi is not None and pop.evenness is not None
    # Perfectly balanced → HHI = 5 * (20^2) / 10000 = 0.20
    assert abs(pop.hhi - 0.20) < 0.01
    assert pop.evenness > 0.7


def test_dominant_member_has_high_hhi():
    pop = compute_member_popularity(
        group_key="plave",
        members=_members(
            ("노아", 100, 100, 10, 5_000_000, 500),
            ("예준",  10,  10,  3,   500_000,  50),
            ("하민",  10,  10,  3,   500_000,  50),
            ("밤비",  10,  10,  3,   500_000,  50),
            ("은호",  10,  10,  3,   500_000,  50),
        ),
    )
    assert pop.status == "ok"
    assert pop.hhi is not None and pop.evenness is not None
    assert pop.hhi > 0.30
    assert pop.evenness < 0.7


def test_insufficient_when_no_activity():
    pop = compute_member_popularity(
        group_key="miiwan",
        members=_members(
            ("나이선", 0, 0, 0, 0, 0),
            ("임온",   0, 0, 0, 0, 0),
            ("마하진", 0, 0, 0, 0, 0),
        ),
    )
    assert pop.status == "insufficient"
    assert pop.hhi is None
    assert pop.evenness is None


def test_to_statements_emits_pop_rows_plus_meta():
    from idol_sight.analysis.member_popularity import to_statements
    pop = compute_member_popularity(
        group_key="plave",
        members=_members(
            ("노아", 50, 50, 5, 1_000_000, 100),
            ("예준", 50, 50, 5, 1_000_000, 100),
        ),
    )
    member_id_lookup = {"노아": 1, "예준": 2}
    statements = to_statements(
        pop, snapshot_at="2026-05-04T08:00:00Z",
        member_id_lookup=member_id_lookup,
    )
    # 2 member rows + 1 pop_meta row.
    assert len(statements) == 3
    # First two SQLs go to agg_member_popularity.
    assert "agg_member_popularity" in statements[0][0]
    assert "agg_member_popularity" in statements[1][0]
    # Last SQL goes to agg_member_pop_meta.
    assert "agg_member_pop_meta" in statements[2][0]
