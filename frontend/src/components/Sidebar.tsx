import { writeState, type RouterState } from "../router";
import { NAV_MODEL, isItemActive, type NavGroup, type NavItem } from "../lib/nav";

function Item({ item, state, onNavigate, own }: {
  item: NavItem; state: RouterState; onNavigate?: () => void; own?: boolean;
}) {
  const active = isItemActive(item, state);
  const base = "block w-full text-left rounded-ctrl px-2 py-1.5 text-data transition-colors ";
  const cls = active
    ? (own ? "text-own font-medium" : "bg-brand-weak text-brand-fg")
    : "text-zinc-300 hover:bg-zinc-800/60";
  const style = active && own ? { background: "rgba(117,215,209,0.16)" } : undefined;
  return (
    <button
      class={base + cls}
      style={style}
      onClick={() => { writeState({ tab: item.tab, category: item.category ?? "all" }); onNavigate?.(); }}
    >{item.label}</button>
  );
}

function Group({ group, state, onNavigate }: { group: NavGroup; state: RouterState; onNavigate?: () => void }) {
  if (group.own) {
    return (
      <div class="mt-3 rounded-card p-1.5"
           style={{ border: "1px solid rgba(117,215,209,0.55)", background: "rgba(117,215,209,0.07)" }}>
        <div class="flex items-center gap-1.5 px-1 pb-1">
          <span class="text-own leading-none">★</span>
          <span class="font-bold text-own text-data">{group.label}</span>
          <span class="rounded-chip border px-1 text-[9px] text-own"
                style={{ borderColor: "rgba(117,215,209,0.5)" }}>자사</span>
        </div>
        {group.items.map((it) => (
          <Item key={it.label} item={it} state={state} onNavigate={onNavigate} own />
        ))}
      </div>
    );
  }
  return (
    <div>
      <div class="px-2 pt-3 pb-1 text-[10px] uppercase tracking-wider text-zinc-500">
        {group.label}{group.sub ? <span class="text-zinc-500"> · {group.sub}</span> : null}
      </div>
      {group.items.map((it) => (
        <Item key={it.label} item={it} state={state} onNavigate={onNavigate} />
      ))}
    </div>
  );
}

export function Sidebar({ state, onNavigate }: { state: RouterState; onNavigate?: () => void }) {
  return (
    <nav class="w-56 shrink-0 p-2 text-sm" aria-label="주 메뉴">
      {NAV_MODEL.map((g) => (
        <Group key={g.id} group={g} state={state} onNavigate={onNavigate} />
      ))}
      <div class="text-hint text-zinc-500 px-2 pt-4 leading-relaxed">
        색: <b class="text-own">자사 #75d7d1</b> · <b class="text-market">시장</b>
      </div>
    </nav>
  );
}
