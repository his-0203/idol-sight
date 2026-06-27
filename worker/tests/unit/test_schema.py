import sqlite3
from pathlib import Path

MIGRATIONS_DIR = Path(__file__).resolve().parents[3] / "migrations"


def _load_schema() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    sql = (MIGRATIONS_DIR / "0001_init.sql").read_text()
    conn.executescript(sql)
    return conn


def test_all_expected_tables_exist():
    conn = _load_schema()
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).fetchall()
    names = {r[0] for r in rows}
    expected = {
        "groups", "members",
        "youtube_videos", "youtube_video_stats", "youtube_channel_stats",
        "naver_articles",
        "community_posts", "community_post_stats", "community_keywords",
        "hanteo_weekly",
        "agg_summary", "agg_health_scores", "agg_market_share",
        "agg_member_popularity", "agg_member_pop_meta",
        "insights",
        "crawl_meta", "selectors_cache",
    }
    missing = expected - names
    assert not missing, f"missing tables: {missing}"


def test_indexes_present():
    conn = _load_schema()
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"
    ).fetchall()
    names = {r[0] for r in rows}
    assert "idx_yt_video_group" in names
    assert "idx_naver_group_date" in names
    assert "idx_comm_platform_group_date" in names
    assert "idx_summary_snap" in names


def test_groups_pk_is_key_text():
    conn = _load_schema()
    info = conn.execute("PRAGMA table_info(groups)").fetchall()
    pk = [row for row in info if row[5] == 1]
    assert len(pk) == 1
    assert pk[0][1] == "key"
    assert pk[0][2].upper() == "TEXT"


def test_can_insert_minimal_group():
    conn = _load_schema()
    conn.execute(
        "INSERT INTO groups(key,name,name_kr,is_active) VALUES (?,?,?,?)",
        ("plave", "PLAVE", "플레이브", 1),
    )
    row = conn.execute("SELECT key FROM groups WHERE key='plave'").fetchone()
    assert row == ("plave",)
