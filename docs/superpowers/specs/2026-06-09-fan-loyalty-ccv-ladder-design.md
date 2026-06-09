# 팬 충성도 카드 — peak CCV 호가창 사다리 (Design)

- 날짜: 2026-06-09
- 상태: 설계 승인됨 (운영자)
- 범위: **프런트엔드 전용** (worker·migration·API 변경 없음)
- 대상: `frontend/src/components/FanLoyaltyCard.tsx`, `frontend/src/lib/datetime.ts` (+ 각 테스트)

## 배경 / 문제

V2.46 에서 그룹 상세 `content` 탭에 `FanLoyaltyCard` 가 마운트되어 라이브 전환율 기반
충성도 점수를 보여준다. 카드 하단의 방송별 peak CCV 는 `Sparkline` 으로 **모양(추세)만**
렌더되고, 실제 수치·날짜는 버려진다. 운영자는 "주식 호가창처럼" 방송별 최고 동시
시청자 **실값**을 함께 보고 싶어 한다.

핵심 통찰: 필요한 데이터가 **이미 응답에 다 있다**. `api/group/[key].ts:262-281` 가
`fan_loyalty.broadcasts[] = { video_id, peak, last_at }` (최근 56일, 최대 12개,
오래된→최신) 과 `peak_ccv_median` 을 내려준다. 따라서 worker/migration 없이
`FanLoyaltyCard` 렌더만 바꾸면 된다.

## 설계

### 레이아웃

상단 행(점수 / 전환율 / 증감율 ▲▼)은 그대로 두고, **기존 스파크라인을 사다리로 교체**한다.

```
팬 충성도 (라이브 전환율)            최근 56일 · 방송 5회
91   전환율 4.2%   ▲ +18%
──────────────────────────────────────────
방송별 최고 동시 시청자                        peak CCV
06/07 일  ███████████████████████████  1,620   ← 최신(teal 강조)
06/05 토  ███████████████              1,180
06/03 목  █████████████      중앙값     1,050   ← 중앙값(회색 좌측 인셋 보더)
05/30 일  ██████████                     910
05/28 목  █████████                      820
──────────────────────────────────────────
충성도 = 구독자 중 라이브 전환율(규모 무관). 절대 시청자 수와 별개.
```

행 구조 (grid 3열):
- **좌**: `MM/DD 요일` — `last_at` 을 KST 로 포맷 (예: `06/07 일`)
- **중**: 깊이 막대 — 폭 = `peak / max(peak)` (자기 집합 내 정규화), miiwan teal
- **우**: `peak` 우측정렬 `tabular-nums` + 천단위 콤마

강조:
- **최신 행**(맨 위): teal 배경(`bg rgba(20,184,166,.08)`) + 진한 막대 + 강조 텍스트.
- **중앙값 행**: `peak_ccv_median` 에 가장 가까운 행에 회색 좌측 인셋 보더 + `중앙값`
  라벨. 점수 산식(중앙값 peak ÷ 구독자)의 기준점을 시각적으로 연결.
  - **방송 3회 미만이면 중앙값 마킹 생략** (1~2회는 중앙값이 최신/유일값과 겹쳐 무의미).

정렬: **시간순(최신 위)**. 충성도 추세(▲) 및 기존 스파크라인의 시선 방향과 일치.

### 상태별 렌더

| basis | 사다리 | 비고 |
|---|---|---|
| `scored` (방송 2회+) | 풀 사다리 | 중앙값 마킹(3회+) |
| `low_confidence` (1회) | 1행 사다리 | 기존 amber `단발 방송 기준` 배지 유지, 중앙값 마킹 없음 |
| `insufficient` (0회) | 사다리 없음 | 기존 `라이브 데이터 축적 중` 유지 |

행 개수: API 가 최근 56일 **최대 12개**로 이미 제한 → 추가 truncation 없이 받은 만큼 렌더.

### 제외 (YAGNI — 운영자 결정)

- YouTube 라이브 링크 (행 클릭 이동)
- 행별 전환율(peak÷구독자) 병기
- 'LIVE'(현재 방송 중) 뱃지 — `last_at` 으로는 현재 라이브 여부를 신뢰성 있게 단정 불가

## 컴포넌트 / 함수 경계

### `frontend/src/lib/datetime.ts` (KST 포맷 단일 출처)

신규 export `formatKSTMonthDayWeekday(input) → "MM/DD 요일"`:
- UTC 입력을 KST 로 변환, `Intl.DateTimeFormat("ko-KR", { timeZone:"Asia/Seoul",
  month:"2-digit", day:"2-digit", weekday:"short" })` 사용.
- 결과 예: `"06/07 일"`. null/파싱불가 → `"—"` (모듈 관례).

### `frontend/src/components/FanLoyaltyCard.tsx` (순수 헬퍼 + 렌더)

기존 `fmtPct`/`trendLabel`/`scoreColor` 옆에 순수 헬퍼 추가:

- `barWidthPct(peak, maxPeak) → number` — `0~100`, `maxPeak<=0` 가드 시 0.
- `medianRowIndex(broadcasts, peakMedian) → number | null` —
  `broadcasts.length < 3` 또는 `peakMedian == null` 이면 null. 아니면 `peak` 이
  `peakMedian` 에 가장 가까운 행의 인덱스(동률 시 첫 행).

렌더: `basis==="insufficient"` 가지에서는 기존대로 사다리 없이 메시지. 그 외에는
상단 점수 행(스파크라인 제거) + 사다리. 사다리는 `broadcasts` 를 최신-위 순서로
렌더(API 는 오래된→최신이므로 역순), 각 행에 최신/중앙값 강조 클래스 부여.

## 테스트 (TDD)

- `datetime.test.ts`: `formatKSTMonthDayWeekday` — KST 변환(UTC 경계 포함), 요일,
  null/빈 입력.
- `FanLoyaltyCard.test.ts` (기존 `fmtPct`/`trendLabel` 유지):
  - `barWidthPct` — 정규화, max 0/음수 가드.
  - `medianRowIndex` — 홀/짝 개수, 3회 미만 null, peakMedian null, 동률.

## 비목표

- 산식·임계값·수집 변경 없음 (충성도 점수 로직은 V2.46 그대로).
- 다른 카드/뷰 변경 없음.
- 윤리: peak CCV·구독자·전환율은 모두 공개 외형 지표 → §4 위배 없음 (V2.46 동일 논리).
