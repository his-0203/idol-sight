import { useEffect, useMemo, useState } from "preact/hooks";
import Chart from "chart.js/auto";
import { api } from "../api";
import { fmt } from "../format";
import { writeState, readState, onStateChange } from "../router";
import { FreshnessBadge } from "../components/FreshnessBadge";
import { ExportMenu } from "../components/ExportMenu";
import { ShareLink } from "../components/ShareLink";
import { HealthSpec } from "../components/HealthSpec";
import { DebutCurve } from "../components/DebutCurve";
import { colorOf, fillOf } from "../design/groups";
import { gradeClasses } from "../design/grades";
import { fmtScale, fmtTooltipCallback } from "../design/chart-defaults";
import { BreadthDepthQuadrant } from "../components/BreadthDepthQuadrant";
import { Tooltip } from "../components/Tooltip";
import { computeQuadrantLayout, QUADRANT_LABEL, type QuadrantInput } from "../lib/breadthDepth";
import {
  DEFAULT_ORGANICITY_MODE,
  computeGroupOrganicities,
  organicityCaveat,
  verdictColor,
  type GroupOrganicity,
  type OrganicitySummaryRow,
} from "../lib/organicity";
import { DEFAULT_CURRENT_BUCKET, DEFAULT_DISPLAY_BUCKETS } from "../lib/debutWindow";

// 카테고리 분류는 lib/category로 추출(GroupSwitcher와 공유). 카드를 카테고리
// 섹션으로 나눠야 순위가 읽힌다 — PLAVE(corporate)와 STELLIVE(confederation)를
// 한 평면에 섞으면 같은 면에서 경쟁하는 것처럼 보이지만 Health 가중이 다르다.
import { categoryOf, CATEGORY_LABEL, CATEGORY_HINT, type Category } from "../lib/category";

// 인지도×관여 팬 사분면 태그 색(표 컬럼). breadthDepth QUADRANT_LABEL과 키 동일.
const QUAD_TAG: Record<string, string> = {
  strong:    "text-emerald-400 border-emerald-500/40",
  ad_driven: "text-amber-400 border-amber-500/40",
  niche:     "text-sky-400 border-sky-500/40",
  low:       "text-zinc-400 border-zinc-700",
};

// Grade ordering — used as the primary sort key inside each category
// section so the operator sees ranks at a glance. PRE (pre-debut) is
// last because the grade is a placeholder, not an achievement.
const GRADE_ORDER: Record<string, number> = {
  S: 0, A: 1, B: 2, C: 3, D: 4, PRE: 5,
};

function gradeRank(grade: string | null | undefined): number {
  const fallback = GRADE_ORDER.PRE ?? 99;
  return GRADE_ORDER[grade ?? "PRE"] ?? fallback;
}

// Sort: grade ASC (S first) → total DESC → SOV DESC → name ASC.
// `latestShareByKey` is read from share.rows so groups missing a Health
// Score still get a sensible secondary order from cohort percentile.
function sortByRank(
  entries: Array<[string, any]>,
  latestShareByKey: Record<string, number>,
): Array<[string, any]> {
  return [...entries].sort(([ka, ga], [kb, gb]) => {
    const gradeDiff = gradeRank(ga.health_score?.grade) - gradeRank(gb.health_score?.grade);
    if (gradeDiff !== 0) return gradeDiff;
    const totalDiff = (gb.health_score?.total ?? -1) - (ga.health_score?.total ?? -1);
    if (totalDiff !== 0) return totalDiff;
    const sovDiff = (latestShareByKey[kb] ?? 0) - (latestShareByKey[ka] ?? 0);
    if (sovDiff !== 0) return sovDiff;
    return (ga.name ?? "").localeCompare(gb.name ?? "");
  });
}

export interface Awareness { score: number | null; category_rank: number | null; }

export interface AwarenessV253 extends Awareness {
  score_adj?: number | null; category_rank_adj?: number | null;
  organic_confidence?: number | null;
}

// '—' when basis=insufficient (null score) or no agg_awareness row.
export function fmtAwareness(score: number | null | undefined): string {
  return score == null ? "—" : String(score);
}

