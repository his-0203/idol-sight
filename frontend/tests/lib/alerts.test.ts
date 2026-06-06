import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALERT_RULE_LABEL,
  ALERT_SEVERITY_TONE,
  CONTROVERSY_SPIKE_MIN_COUNT,
  CONTROVERSY_SPIKE_MULTIPLIER,
} from "../../src/lib/alerts";

describe("shared alert constants", () => {
  it("covers the worker alert rules and the three severities", () => {
    for (const rule of [
      "controversy_spike", "identity_leak", "model_theft",
      "video_velocity_24h", "debut_milestone",
    ]) {
      expect(ALERT_RULE_LABEL[rule]).toBeTruthy();
    }
    for (const sev of ["critical", "warn", "info"]) {
      expect(ALERT_SEVERITY_TONE[sev]).toBeTruthy();
    }
  });

  // Cross-language guard: the controversy-spike thresholds must match the worker
  // rule_controversy_spike, or the BI Risk Level and the Discord alert disagree.
  it("controversy thresholds match worker alerts/__init__.py", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const py = readFileSync(
      resolve(here, "../../../worker/src/idol_sight/alerts/__init__.py"),
      "utf8",
    );
    const mult = py.match(/CONTROVERSY_SPIKE_MULTIPLIER\s*=\s*([\d.]+)/);
    const minc = py.match(/CONTROVERSY_SPIKE_MIN_COUNT\s*=\s*(\d+)/);
    expect(mult, "worker MULTIPLIER not found").toBeTruthy();
    expect(minc, "worker MIN_COUNT not found").toBeTruthy();
    expect(Number(mult![1])).toBe(CONTROVERSY_SPIKE_MULTIPLIER);
    expect(Number(minc![1])).toBe(CONTROVERSY_SPIKE_MIN_COUNT);
  });
});
