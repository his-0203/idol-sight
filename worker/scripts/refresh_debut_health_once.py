"""One-off production operation; kept off main and does not collect new data."""

from idol_sight.cli import _make_d1_client, _recompute_health_scores
from idol_sight.config import load_settings


class PreviewClient:
    """Allow reads, capture score writes until the operation has been checked."""

    def __init__(self, client):
        self.execute = client.execute
        self.statements = []

    def batch(self, statements):
        self.statements.extend(statements)


def main():
    client = _make_d1_client(load_settings())
    groups = client.execute(
        "SELECT key, debut_date, debut_confirmed FROM groups "
        "WHERE key IN ('bthd','wegosix','begritz') ORDER BY key"
    )
    by_key = {row["key"]: row for row in groups}
    assert by_key["bthd"]["debut_date"] == "2026-06-26"
    assert by_key["wegosix"]["debut_date"] == "2026-09-22"
    assert all(by_key[key]["debut_confirmed"] == 1 for key in ("bthd", "wegosix"))
    assert by_key["begritz"]["debut_date"] is None

    snap = client.execute("SELECT MAX(snapshot_at) AS snap FROM agg_health_scores")[0]["snap"]
    assert snap, "No existing health snapshot; stop without writing"
    assert client.execute(
        "SELECT COUNT(*) AS n FROM agg_summary WHERE snapshot_at=?", [snap]
    )[0]["n"] > 0, "Matching cohort snapshot is required"

    before = client.execute(
        "SELECT group_key, snapshot_at, total, grade FROM agg_health_scores "
        "WHERE snapshot_at=? AND group_key IN ('bthd','wegosix','begritz') "
        "ORDER BY group_key", [snap]
    )
    assert {r["group_key"] for r in before} == {"bthd", "wegosix", "begritz"}
    preview = PreviewClient(client)
    _recompute_health_scores(preview, snap)
    selected = [(sql, params) for sql, params in preview.statements
                if params[0] in {"bthd", "wegosix"}]
    assert len(selected) == 2
    assert {params[0] for _, params in selected} == {"bthd", "wegosix"}
    assert all(sql.startswith("INSERT INTO agg_health_scores")
               and params[1] == snap and params[4] != "PRE"
               for sql, params in selected)
    print("before:", before)
    client.batch(selected)
    after = client.execute(
        "SELECT group_key, snapshot_at, total, grade FROM agg_health_scores "
        "WHERE snapshot_at=? AND group_key IN ('bthd','wegosix','begritz') "
        "ORDER BY group_key", [snap]
    )
    assert next(r for r in after if r["group_key"] == "begritz") == next(
        r for r in before if r["group_key"] == "begritz"
    )
    assert all(r["grade"] != "PRE" for r in after if r["group_key"] != "begritz")
    print("after:", after)
    print("Updated exactly two existing health rows; source data and BEGRITZ unchanged.")


if __name__ == "__main__":
    main()
