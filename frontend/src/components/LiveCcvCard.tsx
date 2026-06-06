import { useEffect, useState } from "preact/hooks";
import { api } from "../api";

interface CcvGroup {
  group_key: string; video_id: string; title: string | null;
  peak: number; avg: number; sample_count: number; last_at: string;
  samples: { t: string; ccv: number }[];
}

const LABEL: Record<string, string> = {
  miiwan: "MiiWAN", plave: "PLAVE", owis: "OWIS", wegosix: "WE GO-6",
};

function Spark({ pts }: { pts: { ccv: number }[] }) {
  if (pts.length < 2) return null;
  const vals = pts.map((p) => p.ccv);
  const max = Math.max(...vals, 1);
  const w = 96, h = 24;
  const d = vals.map((v, i) =>
    `${(i / (vals.length - 1)) * w},${h - (v / max) * h}`).join(" ");
  return (
    <svg width={w} height={h} class="text-brand-fg">
      <polyline points={d} fill="none" stroke="currentColor" stroke-width="1.5" />
    </svg>
  );
}

export function LiveCcvCard() {
  const [groups, setGroups] = useState<CcvGroup[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.liveCcv().then((d) => setGroups(d.groups)).catch((e) => setErr(String(e)));
  }, []);

  if (err) return null;                       // card is supplementary; fail quiet
  if (!groups) return null;

  const mine = groups.find((g) => g.group_key === "miiwan");
  const others = groups.filter((g) => g.group_key !== "miiwan");

  return (
    <section class="rounded-lg border border-zinc-800 p-4">
      <h3 class="mb-2 text-sm font-semibold">라이브 반응 (동시 시청자)</h3>
      {!mine && others.length === 0 ? (
        <div class="text-hint text-zinc-500">최근 라이브 데이터 없음</div>
      ) : (
        <div class="space-y-3">
          {mine && (
            <div class="flex items-center gap-3">
              <div class="min-w-[64px] text-data font-semibold text-brand-fg">MiiWAN</div>
              <div class="text-data">
                peak <strong>{mine.peak.toLocaleString()}</strong>
                <span class="text-zinc-500"> · avg {mine.avg.toLocaleString()}</span>
              </div>
              <div class="ml-auto"><Spark pts={mine.samples} /></div>
            </div>
          )}
          {others.length > 0 && (
            <div class="border-t border-zinc-800/60 pt-2">
              <div class="mb-1 text-hint text-zinc-500">벤치마크 (최근 방송 peak)</div>
              {others.map((g) => (
                <div key={g.group_key} class="flex items-center gap-3 text-data">
                  <span class="min-w-[64px] text-zinc-400">{LABEL[g.group_key] ?? g.group_key}</span>
                  <span>{g.peak.toLocaleString()}</span>
                  <span class="ml-auto text-zinc-600 text-hint">
                    {new Date(g.last_at).toLocaleDateString("ko-KR")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
