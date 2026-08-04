// MiiWAN 포지션 — "시장 전체에서 우리 좌표가 어디고, 어느 방향으로
// 움직이고 있나"를 답하는 종합 뷰. 브리핑(이번 주 무슨 일·오늘 할 일,
// 시계열)과 역할을 나눈다: 여기는 전략·공간이다.
//
// 읽는 순서 = 좌표 → 지도 → 방향 → 팬덤 → 상태·다음 일정.
// 전부 기존 API 재조립 (Phase 1, 신규 수집 0):
//   /api/market            좌표 스트립 + 시장 지도 (인지도·코어·건강·전환율)
//   /api/market-share      관심 점유율 수준·순위·추이·모멘텀
//   /api/growth-trajectory 성장 자세(가속/유지/둔화) + 약한 축
//   /api/debut-window/...  자연 유입 점수·광고 주의 마커
//   부모(/api/miiwan)      국가 분포·찐팬·위기 알림·동시기 결론(cohortHead)
//
// 하드 제약: K-POP / 서브컬처 분리 — 순위·중앙값·지도 전부 K-POP 버추얼
// 집합으로 한정하고, 그 사실을 화면에 공시한다.

import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api";
import { fmt } from "../format";
import { KPI } from "../components/KPI";
import { Sparkline } from "../components/Sparkline";
import { BreadthDepthQuadrant } from "../components/BreadthDepthQuadrant";
import { MiiWANEventTimeline } from "../components/MiiWANEventTimeline";
import { computeQuadrantLayout, type QuadrantInput } from "../lib/breadthDepth";
import { categoryOf } from "../lib/category";
import {
  computeGroupOrganicities, DEFAULT_ORGANICITY_MODE, organicityCaveat,
  scoreColor, type GroupOrganicity, type OrganicitySummaryRow,
} from "../lib/organicity";
import { DEFAULT_CURRENT_BUCKET, DEFAULT_DISPLAY_BUCKETS } from "../lib/debutWindow";
import {
  cohortForecast, demographicBars, momentumLine, PILLAR_LABEL,
  QUADRANT_VERDICT, sovPosition, subSplitLine, topCountriesLine,
  topDemographicLine, type DemographicRow,
} from "../lib/position";
import type { Headline } from "../lib/cohortHeadline";
import {
  buildKpiTable, KPI_LABEL, KPI_MONTHS,
  MONTH_NOTES, type MonthlyKpiRow,
} from "../lib/miiwanKpi";
import {
  CONTROVERSY_SPIKE_MIN_COUNT, CONTROVERSY_SPIKE_MULTIPLIER,
} from "../lib/alerts";
import { awarenessDisplay, coreDisplay } from "./MarketOverview";
import { fmtRate, type FanActivity } from "../components/FanActivityCard";

const RISK_RULES = new Set(["identity_leak", "model_theft", "controversy_spike"]);

// /api/miiwan 의 industry 필드 — 산업 표준 성과 마커. 신인 구간엔 전부
// null/빈 배열이 정상이라, 하나라도 값이 생겼을 때만 섹션을 점등한다.
export interface IndustryMarkers {
  melon_top100_peak: number | null;
  melon_top100_depth: number | null;
  music_show_wins: number | null;
  show_wins: Array<{ program: string; episode_date: string; song_title: string | null }>;
  hanteo: { album: string; rank: number | null; sales: number | null; week_start: string } | null;
}

