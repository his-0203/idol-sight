# IDOL-SIGHT Frontend UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the 7-tab BI dashboard at `https://idol-sight.pages.dev` — Market Overview / Weekly / Group Content / Members / Community / PR&Risk / Insights — that consumes Plan 1+2+3's D1 schema.

**Architecture:** Pages Functions expose `/api/*` JSON endpoints reading D1 directly. SPA (Vite + Preact + Tailwind) renders tabs lazily, with shared components for freshness badges, KPI cards, exports, share links, health-spec modal, and source_refs back-links. Charts use Chart.js v4 (already in deps). All data flows through `/api/*` (auth gated) — no embedded data.

**Tech Stack:** TypeScript, Preact 10, Vite 5, Tailwind 3.4, Chart.js 4, vitest 2, Cloudflare Pages Functions + D1.

**Spec reference:** `docs/superpowers/specs/2026-05-04-idol-sight-rebuild-design.md` §5 (data), §7 (analysis), §8 (frontend).

**Predecessor plans:** Plan 1·2·3 (53+ commits already merged to main).

---

## File Structure

Files added/modified (frontend-only — worker is untouched):

```
frontend/
├── functions/
│   ├── _middleware.ts              # MODIFY — pass D1 binding env
│   ├── lib/
│   │   ├── d1.ts                   # NEW — D1 binding wrapper for Functions
│   │   └── jsonResponse.ts         # NEW — Response helper
│   └── api/
│       ├── meta.ts                 # NEW — /api/meta
│       ├── groups.ts               # NEW — /api/groups
│       ├── group/[key].ts          # NEW — /api/group/:key
│       ├── market.ts               # NEW — /api/market
│       ├── market-share.ts         # NEW — /api/market-share
│       ├── weekly.ts               # NEW — /api/weekly
│       ├── insights.ts             # NEW — /api/insights
│       ├── members/[key].ts        # NEW — /api/members/:key
│       ├── search.ts               # NEW — /api/search
│       └── health/spec.ts          # NEW — /api/health/spec
├── src/
│   ├── main.ts                     # REWRITE — SPA entry
│   ├── router.ts                   # NEW — URL state (#tab=…&group=…)
│   ├── api.ts                      # NEW — typed fetch wrapper
│   ├── theme.ts                    # NEW — dark/light toggle
│   ├── format.ts                   # NEW — fmt(n), pct, deltaBadge
│   ├── views/
│   │   ├── MarketOverview.tsx      # NEW
│   │   ├── WeeklyUpdate.tsx        # NEW
│   │   ├── GroupContent.tsx        # NEW
│   │   ├── Members.tsx             # NEW
│   │   ├── Community.tsx           # NEW
│   │   ├── PRRisk.tsx              # NEW
│   │   └── Insights.tsx            # NEW
│   ├── components/
│   │   ├── FreshnessBadge.tsx      # NEW
│   │   ├── KPI.tsx                 # NEW
│   │   ├── ExportMenu.tsx          # NEW
│   │   ├── ShareLink.tsx           # NEW
│   │   ├── HealthSpec.tsx          # NEW
│   │   ├── SourceRef.tsx           # NEW
│   │   ├── Header.tsx              # NEW
│   │   └── LoginGate.tsx           # NEW
│   └── styles.css                  # MODIFY — light/dark vars
├── index.html                      # MODIFY — Chart.js + Preact mount
└── tests/functions/
    ├── api_meta.test.ts            # NEW
    ├── api_groups.test.ts          # NEW
    ├── api_group.test.ts           # NEW
    ├── api_market.test.ts          # NEW
    └── api_search.test.ts          # NEW
```

**File responsibility:**
- Each `/api/*` file is one endpoint, one query, one shape — minimal logic.
- `functions/lib/d1.ts` is the only place that knows the `env.DB` binding shape.
- Each `views/<Name>.tsx` is one tab — fetches its own data on mount, no shared state.
- Components are pure presentation; data lives in views.

---

## Conventions

- All commands run from the worktree root unless noted. Frontend commands run from `frontend/`.
- pnpm via `npx -y pnpm` (no global pnpm assumed) — the same pattern Plan 1's CI uses.
- Tests use `vitest` with `Adaptor`/`Request`/`Response` (Pages Functions are Web-standard).
- One focused commit per task. `git -c user.email=heesoo0203@gmail.com -c user.name=user commit -m "..."` if needed.
- Frontend Pages Functions get D1 via `env.DB` (the binding name in `wrangler.toml`).
- All `/api/*` endpoints return `application/json` and assume auth middleware already passed.

---

## Task 1: D1 binding wrapper + JSON response helper

**Files:**
- Create: `frontend/functions/lib/d1.ts`
- Create: `frontend/functions/lib/jsonResponse.ts`
- Create: `frontend/tests/functions/lib_d1.test.ts`

> **Why:** Pages Functions get D1 as `env.DB` (a `D1Database` runtime object). All endpoints want the same `query/queryOne` ergonomics. Centralise here so endpoint files stay thin.

- [ ] **Step 1: Write the test**

`frontend/tests/functions/lib_d1.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { d1Query, d1QueryOne } from "../../functions/lib/d1";
import { jsonResponse } from "../../functions/lib/jsonResponse";

function fakeDb(rows: any[]) {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    all: vi.fn(async () => ({ results: rows })),
    first: vi.fn(async () => rows[0] ?? null),
  };
  return { prepare: vi.fn(() => stmt), _stmt: stmt } as any;
}

describe("d1 wrappers", () => {
  it("d1Query binds params and returns rows", async () => {
    const db = fakeDb([{ a: 1 }, { a: 2 }]);
    const rows = await d1Query<{ a: number }>(db, "SELECT a FROM t WHERE x=?", ["x"]);
    expect(rows).toEqual([{ a: 1 }, { a: 2 }]);
    expect(db.prepare).toHaveBeenCalledWith("SELECT a FROM t WHERE x=?");
    expect(db._stmt.bind).toHaveBeenCalledWith("x");
  });

  it("d1QueryOne returns first row or null", async () => {
    const db = fakeDb([{ a: 7 }]);
    expect(await d1QueryOne(db, "SELECT 1")).toEqual({ a: 7 });
    const empty = fakeDb([]);
    expect(await d1QueryOne(empty, "SELECT 1")).toBeNull();
  });
});

describe("jsonResponse", () => {
  it("returns 200 application/json", async () => {
    const r = jsonResponse({ ok: 1 });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(await r.json()).toEqual({ ok: 1 });
  });

  it("respects status override", () => {
    expect(jsonResponse({ x: 1 }, 404).status).toBe(404);
  });

  it("sets Cache-Control: no-store by default", () => {
    expect(jsonResponse({}).headers.get("cache-control")).toBe("no-store");
  });
});
```

- [ ] **Step 2: Run, see FAIL**

```bash
cd frontend
npx -y pnpm test
```

- [ ] **Step 3: Implement `functions/lib/d1.ts`**

```ts
// Cloudflare D1 binding type — matches @cloudflare/workers-types.
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
}
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = unknown>(): Promise<{ results: T[] }>;
  first<T = unknown>(): Promise<T | null>;
}

export async function d1Query<T = Record<string, unknown>>(
  db: D1Database,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const stmt = db.prepare(sql);
  const bound = params.length ? stmt.bind(...params) : stmt;
  const r = await bound.all<T>();
  return r.results ?? [];
}

export async function d1QueryOne<T = Record<string, unknown>>(
  db: D1Database,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const stmt = db.prepare(sql);
  const bound = params.length ? stmt.bind(...params) : stmt;
  return (await bound.first<T>()) ?? null;
}
```

- [ ] **Step 4: Implement `functions/lib/jsonResponse.ts`**

```ts
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
```

- [ ] **Step 5: Run tests → PASS**

```bash
cd frontend && npx -y pnpm test -- tests/functions/lib_d1.test.ts
```

Expected: 5 PASSED.

- [ ] **Step 6: Commit**

```bash
git add frontend/functions/lib/d1.ts frontend/functions/lib/jsonResponse.ts \
        frontend/tests/functions/lib_d1.test.ts
git commit -m "feat(frontend): D1 query wrappers + jsonResponse helper for Pages Functions"
```

---

## Task 2: `/api/meta` — freshness audit

**Files:**
- Create: `frontend/functions/api/meta.ts`
- Create: `frontend/tests/functions/api_meta.test.ts`

> **Output:** all jobs in `crawl_meta` so the SPA can render freshness badges (fresh / stale / broken).

```json
{
  "global_last_success_at": "2026-05-04T14:30:00Z",
  "by_job": [
    {"job":"naver:plave","last_success_at":"...","expected_interval_h":1,"status":"ok",
     "error_msg":null}
  ]
}
```

- [ ] **Step 1: Test**

`frontend/tests/functions/api_meta.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { onRequestGet } from "../../functions/api/meta";

function envWithRows(rows: any[]) {
  const stmt = { bind: vi.fn().mockReturnThis(), all: vi.fn(async () => ({ results: rows })) };
  return { DB: { prepare: vi.fn(() => stmt) } } as any;
}

describe("/api/meta", () => {
  it("returns by_job + global_last_success_at", async () => {
    const env = envWithRows([
      { job: "naver:plave", last_success_at: "2026-05-04T14:00:00Z",
        expected_interval_h: 1, status: "ok", error_msg: null },
      { job: "dc:bdawn", last_success_at: "2026-05-04T08:00:00Z",
        expected_interval_h: 6, status: "failed", error_msg: "cf 403" },
    ]);
    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.by_job).toHaveLength(2);
    expect(body.global_last_success_at).toBe("2026-05-04T14:00:00Z");   // newest
  });

  it("global_last_success_at is null when no rows", async () => {
    const env = envWithRows([]);
    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    const body = await res.json();
    expect(body.by_job).toEqual([]);
    expect(body.global_last_success_at).toBeNull();
  });
});
```

- [ ] **Step 2: Run, FAIL**

```bash
cd frontend && npx -y pnpm test -- tests/functions/api_meta.test.ts
```

- [ ] **Step 3: Implement**

`frontend/functions/api/meta.ts`:

```ts
import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";

interface CrawlMetaRow {
  job: string;
  last_success_at: string | null;
  expected_interval_h: number | null;
  status: string | null;
  error_msg: string | null;
}

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env }) => {
  const rows = await d1Query<CrawlMetaRow>(
    env.DB,
    "SELECT job, last_success_at, expected_interval_h, status, error_msg "
    + "FROM crawl_meta ORDER BY job",
  );
  const newest = rows
    .map((r) => r.last_success_at)
    .filter((s): s is string => Boolean(s))
    .sort()
    .pop() ?? null;
  return jsonResponse({ global_last_success_at: newest, by_job: rows });
};
```

- [ ] **Step 4: Test PASS**

```bash
cd frontend && npx -y pnpm test -- tests/functions/api_meta.test.ts
```

Expected: 2 PASSED.

- [ ] **Step 5: Commit**

