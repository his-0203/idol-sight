// frontend/src/components/MiiWANCohortReport.tsx
//
// 동시기 성과 — 같은 시기에 데뷔한 팀들과의 비교 (투자사 보고 서사).
// 구조: ① 결론 헤드라인(스코어카드에서 자동 산출, 하드코딩 금지)
//      ② 성장곡선(데뷔일=100) ③ 스코어카드 표 ④ 성장의 질 산점도
//      ⑤ 자연 유입 점수 ⑥ 방법론 각주.
// 열세 지표도 숨기지 않는다 — 가짜 없는 보고가 전제.
//
// 배수 하나로 서열이 만들어지는 걸 세 군데서 막는다: 표의 '출발선' 컬럼
// (저베이스일수록 배수가 구조적으로 커진다) · 곡선의 흐린 선(광고 의심)
// · 산점도(속도와 자연 유입을 분리한 2축). 셋 다 같은 임계 상수를 쓴다.
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
import { colorOf, fillOf } from "../design/groups";
import { EmptyState } from "./EmptyState";
import { EstBadge } from "./EstBadge";
// 헤드라인 문구·임계값은 순수 로직이라 lib 로 뺐다 (테스트: tests/lib/cohortHeadline.test.ts).
import {
  AD_SUSPECT_METRICS, METRIC_LABELS, ORG_AD_SUSPECT_THRESHOLD,
  fmtMultiple, headline, type CohortData, type CurvePoint, type OrgRowScored,
} from "../lib/cohortHeadline";
// 산점도 데이터 준비도 순수 로직 (테스트: tests/lib/cohortQuality.test.ts).
import { QUALITY_METRIC, buildQualityScatter } from "../lib/cohortQuality";

// 광고 의심 라인의 투명도 — 참조선(PLAVE)이 이미 점선을 쓰고 있어
// "의심"에 점선을 또 쓰면 두 인코딩이 겹쳐 읽힌다. 의심 = 흐림 + ⚠,
// 참조 = 점선으로 채널을 분리한다.
const SUSPECT_LINE_ALPHA = 0.45;
const SUSPECT_MARK = " ⚠";

/**
 * excluded.reason → 화면 문구. 사유별로 운영 대응이 달라 뭉뚱그리지 않는다.
 * (그룹,지표)당 사유는 최대 1건이고, 앞의 둘은 "표의 배수도 못 냈다",
 * 뒤의 둘은 "배수는 남았고 곡선만 빠졌다"를 뜻한다 — 이 구분이 지켜져야
 * 곡선-side 문구의 "표의 배수는 남는다"가 항상 참이 된다.
 */
const EXCLUDED_REASONS: Record<string, string> = {
  no_data_in_window: "비교 구간에 측정값이 아예 없음",
  no_d0_baseline: "데뷔일 시점 값이 없어 배수를 낼 수 없음",
  no_at_day_value: "비교 시점에 아직 도달하지 않았거나 그 구간 측정값이 없음",
  no_measured_d0_baseline:
    "데뷔일 시점 실측값이 없음 (곡선만 제외 — 표의 배수는 추정값으로 남음)",
  empty_window: "데뷔일 값은 있으나 비교 구간에 측정값이 없음 (곡선만 제외)",
};

