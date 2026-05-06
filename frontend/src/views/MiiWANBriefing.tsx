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
  snapshot_at: string | null;
  data_source: string | null;
  summary: SummaryShape | null;
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

// Deterministic action playbook keyed by alert rule. Each step encodes
// the V2.10 IPX action contract — verb-first / owner / due / measurable
// or conditional — so the operator gets a concrete next move even when
// the alert body is generic ("체크리스트를 점검하세요"). Note exists for
// rules where Streisand or legal posture overrides "act fast" reflex.
type PlaybookStep = {
  verb: string;        // imperative action
  owner?: string;      // accountable team/role
  due?: string;        // time bound (D-N / 즉시 / 24h 내 / 조건부)
  detail?: string;     // optional clarifying line
};
type Playbook = { steps: PlaybookStep[]; note?: string };

const ALERT_PLAYBOOK: Record<string, Playbook> = {
  debut_milestone: {
    steps: [
      { verb: "PR·SNS 카운트다운 슬롯 1차 콘텐츠 발행", owner: "콘텐츠팀", due: "D-25 까지" },
      { verb: "미디어 보도자료 초안 IPX·Abyss 검토 의뢰",   owner: "PR팀",   due: "D-21 까지" },
      { verb: "멤버 솔로 채널 5명 활성화 점검·시드",        owner: "운영팀",  due: "D-14 까지" },
      { verb: "D-7 / D-1 자동 알림 트리거 사전 점검",      owner: "BI",     due: "이번 주" },
    ],
  },
  controversy_spike: {
    steps: [
      { verb: "트리거 트윗·게시글 원문 보존 (스크린샷+URL)", owner: "PR팀",  due: "1시간 내" },
      { verb: "naver / dc / theqoo cross-platform 확산 여부 확인", owner: "BI", due: "오늘 안" },
      { verb: "대응 / 무대응 결정 — 기본은 무대응",         owner: "PR리드", due: "오늘 안",
        detail: "Streisand 회피 우선. 공식 대응은 false positive 시 손해 큼." },
      { verb: "24h 후 controversy_count 재측정 + 감쇄 판정", owner: "BI",    due: "내일" },
    ],
    note: "공식 대응은 Streisand 효과로 오히려 확산 가능. 인간 검증 필수.",
  },
  identity_leak: {
    steps: [
      { verb: "노출 키워드·URL 보존, 외부 공유·DM 금지",   owner: "PR팀",   due: "즉시" },
      { verb: "IPX 법무·운영 라인에 통보",                 owner: "총괄",   due: "즉시" },
      { verb: "원 출처 플랫폼 신고 (개인정보·명예훼손)",    owner: "법무",   due: "당일" },
      { verb: "공식 채널 언급·인용·정정 자제 (지속)",      owner: "전 채널", due: "지속" },
    ],
    note: "본체 노출은 BI에 직접 저장 금지. 알림 본문조차 캡처·외부공유 X.",
  },
  model_theft: {
    steps: [
      { verb: "도용 콘텐츠 URL·스크린샷 보존",              owner: "운영팀",  due: "1시간 내" },
      { verb: "원본 캐릭터 IP 권리 증빙 정리",              owner: "IPX 법무", due: "당일" },
      { verb: "플랫폼 DMCA / 정책위반 신고 접수",           owner: "법무",    due: "24h 내" },
      { verb: "확산 모니터 24h 지속 + 추가 발견 시 일괄 신고", owner: "BI",     due: "+24h" },
    ],
  },
  video_velocity_24h: {
    steps: [
      { verb: "썸네일·제목 A/B 후보 1세트 준비",            owner: "콘텐츠팀", due: "오늘" },
      { verb: "공식 SNS·커뮤니티 임베드 push",              owner: "마케팅팀", due: "12h 내" },
      { verb: "후속 영상·숏츠 슬롯 1건 일정 확정",          owner: "콘텐츠팀", due: "이번 주" },
      { verb: "광고 boost 검토 — viral_velocity ≥ 3× WoW 시", owner: "마케팅팀", due: "조건부" },
    ],
  },
};

