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
        growth_mom = ((minutes - pm) / pm) if pm > 0 else None
        retention_rel = (avp / domestic_avp) if domestic_avp > 0 else None
        sub_per_1k = (subs / (views / 1000.0)) if views > 0 else 0.0

        stmts.append((
            """
            INSERT INTO agg_youtube_analytics_country
              (group_key, snapshot_at, country, watch_share, growth_mom,
               retention_rel, sub_per_1k, watch_minutes, organic_share)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(group_key, snapshot_at, country) DO UPDATE SET
              watch_share=excluded.watch_share,
              growth_mom=excluded.growth_mom,
              retention_rel=excluded.retention_rel,
              sub_per_1k=excluded.sub_per_1k,
              watch_minutes=excluded.watch_minutes,
              organic_share=excluded.organic_share
            """.strip(),
            [group_key, snapshot_at, country, watch_share, growth_mom,
             retention_rel, sub_per_1k, round(minutes), organic.get(country)],
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

        # 채널 단위 행 — 멤버십/재방문은 Analytics API 가 깔끔히 노출하지
        # 않아 현재 NULL. 국가 데이터가 들어왔다는 snapshot 마커 역할 +
        # 추후 지표 확보 시 채울 자리.
        stmts.append((
            """
            INSERT INTO agg_youtube_analytics
              (group_key, snapshot_at, returning_viewers_30d,
               membership_count, membership_penetration, has_super_chat)
            VALUES (?, ?, NULL, NULL, NULL, NULL)
            ON CONFLICT(group_key, snapshot_at) DO NOTHING
            """.strip(),
            [group.key, snapshot_at],
        ))

        runtime_ms = int((perf_counter() - started) * 1000)
        return CollectionResult(
            rows_inserted=len(stmts), rows_updated=0,
            statements=stmts, runtime_ms=runtime_ms,
        )
