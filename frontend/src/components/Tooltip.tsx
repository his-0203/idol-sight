// Lightweight, accessible tooltip / popover primitive.
//
// Why this exists: native `title` attributes are inaccessible (no keyboard
// focus support, no styling, OS-dependent delay). We render a small
// designed popover that opens on mouseenter / focus and closes on
// mouseleave / blur / Escape. The trigger is rendered inline so callers
// can wrap any inline element (label text, icon, factor name) without
// disturbing layout.
//
// Accessibility:
// - The trigger is a real <button type="button"> with `aria-describedby`
//   pointing at the popover. Screen readers announce the description on
//   focus.
// - Escape collapses the popover and returns focus to the trigger.
// - The popover is `role="tooltip"` and rendered next to the trigger so
//   discovery doesn't require pointer hover.

import { useEffect, useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";

export type TooltipProps = {
  /** Content rendered inside the popover. Strings render as plain text;
   *  callers can pass JSX for richer content (e.g. multi-line). */
  content: ComponentChildren;
  /** The visible label that opens the tooltip. */
  children: ComponentChildren;
  /** Optional class for the trigger wrapper (e.g. underline styling). */
  triggerClass?: string;
  /** Tooltip placement relative to the trigger. Defaults to "top". */
  placement?: "top" | "bottom";
  /** Optional max-width for the popover. Defaults to a readable column. */
  maxWidth?: string;
};

export function Tooltip(props: TooltipProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);
  // 우측 표 헤더(SoV·주의)에서 팝오버가 화면 밖으로 잘리지 않도록, 열릴 때
  // 뷰포트를 측정해 넘치는 만큼 가로로 당긴다(translateX). 닫히면 0으로 리셋.
  const [shiftX, setShiftX] = useState(0);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) { setShiftX(0); return; }
    const el = popRef.current;
    if (!el) return;
    const margin = 8;
    // shiftX=0 상태(translateX(0))로 그려진 직후 측정해 자연 위치를 잡는다.
    const rect = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    let shift = 0;
    if (rect.right > vw - margin) shift = (vw - margin) - rect.right;   // 우측 넘침 → 왼쪽으로
    if (rect.left + shift < margin) shift = margin - rect.left;          // 좌측 넘침 방지(클램프)
    if (shift !== 0) setShiftX(shift);
  }, [open]);

  const placement = props.placement ?? "top";
  const positionCls = placement === "top"
    ? "bottom-full mb-1.5"
    : "top-full mt-1.5";

  return (
    <span class="relative inline-block">
      <button
        type="button"
        ref={triggerRef}
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        // Toggle on click for touch / keyboard users that don't hover.
        onClick={() => setOpen((v) => !v)}
        class={
          "inline-flex items-center gap-1 cursor-help " +
          "underline decoration-dotted decoration-zinc-600 underline-offset-4 " +
          "hover:decoration-zinc-300 focus:outline-none focus-visible:ring-1 " +
          "focus-visible:ring-zinc-500 rounded-sm " +
          (props.triggerClass ?? "")
        }
      >
        {props.children}
      </button>
      {open && (
        <span
          id={id}
          ref={popRef}
          role="tooltip"
          class={
            "absolute left-0 z-50 " + positionCls + " " +
            "rounded-md border border-zinc-700 bg-zinc-950/95 " +
            "px-2.5 py-1.5 text-xs leading-snug text-zinc-200 shadow-lg " +
            "pointer-events-none"
          }
          style={{
            // width:max-content + min/max로 좁은 표 셀 안에서도 컨테이너에
            // 클램핑되지 않도록 강제. 한국어는 wordBreak:keep-all로 어절
            // 단위 줄바꿈해서 한 글자씩 떨어지지 않게.
            width: "max-content",
            minWidth: "14rem",
            maxWidth: props.maxWidth ?? "22rem",
            whiteSpace: "normal",
            wordBreak: "keep-all",
            overflowWrap: "break-word",
            // 화면 밖 넘침 보정(우측 헤더 등). 0이면 transform 미적용.
            transform: shiftX ? `translateX(${shiftX}px)` : undefined,
          }}
        >
          {props.content}
        </span>
      )}
    </span>
  );
}

// Shared 4-factor copy. Sourced from
// docs/superpowers/specs/2026-05-04-v2-roadmap.md §V2.5 and the live
// /api/health/spec endpoint. Centralised here so HealthSpec, KPI and
// any future factor surface stay in sync.
export const FACTOR_TOOLTIP: Record<string, string> = {
  reach:
    "도달(Reach) — 구독자, 누적 조회수, 뉴스 노출 등 시장이 그룹을 ‘얼마나 알고 있는지’ 측정. 비교군 상위 25% 수준 기준 환산.",
  ritual:
    "의례적 승리(Ritual) — 한터 초동, 음방 1위, 차트 진입, 외부 콜라보 등 팬덤이 의례적으로 동원되는 ‘승리 이벤트’ 강도.",
  mobilization:
    "동원(Mobilization) — 누적 조회수·구독자·한터 초동 등 팬이 시간/돈을 실제로 투입한 양. 화력의 ‘쌓인 결과’.",
  intimacy:
    "친밀도(Intimacy) — 참여율(좋아요+댓글)·커뮤니티 활동·합방 빈도 등 팬-그룹 관계의 깊이. 부정 sentiment 시 압축됨.",
};

