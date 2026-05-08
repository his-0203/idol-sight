"""SQL-level test for member-video attribution (cli._MEMBER_POP_FETCH_SQL).

`agg_member_popularity` 의 멤버 단위 yt_videos / yt_avg_views 는 cli.py 의
analyze_weekly 에 inlined 되어 있던 SELECT 를 통해 산출된다. 0050 migration 으로
youtube_videos.tags 컬럼이 추가된 뒤 V2.5.1 에서 OR EXISTS(json_each(tags)) 절을
더해 해시태그 기반 attribution 을 확장했다.

여기서는 in-memory SQLite 에 0001_init + 0050 schema 를 띄우고 시나리오별
영상 데이터를 시드한 뒤 실제 SQL 을 실행해, MiiWAN 멤버 '마하진' (name=마하진,
name_en=Mahajin) 에 대한 카운트/평균이 기대대로 잡히는지 검증한다.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from idol_sight.cli import _MEMBER_POP_FETCH_SQL

MIGRATIONS_DIR = Path(__file__).resolve().parents[3] / "migrations"


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript((MIGRATIONS_DIR / "0001_init.sql").read_text())
    conn.executescript((MIGRATIONS_DIR / "0050_youtube_video_tags.sql").read_text())
    return conn


def _seed_miiwan(conn: sqlite3.Connection) -> int:
    """Seed miiwan group + 마하진 member. Returns member id."""
    conn.execute(
        "INSERT INTO groups(key, name, name_kr, is_active) VALUES (?, ?, ?, ?)",
        ("miiwan", "MiiWAN", "미완소년", 1),
    )
    cur = conn.execute(
        "INSERT INTO members(group_key, name, name_en, active) VALUES (?, ?, ?, ?)",
        ("miiwan", "마하진", "Mahajin", 1),
    )
    return cur.lastrowid or 0


def _add_video(
    conn: sqlite3.Connection,
    *,
    video_id: str,
    group_key: str,
    title: str,
    tags: list[str] | None,
    views: int = 100_000,
) -> None:
    conn.execute(
        "INSERT INTO youtube_videos"
        "  (video_id, group_key, channel_id, title, duration_sec,"
        "   published_at, content_type, is_short, first_seen_at, tags)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            video_id, group_key, "UC_X", title, 180,
            "2026-05-01T00:00:00Z", "MV", 0, "2026-05-01T00:00:00Z",
            json.dumps(tags, ensure_ascii=False) if tags is not None else None,
        ),
    )
    conn.execute(
        "INSERT INTO youtube_video_stats(video_id, snapshot_at, views, likes, comments)"
        " VALUES (?, ?, ?, ?, ?)",
        (video_id, "2026-05-01T01:00:00Z", views, 0, 0),
    )


def _run_query(conn: sqlite3.Connection, group_key: str) -> list[dict]:
    rows = conn.execute(_MEMBER_POP_FETCH_SQL, [group_key]).fetchall()
    return [dict(r) for r in rows]


def test_title_match_still_counted_baseline():
    """기존 동작 회귀 — title 에 한글 이름이 들어간 영상은 tags 와 무관하게 카운트."""
    conn = _conn()
    _seed_miiwan(conn)
    _add_video(conn, video_id="v1", group_key="miiwan",
               title="마하진 솔로 무대", tags=None)

    rows = _run_query(conn, "miiwan")
    assert len(rows) == 1
    assert rows[0]["group_video_mention_count"] == 1


def test_korean_hashtag_in_tags_is_counted():
    """tags 에 한글 멤버명이 정확히 들어간 영상 — 새 동작."""
    conn = _conn()
    _seed_miiwan(conn)
    # title 에는 멤버명 없음.
    _add_video(conn, video_id="v1", group_key="miiwan",
               title="MiiWAN team behind", tags=["마하진", "behind"])

    rows = _run_query(conn, "miiwan")
    assert rows[0]["group_video_mention_count"] == 1


def test_english_hashtag_case_insensitive():
    """tags 에 'mahajin' (소문자) — name_en='Mahajin' 과 case-insensitive 매칭."""
    conn = _conn()
    _seed_miiwan(conn)
    _add_video(conn, video_id="v1", group_key="miiwan",
               title="behind the scenes", tags=["mahajin", "kpop"])
    _add_video(conn, video_id="v2", group_key="miiwan",
               title="dance practice", tags=["MAHAJIN"])  # 대문자

    rows = _run_query(conn, "miiwan")
    assert rows[0]["group_video_mention_count"] == 2


def test_tags_null_does_not_error_or_match():
    """tags=NULL 인 영상이 섞여 있어도 json_each 가 에러를 내지 않는다."""
    conn = _conn()
    _seed_miiwan(conn)
    _add_video(conn, video_id="v1", group_key="miiwan",
               title="random video", tags=None)

    rows = _run_query(conn, "miiwan")
    # title 매칭도 없고 tags=NULL 이니 0.
    assert rows[0]["group_video_mention_count"] == 0


def test_empty_tags_array_does_not_match():
    """tags='[]' (빈 배열) — json_each 는 0 row, EXISTS 는 false."""
    conn = _conn()
    _seed_miiwan(conn)
    _add_video(conn, video_id="v1", group_key="miiwan",
               title="random video", tags=[])

    rows = _run_query(conn, "miiwan")
    assert rows[0]["group_video_mention_count"] == 0


def test_unrelated_tags_do_not_match():
    """tags 에 멤버명이 아닌 다른 토큰만 있는 경우 — 카운트 X."""
    conn = _conn()
    _seed_miiwan(conn)
    _add_video(conn, video_id="v1", group_key="miiwan",
               title="random video", tags=["kpop", "viral", "shorts"])

    rows = _run_query(conn, "miiwan")
    assert rows[0]["group_video_mention_count"] == 0


def test_title_and_tag_match_counts_once_no_double_count():
    """동일 영상에 title+tag 양쪽 매칭 — EXISTS 는 row 단위 카운트라 1회만."""
    conn = _conn()
    _seed_miiwan(conn)
    _add_video(conn, video_id="v1", group_key="miiwan",
               title="마하진 무대", tags=["마하진", "Mahajin"])

    rows = _run_query(conn, "miiwan")
    assert rows[0]["group_video_mention_count"] == 1


def test_avg_views_includes_tag_matched_videos():
    """group_video_avg_views 에도 동일하게 OR 절 적용 — tag-only 영상도 평균에 반영."""
    conn = _conn()
    _seed_miiwan(conn)
    # title 매칭 영상 1편 (조회수 100만)
    _add_video(conn, video_id="v1", group_key="miiwan",
               title="마하진 댄스", tags=None, views=1_000_000)
    # tag 매칭 영상 1편 (조회수 200만)
    _add_video(conn, video_id="v2", group_key="miiwan",
               title="behind", tags=["Mahajin"], views=2_000_000)

    rows = _run_query(conn, "miiwan")
    assert rows[0]["group_video_mention_count"] == 2
    # 평균 = (1_000_000 + 2_000_000) / 2 = 1_500_000
    assert rows[0]["group_video_avg_views"] == 1_500_000


def test_non_miiwan_group_unaffected_by_tags_clause():
    """tags=NULL 인 다른 그룹도 동일한 SQL 로 정상 동작."""
    conn = _conn()
    conn.execute(
        "INSERT INTO groups(key, name, name_kr, is_active) VALUES (?, ?, ?, ?)",
        ("plave", "PLAVE", "플레이브", 1),
    )
    conn.execute(
        "INSERT INTO members(group_key, name, name_en, active) VALUES (?, ?, ?, ?)",
        ("plave", "노아", "Noah", 1),
    )
    _add_video(conn, video_id="p1", group_key="plave",
               title="노아 솔로", tags=None)
    _add_video(conn, video_id="p2", group_key="plave",
               title="random", tags=None)

    rows = _run_query(conn, "plave")
    assert len(rows) == 1
    assert rows[0]["group_video_mention_count"] == 1


def test_inactive_member_excluded():
    """active=0 멤버는 결과에서 제외 — 기존 WHERE 절 회귀 확인."""
    conn = _conn()
    _seed_miiwan(conn)
    conn.execute(
        "INSERT INTO members(group_key, name, name_en, active) VALUES (?, ?, ?, ?)",
        ("miiwan", "탈퇴멤버", "Exited", 0),
    )
    rows = _run_query(conn, "miiwan")
    names = {r["name"] for r in rows}
    assert "마하진" in names
    assert "탈퇴멤버" not in names
