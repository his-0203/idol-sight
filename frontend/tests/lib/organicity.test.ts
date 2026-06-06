import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ORGANIC_NEUTRAL_COLOR,
  VERDICT_COLOR,
  VERDICT_THRESHOLDS,
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
