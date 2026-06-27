# 재설계 Phase 2 — 네비 셸(사이드바 + 탑바) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 평평한 top-tab Header를 **좌측 사이드바 IA(의도별 그룹 + MiiWAN 특권 존) + 슬림 탑바**로 교체한다. 기존 11개 뷰는 그대로 두고 새 네비로 라우팅만 바꾼다.

**Architecture:** 순수 네비 모델·활성판정을 `lib/nav.ts`로 분리(테스트 가능), `Sidebar`/`TopBar` 컴포넌트는 얇게(tsc 가드 — vitest `environment:"node"`라 렌더 테스트 없음). App.tsx 레이아웃을 `TopBar` + `flex(Sidebar + main)`로 재구성. 카테고리 컨텍스트를 위해 router에 `category` 파라미터 추가(K-POP/서브컬처 사이드바 항목이 MarketOverview 카테고리 필터를 구동).

**Tech Stack:** Preact + TypeScript, hash 라우터(`router.ts`), Tailwind(다크), vitest(`environment:"node"`).

## Global Constraints

- **점수·데이터·수집 불변**: UI/네비 한정. 백엔드·API·점수 변경 0.
- **기존 뷰 보존**: 11개 뷰(market/weekly/content/members/community/risk/growth/insights/miiwan/shorts/status)는 내용 변경 없이 새 네비에서 렌더. per-group 뷰의 master-detail(하위탭·그룹전환)은 **Phase 3**(이번 비범위) — 현재처럼 MarketOverview 카드로 진입 유지.
- **브랜드 토큰(Phase 1 도입분) 사용**: 자사 `own`(#75d7d1)/`market`(#ABE3E4) 토큰, `colorOf()` 그룹색. MiiWAN 특권 존은 `own` 액센트로 가시성있게.
- **카테고리 분리 하드 제약**: K-POP/서브컬처는 사이드바 구조로 분리(필터 토글 아님).
- **테스트 환경**: vitest `environment:"node"` — 순수 함수만 단위테스트, `.tsx`는 tsc 가드.
- **CI 그린**: 각 태스크 종료 시 `cd frontend && ./node_modules/.bin/vitest run` + `./node_modules/.bin/tsc --noEmit` 둘 다 통과(rtk 후크 회피 위해 bin 직접 호출).
- **반응형**: 데스크톱(≥md) 사이드바 상시 노출, 모바일(<md) 햄버거 토글 오버레이.

---

### Task 1: router에 `category` 파라미터 추가

**Files:**
- Modify: `frontend/src/router.ts`
- Test: `frontend/tests/lib/router.test.ts` (Create)

**Interfaces:**
- Produces: `RouterState.category: "all" | "kpop" | "subculture"` (default `"all"`). `readState()`/`writeState()`가 해시 `category=` 직렬화(기본 all은 생략).

- [ ] **Step 1: Write the failing test**

`frontend/tests/lib/router.test.ts`:

```typescript
import { describe, expect, it, beforeEach } from "vitest";
import { readState, writeState } from "../../src/router";

describe("router category param", () => {
  // vitest environment is "node" — no DOM. router.ts uses only location.hash
  // (get/set) + URLSearchParams, so a minimal mutable location shim suffices.
  beforeEach(() => { (globalThis as any).location = { hash: "" }; });

  it("defaults category to 'all'", () => {
    expect(readState().category).toBe("all");
  });

  it("round-trips a non-default category through the hash", () => {
    writeState({ tab: "market", category: "kpop" });
    expect(location.hash).toContain("category=kpop");
    expect(readState().category).toBe("kpop");
  });

  it("omits category from the hash when 'all' (default)", () => {
    writeState({ tab: "market", category: "all" });
    expect(location.hash).not.toContain("category=");
    expect(readState().category).toBe("all");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && ./node_modules/.bin/vitest run tests/lib/router.test.ts`
Expected: FAIL — `category` not on RouterState / undefined.

- [ ] **Step 3: Implement — edit `frontend/src/router.ts`**

In the `RouterState` interface, add `category` after `period`:
```typescript
  period: number | null;        // days; null = all
  category: "all" | "kpop" | "subculture";
  theme: "dark" | "light";
```
In `DEFAULT`:
```typescript
const DEFAULT: RouterState = {
  tab: "market", group: null, period: 7, category: "all", theme: "dark",
};
```
In `readState()` return object, add:
```typescript
    category: (params.get("category") as RouterState["category"]) || DEFAULT.category,
```
In `writeState()`, after the `period` serialization block and before the `theme` block, add:
```typescript
  if (next.category !== DEFAULT.category) params.set("category", next.category);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && ./node_modules/.bin/vitest run tests/lib/router.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/router.ts frontend/tests/lib/router.test.ts
git commit -m "feat(router): add category param (all|kpop|subculture) for sidebar cohort nav

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `lib/nav.ts` — 순수 네비 모델 + 활성 판정

**Files:**
- Create: `frontend/src/lib/nav.ts`
- Test: `frontend/tests/lib/nav.test.ts`

**Interfaces:**
- Consumes: `RouterState` from `../router` (Task 1 — has `tab` and `category`).
- Produces:
  - `interface NavItem { label: string; tab: RouterState["tab"]; category?: RouterState["category"] }`
  - `interface NavGroup { id: string; label: string; sub?: string; own?: boolean; items: NavItem[] }`
  - `const NAV_MODEL: NavGroup[]`
  - `function isItemActive(item: NavItem, state: Pick<RouterState,"tab"|"category">): boolean`

- [ ] **Step 1: Write the failing test**

`frontend/tests/lib/nav.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { NAV_MODEL, isItemActive, type NavItem } from "../../src/lib/nav";

const item = (p: Partial<NavItem> & { tab: any }): NavItem => ({ label: "x", ...p });

describe("NAV_MODEL", () => {
  it("has the five intent groups in order", () => {
    expect(NAV_MODEL.map((g) => g.id)).toEqual(["pulse", "cohort", "miiwan", "system"]);
  });
  it("marks the MiiWAN group as own (privileged)", () => {
    expect(NAV_MODEL.find((g) => g.id === "miiwan")!.own).toBe(true);
  });
  it("cohort group carries kpop + subculture market items", () => {
    const cats = NAV_MODEL.find((g) => g.id === "cohort")!.items.map((i) => i.category);
    expect(cats).toEqual(["kpop", "subculture"]);
  });
});

describe("isItemActive", () => {
  it("non-market item active iff tab matches", () => {
    expect(isItemActive(item({ tab: "insights" }), { tab: "insights", category: "all" })).toBe(true);
    expect(isItemActive(item({ tab: "insights" }), { tab: "weekly", category: "all" })).toBe(false);
  });
  it("market item active requires matching category", () => {
    const kpop = item({ tab: "market", category: "kpop" });
    expect(isItemActive(kpop, { tab: "market", category: "kpop" })).toBe(true);
    expect(isItemActive(kpop, { tab: "market", category: "all" })).toBe(false);
  });
  it("market overview (no category) active only at category 'all'", () => {
    const overview = item({ tab: "market" });
    expect(isItemActive(overview, { tab: "market", category: "all" })).toBe(true);
    expect(isItemActive(overview, { tab: "market", category: "subculture" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && ./node_modules/.bin/vitest run tests/lib/nav.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `frontend/src/lib/nav.ts`**

```typescript
import type { RouterState } from "../router";

// 사이드바 정보구조. 의도별 그룹(시장 펄스 / 코호트 / MiiWAN 자사 / 시스템).
// per-group 뷰(content/members/community/risk/growth)는 여기 없음 — Phase 3
// master-detail 엔티티 셸에서 진입(현재는 MarketOverview 카드 경유 유지).
export interface NavItem {
  label: string;
  tab: RouterState["tab"];
  category?: RouterState["category"]; // market 탭일 때 코호트 컨텍스트
}

export interface NavGroup {
  id: string;
  label: string;
  sub?: string;       // 작은 부제 (예: "모니터링", "Corporate")
  own?: boolean;      // 자사(MiiWAN) 특권 존 — own 액센트
  items: NavItem[];
}

export const NAV_MODEL: NavGroup[] = [
  { id: "pulse", label: "시장 펄스", sub: "모니터링", items: [
    { label: "시장 개요", tab: "market", category: "all" },
    { label: "주간 브리프", tab: "weekly" },
    { label: "인사이트", tab: "insights" },
    { label: "숏폼 트렌드", tab: "shorts" },
  ]},
  { id: "cohort", label: "코호트 비교", sub: "카테고리 분리", items: [
    { label: "K-POP (Corporate)", tab: "market", category: "kpop" },
    { label: "서브컬처 (V-튜버)", tab: "market", category: "subculture" },
  ]},
  { id: "miiwan", label: "MiiWAN", sub: "자사 · 1차 데이터", own: true, items: [
    { label: "개요 (심층분석)", tab: "miiwan" },
  ]},
  { id: "system", label: "시스템", items: [
    { label: "상태", tab: "status" },
  ]},
];

/** 사이드바 항목이 현재 뷰를 가리키는가. market 탭은 카테고리까지 일치해야 활성. */
export function isItemActive(
  item: NavItem,
  state: Pick<RouterState, "tab" | "category">,
): boolean {
  if (item.tab !== state.tab) return false;
  if (item.tab === "market") return (item.category ?? "all") === (state.category ?? "all");
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && ./node_modules/.bin/vitest run tests/lib/nav.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/nav.ts frontend/tests/lib/nav.test.ts
git commit -m "feat(nav): pure sidebar nav model + active detection

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `Sidebar.tsx` — 좌측 사이드바 (MiiWAN 특권 존)

**Files:**
- Create: `frontend/src/components/Sidebar.tsx`

**Interfaces:**
- Consumes: `NAV_MODEL`, `isItemActive` (`../lib/nav`); `writeState`, `RouterState` (`../router`).
- Produces: `export function Sidebar(props: { state: RouterState; onNavigate?: () => void }): JSX.Element` — `onNavigate` is called after a nav click (모바일에서 오버레이 닫기용).

- [ ] **Step 1: Implement `frontend/src/components/Sidebar.tsx`**

```tsx
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
        {group.label}{group.sub ? <span class="text-zinc-600"> · {group.sub}</span> : null}
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
      <div class="text-hint text-zinc-600 px-2 pt-4 leading-relaxed">
        색: <b class="text-own">자사 #75d7d1</b> · <b class="text-market">시장</b>
      </div>
    </nav>
  );
}
```

- [ ] **Step 2: Verify tsc**

Run: `cd frontend && ./node_modules/.bin/tsc --noEmit`
Expected: 0 errors. (렌더 테스트 없음 — 로직은 Task 2에서 검증.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/Sidebar.tsx
git commit -m "feat(ui): Sidebar — 의도별 그룹 IA + MiiWAN 자사 특권 존(#75d7d1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `TopBar.tsx` — 슬림 탑바(로고·관점·검색) + 검색 오픈 이벤트

**Files:**
- Create: `frontend/src/components/TopBar.tsx`
- Modify: `frontend/src/components/SearchPalette.tsx` (커스텀 오픈 이벤트 수신)

**Interfaces:**
- Consumes: `writeState` (`../router`).
- Produces: `export function TopBar(props: { onMenu?: () => void }): JSX.Element`. 검색 버튼은 `window.dispatchEvent(new CustomEvent("idolsight:search-open"))`. `SearchPalette`는 이 이벤트로도 열린다.

- [ ] **Step 1: Implement `frontend/src/components/TopBar.tsx`**

```tsx
import { writeState } from "../router";

export function TopBar({ onMenu }: { onMenu?: () => void }) {
  return (
    <header class="sticky top-0 z-20 flex h-12 items-center gap-3 border-b border-zinc-800 bg-surface/95 px-4 backdrop-blur">
      <button class="md:hidden rounded-ctrl border border-zinc-800 px-2 py-1 text-zinc-400"
              onClick={onMenu} aria-label="메뉴 열기">☰</button>
      <button class="font-bold tracking-tight" onClick={() => writeState({ tab: "market", category: "all" })}
              title="홈 (시장 개요)">idol-sight</button>
      <span class="hidden sm:inline text-hint text-zinc-500">시장 인텔리전스 · 3사 사내</span>
      <div class="ml-auto flex items-center gap-2 text-data">
        <span class="flex items-center gap-1.5 rounded-ctrl border px-2.5 py-1"
              style={{ borderColor: "rgba(117,215,209,0.4)", background: "rgba(117,215,209,0.06)" }}>
          <span class="inline-block h-2 w-2 rounded-full" style={{ background: "#75d7d1" }}></span>
          관점: <b class="text-own">MiiWAN</b>
        </span>
        <button class="rounded-ctrl border border-zinc-800 px-2 py-1 text-zinc-400 hover:bg-zinc-800/60"
                onClick={() => window.dispatchEvent(new CustomEvent("idolsight:search-open"))}
                title="검색 (⌘K)">🔍 <span class="hidden md:inline">검색</span></button>
      </div>
    </header>
  );
}
```

- [ ] **Step 2: Wire `SearchPalette` to also open on the custom event**

In `frontend/src/components/SearchPalette.tsx`, find the `useEffect` that registers the `keydown` Cmd/Ctrl+K handler. Add a sibling effect (or extend it) that opens the palette on the custom event. Add this effect right after the existing keydown effect:

```tsx
  useEffect(() => {
    const open = () => setOpen(true);
    window.addEventListener("idolsight:search-open", open);
    return () => window.removeEventListener("idolsight:search-open", open);
  }, []);
```

(`setOpen` is the palette's existing open-state setter — match its actual name; if the state setter is named differently, e.g. `setShow`, use that. Read the file first to confirm the setter name and that `useEffect` is imported.)

- [ ] **Step 3: Verify tsc**

Run: `cd frontend && ./node_modules/.bin/tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/TopBar.tsx frontend/src/components/SearchPalette.tsx
git commit -m "feat(ui): TopBar(로고·관점·검색) + SearchPalette 커스텀 오픈 이벤트

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: App 셸 통합 — TopBar + Sidebar 레이아웃, 모바일 토글, MarketOverview 카테고리 init

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/views/MarketOverview.tsx` (초기 카테고리를 router에서)

**Interfaces:**
- Consumes: `TopBar` (Task 4), `Sidebar` (Task 3), `RouterState.category` (Task 1).

- [ ] **Step 1: Restructure `frontend/src/App.tsx`**

Replace the `Header` import/usage with the new shell. New `App.tsx` body:

```tsx
import { useEffect, useState } from "preact/hooks";
import { TopBar } from "./components/TopBar";
import { Sidebar } from "./components/Sidebar";
import { Breadcrumb } from "./components/Breadcrumb";
import { LoginGate } from "./components/LoginGate";
import { applyTheme } from "./theme";
import { onStateChange, readState } from "./router";
import { api } from "./api";
import { MarketOverview } from "./views/MarketOverview";
import { WeeklyUpdate } from "./views/WeeklyUpdate";
import { GroupContent } from "./views/GroupContent";
import { Members } from "./views/Members";
import { Community } from "./views/Community";
import { PRRisk } from "./views/PRRisk";
import { GroupGrowth } from "./views/GroupGrowth";
import { Insights } from "./views/Insights";
import { MiiWANBriefing } from "./views/MiiWANBriefing";
import { ShortsTrend } from "./views/ShortsTrend";
import { SystemStatus } from "./views/SystemStatus";
import { SearchPalette } from "./components/SearchPalette";

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [state, setState] = useState(readState());
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => { applyTheme(); }, []);
  useEffect(() => onStateChange(setState), []);
  useEffect(() => {
    api.meta().then(() => setAuthed(true)).catch((e) => {
      if (String(e).includes("401")) setAuthed(false);
      else setAuthed(true);
    });
  }, []);

  if (authed === null) return <div class="p-8 text-zinc-500">Loading…</div>;
  if (authed === false) return <LoginGate />;

  return (
    <div class="min-h-screen">
      <TopBar onMenu={() => setNavOpen(true)} />
      <SearchPalette />
      <div class="flex">
        {/* desktop sidebar */}
        <aside class="hidden md:block shrink-0 border-r border-zinc-800 min-h-[calc(100vh-3rem)] sticky top-12 self-start">
          <Sidebar state={state} />
        </aside>
        {/* mobile overlay sidebar */}
        {navOpen && (
          <div class="md:hidden fixed inset-0 z-30 flex" onClick={() => setNavOpen(false)}>
            <div class="absolute inset-0 bg-black/50"></div>
            <aside class="relative z-10 bg-surface border-r border-zinc-800 min-h-screen" onClick={(e) => e.stopPropagation()}>
              <Sidebar state={state} onNavigate={() => setNavOpen(false)} />
            </aside>
          </div>
        )}
        <main class="flex-1 min-w-0 p-4">
          <Breadcrumb state={state} />
          {state.tab === "market"    && <MarketOverview />}
          {state.tab === "weekly"    && <WeeklyUpdate />}
          {state.tab === "content"   && <GroupContent groupKey={state.group} />}
          {state.tab === "members"   && <Members groupKey={state.group} />}
          {state.tab === "community" && <Community groupKey={state.group} period={state.period} />}
          {state.tab === "risk"      && <PRRisk groupKey={state.group} />}
          {state.tab === "growth"    && <GroupGrowth groupKey={state.group} />}
          {state.tab === "insights"  && <Insights />}
          {state.tab === "miiwan"    && <MiiWANBriefing />}
          {state.tab === "shorts"    && <ShortsTrend />}
          {state.tab === "status"    && <SystemStatus />}
        </main>
      </div>
    </div>
  );
}
```

(Note: the old `Header` import and `<main class="mx-auto max-w-7xl p-4">` wrapper are removed. `Breadcrumb` now lives inside `main`.)

- [ ] **Step 2: MarketOverview reads initial category from router**

In `frontend/src/views/MarketOverview.tsx`, find `const [activeCategory, setActiveCategory] = useState<...>("all")` (or wherever `activeCategory` is initialized). Change the initializer to read the router:
- Add at top of the component (after other state): import `readState` from `../router` if not already imported, then initialize:
```typescript
  const [activeCategory, setActiveCategory] = useState<"all" | "kpop" | "subculture">(readState().category);
```
- Add an effect so navigating via the sidebar (which sets `category`) updates the view without a remount:
```typescript
  useEffect(() => onStateChange((s) => setActiveCategory(s.category)), []);
```
(Import `onStateChange` alongside `readState` from `../router`. If `useEffect` isn't imported, add it. Read the file first to confirm the exact `activeCategory` declaration and existing imports — match them; do not duplicate imports.)

- [ ] **Step 3: Verify tsc + full suite**

Run: `cd frontend && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run`
Expected: 0 type errors, all tests pass (existing 322 + new router/nav tests). The old `Header.tsx` is now unused — that's fine (leave the file; do not delete in this task). `MarketOverview.test.ts` must still pass.

- [ ] **Step 4: Manual sanity (describe, no automated render)**

Confirm by reading the diff: (a) every `state.tab` view is still rendered in the new `main`; (b) sidebar nav buttons call `writeState` with tab+category; (c) `category` from K-POP/서브컬처 items flows to `MarketOverview` activeCategory; (d) mobile overlay closes on backdrop click and on nav.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.tsx frontend/src/views/MarketOverview.tsx
git commit -m "feat(ui): App 셸을 사이드바+탑바로 재구성, MarketOverview 카테고리 router 연동

평평 top-tab Header → 좌측 사이드바 IA + 슬림 탑바. 기존 11뷰 보존, 모바일 햄버거
오버레이. K-POP/서브컬처 사이드바 항목이 router category로 MarketOverview 필터 구동.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage** (vs 제안서 §3 IA + 프로토타입):
- 사이드바 의도그룹(시장 펄스/코호트/MiiWAN/시스템) → Task 2 NAV_MODEL + Task 3 Sidebar. ✅
- MiiWAN 특권 존(own #75d7d1) → Task 3 Group own 분기. ✅
- 탑바(로고·관점·검색) → Task 4. ✅
- 카테고리 구조 분리(필터 토글 아님) → Task 1 router category + Task 2 cohort items + Task 5 MarketOverview 연동. ✅
- 기존 뷰 보존·라우팅만 교체 → Task 5 App 셸. ✅
- 반응형(데스크톱 상시/모바일 토글) → Task 5. ✅
- per-group master-detail = Phase 3(비범위) — 명시. ✅

**2. Placeholder scan:** TBD/TODO 없음. 컴포넌트 코드 전량 포함. Task 4 Step 2·Task 5 Step 2는 "파일 먼저 읽어 setter/선언명 확인" 지시(실제 식별자 의존) — 구체 코드와 확인 절차 동반. ✅

**3. Type consistency:** `RouterState.category`(Task 1) ↔ `NavItem.category`(Task 2) ↔ Sidebar/TopBar writeState(Task 3/4) ↔ MarketOverview activeCategory(Task 5) 동일 리터럴 유니온 `"all"|"kpop"|"subculture"`. `isItemActive`/`NAV_MODEL` 시그니처 Task 2 정의와 Task 3 소비 일치. `Sidebar({state,onNavigate})`/`TopBar({onMenu})` Task 3/4 정의와 Task 5 사용 일치. ✅

**참고:** `growth` 고아 라우트는 Phase 2에서 사이드바 미포함(Phase 3 엔티티 셸에서 편입). per-group 뷰는 현행 카드 진입 유지. 구 `Header.tsx`는 미사용으로 남김(Phase 3에서 제거/재활용).
