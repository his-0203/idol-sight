import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { Tooltip, FACTOR_TOOLTIP } from "./Tooltip";

// "산식 보기" 모달. 4-factor 모델을 단일 뷰로 보여준다. 그룹 모델
// (기업형/분절형/연합형)별 가중치를 한눈에 볼 수 있게 표 형태로.

const FACTOR_LABELS: Record<string, string> = {
  reach:        "도달(Reach)",
  ritual:       "의례적 승리(Ritual)",
  mobilization: "동원(Mobilization)",
  intimacy:     "친밀도(Intimacy)",
};

const MODEL_LABELS: Record<string, string> = {
  corporate:     "기업형(K-pop 정통)",
  segmentary:    "분절형(왁타버스 위성)",
  confederation: "연합형(V-tuber 우산)",
};

export function HealthSpec() {
  const [open, setOpen] = useState(false);
  const [spec, setSpec] = useState<any>(null);
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
              <h3 class="font-semibold">Health Score 산식</h3>
              <button class="text-zinc-500 hover:text-zinc-300"
                      onClick={() => setOpen(false)}>✕</button>
            </div>
            {!spec ? <div class="text-zinc-500">로딩…</div> : (
              <FactorsView spec={spec} />
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
        그룹 모델별로 가중치가 달라집니다. 같은 신호라도 PLAVE-style(기업형),
        ISEDOL-style(분절형), STELLIVE-style(연합형)에 따라
        Health Score 구성 비중이 달라지며, 각 그룹의 실제 화력 측정 방식과
        정렬되도록 설계되었습니다.
      </p>

      <div class="overflow-x-auto rounded border border-zinc-800">
        <table class="w-full min-w-[480px] tabular-nums">
          <thead class="bg-zinc-900/60 text-zinc-500">
            <tr>
              <th class="px-2 py-1.5 text-left">지표</th>
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
                입력 가중치: {spec.factor_inputs[f]}
              </div>
            )}
          </div>
        ))}
      </div>

      <div class="rounded border border-zinc-800/60 bg-zinc-900/40 p-2 text-zinc-500">
        <p class="text-zinc-400">
          음원 성과는 실시간·일간 차트를 합쳐 단곡/다곡 진입을 함께 반영합니다.
        </p>
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
        등급: {spec.grade_thresholds.map(([g, t]: [string, number]) => `${g}≥${t}`).join(" / ")}
      </div>
    </div>
  );
}
