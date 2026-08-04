import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";

// 월간 보고서 — 사전 렌더·동결본(monthly_reports, worker monthly-report 커맨드
// 적재) 서빙. /api/* 는 _middleware 가 HMAC 쿠키를 일괄 검증하므로 여기서
// 추가 인증 불필요. 같은 오리진 <a href> 다운로드에 쿠키가 실린다.
//
//   ?list=1                       → 준비된 (month, edition) 목록 (버튼 상태용)
//   ?month=2026-07&edition=internal|investor → text/html attachment

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async (
  { env, request },
) => {
  const url = new URL(request.url);

  if (url.searchParams.get("list")) {
    const rows = await d1Query<{
      month: string; edition: string; generated_at: string;
      size_bytes: number; meta_json: string | null;
    }>(env.DB,
      `SELECT month, edition, generated_at, size_bytes, meta_json
         FROM monthly_reports ORDER BY month DESC, edition ASC`);
    return jsonResponse({
      reports: rows.map((r) => ({
        month: r.month, edition: r.edition, generated_at: r.generated_at,
        size_bytes: r.size_bytes,
        draft: (() => {
          try { return Boolean(JSON.parse(r.meta_json ?? "{}").draft); }
          catch { return false; }
        })(),
      })),
    });
  }

  const month = url.searchParams.get("month") ?? "";
  const edition = url.searchParams.get("edition") ?? "internal";
  if (!/^\d{4}-\d{2}$/.test(month) || !["internal", "investor"].includes(edition)) {
    return jsonResponse({ error: "month=YYYY-MM & edition=internal|investor" }, 400);
  }
  const rows = await d1Query<{ html: string }>(env.DB,
    "SELECT html FROM monthly_reports WHERE month=? AND edition=?",
    [month, edition]);
  if (!rows.length) return jsonResponse({ error: "not_generated" }, 404);
  return new Response(rows[0]!.html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-disposition":
        `attachment; filename="miiwan-monthly-${month}-${edition}.html"`,
      "cache-control": "private, no-store",
    },
  });
};
