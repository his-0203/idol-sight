// frontend/functions/lib/debutAligned.ts
//
// 데뷔일 정렬(day_offset) 버킷팅 — /api/debut-curve 와 /api/miiwan-cohort 공유.
// (group, 정수 day_offset)당 스냅샷 중 MAX 값을 유지한다. 누적 지표
// (구독자·조회수·뉴스 수)는 단조증가라 같은 날 backfill_estimate 행과
// 부분집계 live 행이 공존할 때 큰 쪽이 신뢰할 수 있는 신호다.
//
// 달력 기준은 **KST**. groups.debut_date 는 KST 달력 날짜이고 as_of_day 도
// debutWindowBuckets.debutAgeDaysKST(=KST) 로 계산하므로, snapshot_at(UTC)을
// UTC 달력일로 자르면 15:00Z 이후 스냅샷이 축·앵커에서 하루 어긋난다.
// → 여기서도 debutAgeDaysKST 와 동일한 관례(UTC+9 후 달력일)로 맞춘다.
import { debutAgeDaysKST } from "./debutWindowBuckets";

export interface AlignedInputRow {
  group_key: string;
  debut_date: string | null;
  snapshot_at: string;
  value: number | null;
  source: string;
}

export interface AlignedValue { value: number; source: string }

/**
 * 스냅샷 타임스탬프(UTC ISO) → 데뷔일 대비 경과일(KST 달력 기준).
 * 파싱 불가한 값은 null — NaN offset 이 버킷 키로 새는 것을 막는다.
 *
 * 포맷 계약: `snapshotAt` 은 `YYYY-MM-DDTHH:MM:SSZ` 같은 UTC ISO 문자열이어야
 * 한다 — `Date.parse` 가 문자열 전체를 그 전제로 파싱한다. SQLite 의 공백
 * 구분 `YYYY-MM-DD HH:MM:SS`(타임존 표기 없음)가 그대로 들어오면 `Date.parse`
 * 가 이를 **로컬 타임**으로 해석해 KST 환경에서 9시간 밀려 SQL 쪽(UTC 가정)
 * 계산과 어긋난다. 호출부가 이미 UTC ISO로 정규화해서 넘기는 것을 전제하며,
 * 여기서 런타임 가드는 두지 않는다.
 */
export function dayOffsetKST(snapshotAt: string, debutDate: string): number | null {
  const t = Date.parse(snapshotAt);
  if (!Number.isFinite(t)) return null;
  const offset = debutAgeDaysKST(debutDate, new Date(t));
  return Number.isFinite(offset) ? offset : null;
}

export function alignByDebut(
  rows: AlignedInputRow[],
  from: number,
  to: number,
): Record<string, Map<number, AlignedValue>> {
  const byGroup: Record<string, Map<number, AlignedValue>> = {};
  for (const r of rows) {
    if (!r.debut_date || r.value == null) continue;
    const offset = dayOffsetKST(r.snapshot_at, r.debut_date);
    if (offset == null || offset < from || offset > to) continue;
    const slot = byGroup[r.group_key] ?? new Map<number, AlignedValue>();
    const v = Number(r.value);
    const existing = slot.get(offset);
    if (!existing || v > existing.value) slot.set(offset, { value: v, source: r.source });
    byGroup[r.group_key] = slot;
  }
  return byGroup;
}
