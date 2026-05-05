// frontend/src/views/Insights.tsx
import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { SourceRef } from "../components/SourceRef";

export function Insights() {
  const [data, setData] = useState<any>(null);
  useEffect(() => { api.insights().then(setData); }, []);
  if (!data) return <div class="text-zinc-500">Loading…</div>;
  return (
    <ul class="space-y-2 text-sm">
      {data.insights.map((i: any) => (
        <li key={i.id} class="rounded-lg border border-zinc-800 p-3">
          <div class="text-xs text-zinc-500">{i.scope} · {i.type} · {i.week_start ?? i.generated_at?.slice(0,10)}</div>
          <div class="font-semibold">{i.title}</div>
          <div class="mt-1 text-xs text-zinc-400">{i.body}</div>
          <SourceRef refs={i.source_refs ?? []} />
        </li>
      ))}
    </ul>
  );
}
