// MiiWAN strategic briefing — IPX/Abyss internal briefing tab,
// rebuilt 2026-05-05 from a strategy-analyst lens.
//
// The previous layout dumped six sections in row order without a
// hierarchy of decisions. The rebuilt version answers the six
// questions an operator/contractor actually opens this page to ask,
// in priority order:
//
//   1. NOW       — 지금 어디에 있나? (D-day · Health · 한 줄 진단)
//   2. ACTION    — 오늘 무엇을 해야 하나? (alerts + ipx_action 통합 큐)
//   3. RISK      — 어떤 위기에 대비해야 하나? (identity_leak / model_theft
//                   / controversy_spike — 가상 아이돌 운영의 critical 알림)
//   4. KPIS      — 핵심 지표가 어떻게 움직이고 있나? (WoW + 30d sparkline)
//   5. COHORT    — 비교 대상 대비 어디에 있나? (D-30 벤치마크 표)
//   6. INSIGHT   — 분석가의 권고 (LLM weekly insights)
//
// The "활성 멤버" 카드는 D-7 이상 남은 시점에서는 정보값이 0(분산
// 없음, 솔로 채널 boolean만)이라 의도적으로 collapse 처리. D-7 이내
// 또는 데뷔 후에만 자동 노출.

import { useEffect, useMemo, useState } from "preact/hooks";
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

type AlertRow = {
  alert_key: string;
  rule: "controversy_spike" | "identity_leak" | "model_theft"
       | "video_velocity_24h" | "debut_milestone" | string;
  scope: string;
  severity: "info" | "warn" | "critical";
  title: string;
  body: string;
  fired_at: string;
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
  alerts: AlertRow[];
  controversy_trend: { current: number; previous: number | null } | null;
};

// Mirrors worker rule_controversy_spike thresholds. Keep in sync.
const CONTROVERSY_SPIKE_MULTIPLIER = 2.0;
const CONTROVERSY_SPIKE_MIN_COUNT = 5;

// Strategic one-liner that summarizes "what phase is MiiWAN in and
// what posture should the operator take today". Built from days-to-
// debut + alerts severity + Health grade — i.e. signals that already
// exist on the briefing, just narrativized so the operator doesn't
// have to assemble the read themselves.
function strategicDiagnosis(d: MiiwanData): { tone: "ok" | "warn" | "critical"; line: string } {
  const days = d.days_to_debut;
  const debuted = days != null && days <= 0;
  const hasCritical = d.alerts.some((a) => a.severity === "critical");
  const hasWarn = d.alerts.some((a) => a.severity === "warn");
  const grade = d.health_score?.grade;

  if (hasCritical) {
    return {
      tone: "critical",
      line: "위기 신호 감지 — Risk Watch 우선 점검 후 대응 동선 시작.",
    };
  }
  if (days == null) {
    return { tone: "ok", line: "데뷔일 미정 — 일정 확정 후 D-N 곡선 추적 시작." };
  }
  if (debuted) {
    const dPlus = -days;
    if (dPlus <= 7) {
      return {
        tone: "warn",
        line: `데뷔 D+${dPlus} — 초기 모멘텀 측정 윈도. 24h velocity / 첫 주 SOV 변화에 즉각 반응.`,
      };
    }
    return {
      tone: grade === "S" || grade === "A" ? "ok" : "warn",
      line: `데뷔 D+${dPlus} — Health ${grade ?? "—"} 등급 기준 ${grade === "S" || grade === "A" ? "모멘텀 유지" : "약점 보완"} 우선.`,
    };
  }
  if (days <= 7) {
    return {
      tone: "warn",
      line: `데뷔 D-${days} — 라스트 마일. ipx_action 큐 우선 처리, 대기 중인 알림 모두 클리어.`,
    };
  }
  if (days <= 30) {
    return {
      tone: hasWarn ? "warn" : "ok",
      line: `데뷔 D-${days} — 가속 구간. D-30 벤치마크 갭 중 가장 큰 1개 지표 선정해 콘텐츠/PR 슬롯 집중.`,
    };
  }
  return {
    tone: "ok",
    line: `데뷔 D-${days} — 베이스라인 누적 단계. 코호트 곡선 fitting 추적 + 솔로 채널 시드 점검.`,
  };
}

const RULE_LABEL: Record<string, string> = {
  controversy_spike:  "논란 급증",
  identity_leak:      "본체 노출 가능성",
  model_theft:        "AI 도용 / 딥페이크",
  video_velocity_24h: "24h Viral",
  debut_milestone:    "데뷔 마일스톤",
};