/** 구독 효율(subs/1k뷰) 표기. 소수 1자리 — 0.3~3 대역을 구분해 보여야 한다. */
function fmtEfficiency(v: number | null): string {
  return v == null ? "—" : (Math.round(v * 10) / 10).toFixed(1);
}

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
  // 산점도는 지표 탭과 독립적인 별도 차트라 인스턴스를 따로 들고 있는다.
  const qCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const qChartRef = useRef<Chart | null>(null);

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
    // 곡선은 출발선이 작은 팀을 압승처럼 그린다. 표의 배지는 표까지 내려와야
    // 읽히므로, 첫인상을 만드는 곡선 자체에 같은 신호를 얹는다 — 배지와
    // 동일 스코프(유튜브 지표 한정 · 점수 없는 팀은 손대지 않음).
    const adScope = AD_SUSPECT_METRICS.has(metric);
    const orgScore = new Map(
      data.organicity.filter((o) => o.score != null).map((o) => [o.group_key, o.score!]),
    );
    const isSuspect = (gk: string): boolean => {
      const s = orgScore.get(gk);
      return adScope && s != null && s < ORG_AD_SUSPECT_THRESHOLD;
    };
    // 툴팁이 라벨만 보고 판단할 수 있게 의심 계열 라벨을 모아둔다
    // (dataset.label 에는 ⚠ 만 붙고 "왜"는 툴팁에서 풀어 쓴다).
    const suspectLabels = new Set<string>();
    const preDebut = data.windows?.pre_debut;

    // 곡선이 데뷔 전 구간까지 그려지므로 "어디가 데뷔일인가"가 한눈에
    // 보여야 한다 — 성장배수·순위는 여전히 이 세로선의 값이 기준이다.
    // 산점도 가이드라인과 같은 인라인 플러그인 패턴.
    const debutMark = {
      id: "cohortDebutMark",
      beforeDatasetsDraw(chart: Chart) {
        const { ctx, chartArea: a, scales } = chart;
        if (!a || !scales.x) return;
        const x0 = scales.x.getPixelForValue(0);
        if (!(x0 >= a.left && x0 <= a.right)) return;
        ctx.save();
        // 데뷔 전 구간은 아주 옅은 음영만 — 선+라벨이 주인공이라 음영이
        // 눈에 띄면 곡선을 읽는 데 방해가 된다.
        if (x0 > a.left) {
          ctx.fillStyle = "rgba(113,113,122,0.07)"; // zinc-500 / very low
          ctx.fillRect(a.left, a.top, x0 - a.left, a.bottom - a.top);
        }
        ctx.beginPath();
        ctx.moveTo(x0, a.top);
        ctx.lineTo(x0, a.bottom);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "rgba(245,158,11,0.55)"; // amber-500
        ctx.stroke();
        ctx.fillStyle = "rgba(245,158,11,0.9)";
        ctx.font = "11px sans-serif";
        ctx.textAlign = x0 > a.right - 32 ? "right" : "left";
        ctx.textBaseline = "top";
        ctx.fillText("데뷔", x0 + (x0 > a.right - 32 ? -4 : 4), a.top + 2);
        ctx.restore();
      },
    };
    chartRef.current = new Chart(canvas, {
      type: "line",
      data: {
        datasets: entries.map(([gk, pts]) => {
          const ref = data.groups[gk]?.reference;
          const isMine = gk === "miiwan";
          const suspect = isSuspect(gk);
          const label = (data.groups[gk]?.name ?? gk)
            + (ref ? " (참조)" : "") + (suspect ? SUSPECT_MARK : "");
          if (suspect) suspectLabels.add(label);
          return {
            label,
            data: pts.map((p) => ({ x: p.day, y: p.index })),
            borderColor: suspect ? fillOf(gk, SUSPECT_LINE_ALPHA) : colorOf(gk),
            backgroundColor: suspect ? fillOf(gk, SUSPECT_LINE_ALPHA) : colorOf(gk),
            borderWidth: isMine ? 3 : 1.5,
            // 점선은 참조선 전용 — 의심은 투명도로만 표현해 두 인코딩을 분리.
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
            // 축 제목의 데뷔 전 구간도 응답 상수에서 — 숫자를 손으로 적으면
            // 백엔드 상수를 바꿨을 때 축만 옛 값으로 남는다.
            title: {
              display: true,
              text: preDebut == null
                ? "데뷔일 기준 며칠"
                : `데뷔일 기준 며칠 (D-${preDebut} ~ D+${data.as_of_day})`,
            },
            // 곡선이 데뷔 전 구간부터 그려져 x 는 음수에서 시작한다.
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
              label: (item) => {
                const l = item.dataset.label ?? "";
                return `${l}: ${item.parsed.y}`
                  + (suspectLabels.has(l) ? " (광고 영향 의심)" : "");
              },
            },
          },
        },
      },
      plugins: [debutMark],
    });
    return () => { chartRef.current?.destroy(); chartRef.current = null; };
  }, [data, metric, hasCurves]);

  // ④ 성장의 질 산점도. 지표 탭과 무관하게 항상 구독자 기준(QUALITY_METRIC)
  // 이라 탭 전환에 다시 그리지 않는다 — deps 는 data 뿐.
  useEffect(() => {
    qChartRef.current?.destroy();
    qChartRef.current = null;
    const canvas = qCanvasRef.current;
    if (!canvas || !data) return;
    const s = buildQualityScatter(data);
    if (!s.points.length) return;

    // 가이드라인 두 개(자연 유입 임계 · 성장배수 중앙값)를 캔버스에 직접
    // 그린다. annotation 플러그인을 새로 들이는 대신 인라인 플러그인 —
    // 선의 의미는 축 옆 소형 라벨로만 적고, 사분면 해석은 아래 캡션에서
    // 문장으로 푼다(캔버스 텍스트는 좁은 화면에서 넘친다).
    const guides = {
      id: "cohortQualityGuides",
      afterDatasetsDraw(chart: Chart) {
        const { ctx, chartArea: a, scales } = chart;
        if (!a || !scales.x || !scales.y) return;
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(148,163,184,0.35)";
        ctx.fillStyle = "rgba(148,163,184,0.65)";
        ctx.font = "11px sans-serif";

        const yPix = scales.y.getPixelForValue(s.threshold);
        if (yPix >= a.top && yPix <= a.bottom) {
          ctx.beginPath();
          ctx.moveTo(a.left, yPix);
          ctx.lineTo(a.right, yPix);
          ctx.stroke();
          ctx.textAlign = "left";
          ctx.textBaseline = "bottom";
          ctx.fillText(`자연 유입 ${s.threshold}점`, a.left + 4, yPix - 3);
        }
        if (s.medianGrowth != null) {
          const xPix = scales.x.getPixelForValue(s.medianGrowth);
          if (xPix >= a.left && xPix <= a.right) {
            ctx.beginPath();
            ctx.moveTo(xPix, a.top);
            ctx.lineTo(xPix, a.bottom);
            ctx.stroke();
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            ctx.fillText(`중앙값 ${fmtMultiple(s.medianGrowth)}`, xPix, a.top + 2);
          }
        }
        ctx.restore();
      },
    };

    qChartRef.current = new Chart(canvas, {
      type: "bubble",
      data: {
        // 그룹당 한 데이터셋 — 범례에서 팀별로 켜고 끌 수 있고, 색·채움
        // (참조는 hollow)을 데이터셋 단위로 줄 수 있다.
        datasets: s.points.map((p) => ({
          label: p.name + (p.reference ? " (참조)" : ""),
          data: [{ x: p.growth, y: p.organic, r: p.radius }],
          // 참조(PLAVE)는 체급이 달라 순위·중앙값에서 빠진다 — 속이 빈 원으로
          // "같이 재는 대상이 아님"을 형태로 구분한다.
          backgroundColor: p.reference
            ? "transparent"
            : fillOf(p.group_key, p.group_key === "miiwan" ? 0.75 : 0.45),
          borderColor: colorOf(p.group_key),
          borderWidth: p.group_key === "miiwan" ? 3 : 2,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            title: { display: true, text: "성장배수 (데뷔일 대비 몇 배)" },
            ticks: { callback: (v) => fmtMultiple(Number(v)) },
          },
          y: {
            title: { display: true, text: "자연 유입 점수" },
            suggestedMin: 0, suggestedMax: 100,
          },
        },
        plugins: {
          tooltip: {
            callbacks: {
              label: (item) => {
                const p = s.points[item.datasetIndex];
                if (!p) return item.dataset.label ?? "";
                return `${p.name}: ${fmtMultiple(p.growth)} · 자연 유입 ${p.organic}점`
                  + ` · 구독자 ${fmt(p.scale)}`;
              },
            },
          },
        },
      },
      plugins: [guides],
    });
    return () => { qChartRef.current?.destroy(); qChartRef.current = null; };
  }, [data]);

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
  // 구독 효율은 조회수 대비 구독자라 구독자 탭에서만 뜻이 통한다.
  const showEfficiency = metric === "yt_subscribers";
  // 산점도는 캔버스(useEffect)와 캡션(아래 JSX)이 같은 결과를 봐야 한다 —
  // 제외 목록·중앙값을 두 곳에서 따로 계산하면 화면이 자기모순에 빠진다.
  const quality = buildQualityScatter(data);
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
  // 곡선이 그리는 데뷔 전 구간. 응답에 없으면 숫자를 지어내지 않고
  // "데뷔 전부터"로 뭉뚱그린다(측정 허용폭 표기와 같은 처리).
  const preDebutDays = data.windows?.pre_debut;
  const preDebutLabel = preDebutDays == null
    ? "데뷔 전부터" : `데뷔 ${preDebutDays}일 전부터`;

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
        {/* 데뷔 전 구간을 왜 같이 그리는지 — 미완이는 데뷔 전부터 팬덤을
            쌓아온 팀이라 이 구간이 곧 "출발선이 큰 이유"의 근거다. */}
        <p class="mb-2 text-hint text-zinc-500">
          곡선은 {preDebutLabel} 표시한다 — 데뷔 전 구간(옅은 배경)이 가파른
          팀은 데뷔 시점에 이미 팬이 모여 있었다는 뜻이다. 성장배수와 순위는
          지금도 <strong class="text-zinc-300">데뷔일(세로선)</strong> 값이 기준이라
          이 표시 범위 변경에 영향을 받지 않는다. 곡선은 실제로 측정된 점만
          잇는다 — 측정이 주 1회였던 팀은 점 사이가 직선으로 보이며, 그 사이를
          메운 추정값은 그리지 않는다(없던 급등이 그려지는 것을 막는다).
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
        {/* 흐린 선의 뜻은 곡선 바로 아래서 밝힌다 — 표까지 내려가야 알 수
            있으면 첫인상은 이미 굳는다. 뉴스 탭에는 적용되지 않으므로
            캡션도 유튜브 지표에서만 보인다(배지와 같은 스코프). */}
        {hasCurves && adSuspectMetric && (
          <p class="mt-2 text-hint text-zinc-500">
            흐린 선 ⚠ = 자연 유입 점수가 {ORG_AD_SUSPECT_THRESHOLD}점 미만이라
            광고 효과가 섞여 있을 수 있는 팀. 점선은 참고용(PLAVE)이라는 뜻으로
            의미가 다르다.
          </p>
        )}
      </div>

      {/* ③ 동시기 스코어카드 */}
      {sc && (
        <div class="overflow-x-auto rounded-lg border border-zinc-800">
          <p class="px-3 py-2 text-hint text-zinc-400 border-b border-zinc-800/60">
            <strong class="text-zinc-300">이 표로 알 수 있는 것</strong> — 같은 시기에
            데뷔한 팀들 사이에서 우리가 몇 번째로 크게 늘었는지. 성장을 데뷔 전
            ({preDebutLabel} 데뷔일까지)과 데뷔 후(데뷔일 → D+{data.as_of_day})로
            나눠 적었다 — 같은 출발선이라도 그 값이 데뷔 전에 쌓인 것인지 데뷔
            직전에 채워진 것인지가 다르기 때문이다.
          </p>
          <table class="w-full min-w-[860px] text-sm tabular-nums">
            <thead class="bg-zinc-900/60 text-xs uppercase tracking-wider text-zinc-500">
              <tr>
                <th scope="col" class="px-3 py-2 text-left">그룹</th>
                <th scope="col" class="px-3 py-2 text-right">출발선 (데뷔일 값)</th>
                <th scope="col" class="px-3 py-2 text-right">D+{data.as_of_day} 시점 값</th>
                <th scope="col" class="px-3 py-2 text-right">데뷔 전 성장</th>
                <th scope="col" class="px-3 py-2 text-right">데뷔 후 성장</th>
                {/* 구독 효율은 "조회수 대비 구독자"라 구독자 탭에서만 뜻이 통한다. */}
                {showEfficiency && (
                  <th scope="col" class="px-3 py-2 text-right">데뷔 전 구독 효율</th>
                )}
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
                      {/* 출발선 = 성장배수의 분모. 이 칸이 없으면 "왜 우리 배수가
                          작은가"에 표가 답하지 못하고, 배수 순위가 곧 실력 순위로
                          읽힌다. 측정일은 옆 칸(기준 D+N)에 이미 병기돼 있다. */}
                      <td class="px-3 py-2 text-right text-zinc-400">
                        {r.base_value == null ? "—" : fmt(r.base_value)}
                        <EstBadge source={r.base_source} />
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
                      {/* 데뷔 전 / 데뷔 후를 나눠 놓으면 "출발선이 크다"가
                          데뷔 전에 쌓인 것인지 데뷔 직전에 채워진 것인지
                          보인다. 정렬 기준은 종전대로 데뷔 후 성장. */}
                      <td class="px-3 py-2 text-right text-zinc-400">
                        {fmtMultiple(r.pre_multiple)}
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
                      {/* 수치만 — 임계선·판정 플래그를 두지 않는다. 읽는 법은
                          아래 캡션이 설명하고 판단은 읽는 사람 몫이다. */}
                      {showEfficiency && (
                        <td class="px-3 py-2 text-right text-zinc-400">
                          {fmtEfficiency(r.subs_per_1k_pre)}
                          {r.subs_per_1k_post != null && (
                            <div class="text-hint text-zinc-600">
                              데뷔 후 {fmtEfficiency(r.subs_per_1k_post)}
                            </div>
                          )}
                        </td>
                      )}
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
          {/* 저베이스 왜곡 해명 — 배수 순위가 곧 실력 순위로 읽히는 걸 막는다. */}
          <p class="px-3 py-2 text-hint text-zinc-500 border-t border-zinc-800/60">
            <strong class="text-zinc-300">출발선을 같이 볼 것</strong> — 출발선이 클수록
            배수는 구조적으로 작게 나온다. 1천에서 2천이 되면 2.0×지만, 30만에서
            32만이 되면 1.1×다. 늘어난 사람 수는 뒤가 훨씬 많은데도 배수는 앞이 크다.
          </p>
          {/* 수치만 놓고 읽는 법을 준다 — 특정 팀을 지목하거나 판정하지 않는다. */}
          {showEfficiency && (
            <p class="px-3 py-2 text-hint text-zinc-500 border-t border-zinc-800/60">
              <strong class="text-zinc-300">구독 효율</strong> = 조회수 1,000회당 늘어난
              구독자. 정상 구간은 어느 팀이든 0.3~3 수준이고, 이보다 크게 높으면 영상
              노출 없이 구독자가 늘었다는 뜻이라 유료 캠페인 가능성을 시사한다.
              구독자·조회수가 같은 날 함께 측정된 실측값끼리만 비교했고, 한쪽이
              비면 &mdash; 로 둔다.
            </p>
          )}
        </div>
      )}

      {/* ④ 성장의 질 — 속도(x)와 자연 유입(y)을 분리한 2축. 곡선·표가 배수
          하나로 만드는 서열을 여기서 풀어준다. 지표 탭과 무관하게 항상
          구독자 기준(QUALITY_METRIC)이라 축 라벨에 그걸 밝힌다. */}
      {quality.points.length > 0 && (
        <div class="card">
          <p class="mb-1 text-sm font-medium text-zinc-200">성장의 질</p>
          <p class="mb-2 text-hint text-zinc-400">
            <strong class="text-zinc-300">이 그림으로 알 수 있는 것</strong> —
            오른쪽일수록 빠르게 컸고, 위쪽일수록 광고 없이 컸다. 원이 클수록 현재
            팬 규모가 크다. ({METRIC_LABELS[QUALITY_METRIC] ?? QUALITY_METRIC} 기준)
          </p>
          <div style={{ height: "320px" }}>
            <canvas ref={qCanvasRef} />
          </div>
          <p class="mt-2 text-hint text-zinc-500 leading-relaxed">
            가로 점선은 자연 유입 {quality.threshold}점, 세로 점선은 같은 시기 데뷔
            팀들의 성장배수 중앙값
            {quality.medianGrowth != null && <> ({fmtMultiple(quality.medianGrowth)})</>}.
            {" "}오른쪽 아래에 있는 팀은 빠르게 컸지만 자연 유입 점수가 낮아 광고
            효과가 섞여 있을 수 있고, 위쪽에 있는 팀은 속도가 느려도 광고 없이 팬이
            모인 쪽이다. 속이 빈 원은 참고용(PLAVE)이라 순위·중앙값에서 뺐다.
          </p>
          {/* 값이 없는 팀을 조용히 지우면 "코호트가 원래 이만큼"으로 읽힌다 —
              누가 왜 빠졌는지 함께 밝힌다(가짜 없음 · 열세 숨김 금지). */}
          {quality.excluded.length > 0 && (
            <p class="mt-1 text-hint text-zinc-500">
              표시 제외: {quality.excluded.map((e) => `${e.name} (${e.reason})`).join(" · ")}
            </p>
          )}
        </div>
      )}

      {/* ⑤ 자연 유입 점수(유기성) — 데뷔 직후 구간 한정(미완이 경과일이 도달한
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
            자연 유입 점수 ({orgWindowLabel} 기준)
            {miiwanOrg && (
              <span class="ml-2 text-hint text-zinc-500">MiiWAN {miiwanOrg.score}점</span>
            )}
          </p>
          <p class="mb-2 text-hint text-zinc-400">
            <strong class="text-zinc-300">이 점수로 알 수 있는 것</strong> — 이 성장에
            광고가 얼마나 섞여 있는지. 데뷔 전후 영상들이 유료 광고로 밀린 것처럼
            보이는지 하나씩 판정해 100점 만점으로 평균 낸 값이고, 높을수록 광고
            없이 사람들이 스스로 찾아왔다는 뜻이다. 창이 데뷔 전까지 걸쳐 있는
            이유는 유료 캠페인이 주로 데뷔 직전에 집행되기 때문이다.
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
                {/* 편수 기준(막대)과 조회수 기준을 나란히 — 둘이 벌어지는
                    정도 자체가 신호라 한쪽만 보여주면 안 된다. */}
                <span class="w-24 text-right text-hint text-zinc-600"
                      title="같은 기간을 조회수로 가중해 낸 점수 (막대는 영상 편수 기준)">
                  {o.score_view_weighted == null
                    ? "조회수 기준 —"
                    : `조회수 기준 ${o.score_view_weighted}점`}
                </span>
                {o.reference && <span class="text-hint text-zinc-600">참고용</span>}
              </div>
            ))}
          </div>
          <p class="mt-2 text-hint text-zinc-500">
            막대는 영상 <strong class="text-zinc-300">편수</strong> 기준, 옆의 값은
            같은 기간을 <strong class="text-zinc-300">조회수</strong>로 가중한 점수다.
            두 값의 차이가 크면 조회수가 소수의 광고성 영상에 쏠려 있다는 뜻이다.
            {" "}{ORG_AD_SUSPECT_THRESHOLD}점 미만이면 위 표의 성장배수 옆에 &lsquo;광고 영향
            의심&rsquo;을 붙인다. MiiWAN이 지금까지 지나온 기간({orgWindowLabel})까지만
            세서 비교한다 — 먼저 데뷔한 팀만 더 긴 기간을 쓰면 공정하지 않기
            때문이다. 아래 &lsquo;코호트 유기성 비교&rsquo;는 이 창이 아니라 최근
            기간을 보는 것이라 숫자가 다를 수 있다.
          </p>
        </div>
      )}

      {/* ⑥ 방법론 각주 — "이 비교 어떻게 만든 거냐"에 화면만으로 답하기 */}
      <div class="space-y-1.5">
        <p class="text-hint text-zinc-500 leading-relaxed">
          어떻게 계산했나: 팀마다 데뷔한 날이 다르므로 각 팀의 데뷔일을 똑같이 0일로
          맞춘 뒤, 데뷔 후 같은 날짜끼리 비교한다. 그래프는 데뷔일 값을 100으로 놓고
          그린 성장 폭이고 {preDebutLabel} 그린다(데뷔 전 값은 100 아래에 깔린다 —
          수집이 없던 팀은 그냥 늦게 시작하며, 없는 날을 만들어 채우지 않는다).
          곡선에는 실측값만 쓰고 표의 배수는 추정값(est)까지 쓰므로, 실측 데뷔일
          값이 없는 팀은 곡선에서만 빠지고 표에는 배수가 남을 수 있다.
          성장배수는 D+{data.as_of_day} 값 ÷ 데뷔일 값이다
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
