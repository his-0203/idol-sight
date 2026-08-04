"""월간 보고서 — 순수 함수(단위·MoM·자동 결론 R1~R6) 테스트."""

from idol_sight.analysis.monthly_report import (
    band_verdict,
    cohort_rank_line,
    fmt_num,
    kpi_headline,
    kpi_judgments,
    kpi_line,
    mom_phrase,
    month_bounds,
    month_last_day,
    prev_month,
    quadrant_move_line,
    spike_note,
    tier_line,
)


def test_month_bounds_and_helpers():
    assert month_bounds("2026-07") == ("2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z")
    assert month_bounds("2026-12")[1] == "2027-01-01T00:00:00Z"
    assert prev_month("2026-01") == "2025-12"
    assert month_last_day("2026-02") == "2026-02-28"


def test_fmt_and_mom_mirror_monthly_report_style():
    # 기존 먼슬리 보고 표기: '28.6k (전월 27.9k)'
    assert fmt_num(28600) == "28.6k"
    assert fmt_num(6895) == "6,895"
    assert mom_phrase(28600, 27900) == "28.6k (전월 27.9k)"
    assert mom_phrase(369, None) == "369 (전월 —)"


def test_kpi_judgments_and_headline_r1():
    # 2026-07 밴드: 구독 32~35k · 동접 700~760 · 위버스 4.2~4.6k · 멤버십 70~80
    j = kpi_judgments("2026-07", {
        "subscribers": 28600, "avg_ccv": 369,
        "weverse_members": 8447, "weverse_membership": 111,
    })
    assert j["subscribers"]["verdict"] == "below"
    assert j["avg_ccv"]["verdict"] == "below"
    assert j["weverse_members"]["verdict"] == "above"
    assert j["weverse_membership"]["verdict"] == "above"
    head = kpi_headline(j)
    assert "2개 미달" in head and "페이스 점검" in head


def test_kpi_headline_all_within_and_band_edges():
    j = kpi_judgments("2026-07", {
        "subscribers": 32000, "avg_ccv": 760,       # 경계 포함 within
        "weverse_members": 4400, "weverse_membership": 75,
    })
    assert all(x["verdict"] == "within" for x in j.values())
    assert "모두 목표 밴드 내" in kpi_headline(j)
    assert band_verdict(31999, (32000, 35000)) == "below"


def test_kpi_headline_no_bands_month():
    j = kpi_judgments("2026-06", {"subscribers": 27900, "avg_ccv": 585,
                                  "weverse_members": None,
                                  "weverse_membership": None})
    assert "판정 가능한 KPI 없음" in kpi_headline(j)


def test_kpi_line_r2_below_quantifies_gap():
    j = kpi_judgments("2026-07", {"subscribers": 28600, "avg_ccv": None,
                                  "weverse_members": None,
                                  "weverse_membership": None})
    line = kpi_line(j["subscribers"], 27900)
    assert "28.6k (전월 27.9k)" in line
    assert "3,400 부족" in line


def test_tier_line_r3():
    assert "신규 산출" in tier_line(None, 2, 5, 10)
    assert "상승" in tier_line(3, 2, None, None)
    assert "유지(추격 그룹) — 카테고리 내 조회 흐름 5위/10팀" == \
        tier_line(2, 2, 5, 10).replace("티어 ", "", 1)
    assert tier_line(2, None, None, None) is None


def test_cohort_rank_line_r4():
    assert "2위 → 1위" in cohort_rank_line(1, 2, 5, 3.1, 2.8)
    keep = cohort_rank_line(2, 2, 5, 1.15, 1.10)
    assert "동시기 2위" in keep and "1.15x" in keep and "전월 1.10x" in keep


def test_quadrant_move_line_r5_silent_on_hold():
    labels = {"niche": "니치 충성", "strong": "진성 강세"}
    assert quadrant_move_line("niche", "niche", labels) is None
    assert "니치 충성 → 진성 강세" in quadrant_move_line("niche", "strong", labels)


def test_spike_note_r6_event_attribution():
    days = [(f"2026-07-{d:02d}", 30) for d in range(1, 28)]
    days[14] = ("2026-07-15", 400)   # median 30 × 5 초과
    note = spike_note(days, [{"event_date": "2026-07-16", "title": "신곡 공개"}])
    assert "신곡 공개" in note and "스파이크" in note
    note2 = spike_note(days, [])
    assert "원인 미상" in note2
    assert spike_note(days[:5], []) is None   # 표본 부족 → 각주 없음
