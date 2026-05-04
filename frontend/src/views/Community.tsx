export function Community({ groupKey, period }: { groupKey: string | null; period: number | null }) {
  return <div class="text-zinc-500">Community {groupKey ?? "(no group)"} period={period ?? "all"} — Task 13</div>;
}
