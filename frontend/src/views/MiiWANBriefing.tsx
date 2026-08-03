// MiiWAN strategic briefing — IPX/Abyss internal briefing tab,
// rebuilt 2026-05-05 from a strategy-analyst lens, reworked 2026-08-03
// after a 4-lens review (data storytelling / investor comms / IA / data
// inventory).
//
// The page must answer, in reading order, the report arc
// 과거 → 현재 → 전망 → 액션:
//
//   HERO     — 지금 어디인가 + 지난 주 대비 무엇이 변했나 + 이 페이스면
//              다음 주 어디인가(추정) + 동시기 순위 결론. 섹션 점프 칩.
//   KPIS     — 핵심 지표 (WoW + 30d sparkline). 경영진의 첫 질문이므로
//              히어로 바로 아래.
//   INSIGHT  — 주간 전략 분석 (LLM weekly). 07-30 사용자 지시로 액션 큐
//              위 — 주간 관점의 "무엇이 중요한가"를 먼저 읽는다.
//   ACTION   — 오늘 무엇을 해야 하나 (alerts + ipx_action 통합 큐).
//   RISK     — 어떤 위기에 대비해야 하나 (identity_leak / model_theft
//              / controversy_spike). 액션 클러스터에 인접 배치.
//   COHORT   — 동시기 대비 어디인가 (스코어카드, /api/miiwan-cohort).
//   피드류(이벤트·라이브 채팅·찐팬·멤버)는 하단 — 원자료성이라 결론
//   섹션들보다 뒤.
//
// 뷰 모드 3종:
//   briefing — 운영자 일일 뷰 (전체). 시계열 — "이번 주 무슨 일, 오늘 할 일".
//   position — 종합 포지션 뷰 (MiiWANPosition). 공간 — "시장 전체에서
//              우리 좌표가 어디고 어느 방향인가". 브리핑의 축약이 아니라
//              별도 데이터(SOV·인지도·사분면·성장 자세)로 구성.
//   market   — 국가별 진출/굿즈 분석 (MarketAnalysis).
//
// The "활성 멤버" 카드는 D-7 이상 남은 시점에서는 정보값이 거의
// 없으므로 (이름/영문명 정도) 의도적으로 collapse 처리. D-7 이내
// 또는 데뷔 후에만 자동 노출.

import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api";
import { fmt } from "../format";
import { headline, type Headline } from "../lib/cohortHeadline";
import { KPI } from "../components/KPI";
import { EmptyState } from "../components/EmptyState";
import { EstBadge } from "../components/EstBadge";
import { DataSourceDetails, type RawRef } from "../components/Tooltip";
import { colorOf } from "../design/groups";
import { formatKST, formatKSTDate, todayKST } from "../lib/datetime";
import { liveDateIndex, monthMatrix, type AvailEntry } from "../lib/liveChatCalendar";
import {
  ALERT_RULE_LABEL as RULE_LABEL,
  ALERT_SEVERITY_TONE as SEVERITY_TONE,
  CONTROVERSY_SPIKE_MIN_COUNT,
  CONTROVERSY_SPIKE_MULTIPLIER,
} from "../lib/alerts";
import { InsightBody } from "../components/InsightBody";
import { GroupBadge } from "../components/GroupBadge";
import { extractGroupKeys, humanizeInsightText } from "../lib/insightFormat";
import { CompetitorOrganicityBar } from "../components/CompetitorOrganicityBar";
import { MiiWANCohortReport } from "../components/MiiWANCohortReport";
import { FanActivityCard, type FanActivity } from "../components/FanActivityCard";
import { MiiWANEventTimeline } from "../components/MiiWANEventTimeline";
import { MarketAnalysis } from "./MarketAnalysis";
import { MiiWANPosition } from "./MiiWANPosition";

type SummaryShape = {
  yt_total_videos: number; yt_total_views: number; yt_subscribers: number;
  dc_total_posts: number; theqoo_posts: number; instiz_posts: number;
  naver_total_news: number; controversy_count: number;
};

type Insight = {
  id: number; title: string; body: string;
  scope: string; type: string;
  source_refs: Array<{ table: string; pk: string; label: string }>;
  generated_at: string;
  /** Optional one-line LLM commentary slot.
   *  값이 있으면 본문 아래 AI 배지로 노출됨. */
  ai_comment?: string | null;
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
  alerts: AlertRow[];
  controversy_trend: { current: number; previous: number | null } | null;
  decision: DecisionData;
  // P2a 찐팬 활동량 — agg_live_activity_summary 행 없으면 null(카드 '축적 중').
  fan_activity: FanActivity | null;
};

// DECISION 탭 데이터. member_popularity는 공개 프록시(지금 가동),
// analytics는 소유자 OAuth 전용 — 미연결 시 null → empty-state.
type DecisionData = {
  member_popularity: Array<{
    member_id: number; name: string;
    composite_score: number | null; yt_avg_views: number | null;
    sufficient: boolean;
  }>;
  analytics: {
    snapshot_at: string;
    countries: Array<{
      country: string; watch_share: number; growth_mom: number | null;
      retention_rel: number; sub_per_1k: number;
      watch_minutes: number | null; organic_share: number | null;
      subs_gained: number | null;
    }>;
    returning_viewers_30d: number | null;
    membership_count: number | null;
    membership_penetration: number | null;
    has_super_chat: boolean | null;
  } | null;
  goods_preorder: Array<{
    country: string; member_id: number | null; count: number; source: string;
  }>;
};

