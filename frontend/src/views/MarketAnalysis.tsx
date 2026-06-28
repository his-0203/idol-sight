// MarketAnalysis — MiiWAN 브리핑의 '시장 분석' 서브뷰.
//
// 단순 점수 나열을 거부하고, 4개 설계 에이전트 합의를 화면으로:
//   헤드라인(자동요약) → 신뢰게이트 → PRI 우선순위·순차베팅 → 사분면(어디를)
//   → 국가 드릴다운('왜') → 점유집중도 → 굿즈 → 보류함.
// 모든 해석/플래그/경고는 점수를 바꾸지 않는다. 표본부족은 분리한다.

import { useMemo, useRef, useState } from "preact/hooks";
import { EmptyState } from "../components/EmptyState";
import { Tooltip } from "../components/Tooltip";
import { QuadrantScatter } from "../components/QuadrantScatter";
import { RegionDonut, type DonutSegment } from "../components/RegionDonut";
import {
  enrichCountries, headline, bettingQueue, hhi, hhiLabel, cr3,
  QUADRANT_LABEL, TIER_LABEL_KO, FANDOM_LABEL, metaOf, fmtGrowthPct,
  conclusion, weaknessAdvice,
  type CountryRow, type EnrichedCountry, type ConclusionTone,
} from "../lib/marketAnalysis";
import {
  allocateMerch, estimateDemandFloor, gradeWillingnessToPay,
} from "../lib/decisionSupport";
import { fmt } from "../format";

type CountryApi = {
  country: string; watch_share: number; growth_mom: number | null;
  retention_rel: number; sub_per_1k: number;
  watch_minutes: number | null; organic_share: number | null;
  subs_gained: number | null;
};
export type AnalyticsApi = {
  snapshot_at: string;
  countries: CountryApi[];
  returning_viewers_30d: number | null;
  membership_count: number | null;
  membership_penetration: number | null;
  has_super_chat: boolean | null;
} | null;
export type MemberPopApi = Array<{
  member_id: number; name: string; composite_score: number | null;
  yt_avg_views: number | null; sufficient: boolean;
}>;

const TIER_TONE: Record<string, string> = {
  candidate: "text-cyan-300", test: "text-violet-300",
  watch: "text-slate-400", insufficient: "text-zinc-500",
};
const CONCLUSION_TONE: Record<ConclusionTone, string> = {
  go: "border-cyan-500/40 bg-cyan-500/15 text-cyan-200",
  test: "border-emerald-500/40 bg-emerald-500/15 text-emerald-200",
  watch: "border-zinc-600/40 bg-zinc-700/30 text-zinc-300",
  hold: "border-red-500/40 bg-red-500/15 text-red-200",
  home: "border-amber-500/40 bg-amber-500/15 text-amber-200",
};

// 용어 인라인 툴팁 — hover/focus/클릭 시 실제 팝오버(native title 은 지연·
// 비접근성이라 디자인된 Tooltip 컴포넌트 사용).
function Term({ children, hint }: { children: any; hint: string }) {
  return <Tooltip content={hint}>{children}</Tooltip>;
}

// L0~L4 액션 단계를 숫자 코드 대신 진행바로 — "어디까지 왔나"를 위치로.
const RUNG_STEPS = ["관찰", "자막", "유료광고", "현지PR", "진출"];
const RUNG_IDX: Record<string, number> = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };
function RungBar({ rung }: { rung: string }) {
  const cur = RUNG_IDX[rung] ?? 0;
  return (
    <div class="flex gap-0.5" role="progressbar"
      aria-label={`진출 단계: ${RUNG_STEPS[cur]} (${cur + 1}/${RUNG_STEPS.length})`}
      aria-valuenow={cur} aria-valuemin={0} aria-valuemax={RUNG_STEPS.length - 1}>
      {RUNG_STEPS.map((s, i) => (
        <div key={i}
          class={"flex-1 rounded px-1 py-0.5 text-center text-[9px] "
            + (i === cur ? "bg-cyan-500/70 font-semibold text-white"
              : i < cur ? "bg-cyan-500/20 text-cyan-300" : "bg-zinc-800 text-zinc-500")}>
          {i === cur ? `▸ ${s}` : s}
        </div>
      ))}
    </div>
  );
}

const DRIVER_HINT: Record<string, string> = {
  "뜨는 중?": "한 달 전보다 시청이 늘고 있나 (성장세). 막대가 길수록 빠르게 큼.",
  "끝까지": "영상을 끝까지 보는 비율 — 한국(본진) 대비 배수. 길수록 더 잘 봄.",
  "팬 전환": "1,000번 봤을 때 새 구독자 몇 명. 관심이 팬으로 바뀌는 강도.",
  "시청 비중": "해외 시청 중 이 나라가 차지하는 몫(크기). 점수엔 10%만 반영.",
};

