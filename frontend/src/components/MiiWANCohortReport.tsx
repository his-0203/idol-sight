// frontend/src/components/MiiWANCohortReport.tsx
//
// 동시기 성과 — 같은 시기에 데뷔한 팀들과의 비교 (투자사 보고 서사).
// 구조: ① 결론 헤드라인(스코어카드에서 자동 산출, 하드코딩 금지)
//      ② 성장곡선(데뷔일=100) ③ 스코어카드 표 ④ 자연 유입 점수
//      ⑤ 방법론 각주. 열세 지표도 숨기지 않는다 — 가짜 없는 보고가 전제.
//
// 카피 원칙: 읽는 사람은 투자사·경영진이지 데이터 담당자가 아니다.
// "코호트 / 유기성 / 인덱스 / 스냅샷 / 허용폭" 같은 내부 용어는 화면에
// 쓰지 않고 각각 "같은 시기에 데뷔한 팀들 / 자연 유입 점수 / 데뷔일=100
// 성장 폭 / 측정값 / 오차 범위"로 말한다. 정직성 장치(측정일 병기 · 제외
// 명시 · est 배지)는 문장만 쉬워질 뿐 그대로 남는다.
import { useEffect, useRef, useState } from "preact/hooks";
import Chart from "chart.js/auto";
import { api } from "../api";
import { fmt } from "../format";
import { colorOf } from "../design/groups";
import { EmptyState } from "./EmptyState";
import { EstBadge } from "./EstBadge";
// 헤드라인 문구·임계값은 순수 로직이라 lib 로 뺐다 (테스트: tests/lib/cohortHeadline.test.ts).
import {
  AD_SUSPECT_METRICS, METRIC_LABELS, ORG_AD_SUSPECT_THRESHOLD,
  fmtMultiple, headline, type CohortData, type CurvePoint, type OrgRowScored,
} from "../lib/cohortHeadline";

/** excluded.reason → 화면 문구. 사유별로 운영 대응이 달라 뭉뚱그리지 않는다. */
const EXCLUDED_REASONS: Record<string, string> = {
  no_data_in_window: "비교 구간에 측정값이 아예 없음",
  no_d0_baseline: "데뷔일 시점 값이 없음 (과거 데이터 보완 전)",
  empty_window: "데뷔일 값은 있으나 비교 구간에 측정값이 없음",
};

const accent = colorOf("miiwan");

// 지표 탭 ↔ 패널 연결용 고정 id. 패널은 하나이고 내용만 바뀌므로
// 모든 탭이 같은 패널을 가리키고, 패널은 활성 탭을 labelledby 로 가리킨다.
const PANEL_ID = "cohort-metric-panel";
const tabId = (m: string) => `cohort-metric-tab-${m}`;

/**
 * 측정일 오차 범위 표기(`±3일`). 응답에 상수가 없으면 숫자를 지어내지 않고
 * "오차 범위 안"으로 우아하게 생략한다 — 틀린 범위를 보여주느니 안 보여주는
 * 쪽이 낫다 (투자사 보고). 항상 괄호 안에서 쓰여 세 사용처(스코어카드 각주 ·
 * 방법론 각주 ×2)가 같은 생략 처리를 갖는다.
 */
function tol(n: number | undefined): string {
  return n == null ? "오차 범위 안" : `±${n}일`;
}