// ---------------------------------------------------------------------------
// Source-ref label humanizer.
//
// The Gemini weekly pipeline emits source_refs whose `label` is a free-text
// concatenation of group + raw column + window slice — e.g.
// "MiiWAN yt_total_views (last 7d end)". Operators rejected this as
// noise: it leaks DB column names, English window slugs, and identical
// chains repeat across cards (last 7d start/end + prev 7d start/end).
// We humanize the strings with a small lexicon so the rendered ref reads
// like a sentence ("MiiWAN 누적 조회수 · 직전 7일 끝") without round-
// tripping the worker. Failures fall through to the original string —
// never block rendering on a missing token.
//
// Living here (rather than in a util/ module) because we are constrained
// to a single shared component file for new utility code; co-locating
// next to FACTOR_TOOLTIP also keeps the "front-end copy lexicon" in one
// place for future additions.

const _COLUMN_LEXICON: Array<[RegExp, string]> = [
  [/yt_total_views/g,    "누적 조회수"],
  [/yt_subscribers/g,    "구독자"],
  [/yt_total_videos/g,   "영상 수"],
  [/dc_total_posts/g,    "디시 게시글"],
  [/theqoo_posts/g,      "더쿠 게시글"],
  [/instiz_posts/g,      "인스티즈 게시글"],
  [/naver_total_news/g,  "네이버 뉴스"],
  [/controversy_count/g, "논란 카운트"],
  [/agg_market_share/g,  "시장 점유"],
  [/agg_summary/g,       "주간 활동 합산"],
  [/hanteo_weekly/g,     "한터 주간"],
  [/naver_articles/g,    "네이버 기사"],
];

const _WINDOW_LEXICON: Array<[RegExp, string]> = [
  [/\(last 7d end\)/g,   "(직전 7일 끝)"],
  [/\(last 7d start\)/g, "(직전 7일 시작)"],
  [/\(prev 7d end\)/g,   "(이전 7일 끝)"],
  [/\(prev 7d start\)/g, "(이전 7일 시작)"],
  [/\blast 7d\b/g,       "직전 7일"],
  [/\bprev 7d\b/g,       "이전 7일"],
  [/\bweek_start\b/g,    "주 시작"],
  [/\bweek_end\b/g,      "주 끝"],
];

/** Convert a raw Gemini-emitted source-ref label into a Korean label.
 *  Idempotent: if no tokens match, the original string is returned. */
export function humanizeSourceLabel(label: string): string {
  if (!label) return label;
  let out = label;
  for (const [re, ko] of _COLUMN_LEXICON) out = out.replace(re, ko);
  for (const [re, ko] of _WINDOW_LEXICON) out = out.replace(re, ko);
  return out;
}

/** Collapsed "데이터 출처" disclosure renderer. Hides verbose source-ref
 *  chains by default (operators reported them as text fatigue) while
 *  keeping them one click away for analysts who need to verify a number.
 *  The body uses humanized labels via condenseRefs. */
export function DataSourceDetails(props: {
  refs: ReadonlyArray<RawRef>;
  /** Optional left-aligned label override. Defaults to "데이터 출처". */
  label?: string;
}) {
  const condensed = condenseRefs(props.refs);
  if (!condensed.length) return null;
  return (
    <details class="mt-1.5 group">
      <summary
        class="cursor-pointer select-none text-hint text-zinc-500
               hover:text-zinc-300 list-none flex items-center gap-1"
      >
        <span class="text-zinc-600 group-open:rotate-90 transition-transform inline-block w-2 leading-none">
          ›
        </span>
        <span>{props.label ?? "데이터 출처"}</span>
        <span class="text-zinc-500 tabular-nums">({condensed.length})</span>
      </summary>
      <ul class="mt-1 ml-3 space-y-0.5">
        {condensed.map((r, i) => (
          <li key={i} class="text-hint text-zinc-500" title={`${r.table}: ${r.pk}`}>
            {r.label}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Compact a list of refs by collapsing identical "subject" strings that
 *  only differ by a window-slice suffix. Operators reading 4 chained
 *  refs of the same metric (last 7d start / end / prev 7d start / end)
 *  saw it as a wall of noise. We coalesce by subject and append a single
 *  compact range note. */
export type RawRef = { table: string; pk: string; label: string };
export type FriendlyRef = { table: string; pk: string; label: string };
export function condenseRefs(refs: ReadonlyArray<RawRef>): FriendlyRef[] {
  if (!refs.length) return [];
  type Bucket = { subject: string; pks: string[]; tables: Set<string>; suffixes: Set<string> };
  const order: string[] = [];
  const byKey = new Map<string, Bucket>();
  // Strip a window-slice suffix like "(last 7d end)" → subject + suffix.
  const SUFFIX_RE = /\s*\((?:last|prev)\s*7d(?:\s*(?:start|end))?\)\s*$/;
  for (const r of refs) {
    const human = humanizeSourceLabel(r.label);
    const m = SUFFIX_RE.exec(r.label);
    let subject = human;
    let suffix = "";
    const matched = m && m[0] ? m[0] : null;
    if (m && matched) {
      suffix = humanizeSourceLabel(matched.trim());
      subject = humanizeSourceLabel(r.label.slice(0, m.index)).trim();
    }
    const key = `${r.table}|${subject}`;
    let b = byKey.get(key);
    if (!b) {
      b = { subject, pks: [], tables: new Set(), suffixes: new Set() };
      byKey.set(key, b);
      order.push(key);
    }
    b.pks.push(r.pk);
    b.tables.add(r.table);
    if (suffix) b.suffixes.add(suffix);
  }
  const out: FriendlyRef[] = [];
  for (const key of order) {
    const b = byKey.get(key);
    if (!b) continue;
    const tables = [...b.tables].join(",");
    const suffixNote = b.suffixes.size > 0
      ? ` · ${[...b.suffixes].join(" / ")}`
      : "";
    out.push({
      table: tables,
      pk: b.pks.join(" · "),
      label: `${b.subject}${suffixNote}`,
    });
  }
  return out;
}
