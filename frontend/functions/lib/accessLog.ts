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
