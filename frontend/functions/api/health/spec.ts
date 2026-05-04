import { jsonResponse } from "../../lib/jsonResponse";

// Mirror of WEIGHTS from worker/src/idol_sight/analysis/health_score.py.
// Frontend uses this to render the spec modal — single source of truth.
export const onRequestGet: PagesFunction = async () =>
  jsonResponse({
    weights: { subscribers: 20, views: 20, quality: 15, community: 20, news: 10, risk: 15 },
    bonus_max: 10,
    denom: 110,
    grade_thresholds: [["S",9],["A",7],["B",5],["C",3],["D",0]],
    grade_labels: {
      S: "정상 궤도", A: "안정적", B: "성장 중",
      C: "초기 진입", D: "활동 미미", PRE: "데뷔 전 (활동량 부족)",
    },
    references: {
      subscribers: "yt_subscribers ÷ 1,000,000",
      views: "yt_total_views ÷ 200,000,000",
      quality: "Top-10 평균 조회수 ÷ 10,000,000",
      community: "(dc + theqoo + instiz) ÷ 200,000",
      news: "naver_total_news ÷ 500",
      risk: "1 − controversy_count/10",
      bonus: "최근 90d/30d 활동량 가산 (각 7/3점)",
    },
  });
