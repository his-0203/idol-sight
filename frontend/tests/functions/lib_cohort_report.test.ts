// frontend/tests/functions/lib_cohort_report.test.ts
//
// 투자사 보고에 들어가는 수치라 계산 규칙을 테스트로 고정한다:
// 인덱스 = D0 기준값 100 정규화, 성장배수 = D+N/D0, 순위 = 내림차순.
import { describe, expect, it } from "vitest";
import {
  BASE_WINDOW, ESTIMATE_SOURCE, PRE_BASE_WINDOW, PRE_DEBUT_DAYS,
  baseValueAt, growthMultiple, indexCurve, measuredOnly, preMultiple,
  rankOf, subsPer1kViews,
} from "../../functions/lib/cohortReport";

// empty_window 주석의 "base.day >= fromDay 항상 참" 전제는 base 탐색 폭이
// 표시 구간보다 좁을 때만 성립한다 — 상수를 바꾸다 조용히 깨지지 않게 고정.
it("불변식: PRE_DEBUT_DAYS > BASE_WINDOW", () => {
  expect(PRE_DEBUT_DAYS).toBeGreaterThan(BASE_WINDOW);
});

const pts = (entries: Array<[number, number, string?]>) =>
  new Map(entries.map(([d, v, s]) => [d, { value: v, source: s ?? "live" }]));

describe("baseValueAt", () => {
  it("targetDay 정확 일치 우선, 없으면 윈도 내 최근접(동률은 이른 날)", () => {
    expect(baseValueAt(pts([[0, 10]]), 0, 3)).toEqual({ day: 0, value: 10, source: "live" });
    expect(baseValueAt(pts([[-2, 5], [2, 7]]), 0, 3)!.day).toBe(-2); // |−2|=|2| → 이른 날
    expect(baseValueAt(pts([[5, 9]]), 0, 3)).toBeNull(); // 윈도 밖
  });
});

describe("indexCurve", () => {
  it("D0=100 정규화, 데뷔 전 구간 포함 ~ asOfDay 까지", () => {
    const out = indexCurve(pts([[-5, 100], [0, 200], [10, 300], [43, 500], [60, 900]]), 43).curve!;
    // 데뷔 전 점은 기준값으로 나뉘어 100 아래에 깔린다 (100/200 = 50).
    expect(out[0]).toEqual({ day: -5, index: 50, source: "live" });
    expect(out.find((p) => p.day === 0)!.index).toBe(100);
    expect(out.find((p) => p.day === 10)!.index).toBe(150);
    expect(out.find((p) => p.day === 43)!.index).toBe(250);
    // asOfDay 뒤는 여전히 자른다 — "아직 오지 않은 날"을 그리지 않는다.
    expect(out.some((p) => p.day > 43)).toBe(false);
  });
  // 표시 구간을 넓혀도 기준값(D0±BASE_WINDOW)은 그대로 — 성장배수·순위가
  // 데뷔 전 값에 끌려가면 안 된다.
  it("데뷔 전 구간 경계: -PRE_DEBUT_DAYS 는 포함, 그 하루 전은 제외", () => {
    const out = indexCurve(pts([
      [-PRE_DEBUT_DAYS - 1, 10], [-PRE_DEBUT_DAYS, 20], [0, 100],
    ]), 43).curve!;
    expect(out[0]).toEqual({ day: -PRE_DEBUT_DAYS, index: 20, source: "live" });
    expect(out.some((p) => p.day === -PRE_DEBUT_DAYS - 1)).toBe(false);
    // 기준은 여전히 D0 값(100) — 창을 넓혀도 100 인덱스의 위치는 안 움직인다.
    expect(out.find((p) => p.day === 0)!.index).toBe(100);
  });
  it("기준점이 음수일이면 그 날이 100 (합성 D0 포인트 만들지 않음)", () => {
    const out = indexCurve(pts([[-2, 50], [10, 100]]), 43).curve!;
    expect(out.find((p) => p.day === -2)).toEqual({ day: -2, index: 100, source: "live" });
    expect(out.some((p) => p.day === 0)).toBe(false); // D0 스냅샷 없음 → 합성 금지
    expect(out.find((p) => p.day === 10)!.index).toBe(200);
  });
  it("데뷔 전 수집이 없는 팀은 곡선이 늦게 시작할 뿐 (빈 날 합성 금지)", () => {
    const out = indexCurve(pts([[0, 100], [20, 150]]), 43).curve!;
    expect(out[0]!.day).toBe(0);
    expect(out).toHaveLength(2);
  });
  it("D0 기준값 없음/0이면 no_d0_baseline (가짜 수치 생성 금지)", () => {
    expect(indexCurve(pts([[20, 300]]), 43)).toEqual({ curve: null, reason: "no_d0_baseline" });
    expect(indexCurve(pts([[0, 0], [10, 5]]), 43))
      .toEqual({ curve: null, reason: "no_d0_baseline" });
  });
  it("기준값은 있는데 창 안에 점이 없으면 empty_window (두 사유를 뭉치지 않음)", () => {
    // 기준값은 D+2 (D0±3 안) 인데 asOfDay=1 이라 fromDay..asOfDay 창이 빈다.
    const out = indexCurve(pts([[2, 500]]), 1);
    expect(out).toEqual({ curve: null, reason: "empty_window" });
  });
  it("같은 상황이라도 데뷔 전 점이 있으면 곡선이 선다 (창을 넓힌 효과)", () => {
    // 기준값 D+2, asOfDay=1 로 위와 동일하지만 D-10 점이 창 안에 들어온다.
    const out = indexCurve(pts([[-10, 250], [2, 500]]), 1).curve!;
    expect(out).toEqual([{ day: -10, index: 50, source: "live" }]);
  });
});

