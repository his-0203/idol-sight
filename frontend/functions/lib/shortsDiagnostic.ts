// MiiWAN 숏츠 운영 진단 — 순수 헬퍼.
// 설계: docs/superpowers/specs/2026-06-02-shorts-trend-and-miiwan-diagnostic-design.md
// 임계값은 Task 2 의 THRESHOLDS 상수에 모은다. 본 파일 전체가 부수효과 없는
// 순수 함수라 vitest 로 단독 검증 가능하고, API 에서 그대로 호출한다.

export function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function mean(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function stdev(nums: number[]): number {
  if (nums.length === 0) return 0;
  const m = mean(nums);
  return Math.sqrt(mean(nums.map((n) => (n - m) ** 2)));
}

export function coefficientOfVariation(nums: number[]): number {
  const m = mean(nums);
  return m === 0 ? 0 : stdev(nums) / m;
}

export function breakoutRatio(views: number[]): number {
  const med = median(views);
  return med === 0 ? 0 : Math.max(...views) / med;
}

// median ±40% 밴드 안에 들어오는 표본 비율 (0~1). 높을수록 '평탄·정체'.
export function bandConcentration(views: number[]): number {
  if (views.length === 0) return 0;
  const med = median(views);
  if (med === 0) return 0;
  const lo = med * 0.6, hi = med * 1.4;
  return views.filter((v) => v >= lo && v <= hi).length / views.length;
}

function toMs(iso: string): number {
  // SQLite 'YYYY-MM-DD HH:MM:SS' (Z 없음) 도 UTC 로 취급.
  let s = iso.trim();
  if (s.includes(" ") && !s.includes("T")) s = s.replace(" ", "T");
  if (!/[Z+]|[+-]\d\d:?\d\d$/.test(s)) s += "Z";
  return Date.parse(s);
}

// 게시 시각 정렬 후 인접 간격(일)의 중앙값. 표본 2개 미만이면 0.
export function cadenceDays(publishedAts: string[]): number {
  const ms = publishedAts.map(toMs).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
  if (ms.length < 2) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < ms.length; i++) gaps.push((ms[i]! - ms[i - 1]!) / 86_400_000);
  return median(gaps);
}

export function titleHasGroupToken(title: string | null, tokens: string[]): boolean {
  if (!title) return false;
  const t = title.toLowerCase();
  return tokens.some((tok) => tok && t.includes(tok.toLowerCase()));
}

// 이모지(Extended_Pictographic) · "기타 기호"(\p{So}: ★☆♥ 등) · 장식 문장부호 curated set.
// \p{S} 전체(수학기호 \p{Sm}: + = ~ × | < >, 통화 \p{Sc}) 는 일반 제목에서 흔해
// 오탐을 유발하므로 의도적으로 제외. '?!' '…' '~' 도 장식 아님.
const DECORATION_RE = /\p{Extended_Pictographic}|\p{So}|[‧꒰꒱ა⟡⟢✦✧⋆˚₊]/u;
export function titleHasDecoration(title: string | null): boolean {
  return !!title && DECORATION_RE.test(title);
}

export function titleHasHashtag(title: string | null): boolean {
  return !!title && title.includes("#");
}

export function coveragePct<T>(rows: T[], pred: (r: T) => boolean): number {
  if (rows.length === 0) return 0;
  return (rows.filter(pred).length / rows.length) * 100;
}

// 정규화 HHI: 0=완전 균등, 1=완전 집중. n<2 또는 합 0 → null.
export function normalizedHHI(shares: number[]): number | null {
  const vals = shares.filter((s) => s > 0);
  const n = shares.length;
  if (n < 2) return null;
  const total = vals.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const hhi = vals.reduce((acc, s) => acc + (s / total) ** 2, 0);
  const floor = 1 / n;
  return (hhi - floor) / (1 - floor);
}

// 공식 그룹명 토큰만 추출 (멤버 별명·초성 약자 제외). name/name_kr 을 기준으로,
// context_keywords 중 그 이름과 부분문자열 관계인 것(대소문자 변형·축약)만 인정.
// 알려진 한계: 공백·숫자 치환 변형(예: WeGoSix→"wego6"/"we go six")은
// 부분문자열 관계가 아니라 누락된다. MiiWAN 변형은 부분문자열(미완/miiwan)이라
// 현재 영향 없음. 타 그룹 coverage 에 재사용 시 정밀 토큰 사전 도입 검토.
export function groupNameVariants(
  name: string | null, nameKr: string | null, contextKeywords: string[],
): string[] {
  const base = [name, nameKr].filter((x): x is string => !!x);
  const lc = (s: string) => s.toLowerCase();
  const variants = contextKeywords.filter((k) =>
    base.some((b) => lc(b).includes(lc(k)) || lc(k).includes(lc(b))));
  return Array.from(new Set([...base, ...variants]));
}

export type Status = "good" | "warn" | "bad" | "na";

export interface ShortRow {
  video_id: string;
  title: string | null;
  published_at: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  viral_velocity_ratio: number | null;
}

