// MiiWAN-only briefing tab. IPX/Abyss 자사 그룹 전용 화면이라
// market-wide insights 와 분리해서 운영자가 한 번에 모든 정보를 볼 수
// 있도록 모은다.
//
// 5개 섹션 (위→아래):
//   1) D-day Hero: 데뷔 카운트다운 + Health 등급 + 멤버 솔로 채널 보유 여부
//   2) 핵심 지표 KPI 6개: subs / views / 영상수 / 뉴스 / 디시 / 트위터
//   3) 멤버 카드: 활성 멤버 + 솔로 채널 시드 상태
//   4) 데뷔 D-30 벤치마크: 같은 시점의 PLAVE/ISEDOL/STELLIVE 데이터와 직접 비교
//   5) MiiWAN 전용 인사이트 + IPX 액션 권고

import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { fmt } from "../format";
import { KPI } from "../components/KPI";
import { EmptyState } from "../components/EmptyState";
import { SourceRef } from "../components/SourceRef";
import { colorOf } from "../design/groups";

type SummaryShape = {
  yt_total_videos: number; yt_total_views: number; yt_subscribers: number;
  dc_total_posts: number; theqoo_posts: number; instiz_posts: number;
  naver_total_news: number; twitter_posts: number; controversy_count: number;
};

type Benchmark = {
  group_key: string; name: string; debut_date: string | null;
  snapshot_at: string | null; summary: SummaryShape | null;
};

type Insight = {
  id: number; title: string; body: string;
  scope: string; type: string;
  source_refs: Array<{ table: string; pk: string; label: string }>;
  generated_at: string;
};

type MiiwanData = {
  group: { key: string; name: string; name_kr: string; debut_date: string | null };
  today: string;
  days_to_debut: number | null;
  summary: ({ snapshot_at: string } & SummaryShape) | null;
  prev_summary: (Partial<SummaryShape> & { snapshot_at?: string }) | null;
  summary_history?: Array<Partial<SummaryShape> & { snapshot_at: string }>;
  health_score: { total: number | null; grade: string; label: string | null;
                  breakdown: Record<string, number> } | null;
  members: Array<{ id: number; name: string; name_en: string | null;
                   has_solo_channel: boolean }>;
  insights: Insight[];
  benchmarks: Benchmark[];
};

function relativeRatio(mine: number, theirs: number): string {
  if (!theirs || theirs <= 0) return "—";
  const r = mine / theirs;
  if (r >= 1) return `+${Math.round((r - 1) * 100)}%`;
  return `−${Math.round((1 - r) * 100)}%`;
}

