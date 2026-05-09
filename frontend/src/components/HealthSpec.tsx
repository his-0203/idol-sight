import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { Tooltip, FACTOR_TOOLTIP } from "./Tooltip";

// "산식 보기" 모달. v2.5 4-factor 모델을 1차 view로 보여주고, 6-component
// breakdown은 호환을 위해 보조 view로 보여준다. 그룹 모델 (corporate /
// segmentary / confederation)별 가중치를 한눈에 볼 수 있게 표 형태로.

const FACTOR_LABELS: Record<string, string> = {
  reach:        "Reach (도달)",
  ritual:       "RitualVictory (의례 승리)",
  mobilization: "Mobilization (동원)",
  intimacy:     "Intimacy (친밀성)",
};

const MODEL_LABELS: Record<string, string> = {
  corporate:     "Corporate",
  segmentary:    "Segmentary",
  confederation: "Confederation",
};

export function HealthSpec() {
  const [open, setOpen] = useState(false);
  const [spec, setSpec] = useState<any>(null);
  const [view, setView] = useState<"factors" | "legacy">("factors");
  useEffect(() => { if (open && !spec) api.healthSpec().then(setSpec); }, [open]);
  return (
    <>
      <button
        class="text-xs text-zinc-500 underline-offset-2 hover:underline"
        onClick={() => setOpen(true)}
      >산식 보기</button>
      {open && (
        <div class="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
             onClick={() => setOpen(false)}>
          <div class="max-h-[90vh] w-full max-w-2xl overflow-y-auto
                      rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-sm"
               onClick={(e) => e.stopPropagation()}>
            <div class="mb-3 flex items-center justify-between">
              <h3 class="font-semibold">Health Score 산식 (V2.18)</h3>
              <button class="text-zinc-500 hover:text-zinc-300"
                      onClick={() => setOpen(false)}>✕</button>
            </div>
            {!spec ? <div class="text-zinc-500">로딩…</div> : (
              <>
                <div class="mb-3 flex gap-1 text-xs">
                  <button
                    class={"rounded px-2 py-1 transition-colors " +
                           (view === "factors"
                             ? "bg-brand-weak text-brand-fg"
                             : "text-zinc-500 hover:bg-zinc-800/60")}
                    onClick={() => setView("factors")}
                  >4-Factor (V2.5)</button>
                  <button
                    class={"rounded px-2 py-1 transition-colors " +
                           (view === "legacy"
                             ? "bg-brand-weak text-brand-fg"
                             : "text-zinc-500 hover:bg-zinc-800/60")}
                    onClick={() => setView("legacy")}
                  >Legacy 6-component</button>
                </div>

                {view === "factors" ? (
                  <FactorsView spec={spec} />
                ) : (
                  <LegacyView spec={spec} />
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function FactorsView({ spec }: { spec: any }) {
  const fw = spec.factor_weights ?? {};
  const fd = spec.factor_descriptions ?? {};
  const gm = spec.group_models ?? {};
  const factors = ["reach", "ritual", "mobilization", "intimacy"];
  const models  = ["corporate", "segmentary", "confederation"];
  return (
    <div class="space-y-3 text-xs">
      <p class="text-zinc-400">
        그룹 모델별로 가중치가 달라집니다. 같은 신호라도 PLAVE-style(corporate),
        ISEDOL-style(segmentary), STELLIVE-style(confederation)에 따라
        Health Score 구성 비중이 달라지며, 각 그룹의 실제 화력 측정 방식과
        정렬되도록 설계되었습니다.
      </p>

      <div class="overflow-x-auto rounded border border-zinc-800">
        <table class="w-full min-w-[480px] tabular-nums">
          <thead class="bg-zinc-900/60 text-zinc-500">
            <tr>
              <th class="px-2 py-1.5 text-left">Factor</th>
              {models.map((m) => (
                <th key={m} class="px-2 py-1.5 text-right">{MODEL_LABELS[m]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {factors.map((f) => (
              <tr key={f} class="border-t border-zinc-800/60">
                <td class="px-2 py-1.5 text-zinc-300">
                  <Tooltip
                    content={FACTOR_TOOLTIP[f] ?? FACTOR_LABELS[f]}
                    triggerClass="text-zinc-300"
                  >
                    {FACTOR_LABELS[f]}
                  </Tooltip>
                </td>
                {models.map((m) => (
                  <td key={m} class="px-2 py-1.5 text-right">
                    {fw[m]?.[f] ?? "—"}
                  </td>
                ))}
              </tr>
            ))}
            <tr class="border-t border-zinc-700 bg-zinc-900/30 text-zinc-400">
              <td class="px-2 py-1.5">합계</td>
              {models.map((m) => (
                <td key={m} class="px-2 py-1.5 text-right">100</td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <div class="space-y-1 text-zinc-400">
        {factors.map((f) => (
          <div key={f}>
            <Tooltip
              content={FACTOR_TOOLTIP[f] ?? FACTOR_LABELS[f]}
              triggerClass="text-zinc-300"
            >
              {FACTOR_LABELS[f]}
            </Tooltip>
            {fd[f] && <span class="ml-2 text-zinc-500">{fd[f]}</span>}
            {spec.factor_inputs?.[f] && (
              <div class="ml-4 text-[11px] text-zinc-500">
                input weights: {spec.factor_inputs[f]}
              </div>
            )}
          </div>
        ))}
      </div>

      <div class="rounded border border-amber-900/40 bg-amber-950/20 p-2 text-zinc-500">
        <div class="mb-1 font-semibold text-amber-400">V2.19 산식 보정 (음원 차트 두 축화)</div>
        <ul class="ml-3 list-disc space-y-0.5">
          <li>collector가 <strong>realtime + daily 두 차트</strong>를 fetch하고 song_id로 dedup union.
              일간만 fetch하던 V2.18에서 PLAVE처럼 팬덤 깊은 그룹의 음원 깊이가
              underrepresented (PLAVE 일간 1곡 / 실시간 6곡) 되던 문제 해결.</li>
          <li>ritual factor 차트 축 0.20을 <strong>peak/depth 반반</strong> 분할.
              <code>chart_peak</code> 0.20→0.10 (union의 best rank),
              <code>chart_depth</code> 0.10 신설 (union 진입곡 수, ref=5 saturated).
              단곡 진입과 다곡 진입 변별 가능.</li>
        </ul>
        <div class="mt-1 text-[11px] text-zinc-500">
          V2.18 유지: STELLIVE segmentary 통합. V2.17 유지: news log1p normalize +
          news weight (reach 0.05 / ritual 0.10).
          V2.16 유지: redistribute=False ritual / music_show_wins stub /
          cold-start floor 제거.
        </div>
      </div>

      <div class="rounded border border-zinc-800/60 bg-zinc-900/40 p-2 text-zinc-500">
        <div class="mb-1 font-semibold text-zinc-400">그룹 모델 분류</div>
        {models.map((m) => (
          <div key={m} class="text-hint">
            <span class="text-zinc-400">{MODEL_LABELS[m]}</span>:{" "}
            {gm[m]}
          </div>
        ))}
      </div>

      <div class="text-zinc-500">
        Grade: {spec.grade_thresholds.map(([g, t]: [string, number]) => `${g}≥${t}`).join(" / ")}
      </div>
    </div>
  );
}

function LegacyView({ spec }: { spec: any }) {
  return (
    <div class="space-y-2 text-xs">
      <p class="text-zinc-500">
        호환용 — 기존 6-component breakdown. V2.5에서는 4-factor가 1차 view입니다.
      </p>
      <table class="w-full">
        <tbody>
          {Object.entries(spec.weights).map(([k, v]) => (
            <tr key={k}>
              <td class="py-0.5 text-zinc-400">{k}</td>
              <td class="py-0.5 text-right">{String(v)}</td>
              <td class="py-0.5 pl-3 text-zinc-500">{spec.references[k]}</td>
            </tr>
          ))}
          <tr class="border-t border-zinc-800">
            <td class="pt-1 text-zinc-400">bonus_max</td>
            <td class="pt-1 text-right">{spec.bonus_max}</td>
            <td class="pt-1 pl-3 text-zinc-500">{spec.references.bonus}</td>
          </tr>
          <tr>
            <td class="text-zinc-400">denom</td>
            <td class="text-right">{spec.denom}</td>
            <td class="pl-3 text-zinc-500">total = raw / denom × 10</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