// Controversy thresholds: see src/lib/alerts.ts.

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
      { verb: "PR·SNS 카운트다운 슬롯 1차 콘텐츠 발행",            owner: "콘텐츠팀", due: "D-25 까지" },
      { verb: "미디어 보도자료 초안 IPX·Abyss 검토 의뢰",          owner: "PR팀",     due: "D-21 까지" },
      { verb: "그룹 공식 채널(YT/X/Instagram) 콘텐츠 큐 14일치 확보", owner: "콘텐츠팀", due: "D-14 까지" },
      { verb: "D-7 / D-1 자동 알림 트리거 사전 점검",              owner: "BI",       due: "이번 주" },
    ],
  },
  controversy_spike: {
    steps: [
      { verb: "발단이 된 트윗·게시글 원문 보존 (스크린샷+URL)", owner: "PR팀",  due: "1시간 내" },
      { verb: "네이버·디시·더쿠 등 다른 커뮤니티로 확산됐는지 확인", owner: "BI", due: "오늘 안" },
      { verb: "대응 / 무대응 결정 — 기본은 무대응",         owner: "PR리드", due: "오늘 안",
        detail: "공식 대응이 오히려 이슈를 키울 수 있어, 오인 신고일수록 무대응이 안전." },
      { verb: "24시간 후 논란 글 수 재측정 + 가라앉았는지 판정", owner: "BI",    due: "내일" },
    ],
    note: "공식 대응은 오히려 확산을 키울 수 있음. 사람이 직접 확인한 뒤 결정.",
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
      { verb: "확산 속도가 전주 3배 이상이면 광고 집행 검토", owner: "마케팅팀", due: "조건부" },
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
      line: "위기 신호 감지 — 위기 모니터 우선 점검 후 대응 시작.",
    };
  }
  if (days == null) {
    return { tone: "ok", line: "데뷔일 미정 — 일정 확정 후 데뷔 기준 성장 추적 시작." };
  }
  if (debuted) {
    const dPlus = -days;
    if (dPlus <= 7) {
      return {
        tone: "warn",
        line: `데뷔 D+${dPlus} — 초기 반응 측정 구간. 첫 24시간 확산 속도·첫 주 언급 점유율 변화에 즉각 반응.`,
      };
    }
    return {
      tone: grade === "S" || grade === "A" ? "ok" : "warn",
      line: `데뷔 D+${dPlus} — 건강 점수 ${grade ?? "—"} 등급 기준 ${grade === "S" || grade === "A" ? "성장 흐름 유지" : "약점 보완"} 우선.`,
    };
  }
  if (days <= 7) {
    return {
      tone: "warn",
      line: `데뷔 D-${days} — 마지막 준비 구간. 실행 권고 목록 우선 처리, 대기 중인 알림 모두 정리.`,
    };
  }
  if (days <= 30) {
    return {
      tone: hasWarn ? "warn" : "ok",
      line: `데뷔 D-${days} — 가속 구간. 동시기 팀 대비 격차가 가장 큰 지표 1개에 콘텐츠·PR 집중.`,
    };
  }
  return {
    tone: "ok",
    line: `데뷔 D-${days} — 기초 데이터 누적 단계. 동시기 팀 대비 성장 곡선 추적 + 공식 채널 업로드 페이스 유지.`,
  };
}

// Alert rule labels / severity tones: see src/lib/alerts.ts.

// insights.type / health breakdown 키는 백엔드 enum 원문 — 경영진·투자자
// 화면에 raw 토큰을 내보내지 않도록 여기서 한국어 라벨로 치환한다
// (alerts.ts ALERT_RULE_LABEL과 같은 패턴).
const INSIGHT_TYPE_LABEL: Record<string, string> = {
  insight:    "분석",
  ipx_action: "실행 권고",
  weekly:     "주간 요약",
  diagnosis:  "진단",
};

const HEALTH_DIMENSION_LABEL: Record<string, string> = {
  subscribers: "구독자",
  views:       "조회수",
  quality:     "반응 품질",
  community:   "커뮤니티",
  news:        "뉴스",
  risk:        "리스크",
};

// 보고서의 "이전 상황"과 "전망" 축 — 기존 summary/prev/history에서 파생만
// 하고 새 수집은 없다. 전망은 최근 스냅샷 기울기의 단순 연장이라 반드시
// (추정) 표기와 함께 노출한다 (est 배지와 같은 정직성 원칙).
function weeklyOutlook(d: MiiwanData): { lastWeek: string | null; forecast: string | null } {
  const cur = d.summary;
  const prev = d.prev_summary;

  let lastWeek: string | null = null;
  if (cur && prev) {
    const parts: string[] = [];
    const push = (label: string, c?: number | null, p?: number | null) => {
      if (c == null || p == null || c === p) return;
      const diff = c - p;
      parts.push(`${label} ${diff > 0 ? "+" : "−"}${fmt(Math.abs(diff))}`);
    };
    push("구독자", cur.yt_subscribers, prev.yt_subscribers);
    push("누적 조회수", cur.yt_total_views, prev.yt_total_views);
    push("뉴스", cur.naver_total_news, prev.naver_total_news);
    if (parts.length) lastWeek = parts.slice(0, 3).join(" · ");
  }

  // 구독자 최근 ~7일 기울기 → +7일 투영. 표본이 3일 미만이면 노출 안 함.
  let forecast: string | null = null;
  const h = (d.summary_history ?? []).filter(
    (r) => r.yt_subscribers != null && r.snapshot_at,
  );
  if (h.length >= 2) {
    const last = h[h.length - 1]!;
    const lastT = Date.parse(last.snapshot_at);
    let base = h[0]!;
    for (const r of h) {
      if (lastT - Date.parse(r.snapshot_at) >= 6.5 * 86_400_000) base = r;
      else break;
    }
    const days = (lastT - Date.parse(base.snapshot_at)) / 86_400_000;
    if (days >= 3 && base.yt_subscribers != null && last.yt_subscribers != null) {
      const perDay = (last.yt_subscribers - base.yt_subscribers) / days;
      const proj = Math.round((last.yt_subscribers + perDay * 7) / 100) * 100;
      forecast = `이 페이스면 다음 주 구독자 약 ${fmt(proj)} (최근 ${Math.round(days)}일 추세 연장 · 추정)`;
    }
  }

  return { lastWeek, forecast };
}

const DIAGNOSIS_TONE: Record<"ok" | "warn" | "critical", string> = {
  ok:       "border-emerald-500/40 bg-emerald-500/5 text-emerald-200",
  warn:     "border-amber-500/40 bg-amber-500/5 text-amber-200",
  critical: "border-red-500/60 bg-red-500/10 text-red-200",
};

