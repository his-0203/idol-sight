// /api/miiwan-live-chat — 달력용 available(전체 라이브 날짜) + 선택 리포트(기본=최신).
//
// D1→API 계약 고정: available 은 report_json 없이 가볍게 전체, report 는 선택된
// video_id(미지정 시 최신) 1건의 풀 바디. (라이브 엔드포인트는 HMAC 게이트라
// 이 변환 레이어를 테스트로 검증.)

import { describe, expect, it, vi } from "vitest";
import { onRequestGet } from "../../functions/api/miiwan-live-chat";

const ROWS = [
  {
    video_id: "v_new", title: "데뷔 라이브", ended_at: "2026-06-16T13:00:00Z",
    generated_at: "2026-06-16T19:00:00Z", total_messages: 1200, sampled: 500,
    positive_ratio: 0.6, negative_ratio: 0.1,
    report_json: JSON.stringify({ summary: "호평", positive_all: ["좋다"], negative_all: [] }),
  },
  {
    video_id: "v_old", title: "옛 라이브", ended_at: "2026-06-10T13:00:00Z",
    generated_at: "2026-06-10T19:00:00Z", total_messages: 300, sampled: 120,
    positive_ratio: 0.4, negative_ratio: 0.2,
    report_json: JSON.stringify({ summary: "무난", positive_all: [], negative_all: ["별로"] }),
  },
];

// SQL 부분일치 + video_id 바인드로 분기하는 D1 목.
const envWith = () => ({
  DB: {
    prepare: vi.fn((sql: string) => {
      let bound: unknown[] = [];
      const api: any = {
        bind: vi.fn((...args: unknown[]) => { bound = args; return api; }),
        all: vi.fn(async () => {
          if (sql.includes("report_json")) {
            // 선택 리포트 조회: 2번째 바인드가 video_id
            const vid = bound[1];
            return { results: ROWS.filter((r) => r.video_id === vid) };
          }
          // available: report_json 없이 전체
          return {
            results: ROWS.map((r) => ({
              video_id: r.video_id, title: r.title, ended_at: r.ended_at,
            })),
          };
        }),
        first: vi.fn(async () => null),
      };
      return api;
    }),
  },
} as any);

async function call(url: string) {
  const env = envWith();
  const res = await onRequestGet({ env, request: new Request(url) } as any);
  return res.json() as Promise<any>;
}

describe("/api/miiwan-live-chat", () => {
  it("available 은 전체 라이브 날짜(가벼움), report 는 기본=최신", async () => {
    const body = await call("https://x/api/miiwan-live-chat");
    expect(body.available.map((a: any) => a.video_id)).toEqual(["v_new", "v_old"]);
    expect(body.available[0]).not.toHaveProperty("report_json");
    expect(body.report.video_id).toBe("v_new"); // 최신
    expect(body.report.report.summary).toBe("호평"); // report_json 파싱됨
    expect(body.report.report.positive_all).toEqual(["좋다"]);
  });

  it("video_id 지정 시 그 방송 리포트를 돌려준다", async () => {
    const body = await call("https://x/api/miiwan-live-chat?video_id=v_old");
    expect(body.report.video_id).toBe("v_old");
    expect(body.report.report.negative_all).toEqual(["별로"]);
    expect(body.available).toHaveLength(2); // 달력 데이터는 항상 전체
  });
});
