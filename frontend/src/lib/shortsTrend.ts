// 경쟁사 숏폼 트렌드 랭킹·신선도 — 클라이언트 순수 헬퍼.
// 설계: docs/superpowers/specs/2026-06-02-shorts-trend-and-miiwan-diagnostic-design.md
export const FRESH_DAYS = 14;        // 신선도 윈도우
export const FRESH_VELOCITY = 2.0;   // 🔥 배지 최소 velocity
export const MIN_VIEWS_FLOOR = 5000; // velocity 랭킹 노이즈 floor

export interface TrendShort {
  video_id: string;
  group_key: string;
  group_name_kr: string;
  title: string | null;
  content_type: string | null;
  published_at: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  view_count_24h: number | null;
  viral_velocity_ratio: number | null;
}

export type TrendSort = "fresh" | "velocity" | "views" | "recent";

export function daysSince(publishedAt: string | null, now: number): number | null {
  if (!publishedAt) return null;
  let s = publishedAt.trim();
  if (s.includes(" ") && !s.includes("T")) s = s.replace(" ", "T");
  if (!/[Z+]|[+-]\d\d:?\d\d$/.test(s)) s += "Z";
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return Math.floor((now - t) / 86_400_000);
}

export function isFresh(s: TrendShort, now: number): boolean {
  const d = daysSince(s.published_at, now);
  return d != null && d <= FRESH_DAYS
    && s.viral_velocity_ratio != null && s.viral_velocity_ratio >= FRESH_VELOCITY;
}

export function velocityEligible(s: TrendShort): boolean {
  return (s.views ?? 0) >= MIN_VIEWS_FLOOR && s.viral_velocity_ratio != null;
}

export function sortShorts(rows: TrendShort[], sort: TrendSort, now: number): TrendShort[] {
  const out = [...rows];
  if (sort === "recent") {
    return out.sort((a, b) => (daysSince(a.published_at, now) ?? 1e9) - (daysSince(b.published_at, now) ?? 1e9));
  }
  if (sort === "views") {
    return out.sort((a, b) => (b.views ?? -1) - (a.views ?? -1));
  }
  if (sort === "velocity") {
    // floor 미만/측정불가는 맨 뒤. 그 안에서 velocity 내림차순.
    return out.sort((a, b) => {
      const ea = velocityEligible(a), eb = velocityEligible(b);
      if (ea !== eb) return ea ? -1 : 1;
      return (b.viral_velocity_ratio ?? -1) - (a.viral_velocity_ratio ?? -1);
    });
  }
  // "fresh": 신선 영상 먼저, 그 안에서 velocity 내림차순.
  return out.sort((a, b) => {
    const fa = isFresh(a, now), fb = isFresh(b, now);
    if (fa !== fb) return fa ? -1 : 1;
    return (b.viral_velocity_ratio ?? -1) - (a.viral_velocity_ratio ?? -1);
  });
}
