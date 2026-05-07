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
      subscribers: "yt_subscribers / 내부 코호트 p75 (linear)",
      views:       "yt_total_views / 내부 코호트 p75 (linear)",
      quality:     "(likes + 5·comments) / views, 내부 코호트 p75 engagement rate 정규화",
      community:   "(dc + theqoo + instiz) / 내부 코호트 p75",
      news:        "log1p(naver_total_news) / log1p(내부 코호트 p75) — V2.17 log scale. " +
                   "영문 brand 그룹(SKINZ)이 한국 naver 뉴스에 잘 안 잡혀 raw count 차이가 " +
                   "reach/ritual을 좌우하던 group-name spelling 효과를 압축.",
      risk:        "1 − controversy_count/10 (4-factor 모두에 곱)",
      bonus:       "최근 90d/30d 영상 활동량 가산 (각 ≤7/≤3점, 합산 ≤10)",
      hanteo:      "초동 sales / 1,000,000 (절대값 정규화 — 코호트 무관, 1M=saturated)",
      music_show_wins:
                   "음방 1위 누적 횟수 / 5 (saturate). V2.16 ritual stub — collector 미구현, " +
                   "manual seed 가능. cohort-level 모두 0이면 dead 처리.",
      melon_top100_peak:
                   "멜론 TOP 100 최고 순위 (1=최고, 100=최저, 미진입=NULL). " +
                   "(101 - peak) / 100 정규화 → 1위 1.0 / 100위 0.01. " +
                   "V2.19: collector가 realtime + daily 두 차트 union의 best rank를 기록. " +
                   "weight 0.20 → 0.10 (절반은 chart_depth로 양도).",
      melon_top100_depth:
                   "멜론 TOP 100 진입곡 수 (realtime + daily union, song_id dedup, 미진입=NULL/0). " +
                   "min(depth/5, 1.0) 정규화 → 5곡 동시 진입 saturated. " +
                   "V2.19 신설 — best rank 단독으로 잡히지 않는 음원 깊이(PLAVE 6곡 vs 단곡 진입) 변별 시그널.",
      cohort_percentile: "DYNAMIC_REF_PERCENTILE = 0.75 — 1.0=top quartile. " +
                         "내부 9그룹 코호트 단독 p75 (V2.17: external 머지 철회).",
      external_cohort:
                   "V2.17 운영 default: 비활성. external_groups/external_metrics는 표시용으로만 " +
                   "유지 (MarketOverview 별도 view). health_score REF는 내부 코호트 단독 — D-tier " +
                   "그룹 변별력 보호.",
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
      reach:        "0.55 subscribers + 0.40 views + 0.05 news (V2.17: news 0.15→0.05)",
      ritual:       "0.50 hanteo + 0.10 news + 0.20 music_show_wins + 0.10 chart_peak + 0.10 chart_depth " +
                    "(V2.19: chart_peak 0.20→0.10, chart_depth 신규 0.10 — 차트 축 0.20을 peak/depth 반반. " +
                    "redistribute=False — 어느 시그널 부재 시 그 weight 만큼 ritual 자연 감소)",
      mobilization: "0.40 views + 0.25 cadence(v90) + 0.25 hanteo + 0.10 subs",
      intimacy:     "(0.55 quality + 0.45 community) × (1 − negative_ratio)",
    },
    factor_descriptions: {
      reach:        "도달 — 구독자, 누적 조회수, 뉴스 노출",
      ritual:       "의례 승리 — 한터 초동, 뉴스, 음방 1위, 음원 차트 peak/depth (V2.19: chart_depth 추가)",
      mobilization: "동원 — 누적 조회수, 영상 cadence, 한터 초동, 구독자",
      intimacy:     "친밀성 — 인게이지먼트(좋아요+댓글)·커뮤니티, 부정 sentiment 시 압축",
    },
    group_models: {
      corporate:     "K-pop 정통 (그룹 1차) — PLAVE / SKINZ / OWIS / MY:RAKL / MiiWAN / B:DAWN / WE GO-6",
      segmentary:    "서브컬처 버추얼 IP (멤버 솔로 활동 비중 높음) — ISEDOL / STELLIVE (V2.18 통합)",
      confederation: "V-tuber 우산 모델 (해체 시 복구용 카테고리, 운영 default 미사용)",
    },
  });
