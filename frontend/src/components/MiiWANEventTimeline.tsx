// MiiWAN 이벤트 타임라인 — group_events 테이블의 -30/+60일 창.
// MiiWANBriefing(운영 브리핑)과 MiiWANPosition(포지션 뷰)이 공유:
// 브리핑은 전체 창 + 빈 상태 자리 유지, 포지션은 futureOnly +
// hideWhenEmpty로 예정 이벤트만 노출한다.

import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api";

export type GroupEvent = {
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

export function MiiWANEventTimeline({ today, futureOnly, hideWhenEmpty }: {
  today: string;
  /** 예정 이벤트만 — 과거 이력은 운영 로그 성격. */
  futureOnly?: boolean;
  /** 보여줄 이벤트가 없으면 섹션 자체를 렌더하지 않는다
      (빈 섹션은 미완성 티만 낸다). 브리핑 모드는 자리 유지. */
  hideWhenEmpty?: boolean;
}) {
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
      .filter((e) => !futureOnly || e.event_date >= today)
      .sort((a, b) => a.event_date.localeCompare(b.event_date));
  }, [events, futureOnly, today]);

  const todayDate = today;

  if (!events) {
    if (hideWhenEmpty) return null;
    return (
      <section>
        <h2 class="section-title mb-3">이벤트 캘린더</h2>
        <div class="text-hint text-zinc-500">Loading…</div>
      </section>
    );
  }

  if (filtered.length === 0) {
    if (hideWhenEmpty) return null;
    return (
      <section>
        <h2 class="section-title mb-3">이벤트 캘린더</h2>
        <div class="text-hint text-zinc-500">
          최근 30일 / 향후 60일 등록된 이벤트 없음.
        </div>
      </section>
    );
  }

  return (
    <section>
      <div class="mb-3 flex flex-wrap items-baseline gap-2">
        <h2 class="section-title">이벤트 캘린더</h2>
        <span class="text-hint text-zinc-500">
          {futureOnly
            ? "향후 60일 예정"
            : "최근 30일 + 향후 60일 · 과거(회색) / 오늘(amber) / 예정(emerald)"}
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
                <span class="ml-auto rounded bg-zinc-900/60 px-1.5 text-hint tabular-nums text-zinc-300">
                  {dayLabel}
                </span>
              </div>
              {e.description && (
                <div class="mt-0.5 text-xs text-zinc-400">{e.description}</div>
              )}
              {e.source_url && (
                <a class="mt-0.5 inline-block text-hint text-zinc-500 hover:text-zinc-400 hover:underline"
                   href={e.source_url} target="_blank" rel="noopener">출처 ↗</a>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
