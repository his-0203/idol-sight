# (test_live_activity.py — 전 마이그레이션 :memory: 적용, test_live_chat_migration.py 미러)
import sqlite3
from pathlib import Path
import pytest

MIGRATIONS_DIR = Path(__file__).resolve().parents[3] / "migrations"


def _apply_all():
    conn = sqlite3.connect(":memory:")
    for f in sorted(MIGRATIONS_DIR.glob("*.sql")):
        conn.executescript(f.read_text())
    return conn


def test_migration_creates_live_activity_tables():
    conn = _apply_all()
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"agg_live_activity", "agg_live_activity_summary"} <= tables
    ala_cols = {r[1] for r in conn.execute("PRAGMA table_info(agg_live_activity)")}
    assert {"group_key", "video_id", "ended_at", "unique_chatters", "total_messages",
            "msgs_per_chatter", "peak_msgs_per_min", "returning_rate", "basis",
            "generated_at"} <= ala_cols
    sum_cols = {r[1] for r in conn.execute("PRAGMA table_info(agg_live_activity_summary)")}
    assert {"group_key", "generated_at", "window_days", "broadcast_count",
            "median_unique_chatters", "median_msgs_per_chatter", "median_returning_rate",
            "median_peak_msgs_per_min", "core_fan_count", "core_fan_share",
            "est_engaged_fans", "est_active_core", "view_through", "like_rate",
            "comment_rate", "basis"} <= sum_cols


def test_migration_agg_live_activity_pk_composite():
    conn = _apply_all()
    ins = ("INSERT INTO agg_live_activity (group_key, video_id, basis, generated_at) "
           "VALUES ('miiwan','v1','scored','2026-06-27T00:00:00Z')")
    conn.execute(ins)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(ins)
