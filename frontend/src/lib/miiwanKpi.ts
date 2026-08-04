// 미완소년 월간 KPI 페이스 — 목표 밴드(내부 계획 가정치, 2026-06-30 확정)
// 대비 실측으로 "계획 페이스 안에 있는가"를 판정한다. 밴드·공식 KPI는
// 고정 계획 수치라 상수로 둔다. 금액 지표는 다루지 않는다.

export type KpiMetric =
  | "subscribers" | "avg_ccv" | "weverse_members" | "weverse_membership";

export interface MonthlyKpiRow {
  month: string;                       // "2026-06"
  yt_subscribers: number | null;       // 월말 스냅샷
  avg_ccv: number | null;              // 방송별 평균 CCV의 월평균
  weverse_members: number | null;      // 월말
  weverse_membership: number | null;   // 월말
  in_progress: boolean;                // 당월(월말 확정 전)
}

export const KPI_METRICS = [
  "subscribers", "avg_ccv", "weverse_members", "weverse_membership",
] as const satisfies readonly KpiMetric[];

export const KPI_LABEL: Record<KpiMetric, string> = {
  subscribers: "YouTube 구독자",
  avg_ccv: "평균 라이브 동접",
  weverse_members: "위버스 가입자",
  weverse_membership: "유료 멤버십",
};

export const KPI_MONTHS = [
  "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12",
] as const;

/** [보수, 낙관]. 2026-06은 실측 기점이라 밴드 없음. */
export const PACE_BANDS: Record<string, Partial<Record<KpiMetric, [number, number]>>> = {
  "2026-07": { subscribers: [32000, 35000], avg_ccv: [700, 760], weverse_members: [4200, 4600], weverse_membership: [70, 80] },
  "2026-08": { subscribers: [37000, 45000], avg_ccv: [850, 1050], weverse_members: [4800, 5900], weverse_membership: [130, 170] },
  "2026-09": { subscribers: [43000, 55000], avg_ccv: [1000, 1300], weverse_members: [5600, 7200], weverse_membership: [300, 400] },
  "2026-10": { subscribers: [50000, 68000], avg_ccv: [1200, 1600], weverse_members: [6500, 8800], weverse_membership: [450, 600] },
  "2026-11": { subscribers: [62000, 80000], avg_ccv: [1500, 1900], weverse_members: [8000, 10400], weverse_membership: [580, 770] },
  "2026-12": { subscribers: [72000, 90000], avg_ccv: [1600, 2000], weverse_members: [9500, 11700], weverse_membership: [700, 900] },
};

/** ◆ 의사결정 시점 · ★ 컴백 — 표 열 헤더에 병기. */
export const MONTH_NOTES: Record<string, string> = {
  "2026-08": "◆ 굿즈 참여 결정",
  "2026-09": "★ 디지털 싱글 컴백",
  "2026-10": "◆ 제작 스케일·팬미팅 결정",
};

/** 먼슬리 보고의 공식 KPI 목표 (구독·동접만 공식 목표가 있다). */
export const OFFICIAL_KPI = [
  { month: "2026-08", label: "8월 말 공식 KPI", targets: { subscribers: 30000, avg_ccv: 1000 } },
  { month: "2026-11", label: "11월 말 공식 KPI", targets: { subscribers: 72000, avg_ccv: 1600 } },
] as const;

export type BandVerdict = "below" | "within" | "above";

export function bandVerdict(actual: number, band: [number, number]): BandVerdict {
  if (actual < band[0]) return "below";
  if (actual > band[1]) return "above";
  return "within";
}

export interface KpiCell {
  month: string;
  band: [number, number] | null;
  actual: number | null;
  verdict: BandVerdict | null;   // 실측+밴드 있고 확정 월일 때만
  inProgress: boolean;
}

export interface KpiTableRow { metric: KpiMetric; cells: KpiCell[] }

const METRIC_FIELD: Record<KpiMetric, keyof MonthlyKpiRow> = {
  subscribers: "yt_subscribers",
  avg_ccv: "avg_ccv",
  weverse_members: "weverse_members",
  weverse_membership: "weverse_membership",
};

export function buildKpiTable(monthly: MonthlyKpiRow[]): KpiTableRow[] {
  const byMonth = new Map(monthly.map((r) => [r.month, r]));
  return KPI_METRICS.map((metric) => ({
    metric,
    cells: KPI_MONTHS.map((month) => {
      const row = byMonth.get(month) ?? null;
      const actual = (row?.[METRIC_FIELD[metric]] as number | null) ?? null;
      const band = PACE_BANDS[month]?.[metric] ?? null;
      const inProgress = row?.in_progress ?? false;
      return {
        month, band, actual, inProgress,
        verdict: actual != null && band != null && !inProgress
          ? bandVerdict(actual, band) : null,
      };
    }),
  }));
}

export interface OfficialProgressItem {
  metric: KpiMetric; actual: number | null; target: number; pct: number | null;
}

/** 공식 KPI 2시점 대비 최신 실측 달성률 (0~100+, 반올림). */
export function officialProgress(monthly: MonthlyKpiRow[]) {
  const latest = (metric: KpiMetric): number | null => {
    for (let i = monthly.length - 1; i >= 0; i--) {
      const v = monthly[i][METRIC_FIELD[metric]] as number | null;
      if (v != null) return v;
    }
    return null;
  };
  return OFFICIAL_KPI.map((k) => ({
    month: k.month,
    label: k.label,
    items: (Object.entries(k.targets) as Array<[KpiMetric, number]>).map(
      ([metric, target]): OfficialProgressItem => {
        const actual = latest(metric);
        return {
          metric, actual, target,
          pct: actual != null ? Math.round((actual / target) * 100) : null,
        };
      }),
  }));
}
