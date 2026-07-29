// frontend/src/components/EstBadge.tsx
//
// 수치 옆 출처 배지 — live 가 아닌 값에만 붙는다. 절대값을 그대로 믿으면
// 안 되는 행을 화면에서 표시해 두는 장치라 값과 배지는 항상 같이 렌더한다.
//
// views/MiiWANBriefing 에 있던 것을 components 로 내렸다 —
// components/MiiWANCohortReport 가 views 를 import 하면서
// components ↔ views 순환이 생겼기 때문.

export function EstBadge({ source }: { source: string | null | undefined }) {
  if (!source || source === 'live') return null;
  const tip = source === 'backfill_estimate'
    ? 'Social Blade 추정 (±5%) — 곡선 모양 신뢰, 절대값은 참고만'
    : '네이버 뉴스 검색 키워드 카운트 — 검증값';
  const label = source === 'backfill_estimate' ? 'est' : 'bf';
  return (
    <span
      title={tip}
      class="ml-1 rounded bg-zinc-800/60 px-1 py-[1px] text-[10px] text-zinc-500"
    >{label}</span>
  );
}
