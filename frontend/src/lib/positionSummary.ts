// 포지션 탭 "한눈 요약" — 경영진·투자사가 아래 섹션들을 안 읽어도 결론을
// 갖게 하는 5줄 다이제스트(위치→방향→KPI→팬덤→위기). 전부 화면의 기존
// 데이터에서 파생하며, 결측 섹션은 줄을 생략한다(가짜 수치 금지 원칙).
// 문장은 순화 용어만 사용(볼트 덱 규칙과 동일 기조).

import { momentumLine, QUADRANT_VERDICT, TIER_LABEL } from "./position";
import type { QuadrantKey } from "./breadthDepth";
import {
  bandVerdict, KPI_LABEL, PACE_BANDS, type KpiMetric, type MonthlyKpiRow,
} from "./miiwanKpi";

export type SummaryTone = "good" | "warn" | "bad" | "info";

export interface SummaryLine { label: string; text: string; tone: SummaryTone }

export interface PositionSummaryInput {
  /** v3.1 관심 규모 티어(1=선두). SoV %·순위는 헤드라인 은퇴 — 상세는
      '방향과 속도'·시장 개요에 잔존(비은폐). */
  sovTier: number | null;
  momentumGap: number | null;      // 최근-누적 점유 격차 (±0.5pp 임계)
  quadrant: QuadrantKey | null;
  postureLabel: string | null;     // 성장 자세 라벨
  orgScore: number | null;         // 자연 유입 점수 (0~100)
  monthlyKpi: MonthlyKpiRow[];
  riskLevel: "정상" | "주의" | "심각";
  strength: string | null;         // 동시기 강점 1줄 (cohortHead)
}

const METRIC_FIELD: Record<KpiMetric, keyof MonthlyKpiRow> = {
  subscribers: "yt_subscribers",
  avg_ccv: "avg_ccv",
  weverse_members: "weverse_members",
  weverse_membership: "weverse_membership",
};

const SHORT_LABEL: Record<KpiMetric, string> = {
  subscribers: "구독",
  avg_ccv: "동접",
  weverse_members: "위버스",
  weverse_membership: "멤버십",
};

const VERDICT_MARK = { below: "⚠️", within: "✅", above: "🔵" } as const;

/** 마지막 확정(당월 아님) 월의 지표별 밴드 판정 요약. 판정 가능한 지표가
    없으면 null. */
function kpiLine(monthly: MonthlyKpiRow[]): SummaryLine | null {
  const settled = [...monthly]
    .filter((r) => !r.in_progress)
    .sort((a, b) => b.month.localeCompare(a.month));
  for (const row of settled) {
    const parts: string[] = [];
    let hasBelow = false;
    for (const metric of Object.keys(METRIC_FIELD) as KpiMetric[]) {
      const actual = row[METRIC_FIELD[metric]] as number | null;
      const band = PACE_BANDS[row.month]?.[metric];
      if (actual == null || !band) continue;
      const v = bandVerdict(actual, band);
      if (v === "below") hasBelow = true;
      parts.push(`${SHORT_LABEL[metric]} ${VERDICT_MARK[v]}`);
    }
    if (parts.length) {
      return {
        label: "월간 KPI",
        text: `${Number(row.month.slice(5))}월 목표 밴드 대비 — ${parts.join(" · ")}`,
        tone: hasBelow ? "warn" : "good",
      };
    }
  }
  return null;
}

export function buildPositionSummary(i: PositionSummaryInput): SummaryLine[] {
  const lines: SummaryLine[] = [];

  // 시장 위치 — 헤드는 사분면 판정(질적 좌표) + 규모 티어(양적 좌표).
  // v3.1: SoV %·순위는 헤드라인 은퇴(백분위 합성이라 점유 표현 부적합) —
  // 수치는 '방향과 속도' 흐름 줄과 시장 개요 상세에 잔존(열세 숨김 금지).
  if (i.quadrant != null || i.sovTier != null) {
    const quad = i.quadrant ? QUADRANT_VERDICT[i.quadrant] : null;
    const tier = i.sovTier != null
      ? `관심 규모는 K-POP 버추얼 내 '${TIER_LABEL[i.sovTier] ?? `T${i.sovTier}`}'(최근 90일 조회 흐름 기준).`
      : null;
    lines.push({
      label: "시장 위치",
      text: [quad, tier].filter(Boolean).join(" "),
      tone: i.quadrant === "strong" ? "good"
        : i.quadrant === "low" ? "warn" : "info",
    });
  }

  const momentum = momentumLine(i.momentumGap);
  if (momentum || i.postureLabel) {
    lines.push({
      label: "성장 방향",
      text: [i.postureLabel && `성장 자세 '${i.postureLabel}'`, momentum]
        .filter(Boolean).join(" — "),
      tone: i.momentumGap != null && i.momentumGap > 0.5 ? "good"
        : i.momentumGap != null && i.momentumGap < -0.5 ? "warn" : "info",
    });
  }

  const kpi = kpiLine(i.monthlyKpi);
  if (kpi) lines.push(kpi);

  if (i.orgScore != null) {
    const score = Math.round(i.orgScore);
    lines.push({
      label: "팬덤 질",
      text: `자연 유입 점수 ${score}점(광고 없이 모였는가의 신호)`
        + (i.strength ? ` · ${i.strength}` : ""),
      tone: score >= 70 ? "good" : score >= 40 ? "info" : "warn",
    });
  }

  lines.push({
    label: "위기 상태",
    text: i.riskLevel === "정상"
      ? "위험 신호 없음 — 본체 노출·AI 도용·논란 급증 매일 자동 감시 중"
      : `위험도 ${i.riskLevel} — 위기 상태 섹션 확인 필요`,
    tone: i.riskLevel === "정상" ? "good"
      : i.riskLevel === "주의" ? "warn" : "bad",
  });

  return lines;
}
