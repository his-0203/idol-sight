# Debut Window 롤링 윈도우 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Debut Window 를 데뷔일 고정 ±60일 스냅샷에서, MiiWAN 나이를 따라 20일에 한 칸씩 앞으로 굴러가는 7버킷(140일) 롤링 윈도우로 전환한다.

**Architecture:** worker 는 `Post` catch-all 을 폐기하고 `d≥10 → D+20k` 산술로 무한 버킷을 생성한다 (기존 Post 행은 migration 으로 재배치). 표시 창은 Pages Functions `summary.ts` 가 D1 의 MiiWAN `debut_date` 로 계산해 응답 `window` 메타로 내려주고, 세 프런트 컴포넌트는 정적 `DISPLAY_BUCKETS` 대신 이 메타를 렌더한다. MiiWAN 이 D+70 (2026-08-25) 에 도달하기 전까지 화면은 현행과 완전 동일하다.

**Tech Stack:** Python 3.12 (uv/pytest), Cloudflare Pages Functions (TS), Preact, vitest, D1 migration.

**스펙:** `docs/superpowers/specs/2026-06-11-debut-window-rolling-window-design.md`

---

## 파일 구조

| 파일 | 작업 |
|---|---|
| `worker/src/idol_sight/analysis/debut_window.py` | `WINDOW_BUCKETS` 5개 축소 + `bucket_for` 산술 확장, defensive `None` 분기 제거 |
| `worker/tests/unit/test_debut_window.py` | 9-bucket/Post 테스트 갱신 + 산술 경계 테스트 추가 |
| `migrations/0085_debut_window_rolling_post_split.sql` | 신규 — Post 행 재배치 + summary DELETE (0073 패턴) |
| `frontend/functions/lib/debutWindowBuckets.ts` | 전면 재작성 — `FRONTEND_BUCKET_MAP`/`VALID_BUCKETS` 폐기, 산술 함수군 신설 |
| `frontend/functions/api/debut-window/summary.ts` | 창 계산 + `window` 메타 응답, CASE 빌더 제거 |
| `frontend/functions/api/debut-window/videos.ts` | bucket 검증 동적화 |
| `frontend/src/lib/debutWindow.ts` | `DISPLAY_BUCKETS` → fallback 상수로 교체 |
| `frontend/src/api.ts` | `debutWindowSummary` 반환 타입에 `window` 메타 |
| `frontend/src/components/DebutWindowKPI.tsx` | 응답 메타 기반 렌더 |
| `frontend/src/components/CompetitorOrganicityBar.tsx` | 〃 + 기본 탭 = `current_bucket` |
| `frontend/src/components/DebutWindowVideoTable.tsx` | 〃 + mount 시 summary 1회 호출 |
| `frontend/tests/lib/debutWindow.test.ts` | cross-language 가드 재작성 |
| `frontend/tests/lib/debutWindowBuckets.test.ts` | 신규 — 산술/창/검증 단위 테스트 |
| `docs/analysis-formulas-reference.md` §6.8 | 버킷 정의 갱신 |
| `CLAUDE.md` | V2.49 항목 추가 |

**소비처 전수 확인 결과** (플랜 작성 시 검증 완료):
- `debutWindowBuckets` import: `summary.ts`, `videos.ts`, `tests/lib/debutWindow.test.ts` 뿐. `videos-all.ts` 는 bucket 무의존 (무변경).
- `DISPLAY_BUCKETS` import: 컴포넌트 3개 + `tests/lib/debutWindow.test.ts` 뿐.
- `bucket_for` 호출: `debut_window.py` 내부뿐.
- weekly_diagnosis 는 `published_at` 범위로만 organicity 조회 (버킷 무관) — 무영향.

---

### Task 1: worker `bucket_for` 산술 전환 (TDD)

**Files:**
- Modify: `worker/src/idol_sight/analysis/debut_window.py:40-59` (주석+상수), `:138-146` (`bucket_for`), `:437-439` (defensive 분기)
- Test: `worker/tests/unit/test_debut_window.py`

- [ ] **Step 1: 실패하는 산술 테스트 추가**

`worker/tests/unit/test_debut_window.py` 의 `test_bucket_for_extreme_values` 아래에 추가:

```python
def test_bucket_for_positive_arithmetic_unbounded():
    """V2.49 롤링 윈도우: d>=10 은 20일 폭 산술 생성 (Post catch-all 폐기).
    k = (d-10)//20 + 1 → f"D+{20k}". D+20/D+40/D+60 경계는 V2.34 와 동일."""
    assert bucket_for(70) == "D+80"
    assert bucket_for(89) == "D+80"
    assert bucket_for(90) == "D+100"
    assert bucket_for(109) == "D+100"
    assert bucket_for(200) == "D+200"
    assert bucket_for(400) == "D+400"
    assert bucket_for(1500) == "D+1500"


def test_bucket_for_never_returns_post():
    """V2.49: 'Post' 라벨은 더 이상 생성되지 않는다 (migration 0085 가
    기존 행 재배치). 양수 전 구간이 D+N (N=20 배수) 형식."""
    for d in range(10, 500):
        label = bucket_for(d)
        assert label != "Post"
        assert label.startswith("D+")
        n = int(label[2:])
        assert n >= 20 and n % 20 == 0


def test_bucket_for_positive_buckets_are_20d_uniform():
    """V2.49: 산술 버킷 경계가 d=10+20j 에서만 바뀜 — 전부 20일 폭."""
    changes = []
    prev = None
    for d in range(10, 210):
        lab = bucket_for(d)
        if lab != prev:
            changes.append(d)
            prev = lab
    assert changes == [10, 30, 50, 70, 90, 110, 130, 150, 170, 190]
```

- [ ] **Step 2: 실패 확인**