// adj-first: mig 0106 적용 + organicity 채점 그룹만 adj 보유. 미적용/구 스냅샷은 원값 폴백.
export function awarenessDisplay(aw: AwarenessV253 | null | undefined) {
  if (!aw) return { score: null, rank: null, discounted: false };
  const discounted = aw.score_adj != null && aw.organic_confidence != null && aw.organic_confidence < 1;
  return {
    score: aw.score_adj ?? aw.score ?? null,
    rank: (aw.category_rank_adj ?? aw.category_rank) ?? null,
    discounted,
  };
}

export function coreDisplay(cf: any) {
  if (!cf) return { value: null, insufficientOrganic: false };
  if (cf.basis === "insufficient_organic") return { value: null, insufficientOrganic: true };
  return { value: cf.est_engaged_fans_adj ?? cf.est_engaged_fans ?? null, insufficientOrganic: false };
}

// Sort by category_rank(adj-first) ASC (1 = 가장 잘 알려짐). 순위 없는 그룹은 맨 뒤로→name.
export function sortByAwareness(
  entries: Array<[string, any]>,
): Array<[string, any]> {
  return [...entries].sort(([, ga], [, gb]) => {
    const ra = awarenessDisplay(ga.awareness).rank;
    const rb = awarenessDisplay(gb.awareness).rank;
    const aHas = ra != null;
    const bHas = rb != null;
    if (aHas && bHas && ra !== rb) return ra - rb;
    if (aHas !== bHas) return aHas ? -1 : 1;
    return (ga.name ?? "").localeCompare(gb.name ?? "");
  });
}

// ── 표 컬럼 클릭 정렬 ──────────────────────────────────────────────────
export type TableSortKey = "grade" | "awareness" | "core" | "viewconv" | "sov";
export interface TableSort { key: TableSortKey; dir: 1 | -1 } // dir 1=내림차순, -1=오름차순

export function tableSortValue(key: TableSortKey, k: string, g: any, shares: Record<string, number>): number | null {
  switch (key) {
    case "grade":     return g.health_score?.total ?? null;
    case "awareness": return awarenessDisplay(g.awareness).score;
    case "core":      return coreDisplay(g.core_fan_estimate).value;
    case "viewconv":  return g.view_conversion?.rate_ceiling ?? g.view_conversion?.rate ?? null;
    case "sov":       return shares[k] ?? null;
  }
}

// 표 컬럼 용어 도움말 — 새 사용자가 "무슨 값·어떻게 산출됐나" 알 수 있게.
const HELP = {
  group:     "색 = 그룹 식별 · '자사' 배지 = MiiWAN(우리 그룹). 행 클릭 = 그룹 심층 페이지.",
  grade:     "건강 점수(0~10)의 등급(S>A>B>C>D). Reach·Ritual·Mobilize·Intimacy 4축 가중합. 옆 숫자는 원점수, PRE = 데뷔 전(또는 점수 집계 전·활동량 부족).",
  awareness: "인지 폭(0~100). 카테고리 리더 대비 구독·조회·최근 90일 뉴스 log 정규화 후 organicity 신뢰 계수로 할인한 보정값(원값은 셀 툴팁). #N = 보정값 기준 카테고리 내 순위. 산식 v2(2026-08): 뉴스=최근 90일 기사 수(누적 아님) — 전 그룹 동일 적용.",
  core:      "추정 관여 팬 = 최근 30일 영상 중 좋아요 상위 5편의 중앙값(고유 반응 팬 근사). 유료 의심(suspect/likely_paid) 영상은 제외. 산식 v2(2026-08): 상위 5편 기준이라 업로드 편수가 많아도 불리하지 않음 — 전 그룹 동일 적용. 추정 휴리스틱 — 실측 아님.",
  quad:      "인지도(넓이)×추정 관여 팬(이 표의 컬럼과 동일 값) 사분면. 진성 강세=둘 다 높음 · 인지 선행=넓지만 얕음(코어 전환 과제) · 니치 충성=좁지만 깊음 · 초기 단계=둘 다 낮음 (카테고리 중앙값 기준). 사분면의 인지도는 할인 전 원값 — '넓지만 얕음' 패턴 탐지가 목적.",
  viewconv:  "시청전환율 = 라이브 방송 동시접속(방송별 peak CCV 중앙값) ÷ 구독자. 구독자 중 실제 라이브에 오는 비율(충성도 신호). 위버스 등 오프플랫폼 라이브가 있는 그룹(PLAVE)은 유튜브 실측 + 위버스 추정(≥10만) 합산값(≈ 표시). 라이브 CCV 미수집 그룹은 —.",
  sov:       "관심 점유율(Share of Voice) — 같은 카테고리(K-POP/서브컬처) 안에서의 상대 비중(유튜브 조회 33%·커뮤니티 28%·최근 90일 뉴스 22%·구독 17%). v3(2026-08): 카테고리별 독립 산출(각 합 100%)·뉴스는 최근 90일·전주 비교는 7일 전 스냅샷 앵커. 옆 ▲▼ = 전주 대비 변화(pp). ※ 백분위 합성 특성상 %는 규모 격차를 압축함 — 규모 비교는 티어(T1~T3, 최근 90일 조회 흐름 log 갭) 참조.",
  caveat:    "영상 카탈로그 organicity가 주의 구간(유료로 산 도달 의심). 심각도 순: 노랑=오가닉성 주의 < 주황=유료 의심 < 빨강=유료 가능성 높음. 인지도·추정 관여 팬에는 신뢰 할인으로 반영됨(V2.53).",
} satisfies Record<string, string>;

