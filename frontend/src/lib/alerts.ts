// Single source for alert rule labels, severity tones, and controversy-spike
// thresholds shared by PRRisk / MiiWANBriefing / GroupContent — each had its own
// hand-copied set. The thresholds mirror worker alerts/__init__.py and are
// guarded by tests/lib/alerts.test.ts: drift between the BI Risk Level and the
// Discord webhook ("dashboard says LOW but the bot didn't fire") is the fastest
// way to lose operator trust.

export const CONTROVERSY_SPIKE_MULTIPLIER = 2.0; // 2x previous-week count
export const CONTROVERSY_SPIKE_MIN_COUNT = 5;    // baseline floor; ignore noise

export const ALERT_RULE_LABEL: Record<string, string> = {
  controversy_spike:  "논란 급증",
  identity_leak:      "본체 노출 가능성",
  model_theft:        "AI 도용 / 딥페이크",
  video_velocity_24h: "24h Viral",
  debut_milestone:    "데뷔 마일스톤",
};

export const ALERT_SEVERITY_TONE: Record<string, string> = {
  critical: "border-red-500/60 bg-red-500/10 text-red-200",
  warn:     "border-amber-500/40 bg-amber-500/10 text-amber-200",
  info:     "border-zinc-700 bg-zinc-900/40 text-zinc-300",
};
