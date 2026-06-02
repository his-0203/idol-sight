import { useState } from "preact/hooks";

type Status = "good" | "warn" | "bad" | "na";
interface Kpi {
  id: string; label: string; value: number | null; display: string;
  status: Status; target: string; why: string; fix: string;
}
export interface DiagnosticData {
  group_key: string;
  shorts_n: number;
  dimensions: {
    viral_physics: Kpi[]; discoverability: Kpi[]; core_strength: Kpi[];
    discovery_channels: Kpi[]; operating_rhythm: Kpi[];
  };
  priorities: Array<{ id: string; label: string; display: string; fix: string }>;
  caveats: string[];
}

const STATUS_COLOR: Record<Status, string> = {
  good: "#22c55e", warn: "#eab308", bad: "#ef4444", na: "#6b7280",
};
const DIM_LABEL: Record<string, string> = {
  viral_physics: "바이럴 물리", discoverability: "발견 가능성",
  core_strength: "코어 강도", discovery_channels: "발견 채널",
  operating_rhythm: "운영 리듬",
};

// 숏폼 알고리즘 7 레버 (리포트 9p evergreen).
const LEVERS: Array<[string, string]> = [
  ["① 첫 1~3초 후킹", "강한 첫 컷(질문·반전·시각 충격). 인트로·로고 제거."],
  ["② 시청 지속·재시청", "짧게, 군더더기 컷 삭제, 끝→처음 루프 설계."],
  ["③ 검색·분류 메타데이터", "제목 앞 검색어(그룹명·곡명·본명) + 설명·해시태그."],
  ["④ 트렌딩 사운드", "상승 중 사운드 빠르게 차용, 챌린지·밈에 얹기."],
  ["⑤ 초동 속도", "피크 시간 업로드 + 알림·커뮤니티 초기 부스트."],
  ["⑥ 공유·외부 유입", "공유 욕구 소재 + X·커뮤니티 동시 배포."],
  ["⑦ 업로드 일관성", "정기 cadence + 포맷·주제 일관."],
];
// 플랫폼별 전략 (리포트 10p evergreen).
const PLATFORMS: Array<[string, string]> = [
  ["YouTube", "검색 SEO — 제목 앞 키워드, 롱폼 자산화, 자막·챕터."],
  ["TikTok", "FYP·트렌딩 사운드·첫 2초·글로벌(동남아·일본) 도달."],
  ["IG Reels", "비주얼·세계관·저장 유발, 그리드 일관성."],
];

function KpiCell({ k }: { k: Kpi }) {
  return (
    <div class="rounded-ctrl border border-zinc-800 p-3" title={`${k.why}\n\n처방: ${k.fix}`}>
      <div class="flex items-center justify-between">
        <span class="text-hint text-zinc-400">{k.label}</span>
        <span class="inline-block h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[k.status] }} />
      </div>
      <div class="mt-1 text-lg font-bold tabular-nums">{k.display}</div>
      <div class="text-hint text-zinc-600">목표 {k.target}</div>
    </div>
  );
}

export function MiiwanShortsDiagnostic({ data }: { data: DiagnosticData }) {
  const [showPlaybook, setShowPlaybook] = useState(false);
  const dims = data.dimensions;

  return (
    <section class="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div class="mb-3 flex items-center justify-between">
        <h2 class="text-lg font-bold">MiiWAN 숏츠 운영 진단</h2>
        <span class="text-hint text-zinc-500">숏폼 {data.shorts_n}편 기준</span>
      </div>

      {data.shorts_n === 0 ? (
        <p class="text-zinc-400">숏폼 데이터가 아직 없습니다.</p>
      ) : (
        <>
          {data.priorities.length > 0 && (
            <div class="mb-4 rounded-ctrl border border-red-900/50 bg-red-950/20 p-3">
              <div class="mb-2 font-semibold text-red-300">🔴 지금 우선순위 TOP {data.priorities.length}</div>
              <ol class="space-y-1.5">
                {data.priorities.map((p, i) => (
                  <li key={p.id} class="text-data">
                    <span class="font-semibold">{i + 1}. {p.label}</span>
                    <span class="text-zinc-500"> ({p.display})</span>
                    <span class="text-zinc-400"> — {p.fix}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          <div class="space-y-3">
            {(Object.keys(dims) as Array<keyof typeof dims>).map((key) => (
              <div key={key}>
                <div class="mb-1.5 text-hint font-semibold uppercase tracking-wide text-zinc-500">
                  {DIM_LABEL[key]}
                </div>
                <div class="grid grid-cols-2 gap-2 md:grid-cols-4">
                  {dims[key].map((k) => <KpiCell key={k.id} k={k} />)}
                </div>
              </div>
            ))}
          </div>

          <ul class="mt-3 space-y-0.5">
            {data.caveats.map((c) => (
              <li key={c} class="text-hint text-zinc-600">· {c}</li>
            ))}
          </ul>
        </>
      )}

      <button
        class="mt-4 text-data text-brand-fg hover:underline"
        onClick={() => setShowPlaybook((v) => !v)}
      >
        📘 숏폼 알고리즘 플레이북 {showPlaybook ? "▲" : "▼"}
      </button>
      {showPlaybook && (
        <div class="mt-3 grid gap-4 md:grid-cols-2">
          <div>
            <div class="mb-1.5 text-hint font-semibold text-zinc-400">알고리즘 7 레버</div>
            <ul class="space-y-1">
              {LEVERS.map(([t, d]) => (
                <li key={t} class="text-hint">
                  <span class="font-semibold text-zinc-300">{t}</span>
                  <span class="text-zinc-500"> — {d}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div class="mb-1.5 text-hint font-semibold text-zinc-400">플랫폼별 전략</div>
            <ul class="space-y-1">
              {PLATFORMS.map(([t, d]) => (
                <li key={t} class="text-hint">
                  <span class="font-semibold text-zinc-300">{t}</span>
                  <span class="text-zinc-500"> — {d}</span>
                </li>
              ))}
            </ul>
            <p class="mt-2 text-hint text-zinc-600">원본 1개 → 플랫폼별 3벌 리퍼포징(워터마크 제거·세로 풀스크린·캡션 교체).</p>
          </div>
        </div>
      )}
    </section>
  );
}
