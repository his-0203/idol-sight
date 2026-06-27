// 카테고리(코호트) 분류 — worker의 group_model 분류(migration 0007)에서 파생.
//   corporate     → K-POP (음반·음방·컴백 사이클)
//   segmentary    → 서브컬처 (왁타버스 위성)
//   confederation → 서브컬처 (V-tuber 우산)
// K-POP과 서브컬처는 KPI 가중이 달라 한 평면에서 비교 불가 — 항상 분리.
export type Category = "kpop" | "subculture";

export const CATEGORY_LABEL: Record<Category, string> = {
  kpop:       "K-POP",
  subculture: "서브컬처",
};

export const CATEGORY_HINT: Record<Category, string> = {
  kpop:       "Corporate (음반·음방·컴백 사이클)",
  subculture: "Segmentary / Confederation (스트리밍·라이브·V-tuber)",
};

export const CATEGORY_ORDER: Category[] = ["kpop", "subculture"];

export function categoryOf(groupModel: string | null | undefined): Category {
  if (groupModel === "segmentary" || groupModel === "confederation") return "subculture";
  return "kpop";
}

export interface CategorizedGroup {
  key: string;
  name: string;
  group_model: string | null;
  category: Category;
}

/** 그룹 목록을 카테고리별로 묶는다(입력 순서 보존). 그룹 전환 셀렉터용. */
export function groupsByCategory(
  groups: Array<{ key: string; name: string; group_model?: string | null }>,
): Record<Category, CategorizedGroup[]> {
  const out: Record<Category, CategorizedGroup[]> = { kpop: [], subculture: [] };
  for (const g of groups) {
    const category = categoryOf(g.group_model);
    out[category].push({ key: g.key, name: g.name, group_model: g.group_model ?? null, category });
  }
  return out;
}
