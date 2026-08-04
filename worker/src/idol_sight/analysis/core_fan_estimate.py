"""전 그룹 추정 코어팬 (MarketOverview 참고용, P2a 확장).

기존 youtube_video_stats 재가공 — 신규 수집 0. P2a estimate_video_engagement
산식 그대로 재사용(import). 그룹별 최근 30일 영상(< 3편이면 최신 12편 폴백)에서
median likes/comments를 추정 관여팬/적극코어로 산출한다.

MiiWAN 전용이던 estimate 부분을 전 그룹으로 확대. 정렬/순위 키 아님 — 카드
참고 표기 전용. Heuristic, not ground-truth.

loyalty.py / awareness.py 의 build/compute 분리 + full DELETE rebuild 패턴을
미러한다. live_activity.py 의 영상 조회 SQL(_VIDEOS_WINDOW_SQL/_VIDEOS_FALLBACK_SQL,
상수 _MIN_WINDOW_VIDEOS=3/_VIDEO_FALLBACK_LIMIT=12/_WINDOW_DAYS=56)은 module-private
이므로 이 모듈에 복제한다.

V2.53 Organic Trust Layer: 원값 경로(est_engaged_fans/est_active_core 및 기존
window/fallback semantics)는 불변으로 두고, 데뷔윈도우 영상 organicity 판정
(debut_window_video_organicity, verdict ∈ {suspect, likely_paid})에 해당하는
유료 의심 영상을 제외한 보정값(est_engaged_fans_adj/est_active_core_adj/
organic_video_count)을 **추가** 산출한다. 필터 후 유효 표본 < 3편(폴백 포함)이면
basis='insufficient_organic'(adj NULL, 원값은 유지 저장). suspect 셋 로드와 adj
컬럼 감지(mig 0107)는 전부 try/except graceful — 미적용 D1에서 기존 동작 유지.
"""
from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from idol_sight.analysis.live_activity import estimate_video_engagement
from idol_sight.collectors.base import CollectionResult

__all__ = [
    "select_organic_videos",
    "compute_core_fan_estimate",
    "build_core_fan_estimate",
]

log = logging.getLogger(__name__)

# live_activity.py 의 module-private 상수를 미러하되, 윈도우는 의도적으로
# 분기(2026-08-04 사용자 결정): 시장 개요/지도의 추정 코어는 "지금"의
# 좌표라 최근 30일 기준 — live_activity(MiiWAN 심층 P2a)는 56일 유지.
_WINDOW_DAYS: int = 30
_MIN_WINDOW_VIDEOS: int = 3        # 윈도우 내 영상 < 3 → 최신 12건 폴백
_VIDEO_FALLBACK_LIMIT: int = 12

# v2(2026-08): est_engaged_fans/est_active_core 는 표본 전체 median 이 아니라
# **반응 상위 K편의 median** — 전체 median 은 업로드 편수의 감소함수라 일상
# 클립을 성실히 올리는 그룹이 벌점을 받았다(볼륨 역상관). 상위 K median 은
# 영상 추가로 내려갈 수 없어(약단조) 이 병리가 구조적으로 소멸하고, 쇼츠·
# 일상 클립은 상위 K에 못 들면 자동 배제된다. 지표별로 자기 신호 기준
# top-K(좋아요→engaged, 댓글→core). K 자의성은 K∈{3,5,7} 순위 안정성으로
# 검증(스펙 §③). like_rate/comment_rate/video_count 는 전체 표본 기준 유지.
TOP_K_VIDEOS: int = 5


def _top_k(videos: list[dict[str, Any]], field: str,
           k: int = TOP_K_VIDEOS) -> list[dict[str, Any]]:
    """``field`` 내림차순 상위 k편 (표본 <k 면 전부 — 현행 median 과 연속)."""
    return sorted(videos, key=lambda v: (v.get(field) or 0), reverse=True)[:k]

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

# V2.53: mig 0107 적용 D1 전용 — 원본 9컬럼 + adj 3컬럼.
_INSERT_SQL_ADJ = (
    "INSERT INTO agg_core_fan_estimate\n"
    "  (group_key, snapshot_at, est_engaged_fans, est_active_core,\n"
    "   like_rate, comment_rate, video_count, basis, generated_at,\n"
    "   est_engaged_fans_adj, est_active_core_adj, organic_video_count)\n"
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
)

