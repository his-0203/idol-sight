import { useEffect, useState } from "preact/hooks";
import { api } from "../api";

// Operational health surface (PM/operator). Answers "is the pipeline actually
// running?" — the recurring failure mode is silent: collection stalls while the
// dashboard still renders stale numbers. Reads /api/admin/status.

interface JobRow {
  job: string; source: string | null; group_key: string | null;
  expected_interval_h: number | null;
  last_success_at: string | null; last_attempt_at: string | null;
  status: string | null; error_msg: string | null;
  hours_since_success: number | null; stale_after_h: number;
  state: "ok" | "failed" | "stale" | "unknown";
}
interface StatusResp {
  generated_at: string;
  overall: "ok" | "warn" | "critical";
  jobs: JobRow[];
  last_aggregate_at: string | null;
  aggregate_hours_ago: number | null;
  last_alert_at: string | null;
  counts: Record<string, number>;
}

const OVERALL_TONE: Record<string, string> = {
  ok:       "border-emerald-500/50 bg-emerald-500/10 text-emerald-200",
  warn:     "border-amber-500/50 bg-amber-500/10 text-amber-200",
  critical: "border-red-500/60 bg-red-500/10 text-red-200",
};
const OVERALL_LABEL: Record<string, string> = {
  ok: "🟢 정상", warn: "🟡 점검 필요", critical: "🔴 장애",
};
const STATE_DOT: Record<string, string> = {
  ok: "#16a34a", stale: "#eab308", unknown: "#6b7280", failed: "#ef4444",
};
const STATE_LABEL: Record<string, string> = {
  ok: "정상", stale: "지연", unknown: "이력없음", failed: "실패",
};

function ago(h: number | null): string {
  if (h == null) return "—";
  if (h < 1) return `${Math.round(h * 60)}분 전`;
  if (h < 48) return `${h.toFixed(1)}시간 전`;
  return `${Math.round(h / 24)}일 전`;
}
function fmtNum(n: number | undefined): string {
  return n == null ? "—" : n.toLocaleString();
}

export function SystemStatus() {
  const [data, setData] = useState<StatusResp | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.adminStatus().then(setData).catch((e) => setErr(String(e)));
  }, []);

  if (err) return <div class="text-rose-400">상태 불러오기 실패: {err}</div>;
  if (!data) return <div class="text-zinc-500">Loading…</div>;

  // worst-first: failed → stale/unknown → ok
  const order = { failed: 0, stale: 1, unknown: 2, ok: 3 } as const;
  const jobs = [...data.jobs].sort((a, b) => order[a.state] - order[b.state]);

  return (
    <div class="space-y-4">
      <div class="flex items-center gap-3">
        <h2 class="text-lg font-semibold">시스템 상태</h2>
        <span class={"rounded border px-2 py-0.5 text-sm " + (OVERALL_TONE[data.overall] ?? "")}>
          {OVERALL_LABEL[data.overall] ?? data.overall}
        </span>
        <span class="text-hint text-zinc-500">
          {new Date(data.generated_at).toLocaleString("ko-KR")}
        </span>
      </div>

      {/* 파이프라인 요약 */}
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div class="rounded border border-zinc-800 p-3">
          <div class="text-hint text-zinc-500">마지막 집계(aggregate)</div>
          <div class="text-data">{ago(data.aggregate_hours_ago)}</div>
        </div>
        <div class="rounded border border-zinc-800 p-3">
          <div class="text-hint text-zinc-500">마지막 알림</div>
          <div class="text-data">
            {data.last_alert_at ? new Date(data.last_alert_at).toLocaleDateString("ko-KR") : "—"}
          </div>
        </div>
        <div class="rounded border border-zinc-800 p-3">
          <div class="text-hint text-zinc-500">수집 잡 상태</div>
          <div class="text-data">
            {jobs.filter((j) => j.state === "ok").length}/{jobs.length} 정상
          </div>
        </div>
      </div>

      {/* 수집 잡 freshness */}
      <div class="overflow-x-auto rounded border border-zinc-800">
        <table class="w-full min-w-[560px] text-[12px] tabular-nums">
          <thead class="bg-zinc-900/60 text-zinc-500">
            <tr>
              <th class="px-2 py-1.5 text-left">잡</th>
              <th class="px-2 py-1.5 text-left">상태</th>
              <th class="px-2 py-1.5 text-right">마지막 성공</th>
              <th class="px-2 py-1.5 text-right">지연 임계(h)</th>
              <th class="px-2 py-1.5 text-left">오류</th>
            </tr>
          </thead>
          <tbody class="text-zinc-300">
            {jobs.map((j) => (
              <tr key={j.job} class="border-t border-zinc-800/60">
                <td class="px-2 py-1.5">{j.job}</td>
                <td class="px-2 py-1.5">
                  <span style={{ color: STATE_DOT[j.state] }}>●</span>{" "}
                  {STATE_LABEL[j.state] ?? j.state}
                </td>
                <td class="px-2 py-1.5 text-right">{ago(j.hours_since_success)}</td>
                <td class="px-2 py-1.5 text-right text-zinc-500">{j.stale_after_h}</td>
                <td class="px-2 py-1.5 text-rose-300/80 max-w-[280px] truncate"
                    title={j.error_msg ?? ""}>{j.error_msg ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 데이터 성장(비용 프록시) */}
      <div class="rounded border border-zinc-800/60 bg-zinc-900/40 p-3">
        <div class="mb-1 text-hint text-zinc-500">데이터 누적 (비용·성장 프록시)</div>
        <div class="flex flex-wrap gap-x-5 gap-y-1 text-data">
          <span>영상 {fmtNum(data.counts.videos)}</span>
          <span>영상 스냅샷 {fmtNum(data.counts.video_stats)}</span>
          <span>커뮤글 {fmtNum(data.counts.community_posts)}</span>
          <span>네이버 {fmtNum(data.counts.naver_articles)}</span>
          <span>agg 스냅샷 {fmtNum(data.counts.snapshots)}</span>
        </div>
      </div>

      <p class="text-hint text-zinc-500">
        지연 임계 = 기대 주기 × 4 (health-check 기준). 실패/지연 잡은
        GitHub Actions 로그 확인 후 재실행. 자세한 지표 정의는 운영팀 문서를 참고.
      </p>
    </div>
  );
}