Run: `cd worker && uv run pytest tests/unit/test_debut_window.py -k "positive_arithmetic or never_returns_post or 20d_uniform" -v`
Expected: FAIL — `bucket_for(70)` 가 `"Post"` 반환.

- [ ] **Step 3: 구현**

`debut_window.py:49-59` 의 `WINDOW_BUCKETS` 를 교체 (직전 주석 블록 `:40-48` 도 함께):

```python
# V2.49 (2026-06-11) 롤링 윈도우: 음수 측(데뷔 전) + D-Day 만 고정 목록.
# d >= 10 (데뷔 후) 는 bucket_for 가 산술 생성 — k = (d-10)//20 + 1 →
# f"D+{20k}" (20일 폭 무한 시리즈: D+20, D+40, …, D+80, D+100, …).
# 'Post' catch-all 은 폐기 (migration 0085 가 기존 행 재배치). 'Pre' 는
# 유지 — 표시 창이 과거로는 밀리지 않으므로 음수 무한 시리즈는 불필요.
#
# 표시 창(연속 7버킷)은 frontend functions/lib/debutWindowBuckets.ts 가
# anchor(MiiWAN) 데뷔 경과일로 계산. 경계 동일성은 frontend
# tests/lib/debutWindow.test.ts 의 cross-language fixture 가 핀.
WINDOW_BUCKETS: list[tuple[str, int, int]] = [
    ("Pre",   -999999, -71),
    ("D-60",     -70,  -51),
    ("D-40",     -50,  -31),
    ("D-20",     -30,  -11),
    ("D-Day",    -10,    9),
]
```

`bucket_for` (`:138-146`) 교체:

```python
def bucket_for(days_relative: int) -> str:
    """Map a signed day offset to its bucket label.

    ``days_relative`` is days from debut: negative = before, positive = after.
    음수/D-Day 는 WINDOW_BUCKETS 고정 목록, d >= 10 은 20일 폭 산술 생성
    (무한 시리즈). V2.49 부터 총함수 — None 을 반환하지 않는다.
    """
    for label, lo, hi in WINDOW_BUCKETS:
        if lo <= days_relative <= hi:
            return label
    k = (days_relative - 10) // 20 + 1
    return f"D+{20 * k}"
```

`build_video_organicity` 내 (`:437-439`) defensive 분기 제거:

```python
        if debut_date:
            days_rel = _days_between(debut_date, r["published_at"])
            bucket = bucket_for(days_rel)
```

(`if bucket is None: continue` 두 줄 삭제. docstring `:427-428` 의 "Pre/Post buckets catch ±60d outside videos" 도 "Pre + 산술 D+N 버킷이 전 기간을 커버" 로 갱신.)

- [ ] **Step 4: 신규 테스트 통과 확인**

Run: `cd worker && uv run pytest tests/unit/test_debut_window.py -k "positive_arithmetic or never_returns_post or 20d_uniform" -v`
Expected: PASS 3건.

- [ ] **Step 5: 기존 테스트 갱신** (Post 전제 테스트들)

같은 파일에서:

(a) `test_window_buckets_are_9_non_overlapping_ranges` (`:21-49`) 전체 교체:

```python
def test_window_buckets_fixed_entries():
    """V2.49 롤링 윈도우: WINDOW_BUCKETS 는 음수 측 + D-Day 고정 5개만
    (Post 폐기). d >= 10 은 bucket_for 의 산술 생성 (20일 폭 무한)."""
    assert len(WINDOW_BUCKETS) == 5
    labels = [b[0] for b in WINDOW_BUCKETS]
    assert labels == ["Pre", "D-60", "D-40", "D-20", "D-Day"]
    flat = [(lo, hi) for _, lo, hi in WINDOW_BUCKETS]
    assert flat == [
        (-999999, -71),
        (-70, -51),
        (-50, -31),
        (-30, -11),
        (-10,   9),
    ]
    # 균등 20일 폭 회귀 가드 — named 음수 bucket + D-Day 모두 20일.
    named = [b for b in WINDOW_BUCKETS if b[0] != "Pre"]
    assert all(hi - lo + 1 == 20 for _, lo, hi in named)
```

(b) parametrize `test_bucket_for_returns_correct_bucket` (`:52-90`) 의 Pre/Post 케이스 4줄 교체 — `(-100, "Pre"), (-71, "Pre")` 유지, `(70, "Post"), (200, "Post")` 를 다음으로 교체:

```python
    # 산술 생성 (V2.49 — Post 폐기)
    (70,   "D+80"),
    (200,  "D+200"),
```

(c) `test_bucket_for_outside_pm_69_maps_to_pre_post` (`:806-813`) 교체:

```python
def test_bucket_for_outside_pm_69():
    """V2.49: -71 이하는 Pre 유지, +70 이상은 산술 D+N (Post 폐기)."""
    assert bucket_for(-71) == "Pre"
    assert bucket_for(-100) == "Pre"
    assert bucket_for(-999999) == "Pre"
    assert bucket_for(70) == "D+80"
    assert bucket_for(100) == "D+100"
```

(d) `test_bucket_for_pre_post_boundary` 교체:

```python
def test_bucket_for_pre_and_arithmetic_boundary():
    """V2.49: Pre/D-60 경계 유지, D+60/D+80 경계는 산술."""
    assert bucket_for(-71) == "Pre"
    assert bucket_for(-70) == "D-60"
    assert bucket_for(69) == "D+60"
    assert bucket_for(70) == "D+80"
```

(e) `test_bucket_for_extreme_values` 교체:

```python
def test_bucket_for_extreme_values():
    """V2.49: 극단값 — 음수는 Pre, 양수는 산술 (overflow 없는 int)."""
    assert bucket_for(-999999) == "Pre"
    assert bucket_for(999999) == "D+1000000"
```

