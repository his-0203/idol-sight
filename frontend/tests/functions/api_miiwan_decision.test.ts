// /api/miiwan 의 decision.analytics 매핑 검증.
//
// 워커가 agg_youtube_analytics* 에 적재한 행이 프론트(DecisionBoard)가
// 먹는 decision.analytics 모양으로 정확히 변환되는지 — D1→API 계약을 고정.
// (라이브 엔드포인트는 HMAC 게이트라 직접 못 보므로 이 레이어를 테스트로 검증.)

import { describe, expect, it, vi } from "vitest";
import { onRequestGet } from "../../functions/api/miiwan";

const MIIWAN = {
  key: "miiwan", name: "MiiWAN", name_kr: "미완소년",
  debut_date: "2026-06-01", yt_channel_id: "UCxxxx",
};

// SQL 부분일치로 분기하는 D1 목. 미지정 쿼리는 [] (안전).
const envWith = (handler: (sql: string) => any[]) => ({
  DB: { prepare: vi.fn((sql: string) => ({
    bind: vi.fn().mockReturnThis(),
    all: vi.fn(async () => ({ results: handler(sql) })),
    first: vi.fn(async () => handler(sql)[0] ?? null),
  })) },
} as any);

function baseHandler(sql: string): any[] {
  // 벤치마크(groups key IN ...) 는 빈 배열, 그룹 메타만 miiwan.
  if (sql.includes("FROM groups") && sql.includes("key IN")) return [];
  if (sql.includes("FROM groups")) return [MIIWAN];
  return [];
}

describe("/api/miiwan decision.analytics", () => {
  it("국가 행 → analytics.countries 로 필드 정확 매핑 + analytics 비-null", async () => {
    const env = envWith((sql) => {
      if (sql.includes("agg_youtube_analytics_country")) {
        return [
          { country: "JP", watch_share: 0.6, growth_mom: 0.2,
            retention_rel: 1.2, sub_per_1k: 50 },
          { country: "US", watch_share: 0.3, growth_mom: -0.1,
            retention_rel: 0.7, sub_per_1k: 4 },
        ];
      }
      // 채널 단위 행 (country 아님) — has_super_chat 1.
      if (sql.includes("agg_youtube_analytics")) {
        return [{ snapshot_at: "2026-06-16T00:00:00Z",
                  returning_viewers_30d: null, membership_count: null,
                  membership_penetration: null, has_super_chat: 1 }];
      }
      return baseHandler(sql);
    });

    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    const body = await res.json() as any;

    const a = body.decision.analytics;
    expect(a).not.toBeNull();
    expect(a.snapshot_at).toBe("2026-06-16T00:00:00Z");
    expect(a.countries).toHaveLength(2);
    // watch_share DESC 정렬 가정 → JP 먼저. 필드 매핑 정확성.
    expect(a.countries[0]).toEqual({
      country: "JP", watch_share: 0.6, growth_mom: 0.2,
      retention_rel: 1.2, sub_per_1k: 50,
    });
    // has_super_chat 1(int) → boolean true 로 변환.
    expect(a.has_super_chat).toBe(true);
    // OAuth 미노출 칼럼은 null 유지 (수요하한/지불의향 '대기' 근거).
    expect(a.returning_viewers_30d).toBeNull();
    expect(a.membership_count).toBeNull();
  });

  it("analytics 행 없으면 analytics=null (프론트 empty-state)", async () => {
    const env = envWith(baseHandler); // 모든 analytics 쿼리 [] 반환
    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    const body = await res.json() as any;
    expect(body.decision.analytics).toBeNull();
    // 멤버배분은 analytics 와 독립 — 키는 항상 존재.
    expect(Array.isArray(body.decision.member_popularity)).toBe(true);
  });

  it("국가 null 칼럼은 안전 디폴트(growth 0 / retention 1)로 채움", async () => {
    const env = envWith((sql) => {
      if (sql.includes("agg_youtube_analytics_country")) {
        return [{ country: "BR", watch_share: 0.1, growth_mom: null,
                  retention_rel: null, sub_per_1k: 9 }];
      }
      if (sql.includes("agg_youtube_analytics")) {
        return [{ snapshot_at: "2026-06-16T00:00:00Z", returning_viewers_30d: null,
                  membership_count: null, membership_penetration: null,
                  has_super_chat: null }];
      }
      return baseHandler(sql);
    });
    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    const body = await res.json() as any;
    const c = body.decision.analytics.countries[0];
    expect(c.growth_mom).toBe(0);
    expect(c.retention_rel).toBe(1);
    expect(body.decision.analytics.has_super_chat).toBeNull();
  });
});