/** ts=null이면 기본 순서(sortByRank=등급순) 유지. 값 없는 그룹은 방향과 무관하게 항상 뒤로. */
export function sortEntriesBy(
  entries: Array<[string, any]>,
  ts: TableSort | null,
  shares: Record<string, number>,
): Array<[string, any]> {
  if (!ts) return entries;
  return [...entries].sort(([ka, ga], [kb, gb]) => {
    const a = tableSortValue(ts.key, ka, ga, shares);
    const b = tableSortValue(ts.key, kb, gb, shares);
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    return (b - a) * ts.dir;
  });
}

function latestShareMap(
  shareRows: Array<{ week_end: string; group_key: string; final: number }> | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!shareRows?.length) return out;
  const latestWeek = [...new Set(shareRows.map((r) => r.week_end))].sort().pop();
  for (const r of shareRows) {
    if (r.week_end === latestWeek) out[r.group_key] = r.final ?? 0;
  }
  return out;
}

// Compute (currentWeekShare, previousWeekShare) per group_key from share.rows.
// Used to render the ▲/▼ delta chip on each card.
function shareDeltaByKey(
  shareRows: Array<{ week_end: string; group_key: string; final: number }> | undefined,
): Record<string, { current: number; prev: number | null }> {
  if (!shareRows || !shareRows.length) return {};
  const weeks = [...new Set(shareRows.map((r) => r.week_end))].sort();
  const current = weeks[weeks.length - 1];
  const prev = weeks.length >= 2 ? weeks[weeks.length - 2] : null;
  const out: Record<string, { current: number; prev: number | null }> = {};
  for (const r of shareRows) {
    const slot = out[r.group_key] ?? { current: 0, prev: null };
    if (r.week_end === current) slot.current = r.final ?? 0;
    if (prev && r.week_end === prev) slot.prev = r.final ?? 0;
    out[r.group_key] = slot;
  }
  return out;
}

