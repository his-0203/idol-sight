// frontend/tests/functions/api_miiwan_fan_activity.test.ts
//
// /api/miiwan 의 fan_activity 매핑 검증. 워커가 agg_live_activity_summary /
// agg_live_activity 에 적재한 행이 프론트(FanActivityCard)가 먹는 shape 로
// 정확히 실리는지 — D1→API 계약 고정. api_miiwan_decision.test.ts 미러.

import { describe, expect, it, vi } from "vitest";
import { onRequestGet } from "../../functions/api/miiwan";

const MIIWAN = {
  key: "miiwan", name: "MiiWAN", name_kr: "미완소년",
  debut_date: "2026-06-01", yt_channel_id: "UCxxxx",
};

const envWith = (handler: (sql: string) => any[]) => ({
  DB: { prepare: vi.fn((sql: string) => ({
    bind: vi.fn().mockReturnThis(),
    all: vi.fn(async () => ({ results: handler(sql) })),
    first: vi.fn(async () => handler(sql)[0] ?? null),
  })) },
} as any);

function baseHandler(sql: string): any[] {
  if (sql.includes("FROM groups") && sql.includes("key IN")) return [];
  if (sql.includes("FROM groups")) return [MIIWAN];
  return [];
}

const SUMMARY = {
  generated_at: "2026-06-26T19:00:00Z", window_days: 56, broadcast_count: 3,
  median_unique_chatters: 99, median_msgs_per_chatter: 63.5,
  median_returning_rate: 0.42, median_peak_msgs_per_min: 180,
  core_fan_count: 38, core_fan_share: 0.31,
  est_engaged_fans: 220, est_active_core: 23,
  view_through: 2.6, like_rate: 0.08, comment_rate: 0.012, basis: "scored",
};
const BROADCASTS = [
  { video_id: "v_old", ended_at: "2026-06-16T13:00:00Z", unique_chatters: 140,
    total_messages: 8541, msgs_per_chatter: 61.0, peak_msgs_per_min: 210,
    returning_rate: null, basis: "low_confidence" },
  { video_id: "v_new", ended_at: "2026-06-17T13:00:00Z", unique_chatters: 99,
    total_messages: 5987, msgs_per_chatter: 60.5, peak_msgs_per_min: 180,
    returning_rate: 0.42, basis: "scored" },
];

describe("/api/miiwan fan_activity", () => {
  it("summary + broadcasts → fan_activity 로 정확 매핑(찐팬 활동량)", async () => {
    const env = envWith((sql) => {
      // 주의: summary 쿼리 SQL 이 'agg_live_activity' 를 포함하므로 _summary 먼저 분기.
      if (sql.includes("agg_live_activity_summary")) return [SUMMARY];
      if (sql.includes("agg_live_activity")) return BROADCASTS;
      return baseHandler(sql);
    });
    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    const body = await res.json() as any;

    const fa = body.fan_activity;
    expect(fa).not.toBeNull();
    expect(fa.basis).toBe("scored");
    expect(fa.median_unique_chatters).toBe(99);
    expect(fa.core_fan_share).toBe(0.31);
    expect(fa.est_engaged_fans).toBe(220);   // 추정 관여 팬(좋아요)
    expect(fa.est_active_core).toBe(23);     // 추정 적극 코어(댓글)
    // 방송별 추이 — 별도 쿼리 결과를 시간순 그대로 실어 보낸다.
    expect(fa.broadcasts).toHaveLength(2);
    expect(fa.broadcasts[0].video_id).toBe("v_old");
    expect(fa.broadcasts[0].returning_rate).toBeNull(); // 첫 방송
    expect(fa.broadcasts[1].returning_rate).toBe(0.42);
  });

  it("summary 행 없으면 fan_activity=null (프론트 '라이브 데이터 축적 중')", async () => {
    const env = envWith(baseHandler); // 모든 live_activity 쿼리 [] 반환
    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    const body = await res.json() as any;
    expect(body.fan_activity).toBeNull();
  });
});
