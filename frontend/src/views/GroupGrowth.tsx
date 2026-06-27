// frontend/src/views/GroupGrowth.tsx
import { GroupTabs } from "../components/GroupTabs";
import { GrowthTrajectoryPanel } from "../components/GrowthTrajectoryPanel";
import { EmptyState } from "../components/EmptyState";

export function GroupGrowth({ groupKey }: { groupKey: string | null }) {
  return (
    <div>
      <GroupTabs />
      {groupKey
        ? (
          <div>
            <div class="mb-3 flex items-baseline gap-2">
              <h2 class="section-title">성장 궤적</h2>
              <span class="text-hint text-zinc-500">구독자·Health Score 30/90일 추이 + 시장 상대 벤치마크</span>
            </div>
            <GrowthTrajectoryPanel groupKey={groupKey} />
          </div>
        )
        : <EmptyState title="그룹을 선택하세요" hint="시장 개요에서 그룹을 고르면 성장 궤적이 표시됩니다." icon="📈" />}
    </div>
  );
}
