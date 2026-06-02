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

export function ShortsTrend() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.shortsTrend().then(setData).catch((e) => setErr(String(e)));
  }, []);

  if (err) return <div class="p-4 text-red-400">불러오기 실패: {err}</div>;
  if (!data) return <div class="p-4 text-zinc-500">불러오는 중…</div>;

  return (
    <div>
      <MiiwanShortsDiagnostic data={data.diagnostic} />
      <WeeklyChallenges items={data.challenges ?? []} />
      <ShortsTrendTable
        rows={data.trend}
        groups={data.groups}
        windowDays={data.window_days}
        limit={data.limit}
      />
      {data.generated_at && (
        <p class="mt-4 text-hint text-zinc-600">
          데이터 기준 {formatKST(data.generated_at)} · 매일 21:30 KST 갱신
        </p>
      )}
    </div>
  );
}