# V2.53: 데뷔윈도우 영상 organicity 판정 중 유료 의심(suspect/likely_paid)만 로드.
# 미채점(테이블에 없는) 영상은 여기 안 잡히므로 adj 산정에서 포함된다.
_SUSPECT_SQL = (
    "SELECT video_id FROM debut_window_video_organicity "
    "WHERE verdict IN ('suspect', 'likely_paid')"
)


def select_organic_videos(
    window_videos: list[dict[str, Any]],
    fallback_videos: list[dict[str, Any]],
    suspect_ids: set[str],
) -> list[dict[str, Any]] | None:
    """suspect/likely_paid 제외 후 표본 확보 (순수).

    윈도우에서 제외 후 < _MIN_WINDOW_VIDEOS 면 폴백(최신 12편)에도 동일
    필터 적용, 그래도 부족하면 None (→ basis='insufficient_organic').
    미채점 영상(suspect_ids 밖)은 그대로 포함한다.
    """
    filtered = [v for v in window_videos if v.get("video_id") not in suspect_ids]
    if len(filtered) >= _MIN_WINDOW_VIDEOS:
        return filtered
    fb = [v for v in fallback_videos if v.get("video_id") not in suspect_ids]
    if len(fb) >= _MIN_WINDOW_VIDEOS:
        return fb
    return None


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
           "comment_rate", "video_count", "basis", "est_engaged_fans_adj",
           "est_active_core_adj", "organic_video_count"}, ...]``.

    Notes:
        - ``videos``가 비면 ``basis='insufficient'``, 원값·adj 전부 None.
        - ``est_engaged_fans``/``est_active_core``는 round 정수.
        - ``subscribers=None`` — view_through 미사용(스키마에 없음).

        V2.53: 입력 entry의 ``videos_adj`` (유료 의심 제외 영상, 키 부재 시
        ``videos`` 전체 = 필터 없음 하위호환, None 이면 표본 부족) 을 소비해
        보정값 3키를 **추가** 산출한다. ``videos`` 있고 ``videos_adj`` None →
        ``basis='insufficient_organic'`` (adj None, 원값은 그대로 유지 저장).
        둘 다 있으면 ``'scored'``. 원값 경로의 값·산정은 불변.
    """
    out: list[dict[str, Any]] = []
    for g in group_videos:
        key: str = g["key"]
        videos: list[dict[str, Any]] = g.get("videos") or []
        # subscribers=None: view_through 필드는 agg_core_fan_estimate 에 없으므로 미사용
        # rate·count 는 전체 표본 기준(축 아님) — 공유 산식 함수는 불변으로
        # 두고(라이브 활동 P2a 와 공유) 표본 선택만 v2 top-K 로 바꾼다.
        est = estimate_video_engagement(videos, subscribers=None)
        est_l = estimate_video_engagement(_top_k(videos, "likes"), subscribers=None)
        est_c = estimate_video_engagement(_top_k(videos, "comments"), subscribers=None)
        # V2.53: videos_adj 키 부재 = 필터 없음(videos 전체를 adj 로 간주, 호환).
        videos_adj = g.get("videos_adj", videos)
        if videos:
            if videos_adj:
                # suspect 제외 **후** 동일 top-K — 의심 영상이 상위권이었다면
                # 보정값이 실제로 내려간다.
                adj_l = estimate_video_engagement(
                    _top_k(videos_adj, "likes"), subscribers=None)
                adj_c = estimate_video_engagement(
                    _top_k(videos_adj, "comments"), subscribers=None)
                est_adj = {
                    "est_engaged_fans": adj_l["est_engaged_fans"],
                    "est_active_core": adj_c["est_active_core"],
                }
            else:
                est_adj = None
            basis = "scored" if videos_adj else "insufficient_organic"
        else:
            est_adj = None
            basis = "insufficient"
        out.append({
            "group_key": key,
            "est_engaged_fans": est_l["est_engaged_fans"],
            "est_active_core": est_c["est_active_core"],
            "like_rate": est["like_rate"],
            "comment_rate": est["comment_rate"],
            "video_count": est["video_count"],
            "basis": basis,
            "est_engaged_fans_adj": est_adj["est_engaged_fans"] if est_adj else None,
            "est_active_core_adj": est_adj["est_active_core"] if est_adj else None,
            "organic_video_count": len(videos_adj) if videos_adj else None,
        })
    return out


class _Executor(Protocol):
    def execute(
        self, sql: str, params: list[Any] | None = None
    ) -> list[dict[str, Any]]: ...


def _has_adj_columns(client: _Executor) -> bool:
    """mig 0107 적용 여부 감지 — 미적용 D1에서도 기존 INSERT로 동작(graceful)."""
    try:
        client.execute(
            "SELECT est_engaged_fans_adj FROM agg_core_fan_estimate LIMIT 1")
        return True
    except Exception:
        return False


def build_core_fan_estimate(
    client: _Executor,
    *,
    snapshot_at: str,
) -> CollectionResult:
    """활성 그룹별 최근 영상 → compute → 스냅샷별 멱등 쓰기.

    신규 수집 없음 — youtube_videos + youtube_video_stats 재가공.
    30일 윈도우 내 영상 < 3편이면 최신 12편 폴백.
    DELETE WHERE snapshot_at=? 선두 → 같은 스냅샷 재실행 시 멱등(과거 보존).

    V2.53: 유료 의심(suspect/likely_paid) 영상을 제외한 adj 표본을 산정해 보정
    컬럼을 함께 적재한다. D1에 adj 컬럼이 있으면 확장 INSERT, 없으면(mig 0107
    미적용) 기존 INSERT 로 나간다. 원값 폴백 semantics·값은 불변.

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

    # V2.53: 유료 의심(suspect/likely_paid) 영상 셋 로드. 테이블 이상/미적용 시
    # 빈 셋 → 전 영상 organic 취급(graceful).
    try:
        suspect_ids = {r["video_id"] for r in client.execute(_SUSPECT_SQL)}
    except Exception as e:  # noqa: BLE001
        log.warning("suspect video set load failed, treating all videos as organic: %s", e)
        suspect_ids = set()

    groups = client.execute(_GROUPS_SQL)
    group_videos: list[dict[str, Any]] = []
    for g in groups:
        key: str = g["key"]
        window_videos = client.execute(_VIDEOS_WINDOW_SQL, [key, cutoff])
        fallback_videos: list[dict[str, Any]] = []
        # 폴백 fetch 조건: 원값 폴백(window<3) 또는 필터 후 표본<3 (adj 폴백용).
        need_fallback = (
            len(window_videos) < _MIN_WINDOW_VIDEOS
            or len([v for v in window_videos
                    if v.get("video_id") not in suspect_ids]) < _MIN_WINDOW_VIDEOS
        )
        if need_fallback:
            fallback_videos = client.execute(
                _VIDEOS_FALLBACK_SQL, [key, _VIDEO_FALLBACK_LIMIT])
        # 원값 폴백 semantics 보존: window≥3 → window, 아니면 fallback(또는 window).
        videos = (window_videos if len(window_videos) >= _MIN_WINDOW_VIDEOS
                  else fallback_videos or window_videos)
        videos_adj = select_organic_videos(
            window_videos, fallback_videos, suspect_ids)
        group_videos.append(
            {"key": key, "videos": list(videos), "videos_adj": videos_adj})

    rows = compute_core_fan_estimate(group_videos)
    use_adj = _has_adj_columns(client)

    statements: list[tuple[str, list[Any]]] = [(_CLEAR_SQL, [snapshot_at])]
    for r in rows:
        base_params = [
            r["group_key"], snapshot_at,
            r["est_engaged_fans"], r["est_active_core"],
            r["like_rate"], r["comment_rate"],
            r["video_count"], r["basis"], now,
        ]
        if use_adj:
            statements.append((_INSERT_SQL_ADJ, base_params + [
                r["est_engaged_fans_adj"], r["est_active_core_adj"],
                r["organic_video_count"],
            ]))
        else:
            statements.append((_INSERT_SQL, base_params))

    return CollectionResult(
        rows_inserted=0,
        rows_updated=len(statements),
        statements=statements,
    )
