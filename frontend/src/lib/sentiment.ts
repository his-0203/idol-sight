// Sentiment badge styles shared across views that render post/article sentiment.
// The four buckets mirror community_posts.sentiment (migration 0006_community_sentiment.sql):
//   positive — fan support, hype
//   negative — criticism, complaint
//   controversy — scandal, 논란
//   neutral — news, info, schedule
// NULL = un-classified; older rows and rows the LLM couldn't bucket stay NULL.
//
// NOTE: as of 2026-06, only community_posts carries sentiment.
// naver_articles does NOT have a sentiment column — callers that pass
// n.sentiment from a naver_articles row will always receive null (safe no-op).

export type Sentiment = "positive" | "negative" | "controversy" | "neutral" | null | undefined;

export const SENTIMENT_BADGE: Record<
  Exclude<Sentiment, null | undefined>,
  { label: string; cls: string }
> = {
  positive:    { label: "긍정", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" },
  negative:    { label: "부정", cls: "border-orange-500/40 bg-orange-500/10 text-orange-300" },
  controversy: { label: "논란", cls: "border-red-500/40 bg-red-500/10 text-red-300" },
  neutral:     { label: "중립", cls: "border-zinc-700 bg-zinc-800/40 text-zinc-400" },
};

/** Returns the badge config for a non-null sentiment value, or null for un-classified. */
export function sentimentBadge(
  sentiment: Sentiment,
): { label: string; cls: string } | null {
  if (!sentiment) return null;
  return SENTIMENT_BADGE[sentiment] ?? null;
}