export interface Kpi {
  id: string;
  label: string;
  value: number | null;
  display: string;
  status: Status;
  target: string;
  why: string;
  fix: string;
}

export interface DiagnosticInput {
  group_key: string;
  shorts: ShortRow[];
  groupTokens: string[];
  subscribers: number | null;
  memberShares: number[];
}

export interface Diagnostic {
  group_key: string;
  shorts_n: number;
  dimensions: {
    viral_physics: Kpi[];
    discoverability: Kpi[];
    core_strength: Kpi[];
    operating_rhythm: Kpi[];
  };
  priorities: Array<{ id: string; label: string; display: string; fix: string }>;
  caveats: string[];
}

export interface Threshold {
  good: number;
  warn: number;
  direction: "higher" | "lower";
}

export function statusByThresholds(value: number, t: Threshold): Status {
  if (t.direction === "higher") {
    if (value >= t.good) return "good";
    if (value >= t.warn) return "warn";
    return "bad";
  }
  if (value <= t.good) return "good";
  if (value <= t.warn) return "warn";
  return "bad";
}

// 표본이 이 미만이면 분포 기반(A. 바이럴 물리) KPI 는 na 처리.
const SMALL_SAMPLE = 5;

const T = {
  breakout:   { good: 10,  warn: 3,   direction: "higher" } as Threshold,
  cv:         { good: 0.8, warn: 0.4, direction: "higher" } as Threshold,
  band:       { good: 0.4, warn: 0.7, direction: "lower"  } as Threshold,
  coverage:   { good: 80,  warn: 40,  direction: "higher" } as Threshold,
  decoration: { good: 20,  warn: 50,  direction: "lower"  } as Threshold,
  hashtag:    { good: 50,  warn: 20,  direction: "higher" } as Threshold,
  er:         { good: 4,   warn: 2,   direction: "higher" } as Threshold,
  velocity:   { good: 2,   warn: 1,   direction: "higher" } as Threshold,
};

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

