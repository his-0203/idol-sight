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
      subscribers: "yt_subscribers / (내부+외부 코호트 p75)",
      views:       "yt_total_views / (내부+외부 코호트 p75)",
      quality:     "(likes + 5·comments) / views, 내부 코호트 p75 engagement rate 정규화",
      community:   "(dc + theqoo + instiz) / 내부 코호트 p75",
      news:        "naver_total_news / (내부+외부 코호트 p75)",
      risk:        "1 − controversy_count/10 (4-factor 모두에 곱)",
      bonus:       "최근 90d/30d 영상 활동량 가산 (각 ≤7/≤3점, 합산 ≤10)",
      hanteo:      "초동 sales / 1,000,000 (절대값 정규화 — 코호트 무관, 1M=saturated)",
      music_show_wins:
                   "음방 1위 누적 횟수 / 5 (saturate). V2.16 ritual stub — collector 미구현, " +
                   "manual seed 가능. cohort-level 모두 0이면 dead 처리.",
      cohort_percentile: "DYNAMIC_REF_PERCENTILE = 0.75 — 1.0=top quartile. " +
                         "내부 9그룹 + 외부 K-pop 벤치마크(external_groups) 합쳐서 percentile 계산. " +
                         "PLAVE saturate 방지 + 시장 정합성 회복.",
      external_cohort:
                   "external_groups/external_metrics — 에스파/RIIZE/뉴진스 등 K-pop 벤치마크. " +
                   "subscribers/views/news REF에만 머지 (engagement·community는 내부 코호트만 — K-pop " +
                   "메인라인은 dc/theqoo 추적 안 함).",
      absolute_scoring:
                   "V2.16: cold-start floor 제거. 데뷔 첫날 그룹도 절대값 그대로. " +
                   "참여 가산 없음.",
    },

    // V2.5 4-factor model — bundles raw signals into the four ways an
    // idol's traction actually accrues, with model-specific weights so
    // ISEDOL/STELLIVE aren't graded on PLAVE's playbook.
    factor_weights: {
      corporate:     { reach: 25, ritual: 30, mobilization: 30, intimacy: 15 },
      segmentary:    { reach: 20, ritual: 15, mobilization: 25, intimacy: 40 },
      confederation: { reach: 15, ritual: 10, mobilization: 20, intimacy: 55 },
    },
    factor_inputs: {
      reach:        "0.50 subscribers + 0.35 views + 0.15 news (redistribute=True)",
      ritual:       "0.50 hanteo + 0.20 news + 0.30 music_show_wins (V2.16 redistribute=False — " +
                    "한터/음방 부재 시 weight가 news로 재분배되지 않음)",
      mobilization: "0.40 views + 0.25 cadence(v90) + 0.25 hanteo + 0.10 subs",
      intimacy:     "(0.55 quality + 0.45 community) × (1 − negative_ratio)",
    },
    factor_descriptions: {
      reach:        "도달 — 구독자, 누적 조회수, 뉴스 노출",
      ritual:       "의례 승리 — 한터 초동, 뉴스, 음방 1위 (V2.16: redistribute 차단)",
      mobilization: "동원 — 누적 조회수, 영상 cadence, 한터 초동, 구독자",
      intimacy:     "친밀성 — 인게이지먼트(좋아요+댓글)·커뮤니티, 부정 sentiment 시 압축",
    },
    group_models: {
      corporate:     "K-pop 정통 (그룹 1차) — PLAVE / SKINZ / OWIS / MY:RAKL / MiiWAN / B:DAWN / WE GO-6",
      segmentary:    "왁타버스 IP 위성 (솔로 활동 비중 높음) — ISEDOL",
      confederation: "V-tuber 우산 모델 (멤버 portfolio) — STELLIVE",
    },
  });
