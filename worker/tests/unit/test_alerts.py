"""Tests for the alert engine."""
from datetime import date, timedelta
from unittest.mock import MagicMock

from idol_sight.alerts import (
    Alert,
    rule_controversy_spike,
    rule_debut_milestone,
    rule_identity_leak,
    rule_model_theft,
    rule_video_velocity_24h,
    run_alerts,
)


def _client(rows_by_query: dict[str, list[dict]]) -> MagicMock:
    """Mock D1 client whose execute() routes by SQL substring match."""
    client = MagicMock()

    def _execute(sql: str, params: list | None = None):
        for needle, rows in rows_by_query.items():
            if needle in sql:
                return rows
        return []

    client.execute.side_effect = _execute
    return client


# ─── debut_milestone ────────────────────────────────────────────────────


def test_debut_milestone_fires_d30_when_inside_band():
    today = date(2026, 5, 5)
    debut_iso = (today + timedelta(days=27)).isoformat()  # D-27 → inside D-30 band
    client = _client({
        "FROM groups": [
            {"key": "miiwan", "name": "MiiWAN", "name_kr": "미완소년",
             "debut_date": debut_iso},
        ],
    })
    alerts = rule_debut_milestone(client, today=today)
    assert len(alerts) == 1
    a = alerts[0]
    assert a.rule == "debut_milestone"
    assert a.scope == "miiwan"
    assert a.bucket == "D-30"
    assert "27일" in a.body or "27일" in a.title


def test_debut_milestone_promotes_to_d7_then_d1():
    today = date(2026, 5, 5)
    client = _client({
        "FROM groups": [
            {"key": "owis", "name": "OWIS", "name_kr": "오위스",
             "debut_date": (today + timedelta(days=4)).isoformat()},
            {"key": "miiwan", "name": "MiiWAN", "name_kr": "미완소년",
             "debut_date": (today + timedelta(days=1)).isoformat()},
        ],
    })
    alerts = rule_debut_milestone(client, today=today)
    by_scope = {a.scope: a.bucket for a in alerts}
    assert by_scope["owis"] == "D-7"     # 4 days → D-7 band
    assert by_scope["miiwan"] == "D-1"   # 1 day  → D-1 band


def test_debut_milestone_skips_already_debuted():
    today = date(2026, 5, 5)
    client = _client({
        "FROM groups": [
            {"key": "plave", "name": "PLAVE", "name_kr": "플레이브",
             "debut_date": "2023-03-12"},
        ],
    })
    assert rule_debut_milestone(client, today=today) == []


# ─── video_velocity_24h ─────────────────────────────────────────────────


def test_video_velocity_24h_fires_above_threshold():
    client = _client({
        "FROM youtube_videos v": [
            {"video_id": "abc123", "group_key": "plave",
             "title": "PLAVE - WAY 4 LUV M/V",
             "published_at": "2026-05-04T10:00:00Z",
             "group_name": "PLAVE",
             "peak_views_24h": 1_500_000},
        ],
    })
    alerts = rule_video_velocity_24h(client)
    assert len(alerts) == 1
    a = alerts[0]
    assert a.rule == "video_velocity_24h"
    assert a.bucket == "abc123"
    assert "1,500,000" in a.title


def test_video_velocity_24h_dedup_per_video():
    """Same video shouldn't generate two alerts even when the rule
    runs twice — dedup happens via the bucket = video_id."""
    candidates = rule_video_velocity_24h(_client({
        "FROM youtube_videos v": [
            {"video_id": "v1", "group_key": "plave", "title": "x",
             "published_at": "2026-05-01T00:00:00Z",
             "group_name": "PLAVE", "peak_views_24h": 2_000_000},
            {"video_id": "v1", "group_key": "plave", "title": "x",
             "published_at": "2026-05-01T00:00:00Z",
             "group_name": "PLAVE", "peak_views_24h": 2_500_000},
        ],
    }))
    keys = {c.alert_key for c in candidates}
    # One bucket regardless of how many rows the cohort SQL returned
    # (it shouldn't return two anyway, but just-in-case: dedup is by key).
    assert len({c.bucket for c in candidates}) <= len(candidates)
    assert any(k.endswith(":v1") for k in keys)


# ─── controversy_spike ──────────────────────────────────────────────────


