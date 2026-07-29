// frontend/src/components/MiiWANCohortReport.tsx
//
// 동시기 성과 — 같은 시기에 데뷔한 팀들과의 비교 (투자사 보고 서사).
//
// 구조는 **포괄 → 세부** 피라미드다. 위로 갈수록 결론, 아래로 갈수록 근거:
//   ① 결론 헤드라인 (한 줄 결론 → 강·약점 → 자연 유입 위치)
//   ② 성장의 질 산점도 — 속도×자연 유입×규모를 한 장에. 지표 탭 **밖**에
//      두어 "탭을 눌러도 안 바뀐다"는 혼란을 위치로 없앤다.
//   ③ 지표 탭 + 성장곡선 (시간 흐름)
//   ④ 스코어카드 표 (팀별 세부)
//   ⑤ 자연 유입 점수 (②의 세로축 해부 — 가장 깊은 드릴다운)
//   ⑥ 방법론 각주·제외 목록 (파인 프린트)
// 시각 위계도 같은 방향으로 내려간다 — ①은 강조 카드, ②~⑤는 통일된
// 소제목+리드(SECTION_TITLE / SECTION_LEAD) 아래 해석 블록(VerdictLines),
// 방법론성 각주와 ⑥은 접은 text-hint 소자(제외 목록만 기본 펼침).
// 열세 지표도 숨기지 않는다 — 가짜 없는 보고가 전제.
//
// 배수 하나로 서열이 만들어지는 걸 네 군데서 막는다: 표의 '출발선' 컬럼
// (저베이스일수록 배수가 구조적으로 커진다) · '데뷔 전/후 성장' 분리 ·
// 곡선의 흐린 선(광고 의심) · 산점도(속도와 자연 유입을 분리한 2축).
// 광고 의심 판정은 네 곳 모두 같은 숫자를 쓴다 — 편수·조회수 두 점수 중
// 낮은 쪽(adJudgeScore) 대 ORG_AD_SUSPECT_THRESHOLD.
//
// 카피 원칙: 읽는 사람은 투자사·경영진이지 데이터 담당자가 아니다.
// "코호트 / 유기성 / 인덱스 / 스냅샷 / 허용폭" 같은 내부 용어는 화면에
// 쓰지 않고 각각 "같은 시기에 데뷔한 팀들 / 자연 유입 점수 / 데뷔일=100
// 성장 폭 / 측정값 / 오차 범위"로 말한다. 정직성 장치(측정일 병기 · 제외
// 명시 · est 배지)는 문장만 쉬워질 뿐 그대로 남는다.
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import Chart from "chart.js/auto";
import { api } from "../api";
import { fmt } from "../format";
import { colorOf, fillOf } from "../design/groups";
import { EmptyState } from "./EmptyState";
import { EstBadge } from "./EstBadge";
// 자연 유입 점수 등급 경계·색 — organicity.ts 가 단일 원천(DebutWindow* 계열과 공유).
import { VERDICT_COLOR, VERDICT_THRESHOLDS, scoreColor } from "../lib/organicity";
// 헤드라인 문구·임계값은 순수 로직이라 lib 로 뺐다 (테스트: tests/lib/cohortHeadline.test.ts).
import {
  AD_SUSPECT_METRICS, EX_PAID_LABEL, METRIC_LABELS,
  METRIC_UNITS, ORG_ACTION_HINT, ORG_AD_SUSPECT_THRESHOLD, ORG_SCORE_GAP_CHIP,
  PRIMARY_METRIC,
  activityRows, activityVerdict,
  adJudgeScore, adScoreMap, cohortComposition, curveVerdict, debutDateRange,
  exPaidNote, fmtDelta, fmtMultiple, headline, nearTieKeys, nextReportCard,
  organicityVerdict, scorecardVerdict,
  type CohortData, type CurvePoint, type OrgRow, type SectionVerdict,
} from "../lib/cohortHeadline";
// 산점도 데이터 준비도 순수 로직 (테스트: tests/lib/cohortQuality.test.ts).
import {
  PRE_BASE_WINDOW, QUALITY_METRIC, buildQualityScatter, isLooseAnchor,
  qualityVerdict,
} from "../lib/cohortQuality";

// 광고 의심 라인의 투명도 — 참조선(PLAVE)이 이미 점선을 쓰고 있어
// "의심"에 점선을 또 쓰면 두 인코딩이 겹쳐 읽힌다. 의심 = 흐림 + 텍스트 칩,
// 참조 = 점선으로 채널을 분리한다.
const SUSPECT_LINE_ALPHA = 0.45;
// ⚠ 는 이 화면에서 이미 헤드라인 '보완할 것'과 로드 실패 상태가 쓰고 있다.
// 같은 글리프를 세 뜻으로 쓰면 아이콘이 뜻을 잃는다 — 곡선 범례는 글리프
// 대신 말로 적는다(범례 폭이 조금 늘 뿐, 뜻이 정확해진다).
// C8(07-30 투자 리뷰) 용어 통일 — 화면이 같은 것을 '광고 의심'·'광고 영향
// 의심'·'광고 과다' 세 이름으로 부르고 있었다. **표시(배지·곡선 라벨)는
// '광고 영향 의심' 하나**, **임계 지칭은 '광고 과다 기준선' 하나**로 모은다.
const SUSPECT_MARK = " (광고 영향 의심)";
/** 표시(배지·곡선 라벨)의 단일 명칭 — 각주가 배지를 지칭할 때도 이 말을 쓴다. */
const SUSPECT_LABEL = "광고 영향 의심";

/**
 * C7(07-30 투자 리뷰) — 응답에 windows.pre_debut 가 없을 때의 폴백. 예전엔
 * `preDebutDays ?? 30` 이 두 군데에 흩어져 있어 한쪽만 고치면 조용히 갈렸다.
 * 표 헤더처럼 "숫자를 안 쓰고 넘어갈 수 있는" 자리에서는 이 폴백을 쓰지
 * 않는다 — 없는 값을 지어내는 대신 그 절을 생략한다(측정 허용폭과 같은 처리).
 */
const PRE_DEBUT_FALLBACK = 30;

/**
 * C6(07-30 투자 리뷰) — 구독 효율 미니 바의 색. 그룹색으로 칠하면 "우리 팀
 * 색이 길다 = 좋다"로 읽히는데, 이 컬럼의 헤더는 "낮을수록 자연스러움"이라
 * 방향이 정반대였다. 길수록 주의 신호가 되도록 주의색(amber)으로 통일한다 —
 * 새 의미 토큰이 아니라 이 화면이 이미 '보완할 점'·데뷔선에 쓰는 amber-500.
 */
const EFFICIENCY_BAR_COLOR = "#f59e0b";

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

/** 0~100 점수를 막대 위치(%)로. 범위를 벗어난 값은 잘라 붙인다. */
function clampPct(v: number): number {
  return Math.max(0, Math.min(100, v));
}

/** organicity 등급색 hex → rgba. 등급 밴드 배경은 원색이면 막대를 잡아먹는다. */
function hexAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** 등급 밴드 배경 — 경계·색 모두 organicity.ts 단일 원천에서 파생. */
const TIER_BAND_ALPHA = 0.10;
const T = VERDICT_THRESHOLDS;
const TIER_BAND_BG = `linear-gradient(to right, ${[
  [VERDICT_COLOR.likely_paid, 0, T.suspect],
  [VERDICT_COLOR.suspect, T.suspect, T.borderline],
  [VERDICT_COLOR.borderline, T.borderline, T.organic],
  [VERDICT_COLOR.organic, T.organic, T.organic_strong],
  [VERDICT_COLOR.organic_strong, T.organic_strong, 100],
].map(([c, from, to]) =>
  `${hexAlpha(c as string, TIER_BAND_ALPHA)} ${from}% ${to}%`).join(", ")})`;

// 시각 위계 3단 (07-30 피드백 "작은 텍스트가 너무 많고 위계가 없다"):
//   ① 섹션 제목  16px/600/zinc-200
//   ② 해석(잘함·보완·핵심 수치) 14px/zinc-200 + 좌측 보더로 시각 분리
//   ③ 보조(리드·각주·소자 수치) 11px(text-hint)/zinc-400~600
// 예전엔 ①이 14px/500/zinc-200, ②가 14px/zinc-300 이라 크기·굵기·색이 거의
// 같아 눈이 줄을 세우지 못했다. 새 색·새 토큰은 도입하지 않고 기존 zinc
// 스케일과 tailwind.config 의 의미 스케일(hint/data/body) 안에서만 벌린다.
const SECTION_TITLE = "text-base font-semibold text-zinc-200";
const SECTION_LEAD = "mb-2 text-hint text-zinc-400";
const CHIP = "rounded bg-zinc-800/60 px-1.5 py-[1px] text-[11px] text-zinc-400";
/** 접은 각주의 여는 손잡이 — 방법론성 설명은 전부 이 형태로 통일한다. */
const SUMMARY = "cursor-pointer text-zinc-400 hover:text-zinc-200";

/** 섹션별 MiiWAN 읽기 — 그림·표만으로는 자사 위치가 안 읽힌다는 피드백(07-29).
    문장은 전부 lib에서 데이터로 산출 — 결론 하드코딩 금지.
    좌측 보더 + 들여쓰기로 주변 각주(③)와 시각적으로 떼어 놓는다: 이 두 줄만
    읽어도 섹션 결론이 잡혀야 한다(07-30 피드백 "10초 스캔").
    extra = 같은 해석 위계로 붙는 섹션 고유 결론(자연 유입 섹션의 '광고 투입
    콘텐츠 제외' 점수·다음 액션). 해석 두 줄이 없어도 extra 만으로 블록을
    세운다 — 데이터가 있는데 그리지 않는 경로를 만들지 않기 위해서다.
    F1(07-30 R3 타이포 리뷰) — v.sub 는 바로 위 줄을 보강하는 **보조 한 줄**
    이라 같은 블록 안에 두되 위계를 한 단 내려(text-hint/zinc-500) 그린다.
    두 사실을 한 문장에 이어 붙이면(舊 상세표 weak) 둘이 같은 무게로 읽혔다.
    sub 를 안 내는 verdict 는 필드 자체가 없어 이 줄이 그려지지 않는다. */