export function MiiWANPosition(props: {
  today: string;
  alerts: Array<{ rule: string; severity: string }>;
  controversyTrend: { current: number; previous: number | null } | null;
  countries: Array<{ country: string; watch_share: number }> | null;
  fanActivity: FanActivity | null;
  cohortHead: Headline | null;
  demographics: DemographicRow[];
  industry: IndustryMarkers | null;
  /** 구독 vs 비구독 시청 비중 (0..1, 소유자 OAuth). 미연결이면 null. */
  subSplit: { subscribed: number | null; unsubscribed: number | null } | null;
  /** 방송별 peak 라이브 동접 (시간 오름차순). */
  ccvTrend: Array<{ video_id: string; peak: number; started_at: string }>;
  /** /api/miiwan-cohort 원본 — 전망(선배 팀 궤적) 산출용. 부모가 이미
      히어로 headline 용으로 fetch한 응답을 그대로 내려받는다. */
  cohortRaw: any | null;
  /** /api/miiwan monthly_kpi — 월간 KPI 페이스 표. */
  monthlyKpi: MonthlyKpiRow[];
}) {
  const [market, setMarket] = useState<any>(null);
  const [share, setShare] = useState<any>(null);
  const [traj, setTraj] = useState<any>(null);
  const [orgRows, setOrgRows] = useState<OrganicitySummaryRow[] | null>(null);
  const [orgBuckets, setOrgBuckets] = useState<string[]>(DEFAULT_DISPLAY_BUCKETS);
  const [orgCurrent, setOrgCurrent] = useState<string>(DEFAULT_CURRENT_BUCKET);

  useEffect(() => {
    api.market().then(setMarket).catch(() => setMarket({ groups: {} }));
    api.marketShare(13).then(setShare).catch(() => setShare({ rows: [] }));
    api.growthTrajectory<any>("miiwan").then(setTraj).catch(() => setTraj({ status: "no_data" }));
    api.debutWindowSummary<OrganicitySummaryRow>().then((r) => {
      if (r.window?.buckets?.length) {
        setOrgBuckets(r.window.buckets);
        setOrgCurrent(r.window.current_bucket);
      }
      setOrgRows(r.rows);
    }).catch(() => setOrgRows([]));
  }, []);

  // ── K-POP 버추얼 집합 (카테고리 분리 하드 제약) ─────────────────────
  const kpopEntries = useMemo<Array<[string, any]>>(() => {
    if (!market?.groups) return [];
    return Object.entries(market.groups)
      .filter(([, g]: any) => categoryOf(g.group_model) === "kpop") as Array<[string, any]>;
  }, [market]);
  const kpopKeys = useMemo(() => new Set(kpopEntries.map(([k]) => k)), [kpopEntries]);

  const sov = useMemo(() => sovPosition(share?.rows, kpopKeys), [share, kpopKeys]);

  const orgByKey = useMemo<Map<string, GroupOrganicity>>(() => {
    if (!orgRows) return new Map();
    return computeGroupOrganicities(orgRows, {
      buckets: orgBuckets, currentBucket: orgCurrent, mode: DEFAULT_ORGANICITY_MODE,
    });
  }, [orgRows, orgBuckets, orgCurrent]);

  // 시장 지도 — MarketOverview 사분면과 같은 축·같은 lib (원값 인지도 ×
  // 추정 적극코어, 십자선 = K-POP 중앙값). 화면 간 정의가 어긋나지 않게
  // 재사용하고, 여기서는 MiiWAN 사분면 판정 한 줄만 얹는다.
  const quadPoints = useMemo<QuadrantInput[]>(() => {
    return kpopEntries.reduce<QuadrantInput[]>((acc, [key, g]) => {
      const x = g.awareness?.score;
      const y = g.core_fan_estimate?.est_active_core;
      if (x != null && y != null) {
        acc.push({ key, name: g.name, x, y, caveat: organicityCaveat(orgByKey.get(key)).show });
      }
      return acc;
    }, []);
  }, [kpopEntries, orgByKey]);

  const miiwanQuadrant = useMemo(() => {
    const layout = computeQuadrantLayout(quadPoints);
    return layout.plottable
      ? layout.points.find((p) => p.key === "miiwan")?.quadrant ?? null
      : null;
  }, [quadPoints]);

  // 건강 점수·D-day는 상단 히어로(브리핑과 공유)가 이미 보여주므로 여기
  // 스트립은 겹치지 않는 4축만: 점유(양)·인지(넓이)·전환(깊이)·자연 유입(질).
  const mi = market?.groups?.miiwan;
  const aw = awarenessDisplay(mi?.awareness);
  const core = coreDisplay(mi?.core_fan_estimate);
  const viewConv = mi?.view_conversion;
  const miiwanOrg = orgByKey.get("miiwan");
  const orgScore = miiwanOrg?.score ?? null;

  // 위기 상태 한 줄 — 브리핑 RiskWatch와 같은 신호원(alerts + 논란 추세).
  const cur = props.controversyTrend?.current ?? 0;
  const prevC = props.controversyTrend?.previous ?? 0;
  const spiking = cur >= CONTROVERSY_SPIKE_MIN_COUNT
    && prevC > 0 && cur / prevC >= CONTROVERSY_SPIKE_MULTIPLIER;
  const hasCritical = props.alerts.some(
    (a) => RISK_RULES.has(a.rule) && a.severity === "critical");
  const riskLevel = hasCritical ? "심각" : spiking ? "주의" : "정상";
  const riskTone = hasCritical
    ? "border-red-500 bg-red-500/10 text-red-200"
    : spiking
    ? "border-amber-500 bg-amber-500/10 text-amber-200"
    : "border-emerald-500/40 bg-emerald-500/5 text-emerald-200";

  const countriesLine = topCountriesLine(props.countries);
  const fan = props.fanActivity;
  const splitLine = subSplitLine(props.subSplit?.subscribed, props.subSplit?.unsubscribed);
  const ccvSeries = props.ccvTrend.map((b) => b.peak);
  const lastCcv = props.ccvTrend[props.ccvTrend.length - 1] ?? null;
  const prevCcv = props.ccvTrend[props.ccvTrend.length - 2] ?? null;
  // 전망 — 선배 팀들이 같은 구간에서 실제로 걸은 성장 비율의 중앙값을
  // 현재 구독자에 적용. 예측 모델이 아니므로 반드시 (추정)과 근거를 병기.
  const forecast = cohortForecast(
    props.cohortRaw?.forward ?? null,
    "yt_subscribers",
    props.cohortRaw?.as_of_day ?? null,
    mi?.summary?.yt_subscribers ?? null,
  );
  const ageBars = demographicBars(props.demographics);
  const maxAgeTotal = ageBars.reduce((m, b) => Math.max(m, b.total), 0);
  const topDemo = topDemographicLine(props.demographics);

  // 산업 성과 — 하나라도 값이 있을 때만 점등.
  const ind = props.industry;
  const showWins = ind?.show_wins ?? [];
  const musicShowCount = Math.max(ind?.music_show_wins ?? 0, showWins.length);
  const hasIndustry = !!ind && (
    ind.melon_top100_peak != null || musicShowCount > 0 || ind.hanteo != null);

  if (!market || !share) {
    return <div class="text-zinc-500">Loading…</div>;
  }

  return (
    <div class="space-y-6">
      <p class="text-hint text-zinc-500">
        같은 지표 체계를 쓰는 <strong class="text-zinc-400">K-POP 버추얼 그룹
        {kpopEntries.length > 0 ? ` ${kpopEntries.length}팀` : ""}</strong> 안에서 본
        MiiWAN의 현재 좌표. 서브컬처 계열(이세돌·스텔라이브 등)은 활동 구조가 달라
        비교에서 제외한다.
      </p>

      {/* ① 좌표 스트립 — "지금 어디인가"를 숫자 4개로. */}
      <section>
        <h2 class="section-title mb-3">시장 좌표</h2>
        <div class="grid grid-cols-2 gap-2 md:grid-cols-4">
          <KPI label="관심 점유율"
               value={sov.share != null ? `${sov.share.toFixed(1)}%` : "—"}
               delta={sov.deltaPp}
               deltaUnit="pct"
               hint={sov.rank != null ? `K-POP 버추얼 ${sov.teamCount}팀 중 ${sov.rank}위 · 주간` : "주간 집계 전"}
               sparkline={sov.series.length >= 2 ? sov.series : undefined} />
          <KPI label="인지도 (0~100)"
               value={aw.score}
               hint={aw.rank != null
                 ? `카테고리 내 #${aw.rank}${aw.discounted ? " · 광고 신뢰 보정값" : ""}`
                 : "집계 전"} />
          <KPI label="시청전환율"
               value={viewConv?.rate != null ? `${(viewConv.rate * 100).toFixed(1)}%` : "—"}
               hint="라이브 동시접속 ÷ 구독자 · 실측" />
          <KPI label="자연 유입 점수"
               value={orgScore != null ? Math.round(orgScore) : "—"}
               hint="광고 없이 모인 비율 신호 (0~100)" />
        </div>
        {orgScore != null && (
          <p class="mt-2 text-hint text-zinc-500">
            자연 유입{" "}
            <span class="font-semibold" style={{ color: scoreColor(orgScore) }}>
              {Math.round(orgScore)}점
            </span>
            은 '광고 없이 모였는가'(진짜인가)의 신호이며 규모의 증거는 아니다 —
            규모는 점유율·아래 동시기 비교가 답한다.
          </p>
        )}
      </section>

      {/* ② 시장 지도 — 위치가 우위를 말하는 사분면. MarketOverview와 같은
          축이라 화면 간 정의 충돌 없음. */}
      <section>
        <div class="mb-2 flex flex-wrap items-baseline gap-2">
          <h2 class="section-title">시장 지도 — 인지도 × 코어 팬</h2>
          <span class="text-hint text-zinc-500">십자선 = K-POP 버추얼 중앙값</span>
        </div>
        <BreadthDepthQuadrant points={quadPoints} />
        {miiwanQuadrant && (
          <p class="mt-2 rounded border-l-2 border-[#75d7d1] bg-[#75d7d1]/5 px-3 py-2 text-sm text-zinc-200">
            <span class="mr-2 font-semibold text-[#75d7d1]">MiiWAN 위치</span>
            {QUADRANT_VERDICT[miiwanQuadrant]}
          </p>
        )}
      </section>

      {/* ③ 방향과 속도 — 위치가 아니라 벡터. */}
      <section>
        <h2 class="section-title mb-2">방향과 속도</h2>
        <div class="card space-y-3">
          <div class="flex flex-wrap items-center gap-3">
            <span class="w-28 shrink-0 text-xs text-zinc-500">점유율 흐름 (13주)</span>
            {sov.series.length >= 2 ? (
              <>
                <span class="text-emerald-500/70">
                  <Sparkline points={sov.series} width={120} height={22} />
                </span>
                {momentumLine(sov.momentumGap) && (
                  <span class="text-sm text-zinc-300">{momentumLine(sov.momentumGap)}</span>
                )}
              </>
            ) : (
              <span class="text-hint text-zinc-500">주간 집계 2주 이상 쌓이면 표시</span>
            )}
          </div>
          {traj?.posture_label && (
            <div class="flex flex-wrap items-center gap-3">
              <span class="w-28 shrink-0 text-xs text-zinc-500">성장 자세</span>
              <span class="text-sm font-semibold text-zinc-200">{traj.posture_label}</span>
              {traj.weakest_pillar && (
                <span class="rounded bg-amber-500/10 px-1.5 py-[1px] text-[11px] text-amber-300">
                  약한 축: {PILLAR_LABEL[traj.weakest_pillar] ?? traj.weakest_pillar}
                </span>
              )}
              {traj.history_days != null && (
                <span class="text-hint text-zinc-600">최근 {traj.history_days}일 추세</span>
              )}
            </div>
          )}
          {ccvSeries.length >= 2 && (
            <div class="flex flex-wrap items-center gap-3">
              <span class="w-28 shrink-0 text-xs text-zinc-500">라이브 동접 흐름</span>
              <span class="text-emerald-500/70">
                <Sparkline points={ccvSeries} width={120} height={22} />
              </span>
              {lastCcv && (
                <span class="text-sm text-zinc-300">
                  최근 방송 피크 {fmt(lastCcv.peak)}명
                  {prevCcv && lastCcv.peak !== prevCcv.peak && (
                    <span class={lastCcv.peak > prevCcv.peak ? "ml-1 text-emerald-400" : "ml-1 text-red-400"}>
                      ({lastCcv.peak > prevCcv.peak ? "▲" : "▼"} {fmt(Math.abs(lastCcv.peak - prevCcv.peak))} vs 직전)
                    </span>
                  )}
                </span>
              )}
              <span class="text-hint text-zinc-600">방송별 최고 동시접속 · 실측</span>
            </div>
          )}
          {props.cohortHead && (props.cohortHead.strengths[0] || props.cohortHead.weaknesses[0]) && (
            <div class="flex flex-wrap items-start gap-3">
              <span class="w-28 shrink-0 pt-0.5 text-xs text-zinc-500">동시기 대비</span>
              <div class="min-w-0 flex-1 space-y-1 text-sm">
                {props.cohortHead.strengths[0] && (
                  <div class="text-emerald-300">✅ {props.cohortHead.strengths[0]}</div>
                )}
                {props.cohortHead.weaknesses[0] && (
                  <div class="text-amber-300">⚠️ {props.cohortHead.weaknesses[0]}</div>
                )}
                <div class="text-hint text-zinc-600">전체 비교는 브리핑 탭 '동시기 성과' 참고</div>
              </div>
            </div>
          )}
          {forecast && (
            <div class="flex flex-wrap items-start gap-3">
              <span class="w-28 shrink-0 pt-0.5 text-xs text-zinc-500">전망 (동시기 경로)</span>
              <div class="min-w-0 flex-1 text-sm text-zinc-300">
                먼저 데뷔한 {forecast.peerCount}팀은 같은 구간에서 중앙값
                {" "}×{forecast.medianRatio.toFixed(2)} 성장 — 통상 경로 유지 시
                {" "}D+{forecast.horizonDay} 구독자 약{" "}
                {forecast.projectedValue != null ? fmt(forecast.projectedValue) : "—"}
                <span class="text-zinc-500"> (선배 팀 실적 기반 · 예측 아님 · 추정)</span>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ③b 월간 KPI 페이스 — 계획(보수~낙관 밴드) 위에 실측을 얹어
          "페이스 안인가"를 답한다. 밴드=내부 계획 가정치(고정 상수),
          실측=agg_summary·live_ccv·weverse_stats. 당월은 판정 유보. */}
      <section>
        <div class="mb-2 flex flex-wrap items-baseline gap-2">
          <h2 class="section-title">월간 KPI 페이스</h2>
          <span class="text-hint text-zinc-500">
            목표 밴드 = 내부 계획 가정치(보수~낙관) · 위버스 = 자사 시트 집계
          </span>
        </div>
        <div class="card overflow-x-auto">
          <table class="w-full min-w-[640px] text-sm">
            <thead>
              <tr class="text-left text-xs text-zinc-500">
                <th class="py-1.5 pr-3 font-normal">지표</th>
                {KPI_MONTHS.map((m) => (
                  <th key={m} class="py-1.5 pr-3 font-normal">
                    {Number(m.slice(5))}월
                    {MONTH_NOTES[m] && (
                      <span class="ml-1 text-[10px] text-amber-300/80"
                            title={MONTH_NOTES[m]}>
                        {MONTH_NOTES[m].slice(0, 1)}
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {buildKpiTable(props.monthlyKpi).map((row) => (
                <tr key={row.metric} class="border-t border-zinc-800/60">
                  <td class="py-2 pr-3 text-xs text-zinc-400">{KPI_LABEL[row.metric]}</td>
                  {row.cells.map((c) => (
                    <td key={c.month} class="py-2 pr-3 align-top">
                      {c.actual != null && (
                        <div class={"tabular-nums font-semibold "
                          + (c.verdict === "below" ? "text-amber-300"
                            : c.verdict === "above" ? "text-sky-300"
                            : "text-zinc-100")}>
                          {fmt(c.actual)}
                          {c.verdict === "within" && " ✅"}
                          {c.verdict === "below" && " ⚠️"}
                          {c.verdict === "above" && " 🔵"}
                          {c.inProgress && (
                            <span class="ml-1 text-[10px] font-normal text-zinc-500">진행 중</span>
                          )}
                        </div>
                      )}
                      {c.band && (
                        <div class="text-[11px] tabular-nums text-zinc-500">
                          {fmt(c.band[0])}~{fmt(c.band[1])}
                        </div>
                      )}
                      {c.actual == null && !c.band && <span class="text-zinc-600">—</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p class="mt-2 text-hint text-zinc-500">
          ◆ = 의사결정 시점(8월 말 굿즈 참여 · 10월 말 제작 스케일) · ★ = 9월 컴백 ·
          ⚠️ 보수선 미달 · ✅ 밴드 내 · 🔵 낙관선 초과 · 당월은 월말 확정 전까지 판정 유보
        </p>
      </section>

      {/* ④ 팬덤 프로필 — 우리 팬이 누구고, 진짜이고, 얼마나 깊은가. */}
      <section>
        <h2 class="section-title mb-2">팬덤 프로필</h2>
        <div class="grid grid-cols-2 gap-2 md:grid-cols-3">
          <KPI label="추정 관여 팬"
               value={core.value}
               hint="영상 좋아요 반응 기준 · 추정" />
          <KPI label="주 시청 국가"
               value={countriesLine ?? "—"}
               hint={countriesLine ? "시청 시간 비중 · 자사 채널 실측" : "소유자 데이터 연결 시 표시"} />
          <KPI label="라이브 재방문율"
               value={fan?.median_returning_rate != null ? fmtRate(fan.median_returning_rate) : "—"}
               hint={fan?.median_returning_rate != null
                 ? `채팅 참여 기준 실측 · 최근 ${fan.window_days}일`
                 : "라이브 데이터 축적 중"} />
        </div>

        {/* 구독 vs 비구독 시청 비중 — "조회수가 코어 반복 소비인가, 새
            시청자 유입인가". 소유자 OAuth 실측, 미연결이면 카드 미표시. */}
        {props.subSplit && props.subSplit.subscribed != null && props.subSplit.unsubscribed != null && (
          <div class="card mt-2">
            <div class="mb-1.5 flex flex-wrap items-baseline gap-2">
              <span class="text-xs font-semibold text-zinc-300">시청 시간 구성 — 구독자 vs 비구독자</span>
              <span class="ml-auto text-hint text-zinc-500">자사 채널 실측</span>
            </div>
            <div class="flex h-3 overflow-hidden rounded-sm bg-zinc-800/60">
              <div class="bg-[#75d7d1]/80" style={{ width: `${props.subSplit.subscribed * 100}%` }} />
              <div class="bg-zinc-500/70" style={{ width: `${props.subSplit.unsubscribed * 100}%` }} />
            </div>
            <div class="mt-1 flex flex-wrap items-center gap-3 text-hint text-zinc-500">
              <span class="flex items-center gap-1">
                <span class="inline-block h-2 w-2 rounded-sm bg-[#75d7d1]/80" />
                구독자 시청 {Math.round(props.subSplit.subscribed * 100)}%
              </span>
              <span class="flex items-center gap-1">
                <span class="inline-block h-2 w-2 rounded-sm bg-zinc-500/70" />
                비구독 시청 {Math.round(props.subSplit.unsubscribed * 100)}%
              </span>
            </div>
            {splitLine && <p class="mt-1.5 text-sm text-zinc-300">{splitLine}</p>}
          </div>
        )}

        {/* 연령×성별 시청 분포 — 자사 채널 실측(소유자 데이터). 경쟁사가
            가질 수 없는 이 페이지의 차별 데이터라 팬덤 프로필의 중심 카드. */}
        {ageBars.length > 0 && (
          <div class="card mt-2">
            <div class="mb-2 flex flex-wrap items-baseline gap-2">
              <span class="text-xs font-semibold text-zinc-300">누가 보는가 — 연령×성별 시청 비중</span>
              {topDemo && (
                <span class="rounded bg-[#75d7d1]/10 px-1.5 py-[1px] text-[11px] text-[#75d7d1]">
                  핵심 시청층: {topDemo}
                </span>
              )}
              <span class="ml-auto text-hint text-zinc-500">자사 채널 실측</span>
            </div>
            <div class="space-y-1.5">
              {ageBars.map((b) => (
                <div key={b.age} class="flex items-center gap-2">
                  <span class="w-12 shrink-0 text-right text-xs tabular-nums text-zinc-400">{b.age}</span>
                  <div class="h-3 flex-1 overflow-hidden rounded-sm bg-zinc-800/60">
                    <div class="flex h-full"
                         style={{ width: `${maxAgeTotal > 0 ? (b.total / maxAgeTotal) * 100 : 0}%` }}>
                      {b.female > 0 && (
                        <div class="bg-rose-400/80" style={{ width: `${(b.female / b.total) * 100}%` }} />
                      )}
                      {b.male > 0 && (
                        <div class="bg-sky-400/80" style={{ width: `${(b.male / b.total) * 100}%` }} />
                      )}
                      {b.other > 0 && (
                        <div class="bg-zinc-500/80" style={{ width: `${(b.other / b.total) * 100}%` }} />
                      )}
                    </div>
                  </div>
                  <span class="w-10 shrink-0 text-xs tabular-nums text-zinc-500">
                    {Math.round(b.total)}%
                  </span>
                </div>
              ))}
            </div>
            <div class="mt-1.5 flex items-center gap-3 text-hint text-zinc-500">
              <span class="flex items-center gap-1">
                <span class="inline-block h-2 w-2 rounded-sm bg-rose-400/80" /> 여성
              </span>
              <span class="flex items-center gap-1">
                <span class="inline-block h-2 w-2 rounded-sm bg-sky-400/80" /> 남성
              </span>
              <span class="flex items-center gap-1">
                <span class="inline-block h-2 w-2 rounded-sm bg-zinc-500/80" /> 기타
              </span>
              <span class="ml-auto">전체 시청 시간 대비 % · 막대 길이는 최대 연령대 기준</span>
            </div>
          </div>
        )}
      </section>

      {/* 산업 성과 — 멜론·음방·초동 등 외부인이 아는 표준 마커. 신인 구간엔
          전부 비어 있는 게 정상이라, 하나라도 달성되면 자동 점등한다
          (빈 대시 나열은 노이즈만 만든다). */}
      {hasIndustry && ind && (
        <section>
          <h2 class="section-title mb-2">산업 성과</h2>
          <div class="flex flex-wrap gap-2">
            {ind.melon_top100_peak != null && (
              <span class="rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-3 py-1.5 text-sm text-emerald-200">
                🎵 멜론 TOP100 최고 {ind.melon_top100_peak}위
                {ind.melon_top100_depth != null && (
                  <span class="ml-1 text-xs text-zinc-400">· {ind.melon_top100_depth}곡 진입</span>
                )}
              </span>
            )}
            {musicShowCount > 0 && (
              <span class="rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-3 py-1.5 text-sm text-emerald-200">
                🏆 음악방송 1위 {musicShowCount}회
                {showWins[0] && (
                  <span class="ml-1 text-xs text-zinc-400">
                    · 최근 {showWins[0].program} {showWins[0].episode_date}
                  </span>
                )}
              </span>
            )}
            {ind.hanteo && (
              <span class="rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-3 py-1.5 text-sm text-emerald-200">
                💿 한터 초동 {ind.hanteo.sales != null ? fmt(ind.hanteo.sales) : "—"}장
                <span class="ml-1 text-xs text-zinc-400">· {ind.hanteo.album}</span>
              </span>
            )}
          </div>
        </section>
      )}

      {/* ⑤ 상태와 다음 일정 — 감시 체계 + 예정 이벤트로 닫는다. */}
      <section>
        <h2 class="section-title mb-2">위기 상태</h2>
        <div class={`rounded border-l-4 px-3 py-2 text-sm ${riskTone}`}>
          <span class="font-semibold">위험도: {riskLevel}</span>
          <span class="ml-2 text-xs text-zinc-400">
            본체 노출 · AI 도용 · 논란 급증 3개 시나리오 매일 자동 감시 중
          </span>
          {props.controversyTrend && (
            <span class="ml-2 rounded bg-zinc-900/50 px-2 py-0.5 text-xs">
              논란 글 이번 주 {cur} · 직전 주 {prevC}
            </span>
          )}
        </div>
      </section>

      <MiiWANEventTimeline today={props.today} futureOnly hideWhenEmpty />
    </div>
  );
}
