// frontend/src/components/MiiWANCohortReport.tsx
//
// 동시기 성과 — 데뷔 코호트 벤치마크 (투자사 보고 서사).
// 구조: ① 결론 헤드라인(스코어카드에서 자동 산출, 하드코딩 금지)
//      ② 인덱스 성장곡선(D0=100) ③ 스코어카드 표 ④ 동시기 유기성
//      ⑤ 방법론 각주. 열세 지표도 숨기지 않는다 — 가짜 없는 보고가 전제.
import { useEffect, useRef, useState } from "preact/hooks";
import Chart from "chart.js/auto";
import { api } from "../api";
import { fmt } from "../format";
import { colorOf } from "../design/groups";
import { EmptyState } from "./EmptyState";
import { EstBadge } from "../views/MiiWANBriefing";

type CurvePoint = { day: number; index: number; source: string };
type ScRow = {
  group_key: string; value_at_day: number | null;
  growth_multiple: number | null; source: string | null; reference: boolean;
  /** 실제로 값을 집어온 경과일 — 탐색 허용폭 때문에 D+N과 다를 수 있다. */
  base_day: number | null; at_day: number | null; base_source: string | null;
};
type OrgRow = {
  group_key: string; score: number | null; video_count: number; reference: boolean;
};
/** score가 실제로 있는 행만 남긴 뒤 쓰는 좁힌 타입 (막대 폭 계산에 non-null 필요). */
type OrgRowScored = Omit<OrgRow, "score"> & { score: number };
type CohortData = {
  as_of_day: number;
  metrics: string[];
  groups: Record<string, { name: string; debut_date: string | null; reference: boolean }>;
  curves: Record<string, Record<string, CurvePoint[]>>;
  scorecard: Record<string, { rows: ScRow[]; miiwan_rank: number | null; cohort_size: number }>;
  organicity: OrgRow[];
  /** 유기성 집계에 실제로 쓰인 데뷔 창 라벨 (예: "D-Day~D+40"). */
  organicity_window?: string;
  /** 유기성 쿼리 실패 시 true (+ organicity: []). 숨기지 말고 힌트 카드로 노출. */
  organicity_unavailable?: boolean;
  excluded: Array<{ group_key: string; metric: string; reason: string }>;
};

const METRIC_LABELS: Record<string, string> = {
  yt_subscribers: "구독자",
  yt_total_views: "누적 조회수",
  naver_total_news: "뉴스 노출",
  dc_total_posts: "커뮤니티 활동",
};

const accent = colorOf("miiwan");

function fmtMultiple(m: number | null): string {
  return m == null ? "—" : `${(Math.round(m * 10) / 10).toFixed(1)}×`;
}

/** 데뷔 경과일 라벨 — 음수(데뷔 전 기준 스냅샷)면 "D-2" 로 쓴다. */
function dayLabel(day: number): string {
  return day < 0 ? `D${day}` : `D+${day}`;
}

// 헤드라인: 지표별 순위를 우세(상위 절반)/열세로 나눠 한 줄 결론 생성.
function headline(d: CohortData): { lead: string; trail: string | null } {
  const parts: string[] = [];
  const weak: string[] = [];
  for (const m of d.metrics) {
    const sc = d.scorecard[m];
    if (!sc || sc.miiwan_rank == null || sc.cohort_size < 2) continue;
    const label = METRIC_LABELS[m] ?? m;
    const mine = sc.rows.find((r) => r.group_key === "miiwan");
    const txt = `${label} 성장 ${fmtMultiple(mine?.growth_multiple ?? null)} (동시기 ${sc.cohort_size}팀 중 ${sc.miiwan_rank}위)`;
    if (sc.miiwan_rank <= Math.ceil(sc.cohort_size / 2)) parts.push(txt);
    else weak.push(txt);
  }
  return {
    lead: parts.length
      ? `데뷔 D+${d.as_of_day} 기준, ${parts.join(" · ")}`
      : `데뷔 D+${d.as_of_day} 기준 동시기 비교`,
    trail: weak.length ? `보완 지표: ${weak.join(" · ")}` : null,
  };
}

