# 주간 접속 추적 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 운영자만 볼 수 있는 숨겨진 관리자 URL로, 브라우저 단위 근사를 통해 "서로 다른 사람이 주간 몇 번 접속했는지" 측정한다.

**Architecture:** Pages Functions 미들웨어가 첫 방문 시 무작위 `client_id` 쿠키를 발급하고, 로그인된 문서 로드(앱 열기/새로고침)마다 D1 `access_log` 에 비차단 기록한다. 숨겨진 `/admin/access?key=…` 함수가 D1을 KST 기준으로 집계해 HTML 표로 반환한다.

**Tech Stack:** Cloudflare Pages Functions (TypeScript), D1, vitest. 순수 헬퍼는 단위 테스트, 미들웨어/관리자 함수는 mock D1 + Request 로 테스트.

**Spec:** `docs/superpowers/specs/2026-06-05-weekly-access-tracking-design.md`

---

## File Structure

**생성:**
- `migrations/0079_access_log.sql` — `access_log` 테이블 + 인덱스
- `frontend/functions/lib/accessLog.ts` — 순수 헬퍼 (쿠키명 상수, document 판정, cid 축약, 상수시간 키 비교, HTML 렌더)
- `frontend/functions/admin/access.ts` — 숨겨진 관리자 페이지 (`onRequestGet`)
- `frontend/tests/functions/accessLog.test.ts` — 순수 헬퍼 단위 테스트
- `frontend/tests/functions/admin_access.test.ts` — 관리자 함수 테스트

**수정:**
- `frontend/functions/lib/d1.ts` — `D1PreparedStatement` 인터페이스에 `run()` 추가
- `frontend/functions/_middleware.ts` — cid 쿠키 발급 + 접속 로깅
- `frontend/tests/functions/middleware.test.ts` — cid 쿠키/로깅 테스트 추가
- `CLAUDE.md` — V2.35 상태 항목 추가
- `docs/onboarding.md` — `ADMIN_KEY` 시크릿 안내 (해당 섹션 있으면)

---

## Task 1: D1 마이그레이션 `access_log`

**Files:**
- Create: `migrations/0079_access_log.sql`

- [ ] **Step 1: 마이그레이션 SQL 작성**

```sql
-- 0079_access_log.sql
-- 운영자 전용 주간 접속 추적. client_id 는 무작위 UUID(가명) — PII 아님.
CREATE TABLE IF NOT EXISTS access_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id  TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))  -- UTC ISO8601
);
CREATE INDEX IF NOT EXISTS idx_access_log_created_at ON access_log(created_at);
CREATE INDEX IF NOT EXISTS idx_access_log_client_id  ON access_log(client_id);
```

- [ ] **Step 2: 로컬 적용으로 SQL 검증**

Run: `cd frontend && wrangler d1 migrations apply idol-sight --local`
Expected: `0079_access_log.sql` 항목이 성공(✅)으로 적용됨. 에러 없음.

- [ ] **Step 3: 커밋**

```bash
git add migrations/0079_access_log.sql
git commit -m "feat(access-tracking): add access_log migration 0079"
```

> 원격 적용(`--remote`)은 운영자가 직접 실행한다 (메모리: D1 원격 apply 는 운영자 전담). 이 플랜에서는 로컬까지만.

---

## Task 2: 순수 헬퍼 `accessLog.ts` (TDD)

**Files:**
- Create: `frontend/functions/lib/accessLog.ts`
- Test: `frontend/tests/functions/accessLog.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/tests/functions/accessLog.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  ACCESS_COOKIE,
  isDocumentLoad,
  shortCid,
  safeKeyEqual,
  renderAdminHtml,
} from "../../functions/lib/accessLog";

const docReq = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  new Request(`https://x${path}`, { method, headers });

