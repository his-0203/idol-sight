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
  QUADRANT_LABEL, RUNG_LABEL, TIER_LABEL_KO, metaOf, fmtGrowthPct,
  type CountryRow, type EnrichedCountry,
} from "../lib/marketAnalysis";
import {
  allocateMerch, estimateDemandFloor, gradeWillingnessToPay,
} from "../lib/decisionSupport";
import { fmt } from "../format";

type CountryApi = {
  country: string; watch_share: number; growth_mom: number | null;
  retention_rel: number; sub_per_1k: number;
  watch_minutes: number | null; organic_share: number | null;
};
export type GoodsPreorderApi = Array<{
  country: string; member_id: number | null; count: number; source: string;
}>;
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
  // growth_mom null = 직전 30일 데이터 없음(신규). 엔진엔 0으로 넣되(중립),
  // 산점도에는 '성장 알려진' 국가만 그려 데뷔 초기 x=0 무더기를 방지한다.
  const raw: CountryRow[] = (analytics?.countries ?? []).map((c) => ({
    country: c.country, watchShare: c.watch_share, growthMoM: c.growth_mom ?? 0,
    retentionRel: c.retention_rel, subPer1k: c.sub_per_1k,
    watchMinutes: c.watch_minutes, organicShare: c.organic_share,
  }));
  const growthKnown = useMemo(
    () => new Set((analytics?.countries ?? []).filter((c) => c.growth_mom != null).map((c) => c.country)),
    [analytics],
  );
  const enriched = useMemo(() => enrichCountries(raw), [analytics]);
  const sufficient = enriched.filter((e) => !e.insufficient);
  const insufficient = enriched.filter((e) => e.insufficient);
  const scatterCountries = enriched.filter((e) => growthKnown.has(e.row.country));
  const growthPending = enriched.length - scatterCountries.length;

  const [selected, setSelected] = useState<string | null>(null);
  // 비전문가 배려 — 지표 안내 기본 펼침(처음 보는 사람이 용어부터 막히지 않게).
  const [showHelp, setShowHelp] = useState(true);
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
      {/* 헤드라인 자동요약 + 도움말 토글 */}
      <section class="rounded-card border border-cyan-500/20 bg-cyan-500/[0.06] p-4">
        <div class="flex items-start justify-between gap-3">
          <div>
            <div class="text-hint mb-1 text-cyan-300/80">📋 이번 주 추천 — 무엇부터 할까 ({dPlus} · 갱신 {analytics.snapshot_at.slice(0, 10)})</div>
            <div class="text-sm font-semibold text-zinc-100">{headline(enriched)}</div>
            <div class="mt-0.5 text-[11px] text-zinc-500">아래는 "왜 그런지" 근거입니다. 모르는 용어는 오른쪽 ? 를 보세요.</div>
          </div>
          <button type="button" onClick={() => setShowHelp((v) => !v)}
            aria-expanded={showHelp}
            class="shrink-0 rounded-full border border-zinc-600 px-2 py-0.5 text-xs text-zinc-400 hover:border-zinc-400 hover:text-zinc-200">
            {showHelp ? "✕ 닫기" : "? 지표 안내"}
          </button>
        </div>
        {showHelp && <HelpPanel />}
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
        <h3 class="section-title mb-1">국가 한눈에 — 성장세 × 끝까지 보는 정도</h3>
        <p class="text-hint mb-1 text-zinc-400">
          👉 읽는 법: <strong class="text-zinc-300">오른쪽일수록 뜨는 중, 위일수록 끝까지 봄.</strong> 오른쪽 위(초록) 칸이 명당입니다.
          버블을 누르면 그 나라의 '왜'가 아래에 펼쳐져요.
        </p>
        <p class="text-hint mb-3 text-zinc-500">
          버블 크기 = 시청 비중 · 색 = 등급(🔵0순위 🟣검증중 ⚪지켜보기) · 흐림 = 데이터 부족 ·
          <span class="text-amber-300"> 금테 = 본진(한국)</span>.
          {growthPending > 0 && <> 성장 데이터 누적 중인 {growthPending}개국은 그림에서 빠지고 오른쪽 목록엔 있습니다.</>}
        </p>
        <div class="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <div class="rounded-card border border-zinc-800 bg-zinc-900/40 p-3">
            {scatterCountries.length > 0 ? (
              <QuadrantScatter countries={scatterCountries} selected={sel?.row.country ?? null} onSelect={setSelected} />
            ) : (
              <div class="flex h-80 items-center justify-center text-center text-sm text-zinc-500">
                성장 데이터 누적 중 — 30일 윈도우가 차면 사분면이 채워집니다.<br />그 전까지는 우측 점수 랭킹으로 판단하세요.
              </div>
            )}
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
          </div>
        </div>
      </section>

      {/* 국가 드릴다운 — '왜' */}
      {sel && <CountryDrilldown e={sel} pop={raw} />}

      {/* PRI 우선순위 + 순차 베팅 */}
      <section>
        <h3 class="section-title mb-1">진출 매력도 — 어디부터 돈을 쓸까</h3>
        <p class="text-hint mb-3 text-zinc-500">
          단순 점수가 아니라 <strong class="text-zinc-400">들이는 노력 대비 기대 성과</strong>(도달×팬전환×진입 쉬움×성장세). 100에 가까울수록 매력적. 유료 광고는 예산상 동시 2곳까지.
        </p>
        <div class="grid gap-4 md:grid-cols-2">
          <div class="rounded-card border border-zinc-800 bg-zinc-900/40 p-3">
            <div class="mb-2 text-xs font-semibold text-zinc-400">진출 매력도 랭킹 (100점 만점)</div>
            <div class="space-y-1">
              {byPri.slice(0, 8).map((e, i) => (
                <div key={e.row.country} class="flex items-center gap-2">
                  <span class="w-4 text-right text-xs text-zinc-600">{i + 1}</span>
                  <span class="w-8 text-sm text-zinc-300">{e.row.country}</span>
                  <div class="h-2 flex-1 overflow-hidden rounded bg-zinc-800">
                    <div class="h-full rounded bg-violet-500/60" style={{ width: `${Math.round(e.pri * 100)}%` }} />
                  </div>
                  <span class="w-9 text-right text-xs tabular-nums text-zinc-400">{Math.round(e.pri * 100)}</span>
                </div>
              ))}
            </div>
          </div>
          <div class="rounded-card border border-zinc-800 bg-zinc-900/40 p-3">
            <div class="mb-2 text-xs font-semibold text-zinc-400">예산 배분 계획</div>
            <p class="mb-2 text-[11px] text-zinc-600">예산을 흩으면 효과 측정이 어려워 한 번에 2곳만 집중합니다. 자막 테스트는 무료라 여러 곳 동시 가능.</p>
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
      <div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 class="text-lg font-bold text-zinc-100">{e.row.country}{e.row.country === "KR" && <span class="ml-1 text-xs text-amber-300">본진</span>}</h3>
        <span class={"text-sm font-semibold " + (TIER_TONE[e.tier] ?? "")}>{e.interpretation.label}</span>
        <span class="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">{TIER_LABEL_KO[e.tier]} · {e.score}점</span>
        <span class="text-hint text-zinc-500">{QUADRANT_LABEL[e.quadrant]}</span>
        {e.insufficient && <span class="rounded border border-amber-500/30 bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">데이터 부족</span>}
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
            {e.row.watchMinutes != null && <> · 표본 {fmt(e.row.watchMinutes)}분</>}
          </div>
          {e.row.organicShare != null && (
            <div class="text-[11px] text-zinc-500">
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
          {/* 약점 → 처방 연결 + 액션 카드 */}
          <div class="rounded border border-cyan-700/40 bg-cyan-500/[0.05] p-2.5">
            <div class="mb-1 text-xs text-zinc-400">
              가장 약한 곳: <strong class="text-amber-300">{weakest[0]}</strong>
              <span class="mx-1 text-cyan-400">➜ 그래서 할 일</span>
            </div>
            <div class="text-sm font-medium text-zinc-100">{e.action.verb}</div>
            <div class="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-zinc-500">
              <span class="rounded bg-zinc-700/60 px-1.5 py-0.5 text-zinc-300">{RUNG_LABEL[e.action.costTier]}</span>
              <span>{e.action.owner} · {e.action.due}</span>
            </div>
            <div class="mt-1 text-[11px] text-zinc-500">성공 기준: {e.action.measurable}</div>
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
        <div class="mb-1 font-semibold text-zinc-200">등급 · 읽는 법</div>
        <Row k="tier" v="🔵후보(0순위) · 🟣테스트(검증 필요) · ⚪관망 · 표본부족(판단 보류)." />
        <Row k="사분면" v="가로=성장, 세로=유지율. 우상 '공략 1순위', 우하 '거품 의심', 좌상 '안정·육성', 좌하 '관망'." />
        <Row k="PRI" v="노력 대비 기대수익 — 도달×전환×진입용이성×모멘텀. 단순 점수보다 진출 우선순위에 적합." />
        <Row k="L0~L4" v="액션 사다리: L0 관찰 → L1 자막AB → L2 유료도달 → L3 현지PR → L4 물리진출. 임계 미달 시 강등." />
        <Row k="본진" v="KR은 한국 본진 = 유지율 기준선(1.0×). 진출 대상에 포함하되 금색 테두리로 구분." />
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
      <p class="mt-1 text-[11px] text-zinc-500">{note}</p>
    </div>
  );
}
