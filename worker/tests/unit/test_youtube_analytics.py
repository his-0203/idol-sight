"""youtube_analytics collector 의 순수 계산 로직 검증.

HTTP 는 건드리지 않고 build_country_rows / index_rows 만 — 국가별 점수의
4축(watch_share / growth_mom / retention_rel / sub_per_1k)이 의도대로
계산되는지 고정한다.
"""

from idol_sight.collectors.youtube_analytics import (
    build_country_rows,
    index_rows,
    organic_share_from_traffic,
)


def test_index_rows_maps_column_headers():
    resp = {
        "columnHeaders": [
            {"name": "country"}, {"name": "estimatedMinutesWatched"},
            {"name": "views"}, {"name": "subscribersGained"},
            {"name": "averageViewPercentage"},
        ],
        "rows": [
            ["JP", 1200, 600, 30, 50.0],
            ["KR", 800, 500, 10, 45.0],
        ],
    }
    rows = index_rows(resp)
    assert rows[0] == {
        "country": "JP", "estimatedMinutesWatched": 1200, "views": 600,
        "subscribersGained": 30, "averageViewPercentage": 50.0,
    }


def test_index_rows_empty():
    assert index_rows({}) == []


def _params(stmt):
    return stmt[1]


def test_build_country_rows_computes_four_axes():
    current = [
        {"country": "JP", "estimatedMinutesWatched": 1200, "views": 600,
         "subscribersGained": 30, "averageViewPercentage": 54.0},
        {"country": "KR", "estimatedMinutesWatched": 800, "views": 500,
         "subscribersGained": 10, "averageViewPercentage": 45.0},
    ]
    prior = [
        {"country": "JP", "estimatedMinutesWatched": 1000},
        {"country": "KR", "estimatedMinutesWatched": 900},
    ]
    rows = build_country_rows(current, prior, "miiwan", "2026-06-16T00:00:00Z")
    by_country = {_params(r)[2]: _params(r) for r in rows}

    jp = by_country["JP"]
    # params: [group, snapshot, country, watch_share, growth_mom, retention_rel, sub_per_1k]
    # watch_share = 1200 / (1200+800) = 0.6
    assert abs(jp[3] - 0.6) < 1e-9
    # growth_mom = (1200-1000)/1000 = 0.2
    assert abs(jp[4] - 0.2) < 1e-9
    # retention_rel = 54 / 45 (KR 기준) = 1.2
    assert abs(jp[5] - 1.2) < 1e-9
    # sub_per_1k = 30 / (600/1000) = 50
    assert abs(jp[6] - 50.0) < 1e-9


def test_growth_mom_none_when_prior_below_threshold():
    # 직전 시청 30분(<60) = 신규 진입 → 폭발 비율 대신 None.
    current = [{"country": "BR", "estimatedMinutesWatched": 5000, "views": 100,
                "subscribersGained": 5, "averageViewPercentage": 40.0}]
    prior = [{"country": "BR", "estimatedMinutesWatched": 30}]
    rows = build_country_rows(current, prior, "miiwan", "2026-06-16T00:00:00Z")
    assert _params(rows[0])[4] is None
    # 직전 200분(>=60)이면 정상 계산
    prior2 = [{"country": "BR", "estimatedMinutesWatched": 200}]
    rows2 = build_country_rows(current, prior2, "miiwan", "2026-06-16T00:00:00Z")
    assert _params(rows2[0])[4] is not None


def test_growth_mom_none_when_no_prior():
    current = [
        {"country": "BR", "estimatedMinutesWatched": 500, "views": 100,
         "subscribersGained": 5, "averageViewPercentage": 40.0},
    ]
    rows = build_country_rows(current, [], "miiwan", "2026-06-16T00:00:00Z")
    # prior 없음 → growth_mom None
    assert _params(rows[0])[4] is None


def test_watch_minutes_and_organic_stored():
    current = [
        {"country": "JP", "estimatedMinutesWatched": 1200.7, "views": 600,
         "subscribersGained": 30, "averageViewPercentage": 54.0},
    ]
    rows = build_country_rows(current, [], "miiwan", "2026-06-16T00:00:00Z",
                              organic={"JP": 0.82})
    p = _params(rows[0])
    # params: [..., sub_per_1k, watch_minutes, organic_share, subs_gained]
    assert p[7] == 1201          # round(1200.7)
    assert p[8] == 0.82
    assert p[9] == 30            # round(subscribersGained)


def test_organic_share_from_traffic():
    rows = [
        {"insightTrafficSourceType": "YT_SEARCH", "views": 400},
        {"insightTrafficSourceType": "RELATED_VIDEO", "views": 300},
        {"insightTrafficSourceType": "EXT_URL", "views": 200},
        {"insightTrafficSourceType": "SHARES", "views": 100},
    ]
    # 오가닉 = 검색400+추천300 = 700 / 전체 1000 = 0.7
    assert organic_share_from_traffic(rows) == 0.7


def test_organic_share_none_when_no_views():
    assert organic_share_from_traffic([]) is None


def test_sub_per_1k_zero_when_no_views():
    current = [
        {"country": "US", "estimatedMinutesWatched": 100, "views": 0,
         "subscribersGained": 3, "averageViewPercentage": 30.0},
    ]
    rows = build_country_rows(current, [], "miiwan", "2026-06-16T00:00:00Z")
    assert _params(rows[0])[6] == 0.0


def test_retention_rel_falls_back_to_overall_avg_when_no_kr():
    # KR 행이 없으면 전체 평균을 분모로 — 분모 0/누락 방어.
    current = [
        {"country": "JP", "estimatedMinutesWatched": 1000, "views": 500,
         "subscribersGained": 20, "averageViewPercentage": 60.0},
        {"country": "US", "estimatedMinutesWatched": 500, "views": 300,
         "subscribersGained": 10, "averageViewPercentage": 40.0},
    ]
    rows = build_country_rows(current, [], "miiwan", "2026-06-16T00:00:00Z")
    by_country = {_params(r)[2]: _params(r) for r in rows}
    # 전체 평균 avp = (60+40)/2 = 50 → JP retention_rel = 60/50 = 1.2
    assert abs(by_country["JP"][5] - 1.2) < 1e-9
