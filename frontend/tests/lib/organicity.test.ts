import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ORGANICITY_MODE,
  ORGANIC_NEUTRAL_COLOR,
  THIN_SAMPLE_MAX,
  VERDICT_COLOR,
  VERDICT_THRESHOLDS,
  headlineOrganicScore,
  isThinSample,
  scoreColor,
  scoreToVerdict,
  verdictColor,
} from "../../src/lib/organicity";

describe("organicity shared scale", () => {
  it("scoreToVerdict honors the 85/70/55/40 boundaries", () => {
    expect(scoreToVerdict(100)).toBe("organic_strong");
    expect(scoreToVerdict(85)).toBe("organic_strong");
    expect(scoreToVerdict(84)).toBe("organic");
    expect(scoreToVerdict(70)).toBe("organic");
    expect(scoreToVerdict(69)).toBe("borderline");
    expect(scoreToVerdict(55)).toBe("borderline");
    expect(scoreToVerdict(54)).toBe("suspect");
    expect(scoreToVerdict(40)).toBe("suspect");
    expect(scoreToVerdict(39)).toBe("likely_paid");
    expect(scoreToVerdict(0)).toBe("likely_paid");
  });

  it("scoreColor maps tiers and treats null/undefined as neutral", () => {
    expect(scoreColor(90)).toBe(VERDICT_COLOR.organic_strong);
    expect(scoreColor(60)).toBe(VERDICT_COLOR.borderline);
    expect(scoreColor(10)).toBe(VERDICT_COLOR.likely_paid);
    expect(scoreColor(null)).toBe(ORGANIC_NEUTRAL_COLOR);
    expect(scoreColor(undefined)).toBe(ORGANIC_NEUTRAL_COLOR);
  });

  it("verdictColor maps each verdict and falls back to neutral", () => {
    expect(verdictColor("organic_strong")).toBe(VERDICT_COLOR.organic_strong);
    expect(verdictColor("likely_paid")).toBe(VERDICT_COLOR.likely_paid);
    expect(verdictColor("insufficient_data")).toBe(ORGANIC_NEUTRAL_COLOR);
    expect(verdictColor(null)).toBe(ORGANIC_NEUTRAL_COLOR);
    expect(verdictColor("garbage")).toBe(ORGANIC_NEUTRAL_COLOR);
  });

  // V2.40 Finding 3: the default organicity lens is the count-based simple
  // mean, NOT the view-weighted mean — a single high-view paid outlier (the
  // PLUMA teaser) must not dominate a bucket whose catalog is otherwise organic.
  it("DEFAULT_ORGANICITY_MODE is the count-based simple mean", () => {
    expect(DEFAULT_ORGANICITY_MODE).toBe("all_simple");
  });

  it("headlineOrganicScore returns the simple (count-based) mean, not weighted", () => {
    // A teaser-dominated bucket: weighted is dragged down by the outlier, but
    // the catalog (simple mean) is healthy. Headline must reflect the catalog.
    expect(
      headlineOrganicScore({
        organic_score_mean: 35,         // view-weighted, teaser-dominated
        organic_score_mean_simple: 82,  // count-based, healthy catalog
      }),
    ).toBe(82);
  });

  it("headlineOrganicScore is null when the bucket has no scored videos", () => {
    expect(
      headlineOrganicScore({
        organic_score_mean: null,
        organic_score_mean_simple: null,
        organic_score_mean_shrunk: null,
      }),
    ).toBeNull();
  });

  // V2.50: the headline is the thin-sample-shrunk mean — a 1-video bucket whose
  // raw simple mean is 90 must surface its shrunk value (~64), not the
  // confident 90, so "few organic videos" can't read as organic_strong.
  it("headlineOrganicScore prefers the shrunk mean when present", () => {
    expect(
      headlineOrganicScore({
        organic_score_mean: 90,
        organic_score_mean_simple: 90,
        organic_score_mean_shrunk: 63.75,
      }),
    ).toBe(63.75);
  });

  it("headlineOrganicScore falls back to the raw simple mean on pre-0092 rows", () => {
    // shrunk absent (older summary row) → raw simple mean.
    expect(
      headlineOrganicScore({
        organic_score_mean: 35,
        organic_score_mean_simple: 82,
      }),
    ).toBe(82);
  });

  // V2.50 thin-sample flag: buckets below THIN_SAMPLE_MAX scored videos are
  // flagged so a confident-looking headline from 1-2 videos is visibly caveated.
  it("isThinSample flags buckets below the scored-count threshold", () => {
    expect(THIN_SAMPLE_MAX).toBe(3);
    expect(isThinSample(0)).toBe(true);
    expect(isThinSample(1)).toBe(true);
    expect(isThinSample(2)).toBe(true);
    expect(isThinSample(3)).toBe(false);
    expect(isThinSample(10)).toBe(false);
    expect(isThinSample(null)).toBe(true);
    expect(isThinSample(undefined)).toBe(true);
  });

  // Cross-language drift guard: the frontend thresholds must match the worker's
  // _classify_verdict boundaries. If a recalibration changes one without the
  // other, this fails instead of silently desyncing the color meaning.
  it("matches the worker debut_window._classify_verdict boundaries", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const py = readFileSync(
      resolve(here, "../../../worker/src/idol_sight/analysis/debut_window.py"),
      "utf8",
    );
    const want: Record<string, number> = {
      organic_strong: VERDICT_THRESHOLDS.organic_strong,
      organic: VERDICT_THRESHOLDS.organic,
      borderline: VERDICT_THRESHOLDS.borderline,
      suspect: VERDICT_THRESHOLDS.suspect,
    };
    for (const [verdict, threshold] of Object.entries(want)) {
      // e.g.  if score >= 85:\n        return "organic_strong"
      const re = new RegExp(`score\\s*>=\\s*(\\d+)\\s*:\\s*\\n\\s*return\\s*"${verdict}"`);
      const m = py.match(re);
      expect(m, `worker threshold for ${verdict} not found`).toBeTruthy();
      expect(Number(m![1])).toBe(threshold);
    }
  });

  // V2.50: the shrunk headline math lives in the worker, but organicity.ts
  // documents the prior (55 = borderline midpoint) and pseudocount (k=3). Pin
  // them so a worker recalibration that silently changes the headline behavior
  // can't drift away from the frontend's documented contract.
  it("worker shrinkage constants match the documented prior/pseudocount", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const py = readFileSync(
      resolve(here, "../../../worker/src/idol_sight/analysis/debut_window.py"),
      "utf8",
    );
    expect(py).toMatch(/ORGANICITY_PRIOR\s*=\s*55\.0/);
    expect(py).toMatch(/ORGANICITY_SHRINKAGE_K\s*=\s*3\.0/);
    // The neutral prior must sit in the borderline tier (55..69) so a shrunk
    // thin bucket reads as "unproven", never organic.
    expect(scoreToVerdict(55)).toBe("borderline");
  });
});

