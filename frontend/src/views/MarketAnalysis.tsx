// MarketAnalysis — MiiWAN 브리핑의 '시장 분석' 서브뷰.
//
// 단순 점수 나열을 거부하고, 4개 설계 에이전트 합의를 화면으로:
//   헤드라인(자동요약) → 신뢰게이트 → 사분면(어디를) → 국가 드릴다운('왜')
//   → 점유집중도 → PRI 우선순위·순차베팅 → 굿즈 → 보류함.
// 모든 해석/플래그/경고는 점수를 바꾸지 않는다. 표본부족은 분리한다.

import { useMemo, useState } from "preact/hooks";
import { EmptyState } from "../components/EmptyState";
import { QuadrantScatter } from "../components/QuadrantScatter";
import {
  enrichCountries, headline, bettingQueue, hhi, hhiLabel, cr3,
  QUADRANT_LABEL, RUNG_LABEL, metaOf,
  type CountryRow, type EnrichedCountry,
} from "../lib/marketAnalysis";
import {
  allocateMerch, estimateDemandFloor, gradeWillingnessToPay,
} from "../lib/decisionSupport";
import { fmt } from "../format";

type CountryApi = {
  country: string; watch_share: number; growth_mom: number;
  retention_rel: number; sub_per_1k: number;
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

export function MarketAnalysis({
  analytics, memberPopularity, daysToDebut,
}: {
  analytics: AnalyticsApi; memberPopularity: MemberPopApi; daysToDebut: number | null;
}) {
  const raw: CountryRow[] = (analytics?.countries ?? []).map((c) => ({
    country: c.country, watchShare: c.watch_share, growthMoM: c.growth_mom,
    retentionRel: c.retention_rel, subPer1k: c.sub_per_1k,
  }));
  const enriched = useMemo(() => enrichCountries(raw), [analytics]);
  const sufficient = enriched.filter((e) => !e.insufficient);
  const insufficient = enriched.filter((e) => e.insufficient);

  const [selected, setSelected] = useState<string | null>(null);
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
  const h = hhi(sufficient.map((e) => e.row));
  const queue = bettingQueue(enriched);
  const byPri = [...sufficient].sort((a, b) => b.pri - a.pri);

  return (
    <div class="space-y-6">
      {/* 헤드라인 자동요약 */}
      <section class="rounded-card border border-cyan-500/20 bg-cyan-500/[0.06] p-4">
        <div class="text-hint mb-1 text-zinc-500">오늘의 한 줄 ({dPlus} · 갱신 {analytics.snapshot_at.slice(0, 10)})</div>
        <div class="text-sm font-semibold text-zinc-100">{headline(enriched)}</div>
      </section>

      {/* 신뢰 게이트 */}
      <section class="grid grid-cols-2 gap-2 md:grid-cols-4">
        <GateCard label="추적 국가" value={`${enriched.length}개국`} />
        <GateCard label="충분 표본" value={`${sufficient.length}개국`} tone="ok" />
        <GateCard label="보류(표본부족)" value={`${insufficient.length}개국`} tone="muted" />
        <GateCard label="점유 집중도" value={`${hhiLabel(h)} · TOP3 ${Math.round(cr3(sufficient.map((e) => e.row)) * 100)}%`} />
      </section>

      {/* 사분면 + 랭킹 */}
      <section>
        <h3 class="section-title mb-1">50개국 한눈에 — 모멘텀 × 품질</h3>
        <p class="text-hint mb-3 text-zinc-500">
          버블 클릭 → 아래 '왜' 분해. 크기=시청 점유, 색=tier(🔵후보 🟣테스트 ⚪관망), 흐림=표본부족.
        </p>
        <div class="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <div class="rounded-card border border-zinc-800 bg-zinc-900/40 p-3">
            <QuadrantScatter countries={enriched} selected={sel?.row.country ?? null} onSelect={setSelected} />
          </div>
          <div class="rounded-card border border-zinc-800 bg-zinc-900/40 p-3">
            <div class="mb-2 text-xs font-semibold text-zinc-400">진출 점수 랭킹 (Top 12)</div>
            <div class="space-y-1">
              {[...enriched].sort((a, b) => b.score - a.score).slice(0, 12).map((e) => (
                <button key={e.row.country} type="button"
                  onClick={() => setSelected(e.row.country)}
                  class={"flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-zinc-800/60 "
                    + (sel?.row.country === e.row.country ? "bg-zinc-800/80" : "")}>
                  <span class="w-8 shrink-0 text-sm font-medium text-zinc-300">{e.row.country}</span>
                  <div class="h-2.5 flex-1 overflow-hidden rounded bg-zinc-800">
                    <div class={"h-full rounded " + (e.insufficient ? "bg-zinc-600 opacity-50" : "bg-cyan-500/60")}
                      style={{ width: `${e.score}%` }} />
                  </div>
                  <span class="w-7 shrink-0 text-right text-xs tabular-nums text-zinc-400">{e.score}</span>
                  {e.insufficient && <span class="text-[10px] text-amber-400">⚠</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* 국가 드릴다운 — '왜' */}
      {sel && <CountryDrilldown e={sel} pop={raw} />}

      {/* PRI 우선순위 + 순차 베팅 */}
      <section>
        <h3 class="section-title mb-1">진출 우선순위 — 노력 대비 기대수익(PRI)</h3>
        <p class="text-hint mb-3 text-zinc-500">
          단순 점수가 아니라 (도달×전환×진입용이성×모멘텀). 유료 진출은 동시 2개국만 — 나머지는 대기.
        </p>
        <div class="grid gap-4 md:grid-cols-2">
          <div class="rounded-card border border-zinc-800 bg-zinc-900/40 p-3">
            <div class="mb-2 text-xs font-semibold text-zinc-400">PRI 랭킹</div>
            <div class="space-y-1">
              {byPri.slice(0, 8).map((e, i) => (
                <div key={e.row.country} class="flex items-center gap-2">
                  <span class="w-4 text-right text-xs text-zinc-600">{i + 1}</span>
                  <span class="w-8 text-sm text-zinc-300">{e.row.country}</span>
                  <div class="h-2 flex-1 overflow-hidden rounded bg-zinc-800">
                    <div class="h-full rounded bg-violet-500/60" style={{ width: `${Math.round(e.pri * 100)}%` }} />
                  </div>
                  <span class="w-9 text-right text-xs tabular-nums text-zinc-400">{e.pri.toFixed(2)}</span>
                </div>
              ))}
            </div>
          </div>
          <div class="rounded-card border border-zinc-800 bg-zinc-900/40 p-3">
            <div class="mb-2 text-xs font-semibold text-zinc-400">순차 베팅 큐</div>
            <div class="space-y-2 text-xs">
              <QueueRow label="🎯 유료 슬롯 (동시 2)" tone="text-cyan-300"
                items={queue.paidSlots.map((e) => e.row.country)} />
              <QueueRow label="🈂️ 자막 AB (무료·동시 가능)" tone="text-emerald-300"
                items={queue.subtitleEligible.map((e) => e.row.country)} />
              <QueueRow label="⏸ 유료 대기" tone="text-zinc-400"
                items={queue.paidQueue.map((e) => e.row.country)} />
            </div>
          </div>
        </div>
      </section>

      {/* 굿즈 */}
      <GoodsBoard memberPopularity={memberPopularity} analytics={analytics} />

      {/* 보류함 */}
      {insufficient.length > 0 && (
        <section>
          <h3 class="section-title mb-1">보류함 — 표본 부족 ({insufficient.length}개국)</h3>
          <p class="text-hint mb-2 text-zinc-500">노이즈를 결정으로 오인하지 않도록 분리. 표본 누적되면 결정 영역으로 승격.</p>
          <div class="flex flex-wrap gap-1.5">
            {insufficient.map((e) => (
              <span key={e.row.country} class="rounded border border-zinc-700/50 bg-zinc-800/40 px-2 py-0.5 text-xs text-zinc-400">
                {e.row.country} <span class="text-zinc-600">{(e.row.watchShare * 100).toFixed(2)}%</span>
              </span>
            ))}
          </div>
        </section>
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
      <div class="text-zinc-400">{items.length ? items.join(" · ") : <span class="text-zinc-600">없음</span>}</div>
    </div>
  );
}

// ─── 국가 '왜' 드릴다운 ──────────────────────────────────────────────
function CountryDrilldown({ e, pop }: { e: EnrichedCountry; pop: CountryRow[] }) {
  void pop;
  const m = metaOf(e.row.country);
  const drivers: Array<[string, number, string]> = [
    ["성장", e.drivers.growth, `${e.row.growthMoM >= 0 ? "+" : ""}${Math.round(e.row.growthMoM * 100)}%`],
    ["유지율", e.drivers.retention, `${e.row.retentionRel.toFixed(2)}× 국내`],
    ["전환", e.drivers.sub, `${e.row.subPer1k.toFixed(1)}/1k`],
    ["점유", e.drivers.share, `${(e.row.watchShare * 100).toFixed(1)}%`],
  ];
  const weakest = drivers.reduce((min, d) => (d[1] < min[1] ? d : min), drivers[0]!);

  return (
    <section class="rounded-card border-l-4 border border-zinc-800 bg-zinc-900/40 p-4"
      style={{ borderLeftColor: "#22d3ee" }}>
      <div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 class="text-lg font-bold text-zinc-100">{e.row.country}</h3>
        <span class={"text-sm font-semibold " + (TIER_TONE[e.tier] ?? "")}>{e.interpretation.label}</span>
        <span class="text-sm tabular-nums text-zinc-300">{e.score}점</span>
        <span class="text-hint text-zinc-500">{QUADRANT_LABEL[e.quadrant]} · {RUNG_LABEL[e.rung]}</span>
        {e.insufficient && <span class="rounded border border-amber-500/30 bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">표본부족</span>}
      </div>

      <div class="grid gap-4 md:grid-cols-[1fr_1.2fr]">
        {/* 4드라이버 분해 */}
        <div class="space-y-1.5">
          {drivers.map(([name, norm, raw]) => (
            <div key={name} class="flex items-center gap-2">
              <span class="w-12 shrink-0 text-xs text-zinc-400">{name}</span>
              <div class="h-3 flex-1 overflow-hidden rounded bg-zinc-800">
                <div class={"h-full rounded " + (name === weakest[0] ? "bg-amber-500/60" : "bg-cyan-500/50")}
                  style={{ width: `${Math.round(norm * 100)}%` }} />
              </div>
              <span class="w-20 shrink-0 text-right text-xs tabular-nums text-zinc-400">{raw}</span>
              {name === weakest[0] && <span class="text-[10px] text-amber-400">⚠ 약점</span>}
            </div>
          ))}
          <div class="pt-1 text-[11px] text-zinc-600">
            시장: {m.market} · 언어격차: {m.langGap} · 교포: {m.diasporaKr}
          </div>
        </div>

        {/* 해석 + 액션 */}
        <div class="space-y-2">
          <p class="text-sm leading-relaxed text-zinc-300">{e.interpretation.narrative}</p>
          {e.flags.map((f, i) => (
            <p key={i} class="text-xs text-zinc-500">🏳️ {f}</p>
          ))}
          {e.warnings.map((w, i) => (
            <p key={i} class="rounded border border-amber-500/20 bg-amber-500/[0.06] px-2 py-1 text-xs text-amber-300/90">⚠️ {w}</p>
          ))}
          {/* 액션 카드 */}
          <div class="rounded border border-zinc-700/60 bg-zinc-800/40 p-2.5">
            <div class="mb-1 flex items-center gap-2">
              <span class="rounded bg-zinc-700/60 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-300">{e.action.costTier} · {RUNG_LABEL[e.action.costTier]}</span>
              <span class="text-[10px] text-zinc-500">{e.action.owner} · {e.action.due}</span>
            </div>
            <div class="text-sm font-medium text-zinc-200">{e.action.verb}</div>
            <div class="mt-1 text-xs text-zinc-500">측정: {e.action.measurable}</div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── 굿즈 보드 (멤버배분 = 공개 프록시 / 수량·가격 = 대기) ──────────
function GoodsBoard({ memberPopularity, analytics }: { memberPopularity: MemberPopApi; analytics: AnalyticsApi }) {
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
      <h3 class="section-title mb-1">굿즈 제작</h3>
      <p class="text-hint mb-3 text-zinc-500">멤버 배분은 공개 인기 데이터로 가동. 총 수량·가격대는 멤버십/슈퍼챗(API 미제공) 연결 후 점등.</p>
      <div class="grid gap-4 md:grid-cols-[1.3fr_1fr]">
        <div class="rounded-card border border-zinc-800 bg-zinc-900/40 p-3">
          <div class="mb-2 text-xs font-semibold text-zinc-400">멤버별 배분 (포카 비율) · <span class="text-amber-300">추정</span></div>
          {alloc.length === 0 ? (
            <div class="text-xs text-zinc-600">멤버 인기 데이터 없음.</div>
          ) : alloc.map((m) => (
            <div key={m.memberId} class="mb-1.5 flex items-center gap-2">
              <span class="w-16 shrink-0 truncate text-sm text-zinc-300">{m.name}</span>
              <div class="h-3 flex-1 overflow-hidden rounded bg-zinc-800">
                <div class="h-full rounded bg-emerald-500/60" style={{ width: `${m.sharePct.toFixed(1)}%` }} />
              </div>
              <span class="w-12 shrink-0 text-right text-sm tabular-nums text-zinc-300">{m.sharePct.toFixed(1)}%</span>
            </div>
          ))}
          <p class="mt-1 text-[11px] text-zinc-600">하한 10%·상한 평균×2 — 0장·과잉생산 동시 방어.</p>
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

function PendingCard({ title, value, note }: { title: string; value: string | null; note: string }) {
  return (
    <div class={"rounded-card border p-3 " + (value == null ? "border-dashed border-zinc-700 bg-zinc-900/30" : "border-zinc-800 bg-zinc-900/40")}>
      <div class="flex items-center gap-2">
        <span class="text-sm font-semibold text-zinc-300">{title}</span>
        {value == null && <span class="rounded border border-zinc-600/40 bg-zinc-700/30 px-1.5 py-0.5 text-[10px] text-zinc-400">대기</span>}
      </div>
      {value != null && <div class="mt-0.5 text-base font-semibold tabular-nums text-zinc-100">{value}</div>}
      <p class="mt-1 text-[11px] text-zinc-500">{note}</p>
    </div>
  );
}
