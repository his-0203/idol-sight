import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { type RouterState } from "../router";

// Breadcrumb that answers "which scope · which group · which view · which
// period" in one line. Renders directly under the sub-header so the user's
// orientation cost is paid once per page load, not on every glance.
const MARKET_LABELS: Record<string, string> = {
  market:   "시장 개요",
  weekly:   "주간 업데이트",
  insights: "인사이트",
};

const GROUP_LABELS: Record<string, string> = {
  content:   "그룹 상세",
  members:   "멤버 보기",
  community: "커뮤니티",
  risk:      "PR/리스크",
};

const GROUP_TABS_SET = new Set(Object.keys(GROUP_LABELS));

function periodLabel(p: number | null): string | null {
  if (p == null) return null;
  return `최근 ${p}일`;
}

export function Breadcrumb({ state }: { state: RouterState }) {
  const [groups, setGroups] = useState<Array<{ key: string; name: string; name_kr: string }>>([]);
  useEffect(() => { api.groups().then((r) => setGroups(r.groups)).catch(() => {}); }, []);

  const onGroup = GROUP_TABS_SET.has(state.tab);
  const crumbs: string[] = [];

  if (onGroup) {
    crumbs.push("그룹");
    const g = groups.find((x) => x.key === state.group);
    if (g) crumbs.push(`${g.name} · ${g.name_kr}`);
    else if (state.group) crumbs.push(state.group);
    else crumbs.push("미선택");
    crumbs.push(GROUP_LABELS[state.tab] ?? state.tab);
  } else {
    crumbs.push("시장");
    crumbs.push(MARKET_LABELS[state.tab] ?? state.tab);
  }

  const period = periodLabel(state.period);
  if (period && state.tab === "community") crumbs.push(period);

  return (
    <nav aria-label="현재 위치"
         class="mx-auto max-w-7xl px-4 pt-3 text-hint text-zinc-500">
      {crumbs.map((c, i) => (
        <span key={i}>
          {i > 0 && <span class="mx-1.5 text-zinc-700">▸</span>}
          <span class={i === crumbs.length - 1 ? "text-zinc-300" : ""}>{c}</span>
        </span>
      ))}
    </nav>
  );
}