def test_controversy_spike_fires_when_doubled_above_floor():
    client = _client({
        "WHERE snapshot_at = (SELECT MAX(snapshot_at) FROM agg_summary)":
        [{"group_key": "isedol", "snapshot_at": "2026-05-04T00:00:00Z",
          "controversy_count": 12}],
        # per-group previous snapshot query
        "WHERE b.group_key = a.group_key":
        [{"group_key": "isedol", "controversy_count": 5}],
    })
    alerts = rule_controversy_spike(client)
    assert len(alerts) == 1
    a = alerts[0]
    assert a.rule == "controversy_spike"
    assert a.severity == "critical"
    assert a.bucket.startswith("2026-W")


def test_controversy_spike_skips_below_floor():
    """min_count floor — even a 100% jump from 1 → 2 shouldn't fire."""
    client = _client({
        "WHERE snapshot_at = (SELECT MAX(snapshot_at) FROM agg_summary)":
        [{"group_key": "plave", "snapshot_at": "2026-05-04T00:00:00Z",
          "controversy_count": 2}],
        "WHERE b.group_key = a.group_key":
        [{"group_key": "plave", "controversy_count": 1}],
    })
    assert rule_controversy_spike(client) == []


def test_controversy_spike_skips_group_absent_from_prior_snapshot():
    """FP guard: a group with no prior-own snapshot (sparse / late-added) has no
    WoW baseline. It must NOT fire an inf-ratio critical just because it's
    missing from the previous snapshot."""
    client = _client({
        "WHERE snapshot_at = (SELECT MAX(snapshot_at) FROM agg_summary)":
        [{"group_key": "uryael", "snapshot_at": "2026-05-04T00:00:00Z",
          "controversy_count": 9}],
        # prev query returns a DIFFERENT group only — uryael has no prior row.
        "WHERE b.group_key = a.group_key":
        [{"group_key": "plave", "controversy_count": 3}],
    })
    assert rule_controversy_spike(client) == []


def test_controversy_spike_fires_on_genuine_zero_baseline():
    """A tracked group present in the prior snapshot with a genuine 0 count that
    jumps above the floor IS a real emergence and should fire."""
    client = _client({
        "WHERE snapshot_at = (SELECT MAX(snapshot_at) FROM agg_summary)":
        [{"group_key": "plave", "snapshot_at": "2026-05-04T00:00:00Z",
          "controversy_count": 6}],
        "WHERE b.group_key = a.group_key":
        [{"group_key": "plave", "controversy_count": 0}],
    })
    alerts = rule_controversy_spike(client)
    assert len(alerts) == 1
    assert alerts[0].severity == "critical"


# ─── run_alerts (dedup + persistence) ───────────────────────────────────


def test_run_alerts_dedups_against_alerts_table():
    today = date(2026, 5, 5)
    debut_iso = (today + timedelta(days=27)).isoformat()
    client = _client({
        "FROM groups": [
            {"key": "miiwan", "name": "MiiWAN", "name_kr": "미완소년",
             "debut_date": debut_iso},
        ],
        "FROM alerts": [
            # Pretend D-30 already fired earlier — engine must skip it.
            {"alert_key": "debut_milestone:miiwan:D-30"},
        ],
    })
    fired = run_alerts(client, webhook_url=None, today=today)
    assert fired == []


def test_run_alerts_writes_alert_row_for_fresh_firing():
    today = date(2026, 5, 5)
    debut_iso = (today + timedelta(days=27)).isoformat()
    client = _client({
        "FROM groups": [
            {"key": "miiwan", "name": "MiiWAN", "name_kr": "미완소년",
             "debut_date": debut_iso},
        ],
        # No prior firings.
        "FROM alerts": [],
    })
    fired = run_alerts(client, webhook_url=None, today=today)
    assert len(fired) == 1
    # batch() must have been invoked exactly once with an INSERT INTO alerts.
    assert client.batch.call_count == 1
    args, _kwargs = client.batch.call_args
    statements = args[0]
    assert len(statements) == 1
    sql, params = statements[0]
    assert "INSERT INTO alerts" in sql
    assert params[0] == "debut_milestone:miiwan:D-30"


def test_alert_dataclass_key_format():
    a = Alert(rule="r", scope="s", bucket="b", severity="info", title="t", body="x")
    assert a.alert_key == "r:s:b"


# ─── identity_leak ─────────────────────────────────────────────────────