// V2.10 IPX action contract: verb-first / due / owner / measurable /
// conditional. We re-check on the client because past LLM cycles emit
// stale anti-pattern bodies ("전략적 검토 필요", "면밀히 모니터링")
// that violate the contract. The check is cheap heuristic, not a parser
// — it errs on flagging too much rather than giving false comfort.
const IPX_ANTI_PATTERN = /(전략적|강화\s*검토|검토\s*필요|면밀(?:히|한)|모색|관심을\s*가져|살펴보)/;
// 한국어 SOV 특성상 verb-first 자체는 작위적 — 대신 본문 어디든 "실행
// 가능한 행동 동사" 가 한 개라도 있으면 통과로 본다. anti-pattern 검사가
// "관찰만 하고 행동이 없는" 케이스를 별도로 잡아주므로 두 검사가 서로
// 보완.
const IPX_ACTION_VERB  = /(발행|발송|배포|등록|점검|호출|작성|차단|예약|모니터링|보존|신고|결정|확인|할당|분리|업로드|공지|고지|커뮤니케이션|협의|세팅|설정|롤아웃|롤백|푸시|논의|승인|발표|제출|수정|업데이트|개시|시작|중단|정지)/;
const IPX_DUE          = /(D[-+]\d+|이번\s*주|이번\s*달|오늘|내일|모레|\d+\s*(?:시간|분|일|주)|월요일|화요일|수요일|목요일|금요일|토요일|일요일|주말|즉시|당일|\+\d+h)/;
const IPX_OWNER        = /(IPX|Abyss|어비스|PR\s*팀|콘텐츠\s*팀|운영\s*팀|법무|마케팅|BI|총괄|리드|CXO|에이전시|대행사)/;
const IPX_MEASURABLE   = /(\d+(?:\.\d+)?\s*(?:%|×|배|건|회|명|만|천|MoM|WoW|p)|≥|≤|>=|<=)/;
const IPX_CONDITIONAL  = /(시\b|면\b|일\s*때|초과|이상|이하|미만|넘으면|이면|부터|까지)/;

type IpxScore = {
  passed: string[];
  missing: string[];
  antipattern: boolean;
};

function ipxFiveElements(body: string, title: string): IpxScore {
  const text = `${title}\n${body}`;
  const checks: Array<[string, boolean]> = [
    ["행동 동사", IPX_ACTION_VERB.test(text)],
    ["기한",     IPX_DUE.test(text)],
    ["담당",     IPX_OWNER.test(text)],
    ["측정",     IPX_MEASURABLE.test(text)],
    ["조건",     IPX_CONDITIONAL.test(text)],
  ];
  const passed  = checks.filter(([, v]) => v).map(([k]) => k);
  const missing = checks.filter(([, v]) => !v).map(([k]) => k);
  return { passed, missing, antipattern: IPX_ANTI_PATTERN.test(text) };
}

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

function EstBadge({ source }: { source: string | null | undefined }) {
  if (!source || source === 'live') return null;
  const tip = source === 'backfill_estimate'
    ? 'Social Blade 추정 (±5%) — 곡선 모양 신뢰, 절대값은 참고만'
    : '네이버 뉴스 검색 키워드 카운트 — 검증값';
  const label = source === 'backfill_estimate' ? 'est' : 'bf';
  return (
    <span
      title={tip}
      class="ml-1 rounded bg-zinc-800/60 px-1 py-[1px] text-[10px] text-zinc-500"
    >{label}</span>
  );
}

// In backfill rows we INSERTed 0 as placeholder for community/twitter
// metrics that weren't researched. Rendering those as "0" in benchmark
// cells reads as "actually zero" and confuses operators. For backfill
// rows specifically, treat 0 on these columns as "no data" → "—".
const PLACEHOLDER_ZERO_KEYS = new Set([
  "dc_total_posts", "theqoo_posts", "instiz_posts",
  "twitter_posts", "controversy_count",
]);