(f) `test_bucket_for_year_old_videos` — 본문을 읽고 Post 단정을 산술 라벨로 교체 (예: ISEDOL 4년차 영상 `bucket_for(1500) == "D+1500"` 패턴). 본문이 Post 를 단정하지 않으면 무변경.

(g) `grep -n '"Post"' worker/tests/ -r` 로 잔여 Post 단정 전수 확인 후 동일 방식 갱신. `build_video_organicity`/`build_summary` 테스트가 Post 행 fixture 를 쓰면 산술 라벨로 교체.

- [ ] **Step 6: worker 전체 테스트**

Run: `cd worker && uv run pytest`
Expected: 전체 PASS (724+ 기준, 신규 3건 추가).

- [ ] **Step 7: Commit**

```bash
git add worker/src/idol_sight/analysis/debut_window.py worker/tests/unit/test_debut_window.py
git commit -m "feat(worker): Debut Window Post catch-all 폐기 — d>=10 산술 D+20k 무한 버킷 (V2.49)"
```

---

### Task 2: migration 0085 — Post 행 재배치

**Files:**
- Create: `migrations/0085_debut_window_rolling_post_split.sql`

- [ ] **Step 1: migration 작성**

```sql
-- migrations/0085_debut_window_rolling_post_split.sql
--
-- V2.49 — Debut Window 롤링 윈도우: 'Post' catch-all (days >= +70) 폐기.
-- worker bucket_for 가 d >= 10 을 20일 폭 산술 라벨 (D+20k, k=(d-10)/20+1)
-- 로 생성하게 바뀌므로, 기존 Post 행을 같은 산식으로 재배치한다.
-- (0073 패턴 — UPDATE in-place + summary DELETE 후 cron 재집계.)
--
-- SQLite 정수 나눗셈은 양수에서 truncate = Python floor 와 동일 (d>=70 이라
-- 항상 양수). window_bucket 은 CHECK 없는 TEXT 라 새 라벨 삽입 자유 (V2.42).

-- 1) per-video 테이블: Post 행만 산술 라벨로 재할당.
UPDATE debut_window_video_organicity
SET window_bucket = 'D+' || (((days_relative_to_debut - 10) / 20 + 1) * 20)
WHERE window_bucket = 'Post';

-- 2) summary 테이블: bucket 구성이 바뀌므로 통째로 비우고 다음 worker cron
--    의 build_summary 가 재집계. (몇 시간의 'Loading…' 은 운영자 수용,
--    즉시 채우려면 worker aggregate 수동 dispatch.)
DELETE FROM debut_window_organicity_summary;
```

- [ ] **Step 2: 로컬 적용 검증**

Run: `cd frontend && wrangler d1 migrations apply idol-sight --local`
Expected: 0085 적용 성공. (로컬 DB 에 Post 행이 없어도 UPDATE 0건으로 무해.)

검증 쿼리 (로컬에 데이터 있으면):
```bash
cd frontend && wrangler d1 execute idol-sight --local --command \
  "SELECT window_bucket, COUNT(*) FROM debut_window_video_organicity WHERE window_bucket='Post' GROUP BY 1"
```
Expected: 0 rows.

- [ ] **Step 3: Commit**

```bash
git add migrations/0085_debut_window_rolling_post_split.sql
git commit -m "feat(migration): 0085 — Debut Window Post 행 산술 D+N 재배치 + summary 재집계 (V2.49)"
```

---

### Task 3: `functions/lib/debutWindowBuckets.ts` 재작성 (TDD)

**Files:**
- Rewrite: `frontend/functions/lib/debutWindowBuckets.ts`
- Create: `frontend/tests/lib/debutWindowBuckets.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/tests/lib/debutWindowBuckets.test.ts` 신규:

