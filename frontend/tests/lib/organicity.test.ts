import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ORGANICITY_MODE,
  ORGANIC_NEUTRAL_COLOR,
  VERDICT_COLOR,
  VERDICT_THRESHOLDS,
  headlineOrganicScore,
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
      }),
    ).toBeNull();
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
});
