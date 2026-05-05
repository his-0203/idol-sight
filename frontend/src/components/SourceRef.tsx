// Inline source attribution. Renders as quiet text with a hover-underline so
// the surrounding card doesn't get visually overloaded with chip pills.
export function SourceRef(props: { refs: Array<{ table: string; pk: string; label: string }> }) {
  if (!props.refs.length) return null;
  return (
    <div class="mt-1 flex flex-wrap items-center gap-x-1 text-xs text-zinc-500">
      {props.refs.map((r, i) => (
        <span key={i} class="contents">
          {i > 0 && <span class="text-zinc-700" aria-hidden>·</span>}
          <span
            class="hover:text-zinc-300 hover:underline underline-offset-2 cursor-help"
            title={`${r.table}: ${r.pk}`}
          >{r.label}</span>
        </span>
      ))}
    </div>
  );
}
