import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DISPLAY_BUCKETS } from "../../src/lib/debutWindow";
import {
  FRONTEND_BUCKET_MAP,
  VALID_BUCKETS,
} from "../../functions/lib/debutWindowBuckets";

describe("debut window display buckets", () => {
  it("matches the functions FRONTEND_BUCKET_MAP keys (identity, in order)", () => {
    expect([...DISPLAY_BUCKETS]).toEqual(Object.keys(FRONTEND_BUCKET_MAP));
  });

  it("matches the functions VALID_BUCKETS set", () => {
    expect(new Set(DISPLAY_BUCKETS)).toEqual(VALID_BUCKETS);
  });

  // Cross-language guard: the display tabs must equal the worker's named
  // WINDOW_BUCKETS (excluding the Pre/Post catch-alls the UI doesn't show).
  it("matches the worker WINDOW_BUCKETS named buckets", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const py = readFileSync(
      resolve(here, "../../../worker/src/idol_sight/analysis/debut_window.py"),
      "utf8",
    );
    // Skip the type annotation's brackets (list[tuple[...]]) and capture the
    // assigned list literal up to its first closing bracket.
    const block = py.match(/WINDOW_BUCKETS[\s\S]*?=\s*\[([\s\S]*?)\]/);
    const inner = block?.[1];
    expect(inner, "WINDOW_BUCKETS not found").toBeTruthy();
    const labels = [...inner!.matchAll(/\(\s*"([^"]+)"/g)].map((m) => m[1]!);
    const named = labels.filter((l) => l !== "Pre" && l !== "Post");
    expect(named).toEqual([...DISPLAY_BUCKETS]);
  });
});
