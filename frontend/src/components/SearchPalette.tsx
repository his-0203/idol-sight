import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { writeState } from "../router";

export function SearchPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<any>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (!open || !q) { setResults(null); return; }
    const t = setTimeout(() => api.search(q).then(setResults).catch(() => setResults(null)), 200);
    return () => clearTimeout(t);
  }, [open, q]);

  if (!open) return null;
  return (
    <div class="fixed inset-0 z-50 grid place-items-start bg-black/60 pt-24" onClick={() => setOpen(false)}>
      <div class="mx-auto w-full max-w-xl rounded-lg border border-zinc-800 bg-zinc-900 p-3 shadow-2xl"
           onClick={(e) => e.stopPropagation()}>
        <input type="text" autofocus value={q}
               placeholder="검색 (그룹/멤버/뉴스/커뮤니티 글)…"
               onInput={(e: any) => setQ(e.currentTarget.value)}
               class="w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm focus:border-violet-500 focus:outline-none" />
        {results && (
          <div class="mt-3 max-h-96 space-y-3 overflow-y-auto text-sm">
            {results.groups?.length > 0 && <Section title="Groups">{results.groups.map((g: any) =>
              <button key={g.key} class="block w-full rounded px-2 py-1 text-left hover:bg-zinc-800"
                      onClick={() => { writeState({ tab: "content", group: g.key }); setOpen(false); }}>
                {g.name} <span class="text-zinc-500">{g.name_kr}</span>
              </button>)}</Section>}
            {results.members?.length > 0 && <Section title="Members">{results.members.map((m: any) =>
              <button key={m.id} class="block w-full rounded px-2 py-1 text-left hover:bg-zinc-800"
                      onClick={() => { writeState({ tab: "members", group: m.group_key }); setOpen(false); }}>
                {m.name} <span class="text-zinc-500">({m.group_key})</span>
              </button>)}</Section>}
            {results.naver?.length > 0 && <Section title="News">{results.naver.map((n: any, i: number) =>
              <a key={i} class="block rounded px-2 py-1 hover:bg-zinc-800" href={n.url} target="_blank">{n.title}</a>)}
            </Section>}
            {results.community?.length > 0 && <Section title="Community">{results.community.map((c: any, i: number) =>
              <a key={i} class="block rounded px-2 py-1 hover:bg-zinc-800" href={c.url} target="_blank">
                <span class="mr-1 text-[10px] text-zinc-500">[{c.platform}]</span>{c.title}</a>)}
            </Section>}
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: any }) {
  return (
    <div>
      <div class="mb-1 text-[10px] uppercase text-zinc-500">{title}</div>
      <div>{children}</div>
    </div>
  );
}