```ts
import { describe, expect, it } from "vitest";
import {
  WINDOW_SIZE,
  bucketIndexForAge,
  currentBucket,
  debutAgeDaysKST,
  displayBuckets,
  isValidBucketLabel,
  labelForIndex,
} from "../../functions/lib/debutWindowBuckets";

// worker bucket_for 와 같은 경계 fixture. worker 쪽은
// worker/tests/unit/test_debut_window.py 의 parametrize 가 같은 표를 핀
// (cross-language 가드 — 한쪽만 바꾸면 양쪽 테스트가 같이 깨져야 함).
const BOUNDARY_FIXTURE: Array<[number, string]> = [
  [-70, "D-60"], [-51, "D-60"],
  [-50, "D-40"], [-31, "D-40"],
  [-30, "D-20"], [-11, "D-20"],
  [-10, "D-Day"], [0, "D-Day"], [9, "D-Day"],
  [10, "D+20"], [29, "D+20"],
  [30, "D+40"], [49, "D+40"],
  [50, "D+60"], [69, "D+60"],
  [70, "D+80"], [89, "D+80"],
  [90, "D+100"], [200, "D+200"], [400, "D+400"],
];

describe("bucket arithmetic (worker bucket_for parity)", () => {
  it.each(BOUNDARY_FIXTURE)("day %i → %s", (day, label) => {
    expect(labelForIndex(bucketIndexForAge(day))).toBe(label);
  });

  it("currentBucket is the label of today's bucket", () => {
    expect(currentBucket(-5)).toBe("D-Day");
    expect(currentBucket(75)).toBe("D+80");
  });
});

describe("displayBuckets (rolling 7-bucket window)", () => {
  const FIXED = ["D-60", "D-40", "D-20", "D-Day", "D+20", "D+40", "D+60"];

  it("pre-debut and up to D+69 → fixed legacy window", () => {
    expect(displayBuckets(-100)).toEqual(FIXED);
    expect(displayBuckets(-5)).toEqual(FIXED);
    expect(displayBuckets(0)).toEqual(FIXED);
    expect(displayBuckets(69)).toEqual(FIXED);
  });

  it("D+70 → first slide (D-60 out, D+80 in)", () => {
    expect(displayBuckets(70)).toEqual(
      ["D-40", "D-20", "D-Day", "D+20", "D+40", "D+60", "D+80"],
    );
    expect(displayBuckets(89)).toEqual(displayBuckets(70));
  });

  it("D+130 → D-Day has rolled out", () => {
    expect(displayBuckets(130)).toEqual(
      ["D+20", "D+40", "D+60", "D+80", "D+100", "D+120", "D+140"],
    );
  });

  it("window is always WINDOW_SIZE consecutive buckets", () => {
    for (const age of [-50, 0, 69, 70, 150, 365]) {
      expect(displayBuckets(age)).toHaveLength(WINDOW_SIZE);
    }
  });
});

describe("isValidBucketLabel", () => {
  it("accepts named + arithmetic labels", () => {
    for (const l of ["D-60", "D-40", "D-20", "D-Day", "D+20", "D+80", "D+400"]) {
      expect(isValidBucketLabel(l)).toBe(true);
    }
  });
  it("rejects everything else", () => {
    for (const l of ["Post", "Pre", "Undated", "D+30", "D+0", "D-80", "D+20k", "", "x"]) {
      expect(isValidBucketLabel(l)).toBe(false);
    }
  });
});

describe("debutAgeDaysKST", () => {
  it("debut day itself in KST is age 0", () => {
    // 2026-06-16 00:30 KST = 2026-06-15T15:30Z
    expect(debutAgeDaysKST("2026-06-16", new Date("2026-06-15T15:30:00Z"))).toBe(0);
  });
  it("UTC date lag does not understate age (KST is the calendar)", () => {
    // 2026-06-17 08:00 KST = 2026-06-16T23:00Z — UTC 는 아직 16일이지만 KST 는 17일
    expect(debutAgeDaysKST("2026-06-16", new Date("2026-06-16T23:00:00Z"))).toBe(1);
  });
  it("pre-debut is negative", () => {
    expect(debutAgeDaysKST("2026-06-16", new Date("2026-06-11T03:00:00Z"))).toBe(-5);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && pnpm vitest run tests/lib/debutWindowBuckets.test.ts`
Expected: FAIL — `labelForIndex` 등 export 부재.

- [ ] **Step 3: `debutWindowBuckets.ts` 전면 재작성**

```ts
// frontend/functions/lib/debutWindowBuckets.ts
//
// V2.49 (2026-06-11): 롤링 윈도우 — 정적 FRONTEND_BUCKET_MAP identity 맵
// 폐기. 버킷 라벨은 worker bucket_for (debut_window.py) 와 동일한 산술
// 규칙으로 생성/검증한다:
//   음수 측: D-60(-70..-51) / D-40(-50..-31) / D-20(-30..-11) / D-Day(-10..9)
//   d >= 10: D+20k (k = floor((d-10)/20) + 1) — 20일 폭 무한 시리즈
// 표시 창은 anchor 그룹(MiiWAN)의 데뷔 경과일이 속한 버킷을 오른쪽 끝으로
// 한 연속 7버킷. 오른쪽 끝 최소 D+60 — 데뷔 전~D+69 는 현행 고정 창과 동일.
// worker 와의 경계 동일성은 tests/lib/debutWindowBuckets.test.ts 의
// BOUNDARY_FIXTURE 가 핀 (worker 쪽은 test_debut_window.py parametrize).

export const ANCHOR_GROUP_KEY = "miiwan";
export const WINDOW_SIZE = 7;
export const UNDATED_BUCKET = "Undated";

// 개념적 무한 시퀀스의 고정 prefix (index 0..3). index 4+ 는 D+20(i-3).
const NEGATIVE_LABELS = ["D-60", "D-40", "D-20", "D-Day"] as const;

// 시퀀스 index → 버킷 라벨.
export function labelForIndex(i: number): string {
  if (i < 0 || !Number.isInteger(i)) {
    throw new Error(`bucket index out of range: ${i}`);
  }
  if (i < NEGATIVE_LABELS.length) return NEGATIVE_LABELS[i]!;
  return `D+${20 * (i - 3)}`;
}

// 데뷔 경과일 → 그 날이 속한 버킷의 시퀀스 index.
// worker bucket_for 와 동일 경계. -51 미만(Pre 포함)은 0 으로 clamp —
// 표시 창 계산 용도라 Pre 구분이 필요 없다.
export function bucketIndexForAge(ageDays: number): number {
  if (ageDays <= -51) return 0;
  if (ageDays <= -31) return 1;
  if (ageDays <= -11) return 2;
  if (ageDays <= 9) return 3;
  return Math.floor((ageDays - 10) / 20) + 4;
}

// 오늘이 속한 버킷 라벨 — 컴포넌트의 기본 선택 탭.
export function currentBucket(ageDays: number): string {
  return labelForIndex(bucketIndexForAge(ageDays));
}

// 표시 창: 오른쪽 끝 = max(오늘 버킷, D+60(index 6)) 인 연속 7버킷.
// currentBucket(ageDays) 는 항상 이 창 안에 있다 (오른쪽 끝이 오늘 버킷
// 이상으로만 확장되고 창 폭 7 > 음수 측 깊이 4 이므로).
export function displayBuckets(ageDays: number): string[] {
  const right = Math.max(6, bucketIndexForAge(ageDays));
  const start = right - (WINDOW_SIZE - 1);
  return Array.from({ length: WINDOW_SIZE }, (_, j) => labelForIndex(start + j));
}

// ?bucket= 파라미터 검증 — named 4종 + "D+N (N = 20 의 배수 ≥ 20)".
export function isValidBucketLabel(label: string): boolean {
  if ((NEGATIVE_LABELS as readonly string[]).includes(label)) return true;
  const m = /^D\+(\d+)$/.exec(label);
  if (!m) return false;
  const n = Number(m[1]);
  return n >= 20 && n % 20 === 0;
}

// KST 달력 기준 데뷔 경과일. debut_date 는 'YYYY-MM-DD' (KST 달력 날짜),
// now 는 UTC Date. 둘 다 UTC midnight 타임스탬프로 환산해 정수일 차분.
export function debutAgeDaysKST(debutDate: string, now: Date): number {
  const kstTodayIso = new Date(now.getTime() + 9 * 3_600_000)
    .toISOString().slice(0, 10);
  return Math.round((Date.parse(kstTodayIso) - Date.parse(debutDate)) / 86_400_000);
}
```

