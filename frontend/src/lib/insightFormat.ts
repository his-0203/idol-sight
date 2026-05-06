// frontend/src/lib/insightFormat.ts
//
// LLM 인사이트 본문 텍스트를 시각 토큰 배열로 변환하는 파서.
//
// 입력: LLM 이 자유 텍스트로 작성한 한국어 본문 (markdown bold `**xxx**`
//       와 그룹명 / 톤 어휘가 섞여 있음).
// 출력: <InsightBody> 가 렌더링하는 토큰 배열.
//
// 토큰 종류:
//   - text:        평문
//   - groupBadge:  알려진 그룹의 영문/한글/별칭 표기. group key 와 표시 라벨 동봉.
//   - tone:        긍정 / 부정 / 중립 강조. markdown bold 또는 lexicon 매칭.
//
// 디자인 원칙:
//   - 보수적 매칭. word-boundary 검사로 false positive 회피
//     (예: "릴파" 가 "릴파이브" 안에서 매칭되지 않게).
//   - 한국어는 alphabetic word boundary 가 없으므로 직접 lookbehind/lookahead
//     로 한글/영문/숫자 인접 문자 체크.
//   - LLM 출력 contract: `**xxx**` 마크다운 → 강조 토큰. 톤 (긍정/부정)
//     은 인접 어휘로 자동 추론, 미분류는 중립.
//   - 라이브러리 추가 금지. ~150 줄 내외로 직접 구현.
//
// 다른 에이전트가 worker 측에서 이 contract 에 맞춰 markdown bold + 정확한
// 그룹명을 일관되게 출력하도록 프롬프트를 갱신 중. 두 작업의 정합점은
// "GROUP_LEXICON 의 alias 표기 ↔ LLM 본문" 이다.

import { GROUP_KEYS, type GroupKey } from "../design/groups";

// ─────────────────────────────────────────────────────────────────────────
// 그룹 lexicon
// ─────────────────────────────────────────────────────────────────────────
//
// 각 그룹의 모든 표기 (영문 공식명 / 한국어 정식명 / 흔한 별칭) → group key.
// 매칭 우선순위: 긴 alias 먼저 (예: "이세계아이돌" 이 "이세돌" 보다 먼저
// 매칭되도록). 같은 라벨이 여러 그룹에 매칭될 수 있는 경우는 의도적으로
// 짧은 alias 를 제외 (예: STELLIVE 의 "린" 은 isedol "릴파" 와 충돌하지
// 않지만, 짧고 일반적이라 제외).
//
// 한국어 표기는 정규화하지 않는다 (음절 단위 매칭). 영문은 case-insensitive.

type GroupAlias = {
  /** 매칭할 표기 (literal) */
  alias: string;
  /** 표시할 라벨 (대개 영문 공식명) */
  label: string;
  /** 매칭이 영문/숫자 토큰인지 (true 면 word-boundary 적용) */
  word: boolean;
};

type GroupEntry = {
  key: GroupKey;
  /** 화면에 띄울 기본 라벨 (영문 공식명) */
  display: string;
  aliases: GroupAlias[];
};