/** 데뷔 경과일 라벨 — 음수(데뷔 전 기준 스냅샷)면 "D-2" 로 쓴다. */
function dayLabel(day: number): string {
  return day < 0 ? `D${day}` : `D+${day}`;
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
            title: { display: true, text: "데뷔 후 며칠 (D+N)" },
            // 기준점이 데뷔 전 측정값이면 곡선이 음수 day에서 시작할 수 있다.
            ticks: { callback: (v) => dayLabel(Number(v)) },
          },
          y: { title: { display: true, text: "데뷔일 값을 100으로 놓은 성장 폭" } },
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
  // 성장배수 ↔ 자연 유입 점수 교차 검증용 조회표. 점수가 없는 그룹은 맵에
  // 아예 들어가지 않고, 없으면 배지도 달지 않는다 — 판정 근거 없이 "광고
  // 의심"을 씌우지 않는다(기존 "가짜 수치 없음"과 같은 원칙).
  const orgScoreOf = new Map(
    data.organicity.filter((o) => o.score != null).map((o) => [o.group_key, o.score!]),
  );
  const adSuspectMetric = AD_SUSPECT_METRICS.has(metric);
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
  // 측정 허용폭은 백엔드 상수에서 파생 — 화면에 ±3 / ±7 을 따로 적어두면
  // 상수를 바꿨을 때 표기와 실제 계산이 조용히 어긋난다.
  const baseTol = tol(data.windows?.base);
  const atTol = tol(data.windows?.at);

  return (
    <div class="space-y-4">
      {/* ① 결론 헤드라인 — 스코어카드 자동 산출 (수치·순위 하드코딩 금지) */}
      <div class="card border-l-4" style={{ borderLeftColor: accent }}>
        <p class="font-semibold text-zinc-100">{head.lead}</p>
        {head.neutral && <p class="mt-1 text-hint text-zinc-400">{head.neutral}</p>}
        {head.strengths.length > 0 && (
          <div class="mt-3">
            <p class="text-sm font-medium text-zinc-200">✅ 잘하고 있는 것</p>
            <ul class="mt-1 list-disc space-y-0.5 pl-5 text-sm text-zinc-300">
              {head.strengths.map((s) => <li key={s}>{s}</li>)}
            </ul>
            {head.strengthWhy && (
              <p class="mt-1 pl-5 text-hint text-zinc-400">{head.strengthWhy}</p>
            )}
          </div>
        )}
        {head.weaknesses.length > 0 && (
          <div class="mt-3">
            <p class="text-sm font-medium text-zinc-200">⚠️ 보완할 것</p>
            <ul class="mt-1 list-disc space-y-0.5 pl-5 text-sm text-zinc-300">
              {head.weaknesses.map((w) => <li key={w}>{w}</li>)}
            </ul>
          </div>
        )}
        <p class="mt-3 text-hint text-zinc-500">
          규모가 큰 팀이 이기는 비교가 아니다 — 각 팀의 데뷔일을 똑같이 출발선에
          놓고, <strong class="text-zinc-300">데뷔한 지 같은 날짜(D+{data.as_of_day})에
          얼마나 늘었는지</strong>를 견준다.
        </p>
      </div>

      {/* ② 성장곡선(데뷔일=100) + 지표 pill 탭 */}
      <div>
        <p class="mb-2 text-hint text-zinc-400">
          <strong class="text-zinc-300">이 그래프로 알 수 있는 것</strong> — 출발선을
          맞췄을 때 누가 더 가파르게 크고 있는지. 각 팀의 데뷔일 값을 100으로 놓고,
          거기서 몇까지 올라왔는지를 그린다 (200이면 두 배).
        </p>
        <div role="tablist" aria-label="지표 선택"
             class="mb-3 flex overflow-x-auto gap-1 card p-1">
          {data.metrics.map((m) => {
            const active = m === metric;
            return (
              <button key={m} id={tabId(m)} role="tab" aria-selected={active}
                      aria-controls={PANEL_ID}
                      class={"flex-1 min-w-[80px] rounded-md px-3 py-1.5 text-sm font-medium transition "
                        + (active ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200")}
                      style={active ? { color: accent } : undefined}
                      onClick={() => setMetricSel(m)}>
                {METRIC_LABELS[m] ?? m}
              </button>
            );
          })}
        </div>
        {/* 패널은 하나(내용만 교체) — tabIndex 0 이라 캔버스밖에 없어도
            키보드로 도달·스크롤할 수 있다. */}
        <div id={PANEL_ID} role="tabpanel" tabIndex={0} aria-labelledby={tabId(metric)}>
          {!hasCurves ? (
            <EmptyState title="이 지표는 아직 그래프를 그릴 수 없다"
                        hint="데뷔일 시점 값이 쌓이면 자동으로 채워집니다." icon="📈" />
          ) : (
            <div class="card" style={{ height: "320px" }}>
              <canvas ref={canvasRef} />
            </div>
          )}
        </div>
      </div>

      {/* ③ 동시기 스코어카드 */}
      {sc && (
        <div class="overflow-x-auto rounded-lg border border-zinc-800">
          <p class="px-3 py-2 text-hint text-zinc-400 border-b border-zinc-800/60">
            <strong class="text-zinc-300">이 표로 알 수 있는 것</strong> — 같은 시기에
            데뷔한 팀들 사이에서 우리가 몇 번째로 크게 늘었는지. 성장배수는 데뷔일
            대비 지금 몇 배가 됐는지를 뜻한다.
          </p>
          <table class="w-full min-w-[560px] text-sm tabular-nums">
            <thead class="bg-zinc-900/60 text-xs uppercase tracking-wider text-zinc-500">
              <tr>
                <th class="px-3 py-2 text-left">그룹</th>
                <th class="px-3 py-2 text-right">D+{data.as_of_day} 시점 값</th>
                <th class="px-3 py-2 text-right">성장배수 (데뷔일 대비)</th>
              </tr>
            </thead>
            <tbody>
              {[...sc.rows]
                .sort((a, b) => (b.growth_multiple ?? -1) - (a.growth_multiple ?? -1))
                .map((r) => {
                  const isMine = r.group_key === "miiwan";
                  // 성장배수만 보면 "잘 컸네"로 읽히지만 광고비로도 만들 수
                  // 있는 숫자다. 같은 그룹의 자연 유입 점수가 낮으면 그 성장에
                  // 광고 몫이 섞여 있다는 뜻이라 배수 옆에서 바로 경고한다.
                  // 점수 자체가 없으면(맵에 없음) 배지 없음.
                  const orgScore = orgScoreOf.get(r.group_key);
                  const adSuspect = adSuspectMetric
                    && r.growth_multiple != null
                    && orgScore != null
                    && orgScore < ORG_AD_SUSPECT_THRESHOLD;
                  return (
                    <tr key={r.group_key}
                        class={"border-t border-zinc-800/60" + (isMine ? " bg-zinc-800/40" : "")}>
                      <td class="px-3 py-2" style={{ color: colorOf(r.group_key) }}>
                        {data.groups[r.group_key]?.name ?? r.group_key}
                        {r.reference && (
                          <span class="ml-1 text-hint text-zinc-500"
                                title="먼저 성공한 선례라 체급이 달라 순위에서 뺀다">참고용 · 순위 제외</span>
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
                        {adSuspect && (
                          <div class="text-hint font-normal text-amber-500"
                               title={"데뷔 초기 영상 중 유료 광고로 판정된 비중이 높아, "
                                 + "이 성장에는 광고 효과가 섞여 있을 수 있음 "
                                 + `(자연 유입 점수 ${orgScore}점 · 기준 ${ORG_AD_SUSPECT_THRESHOLD}점 미만)`}>
                            광고 영향 의심
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
          <p class="px-3 py-2 text-hint text-zinc-500 border-t border-zinc-800/60">
            {/* 비교 대상이 미완이 1팀뿐이면 "1위"는 자기 자신을 이긴 것이라
                의미가 없다 — 순위 대신 모수 부족을 명시한다(빈칸 금지). */}
            {sc.miiwan_rank != null && sc.cohort_size >= 2 ? (
              <>
                성장배수 기준 같은 시기 데뷔 {sc.cohort_size}팀 중 <strong style={{ color: accent }}>
                MiiWAN {sc.miiwan_rank}위</strong> (참고용 팀 제외).
              </>
            ) : miiwanBaselineMissing ? (
              <>
                MiiWAN의 이 지표는 데뷔일 시점 값({baseTol})이 없어 순위를
                내지 않는다 (데뷔일 값이 있는 다른 팀 {sc.cohort_size}팀).
              </>
            ) : (
              <>같은 시기에 데뷔한 비교 대상이 부족하다 (이 지표의 데뷔일 값이 있는 팀 {sc.cohort_size}팀, MiiWAN 포함).</>
            )}
            {" "}값은 데뷔일({baseTol}) / D+{data.as_of_day}({atTol}) 안에서 가장 가까운 날의
            측정값을 썼고, 줄마다 실제로 잰 날짜를 함께 적었다.
          </p>
          {/* 광고 의심 배지와 짝이 되는 각주 — 배지가 안 뜨는 지표·시점에도
              "배수는 돈으로도 만들 수 있다"는 읽는 법 자체를 남긴다. */}
          <p class="px-3 py-2 text-hint text-zinc-500 border-t border-zinc-800/60">
            성장배수는 광고비를 써서도 만들 수 있는 숫자다. 그래서 이 표만 보지 말고
            아래 <strong class="text-zinc-300">자연 유입 점수</strong>(광고 없이 팬이 스스로
            찾아온 정도)와 같이 봐야 한다 — 유튜브 지표는 그 점수가
            {" "}{ORG_AD_SUSPECT_THRESHOLD}점 미만인 팀에 &lsquo;광고 영향 의심&rsquo;을 표시해 뒀다.
          </p>
        </div>
      )}

      {/* ④ 자연 유입 점수(유기성) — 데뷔 직후 구간 한정(미완이 경과일이 도달한
          버킷까지만). 아래 '코호트 유기성 비교'(롤링 창)와 기준이 다름을 명시. */}
      {data.organicity_unavailable && (
        <div class="card">
          <p class="text-hint text-zinc-500">
            자연 유입 점수를 불러오지 못했습니다 (일시 오류).
          </p>
        </div>
      )}
      {orgRows.length > 0 && (
        <div class="card">
          <p class="mb-1 text-sm font-medium text-zinc-200">
            자연 유입 점수 (각 팀의 데뷔 직후 {orgWindowLabel} 기준)
            {miiwanOrg && (
              <span class="ml-2 text-hint text-zinc-500">MiiWAN {miiwanOrg.score}점</span>
            )}
          </p>
          <p class="mb-2 text-hint text-zinc-400">
            <strong class="text-zinc-300">이 점수로 알 수 있는 것</strong> — 이 성장이
            광고로 산 것인지, 팬이 만들어준 것인지. 데뷔 직후 영상들이 유료 광고로
            밀린 것처럼 보이는지 하나씩 판정해 100점 만점으로 평균 낸 값이고,
            높을수록 광고 없이 사람들이 스스로 찾아왔다는 뜻이다.
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
                {o.reference && <span class="text-hint text-zinc-600">참고용</span>}
              </div>
            ))}
          </div>
          <p class="mt-2 text-hint text-zinc-500">
            {ORG_AD_SUSPECT_THRESHOLD}점 미만이면 위 표의 성장배수 옆에 &lsquo;광고 영향
            의심&rsquo;을 붙인다. MiiWAN이 지금까지 지나온 기간({orgWindowLabel})까지만
            세서 비교한다 — 먼저 데뷔한 팀만 더 긴 기간을 쓰면 공정하지 않기
            때문이다. 아래 &lsquo;코호트 유기성 비교&rsquo;는 데뷔 직후가 아니라 최근
            기간을 보는 것이라 숫자가 다를 수 있다.
          </p>
        </div>
      )}

      {/* ⑤ 방법론 각주 — "이 비교 어떻게 만든 거냐"에 화면만으로 답하기 */}
      <div class="space-y-1.5">
        <p class="text-hint text-zinc-500 leading-relaxed">
          어떻게 계산했나: 팀마다 데뷔한 날이 다르므로 각 팀의 데뷔일을 똑같이 0일로
          맞춘 뒤, 데뷔 후 같은 날짜끼리 비교한다. 그래프는 데뷔일 값을 100으로 놓고
          그린 성장 폭, 성장배수는 D+{data.as_of_day} 값 ÷ 데뷔일 값이다
          (데뷔일 값은 데뷔일({baseTol}), 지금 값은 D+{data.as_of_day}({atTol}) 안에서
          가장 가까운 날의 측정값). 비교 대상은 비슷한 시기에 데뷔한 K-POP 버추얼
          {" "}{cohortCandidates}팀(MiiWAN 포함) 중 {METRIC_LABELS[metric] ?? metric} 지표에서
          데뷔일 값이 확보된 {sc?.cohort_size ?? 0}팀이다. PLAVE는 체급이 달라 순위에서
          빼고 참고용으로만 그래프에 점선으로 넣었다.
          {" "}<span class="text-zinc-400">est</span> 배지 = 나중에 되짚어 채운 추정치라
          모양은 믿되 절대값은 참고만 한다. 데이터가 없는 팀은 숫자를 만들어 채우지 않고
          비교에서 뺀다
          {data.excluded.length > 0 && <> (현재 {data.excluded.length}건 제외)</>}.
        </p>
        {/* 제외 상세는 hover title 이 아니라 접이식 — 모바일·키보드에서도
            "무엇이 왜 빠졌는지" 확인할 수 있어야 한다. */}
        {data.excluded.length > 0 && (
          <details class="text-hint text-zinc-500">
            <summary class="cursor-pointer text-zinc-400 hover:text-zinc-200">
              비교에서 뺀 항목 {data.excluded.length}건 보기
            </summary>
            <ul class="mt-1 list-disc space-y-0.5 pl-5">
              {data.excluded.map((e) => (
                <li key={`${e.group_key}:${e.metric}:${e.reason}`}>
                  {data.groups[e.group_key]?.name ?? e.group_key}
                  {" / "}{METRIC_LABELS[e.metric] ?? e.metric}
                  {" — "}{EXCLUDED_REASONS[e.reason] ?? e.reason}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