- [ ] **Step 4: 신규 테스트 통과 확인**

Run: `cd frontend && pnpm vitest run tests/lib/debutWindowBuckets.test.ts`
Expected: PASS 전건. (기존 `tests/lib/debutWindow.test.ts` 는 이 시점에 컴파일 FAIL — Task 6 에서 재작성. 전체 suite 는 Task 7 에서.)

- [ ] **Step 5: Commit**

```bash
git add frontend/functions/lib/debutWindowBuckets.ts frontend/tests/lib/debutWindowBuckets.test.ts
git commit -m "feat(functions): debutWindowBuckets 산술 재작성 — displayBuckets 롤링 창 + 동적 라벨 검증 (V2.49)"
```

---

### Task 4: API — `summary.ts` 창 메타 + `videos.ts` 검증 동적화

**Files:**
- Modify: `frontend/functions/api/debut-window/summary.ts`
- Modify: `frontend/functions/api/debut-window/videos.ts`
- Modify: `frontend/src/api.ts:49-55`

- [ ] **Step 1: `summary.ts` 개편**

import 교체 (`:14-18` 헤더 주석 + import):

```ts
// videos.ts 와 같은 debutWindowBuckets 산술 모듈을 공유.
// V2.49: 응답에 window 메타 (롤링 창 버킷 리스트 + 오늘 버킷) 동봉 —
// 프런트 3 컴포넌트 (KPI / CompetitorOrganicityBar / VideoTable) 가
// 정적 탭 대신 이 메타를 렌더한다.

import { d1Query, type D1Database } from "../../lib/d1";
import { jsonResponse } from "../../lib/jsonResponse";
import {
  ANCHOR_GROUP_KEY,
  UNDATED_BUCKET,
  currentBucket,
  debutAgeDaysKST,
  displayBuckets,
  isValidBucketLabel,
} from "../../lib/debutWindowBuckets";
```

`const UNDATED_BUCKET = "Undated";` 로컬 상수 (`:45`), `buildBucketCase()` 함수 (`:47-60`), `ALL_WORKER_BUCKETS` (`:62-63`) 삭제.

핸들러 앞부분 (`:65-81`) 교체:

```ts
export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env, request }) => {
  const url = new URL(request.url);
  const bucket = url.searchParams.get("bucket");

  // V2.49 롤링 윈도우 — anchor(MiiWAN) 데뷔 경과일이 표시 창을 결정.
  // debut_date 미설정(이론상 없음)이면 age 0 → 데뷔 전 고정 창과 동일.
  const anchorRows = await d1Query<{ debut_date: string | null }>(
    env.DB, "SELECT debut_date FROM groups WHERE key = ?", [ANCHOR_GROUP_KEY],
  );
  const debutDate = anchorRows[0]?.debut_date ?? null;
  const ageDays = debutDate ? debutAgeDaysKST(debutDate, new Date()) : 0;
  const windowBuckets = displayBuckets(ageDays);
  const nowBucket = currentBucket(ageDays);

  let targetBuckets: string[];
  if (bucket) {
    if (!isValidBucketLabel(bucket)) {
      return jsonResponse({ error: "invalid bucket" }, 400);
    }
    targetBuckets = [bucket];
  } else {
    // 카드 fetch (필터 없음): 창 7버킷 + Undated passthrough (V2.42).
    targetBuckets = [...windowBuckets, UNDATED_BUCKET];
  }

  const placeholders = targetBuckets.map(() => "?").join(",");
```

SQL 내 `${bucketCase} AS window_bucket` (`:90`) → `window_bucket` 으로 교체 (V2.34 부터 worker↔frontend 1:1 identity 라 CASE 는 항등이었음 — 동적 라벨에선 passthrough 가 정확). `const bucketCase = buildBucketCase();` 줄 삭제. 마지막 응답 (`:143-144`) 교체:

```ts
  const rows = await d1Query<SummaryRow>(env.DB, sql, targetBuckets);
  return jsonResponse({
    rows,
    window: { buckets: windowBuckets, current_bucket: nowBucket },
  }, 200);
```

(파라미터 변수명 `targetWorkerBuckets` → `targetBuckets` 일괄.)

- [ ] **Step 2: `videos.ts` 검증 동적화**

import (`:9`) 교체:

```ts
import { isValidBucketLabel } from "../../lib/debutWindowBuckets";
```

검증 + WHERE (`:36-44`, `:53-55`) 교체:

```ts
  if (!bucket || !isValidBucketLabel(bucket)) {
    return jsonResponse({ error: "valid bucket required" }, 400);
  }
```

```ts
    WHERE o.group_key = ? AND o.window_bucket = ?
```

```ts
  const params: (string | number)[] = [group, bucket];
```

(`const workerBuckets = FRONTEND_BUCKET_MAP[bucket]!;` 와 `bucketPlaceholders` 줄 삭제. 헤더 주석의 "D-60/D-30/D-Day/D+30/D+60" 도 "named 4종 + D+20 배수 (V2.49 산술)" 로 갱신.)

