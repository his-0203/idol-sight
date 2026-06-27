"""전 그룹 추정 코어팬 (MarketOverview 참고용, P2a 확장).

기존 youtube_video_stats 재가공 — 신규 수집 0. P2a estimate_video_engagement
산식 그대로 재사용(import). 그룹별 최근 56일 영상(< 3편이면 최신 12편 폴백)에서
median likes/comments를 추정 관여팬/적극코어로 산출한다.

MiiWAN 전용이던 estimate 부분을 전 그룹으로 확대. 정렬/순위 키 아님 — 카드
참고 표기 전용. Heuristic, not ground-truth.

loyalty.py / awareness.py 의 build/compute 분리 + full DELETE rebuild 패턴을
미러한다. live_activity.py 의 영상 조회 SQL(_VIDEOS_WINDOW_SQL/_VIDEOS_FALLBACK_SQL,
상수 _MIN_WINDOW_VIDEOS=3/_VIDEO_FALLBACK_LIMIT=12/_WINDOW_DAYS=56)은 module-private
이므로 이 모듈에 복제한다.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from idol_sight.analysis.live_activity import estimate_video_engagement
from idol_sight.collectors.base import CollectionResult

__all__ = [
    "compute_core_fan_estimate",
    "build_core_fan_estimate",
]

# live_activity.py 의 module-private 상수 복제 (해당 모듈에서 import 금지)
_WINDOW_DAYS: int = 56
_MIN_WINDOW_VIDEOS: int = 3        # 윈도우 내 영상 < 3 → 최신 12건 폴백
_VIDEO_FALLBACK_LIMIT: int = 12

_GROUPS_SQL = "SELECT key FROM groups WHERE is_active=1"

# live_activity._VIDEOS_WINDOW_SQL 복제
_VIDEOS_WINDOW_SQL = (
    "SELECT v.video_id, v.published_at, s.views, s.likes, s.comments "
    "FROM youtube_videos v LEFT JOIN youtube_video_stats s "
    "  ON s.video_id = v.video_id AND s.snapshot_at = ("
    "    SELECT MAX(snapshot_at) FROM youtube_video_stats WHERE video_id = v.video_id) "
    "WHERE v.group_key = ? AND v.published_at IS NOT NULL AND v.published_at >= ? "
    "ORDER BY v.published_at DESC"
)

# live_activity._VIDEOS_FALLBACK_SQL 복제
_VIDEOS_FALLBACK_SQL = (
    "SELECT v.video_id, v.published_at, s.views, s.likes, s.comments "
    "FROM youtube_videos v LEFT JOIN youtube_video_stats s "
    "  ON s.video_id = v.video_id AND s.snapshot_at = ("
    "    SELECT MAX(snapshot_at) FROM youtube_video_stats WHERE video_id = v.video_id) "
    "WHERE v.group_key = ? AND v.published_at IS NOT NULL "
    "ORDER BY v.published_at DESC LIMIT ?"
)

# 스냅샷별 멱등 쓰기: 같은 snapshot_at 만 지우고 다시 INSERT → 과거 스냅샷 보존
_CLEAR_SQL = "DELETE FROM agg_core_fan_estimate WHERE snapshot_at = ?"

_INSERT_SQL = (
    "INSERT INTO agg_core_fan_estimate\n"
    "  (group_key, snapshot_at, est_engaged_fans, est_active_core,\n"
    "   like_rate, comment_rate, video_count, basis, generated_at)\n"
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
)


def compute_core_fan_estimate(
    group_videos: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """그룹별 영상 목록 → 추정 코어팬 지표 리스트 (순수).

    Args:
        group_videos: ``[{"key": group_key, "videos": [...]}, ...]``.
                      ``videos``는 youtube_video_stats 최신 스냅샷이 조인된
                      영상 행 목록(views/likes/comments 키).

    Returns:
        ``[{"group_key", "est_engaged_fans", "est_active_core", "like_rate",
           "comment_rate", "video_count", "basis"}, ...]``.

    Notes:
        - ``videos``가 비면 ``basis='insufficient'``, 나머지 값 None.
        - ``est_engaged_fans``/``est_active_core``는 round 정수.
        - ``subscribers=None`` — view_through 미사용(스키마에 없음).
    """
    out: list[dict[str, Any]] = []
    for g in group_videos:
        key: str = g["key"]
        videos: list[dict[str, Any]] = g.get("videos") or []
        # subscribers=None: view_through 필드는 agg_core_fan_estimate 에 없으므로 미사용
        est = estimate_video_engagement(videos, subscribers=None)
        basis = "scored" if videos else "insufficient"
        out.append({
            "group_key": key,
            "est_engaged_fans": est["est_engaged_fans"],
            "est_active_core": est["est_active_core"],
            "like_rate": est["like_rate"],
            "comment_rate": est["comment_rate"],
            "video_count": est["video_count"],
            "basis": basis,
        })
    return out


class _Executor(Protocol):
    def execute(
        self, sql: str, params: list[Any] | None = None
    ) -> list[dict[str, Any]]: ...


def build_core_fan_estimate(
    client: _Executor,
    *,
    snapshot_at: str,
) -> CollectionResult:
    """활성 그룹별 최근 영상 → compute → 스냅샷별 멱등 쓰기.

    신규 수집 없음 — youtube_videos + youtube_video_stats 재가공.
    56일 윈도우 내 영상 < 3편이면 최신 12편 폴백.
    DELETE WHERE snapshot_at=? 선두 → 같은 스냅샷 재실행 시 멱등(과거 보존).

    Args:
        client: ``.execute(sql, params)`` 메서드를 가진 D1 클라이언트.
        snapshot_at: 쓸 스냅샷 타임스탬프(ISO8601 UTC).

    Returns:
        CollectionResult(statements=[(sql, params), ...]).
        statements[0] = DELETE(스냅샷 범위 삭제, 선두).
        statements[1:] = INSERT per-group.
    """
    now: str = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    cutoff: str = (
        datetime.now(UTC) - timedelta(days=_WINDOW_DAYS)
    ).strftime("%Y-%m-%dT%H:%M:%SZ")

    groups = client.execute(_GROUPS_SQL)
    group_videos: list[dict[str, Any]] = []
    for g in groups:
        key: str = g["key"]
        videos = client.execute(_VIDEOS_WINDOW_SQL, [key, cutoff])
        if len(videos) < _MIN_WINDOW_VIDEOS:
            videos = client.execute(_VIDEOS_FALLBACK_SQL, [key, _VIDEO_FALLBACK_LIMIT])
        group_videos.append({"key": key, "videos": list(videos)})

    rows = compute_core_fan_estimate(group_videos)

    statements: list[tuple[str, list[Any]]] = [(_CLEAR_SQL, [snapshot_at])]
    for r in rows:
        statements.append((_INSERT_SQL, [
            r["group_key"], snapshot_at,
            r["est_engaged_fans"], r["est_active_core"],
            r["like_rate"], r["comment_rate"],
            r["video_count"], r["basis"], now,
        ]))

    return CollectionResult(
        rows_inserted=0,
        rows_updated=len(statements),
        statements=statements,
    )
