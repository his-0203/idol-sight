"""Live CCV migration 0080 — smoke test."""
import sqlite3
from pathlib import Path

MIGRATIONS_DIR = Path(__file__).resolve().parents[3] / "migrations"


def _apply_all() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    for f in sorted(MIGRATIONS_DIR.glob("*.sql")):
        conn.executescript(f.read_text())
    return conn


def test_migration_adds_ccv_tracked_and_samples_table():
    conn = _apply_all()
    cols = {r[1] for r in conn.execute("PRAGMA table_info(groups)")}
    assert "ccv_tracked" in cols
    tables = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    assert "live_ccv_samples" in tables
    seeded = {r[0] for r in conn.execute(
        "SELECT key FROM groups WHERE ccv_tracked=1")}
    assert {"miiwan", "plave", "owis", "wegosix"} <= seeded
    indexes = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='index' "
        "AND tbl_name='live_ccv_samples'")}
    assert "idx_ccv_group_time" in indexes
