// frontend/src/components/GrowthTrajectoryPanel.tsx
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api } from "../api";

interface Pillar {
  key: string;
  level: number | null;       // reach=subs, engagement/sentiment=ratio, community=posts
  wow_growth: number | null;  // 1-week change (retained from contract; not surfaced)
  change_4w: number | null;   // 4-week change — level pillars: relative %; ratio: absolute
  prev: number | null;        // value over the previous 7 days (the "before")
  recent: number | null;      // value over the recent 7 days (the "after")
  slope_4w: number | null;    // retained from worker contract (tooltip/future use)
  accel: number;              // retained from worker contract (tooltip/future use)
  direction: string;          // climbing | plateau | declining | unknown
  accel_dir: string;          // accelerating | flat | decelerating (not surfaced)
  source?: string;            // reach only: "subscribers" | "views" (views = quantized-subs fallback)
}
interface Trajectory {
  status: string;             // ok | insufficient_history | no_data
  computed_at?: string;
  history_days?: number;
  posture_label?: string | null;
  weakest_pillar?: string | null;
  pillars?: Pillar[];
}

// Plain, non-jargon names — the panel leads with meaning, not metric names.
const PILLAR_LABEL: Record<string, string> = {
  reach: "새 팬 유입",
  engagement: "팬 반응",
  community: "커뮤니티 활기",
  sentiment: "평판",
};

type Tone = "good" | "neutral" | "watch" | "muted";
const TONE_COLOR: Record<Tone, string> = {
  good: "#22c55e", neutral: "#a1a1aa", watch: "#f59e0b", muted: "#71717a",
};

// Per-pillar plain status word + tone, keyed by the worker's direction. Direction
// is growth-rate framed (climbing = growth speeding up), and sentiment is already
// health-inverted upstream (climbing = 부정여론 감소). No arrows — the word + dot
// carries the read, avoiding the number-vs-arrow contradiction of the old design.
const STATUS: Record<string, Record<string, [string, Tone]>> = {
  reach: {
    climbing: ["빠른 증가", "good"], plateau: ["유지", "neutral"],
    declining: ["증가 둔화", "watch"], unknown: ["—", "muted"],
  },
  community: {
    climbing: ["활발해지는 중", "good"], plateau: ["유지", "neutral"],
    declining: ["잠잠해지는 중", "watch"], unknown: ["—", "muted"],
  },
  engagement: {
    climbing: ["좋아지는 중", "good"], plateau: ["안정적", "neutral"],
    declining: ["약해지는 중", "watch"], unknown: ["—", "muted"],
  },
  sentiment: {
    climbing: ["개선 중", "good"], plateau: ["양호", "good"],
    declining: ["주의", "watch"], unknown: ["—", "muted"],
  },
};

function statusFor(p: Pillar): [string, Tone] {
  return STATUS[p.key]?.[p.direction] ?? ["—", "muted"];
}

// Compact signed Korean number (+1,100 / +516만 / +1.2억) for weekly count deltas.
function compactKo(n: number): string {
  const sign = n < 0 ? "−" : "+";
  const a = Math.abs(n);
  if (a >= 1e8) return `${sign}${(a / 1e8).toFixed(1)}억`;
  if (a >= 1e4) return `${sign}${Math.round(a / 1e4)}만`;
  return `${sign}${Math.round(a).toLocaleString()}`;
}

// Supporting detail (muted): the previous-7-days vs recent-7-days figures behind
// the status word, so a viewer can see *why* a pillar is rising or falling
// ("이전 X → 최근 Y"). prev/recent are the pillar's own signal one week apart:
// reach = weekly adds (subs or views), community = weekly post count, engagement
// = 7-day ER, sentiment = negative_ratio.
function fmtPrevRecent(p: Pillar): string {
  if (p.prev === null || p.prev === undefined || p.recent === null || p.recent === undefined) {
    return "";
  }
  if (p.key === "reach") {
    const tail = p.source === "views" ? " 조회/주" : " 명/주";
    return `이전 ${compactKo(p.prev)} → 최근 ${compactKo(p.recent)}${tail}`;
  }
  if (p.key === "community") {
    return `이전 ${Math.round(p.prev)} → 최근 ${Math.round(p.recent)}건/주`;
  }
  // engagement / sentiment — ratios rendered as %
  return `이전 ${(p.prev * 100).toFixed(1)}% → 최근 ${(p.recent * 100).toFixed(1)}%`;
}