export function MiiWANCohortReport() {
  const [data, setData] = useState<CohortData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [metricSel, setMetricSel] = useState<string>("yt_subscribers");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<Chart | null>(null);

  useEffect(() => {
    let alive = true;
    api.miiwanCohort()
      .then((d: CohortData) => { if (alive) setData(d); })
      .catch((e: unknown) => { if (alive) setErr(String(e)); });
    return () => { alive = false; };
  }, []);

  // 선택된 지표가 응답의 metrics에 없을 수 있다(백엔드가 지표 목록을 바꾸면
  // 기본값 "yt_subscribers"가 유효하지 않을 수 있음) → 파생값으로 흡수해
  // 차트·표·탭이 모두 실제 존재하는 지표를 가리키게 한다.
  const metric = data && !data.metrics.includes(metricSel)
    ? (data.metrics[0] ?? metricSel)
    : metricSel;

  const curves: Record<string, CurvePoint[]> = data?.curves?.[metric] ?? {};
  const hasCurves = Object.keys(curves).length > 0;

  useEffect(() => {
    // 어떤 조기 종료 경로에서도 이전 인스턴스가 남지 않도록 항상 먼저 파기.
    // (곡선이 비어 canvas 자체가 언마운트되는 경우 포함)
    chartRef.current?.destroy();
    chartRef.current = null;
    const canvas = canvasRef.current;
    if (!canvas || !data || !hasCurves) return;

    const entries = Object.entries(curves)
      // 미완이 라인이 항상 마지막(최상단)에 그려지게 정렬
      .sort(([a], [b]) => (a === "miiwan" ? 1 : b === "miiwan" ? -1 : 0));
    chartRef.current = new Chart(canvas, {
      type: "line",
      data: {
        datasets: entries.map(([gk, pts]) => {
          const ref = data.groups[gk]?.reference;
          const isMine = gk === "miiwan";
          return {
            label: (data.groups[gk]?.name ?? gk) + (ref ? " (참조)" : ""),
            data: pts.map((p) => ({ x: p.day, y: p.index })),
            borderColor: colorOf(gk),
            backgroundColor: colorOf(gk),
            borderWidth: isMine ? 3 : 1.5,
            borderDash: ref ? [6, 4] : undefined,
            pointRadius: 0,
            pointHoverRadius: 4,
            tension: 0.25,
          };
        }),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          x: {
            type: "linear",
            title: { display: true, text: "데뷔 후 경과일 (D+N)" },
            // 기준점이 데뷔 전 스냅샷이면 곡선이 음수 day에서 시작할 수 있다.
            ticks: { callback: (v) => dayLabel(Number(v)) },
          },
          y: { title: { display: true, text: "인덱스 (D-Day = 100)" } },
        },
        plugins: {
          tooltip: {
            callbacks: {
              title: (items) => {
                const x = items[0]?.parsed.x;
                return x == null ? "" : dayLabel(x);
              },
              label: (item) => `${item.dataset.label}: ${item.parsed.y}`,
            },
          },
        },
      },
    });
    return () => { chartRef.current?.destroy(); chartRef.current = null; };
  }, [data, metric, hasCurves]);

  if (err) return <EmptyState title="동시기 비교 로드 실패" hint={err} icon="⚠️" />;
  if (!data) return <EmptyState title="불러오는 중…" hint="" icon="⏳" />;

  // 아래는 전부 훅이 아닌 일반 계산 — 조기 종료 뒤에 와도 훅 규칙에 안전하다.
  const head = headline(data);
  const sc = data.scorecard[metric];
  const orgRows: OrgRowScored[] = data.organicity
    .filter((o): o is OrgRowScored => o.score != null)
    .sort((a, b) => b.score - a.score);
  const miiwanOrg = orgRows.find((o) => o.group_key === "miiwan");
  // 코호트 후보 = 참조선(PLAVE)을 뺀 동시기 그룹 수 — **미완이 포함**.
  // cohort_size(백엔드)도 미완이 기준값이 있으면 미완이를 포함해 세므로
  // 포함 기준을 여기에 맞춘다. (미완이를 뺀 5팀과 비교하면 "후보 5팀 중
  // 확보 6팀" 같은 부분집합 > 전체집합 모순이 생긴다.)
  // cohort_size 는 그중 이 지표의 D-Day 기준값이 확보된 그룹만 세므로
  // 후보 수 이하 — 각주가 둘을 함께 밝힌다.
  const cohortCandidates = Object.values(data.groups).filter((g) => !g.reference).length;
  // miiwan_rank == null 의 원인 구분: 미완이 자신의 기준값이 없어서인지
  // (그러면 cohort_size 는 피어만 센다) 피어가 없어서인지.
  const miiwanBaselineMissing =
    sc != null && sc.rows.find((r) => r.group_key === "miiwan")?.growth_multiple == null;
  const orgWindowLabel = data.organicity_window ?? "데뷔 창";
  const excludedTip = data.excluded
    .map((e) => `${data.groups[e.group_key]?.name ?? e.group_key} / ${METRIC_LABELS[e.metric] ?? e.metric}: ${e.reason}`)
    .join("\n");

  return (
    <div class="space-y-4">
      {/* ① 결론 헤드라인 — 스코어카드 자동 산출 */}
      <div class="card border-l-4" style={{ borderLeftColor: accent }}>
        <p class="font-semibold text-zinc-100">{head.lead}</p>
        {head.trail && <p class="mt-1 text-hint text-zinc-400">{head.trail}</p>}
        <p class="mt-1 text-hint text-zinc-500">
          절대 규모가 아니라 <strong class="text-zinc-300">같은 데뷔 경과 시점(D+{data.as_of_day})의
          성장 기울기</strong>로 비교 — 각 그룹의 데뷔일을 0일로 정렬한 값.
        </p>
      </div>

      {/* ② 인덱스 성장곡선 + 지표 pill 탭 */}
      <div>
        <div role="tablist" aria-label="cohort metric"
             class="mb-3 flex overflow-x-auto gap-1 card p-1">
          {data.metrics.map((m) => {
            const active = m === metric;
            return (
              <button key={m} role="tab" aria-selected={active}
                      class={"flex-1 min-w-[80px] rounded-md px-3 py-1.5 text-sm font-medium transition "
                        + (active ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200")}
                      style={active ? { color: accent } : undefined}
                      onClick={() => setMetricSel(m)}>
                {METRIC_LABELS[m] ?? m}
              </button>
            );
          })}
        </div>
        {!hasCurves ? (
          <EmptyState title="이 지표의 곡선 데이터 부족"
                      hint="D-Day 기준값이 축적되면 자동으로 채워집니다." icon="📈" />
        ) : (
          <div class="card" style={{ height: "320px" }}>
            <canvas ref={canvasRef} />
          </div>
        )}
      </div>

      {/* ③ 동시기 스코어카드 */}
      {sc && (
        <div class="overflow-x-auto rounded-lg border border-zinc-800">
          <table class="w-full min-w-[560px] text-sm tabular-nums">
            <thead class="bg-zinc-900/60 text-xs uppercase tracking-wider text-zinc-500">
              <tr>
                <th class="px-3 py-2 text-left">그룹</th>
                <th class="px-3 py-2 text-right">D+{data.as_of_day} 시점 값</th>
                <th class="px-3 py-2 text-right">성장배수 (D-Day 대비)</th>
              </tr>
            </thead>
            <tbody>
              {[...sc.rows]
                .sort((a, b) => (b.growth_multiple ?? -1) - (a.growth_multiple ?? -1))
                .map((r) => {
                  const isMine = r.group_key === "miiwan";
                  return (
                    <tr key={r.group_key}
                        class={"border-t border-zinc-800/60" + (isMine ? " bg-zinc-800/40" : "")}>
                      <td class="px-3 py-2" style={{ color: colorOf(r.group_key) }}>
                        {data.groups[r.group_key]?.name ?? r.group_key}
                        {r.reference && (
                          <span class="ml-1 text-hint text-zinc-500"
                                title="성공 사례 참조선 — 순위 모수에서 제외">참조 · 순위 제외</span>
                        )}
                      </td>
                      <td class="px-3 py-2 text-right text-zinc-300">
                        <div>
                          {r.value_at_day == null ? "—" : fmt(r.value_at_day)}
                          <EstBadge source={r.source} />
                        </div>
                        {r.at_day != null && (
                          <div class="text-hint text-zinc-600">
                            실측 {dayLabel(r.at_day)}
                            {r.base_day != null && <> · 기준 {dayLabel(r.base_day)}</>}
                          </div>
                        )}
                      </td>
                      <td class={"px-3 py-2 text-right " + (isMine ? "font-semibold" : "text-zinc-300")}
                          style={isMine ? { color: accent } : undefined}>
                        {fmtMultiple(r.growth_multiple)}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
          <p class="px-3 py-2 text-hint text-zinc-500 border-t border-zinc-800/60">
            {/* 코호트가 미완이 1팀뿐이면 "1위"는 자기 자신을 이긴 것이라
                의미가 없다 — 순위 대신 모수 부족을 명시한다(빈칸 금지). */}
            {sc.miiwan_rank != null && sc.cohort_size >= 2 ? (
              <>
                성장배수 기준 동시기 {sc.cohort_size}팀 중 <strong style={{ color: accent }}>
                MiiWAN {sc.miiwan_rank}위</strong> (참조 그룹 제외).
              </>
            ) : miiwanBaselineMissing ? (
              <>
                MiiWAN의 이 지표 D-Day 기준값(±3)이 없어 동시기 순위를 내지 않는다
                (기준값 확보 피어 {sc.cohort_size}팀).
              </>
            ) : (
              <>동시기 비교 가능한 코호트 부족 (이 지표 기준값 확보 그룹 {sc.cohort_size}팀, MiiWAN 포함).</>
            )}
            {" "}값은 D-Day±3 / D+{data.as_of_day}±7 안의 최근접 스냅샷에서 집었고,
            행마다 실제 측정일을 병기했다.
          </p>
        </div>
      )}

      {/* ④ 동시기 유기성 — 데뷔 창 한정(미완이 경과일이 도달한 버킷까지만).
          아래 '코호트 유기성 비교'(롤링 창)와 기준이 다름을 명시. */}
      {data.organicity_unavailable && (
        <div class="card">
          <p class="text-hint text-zinc-500">
            유기성 데이터를 불러오지 못했습니다 (일시 오류).
          </p>
        </div>
      )}
      {orgRows.length > 0 && (
        <div class="card">
          <p class="mb-2 text-sm font-medium text-zinc-200">
            동시기 유기성 (각 그룹의 데뷔 창 {orgWindowLabel} 기준)
            {miiwanOrg && (
              <span class="ml-2 text-hint text-zinc-500">MiiWAN {miiwanOrg.score}점</span>
            )}
          </p>
          <div class="space-y-1.5">
            {orgRows.map((o) => (
              <div key={o.group_key} class="flex items-center gap-2 text-sm">
                <span class="w-20 shrink-0" style={{ color: colorOf(o.group_key) }}>
                  {data.groups[o.group_key]?.name ?? o.group_key}
                </span>
                <div class="h-2 flex-1 rounded bg-zinc-800">
                  <div class="h-2 rounded"
                       style={{ width: `${Math.max(0, Math.min(100, o.score))}%`,
                                background: colorOf(o.group_key),
                                opacity: o.group_key === "miiwan" ? 1 : 0.5 }} />
                </div>
                <span class="w-12 text-right tabular-nums text-zinc-400">{o.score}</span>
                {o.reference && <span class="text-hint text-zinc-600">참조</span>}
              </div>
            ))}
          </div>
          <p class="mt-2 text-hint text-zinc-500">
            미완이가 도달한 버킷({orgWindowLabel})까지만 집계 — 피어만 더 긴 창을
            쓰지 않도록 창을 맞춘다. 아래 &lsquo;코호트 유기성 비교&rsquo;는 데뷔 창이 아니라
            최근 롤링 창 기준이라 숫자가 다를 수 있다.
          </p>
        </div>
      )}

      {/* ⑤ 방법론 각주 — "이 비교 어떻게 만든 거냐"에 화면만으로 답하기 */}
      <p class="text-hint text-zinc-500 leading-relaxed">
        방법론: 각 그룹의 데뷔일을 D-Day(=0일)로 정렬하고 같은 경과일의 스냅샷을
        비교. 성장곡선은 D-Day 값=100 인덱스, 성장배수는 D+{data.as_of_day} 값 ÷ D-Day 값
        (기준값은 D-Day±3, 도달값은 D+{data.as_of_day}±7 안의 최근접 스냅샷).
        순위 코호트는 데뷔 초기 구간을 정렬해 비교한 K-POP 버추얼 후보 {cohortCandidates}팀
        (MiiWAN 포함) 중 {METRIC_LABELS[metric] ?? metric} 지표에서 기준값이 확보된
        {" "}{sc?.cohort_size ?? 0}팀,
        PLAVE는 성공 사례 참조선(그래프 점선 · 순위 제외). <span class="text-zinc-400">est</span> 배지 =
        백필 추정치(곡선 모양 신뢰, 절대값 참고). 해당 구간 데이터가 없는 그룹은
        수치를 만들어 채우지 않고 비교에서 제외
        {data.excluded.length > 0 && (
          <span title={excludedTip}> (현재 {data.excluded.length}건 제외)</span>
        )}.
      </p>
    </div>
  );
}
