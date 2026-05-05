// frontend/src/components/EmptyState.tsx
// Reusable "nothing to show yet" placeholder. Keeps spacing consistent with
// the surrounding card grid so views don't collapse to awkward widths when
// the API returns empty arrays.
export function EmptyState(props: {
  title: string;
  hint?: string;
  icon?: string;
}) {
  return (
    <div class="rounded-card border border-zinc-800 bg-zinc-900/30 p-6 text-center">
      {props.icon && <div class="mb-2 text-2xl text-zinc-600" aria-hidden>{props.icon}</div>}
      <div class="text-sm font-semibold text-zinc-300">{props.title}</div>
      {props.hint && <div class="mt-1 text-xs text-zinc-500">{props.hint}</div>}
    </div>
  );
}
