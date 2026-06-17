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
