import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bucketIndexForAge,
  displayBuckets,
  labelForIndex,
} from "../../functions/lib/debutWindowBuckets";
import {
  DEFAULT_CURRENT_BUCKET,
  DEFAULT_DISPLAY_BUCKETS,
} from "../../src/lib/debutWindow";

describe("debut window cross-layer guards", () => {
  it("fallback equals the pre-debut window (server/client agree)", () => {
    expect(DEFAULT_DISPLAY_BUCKETS).toEqual(displayBuckets(0));
    expect(DEFAULT_DISPLAY_BUCKETS).toContain(DEFAULT_CURRENT_BUCKET);
  });

  // Cross-language guard: worker WINDOW_BUCKETS (고정 음수 측 + D-Day) 의
  // 라벨/경계가 functions 의 산술과 일치해야 한다. 양수 측 산술 동일성은
  // debutWindowBuckets.test.ts 의 BOUNDARY_FIXTURE ↔ worker parametrize 가 핀.
  it("matches the worker WINDOW_BUCKETS fixed entries", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const py = readFileSync(
      resolve(here, "../../../worker/src/idol_sight/analysis/debut_window.py"),
      "utf8",
    );
    // WINDOW_BUCKETS 에 타입 어노테이션(list[tuple[str, int, int]])이 붙어
    // "=" 다음 첫 "[" は 어노테이션의 대괄호다. "= [" (공백 포함)로 리스트
    // 리터럴 시작을 찾아야 어노테이션을 건너뛸 수 있다.
    const assignIdx = py.indexOf("WINDOW_BUCKETS");
    const eqIdx = py.indexOf("=", assignIdx);
    // "= [" — 어노테이션 닫힘("]") 이후에 오는 첫 번째 "[" 를 잡는다.
    const listLiteralMatch = py.slice(eqIdx).match(/=\s*\[/);
    const listStart = listLiteralMatch
      ? eqIdx + listLiteralMatch.index! + listLiteralMatch[0].length - 1
      : -1;
    const listEnd = listStart !== -1 ? py.indexOf("]", listStart + 1) : -1;
    const inner = listStart !== -1 && listEnd !== -1
      ? py.slice(listStart + 1, listEnd)
      : null;
    expect(inner, "WINDOW_BUCKETS list literal not found").toBeTruthy();

    const entries = [...inner!.matchAll(
      /\(\s*"([^"]+)",\s*(-?\d+),\s*(-?\d+)\s*\)/g,
    )].map((m) => [m[1]!, Number(m[2]), Number(m[3])] as const);

    // 5개 항목이 있어야 false-green 방지
    expect(entries, "expected 5 WINDOW_BUCKETS entries").toHaveLength(5);
    expect(entries.map((e) => e[0])).toEqual(
      ["Pre", "D-60", "D-40", "D-20", "D-Day"],
    );
    // 각 named 구간의 양 끝 day 가 functions 산술에서 같은 라벨로 떨어지는지.
    for (const [label, lo, hi] of entries) {
      if (label === "Pre") continue;   // 표시 창 계산은 Pre 를 D-60 으로 clamp
      expect(labelForIndex(bucketIndexForAge(lo))).toBe(label);
      expect(labelForIndex(bucketIndexForAge(hi))).toBe(label);
    }
  });
});
