import { fmt } from "../format";

export interface ChallengeItem {
  rank: number;
  name: string;
  tag: string;
  description: string | null;
  origin: string | null;
  hashtags: string[];
  example_video_ids: string[];
  yt_recent_shorts: number | null;
  yt_total_views: number | null;
  miiwan_fit: string | null;
  source_urls: string[];
  confidence: string | null;
  started_around?: string | null;
  momentum?: string | null;
  valid_until?: string | null;
  week_start?: string;
  generated_at?: string;
}

const TAG_LABEL: Record<string, string> = { dance: "댄스", meme: "밈" };

// YouTube 검색어: '가수명 곡명 챌린지' 평문. 이름의 검색 연산자(-, 따옴표, 괄호 등)를
// 제거 — '-' 는 제외 연산자, 따옴표는 구문 연산자라 그대로 두면 검색이 망가진다.
function ytQuery(c: { name: string; tag: string }): string {
  const clean = c.name.replace(/["'“”‘’|()\-]+/g, " ").replace(/\s+/g, " ").trim();
  return c.tag === "meme" || clean.includes("챌린지") ? clean : `${clean} 챌린지`;
}
const CONF_COLOR: Record<string, string> = {
  high: "#22c55e", medium: "#eab308", low: "#6b7280",
};
const MOMENTUM: Record<string, { label: string; color: string }> = {
  rising:    { label: "확산 중 ↑", color: "#22c55e" },
  peaking:   { label: "정점", color: "#eab308" },
  declining: { label: "하락 ↓", color: "#f87171" },
};

export function WeeklyChallenges({ items }: { items: ChallengeItem[] }) {
  if (items.length === 0) {
    return (
      <section class="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <h2 class="text-lg font-bold">이번 주 바이럴 챌린지</h2>
        <p class="mt-2 text-zinc-400">이번 주 챌린지 데이터가 아직 없습니다.</p>
      </section>
    );
  }
  const week = items[0]?.week_start;
  return (
    <section class="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div class="mb-1 flex items-center justify-between">
        <h2 class="text-lg font-bold">이번 주 바이럴 챌린지</h2>
        <span class="text-hint text-zinc-500">{week ? `${week} 주` : ""}</span>
      </div>
      <p class="mb-3 text-hint text-zinc-600">발굴(AI 웹검색) + YouTube 측정 · MiiWAN 적합도 제안</p>
      <ol class="space-y-2">
        {items.map((c) => (
          <li key={c.rank} class="rounded-ctrl border border-zinc-800 p-3">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-bold tabular-nums text-zinc-300">#{c.rank}</span>
              <span class="font-semibold">{c.name}</span>
              <span class="rounded-full bg-zinc-800 px-2 py-0.5 text-hint text-zinc-300">
                {TAG_LABEL[c.tag] ?? c.tag}
              </span>
              {c.confidence && (
                <span class="inline-flex items-center gap-1 text-hint text-zinc-500">
                  <span class="inline-block h-1.5 w-1.5 rounded-full"
                    style={{ background: CONF_COLOR[c.confidence] ?? "#6b7280" }} />
                  {c.confidence}
                </span>
              )}
            </div>
            {c.description && <div class="mt-1 text-data text-zinc-300">{c.description}</div>}
            <div class="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-hint text-zinc-500">
              {c.origin && <span>원곡: {c.origin}</span>}
              {c.hashtags.length > 0 && <span>{c.hashtags.join(" ")}</span>}
              <span>
                측정: {c.yt_recent_shorts == null ? "미측정"
                  : `숏폼 ${c.yt_recent_shorts}+ · 조회 ${fmt(c.yt_total_views)}`}
              </span>
            </div>
            {/* 생애주기 (LLM 추정): 추세·시작·유효기한 */}
            {(c.momentum || c.started_around || c.valid_until) && (
              <div class="mt-1 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-hint">
                {c.momentum && MOMENTUM[c.momentum] && (
                  <span class="inline-flex items-center gap-1"
                    style={{ color: MOMENTUM[c.momentum]!.color }}>
                    <span class="inline-block h-1.5 w-1.5 rounded-full"
                      style={{ background: MOMENTUM[c.momentum]!.color }} />
                    {MOMENTUM[c.momentum]!.label}
                  </span>
                )}
                {c.started_around && <span class="text-zinc-500">시작 {c.started_around}</span>}
                {c.valid_until && <span class="text-zinc-400">업로드 유효 {c.valid_until}</span>}
              </div>
            )}
            {c.miiwan_fit && (
              <div class="mt-1 text-hint text-brand-fg">MiiWAN: {c.miiwan_fit}</div>
            )}
            <div class="mt-1 flex flex-wrap gap-3 text-hint">
              {/* 챌린지를 YouTube 에서 직접 검색 — 항상 작동하는 단일 진입점. */}
              <a class="text-zinc-300 hover:underline" target="_blank" rel="noreferrer"
                href={`https://www.youtube.com/results?search_query=${encodeURIComponent(ytQuery(c))}`}>
                YouTube에서 보기 ↗
              </a>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
