import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { MiiwanShortsDiagnostic, type DiagnosticData } from "../components/MiiwanShortsDiagnostic";
import { ShortsTrendTable } from "../components/ShortsTrendTable";
import { WeeklyChallenges, type ChallengeItem } from "../components/WeeklyChallenges";
import { formatKST } from "../lib/datetime";
import type { TrendShort } from "../lib/shortsTrend";

interface Payload {
  generated_at: string | null;
  window_days: number;
  limit: number;
  trend: TrendShort[];
  groups: Array<{ key: string; name_kr: string }>;
  diagnostic: DiagnosticData;
  challenges: ChallengeItem[];
}

type SectionTab = "challenges" | "trend";

export function ShortsTrend() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // 진단 패널은 상단 고정, 긴 두 리스트만 탭으로 전환 (기본: 이번 주 챌린지).
  const [tab, setTab] = useState<SectionTab>("challenges");

  useEffect(() => {
    api.shortsTrend().then(setData).catch((e) => setErr(String(e)));
  }, []);

  if (err) return <div class="p-4 text-red-400">불러오기 실패: {err}</div>;
  if (!data) return <div class="p-4 text-zinc-500">불러오는 중…</div>;

  const challenges = data.challenges ?? [];
  const TABS: Array<[SectionTab, string]> = [
    ["challenges", `이번 주 챌린지${challenges.length ? ` (${challenges.length})` : ""}`],
    ["trend", "경쟁사 숏폼 트렌드"],
  ];

  return (
    <div>
      <MiiwanShortsDiagnostic data={data.diagnostic} />

      <nav class="mb-4 flex gap-1 border-b border-zinc-800 text-data" aria-label="숏폼 섹션">
        {TABS.map(([k, label]) => (
          <button
            key={k}
            class={
              "-mb-px rounded-t-ctrl border-b-2 px-3 py-1.5 transition-colors " +
              (tab === k
                ? "border-brand-fg text-brand-fg"
                : "border-transparent text-zinc-400 hover:text-zinc-200")
            }
            onClick={() => setTab(k)}
          >{label}</button>
        ))}
      </nav>

      {tab === "challenges"
        ? <WeeklyChallenges items={challenges} />
        : <ShortsTrendTable
            rows={data.trend}
            groups={data.groups}
            windowDays={data.window_days}
            limit={data.limit}
          />}

      {data.generated_at && (
        <p class="mt-4 text-hint text-zinc-600">
          데이터 기준 {formatKST(data.generated_at)} · 매일 21:30 KST 갱신
        </p>
      )}
    </div>
  );
}