export const GROUP_LEXICON: GroupEntry[] = [
  {
    key: "plave",
    display: "PLAVE",
    aliases: [
      { alias: "PLAVE",      label: "PLAVE", word: true },
      { alias: "플레이브",   label: "PLAVE", word: false },
    ],
  },
  {
    key: "isedol",
    display: "ISEDOL",
    aliases: [
      // "이세계아이돌" 먼저 — "이세돌" 의 superstring 회피.
      { alias: "이세계아이돌", label: "ISEDOL", word: false },
      { alias: "ISEGYE IDOL",  label: "ISEDOL", word: true },
      { alias: "ISEDOL",       label: "ISEDOL", word: true },
      { alias: "이세돌",       label: "ISEDOL", word: false },
    ],
  },
  {
    key: "stellive",
    display: "STELLIVE",
    aliases: [
      { alias: "STELLIVE",   label: "STELLIVE", word: true },
      { alias: "StelLive",   label: "STELLIVE", word: true },
      { alias: "스텔라이브", label: "STELLIVE", word: false },
    ],
  },
  {
    key: "skinz",
    display: "SKINZ",
    aliases: [
      { alias: "SKINZ", label: "SKINZ", word: true },
      { alias: "스킨즈", label: "SKINZ", word: false },
    ],
  },
  {
    key: "myrakl",
    display: "MY:RAKL",
    aliases: [
      { alias: "MY:RAKL",   label: "MY:RAKL", word: true },
      { alias: "MYRAKL",    label: "MY:RAKL", word: true },
      { alias: "마이라클",  label: "MY:RAKL", word: false },
      // "미라클" 은 일반어 충돌 가능. context_keywords 의 blacklist
      // ("기적","축구","오마이걸") 는 본문에 동시 등장 시 실제 그룹
      // 매칭이 아닐 가능성이 있지만, 인사이트 본문은 LLM 이 그룹
      // 컨텍스트로만 사용하므로 보수적으로 매칭 허용.
      { alias: "미라클",    label: "MY:RAKL", word: false },
    ],
  },
  {
    key: "owis",
    display: "OWIS",
    aliases: [
      { alias: "OWIS",  label: "OWIS", word: true },
      { alias: "오위스", label: "OWIS", word: false },
    ],
  },
  {
    key: "miiwan",
    display: "MiiWAN",
    aliases: [
      { alias: "MiiWAN",   label: "MiiWAN", word: true },
      { alias: "MIIWAN",   label: "MiiWAN", word: true },
      { alias: "미완소년", label: "MiiWAN", word: false },
    ],
  },
  {
    key: "bdawn",
    display: "B:DAWN",
    aliases: [
      // "B:DAWN" 의 ":" 는 word boundary 깨므로 word=false 로
      // 검색하되 양옆에 한글/영문이 붙어있지 않은지 별도 체크.
      { alias: "B:DAWN", label: "B:DAWN", word: false },
      { alias: "BDAWN",  label: "B:DAWN", word: true },
      { alias: "비던",   label: "B:DAWN", word: false },
    ],
  },
  {
    key: "wegosix",
    display: "WE GO-6",
    aliases: [
      { alias: "WE GO-6",  label: "WE GO-6", word: false },
      { alias: "WEGO-6",   label: "WE GO-6", word: false },
      { alias: "WEGO6",    label: "WE GO-6", word: true },
      { alias: "wegosix",  label: "WE GO-6", word: true },
      { alias: "위고식스", label: "WE GO-6", word: false },
    ],
  },
];

// 매칭 시 사용할 (alias, key, label, word) 평탄 배열을 alias 길이 내림차순으로
// 정렬. 긴 표기가 먼저 매칭되도록 (이세계아이돌 > 이세돌 등).
type FlatAlias = GroupAlias & { key: GroupKey };
const FLAT_ALIASES: FlatAlias[] = (() => {
  const flat: FlatAlias[] = [];
  for (const g of GROUP_LEXICON) {
    for (const a of g.aliases) flat.push({ ...a, key: g.key });
  }
  flat.sort((a, b) => b.alias.length - a.alias.length);
  return flat;
})();