- [ ] **Step 3: `src/api.ts` 반환 타입 갱신**

`:49-55` 교체:

```ts
  debutWindowSummary: <T = unknown>(bucket?: string): Promise<{
    rows: T[];
    // V2.49: 롤링 창 메타 — 표시 버킷 리스트 + 오늘(anchor 기준) 버킷.
    window?: { buckets: string[]; current_bucket: string };
  }> =>
    getJson(
      "/api/debut-window/summary"
      + (bucket ? `?bucket=${encodeURIComponent(bucket)}` : ""),
    ),
```

- [ ] **Step 4: 타입 확인**

Run: `cd frontend && pnpm tsc --noEmit`
Expected: 컴포넌트 쪽 기존 `DISPLAY_BUCKETS` import 는 아직 살아 있어 통과 (lib 는 Task 5 에서 교체). 에러 0.

- [ ] **Step 5: Commit**

```bash
git add frontend/functions/api/debut-window/summary.ts frontend/functions/api/debut-window/videos.ts frontend/src/api.ts
git commit -m "feat(api): debut-window summary 에 롤링 창 window 메타 + bucket 검증 동적화 (V2.49)"
```

---

### Task 5: 프런트 lib + 컴포넌트 3개

**Files:**
- Rewrite: `frontend/src/lib/debutWindow.ts`
- Modify: `frontend/src/components/DebutWindowKPI.tsx`
- Modify: `frontend/src/components/CompetitorOrganicityBar.tsx`
- Modify: `frontend/src/components/DebutWindowVideoTable.tsx`

- [ ] **Step 1: `src/lib/debutWindow.ts` 재작성**

```ts
// V2.49 롤링 윈도우: 표시 탭은 summary API 의 window 메타가 내려준다
// (서버가 anchor=MiiWAN 데뷔 경과일로 계산 — functions/lib/debutWindowBuckets
// 의 displayBuckets). 아래 정적 목록은 메타 부재 시(네트워크 오류 등)
// fallback 전용 — 데뷔 전 고정 창과 동일한 값.
export const DEFAULT_DISPLAY_BUCKETS: string[] = [
  "D-60", "D-40", "D-20", "D-Day", "D+20", "D+40", "D+60",
];
export const DEFAULT_CURRENT_BUCKET = "D-Day";
```

(`DISPLAY_BUCKETS` / `DisplayBucket` export 삭제.)

- [ ] **Step 2: `DebutWindowKPI.tsx`**

import (`:4`) 교체:

```tsx
import { DEFAULT_DISPLAY_BUCKETS } from "../lib/debutWindow";
```

state + fetch (`:31-45`) 교체:

```tsx
  const [byBucket, setByBucket] = useState<Map<string, SummaryRow> | null>(null);
  // V2.49: 표시 버킷은 summary 응답의 window 메타 (롤링 창). 부재 시 fallback.
  const [buckets, setBuckets] = useState<string[]>(DEFAULT_DISPLAY_BUCKETS);

  useEffect(() => {
    let cancelled = false;
    api.debutWindowSummary<SummaryRow>().then((r) => {
      if (cancelled) return;
      if (r.window?.buckets?.length) setBuckets(r.window.buckets);
      const filtered = r.rows.filter((x) => x.group_key === groupKey);
      const m = new Map<string, SummaryRow>();
      for (const row of filtered) m.set(row.window_bucket, row);
      setByBucket(m);
    }).catch(() => {
      // graceful: leave at null → loading state. Errors are non-fatal here.
    });
    return () => { cancelled = true; };
  }, [groupKey]);
```

렌더 (`:53`): `{BUCKETS.map((b) => {` → `{buckets.map((b) => {`. (Undated 배지 블록 무변경.)

- [ ] **Step 3: `CompetitorOrganicityBar.tsx`**

import (`:4`) 교체 + 타입 (`:8-10`) 교체:

```tsx
import { DEFAULT_CURRENT_BUCKET, DEFAULT_DISPLAY_BUCKETS } from "../lib/debutWindow";
```

```tsx
// V2.49: 표시 탭은 summary 응답의 window 메타 (롤링 창) — 정적 타입 대신
// string. 모든 탭이 같은 20일 창 단위라 그룹 간 표본 왜곡 없음 (기존 동일).
type Bucket = string;
```

(`type AnyBucket` / `const ALL_BUCKETS` 줄 삭제. 이후 `AnyBucket` 참조는 전부 `string` 으로: `DisplayRow.shown_bucket: string`, `pickDisplayRow` 의 `byBucket: Map<string, SummaryRow>`.)

`pickDisplayRow` 시그니처에 버킷 배열 파라미터 추가 (`:81-118`):

```tsx
function pickDisplayRow(
  byBucket: Map<string, SummaryRow>,
  selected: Bucket,
  mode: Mode,
  groupKey: string,
  bucketsOrdered: readonly string[],
): DisplayRow {
```

내부 fallback 루프의 `BUCKETS` → `bucketsOrdered`:

```tsx
  // 균등 폭 bucketsOrdered 를 chronologically newest → oldest 로 순회.
  for (let i = bucketsOrdered.length - 1; i >= 0; i--) {
    const b = bucketsOrdered[i]!;
```

컴포넌트 state (`:120-138`) 교체:

```tsx
export function CompetitorOrganicityBar() {
  // V2.49: 기본 탭 = 서버가 내려준 "오늘(anchor 기준) 버킷" — 데뷔 전엔
  // D-Day, 슬라이드 후엔 최신 버킷. 사용자가 클릭하면 그 선택 우선.
  const [picked, setPicked] = useState<Bucket | null>(null);
  const [mode, setMode] = useState<Mode>(DEFAULT_ORGANICITY_MODE);
  const [allRows, setAllRows] = useState<SummaryRow[] | null>(null);
  const [buckets, setBuckets] = useState<string[]>(DEFAULT_DISPLAY_BUCKETS);
  const [defaultBucket, setDefaultBucket] = useState<string>(DEFAULT_CURRENT_BUCKET);
  const bucket = picked ?? defaultBucket;

  useEffect(() => {
    let cancelled = false;
    api.debutWindowSummary<SummaryRow>().then((r) => {
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
```

