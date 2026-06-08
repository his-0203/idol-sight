// frontend/src/components/GrowthTrajectoryPanel.tsx
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api } from "../api";

interface Pillar {
  key: string;
  level: number | null;       // reach=subs, engagement/sentiment=ratio, community=posts
  wow_growth: number | null;  // 1-week change (retained from contract; not surfaced)
  change_4w: number | null;   // 4-week change — level pillars: relative %; ratio: absolute
  slope_4w: number | null;    // retained from worker contract (tooltip/future use)
  accel: number;              // retained from worker contract (tooltip/future use)
  direction: string;          // climbing | plateau | declining | unknown
  accel_dir: string;          // accelerating | flat | decelerating (not surfaced)
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
    climbing: ["빠른 증가", "good"], plateau: ["꾸준", "good"],
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

// Supporting number (muted), kept on the SAME 4-week horizon as the status word
// so the two never read as contradictory (the old 1-week figure could show "+0%"
// next to "빠른 증가"). Level pillars show the 4-week growth %; ratio pillars show
// the current level for context (their status word already carries the trend).
function fmtMetric(p: Pillar): string {
  if (p.key === "reach" || p.key === "community") {
    // == null catches undefined too: rows written before change_4w existed (a
    // pre-redesign cron run) omit the field — fall back to blank, not NaN.
    if (p.change_4w === null || p.change_4w === undefined) return "";
    const v = p.change_4w * 100;
    const dec = Math.abs(v) < 1 ? 1 : 0;   // don't round a small-but-real % to 0
    return `최근 4주 ${v >= 0 ? "+" : ""}${v.toFixed(dec)}%`;
  }
  if (p.level === null) return "";
  if (p.key === "engagement") return `참여율 ${(p.level * 100).toFixed(1)}%`;
  return `부정 ${(p.level * 100).toFixed(0)}%`;  // sentiment
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
          const metric = fmtMetric(p);
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
        자기 과거 대비 추정치 · 참고용이며 정답이 아니에요 (사람 확인이 필요해요).
      </p>
    </div>
  );
}