export function buildDiagnostic(input: DiagnosticInput): Diagnostic {
  const { shorts, groupTokens } = input;
  const n = shorts.length;
  const small = n < SMALL_SAMPLE;
  const views = shorts.map((s) => s.views ?? 0).filter((v) => v > 0);
  const ers = shorts
    .filter((s) => (s.views ?? 0) > 0)
    .map((s) => ((s.likes ?? 0) + (s.comments ?? 0)) / (s.views as number) * 100);
  const velocities = shorts
    .map((s) => s.viral_velocity_ratio)
    .filter((v): v is number => v != null);

  const distStatus = (s: Status): Status => (small || views.length === 0 ? "na" : s);

  const breakout = breakoutRatio(views);
  const cv = coefficientOfVariation(views);
  const band = bandConcentration(views);
  const med = median(views);
  const cadence = cadenceDays(
    shorts.map((s) => s.published_at).filter((p): p is string => !!p),
  );
  const hhi = normalizedHHI(input.memberShares);
  const avgVel = velocities.length ? mean(velocities) : null;

  const covGroup = coveragePct(shorts, (s) => titleHasGroupToken(s.title, groupTokens));
  const covDecor = coveragePct(shorts, (s) => titleHasDecoration(s.title));
  const covHash = coveragePct(shorts, (s) => titleHasHashtag(s.title));
  const avgLen = mean(shorts.map((s) => (s.title ?? "").length));
  const avgEr = ers.length ? mean(ers) : null;

  const dimensions: Diagnostic["dimensions"] = {
    viral_physics: [
      {
        id: "breakout_ratio", label: "브레이크아웃 배율",
        value: round(breakout), display: `${round(breakout)}×`,
        status: distStatus(statusByThresholds(breakout, T.breakout)),
        target: "≥10×",
        why: "바이럴 채널은 1편이 중앙값의 수십~수백 배로 튄다. 2× 평탄 = breakout 0건.",
        fix: "초동 속도(피크 시간 업로드+알림·커뮤니티 부스트)와 공유 유발 소재로 1편을 끝까지 밀어 콜드 피드로 진입시킨다.",
      },
      {
        id: "view_cv", label: "조회 변동계수(CV)",
        value: round(cv, 2), display: round(cv, 2).toFixed(2),
        status: distStatus(statusByThresholds(cv, T.cv)),
        target: "≥0.8",
        why: "조회가 거의 평탄(낮은 CV)하면 '같은 사람들'에게만 도달한다는 신호.",
        fix: "포맷 실험으로 분산을 키우고, 반응 좋은 1편에 초기 트래픽을 집중.",
      },
      {
        id: "band_concentration", label: "좁은 밴드 집중도",
        value: round(band * 100), display: `${round(band * 100)}%`,
        status: distStatus(statusByThresholds(band, T.band)),
        target: "<40%",
        why: "조회 92%가 좁은 밴드에 갇히면 구독자 도달 천장에 막힌 것.",
        fix: "구독 피드 밖(추천)으로 나갈 후킹·사운드·식별자를 영상에 심는다.",
      },
      {
        id: "ceiling_vs_subs", label: "천장 vs 구독자",
        value: input.subscribers ? round(med / input.subscribers, 2) : null,
        display: input.subscribers ? `중앙 ${med} / 구독 ${input.subscribers}` : "구독자 미상",
        status: "na",
        target: "—",
        why: "중앙 조회가 활성 구독자 규모에 수렴하면 추천 피드 미진입(에코챔버) 징후.",
        fix: "비구독자 완시청률을 끌어올려 추천 확장 게이트를 통과.",
      },
    ],
    discoverability: [
      {
        id: "group_name_coverage", label: "공식 그룹명 제목 커버리지",
        value: round(covGroup), display: `${round(covGroup)}%`,
        status: n === 0 ? "na" : statusByThresholds(covGroup, T.coverage),
        target: "≥80%",
        why: "제목에 그룹명이 없으면 검색·추천 매칭 단서가 없어 신규 유입 경로가 닫힌다.",
        fix: "제목 앞부분에 미완소년·MiiWAN 등 공식 식별자를 배치(곡명·본명 사전 추가 시 정밀도↑).",
      },
      {
        id: "decoration_ratio", label: "이모지·장식 특수문자 비율",
        value: round(covDecor), display: `${round(covDecor)}%`,
        status: n === 0 ? "na" : statusByThresholds(covDecor, T.decoration),
        target: "<20%",
        why: "장식 기호·이모지 과다는 검색 키워드를 밀어내고 알고리즘 분류를 방해.",
        fix: "장식은 줄이고 검색어 중심으로. 감성은 썸네일·첫 컷으로.",
      },
      {
        id: "avg_title_len", label: "평균 제목 길이",
        value: round(avgLen), display: `${round(avgLen)}자`,
        status: "na", target: "—",
        why: "지나치게 짧으면 키워드가 부족, 너무 길면 핵심이 묻힌다(해석 보조).",
        fix: "앞 15~20자에 핵심 키워드를 담는다.",
      },
      {
        id: "hashtag_pct", label: "해시태그 사용률",
        value: round(covHash), display: `${round(covHash)}%`,
        status: n === 0 ? "na" : statusByThresholds(covHash, T.hashtag),
        target: "≥50%",
        why: "해시태그는 묶음 노출·재생목록 유입 경로.",
        fix: "#미완소년 #버추얼아이돌 등 주제 태그와 시리즈명을 일관 사용.",
      },
    ],
    core_strength: [
      {
        id: "avg_er", label: "평균 ER",
        value: avgEr == null ? null : round(avgEr, 2),
        display: avgEr == null ? "—" : `${round(avgEr, 2)}%`,
        status: avgEr == null ? "na" : statusByThresholds(avgEr, T.er),
        target: "≥4%",
        why: "본 사람의 관여도. 높으면 콘텐츠 자체는 강하다는 뜻.",
        fix: "유지 — cadence·퀄리티는 그대로 두고 '바깥을 향하게' 재설계.",
      },
      {
        id: "member_hhi", label: "멤버 집중 HHI(정규화)",
        value: hhi == null ? null : round(hhi, 2),
        display: hhi == null ? "—" : round(hhi, 2).toFixed(2),
        status: "na", target: "—",
        why: "0=균등, 1=집중. 대표 얼굴 형성 정도(해석 보조).",
        fix: "대표 1인 푸시와 균등 노출 사이 전략적 선택.",
      },
    ],
    operating_rhythm: [
      {
        id: "upload_cadence", label: "업로드 간격(중앙값)",
        value: cadence || null,
        display: cadence ? `${round(cadence)}일` : "—",
        status: "na", target: "일관성",
        why: "주제·포맷·빈도가 일정해야 알고리즘이 채널 시청자상을 학습(해석 보조).",
        fix: "정기 cadence 유지 + 포맷·주제 일관, 잦은 노선 변경 지양.",
      },
      {
        id: "avg_velocity", label: "평균 24h velocity",
        value: avgVel == null ? null : round(avgVel, 2),
        display: avgVel == null ? "—" : `${round(avgVel, 2)}×`,
        status: avgVel == null ? "na" : statusByThresholds(avgVel, T.velocity),
        target: "≥2×",
        why: "업로드 직후 확산 여부. 1 미만은 채널 평균에도 못 미침.",
        fix: "피크 시간 업로드 + 초기 알림·커뮤니티 동원으로 초동 부스트.",
      },
    ],
  };

  const order: Array<keyof Diagnostic["dimensions"]> = [
    "viral_physics", "discoverability", "operating_rhythm", "core_strength",
  ];
  const priorities = order
    .flatMap((dim) => dimensions[dim])
    .filter((k) => k.status === "bad")
    .slice(0, 3)
    .map((k) => ({ id: k.id, label: k.label, display: k.display, fix: k.fix }));

  const caveats: string[] = ["식별자 = 공식 그룹명 기준 (곡명·본명 사전 추가 시 정밀도↑)"];
  if (small) caveats.push(`표본 ${n}편 — 분포 지표(바이럴 물리)는 방향성 참고`);

  return { group_key: input.group_key, shorts_n: n, dimensions, priorities, caveats };
}