```bash
git add frontend/functions/api/meta.ts frontend/tests/functions/api_meta.test.ts
git commit -m "feat(frontend): /api/meta returns crawl_meta freshness data"
```

---

## Task 3: `/api/groups` — list active groups

**Files:**
- Create: `frontend/functions/api/groups.ts`
- Create: `frontend/tests/functions/api_groups.test.ts`

- [ ] **Step 1: Test**

```ts
// frontend/tests/functions/api_groups.test.ts
import { describe, expect, it, vi } from "vitest";
import { onRequestGet } from "../../functions/api/groups";

const envWith = (rows: any[]) => ({
  DB: { prepare: vi.fn(() => ({ bind: vi.fn().mockReturnThis(),
                                 all: vi.fn(async () => ({ results: rows })) })) },
} as any);

describe("/api/groups", () => {
  it("returns active groups with parsed lists", async () => {
    const env = envWith([
      { key: "plave", name: "PLAVE", name_kr: "플레이브",
        debut_date: "2023-03-12", yt_channel_id: "UC...", dc_gallery_id: "plave",
        context_keywords: '["플레이브","PLAVE"]', is_active: 1, has_data: 1 },
    ]);
    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    const body = await res.json();
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].context_keywords).toEqual(["플레이브", "PLAVE"]);
    expect(body.groups[0].has_data).toBe(true);
  });
});
```

- [ ] **Step 2: Run, FAIL**

```bash
cd frontend && npx -y pnpm test -- tests/functions/api_groups.test.ts
```

- [ ] **Step 3: Implement**

`frontend/functions/api/groups.ts`:

```ts
import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";

interface GroupRow {
  key: string;
  name: string;
  name_kr: string;
  debut_date: string | null;
  yt_channel_id: string | null;
  dc_gallery_id: string | null;
  context_keywords: string | null;
  is_active: number;
  has_data: number;
}

function parseList(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch { return []; }
}

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env }) => {
  const rows = await d1Query<GroupRow>(
    env.DB,
    `SELECT g.key, g.name, g.name_kr, g.debut_date, g.yt_channel_id,
            g.dc_gallery_id, g.context_keywords, g.is_active,
            CASE WHEN EXISTS (
              SELECT 1 FROM agg_summary s WHERE s.group_key = g.key
            ) THEN 1 ELSE 0 END AS has_data
       FROM groups g
      WHERE g.is_active = 1
      ORDER BY g.key`,
  );
  return jsonResponse({
    groups: rows.map((r) => ({
      key: r.key, name: r.name, name_kr: r.name_kr,
      debut_date: r.debut_date,
      yt_channel_id: r.yt_channel_id,
      dc_gallery_id: r.dc_gallery_id,
      context_keywords: parseList(r.context_keywords),
      has_data: r.has_data === 1,
    })),
  });
};
```

- [ ] **Step 4: Test PASS**

```bash
cd frontend && npx -y pnpm test -- tests/functions/api_groups.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add frontend/functions/api/groups.ts frontend/tests/functions/api_groups.test.ts
git commit -m "feat(frontend): /api/groups lists active groups with has_data flag"
```

---

## Task 4: `/api/market` — Market Overview cards + chart datasets

**Files:**
- Create: `frontend/functions/api/market.ts`
- Create: `frontend/tests/functions/api_market.test.ts`

> **Output:** one record per active group with summary, latest health score, and IDs needed by chart components on the frontend.

```json
{
  "generated_at": "2026-05-04T14:30:00Z",
  "groups": {
    "plave": {
      "name": "PLAVE", "name_kr": "플레이브",
      "summary": {"yt_total_views": 160000000, "dc_total_posts": 89663, ...},
      "health_score": {"total": 9.5, "grade": "S", "label": "...",
                        "breakdown": {...}, "bonus": {...}}
    }
  },
  "market_insights": [{...from insights table where scope='market'...}]
}
```

- [ ] **Step 1: Test**

```ts
// frontend/tests/functions/api_market.test.ts
import { describe, expect, it, vi } from "vitest";
import { onRequestGet } from "../../functions/api/market";

const envWith = (handler: (sql: string) => any[]) => ({
  DB: { prepare: vi.fn((sql: string) => ({
    bind: vi.fn().mockReturnThis(),
    all: vi.fn(async () => ({ results: handler(sql) })),
    first: vi.fn(async () => handler(sql)[0] ?? null),
  })) },
} as any);

describe("/api/market", () => {
  it("aggregates groups with latest health + summary + insights", async () => {
    const env = envWith((sql) => {
      if (sql.includes("FROM groups")) {
        return [{ key: "plave", name: "PLAVE", name_kr: "플레이브" }];
      }
      if (sql.includes("FROM agg_summary")) {
        return [{ group_key: "plave", snapshot_at: "2026-05-04T14:00:00Z",
                  yt_total_views: 1, dc_total_posts: 2, theqoo_posts: 3,
                  instiz_posts: 4, naver_total_news: 5, twitter_posts: 6,
                  controversy_count: 0, yt_total_videos: 7, yt_subscribers: 8 }];
      }
      if (sql.includes("FROM agg_health_scores")) {
        return [{ group_key: "plave", snapshot_at: "x", total: 9.5, grade: "S",
                  label: "정상 궤도", breakdown_json: '{"subscribers":20}',
                  bonus_json: '{}', quality_method: "top10_avg" }];
      }
      if (sql.includes("FROM insights")) {
        return [{ id: 1, title: "T", body: "B", scope: "market", type: "insight",
                  source_refs_json: "[]", generated_at: "..." }];
      }
      return [];
    });
    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    const body = await res.json();
    expect(body.groups.plave.health_score.total).toBe(9.5);
    expect(body.groups.plave.health_score.breakdown).toEqual({ subscribers: 20 });
    expect(body.market_insights).toHaveLength(1);
  });

  it("returns null health for groups without scores", async () => {
    const env = envWith((sql) => {
      if (sql.includes("FROM groups"))
        return [{ key: "miiwan", name: "MiiWAN", name_kr: "미완소년" }];
      if (sql.includes("FROM agg_summary"))
        return [{ group_key: "miiwan", snapshot_at: "x", yt_total_views: 0,
                  dc_total_posts: 0, theqoo_posts: 0, instiz_posts: 0,
                  naver_total_news: 0, twitter_posts: 0, controversy_count: 0,
                  yt_total_videos: 0, yt_subscribers: 0 }];
      return [];
    });
    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    const body = await res.json();
    expect(body.groups.miiwan.health_score).toBeNull();
  });
});
```

- [ ] **Step 2: Run, FAIL**

```bash
cd frontend && npx -y pnpm test -- tests/functions/api_market.test.ts
```

- [ ] **Step 3: Implement**

`frontend/functions/api/market.ts`:

```ts
import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";

interface GroupRow { key: string; name: string; name_kr: string; debut_date: string | null }

interface SummaryRow {
  group_key: string; snapshot_at: string;
  yt_total_videos: number; yt_total_views: number; yt_subscribers: number;
  dc_total_posts: number; theqoo_posts: number; instiz_posts: number;
  naver_total_news: number; twitter_posts: number; controversy_count: number;
}

interface HealthRow {
  group_key: string; snapshot_at: string; total: number | null; grade: string;
  label: string | null; breakdown_json: string | null; bonus_json: string | null;
  quality_method: string | null;
}

interface InsightRow {
  id: number; title: string; body: string; scope: string; type: string;
  source_refs_json: string | null; generated_at: string;
}

const safeJson = (s: string | null) => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env }) => {
  const groups = await d1Query<GroupRow>(env.DB,
    "SELECT key, name, name_kr, debut_date FROM groups WHERE is_active=1 ORDER BY key");

  const sums = await d1Query<SummaryRow>(env.DB,
    `SELECT * FROM agg_summary
      WHERE snapshot_at = (SELECT MAX(snapshot_at) FROM agg_summary)`);

  const healths = await d1Query<HealthRow>(env.DB,
    `SELECT * FROM agg_health_scores
      WHERE snapshot_at = (SELECT MAX(snapshot_at) FROM agg_health_scores)`);

  const insights = await d1Query<InsightRow>(env.DB,
    `SELECT id, title, body, scope, type, source_refs_json, generated_at
       FROM insights
      WHERE scope='market' OR type='ipx_action'
      ORDER BY generated_at DESC LIMIT 30`);

  const sumByKey: Record<string, SummaryRow> = {};
  for (const s of sums) sumByKey[s.group_key] = s;
  const healthByKey: Record<string, HealthRow> = {};
  for (const h of healths) healthByKey[h.group_key] = h;

  const out: Record<string, unknown> = {};
  for (const g of groups) {
    const s = sumByKey[g.key];
    const h = healthByKey[g.key];
    out[g.key] = {
      name: g.name, name_kr: g.name_kr, debut_date: g.debut_date,
      summary: s ? {
        yt_total_videos: s.yt_total_videos, yt_total_views: s.yt_total_views,
        yt_subscribers: s.yt_subscribers,
        dc_total_posts: s.dc_total_posts, theqoo_posts: s.theqoo_posts,
        instiz_posts: s.instiz_posts, naver_total_news: s.naver_total_news,
        twitter_posts: s.twitter_posts, controversy_count: s.controversy_count,
      } : null,
      health_score: h ? {
        total: h.total, grade: h.grade, label: h.label,
        breakdown: safeJson(h.breakdown_json),
        bonus: safeJson(h.bonus_json),
        quality_method: h.quality_method,
      } : null,
    };
  }

  return jsonResponse({
    generated_at: sums[0]?.snapshot_at ?? null,
    groups: out,
    market_insights: insights.map((i) => ({
      id: i.id, title: i.title, body: i.body, scope: i.scope, type: i.type,
      source_refs: (() => { try { return JSON.parse(i.source_refs_json ?? "[]"); }
                            catch { return []; } })(),
      generated_at: i.generated_at,
    })),
  });
};
```

- [ ] **Step 4: Test PASS**

```bash
cd frontend && npx -y pnpm test -- tests/functions/api_market.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add frontend/functions/api/market.ts frontend/tests/functions/api_market.test.ts
git commit -m "feat(frontend): /api/market returns groups+health+market insights"
```

---

## Task 5: `/api/group/[key]` — full group dashboard

**Files:**
- Create: `frontend/functions/api/group/[key].ts`
- Create: `frontend/tests/functions/api_group.test.ts`

> Returns one group's full payload: summary + deltas + health + yt videos top + community top + naver articles + twitter posts. Used by GroupContent / Members / Community / PRRisk tabs.

- [ ] **Step 1: Test**

