"""MiiWAN 찐팬 활동량 (P2a) — 라이브 채팅 measured + 영상 참여 estimated.

(A) live_chat_messages 재가공: 방송별 고유 챗터·챗터당 메시지·분당 피크·재방문
    비율 + 윈도우 코어팬(≥2방송 등장). measured.
(B) youtube_video_stats 최신 스냅샷 재가공: median likes/comments/views 기반
    추정 관여 팬·적극 코어·시청 전환·참여율. estimated (공개 외형 신호 — 추정치이며
    인간 판단 대체 아님).

신규 수집 0 — 전부 기존 데이터 재가공. loyalty.py 의 build/compute 분리 +
basis 3단계(insufficient/low_confidence/scored) + full DELETE rebuild 패턴을
미러한다. measured 라이브 코어와 estimated 영상은 서로 다른 참여 표면(축).
Heuristic, not ground-truth.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from idol_sight.analysis.loyalty import median
from idol_sight.collectors.base import CollectionResult

__all__ = [
    "WINDOW_DAYS",
    "MIN_WINDOW_VIDEOS",
    "VIDEO_FALLBACK_LIMIT",
    "MS_PER_MINUTE",
    "compute_broadcast_activity",
    "window_core_fans",
    "estimate_video_engagement",
    "compute_live_activity",
    "build_live_activity",
]

WINDOW_DAYS: int = 56
MIN_WINDOW_VIDEOS: int = 3       # 윈도우 내 영상 < 3 → 최신 12건 폴백 (소표본 가드)
VIDEO_FALLBACK_LIMIT: int = 12
MS_PER_MINUTE: int = 60_000


# ---------------------------------------------------------------------------
# 순수 컴퓨트 함수
# ---------------------------------------------------------------------------


def compute_broadcast_activity(
    messages: list[dict[str, Any]],
    *,
    prev_chatters: set[str] | None,
) -> dict[str, Any]:
    """방송 1회 분 채팅 메시지 목록을 받아 활동 지표를 반환한다.

    Args:
        messages: live_chat_messages 행 목록. 각 행은 ``author``, ``offset_ms`` 키 포함.
        prev_chatters: 직전 방송의 챗터 집합(최초 방송이면 None).

    Returns:
        dict with keys: total_messages, unique_chatters, msgs_per_chatter,
        peak_msgs_per_min, returning_rate, chatters.

    Notes:
        - ``offset_ms`` NULL → peak 버킷에서만 제외 (고유/총량 포함).
        - ``author`` NULL or '' → 고유 챗터 집합에서 제외.
        - unique == 0 → msgs_per_chatter None, returning_rate None.
        - prev_chatters is None → returning_rate None (첫 방송).
    """
    total_messages: int = len(messages)
    chatters: set[str] = {
        m["author"]
        for m in messages
        if m.get("author") not in (None, "")
    }
    unique: int = len(chatters)
    msgs_per_chatter: float | None = (
        round(total_messages / unique, 1) if unique else None
    )

    # peak: offset_ms NULL 제외
    buckets: dict[int, int] = {}
    for m in messages:
        off = m.get("offset_ms")
        if off is None:
            continue
        b = int(off) // MS_PER_MINUTE
        buckets[b] = buckets.get(b, 0) + 1
    peak: int | None = max(buckets.values()) if buckets else None

    # returning_rate: 직전 방송 챗터와의 교집합 비율
    if prev_chatters is None or unique == 0:
        returning: float | None = None
    else:
        returning = round(len(chatters & prev_chatters) / unique, 4)

    return {
        "total_messages": total_messages,
        "unique_chatters": unique,
        "msgs_per_chatter": msgs_per_chatter,
        "peak_msgs_per_min": peak,
        "returning_rate": returning,
        "chatters": chatters,
    }


def window_core_fans(
    chatters_per_broadcast: list[set[str]],
) -> tuple[int, float | None]:
    """윈도우 전체에서 ≥2회 등장한 챗터 수와 비율을 반환한다.

    Args:
        chatters_per_broadcast: 방송별 챗터 집합 리스트.

    Returns:
        (core_count, core_share). 전체 고유 챗터가 0이면 share=None.
    """
    appearances: dict[str, int] = {}
    for chatters in chatters_per_broadcast:
        for a in chatters:
            appearances[a] = appearances.get(a, 0) + 1
    core: int = sum(1 for n in appearances.values() if n >= 2)
    total_unique: int = len(appearances)
    share: float | None = round(core / total_unique, 4) if total_unique else None
    return core, share


def estimate_video_engagement(
    videos: list[dict[str, Any]],
    subscribers: int | None,
) -> dict[str, Any]:
    """발행 영상 목록에서 추정 관여 팬 지표를 계산한다.

    Args:
        videos: youtube_video_stats 최신 스냅샷이 조인된 영상 행 목록.
                각 행은 ``views``, ``likes``, ``comments`` 키 포함.
        subscribers: 최신 구독자 수. None 또는 ≤0 → view_through None.

    Returns:
        dict with keys: est_engaged_fans, est_active_core, view_through,
        like_rate, comment_rate, video_count.

    Notes:
        - views == 0 영상은 like_rate / comment_rate 비율 계산에서만 제외.
        - est_engaged_fans = round(median(likes)), est_active_core = round(median(comments)).
        - view_through = median(views) / subscribers.
    """
    base: dict[str, Any] = {
        "est_engaged_fans": None,
        "est_active_core": None,
        "view_through": None,
        "like_rate": None,
        "comment_rate": None,
        "video_count": len(videos),
    }
    if not videos:
        return base

    likes: list[float] = [float(v.get("likes") or 0) for v in videos]
    comments: list[float] = [float(v.get("comments") or 0) for v in videos]
    views: list[float] = [float(v.get("views") or 0) for v in videos]

    base["est_engaged_fans"] = round(median(likes))
    base["est_active_core"] = round(median(comments))

    med_views: float = median(views)
    if subscribers and subscribers > 0:
        base["view_through"] = round(med_views / subscribers, 4)

    # 비율: views == 0 영상 제외
    like_ratios: list[float] = [
        float(v.get("likes") or 0) / float(v["views"])
        for v in videos
        if v.get("views")
    ]
    comment_ratios: list[float] = [
        float(v.get("comments") or 0) / float(v["views"])
        for v in videos
        if v.get("views")
    ]
    if like_ratios:
        base["like_rate"] = round(median(like_ratios), 4)
    if comment_ratios:
        base["comment_rate"] = round(median(comment_ratios), 4)

    return base


def compute_live_activity(
    broadcasts: list[dict[str, Any]],
    videos: list[dict[str, Any]],
    subscribers: int | None,
    *,
    window_days: int = WINDOW_DAYS,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """윈도우 내 방송·영상 목록을 받아 per-broadcast 행과 summary를 반환한다.

    Args:
        broadcasts: 방송 목록. 각 항목은 ``video_id``, ``ended_at``,
                    ``messages`` (live_chat_messages 행 리스트) 키 포함.
        videos: 영상 목록(estimate_video_engagement 에 전달).
        subscribers: 최신 구독자 수.
        window_days: 집계 윈도우 일수.

    Returns:
        (per_broadcast, summary).

    Basis rules:
        - 방송 0건 → summary basis "insufficient".
        - 방송 1건 → summary basis "low_confidence"; core_fan 계산 안 함.
        - 방송 ≥2건 → summary basis "scored"; core_fan 계산.
        - per-broadcast row:
          - unique_chatters == 0 → "insufficient".
          - returning_rate is None (첫 방송) → "low_confidence".
          - otherwise → "scored".
    """
    per_broadcast: list[dict[str, Any]] = []
    chatters_seq: list[set[str]] = []
    prev: set[str] | None = None

    for b in broadcasts:
        act = compute_broadcast_activity(b.get("messages") or [], prev_chatters=prev)
        if act["unique_chatters"] == 0:
            row_basis = "insufficient"
        elif act["returning_rate"] is None:
            row_basis = "low_confidence"
        else:
            row_basis = "scored"

        per_broadcast.append({
            "video_id": b["video_id"],
            "ended_at": b.get("ended_at"),
            "unique_chatters": act["unique_chatters"],
            "total_messages": act["total_messages"],
            "msgs_per_chatter": act["msgs_per_chatter"],
            "peak_msgs_per_min": act["peak_msgs_per_min"],
            "returning_rate": act["returning_rate"],
            "basis": row_basis,
        })
        chatters_seq.append(act["chatters"])
        prev = act["chatters"]

    bc: int = len(broadcasts)
    est = estimate_video_engagement(videos, subscribers)

    if bc == 0:
        summary: dict[str, Any] = {
            "window_days": window_days,
            "broadcast_count": 0,
            "median_unique_chatters": None,
            "median_msgs_per_chatter": None,
            "median_returning_rate": None,
            "median_peak_msgs_per_min": None,
            "core_fan_count": None,
            "core_fan_share": None,
            "est_engaged_fans": est["est_engaged_fans"],
            "est_active_core": est["est_active_core"],
            "view_through": est["view_through"],
            "like_rate": est["like_rate"],
            "comment_rate": est["comment_rate"],
            "basis": "insufficient",
        }
        return per_broadcast, summary

    uniques: list[float] = [float(r["unique_chatters"]) for r in per_broadcast]
    mpc: list[float] = [
        r["msgs_per_chatter"]
        for r in per_broadcast
        if r["msgs_per_chatter"] is not None
    ]
    rets: list[float] = [
        r["returning_rate"]
        for r in per_broadcast
        if r["returning_rate"] is not None
    ]
    peaks: list[float] = [
        float(r["peak_msgs_per_min"])
        for r in per_broadcast
        if r["peak_msgs_per_min"] is not None
    ]

    if bc >= 2:
        core_count, core_share = window_core_fans(chatters_seq)
    else:
        core_count, core_share = None, None

    summary = {
        "window_days": window_days,
        "broadcast_count": bc,
        "median_unique_chatters": round(median(uniques)) if uniques else None,
        "median_msgs_per_chatter": round(median(mpc), 1) if mpc else None,
        "median_returning_rate": round(median(rets), 4) if rets else None,
        "median_peak_msgs_per_min": round(median(peaks)) if peaks else None,
        "core_fan_count": core_count,
        "core_fan_share": core_share,
        "est_engaged_fans": est["est_engaged_fans"],
        "est_active_core": est["est_active_core"],
        "view_through": est["view_through"],
        "like_rate": est["like_rate"],
        "comment_rate": est["comment_rate"],
        "basis": "low_confidence" if bc == 1 else "scored",
    }
    return per_broadcast, summary


# ---------------------------------------------------------------------------
# D1 오케스트레이션 — SQL 상수
# ---------------------------------------------------------------------------

_CLEAR_BROADCAST_SQL = "DELETE FROM agg_live_activity WHERE group_key = ?"
_CLEAR_SUMMARY_SQL = "DELETE FROM agg_live_activity_summary WHERE group_key = ?"
_REPORTS_SQL = (
    "SELECT video_id, ended_at FROM live_chat_reports "
    "WHERE group_key = ? AND ended_at IS NOT NULL AND ended_at >= ? ORDER BY ended_at ASC"
)
_MESSAGES_SQL = "SELECT video_id, author, offset_ms FROM live_chat_messages WHERE group_key = ?"
_VIDEOS_WINDOW_SQL = (
    "SELECT v.video_id, v.published_at, s.views, s.likes, s.comments "
    "FROM youtube_videos v LEFT JOIN youtube_video_stats s "
    "  ON s.video_id = v.video_id AND s.snapshot_at = ("
    "    SELECT MAX(snapshot_at) FROM youtube_video_stats WHERE video_id = v.video_id) "
    "WHERE v.group_key = ? AND v.published_at IS NOT NULL AND v.published_at >= ? "
    "ORDER BY v.published_at DESC"
)
_VIDEOS_FALLBACK_SQL = (
    "SELECT v.video_id, v.published_at, s.views, s.likes, s.comments "
    "FROM youtube_videos v LEFT JOIN youtube_video_stats s "
    "  ON s.video_id = v.video_id AND s.snapshot_at = ("
    "    SELECT MAX(snapshot_at) FROM youtube_video_stats WHERE video_id = v.video_id) "
    "WHERE v.group_key = ? AND v.published_at IS NOT NULL ORDER BY v.published_at DESC LIMIT ?"
)
_SUBS_SQL = (
    "SELECT yt_subscribers, snapshot_at FROM agg_summary "
    "WHERE group_key = ? AND yt_subscribers IS NOT NULL ORDER BY snapshot_at DESC LIMIT 1"
)
_INSERT_BROADCAST_SQL = (
    "INSERT INTO agg_live_activity\n"
    "  (group_key, video_id, ended_at, unique_chatters, total_messages,\n"
    "   msgs_per_chatter, peak_msgs_per_min, returning_rate, basis, generated_at)\n"
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
)
_INSERT_SUMMARY_SQL = (
    "INSERT INTO agg_live_activity_summary\n"
    "  (group_key, generated_at, window_days, broadcast_count,\n"
    "   median_unique_chatters, median_msgs_per_chatter, median_returning_rate,\n"
    "   median_peak_msgs_per_min, core_fan_count, core_fan_share,\n"
    "   est_engaged_fans, est_active_core, view_through, like_rate, comment_rate,\n"
    "   basis)\n"
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
)


class _Executor(Protocol):
    def execute(self, sql: str, params: list[Any] = ...) -> list[dict[str, Any]]: ...


def build_live_activity(
    client: _Executor,
    *,
    group_key: str,
    window_days: int = WINDOW_DAYS,
) -> CollectionResult:
    """D1에서 데이터를 읽어 agg_live_activity / agg_live_activity_summary를 재구축한다.

    신규 수집 없음 — 기존 live_chat_messages, youtube_video_stats, agg_summary를
    재가공한다. full DELETE rebuild(group_key 범위): statements 리스트를 반환하며
    실제 D1 batch는 호출자(cli.py)가 실행한다.

    Args:
        client: ``.execute(sql, params)`` 메서드를 가진 D1 클라이언트.
        group_key: 그룹 식별자 (예: "miiwan").
        window_days: 집계 윈도우 일수 (기본 56일).

    Returns:
        CollectionResult(rows_inserted=0, rows_updated=len(statements),
        statements=[(sql, params), ...]).

        statements 순서:
        1. DELETE agg_live_activity WHERE group_key
        2. DELETE agg_live_activity_summary WHERE group_key
        3. INSERT … (per-broadcast rows, 0개 이상)
        4. INSERT agg_live_activity_summary (1개)
    """
    now: str = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    cutoff: str = (
        datetime.now(UTC) - timedelta(days=window_days)
    ).strftime("%Y-%m-%dT%H:%M:%SZ")

    # 방송 목록 (ended_at 오름차순)
    reports = client.execute(_REPORTS_SQL, [group_key, cutoff])

    # 메시지를 video_id 별로 그루핑
    msgs_by_video: dict[str, list[dict[str, Any]]] = {}
    for m in client.execute(_MESSAGES_SQL, [group_key]):
        msgs_by_video.setdefault(m["video_id"], []).append(m)

    broadcasts = [
        {
            "video_id": r["video_id"],
            "ended_at": r.get("ended_at"),
            "messages": msgs_by_video.get(r["video_id"], []),
        }
        for r in reports
    ]

    # 영상 목록: 윈도우 내 < MIN_WINDOW_VIDEOS 이면 최신 VIDEO_FALLBACK_LIMIT 건 폴백
    videos = client.execute(_VIDEOS_WINDOW_SQL, [group_key, cutoff])
    if len(videos) < MIN_WINDOW_VIDEOS:
        videos = client.execute(_VIDEOS_FALLBACK_SQL, [group_key, VIDEO_FALLBACK_LIMIT])

    # 최신 구독자 수
    subs_rows = client.execute(_SUBS_SQL, [group_key])
    subscribers: int | None = subs_rows[0]["yt_subscribers"] if subs_rows else None

    per_broadcast, summary = compute_live_activity(
        broadcasts, videos, subscribers, window_days=window_days
    )

    # statements 구성 (DELETE + INSERT per-broadcast + INSERT summary)
    statements: list[tuple[str, list[Any]]] = [
        (_CLEAR_BROADCAST_SQL, [group_key]),
        (_CLEAR_SUMMARY_SQL, [group_key]),
    ]
    for r in per_broadcast:
        statements.append((
            _INSERT_BROADCAST_SQL,
            [
                group_key, r["video_id"], r["ended_at"],
                r["unique_chatters"], r["total_messages"],
                r["msgs_per_chatter"], r["peak_msgs_per_min"],
                r["returning_rate"], r["basis"], now,
            ],
        ))
    statements.append((
        _INSERT_SUMMARY_SQL,
        [
            group_key, now, summary["window_days"], summary["broadcast_count"],
            summary["median_unique_chatters"], summary["median_msgs_per_chatter"],
            summary["median_returning_rate"], summary["median_peak_msgs_per_min"],
            summary["core_fan_count"], summary["core_fan_share"],
            summary["est_engaged_fans"], summary["est_active_core"],
            summary["view_through"], summary["like_rate"],
            summary["comment_rate"], summary["basis"],
        ],
    ))

    return CollectionResult(
        rows_inserted=0,
        rows_updated=len(statements),
        statements=statements,
    )