import {
  computeGroupOrganicities,
  organicityCaveat,
  organicityScoreFor,
  selectGroupOrganicity,
  type OrganicitySummaryRow,
} from "../../src/lib/organicity";

function row(p: Partial<OrganicitySummaryRow> & { group_key: string; window_bucket: string }): OrganicitySummaryRow {
  return {
    organic_score_mean: null, organic_score_mean_long: null,
    organic_score_mean_short: null, organic_score_mean_simple: null,
    organic_score_mean_shrunk: null, video_count: 0, scored_video_count: 0,
    long_form_count: 0, short_form_count: 0, ...p,
  };
}

describe("selectGroupOrganicity (bucket fallback collapse)", () => {
  const buckets = ["D-20", "D-Day", "D+20"] as const;

  it("exact: selected bucket has a score for the mode", () => {
    const m = new Map([
      ["D-Day", row({ group_key: "g", window_bucket: "D-Day", organic_score_mean_simple: 72, organic_score_mean_shrunk: 72, video_count: 10, scored_video_count: 10 })],
    ]);
    const r = selectGroupOrganicity(m, "D-Day", "all_simple", "g", buckets);
    expect(r.score).toBe(72);
    expect(r.display_mode).toBe("exact");
    expect(r.thin).toBe(false);
  });

  it("current: selected bucket empty → newest non-null bucket", () => {
    const m = new Map([
      ["D-20", row({ group_key: "g", window_bucket: "D-20", organic_score_mean_simple: 60, organic_score_mean_shrunk: 60, video_count: 5, scored_video_count: 5 })],
    ]);
    const r = selectGroupOrganicity(m, "D+20", "all_simple", "g", buckets);
    expect(r.score).toBe(60);
    expect(r.display_mode).toBe("current");
    expect(r.shown_bucket).toBe("D-20");
  });

  it("none: no scoreable bucket for the mode", () => {
    const m = new Map([
      ["D-Day", row({ group_key: "g", window_bucket: "D-Day" })],
    ]);
    const r = selectGroupOrganicity(m, "D-Day", "all_simple", "g", buckets);
    expect(r.score).toBeNull();
    expect(r.display_mode).toBe("none");
  });

  it("thin sample flagged when scored < 3", () => {
    const m = new Map([
      ["D-Day", row({ group_key: "g", window_bucket: "D-Day", organic_score_mean_simple: 90, organic_score_mean_shrunk: 90, video_count: 2, scored_video_count: 2 })],
    ]);
    const r = selectGroupOrganicity(m, "D-Day", "all_simple", "g", buckets);
    expect(r.thin).toBe(true);
  });
});

