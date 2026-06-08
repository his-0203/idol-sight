// frontend/src/views/GroupGrowth.tsx
import { GroupTabs } from "../components/GroupTabs";
import { GrowthTrajectoryPanel } from "../components/GrowthTrajectoryPanel";
import { EmptyState } from "../components/EmptyState";

export function GroupGrowth({ groupKey }: { groupKey: string | null }) {
  return (
    <div>
      <GroupTabs />
      {groupKey
        ? <GrowthTrajectoryPanel groupKey={groupKey} />
        : <EmptyState title="그룹을 선택하세요" hint="시장 개요에서 그룹을 고르면 성장 궤적이 표시됩니다." icon="📈" />}
    </div>
  );
}