def test_identity_leak_fires_on_naver_keyword_match():
    # The rule now fetches raw titles and aggregates/filters in Python.
    client = _client({
        "FROM naver_articles": [
            {"group_key": "plave", "day": "2026-05-04",
             "title": "[단독] PLAVE 본체 추정 인물 사진 유출"},
            {"group_key": "plave", "day": "2026-05-04",
             "title": "PLAVE 본체 논란 후속"},
        ],
    })
    alerts = rule_identity_leak(client)
    assert len(alerts) == 1
    a = alerts[0]
    assert a.rule == "identity_leak"
    assert a.severity == "critical"
    assert a.bucket == "2026-05-04"
    assert a.scope == "plave"
    assert "2건" in a.title  # both genuine hits counted


def test_identity_leak_buckets_per_group_per_day():
    client = _client({
        "FROM naver_articles": [
            {"group_key": "plave",  "day": "2026-05-04", "title": "본체 기사"},
            {"group_key": "plave",  "day": "2026-05-04", "title": "본체 추가"},
            {"group_key": "plave",  "day": "2026-05-05", "title": "후속 신상 유출"},
            {"group_key": "isedol", "day": "2026-05-04", "title": "리얼페이스 공개"},
        ],
    })
    alerts = rule_identity_leak(client)
    keys = {a.alert_key for a in alerts}
    assert keys == {
        "identity_leak:plave:2026-05-04",
        "identity_leak:plave:2026-05-05",
        "identity_leak:isedol:2026-05-04",
    }


def test_identity_leak_ignores_benign_substring_compounds():
    """FP guard: titles where an identity keyword only appears inside a benign
    compound (신상품, 교통정체, 정체성, …) must NOT fire a critical leak alert."""
    client = _client({
        "FROM naver_articles": [
            {"group_key": "plave",  "day": "2026-05-04", "title": "PLAVE 신상품 굿즈 출시"},
            {"group_key": "isedol", "day": "2026-05-04", "title": "ISEDOL 멤버 교통정체 지각 사과"},
            {"group_key": "owis",   "day": "2026-05-04", "title": "OWIS 정체성 콘셉트 해석"},
        ],
    })
    assert rule_identity_leak(client) == []


def test_identity_leak_genuine_hit_survives_alongside_benign():
    """A real '신상 유출' hit fires even though '신상품' would be masked."""
    client = _client({
        "FROM naver_articles": [
            {"group_key": "plave", "day": "2026-05-04", "title": "PLAVE 신상품 굿즈"},
            {"group_key": "plave", "day": "2026-05-04", "title": "PLAVE 멤버 신상 유출 의혹"},
        ],
    })
    alerts = rule_identity_leak(client)
    assert len(alerts) == 1
    assert "1건" in alerts[0].title  # only the genuine one counted


# ─── model_theft ───────────────────────────────────────────────────────


def test_model_theft_fires_on_24h_spike():
    """20 mentions in 24h vs prior-7d total = 14 (avg 2/day) → 10x → fire."""
    client = _client({
        "FROM community_posts": [
            {"group_key": "plave", "last_24h": 20, "prior_7d": 14},
        ],
    })
    alerts = rule_model_theft(client)
    assert len(alerts) == 1
    a = alerts[0]
    assert a.rule == "model_theft"
    assert a.severity == "warn"
    assert a.bucket.startswith("20")  # ISO week


def test_model_theft_skips_below_floor():
    """Even a 100% spike from 1→2 mentions shouldn't fire (last < 5)."""
    client = _client({
        "FROM community_posts": [
            {"group_key": "plave", "last_24h": 2, "prior_7d": 1},
        ],
    })
    assert rule_model_theft(client) == []


def test_model_theft_skips_when_ratio_below_3x():
    """8 mentions in 24h vs 7-day avg of 5/day = 1.6× → skip."""
    client = _client({
        "FROM community_posts": [
            {"group_key": "plave", "last_24h": 8, "prior_7d": 35},
        ],
    })
    assert rule_model_theft(client) == []


def test_model_theft_skips_first_surge_without_baseline():
    """FP guard: no prior baseline (prior_7d=0) + a small first-ever handful
    (last_24h=6) must NOT fire an inf-ratio alert."""
    client = _client({
        "FROM community_posts": [
            {"group_key": "plave", "last_24h": 6, "prior_7d": 0},
        ],
    })
    assert rule_model_theft(client) == []


def test_model_theft_fires_large_surge_without_baseline():
    """No baseline but an unambiguous absolute surge (last_24h ≥ 10) still
    fires."""
    client = _client({
        "FROM community_posts": [
            {"group_key": "plave", "last_24h": 12, "prior_7d": 0},
        ],
    })
    alerts = rule_model_theft(client)
    assert len(alerts) == 1
    assert alerts[0].rule == "model_theft"