function VerdictLines({ v, extra }: { v: SectionVerdict; extra?: ComponentChildren }) {
  if (!v.good && !v.weak && !v.sub && !extra) return null;
  return (
    <div class="my-3 space-y-1 border-l-2 border-zinc-700 pl-3 text-sm leading-relaxed">
      {v.good && (
        <p class="text-zinc-200">
          <strong class="text-emerald-400">잘하고 있는 점</strong>
          <span class="text-zinc-600"> — </span>{v.good}
        </p>
      )}
      {v.weak && (
        <p class="text-zinc-200">
          <strong class="text-amber-400">보완할 점</strong>
          <span class="text-zinc-600"> — </span>{v.weak}
        </p>
      )}
      {v.sub && <p class="text-hint text-zinc-500">{v.sub}</p>}
      {extra}
    </div>
  );
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

/**
 * 표 서브라인용 자연어 측정일. "기준 D-2" 는 내부 표기라 처음 보는 사람이
 * 읽지 못한다 — 축·툴팁처럼 공간이 좁은 곳에만 D± 를 남긴다.
 */
function measuredOn(day: number): string {
  if (day === 0) return "데뷔 당일 측정";
  return day < 0 ? `데뷔 ${-day}일 전 측정` : `데뷔 ${day}일 후 측정`;
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
    // 판정 점수는 편수·조회수 중 낮은 쪽(B1) — 표의 배지·산점도 y축과 같은
    // 숫자를 써야 세 화면이 같은 팀을 같은 이유로 가리킨다.
    const adScope = AD_SUSPECT_METRICS.has(metric);
    const orgScore = adScoreMap(data);
    const isSuspect = (gk: string): boolean => {
      const s = orgScore.get(gk);
      return adScope && s != null && s < ORG_AD_SUSPECT_THRESHOLD;
    };
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
          return {
            label,
            data: pts.map((p) => ({ x: p.day, y: p.index })),
            borderColor: suspect ? fillOf(gk, SUSPECT_LINE_ALPHA) : colorOf(gk),
            backgroundColor: suspect ? fillOf(gk, SUSPECT_LINE_ALPHA) : colorOf(gk),
            borderWidth: isMine ? 3 : 1.5,
            // 점선은 참조선 전용 — 의심은 투명도로만 표현해 두 인코딩을 분리.
            borderDash: ref ? [6, 4] : undefined,
            // 실측점을 상시 표시한다. 곡선이 실측만 잇기 때문에 점 사이는
            // 직선인데, 점이 안 보이면 그 직선이 "완만한 성장"으로 읽힌다.
            // 점이 드문 구간 = 측정이 드물었던 구간임을 호버 없이도 본다.
            pointRadius: isMine ? 3 : 2,
            pointHoverRadius: 5,
            tension: 0.25,
          };
        }),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        // 팀마다 측정일이 달라 index 모드는 서로 다른 날짜의 점을 한 툴팁에
        // 묶어 보여준다("D+12" 제목 아래 실은 D+9·D+14 값이 섞임). nearest
        // 로 커서에 가장 가까운 실측점 하나만 정확히 집는다.
        interaction: { mode: "nearest", axis: "x", intersect: false },
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
              // nearest 라 items 는 실측점 하나 — 그 점이 실제로 측정된
              // 날짜를 제목에 그대로 쓴다(커서 위치가 아니라 점의 날짜).
              title: (items) => {
                const x = items[0]?.parsed.x;
                return x == null ? "" : `${dayLabel(x)} 측정`;
              },
              // 라벨(dataset.label)에 이미 SUSPECT_MARK("(광고 영향 의심)")가
              // 들어 있으므로 툴팁에서 다시 붙이지 않는다 — 한 줄에 같은 말이
              // 두 번 나온다. (C8 이후 화면 표시 명칭은 '광고 영향 의심' 하나다.)
              // 절대값은 CurvePoint 에 없다 — 곡선은 인덱스 전용 계열이라
              // 여기서 표에 있는 값을 다시 끌어오면 두 출처가 어긋날 위험만
              // 커진다. 절대값은 표에서 읽는다.
              label: (item) => `${item.dataset.label ?? ""}: ${item.parsed.y}`,
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
            // B4 — 라벨 정합. 이 축만 '총'(데뷔 전 구간 포함)이고 표·헤드라인의
            // 배수는 데뷔 후라, 축 제목이 그 차이를 스스로 말해야 한다.
            title: { display: true, text: "총 성장 배수 (데뷔 전 포함, 데뷔 전 값 대비)" },
            ticks: { callback: (v) => fmtMultiple(Number(v)) },
          },
          y: {
            // 0~100 고정이면 전 팀이 60~80에 몰렸을 때 세로 차이가 안 보여
            // "다 비슷하다"로 읽힌다. 범위는 데이터에 맞추되 임계선은 항상
            // 화면 안에 남도록 lib 에서 클램프한다.
            title: { display: true, text: "자연 유입 점수 (낮은 쪽 기준)" },
            min: s.yRange.min, max: s.yRange.max,
          },
        },
        plugins: {
          tooltip: {
            callbacks: {
              label: (item) => {
                const p = s.points[item.datasetIndex];
                if (!p) return item.dataset.label ?? "";
                const anchor = p.anchorDay < 0
                  ? `데뷔 ${-p.anchorDay}일 전 대비` : "데뷔일 대비(데뷔 전 측정 없음)";
                return `${p.name}: 총 ${fmtMultiple(p.growth)} (${anchor})`
                  + ` · 자연 유입 ${p.organic}점 · 구독자 ${fmt(p.scale)}`;
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
  // 판정 점수(편수·조회수 중 낮은 쪽) 오름/내림 정렬 — 막대가 그 순서로 선다.
  const orgRows: OrgRow[] = data.organicity
    .filter((o) => o.score != null)
    .sort((a, b) => (adJudgeScore(b) ?? 0) - (adJudgeScore(a) ?? 0));
  // 성장배수 ↔ 자연 유입 교차 검증용 조회표. 점수가 없는 그룹은 맵에 아예
  // 들어가지 않고, 없으면 배지도 달지 않는다 — 판정 근거 없이 "광고 의심"을
  // 씌우지 않는다(기존 "가짜 수치 없음"과 같은 원칙).
  const orgScoreOf = adScoreMap(data);
  const adSuspectMetric = AD_SUSPECT_METRICS.has(metric);
  // 구독 효율은 조회수 대비 구독자라 구독자 탭에서만 뜻이 통한다.
  const showEfficiency = metric === PRIMARY_METRIC;
  // 산점도는 캔버스(useEffect)와 캡션(아래 JSX)이 같은 결과를 봐야 한다 —
  // 제외 목록·중앙값을 두 곳에서 따로 계산하면 화면이 자기모순에 빠진다.
  const quality = buildQualityScatter(data);
  // 섹션별 잘함/보완 두 줄 — 전부 lib 함수 산출(컴포넌트는 조립·계산 안 함).
  const qVerdict = qualityVerdict(quality);
  const cVerdict = curveVerdict(data);
  const sVerdict = scorecardVerdict(data, metric);
  const oVerdict = organicityVerdict(data);
  // ⑤-b 데뷔 창 활동 — 표에 세울 행과 그 해석. 둘 다 lib 산출(같은 규칙).
  const actRows = activityRows(data);
  const aVerdict = activityVerdict(data);
  // "다음 보고까지" 카드 — 강점·보완은 위 섹션들이 쓰는 **같은 게이트**를
  // 재사용해 파생하고(문장만 카드용), 액션·산출물은 운영 약속 상수다.
  const nextCard = nextReportCard(data, { curve: cVerdict, organicity: oVerdict });
  const composition = cohortComposition(data, metric);
  const debutRange = debutDateRange(data);
  const nearTie = nearTieKeys(sc?.rows ?? []);
  const unitLabel = METRIC_UNITS[metric] ?? "";
  // R9 — 순위 대상(비참조)을 배수 내림차순으로 세우고 참조행은 그 아래로.
  const orderedRows = [...(sc?.rows ?? [])].sort((a, b) => {
    if (a.reference !== b.reference) return a.reference ? 1 : -1;
    return (b.growth_multiple ?? -1) - (a.growth_multiple ?? -1);
  });
  // B5 — 구독 효율 미니 바의 기준 = 코호트 최대값(상대 비교 전용).
  // 새 임계를 만들지 않는다 — 절대선을 그으면 데뷔 전 대역에서 전 팀이
  // 걸리거나 아무도 안 걸린다.
  const effMax = Math.max(
    0, ...(sc?.rows ?? []).map((r) => r.subs_per_1k_pre ?? 0),
  );
  // miiwan_rank == null 의 원인 구분: 미완이 자신의 기준값이 없어서인지
  // (그러면 cohort_size 는 피어만 센다) 피어가 없어서인지.
  const miiwanBaselineMissing =
    sc != null && sc.rows.find((r) => r.group_key === "miiwan")?.growth_multiple == null;
  const orgWindowLabel = data.organicity_window ?? "데뷔 창";
  // 유료 판정 제외 요약 — MiiWAN 행에서만 상시 노출(다른 팀은 표·마커로 충분).
  const miiwanExPaid = exPaidNote(data.organicity.find((o) => o.group_key === "miiwan"));
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
      {/* ① 결론 — 한 줄 결론 → 잘하고 있는 것 / 보완할 것 → 방법.
          수치·순위·문구 조합은 전부 headline() 자동 산출(하드코딩 금지). */}
      <div class="card border-l-4" style={{ borderLeftColor: accent }}>
        <p class="text-hint text-zinc-500">{head.lead}</p>
        {head.conclusion && (
          <p class="mt-1 text-base font-semibold leading-relaxed text-zinc-100">
            {head.conclusion}
          </p>
        )}
        {head.neutral && <p class="mt-1 text-hint text-zinc-400">{head.neutral}</p>}

        {/* H3 — 강점이 없어도 블록을 지우지 않는다. 빈 블록은 '숨김'으로 읽힌다. */}
        <div class="mt-3">
          <p class="text-sm font-medium text-zinc-200">✅ 잘하고 있는 것</p>
          {head.strengths.length > 0 ? (
            <ul class="mt-1 list-disc space-y-0.5 pl-5 text-sm text-zinc-300">
              {head.strengths.map((s) => <li key={s}>{s}</li>)}
            </ul>
          ) : (
            <p class="mt-1 pl-5 text-sm text-zinc-400">{head.strengthsEmpty}</p>
          )}
        </div>

        {head.weaknesses.length > 0 && (
          <div class="mt-3">
            <p class="text-sm font-medium text-zinc-200">⚠️ 보완할 것</p>
            <ul class="mt-1 list-disc space-y-0.5 pl-5 text-sm text-zinc-300">
              {head.weaknesses.map((w) => <li key={w}>{w}</li>)}
            </ul>
          </div>
        )}
      </div>

      {/* ② 성장의 질 — 속도(x)·자연 유입(y)·규모(원)를 한 장에 담은 가장
          포괄적인 뷰라 결론 바로 아래. 지표 탭 영역 **밖**에 있어 "탭을 눌러도
          안 바뀐다"는 혼란이 위치로 해소된다. */}
      {quality.points.length > 0 && (
        <div class="card">
          <div class="mb-1 flex flex-wrap items-center gap-2">
            <h3 class={SECTION_TITLE}>성장의 질</h3>
            <span class={CHIP}>{METRIC_LABELS[QUALITY_METRIC] ?? QUALITY_METRIC} 기준</span>
          </div>
          {/* F4 — 기준선이 40점(광고 과다 컷)으로 내려온 뒤로 "위 = 광고 없이
              컸다"는 organic(70점) 컷 이야기와 섞여 아래 막대 캡션("70점부터
              자연 유입 우세")과 모순됐다. 위쪽은 "과다 사용 정황이 없다"까지만.
              R11(07-30) — 리드는 축 세 개를 한 줄로만 말한다. 사분면 해석·
              참조 원 규칙 같은 읽는 법은 아래 접은 각주로 내렸다. */}
          <p class={SECTION_LEAD}>
            오른쪽일수록 빠르게 컸고, 위쪽일수록 광고 과다 사용 정황이 없으며,
            원이 클수록 현재 팬 규모가 크다.
          </p>
          <div style={{ height: "320px" }}>
            <canvas ref={qCanvasRef} />
          </div>
          {/* R5 — 자사 위치 서술(舊 scatterNote)은 Task 2에서 qualityVerdict로
              흡수됐고, 여기서 VerdictLines로 렌더한다. */}
          <VerdictLines v={qVerdict} />
          {/* 값이 없는 팀을 조용히 지우면 "코호트가 원래 이만큼"으로 읽힌다 —
              누가 왜 빠졌는지 함께 밝힌다(가짜 없음 · 열세 숨김 금지).
              M1 — 앵커가 "데뷔 약 N일 전"이라는 x축 전제에서 벗어난 팀(데뷔일
              폴백·D-21처럼 창 안쪽에서 잡힌 앵커·창보다 더 이른 앵커 전부)도
              같은 줄에서 실제로 쓴 날짜를 공시한다. isLooseAnchor()가 세 경우를
              하나의 규칙으로 판정한다(B3 — 배수를 키우는 이른 앵커도 포함).
              F1(07-30 타이포 리뷰) — 상시 공시가 접은 '읽는 법'보다 **먼저**
              온다. 접힌 손잡이가 위에 있으면 그 아래 공시문이 details 의 내용
              처럼 보여, 펼치지 않은 독자에게는 공시 자체가 없는 것처럼 읽혔다. */}
          {(quality.excluded.length > 0
            || quality.points.some((p) => isLooseAnchor(p.anchorDay, preDebutDays ?? PRE_DEBUT_FALLBACK))) && (
            <p class="mt-2 text-hint text-zinc-500 leading-relaxed">
              {quality.excluded.length > 0 && (
                <>표시 제외: {quality.excluded.map((e) => `${e.name} (${e.reason})`).join(" · ")}{" "}</>
              )}
              {quality.points
                .filter((p) => isLooseAnchor(p.anchorDay, preDebutDays ?? PRE_DEBUT_FALLBACK))
                .map((p) => p.anchorDay === 0
                  ? `${p.name}은(는) 데뷔 전 측정값이 없어 데뷔일 값 대비로 그렸다.`
                  : `${p.name}은(는) 데뷔 ${-p.anchorDay}일 전 값 대비로 그렸다`
                    + `(${preDebutDays ?? PRE_DEBUT_FALLBACK}일 전 측정이 없어).`)
                .join(" ")}
            </p>
          )}
          {/* R11 — 예전엔 여기 text-hint 문단이 셋 연속으로 붙어 있어 해석 두
              줄이 각주에 파묻혔다. 읽는 법(방법론)은 접는다. */}
          <details class="mt-1 text-hint text-zinc-500">
            <summary class={SUMMARY}>그래프 읽는 법</summary>
            <p class="mt-1 leading-relaxed">
              가로 점선은 자연 유입 {quality.threshold}점, 세로 점선은 같은 시기 데뷔
              팀들의 총 성장 배수(데뷔 전 포함) 중앙값
              {quality.medianGrowth != null && <> ({fmtMultiple(quality.medianGrowth)})</>}.
              {" "}오른쪽 아래 팀은 빠르게 컸지만 자연 유입 점수가 낮아 광고 효과가
              섞여 있을 수 있다. 속이 빈 원은 참고용(PLAVE)이라 순위·중앙값에서 뺐다.
              {" "}세로축은 편수·조회수 두 기준 중 낮은 점수이며, 자사를 포함한 전 팀에
              같은 기준을 적용한다.
            </p>
          </details>
        </div>
      )}

      {/* ③ 성장곡선(데뷔일=100) + 지표 pill 탭 — 시간 흐름(중간 층위). */}
      <div>
        <h3 class={SECTION_TITLE}>시간에 따른 성장</h3>
        {/* R2 — 곡선 캡션은 한 줄로. 세로선·배경의 뜻은 차트 위 칩과 각주에 있다. */}
        <p class={SECTION_LEAD}>
          각 팀의 데뷔일 값을 100으로 놓았을 때 누가 더 가파른지 (200이면 두 배).
        </p>
        <div role="tablist" aria-label="지표 선택"
             class="mb-2 flex overflow-x-auto gap-1 card p-1">
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
        {/* 점이 드문 구간이 "완만한 성장"으로 읽히지 않게 칩으로 먼저 알린다.
            리드에서 뺀 축 표기(세로선·옅은 배경)도 같은 칩 줄에 둔다 — 같은
            층위(범례)라 문단으로 따로 세우면 소자 문단만 늘어난다. */}
        <div class="mb-2 flex flex-wrap gap-2">
          <span class={CHIP}>점 = 실제 측정 시점 · 일부 팀은 주 1회 측정이라 직선 구간 있음</span>
          <span class={CHIP}>세로선 = 데뷔일 · 옅은 배경 = 데뷔 전 구간</span>
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
        {/* I2 — cVerdict 는 PRIMARY_METRIC(구독자) 고정 결론이라 조회수 탭에
            그대로 두면 라벨 없이 다른 지표의 판정문이 붙는다. 곡선이 없는
            지표에서는 EmptyState 아래에 결론만 남아 근거 없는 단정이 된다.
            둘 다 아닌 경우에만 낸다. */}
        {metric === PRIMARY_METRIC && hasCurves && <VerdictLines v={cVerdict} />}
        {/* D2(07-30 타이포 리뷰) — 비주력 탭에는 결론 두 줄이 없다. 아무 안내가
            없으면 "이 지표는 판정을 못 했다"로 읽히므로, 결론이 어디 있는지
            한 줄로 가리킨다(수치가 아닌 위치 안내라 정적 문구 허용). */}
        {metric !== PRIMARY_METRIC && hasCurves && (
          <p class="mt-2 text-hint text-zinc-500">
            성장 판정 문장은 대표 지표({METRIC_LABELS[PRIMARY_METRIC] ?? PRIMARY_METRIC})
            {" "}탭에 표시된다.
          </p>
        )}
        {/* R7 — 흐린 선의 뜻. ⚠ 글리프는 위 '보완할 것'과 겹치므로 말로 쓴다.
            D1(07-30 타이포 리뷰) — 방법론성 설명이라 다른 섹션과 같은 details
            패턴으로 접는다. 접어도 손잡이에 '흐린 선'이 남아 범례로 기능한다. */}
        {hasCurves && adSuspectMetric && (
          <details class="mt-2 text-hint text-zinc-500">
            <summary class={SUMMARY}>흐린 선 &lsquo;{SUSPECT_LABEL}&rsquo;의 뜻</summary>
            <p class="mt-1 leading-relaxed">
              자연 유입 점수가 {ORG_AD_SUSPECT_THRESHOLD}점 미만이라 광고 효과가 섞여
              있을 수 있는 팀. 점선은 참고용(PLAVE)이라는 뜻으로 의미가 다르다.
              곡선은 실제로 측정된 점만 잇고, 그 사이를 메운 추정값은 그리지 않는다.
            </p>
          </details>
        )}
      </div>

      {/* ④ 스코어카드 — 팀별 세부. */}
      {sc && (
        <div>
          <h3 class={SECTION_TITLE}>팀별 상세</h3>
          <p class={SECTION_LEAD}>
            우리가 몇 번째로 크게 늘었는지, 그 성장이 데뷔 전에 쌓인 것인지
            데뷔 후에 만든 것인지.
          </p>
          <VerdictLines v={sVerdict} />
          {/* C1 — 비교 대상 구성은 표 앞에 고정 노출(공시). 각주까지 내려가야
              알 수 있으면 "왜 4팀뿐이냐"는 질문이 먼저 나온다.
              R11(07-30) — 반면 '출발선 읽는 법'·'배지 범례'는 방법론이라
              접는다: 출발선 인과는 바로 위 '보완할 점'이 이미 한 줄로 말하고
              (같은 사실을 두 번 말하지 않는다), 배지 뜻은 표를 실제로 볼 때
              찾으면 되는 참조 정보다. */}
          <p class="mb-2 text-hint text-zinc-500">
            비교 대상: 같은 시기 데뷔 {composition.candidates}팀 중 데이터 확보
            {" "}{composition.withData}팀
            {composition.excluded > 0 && <> · 제외 {composition.excluded}팀(아래 사유)</>}
            {composition.referenceNames.length > 0 && (
              <> · 참고 {composition.referenceNames.length}팀
                ({composition.referenceNames.join(", ")}, 순위 제외)</>
            )}
          </p>
          <details class="mb-2 text-hint text-zinc-500">
            <summary class={SUMMARY}>표 읽는 법 · 배지 뜻</summary>
            <p class="mt-1 leading-relaxed">
              출발선이 클수록 배수는 구조적으로 작게 나온다 — 1천에서 2천이 되면
              2.0×지만 30만에서 32만이 되면 1.1×다. 늘어난 사람 수는 뒤가 훨씬 많다.
            </p>
            {/* E1 — 배지 뜻은 hover 없이 글자로. hover 는 모바일에 존재하지 않는다. */}
            <p class="mt-1 text-zinc-600">
              <span class="rounded bg-zinc-800/60 px-1 py-[1px] text-[10px] text-zinc-500">est</span>
              {" "}= 나중에 되짚어 채운 추정치(모양은 믿되 절대값은 참고) ·
              {" "}<span class="rounded bg-zinc-800/60 px-1 py-[1px] text-[10px] text-zinc-500">bf</span>
              {" "}= 검색 키워드 집계로 확인한 값 · 배지 없음 = 그날 직접 수집한 실측값
            </p>
          </details>
          <div class="overflow-x-auto rounded-lg border border-zinc-800">
          {/* M3 — 컬럼 7개(구독 효율 포함 시)라 900px에선 좁은 화면에서 셀이
              눌린다. 1000px로 여유를 둔다. */}
          <table class="w-full min-w-[1000px] text-sm tabular-nums">
            <thead class="bg-zinc-900/60 text-xs uppercase tracking-wider text-zinc-500">
              <tr>
                <th scope="col" class="px-3 py-2 text-left">그룹</th>
                {/* C7 — "30일 전"은 백엔드 PRE_DEBUT_DAYS 를 손으로 적은 값이라
                    상수를 바꾸면 이 헤더만 옛 값으로 남았다. 응답에서 파생하고,
                    없으면 숫자를 지어내지 않고 절을 생략한다. */}
                <th scope="col" class="px-3 py-2 text-right">
                  데뷔 전 값{preDebutDays != null && <> ({preDebutDays}일 전 기준)</>}
                </th>
                <th scope="col" class="px-3 py-2 text-right">출발선 (데뷔일 값)</th>
                <th scope="col" class="px-3 py-2 text-right">D+{data.as_of_day} 시점 값</th>
                <th scope="col" class="px-3 py-2 text-right">데뷔 전 성장 배수</th>
                <th scope="col" class="px-3 py-2 text-right">데뷔 후 성장 배수</th>
                {/* 구독 효율은 "조회수 대비 구독자"라 구독자 탭에서만 뜻이 통한다. */}
                {showEfficiency && (
                  <th scope="col" class="px-3 py-2 text-right">
                    구독 효율 (데뷔 전/후)
                    <div class="font-normal normal-case tracking-normal text-zinc-600">
                      낮을수록 자연스러움
                    </div>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {/* R9 — 참조행(PLAVE)은 순위 모수 밖이라 아래로 내린다. 같은 표
                  안에 섞여 있으면 "1위 PLAVE" 로 읽혀 순위가 통째로 오독된다. */}
              {orderedRows.flatMap((r, i) => {
                  const isMine = r.group_key === "miiwan";
                  const firstRef = r.reference && !orderedRows[i - 1]?.reference;
                  // 성장배수만 보면 "잘 컸네"로 읽히지만 광고비로도 만들 수
                  // 있는 숫자다. 판정 점수(편수·조회수 중 낮은 쪽)가 기준 아래면
                  // 배수 옆에서 바로 알린다. 점수가 없으면 배지도 없다.
                  const orgScore = orgScoreOf.get(r.group_key);
                  const adSuspect = adSuspectMetric
                    && r.growth_multiple != null
                    && orgScore != null
                    && orgScore < ORG_AD_SUSPECT_THRESHOLD;
                  const delta = r.value_at_day != null && r.base_value != null
                    ? fmtDelta(r.value_at_day - r.base_value, unitLabel) : null;
                  const effShare = effMax > 0 && r.subs_per_1k_pre != null
                    ? Math.max(0, Math.min(1, r.subs_per_1k_pre / effMax)) : null;
                  // 구분선 행과 데이터 행을 한 배열로 낸다 — Fragment 로 묶으면
                  // key 가 Fragment 에 붙어야 해서 목록 갱신 시 경고가 난다.
                  return [
                    firstRef ? (
                      <tr key="ref-divider">
                        <td colSpan={showEfficiency ? 7 : 6}
                            class="border-t-2 border-zinc-700 px-3 py-2 text-hint text-zinc-500">
                          아래는 순위에서 제외한 참고 사례 — 데뷔 시기·규모가 달라
                          같이 세지 않는다.
                        </td>
                      </tr>
                    ) : null,
                    <tr key={r.group_key}
                        class={"border-t border-zinc-800/60" + (isMine ? " bg-zinc-800/40" : "")}>
                      <td class="px-3 py-2" style={{ color: colorOf(r.group_key) }}>
                        {data.groups[r.group_key]?.name ?? r.group_key}
                        {/* C2 — 팀별 데뷔일. "같은 시기"의 실제 폭을 표에서 본다. */}
                        {data.groups[r.group_key]?.debut_date && (
                          <div class="text-hint text-zinc-600">
                            {data.groups[r.group_key]!.debut_date} 데뷔
                          </div>
                        )}
                      </td>
                      {/* 데뷔 전 값 = 데뷔 전 배수·총 성장의 출발점. D-30±7이 비면
                          확보된 가장 이른 데뷔 전 값을 쓰고 측정일을 그대로 밝힌다. */}
                      <td class="px-3 py-2 text-right text-zinc-400">
                        {r.pre_value == null ? "—" : fmt(r.pre_value)}
                        <EstBadge source={r.pre_source} />
                        {r.pre_day != null && (
                          <div class="text-hint text-zinc-600">{measuredOn(r.pre_day)}</div>
                        )}
                      </td>
                      {/* 출발선 = 성장배수의 분모. 이 칸이 없으면 "왜 우리 배수가
                          작은가"에 표가 답하지 못하고, 배수 순위가 곧 실력 순위로
                          읽힌다. */}
                      <td class="px-3 py-2 text-right text-zinc-400">
                        {r.base_value == null ? "—" : fmt(r.base_value)}
                        <EstBadge source={r.base_source} />
                        {/* R8 — "기준 D-2" 는 내부 표기다. 자연어로 쓴다. */}
                        {r.base_day != null && (
                          <div class="text-hint text-zinc-600">{measuredOn(r.base_day)}</div>
                        )}
                      </td>
                      <td class="px-3 py-2 text-right text-zinc-300">
                        <div>
                          {r.value_at_day == null ? "—" : fmt(r.value_at_day)}
                          <EstBadge source={r.source} />
                        </div>
                        {r.at_day != null && (
                          <div class="text-hint text-zinc-600">{measuredOn(r.at_day)}</div>
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
                        {/* E2 — 추정치가 낀 근소한 차이는 순서를 확정하지 않는다. */}
                        {nearTie.has(r.group_key) && (
                          <span class="ml-1 text-hint font-normal text-zinc-500"
                                title="이 차이는 추정 오차 안일 수 있어 순서를 확정하지 않는다">≈</span>
                        )}
                        {/* R8 — 배수 옆에 실제로 몇 명 늘었는지. */}
                        {delta && (
                          <div class="text-hint font-normal text-zinc-600">{delta}</div>
                        )}
                        {adSuspect && (
                          <div class="text-hint font-normal text-amber-500"
                               title={"데뷔 전후 영상 중 유료 광고로 판정된 비중이 높아, "
                                 + "이 성장에는 광고 효과가 섞여 있을 수 있음 "
                                 + `(판정 점수 ${orgScore}점 · 광고 과다 기준선 ${ORG_AD_SUSPECT_THRESHOLD}점 미만)`}>
                            {SUSPECT_LABEL}
                          </div>
                        )}
                      </td>
                      {/* B5 — 새 임계를 만들지 않고 코호트 내 상대 위치만 막대로.
                          수치가 주인공이고 막대는 눈이 줄을 세우는 것을 돕는다. */}
                      {showEfficiency && (
                        <td class="px-3 py-2 text-right text-zinc-400">
                          {fmtEfficiency(r.subs_per_1k_pre)}
                          {" / "}
                          <span class="text-zinc-500">{fmtEfficiency(r.subs_per_1k_post)}</span>
                          {/* C6 — 그룹색이 아니라 주의색. 길수록 "주의"라는
                              헤더("낮을수록 자연스러움")와 방향을 맞춘다. */}
                          {effShare != null && (
                            <div class="mt-1 ml-auto h-1 w-16 rounded bg-zinc-800">
                              <div class="h-1 rounded"
                                   style={{ width: `${Math.round(effShare * 100)}%`,
                                            background: EFFICIENCY_BAR_COLOR,
                                            opacity: r.group_key === "miiwan" ? 1 : 0.55 }} />
                            </div>
                          )}
                        </td>
                      )}
                    </tr>,
                  ];
                })}
            </tbody>
          </table>
          {/* C1(07-30 타이포 리뷰) — 표 아래에 같은 크기·같은 색의 소자 문단이
              셋 연속으로 붙어 있어 눈이 "어느 게 결론인지"를 못 골랐다. 이 줄만
              해석 위계(text-sm/zinc-300)로 올린다 — 표를 한 줄로 요약하는 문장
              이고, 나머지 둘(배지 읽는 법·효율 읽는 법)은 참조 정보다. */}
          <p class="px-3 py-2 text-sm leading-relaxed text-zinc-300 border-t border-zinc-800/60">
            {/* 비교 대상이 미완이 1팀뿐이면 "1위"는 자기 자신을 이긴 것이라
                의미가 없다 — 순위 대신 모수 부족을 명시한다(빈칸 금지). */}
            {sc.miiwan_rank != null && sc.cohort_size >= 2 ? (
              <>
                데뷔 후 성장 배수 기준 같은 시기 데뷔 {sc.cohort_size}팀 중 <strong style={{ color: accent }}>
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
          </p>
          {/* C1 — 측정 허용폭·≈ 표기는 방법론이라 승격된 순위 줄에서 떼어
              보조 위계로 되돌린다(같은 문단에 있으면 결론 한 줄이 다시 길어진다). */}
          <p class="px-3 py-2 text-hint text-zinc-500 border-t border-zinc-800/60">
            값은 데뷔일({baseTol}) / D+{data.as_of_day}({atTol}) 안에서 가장 가까운 날의
            측정값을 썼고, 줄마다 실제로 잰 날짜를 함께 적었다.
            {nearTie.size > 0 && (
              <> <strong class="text-zinc-400">≈</strong> 표시가 붙은 순위는 추정치가
              섞인 근소한 차이라 순서를 확정하지 않는다.</>
            )}
          </p>
          {/* 광고 의심 배지와 짝이 되는 각주 — 배지가 안 뜨는 지표·시점에도
              "배수는 돈으로도 만들 수 있다"는 읽는 법 자체를 남긴다. 07-30:
              같은 말을 세 절에 나눠 하던 문장을 한 문장으로 줄였다(판정 규칙의
              상세는 아래 자연 유입 섹션 캡션이 한 번만 말한다).
              C2(07-30 경영 리뷰) — 배지 임계는 "광고를 과하게 쓴 게 뚜렷한 팀"만
              가리키도록 캘리브레이션한 값이라, 배지가 없는 팀도 기준선 부근일 수
              있다. 그 자리에 아무 말이 없으면 "배지 없음 = 광고 영향 없음"으로
              읽힌다 — 배지 로직·티어는 그대로 두고 읽는 법만 봉합한다.
              F3(07-30 R3 투자 리뷰) — 뒤 절은 "**전 팀**의 판정 점수는 아래에서
              공개된다"는 정적 주장이었다. 유기성이 비거나(organicity_unavailable)
              일부 팀 점수가 없으면 그냥 거짓이 되고, 그걸 검증하는 코드도 없었다.
              아래 섹션이 실제로 그리는 행(orgRows)이 있을 때만 절을 낸다.
              G1(07-30 R3b 리뷰) — 단, **숫자는 세지 않는다**. orgRows 는 참조팀
              (PLAVE)까지 포함한 행 수라 "판정 점수가 있는 7팀"이 되는데, 같은
              화면의 판정 순위는 참조를 뺀 "6팀 중 4위"다 — 6 vs 7 이 한 화면에서
              충돌하고, "…있는 N팀" 어법이 순위 모수 어법과 겹쳐 이 각주가 순위
              모수를 다시 정의하는 것처럼 읽힌다. 여기서 할 말은 "어디를 보면
              된다"이지 모수 선언이 아니므로, 세기를 포기해 참조 포함/제외 논쟁
              자체를 없앤다(게이트는 유지 — 없는 섹션을 가리키지 않는다). */}
          <p class="px-3 py-2 text-hint text-zinc-500 border-t border-zinc-800/60">
            성장 배수는 광고비로도 만들 수 있는 숫자라, 판정 점수
            {" "}{ORG_AD_SUSPECT_THRESHOLD}점 미만인 팀에는 배수 옆에
            {" "}&lsquo;{SUSPECT_LABEL}&rsquo;을 붙이고 아래
            {" "}<strong class="text-zinc-300">자연 유입 점수</strong>와 같이 읽게 했다.
            {" "}배지가 없다고 광고 영향이 없다는 뜻은 아니다
            {orgRows.length > 0 && (
              <> — 각 팀의 판정 점수는 아래 자연 유입 점수에 실려 있다</>
            )}.
          </p>
          {/* S — 데뷔 전/후 대역이 다르다는 사실을 분리해 쓴다. 하나로 뭉치면
              "0.3~3 이 정상"과 실제 데뷔 전 수치(수십~수백)가 정면 충돌한다.
              접되 오독 방지 핵심("데뷔 전은 상대 비교")은 손잡이 문구에 남긴다. */}
          {showEfficiency && (
            <details class="px-3 py-2 text-hint text-zinc-500 border-t border-zinc-800/60">
              <summary class={SUMMARY}>
                구독 효율 읽는 법 — 데뷔 전 값은 절대값이 아니라 팀 간 상대 비교로
              </summary>
              <p class="mt-1 leading-relaxed">
                {/* C5(07-30 투자 리뷰) — "현재 전 팀이 이 범위 안에 있다"는
                    정적 주장이라 데이터가 바뀌면 조용히 거짓이 된다(그 사실을
                    검증하는 코드가 어디에도 없었다). 정상 구간 정의만 남긴다. */}
                조회수 1,000회당 늘어난 구독자. <strong class="text-zinc-300">데뷔 후</strong>
                {" "}정상 구간은 0.3~3이다.
                {" "}<strong class="text-zinc-300">데뷔 전</strong>은 조회수 자체가 적어
                비율이 수십~수백으로 뜨는 게 보통이라, 유독 높은 팀은 영상 노출 없이
                구독자가 늘었다는 뜻으로 읽는다. 구독자·조회수가 같은 날 함께 측정된
                실측값끼리만 비교했고, 한쪽이 비면 &mdash; 로 둔다.
              </p>
            </details>
          )}
          </div>
        </div>
      )}

      {/* ⑤ 자연 유입 점수 — 산점도 세로축의 상세 해부(가장 깊은 드릴다운). */}
      {data.organicity_unavailable && (
        <div class="card">
          <p class="text-hint text-zinc-500">
            자연 유입 점수를 불러오지 못했습니다 (일시 오류).
          </p>
        </div>
      )}
      {orgRows.length > 0 && (
        <div class="card">
          <div class="mb-1 flex flex-wrap items-center gap-2">
            <h3 class={SECTION_TITLE}>자연 유입 점수</h3>
            <span class={CHIP}>{orgWindowLabel} · 데뷔 창 기준</span>
          </div>
          <p class={SECTION_LEAD}>
            영상 하나하나가 광고로 밀린 것처럼 보이는지 자동 판정해 100점 만점으로
            평균 낸 값 — 높을수록 사람들이 스스로 찾아왔다는 뜻이다.
          </p>
          {/* 07-30 피드백 ③ — "광고 투입 콘텐츠 제외 N점"이 이 섹션에서
              '보완할 점' 다음으로 중요한 사실이다(자연 확장 콘텐츠만 보면
              점수가 잘 나온다는 뜻). 예전엔 hint 소자 문단으로 '보완할 점'
              위에 얹혀 있어 원인 설명처럼만 읽혔다. 이제 해석 블록 안으로
              들여 굵은 결론 한 줄(headline)로 세우고, 규모·앵커는 그 아래
              보조 각주(note)로 내린다. 문장은 전부 exPaidNote 가 만든다 —
              여기서 고정 문구를 덧붙이면 데이터에서 파생되지 않은 결론이
              모든 창에 그대로 실린다(제외 뒤 남은 조회수에도 의심 대역이
              섞여 있어 "나머지는 자연 소비"라고 단정할 수 없다). */}
          {/* A4(07-30 타이포 리뷰) — 이 결론의 강조색이 zinc-100 이면 바로 위
              '잘하고 있는 점/보완할 점'(zinc-200)보다 밝아 위계가 뒤집힌다.
              제외 점수는 해석 두 줄 **다음** 가는 값이므로 같은 zinc-200 굵기로. */}
          {/* A5(07-30 경영 리뷰) — 이 섹션은 "배제하기 어렵다"에서 끝나 다음
              행동이 없었다. 결정 지향 안내 한 줄을 보조 위계로 붙인다. 문구는
              lib 상수(WEAK_REMEDY 와 같은 성격) — 판정이 걸린 창에서만 낸다:
              보완할 점이 없는 창에 액션만 남으면 근거 없는 지시가 된다.
              R3(07-30 타이포 리뷰) — 예전엔 이 줄이 VerdictLines **밖**에 있어
              좌측 보더·들여쓰기가 끊겼고, 그 결과 '보완할 점'의 다음 행동이
              아니라 아래 막대의 캡션처럼 보였다. 같은 블록 안(extra)으로 넣어
              보완할 점 → 제외 점수 → 다음 액션이 한 묶음으로 읽히게 한다.
              R3 — exPaidNote 의 앵커 절(ⓒ)도 note(ⓐⓑ)와 줄을 나눈다: 쏠림
              설명의 꼬리처럼 붙어 있으면 "그래도 결론 점수는 판정 점수"라는
              가장 중요한 한 마디가 그냥 지나쳐진다. */}
          <VerdictLines v={oVerdict} extra={(miiwanExPaid || oVerdict.weak) && (
            <>
              {miiwanExPaid && (
                <p class="pt-1">
                  <strong class="text-zinc-200">{miiwanExPaid.headline}</strong>
                  <span class="block text-hint text-zinc-500">{miiwanExPaid.note}</span>
                  <span class="block text-hint text-zinc-400">{miiwanExPaid.anchor}</span>
                </p>
              )}
              {oVerdict.weak && (
                <p class="pt-1 text-hint text-zinc-400">{ORG_ACTION_HINT}</p>
              )}
            </>
          )} />
          {/* B2 — 편수 점수와 조회수 점수를 잇는 구간 막대. 두 기준이 갈리는
              폭 자체가 신호라 한 점으로 뭉개지 않는다. R10 — 진한 막대가 우리 팀. */}
          {/* 눈금 행 — 등급 경계를 축처럼 보여준다. 좌우 스페이서는 아래 행의
              이름/숫자/꼬리 컬럼 폭과 정확히 같아야 트랙(flex-1)이 같은 폭으로
              맞춰진다 — 트레일링 컬럼(F3)까지 포함해 다섯 스페이서 전부 필요. */}
          <div class="flex items-center gap-2 text-sm" aria-hidden="true">
            <span class="w-20 shrink-0" />
            <span class="w-9 shrink-0" />
            <div class="relative h-4 flex-1 text-[10px] tabular-nums text-zinc-600">
              {/* M4 — 0/100 라벨은 가운데 정렬(-translate-x-1/2)이면 절반이
                  트랙 밖으로 넘친다. 양끝은 트랙 안쪽으로 붙인다. */}
              {[0, T.suspect, T.borderline, T.organic, T.organic_strong, 100].map((t) => (
                <span key={t}
                      class={"absolute " + (t === 0 ? "left-0"
                        : t === 100 ? "right-0" : "-translate-x-1/2")}
                      style={t === 0 || t === 100 ? undefined : { left: `${t}%` }}>
                  {t}
                </span>
              ))}
            </div>
            <span class="w-36 shrink-0" />
            <span class="w-20 shrink-0" />
            <span class="w-28 shrink-0" />
          </div>
          <div class="space-y-1.5">
            {orgRows.map((o) => {
              // orgRows 는 score != null 로 걸러진 행이라 여기서 non-null 이다.
              const byCount = o.score!;
              const byViews = o.score_view_weighted ?? byCount;
              const judge = adJudgeScore(o)!;
              const lo = Math.min(byCount, byViews);
              const hi = Math.max(byCount, byViews);
              const isMine = o.group_key === "miiwan";
              const wide = hi - lo >= ORG_SCORE_GAP_CHIP;
              return (
                <div key={o.group_key} class="flex items-center gap-2 text-sm">
                  <span class="w-20 shrink-0" style={{ color: colorOf(o.group_key) }}>
                    {data.groups[o.group_key]?.name ?? o.group_key}
                  </span>
                  {/* 판정 점수 — 이 행의 결론. 색은 등급색(단일 원천). */}
                  <span class="w-9 shrink-0 text-right tabular-nums font-semibold"
                        style={{ color: scoreColor(judge) }}
                        title={`판정 점수 ${judge}점 (편수 ${byCount} · 조회수 ${byViews} 중 낮은 쪽)`}>
                    {judge}
                  </span>
                  <div class="relative h-3 flex-1 rounded"
                       style={{ background: TIER_BAND_BG }}>
                    {/* 광고 의심 기준선 */}
                    <div class="absolute top-[-2px] bottom-[-2px] w-px"
                         style={{ left: `${ORG_AD_SUSPECT_THRESHOLD}%`,
                                  background: hexAlpha(VERDICT_COLOR.likely_paid, 0.7) }} />
                    {/* 두 기준 사이 구간 */}
                    <div class="absolute top-1/2 h-1 -translate-y-1/2 rounded"
                         style={{ left: `${clampPct(lo)}%`,
                                  width: `${Math.max(1, clampPct(hi) - clampPct(lo))}%`,
                                  background: colorOf(o.group_key),
                                  opacity: isMine ? 0.9 : 0.45 }} />
                    {/* 편수 기준 = 채운 점 / 조회수 기준 = 속 빈 점 */}
                    <div class="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
                         title={`편수 기준 ${byCount}점`}
                         style={{ left: `${clampPct(byCount)}%`,
                                  background: colorOf(o.group_key),
                                  opacity: isMine ? 1 : 0.75 }} />
                    {o.score_view_weighted != null && (
                      <div class="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
                           title={`조회수 기준 ${byViews}점`}
                           style={{ left: `${clampPct(byViews)}%`,
                                    borderColor: colorOf(o.group_key),
                                    background: "rgb(24 24 27)", // zinc-900 카드 배경
                                    opacity: isMine ? 1 : 0.75 }} />
                    )}
                    {/* 유료 판정 제외 점수 — 채운 점(편수)·빈 점(조회수)과 형태를
                        분리한 세로 틱. 전 그룹 대칭 노출(미완 전용 아님).
                        유료 판정이 0편인 그룹은 뺀다: 제외할 게 없어 틱이 빈 점
                        위에 그대로 겹치고, 겹친 틱은 "제외해도 안 움직였다"가
                        아니라 "제외 대상이 없었다"라 읽는 법이 다르다
                        (요약 문장 exPaidNote 의 게이트와 같은 규칙). */}
                    {o.score_view_weighted_ex_paid != null
                      && (o.paid_video_count ?? 0) > 0 && (
                      <div class="absolute top-[-3px] bottom-[-3px] w-[2px] -translate-x-1/2 rounded"
                           title={`${EX_PAID_LABEL} ${o.score_view_weighted_ex_paid}점`
                             + ` — 판정된 ${o.paid_video_count}편`
                             + (o.paid_view_share == null ? ""
                               : `(조회수의 ${Math.round(o.paid_view_share * 100)}%)`)
                             + `을 뺀 조회수 기준 점수 · 판정 점수·배지는 그대로`}
                           style={{ left: `${clampPct(o.score_view_weighted_ex_paid)}%`,
                                    background: colorOf(o.group_key),
                                    opacity: isMine ? 1 : 0.75 }} />
                    )}
                  </div>
                  {/* 숫자 컬럼 — 트랙의 점·틱을 글자로 받아쓴다. 제외 점수를
                      틱의 title 툴팁에만 두면 인쇄·스크린샷·모바일에서 사라져
                      MiiWAN 요약 문장의 회복 수치만 남는다(같은 화면에서 자사만
                      유리하게 읽힌다). 그래서 전 그룹 행에 상시 표기한다.
                      틱과 달리 유료 0편도 그대로 적는다 — 값 비교라 제외해도
                      같다는 사실이 그 자체로 답이고, 겹쳐 오독될 위치 표시가
                      아니기 때문이다. */}
                  {/* 07-30 — 둘째 줄은 예전엔 "제외 시 N점"이었다. 무엇을
                      제외했는지가 빠져 "광고를 태운 콘텐츠를 빼면 이만큼"이라는
                      뜻이 안 읽혔고, 색도 첫 줄보다 어두워(zinc-600) 덜 중요한
                      값으로 보였다. 라벨을 붙이고 밝기·굵기를 첫 줄 위로
                      올린다 — 판정 점수(w-9 굵은 숫자) 다음 가는 위계.
                      N6(07-30 R3 리뷰) — 축약 라벨(舊 EX_PAID_LABEL_SHORT
                      "광고 투입 제외")을 없애고 화면 전체를 정식 라벨 하나로
                      통일한다. 같은 값을 두 이름으로 부르면 좁은 컬럼의 숫자와
                      각주·툴팁의 숫자가 서로 다른 지표처럼 읽힌다. 폭 때문에
                      두 줄로 접히는 건 leading-tight 로 받는다(라벨은 접혀도
                      한 덩어리로 읽히고, 숫자는 우측 정렬이라 끝에 남는다). */}
                  <span class="w-36 shrink-0 text-right tabular-nums">
                    <span class="block text-hint text-zinc-500">
                      편수 {byCount} · 조회수 {o.score_view_weighted == null ? "—" : byViews}
                    </span>
                    {o.score_view_weighted_ex_paid != null && (
                      <span class="block text-hint font-medium leading-tight text-zinc-300">
                        {EX_PAID_LABEL} {o.score_view_weighted_ex_paid}점
                      </span>
                    )}
                  </span>
                  <span class="w-20 shrink-0 text-right text-hint text-zinc-600">
                    영상 {o.video_count}편
                  </span>
                  {/* F3 — 칩·참고용 라벨을 트랙 옆에 자유폭으로 두면 폭 있는
                      행(5/7행)만 트랙(flex-1)이 눌려 눈금·기준선과 어긋난다.
                      고정폭 트레일링 컬럼에 담아 모든 행의 트랙 폭을 맞춘다
                      (눈금 행에도 같은 w-28 스페이서를 뒀다). */}
                  <span class="flex w-28 shrink-0 items-center justify-end gap-1 text-right">
                    {wide && (
                      <span class={CHIP} title="영상 편수로 본 점수와 조회수로 본 점수가 크게 갈린다">
                        기준 차이 큼
                      </span>
                    )}
                    {o.reference && <span class="text-hint text-zinc-600">참고용</span>}
                  </span>
                </div>
              );
            })}
          </div>
          {/* 항상 펼쳐 두는 한 줄 = 막대를 읽는 최소 규칙 + 자기공시(K3):
              유료 여부는 공개 지표로 낸 **자체 추정 판정**이라는 사실이 이
              화면에서 접힌 적이 없어야 한다. 나머지(등급 밴드·창 길이·제외
              점수 읽는 법)는 방법론이라 접는다. */}
          <p class="mt-2 text-hint text-zinc-500 leading-relaxed">
            <strong class="text-zinc-300">굵은 숫자가 판정 점수</strong> — 편수로 본
            점수(채운 점)와 조회수로 본 점수(빈 점) 중 낮은 쪽이고, 두 점이 멀수록
            조회수가 소수 영상에 쏠려 있다는 뜻이다. 유료 여부는 공개 영상 지표로 낸
            자체 추정 판정이며, 자사를 포함한 전 팀에 같은 기준을 적용한다.
          </p>
          {/* 제외 점수 읽는 법 — 제외 기준이 판정선과 **같은 선**이라
              (영상별 유료 판정 = 점수 ORG_AD_SUSPECT_THRESHOLD 미만) 남은
              영상은 정의상 전부 그 위에 있고, 틱은 기준선 왼쪽에 설 수가 없다.
              이 구조를 적어두지 않으면 "틱이 기준선을 넘었다"가 발견처럼
              읽힌다 — 보장된 산술을 성과로 파는 문장이 된다. 그래서 방향이
              아니라 규모(편수·조회수 점유)로 읽으라고 못 박는다. */}
          <details class="mt-1 text-hint text-zinc-500">
            <summary class={SUMMARY}>점수대·비교 기간과 &lsquo;{EX_PAID_LABEL}&rsquo; 점수 읽는 법</summary>
            {/* A6(07-30 투자 리뷰) — 예전엔 양 끝 두 대역(40 미만·70 이상)만
                설명해, 우리가 실제로 서 있는 가운데 대역이 무슨 뜻인지 화면
                어디에도 없었다. 배경에 그려진 다섯 구간을 전부 정의한다.
                경계 숫자는 전부 VERDICT_THRESHOLDS 보간 — 손으로 적으면
                재보정 때 배경색과 설명이 조용히 갈린다.
                F4(07-30 R3 투자 리뷰) — {T.suspect}~{T.borderline} 구간을 예전엔
                "의심 대역"이라 불렀는데, 두 문장 뒤에서 "‘{SUSPECT_LABEL}’은
                {T.suspect}점 미만에만 붙인다"고 말하고 있어 같은 각주가 스스로를
                뒤집었다(배지가 없는 팀이 '의심 대역'에 있는 모순). 밴드 이름을
                판정 라벨과 겹치지 않는 '주의 대역'으로 바꾼다 — 배지 로직·임계는
                불변, 이름만 정리한다. 같은 이유로 {T.suspect}점을 문단에서 두 번
                적지 않는다: 임계는 밴드 정의에서 한 번만 보간하고, 배지 문장은
                그 밴드를 가리킨다. */}
            <p class="mt-1 leading-relaxed">
              배경 색 구간은 점수대의 뜻이다 — {T.suspect}점 미만(붉은 구간) = 광고
              과다 · {T.suspect}~{T.borderline}(주황) = 주의 대역(기준선 부근) ·
              {" "}{T.borderline}~{T.organic}(노랑) = 경계 · {T.organic}점 이상(초록) =
              자연 유입 우세({T.organic_strong}점 이상은 진한 초록). 위 그래프·표의
              {" "}&lsquo;{SUSPECT_LABEL}&rsquo;은 붉은 구간(광고 과다 기준선 미만)에
              선 팀에만 붙는다. MiiWAN이 지금까지 지나온
              기간({orgWindowLabel})까지만 세서 비교한다 — 먼저 데뷔한 팀만 더 긴
              기간을 쓰면 공정하지 않기 때문이다.
            </p>
            {/* A3 — 보장 산술("제외 후 점수가 기준선 위인 건 당연하다")과 판정
                앵커는 이제 제외 점수 문단(exPaidNote.note)이 상시로 공시한다.
                여기서 같은 말을 반복하지 않고, 이 각주는 "틱·숫자가 무엇을 뺀
                값인가"라는 정의만 담당한다. */}
            <p class="mt-1 leading-relaxed">
              세로 틱과 &lsquo;{EX_PAID_LABEL}&rsquo; 숫자는 광고 투입으로 판정된
              ({ORG_AD_SUSPECT_THRESHOLD}점 미만) 영상을 빼고 다시 센 조회수 기준
              점수다. 읽을 것은 틱의 위치가 아니라
              {" "}<strong class="text-zinc-300">몇 편이 조회수의 몇 %를 차지했는가</strong>다.
            </p>
          </details>
        </div>
      )}

      {/* ⑤-b 데뷔 창 활동 — ⑤가 "광고 없이 컸나"(질)를 본다면 여기는 "얼마나
          올려서 얼마나 도달·반응했나"(양과 밀도)다. 같은 창(orgWindowLabel)의
          같은 쿼리에서 온 수치라 위 점수와 나란히 읽어도 기간이 어긋나지 않는다.
          자연 유입 섹션 바로 뒤에 두는 이유: 판정 점수의 분모(무엇을 얼마나
          올렸나)가 여기 있어서, 위에서 생긴 "그래서 얼마나 만든 건데?"가
          바로 다음 화면에서 답을 받는다. */}
      {actRows.length > 0 && (
        <div class="card">
          <div class="mb-1 flex flex-wrap items-center gap-2">
            <h3 class={SECTION_TITLE}>데뷔 창 활동</h3>
            <span class={CHIP}>{orgWindowLabel} · 데뷔 창 기준</span>
          </div>
          <p class={SECTION_LEAD}>
            얼마나 올려서(업로드) 얼마나 도달했고(조회수) 얼마나 반응을 얻었나 —
            투입 대비 산출.
          </p>
          <VerdictLines v={aVerdict} />
          <div class="overflow-x-auto rounded-lg border border-zinc-800">
            <table class="w-full min-w-[560px] text-sm tabular-nums">
              <thead class="bg-zinc-900/60 text-xs uppercase tracking-wider text-zinc-500">
                <tr>
                  <th scope="col" class="px-3 py-2 text-left">그룹</th>
                  {/* 라벨 주의 — 여기서 세는 것은 창 안에 올라온 **전체** 영상이고,
                      위 자연 유입의 '영상 N편'은 판정이 가능했던 표본이다.
                      두 수를 같은 이름으로 부르면 독자가 같은 숫자로 읽는다. */}
                  <th scope="col" class="px-3 py-2 text-right">업로드 (롱·숏)</th>
                  <th scope="col" class="px-3 py-2 text-right">창 내 조회수</th>
                  <th scope="col" class="px-3 py-2 text-right">
                    조회 1,000회당 반응
                    <div class="font-normal normal-case tracking-normal text-zinc-600">
                      높을수록 반응이 밀도 있다
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody>
                {actRows.flatMap((o, i) => {
                  const isMine = o.group_key === "miiwan";
                  const firstRef = o.reference && !actRows[i - 1]?.reference;
                  const parts = o.uploads_long != null && o.uploads_short != null
                    ? `롱 ${o.uploads_long}·숏 ${o.uploads_short}` : null;
                  return [
                    firstRef ? (
                      <tr key="act-ref-divider">
                        <td colSpan={4}
                            class="border-t-2 border-zinc-700 px-3 py-2 text-hint text-zinc-500">
                          아래는 순위에서 제외한 참고 사례 — 데뷔 시기·규모가 달라
                          같이 세지 않는다.
                        </td>
                      </tr>
                    ) : null,
                    <tr key={o.group_key}
                        class={"border-t border-zinc-800/60" + (isMine ? " bg-zinc-800/40" : "")}>
                      <td class="px-3 py-2" style={{ color: colorOf(o.group_key) }}>
                        {data.groups[o.group_key]?.name ?? o.group_key}
                      </td>
                      <td class={"px-3 py-2 text-right " + (isMine ? "font-semibold" : "text-zinc-300")}
                          style={isMine ? { color: accent } : undefined}>
                        {(o.uploads ?? 0) > 0 ? `${o.uploads}편` : "—"}
                        {parts && (
                          <div class="text-hint font-normal text-zinc-600">{parts}</div>
                        )}
                      </td>
                      <td class="px-3 py-2 text-right text-zinc-400">
                        {o.window_views == null ? "—" : fmt(o.window_views)}
                      </td>
                      <td class="px-3 py-2 text-right text-zinc-300">
                        {o.engagement_per_1k_views == null
                          ? "—" : o.engagement_per_1k_views.toFixed(1)}
                      </td>
                    </tr>,
                  ];
                })}
              </tbody>
            </table>
            {/* 라벨 충돌 방지 — 이 각주가 없으면 "업로드 107편"과 위 섹션의
                "영상 122편"이 같은 모집단으로 읽혀, 둘이 다를 때 화면이
                자기모순처럼 보인다. 반응의 정의도 여기서 한 번만 말한다. */}
            <p class="px-3 py-2 text-hint text-zinc-500 leading-relaxed border-t border-zinc-800/60">
              업로드 편수는 창 안에 올라온 <strong class="text-zinc-400">전체</strong> 영상 수이고,
              위 자연 유입의 &lsquo;영상 N편&rsquo;은 그중 점수를 낼 수 있었던 표본이라 두
              숫자는 다르다. 반응은 공개된 좋아요·댓글 합이며, 조회수가 없는 팀은
              &mdash;로 둔다.
            </p>
          </div>
        </div>
      )}

      {/* "다음 보고까지" — ⑥ 각주 바로 위. 화면 전체에 흩어진 판정을 강점 /
          보완 / 다음 액션으로 모아 **행동**으로 닫는다. 헤드라인(①)과 시각
          위계가 같은 강조 카드인 이유: 읽는 사람이 위에서 결론을 잡고
          아래에서 근거를 따라 내려온 뒤, 마지막에 "그래서 무엇을 할 것인가"를
          같은 무게로 받아야 하기 때문이다. 역할 구분은 리드 한 줄이 말한다.
          블록 제목에 ✅·⚠️ 를 쓰지 않는 이유: 헤드라인이 이미 그 글리프로
          자기 목록을 표시하고 있어, 같은 글리프를 두 카드가 쓰면 아래 카드가
          위 카드의 반복으로 읽힌다. 색(emerald/amber)만 VerdictLines 와
          맞춰 뜻을 잇는다. */}
      {(nextCard.strengths.length > 0 || nextCard.focus.length > 0) && (
        <div class="card border-l-4" style={{ borderLeftColor: accent }}>
          <h3 class={SECTION_TITLE}>다음 보고까지</h3>
          {/* 시점은 상수에 박지 않고 응답에서 파생한다 — "다음 보고"는 지금
              시점(D+N) 이후라는 뜻이고, 상수에 날짜를 적으면 보고가 밀릴 때
              문구만 옛날 값으로 남는다. */}
          <p class={SECTION_LEAD}>
            맨 위 헤드라인이 한 줄 결론이라면, 여기는 무엇을 해서 다음 보고
            (지금은 D+{data.as_of_day}) 때 무엇을 가져올지다.
          </p>
          <div class="mt-2 grid gap-4 md:grid-cols-3">
            {nextCard.strengths.length > 0 && (
              <div>
                <p class="text-sm font-medium text-emerald-400">종합 강점</p>
                <ul class="mt-1 list-disc space-y-0.5 pl-5 text-sm text-zinc-300">
                  {nextCard.strengths.map((s) => <li key={s}>{s}</li>)}
                </ul>
              </div>
            )}
            {nextCard.focus.length > 0 && (
              <div>
                <p class="text-sm font-medium text-amber-400">보완할 것</p>
                <ul class="mt-1 list-disc space-y-0.5 pl-5 text-sm text-zinc-300">
                  {nextCard.focus.map((s) => <li key={s}>{s}</li>)}
                </ul>
              </div>
            )}
            {/* 액션·산출물은 데이터 파생이 아니라 운영 약속(NEXT_REPORT_ACTIONS).
                "가져올 것"을 액션 밑에 붙여 쌍으로 읽히게 한다 — 쌍이 끊기면
                다음 보고에서 무엇을 검증할 수 있는지가 사라진다. */}
            <div>
              <p class="text-sm font-medium text-zinc-200">다음 액션 → 가져올 것</p>
              <ul class="mt-1 space-y-1.5 text-sm text-zinc-300">
                {nextCard.actions.map((a) => (
                  <li key={a.action}>
                    {a.action}
                    <span class="block text-hint text-zinc-500">
                      → 가져올 것: {a.deliverable}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* ⑥ 방법론 각주·제외 목록 — 파인 프린트. 07-30: 내용은 그대로 두고
          접는다. 다섯 불릿이 늘 펼쳐져 있어 화면 끝이 소자 텍스트 벽으로
          끝났다(K4/K5). 제외 목록은 종전대로 기본 펼침 — 접으면 "숨겼다"와
          구분되지 않는다. */}
      <div class="space-y-1.5 text-hint text-zinc-500">
        <details>
          <summary class={SUMMARY}>측정·비교 방법 (정렬 · 배수 계산 · 대상 선정 · 추정치 · 제외 원칙)</summary>
        <ul class="mt-1 space-y-1 leading-relaxed">
          <li>
            <strong class="text-zinc-400">정렬 방식</strong> — 팀마다 데뷔한 날이
            다르므로 각 팀의 데뷔일을 똑같이 0일로 맞춘 뒤 같은 경과일끼리 비교한다.
            그래프는 데뷔일 값을 100으로 놓은 성장 폭이고 {preDebutLabel} 그린다.
          </li>
          <li>
            <strong class="text-zinc-400">배수 계산</strong> — 데뷔 후 성장 배수 =
            D+{data.as_of_day} 값 ÷ 데뷔일 값 (데뷔일 값은 데뷔일({baseTol}), 지금 값은
            D+{data.as_of_day}({atTol}) 안에서 가장 가까운 날의 측정값). 데뷔 전 성장
            배수는 그 앞 구간을 같은 방식으로 잰 값으로,
            {/* N4(07-30 R3 리뷰) — "데뷔 30일 전(±7일)"은 백엔드 상수를 손으로
                적은 값이라, 같은 li 아래 총 성장 배수 절(B2)이 이미 응답에서
                파생하고 있는데도 이 문장만 옛 값으로 남을 수 있었다. 같은
                소스(preDebutDays·PRE_BASE_WINDOW)에서 파생하고, 응답에 창이
                없으면 숫자를 지어내지 않고 이름으로만 말한다. */}
            {preDebutDays != null
              ? <> 데뷔 {preDebutDays}일 전(±{PRE_BASE_WINDOW}일)</>
              : <> 데뷔 전 기준 창의</>}
            {" "}측정값이 있을 때만 낸다 — 그래서 데뷔 전 값이 있어도(창 밖의 값이라)
            데뷔 전 성장 배수는 &mdash;로 남는 팀이 있을 수 있다. 표의 &lsquo;데뷔 전 값&rsquo; 칸은
            그 창에 측정이 없으면 확보된 가장 이른 데뷔 전 값을 측정일과 함께 싣고,
            데뷔 전 측정이 아예 없는 팀은 &mdash;로 둔다.
            {/* B2(07-30 투자 리뷰) — 산점도 x축이 쓰는 '총 성장 배수'만 정의가
                없어, 표의 두 배수와 어떻게 다른지 화면에서 확인할 방법이 없었다.
                분모·앵커 규칙을 응답 상수에서 파생해 적는다. */}
            {" "}산점도의 <strong class="text-zinc-400">총 성장 배수</strong>는 D+{data.as_of_day} 값 ÷
            데뷔 전 앵커 값이다
            {preDebutDays != null
              ? <> (원칙 데뷔 {preDebutDays}일 전 ±{PRE_BASE_WINDOW}일, 그 창에 측정이 없으면
                확보된 가장 이른 데뷔 전 값)</>
              : <> (그 창에 측정이 없으면 확보된 가장 이른 데뷔 전 값)</>}
            {" "}— 데뷔 전 구간까지 포함하므로 표의 데뷔 후 배수보다 크게 나온다.
          </li>
          {/* E1(07-30 투자 리뷰) — "왜 유튜브 지표만 보나"가 화면 어디에도 없어
              "유리한 것만 골랐다"로 읽힐 여지가 있었다. 백엔드 METRICS 주석의
              사유를 한 줄로 옮긴다(계산은 불변 — 공시만 추가). */}
          <li>
            <strong class="text-zinc-400">지표 선정</strong> — 커뮤니티 활동·뉴스 노출은
            이 화면에서 뺐다. 커뮤니티는 갤러리가 열린 시점이 팀마다 달라 데뷔일
            값이 성장의 출발선이 아니라 &lsquo;언제 갤러리가 생겼나&rsquo;를 재는 값이
            되고, 뉴스는 수집 방식마다 세는 단위(누적 건수 / 그 주의 건수)가 섞여
            있어 배수 비교가 성립하지 않는다. 다른 화면의 같은 지표는 그대로 쓴다.
          </li>
          <li>
            <strong class="text-zinc-400">비교 대상 선정</strong> — {debutRange
              ? <>데뷔일 {debutRange.from}~{debutRange.to} 사이 국내 K-POP 버추얼
                {" "}{composition.candidates}팀(MiiWAN 포함)</>
              : <>비슷한 시기에 데뷔한 국내 K-POP 버추얼 {composition.candidates}팀(MiiWAN 포함)</>}
            {" "}중 {METRIC_LABELS[metric] ?? metric} 지표에서 데뷔일 값이 확보된
            {" "}{sc?.cohort_size ?? 0}팀. PLAVE는 데뷔 시기·체급이 달라 순위에서 빼고
            참고 사례로만 넣었다.
          </li>
          <li>
            <strong class="text-zinc-400">추정치 취급</strong> — est 배지는 나중에
            되짚어 채운 추정치라 모양은 믿되 절대값은 참고만 한다. 곡선에는 실측값만
            쓰고 표의 배수는 추정값까지 쓰므로, 실측 데뷔일 값이 없는 팀은 곡선에서만
            빠지고 표에는 배수가 남을 수 있다.
          </li>
          <li>
            <strong class="text-zinc-400">제외 원칙</strong> — 데이터가 없는 팀은 숫자를
            만들어 채우지 않고 비교에서 뺀다
            {data.excluded.length > 0 && <> (현재 {data.excluded.length}건)</>}. 제외는
            순위를 유리하게도 불리하게도 조정하지 않는다 — 모수에서 빠질 뿐이다.
          </li>
        </ul>
        </details>
        {/* R4 — 제외 목록은 기본 펼침. 접어두면 "숨겼다"와 구분되지 않는다. */}
        {data.excluded.length > 0 && (
          <details open class="text-hint text-zinc-500">
            <summary class="cursor-pointer text-zinc-400 hover:text-zinc-200">
              비교에서 뺀 항목 {data.excluded.length}건
            </summary>
            <ul class="mt-1 list-disc space-y-0.5 pl-5">
              {data.excluded.map((e) => (
                <li key={`${e.group_key}:${e.metric}:${e.reason}`}>
                  {data.groups[e.group_key]?.name ?? e.group_key}
                  {" / "}{METRIC_LABELS[e.metric] ?? e.metric}
                  {" — "}{EXCLUDED_REASONS[e.reason] ?? e.reason}
                  {" · "}
                  <span class="text-zinc-600">
                    {e.reason === "no_at_day_value"
                      ? "비교 시점에 도달하면 자동으로 편입된다"
                      : "순위에 유리·불리 어느 쪽으로도 조정하지 않는다"}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