describe("organicityScoreFor (all_simple uses shrunk headline)", () => {
  it("falls back to raw simple mean when shrunk null", () => {
    expect(organicityScoreFor(row({ group_key: "g", window_bucket: "b", organic_score_mean_simple: 50, organic_score_mean_shrunk: null }), "all_simple")).toBe(50);
    expect(organicityScoreFor(row({ group_key: "g", window_bucket: "b", organic_score_mean_simple: 50, organic_score_mean_shrunk: 58 }), "all_simple")).toBe(58);
  });
});

describe("computeGroupOrganicities", () => {
  const buckets = ["D-Day", "D+20"];
  const rows = [
    row({ group_key: "a", window_bucket: "D-Day", organic_score_mean_simple: 80, organic_score_mean_shrunk: 80, video_count: 9, scored_video_count: 9 }),
    row({ group_key: "b", window_bucket: "D-Day", organic_score_mean_simple: 30, organic_score_mean_shrunk: 30, video_count: 9, scored_video_count: 9 }),
    row({ group_key: "x", window_bucket: "D-Day", organic_score_mean_simple: 99, organic_score_mean_shrunk: 99, video_count: 9, scored_video_count: 9 }),
  ];

  it("returns one entry per group, excluding excludeGroups", () => {
    const m = computeGroupOrganicities(rows, { buckets, currentBucket: "D-Day", mode: "all_simple", excludeGroups: new Set(["x"]) });
    expect(m.size).toBe(2);
    expect(m.get("a")!.score).toBe(80);
    expect(m.has("x")).toBe(false);
  });

  it("ignores rows in buckets not in the display list", () => {
    const extra = [...rows, row({ group_key: "c", window_bucket: "D-999", organic_score_mean_simple: 50, organic_score_mean_shrunk: 50, video_count: 9, scored_video_count: 9 })];
    const m = computeGroupOrganicities(extra, { buckets, currentBucket: "D-Day", mode: "all_simple" });
    expect(m.has("c")).toBe(false);
  });
});

describe("organicityCaveat", () => {
  const g = (score: number | null, scoredCount = 9): import("../../src/lib/organicity").GroupOrganicity =>
    ({ group_key: "g", score, sample_count: 9, scored_count: scoredCount, thin: false, display_mode: "exact", shown_bucket: "D-Day" });

  it("shows for caution tiers, hides for organic/strong", () => {
    expect(organicityCaveat(g(35)).show).toBe(true);   // likely_paid
    expect(organicityCaveat(g(35)).label).toBe("유료 가능성 높음");
    expect(organicityCaveat(g(50)).show).toBe(true);   // suspect
    expect(organicityCaveat(g(50)).label).toBe("유료 의심");
    expect(organicityCaveat(g(60)).show).toBe(true);   // borderline
    expect(organicityCaveat(g(60)).label).toBe("오가닉성 주의");
    expect(organicityCaveat(g(75)).show).toBe(false);  // organic
    expect(organicityCaveat(g(90)).show).toBe(false);  // organic_strong
    // scored_count gate: caution tier shown at 3 scored, hidden at 2 scored.
    expect(organicityCaveat(g(35, 3)).show).toBe(true);
    expect(organicityCaveat(g(35, 2)).show).toBe(false);
  });

  it("hides when thin (scored_count < 3), null score, or missing", () => {
    expect(organicityCaveat(g(35, 2)).show).toBe(false); // scored_count=2 → thin by scored → hidden
    expect(organicityCaveat(g(null)).show).toBe(false);
    expect(organicityCaveat(undefined).show).toBe(false);
  });
});
