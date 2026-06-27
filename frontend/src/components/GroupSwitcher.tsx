import { useEffect, useState } from "preact/hooks";
import { onStateChange, readState, writeState } from "../router";
import { api } from "../api";
import { colorOf } from "../design/groups";
import {
  groupsByCategory, CATEGORY_LABEL, CATEGORY_ORDER, type CategorizedGroup,
} from "../lib/category";

interface GroupLite { key: string; name: string; group_model?: string | null }

// 그룹 전환 셀렉터 — master-detail의 "다른 엔티티 선택". 현재 하위탭은 유지한 채
// (writeState({group}) 머지) 그룹만 바꾼다. 카테고리별로 묶어 보여준다.
export function GroupSwitcher() {
  const [state, setState] = useState(readState());
  const [groups, setGroups] = useState<GroupLite[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => onStateChange(setState), []);
  useEffect(() => {
    let cancelled = false;
    api.groups()
      .then((r: any) => { if (!cancelled) setGroups(r.groups ?? []); })
      .catch(() => { if (!cancelled) setGroups([]); });
    return () => { cancelled = true; };
  }, []);

  const current = groups?.find((g) => g.key === state.group) ?? null;
  const byCat = groupsByCategory(groups ?? []);

  return (
    <div class="relative">
      <button
        class="flex items-center gap-1.5 rounded-ctrl border border-zinc-700 px-2 py-1 text-data hover:bg-zinc-800/60"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox" aria-expanded={open}
      >
        {current ? (
          <>
            <span class="inline-block h-2.5 w-2.5 rounded-full" style={{ background: colorOf(current.key) }}></span>
            <b>{current.name}</b>
          </>
        ) : <span class="text-zinc-400">그룹 선택</span>}
        <span class="text-zinc-500">▾</span>
      </button>
      {open && (
        <>
          <div class="fixed inset-0 z-10" onClick={() => setOpen(false)}></div>
          <div class="absolute z-20 mt-1 max-h-80 w-56 overflow-auto rounded-card border border-zinc-700 bg-surface p-1 shadow-xl"
               role="listbox">
            {CATEGORY_ORDER.map((cat) => byCat[cat].length ? (
              <div key={cat}>
                <div class="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-zinc-500">
                  {CATEGORY_LABEL[cat]}
                </div>
                {byCat[cat].map((g: CategorizedGroup) => {
                  const own = g.key === "miiwan";
                  const active = g.key === state.group;
                  return (
                    <button
                      key={g.key} role="option" aria-selected={active}
                      class={"flex w-full items-center gap-1.5 rounded-ctrl px-2 py-1.5 text-left text-data " +
                        (active ? "bg-brand-weak text-brand-fg" : "text-zinc-200 hover:bg-zinc-800/60")}
                      onClick={() => { writeState({ group: g.key }); setOpen(false); }}
                    >
                      <span class="inline-block h-2 w-2 rounded-full" style={{ background: colorOf(g.key) }}></span>
                      <span>{g.name}</span>
                      {own && (
                        <span class="ml-auto rounded-chip border px-1 text-[9px] text-own"
                              style={{ borderColor: "rgba(117,215,209,0.5)" }}>자사</span>
                      )}
                    </button>
                  );
                }) }
              </div>
            ) : null)}
          </div>
        </>
      )}
    </div>
  );
}