describe("accessLog helpers", () => {
  it("ACCESS_COOKIE name is stable", () => {
    expect(ACCESS_COOKIE).toBe("idol_radar_cid");
  });

  describe("isDocumentLoad", () => {
    it("true for GET document navigation", () => {
      expect(isDocumentLoad(docReq("/", { "sec-fetch-dest": "document" }), "/")).toBe(true);
    });
    it("true for GET with text/html accept and no sec-fetch-dest", () => {
      expect(isDocumentLoad(docReq("/group/plave", { accept: "text/html,*/*" }), "/group/plave")).toBe(true);
    });
    it("false for non-GET", () => {
      expect(isDocumentLoad(docReq("/", { "sec-fetch-dest": "document" }, "POST"), "/")).toBe(false);
    });
    it("false for /api paths", () => {
      expect(isDocumentLoad(docReq("/api/ping", { "sec-fetch-dest": "document" }), "/api/ping")).toBe(false);
    });
    it("false for /admin paths", () => {
      expect(isDocumentLoad(docReq("/admin/access", { "sec-fetch-dest": "document" }), "/admin/access")).toBe(false);
    });
    it("false for /assets and /__auth", () => {
      expect(isDocumentLoad(docReq("/assets/app.js", { "sec-fetch-dest": "script" }), "/assets/app.js")).toBe(false);
      expect(isDocumentLoad(docReq("/__auth", { "sec-fetch-dest": "document" }), "/__auth")).toBe(false);
    });
    it("false when neither sec-fetch-dest nor html accept present", () => {
      expect(isDocumentLoad(docReq("/foo"), "/foo")).toBe(false);
    });
  });

  describe("shortCid", () => {
    it("strips dashes and takes first 6 hex", () => {
      expect(shortCid("abcdef12-3456-7890-abcd-ef1234567890")).toBe("#abcdef");
    });
  });

  describe("safeKeyEqual", () => {
    it("true for equal", () => expect(safeKeyEqual("s3cret", "s3cret")).toBe(true));
    it("false for different value", () => expect(safeKeyEqual("s3cret", "s3creT")).toBe(false));
    it("false for different length", () => expect(safeKeyEqual("ab", "abc")).toBe(false));
    it("false for empty vs nonempty", () => expect(safeKeyEqual("", "x")).toBe(false));
  });

  describe("renderAdminHtml", () => {
    it("renders weekly + per-person numbers", () => {
      const html = renderAdminHtml(
        [{ wk: "2026-22", visitors: 12, hits: 80 }],
        [{ cid: "#abc123", hits: 9 }],
      );
      expect(html).toContain("2026-22");
      expect(html).toContain("12");
      expect(html).toContain("#abc123");
      expect(html).toContain("9");
    });
    it("shows 데이터 없음 when empty", () => {
      const html = renderAdminHtml([], []);
      expect(html).toContain("데이터 없음");
    });
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd frontend && pnpm test -- accessLog`
Expected: FAIL — `Cannot find module '../../functions/lib/accessLog'`

- [ ] **Step 3: `accessLog.ts` 구현**

`frontend/functions/lib/accessLog.ts`:
```ts
// 운영자 전용 접속 추적용 순수 헬퍼. Cloudflare 런타임 의존 없음 → 단위 테스트 가능.

export const ACCESS_COOKIE = "idol_radar_cid";

const EXCLUDED_PREFIXES = ["/api/", "/__auth", "/admin", "/assets"];

/** 앱 열기/새로고침(top-level document GET)인지 판정. 정적 자산·API·관리자·인증은 제외. */
export function isDocumentLoad(request: Request, pathname: string): boolean {
  if (request.method !== "GET") return false;
  if (EXCLUDED_PREFIXES.some((p) => pathname.startsWith(p))) return false;
  const dest = request.headers.get("sec-fetch-dest");
  if (dest) return dest === "document";
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/html");
}

/** 무작위 client_id 발급 (Cloudflare/Web Crypto 런타임 제공). */
export function newClientId(): string {
  return crypto.randomUUID();
}

/** 표시용 축약: 대시 제거 후 앞 6자에 '#' 접두. */
export function shortCid(cid: string): string {
  return "#" + cid.replace(/-/g, "").slice(0, 6);
}

/** 관리자 키 상수시간 비교(길이 다르면 즉시 false — 기존 hmac 패턴과 동일). */
export function safeKeyEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ea = enc.encode(a);
  const eb = enc.encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i]! ^ eb[i]!;
  return diff === 0;
}

/** 관리자 페이지 HTML. 입력은 이미 집계·축약된 행들. */
export function renderAdminHtml(
  weekly: { wk: string; visitors: number; hits: number }[],
  perPerson: { cid: string; hits: number }[],
): string {
  const wRows = weekly
    .map((w) => `<tr><td>${w.wk}</td><td>${w.visitors}</td><td>${w.hits}</td></tr>`)
    .join("");
  const pRows = perPerson
    .map((p) => `<tr><td>${p.cid}</td><td>${p.hits}</td></tr>`)
    .join("");
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>접속 통계</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
table{border-collapse:collapse;width:100%;margin:.75rem 0}
th,td{border:1px solid #ddd;padding:.4rem .6rem;text-align:left}
th{background:#f4f4f4}h2{margin-top:2rem;font-size:1.1rem}
small{color:#888}</style></head><body>
<h1>접속 통계 <small>(브라우저 단위 근사 · KST)</small></h1>
<h2>주별 요약 (최근 8주)</h2>
<table><thead><tr><th>주(年-주차)</th><th>고유 방문자</th><th>총 접속</th></tr></thead>
<tbody>${wRows || '<tr><td colspan="3">데이터 없음</td></tr>'}</tbody></table>
<h2>이번 주 사람별</h2>
<table><thead><tr><th>사람</th><th>접속 횟수</th></tr></thead>
<tbody>${pRows || '<tr><td colspan="2">데이터 없음</td></tr>'}</tbody></table>
</body></html>`;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd frontend && pnpm test -- accessLog`
Expected: PASS (모든 케이스)

- [ ] **Step 5: 커밋**

```bash
git add frontend/functions/lib/accessLog.ts frontend/tests/functions/accessLog.test.ts
git commit -m "feat(access-tracking): add accessLog pure helpers"
```

---

## Task 3: D1 인터페이스에 `run()` 추가

**Files:**
- Modify: `frontend/functions/lib/d1.ts`

- [ ] **Step 1: `D1PreparedStatement` 인터페이스에 `run()` 추가**

`frontend/functions/lib/d1.ts` 의 인터페이스를 다음으로 교체:
```ts
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = unknown>(): Promise<{ results: T[] }>;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<unknown>;
}
```

- [ ] **Step 2: 타입 체크 통과 확인**

Run: `cd frontend && pnpm typecheck`
Expected: 에러 없음 (기존 사용처는 `run()` 미사용이라 영향 없음)

- [ ] **Step 3: 커밋**

```bash
git add frontend/functions/lib/d1.ts
git commit -m "feat(access-tracking): add run() to D1PreparedStatement type"
```

---

## Task 4: 미들웨어 — cid 쿠키 + 접속 로깅 (TDD)

**Files:**
- Modify: `frontend/functions/_middleware.ts`
- Test: `frontend/tests/functions/middleware.test.ts`

- [ ] **Step 1: 실패하는 테스트 추가**

`frontend/tests/functions/middleware.test.ts` 상단 import 를 다음으로 교체:
```ts
import { describe, expect, it, vi } from "vitest";
import { onRequest } from "../../functions/_middleware";
import { hmacSign } from "../../functions/lib/hmac";
import { dayBucket } from "../../functions/lib/cookies";

const ENV = { COOKIE_SECRET: "0123456789abcdef0123456789abcdef" } as any;

const next = vi.fn(async () => new Response("ok"));

function dbMock() {
  const run = vi.fn(async () => ({}));
  const bind = vi.fn(() => ({ run }));
  const prepare = vi.fn(() => ({ bind }));
  return { DB: { prepare }, run, bind, prepare };
}
```

같은 파일 맨 아래 `describe("_middleware", …)` 블록 닫힌 직후에 새 describe 추가:
```ts
describe("_middleware access tracking", () => {
  it("sets a cid cookie when absent", async () => {
    next.mockClear();
    const res = await onRequest({
      request: new Request("https://x/somepage.html"),
      next,
      env: ENV,
    } as any);
    expect(res.headers.get("set-cookie") ?? "").toContain("idol_radar_cid=");
  });

  it("does NOT reset cid cookie when already present", async () => {
    next.mockClear();
    const res = await onRequest({
      request: new Request("https://x/somepage.html", {
        headers: { cookie: "idol_radar_cid=keep-me" },
      }),
      next,
      env: ENV,
    } as any);
    expect(res.headers.get("set-cookie") ?? "").not.toContain("idol_radar_cid=");
  });

  it("logs a visit on authed document load", async () => {
    next.mockClear();
    const db = dbMock();
    const sig = await hmacSign(ENV.COOKIE_SECRET, `auth|${dayBucket()}`);
    const tasks: Promise<unknown>[] = [];
    await onRequest({
      request: new Request("https://x/", {
        headers: {
          cookie: `idol_radar_auth=${sig}; idol_radar_cid=abc-123`,
          "sec-fetch-dest": "document",
        },
      }),
      next,
      env: { ...ENV, ...db },
      waitUntil: (p: Promise<unknown>) => tasks.push(p),
    } as any);
    await Promise.all(tasks);
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO access_log"),
    );
    expect(db.bind).toHaveBeenCalledWith("abc-123");
  });

  it("does NOT log for /api requests", async () => {
    next.mockClear();
    const db = dbMock();
    const sig = await hmacSign(ENV.COOKIE_SECRET, `auth|${dayBucket()}`);
    await onRequest({
      request: new Request("https://x/api/ping", {
        headers: { cookie: `idol_radar_auth=${sig}; idol_radar_cid=abc-123` },
      }),
      next,
      env: { ...ENV, ...db },
      waitUntil: (p: Promise<unknown>) => p,
    } as any);
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it("does NOT log on document load when unauthenticated", async () => {
    next.mockClear();
    const db = dbMock();
    await onRequest({
      request: new Request("https://x/", {
        headers: { "sec-fetch-dest": "document", cookie: "idol_radar_cid=abc-123" },
      }),
      next,
      env: { ...ENV, ...db },
      waitUntil: (p: Promise<unknown>) => p,
    } as any);
    expect(db.prepare).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd frontend && pnpm test -- middleware`
Expected: FAIL — 새 describe 의 cid/logging 케이스 실패 (기존 미들웨어는 cid·로깅 미구현)

- [ ] **Step 3: 미들웨어 구현**

`frontend/functions/_middleware.ts` 전체를 다음으로 교체:
```ts
import { hmacVerify } from "./lib/hmac";
import { dayBucket, getCookie } from "./lib/cookies";
import { ACCESS_COOKIE, isDocumentLoad, newClientId } from "./lib/accessLog";
import type { D1Database } from "./lib/d1";

type Env = {
  COOKIE_SECRET: string;
  DB?: D1Database;
};

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const { request, next, env } = ctx;
  const url = new URL(request.url);

  const isApi =
    url.pathname.startsWith("/api/") && !url.pathname.startsWith("/__auth");

  // 인증 여부 판정 — 비용을 아끼려 필요한 경우(API 또는 문서 로드)에만 HMAC 검증.
  const docLoad = isDocumentLoad(request, url.pathname);
  let authed = false;
  if (isApi || docLoad) {
    const sig = getCookie(request, "idol_radar_auth");
    if (sig) authed = await hmacVerify(env.COOKIE_SECRET, sig, `auth|${dayBucket()}`);
  }

  // 기존 동작: 미인증 /api/* 는 401 (cid 쿠키 발급 전에 즉시 차단).
  if (isApi && !authed) return new Response("unauth", { status: 401 });

  // client_id 쿠키 보장 — 없으면 새로 발급.
  let cid = getCookie(request, ACCESS_COOKIE);
  const newCid = !cid;
  if (!cid) cid = newClientId();

  // 접속 로깅: 로그인된 문서 로드만, 비차단.
  if (authed && docLoad && env.DB) {
    const p = env.DB.prepare("INSERT INTO access_log (client_id) VALUES (?)")
      .bind(cid)
      .run()
      .catch(() => {});
    if (ctx.waitUntil) ctx.waitUntil(p);
    else await p;
  }

  const res = await next();
  if (newCid) {
    const out = new Response(res.body, res);
    out.headers.append(
      "Set-Cookie",
      `${ACCESS_COOKIE}=${cid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`,
    );
    return out;
  }
  return res;
};
```

- [ ] **Step 4: 테스트 통과 확인 (신규 + 기존 회귀)**

Run: `cd frontend && pnpm test -- middleware`
Expected: PASS — 신규 access tracking 5건 + 기존 `_middleware` 5건 모두 통과

- [ ] **Step 5: 커밋**

```bash
git add frontend/functions/_middleware.ts frontend/tests/functions/middleware.test.ts
git commit -m "feat(access-tracking): cid cookie + visit logging in middleware"
```

---

## Task 5: 숨겨진 관리자 페이지 `/admin/access` (TDD)

**Files:**
- Create: `frontend/functions/admin/access.ts`
- Test: `frontend/tests/functions/admin_access.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/tests/functions/admin_access.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { onRequestGet } from "../../functions/admin/access";

const ADMIN_KEY = "s3cret-admin-key";

const envWith = (h: (sql: string) => any[], adminKey: string | undefined = ADMIN_KEY) =>
  ({
    ADMIN_KEY: adminKey,
    DB: {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn(async () => ({ results: h(sql) })),
        first: vi.fn(async () => h(sql)[0] ?? null),
      })),
    },
  }) as any;

const rows = (sql: string) => {
  if (sql.includes("COUNT(DISTINCT client_id)")) {
    return [{ wk: "2026-22", visitors: 12, hits: 80 }];
  }
  if (sql.includes("GROUP BY client_id")) {
    return [{ client_id: "abc123def-456-789", hits: 9 }];
  }
  return [];
};

// adminKey: env 의 ADMIN_KEY 값. "" 를 넘기면 env 미설정(falsy) 상황을 재현.
const call = (key: string | null, adminKey: string = ADMIN_KEY) =>
  onRequestGet({
    env: envWith(rows, adminKey),
    request: new Request(
      `https://x/admin/access${key === null ? "" : `?key=${encodeURIComponent(key)}`}`,
    ),
  } as any);

describe("/admin/access", () => {
  it("404 when key missing", async () => {
    expect((await call(null)).status).toBe(404);
  });
  it("404 when key wrong", async () => {
    expect((await call("nope")).status).toBe(404);
  });
  it("404 when ADMIN_KEY env unset (even with a key)", async () => {
    expect((await call(ADMIN_KEY, "")).status).toBe(404);
  });
  it("200 + HTML with stats when key correct", async () => {
    const res = await call(ADMIN_KEY);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("2026-22");
    expect(body).toContain("12");
    expect(body).toContain("#abc123");
    expect(body).toContain("9");
  });
});
```

> 참고: "env unset" 케이스는 `adminKey` 인자를 빈 문자열로 넘겨 `env.ADMIN_KEY` 가 falsy 인 상황을 재현한다.

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd frontend && pnpm test -- admin_access`
Expected: FAIL — `Cannot find module '../../functions/admin/access'`

- [ ] **Step 3: 관리자 함수 구현**

`frontend/functions/admin/access.ts`:
```ts
import { d1Query, type D1Database } from "../lib/d1";
import { renderAdminHtml, safeKeyEqual, shortCid } from "../lib/accessLog";

type Env = { DB: D1Database; ADMIN_KEY?: string };

const notFound = () => new Response("Not Found", { status: 404 });

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const key = new URL(request.url).searchParams.get("key") ?? "";
  // env 미설정 시에도 404 — 존재 자체를 숨긴다.
  if (!env.ADMIN_KEY || !safeKeyEqual(key, env.ADMIN_KEY)) return notFound();

  const weekly = await d1Query<{ wk: string; visitors: number; hits: number }>(
    env.DB,
    `SELECT strftime('%Y-%W', datetime(created_at, '+9 hours')) AS wk,
            COUNT(DISTINCT client_id) AS visitors,
            COUNT(*) AS hits
       FROM access_log
      GROUP BY wk
      ORDER BY wk DESC
      LIMIT 8`,
  );

  const perPersonRaw = await d1Query<{ client_id: string; hits: number }>(
    env.DB,
    `SELECT client_id, COUNT(*) AS hits
       FROM access_log
      WHERE strftime('%Y-%W', datetime(created_at, '+9 hours'))
          = strftime('%Y-%W', datetime('now', '+9 hours'))
      GROUP BY client_id
      ORDER BY hits DESC`,
  );

  const perPerson = perPersonRaw.map((r) => ({ cid: shortCid(r.client_id), hits: r.hits }));
  const html = renderAdminHtml(weekly, perPerson);
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
};
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd frontend && pnpm test -- admin_access`
Expected: PASS (4건)

- [ ] **Step 5: 커밋**

```bash
git add frontend/functions/admin/access.ts frontend/tests/functions/admin_access.test.ts
git commit -m "feat(access-tracking): hidden /admin/access weekly stats page"
```

---

## Task 6: 전체 검증 + 문서/시크릿 안내

**Files:**
- Modify: `CLAUDE.md` (V2.35 항목)
- Modify: `docs/onboarding.md` (ADMIN_KEY 안내 — 시크릿 목록 섹션이 있으면)

- [ ] **Step 1: 전체 테스트 + 타입체크**

Run: `cd frontend && pnpm test && pnpm typecheck`
Expected: 전부 PASS, 타입 에러 없음

- [ ] **Step 2: CLAUDE.md 에 V2.35 상태 항목 추가**

`CLAUDE.md` 의 "V2.5 현재 상태" 적용 완료 목록 맨 아래(V2.34 항목 다음)에 추가:
```markdown
- **V2.35 (2026-06-05)**: 운영자 전용 주간 접속 추적 (migration 0079). 단일 공유 비밀번호 구조상 진짜 직원 단위 식별은 불가 → **브라우저 단위 근사**. 첫 방문 시 `_middleware.ts` 가 무작위 `idol_radar_cid` 쿠키(1년) 발급, 로그인된 *문서 로드*(앱 열기/새로고침)마다 `access_log` 에 `ctx.waitUntil` 비차단 INSERT (정적자산·API·로그인화면 제외). 숨겨진 `/admin/access?key=<ADMIN_KEY>` (`functions/admin/access.ts`) 가 KST 기준 주별 요약(최근 8주 고유 방문자/총 접속) + 이번 주 cid별 횟수를 HTML 표로 반환, 키 불일치/미설정 시 404로 존재 은닉. 순수 로직은 `functions/lib/accessLog.ts` 로 분리해 단위 테스트. 신규 시크릿 `ADMIN_KEY` 는 Cloudflare Pages 환경변수 등록 필요.
```

- [ ] **Step 3: onboarding 시크릿 목록에 ADMIN_KEY 추가 (해당 섹션 존재 시)**

`docs/onboarding.md` 에서 시크릿(`COOKIE_SECRET` 등)을 나열한 부분을 찾는다.
Run: `grep -n "COOKIE_SECRET" docs/onboarding.md`
존재하면 그 목록에 한 줄 추가 (Cloudflare Pages 환경변수 전용, GitHub Secrets 불필요):
```markdown
- `ADMIN_KEY` — 숨겨진 접속통계 페이지 `/admin/access?key=…` 보호용 랜덤 키 (Cloudflare Pages 환경변수에만 등록).
```
존재하지 않으면 이 스텝은 건너뛴다 (onboarding 구조 변경 금지).

- [ ] **Step 4: 커밋**

```bash
git add CLAUDE.md docs/onboarding.md
git commit -m "docs(access-tracking): record V2.35 + ADMIN_KEY secret"
```

- [ ] **Step 5: 운영자 후속 작업 안내 (코드 아님 — 실행자는 사용자에게 전달)**

다음을 운영자에게 안내한다(직접 실행하지 말 것):
1. Cloudflare Pages 프로젝트 → Settings → Environment variables 에 `ADMIN_KEY` (추측 어려운 랜덤 문자열) 등록.
2. 로컬 dev 로 관리자 페이지를 보려면 `frontend/.dev.vars` 에 `ADMIN_KEY=...` 추가(gitignore 됨).
3. 원격 D1 마이그레이션 적용:
   `! cd frontend && wrangler d1 migrations apply idol-sight --remote`
4. 배포 후 `https://<사이트>/admin/access?key=<ADMIN_KEY>` 접속해 표 렌더 확인.

---

## Self-Review (작성자 체크 완료)

- **Spec 커버리지**: §5.1 DB→T1, §5.2 미들웨어(cid·로깅·인증가드)→T4, §5.3 관리자페이지(404은닉·KST집계·HTML)→T5, §5.4 ADMIN_KEY→T6, §3 문서로드 정의/§4 cid 근사→T2(`isDocumentLoad`/`shortCid`), §7 에러처리(waitUntil 삼킴·env가드·404)→T4·T5 코드. 전부 매핑됨.
- **Placeholder 스캔**: 모든 코드/명령/기대값 실재. TODO 없음.
- **타입 일관성**: `ACCESS_COOKIE`="idol_radar_cid", `isDocumentLoad(request,pathname)`, `shortCid`→`#`+6hex, `renderAdminHtml(weekly[],perPerson[{cid,hits}])`, `safeKeyEqual(a,b)`, D1 `run()` 추가 — 미들웨어/관리자/테스트 전반에서 시그니처 일치.
