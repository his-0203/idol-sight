# 주간 접속 추적 (Weekly Access Tracking) 설계

**작성일**: 2026-06-05
**상태**: 승인됨, 구현 대기
**목적**: 운영자(나)만 볼 수 있는, "서로 다른 사람이 일주일에 몇 번 접속했는지" 측정.

---

## 1. 배경 / 문제

IDOL-SIGHT 는 Cloudflare Pages 에 배포된 Preact SPA + Pages Functions API + D1 구조다.
현재 인증은 **전원이 같은 비밀번호 1개를 공유**하며, 로그인 쿠키(`idol_radar_auth`)도
`auth|<날짜>` 를 HMAC 서명한 값이라 그날 모든 사용자가 동일한 쿠키값을 가진다
(`frontend/functions/__auth.ts`). 따라서 시스템은 구조적으로 "직원 A vs 직원 B" 를
진짜 신원 단위로 구분하지 못한다.

운영자는 진짜 개인 로그인(S급 RBAC) 도입 없이, **브라우저 단위 근사**로
"서로 다른 사람이 주간 몇 번 접속했는지"만 사적으로 확인하면 된다.

## 2. 비목표 (Non-goals)

- 진짜 직원 단위 신원 식별 (그건 로드맵 S급 RBAC + Cloudflare Access 의 몫).
- 앱 화면 내 노출 / 대시보드 KPI 카드. **운영자만** 본다.
- 페이지별 상세 행동 분석, 체류시간, 퍼널. (YAGNI — 접속 횟수만.)

## 3. "접속 1회" 정의

**앱 열기/새로고침(문서 로드) 1회 = 접속 1회.**

- 사이트를 열거나 F5 하면 1회.
- SPA 내부 탭/뷰 이동은 새 문서 요청이 아니므로 같은 방문으로 묶이고 세지 않는다
  → "한 번 접속했다" 는 일상 직관과 일치.
- 정적 자산(JS/CSS/이미지) 요청, `/api/*` 호출, 로그인 화면 표출은 세지 않는다.

## 4. "서로 다른 사람" 정의

**브라우저 단위 근사.** 첫 방문 시 무작위 UUID(`client_id`)를 쿠키로 발급하고,
이후 접속마다 그 id 로 로그를 쌓는다.

- 한 사람이 폰+PC 를 쓰면 2명으로, 쿠키를 지우면 새 사람으로 집계되는 것이 한계.
- 사내 50명 규모 추적에는 충분한 근사치.
- `client_id` 는 무작위 가명값 — 개인정보(PII) 아님. 윤리 가이드라인(본체/2차창작 등)과
  무관한 내부 운영 로그.

## 5. 아키텍처 / 구성요소

### 5.1 DB — `migrations/0079_access_log.sql`

```sql
CREATE TABLE access_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id  TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))  -- UTC ISO8601
);
CREATE INDEX idx_access_log_created_at ON access_log(created_at);
CREATE INDEX idx_access_log_client_id  ON access_log(client_id);
```

- `created_at` 은 UTC. 조회 시 `datetime(created_at, '+9 hours')` 로 KST 변환.

### 5.2 미들웨어 — `frontend/functions/_middleware.ts` (확장)

env 타입에 `DB: D1Database` 추가. 처리 순서:

1. **client_id 보장**: 요청에 `idol_radar_cid` 쿠키가 없으면 `crypto.randomUUID()` 로
   생성. 응답에 `Set-Cookie: idol_radar_cid=<id>; Path=/; HttpOnly; Secure; SameSite=Lax;
   Max-Age=31536000`(1년) 추가. 있으면 그 값을 사용.
2. **기존 `/api/` 인증 로직 유지**: 미인증 `/api/*` 요청은 그대로 401.
3. **접속 로깅**: 요청이 *문서 로드* 이고 *로그인 쿠키가 유효* 하면
   `ctx.waitUntil(db.prepare('INSERT INTO access_log(client_id) VALUES (?)').bind(cid).run())`
   로 비차단 기록.
   - *문서 로드* 판정: `Sec-Fetch-Dest === 'document'` 또는 `Accept` 헤더에 `text/html`
     포함. 경로가 `/api/`, `/__auth`, `/assets`, `/admin` 로 시작하지 않을 것.
   - *로그인 유효* 판정: 기존 `hmacVerify(COOKIE_SECRET, sig, 'auth|'+dayBucket())` 재사용.
