// frontend/src/lib/datetime.ts
//
// User-facing timestamp formatter, all rendered in **KST (Asia/Seoul)**.
//
// Why this lives in one place:
//   - Backend stores everything in UTC (ISO-8601 with `Z` suffix). When raw
//     UTC strings (or `slice(0, 10)` slices of them) leak into the operator's
//     UI, "yesterday" can look like "2 days ago" near midnight, and
//     `2026-05-07T15:00Z` reads as 15:00 even though the operator is at 00:00
//     KST the next day. The user's request — "모든 시간은 KST 기준으로
//     잡아줘" — applies only to **display**; data, API, and DB stay UTC.
//   - We keep the helper dependency-free (no date-fns/dayjs) by leaning on
//     `Intl.DateTimeFormat({ timeZone: "Asia/Seoul" })` and `Date` math.
//
// Anything machine-readable (`data-*`, debug logs, export filenames) should
// stay UTC; this module is for human-facing strings only.
//

const KST_TZ = "Asia/Seoul";

// Memoised formatters — `Intl.DateTimeFormat` construction is the slow
// part, reuse one instance per shape.
const DATETIME_FMT = new Intl.DateTimeFormat("ko-KR", {
  timeZone: KST_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const DATE_FMT = new Intl.DateTimeFormat("ko-KR", {
  timeZone: KST_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function toDate(input: string | Date | number | null | undefined): Date | null {
  if (input == null) return null;
  if (input instanceof Date) {
    return Number.isFinite(input.getTime()) ? input : null;
  }
  if (typeof input === "number") {
    return Number.isFinite(input) ? new Date(input) : null;
  }
  // Backend ISO strings end in `Z`. SQL DATETIME (`YYYY-MM-DD HH:MM:SS`)
  // is naive and we treat it as UTC by appending `Z` because that's the
  // worker's actual contract (worker writes UTC into D1).
  let s = input.trim();
  if (!s) return null;
  // Bare YYYY-MM-DD: treat as date-only at KST midnight. We do this by
  // pinning to noon UTC, which is always the same calendar day in KST,
  // so date-only formatters round-trip correctly.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    s = `${s}T12:00:00Z`;
  } else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    // SQLite-style "YYYY-MM-DD HH:MM[:SS]" without timezone marker.
    // Normalize to ISO with explicit Z (UTC).
    s = s.replace(" ", "T");
    if (!/[zZ]|[+\-]\d{2}:?\d{2}$/.test(s)) s = `${s}Z`;
  }
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

// Pull a part out of a formatToParts() array. Falls back to "00" so we
// never throw for missing parts (older browsers).
function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((p) => p.type === type)?.value ?? "00";
}

export type FormatKSTOptions = {
  /** Include time component. Default: true. */
  withTime?: boolean;
  /** Include `KST` suffix. Default: true (so the timezone is unambiguous). */
  withSuffix?: boolean;
};

/**
 * Format a UTC timestamp (or any Date-like) as a **KST** display string.
 *
 *   formatKST("2026-05-07T05:23:45Z")               // "2026-05-07 14:23 KST"
 *   formatKST("2026-05-07")                         // "2026-05-07 KST"
 *   formatKST("2026-05-07T05:23Z", { withTime:false }) // "2026-05-07 KST"
 *   formatKST(null)                                 // "—"
 */
export function formatKST(
  input: string | Date | number | null | undefined,
  opts: FormatKSTOptions = {},
): string {
  const d = toDate(input);
  if (!d) return "—";
  const withTime = opts.withTime ?? true;
  const withSuffix = opts.withSuffix ?? true;
  const parts = (withTime ? DATETIME_FMT : DATE_FMT).formatToParts(d);
  const y = part(parts, "year");
  const m = part(parts, "month");
  const day = part(parts, "day");
  let out = `${y}-${m}-${day}`;
  if (withTime) {
    const hh = part(parts, "hour");
    // ko-KR with hour12:false sometimes returns "24" at midnight; clamp.
    const hour = hh === "24" ? "00" : hh;
    const mm = part(parts, "minute");
    out += ` ${hour}:${mm}`;
  }
  if (withSuffix) out += " KST";
  return out;
}

/** Date-only KST string. Convenience over `formatKST(x, { withTime: false })`. */
export function formatKSTDate(
  input: string | Date | number | null | undefined,
  opts: { withSuffix?: boolean } = {},
): string {
  return formatKST(input, { withTime: false, withSuffix: opts.withSuffix ?? false });
}

/**
 * Relative-from-now Korean phrase. Output is timezone-agnostic by
 * construction (it's a duration), but we expose it from this module so
 * the whole "user-facing time" surface lives in one file.
 *
 * Bands:
 *   < 60s          → "방금 전"
 *   < 1h           → "N분 전"
 *   < 48h          → "N시간 전"
 *   < 30d          → "N일 전"
 *   else           → fallback to formatKSTDate()
 *
 * Future timestamps return their absolute KST representation (we don't
 * say "in N minutes" — the operator surface only ever shows past events
 * for "ago" wording today, so the symmetric form would be misleading).
 */
export function formatKSTRelative(
  input: string | Date | number | null | undefined,
  opts: { now?: number } = {},
): string {
  const d = toDate(input);
  if (!d) return "마지막 갱신 없음";
  const now = opts.now ?? Date.now();
  const diffMs = now - d.getTime();
  if (diffMs < 0) return formatKST(d);
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return "방금 전";
  const min = Math.round(diffMs / 60_000);
  if (min < 60) return `${min}분 전`;
  const hr = Math.round(diffMs / 3_600_000);
  if (hr < 48) return `${hr}시간 전`;
  const day = Math.round(diffMs / 86_400_000);
  if (day < 30) return `${day}일 전`;
  return formatKSTDate(d);
}

/**
 * Today's calendar date in KST as `YYYY-MM-DD`.
 *
 * Replaces `new Date().toISOString().slice(0, 10)` which is UTC-based
 * and rolls a day too early/late depending on KST offset.
 */
export function todayKST(now: number = Date.now()): string {
  return formatKSTDate(new Date(now));
}

/**
 * Calendar-day delta from today to `dateStr` (YYYY-MM-DD), evaluated in
 * **KST**. Positive = future, negative = past, 0 = today.
 *
 * Used by the D-day badges and event timelines so "오늘" actually
 * matches the operator's wall clock instead of UTC's.
 */
export function daysBetweenKST(
  dateStr: string | Date | number | null | undefined,
  now: number = Date.now(),
): number | null {
  const target = toDate(dateStr);
  if (!target) return null;
  const fromY = todayKST(now);
  const toY = formatKSTDate(target);
  const fromMs = Date.parse(`${fromY}T12:00:00+09:00`);
  const toMs = Date.parse(`${toY}T12:00:00+09:00`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  return Math.round((toMs - fromMs) / 86_400_000);
}
