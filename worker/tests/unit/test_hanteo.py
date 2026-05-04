from pathlib import Path
from unittest.mock import MagicMock

from scrapling.parser import Adaptor

from idol_sight.collectors.hanteo import HanteoCollector

FIXTURES = Path(__file__).parent / "fixtures"


def test_parses_weekly_chart_for_seeded_groups():
    """Hanteo collector reads the weekly chart and emits rows for any seeded
    group whose name appears as the artist."""
    html = (FIXTURES / "hanteo_weekly.html").read_text()
    page = Adaptor(content=html, url="https://www.hanteochart.com/")
    stealthy = MagicMock()
    stealthy.fetch.return_value = page

    seeded = [
        {"key": "plave",    "name": "PLAVE"},
        {"key": "stellive", "name": "STELLIVE"},
        {"key": "skinz",    "name": "SKINZ"},
        {"key": "isedol",   "name": "ISEDOL"},   # not in fixture; should be skipped
    ]
    groups_loader = MagicMock(return_value=seeded)

    c = HanteoCollector(stealthy=stealthy, groups_loader=groups_loader)
    result = c.collect_global()
    stealthy.fetch.assert_called_once()

    assert result.rows_inserted == 3       # plave, stellive, skinz matched
    statements = result.statements
    assert all("hanteo_weekly" in sql for sql, _ in statements)
    # PLAVE row
    plave_stmt = next(s for s in statements if "plave" in s[1])
    sql, params = plave_stmt
    assert params[2] == "plave"          # group_key (after week_start, week_end)
    assert params[3] == "Caligo Pt.2"     # album
    assert params[4] == 2                 # rank
    assert params[5] == 991850            # sales (commas stripped)


def test_collect_per_group_is_a_no_op():
    """The orchestrator calls collect(group) but Hanteo is global. The per-
    group method must return an empty result without raising — global data is
    fetched once per week via collect_global() in cli."""
    c = HanteoCollector(stealthy=MagicMock(), groups_loader=MagicMock(return_value=[]))
    res = c.collect(group=MagicMock(key="plave"))
    assert res.rows_inserted == 0