export function MiiWANBriefing() {
  const [data, setData] = useState<MiiwanData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showMembers, setShowMembers] = useState<boolean>(false);
  // 뷰 3분리: 운영 브리핑(시계열) / 포지션(시장 좌표) / 시장 분석(국가·굿즈).
  const [mode, setMode] = useState<"briefing" | "position" | "market">("briefing");
  // 히어로에 승격된 동시기 비교 결론 — 동시기 성과 섹션과 같은 API를 쓰고
  // 문구는 headline()이 자동 산출(하드코딩 금지 원칙 동일). 실패 시 조용히
  // 생략 — 히어로가 이 줄 없이도 성립해야 한다.
  const [cohortHead, setCohortHead] = useState<Headline | null>(null);

  useEffect(() => {
    api.miiwan().then((d) => {
      setData(d);
      // Auto-show member roster when within last-mile window or
      // post-debut. Operators rarely need it earlier.
      setShowMembers(d.days_to_debut == null || d.days_to_debut <= 7);
    }).catch((e) => setErr(String(e)));
    api.miiwanCohort()
      .then((d) => { try { setCohortHead(headline(d)); } catch { /* 데이터 미성숙 — 생략 */ } })
      .catch(() => {});
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
  const outlook = weeklyOutlook(data);
  const actionCount = ipxActions.length + otherAlerts.length;

  return (
    <div class="space-y-6">
      {/* 1) STRATEGIC HERO — 한 줄 진단이 가장 강한 시각 weight를
          차지하도록 구성. 위치(D-day) + 상태(Health) + 진척(멤버
          커버리지)을 한 row에. */}
      <section
        class="rounded-card border-l-4 border border-zinc-800 bg-zinc-900/40 p-5"
        style={{ borderLeftColor: accent }}
      >
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 class="text-2xl font-bold">
            {data.group.name} · <span class="text-zinc-400">{data.group.name_kr}</span>
          </h1>
          <span class="text-hint text-zinc-500">
            데뷔 {data.group.debut_date ?? "—"} (IPX × Abyss Company)
          </span>
          {/* 뷰 토글 — 히어로 헤더 행 우측에 pill 버튼으로 배치. 항상 위에 보임. */}
          <div role="tablist" aria-label="MiiWAN 뷰" class="ml-auto flex gap-1">
            {([["briefing", "브리핑"], ["position", "포지션"], ["market", "시장 분석"]] as const).map(([k, label]) => {
              const on = mode === k;
              return (
                <button key={k} role="tab" aria-selected={on}
                  class={"rounded-full px-3 py-1 text-sm font-medium border transition "
                    + (on
                      ? "border-[#75d7d1] bg-[#75d7d1]/10 text-[#75d7d1]"
                      : "border-zinc-700 text-zinc-400 hover:text-zinc-200")}
                  onClick={() => setMode(k)}>
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        <div class={`mt-3 rounded border-l-4 px-3 py-2 text-sm ${DIAGNOSIS_TONE[diag.tone]}`}>
          <span class="font-semibold mr-2">전략 진단</span>{diag.line}
        </div>

        {/* 과거·현재·전망을 히어로에서 각 한 줄로 닫는다 — 경영진·투자자의
            30초 훑기가 스크롤 없이 "그래서 잘 되고 있나"에 답을 얻도록.
            동시기 결론은 코호트 섹션 headline()과 같은 산출물이라 두 화면이
            어긋날 수 없다. */}
        {(cohortHead?.conclusion || outlook.lastWeek || outlook.forecast) && (
          <div class="mt-2 space-y-1 text-sm">
            {cohortHead?.conclusion && (
              <div class="flex flex-wrap items-baseline gap-2">
                <span class="shrink-0 rounded bg-zinc-800/60 px-1.5 py-[1px] text-[10px] text-zinc-400">동시기 비교</span>
                <span class="text-zinc-200">{cohortHead.conclusion}</span>
              </div>
            )}
            {outlook.lastWeek && (
              <div class="flex flex-wrap items-baseline gap-2">
                <span class="shrink-0 rounded bg-zinc-800/60 px-1.5 py-[1px] text-[10px] text-zinc-400">지난 주 대비</span>
                <span class="text-zinc-300">{outlook.lastWeek}</span>
              </div>
            )}
            {outlook.forecast && (
              <div class="flex flex-wrap items-baseline gap-2">
                <span class="shrink-0 rounded bg-zinc-800/60 px-1.5 py-[1px] text-[10px] text-zinc-400">전망</span>
                <span class="text-zinc-300">{outlook.forecast}</span>
              </div>
            )}
          </div>
        )}

        <div class="mt-3 grid gap-3 md:grid-cols-2">
          <DDayCard d={dToDebut} debuted={debuted} accent={accent} />
          <HealthCard h={data.health_score} />
        </div>

        {/* 섹션 점프 칩 — 11개 섹션 세로 나열의 스캔 비용을 줄인다.
            운영자 도구라 브리핑 모드에서만. */}
        {mode === "briefing" && (
          <nav class="mt-3 flex flex-wrap gap-1.5" aria-label="섹션 바로가기">
            {([
              ["sec-kpi", "핵심 지표"],
              ["sec-insights", "주간 분석"],
              ["sec-actions", actionCount > 0 ? `처리 ${actionCount}건` : "처리 목록"],
              ["sec-risk", "위기 모니터"],
              ["sec-cohort", "동시기 성과"],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                class="rounded-full border border-zinc-700 px-2.5 py-0.5 text-xs text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-200"
                onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })}
              >
                {label} ↓
              </button>
            ))}
          </nav>
        )}
      </section>

      {mode === "market" ? (
        <MarketAnalysis
          analytics={data.decision.analytics}
          memberPopularity={data.decision.member_popularity}
          daysToDebut={data.days_to_debut}
        />
      ) : mode === "position" ? (
        <MiiWANPosition
          today={data.today}
          alerts={data.alerts}
          controversyTrend={data.controversy_trend}
          countries={data.decision.analytics?.countries ?? null}
          fanActivity={data.fan_activity}
          cohortHead={cohortHead}
        />
      ) : (<>

      {/* 2) CORE KPIS — 경영진의 첫 질문("숫자는?")이라 히어로 바로 아래.
          커뮤니티·뉴스 지표는 상승=녹색이 오독을 만들 수 있어(게시글 급증은
          논란일 수도) 중립색으로 렌더. */}
      <section id="sec-kpi">
        <h2 class="section-title mb-3">핵심 지표 (최신 스냅샷
          {data.summary ? ` · ${formatKSTDate(data.summary.snapshot_at)} KST` : ""})
        </h2>
        {!data.summary ? (
          <EmptyState
            title="아직 집계된 활동 데이터 없음"
            hint="첫 자동 수집이 끝나면 여기에 채워집니다."
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
          // 델타의 비교 시점 — prev는 "7일 이전의 가장 최근 스냅샷"이라
          // 항상 정확히 1주 전이 아니다. 명시하지 않으면 WoW로 오독된다.
          const dh = p?.snapshot_at ? `vs ${formatKSTDate(p.snapshot_at)}` : undefined;
          return (
            <div class="grid grid-cols-2 gap-2 md:grid-cols-3">
              <KPI label="구독자 (그룹+멤버)"
                   value={data.summary.yt_subscribers}
                   delta={wow(data.summary.yt_subscribers, p?.yt_subscribers)}
                   deltaHint={dh}
                   sparkline={series("yt_subscribers")} />
              <KPI label="누적 조회수"
                   value={data.summary.yt_total_views}
                   delta={wow(data.summary.yt_total_views, p?.yt_total_views)}
                   deltaHint={dh}
                   sparkline={series("yt_total_views")} />
              <KPI label="등록 영상 수"
                   value={data.summary.yt_total_videos}
                   delta={wow(data.summary.yt_total_videos, p?.yt_total_videos)}
                   deltaHint={dh}
                   sparkline={series("yt_total_videos")} />
              <KPI label="네이버 뉴스"
                   value={data.summary.naver_total_news}
                   delta={wow(data.summary.naver_total_news, p?.naver_total_news)}
                   deltaHint={dh}
                   polarity="neutral"
                   sparkline={series("naver_total_news")} />
              <KPI label="디시 게시글"
                   value={data.summary.dc_total_posts}
                   delta={wow(data.summary.dc_total_posts, p?.dc_total_posts)}
                   deltaHint={dh}
                   polarity="neutral"
                   sparkline={series("dc_total_posts")} />
            </div>
          );
        })()}
      </section>

      {/* 3) STRATEGIC INSIGHT — 주간 LLM 분석, MiiWAN-scoped first.
          (2026-07-30 사용자 지시로 Action Queue 위 — 주간 관점의
          "무엇이 중요한가"를 먼저 읽고, 아래에서 오늘의 처리 목록을 본다.) */}
      <section id="sec-insights">
        <h2 class="section-title mb-3">주간 전략 분석
          <span class="ml-2 text-hint font-normal text-zinc-500">AI 자동 분석 · 주 1회</span>
        </h2>
        {data.insights.length === 0 ? (
          <EmptyState
            title="아직 MiiWAN 전용 분석 없음"
            hint="주간 자동 분석이 1회 이상 돌면 여기에 채워집니다. 현재는 시장 인사이트 탭을 참고하세요."
            icon="💡"
          />
        ) : (
          <div class="space-y-4">
            {miiwanScoped.length > 0 && (
              <InsightGroup title="MiiWAN 전용" tone="brand"
                            items={miiwanScoped} accent={accent} isOwn={true} />
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

      {/* 4) ACTION QUEUE — alerts + ipx_actions 통합. 매일 보는
          운영자가 "오늘 무엇을 해야 하나"를 5초 안에 답할 수 있도록
          인사이트 바로 아래에 위치. 빈 상태도 자리 유지 (학습된 위치 유지). */}
      <ActionQueue ipxActions={ipxActions} otherAlerts={otherAlerts} />

      {/* 5) RISK WATCH — virtual-idol critical 카테고리만 별도 섹션.
          액션 클러스터 바로 옆 (07-30 개편 때 하단으로 밀렸던 것을 복귀). */}
      <RiskWatch
        alerts={riskAlerts}
        controversyTrend={data.controversy_trend}
      />

      {/* 6) 동시기 성과 — 데뷔일 정렬(D+N) 벤치마크. 절대값이 아니라
          성장 기울기·순위로 "동시기 대비 잘하고 있는가"를 증명하는 보고서형
          섹션 (투자사 보고 근거). 도입 산문은 접기 — 차트 자체에 데뷔
          세로선·D± 축이 있어 개념 설명이 중복이다. */}
      <section id="sec-cohort">
        <div class="mb-1 flex flex-wrap items-center gap-2">
          <h2 class="section-title">동시기 성과 — 같은 시기에 데뷔한 팀들과 비교</h2>
          <span class="rounded bg-zinc-800/60 px-1.5 py-[1px] text-[11px] text-zinc-400">
            데뷔 창 기준
          </span>
        </div>
        <details class="mb-3">
          <summary class="cursor-pointer list-none text-hint text-zinc-500 hover:text-zinc-300">
            ▸ 읽는 법 — 왜 데뷔일 기준인가
          </summary>
          <p class="mt-1 text-hint text-zinc-500 leading-relaxed">
            팀마다 데뷔한 날이 다르니 규모를 그냥 비교하면 먼저 시작한 팀이 이긴다.
            그래서 각 팀의 데뷔일을 똑같이 출발선에 놓고, 데뷔 후 같은 날짜에 얼마나
            늘었는지를 본다.
          </p>
        </details>
        <MiiWANCohortReport />
      </section>

      {/* 6b) 자연 유입 비교(최근 롤링 창) — 위 동시기 섹션은 '데뷔 창' 기준이라
          같은 팀이라도 숫자가 다르다. 두 카드에 기간 칩을 달아 그 차이를
          제목에서 바로 드러낸다. 개념 산문 2문단은 접기 — 투자자는 긴
          설명문을 읽지 않고, 필요한 사람만 펼친다. */}
      <section class="card">
        <div class="mb-2 flex flex-wrap items-center gap-2">
          <h2 class="section-title">자연 유입 비교 — 경쟁 팀</h2>
          <span class="rounded bg-zinc-800/60 px-1.5 py-[1px] text-[11px] text-zinc-400">
            최근 기간 기준
          </span>
        </div>
        <details class="mb-2">
          <summary class="cursor-pointer list-none text-hint text-zinc-500 hover:text-zinc-300">
            ▸ 읽는 법 — 위 동시기 표와 무엇이 다른가
          </summary>
          <p class="mt-1 text-hint text-zinc-500 leading-relaxed">
            이 막대는 <strong class="text-zinc-300">'진짜인가'</strong>(광고 없이 모인
            팬인지, 규모와 무관) · 위 동시기 표의 조회·구독은
            {" "}<strong class="text-zinc-300">'충분한가'</strong>(규모) — 두 축은 별개라
            자연 유입이 높아도 규모가 충분하다는 뜻은 아니다. 위 섹션은 데뷔 직후
            기간을, 이 카드는 최근 기간을 보므로 같은 팀이라도 숫자가 다를 수 있다.
          </p>
          <p class="mt-2 text-hint text-zinc-500 leading-relaxed">
            데뷔 후 유료 광고를 줄여 조회수가 정점 대비 떨어지는 건 정상일 수 있다.
            건강은 '정점 대비 하락'이 아니라 <strong class="text-zinc-300">광고 없이 도달하는
            바닥선</strong>이 데뷔 전 수준 위에서 유지·상승하는가로 판단한다 —
            자연 유입이 정상이라는 건 '진짜'라는 뜻이지 '충분·지속'의 증거는 아니다.
          </p>
        </details>
        <CompetitorOrganicityBar />
      </section>

      {/* 7) TIMELINE — 최근 30일 + 향후 60일 이벤트 (group_events).
          components/MiiWANEventTimeline — 포지션 뷰와 공유. */}
      <MiiWANEventTimeline today={data.today} />

      {/* 8) 라이브 채팅 반응 — 방송별 긍/부정 대표 멘트 + 비율 추정.
          /api/miiwan-live-chat (live_chat_reports). */}
      <MiiWANLiveChat />

      {/* 9) P2a 찐팬 활동량 — 라이브 채팅 measured 코어 + 영상 estimated 참여.
          /api/miiwan 의 fan_activity (신규 수집 0, 기존 데이터 재가공).
          summary 행 없으면 null 이라 카드 자체를 숨긴다. 실측/추정 배지는
          정직성 장치라 보고 모드에도 유지. */}
      {data.fan_activity && (
        <section>
          <div class="mb-2 flex flex-wrap items-baseline gap-2">
            <h2 class="section-title">찐팬 활동</h2>
            <span class="text-hint text-zinc-500">라이브 단골 코어 + 추정 참여</span>
          </div>
          <FanActivityCard activity={data.fan_activity} />
        </section>
      )}

      {/* 10) MEMBERS — debut D-7 이내 또는 데뷔 후에만 자동 노출.
          MiiWAN 은 corporate K-POP 모델이라 멤버별 솔로 채널을
          운영하지 않음 → 카드는 이름·영문명만 표시. */}
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
        </div>
        {showMembers && (
          data.members.length === 0 ? (
            <EmptyState title="멤버 정보 준비 중" icon="👥" />
          ) : (
            <ul class="grid grid-cols-2 gap-2 md:grid-cols-5">
              {data.members.map((m) => (
                <li key={m.id}
                    class="card">
                  <div class="text-base font-semibold">{m.name}</div>
                  {m.name_en && (
                    <div class="text-xs text-zinc-500">{m.name_en}</div>
                  )}
                </li>
              ))}
            </ul>
          )
        )}
      </section>
      </>)}
    </div>
  );

  function ActionQueue(props: {
    ipxActions: Insight[];
    otherAlerts: AlertRow[];
  }) {
    const total = props.ipxActions.length + props.otherAlerts.length;
    return (
      <section
        id="sec-actions"
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
            IPX 실행 권고 + 14일 내 누적된 마일스톤·급상승 알림
          </span>
        </div>

        {total === 0 ? (
          <div class="text-sm text-zinc-300">
            ✓ 처리할 액션 없음 — 자동 감시 중. 새 알림·실행 권고가 생기면 여기에 표시됩니다.
          </div>
        ) : (
          <div class="space-y-3">
            {props.ipxActions.length > 0 && (
              <div>
                <h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-amber-300">
                  IPX 실행 권고 ({props.ipxActions.length})
                </h3>
                <ul class="space-y-2">
                  {props.ipxActions.map((i) => {
                    const score = ipxFiveElements(i.body ?? "", i.title ?? "");
                    const bodyGroups = extractGroupKeys(i.body);
                    return (
                      <li key={i.id}
                          class="rounded border-l-2 border-amber-500 bg-zinc-900/40 p-2.5 text-sm">
                        {/* 상단 라인: 본문 등장 그룹 뱃지 + KST */}
                        {(bodyGroups.length > 0 || i.generated_at) && (
                          <div class="mb-1 flex flex-wrap items-center gap-1.5 text-[10px] text-zinc-500">
                            {bodyGroups.slice(0, 3).map((k) => (
                              <GroupBadge key={k} groupKey={k} size="sm" />
                            ))}
                            {i.generated_at && (
                              <span class="ml-auto tabular-nums" title={formatKST(i.generated_at)}>
                                {formatKSTDate(i.generated_at)}
                              </span>
                            )}
                          </div>
                        )}
                        <div class="text-base font-semibold tracking-tight text-zinc-100">{humanizeInsightText(i.title)}</div>
                        <InsightBody
                          body={i.body}
                          class="mt-1 block text-sm leading-relaxed text-zinc-400"
                        />
                        {i.ai_comment && (
                          <div class="mt-2 rounded border-l-2 border-violet-500/40 bg-violet-500/5 px-2 py-1 text-[12px] italic text-zinc-300">
                            <span class="not-italic mr-1 rounded bg-violet-500/15 px-1 py-[1px] text-[9px] uppercase tracking-wider text-violet-300">AI</span>
                            {humanizeInsightText(i.ai_comment)}
                          </div>
                        )}
                        <IpxActionGuard score={score} />
                        <DataSourceDetails refs={(i.source_refs ?? []) as RawRef[]} />
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
                        <span class="rounded bg-zinc-900/60 px-1.5 text-hint text-zinc-300">
                          {RULE_LABEL[a.rule] ?? a.rule}
                        </span>
                        <span class="font-semibold">{a.title}</span>
                        <span class="ml-auto text-hint text-zinc-500" title={formatKST(a.fired_at)}>
                          {formatKST(a.fired_at)}
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
    const LEVEL_KR: Record<"OK" | "ELEVATED" | "CRITICAL", string> = {
      OK: "정상", ELEVATED: "주의", CRITICAL: "심각",
    };
    const tone =
      level === "CRITICAL" ? "border-red-500 bg-red-500/10 text-red-200"
      : level === "ELEVATED" ? "border-amber-500 bg-amber-500/10 text-amber-200"
      : "border-emerald-500/40 bg-emerald-500/5 text-emerald-200";

    return (
      <section id="sec-risk">
        <div class="mb-3 flex flex-wrap items-baseline gap-2">
          <h2 class="section-title">위기 모니터</h2>
          <span class="text-hint text-zinc-500">
            가상 아이돌 운영의 심각 시나리오만 별도. 본체 노출 / AI 도용 / 논란 급증.
          </span>
        </div>

        <div class={`rounded border-l-4 px-3 py-2 text-sm ${tone}`}>
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-semibold">위험도: {LEVEL_KR[level]}</span>
            {props.controversyTrend && (
              <span class="rounded bg-zinc-900/50 px-2 py-0.5 text-xs">
                논란 이번 주 {cur} · 직전 주 {prev}
                {ratio != null && Number.isFinite(ratio) && ` (${ratio.toFixed(1)}×)`}
              </span>
            )}
            {isSpiking && (
              <span class="rounded bg-amber-500/20 px-2 py-0.5 text-xs text-amber-200">
                전주 대비 ≥{CONTROVERSY_SPIKE_MULTIPLIER}배 이상 · 최소 기준 {CONTROVERSY_SPIKE_MIN_COUNT}건
              </span>
            )}
          </div>
          {level !== "OK" && (
            <div class="mt-1 text-xs text-zinc-300">
              ※ 자동 알림 — 사람이 확인한 뒤 대응 권장. 오탐일 때 공식 대응은 오히려 확산을 키울 수 있음.
            </div>
          )}
        </div>

        {props.alerts.length > 0 && (
          <ul class="mt-3 space-y-2">
            {props.alerts.map((a) => (
              <li key={a.alert_key}
                  class={`rounded border-l-2 p-3 ${SEVERITY_TONE[a.severity]}`}>
                <div class="flex items-baseline gap-2">
                  <span class="rounded bg-zinc-900/60 px-1.5 text-hint text-zinc-300">
                    {RULE_LABEL[a.rule] ?? a.rule}
                  </span>
                  <span class="font-semibold">{a.title}</span>
                  <span class="ml-auto text-hint text-zinc-500" title={formatKST(a.fired_at)}>
                    {formatKST(a.fired_at)}
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
      <div class="mb-1.5 flex items-center gap-2 text-hint uppercase tracking-wider text-zinc-400">
        <span>권장 동선</span>
        <span class="rounded bg-zinc-800/60 px-1.5 py-[1px] text-[10px] text-zinc-500">
          할 일 · 담당 · 기한
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
              <span class="basis-full pl-6 text-hint text-zinc-500">{s.detail}</span>
            )}
          </li>
        ))}
      </ol>
      {pb.note && (
        <div class="mt-2 rounded border-l-2 border-amber-500/60 bg-amber-500/5 px-2 py-1 text-hint text-amber-200">
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
  const allGood = score.missing.length === 0 && !score.antipattern;

  // 문제 없으면 단일 녹색 배지만 노출 — 칩 5개가 시각 노이즈를 만드는 것을 방지.
  if (allGood) {
    return (
      <div class="mt-2">
        <span class="rounded bg-emerald-500/10 px-2 py-[2px] text-[10px] text-emerald-300"
              title="행동·담당·기한·측정·조건 모두 충족">
          ✓ 실행 요건 충족
        </span>
      </div>
    );
  }

  // 미달 케이스도 기본은 배지 한 개 — 상세(빠진 항목·예시)는 접어 둔다.
  // 이 배너는 운영자용 작성 가이드지 화면의 결론이 아니다. 펼치기 전에는
  // "보완 필요"라는 사실만 전달하면 충분하다.
  return (
    <details class="group mt-2">
      <summary class="cursor-pointer list-none">
        <span class="rounded bg-amber-500/10 px-2 py-[2px] text-[10px] text-amber-300">
          △ 구체화 필요{weak ? " — 그대로 실행하지 말 것" : ""}
          <span class="ml-1 text-amber-200/60 group-open:hidden">▸ 상세</span>
          <span class="ml-1 hidden text-amber-200/60 group-open:inline">▾ 접기</span>
        </span>
      </summary>
      <div class="mt-1.5 space-y-1.5">
        <div class="flex flex-wrap items-center gap-1">
          <span class="text-[10px] uppercase tracking-wider text-zinc-500">
            실행 요건 점검
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
          <div class="rounded border border-amber-500/40 bg-amber-500/5 px-2 py-1.5 text-hint text-amber-200">
            <div class="mt-0.5 text-amber-100/80">
              {score.antipattern
                ? "본문에 실행 없는 표현 (\"전략적\"·\"검토 필요\"·\"면밀히 모니터링\") 포함. "
                : ""}
              빠진 항목을 채워 다시 작성: 행동 동사 / 담당자 / 기한 / 측정 가능한 목표 / 조건.
            </div>
            <div class="mt-1 rounded bg-zinc-950/40 px-2 py-1 font-mono text-[10.5px] text-zinc-300">
              예) "<span class="text-emerald-300">콘텐츠팀</span>이 <span class="text-emerald-300">D-21까지</span> <span class="text-emerald-300">티저 영상 1건 발행</span>, <span class="text-emerald-300">조회수 ≥ 5만</span> 미달 시 <span class="text-emerald-300">광고 집행 결정</span>"
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

interface LiveChatQuote { quote: string; note?: string }
interface LiveChatTheme { label: string; polarity: string }
interface LiveChatReportBody {
  positive?: LiveChatQuote[];
  negative?: LiveChatQuote[];
  positive_all?: string[];
  negative_all?: string[];
  themes?: LiveChatTheme[];
  summary?: string;
}
interface LiveChatReport {
  video_id: string;
  title: string | null;
  ended_at: string | null;
  total_messages: number;
  sampled: number;
  positive_ratio: number | null;
  negative_ratio: number | null;
  report: LiveChatReportBody | null;
}

function MiiWANLiveChat() {
  const [available, setAvailable] = useState<AvailEntry[] | null>(null);
  const [report, setReport] = useState<LiveChatReport | null>(null);
  const [loadingReport, setLoadingReport] = useState(false);
  const [calOpen, setCalOpen] = useState(false);
  // 달력이 보여줄 월(0-based). null 이면 선택 리포트(또는 오늘) 월로 lazy 초기화.
  const [cursor, setCursor] = useState<{ y: number; m: number } | null>(null);

  // 최초 로드: 전체 날짜(available) + 최신 리포트(report)
  useEffect(() => {
    api.miiwanLiveChat()
      .then((d) => { setAvailable(d?.available ?? []); setReport(d?.report ?? null); })
      .catch(() => { setAvailable([]); setReport(null); });
  }, []);

  const idx = useMemo(() => liveDateIndex(available ?? []), [available]);
  const selectedDate = report?.ended_at ? formatKSTDate(report.ended_at) : null;

  function pick(dateStr: string) {
    const vid = idx.byDate.get(dateStr);
    setCalOpen(false);
    if (!vid || vid === report?.video_id) return;
    setLoadingReport(true);
    api.miiwanLiveChat(vid)
      .then((d) => { if (d?.report) setReport(d.report); })
      .catch(() => {})
      .finally(() => setLoadingReport(false));
  }

  if (!available) {
    return (
      <section>
        <h2 class="section-title mb-3">라이브 채팅 반응</h2>
        <div class="text-hint text-zinc-500">Loading…</div>
      </section>
    );
  }

  if (available.length === 0) {
    return (
      <section>
        <h2 class="section-title mb-3">라이브 채팅 반응</h2>
        <div class="text-hint text-zinc-500">
          아직 분석된 라이브 방송이 없어요. 방송 종료 후 새벽에 자동 수집됩니다.
        </div>
      </section>
    );
  }

  // 달력 기준 월: cursor 우선, 없으면 선택 리포트(또는 오늘) 월
  const anchor = selectedDate ?? todayKST();
  const [ayS = "1970", amS = "1"] = anchor.split("-");
  const view = cursor ?? { y: Number(ayS), m: Number(amS) - 1 };
  const stepMonth = (delta: number) => {
    const d = new Date(Date.UTC(view.y, view.m + delta, 1));
    setCursor({ y: d.getUTCFullYear(), m: d.getUTCMonth() });
  };

  return (
    <section>
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <h2 class="section-title">라이브 채팅 반응</h2>
        <span class="text-hint text-zinc-500">
          방송 종료 후 채팅 리플레이를 수집 · 비율은 표본 기반 추정
        </span>
        <div class="relative ml-auto">
          <button
            type="button"
            onClick={() => { setCursor(null); setCalOpen((o) => !o); }}
            class="flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900/60 px-2 py-1 text-xs text-zinc-300 hover:border-zinc-500"
            title="라이브가 있었던 날짜 선택"
          >
            <span>📅</span>
            <span class="tabular-nums">{selectedDate ?? "날짜"}</span>
            <span class="text-zinc-600">▾</span>
          </button>
          {calOpen && (
            <LiveChatCalendar
              year={view.y}
              month0={view.m}
              liveDates={idx.dates}
              selected={selectedDate}
              onPrev={() => stepMonth(-1)}
              onNext={() => stepMonth(1)}
              onPick={pick}
              onClose={() => setCalOpen(false)}
            />
          )}
        </div>
      </div>
      <div class={loadingReport ? "opacity-50 transition-opacity" : ""}>
        {report
          ? <LiveChatReportCard r={report} />
          : <div class="text-hint text-zinc-500">리포트를 불러오지 못했어요.</div>}
      </div>
    </section>
  );
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

function LiveChatCalendar(
  { year, month0, liveDates, selected, onPrev, onNext, onPick, onClose }: {
    year: number; month0: number; liveDates: Set<string>; selected: string | null;
    onPrev: () => void; onNext: () => void;
    onPick: (d: string) => void; onClose: () => void;
  },
) {
  const weeks = monthMatrix(year, month0);
  return (
    <>
      {/* click-away backdrop */}
      <div class="fixed inset-0 z-10" onClick={onClose} />
      <div class="absolute right-0 z-20 mt-1 w-64 rounded-lg border border-zinc-700 bg-zinc-900 p-2 shadow-xl">
        <div class="mb-1 flex items-center justify-between">
          <button type="button" onClick={onPrev}
            class="rounded px-2 py-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">‹</button>
          <span class="text-xs font-semibold tabular-nums text-zinc-200">
            {year}.{String(month0 + 1).padStart(2, "0")}
          </span>
          <button type="button" onClick={onNext}
            class="rounded px-2 py-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">›</button>
        </div>
        <div class="grid grid-cols-7 gap-0.5 text-center text-[10px] text-zinc-500">
          {WEEKDAYS.map((w) => <div key={w} class="py-0.5">{w}</div>)}
        </div>
        <div class="grid grid-cols-7 gap-0.5">
          {weeks.flat().map((day, i) => {
            if (!day) return <div key={i} />;
            const dnum = Number(day.slice(8, 10));
            const hasLive = liveDates.has(day);
            const isSel = day === selected;
            const base = "h-7 rounded text-xs tabular-nums transition-colors";
            if (!hasLive) {
              return (
                <div key={i} class={`${base} flex items-center justify-center text-zinc-700`}>
                  {dnum}
                </div>
              );
            }
            const tone = isSel
              ? "bg-emerald-500 font-semibold text-zinc-950"
              : "bg-emerald-500/15 font-medium text-emerald-300 hover:bg-emerald-500/30";
            return (
              <button key={i} type="button" onClick={() => onPick(day)}
                class={`${base} ${tone}`} title={`${day} 라이브 채팅 반응`}>
                {dnum}
              </button>
            );
          })}
        </div>
        <div class="mt-1.5 flex items-center gap-1 text-[10px] text-zinc-500">
          <span class="inline-block h-2 w-2 rounded-sm bg-emerald-500/40" /> 라이브 있던 날
        </div>
      </div>
    </>
  );
}

function LiveChatReportCard({ r }: { r: LiveChatReport }) {
  const pos = Math.round((r.positive_ratio ?? 0) * 100);
  const neg = Math.round((r.negative_ratio ?? 0) * 100);
  const neu = Math.max(0, 100 - pos - neg);
  const body = r.report;
  const endedDate = r.ended_at ? r.ended_at.slice(0, 10) : "—";
  return (
    <div class="card">
      <div class="flex flex-wrap items-baseline gap-2">
        <span class="font-semibold">{r.title ?? "(제목 없음)"}</span>
        <span class="tabular-nums text-zinc-500">{endedDate}</span>
        <span class="ml-auto rounded bg-zinc-900/60 px-1.5 text-hint tabular-nums text-zinc-300">
          총 {r.total_messages.toLocaleString()}건 · 표본 {r.sampled.toLocaleString()}
        </span>
      </div>

      {/* 긍/부정 비율 바 (추정) */}
      <div class="mt-2 flex items-center gap-2">
        <div class="flex h-2.5 flex-1 overflow-hidden rounded-full bg-zinc-800">
          <div class="bg-emerald-500" style={{ width: `${pos}%` }} />
          <div class="bg-zinc-600" style={{ width: `${neu}%` }} />
          <div class="bg-rose-500" style={{ width: `${neg}%` }} />
        </div>
        <span class="text-hint tabular-nums text-zinc-400">
          <span class="text-emerald-400">긍정 {pos}%</span>
          {" · "}
          <span class="text-rose-400">부정 {neg}%</span>
          <span class="text-zinc-500"> (추정)</span>
        </span>
      </div>

      {body?.summary && (
        <div class="mt-2 text-sm text-zinc-300">{body.summary}</div>
      )}

      <div class="mt-2 grid gap-3 md:grid-cols-2">
        {!!body?.positive?.length && (
          <div>
            <div class="mb-1 text-xs font-semibold text-emerald-400">👍 주요 긍정</div>
            <ul class="space-y-1">
              {body.positive.slice(0, 5).map((q, i) => (
                <li key={i} class="rounded border-l-2 border-emerald-500/40 bg-emerald-500/5 px-2 py-1 text-xs text-zinc-300">
                  {q.quote}
                </li>
              ))}
            </ul>
          </div>
        )}
        {!!body?.negative?.length && (
          <div>
            <div class="mb-1 text-xs font-semibold text-rose-400">👎 주요 부정</div>
            <ul class="space-y-1">
              {body.negative.slice(0, 5).map((q, i) => (
                <li key={i} class="rounded border-l-2 border-rose-500/40 bg-rose-500/5 px-2 py-1 text-xs text-zinc-300">
                  {q.quote}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {!!body?.themes?.length && (
        <div class="mt-2 flex flex-wrap gap-1.5">
          {body.themes.map((t, i) => {
            const tone = t.polarity === "positive"
              ? "border-emerald-500/40 text-emerald-200"
              : t.polarity === "negative"
              ? "border-rose-500/40 text-rose-200"
              : "border-zinc-700 text-zinc-400";
            return (
              <span key={i} class={`rounded-full border px-2 py-0.5 text-hint ${tone}`}>
                {t.label}
              </span>
            );
          })}
        </div>
      )}

      {(!!body?.positive_all?.length || !!body?.negative_all?.length) && (
        <details class="group mt-2">
          <summary class="cursor-pointer list-none text-xs text-zinc-400 hover:text-zinc-200">
            <span class="group-open:hidden">▸ 표본 채팅 전체 보기</span>
            <span class="hidden group-open:inline">▾ 표본 채팅 접기</span>
            <span class="ml-1 tabular-nums text-zinc-500">
              (긍정 {body?.positive_all?.length ?? 0} · 부정 {body?.negative_all?.length ?? 0})
            </span>
          </summary>
          <div class="mt-2 grid gap-3 md:grid-cols-2">
            {!!body?.positive_all?.length && (
              <div>
                <div class="mb-1 text-xs font-semibold text-emerald-400">
                  👍 긍정 표본 {body.positive_all.length}건
                </div>
                <ul class="max-h-72 space-y-1 overflow-y-auto pr-1">
                  {body.positive_all.map((m, i) => (
                    <li key={i} class="rounded border-l-2 border-emerald-500/30 bg-emerald-500/5 px-2 py-1 text-xs text-zinc-300">
                      {m}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!!body?.negative_all?.length && (
              <div>
                <div class="mb-1 text-xs font-semibold text-rose-400">
                  👎 부정 표본 {body.negative_all.length}건
                </div>
                <ul class="max-h-72 space-y-1 overflow-y-auto pr-1">
                  {body.negative_all.map((m, i) => (
                    <li key={i} class="rounded border-l-2 border-rose-500/30 bg-rose-500/5 px-2 py-1 text-xs text-zinc-300">
                      {m}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

function DDayCard({ d, debuted, accent }:
                  { d: number | null; debuted: boolean; accent: string }) {
  if (d == null) {
    return (
      <div class="card p-4">
        <div class="text-xs uppercase tracking-wider text-zinc-500">데뷔까지</div>
        <div class="mt-1 text-2xl font-bold text-zinc-400">미정</div>
      </div>
    );
  }
  const label = debuted ? "데뷔 완료" : "데뷔까지";
  const big = debuted ? `D+${Math.abs(d)}` : `D-${d}`;
  return (
    <div class="card p-4"
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
      <div class="card p-4">
        <div class="text-xs uppercase tracking-wider text-zinc-500">건강 점수</div>
        <div class="mt-1 text-2xl font-bold text-zinc-400">데뷔 전</div>
        <div class="mt-0.5 text-hint text-zinc-500">점수 산정 보류</div>
      </div>
    );
  }
  // 가장 낮은 3개 차원 — "왜 이 등급인가"를 히어로에서 바로 답해줌.
  const bottomThree = h.breakdown && Object.keys(h.breakdown).length > 0
    ? Object.entries(h.breakdown).sort(([, a], [, b]) => a - b).slice(0, 3)
    : [];
  return (
    <div class="card p-4">
      <div class="text-xs uppercase tracking-wider text-zinc-500">건강 점수
        <span class="ml-1 normal-case tracking-normal text-zinc-600">(10점 만점)</span>
      </div>
      <div class="mt-1 flex items-baseline gap-2">
        <div class="text-3xl font-bold tabular-nums">{h.total.toFixed(1)}</div>
        <div class="text-lg font-semibold text-zinc-400">{h.grade}</div>
      </div>
      <div class="mt-0.5 text-hint text-zinc-500">{h.label ?? ""}</div>
      {bottomThree.length > 0 && (
        <div class="mt-1.5 flex flex-wrap gap-1">
          <span class="text-[10px] text-zinc-600">보완 우선:</span>
          {bottomThree.map(([k, v]) => (
            <span key={k} class="rounded bg-zinc-800/60 px-1.5 py-[1px] text-[10px] text-zinc-500">
              {HEALTH_DIMENSION_LABEL[k] ?? k} {v}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function InsightGroup(props: {
  title: string; items: Insight[];
  tone: "brand" | "action" | "muted";
  accent?: string; hint?: string;
  /** 자사(MiiWAN) 인사이트: accent bar를 #75d7d1으로 강제하고 faint 배경 추가. */
  isOwn?: boolean;
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
      <ul class="space-y-2.5">
        {props.items.map((i) => {
          const bodyGroups = extractGroupKeys(i.body);
          const accentKey = bodyGroups[0] ?? null;
          const ownStyle = props.isOwn
            ? { borderLeftColor: "#75d7d1", backgroundColor: "rgba(117,215,209,0.04)" }
            : { borderLeftColor: colorOf(accentKey) };
          return (
            <li
              key={i.id}
              class={`rounded-lg border p-3 border-l-4 ${toneCls}`}
              style={ownStyle}
            >
              {/* 상단 라인 — 그룹 뱃지 + 종류 + KST. scope raw 텍스트는
                  그룹 헤더("MiiWAN 전용"/"관련 시장")가 이미 전달하는 정보라
                  제거, type은 백엔드 enum이 아니라 한국어 라벨로. */}
              <div class="flex flex-wrap items-center gap-1.5 text-hint text-zinc-500">
                {bodyGroups.slice(0, 3).map((k) => (
                  <GroupBadge key={k} groupKey={k} size="sm" />
                ))}
                <span class="rounded bg-zinc-800/60 px-1.5 py-[1px] text-[10px] tracking-wider text-zinc-400">
                  {INSIGHT_TYPE_LABEL[i.type] ?? i.type}
                </span>
                <span class="ml-auto tabular-nums" title={formatKST(i.generated_at)}>
                  {formatKSTDate(i.generated_at)}
                </span>
              </div>
              <div class="mt-1 text-base font-semibold tracking-tight text-zinc-100">{humanizeInsightText(i.title)}</div>
              <InsightBody
                body={i.body}
                class="mt-1 block text-sm leading-relaxed text-zinc-400"
              />
              {i.ai_comment && (
                <div class="mt-2 rounded border-l-2 border-violet-500/40 bg-violet-500/5 px-2 py-1 text-[12px] italic text-zinc-300">
                  <span class="not-italic mr-1 rounded bg-violet-500/15 px-1 py-[1px] text-[9px] uppercase tracking-wider text-violet-300">AI</span>
                  {humanizeInsightText(i.ai_comment)}
                </div>
              )}
              <DataSourceDetails refs={(i.source_refs ?? []) as RawRef[]} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
