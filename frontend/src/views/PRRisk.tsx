import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api";
import { KPI } from "../components/KPI";
import { EmptyState } from "../components/EmptyState";
import { GroupTabs } from "../components/GroupTabs";
import { formatKST, formatKSTDate } from "../lib/datetime";

function wowDelta(curr: number | null | undefined, prev: number | null | undefined): number | null {
  if (curr == null || prev == null) return null;
  return curr - prev;
}

function seriesOf(history: any[] | undefined, field: string): number[] | undefined {
  if (!history || history.length < 2) return undefined;
  return history.map((r) => Number(r[field] ?? 0));
}

// Mirrors worker/idol_sight/alerts/__init__.py thresholds. Keep both in
// sync — drift between the BI Risk Level and the Discord webhook is
// the fastest way to lose operator trust ("the dashboard says LOW but
// the bot didn't fire").
const CONTROVERSY_SPIKE_MULTIPLIER = 2.0;
const CONTROVERSY_SPIKE_MIN_COUNT = 5;

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

export function PRRisk({ groupKey }: { groupKey: string | null }) {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    if (!groupKey) return;
    setData(null);
    api.group(groupKey).then(setData);
  }, [groupKey]);

  const news = data?.naver_articles ?? [];
  const tweets = data?.twitter_posts ?? [];
  const alerts: AlertRow[] = data?.alerts ?? [];

  // Trend-aware risk level matching the worker's controversy_spike rule
  // (2× WoW with min_count=5). Pure-count heuristics like "≥1 = LOW"
  // generated false alarms because they ignored baseline volume — a
  // 6-controversy week is normal for some groups and a spike for
  // others. We compute the multiplier exactly like rule_controversy_
  // spike and surface it as a chip on the banner.
  const trend = data?.controversy_trend ?? null;
  const cur = trend?.current ?? 0;
  const prev = trend?.previous ?? 0;
  const ratio: number | null = prev === 0
    ? (cur > 0 ? Infinity : null)
    : cur / prev;
  const isSpiking = cur >= CONTROVERSY_SPIKE_MIN_COUNT
                  && ratio != null
                  && ratio >= CONTROVERSY_SPIKE_MULTIPLIER;
  const hasCritical = alerts.some((a) => a.severity === "critical");
  const riskLevel: "OK" | "ELEVATED" | "CRITICAL" =
    hasCritical ? "CRITICAL" : isSpiking ? "ELEVATED" : "OK";

  const identityLeaks = useMemo(
    () => alerts.filter((a) => a.rule === "identity_leak"),
    [alerts],
  );
  const modelThefts = useMemo(
    () => alerts.filter((a) => a.rule === "model_theft"),
    [alerts],
  );
  const otherAlerts = useMemo(
    () => alerts.filter(
      (a) => a.rule !== "identity_leak" && a.rule !== "model_theft"),
    [alerts],
  );
  const controversyTweets = tweets.filter((t: any) => t.type === "controversy");

  if (!groupKey) {
    return (
      <div class="space-y-4">
        <GroupTabs />
        <EmptyState
          title="그룹을 선택하세요"
          hint="상단 시장 개요 카드 또는 Cmd+K 검색에서 그룹을 고르면 PR/리스크 신호가 표시됩니다."
          icon="👆"
        />
      </div>
    );
  }
  if (!data) return (
    <div class="space-y-4">
      <GroupTabs />
      <div class="text-zinc-500">Loading…</div>
    </div>
  );
  if (news.length === 0 && tweets.length === 0 && alerts.length === 0) {
    return (
      <div class="space-y-4">
        <GroupTabs />
        <EmptyState
          title="아직 추적된 PR/리스크 신호 없음"
          hint="뉴스 기사와 트위터 멘션은 수집 파이프라인이 신호를 발견하는 즉시 표시됩니다."
          icon="🛡️"
        />
      </div>
    );
  }

  return (
    <div class="space-y-4">
      <GroupTabs />
      {/* Risk banner — driven by alerts severity + worker-aligned spike check. */}
      <div class={"rounded border-l-4 px-3 py-2 text-sm " +
        (riskLevel === "CRITICAL"
          ? "border-red-500 bg-red-500/10 text-red-200"
          : riskLevel === "ELEVATED"
          ? "border-amber-500 bg-amber-500/10 text-amber-200"
          : "border-emerald-500/40 bg-emerald-500/5 text-emerald-200")}>
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-semibold">Risk: {riskLevel}</span>
          {trend && (
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
        {(riskLevel !== "OK") && (
          <div class="mt-1 text-xs text-zinc-300">
            ※ 자동 알림 — 인간 검증 후 대응 권장. False positive 시 Streisand effect 주의.
          </div>
        )}
      </div>

      <section class="grid grid-cols-2 gap-2 md:grid-cols-4">
        {/* News/Twitter/Controversy KPIs use agg_summary cumulative
            counts (with WoW delta + 30d sparkline) rather than the
            currently-loaded list lengths. The list lengths cap at 30
            and would mislead the operator about real volume changes. */}
        <KPI
          label="뉴스 (누적)"
          value={data.summary?.naver_total_news ?? news.length}
          delta={wowDelta(data.summary?.naver_total_news, data.prev_summary?.naver_total_news)}
          sparkline={seriesOf(data.summary_history, "naver_total_news")}
        />
        <KPI
          label="트위터 (누적)"
          value={data.summary?.twitter_posts ?? tweets.length}
          delta={wowDelta(data.summary?.twitter_posts, data.prev_summary?.twitter_posts)}
          sparkline={seriesOf(data.summary_history, "twitter_posts")}
        />
        <KPI
          label="Controversy"
          value={data.summary?.controversy_count ?? controversyTweets.length}
          delta={wowDelta(data.summary?.controversy_count, data.prev_summary?.controversy_count)}
          sparkline={seriesOf(data.summary_history, "controversy_count")}
        />
        <KPI label="활성 알림 (14d)" value={alerts.length} hint={riskLevel} />
      </section>

      {/* Identity leak — virtual-idol playbook's most severe class.
          Press picking up the human-behind-the-character is treated
          critically per worker rule_identity_leak. */}
      {identityLeaks.length > 0 && (
        <section class="rounded-lg border-2 border-red-500/60 bg-red-500/5 p-3">
          <h3 class="section-title mb-2 flex items-center gap-2 text-red-200">
            🔒 본체 노출 알림
            <span class="rounded bg-red-500/20 px-2 text-xs">{identityLeaks.length}건</span>
          </h3>
          <ul class="space-y-2 text-xs">
            {identityLeaks.map((a) => (
              <li key={a.alert_key} class="rounded border border-red-500/40 bg-zinc-900/40 p-2">
                <div class="font-semibold">{a.title}</div>
                <div class="mt-1 text-zinc-400">{a.body}</div>
                <div class="mt-1 text-zinc-500" title={formatKST(a.fired_at)}>{formatKST(a.fired_at)}</div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Model theft / AI cover spikes. */}
      {modelThefts.length > 0 && (
        <section class="rounded-lg border-2 border-amber-500/60 bg-amber-500/5 p-3">
          <h3 class="section-title mb-2 flex items-center gap-2 text-amber-200">
            🤖 모델 도용 / AI 음성 알림
            <span class="rounded bg-amber-500/20 px-2 text-xs">{modelThefts.length}건</span>
          </h3>
          <ul class="space-y-2 text-xs">
            {modelThefts.map((a) => (
              <li key={a.alert_key} class="rounded border border-amber-500/40 bg-zinc-900/40 p-2">
                <div class="font-semibold">{a.title}</div>
                <div class="mt-1 text-zinc-400">{a.body}</div>
                <div class="mt-1 text-zinc-500" title={formatKST(a.fired_at)}>{formatKST(a.fired_at)}</div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Other alerts (controversy_spike / video_velocity_24h / debut_milestone) */}
      {otherAlerts.length > 0 && (
        <section class="rounded-lg border border-zinc-800 p-3">
          <h3 class="section-title mb-2">기타 활성 알림</h3>
          <ul class="space-y-2 text-xs">
            {otherAlerts.map((a) => (
              <li key={a.alert_key} class={`rounded border-l-2 p-2 ${SEVERITY_TONE[a.severity]}`}>
                <div class="flex items-baseline gap-2">
                  <span class="rounded bg-zinc-900/60 px-1.5 text-[11px] text-zinc-300">
                    {RULE_LABEL[a.rule] ?? a.rule}
                  </span>
                  <span class="font-semibold">{a.title}</span>
                  <span class="ml-auto text-zinc-500" title={formatKST(a.fired_at)}>{formatKST(a.fired_at)}</span>
                </div>
                <div class="mt-1 text-zinc-400">{a.body}</div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {news.length > 0 && (
        <section class="rounded-lg border border-zinc-800 p-3">
          <h3 class="section-title mb-3 border-b border-zinc-800/40 pb-2">최근 뉴스</h3>
          <ul class="space-y-1 text-xs">
            {news.map((n: any, i: number) => (
              <li key={i}>
                <a class="hover:underline" href={n.url} target="_blank" rel="noopener">{n.title}</a>
                <span class="ml-2 text-zinc-500" title={n.published_at ? formatKST(n.published_at) : undefined}>
                  {n.source ?? ""} · {formatKSTDate(n.published_at)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {tweets.length > 0 && (
        <section class="rounded-lg border border-zinc-800 p-3">
          <h3 class="section-title mb-3 border-b border-zinc-800/40 pb-2">트위터/X</h3>
          <ul class="space-y-1 text-xs">
            {/* Controversy 우선 정렬 — 운영자 시선이 즉시 닿게. */}
            {[...tweets].sort((a: any, b: any) => {
              const w = (t: any) => t.type === "controversy" ? 0 : t.type === "news" ? 1 : 2;
              return w(a) - w(b);
            }).map((t: any) => (
              <li key={t.tweet_id}>
                <span class={"mr-1 rounded px-1.5 text-xs " +
                             (t.type === "controversy" ? "bg-red-500/20 text-red-300"
                              : t.type === "news" ? "bg-blue-500/20 text-blue-300"
                              : t.type === "event" ? "bg-emerald-500/20 text-emerald-300"
                              : "bg-zinc-800 text-zinc-400")}>{t.type}</span>
                <a class="hover:underline" href={t.url} target="_blank" rel="noopener">{t.title}</a>
                <span class="ml-2 text-zinc-500">@{t.author_handle}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
