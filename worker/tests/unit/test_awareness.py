# (test_awareness.py 의 migration 섹션 — _apply_all 미러)
import sqlite3
from pathlib import Path
import pytest

MIGRATIONS_DIR = Path(__file__).resolve().parents[3] / "migrations"


def _apply_all():
    conn = sqlite3.connect(":memory:")
    for f in sorted(MIGRATIONS_DIR.glob("*.sql")):
        conn.executescript(f.read_text())
    return conn


def test_migration_creates_agg_awareness_table():
    conn = _apply_all()
    tables = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    assert "agg_awareness" in tables
    cols = {r[1] for r in conn.execute("PRAGMA table_info(agg_awareness)")}
    assert {"group_key", "snapshot_at", "category", "awareness_score",
            "category_rank", "sub_n", "view_n", "news_n", "basis",
            "generated_at"} <= cols
    indexes = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='index' "
        "AND tbl_name='agg_awareness'")}
    assert "idx_aw_snapshot" in indexes


def test_migration_agg_awareness_pk_is_group_key_snapshot():
    conn = _apply_all()
    pk_cols = {r[1] for r in conn.execute("PRAGMA table_info(agg_awareness)")
               if r[5] > 0}
    assert pk_cols == {"group_key", "snapshot_at"}
    ins = ("INSERT INTO agg_awareness "
           "(group_key, snapshot_at, category, awareness_score, category_rank, "
           " sub_n, view_n, news_n, basis, generated_at) "
           "VALUES ('plave','2026-06-27T00:00:00Z','kpop',100.0,1,"
           "1.0,1.0,1.0,'scored','2026-06-27T01:00:00Z')")
    conn.execute(ins)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(ins)
