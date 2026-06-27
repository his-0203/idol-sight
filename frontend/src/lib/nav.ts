import type { RouterState } from "../router";

// 사이드바 정보구조. 의도별 그룹(시장 펄스 / 코호트 / MiiWAN 자사 / 시스템).
// per-group 뷰(content/members/community/risk/growth)는 여기 없음 — Phase 3
// master-detail 엔티티 셸에서 진입(현재는 MarketOverview 카드 경유 유지).
export interface NavItem {
  label: string;
  tab: RouterState["tab"];
  category?: RouterState["category"]; // market 탭일 때 코호트 컨텍스트
}

export interface NavGroup {
  id: string;
  label: string;
  sub?: string;       // 작은 부제 (예: "모니터링", "Corporate")
  own?: boolean;      // 자사(MiiWAN) 특권 존 — own 액센트
  items: NavItem[];
}

export const NAV_MODEL: NavGroup[] = [
  { id: "pulse", label: "시장 펄스", sub: "모니터링", items: [
    { label: "시장 개요", tab: "market", category: "all" },
    { label: "주간 브리프", tab: "weekly" },
    { label: "인사이트", tab: "insights" },
    { label: "숏폼 트렌드", tab: "shorts" },
  ]},
  { id: "cohort", label: "코호트 비교", sub: "카테고리 분리", items: [
    { label: "K-POP (Corporate)", tab: "market", category: "kpop" },
    { label: "서브컬처 (V-튜버)", tab: "market", category: "subculture" },
  ]},
  { id: "miiwan", label: "MiiWAN", sub: "자사 · 1차 데이터", own: true, items: [
    { label: "개요 (심층분석)", tab: "miiwan" },
  ]},
  { id: "system", label: "시스템", items: [
    { label: "상태", tab: "status" },
  ]},
];

/** 사이드바 항목이 현재 뷰를 가리키는가. market 탭은 카테고리까지 일치해야 활성. */
export function isItemActive(
  item: NavItem,
  state: Pick<RouterState, "tab" | "category">,
): boolean {
  if (item.tab !== state.tab) return false;
  if (item.tab === "market") return (item.category ?? "all") === (state.category ?? "all");
  return true;
}
