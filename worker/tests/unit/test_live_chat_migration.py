"""Live chat migration 0090 — smoke test."""
import sqlite3
from pathlib import Path

MIGRATIONS_DIR = Path(__file__).resolve().parents[3] / "migrations"


def _apply_all() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    for f in sorted(MIGRATIONS_DIR.glob("*.sql")):
        conn.executescript(f.read_text())
    return conn


def test_migration_creates_live_chat_tables():
    conn = _apply_all()
    tables = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    assert "live_chat_messages" in tables
    assert "live_chat_reports" in tables

    msg_cols = {r[1] for r in conn.execute("PRAGMA table_info(live_chat_messages)")}
    assert {"video_id", "group_key", "msg_id", "offset_ms", "author", "message"} <= msg_cols

    rep_cols = {r[1] for r in conn.execute("PRAGMA table_info(live_chat_reports)")}
    assert {"video_id", "group_key", "title", "ended_at", "generated_at",
            "total_messages", "sampled", "positive_ratio", "negative_ratio",
            "report_json"} <= rep_cols

    indexes = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='index' "
        "AND tbl_name='live_chat_messages'")}
    assert "idx_lcm_video" in indexes


def test_live_chat_messages_pk_is_idempotent():
    conn = _apply_all()
    ins = ("INSERT INTO live_chat_messages "
           "(video_id, group_key, msg_id, offset_ms, author, message) "
           "VALUES ('v1','miiwan','m1',1000,'a','hi') "
           "ON CONFLICT(video_id, msg_id) DO NOTHING")
    conn.execute(ins)
    conn.execute(ins)  # duplicate — must not raise, must not double-insert
    n = conn.execute("SELECT COUNT(*) FROM live_chat_messages").fetchone()[0]
    assert n == 1