4. 쿠키를 새로 발급해야 하면 `next()` 응답을 복제해 `Set-Cookie` 헤더를 덧붙여 반환.

> 미들웨어는 정적 자산 포함 모든 요청을 거치지만, 쿠키 파싱 외 추가 작업은
> 문서 로드 + 인증된 경우에만 발생하므로 오버헤드는 미미하다.

### 5.3 숨겨진 관리자 페이지 — `frontend/functions/admin/access.ts`

- 경로: `/admin/access?key=<ADMIN_KEY>` (`onRequestGet`).
- env `ADMIN_KEY` 와 query `key` 를 **상수시간 비교**. 불일치/누락 시 **404**
  (존재 자체를 숨김).
- `/admin/*` 은 미들웨어의 비-api 분기를 그대로 통과(접속 로깅 대상에서 제외 — 위 5.2.3).
- 출력: 간단한 HTML(content-type text/html), KST 기준 표 2개.
  1. **주별 요약** — 최근 8주, 각 주의 `(고유 방문자 수, 총 접속 수)`.
  2. **이번 주 사람별** — `client_id` 별 접속 횟수 내림차순.
     - 표시는 `client_id` 앞 6자 등 축약(`#a37c91`)으로.

쿼리 예 (주별 요약):
```sql
SELECT strftime('%Y-%W', datetime(created_at,'+9 hours')) AS wk,
       COUNT(DISTINCT client_id) AS visitors,
       COUNT(*) AS hits
FROM access_log
GROUP BY wk ORDER BY wk DESC LIMIT 8;
```
이번 주 사람별:
```sql
SELECT client_id, COUNT(*) AS hits
FROM access_log
WHERE strftime('%Y-%W', datetime(created_at,'+9 hours'))
    = strftime('%Y-%W', datetime('now','+9 hours'))
GROUP BY client_id ORDER BY hits DESC;
```

### 5.4 시크릿 — `ADMIN_KEY`

- Cloudflare Pages 프로젝트 환경변수에 등록(운영자가 직접). 저장소 커밋 금지.
- 추측 어려운 랜덤 문자열.

## 6. 데이터 흐름

```
브라우저가 사이트 열기
  └─ _middleware: cid 쿠키 없으면 발급(Set-Cookie) → next()
  └─ 문서 로드 + 로그인 유효? → waitUntil INSERT access_log(cid)

운영자가 /admin/access?key=… 열기
  └─ admin/access.ts: key 검증(틀리면 404)
  └─ D1 집계 쿼리 2건 → HTML 표 반환
```

## 7. 에러 처리

- 로깅 INSERT 실패는 `waitUntil` 내부에서 삼킴 — 사용자 응답에 영향 없음.
- `ADMIN_KEY` env 미설정 시 admin 페이지는 500이 아니라 **404**(존재 은닉 유지).
- D1 미바인딩 환경(로컬 등)에서 미들웨어가 깨지지 않도록 `env.DB` 존재 가드.

## 8. 테스트 / 검증

- `/admin/access` 키 없이/틀린 키 → 404, 맞는 키 → 표 렌더 확인.
- 로그인 후 새로고침 N회 → 해당 cid hits 가 N 증가.
- 정적 자산 요청·API 호출이 hits 를 늘리지 않음 확인.
- 미인증 상태(로그인 화면)에서 새로고침은 집계되지 않음 확인.
- migration 로컬 적용: `wrangler d1 migrations apply idol-sight --local`.

## 9. 향후 (out of scope, 메모만)

- 진짜 개인 단위가 필요해지면 Cloudflare Access / per-user 로그인으로 `client_id` 를
  실 신원에 매핑. 그때 `access_log` 스키마는 그대로 재사용 가능.
