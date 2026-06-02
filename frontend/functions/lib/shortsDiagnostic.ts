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