export function MarketAnalysis({
  analytics, memberPopularity, daysToDebut,
}: {
  analytics: AnalyticsApi; memberPopularity: MemberPopApi; daysToDebut: number | null;
}) {
  // growth_mom null = 직전 30일 데이터 없음(신규). 엔진엔 0으로 넣되(중립),
  // 산점도에는 '성장 알려진' 국가만 그려 데뷔 초기 x=0 무더기를 방지한다.
  // useMemo 로 묶어 매 렌더(클릭·토글) 재계산을 막고 enriched 의존성을 정합화.
  const raw: CountryRow[] = useMemo(() => (analytics?.countries ?? []).map((c) => ({
    country: c.country, watchShare: c.watch_share, growthMoM: c.growth_mom ?? 0,
    retentionRel: c.retention_rel, subPer1k: c.sub_per_1k,
    watchMinutes: c.watch_minutes, organicShare: c.organic_share,
    subsGained: c.subs_gained,
  })), [analytics]);
  const growthKnown = useMemo(
    () => new Set((analytics?.countries ?? []).filter((c) => c.growth_mom != null).map((c) => c.country)),
    [analytics],
  );
  const enriched = useMemo(() => enrichCountries(raw, daysToDebut), [raw, daysToDebut]);
  const derived = useMemo(() => {
    const sufficient = enriched.filter((e) => !e.insufficient);
    const overseas = sufficient.filter((e) => e.row.country !== "KR"); // 본진 제외
    return {
      sufficient,
      insufficient: enriched.filter((e) => e.insufficient),
      scatterCountries: enriched.filter((e) => growthKnown.has(e.row.country)),
      queue: bettingQueue(enriched),
      byPri: [...overseas].sort((a, b) => b.pri - a.pri), // 진출 매력도 = 해외만
      h: hhi(overseas.map((e) => e.row)),                  // 점유 집중도 = 해외
      cr3pct: Math.round(cr3(overseas.map((e) => e.row)) * 100),
    };
  }, [enriched, growthKnown]);
  const { sufficient, insufficient, scatterCountries, queue, byPri, h, cr3pct } = derived;
  const growthPending = enriched.length - scatterCountries.length;

  const [selected, setSelected] = useState<string | null>(null);
  // 비전문가 배려 — 지표 안내는 기본 닫힘(첫 화면 단순화). 필요할 때 펼친다.
  const [showHelp, setShowHelp] = useState(false);
  const [donutMetric, setDonutMetric] = useState<"subs" | "share" | "minutes">("share");
  const donut = useMemo(() => {
    const val = (e: EnrichedCountry) => donutMetric === "subs" ? (e.row.subsGained ?? 0)
      : donutMetric === "minutes" ? (e.row.watchMinutes ?? 0) : e.row.watchShare;
    // 국가별 분포(권역으로 뭉치지 않고 세분화) — 상위 9개국 + '기타'.
    const items = enriched.map((e) => ({ country: e.row.country, value: Math.max(0, val(e)) }))
      .filter((x) => x.value > 0).sort((a, b) => b.value - a.value);
    const TOP = 9;
    const segments = items.slice(0, TOP).map((x) => ({ label: x.country, value: x.value }));
    const restSum = items.slice(TOP).reduce((s, x) => s + x.value, 0);
    if (restSum > 0) segments.push({ label: `기타 ${items.length - TOP}개국`, value: restSum });
    // '오래 보는 곳' 순위 — 충분국, 유지율 내림차순 상위 8.
    const retention = enriched.filter((e) => !e.insufficient)
      .map((e) => ({ label: e.row.country, ret: e.row.retentionRel }))
      .sort((a, b) => b.ret - a.ret).slice(0, 8);
    return { segments, retention };
  }, [enriched, donutMetric]);
  // 지도/점수에서 클릭하면 드릴다운이 화면 밖(위)이라 단절 → 부드럽게 스크롤.
  const drilldownRef = useRef<HTMLDivElement>(null);
  const selectCountry = (country: string) => {
    setSelected(country);
    requestAnimationFrame(() => drilldownRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  };
  const sel = enriched.find((e) => e.row.country === selected)
    ?? [...sufficient].sort((a, b) => b.score - a.score)[0]
    ?? enriched[0] ?? null;

  if (!analytics || enriched.length === 0) {
    return (
      <EmptyState
        title="시장 분석 데이터 대기"
        hint="미완소년 소유자 OAuth(YouTube Analytics)가 수집되면 국가별 진출 분석이 여기에 채워집니다. (collector: youtube-analytics)"
        icon="🌏"
      />
    );
  }

  const dPlus = daysToDebut != null && daysToDebut <= 0 ? `D+${-daysToDebut}` : "데뷔 전";

  return (
    <div class="space-y-6">
      {/* 헤드라인 자동요약 + 도움말 토글 */}
      <section class="rounded-card border border-cyan-500/20 bg-cyan-500/[0.06] p-4">
        <div class="flex items-start justify-between gap-3">
          <div>
            <div class="text-hint mb-1 text-cyan-300/80">📋 이번 주 추천 — 무엇부터 할까 ({dPlus} · 갱신 {analytics.snapshot_at.slice(0, 10)})</div>
            <div class="text-sm font-semibold text-zinc-100">{headline(enriched)}</div>
            <div class="mt-0.5 text-hint text-zinc-500">아래는 "왜 그런지" 근거입니다. 모르는 용어는 오른쪽 ? 를 보세요.</div>
          </div>
          <button type="button" onClick={() => setShowHelp((v) => !v)}
            aria-expanded={showHelp}
            class="shrink-0 rounded-full border border-zinc-600 px-2 py-0.5 text-xs text-zinc-400 hover:border-zinc-400 hover:text-zinc-200">
            {showHelp ? "✕ 닫기" : "? 지표 안내"}
          </button>
        </div>
        {showHelp && <HelpPanel />}
      </section>

      {/* 신뢰 게이트 — 메타 정보라 한 줄 요약 + 접기(비전문가 첫 화면 단순화) */}
      <details class="rounded-card border border-zinc-800 bg-zinc-900/40">
        <summary class="cursor-pointer list-none px-3 py-2 text-xs text-zinc-400 marker:content-none">
          📊 데이터 신뢰도 — 충분 <span class="text-emerald-300">{sufficient.length}</span>개국 · 보류 {insufficient.length}개국 · 쏠림 {hhiLabel(h)} <span class="text-zinc-500">(자세히 ▾)</span>
        </summary>
        <div class="grid grid-cols-2 gap-2 px-3 pb-3 md:grid-cols-4">
          <GateCard label="추적 국가" value={`${enriched.length}개국`} />
          <GateCard label="충분 표본" value={`${sufficient.length}개국`} tone="ok" />
          <GateCard label="보류(데이터 부족)" value={`${insufficient.length}개국`} tone="muted" />
          <GateCard label="해외 점유 쏠림" value={`${hhiLabel(h)} · TOP3 ${cr3pct}%`} />
        </div>
      </details>

      {/* 1) 진출 우선순위(매력도) — 주인공: '어디부터 돈을 쓸까' */}
      <section class="rounded-card border border-violet-500/25 bg-violet-500/[0.04] p-4">
        <h3 class="section-title mb-1">💰 진출 우선순위 — 어디부터 돈을 쓸까 (핵심)</h3>
        <p class="text-hint mb-3 text-zinc-400">
          한정된 예산으로 <strong class="text-zinc-300">실제 어느 나라부터 돈을 쓸지</strong>. 데이터 점수에{" "}
          <Term hint="언어 장벽·결제 인프라·배송 가능성·규제 — 실제로 들어가기 쉬운가">진입 난이도</Term>까지 반영한 실행 순위라, 아래 '유망도 점수'와 순위가 다를 수 있어요. 100에 가까울수록 매력적.
        </p>
        <div class="grid gap-4 md:grid-cols-2">
          <div class="rounded-card border border-zinc-800 bg-zinc-900/40 p-3">
            <div class="mb-2 text-xs font-semibold text-zinc-400">진출 매력도 랭킹 (100점 만점) · 클릭 → 왜</div>
            <div class="space-y-1">
              {byPri.slice(0, 8).map((e, i) => (
                <button key={e.row.country} type="button"
                  onClick={() => selectCountry(e.row.country)}
                  class={"flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-zinc-800/60 "
                    + (sel?.row.country === e.row.country ? "bg-zinc-800/80" : "")}>
                  <span class="w-4 shrink-0 text-right text-xs text-zinc-500">{i + 1}</span>
                  <span class="w-8 shrink-0 text-sm text-zinc-300">{e.row.country}</span>
                  <div class="h-2.5 flex-1 overflow-hidden rounded bg-zinc-800">
                    <div class="h-full rounded bg-violet-500/60" style={{ width: `${Math.round(e.pri * 100)}%` }} />
                  </div>
                  <span class="w-9 shrink-0 text-right text-xs tabular-nums text-zinc-400">{Math.round(e.pri * 100)}</span>
                </button>
              ))}
            </div>
          </div>
          <div class="rounded-card border border-zinc-800 bg-zinc-900/40 p-3">
            <div class="mb-2 text-xs font-semibold text-zinc-400">예산 배분 계획</div>
            <p class="mb-2 text-hint text-zinc-500">예산을 흩으면 효과 측정이 어려워 한 번에 2곳만 집중합니다. 자막 테스트는 무료라 여러 곳 동시 가능.</p>
            <div class="space-y-2 text-xs">
              <QueueRow label="🎯 지금 광고할 곳 (2곳까지)" tone="text-cyan-300"
                items={queue.paidSlots.map((e) => e.row.country)} />
              <QueueRow label="🈂️ 자막 효과 테스트 (무료·동시 가능)" tone="text-emerald-300"
                items={queue.subtitleEligible.map((e) => e.row.country)} />
              <QueueRow label="⏸ 다음 차례 (대기)" tone="text-zinc-400"
                items={queue.paidQueue.map((e) => e.row.country)} />
            </div>
          </div>
        </div>
      </section>

      {/* 2) 국가 드릴다운 — '왜' (위 랭킹/아래 지도에서 클릭하면 갱신) */}
      <div ref={drilldownRef}>{sel && <CountryDrilldown e={sel} />}</div>

      {/* 2.5) 우리 채널 현황 — 권역별 분포 도넛 (본진 포함, 서술용) */}
      <section>
        <h3 class="section-title mb-1">🍩 우리 채널 현황 — 어느 나라에서 보고 구독하나</h3>
        <p class="text-hint mb-3 text-zinc-500">국가별 분포(상위 9개국 + 기타), 본진 포함. 토글로 구독·시청 전환.</p>
        <div role="tablist" class="mb-3 inline-flex gap-1 card p-1">
          {([["share", "시청 비중"], ["minutes", "시청 시간"], ["subs", "구독 유입"]] as const).map(([k, label]) => {
            const on = donutMetric === k;
            return (
              <button key={k} role="tab" aria-selected={on}
                class={"rounded-md px-3 py-1 text-xs font-medium transition "
                  + (on ? "bg-zinc-800 text-cyan-300" : "text-zinc-400 hover:text-zinc-200")}
                onClick={() => setDonutMetric(k)}>{label}</button>
            );
          })}
        </div>
        <div class="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
          <div class="rounded-card border border-zinc-800 bg-zinc-900/40 p-3">
            {donut.segments.some((s) => s.value > 0) ? (
              <RegionDonut segments={donut.segments as DonutSegment[]}
                fmt={(v) => donutMetric === "subs" ? `${fmt(Math.round(v))}명`
                  : donutMetric === "minutes" ? `${fmt(Math.round(v))}분`
                  : `${(v * 100).toFixed(1)}%`} />
            ) : (
              <div class="flex h-56 items-center justify-center text-center text-xs text-zinc-500">
                {donutMetric === "subs" ? "구독 유입 데이터 누적 중 (다음 수집부터)" : "데이터 없음"}
              </div>
            )}
          </div>
          <div class="rounded-card border border-zinc-800 bg-zinc-900/40 p-3">
            <div class="mb-2 text-xs font-semibold text-zinc-400">오래 보는 곳 순위 (끝까지 보는 정도, 본진 대비)</div>
            <div class="space-y-1.5">
              {donut.retention.map((r) => (
                <div key={r.label} class="flex items-center gap-2">
                  <span class="w-16 shrink-0 truncate text-xs text-zinc-300">{r.label}</span>
                  <div class="h-2.5 flex-1 overflow-hidden rounded bg-zinc-800">
                    <div class={"h-full rounded " + (r.ret >= 1 ? "bg-emerald-500/60" : "bg-amber-500/50")}
                      style={{ width: `${Math.min(100, (r.ret / 1.5) * 100)}%` }} />
                  </div>
                  <span class="w-12 shrink-0 text-right text-xs tabular-nums text-zinc-400">{r.ret.toFixed(2)}×</span>
                </div>
              ))}
            </div>
            <p class="mt-2 text-hint text-zinc-500">1.0× = 본진(한국)과 동등. 길수록 오래(끝까지) 봄.</p>
          </div>
        </div>
      </section>

      {/* 3) 시장 지도(사분면) + 유망도 점수(참고·접기) */}
      <section>
        <h3 class="section-title mb-1">🗺️ 시장 지도 — 유망한 곳 둘러보기 (참고)</h3>
        <p class="text-hint mb-1 text-zinc-400">
          👉 <strong class="text-zinc-300">오른쪽일수록 뜨는 중, 위일수록 끝까지 봄.</strong> 오른쪽 위(초록)가 명당,
          <strong class="text-emerald-300"> 위쪽일수록 팬덤이 안착하기 좋은 곳</strong>입니다. 버블을 누르면 위에 '왜'가 펼쳐져요.
        </p>
        <p class="text-hint mb-3 text-zinc-500">
          버블 크기 = 시청 비중 · 색 = 등급(🔵0순위 🟣검증중 ⚪지켜보기) · 흐림 = 데이터 부족 ·
          <span class="text-amber-300"> 금테 = 본진(한국)</span>.
          {growthPending > 0 && <> 성장 데이터 누적 중인 {growthPending}개국은 그림에서 빠지고 점수 목록엔 있습니다.</>}
        </p>
        <div class="rounded-card border border-zinc-800 bg-zinc-900/40 p-3">
          {scatterCountries.length > 0 ? (
            <QuadrantScatter countries={scatterCountries} selected={sel?.row.country ?? null} onSelect={selectCountry} />
          ) : (
            <div class="flex h-80 items-center justify-center text-center text-sm text-zinc-500">
              성장 데이터 누적 중 — 30일 윈도우가 차면 지도가 채워집니다.<br />그 전까지는 위 '진출 우선순위'와 아래 점수로 판단하세요.
            </div>
          )}
        </div>
        <details class="mt-3 rounded-card border border-zinc-800 bg-zinc-900/40">
          <summary class="cursor-pointer list-none px-3 py-2 text-xs text-zinc-400 marker:content-none">
            📊 유망도 점수 랭킹 (참고) <span class="text-zinc-500">— 데이터 신호만 본 잠재력. 실제 돈 쓸 순서는 위 '진출 우선순위' (펼치기 ▾)</span>
          </summary>
          <div class="space-y-1 px-3 pb-3">
            {[...enriched].sort((a, b) => b.score - a.score).slice(0, 12).map((e) => (
              <button key={e.row.country} type="button"
                onClick={() => selectCountry(e.row.country)}
                class={"flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-zinc-800/60 "
                  + (sel?.row.country === e.row.country ? "bg-zinc-800/80" : "")}>
                <span class="w-8 shrink-0 text-sm font-medium text-zinc-300">{e.row.country}</span>
                {e.row.country === "KR" && <span class="shrink-0 rounded border border-amber-500/40 px-1 text-[9px] text-amber-300">본진</span>}
                <div class="h-2.5 flex-1 overflow-hidden rounded bg-zinc-800">
                  <div class={"h-full rounded " + (e.insufficient ? "bg-zinc-600 opacity-50" : "bg-cyan-500/60")}
                    style={{ width: `${e.score}%` }} />
                </div>
                <span class="w-7 shrink-0 text-right text-xs tabular-nums text-zinc-400">{e.score}</span>
                {e.insufficient && <span class="text-[10px] text-amber-400">⚠</span>}
              </button>
            ))}
          </div>
        </details>
      </section>

      {/* 굿즈 — 시장 분석과 별개 작업이라 접이식(첫 화면 부담 완화) */}
      <details class="rounded-card border border-zinc-800 bg-zinc-900/40">
        <summary class="cursor-pointer list-none px-4 py-3 marker:content-none">
          <span class="section-title">🎁 굿즈 제작</span>
          <span class="ml-2 text-xs text-zinc-500">멤버 배분·수량·가격 <span class="text-zinc-500">(펼치기 ▾)</span></span>
        </summary>
        <div class="px-4 pb-4">
          <GoodsBoard memberPopularity={memberPopularity} analytics={analytics} />
        </div>
      </details>

      {/* 보류함 — 접이식 */}
      {insufficient.length > 0 && (
        <details class="rounded-card border border-zinc-800 bg-zinc-900/40">
          <summary class="cursor-pointer list-none px-4 py-3 text-sm text-zinc-400 marker:content-none">
            ⏸ 데이터 부족으로 보류 중 — {insufficient.length}개국 <span class="text-zinc-500">(펼치기 ▾)</span>
          </summary>
          <div class="px-4 pb-4">
            <p class="text-hint mb-2 text-zinc-500">노이즈를 결정으로 오인하지 않도록 분리. 데이터가 더 모이면 결정 영역으로 올라옵니다.</p>
            <div class="flex flex-wrap gap-1.5">
              {insufficient.map((e) => (
                <span key={e.row.country} class="rounded border border-zinc-700/50 bg-zinc-800/40 px-2 py-0.5 text-xs text-zinc-400">
                  {e.row.country} <span class="text-zinc-500">{(e.row.watchShare * 100).toFixed(2)}%</span>
                </span>
              ))}
            </div>
          </div>
        </details>
      )}
    </div>
  );
}

function GateCard({ label, value, tone }: { label: string; value: string; tone?: "ok" | "muted" }) {
  const c = tone === "ok" ? "text-emerald-300" : tone === "muted" ? "text-zinc-500" : "text-zinc-200";
  return (
    <div class="rounded-card border border-zinc-800 bg-zinc-900/40 p-3">
      <div class="text-hint text-zinc-500">{label}</div>
      <div class={"mt-0.5 text-sm font-semibold " + c}>{value}</div>
    </div>
  );
}

function QueueRow({ label, items, tone }: { label: string; items: string[]; tone: string }) {
  return (
    <div>
      <div class={"mb-0.5 font-medium " + tone}>{label}</div>
      <div class="text-zinc-400">{items.length ? items.join(" · ") : <span class="text-zinc-500">없음</span>}</div>
    </div>
  );
}

// ─── 국가 '왜' 드릴다운 ──────────────────────────────────────────────
function CountryDrilldown({ e }: { e: EnrichedCountry }) {
  const m = metaOf(e.row.country);
  const concl = conclusion(e);
  const adv = weaknessAdvice(e);
  const retArrow = e.row.retentionRel >= 1 ? "🔼 국내보다 더 봄" : "🔻 국내보다 덜 봄";
  const drivers: Array<[string, number, string]> = [
    ["뜨는 중?", e.drivers.growth, fmtGrowthPct(e.row.growthMoM)],
    ["끝까지", e.drivers.retention, `${e.row.retentionRel.toFixed(2)}× (${retArrow})`],
    ["팬 전환", e.drivers.sub, `1k당 +${e.row.subPer1k.toFixed(1)}명`],
    ["시청 비중", e.drivers.share, `${(e.row.watchShare * 100).toFixed(1)}%`],
  ];
  const weakest = drivers.reduce((min, d) => (d[1] < min[1] ? d : min), drivers[0]!);

  return (
    <section class="rounded-card border-l-4 border border-zinc-800 bg-zinc-900/40 p-4"
      style={{ borderLeftColor: "#22d3ee" }}>
      <div class="mb-3">
        <div class="mb-1.5 flex items-center gap-2">
          <h3 class="text-lg font-bold text-zinc-100">{e.row.country}{e.row.country === "KR" && <span class="ml-1 text-xs text-amber-300">본진</span>}</h3>
        </div>
        {/* 한 줄 결론 — 주인공 */}
        <div class={"inline-block rounded-md border px-2.5 py-1 text-sm font-semibold " + CONCLUSION_TONE[concl.tone]}>{concl.text}</div>
        {/* 근거 — 강등(작게/회색). 5개 척도를 '근거'로 종속. */}
        <div class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-hint text-zinc-500">
          <span class="text-zinc-500">근거:</span>
          <span class={TIER_TONE[e.tier] ?? ""}>{e.interpretation.label}</span>
          <span>· {TIER_LABEL_KO[e.tier]} {e.score}점 · {QUADRANT_LABEL[e.quadrant]} ·</span>
          <Tooltip content="팬덤이 안착하기 좋은 환경 — 끝까지 보고(몰입)·구독하고(헌신)·자연 유입(자생성)되는가.">
            <span>팬덤 안착 {FANDOM_LABEL[e.fandom.level]}</span>
          </Tooltip>
          {e.insufficient && <span class="text-amber-400">· 데이터 부족</span>}
        </div>
      </div>

      <div class="grid gap-4 md:grid-cols-[1fr_1.2fr]">
        {/* 4드라이버 분해 */}
        <div class="space-y-1.5">
          {drivers.map(([name, norm, raw]) => (
            <div key={name} class="flex items-center gap-2">
              <span class="w-14 shrink-0 text-xs text-zinc-400">
                <Term hint={DRIVER_HINT[name] ?? ""}>{name}</Term>
              </span>
              <div class="h-3 flex-1 overflow-hidden rounded bg-zinc-800">
                <div class={"h-full rounded " + (name === weakest[0] ? "bg-amber-500/60" : "bg-cyan-500/50")}
                  style={{ width: `${Math.round(norm * 100)}%` }} />
              </div>
              <span class="w-20 shrink-0 text-right text-xs tabular-nums text-zinc-400">{raw}</span>
              {name === weakest[0] && <span class="text-[10px] text-amber-400">⚠ 약점</span>}
            </div>
          ))}
          <div class="pt-1 text-hint text-zinc-500">
            시장: {m.market} · 언어격차: {m.langGap} · 교포: {m.diasporaKr}
            {e.row.watchMinutes != null && <> · 표본 {fmt(e.row.watchMinutes)}분</>}
          </div>
          {e.row.organicShare != null && (
            <div class="text-hint text-zinc-500">
              유입 품질: 오가닉(검색·추천) {Math.round(e.row.organicShare * 100)}% vs
              외부·공유 {Math.round((1 - e.row.organicShare) * 100)}%
              {e.row.organicShare >= 0.6
                ? " — 자생 수요(진출 신뢰↑)"
                : " — 외부 유입 비중 큼(휘발 주의)"}
            </div>
          )}
        </div>

        {/* 해석 + 액션 */}
        <div class="space-y-2">
          <p class="text-sm leading-relaxed text-zinc-300">{e.interpretation.narrative}</p>
          {e.flags.map((f, i) => (
            <p key={i} class="text-xs text-zinc-500">ℹ️ 참고: {f}</p>
          ))}
          {e.warnings.map((w, i) => (
            <p key={i} class="rounded border border-amber-500/20 bg-amber-500/[0.06] px-2 py-1 text-xs text-amber-300/90">⚠️ 주의: {w}</p>
          ))}
          {/* 약점 진단 — 단정 않고 가능성 2~3개를 유력 순으로 */}
          <div class="rounded-lg border border-amber-500/25 bg-amber-500/[0.04] p-3">
            <div class="mb-2 flex items-baseline gap-1.5">
              <span class="text-xs font-semibold text-amber-300">⚠ 약점: {adv.driver}</span>
              <span class="text-hint text-zinc-500">— 원인 단정 어려워 가능성 순</span>
            </div>
            <div class="space-y-1.5">
              {adv.hypotheses.map((h, i) => (
                <div key={i} class="rounded-md bg-zinc-900/50 p-2">
                  <div class="mb-0.5 flex items-center gap-1.5">
                    <span class="text-[10px] tabular-nums text-zinc-500">{i + 1}</span>
                    <span class={"rounded px-1 py-px text-[9px] font-medium "
                      + (h.likely ? "bg-cyan-500/20 text-cyan-300" : "bg-zinc-700/40 text-zinc-400")}>
                      {h.likely ? "유력" : "가능"}
                    </span>
                    <span class="text-xs text-zinc-300">{h.why}</span>
                  </div>
                  <div class="pl-4 text-xs text-emerald-300/90">→ {h.fix}</div>
                </div>
              ))}
            </div>
          </div>
          {/* 엔진 추천 — 지금 할 한 가지 */}
          <div class="rounded-lg border border-cyan-700/40 bg-cyan-500/[0.05] p-3">
            <div class="mb-1 text-xs font-semibold text-cyan-300">➜ 지금 할 한 가지 (추천)</div>
            <div class="text-sm font-medium text-zinc-100">{e.action.verb}</div>
            <div class="mt-1.5"><RungBar rung={e.action.costTier} /></div>
            <div class="mt-1 flex flex-wrap items-center gap-x-2 text-hint text-zinc-500">
              <span>{e.action.owner} · {e.action.due}</span>
            </div>
            <div class="mt-1 text-hint text-zinc-500">성공 기준: {e.action.measurable}</div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── 굿즈 보드 (멤버배분 = 공개 프록시 / 수량·가격 = 대기) ──────────
function GoodsBoard({ memberPopularity, analytics }: {
  memberPopularity: MemberPopApi; analytics: AnalyticsApi;
}) {
  const alloc = allocateMerch(memberPopularity.map((m) => ({
    memberId: m.member_id, name: m.name, compositeScore: m.composite_score, sufficient: m.sufficient,
  }))).sort((a, b) => b.sharePct - a.sharePct);
  const demand = estimateDemandFloor({
    returningViewers30d: analytics?.returning_viewers_30d ?? null,
    membershipCount: analytics?.membership_count ?? null,
  });
  const wtp = gradeWillingnessToPay({
    membershipPenetration: analytics?.membership_penetration ?? null,
    hasSuperChat: analytics?.has_super_chat ?? null,
  });

  return (
    <section>
      <p class="text-hint mb-3 text-zinc-500">멤버 배분은 공개 인기 데이터로 가동. 총 수량·가격대는 멤버십/슈퍼챗(API 미제공) 연결 후 점등.</p>
      <div class="grid gap-4 md:grid-cols-[1.3fr_1fr]">
        <div class="rounded-card border border-zinc-800 bg-zinc-900/40 p-3">
          <div class="mb-2 text-xs font-semibold text-zinc-400">멤버별 배분 (포카 비율) · <span class="text-amber-300">추정</span></div>
          {alloc.length === 0 ? (
            <div class="text-xs text-zinc-500">멤버 인기 데이터 없음.</div>
          ) : alloc.map((m) => (
            <div key={m.memberId} class="mb-1.5 flex items-center gap-2">
              <span class="w-16 shrink-0 truncate text-sm text-zinc-300">{m.name}</span>
              <div class="h-3 flex-1 overflow-hidden rounded bg-zinc-800">
                <div class="h-full rounded bg-emerald-500/60" style={{ width: `${m.sharePct.toFixed(1)}%` }} />
              </div>
              <span class="w-12 shrink-0 text-right text-sm tabular-nums text-zinc-300">{m.sharePct.toFixed(1)}%</span>
            </div>
          ))}
          <p class="mt-1 text-hint text-zinc-500">하한 10%·상한 평균×2 — 0장·과잉생산 동시 방어.</p>
        </div>
        <div class="space-y-2">
          <PendingCard title="총 제작 수량 (하한)"
            value={demand.low == null ? null : `${fmt(demand.low)}~${fmt(demand.high)}개`}
            note={demand.note} />
          <PendingCard title="가격대 / 지불의향"
            value={wtp.tier === "unknown" ? null : wtp.tier === "premium" ? "프리미엄 여지" : "보급형 권장"}
            note={wtp.note} />
        </div>
      </div>
    </section>
  );
}

// ─── 도움말 — 지표/등급 안내 (? 버튼) ───────────────────────────────
function HelpPanel() {
  const Row = ({ k, v }: { k: string; v: string }) => (
    <div class="flex gap-2 py-0.5">
      <span class="w-16 shrink-0 font-medium text-zinc-300">{k}</span>
      <span class="text-zinc-400">{v}</span>
    </div>
  );
  return (
    <div class="mt-3 grid gap-4 border-t border-cyan-500/15 pt-3 text-xs md:grid-cols-2">
      <div>
        <div class="mb-1 font-semibold text-zinc-200">4개 핵심 지표</div>
        <Row k="성장" v="직전 30일 대비 시청시간 증감(모멘텀). 데뷔 초기엔 표본이 얇아 부정확할 수 있어 '신규'는 산점도에서 제외." />
        <Row k="유지율" v="영상을 끝까지 보는 정도 = 한국(본진) 대비 배수. 1.0×면 국내와 동등, <1이면 덜 봄(언어장벽 신호)." />
        <Row k="전환" v="1,000 조회당 새 구독자 수. 관심이 팬으로 바뀌는 강도." />
        <Row k="점유" v="전체 해외 시청시간 중 그 나라 비중." />
      </div>
      <div>
        <div class="mb-1 font-semibold text-zinc-200">세 가지 렌즈 (헷갈리지 않게)</div>
        <Row k="진출 매력도" v="★주인공★ '어디부터 돈을 쓸까'. 점수 + 진입 난이도(언어·결제·배송·규제)까지 반영한 실행 우선순위." />
        <Row k="유망도 점수" v="'이 나라가 얼마나 유망한가'(데이터 신호만: 성장35+끝까지30+전환25+크기10%). 잠재력 — 참고용." />
        <Row k="팬덤 안착" v="'지속될 팬층이 생기기 좋은가'. 끝까지 보고+구독하고+자연 유입되는가(성장·크기 무관)." />
        <div class="mb-1 mt-2 font-semibold text-zinc-200">기타</div>
        <Row k="tier" v="0순위 · 검증중 · 지켜보기 · 데이터 부족." />
        <Row k="L0~L4" v="액션 단계: 관찰 → 자막 → 유료광고 → 현지PR → 진출. 효과 미달 시 강등." />
        <Row k="본진" v="KR=한국 본진(유지율 기준선 1.0×). 진출 대상에 포함하되 금테로 구분." />
      </div>
    </div>
  );
}

function PendingCard({ title, value, note }: { title: string; value: string | null; note: string }) {
  return (
    <div class={"rounded-card border p-3 " + (value == null ? "border-dashed border-zinc-700 bg-zinc-900/30" : "border-zinc-800 bg-zinc-900/40")}>
      <div class="flex items-center gap-2">
        <span class="text-sm font-semibold text-zinc-300">{title}</span>
        {value == null && <span class="rounded border border-zinc-600/40 bg-zinc-700/30 px-1.5 py-0.5 text-[10px] text-zinc-400">대기</span>}
      </div>
      {value != null && <div class="mt-0.5 text-base font-semibold tabular-nums text-zinc-100">{value}</div>}
      <p class="mt-1 text-hint text-zinc-500">{note}</p>
    </div>
  );
}
