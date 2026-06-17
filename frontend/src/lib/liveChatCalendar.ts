// 라이브 채팅 달력용 순수 헬퍼.
//   - monthMatrix: 일요일 시작 월 격자(YYYY-MM-DD | null 패딩).
//   - liveDateIndex: 리포트 ended_at(UTC) 을 KST 날짜로 묶어 점등 Set + 날짜→video_id 매핑.
import { formatKSTDate } from "./datetime";

export interface AvailEntry {
  video_id: string;
  title: string | null;
  ended_at: string | null;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** year/month0(0-based) 의 일요일 시작 주 배열. 각 칸은 `YYYY-MM-DD` 또는 null. */
export function monthMatrix(year: number, month0: number): (string | null)[][] {
  const first = new Date(Date.UTC(year, month0, 1));
  const startDow = first.getUTCDay(); // 0=일
  const daysInMonth = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  const cells: (string | null)[] = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(`${year}-${pad2(month0 + 1)}-${pad2(d)}`);
  }
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** 리포트 목록 → { dates: 점등할 KST 날짜 Set, byDate: 날짜→video_id }. */
export function liveDateIndex(
  available: AvailEntry[],
): { dates: Set<string>; byDate: Map<string, string> } {
  const dates = new Set<string>();
  const byDate = new Map<string, string>();
  for (const a of available) {
    if (!a.ended_at) continue;
    const day = formatKSTDate(a.ended_at); // KST YYYY-MM-DD
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    dates.add(day);
    // available 은 ended_at DESC 정렬 — 같은 날 복수면 더 최근 것을 우선 유지.
    if (!byDate.has(day)) byDate.set(day, a.video_id);
  }
  return { dates, byDate };
}
