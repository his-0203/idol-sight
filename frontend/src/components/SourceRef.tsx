export function SourceRef(props: { refs: Array<{ table: string; pk: string; label: string }> }) {
  if (!props.refs.length) return null;
  return (
    <div class="mt-1 flex flex-wrap gap-1 text-[10px] text-zinc-500">
      {props.refs.map((r, i) => (
        <span key={i} class="rounded bg-zinc-800/60 px-1.5 py-0.5"
              title={`${r.table}: ${r.pk}`}>📎 {r.label}</span>
      ))}
    </div>
  );
}