```ts
// frontend/tests/functions/api_group.test.ts
import { describe, expect, it, vi } from "vitest";
import { onRequestGet } from "../../functions/api/group/[key]";

const envWith = (h: (sql: string) => any[]) => ({
  DB: { prepare: vi.fn((sql: string) => ({
    bind: vi.fn().mockReturnThis(),
    all: vi.fn(async () => ({ results: h(sql) })),
    first: vi.fn(async () => h(sql)[0] ?? null),
  })) },
} as any);

describe("/api/group/[key]", () => {
  it("returns 404 when group does not exist", async () => {
    const env = envWith(() => []);
    const res = await onRequestGet({
      env, request: new Request("https://x/api/group/nope"),
      params: { key: "nope" },
    } as any);
    expect(res.status).toBe(404);
  });

  it("returns full group payload", async () => {
    const env = envWith((sql) => {
      if (sql.includes("FROM groups WHERE key")) {
        return [{ key: "plave", name: "PLAVE", name_kr: "플레이브",
                  debut_date: "2023-03-12" }];
      }
      if (sql.includes("FROM agg_summary")) {
        return [{ group_key: "plave", snapshot_at: "2026-05-04T14:00:00Z",
                  yt_total_views: 100, dc_total_posts: 50, theqoo_posts: 0,
                  instiz_posts: 0, naver_total_news: 5, twitter_posts: 1,
                  controversy_count: 0, yt_total_videos: 24, yt_subscribers: 999 }];
      }
      if (sql.includes("FROM agg_health_scores")) {
        return [{ total: 9.0, grade: "A", label: "안정적",
                  breakdown_json: "{}", bonus_json: "{}",
                  quality_method: "top10_avg" }];
      }
      if (sql.includes("FROM youtube_videos")) {
        return [{ video_id: "v1", title: "MV", published_at: "2026-04-13",
                  content_type: "MV", views: 1000000, likes: 50000,
                  comments: 5000 }];
      }
      if (sql.includes("FROM community_posts")) {
        return [{ url: "u1", title: "t1", platform: "dc", posted_at: "2026-05-04",
                  views: 100, likes: 10, comments: 5 }];
      }
      if (sql.includes("FROM naver_articles")) {
        return [{ title: "n1", url: "u", source: "Naver", published_at: "2026-05-04" }];
      }
      if (sql.includes("FROM twitter_posts")) {
        return [{ tweet_id: "t1", title: "tw", author_handle: "x",
                  url: "u", posted_at: "2026-05-04", type: "content" }];
      }
      return [];
    });
    const res = await onRequestGet({
      env, request: new Request("https://x/api/group/plave"),
      params: { key: "plave" },
    } as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.group_key).toBe("plave");
    expect(body.summary.yt_total_views).toBe(100);
    expect(body.health_score.grade).toBe("A");
    expect(body.yt_top15).toHaveLength(1);
    expect(body.community_top).toHaveLength(1);
    expect(body.naver_articles).toHaveLength(1);
    expect(body.twitter_posts).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run, FAIL**

```bash
cd frontend && npx -y pnpm test -- tests/functions/api_group.test.ts
```

- [ ] **Step 3: Implement**

`frontend/functions/api/group/[key].ts`:

```ts
import { d1Query, d1QueryOne, type D1Database } from "../../lib/d1";
import { jsonResponse } from "../../lib/jsonResponse";

const safeJson = (s: string | null) => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env, params }) => {
  const key = String(params.key);

  const group = await d1QueryOne<{
    key: string; name: string; name_kr: string; debut_date: string | null;
  }>(env.DB,
    "SELECT key, name, name_kr, debut_date FROM groups WHERE key=? AND is_active=1",
    [key]);
  if (!group) return jsonResponse({ error: "not_found" }, 404);

  const summary = await d1QueryOne<any>(env.DB,
    `SELECT * FROM agg_summary
      WHERE group_key=? AND snapshot_at=(
        SELECT MAX(snapshot_at) FROM agg_summary WHERE group_key=?
      )`, [key, key]);

  const health = await d1QueryOne<any>(env.DB,
    `SELECT total, grade, label, breakdown_json, bonus_json, quality_method
       FROM agg_health_scores
      WHERE group_key=? AND snapshot_at=(
        SELECT MAX(snapshot_at) FROM agg_health_scores WHERE group_key=?
      )`, [key, key]);

  const ytTop = await d1Query<any>(env.DB,
    `SELECT v.video_id, v.title, v.published_at, v.content_type, v.is_short,
            COALESCE(s.views,0) AS views,
            COALESCE(s.likes,0) AS likes,
            COALESCE(s.comments,0) AS comments
       FROM youtube_videos v
       LEFT JOIN youtube_video_stats s ON s.video_id = v.video_id
        AND s.snapshot_at = (SELECT MAX(snapshot_at) FROM youtube_video_stats
                               WHERE video_id = v.video_id)
      WHERE v.group_key = ?
      ORDER BY views DESC LIMIT 15`, [key]);

  const commTop = await d1Query<any>(env.DB,
    `SELECT cp.url, cp.title, cp.platform, cp.posted_at,
            COALESCE(cps.views,0) AS views,
            COALESCE(cps.likes,0) AS likes,
            COALESCE(cps.comments,0) AS comments
       FROM community_posts cp
       LEFT JOIN community_post_stats cps ON cps.url_hash = cp.url_hash
        AND cps.snapshot_at = (SELECT MAX(snapshot_at) FROM community_post_stats
                                 WHERE url_hash = cp.url_hash)
      WHERE cp.group_key = ?
      ORDER BY views DESC LIMIT 30`, [key]);

  const naver = await d1Query<any>(env.DB,
    `SELECT title, url, source, published_at FROM naver_articles
      WHERE group_key=? AND COALESCE(is_excluded,0)=0
      ORDER BY published_at DESC LIMIT 30`, [key]);

  const tweets = await d1Query<any>(env.DB,
    `SELECT tweet_id, title, author_handle, url, posted_at, type
       FROM twitter_posts WHERE group_key=?
      ORDER BY posted_at DESC LIMIT 30`, [key]);

  return jsonResponse({
    group_key: group.key,
    name: group.name, name_kr: group.name_kr, debut_date: group.debut_date,
    summary,
    health_score: health ? {
      total: health.total, grade: health.grade, label: health.label,
      breakdown: safeJson(health.breakdown_json),
      bonus: safeJson(health.bonus_json),
      quality_method: health.quality_method,
    } : null,
    yt_top15: ytTop,
    community_top: commTop,
    naver_articles: naver,
    twitter_posts: tweets,
  });
};
```

- [ ] **Step 4: Test PASS**

```bash
cd frontend && npx -y pnpm test -- tests/functions/api_group.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add frontend/functions/api/group/[key].ts frontend/tests/functions/api_group.test.ts
git commit -m "feat(frontend): /api/group/:key returns full per-group dashboard payload"
```

---

## Task 6: Remaining endpoints — `/api/market-share`, `/api/weekly`, `/api/insights`, `/api/members/[key]`, `/api/health/spec`

**Files (create all):**
- `frontend/functions/api/market-share.ts`
- `frontend/functions/api/weekly.ts`
- `frontend/functions/api/insights.ts`
- `frontend/functions/api/members/[key].ts`
- `frontend/functions/api/health/spec.ts`

> These are simpler than `/api/market` — each one query, no joins. Single-test sanity check per endpoint.

- [ ] **Step 1: Implement all 5 (no separate failing tests; covered by smoke at Task 8)**

`frontend/functions/api/market-share.ts`:

```ts
import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";

interface ShareRow {
  week_start: string; week_end: string; group_key: string;
  cum: number; mom: number; final: number; market_total: number;
}

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env, request }) => {
  const url = new URL(request.url);
  const weeks = Math.min(Math.max(parseInt(url.searchParams.get("weeks") ?? "13", 10), 1), 26);
  const rows = await d1Query<ShareRow>(env.DB,
    `SELECT * FROM agg_market_share
      WHERE week_end >= date('now', ?)
      ORDER BY week_start ASC, group_key ASC`,
    [`-${weeks * 7} days`]);
  return jsonResponse({ weeks, rows });
};
```

`frontend/functions/api/weekly.ts`:

```ts
import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env }) => {
  const insights = await d1Query<any>(env.DB,
    `SELECT id, week_start, scope, type, title, body, source_refs_json, generated_at
       FROM insights
      WHERE type='weekly'
      ORDER BY generated_at DESC LIMIT 20`);
  const hanteo = await d1Query<any>(env.DB,
    `SELECT week_start, week_end, group_key, album, rank, sales, note
       FROM hanteo_weekly
      WHERE week_end = (SELECT MAX(week_end) FROM hanteo_weekly)
      ORDER BY rank ASC`);
  const movers = await d1Query<any>(env.DB,
    `SELECT s.group_key,
            s.yt_total_views - COALESCE(p.yt_total_views, 0) AS d_views,
            s.dc_total_posts  - COALESCE(p.dc_total_posts, 0)  AS d_dc
       FROM agg_summary s
       LEFT JOIN agg_summary p
              ON p.group_key = s.group_key
             AND p.snapshot_at = (
                SELECT MAX(snapshot_at) FROM agg_summary
                  WHERE group_key = s.group_key
                    AND snapshot_at < s.snapshot_at)
      WHERE s.snapshot_at = (SELECT MAX(snapshot_at) FROM agg_summary)`);
  return jsonResponse({ insights, hanteo, movers });
};
```

`frontend/functions/api/insights.ts`:

```ts
import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env, request }) => {
  const url = new URL(request.url);
  const week = url.searchParams.get("week");
  const sql = week
    ? "SELECT * FROM insights WHERE week_start = ? ORDER BY id DESC"
    : "SELECT * FROM insights ORDER BY generated_at DESC LIMIT 50";
  const rows = await d1Query<any>(env.DB, sql, week ? [week] : []);
  return jsonResponse({
    insights: rows.map((r) => ({
      ...r,
      source_refs: (() => { try { return JSON.parse(r.source_refs_json ?? "[]"); }
                            catch { return []; } })(),
    })),
  });
};
```

`frontend/functions/api/members/[key].ts`:

```ts
import { d1Query, d1QueryOne, type D1Database } from "../../lib/d1";
import { jsonResponse } from "../../lib/jsonResponse";

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env, params }) => {
  const key = String(params.key);
  const meta = await d1QueryOne<any>(env.DB,
    `SELECT hhi, evenness, status FROM agg_member_pop_meta
      WHERE group_key=? AND snapshot_at=(
        SELECT MAX(snapshot_at) FROM agg_member_pop_meta WHERE group_key=?
      )`, [key, key]);
  const rows = await d1Query<any>(env.DB,
    `SELECT m.id, m.name, m.name_en,
            mp.yt_score, mp.community_score, mp.composite_score,
            mp.yt_videos, mp.yt_avg_views, mp.yt_sufficient,
            mp.community_mentions
       FROM agg_member_popularity mp
       JOIN members m ON m.id = mp.member_id
      WHERE mp.group_key=? AND mp.snapshot_at=(
        SELECT MAX(snapshot_at) FROM agg_member_popularity WHERE group_key=?
      )
      ORDER BY mp.composite_score DESC`, [key, key]);
  return jsonResponse({
    group_key: key,
    hhi: meta?.hhi ?? null,
    evenness: meta?.evenness ?? null,
    status: meta?.status ?? "insufficient",
    members: rows,
  });
};
```

`frontend/functions/api/health/spec.ts`:

```ts
import { jsonResponse } from "../../lib/jsonResponse";

