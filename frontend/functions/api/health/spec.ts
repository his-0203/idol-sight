import { jsonResponse } from "../../lib/jsonResponse";

// Mirror of worker/src/idol_sight/analysis/health_score.py — single
// source of truth for the spec modal. Both the legacy 6-component
// breakdown and the V2.5 4-factor model are surfaced; the frontend
// chooses which view to render.
export const onRequestGet: PagesFunction = async () =>
  jsonResponse({
    // Legacy 6-component view (still supported for older callers).
    weights: { subscribers: 20, views: 20, quality: 15, community: 20, news: 10, risk: 15 },
    bonus_max: 10,
    denom: 110,
    grade_thresholds: [["S",9],["A",7],["B",5],["C",3],["D",0]],
    grade_labels: {
      S: "정상 궤도", A: "안정적", B: "성장 중",
      C: "초기 진입", D: "활동 미미", PRE: "데뷔 전 (활동량 부족)",
    },
    references: {
      subscribers: "yt_subscribers / cohort p75 (DYNAMIC_REF_PERCENTILE=0.75)",
      views:       "yt_total_views / cohort p75",
      quality:     "(likes + 5·comments) / views, normalized against cohort p75 engagement rate",
      community:   "(dc + theqoo + instiz) / cohort p75",
      news:        "naver_total_news / cohort p75",
      risk:        "1 − controversy_count/10 (multiplies all 4 factors, not just one)",
      bonus:       "최근 90d/30d 영상 활동량 가산 (각 ≤7/≤3점, 합산 ≤10)",
      hanteo:      "초동 sales / 1,000,000 (절대값 정규화 — 코호트 무관, 1M=saturated)",
      cold_start:  "데뷔 < 90일 그룹은 floor 적용 (day 0 → 3.5점, day 89 → 0점 선형 감소)",
      cohort_percentile: "DYNAMIC_REF_PERCENTILE = 0.75 — 1.0=top quartile. " +
                         "p90이 아니라 p75인 이유: 활성 7-그룹 + PLAVE가 모든 축에서 " +
                         "5-10× 우위 → p90이 사실상 PLAVE-pin 되어 하위 그룹이 [0–0.1]에 " +
                         "몰리던 문제(V2.14)를 풀기 위해 0.90 → 0.75로 완화.",
    },

    // V2.5 4-factor model — bundles raw signals into the four ways an
    // idol's traction actually accrues, with model-specific weights so
    // ISEDOL/STELLIVE aren't graded on PLAVE's playbook.
    factor_weights: {
      corporate:     { reach: 25, ritual: 30, mobilization: 30, intimacy: 15 },
      segmentary:    { reach: 20, ritual: 15, mobilization: 25, intimacy: 40 },
      confederation: { reach: 15, ritual: 10, mobilization: 20, intimacy: 55 },
    },
    factor_descriptions: {
      reach:        "도달 — 구독자, 누적 조회수, 뉴스 노출",
      ritual:       "의례 승리 — 한터 초동, 차트/외부 콜라보",
      mobilization: "동원 — 누적 조회수, 한터 초동, 구독자",
      intimacy:     "친밀성 — 인게이지먼트(좋아요+댓글)·커뮤니티, 부정 sentiment 시 압축",
    },
    group_models: {
      corporate:     "K-pop 정통 (그룹 1차) — PLAVE / SKINZ / OWIS / MY:RAKL / MiiWAN / B:DAWN",
      segmentary:    "왁타버스 IP 위성 (솔로 활동 비중 높음) — ISEDOL",
      confederation: "V-tuber 우산 모델 (멤버 portfolio) — STELLIVE",
    },
  });