// Posture label (from worker) → plain one-line gloss + a tone for the badge.
const POSTURE: Record<string, [string, Tone]> = {
  "성장 가속": ["구독자가 빠르게 느는 중", "good"],
  "성장 확대": ["꾸준히 성장하는 중", "good"],
  "성장 확대(둔화 조짐)": ["성장 중이나 속도는 둔화", "neutral"],
  "성장 유지": ["성장 속도를 유지하는 중", "neutral"],
  "성장 둔화": ["성장 속도가 느려지는 중", "watch"],
  "성장 둔화 심화": ["성장 둔화가 뚜렷한 편", "watch"],
};

const WEAKEST_REASON: Record<string, string> = {
  reach: "구독자 증가가 느려지는 중",
  engagement: "팬 반응이 약해지는 중",
  community: "커뮤니티가 잠잠해지는 중",
  sentiment: "부정 여론이 늘고 있음",
};

function MessageBox({ children }: { children: ComponentChildren }) {
  return (
    <div class="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-400">
      {children}
    </div>
  );
}

export function GrowthTrajectoryPanel({ groupKey }: { groupKey: string }) {
  const [data, setData] = useState<Trajectory | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.growthTrajectory<Trajectory>(groupKey)
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setData({ status: "no_data" }); });
    return () => { cancelled = true; };
  }, [groupKey]);

  if (!data) return <div class="text-zinc-500 text-sm">Loading…</div>;

  if (data.status === "insufficient_history") {
    return <MessageBox>아직 데이터가 충분하지 않아요 ({data.history_days ?? 0}일 모음 · 최소 14일부터 표시).</MessageBox>;
  }
  if (data.status !== "ok") {
    return <MessageBox>아직 성장 추이 데이터가 없어요. (다음 집계 이후 표시됩니다)</MessageBox>;
  }

  const pillars = data.pillars ?? [];
  const label = data.posture_label ?? "";
  const [gloss, postureTone] = POSTURE[label] ?? ["", "neutral"];
  const weakest = data.weakest_pillar ?? null;

  return (
    <div class="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      {/* Headline: plain one-liner is the lead; the label sits beside it as a chip. */}
      <div class="mb-4 flex items-start justify-between gap-4">
        <div>
          <h3 class="section-title">성장 추이</h3>
          {gloss && <p class="mt-0.5 text-sm text-zinc-300">{gloss}</p>}
        </div>
        {label && (
          <span class="shrink-0 rounded-full px-2.5 py-1 text-sm font-medium"
                style={{ background: TONE_COLOR[postureTone] + "22", color: TONE_COLOR[postureTone] }}>
            {label}
          </span>
        )}
      </div>

      <div class="space-y-2.5">
        {pillars.map((p) => {
          const [word, tone] = statusFor(p);
          const metric = fmtPrevRecent(p);
          return (
            <div key={p.key} class="flex items-center gap-3 text-sm">
              <span class="w-32 shrink-0 text-zinc-400">{PILLAR_LABEL[p.key] ?? p.key}</span>
              <span class="inline-flex items-center gap-1.5" style={{ color: TONE_COLOR[tone] }}>
                <span class="inline-block h-1.5 w-1.5 rounded-full"
                      style={{ background: TONE_COLOR[tone] }} />
                {word}
              </span>
              {metric && <span class="ml-auto shrink-0 tabular-nums text-zinc-600">{metric}</span>}
            </div>
          );
        })}
      </div>

      {/* Weakest: human phrasing; explicit "all good" when nothing is concerning. */}
      <div class="mt-4 text-sm">
        {weakest ? (
          <span class="text-amber-300">
            가장 신경 쓸 부분 — <span class="font-medium">{PILLAR_LABEL[weakest] ?? weakest}</span>
            {WEAKEST_REASON[weakest] ? `: ${WEAKEST_REASON[weakest]}` : ""}
          </span>
        ) : (
          <span class="text-emerald-400">지금은 특별히 신경 쓸 약점은 없어요.</span>
        )}
      </div>

      <p class="mt-3 text-[11px] leading-relaxed text-zinc-600">
        상태어 = 최근 추세(직전 1주 대비) · 옆 숫자 = 이전·최근 7일 비교 — 서로 다른 시점이라 방향이 달라 보일 수 있어요.
      </p>
      <p class="mt-1 text-[11px] leading-relaxed text-zinc-600">
        자기 과거 대비 추정치 · 참고용이며 정답이 아니에요 (사람 확인이 필요해요).
      </p>
    </div>
  );
}