// Mirror of WEIGHTS from worker/src/idol_sight/analysis/health_score.py.
// Frontend uses this to render the spec modal — single source of truth.
export const onRequestGet: PagesFunction = async () =>
  jsonResponse({
    weights: { subscribers: 20, views: 20, quality: 15, community: 20, news: 10, risk: 15 },
    bonus_max: 10,
    denom: 110,
    grade_thresholds: [["S",9],["A",7],["B",5],["C",3],["D",0]],
    grade_labels: {
      S: "정상 궤도", A: "안정적", B: "성장 중",
      C: "초기 진입", D: "활동 미미", PRE: "데뷔 전 (활동량 부족)",
    },
    references: {
      subscribers: "yt_subscribers ÷ 1,000,000",
      views: "yt_total_views ÷ 200,000,000",
      quality: "Top-10 평균 조회수 ÷ 10,000,000",
      community: "(dc + theqoo + instiz) ÷ 200,000",
      news: "naver_total_news ÷ 500",
      risk: "1 − controversy_count/10",
      bonus: "최근 90d/30d 활동량 가산 (각 7/3점)",
    },
  });
```

- [ ] **Step 2: Smoke test all 5 endpoints**

`frontend/tests/functions/api_endpoints_smoke.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { onRequestGet as marketShare } from "../../functions/api/market-share";
import { onRequestGet as weekly } from "../../functions/api/weekly";
import { onRequestGet as insights } from "../../functions/api/insights";
import { onRequestGet as members } from "../../functions/api/members/[key]";
import { onRequestGet as healthSpec } from "../../functions/api/health/spec";

const env = (rows: any[] = []) => ({
  DB: { prepare: vi.fn(() => ({
    bind: vi.fn().mockReturnThis(),
    all: vi.fn(async () => ({ results: rows })),
    first: vi.fn(async () => rows[0] ?? null),
  })) },
} as any);

describe("smoke: 5 endpoints", () => {
  it("market-share returns rows array", async () => {
    const r = await marketShare({ env: env([]),
      request: new Request("https://x/api/market-share?weeks=4") } as any);
    expect((await r.json()).weeks).toBe(4);
  });
  it("weekly returns insights+hanteo+movers", async () => {
    const r = await weekly({ env: env([]), request: new Request("https://x/") } as any);
    const b = await r.json();
    expect(b).toHaveProperty("insights");
    expect(b).toHaveProperty("hanteo");
    expect(b).toHaveProperty("movers");
  });
  it("insights respects ?week=... filter", async () => {
    const r = await insights({ env: env([]),
      request: new Request("https://x/api/insights?week=2026-04-22") } as any);
    expect(r.status).toBe(200);
  });
  it("members returns hhi+members", async () => {
    const r = await members({
      env: env([]), request: new Request("https://x/"),
      params: { key: "plave" },
    } as any);
    const b = await r.json();
    expect(b).toHaveProperty("hhi");
    expect(b).toHaveProperty("members");
  });
  it("health/spec returns weights table", async () => {
    const r = await healthSpec({} as any);
    const b = await r.json();
    expect(b.weights.subscribers).toBe(20);
    expect(b.grade_thresholds).toEqual([["S",9],["A",7],["B",5],["C",3],["D",0]]);
  });
});
```

- [ ] **Step 3: Run all tests PASS**

```bash
cd frontend && npx -y pnpm test
```

- [ ] **Step 4: Commit**

```bash
git add frontend/functions/api/market-share.ts \
        frontend/functions/api/weekly.ts \
        frontend/functions/api/insights.ts \
        frontend/functions/api/members/[key].ts \
        frontend/functions/api/health/spec.ts \
        frontend/tests/functions/api_endpoints_smoke.test.ts
git commit -m "feat(frontend): 5 secondary api endpoints (market-share/weekly/insights/members/health-spec)"
```

---

## Task 7: `/api/search` — Cmd/Ctrl+K global search

**Files:**
- Create: `frontend/functions/api/search.ts`
- Create: `frontend/tests/functions/api_search.test.ts`

> Searches across groups + members + naver titles + community post titles. Returns ≤20 hits per category.

- [ ] **Step 1: Test**

```ts
import { describe, expect, it, vi } from "vitest";
import { onRequestGet } from "../../functions/api/search";

const envWith = (h: (sql: string) => any[]) => ({
  DB: { prepare: vi.fn((sql: string) => ({
    bind: vi.fn().mockReturnThis(),
    all: vi.fn(async () => ({ results: h(sql) })),
  })) },
} as any);

