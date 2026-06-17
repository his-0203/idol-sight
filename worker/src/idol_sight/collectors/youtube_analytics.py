"""미완소년 소유자 OAuth(YouTube Analytics) collector. 미완소년 전용.

공개 API 키로는 못 보는 소유자 전용 지표를 수집한다 (DECISION 탭의
해외진출/굿즈 보드 입력). 다른 그룹은 OAuth 가 없어 이 collector 가 돌지
않는다 — cli 의 youtube-analytics 커맨드가 miiwan 에게만 호출한다.

수집 흐름:
  1. refresh_token → access_token 갱신 (oauth2.googleapis.com/token)
  2. 국가별 리포트 (현재 30일 + 직전 30일) →
       watch_share / growth_mom / retention_rel / sub_per_1k 계산
  3. agg_youtube_analytics_country 에 적재 +
     agg_youtube_analytics 에 채널 단위 행 1개 (현재 멤버십/재방문은 API
     미노출이라 NULL — 국가 지표만 항상 채워진다).

계산 로직(build_country_rows)은 HTTP 와 분리된 순수함수라 단위 테스트가
쉽다 (tests/unit/test_youtube_analytics.py).
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from time import perf_counter
from typing import Any

import httpx

from idol_sight.collectors.base import CollectionResult
from idol_sight.config import GroupConfig

log = logging.getLogger(__name__)

TOKEN_URL = "https://oauth2.googleapis.com/token"
ANALYTICS_URL = "https://youtubeanalytics.googleapis.com/v2/reports"
DOMESTIC = "KR"  # retention_rel 의 기준 국가 (국내)
# 직전 30일 시청시간이 이 미만이면 성장률 계산 안 함(신규 진입 = 분모 노이즈).
MIN_PRIOR_MINUTES = 60.0


def access_token(
    client_id: str, client_secret: str, refresh_token: str,
    http_factory: Callable[[], Any] | None = None,
) -> str:
    """refresh_token 으로 access_token 발급."""
    factory = http_factory or (lambda: httpx.Client(timeout=30.0))
    with factory() as client:
        r = client.post(TOKEN_URL, data={
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        })
        r.raise_for_status()
        return r.json()["access_token"]


def index_rows(resp: dict) -> list[dict[str, Any]]:
    """Analytics reports.query 응답을 컬럼명 키 dict 리스트로."""
    headers = [h["name"] for h in resp.get("columnHeaders", [])]
    out: list[dict[str, Any]] = []
    for row in resp.get("rows", []):
        out.append(dict(zip(headers, row, strict=False)))
    return out


def build_country_rows(
    current: list[dict[str, Any]],
    prior: list[dict[str, Any]],
    group_key: str,
    snapshot_at: str,
    organic: dict[str, float] | None = None,
) -> list[tuple[str, list[Any]]]:
    """국가별 현재/직전 리포트 → agg_youtube_analytics_country INSERT 문.

    current/prior 각 행은 index_rows 결과:
      country, estimatedMinutesWatched, views, subscribersGained, averageViewPercentage
    organic: country → 오가닉(검색+추천) 트래픽 비중 0..1 (best-effort, 없으면 NULL).
    """
    organic = organic or {}
    total_minutes = sum(
        float(r.get("estimatedMinutesWatched", 0) or 0) for r in current
    ) or 1.0
    prior_minutes = {
        r.get("country"): float(r.get("estimatedMinutesWatched", 0) or 0)
        for r in prior
    }
    # 국내(KR) 평균시청률 — retention_rel 의 분모. 없으면 전체 평균으로 폴백.
    kr = next((r for r in current if r.get("country") == DOMESTIC), None)
    if kr and float(kr.get("averageViewPercentage", 0) or 0) > 0:
        domestic_avp = float(kr["averageViewPercentage"])
    else:
        avps = [
            float(r.get("averageViewPercentage", 0) or 0) for r in current
        ]
        domestic_avp = (sum(avps) / len(avps)) if avps else 0.0

    stmts: list[tuple[str, list[Any]]] = []
    for r in current:
        country = r.get("country")
        if not country:
            continue
        minutes = float(r.get("estimatedMinutesWatched", 0) or 0)
        views = float(r.get("views", 0) or 0)
        subs = float(r.get("subscribersGained", 0) or 0)
        avp = float(r.get("averageViewPercentage", 0) or 0)

        watch_share = minutes / total_minutes
        pm = prior_minutes.get(country, 0.0)
        # 직전 윈도우 시청이 미미한 국가(=신규 진입)는 분모≈0 폭발 대신 NULL.
        # 채널이 오래 돌았어도 그 '국가'가 최근에야 보기 시작하면 발생 →
        # +228996% 같은 무의미한 비율 방지. 프론트는 NULL=신규로 다룬다.
        growth_mom = ((minutes - pm) / pm) if pm >= MIN_PRIOR_MINUTES else None
        retention_rel = (avp / domestic_avp) if domestic_avp > 0 else None
        sub_per_1k = (subs / (views / 1000.0)) if views > 0 else 0.0

        stmts.append((
            """
            INSERT INTO agg_youtube_analytics_country
              (group_key, snapshot_at, country, watch_share, growth_mom,
               retention_rel, sub_per_1k, watch_minutes, organic_share, subs_gained)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(group_key, snapshot_at, country) DO UPDATE SET
              watch_share=excluded.watch_share,
              growth_mom=excluded.growth_mom,
              retention_rel=excluded.retention_rel,
              sub_per_1k=excluded.sub_per_1k,
              watch_minutes=excluded.watch_minutes,
              organic_share=excluded.organic_share,
              subs_gained=excluded.subs_gained
            """.strip(),
            [group_key, snapshot_at, country, watch_share, growth_mom,
             retention_rel, sub_per_1k, round(minutes), organic.get(country), round(subs)],
        ))
    return stmts


# 오가닉으로 보는 트래픽 소스 타입 (검색 + 추천 + 채널페이지/알림).
ORGANIC_SOURCES = {
    "YT_SEARCH", "RELATED_VIDEO", "SUBSCRIBER", "YT_CHANNEL",
    "NOTIFICATION", "PLAYLIST",
}


def organic_share_from_traffic(rows: list[dict[str, Any]]) -> float | None:
    """insightTrafficSourceType 리포트 → 오가닉 조회 비중 0..1.

    rows: index_rows 결과 (insightTrafficSourceType, views).
    """
    total = sum(float(r.get("views", 0) or 0) for r in rows)
    if total <= 0:
        return None
    organic = sum(
        float(r.get("views", 0) or 0)
        for r in rows if r.get("insightTrafficSourceType") in ORGANIC_SOURCES
    )
    return organic / total


def build_subscriber_split(
    rows: list[dict[str, Any]],
) -> dict[str, float] | None:
    """subscribedStatus 리포트 → 구독/비구독 시청시간 비중.

    rows: index_rows 결과 (subscribedStatus ∈ {SUBSCRIBED, UNSUBSCRIBED},
    estimatedMinutesWatched). returning_viewers(API 미노출)의 실용 대체재 —
    "구독자가 머무는 코어 vs 신규 유입" 을 시청시간으로 본다.
    데이터 없으면 None (채널 행은 그대로 NULL 유지).
    """
    by_status = {
        r.get("subscribedStatus"): float(r.get("estimatedMinutesWatched", 0) or 0)
        for r in rows
    }
    sub = by_status.get("SUBSCRIBED", 0.0)
    unsub = by_status.get("UNSUBSCRIBED", 0.0)
    total = sub + unsub
    if total <= 0:
        return None
    return {
        "subscribed_watch_share": sub / total,
        "unsubscribed_watch_share": unsub / total,
    }


def build_demographics_rows(
    rows: list[dict[str, Any]],
    group_key: str,
    snapshot_at: str,
) -> list[tuple[str, list[Any]]]:
    """ageGroup×gender 리포트 → agg_youtube_analytics_demographics INSERT.

    rows: index_rows 결과 (ageGroup, gender, viewerPercentage). viewerPercentage
    는 0..100. 굿즈/타겟 코어팬 결정 입력 (소유자 전용 — 공개 API 미노출).
    """
    stmts: list[tuple[str, list[Any]]] = []
    for r in rows:
        age = r.get("ageGroup")
        gender = r.get("gender")
        if not age or not gender:
            continue
        pct = float(r.get("viewerPercentage", 0) or 0)
        stmts.append((
            """
            INSERT INTO agg_youtube_analytics_demographics
              (group_key, snapshot_at, age_group, gender, viewer_pct)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(group_key, snapshot_at, age_group, gender) DO UPDATE SET
              viewer_pct=excluded.viewer_pct
            """.strip(),
            [group_key, snapshot_at, age, gender, round(pct, 2)],
        ))
    return stmts


class YouTubeAnalyticsCollector:
    source = "youtube-analytics"

    def __init__(
        self,
        client_id: str,
        client_secret: str,
        refresh_token: str,
        http_factory: Callable[[], Any] | None = None,
    ):
        self._cid = client_id
        self._secret = client_secret
        self._refresh = refresh_token
        self._http_factory = http_factory or (lambda: httpx.Client(timeout=30.0))

    def _report(self, token: str, start: str, end: str) -> dict:
        with self._http_factory() as client:
            r = client.get(
                ANALYTICS_URL,
                params={
                    "ids": "channel==MINE",
                    "startDate": start,
                    "endDate": end,
                    "metrics": "estimatedMinutesWatched,views,"
                               "subscribersGained,averageViewPercentage",
                    "dimensions": "country",
                    "sort": "-estimatedMinutesWatched",
                    "maxResults": 50,
                },
                headers={"Authorization": f"Bearer {token}"},
            )
            r.raise_for_status()
            return r.json()

    def _traffic_report(self, token: str, start: str, end: str, country: str) -> dict:
        """단일 국가의 트래픽 소스 타입별 조회수. country 는 filter 로 (차원
        조합 제약 회피). 권한/조합 미지원 시 호출부에서 catch."""
        with self._http_factory() as client:
            r = client.get(
                ANALYTICS_URL,
                params={
                    "ids": "channel==MINE",
                    "startDate": start, "endDate": end,
                    "metrics": "views",
                    "dimensions": "insightTrafficSourceType",
                    "filters": f"country=={country}",
                    "maxResults": 25,
                },
                headers={"Authorization": f"Bearer {token}"},
            )
            r.raise_for_status()
            return r.json()

    def _subscribed_report(self, token: str, start: str, end: str) -> dict:
        """구독 상태별 시청시간 (returning 시청자 대체재). best-effort."""
        with self._http_factory() as client:
            r = client.get(
                ANALYTICS_URL,
                params={
                    "ids": "channel==MINE",
                    "startDate": start, "endDate": end,
                    "metrics": "estimatedMinutesWatched",
                    "dimensions": "subscribedStatus",
                    "maxResults": 10,
                },
                headers={"Authorization": f"Bearer {token}"},
            )
            r.raise_for_status()
            return r.json()

    def _demographics_report(self, token: str, start: str, end: str) -> dict:
        """연령×성별 시청 비중(viewerPercentage). best-effort.

        viewerPercentage 는 다른 metric 과 혼합 불가라 단독 호출한다."""
        with self._http_factory() as client:
            r = client.get(
                ANALYTICS_URL,
                params={
                    "ids": "channel==MINE",
                    "startDate": start, "endDate": end,
                    "metrics": "viewerPercentage",
                    "dimensions": "ageGroup,gender",
                    "maxResults": 50,
                },
                headers={"Authorization": f"Bearer {token}"},
            )
            r.raise_for_status()
            return r.json()

    def collect(
        self, group: GroupConfig, since: str | None = None,
    ) -> CollectionResult:
        started = perf_counter()
        now = datetime.now(UTC)
        snapshot_at = now.strftime("%Y-%m-%dT%H:%M:%SZ")
        cur_end = now.date()
        cur_start = cur_end - timedelta(days=30)
        prior_end = cur_start - timedelta(days=1)
        prior_start = prior_end - timedelta(days=30)

        token = access_token(
            self._cid, self._secret, self._refresh, self._http_factory,
        )
        cur = index_rows(self._report(
            token, cur_start.isoformat(), cur_end.isoformat()))
        prior = index_rows(self._report(
            token, prior_start.isoformat(), prior_end.isoformat()))

        # #3 트래픽 소스 — 상위 국가별 오가닉 비중 (best-effort). 차원 조합
        # 제약·권한 등으로 실패할 수 있어 try/except 로 감싸고, 실패 시
        # organic_share 는 NULL 로 둔다 (핵심 수집은 절대 깨지 않는다).
        organic: dict[str, float] = {}
        top_countries = [r["country"] for r in cur[:12] if r.get("country")]
        for country in top_countries:
            try:
                share = organic_share_from_traffic(index_rows(
                    self._traffic_report(
                        token, cur_start.isoformat(), cur_end.isoformat(), country)))
                if share is not None:
                    organic[country] = share
            except Exception as exc:  # noqa: BLE001 — 보조 지표, 비치명적.
                log.info("traffic-source skip %s: %s", country, exc)

        stmts = build_country_rows(cur, prior, group.key, snapshot_at, organic)

        # 시청자 구성 (migration 0091) — 둘 다 best-effort. 권한/조합 제약 시
        # 핵심 국가 수집을 깨지 않도록 try/except 로 감싼다 (traffic 와 동일).
        split: dict[str, float] | None = None
        try:
            split = build_subscriber_split(index_rows(self._subscribed_report(
                token, cur_start.isoformat(), cur_end.isoformat())))
        except Exception as exc:  # noqa: BLE001 — 보조 지표, 비치명적.
            log.info("subscribed-status skip: %s", exc)
        try:
            stmts.extend(build_demographics_rows(
                index_rows(self._demographics_report(
                    token, cur_start.isoformat(), cur_end.isoformat())),
                group.key, snapshot_at))
        except Exception as exc:  # noqa: BLE001 — 보조 지표, 비치명적.
            log.info("demographics skip: %s", exc)

        # 채널 단위 행 — returning/멤버십/슈퍼챗은 API 미노출로 NULL 유지.
        # 구독/비구독 시청 비중(subscribedStatus)은 0091 로 수집되면 채운다
        # (returning 시청자의 실용 대체재). 없으면 NULL.
        sub_share = split["subscribed_watch_share"] if split else None
        unsub_share = split["unsubscribed_watch_share"] if split else None
        stmts.append((
            """
            INSERT INTO agg_youtube_analytics
              (group_key, snapshot_at, returning_viewers_30d,
               membership_count, membership_penetration, has_super_chat,
               subscribed_watch_share, unsubscribed_watch_share)
            VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?)
            ON CONFLICT(group_key, snapshot_at) DO UPDATE SET
              subscribed_watch_share=excluded.subscribed_watch_share,
              unsubscribed_watch_share=excluded.unsubscribed_watch_share
            """.strip(),
            [group.key, snapshot_at, sub_share, unsub_share],
        ))

        runtime_ms = int((perf_counter() - started) * 1000)
        return CollectionResult(
            rows_inserted=len(stmts), rows_updated=0,
            statements=stmts, runtime_ms=runtime_ms,
        )