`display` useMemo (`:140-154`): 필터/호출부 교체:

```tsx
      if (!buckets.includes(r.window_bucket)) continue;
      const b = r.window_bucket;
```

```tsx
    return Array.from(byGroup.keys()).map((k) =>
      pickDisplayRow(byGroup.get(k)!, bucket, mode, k, buckets),
    );
  }, [allRows, bucket, mode, buckets]);
```

탭 렌더 (`:174-179`): `{BUCKETS.map((b) => (` → `{buckets.map((b) => (`, onClick 은 `setPicked(b)`.

- [ ] **Step 4: `DebutWindowVideoTable.tsx`**

import (`:4`) 교체 + 타입 (`:8`):

```tsx
import { DEFAULT_CURRENT_BUCKET, DEFAULT_DISPLAY_BUCKETS } from "../lib/debutWindow";
```

```tsx
type Bucket = string;
```

state (`:79-91`) — bucket 부분 교체 + window 메타 fetch 추가:

```tsx
  const [viewMode, setViewMode] = useState<ViewMode>("debut");
  // V2.49: 탭 목록/기본 탭은 summary 의 window 메타 (롤링 창). 사용자가
  // 탭을 클릭하면 그 선택 우선. 메타 도착 전엔 fallback (데뷔 전 고정 창).
  const [buckets, setBuckets] = useState<string[]>(DEFAULT_DISPLAY_BUCKETS);
  const [defaultBucket, setDefaultBucket] = useState<string>(DEFAULT_CURRENT_BUCKET);
  const [picked, setPicked] = useState<Bucket | null>(null);
  const bucket = picked ?? defaultBucket;
```

mount 시 메타 fetch (기존 두 fetch effect 위에 추가):

```tsx
  // V2.49: 롤링 창 메타 1회 fetch (rows 는 버리고 window 만 사용 — 가벼운
  // 집계 쿼리라 수용, KPI/Bar 와 같은 endpoint 재사용).
  useEffect(() => {
    let cancelled = false;
    api.debutWindowSummary().then((r) => {
      if (cancelled || !r.window?.buckets?.length) return;
      setBuckets(r.window.buckets);
      setDefaultBucket(r.window.current_bucket);
    }).catch(() => {
      // graceful: fallback 탭 유지.
    });
    return () => { cancelled = true; };
  }, []);
```

탭 렌더 (`:166-171`): `{BUCKETS.map((b) => (` → `{buckets.map((b) => (`, onClick `setBucket(b)` → `setPicked(b)`.

(videos fetch effect (`:94-105`) 는 `bucket` 파생값을 그대로 dep 으로 쓰므로 무변경 — 메타 도착으로 defaultBucket 이 바뀌면 자동 refetch.)

- [ ] **Step 5: 타입/기존 테스트 확인**

Run: `cd frontend && pnpm tsc --noEmit`
Expected: 에러 0 — 단 `tests/lib/debutWindow.test.ts` 가 구 export 를 import 하므로 여기서 FAIL 하면 Task 6 으로 (tsc 가 tests 포함 시 Task 6 먼저 수행 후 함께 확인해도 됨).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/debutWindow.ts frontend/src/api.ts frontend/src/components/DebutWindowKPI.tsx frontend/src/components/CompetitorOrganicityBar.tsx frontend/src/components/DebutWindowVideoTable.tsx
git commit -m "feat(frontend): Debut Window 컴포넌트 롤링 창 메타 렌더 전환 (V2.49)"
```

---

### Task 6: cross-language 가드 테스트 재작성

**Files:**
- Rewrite: `frontend/tests/lib/debutWindow.test.ts`

- [ ] **Step 1: 재작성**

```ts
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
    const block = py.match(/WINDOW_BUCKETS[\s\S]*?=\s*\[([\s\S]*?)\]/);
    const inner = block?.[1];
    expect(inner, "WINDOW_BUCKETS not found").toBeTruthy();
    const entries = [...inner!.matchAll(
      /\(\s*"([^"]+)",\s*(-?\d+),\s*(-?\d+)\s*\)/g,
    )].map((m) => [m[1]!, Number(m[2]), Number(m[3])] as const);

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
```

- [ ] **Step 2: 통과 확인**

Run: `cd frontend && pnpm vitest run tests/lib/debutWindow.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/tests/lib/debutWindow.test.ts
git commit -m "test(frontend): debut window cross-language 가드를 산술 규칙 기반으로 재작성 (V2.49)"
```

---

### Task 7: 전체 검증 + 문서 + 마무리

**Files:**
- Modify: `docs/analysis-formulas-reference.md` §6.8
- Modify: `CLAUDE.md` (V2.49 항목)

- [ ] **Step 1: 전체 테스트**

Run: `cd worker && uv run pytest && cd ../frontend && pnpm vitest run && pnpm tsc --noEmit`
Expected: worker 전체 PASS, frontend 전체 PASS, tsc 에러 0.

- [ ] **Step 2: 산식 레퍼런스 §6.8 갱신**

`docs/analysis-formulas-reference.md:308-314` 를 교체:

```markdown
### 6.8 윈도우 버킷 (`WINDOW_BUCKETS` + 산술, `:49`; V2.49 롤링 윈도우)
> 🟢 **쉽게**: 영상을 **데뷔일 기준 20일 단위 시기**로 묶음. 데뷔 후에는 D+80, D+100… 새 시기가 계속 생기고, 화면은 그중 "지금(MiiWAN 기준)까지의 최근 7칸"만 보여줌 — 시간이 가면 오래된 칸이 한 칸씩 밀려남. 데뷔일 없는 그룹은 'Undated'로 점수만.

