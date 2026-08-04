import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";

// 월간 보고서 — 사전 렌더·동결본(monthly_reports, worker monthly-report 커맨드
// 적재) 서빙. v2(2026-08-04): 내부/투자사 2판 → 종합 단일판(edition='full').
// /api/* 는 _middleware 가 HMAC 쿠키를 일괄 검증하므로 추가 인증 불필요.
//
//   ?list=1            → 준비된 월 목록 (버튼 상태용)
//   ?month=2026-07     → text/html attachment

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async (
  { env, request },
) => {
  const url = new URL(request.url);

  if (url.searchParams.get("list")) {
    const rows = await d1Query<{
      month: string; generated_at: string; size_bytes: number;
    }>(env.DB,
      `SELECT month, generated_at, size_bytes FROM monthly_reports
        WHERE edition = 'full' ORDER BY month DESC`);
    return jsonResponse({ reports: rows });
  }

  const month = url.searchParams.get("month") ?? "";
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return jsonResponse({ error: "month=YYYY-MM" }, 400);
  }
  const rows = await d1Query<{ html: string }>(env.DB,
    "SELECT html FROM monthly_reports WHERE month=? AND edition='full'",
    [month]);
  if (!rows.length) return jsonResponse({ error: "not_generated" }, 404);
  return new Response(rows[0]!.html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-disposition":
        `attachment; filename="miiwan-monthly-${month}.html"`,
      "cache-control": "private, no-store",
    },
  });
};
