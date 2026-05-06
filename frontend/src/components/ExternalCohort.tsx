// ExternalCohort — side-by-side card grid of curated live K-pop
// newcomer benchmarks (RIIZE / BOYNEXTDOOR / ZEROBASEONE / NCT WISH /
// EVNNE seeded by migration 0015). The internal `market.groups` view
// answers "vs the 7 virtual peers"; this view answers "vs the broader
// boy-group newcomer market in the same 2023-2024 debut window".
//
// Data source: a manually-curated benchmark table. Numbers are
// approximate snapshot pulls until the Spotify/YouTube collector
// lands. Each card surfaces (debut date, agency, YT subs, Spotify
// monthly listeners) — the four signals an executive review actually
// asks for. We deliberately *don't* try to fold these into Health
// Score; the data shape is too different and conflating would dilute
// the V2.5 cohort percentile baseline.

import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { fmt } from "../format";

interface CohortGroup {
  key: string;
  name: string;
  name_kr: string | null;
  agency: string | null;
  debut_date: string | null;
  group_type: string;
  notes: string | null;
  metrics: {
    snapshot_at: string;
    yt_subscribers: number | null;
    yt_total_views: number | null;
    spotify_monthly_listeners: number | null;
    spotify_followers: number | null;
    source: string | null;
  } | null;
}

function dDay(debut: string | null): string {
  if (!debut) return "";
  const days = Math.round((Date.now() - Date.parse(debut)) / 86_400_000);
  if (days < 0) return `D${days}`;
  if (days === 0) return "D-DAY";
  if (days < 365) return `D+${days}`;
  return `+${(days / 365).toFixed(1)}년`;
}

export function ExternalCohort() {
  const [data, setData] = useState<{ cohort: CohortGroup[] } | null>(null);
  useEffect(() => { api.externalCohort().then(setData).catch(() => setData({ cohort: [] })); }, []);

  if (!data) {
    return (
      <section class="card">
        <h3 class="section-title mb-2">외부 K-POP 신인 코호트</h3>
        <div class="text-hint text-zinc-500">Loading…</div>
      </section>
    );
  }
  if (data.cohort.length === 0) {
    return (
      <section class="card">
        <h3 class="section-title mb-2">외부 K-POP 신인 코호트</h3>
        <div class="text-hint text-zinc-500">시드 데이터 없음 (migration 0015 적용 필요).</div>
      </section>
    );
  }

  // Sort by Spotify monthly listeners desc as the universal recency-
  // adjusted "how big are you right now" metric. Falls back to YT
  // subs when Spotify is missing so a single-source row still ranks.
  const sorted = [...data.cohort].sort((a, b) => {
    const av = a.metrics?.spotify_monthly_listeners
            ?? a.metrics?.yt_subscribers ?? 0;
    const bv = b.metrics?.spotify_monthly_listeners
            ?? b.metrics?.yt_subscribers ?? 0;
    return bv - av;
  });

  return (
    <section class="card">
      <div class="mb-3 flex flex-wrap items-baseline gap-2">
        <h3 class="section-title">외부 K-POP 신인 코호트 (수동 시드)</h3>
        <span class="text-hint text-zinc-500">
          MiiWAN(D-{Math.abs(Math.round((Date.parse("2026-06-16") - Date.now()) / 86_400_000))}) 기준 동시기 데뷔 보이그룹 비교 — Spotify 월간 리스너 내림차순.
        </span>
        <span class="ml-auto text-hint text-zinc-500">{sorted.length}그룹 · 자동 수집 미구현</span>
      </div>
      <div class="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
        {sorted.map((g) => (
          <div key={g.key}
               class="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
            <div class="flex items-baseline gap-2">
              <span class="font-semibold">{g.name}</span>
              {g.name_kr && <span class="text-hint text-zinc-500">{g.name_kr}</span>}
              <span class="ml-auto rounded bg-zinc-800/80 px-1.5 text-[11px] text-zinc-300 tabular-nums">
                {dDay(g.debut_date)}
              </span>
            </div>
            <div class="text-hint text-zinc-500">
              {g.agency ?? "—"} · 데뷔 {g.debut_date ?? "—"}
            </div>
            {g.metrics ? (
              <div class="mt-2 grid grid-cols-2 gap-2 text-xs">
                <div>
                  <div class="text-zinc-500">YT 구독</div>
                  <div class="text-base font-semibold tabular-nums">
                    {fmt(g.metrics.yt_subscribers)}
                  </div>
                </div>
                <div>
                  <div class="text-zinc-500">Spotify 월간</div>
                  <div class="text-base font-semibold tabular-nums">
                    {fmt(g.metrics.spotify_monthly_listeners)}
                  </div>
                </div>
                <div>
                  <div class="text-zinc-500">YT 조회수</div>
                  <div class="text-sm tabular-nums">{fmt(g.metrics.yt_total_views)}</div>
                </div>
                <div>
                  <div class="text-zinc-500">Spotify 팔로워</div>
                  <div class="text-sm tabular-nums">{fmt(g.metrics.spotify_followers)}</div>
                </div>
              </div>
            ) : (
              <div class="mt-2 text-xs text-zinc-500">측정값 없음</div>
            )}
            {g.metrics?.source === "manual" && (
              <div class="mt-2 text-[11px] text-amber-500/80">
                ⚠ 수동 시드값 — Spotify/YouTube API 연동 후 자동 갱신 예정
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