고정 5개: `Pre(≤-71) · D-60(-70~-51) · D-40(-50~-31) · D-20(-30~-11) · D-Day(-10~+9)` + **산술 무한** `d≥10 → D+20k (k=(d-10)//20+1)` — D+20(10~29) · D+40(30~49) · D+60(50~69) · D+80(70~89) · … (Post catch-all 은 V2.49 에서 폐기, migration 0085 재배치). `days_relative = (published_date - debut_date).days`.
- **Undated** (V2.42, `:135`): `debut_date` 없는 그룹은 점수만 산정(산식은 데뷔일 미사용) → `"Undated"` 버킷.
- **표시 창** (V2.49, `debutWindowBuckets.ts displayBuckets`): MiiWAN 데뷔 경과일(KST)이 속한 버킷을 오른쪽 끝으로 한 연속 7버킷, 오른쪽 끝 최소 D+60 (데뷔 전~D+69 는 종전 D-60~D+60 고정 창과 동일, D+70 에 첫 슬라이드). summary API 가 `window.buckets`/`current_bucket` 메타로 내려주고 프런트 3 컴포넌트가 렌더. Pre/Undated 탭 비노출(Undated 는 KPI 배지).
- worker↔functions 경계 동일성: `debutWindowBuckets.test.ts` BOUNDARY_FIXTURE ↔ `test_debut_window.py` parametrize 가 양쪽 핀.
```

- [ ] **Step 3: CLAUDE.md V2.49 항목 추가**

V2.48.1 항목 뒤에 추가 (요지 — 실제 문구는 구현 결과 반영해 작성):

```markdown
- **V2.49 (2026-06-11)**: Debut Window **롤링 윈도우** — 데뷔일 고정 ±60일 스냅샷에서 MiiWAN 나이를 따라 20일에 한 칸씩 굴러가는 7버킷(140일) 창으로 전환 (운영자 요청 — 데뷔 후 타임라인 확장, 과거 버킷 퇴장, D-Day 자연 퇴장). worker `bucket_for`: `Post` catch-all 폐기 → `d≥10 → D+20k` 산술 무한 생성 (`Pre` 는 유지 — 창이 과거로 안 밀림), migration 0085 가 기존 Post 행 in-place 재배치 + summary DELETE (0073 패턴). 표시 창은 **서버 계산** (`functions/lib/debutWindowBuckets.ts` 전면 재작성 — `FRONTEND_BUCKET_MAP` 폐기, `displayBuckets(ageDays)` = 오늘 버킷을 오른쪽 끝(최소 D+60)으로 한 연속 7개): summary API 가 D1 의 MiiWAN debut_date(KST 경과일)로 계산해 `window.buckets`/`current_bucket` 메타 응답, 3 컴포넌트 (DebutWindowKPI/CompetitorOrganicityBar/DebutWindowVideoTable) 가 정적 `DISPLAY_BUCKETS` 대신 메타 렌더 (fallback = 데뷔 전 고정 창, VideoTable 은 mount 시 summary 1회 추가 호출). 기본 선택 탭 = `current_bucket` (오늘 버킷). 슬라이드 기준은 MiiWAN 나이 전 그룹 공통 (각 그룹 라벨은 자기 데뷔 기준 D±N → 동일 라이프스테이지 코호트 비교 유지, 운영자 확정). wegosix (debut 08-31 placeholder) 는 미도래 버킷 빈 칸, BTHD 는 Undated 무변경 (운영자 확정). D+70 (2026-08-25) 전까지 화면 완전 동일. weekly_diagnosis 는 published_at 범위 조회라 무영향. 스펙/플랜 `docs/superpowers/{specs,plans}/2026-06-11-debut-window-rolling-window*`. **migration 0085 운영자 원격 apply 필요** (`gh workflow run migrate.yml`) — 적용 전에도 표시 창엔 Post 가 원래 없어 graceful, 적용 후 다음 organicity cron 이 summary 재집계.
```

- [ ] **Step 4: Commit + push**

```bash
git add docs/analysis-formulas-reference.md CLAUDE.md
git commit -m "docs: 산식 레퍼런스 §6.8 롤링 윈도우 갱신 + CLAUDE.md V2.49"
git push
```

- [ ] **Step 5: 운영자 안내**

push 후 운영자에게 안내 (D1 원격 apply 는 운영자 직접 — `[[feedback_d1_remote_apply_human_only]]`):
- `! gh workflow run migrate.yml` 로 migration 0085 원격 적용
- 다음 organicity cron (21:30 KST) 이 summary 재집계 → Post 행이 D+N 으로 노출
- SecondBrain 작업 로그 1줄 기록

---

## Self-Review 결과 (플랜 작성 시 수행)

- **스펙 커버리지**: §1(Task 1)·§2(Task 3)·§3(Task 4)·§4(Task 5)·§5(Task 2)·§6(Task 1/3/6/7) 전부 매핑. 누락 없음.
- **타입 일관성**: `displayBuckets`/`currentBucket`/`isValidBucketLabel`/`debutAgeDaysKST` 시그니처가 Task 3 정의 ↔ Task 4 사용처 일치. `window: { buckets, current_bucket }` 응답 형태가 Task 4(api.ts) ↔ Task 5(컴포넌트) 일치.
- **경계 산술 검증**: d=70→k=4→D+80 / d=130→D+140 / displayBuckets(70)=[D-40..D+80] / displayBuckets(130)=[D+20..D+140] — 스펙 예시와 일치. SQLite 정수 나눗셈은 d≥70 양수라 Python `//` 와 동일.
