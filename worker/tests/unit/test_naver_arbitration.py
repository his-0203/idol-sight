"""Cross-group arbitration for naver_articles upserts.

A single article URL is one row (url_hash PK). When several groups
collect the same round-up / comparison article, ownership must settle on
the group whose NewsFilter score is highest (the primary subject), and a
relevant verdict must beat an excluded one — independent of collection
order.
"""

import sqlite3

from idol_sight.collectors.naver import NAVER_ARTICLES_UPSERT_SQL

_SCHEMA = """
CREATE TABLE naver_articles (
  url_hash TEXT PRIMARY KEY,
  group_key TEXT,
  title TEXT,
  source TEXT,
  url TEXT,
  published_at TEXT,
  is_excluded INTEGER DEFAULT 0,
  exclude_reason TEXT,
  collected_at TEXT NOT NULL,
  match_score INTEGER NOT NULL DEFAULT 0
)
"""


def _db() -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    db.execute(_SCHEMA)
    return db


def _upsert(db: sqlite3.Connection, *, group_key: str, is_excluded: int, score: int) -> None:
    db.execute(
        NAVER_ARTICLES_UPSERT_SQL,
        [
            "uh1", group_key, "title", "src", "http://x",
            "2026-05-04T00:00:00Z", is_excluded, None,
            "2026-05-05T00:00:00Z", score,
        ],
    )


def test_higher_score_wins_regardless_of_order():
    for order in (
        [("isedol", 0, 1), ("bthd", 0, 3)],
        [("bthd", 0, 3), ("isedol", 0, 1)],
    ):
        db = _db()
        for gk, ex, sc in order:
            _upsert(db, group_key=gk, is_excluded=ex, score=sc)
        row = db.execute(
            "SELECT group_key, match_score, is_excluded FROM naver_articles"
        ).fetchone()
        assert row == ("bthd", 3, 0)


def test_relevant_takes_over_previously_excluded():
    db = _db()
    _upsert(db, group_key="isedol", is_excluded=1, score=0)   # excluded
    _upsert(db, group_key="bthd", is_excluded=0, score=2)     # relevant
    row = db.execute(
        "SELECT group_key, is_excluded FROM naver_articles"
    ).fetchone()
    assert row == ("bthd", 0)


def test_excluded_does_not_steal_from_relevant_owner():
    db = _db()
    _upsert(db, group_key="bthd", is_excluded=0, score=3)     # relevant owner
    _upsert(db, group_key="isedol", is_excluded=1, score=0)   # excluded for isedol
    row = db.execute(
        "SELECT group_key, is_excluded FROM naver_articles"
    ).fetchone()
    assert row == ("bthd", 0)
