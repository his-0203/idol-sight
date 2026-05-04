"""Validate `migrations/0002_seed.sql` content + group/member shape."""

import json
import sqlite3
from pathlib import Path

MIGRATIONS_DIR = Path(__file__).resolve().parents[3] / "migrations"


def _load_with_seed() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.executescript((MIGRATIONS_DIR / "0001_init.sql").read_text())
    conn.executescript((MIGRATIONS_DIR / "0002_seed.sql").read_text())
    return conn


def test_eight_active_groups_seeded():
    conn = _load_with_seed()
    rows = conn.execute(
        "SELECT key FROM groups WHERE is_active=1 ORDER BY key"
    ).fetchall()
    keys = [r[0] for r in rows]
    assert keys == [
        "bdawn",
        "isedol",
        "miiwan",
        "myrakl",
        "owis",
        "plave",
        "skinz",
        "stellive",
    ]


def test_each_group_has_required_fields():
    conn = _load_with_seed()
    for (key,) in conn.execute("SELECT key FROM groups WHERE is_active=1"):
        row = conn.execute(
            "SELECT name, name_kr, naver_query, context_keywords FROM groups WHERE key=?",
            (key,),
        ).fetchone()
        name, name_kr, naver_query, ctx_json = row
        assert name and name_kr, f"{key}: empty name fields"
        assert naver_query, f"{key}: missing naver_query"
        ctx = json.loads(ctx_json or "[]")
        assert isinstance(ctx, list) and len(ctx) >= 3, (
            f"{key}: context_keywords must be list of >=3"
        )


def test_groups_with_debut_have_yt_channel_id():
    conn = _load_with_seed()
    for key, debut, ch in conn.execute(
        "SELECT key, debut_date, yt_channel_id FROM groups WHERE is_active=1"
    ):
        if debut:
            assert ch and ch.startswith("UC") and len(ch) == 24, (
                f"{key}: debuted group missing or bad yt_channel_id ({ch!r})"
            )


def test_members_have_group_fk():
    conn = _load_with_seed()
    bad = conn.execute(
        "SELECT m.name, m.group_key FROM members m "
        "LEFT JOIN groups g ON g.key = m.group_key "
        "WHERE g.key IS NULL"
    ).fetchall()
    assert bad == [], f"members with no matching group: {bad}"


def test_each_active_group_has_at_least_three_members():
    conn = _load_with_seed()
    for (key,) in conn.execute("SELECT key FROM groups WHERE is_active=1"):
        (cnt,) = conn.execute(
            "SELECT COUNT(*) FROM members WHERE group_key=? AND active=1",
            (key,),
        ).fetchone()
        assert cnt >= 3, f"{key}: only {cnt} active members"