describe("/api/search", () => {
  it("returns 400 when q is empty", async () => {
    const env = envWith(() => []);
    const r = await onRequestGet({ env, request: new Request("https://x/api/search") } as any);
    expect(r.status).toBe(400);
  });

  it("returns hits across categories", async () => {
    const env = envWith((sql) => {
      if (sql.includes("FROM groups"))   return [{ key:"plave", name:"PLAVE", name_kr:"플레이브" }];
      if (sql.includes("FROM members"))  return [{ id: 1, name: "노아", group_key: "plave" }];
      if (sql.includes("FROM naver_articles"))  return [{ url: "u", title: "PLAVE 신곡" }];
      if (sql.includes("FROM community_posts")) return [{ url: "u", title: "플레이브 후기", platform: "dc" }];
      return [];
    });
    const r = await onRequestGet({
      env, request: new Request("https://x/api/search?q=plave"),
    } as any);
    const b = await r.json();
    expect(b.groups).toHaveLength(1);
    expect(b.members).toHaveLength(1);
    expect(b.naver).toHaveLength(1);
    expect(b.community).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run, FAIL**

- [ ] **Step 3: Implement**

`frontend/functions/api/search.ts`:

```ts
import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env, request }) => {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) return jsonResponse({ error: "missing_q" }, 400);
  const like = `%${q}%`;
  const [groups, members, naver, community] = await Promise.all([
    d1Query(env.DB,
      "SELECT key, name, name_kr FROM groups WHERE is_active=1 "
      + "AND (key LIKE ? OR name LIKE ? OR name_kr LIKE ?) LIMIT 20",
      [like, like, like]),
    d1Query(env.DB,
      "SELECT id, name, group_key FROM members WHERE active=1 "
      + "AND (name LIKE ? OR name_en LIKE ?) LIMIT 20",
      [like, like]),
    d1Query(env.DB,
      "SELECT url, title FROM naver_articles WHERE COALESCE(is_excluded,0)=0 "
      + "AND title LIKE ? ORDER BY published_at DESC LIMIT 20", [like]),
    d1Query(env.DB,
      "SELECT url, title, platform FROM community_posts WHERE title LIKE ? "
      + "ORDER BY posted_at DESC LIMIT 20", [like]),
  ]);
  return jsonResponse({ q, groups, members, naver, community });
};
```

- [ ] **Step 4: Test PASS**

```bash
cd frontend && npx -y pnpm test
```

- [ ] **Step 5: Commit**

```bash
git add frontend/functions/api/search.ts frontend/tests/functions/api_search.test.ts
git commit -m "feat(frontend): /api/search across groups/members/naver/community"
```

---

## Task 8: SPA dependencies + main shell

**Files:**
- Modify: `frontend/package.json` (add Chart.js, framer dependency-free additions)
- Modify: `frontend/index.html` (Tailwind + dark/light root, mount Preact app)
- Create: `frontend/src/api.ts`
- Create: `frontend/src/format.ts`
- Create: `frontend/src/router.ts`
- Create: `frontend/src/theme.ts`
- Rewrite: `frontend/src/main.ts` → `frontend/src/main.tsx`
- Create: `frontend/src/App.tsx`
- Create: `frontend/src/components/Header.tsx`
- Create: `frontend/src/components/LoginGate.tsx`

- [ ] **Step 1: Add Chart.js dep**

```bash
cd frontend
npx -y pnpm add chart.js@^4.4.0
```

(`chart.js` lives in `dependencies`, not devDependencies.)

- [ ] **Step 2: Rewrite `frontend/index.html`**

```html
<!doctype html>
<html lang="ko" class="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>IDOL-SIGHT</title>
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ctext y='20' font-size='20'%3E%F0%9F%93%8A%3C/text%3E%3C/svg%3E" />
  </head>
  <body class="bg-zinc-950 text-zinc-100 antialiased dark:bg-zinc-950 dark:text-zinc-100 [.light_&]:bg-zinc-50 [.light_&]:text-zinc-900">
    <div id="app"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 3: Implement primitives**

`frontend/src/format.ts`:

```ts
export function fmt(n: number | null | undefined): string {
  if (n == null) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

export function pct(n: number | null | undefined, digits = 1): string {
  if (n == null) return "—";
  return n.toFixed(digits) + "%";
}

export function deltaSign(n: number): "up" | "down" | "flat" {
  return n > 0 ? "up" : n < 0 ? "down" : "flat";
}
```

`frontend/src/api.ts`:

```ts
async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path, { credentials: "include" });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return (await r.json()) as T;
}

export const api = {
  meta:        () => getJson<any>("/api/meta"),
  groups:      () => getJson<any>("/api/groups"),
  market:      () => getJson<any>("/api/market"),
  marketShare: (weeks = 13) => getJson<any>(`/api/market-share?weeks=${weeks}`),
  group:       (k: string) => getJson<any>(`/api/group/${encodeURIComponent(k)}`),
  members:     (k: string) => getJson<any>(`/api/members/${encodeURIComponent(k)}`),
  weekly:      () => getJson<any>("/api/weekly"),
  insights:    (week?: string) =>
    getJson<any>("/api/insights" + (week ? `?week=${encodeURIComponent(week)}` : "")),
  search:      (q: string) => getJson<any>(`/api/search?q=${encodeURIComponent(q)}`),
  healthSpec:  () => getJson<any>("/api/health/spec"),
};
```

`frontend/src/router.ts`:

```ts
export interface RouterState {
  tab: "market" | "weekly" | "content" | "members" | "community" | "risk" | "insights";
  group: string | null;
  period: number | null;        // days; null = all
  theme: "dark" | "light";
}

const DEFAULT: RouterState = {
  tab: "market", group: null, period: null, theme: "dark",
};

export function readState(): RouterState {
  const params = new URLSearchParams(location.hash.slice(1));
  return {
    tab: (params.get("tab") as RouterState["tab"]) || DEFAULT.tab,
    group: params.get("group"),
    period: params.get("period") ? Number(params.get("period")) : null,
    theme: (params.get("theme") as RouterState["theme"]) || DEFAULT.theme,
  };
}

export function writeState(patch: Partial<RouterState>): void {
  const cur = readState();
  const next = { ...cur, ...patch };
  const params = new URLSearchParams();
  params.set("tab", next.tab);
  if (next.group) params.set("group", next.group);
  if (next.period != null) params.set("period", String(next.period));
  if (next.theme !== "dark") params.set("theme", next.theme);
  location.hash = "#" + params.toString();
}

export function onStateChange(handler: (s: RouterState) => void): () => void {
  const fn = () => handler(readState());
  window.addEventListener("hashchange", fn);
  return () => window.removeEventListener("hashchange", fn);
}
```

`frontend/src/theme.ts`:

```ts
import { readState, writeState } from "./router";

export function applyTheme(): void {
  const t = readState().theme;
  document.documentElement.classList.toggle("light", t === "light");
  document.documentElement.classList.toggle("dark", t === "dark");
}

export function toggleTheme(): void {
  const t = readState().theme;
  writeState({ theme: t === "dark" ? "light" : "dark" });
  applyTheme();
}
```

- [ ] **Step 4: Implement App + Header + LoginGate**

`frontend/src/App.tsx`:

```tsx
import { useEffect, useState } from "preact/hooks";
import { Header } from "./components/Header";
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
import { Insights } from "./views/Insights";

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [state, setState] = useState(readState());

  useEffect(() => { applyTheme(); }, []);
  useEffect(() => onStateChange(setState), []);

  // Liveness check: hit /api/meta. If 401 → show login gate.
  useEffect(() => {
    api.meta().then(() => setAuthed(true)).catch((e) => {
      if (String(e).includes("401")) setAuthed(false);
      else setAuthed(true);   // network/other → show app, individual views handle errors
    });
  }, []);

  if (authed === null) return <div class="p-8 text-zinc-500">Loading…</div>;
  if (authed === false) return <LoginGate />;

  return (
    <div class="min-h-screen">
      <Header state={state} />
      <main class="mx-auto max-w-7xl p-4">
        {state.tab === "market"    && <MarketOverview />}
        {state.tab === "weekly"    && <WeeklyUpdate />}
        {state.tab === "content"   && <GroupContent groupKey={state.group} />}
        {state.tab === "members"   && <Members groupKey={state.group} />}
        {state.tab === "community" && <Community groupKey={state.group} period={state.period} />}
        {state.tab === "risk"      && <PRRisk groupKey={state.group} />}
        {state.tab === "insights"  && <Insights />}
      </main>
    </div>
  );
}
```

`frontend/src/components/Header.tsx`:

```tsx
import { writeState, type RouterState } from "../router";
import { toggleTheme } from "../theme";

const TABS: Array<[RouterState["tab"], string]> = [
  ["market", "Market Overview"],
  ["weekly", "Weekly Update"],
  ["content", "Group Content"],
  ["members", "Member View"],
  ["community", "Community"],
  ["risk", "PR & Risk"],
  ["insights", "Insights"],
];

export function Header({ state }: { state: RouterState }) {
  return (
    <header class="border-b border-zinc-800 px-4 py-3 [.light_&]:border-zinc-200">
      <div class="mx-auto flex max-w-7xl items-center gap-4">
        <h1 class="text-xl font-bold tracking-tight">
          IDOL<span class="text-violet-400">-SIGHT</span>
        </h1>
        <nav class="flex gap-1 overflow-x-auto text-sm">
          {TABS.map(([k, label]) => (
            <button
              class={
                "rounded px-3 py-1 transition-colors " +
                (state.tab === k
                  ? "bg-violet-500/20 text-violet-300"
                  : "text-zinc-400 hover:bg-zinc-800/60")
              }
              onClick={() => writeState({ tab: k })}
            >{label}</button>
          ))}
        </nav>
        <button
          class="ml-auto rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
          onClick={() => toggleTheme()}
          title="Theme"
        >{state.theme === "dark" ? "🌙" : "☀️"}</button>
      </div>
    </header>
  );
}
```

`frontend/src/components/LoginGate.tsx`:

```tsx
export function LoginGate() {
  const params = new URLSearchParams(location.search);
  const failed = params.get("err") === "1";
  return (
    <div class="grid min-h-screen place-items-center p-4">
      <form method="POST" action="/__auth"
            class="w-full max-w-sm rounded-lg border border-zinc-800 bg-zinc-900 p-6 shadow-xl">
        <div class="mb-4 flex items-center gap-2">
          <span class="text-3xl">📊</span>
          <div>
            <h2 class="text-lg font-bold">IDOL-SIGHT</h2>
            <p class="text-xs text-zinc-500">Internal access</p>
          </div>
        </div>
        {failed && (
          <p class="mb-2 rounded bg-red-500/10 px-2 py-1 text-xs text-red-400">
            비밀번호가 올바르지 않습니다.
          </p>
        )}
        <input type="password" name="password" required autofocus
               placeholder="Password"
               class="mb-3 w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm focus:border-violet-500 focus:outline-none" />
        <button class="w-full rounded bg-violet-500 px-3 py-2 text-sm font-semibold hover:bg-violet-600">
          Enter
        </button>
      </form>
    </div>
  );
}
```

`frontend/src/main.tsx`:

```tsx
import { render } from "preact";
import { App } from "./App";
import "./styles.css";

render(<App />, document.getElementById("app")!);
```

- [ ] **Step 5: Stub all 7 views (so build doesn't fail)**

For each of `MarketOverview`, `WeeklyUpdate`, `GroupContent`, `Members`, `Community`, `PRRisk`, `Insights`, create a file in `frontend/src/views/<Name>.tsx`:

```tsx
// frontend/src/views/MarketOverview.tsx (and analogous for others)
export function MarketOverview() {
  return <div class="text-zinc-500">MarketOverview — Task 9</div>;
}
```

(Repeat with the same content for each view, just changing the function name and the inline label so the next tasks know which is which. Replace `MarketOverview` with `WeeklyUpdate`, etc., and change the label to match. Each view gets a 4-line file. Do NOT skip any — all 7 must exist for the App to render without crashing.)

`GroupContent`, `Members`, `Community`, `PRRisk` accept props per the App component signature:

```tsx
export function GroupContent({ groupKey }: { groupKey: string | null }) {
  return <div class="text-zinc-500">GroupContent {groupKey ?? "(no group)"} — Task 11</div>;
}
export function Members({ groupKey }: { groupKey: string | null }) {
  return <div class="text-zinc-500">Members {groupKey ?? "(no group)"} — Task 12</div>;
}
export function Community({ groupKey, period }: { groupKey: string | null; period: number | null }) {
  return <div class="text-zinc-500">Community {groupKey ?? "(no group)"} period={period ?? "all"} — Task 13</div>;
}
export function PRRisk({ groupKey }: { groupKey: string | null }) {
  return <div class="text-zinc-500">PRRisk {groupKey ?? "(no group)"} — Task 13</div>;
}
```

- [ ] **Step 6: Build**

```bash
cd frontend
npx -y pnpm typecheck
npx -y pnpm build
```

Expected: clean. `dist/index.html` + assets generated.

- [ ] **Step 7: Commit**

```bash
git add frontend/index.html frontend/package.json frontend/pnpm-lock.yaml \
        frontend/src/main.tsx frontend/src/App.tsx \
        frontend/src/components/Header.tsx frontend/src/components/LoginGate.tsx \
        frontend/src/api.ts frontend/src/format.ts frontend/src/router.ts frontend/src/theme.ts \
        frontend/src/views/MarketOverview.tsx frontend/src/views/WeeklyUpdate.tsx \
        frontend/src/views/GroupContent.tsx frontend/src/views/Members.tsx \
        frontend/src/views/Community.tsx frontend/src/views/PRRisk.tsx \
        frontend/src/views/Insights.tsx
# main.ts → main.tsx (delete the old one if needed)
git rm -f frontend/src/main.ts 2>/dev/null || true
git commit -m "feat(frontend): SPA shell with Preact App, Header, LoginGate, view stubs"
```

---

## Task 9: Shared components — FreshnessBadge, KPI, ExportMenu, ShareLink, HealthSpec, SourceRef

**Files (one per component):**
- `frontend/src/components/FreshnessBadge.tsx`
- `frontend/src/components/KPI.tsx`
- `frontend/src/components/ExportMenu.tsx`
- `frontend/src/components/ShareLink.tsx`
- `frontend/src/components/HealthSpec.tsx`
- `frontend/src/components/SourceRef.tsx`

> All 6 are presentation-only — props in, JSX out. No fetches. Used by views in Tasks 10-14.

- [ ] **Step 1: Implement FreshnessBadge**

`frontend/src/components/FreshnessBadge.tsx`:

```tsx
type Freshness = "fresh" | "stale" | "broken";

function classify(lastSuccessAt: string | null, intervalH: number): Freshness {
  if (!lastSuccessAt) return "broken";
  const ageH = (Date.now() - Date.parse(lastSuccessAt)) / 3_600_000;
  if (ageH < intervalH * 1.5) return "fresh";
  if (ageH < intervalH * 4)   return "stale";
  return "broken";
}

const COLORS: Record<Freshness, string> = {
  fresh:  "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  stale:  "bg-amber-500/10  text-amber-400  border-amber-500/30",
  broken: "bg-red-500/10    text-red-400    border-red-500/30",
};

const ICONS: Record<Freshness, string> = { fresh: "✓", stale: "⏳", broken: "⚠️" };

export function FreshnessBadge(props: {
  label?: string;
  lastSuccessAt: string | null;
  intervalH: number;
}) {
  const f = classify(props.lastSuccessAt, props.intervalH);
  const ageH = props.lastSuccessAt
    ? (Date.now() - Date.parse(props.lastSuccessAt)) / 3_600_000
    : null;
  const ageText = ageH == null
    ? "마지막 갱신 없음"
    : ageH < 1 ? `${Math.round(ageH * 60)}분 전`
    : ageH < 48 ? `${Math.round(ageH)}시간 전`
    : `${Math.round(ageH / 24)}일 전`;
  return (
    <span class={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] ${COLORS[f]}`}>
      <span>{ICONS[f]}</span>
      {props.label && <span class="text-zinc-300">{props.label}:</span>}
      <span>{ageText}</span>
    </span>
  );
}
```

- [ ] **Step 2: Implement KPI**

```tsx
// frontend/src/components/KPI.tsx
import { fmt } from "../format";

export function KPI(props: {
  label: string;
  value: number | string | null;
  delta?: number | null;
  hint?: string;
}) {
  const v = typeof props.value === "number" ? fmt(props.value) : (props.value ?? "—");
  const d = props.delta;
  return (
    <div class="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 [.light_&]:border-zinc-200 [.light_&]:bg-white">
      <div class="text-[10px] uppercase tracking-wide text-zinc-500">{props.label}</div>
      <div class="mt-1 flex items-baseline gap-2">
        <div class="text-xl font-bold">{v}</div>
        {d != null && d !== 0 && (
          <span class={`text-xs font-semibold ${d > 0 ? "text-emerald-400" : "text-red-400"}`}>
            {d > 0 ? "▲" : "▼"} {fmt(Math.abs(d))}
          </span>
        )}
      </div>
      {props.hint && <div class="mt-0.5 text-[10px] text-zinc-500">{props.hint}</div>}
    </div>
  );
}
```

- [ ] **Step 3: Implement ExportMenu**

```tsx
// frontend/src/components/ExportMenu.tsx
import type { JSX } from "preact";

export function exportCsv(filename: string, rows: Record<string, unknown>[]): void {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const escape = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => escape(r[c])).join(","))].join("\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export function exportPng(canvas: HTMLCanvasElement, filename: string): void {
  const url = canvas.toDataURL("image/png");
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
}

export function ExportMenu(props: { rows?: Record<string, unknown>[]; canvas?: HTMLCanvasElement;
                                     filenameBase: string }): JSX.Element {
  return (
    <div class="flex gap-1">
      {props.rows && (
        <button
          class="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800"
          onClick={() => exportCsv(`${props.filenameBase}.csv`, props.rows!)}
        >CSV</button>
      )}
      {props.canvas && (
        <button
          class="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800"
          onClick={() => exportPng(props.canvas!, `${props.filenameBase}.png`)}
        >PNG</button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Implement ShareLink**

```tsx
// frontend/src/components/ShareLink.tsx
import { useState } from "preact/hooks";

export function ShareLink() {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    await navigator.clipboard.writeText(location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      class="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800"
      onClick={onClick}
      title="현재 화면 URL 복사"
    >{copied ? "복사됨 ✓" : "공유 링크"}</button>
  );
}
```

- [ ] **Step 5: Implement HealthSpec modal**

```tsx
// frontend/src/components/HealthSpec.tsx
import { useEffect, useState } from "preact/hooks";
import { api } from "../api";

export function HealthSpec() {
  const [open, setOpen] = useState(false);
  const [spec, setSpec] = useState<any>(null);
  useEffect(() => { if (open && !spec) api.healthSpec().then(setSpec); }, [open]);
  return (
    <>
      <button
        class="text-[10px] text-zinc-500 underline-offset-2 hover:underline"
        onClick={() => setOpen(true)}
      >산식 보기</button>
      {open && (
        <div class="fixed inset-0 z-50 grid place-items-center bg-black/60" onClick={() => setOpen(false)}>
          <div class="max-w-md rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-sm" onClick={(e) => e.stopPropagation()}>
            <div class="mb-2 flex items-center justify-between">
              <h3 class="font-semibold">Health Score 산식</h3>
              <button class="text-zinc-500 hover:text-zinc-300" onClick={() => setOpen(false)}>✕</button>
            </div>
            {!spec ? <div class="text-zinc-500">로딩…</div> : (
              <div class="space-y-2 text-xs">
                <table class="w-full">
                  <tbody>
                    {Object.entries(spec.weights).map(([k, v]) => (
                      <tr><td class="py-0.5 text-zinc-400">{k}</td>
                          <td class="py-0.5 text-right">{String(v)}</td>
                          <td class="py-0.5 pl-3 text-zinc-500">{spec.references[k]}</td></tr>
                    ))}
                    <tr class="border-t border-zinc-800">
                      <td class="pt-1 text-zinc-400">bonus_max</td>
                      <td class="pt-1 text-right">{spec.bonus_max}</td>
                      <td class="pt-1 pl-3 text-zinc-500">{spec.references.bonus}</td>
                    </tr>
                    <tr><td class="text-zinc-400">denom</td><td class="text-right">{spec.denom}</td>
                        <td class="pl-3 text-zinc-500">total = raw / denom × 10</td></tr>
                  </tbody>
                </table>
                <div class="text-zinc-500">
                  Grade: {spec.grade_thresholds.map(([g, t]: [string, number]) => `${g}≥${t}`).join(" / ")}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 6: Implement SourceRef**

```tsx
// frontend/src/components/SourceRef.tsx
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
```

- [ ] **Step 7: Build + commit**

```bash
cd frontend && npx -y pnpm typecheck && npx -y pnpm build
git add frontend/src/components/FreshnessBadge.tsx frontend/src/components/KPI.tsx \
        frontend/src/components/ExportMenu.tsx frontend/src/components/ShareLink.tsx \
        frontend/src/components/HealthSpec.tsx frontend/src/components/SourceRef.tsx
git commit -m "feat(frontend): shared presentation components (badge/KPI/export/share/health-spec/source-ref)"
```

---

## Task 10: Market Overview view

**File:**
- Replace stub: `frontend/src/views/MarketOverview.tsx`

> Renders: market cards (one per group with health grade) + 4 charts (market_share trend, YT views, community activity, news coverage) + market insights list.

- [ ] **Step 1: Implement (full code below)**

```tsx
import { useEffect, useRef, useState } from "preact/hooks";
import Chart from "chart.js/auto";
import { api } from "../api";
import { fmt } from "../format";
import { writeState } from "../router";
import { FreshnessBadge } from "../components/FreshnessBadge";
import { ExportMenu } from "../components/ExportMenu";
import { ShareLink } from "../components/ShareLink";
import { HealthSpec } from "../components/HealthSpec";
import { SourceRef } from "../components/SourceRef";

const GRADE_COLORS: Record<string, string> = {
  S: "text-emerald-400 border-emerald-500/40 bg-emerald-500/10",
  A: "text-blue-400    border-blue-500/40    bg-blue-500/10",
  B: "text-violet-400  border-violet-500/40  bg-violet-500/10",
  C: "text-amber-400   border-amber-500/40   bg-amber-500/10",
  D: "text-red-400     border-red-500/40     bg-red-500/10",
  PRE: "text-zinc-400  border-zinc-500/40    bg-zinc-500/10",
};

export function MarketOverview() {
  const [market, setMarket] = useState<any>(null);
  const [share, setShare] = useState<any>(null);
  const [meta, setMeta] = useState<any>(null);
  const [excludePlave, setExcludePlave] = useState(false);
  const [logScale, setLogScale] = useState(false);
  const shareCanvas = useRef<HTMLCanvasElement | null>(null);
  const shareChart = useRef<Chart | null>(null);
  const ytCanvas = useRef<HTMLCanvasElement | null>(null);
  const ytChart = useRef<Chart | null>(null);

  useEffect(() => {
    api.market().then(setMarket);
    api.marketShare(13).then(setShare);
    api.meta().then(setMeta);
  }, []);

  // Market share trend (stacked area)
  useEffect(() => {
    if (!share || !shareCanvas.current) return;
    const ctx = shareCanvas.current;
    const weeks = Array.from(new Set<string>(share.rows.map((r: any) => r.week_end))).sort();
    const groupKeys = Array.from(new Set<string>(share.rows.map((r: any) => r.group_key)));
    const filtered = excludePlave ? groupKeys.filter((k) => k !== "plave") : groupKeys;
    const datasets = filtered.map((k, i) => ({
      label: k,
      data: weeks.map((w) => {
        const row = share.rows.find((r: any) => r.week_end === w && r.group_key === k);
        return row?.final ?? 0;
      }),
      backgroundColor: `hsl(${(i * 47) % 360},65%,55%)`,
      borderWidth: 0,
      fill: true,
    }));
    shareChart.current?.destroy();
    shareChart.current = new Chart(ctx, {
      type: "line",
      data: { labels: weeks, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: {
          y: { stacked: true, type: logScale ? "logarithmic" : "linear",
               title: { display: true, text: "share %" } },
          x: { stacked: true },
        },
        plugins: { legend: { position: "bottom" } },
      },
    });
  }, [share, excludePlave, logScale]);

  // YT views bar
  useEffect(() => {
    if (!market || !ytCanvas.current) return;
    const ctx = ytCanvas.current;
    const groups = Object.entries(market.groups);
    ytChart.current?.destroy();
    ytChart.current = new Chart(ctx, {
      type: "bar",
      data: {
        labels: groups.map(([_, g]: any) => g.name),
        datasets: [{
          label: "yt_total_views",
          data: groups.map(([_, g]: any) => g.summary?.yt_total_views ?? 0),
          backgroundColor: "rgb(139 92 246 / 0.6)",
        }],
      },
      options: { responsive: true, maintainAspectRatio: false,
                 plugins: { legend: { display: false } } },
    });
  }, [market]);

  if (!market) return <div class="p-4 text-zinc-500">Loading…</div>;

  return (
    <div class="space-y-6">
      {/* freshness banner */}
      <div class="flex flex-wrap items-center gap-2">
        {meta && (
          <FreshnessBadge label="전체"
            lastSuccessAt={meta.global_last_success_at}
            intervalH={1} />
        )}
        <div class="ml-auto flex items-center gap-1">
          <ShareLink />
        </div>
      </div>

      {/* group cards */}
      <div class="grid grid-cols-2 gap-2 md:grid-cols-4">
        {Object.entries(market.groups).map(([key, g]: any) => (
          <button
            key={key}
            onClick={() => writeState({ tab: "content", group: key })}
            class="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-left hover:border-violet-500/50"
          >
            <div class="flex items-baseline justify-between">
              <div class="font-semibold">{g.name}</div>
              <span class={`rounded border px-1.5 text-xs ${GRADE_COLORS[g.health_score?.grade ?? "PRE"]}`}>
                {g.health_score?.grade ?? "PRE"}
              </span>
            </div>
            <div class="text-xs text-zinc-500">{g.name_kr}</div>
            <div class="mt-2 text-xl font-bold">
              {g.health_score?.total ?? "—"}
            </div>
            <div class="text-[10px] text-zinc-500">
              YT {fmt(g.summary?.yt_total_views ?? 0)} · DC {fmt(g.summary?.dc_total_posts ?? 0)} · News {g.summary?.naver_total_news ?? 0}
            </div>
          </button>
        ))}
      </div>

      {/* market share chart */}
      <section class="rounded-lg border border-zinc-800 p-3">
        <div class="mb-2 flex items-center gap-2 text-sm">
          <h3 class="font-semibold">Market Share Trend (13주)</h3>
          <HealthSpec />
          <label class="ml-auto flex items-center gap-1 text-xs text-zinc-400">
            <input type="checkbox" checked={excludePlave}
                   onChange={(e: any) => setExcludePlave(e.currentTarget.checked)} />
            PLAVE 제외
          </label>
          <label class="flex items-center gap-1 text-xs text-zinc-400">
            <input type="checkbox" checked={logScale}
                   onChange={(e: any) => setLogScale(e.currentTarget.checked)} />
            로그 스케일
          </label>
          <ExportMenu canvas={shareCanvas.current ?? undefined}
                       rows={share?.rows ?? []}
                       filenameBase="market-share" />
        </div>
        <div class="h-72"><canvas ref={shareCanvas}></canvas></div>
      </section>

      {/* YT views bar */}
      <section class="rounded-lg border border-zinc-800 p-3">
        <div class="mb-2 flex items-center text-sm">
          <h3 class="font-semibold">YouTube Total Views</h3>
          <ExportMenu canvas={ytCanvas.current ?? undefined}
                       filenameBase="yt-views" />
        </div>
        <div class="h-60"><canvas ref={ytCanvas}></canvas></div>
      </section>

      {/* market insights */}
      {market.market_insights?.length > 0 && (
        <section class="rounded-lg border border-zinc-800 p-3">
          <h3 class="mb-2 text-sm font-semibold">Market Insights</h3>
          <ul class="space-y-2 text-sm">
            {market.market_insights.map((i: any) => (
              <li key={i.id} class="rounded border border-zinc-800/60 p-2">
                <div class="font-semibold">{i.title}</div>
                <div class="text-xs text-zinc-400">{i.body}</div>
                <SourceRef refs={i.source_refs ?? []} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Build**

```bash
cd frontend && npx -y pnpm typecheck && npx -y pnpm build
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/views/MarketOverview.tsx
git commit -m "feat(frontend): Market Overview tab with cards, charts, insights"
```

---

## Task 11: Weekly Update + Insights views

**Files:**
- Replace: `frontend/src/views/WeeklyUpdate.tsx`
- Replace: `frontend/src/views/Insights.tsx`

- [ ] **Step 1: WeeklyUpdate**

```tsx
// frontend/src/views/WeeklyUpdate.tsx
import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { fmt } from "../format";
import { SourceRef } from "../components/SourceRef";

export function WeeklyUpdate() {
  const [data, setData] = useState<any>(null);
  useEffect(() => { api.weekly().then(setData); }, []);
  if (!data) return <div class="text-zinc-500">Loading…</div>;
  return (
    <div class="space-y-6">
      <section class="rounded-lg border border-zinc-800 p-3">
        <h3 class="mb-2 text-sm font-semibold">Weekly Insights ({data.insights.length})</h3>
        <ul class="space-y-2 text-sm">
          {data.insights.map((i: any) => (
            <li key={i.id} class="rounded border border-zinc-800/60 p-2">
              <div class="text-[10px] text-zinc-500">{i.scope} · {i.week_start}</div>
              <div class="font-semibold">{i.title}</div>
              <div class="text-xs text-zinc-400">{i.body}</div>
              <SourceRef refs={(() => { try { return JSON.parse(i.source_refs_json ?? "[]"); }
                                          catch { return []; } })()} />
            </li>
          ))}
        </ul>
      </section>

      <section class="rounded-lg border border-zinc-800 p-3">
        <h3 class="mb-2 text-sm font-semibold">Hanteo Weekly</h3>
        {data.hanteo.length === 0 ? (
          <div class="text-xs text-zinc-500">차트 데이터 없음 (selector follow-up).</div>
        ) : (
          <table class="w-full text-xs">
            <thead><tr class="text-left text-zinc-500">
              <th class="py-1">#</th><th>Group</th><th>Album</th><th>Sales</th>
            </tr></thead>
            <tbody>
              {data.hanteo.map((h: any) => (
                <tr key={`${h.group_key}-${h.album}`} class="border-t border-zinc-800/60">
                  <td class="py-1">{h.rank}</td>
                  <td>{h.group_key}</td>
                  <td>{h.album}</td>
                  <td>{fmt(h.sales)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section class="rounded-lg border border-zinc-800 p-3">
        <h3 class="mb-2 text-sm font-semibold">Big Movers (이번 vs 직전)</h3>
        <table class="w-full text-xs">
          <thead><tr class="text-left text-zinc-500">
            <th class="py-1">Group</th><th>ΔViews</th><th>ΔDC</th>
          </tr></thead>
          <tbody>
            {data.movers.map((m: any) => (
              <tr key={m.group_key} class="border-t border-zinc-800/60">
                <td class="py-1">{m.group_key}</td>
                <td class={(m.d_views ?? 0) > 0 ? "text-emerald-400" : "text-red-400"}>
                  {m.d_views == null ? "—" : (m.d_views > 0 ? "▲" : "▼") + " " + fmt(Math.abs(m.d_views))}
                </td>
                <td class={(m.d_dc ?? 0) > 0 ? "text-emerald-400" : "text-red-400"}>
                  {m.d_dc == null ? "—" : (m.d_dc > 0 ? "▲" : "▼") + " " + fmt(Math.abs(m.d_dc))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Insights**

```tsx
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
          <div class="text-[10px] text-zinc-500">{i.scope} · {i.type} · {i.week_start ?? i.generated_at?.slice(0,10)}</div>
          <div class="font-semibold">{i.title}</div>
          <div class="mt-1 text-xs text-zinc-400">{i.body}</div>
          <SourceRef refs={i.source_refs ?? []} />
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 3: Build + commit**

```bash
cd frontend && npx -y pnpm typecheck && npx -y pnpm build
git add frontend/src/views/WeeklyUpdate.tsx frontend/src/views/Insights.tsx
git commit -m "feat(frontend): Weekly Update + Insights views"
```

---

## Task 12: Group Content view (per-group dashboard)

**File:**
- Replace: `frontend/src/views/GroupContent.tsx`

> Shows the group's Health hero, KPI row, YT Top 15 table with content_type badges, MV table, recent community/news samples, and group selector.

- [ ] **Step 1: Implement**

```tsx
// frontend/src/views/GroupContent.tsx
import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { fmt } from "../format";
import { writeState } from "../router";
import { KPI } from "../components/KPI";
import { ExportMenu } from "../components/ExportMenu";
import { HealthSpec } from "../components/HealthSpec";

const GRADE_RING: Record<string, string> = {
  S: "ring-emerald-500", A: "ring-blue-500", B: "ring-violet-500",
  C: "ring-amber-500", D: "ring-red-500", PRE: "ring-zinc-500",
};

export function GroupContent({ groupKey }: { groupKey: string | null }) {
  const [groups, setGroups] = useState<any[]>([]);
  const [data, setData] = useState<any>(null);

  useEffect(() => { api.groups().then((r) => setGroups(r.groups)); }, []);
  useEffect(() => {
    if (!groupKey) return;
    setData(null);
    api.group(groupKey).then(setData).catch(() => setData({ error: "not_found" }));
  }, [groupKey]);

  return (
    <div class="space-y-4">
      <div class="flex items-center gap-2 text-sm">
        <label class="text-zinc-500">Group</label>
        <select
          class="rounded border border-zinc-700 bg-zinc-950 px-2 py-1"
          value={groupKey ?? ""}
          onChange={(e: any) => writeState({ group: e.currentTarget.value || null })}
        >
          <option value="">— 선택 —</option>
          {groups.map((g) => (
            <option key={g.key} value={g.key}>{g.name} · {g.name_kr}</option>
          ))}
        </select>
      </div>

      {!groupKey && <div class="text-zinc-500">위에서 그룹을 선택하세요.</div>}
      {groupKey && !data && <div class="text-zinc-500">Loading…</div>}
      {data?.error === "not_found" && <div class="text-red-400">그룹 없음</div>}

      {data && !data.error && (
        <>
          <section class="flex items-center gap-4 rounded-lg border border-zinc-800 p-3">
            <div class={`grid h-20 w-20 place-items-center rounded-full bg-zinc-950 ring-2 ${GRADE_RING[data.health_score?.grade ?? "PRE"]}`}>
              <div class="text-2xl font-bold">{data.health_score?.total ?? "—"}</div>
              <div class="text-[10px] text-zinc-400">{data.health_score?.grade ?? "PRE"}</div>
            </div>
            <div>
              <div class="text-lg font-semibold">{data.name} <span class="text-zinc-500 text-sm">· {data.name_kr}</span></div>
              <div class="text-xs text-zinc-400">{data.health_score?.label ?? "데뷔 전 (활동량 부족)"}</div>
              <HealthSpec />
            </div>
          </section>

          <section class="grid grid-cols-2 gap-2 md:grid-cols-5">
            <KPI label="Videos" value={data.summary?.yt_total_videos ?? 0} />
            <KPI label="Views"  value={data.summary?.yt_total_views ?? 0} />
            <KPI label="Subs"   value={data.summary?.yt_subscribers ?? 0} />
            <KPI label="DC"     value={data.summary?.dc_total_posts ?? 0} />
            <KPI label="News"   value={data.summary?.naver_total_news ?? 0} />
          </section>

          <section class="rounded-lg border border-zinc-800 p-3">
            <div class="mb-2 flex items-center text-sm">
              <h3 class="font-semibold">YouTube Top 15</h3>
              <ExportMenu rows={data.yt_top15} filenameBase={`${groupKey}-yt-top15`} />
            </div>
            <table class="w-full text-xs">
              <thead><tr class="text-left text-zinc-500">
                <th class="py-1">#</th><th>Title</th><th>Type</th><th class="text-right">Views</th><th class="text-right">Likes</th>
              </tr></thead>
              <tbody>
                {data.yt_top15.map((v: any, i: number) => (
                  <tr key={v.video_id} class="border-t border-zinc-800/60">
                    <td class="py-1">{i + 1}</td>
                    <td class="max-w-md truncate">{v.title}</td>
                    <td><span class="rounded bg-zinc-800 px-1.5 text-[10px]">{v.content_type ?? "—"}</span></td>
                    <td class="text-right">{fmt(v.views)}</td>
                    <td class="text-right">{fmt(v.likes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Build + commit**

```bash
cd frontend && npx -y pnpm typecheck && npx -y pnpm build
git add frontend/src/views/GroupContent.tsx
git commit -m "feat(frontend): Group Content view with health hero, KPI, YT Top 15"
```

---

## Task 13: Members view

**File:**
- Replace: `frontend/src/views/Members.tsx`

> Renders HHI / evenness gauge + bar chart per member (yt_score + community_score stacked) + table.

- [ ] **Step 1: Implement**

```tsx
// frontend/src/views/Members.tsx
import { useEffect, useRef, useState } from "preact/hooks";
import Chart from "chart.js/auto";
import { api } from "../api";
import { fmt } from "../format";

export function Members({ groupKey }: { groupKey: string | null }) {
  const [data, setData] = useState<any>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const chart = useRef<Chart | null>(null);

  useEffect(() => {
    if (!groupKey) return;
    setData(null);
    api.members(groupKey).then(setData);
  }, [groupKey]);

  useEffect(() => {
    if (!data || !canvas.current) return;
    chart.current?.destroy();
    chart.current = new Chart(canvas.current, {
      type: "bar",
      data: {
        labels: data.members.map((m: any) => m.name),
        datasets: [
          { label: "YT", stack: "s",
            data: data.members.map((m: any) => m.yt_score),
            backgroundColor: "rgb(139 92 246 / 0.7)" },
          { label: "Community", stack: "s",
            data: data.members.map((m: any) => m.community_score),
            backgroundColor: "rgb(20 184 166 / 0.7)" },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" } },
        scales: { x: { stacked: true }, y: { stacked: true, max: 200 } },
      },
    });
  }, [data]);

  if (!groupKey) return <div class="text-zinc-500">상단에서 그룹을 선택하세요.</div>;
  if (!data) return <div class="text-zinc-500">Loading…</div>;
  if (data.status === "insufficient") {
    return (
      <div class="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 text-sm text-zinc-400">
        <div class="text-lg font-semibold text-zinc-200">데이터 부족</div>
        <p class="mt-1">해당 그룹은 활동량 부족으로 멤버 인기도 산출 불가 (HHI 미계산).</p>
      </div>
    );
  }
  return (
    <div class="space-y-4">
      <section class="grid grid-cols-2 gap-2">
        <div class="rounded-lg border border-zinc-800 p-3">
          <div class="text-[10px] uppercase text-zinc-500">HHI</div>
          <div class="text-2xl font-bold">{data.hhi?.toFixed(3) ?? "—"}</div>
          <div class="text-[10px] text-zinc-500">0=완전 균등, 1=한 명이 독점</div>
        </div>
        <div class="rounded-lg border border-zinc-800 p-3">
          <div class="text-[10px] uppercase text-zinc-500">Evenness</div>
          <div class="text-2xl font-bold">{data.evenness != null ? (data.evenness * 100).toFixed(0) + "%" : "—"}</div>
          <div class="text-[10px] text-zinc-500">100% 가까울수록 균등</div>
        </div>
      </section>
      <section class="rounded-lg border border-zinc-800 p-3">
        <h3 class="mb-2 text-sm font-semibold">Member Composite Score</h3>
        <div class="h-64"><canvas ref={canvas}></canvas></div>
      </section>
      <section class="rounded-lg border border-zinc-800 p-3">
        <table class="w-full text-xs">
          <thead><tr class="text-left text-zinc-500">
            <th class="py-1">#</th><th>Member</th>
            <th class="text-right">Score</th><th class="text-right">YT</th>
            <th class="text-right">Avg Views</th><th class="text-right">Comm</th>
          </tr></thead>
          <tbody>
            {data.members.map((m: any, i: number) => (
              <tr key={m.id} class="border-t border-zinc-800/60">
                <td class="py-1">{i + 1}</td>
                <td>{m.name} <span class="text-zinc-500">{m.name_en ?? ""}</span></td>
                <td class="text-right font-semibold">{m.composite_score?.toFixed(1)}</td>
                <td class="text-right">{m.yt_videos}편</td>
                <td class="text-right">{m.yt_sufficient ? fmt(m.yt_avg_views) : <span class="text-zinc-500">{fmt(m.yt_avg_views)} (부족)</span>}</td>
                <td class="text-right">{fmt(m.community_mentions)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Build + commit**

```bash
cd frontend && npx -y pnpm typecheck && npx -y pnpm build
git add frontend/src/views/Members.tsx
git commit -m "feat(frontend): Members view with HHI gauge + composite score chart"
```

---

## Task 14: Community + PR&Risk views

**Files:**
- Replace: `frontend/src/views/Community.tsx`
- Replace: `frontend/src/views/PRRisk.tsx`

- [ ] **Step 1: Community**

```tsx
// frontend/src/views/Community.tsx
import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { fmt } from "../format";
import { writeState } from "../router";
import { ExportMenu } from "../components/ExportMenu";

export function Community({ groupKey, period }: { groupKey: string | null; period: number | null }) {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    if (!groupKey) return;
    setData(null);
    api.group(groupKey).then(setData);
  }, [groupKey]);
  if (!groupKey) return <div class="text-zinc-500">상단에서 그룹을 선택하세요.</div>;
  if (!data) return <div class="text-zinc-500">Loading…</div>;

  // Apply period filter client-side.
  const cutoff = period ? Date.now() - period * 86400_000 : 0;
  const rows = (data.community_top ?? []).filter((p: any) =>
    !period || (p.posted_at && Date.parse(p.posted_at) >= cutoff)
  );

  return (
    <div class="space-y-4">
      <div class="flex items-center gap-2 text-sm">
        <label class="text-zinc-500">기간</label>
        {[null, 7, 30, 90].map((p) => (
          <button
            key={String(p)}
            class={"rounded border px-2 py-0.5 text-xs " +
                   (period === p
                     ? "border-violet-500 bg-violet-500/10 text-violet-300"
                     : "border-zinc-700 text-zinc-400 hover:bg-zinc-800")}
            onClick={() => writeState({ period: p })}
          >{p ? `${p}일` : "전체"}</button>
        ))}
        <ExportMenu rows={rows} filenameBase={`${groupKey}-community`} />
      </div>
      <table class="w-full text-xs">
        <thead><tr class="text-left text-zinc-500">
          <th class="py-1">#</th><th>Platform</th><th>Title</th>
          <th class="text-right">Views</th><th class="text-right">Likes</th><th>Date</th>
        </tr></thead>
        <tbody>
          {rows.map((p: any, i: number) => (
            <tr key={p.url} class="border-t border-zinc-800/60">
              <td class="py-1">{i + 1}</td>
              <td><span class="rounded bg-zinc-800 px-1.5 text-[10px]">{p.platform}</span></td>
              <td class="max-w-md truncate"><a class="hover:underline" href={p.url} target="_blank">{p.title}</a></td>
              <td class="text-right">{fmt(p.views)}</td>
              <td class="text-right">{fmt(p.likes)}</td>
              <td class="text-zinc-500">{(p.posted_at ?? "").slice(0, 10)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <div class="text-zinc-500">기간 내 게시물 없음.</div>}
    </div>
  );
}
```

- [ ] **Step 2: PRRisk**

```tsx
// frontend/src/views/PRRisk.tsx
import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { KPI } from "../components/KPI";

export function PRRisk({ groupKey }: { groupKey: string | null }) {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    if (!groupKey) return;
    setData(null);
    api.group(groupKey).then(setData);
  }, [groupKey]);
  if (!groupKey) return <div class="text-zinc-500">상단에서 그룹을 선택하세요.</div>;
  if (!data) return <div class="text-zinc-500">Loading…</div>;

  const news = data.naver_articles ?? [];
  const tweets = data.twitter_posts ?? [];
  const controversy = tweets.filter((t: any) => t.type === "controversy").length;
  const riskLevel = controversy >= 3 ? "MED" : controversy >= 1 ? "LOW" : "OK";

  return (
    <div class="space-y-4">
      {controversy > 0 && (
        <div class={"rounded border px-3 py-2 text-sm " +
                    (controversy >= 3
                      ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                      : "border-zinc-700 bg-zinc-900/40 text-zinc-300")}>
          ⚠️ Controversy 트윗 {controversy}건 (Risk: {riskLevel})
        </div>
      )}
      <section class="grid grid-cols-3 gap-2">
        <KPI label="News" value={news.length} />
        <KPI label="Twitter" value={tweets.length} />
        <KPI label="Controversy" value={controversy} hint={`Risk: ${riskLevel}`} />
      </section>
      <section class="rounded-lg border border-zinc-800 p-3">
        <h3 class="mb-2 text-sm font-semibold">최근 뉴스</h3>
        <ul class="space-y-1 text-xs">
          {news.map((n: any, i: number) => (
            <li key={i}>
              <a class="hover:underline" href={n.url} target="_blank">{n.title}</a>
              <span class="ml-2 text-zinc-500">{n.source ?? ""} · {(n.published_at ?? "").slice(0, 10)}</span>
            </li>
          ))}
        </ul>
      </section>
      <section class="rounded-lg border border-zinc-800 p-3">
        <h3 class="mb-2 text-sm font-semibold">트위터/X</h3>
        <ul class="space-y-1 text-xs">
          {tweets.map((t: any) => (
            <li key={t.tweet_id}>
              <span class={"mr-1 rounded px-1.5 text-[10px] " +
                           (t.type === "controversy" ? "bg-red-500/20 text-red-300"
                            : t.type === "news" ? "bg-blue-500/20 text-blue-300"
                            : t.type === "event" ? "bg-emerald-500/20 text-emerald-300"
                            : "bg-zinc-800 text-zinc-400")}>{t.type}</span>
              <a class="hover:underline" href={t.url} target="_blank">{t.title}</a>
              <span class="ml-2 text-zinc-500">@{t.author_handle}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Build + commit**

```bash
cd frontend && npx -y pnpm typecheck && npx -y pnpm build
git add frontend/src/views/Community.tsx frontend/src/views/PRRisk.tsx
git commit -m "feat(frontend): Community + PR&Risk views with period filter and risk banner"
```

---

## Task 15: Cmd/Ctrl+K global search palette

**Files:**
- Create: `frontend/src/components/SearchPalette.tsx`
- Modify: `frontend/src/App.tsx` (mount palette)

- [ ] **Step 1: Implement palette**

```tsx
// frontend/src/components/SearchPalette.tsx
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
```

- [ ] **Step 2: Mount in App**

Edit `frontend/src/App.tsx` — add `<SearchPalette />` inside the root div, after `<Header />`:

```tsx
import { SearchPalette } from "./components/SearchPalette";
// ...
return (
  <div class="min-h-screen">
    <Header state={state} />
    <SearchPalette />
    <main class="mx-auto max-w-7xl p-4">
      ...
    </main>
  </div>
);
```

- [ ] **Step 3: Build + commit**

```bash
cd frontend && npx -y pnpm typecheck && npx -y pnpm build
git add frontend/src/components/SearchPalette.tsx frontend/src/App.tsx
git commit -m "feat(frontend): Cmd/Ctrl+K search palette across groups/members/news/community"
```

---

## Final verification

- [ ] **Step 1: Local build green**

```bash
cd frontend && npx -y pnpm typecheck && npx -y pnpm test && npx -y pnpm build
```

- [ ] **Step 2: Deploy by pushing to main**

```bash
cd /Users/user/Desktop/idol-sight && git push origin main
```

The `frontend-deploy.yml` workflow auto-triggers on `frontend/**` changes.

- [ ] **Step 3: Smoke against deployed URL**

```bash
# Auth
curl -s -c /tmp/c.txt -X POST https://idol-sight.pages.dev/__auth \
  --data-urlencode "password=Virtual2026" -i | head -3

# Each new endpoint
for ep in meta groups market market-share weekly insights health/spec; do
  echo "=== /api/$ep ==="
  curl -s -b /tmp/c.txt "https://idol-sight.pages.dev/api/$ep" | head -c 200
  echo
done

# Group + members + search
curl -s -b /tmp/c.txt "https://idol-sight.pages.dev/api/group/plave" | head -c 200; echo
curl -s -b /tmp/c.txt "https://idol-sight.pages.dev/api/members/plave" | head -c 200; echo
curl -s -b /tmp/c.txt "https://idol-sight.pages.dev/api/search?q=plave" | head -c 200; echo
```

Each should return 200 + JSON.

- [ ] **Step 4: Visit https://idol-sight.pages.dev/ in browser, login `Virtual2026`, verify each tab renders.**

---

## Out of Scope (Plan 5+ candidates)

- naver `parse_safe` 한글 상대시간 처리 fix (Plan 3 follow-up)
- hanteo selector 재조정 (실제 site markup 검증)
- agg_health_scores 호출 추가 (cli.analyze_weekly에서 health_score per group + UPSERT)
- Member solo channel auto-discovery
- 모바일 layout 최적화
- Twitter X API Basic 도입 (nitter 대신)
- E2E playwright 테스트
