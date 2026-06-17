// /api/miiwan-live-chat — 라이브 채팅 리포트. 달력 UI 를 위해 두 갈래로 응답:
//   - available: 리포트가 있는 모든 방송의 (video_id, title, ended_at) — report_json
//     없이 가벼움. "라이브가 있었던 날짜"를 달력에 점등하는 데 쓴다.
//   - report: 선택된 방송 1건의 풀 바디(report_json 파싱 포함). ?video_id 미지정 시
//     가장 최근(ended_at DESC) 방송. 데이터 없으면 null.
import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";

const TARGET = "miiwan";

interface AvailRow {
  video_id: string;
  title: string | null;
  ended_at: string | null;
}

interface ReportRow extends AvailRow {
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

function mapReport(r: ReportRow) {
  return {
    video_id: r.video_id,
    title: r.title,
    ended_at: r.ended_at,
    generated_at: r.generated_at,
    total_messages: r.total_messages,
    sampled: r.sampled,
    positive_ratio: r.positive_ratio,
    negative_ratio: r.negative_ratio,
    report: safeParse(r.report_json),
  };
}

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env, request }) => {
  const wanted = new URL(request.url).searchParams.get("video_id");

  // 달력용 전체 날짜(가벼움). 테이블 미적용/빈 데이터 → graceful.
  let available: AvailRow[] = [];
  try {
    available = await d1Query<AvailRow>(
      env.DB,
      `SELECT video_id, title, ended_at
         FROM live_chat_reports
        WHERE group_key = ?
        ORDER BY ended_at DESC`,
      [TARGET],
    );
  } catch {
    available = [];
  }

  // 선택 방송(미지정 시 최신) 1건의 풀 리포트.
  const targetId = wanted ?? available[0]?.video_id ?? null;
  let report: ReturnType<typeof mapReport> | null = null;
  if (targetId) {
    try {
      const rows = await d1Query<ReportRow>(
        env.DB,
        `SELECT video_id, title, ended_at, generated_at, total_messages,
                sampled, positive_ratio, negative_ratio, report_json
           FROM live_chat_reports
          WHERE group_key = ? AND video_id = ?
          LIMIT 1`,
        [TARGET, targetId],
      );
      if (rows[0]) report = mapReport(rows[0]);
    } catch {
      report = null;
    }
  }

  return jsonResponse({ available, report });
};
