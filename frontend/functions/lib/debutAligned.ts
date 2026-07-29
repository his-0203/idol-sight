// frontend/functions/lib/debutAligned.ts
//
// 데뷔일 정렬(day_offset) 버킷팅 — /api/debut-curve 와 /api/miiwan-cohort 공유.
// (group, 정수 day_offset)당 스냅샷 중 MAX 값을 유지한다. 누적 지표
// (구독자·조회수·뉴스 수)는 단조증가라 같은 날 backfill_estimate 행과
// 부분집계 live 행이 공존할 때 큰 쪽이 신뢰할 수 있는 신호다.

export interface AlignedInputRow {
  group_key: string;
  debut_date: string | null;
  snapshot_at: string;
  value: number | null;
  source: string;
}

export interface AlignedValue { value: number; source: string }

export function alignByDebut(
  rows: AlignedInputRow[],
  from: number,
  to: number,
): Record<string, Map<number, AlignedValue>> {
  const byGroup: Record<string, Map<number, AlignedValue>> = {};
  for (const r of rows) {
    if (!r.debut_date || r.value == null) continue;
    const offset = Math.round(
      (Date.parse(r.snapshot_at.slice(0, 10)) - Date.parse(r.debut_date)) / 86_400_000,
    );
    if (offset < from || offset > to) continue;
    const slot = byGroup[r.group_key] ?? new Map<number, AlignedValue>();
    const v = Number(r.value);
    const existing = slot.get(offset);
    if (!existing || v > existing.value) slot.set(offset, { value: v, source: r.source });
    byGroup[r.group_key] = slot;
  }
  return byGroup;
}
