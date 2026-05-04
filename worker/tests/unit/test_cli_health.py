from unittest.mock import MagicMock

from idol_sight.cli_health import audit_freshness


def test_audit_returns_stale_jobs():
    rows = [
        {"job": "naver:plave",  "last_success_at": "2026-05-04T07:00:00Z",
         "expected_interval_h": 1},
        {"job": "dc:bdawn",     "last_success_at": "2026-04-01T00:00:00Z",
         "expected_interval_h": 6},
        {"job": "instiz:miiwan", "last_success_at": None,
         "expected_interval_h": 6},
    ]
    client = MagicMock()
    client.execute.return_value = rows
    stale = audit_freshness(client, now_iso="2026-05-04T08:00:00Z")
    # naver:plave is fresh (1h < 4h); dc:bdawn and instiz:miiwan are stale.
    stale_jobs = {s["job"] for s in stale}
    assert stale_jobs == {"dc:bdawn", "instiz:miiwan"}