const SEVERITY_TONE: Record<AlertRow["severity"], string> = {
  critical: "border-red-500/60 bg-red-500/10 text-red-200",
  warn:     "border-amber-500/40 bg-amber-500/10 text-amber-200",
  info:     "border-zinc-700 bg-zinc-900/40 text-zinc-300",
};

const DIAGNOSIS_TONE: Record<"ok" | "warn" | "critical", string> = {
  ok:       "border-emerald-500/40 bg-emerald-500/5 text-emerald-200",
  warn:     "border-amber-500/40 bg-amber-500/5 text-amber-200",
  critical: "border-red-500/60 bg-red-500/10 text-red-200",
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
  const [showMembers, setShowMembers] = useState<boolean>(false);

  useEffect(() => {
    api.miiwan().then((d) => {
      setData(d);
      // Auto-show member roster when within last-mile window or
      // post-debut. Operators rarely need it earlier.
      setShowMembers(d.days_to_debut == null || d.days_to_debut <= 7);
    }).catch((e) => setErr(String(e)));
  }, []);

  const dToDebut = data?.days_to_debut ?? null;
  const debuted = dToDebut != null && dToDebut <= 0;
  const accent = colorOf("miiwan");

  const ipxActions = useMemo(
    () => (data?.insights ?? []).filter((i) => i.type === "ipx_action"),
    [data],
  );
  const miiwanScoped = useMemo(
    () => (data?.insights ?? []).filter(
      (i) => i.scope === "miiwan" && i.type !== "ipx_action",
    ),
    [data],
  );
  const otherInsights = useMemo(
    () => (data?.insights ?? []).filter(
      (i) => i.scope !== "miiwan" && i.type !== "ipx_action",
    ),
    [data],
  );

  // Risk-watch alerts are the critical-class virtual-idol triggers
  // (identity_leak, model_theft, controversy_spike). Other alert rules
  // (debut_milestone, video_velocity_24h) inform the diagnosis line
  // but don't warrant their own card — they're better surfaced in
  // the action queue / KPI row.
  const riskAlerts = useMemo(() => {
    const ranked = (data?.alerts ?? []).filter((a) =>
      a.rule === "identity_leak" || a.rule === "model_theft" || a.rule === "controversy_spike"
    );
    // Critical first, then warn, then info; within tone newest first.
    const order = { critical: 0, warn: 1, info: 2 } as const;
    return [...ranked].sort((a, b) => {
      const t = (order[a.severity] ?? 3) - (order[b.severity] ?? 3);
      if (t !== 0) return t;
      return b.fired_at.localeCompare(a.fired_at);
    });
  }, [data]);

  const otherAlerts = useMemo(
    () => (data?.alerts ?? []).filter((a) =>
      a.rule !== "identity_leak" && a.rule !== "model_theft" && a.rule !== "controversy_spike"
    ),
    [data],
  );

  if (err) return <div class="text-sm text-red-400">불러오기 실패: {err}</div>;
  if (!data) return <div class="text-zinc-500">Loading…</div>;

  const diag = strategicDiagnosis(data);

  return (
    <div class="space-y-6">
      {/* 1) STRATEGIC HERO — 한 줄 진단이 가장 강한 시각 weight를
          차지하도록 구성. 위치(D-day) + 상태(Health) + 진척(멤버
          커버리지)을 한 row에. */}
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

        <div class={`mt-3 rounded border-l-4 px-3 py-2 text-sm ${DIAGNOSIS_TONE[diag.tone]}`}>
          <span class="font-semibold mr-2">전략 진단</span>{diag.line}
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

      {/* 2) ACTION QUEUE — alerts + ipx_actions 통합. 매일 보는
          운영자가 "오늘 무엇을 해야 하나"를 5초 안에 답할 수 있도록
          최상단에 위치. 빈 상태도 자리 유지 (학습된 위치 유지). */}
      <ActionQueue ipxActions={ipxActions} otherAlerts={otherAlerts} />

      {/* 3) RISK WATCH — virtual-idol critical 카테고리만 뽑아 별도
          섹션. PR/Risk 페이지로 hop 없이 MiiWAN 컨텍스트에서 즉시
          확인. 가장 시급한 시나리오부터 정렬. */}
      <RiskWatch
        alerts={riskAlerts}
        controversyTrend={data.controversy_trend}
      />

      {/* 4) Core KPIs (existing) */}
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

      {/* 5) COHORT POSITION — 데뷔 D-30 벤치마크 표. 동시 시점 비교
          가능한 유일한 그룹 데이터라 자체 가치가 큼. */}
      <section>
        <h2 class="section-title mb-3">코호트 비교 — 데뷔 D-30 벤치마크</h2>
        <p class="mb-3 text-hint text-zinc-500">
          비교 그룹의 데뷔 직전 스냅샷 vs 현재 MiiWAN. 가장 큰 갭이 다음 콘텐츠 슬롯의 근거.
        </p>
        {data.benchmarks.length === 0 || !data.summary ? (
          <EmptyState
            title="벤치마크 비교 데이터 부족"
            hint="비교 그룹의 과거 스냅샷이 누적되면 자동으로 채워집니다 (backfill-yt-history 실행 후)."
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

      {/* 6) STRATEGIC INSIGHT — LLM weekly insights, MiiWAN-scoped first. */}
      <section>
        <h2 class="section-title mb-3">전략 인사이트 (LLM weekly)</h2>
        {data.insights.length === 0 ? (
          <EmptyState
            title="아직 MiiWAN 전용 인사이트 없음"
            hint="주간 LLM 분석이 1회 이상 돌면 여기에 채워집니다. 현재는 시장 인사이트 탭을 참고하세요."
            icon="💡"
          />
        ) : (
          <div class="space-y-4">
            {miiwanScoped.length > 0 && (
              <InsightGroup title="MiiWAN 전용" tone="brand"
                            items={miiwanScoped} accent={accent} />
            )}
            {otherInsights.length > 0 && (
              <InsightGroup
                title="관련 시장 인사이트"
                tone="muted"
                items={otherInsights}
                hint="MiiWAN 직접은 아니지만 운영에 참고 가능"
              />
            )}
          </div>
        )}
      </section>

      {/* 7) MEMBERS — debut D-7 이내 또는 데뷔 후에만 자동 노출.
          이전에는 D-30+ 시점에서도 무조건 노출됐는데, 솔로 채널
          boolean 5개 동일 상태라 의사결정 가치 0이었음. */}
      <section>
        <div class="mb-3 flex items-baseline gap-2">
          <h2 class="section-title">활성 멤버 ({data.members.length}명)</h2>
          <button
            type="button"
            class="text-xs text-zinc-400 hover:text-zinc-200 hover:underline"
            onClick={() => setShowMembers((v) => !v)}
          >
            {showMembers ? "접기" : "펼치기"}
          </button>
          {!showMembers && (
            <span class="text-hint text-zinc-500">
              {data.members.filter((m) => m.has_solo_channel).length}/{data.members.length}명 솔로 채널 등록
            </span>
          )}
        </div>
        {showMembers && (
          data.members.length === 0 ? (
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
          )
        )}
      </section>
    </div>
  );

  function ActionQueue(props: {
    ipxActions: Insight[];
    otherAlerts: AlertRow[];
  }) {
    const total = props.ipxActions.length + props.otherAlerts.length;
    return (
      <section
        class={"rounded-card border-l-4 border p-4 " +
          (total === 0
            ? "border-emerald-500/40 border-zinc-800 bg-emerald-500/5"
            : "border-amber-500 border-zinc-800 bg-amber-500/5")
        }
      >
        <div class="mb-3 flex flex-wrap items-baseline gap-2">
          <h2 class="text-lg font-bold">
            ⚡ 지금 처리할 것
            {total > 0 && <span class="ml-2 text-sm font-normal text-zinc-500">{total}건</span>}
          </h2>
          <span class="text-hint text-zinc-500">
            IPX 액션 권고 + 14일 내 누적된 마일스톤/Viral 알림
          </span>
        </div>

        {total === 0 ? (
          <div class="text-sm text-zinc-300">
            ✓ 처리할 액션 없음 — 모니터링 모드. 데뷔까지 자동 D-7 / D-1 알림이 자동 트리거됩니다.
          </div>
        ) : (
          <div class="space-y-3">
            {props.ipxActions.length > 0 && (
              <div>
                <h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-amber-300">
                  IPX 액션 권고 ({props.ipxActions.length})
                </h3>
                <ul class="space-y-2">
                  {props.ipxActions.map((i) => (
                    <li key={i.id}
                        class="rounded border-l-2 border-amber-500 bg-zinc-900/40 p-2.5 text-sm">
                      <div class="font-semibold">{i.title}</div>
                      <div class="mt-1 text-xs text-zinc-400">{i.body}</div>
                      <SourceRef refs={i.source_refs ?? []} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {props.otherAlerts.length > 0 && (
              <div>
                <h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  자동 알림 ({props.otherAlerts.length})
                </h3>
                <ul class="space-y-2">
                  {props.otherAlerts.map((a) => (
                    <li key={a.alert_key}
                        class={`rounded border-l-2 p-2.5 text-sm ${SEVERITY_TONE[a.severity]}`}>
                      <div class="flex items-baseline gap-2">
                        <span class="rounded bg-zinc-900/60 px-1.5 text-[11px] text-zinc-300">
                          {RULE_LABEL[a.rule] ?? a.rule}
                        </span>
                        <span class="font-semibold">{a.title}</span>
                        <span class="ml-auto text-hint text-zinc-500">
                          {a.fired_at?.slice(0, 16).replace("T", " ")}
                        </span>
                      </div>
                      <div class="mt-1 text-xs text-zinc-400">{a.body}</div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>
    );
  }

  function RiskWatch(props: {
    alerts: AlertRow[];
    controversyTrend: { current: number; previous: number | null } | null;
  }) {
    const cur = props.controversyTrend?.current ?? 0;
    const prev = props.controversyTrend?.previous ?? 0;
    const ratio: number | null = prev === 0
      ? (cur > 0 ? Infinity : null)
      : cur / prev;
    const isSpiking = cur >= CONTROVERSY_SPIKE_MIN_COUNT
                    && ratio != null
                    && ratio >= CONTROVERSY_SPIKE_MULTIPLIER;
    const hasCritical = props.alerts.some((a) => a.severity === "critical");
    const level: "OK" | "ELEVATED" | "CRITICAL" =
      hasCritical ? "CRITICAL" : isSpiking ? "ELEVATED" : "OK";
    const tone =
      level === "CRITICAL" ? "border-red-500 bg-red-500/10 text-red-200"
      : level === "ELEVATED" ? "border-amber-500 bg-amber-500/10 text-amber-200"
      : "border-emerald-500/40 bg-emerald-500/5 text-emerald-200";

    return (
      <section>
        <div class="mb-3 flex flex-wrap items-baseline gap-2">
          <h2 class="section-title">위기 모니터 (Risk Watch)</h2>
          <span class="text-hint text-zinc-500">
            가상 아이돌 운영의 critical 시나리오만 별도. 본체 노출 / AI 도용 / 논란 급증.
          </span>
        </div>

        <div class={`rounded border-l-4 px-3 py-2 text-sm ${tone}`}>
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-semibold">Risk: {level}</span>
            {props.controversyTrend && (
              <span class="rounded bg-zinc-900/50 px-2 py-0.5 text-xs">
                Controversy 이번 주 {cur} · 직전 주 {prev}
                {ratio != null && Number.isFinite(ratio) && ` (${ratio.toFixed(1)}×)`}
              </span>
            )}
            {isSpiking && (
              <span class="rounded bg-amber-500/20 px-2 py-0.5 text-xs text-amber-200">
                ≥{CONTROVERSY_SPIKE_MULTIPLIER}× WoW · floor {CONTROVERSY_SPIKE_MIN_COUNT}
              </span>
            )}
          </div>
          {level !== "OK" && (
            <div class="mt-1 text-xs text-zinc-300">
              ※ 자동 알림 — 인간 검증 후 대응 권장. False positive 시 Streisand effect 주의.
            </div>
          )}
        </div>

        {props.alerts.length > 0 && (
          <ul class="mt-3 space-y-2">
            {props.alerts.map((a) => (
              <li key={a.alert_key}
                  class={`rounded border-l-2 p-3 ${SEVERITY_TONE[a.severity]}`}>
                <div class="flex items-baseline gap-2">
                  <span class="rounded bg-zinc-900/60 px-1.5 text-[11px] text-zinc-300">
                    {RULE_LABEL[a.rule] ?? a.rule}
                  </span>
                  <span class="font-semibold">{a.title}</span>
                  <span class="ml-auto text-hint text-zinc-500">
                    {a.fired_at?.slice(0, 16).replace("T", " ")}
                  </span>
                </div>
                <div class="mt-1 text-sm text-zinc-300">{a.body}</div>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }
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