// GROUP_KEYS 가 lexicon 에 모두 정의돼 있는지 dev 빌드에서 가벼운 검증.
// 새 그룹 seed 가 추가될 때 lexicon 갱신을 잊지 않도록.
{
  const covered = new Set(GROUP_LEXICON.map((g) => g.key));
  for (const k of GROUP_KEYS) {
    if (!covered.has(k)) {
      // eslint-disable-next-line no-console
      console.warn(`[insightFormat] GROUP_LEXICON missing entry for "${k}"`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 톤 lexicon
// ─────────────────────────────────────────────────────────────────────────
//
// 한국어 자연어 톤 어휘. markdown bold 토큰 안에 등장하면 그 토큰의
// 톤이 결정되고, 본문에 단독 등장해도 inline tone 강조로 렌더된다.
// 색은 design system 의 emerald/rose/zinc 한정.

export const POSITIVE_WORDS = [
  // 상승·증가
  "상승", "증가", "성장", "확대", "확장", "신장",
  // 돌파·기록
  "돌파", "신기록", "최고치", "최대", "최다", "최고",
  // 첫 성취
  "첫 1위", "첫1위", "1위", "정상",
  // 강세·호조
  "호조", "견조", "강세", "약진", "선전", "호황",
  // 가속·견인
  "가속", "견인", "주도", "약 1위",
  // 화제·관심
  "돌풍", "화제", "주목",
  // 일반 긍정 형용
  "흥행", "히트", "성공", "달성",
];

export const NEGATIVE_WORDS = [
  // 하락·감소
  "하락", "감소", "축소", "위축", "저조",
  // 급락·심각
  "급락", "급감", "둔화", "정체", "저하",
  // 부진·약세
  "부진", "약세", "후퇴", "위축세",
  // 위기·우려
  "우려", "리스크", "위험", "위기", "경고",
  // 논란
  "논란", "악재", "갈등",
];

// 정렬: 긴 어휘 먼저 매칭되게 (정상 < 첫 1위 등).
const POS_SORTED = [...POSITIVE_WORDS].sort((a, b) => b.length - a.length);
const NEG_SORTED = [...NEGATIVE_WORDS].sort((a, b) => b.length - a.length);

// ─────────────────────────────────────────────────────────────────────────
// 토큰 모델
// ─────────────────────────────────────────────────────────────────────────

export type Tone = "positive" | "negative" | "neutral";

export type InsightToken =
  | { kind: "text"; text: string }
  | { kind: "group"; key: GroupKey; label: string }
  | { kind: "tone"; tone: Tone; text: string };

// 한글/영문/숫자 인접 문자 검사. word boundary 가 없는 한글에서 alias
// 매칭이 단어 한가운데를 자르지 않도록 보호.
const RX_HANGUL = /[가-힣]/;
const RX_ALNUM = /[A-Za-z0-9_]/;

function isBoundaryChar(c: string | undefined, alias: string, side: "L" | "R"): boolean {
  if (c === undefined) return true;
  const edge = side === "L" ? alias[0]! : alias[alias.length - 1]!;
  if (RX_ALNUM.test(edge)) {
    // 영문/숫자 토큰: 양옆이 영문/숫자/_ 이면 boundary 아님 (단어 한가운데).
    return !RX_ALNUM.test(c);
  }
  if (RX_HANGUL.test(edge)) {
    // 한글 토큰: 한국어는 조사("이/가/을/를/의/에서…")가 단어 끝에 자연스럽게
    // 붙는다. 따라서 RIGHT 측 한글 인접은 boundary 로 인정 (예: "플레이브가
    // 1위" 의 "가"). LEFT 측은 합성어 한가운데(예: "초플레이브") 회피 위해
    // 한글이 붙어있으면 boundary 아니라고 판정.
    if (side === "R") return true;
    return !RX_HANGUL.test(c);
  }
  // 기타 (`:`, `-` 등): 보수적으로 항상 boundary 인정.
  return true;
}

/** 평문 한 조각에서 그룹 alias 와 톤 lexicon 을 인식해 토큰 분해. */
function splitGroupsAndToneIn(text: string): InsightToken[] {
  if (!text) return [];
  const out: InsightToken[] = [];
  let i = 0;
  const n = text.length;

  outer: while (i < n) {
    // 1) 그룹 alias 시도 (긴 것부터)
    for (const a of FLAT_ALIASES) {
      const len = a.alias.length;
      if (i + len > n) continue;
      const slice = text.slice(i, i + len);
      const matches = a.word
        ? slice.toLowerCase() === a.alias.toLowerCase()
        : slice === a.alias;
      if (!matches) continue;
      const left = i > 0 ? text[i - 1] : undefined;
      const right = i + len < n ? text[i + len] : undefined;
      if (!isBoundaryChar(left, a.alias, "L")) continue;
      if (!isBoundaryChar(right, a.alias, "R")) continue;
      out.push({ kind: "group", key: a.key, label: a.label });
      i += len;
      continue outer;
    }
    // 2) 톤 lexicon (긍정 → 부정 순)
    let toneHit: { tone: Tone; len: number } | null = null;
    for (const w of POS_SORTED) {
      if (text.startsWith(w, i)) {
        toneHit = { tone: "positive", len: w.length };
        break;
      }
    }
    if (!toneHit) {
      for (const w of NEG_SORTED) {
        if (text.startsWith(w, i)) {
          toneHit = { tone: "negative", len: w.length };
          break;
        }
      }
    }
    if (toneHit) {
      out.push({ kind: "tone", tone: toneHit.tone, text: text.slice(i, i + toneHit.len) });
      i += toneHit.len;
      continue;
    }
    // 3) 일반 문자: text 토큰을 mergeable 하게 누적
    const last = out[out.length - 1];
    if (last && last.kind === "text") {
      last.text += text[i]!;
    } else {
      out.push({ kind: "text", text: text[i]! });
    }
    i += 1;
  }
  return out;
}

/** 마크다운 bold 안의 텍스트에서 톤을 추론. 인접 단어 매칭. */
function classifyBold(inner: string): Tone {
  for (const w of POS_SORTED) if (inner.includes(w)) return "positive";
  for (const w of NEG_SORTED) if (inner.includes(w)) return "negative";
  return "neutral";
}

/**
 * LLM 본문 한 줄을 파싱해 토큰 배열 반환.
 *
 * 처리 순서:
 *   1) `**xxx**` 마크다운 bold → tone 토큰 (인접 어휘로 tone 자동 분류)
 *   2) bold 사이 평문 → 그룹 alias / 톤 lexicon inline 탐색
 *   3) 잔여 평문 → text 토큰
 */
export function parseInsightBody(body: string | null | undefined): InsightToken[] {
  if (!body) return [];
  const tokens: InsightToken[] = [];
  // `**...**` 매칭. greedy 하지 않게 [^*]+. ** 안에 ** 중첩 없다고 가정.
  const RX_BOLD = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = RX_BOLD.exec(body)) !== null) {
    if (m.index > last) {
      tokens.push(...splitGroupsAndToneIn(body.slice(last, m.index)));
    }
    const inner = m[1] ?? "";
    const tone = classifyBold(inner);
    // bold 안에서도 그룹명은 group badge 로 빼낸다 — 그래야 시각이 일관.
    const sub = splitGroupsAndToneIn(inner);
    // 그룹 토큰은 그대로 두고, 그 외 text/tone 은 bold tone 으로 승격.
    for (const t of sub) {
      if (t.kind === "group") {
        tokens.push(t);
      } else if (t.kind === "tone") {
        // bold 안의 lexicon hit 은 bold tone 우선 (positive/negative > neutral).
        // 단, bold tone 이 neutral 이면 inner 의 lexicon tone 을 그대로 사용.
        const finalTone: Tone = tone === "neutral" ? t.tone : tone;
        tokens.push({ kind: "tone", tone: finalTone, text: t.text });
      } else {
        tokens.push({ kind: "tone", tone, text: t.text });
      }
    }
    last = m.index + m[0].length;
  }
  if (last < body.length) {
    tokens.push(...splitGroupsAndToneIn(body.slice(last)));
  }
  // 인접한 같은 종류 text 토큰 병합 (splitGroupsAndToneIn 단계에서 한
  // 호출 안에서는 병합되지만, bold 경계를 가로지르는 경우 별도 호출로
  // 분리됐을 수 있다).
  const merged: InsightToken[] = [];
  for (const t of tokens) {
    const prev = merged[merged.length - 1];
    if (prev && prev.kind === "text" && t.kind === "text") {
      prev.text += t.text;
    } else {
      merged.push(t);
    }
  }
  return merged;
}

/** 본문에서 등장하는 그룹 키를 등장 순서대로, 중복 제거하여 반환. */
export function extractGroupKeys(body: string | null | undefined): GroupKey[] {
  const tokens = parseInsightBody(body);
  const seen = new Set<GroupKey>();
  const out: GroupKey[] = [];
  for (const t of tokens) {
    if (t.kind === "group" && !seen.has(t.key)) {
      seen.add(t.key);
      out.push(t.key);
    }
  }
  return out;
}
