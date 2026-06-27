import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api";
import { computeGroupOrganicities, DEFAULT_ORGANICITY_MODE, isThinSample, organicityScoreFor, organicitySampleCountFor, scoreColor, selectGroupOrganicity, type GroupOrganicity, type OrganicityMode, type OrganicitySummaryRow } from "../lib/organicity";
import { DEFAULT_CURRENT_BUCKET, DEFAULT_DISPLAY_BUCKETS } from "../lib/debutWindow";

// V2.49: 표시 탭은 summary 응답의 window 메타 (롤링 창) — 정적 타입 대신
// string. 모든 탭이 같은 20일 창 단위라 그룹 간 표본 왜곡 없음 (기존 동일).
type Bucket = string;

// V2.22.3 (2026-05-15): user-requested exclusion from the cohort
// posture bar. ISEDOL/STELLIVE are 서브컬처 (segmentary / confederation)
// group_models — the Debut Window organicity metric still computes for
// them under the V2.18 same-formula policy, but on this comparison bar
// the operator wants a corporate K-POP only view, mirroring the
// MarketOverview / GroupContent / DebutCurve subculture gating
// established in V2.15 / V2.21 (the bar was previously the only place
// they showed up).
// V2.41.1 (2026-06-08): uryael (UR:L / 유아렐) added — it is the same
// subculture case (group_model='segmentary', V2.33 subculture cohort)
// and was simply never gated here when introduced.
const EXCLUDED_GROUPS = new Set<string>(["isedol", "stellive", "uryael"]);

// Score mode = which mean column to render. V2 (migration 0054) adds
// type-split and simple variants so users can defuse Shorts-vs-Long mix
// and view-weighted-single-video dominance.

const MODE_LABEL: Record<OrganicityMode, string> = {
  all_weighted: "전체·조회수 가중",
  all_simple:   "전체·단순평균",
  long:         "롱폼만",
  short:        "숏폼만",
};

// score → color: see src/lib/organicity.ts (single source of truth).

export function CompetitorOrganicityBar() {
  // V2.49: 기본 탭 = 서버가 내려준 "오늘(anchor 기준) 버킷" — 데뷔 전엔
  // D-Day, 슬라이드 후엔 최신 버킷. 사용자가 클릭하면 그 선택 우선.
  const [picked, setPicked] = useState<Bucket | null>(null);
  // V2.40 Finding 3: default to the count-based simple mean so one high-view
  // paid outlier (the PLUMA teaser) can't dominate a bucket. view-weighted
  // stays one click away. See src/lib/organicity.DEFAULT_ORGANICITY_MODE.
  const [mode, setMode] = useState<OrganicityMode>(DEFAULT_ORGANICITY_MODE);
  const [allRows, setAllRows] = useState<OrganicitySummaryRow[] | null>(null);
  const [buckets, setBuckets] = useState<string[]>(DEFAULT_DISPLAY_BUCKETS);
  const [defaultBucket, setDefaultBucket] = useState<string>(DEFAULT_CURRENT_BUCKET);
  const bucket = picked ?? defaultBucket;

  useEffect(() => {
    let cancelled = false;
    api.debutWindowSummary<OrganicitySummaryRow>().then((r) => {
      if (cancelled) return;
      if (r.window?.buckets?.length) {
        setBuckets(r.window.buckets);
        setDefaultBucket(r.window.current_bucket);
      }
      setAllRows(r.rows);
    }).catch(() => {
      if (!cancelled) setAllRows([]);
    });
    return () => { cancelled = true; };
  }, []);

  const display = useMemo<GroupOrganicity[]>(() => {
    if (!allRows) return [];
    return Array.from(
      computeGroupOrganicities(allRows, {
        buckets, currentBucket: bucket, mode, excludeGroups: EXCLUDED_GROUPS,
      }).values(),
    );
  }, [allRows, bucket, mode, buckets]);

  if (!allRows) return <div class="cob-section">불러오는 중…</div>;

  const sorted = [...display].sort((a, b) => {
    if (a.score === null && b.score === null) return 0;
    if (a.score === null) return 1;
    if (b.score === null) return -1;
    return b.score - a.score;
  });

  const fallbackCount = sorted.filter(
    (r) => r.display_mode === "current",
  ).length;

  return (
    <section class="cob-section">
      <h3>데뷔 구간 경쟁 포지션</h3>
      <div class="cob-bucket-picker">
        표시 구간:
        {buckets.map((b) => (
          <button type="button"
                  key={b}
                  class={b === bucket ? "active" : ""}
                  onClick={() => setPicked(b)}>{b}</button>
        ))}
      </div>
      <div class="cob-mode-picker">
        점수 기준:
        {(Object.keys(MODE_LABEL) as OrganicityMode[]).map((m) => (
          <button type="button"
                  key={m}
                  class={m === mode ? "active" : ""}
                  onClick={() => setMode(m)}>{MODE_LABEL[m]}</button>
        ))}
      </div>
      <div class="cob-bars">
        {sorted.map((r) => {
          const width = r.score === null ? 0 : r.score;
          const isOurs = r.group_key === "miiwan";
          const label = r.score === null ? "N/A" : Math.round(r.score).toString();
          const isFallback = r.display_mode === "current";
          const fillClass = "cob-bar-fill" + (isFallback ? " fallback" : "");
          const thinNote = r.thin && r.display_mode !== "none"
            ? " · 표본 적음 — 중립 보정된 점수"
            : "";
          const tooltip = r.display_mode === "none"
            ? `${MODE_LABEL[mode]}: 데이터 없음`
            : isFallback
              ? `선택 버킷 데이터 없음 — 현재 시점(${r.shown_bucket}) 점수 표시 · ${r.sample_count} videos${thinNote}`
              : `${r.sample_count} videos${thinNote}`;
          return (
            <div class={`cob-row ${isOurs ? "ours" : ""}`} key={r.group_key} title={tooltip}>
              <div class="cob-name">{r.group_key.toUpperCase()}</div>
              <div class="cob-bar-track">
                <div class={fillClass}
                     style={{ width: `${width}%`, background: scoreColor(r.score) }} />
              </div>
              <div class="cob-score">
                <span class="cob-score-value">{label}</span>
                {r.thin && r.score !== null && (
                  <span class="cob-thin-tag" aria-label="표본 적음">*</span>
                )}
                {isFallback && (
                  <span class="cob-current-tag">@{r.shown_bucket}</span>
                )}
              </div>
              {isOurs && <div class="cob-tag">← 우리 그룹</div>}
            </div>
          );
        })}
      </div>
      <div class="cob-footer">
        {sorted.length}개 그룹 표시 · 구간 {bucket} · {MODE_LABEL[mode]}
        {fallbackCount > 0 && (
          <> · <span class="cob-fallback-note">
            {fallbackCount}개 그룹은 해당 버킷 데이터 없어 현재 시점 점수로 표시 (@버킷)
          </span></>
        )}
        <br />
        진정성(오가닉) 점수 = 진정성(비율) 신호 · 조회수 규모와 무관 — 막대 길이는 "진짜인가"지 "큰가"가 아님.
        {" "}<span class="cob-thin-legend">* 표본 적음(채점 3개 미만) — 중립으로 보정된 점수, 성장·볼륨은 성장 탭 참고.</span>
      </div>
    </section>
  );
}