export function MarketOverview() {
  const [market, setMarket] = useState<any>(null);
  const [share, setShare] = useState<any>(null);
  const [meta, setMeta] = useState<any>(null);
  const [excludePlave, setExcludePlave] = useState(false);
  const [activeCategory, setActiveCategory] = useState<"all" | Category>(readState().category);
  // 사이드바 코호트 항목이 router category를 바꾸면 뷰 동기화(remount 없이).
  useEffect(() => onStateChange((s) => setActiveCategory(s.category)), []);
  const [tableSort, setTableSort] = useState<TableSort | null>(null);
  const toggleSort = (key: TableSortKey) =>
    setTableSort((ts) => (ts && ts.key === key ? { key, dir: (ts.dir === 1 ? -1 : 1) as 1 | -1 } : { key, dir: 1 }));
  const sortInd = (key: TableSortKey) =>
    tableSort?.key === key ? (tableSort.dir === 1 ? " ▼" : " ▲") : "";
  // 정렬 가능 헤더(클릭) + 용어 도움말(ⓘ 호버) 렌더 헬퍼.
  const sortHdr = (key: TableSortKey, label: string) => (
    <button type="button" class="cursor-pointer select-none font-medium hover:text-zinc-300"
            onClick={() => toggleSort(key)}>{label}{sortInd(key)}</button>
  );
  const help = (t: string) => (
    <Tooltip content={t} placement="bottom"><span class="ml-0.5 cursor-help text-zinc-600">ⓘ</span></Tooltip>
  );
  // Callback ref + state so we know precisely when the canvas mounts.
  // The previous useRef approach + useEffect [share, excludePlave] race-
  // condition'd on first load: useEffect would fire before the canvas was
  // visible-laid-out (Preact reuses the empty-state <div> when the
  // conditional flips), so Chart.js measured 0×0 dimensions and drew
  // nothing. Toggling the checkbox masked the bug because by then the
  // canvas had been in DOM long enough to size correctly. Stashing the
  // node in state makes the canvas dep explicit: the effect only runs in
  // a render where the canvas is genuinely live in the DOM.
  const [shareCanvasEl, setShareCanvasEl] = useState<HTMLCanvasElement | null>(null);

  useEffect(() => {
    api.market().then(setMarket);
    api.marketShare(13).then(setShare);
    api.meta().then(setMeta);
  }, []);

  const [orgRows, setOrgRows] = useState<OrganicitySummaryRow[] | null>(null);
  const [orgBuckets, setOrgBuckets] = useState<string[]>(DEFAULT_DISPLAY_BUCKETS);
  const [orgCurrent, setOrgCurrent] = useState<string>(DEFAULT_CURRENT_BUCKET);

  useEffect(() => {
    let cancelled = false;
    api.debutWindowSummary<OrganicitySummaryRow>().then((r) => {
      if (cancelled) return;
      if (r.window?.buckets?.length) {
        setOrgBuckets(r.window.buckets);
        setOrgCurrent(r.window.current_bucket);
      }
      setOrgRows(r.rows);
    }).catch(() => { if (!cancelled) setOrgRows([]); });
    return () => { cancelled = true; };
  }, []);

  // Market share trend (line, color = group). We dropped the stacked-area
  // + log-scale combo because stacking + log is mathematically meaningless
  // (you cannot add log values), and a line per group reads more cleanly
  // on a small chart.
  useEffect(() => {
    if (!share || !shareCanvasEl) return;
    const weeks = Array.from(new Set<string>(share.rows.map((r: any) => r.week_end))).sort();
    const groupKeys = Array.from(new Set<string>(share.rows.map((r: any) => r.group_key)));
    const filtered = excludePlave ? groupKeys.filter((k) => k !== "plave") : groupKeys;
    const datasets = filtered.map((k) => ({
      label: k,
      data: weeks.map((w) => {
        const row = share.rows.find((r: any) => r.week_end === w && r.group_key === k);
        return row?.final ?? 0;
      }),
      borderColor: colorOf(k),
      backgroundColor: fillOf(k, 0.15),
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      tension: 0.25,
      fill: false,
    }));
    const chart = new Chart(shareCanvasEl, {
      type: "line",
      data: { labels: weeks, datasets },
      options: {
        scales: {
          y: {
            title: { display: true, text: "관심 점유율 (%)" },
            ticks: { callback: (v) => fmtScale(v as number) },
          },
          x: { title: { display: true, text: "주차" } },
        },
        plugins: {
          legend: { position: "bottom" },
          tooltip: { callbacks: { label: fmtTooltipCallback() } },
        },
      },
    });
    return () => { chart.destroy(); };
  }, [share, excludePlave, shareCanvasEl]);

  const sharesByKey = useMemo(() => latestShareMap(share?.rows), [share]);
  const deltas = useMemo(() => shareDeltaByKey(share?.rows), [share]);

  // group_key → GroupOrganicity (current rolling bucket, count-based headline).
  const orgByKey = useMemo<Map<string, GroupOrganicity>>(() => {
    if (!orgRows) return new Map();
    return computeGroupOrganicities(orgRows, {
      buckets: orgBuckets, currentBucket: orgCurrent, mode: DEFAULT_ORGANICITY_MODE,
    });
  }, [orgRows, orgBuckets, orgCurrent]);

  // Split into category buckets and rank within each. The same sort
  // function is reused so cross-section ordering is internally
  // consistent (e.g. an A-grade subculture group above a B-grade
  // subculture group, never re-shuffled by category mixing).
  const sectioned = useMemo(() => {
    if (!market) return { kpop: [], subculture: [] } as Record<Category, Array<[string, any]>>;
    const all = Object.entries(market.groups);
    const kpop = all.filter(([, g]: any) => categoryOf(g.group_model) === "kpop");
    const sub  = all.filter(([, g]: any) => categoryOf(g.group_model) === "subculture");
    const sorter = (e: Array<[string, any]>) =>
      sortByRank(e, sharesByKey); // 기본 = 등급순. 컬럼 클릭 정렬은 렌더 시 sortEntriesBy로 덮어씀.
    return {
      kpop:       sorter(kpop),
      subculture: sorter(sub),
    };
  }, [market, sharesByKey]);

  if (!market) return <div class="p-4 text-zinc-500">Loading…</div>;

  const sectionsToRender: Category[] =
    activeCategory === "all" ? ["kpop", "subculture"] : [activeCategory];

  return (
    <div class="space-y-6">
      {/* freshness banner */}
      <div class="flex flex-wrap items-center gap-2">
        {meta && (
          <FreshnessBadge label="전체"
            lastSuccessAt={meta.global_last_success_at}
            intervalH={1} />
        )}
        <div class="ml-auto flex items-center gap-1">
          <ShareLink />
        </div>
      </div>

      {/* Category filter — explicit toggle is helpful when the operator
          wants to focus on a single cohort (e.g. comparing only K-POP
          newcomers to MiiWAN's launch curve). Default 'all' shows both
          sections stacked so ranks within each cohort are visible. */}
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <span class="text-zinc-500">코호트</span>
        {([
          { key: "all" as const,        label: "전체" },
          { key: "kpop" as const,       label: "K-POP" },
          { key: "subculture" as const, label: "서브컬처" },
        ]).map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => writeState({ tab: "market", category: c.key })}
            class={"rounded-md border px-3 py-1 text-xs transition-colors " +
              (activeCategory === c.key
                ? "border-violet-500 bg-violet-500/10 text-violet-300"
                : "border-zinc-700 text-zinc-400 hover:bg-zinc-800")}
          >{c.label}</button>
        ))}
      </div>

      {/* 정렬 안내 — 표 헤더 클릭으로 정렬 (기본=등급순) */}
      <div class="flex flex-wrap items-center gap-2 text-hint text-zinc-500">
        <span>표 헤더(<b class="text-zinc-400">등급·인지도·추정코어·시청전환율·SoV</b>)를 클릭해 정렬 · 기본 등급순.</span>
        <span>각 헤더의 <span class="text-zinc-400">ⓘ</span>에 마우스를 올리면 용어 설명이 떠요.</span>
      </div>

      {/* ① 개요 KPI strip */}
      {(() => {
        const allEntries = [...sectioned.kpop, ...sectioned.subculture];
        const paidSuspect = allEntries.filter(([k]: any) => organicityCaveat(orgByKey.get(k)).show).length;
        const mw: any = market?.groups?.miiwan;
        return (
          <div class="grid grid-cols-2 gap-2 md:grid-cols-4">
            <div class="card p-3">
              <div class="text-hint text-zinc-500">코호트</div>
              <div class="mt-1 text-lg font-bold tabular-nums">K-POP {sectioned.kpop.length} · 서브 {sectioned.subculture.length}</div>
            </div>
            <div class="card p-3">
              <div class="text-hint text-zinc-500">전체 그룹</div>
              <div class="mt-1 text-lg font-bold tabular-nums">{allEntries.length}</div>
            </div>
            <div class="card p-3">
              <div class="text-hint text-zinc-500">유료 도달 의심 ⚠</div>
              <div class="mt-1 text-lg font-bold tabular-nums text-amber-400">{paidSuspect} 그룹</div>
            </div>
            <div class="card p-3" style={{ borderColor: "rgba(117,215,209,0.45)" }}>
              <div class="text-hint text-zinc-500">자사 MiiWAN</div>
              <div class="mt-1 text-lg font-bold tabular-nums text-own">
                {mw?.health_score?.grade ?? "—"}
                {awarenessDisplay(mw?.awareness).rank != null ? ` · 인지도 #${awarenessDisplay(mw?.awareness).rank}` : ""}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ② 그룹 비교 표 (카테고리별). 넓이×깊이는 태그 컬럼 — 셀 안 서열 손실 없음.
          포지셔닝 산점도는 아래 접힌 보조 패널로 강등. */}
      {sectionsToRender.map((category) => {
        const entries = sectioned[category];
        if (!entries.length) return null;
        // x는 할인 전 원값("넓지만 얕음" 패턴 탐지 목적) · y는 표의 "추정
        // 관여 팬" 컬럼과 동일한 coreDisplay(보정 우선) — 화면 간 값 통일.
        const points = entries.reduce<QuadrantInput[]>((acc, [key, g]: any) => {
          const x = g.awareness?.score;
          const y = coreDisplay(g.core_fan_estimate).value;
          if (x != null && y != null) {
            acc.push({ key, name: g.name, x, y, caveat: organicityCaveat(orgByKey.get(key)).show });
          }
          return acc;
        }, []);
        const layout = computeQuadrantLayout(points);
        const quadByKey = new Map(layout.points.map((p) => [p.key, p.quadrant]));
        return (
          <section key={category}>
            <div class="mb-2 flex flex-wrap items-baseline gap-2">
              <h3 class="section-title">{CATEGORY_LABEL[category]}</h3>
              <span class="text-hint text-zinc-500">{CATEGORY_HINT[category]}</span>
              <span class="ml-auto text-hint text-zinc-500">{entries.length}그룹</span>
            </div>
            <div class="card overflow-x-auto p-0">
              <table class="w-full text-data">
                <thead class="text-hint text-zinc-500">
                  <tr class="border-b border-zinc-800">
                    <th class="px-3 py-2 text-left font-medium">#</th>
                    <th class="px-2 py-2 text-left font-medium">그룹{help(HELP.group)}</th>
                    <th class="px-2 py-2 text-left font-medium">{sortHdr("grade", "등급")}{help(HELP.grade)}</th>
                    <th class="px-2 py-2 text-right font-medium">{sortHdr("awareness", "인지도")}{help(HELP.awareness)}</th>
                    <th class="px-2 py-2 text-right font-medium">{sortHdr("core", "추정 관여 팬")}{help(HELP.core)}</th>
                    <th class="px-2 py-2 text-right font-medium">{sortHdr("viewconv", "시청전환율")}{help(HELP.viewconv)}</th>
                    <th class="px-2 py-2 text-left font-medium">사분면{help(HELP.quad)}</th>
                    <th class="px-2 py-2 text-right font-medium">{sortHdr("sov", "SoV")}{help(HELP.sov)}</th>
                    <th class="px-2 py-2 text-left font-medium">주의{help(HELP.caveat)}</th>
                  </tr>
                </thead>
                <tbody>
                  {sortEntriesBy(entries, tableSort, sharesByKey).map(([key, g]: any, i: number) => {
                    const hs = g.health_score;
                    const grade = hs?.grade ?? "PRE";
                    const total = hs?.total;
                    const fallback = g.summary?.yt_subscribers ?? g.summary?.yt_total_views ?? null;
                    const d = deltas[key];
                    const dpp = d && d.prev != null ? d.current - d.prev : null;
                    const sov = sharesByKey[key];
                    const cav = organicityCaveat(orgByKey.get(key));
                    const quad = quadByKey.get(key);
                    const cf = g.core_fan_estimate;
                    const own = key === "miiwan";
                    return (
                      <tr
                        key={key}
                        class="cursor-pointer border-b border-zinc-800/60 hover:bg-zinc-800/40 focus:outline-none focus:bg-zinc-800/40"
                        style={own ? { boxShadow: "inset 3px 0 0 #75d7d1", background: "rgba(117,215,209,0.05)" } : undefined}
                        tabIndex={0}
                        role="button"
                        aria-label={`${g.name} 상세 보기`}
                        onClick={() => writeState({ tab: "content", group: key })}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); writeState({ tab: "content", group: key }); } }}
                      >
                        <td class="px-3 py-2 tabular-nums text-zinc-500">{i + 1}</td>
                        <td class="px-2 py-2 whitespace-nowrap">
                          <span class="mr-1.5 inline-block h-2.5 w-2.5 rounded-full align-middle" style={{ background: colorOf(key) }}></span>
                          <b class={own ? "text-own" : ""}>{g.name}</b>
                          {own && (
                            <span class="ml-1 rounded-chip border px-1 text-[9px] align-middle text-own" style={{ borderColor: "rgba(117,215,209,0.5)" }}>자사</span>
                          )}
                          <span class="ml-1 text-hint text-zinc-500">{g.name_kr}</span>
                        </td>
                        <td class="px-2 py-2 whitespace-nowrap">
                          <span class={`rounded-chip border px-1.5 font-bold ${gradeClasses(grade)}`}>{grade}</span>
                          <span class="ml-1 text-hint text-zinc-500 tabular-nums">
                            {total != null ? `${total}` : fallback != null ? fmt(fallback) : "—"}
                          </span>
                        </td>
                        {(() => {
                          const awDisp = awarenessDisplay(g.awareness);
                          return (
                            <td class="px-2 py-2 text-right tabular-nums"
                                title={awDisp.discounted
                                  ? `원값 ${g.awareness.score} · 신뢰 계수 ${g.awareness.organic_confidence} — 유료 의심 영상 비중만큼 할인`
                                  : undefined}>
                              {awDisp.score != null ? (
                                <span class="text-sky-300">
                                  {fmtAwareness(awDisp.score)}
                                  {awDisp.rank != null && (
                                    <span class="text-hint text-zinc-500"> #{awDisp.rank}</span>
                                  )}
                                </span>
                              ) : (
                                <span class="text-zinc-600" title="신호 부족 — 인지도 산정 제외">—</span>
                              )}
                            </td>
                          );
                        })()}
                        {(() => {
                          const coreDisp = coreDisplay(cf);
                          return (
                            <td class="px-2 py-2 text-right tabular-nums" title="좋아요·댓글 기반 추정(관여 팬) — 라이브 측정과 다른 축, 참고">
                              {coreDisp.value != null ? (
                                <>~{fmt(coreDisp.value)}</>
                              ) : coreDisp.insufficientOrganic ? (
                                <span class="text-zinc-600" title="유료 의심 영상 제외 후 표본 부족 — 추정 보류">—</span>
                              ) : (
                                <span class="text-zinc-600">—</span>
                              )}
                            </td>
                          );
                        })()}
                        {(() => {
                          const vc = g.view_conversion;
                          const shown = vc?.rate_ceiling ?? vc?.rate ?? null;     // ceiling(유튜브+위버스) 우선
                          const weverse = vc?.rate_ceiling != null;
                          return (
                            <td class="px-2 py-2 text-right tabular-nums"
                                title={shown != null
                                  ? (weverse
                                      ? `유튜브 실측 + 위버스 추정(≥10만) 합산 ÷ 구독자${vc.broadcasts ? ` · ${vc.broadcasts}개 방송` : ""}`
                                      : `라이브 동접(median peak CCV) ÷ 구독자${vc?.broadcasts ? ` · ${vc.broadcasts}개 방송` : ""}`)
                                  : "라이브 CCV 미수집 — 시청전환율 산정 불가"}>
                              {shown != null
                                ? <>{weverse && <span class="text-own">≈</span>}{(shown * 100).toFixed(1)}%</>
                                : <span class="text-zinc-600">—</span>}
                            </td>
                          );
                        })()}
                        <td class="px-2 py-2 whitespace-nowrap">
                          {quad ? (
                            <span class={`rounded-chip border px-1.5 text-hint ${QUAD_TAG[quad]}`}>{QUADRANT_LABEL[quad]}</span>
                          ) : (
                            <span class="text-zinc-600">—</span>
                          )}
                        </td>
                        <td class="px-2 py-2 text-right tabular-nums whitespace-nowrap">
                          {sov != null ? `${sov.toFixed(0)}%` : "—"}
                          {dpp != null && (
                            <span class={"ml-1 text-hint " + (dpp > 0.05 ? "text-emerald-400" : dpp < -0.05 ? "text-red-400" : "text-zinc-500")}>
                              {dpp > 0 ? "▲" : dpp < 0 ? "▼" : "·"}{Math.abs(dpp).toFixed(1)}
                            </span>
                          )}
                        </td>
                        <td class="px-2 py-2 whitespace-nowrap">
                          {cav.show ? (
                            <span class="text-hint" style={{ color: verdictColor(cav.verdict) }} title="영상 카탈로그 organicity 주의 — 광고로 산 도달 가능성. 인지도·추정 관여 팬에는 신뢰 할인으로 반영됨(V2.53).">⚠ {cav.label}</span>
                          ) : (
                            <span class="text-zinc-600">·</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {/* 포지셔닝 맵 (접힘·보조) — 표가 1차 답, 맵은 넓이×깊이를 시각으로 보고 싶을 때 */}
            <details class="mt-2">
              <summary class="cursor-pointer text-hint text-zinc-400">▸ 포지셔닝 맵 (인지도×관여 팬 산점도)</summary>
              <div class="mt-2"><BreadthDepthQuadrant points={points} /></div>
            </details>
          </section>
        );
      })}

      {/* 관심 점유율 (Share of Voice) — line chart for ≥2 weeks, bar fallback for 1 week.
          Renamed from "Market Share" in V2: the 8-group cohort isn't a real
          market with a defined denominator (Circle Chart, etc.), so the
          honest label is Share of Voice. P1 Twitter removal → SOV_WEIGHTS =
          유튜브 조회 33% / 커뮤니티 28% / 뉴스 22% / 구독자 17% (트위터 없음). */}
      {(() => {
        const distinctWeeks = share
          ? Array.from(new Set<string>(share.rows.map((r: any) => r.week_end)))
          : [];
        const hasTrend = distinctWeeks.length >= 2;
        return (
          <section class="card">
            <div class="mb-2 flex flex-wrap items-center gap-2 text-data">
              <h3 class="section-title">
                관심 점유율 (Share of Voice) {hasTrend ? "Trend (13주)" : "(현재 주)"}
              </h3>
              <span class="text-hint text-zinc-500">
                8개 그룹 안에서 항목별 순위(백분위)를 매겨 가중평균 — 유튜브 조회 33% / 커뮤니티 28% / 뉴스 22% / 구독자 17%
              </span>
              <HealthSpec />
              {hasTrend && (
                <label class="ml-auto flex items-center gap-1 text-hint text-zinc-400">
                  <input type="checkbox" checked={excludePlave}
                         onChange={(e: any) => setExcludePlave(e.currentTarget.checked)} />
                  PLAVE 제외
                </label>
              )}
              <ExportMenu canvas={shareCanvasEl ?? undefined}
                           rows={share?.rows ?? []}
                           filenameBase="share-of-voice" />
            </div>
            {hasTrend ? (
              <div class="h-48 md:h-72"><canvas ref={setShareCanvasEl}></canvas></div>
            ) : share && share.rows.length > 0 ? (
              <>
                <div class="mb-2 text-hint text-zinc-500">
                  추이 그래프는 데이터 2주 이상 누적 시 활성화됩니다 (현재 1주차).
                  지금은 이번 주 관심 점유율만 표시.
                </div>
                {/* v3: 점유율이 카테고리별 독립 산출(각 합 100%)이라 랭킹
                    바도 도메인별로 나눠 그린다 — 섞으면 분모가 다른 %가
                    한 줄에 놓여 오독을 만든다. */}
                {(["kpop", "subculture"] as Category[]).map((cat) => {
                  const rows = [...share.rows]
                    .filter((r: any) =>
                      categoryOf(market.groups[r.group_key]?.group_model) === cat)
                    .sort((a: any, b: any) => b.final - a.final);
                  if (!rows.length) return null;
                  return (
                    <div key={cat} class="mb-3">
                      <div class="mb-1 text-hint text-zinc-500">
                        {CATEGORY_LABEL[cat]} (카테고리 내 합 100%)
                      </div>
                      <ul class="space-y-1.5">
                        {rows.map((r: any) => (
                          <li key={r.group_key} class="flex items-center gap-2 text-data">
                            <span class="w-20 shrink-0 truncate"
                                  style={{ color: colorOf(r.group_key) }}>
                              {(market.groups[r.group_key]?.name) ?? r.group_key.toUpperCase()}
                            </span>
                            {r.tier != null && (
                              <span class="shrink-0 rounded bg-zinc-800 px-1 py-[1px] text-[10px] tabular-nums text-zinc-400"
                                    title="관심 규모 티어 — 최근 90일 조회 흐름의 log 갭 클러스터 (1=선두)">
                                T{r.tier}
                              </span>
                            )}
                            <div class="relative h-2 flex-1 overflow-hidden rounded bg-zinc-800/60">
                              <div class="absolute inset-y-0 left-0"
                                   style={{
                                     width: `${Math.min(r.final, 100)}%`,
                                     background: colorOf(r.group_key),
                                   }} />
                            </div>
                            <span class="w-14 shrink-0 text-right tabular-nums">
                              {r.final.toFixed(1)}%
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </>
            ) : (
              <div class="text-hint text-zinc-500">아직 관심 점유율 데이터가 없습니다.</div>
            )}
          </section>
        );
      })()}

      <DebutCurve />
    </div>
  );
}