describe("growthMultiple", () => {
  it("D+asOfDay 최근접값 / D0 기준값", () => {
    expect(growthMultiple(pts([[0, 100], [42, 350]]), 43)).toBeCloseTo(3.5);
  });
  it("기준 또는 도달값 없으면 null", () => {
    expect(growthMultiple(pts([[0, 100]]), 43)).toBeNull(); // D+43 근방 없음
    expect(growthMultiple(pts([[43, 100]]), 43)).toBeNull(); // D0 없음
  });
});

describe("rankOf", () => {
  it("내림차순 1-based: 나보다 큰 값 개수 + 1", () => {
    expect(rankOf(3.5, [1.2, 5.0, 2.0])).toBe(2);
    expect(rankOf(9, [1, 2])).toBe(1);
    expect(rankOf(1, [2, 3, 4])).toBe(4);
  });
});

describe("measuredOnly", () => {
  it("추정 보간값만 걷어내고 원본은 그대로 둔다", () => {
    const src = pts([[0, 100], [5, 200, ESTIMATE_SOURCE], [10, 300, "backfill_exact"]]);
    const out = measuredOnly(src);
    expect([...out.keys()].sort((a, b) => a - b)).toEqual([0, 10]);
    expect(src.size).toBe(3); // 원본 불변
  });
});

describe("preMultiple", () => {
  it("데뷔일 값 ÷ D-PRE_DEBUT_DAYS 값", () => {
    expect(preMultiple(pts([[-PRE_DEBUT_DAYS, 100], [0, 250]]))).toBeCloseTo(2.5);
  });
  // 데뷔 전 앵커는 주 1회라 ±3 이면 다 빠진다 — ±7 이 필요한 이유.
  it("데뷔 전 기준값 탐색 폭은 ±PRE_BASE_WINDOW (경계 포함, 그 밖은 null)", () => {
    const inside = -PRE_DEBUT_DAYS + PRE_BASE_WINDOW;
    expect(preMultiple(pts([[inside, 100], [0, 300]]))).toBeCloseTo(3);
    const outside = -PRE_DEBUT_DAYS + PRE_BASE_WINDOW + 1;
    expect(preMultiple(pts([[outside, 100], [0, 300]]))).toBeNull();
  });
  it("한쪽 값이 없거나 0 이면 null (무한대급 배수 금지)", () => {
    expect(preMultiple(pts([[0, 300]]))).toBeNull();
    expect(preMultiple(pts([[-PRE_DEBUT_DAYS, 100]]))).toBeNull();
    expect(preMultiple(pts([[-PRE_DEBUT_DAYS, 0], [0, 300]]))).toBeNull();
  });
});

describe("subsPer1kViews", () => {
  // 구독자·조회수가 **같은 날** 다 있는 날짜에서만 양 끝을 집는다.
  it("공통 날짜에서 구독자 증분 ÷ (조회수 증분/1000)", () => {
    const subs = pts([[0, 1_000], [43, 3_000]]);
    const views = pts([[0, 100_000], [43, 1_100_000]]);
    // 구독 +2,000 / 조회 +1,000,000 → 1,000뷰당 2.0
    expect(subsPer1kViews(subs, views, 0, 3, 43, 7)).toBeCloseTo(2);
  });
  it("한쪽에만 있는 날짜는 후보에서 빠진다 (구간 어긋남 방지)", () => {
    // 구독자는 D+43 에 있지만 조회수는 D+40 에만 있다 → 공통 날짜는 D0 뿐.
    const subs = pts([[0, 1_000], [43, 9_999]]);
    const views = pts([[0, 100_000], [40, 500_000]]);
    expect(subsPer1kViews(subs, views, 0, 3, 43, 7)).toBeNull();
  });
  it("조회수 증분이 0 이하이면 null (분모 0 근처 폭주 금지)", () => {
    const flat = pts([[0, 100_000], [43, 100_000]]);
    expect(subsPer1kViews(pts([[0, 1_000], [43, 5_000]]), flat, 0, 3, 43, 7)).toBeNull();
    const down = pts([[0, 200_000], [43, 100_000]]);
    expect(subsPer1kViews(pts([[0, 1_000], [43, 5_000]]), down, 0, 3, 43, 7)).toBeNull();
  });
  it("양 끝이 같은 날로 잡히면 null (구간이 없다)", () => {
    const subs = pts([[0, 1_000]]);
    const views = pts([[0, 100_000]]);
    expect(subsPer1kViews(subs, views, 0, 3, 2, 7)).toBeNull();
  });
  // 탐색 폭이 겹치면 뒤집힌 구간(a > b)이 나올 수 있다 — 증분 부호가 통째로
  // 반대라 dViews>0 가드에 우연히 걸리는 것에 기대지 않고 명시적으로 막는다.
  it("구간이 뒤집히면(시작 > 끝) null", () => {
    // 시작 목표 D+10(±7), 끝 목표 D+2(±7) → 후보 {0, 12} 에서 a=12, b=0.
    const subs = pts([[0, 1_000], [12, 5_000]]);
    const views = pts([[0, 100_000], [12, 900_000]]);
    expect(subsPer1kViews(subs, views, 10, 7, 2, 7)).toBeNull();
  });
  it("호출부가 실측만 넘기면 추정 점은 계산에 안 들어간다", () => {
    const subs = measuredOnly(pts([[0, 1_000], [20, 9_999, ESTIMATE_SOURCE], [43, 3_000]]));
    const views = measuredOnly(pts([
      [0, 100_000], [20, 200_000, ESTIMATE_SOURCE], [43, 1_100_000],
    ]));
    expect(subsPer1kViews(subs, views, 0, 3, 43, 7)).toBeCloseTo(2);
  });
});
