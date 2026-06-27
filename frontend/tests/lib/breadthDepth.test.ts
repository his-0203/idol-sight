import { describe, expect, it } from "vitest";
import {
  QUADRANT_LABEL,
  SCATTER_GEOM,
  computeQuadrantLayout,
  computeScatterLayout,
  declutterLabels,
  median,
  type QuadrantInput,
} from "../../src/lib/breadthDepth";

const p = (key: string, x: number, y: number, caveat = false): QuadrantInput => ({ key, name: key.toUpperCase(), x, y, caveat });

describe("declutterLabels", () => {
  it("enforces minGap in cy order, preserving input index order", () => {
    const out = declutterLabels([10, 12, 11], 5, 0, 100);
    // sorted by cy: idx0(10) → idx2(11) → idx1(12)
    expect(out[0]).toBe(10);
    expect(out[2]).toBe(15); // max(11, 10+5)
    expect(out[1]).toBe(20); // max(12, 15+5)
  });
  it("shifts everything up when it overflows bottom", () => {
    const out = declutterLabels([95, 99], 10, 0, 100);
    // greedy: 95, 105 → overflow 5 → 90, 100
    expect(out[0]).toBe(90);
    expect(out[1]).toBe(100);
  });
  it("never lets two labels sit closer than minGap", () => {
    const out = declutterLabels([50, 51, 52, 53], 12, 0, 1000);
    const sorted = [...out].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(12);
  });
});

describe("computeScatterLayout", () => {
  it("places dots by value (higher x → larger cx, higher y → smaller cy) and gives one label per dot", () => {
    const layout = computeScatterLayout([p("hi", 90, 1000), p("lo", 10, 10)]);
    expect(layout.plottable).toBe(true);
    expect(layout.dots).toHaveLength(2);
    expect(layout.labels).toHaveLength(2);
    const hi = layout.dots.find((d) => d.key === "hi")!;
    const lo = layout.dots.find((d) => d.key === "lo")!;
    expect(hi.cx).toBeGreaterThan(lo.cx);     // higher awareness → further right
    expect(hi.cy).toBeLessThan(lo.cy);        // higher core → higher up (smaller y)
  });
  it("labels share a right-gutter x and stay inside the viewBox", () => {
    const layout = computeScatterLayout([p("a", 80, 500), p("b", 20, 20), p("c", 50, 100)]);
    const lxs = new Set(layout.labels.map((l) => l.lx));
    expect(lxs.size).toBe(1);                                     // all labels in one column
    expect([...lxs][0]!).toBeLessThan(SCATTER_GEOM.W);            // inside viewBox width
    for (const l of layout.labels) expect(l.ly).toBeLessThanOrEqual(SCATTER_GEOM.H);
  });
  it("not plottable when fewer than 2 finite points", () => {
    expect(computeScatterLayout([p("only", 50, 50)]).plottable).toBe(false);
  });
});

describe("median", () => {
  it("odd length → middle", () => expect(median([3, 1, 2])).toBe(2));
  it("even length → mean of middles", () => expect(median([1, 2, 3, 4])).toBe(2.5));
  it("empty → 0", () => expect(median([])).toBe(0));
});

describe("computeQuadrantLayout", () => {
  it("classifies by category median crosshair (>= is right/top)", () => {
    // x values [80,80,20,20] → median 50; y values [200,20,200,20] → median 110
    const layout = computeQuadrantLayout([
      p("hi_strong", 80, 200),  // right + top → strong
      p("hi_ad", 80, 20),       // right + low  → ad_driven
      p("lo_niche", 20, 200),   // left + top   → niche
      p("lo_low", 20, 20),      // left + low   → low
    ]);
    expect(layout.plottable).toBe(true);
    expect(layout.xMedian).toBe(50);
    expect(layout.yMedian).toBe(110); // median of [200,20,200,20] = (200+20)/2... sorted [20,20,200,200] → (20+200)/2 = 110
    const q = Object.fromEntries(layout.points.map((pt) => [pt.key, pt.quadrant]));
    expect(q.hi_strong).toBe("strong");
    expect(q.hi_ad).toBe("ad_driven");
    expect(q.lo_niche).toBe("niche");
    expect(q.lo_low).toBe("low");
  });

  it("drops non-finite x/y and flags <2 plottable as not plottable", () => {
    const layout = computeQuadrantLayout([
      p("only", 50, 50),
      { key: "noy", name: "NOY", x: 50, y: NaN, caveat: false },
    ]);
    expect(layout.points).toHaveLength(1);
    expect(layout.plottable).toBe(false);
  });

  it("preserves caveat flag on points", () => {
    const layout = computeQuadrantLayout([p("a", 80, 200, true), p("b", 20, 20)]);
    expect(layout.points.find((pt) => pt.key === "a")!.caveat).toBe(true);
  });

  it("exposes the four quadrant labels", () => {
    expect(QUADRANT_LABEL.strong).toBe("진성 강세");
    expect(QUADRANT_LABEL.ad_driven).toBe("광고형/바이럴");
    expect(QUADRANT_LABEL.niche).toBe("니치 충성");
    expect(QUADRANT_LABEL.low).toBe("저조");
  });
});
