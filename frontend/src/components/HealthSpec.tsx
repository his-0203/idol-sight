import { useEffect, useState } from "preact/hooks";
import { api } from "../api";

export function HealthSpec() {
  const [open, setOpen] = useState(false);
  const [spec, setSpec] = useState<any>(null);
  useEffect(() => { if (open && !spec) api.healthSpec().then(setSpec); }, [open]);
  return (
    <>
      <button
        class="text-[10px] text-zinc-500 underline-offset-2 hover:underline"
        onClick={() => setOpen(true)}
      >산식 보기</button>
      {open && (
        <div class="fixed inset-0 z-50 grid place-items-center bg-black/60" onClick={() => setOpen(false)}>
          <div class="max-w-md rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-sm" onClick={(e) => e.stopPropagation()}>
            <div class="mb-2 flex items-center justify-between">
              <h3 class="font-semibold">Health Score 산식</h3>
              <button class="text-zinc-500 hover:text-zinc-300" onClick={() => setOpen(false)}>✕</button>
            </div>
            {!spec ? <div class="text-zinc-500">로딩…</div> : (
              <div class="space-y-2 text-xs">
                <table class="w-full">
                  <tbody>
                    {Object.entries(spec.weights).map(([k, v]) => (
                      <tr><td class="py-0.5 text-zinc-400">{k}</td>
                          <td class="py-0.5 text-right">{String(v)}</td>
                          <td class="py-0.5 pl-3 text-zinc-500">{spec.references[k]}</td></tr>
                    ))}
                    <tr class="border-t border-zinc-800">
                      <td class="pt-1 text-zinc-400">bonus_max</td>
                      <td class="pt-1 text-right">{spec.bonus_max}</td>
                      <td class="pt-1 pl-3 text-zinc-500">{spec.references.bonus}</td>
                    </tr>
                    <tr><td class="text-zinc-400">denom</td><td class="text-right">{spec.denom}</td>
                        <td class="pl-3 text-zinc-500">total = raw / denom × 10</td></tr>
                  </tbody>
                </table>
                <div class="text-zinc-500">
                  Grade: {spec.grade_thresholds.map(([g, t]: [string, number]) => `${g}≥${t}`).join(" / ")}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