export function MiiWANBriefing() {
  const [data, setData] = useState<MiiwanData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.miiwan().then(setData).catch((e) => setErr(String(e)));
  }, []);

  if (err) return <div class="text-sm text-red-400">불러오기 실패: {err}</div>;
  if (!data) return <div class="text-zinc-500">Loading…</div>;

  const dToDebut = data.days_to_debut;
  const debuted = dToDebut != null && dToDebut <= 0;
  const accent = colorOf("miiwan");

  const ipxActions = data.insights.filter((i) => i.type === "ipx_action");
  const miiwanScoped = data.insights.filter(
    (i) => i.scope === "miiwan" && i.type !== "ipx_action",
  );
  const otherInsights = data.insights.filter(
    (i) => i.scope !== "miiwan" && i.type !== "ipx_action",
  );

  return (
    <div class="space-y-6">
      {/* 1) Hero */}
      <section
        class="rounded-card border-l-4 border border-zinc-800 bg-zinc-900/40 p-5"
        style={{ borderLeftColor: accent }}
      >
        <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h1 class="text-2xl font-bold">
            {data.group.name} · <span class="text-zinc-400">{data.group.name_kr}</span>
          </h1>
          <span class="text-hint text-zinc-500">
            데뷔 {data.group.debut_date ?? "—"} (IPX × Abyss Company)
          </span>
        </div>
        <div class="mt-3 grid gap-3 md:grid-cols-3">
          <DDayCard d={dToDebut} debuted={debuted} accent={accent} />
          <HealthCard h={data.health_score} />
          <ChannelCoverageCard
            total={data.members.length}
            withSolo={data.members.filter((m) => m.has_solo_channel).length}
          />
        </div>
      </section>

      {/* 2) Core KPIs */}
      <section>
        <h2 class="section-title mb-3">핵심 지표 (최신 스냅샷
          {data.summary ? ` · ${data.summary.snapshot_at.slice(0, 10)}` : ""})
        </h2>
        {!data.summary ? (
          <EmptyState
            title="아직 집계된 활동 데이터 없음"
            hint="콜렉터 사이클이 한 번 이상 돌면 여기에 채워집니다."
            icon="📊"
          />
        ) : (() => {
          const wow = (cur: number | null | undefined, prev: number | null | undefined) =>
            cur == null || prev == null ? null : cur - prev;
          const series = (field: string) => {
            const h: any[] = data.summary_history ?? [];
            return h.length >= 2 ? h.map((r) => Number(r[field] ?? 0)) : undefined;
          };
          const p = data.prev_summary;
          return (
            <div class="grid grid-cols-2 gap-2 md:grid-cols-3">
              <KPI label="구독자 (그룹+멤버)"
                   value={data.summary.yt_subscribers}
                   delta={wow(data.summary.yt_subscribers, p?.yt_subscribers)}
                   sparkline={series("yt_subscribers")} />
              <KPI label="누적 조회수"
                   value={data.summary.yt_total_views}
                   delta={wow(data.summary.yt_total_views, p?.yt_total_views)}
                   sparkline={series("yt_total_views")} />
              <KPI label="등록 영상 수"
                   value={data.summary.yt_total_videos}
                   delta={wow(data.summary.yt_total_videos, p?.yt_total_videos)}
                   sparkline={series("yt_total_videos")} />
              <KPI label="네이버 뉴스"
                   value={data.summary.naver_total_news}
                   delta={wow(data.summary.naver_total_news, p?.naver_total_news)}
                   sparkline={series("naver_total_news")} />
              <KPI label="디시 게시글"
                   value={data.summary.dc_total_posts}
                   delta={wow(data.summary.dc_total_posts, p?.dc_total_posts)}
                   sparkline={series("dc_total_posts")} />
              <KPI label="트위터 멘션"
                   value={data.summary.twitter_posts}
                   delta={wow(data.summary.twitter_posts, p?.twitter_posts)}
                   sparkline={series("twitter_posts")}
                   hint={data.summary.controversy_count
                     ? `controversy ${data.summary.controversy_count}` : undefined} />
            </div>
          );
        })()}
      </section>

      {/* 3) Members */}
      <section>
        <h2 class="section-title mb-3">활성 멤버 ({data.members.length}명)</h2>
        {data.members.length === 0 ? (
          <EmptyState title="멤버 시드 없음" icon="👥" />
        ) : (
          <ul class="grid grid-cols-2 gap-2 md:grid-cols-5">
            {data.members.map((m) => (
              <li key={m.id}
                  class="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                <div class="text-base font-semibold">{m.name}</div>
                {m.name_en && (
                  <div class="text-xs text-zinc-500">{m.name_en}</div>
                )}
                <div class="mt-2 text-xs">
                  {m.has_solo_channel ? (
                    <span class="text-emerald-400">● 솔로 채널 등록</span>
                  ) : (
                    <span class="text-zinc-500">○ 솔로 채널 미등록</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 4) D-30 benchmark */}
      <section>
        <h2 class="section-title mb-3">데뷔 D-30 벤치마크 비교</h2>
        <p class="mb-3 text-hint text-zinc-500">
          각 비교 그룹의 데뷔일 직전 스냅샷 vs 현재 MiiWAN. 동일 시점 동일 지표.
        </p>
        {data.benchmarks.length === 0 || !data.summary ? (
          <EmptyState
            title="벤치마크 비교 데이터 부족"
            hint="비교 그룹의 과거 스냅샷이 누적되면 자동으로 채워집니다."
            icon="📐"
          />
        ) : (
          <div class="overflow-x-auto rounded-lg border border-zinc-800">
            <table class="w-full min-w-[640px] text-sm tabular-nums">
              <thead class="bg-zinc-900/60 text-xs uppercase tracking-wider text-zinc-500">
                <tr>
                  <th class="px-3 py-2 text-left">지표</th>
                  <th class="px-3 py-2 text-right" style={{ color: accent }}>
                    MiiWAN<br /><span class="text-hint normal-case text-zinc-500">현재</span>
                  </th>
                  {data.benchmarks.map((b) => (
                    <th key={b.group_key} class="px-3 py-2 text-right"
                        style={{ color: colorOf(b.group_key) }}>
                      {b.name}<br />
                      <span class="text-hint normal-case text-zinc-500">
                        D-day 직전 {b.snapshot_at?.slice(0, 10) ?? "—"}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  ["yt_subscribers", "구독자 (그룹+멤버)"],
                  ["yt_total_views", "누적 조회수"],
                  ["yt_total_videos", "영상 수"],
                  ["naver_total_news", "뉴스"],
                  ["dc_total_posts", "디시 게시글"],
                  ["twitter_posts", "트위터 멘션"],
                ].map(([k, label]) => {
                  const mine = data.summary![k as keyof SummaryShape] as number;
                  return (
                    <tr key={k} class="border-t border-zinc-800/60">
                      <td class="px-3 py-2 text-zinc-400">{label}</td>
                      <td class="px-3 py-2 text-right font-semibold"
                          style={{ color: accent }}>
                        {fmt(mine)}
                      </td>
                      {data.benchmarks.map((b) => {
                        const v = b.summary?.[k as keyof SummaryShape];
                        const ratio = v != null ? relativeRatio(mine, v) : "—";
                        const positive = ratio.startsWith("+");
                        return (
                          <td key={b.group_key} class="px-3 py-2 text-right">
                            <div class="text-zinc-300">{v != null ? fmt(v) : "—"}</div>
                            <div class={"text-hint " +
                              (ratio === "—" ? "text-zinc-600"
                                : positive ? "text-emerald-400" : "text-red-400")}>
                              {ratio}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 5) Insights & IPX actions */}
      <section>
        <h2 class="section-title mb-3">MiiWAN 전용 인사이트 · IPX 액션</h2>
        {data.insights.length === 0 ? (
          <EmptyState
            title="아직 MiiWAN 전용 인사이트 없음"
            hint="주간 LLM 분석이 1회 이상 돌면 여기에 채워집니다. 현재는 시장 인사이트 탭을 참고하세요."
            icon="💡"
          />
        ) : (
          <div class="space-y-4">
            {ipxActions.length > 0 && (
              <InsightGroup title="IPX 액션 권고" tone="action"
                            items={ipxActions} />
            )}
            {miiwanScoped.length > 0 && (
              <InsightGroup title="MiiWAN 인사이트" tone="brand"
                            items={miiwanScoped} accent={accent} />
            )}
            {otherInsights.length > 0 && (
              <InsightGroup
                title="관련 시장 인사이트"
                tone="muted"
                items={otherInsights}
                hint="MiiWAN 전용은 아니지만 운영에 참고할 만한 항목."
              />
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function DDayCard({ d, debuted, accent }:
                  { d: number | null; debuted: boolean; accent: string }) {
  if (d == null) {
    return (
      <div class="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <div class="text-xs uppercase tracking-wider text-zinc-500">데뷔까지</div>
        <div class="mt-1 text-2xl font-bold text-zinc-400">미정</div>
      </div>
    );
  }
  const label = debuted ? "데뷔 완료" : "데뷔까지";
  const big = debuted ? `D+${Math.abs(d)}` : `D-${d}`;
  return (
    <div class="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4"
         style={{ borderColor: accent }}>
      <div class="text-xs uppercase tracking-wider text-zinc-500">{label}</div>
      <div class="mt-1 text-3xl font-bold tabular-nums"
           style={{ color: accent }}>{big}</div>
      <div class="mt-0.5 text-hint text-zinc-500">
        {debuted ? "데뷔 후 모니터링 중" : `${d}일 남음`}
      </div>
    </div>
  );
}

function HealthCard({ h }: { h: MiiwanData["health_score"] }) {
  if (!h || h.total == null) {
    return (
      <div class="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <div class="text-xs uppercase tracking-wider text-zinc-500">Health</div>
        <div class="mt-1 text-2xl font-bold text-zinc-400">PRE</div>
        <div class="mt-0.5 text-hint text-zinc-500">데뷔 전 — 점수 산정 보류</div>
      </div>
    );
  }
  return (
    <div class="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
      <div class="text-xs uppercase tracking-wider text-zinc-500">Health</div>
      <div class="mt-1 flex items-baseline gap-2">
        <div class="text-3xl font-bold tabular-nums">{h.total.toFixed(1)}</div>
        <div class="text-lg font-semibold text-zinc-400">{h.grade}</div>
      </div>
      <div class="mt-0.5 text-hint text-zinc-500">{h.label ?? ""}</div>
    </div>
  );
}

function ChannelCoverageCard(
  { total, withSolo }: { total: number; withSolo: number },
) {
  const pct = total > 0 ? Math.round((withSolo / total) * 100) : 0;
  return (
    <div class="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
      <div class="text-xs uppercase tracking-wider text-zinc-500">멤버 커버리지</div>
      <div class="mt-1 flex items-baseline gap-2">
        <div class="text-3xl font-bold tabular-nums">{withSolo}/{total}</div>
        <div class="text-sm text-zinc-500">{pct}%</div>
      </div>
      <div class="mt-0.5 text-hint text-zinc-500">
        솔로 채널 등록 비율
      </div>
    </div>
  );
}

function InsightGroup(props: {
  title: string; items: Insight[];
  tone: "brand" | "action" | "muted";
  accent?: string; hint?: string;
}) {
  const toneCls = {
    brand:  "border-zinc-800 bg-zinc-900/40",
    action: "border-amber-500/40 bg-amber-500/5",
    muted:  "border-zinc-800/60 bg-zinc-900/20",
  }[props.tone];
  return (
    <div>
      <div class="mb-2 flex items-center gap-2">
        <h3 class="text-sm font-semibold"
            style={props.accent ? { color: props.accent } : undefined}>
          {props.title}
        </h3>
        {props.hint && (
          <span class="text-hint text-zinc-500">{props.hint}</span>
        )}
      </div>
      <ul class="space-y-2">
        {props.items.map((i) => (
          <li key={i.id}
              class={`rounded-lg border p-3 ${toneCls}`}>
            <div class="text-hint text-zinc-500">
              {i.scope} · {i.type} · {i.generated_at?.slice(0, 10)}
            </div>
            <div class="mt-0.5 font-semibold">{i.title}</div>
            <div class="mt-1 text-sm text-zinc-400">{i.body}</div>
            <SourceRef refs={i.source_refs ?? []} />
          </li>
        ))}
      </ul>
    </div>
  );
}
