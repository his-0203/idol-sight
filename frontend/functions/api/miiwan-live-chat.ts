// /api/miiwan-live-chat — 최근 라이브 채팅 리포트(방송별). 데이터 없으면 빈 배열.
import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";

const TARGET = "miiwan";
const LIMIT = 10;

interface ReportRow {
  video_id: string;
  title: string | null;
  ended_at: string | null;
  generated_at: string;
  total_messages: number;
  sampled: number;
  positive_ratio: number | null;
  negative_ratio: number | null;
  report_json: string;
}

function safeParse(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env }) => {
  let rows: ReportRow[] = [];
  try {
    rows = await d1Query<ReportRow>(
      env.DB,
      `SELECT video_id, title, ended_at, generated_at, total_messages,
              sampled, positive_ratio, negative_ratio, report_json
         FROM live_chat_reports
        WHERE group_key = ?
        ORDER BY ended_at DESC
        LIMIT ?`,
      [TARGET, LIMIT],
    );
  } catch {
    rows = []; // 테이블 미적용/빈 데이터 → graceful (miiwan.ts partial 패턴)
  }
  // report_json 은 문자열 → 파싱해서 내려보냄(프론트 편의)
  const reports = rows.map((r) => ({
    video_id: r.video_id,
    title: r.title,
    ended_at: r.ended_at,
    generated_at: r.generated_at,
    total_messages: r.total_messages,
    sampled: r.sampled,
    positive_ratio: r.positive_ratio,
    negative_ratio: r.negative_ratio,
    report: safeParse(r.report_json),
  }));
  return jsonResponse({ reports });
};