function fmtBench(
  v: number | null | undefined,
  source: string | null | undefined,
  key: string,
): string {
  if (v == null) return "—";
  if (source && source !== "live" && PLACEHOLDER_ZERO_KEYS.has(key) && v === 0) {
    return "—";
  }
  return fmt(v);
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

        <div class="mt-3 grid gap-3 md:grid-cols-2">
          <DDayCard d={dToDebut} debuted={debuted} accent={accent} />
          <HealthCard h={data.health_score} />
        </div>
      </section>

      {/* 2) ACTION QUEUE — alerts + ipx_actions 통합. 매일 보는
          운영자가 "오늘 무엇을 해야 하나"를 5초 안에 답할 수 있도록
          최상단에 위치. 빈 상태도 자리 유지 (학습된 위치 유지). */}
      <ActionQueue ipxActions={ipxActions} otherAlerts={otherAlerts} />

      {/* 3) TIMELINE — 데뷔 D-day 컨텍스트에서 최근 30일 + 향후 60일
          이벤트. group_events 테이블에서 자동 조회. 과거/오늘/예정
          시각 분리로 "다음에 무엇이 오는가"를 한 눈에. */}
      <MiiWANEventTimeline today={data.today} />

      {/* 4) RISK WATCH — virtual-idol critical 카테고리만 뽑아 별도
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
            hint="비교 그룹의 D-30 부근 스냅샷이 누적되면 자동으로 채워집니다. 이미 백필된 그룹은 셀별 'est' 배지로 추정값임을 표시."
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
                        const key = k as string;
                        const raw = b.summary?.[key as keyof SummaryShape];
                        const display = fmtBench(raw as number | null | undefined, b.data_source, key);
                        const isMissing = display === "—";
                        const ratio = !isMissing && raw != null ? relativeRatio(mine, raw as number) : "—";
                        const positive = ratio.startsWith("+");
                        return (
                          <td key={b.group_key} class="px-3 py-2 text-right">
                            <div class="text-zinc-300">
                              {display}
                              <EstBadge source={b.data_source} />
                            </div>
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
                  {props.ipxActions.map((i) => {
                    const score = ipxFiveElements(i.body ?? "", i.title ?? "");
                    return (
                      <li key={i.id}
                          class="rounded border-l-2 border-amber-500 bg-zinc-900/40 p-2.5 text-sm">
                        <div class="font-semibold">{i.title}</div>
                        <div class="mt-1 text-xs text-zinc-400">{i.body}</div>
                        <IpxActionGuard score={score} />
                        <SourceRef refs={i.source_refs ?? []} />
                      </li>
                    );
                  })}
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
                      <AlertPlaybook rule={a.rule} />
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
                <AlertPlaybook rule={a.rule} />
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }
}

// Renders the deterministic 4-step playbook for a given alert rule. Sits
// directly under the alert body so the operator doesn't have to context-
// switch to a wiki to know "what do I actually do." If the rule isn't
// in ALERT_PLAYBOOK we render nothing — fail soft, never block.
function AlertPlaybook({ rule }: { rule: string }) {
  const pb = ALERT_PLAYBOOK[rule];
  if (!pb) return null;
  return (
    <div class="mt-2 rounded border border-zinc-800 bg-zinc-950/60 p-2.5">
      <div class="mb-1.5 flex items-center gap-2 text-[11px] uppercase tracking-wider text-zinc-400">
        <span>권장 동선</span>
        <span class="rounded bg-zinc-800/60 px-1.5 py-[1px] text-[10px] text-zinc-500">
          verb · owner · due
        </span>
      </div>
      <ol class="space-y-1.5 text-xs text-zinc-300">
        {pb.steps.map((s, i) => (
          <li key={i} class="flex flex-wrap items-baseline gap-1.5">
            <span class="rounded-full bg-zinc-800 px-1.5 py-[1px] text-[10px] tabular-nums text-zinc-400">
              {i + 1}
            </span>
            <span class="font-medium text-zinc-200">{s.verb}</span>
            {s.owner && (
              <span class="rounded bg-indigo-500/15 px-1.5 py-[1px] text-[10px] text-indigo-200">
                {s.owner}
              </span>
            )}
            {s.due && (
              <span class="rounded bg-amber-500/15 px-1.5 py-[1px] text-[10px] tabular-nums text-amber-200">
                {s.due}
              </span>
            )}
            {s.detail && (
              <span class="basis-full pl-6 text-[11px] text-zinc-500">{s.detail}</span>
            )}
          </li>
        ))}
      </ol>
      {pb.note && (
        <div class="mt-2 rounded border-l-2 border-amber-500/60 bg-amber-500/5 px-2 py-1 text-[11px] text-amber-200">
          ※ {pb.note}
        </div>
      )}
    </div>
  );
}

// Renders V2.10 5-element score next to an LLM-generated IPX action.
// passed elements show as zinc chips, missing as amber chips, and an
// anti-pattern hit (e.g. "전략적", "검토 필요") downgrades the whole
// item with a "구체화 필요" banner. Operator can still read the body —
// we don't hide stale insights, just flag them so they're not acted on
// as if they were concrete.
function IpxActionGuard({ score }: { score: IpxScore }) {
  const total = score.passed.length + score.missing.length;
  const ratio = score.passed.length / total;
  const weak = score.antipattern || ratio < 0.6;
  return (
    <div class="mt-2 space-y-1.5">
      <div class="flex flex-wrap items-center gap-1">
        <span class="text-[10px] uppercase tracking-wider text-zinc-500">
          5요소 점검
        </span>
        {score.passed.map((k) => (
          <span key={`p-${k}`}
                class="rounded bg-emerald-500/10 px-1.5 py-[1px] text-[10px] text-emerald-300">
            ✓ {k}
          </span>
        ))}
        {score.missing.map((k) => (
          <span key={`m-${k}`}
                class="rounded bg-amber-500/10 px-1.5 py-[1px] text-[10px] text-amber-300">
            · {k}
          </span>
        ))}
      </div>
      {weak && (
        <div class="rounded border border-amber-500/40 bg-amber-500/5 px-2 py-1.5 text-[11px] text-amber-200">
          <div class="font-semibold">구체화 필요 — 그대로 실행하지 말 것</div>
          <div class="mt-0.5 text-amber-100/80">
            {score.antipattern
              ? "본문에 안티패턴 (\"전략적\"·\"검토 필요\"·\"면밀히 모니터링\") 포함. "
              : ""}
            아래 5요소 중 빠진 항목을 채워 다시 작성: 행동 동사 / 담당자 / 기한 / 측정 가능한 목표 / 조건.
          </div>
          <div class="mt-1 rounded bg-zinc-950/40 px-2 py-1 font-mono text-[10.5px] text-zinc-300">
            예) "<span class="text-emerald-300">콘텐츠팀</span>이 <span class="text-emerald-300">D-21까지</span> <span class="text-emerald-300">티저 영상 1건 발행</span>, <span class="text-emerald-300">조회수 ≥ 5만</span> 미달 시 <span class="text-emerald-300">광고 boost 결정</span>"
          </div>
        </div>
      )}
    </div>
  );
}

type GroupEvent = {
  id: number;
  group_key: string;
  event_date: string;
  event_type: string;
  title: string;
  description: string | null;
  source_url: string | null;
  confidence: string;
};

const TIMELINE_EVENT_TYPES = new Set([
  "debut", "first_release", "mv_release", "first_show_win",
  "album_release", "single_release", "song_release",
  "first_concert", "tour_start", "tour", "showcase",
  "announcement", "member_reveal", "pre_debut",
  "milestone", "controversy_spike",
]);

const TIMELINE_ICON: Record<string, string> = {
  debut:           "🎬",
  first_release:   "💿",
  first_show_win:  "🏆",
  album_release:   "💿",
  single_release:  "🎵",
  song_release:    "🎵",
  mv_release:      "📺",
  first_concert:   "🎤",
  tour_start:      "🎤",
  tour:            "🎤",
  showcase:        "🎤",
  announcement:    "📣",
  member_reveal:   "👤",
  pre_debut:       "🚧",
  milestone:       "✨",
};

function MiiWANEventTimeline({ today }: { today: string }) {
  const [events, setEvents] = useState<GroupEvent[] | null>(null);

  useEffect(() => {
    // -30 / +60 day window centered on today. The MiiWAN tab is the
    // operator's daily home and the windowing matches the cadence
    // of the briefing's other sections (action queue ~14d, risk
    // watch ~14d, KPI sparklines 30d). +60 forward catches the
    // imminent debut milestones.
    const now = new Date(today);
    const fromDate = new Date(now); fromDate.setDate(fromDate.getDate() - 30);
    const toDate = new Date(now); toDate.setDate(toDate.getDate() + 60);
    api.groupEvents(
      "miiwan",
      fromDate.toISOString().slice(0, 10),
      toDate.toISOString().slice(0, 10),
    ).then((d) => setEvents(d?.events ?? [])).catch(() => setEvents([]));
  }, [today]);

  const filtered = useMemo(() => {
    if (!events) return [];
    return events
      .filter((e) => TIMELINE_EVENT_TYPES.has(e.event_type))
      .sort((a, b) => a.event_date.localeCompare(b.event_date));
  }, [events]);

  const todayDate = today;

  if (!events) {
    return (
      <section>
        <h2 class="section-title mb-3">이벤트 타임라인</h2>
        <div class="text-hint text-zinc-500">Loading…</div>
      </section>
    );
  }

  if (filtered.length === 0) {
    return (
      <section>
        <h2 class="section-title mb-3">이벤트 타임라인</h2>
        <div class="text-hint text-zinc-500">
          최근 30일 / 향후 60일 등록된 이벤트 없음.
        </div>
      </section>
    );
  }

  return (
    <section>
      <div class="mb-3 flex flex-wrap items-baseline gap-2">
        <h2 class="section-title">이벤트 타임라인</h2>
        <span class="text-hint text-zinc-500">
          최근 30일 + 향후 60일 · 과거(회색) / 오늘(amber) / 예정(emerald)
        </span>
      </div>
      <ol class="space-y-1.5">
        {filtered.map((e) => {
          const isPast = e.event_date < todayDate;
          const isToday = e.event_date === todayDate;
          const isFuture = e.event_date > todayDate;
          const tone = isFuture
            ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-100"
            : isToday
            ? "border-amber-500 bg-amber-500/10 text-amber-100"
            : "border-zinc-800 bg-zinc-900/30 text-zinc-400";
          // Days-from-today annotation so the operator can read the
          // distance without subtracting calendar dates in their head.
          const days = Math.round(
            (Date.parse(e.event_date) - Date.parse(todayDate)) / 86_400_000,
          );
          const dayLabel = days === 0 ? "오늘"
            : days > 0 ? `D+${days}`
            : `D${days}`;
          return (
            <li key={e.id} class={`rounded-lg border-l-2 px-3 py-2 text-sm ${tone}`}>
              <div class="flex flex-wrap items-baseline gap-2">
                <span>{TIMELINE_ICON[e.event_type] ?? "•"}</span>
                <span class="tabular-nums text-zinc-500">{e.event_date}</span>
                <span class="font-semibold">{e.title}</span>
                <span class="ml-auto rounded bg-zinc-900/60 px-1.5 text-[11px] tabular-nums text-zinc-300">
                  {dayLabel}
                </span>
              </div>
              {e.description && (
                <div class="mt-0.5 text-xs text-zinc-400">{e.description}</div>
              )}
              {e.source_url && (
                <a class="mt-0.5 inline-block text-[11px] text-zinc-600 hover:text-zinc-400 hover:underline"
                   href={e.source_url} target="_blank" rel="noopener">출처 ↗</a>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
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
