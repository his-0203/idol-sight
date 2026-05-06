# Historical Pre-Debut Backfill — PLAVE / OWIS / SKINZ / MYRAKL

작성일: 2026-05-06
대상: 데뷔 정렬 곡선(`DebutCurve`)과 코호트 비교 표(`MiiWANBriefing` D-30 벤치마크)에서 이미 데뷔한 4개 K-POP 모델 그룹의 데뷔 직전~직후 데이터를 채워, MiiWAN의 D-N 진행 상황을 역사적 코호트와 직접 비교 가능하게 만든다.

## 1. 배경

`DebutCurve.tsx` (line 392) 에 다음 안내가 노출되고 있다:

> "PLAVE/ISEDOL/STELLIVE는 데뷔 후 오랜 기간이 지나 D-30 / D+30 데이터가 없을 수 있음"

`MiiWANBriefing.tsx`의 "코호트 비교 — 데뷔 D-30 벤치마크" 표(line 324)도 같은 한계를 공유한다. `worker/src/idol_sight/analysis/yt_history_backfill.py`가 영상 수와 누적 조회수는 이미 합성하지만, 다음 메트릭이 비어 있다:

- **YouTube 구독자** (`yt_subscribers`)
- **네이버 뉴스 일자별 카운트** (`naver_total_news`)
- **데뷔 D-30 빌드업 이벤트** (`group_events` 일부 누락)

운영자는 MiiWAN의 D-30 시점 트래픽을 PLAVE/SKINZ/MYRAKL/OWIS의 같은 시점과 직접 비교할 수 없다.

## 2. 스코프

### 포함

- **4개 K-POP 모델 그룹**: PLAVE, OWIS, SKINZ, MYRAKL
- **2개 메트릭**: `yt_subscribers`, `naver_total_news`
- **시간 창**: 그룹별 데뷔 기준 **D-180 ~ D+90**
- **이벤트 보충**: PLAVE 멤버 개별 공개, MYRAKL 데뷔 직전 빌드업
- **provenance 분류 컬럼**: `agg_summary.data_source`

### 제외 (의도적)

- **ISEDOL / STELLIVE** — `group_model = segmentary | confederation` (서브컬처 코호트). 그룹 단위 "데뷔일" 자체가 모호하여 D-N 정렬의 해석력이 약함. DebutCurve 코호트 필터로 분리.
- **MiiWAN / B:DAWN** — 미데뷔 그룹. 라이브 데이터로 자연 채워질 것.
- **디시 / 더쿠 / 인스티즈 게시글, 트위터 멘션** — 회수 비용 대비 정확도 낮음 (Q2 합의).
- **새 collector 모듈** — 일회성 백필.

## 3. 시스템 흐름

```
[웹 리서치]
    ↓ Social Blade / Playboard / Naver News 검색 / 공식 보도자료
[migration 0018: agg_summary.data_source 컬럼 + 4그룹 × 2지표 백필 INSERT]
[migration 0019: PLAVE 멤버공개 + MYRAKL D-30 빌드업 group_events 보충]
    ↓ wrangler d1 migrations apply
[D1: agg_summary 행 = live | backfill_exact | backfill_estimate]
[functions/api: SELECT에 data_source 컬럼 추가, 응답 points에 source 동봉]
[DebutCurve: segment.borderDash로 source별 분기 + 범례]
[MiiWANBriefing: 추정 셀에 'est' 배지 + 호버 툴팁]
```

3-tier 변경 없음, 신규 컴포넌트 없음.

## 4. 스키마 변경 — migration 0018

### 4.1 컬럼 추가

```sql
-- migrations/0018_data_source.sql
ALTER TABLE agg_summary
  ADD COLUMN data_source TEXT NOT NULL DEFAULT 'live'
  CHECK(data_source IN ('live', 'backfill_exact', 'backfill_estimate'));

CREATE INDEX idx_agg_summary_source
  ON agg_summary(group_key, data_source, snapshot_at);
```

### 4.2 `data_source` 분류

| 값 | 의미 | 예 |
|---|---|---|
| `live` | collector가 수집한 실측 | 2026-04-01 이후 D1 로그 |
| `backfill_exact` | 검증 가능한 백필 (네이버 뉴스 키워드 카운트, 영상 수) | naver_news만 채워진 행 |
| `backfill_estimate` | 본질적 추정 (Social Blade 구독자, cumulative views) | 구독자가 채워진 모든 행 |

**Weakest-link 룰**: 한 행에 estimate 컬럼이 하나라도 있으면 행 전체를 `backfill_estimate`로 표시. 보수적 분류 — false positive 방향(살짝 더 조심하라고 알림)으로만 작동.

### 4.3 회고 분류 — 기존 `yt_history_backfill` 행

`yt_history_backfill.py`가 출력하는 행은 `yt_subscribers IS NULL` 이고 비-YT 컬럼이 모두 0인 시그니처를 가진다. cumulative views가 over-estimate이므로 `backfill_estimate`로 마킹:

```sql
UPDATE agg_summary
   SET data_source = 'backfill_estimate'
 WHERE yt_subscribers IS NULL
   AND dc_total_posts = 0 AND theqoo_posts = 0 AND instiz_posts = 0
   AND naver_total_news = 0 AND twitter_posts = 0
   AND controversy_count = 0;
```

`yt_history_backfill.py`의 `_INSERT_SQL`에도 `data_source` 컬럼 추가, 값 `'backfill_estimate'`. 미래 재실행 시 새 행이 올바른 source로 들어감.

### 4.4 신규 백필 INSERT 패턴

```sql
INSERT INTO agg_summary
  (group_key, snapshot_at,
   yt_total_videos, yt_total_views, yt_subscribers,
   dc_total_posts, theqoo_posts, instiz_posts,
   naver_total_news, twitter_posts, controversy_count, data_source)
VALUES (?, ?, NULL, NULL, ?, 0, 0, 0, ?, 0, 0, 'backfill_estimate')
ON CONFLICT(group_key, snapshot_at) DO UPDATE SET
  yt_subscribers   = COALESCE(excluded.yt_subscribers, agg_summary.yt_subscribers),
  naver_total_news = CASE
    WHEN agg_summary.naver_total_news = 0 THEN excluded.naver_total_news
    ELSE agg_summary.naver_total_news
  END,
  data_source = excluded.data_source;
```

`yt_history_backfill` 행과 같은 `(group_key, snapshot_at)`에 떨어질 때 컬럼 머지가 동작. `data_source`는 새 값(`backfill_estimate`)이 덮어씀 — 이미 estimate이므로 변경 없음.

## 5. 백필 데이터 출처 및 검증

### 5.1 그룹별 출처

| 그룹 | 데뷔일 | 백필 창 | 구독자 출처 | 뉴스 출처 |
|---|---|---|---|---|
| PLAVE | 2023-03-12 | 2022-09-13 ~ 2023-06-10 | Social Blade `@plave_official` 일별. Social Blade에 결손이 있는 날만 Playboard로 fallback (PLAVE 데뷔창은 2022년이라 일부 일자 데이터 부재 가능) | Naver News `"플레이브" OR "PLAVE"` 일자 필터 |
| SKINZ | 2025-04-10 | 2024-10-12 ~ 2025-07-09 | Social Blade `@skinz_official` 일별 | Naver News `"SKINZ" OR "스킨즈"` |
| MYRAKL | 2026-01-26 | 2025-07-30 ~ 2026-04-26 | Social Blade `@myrakl_official` 일별 | Naver News `"MY:RAKL" OR "마이라클"` |
| OWIS | 2026-03-23 | 2025-09-24 ~ (현재) | Social Blade `@owis_official` 일별 | Naver News `"OWIS" OR "오위스"` |

채널 핸들은 리서치 단계에서 확정. 부재 시 SOURCES.md에 사유 기록.

### 5.2 샘플링 주기

- **주 1회 (월요일 00:00 KST)** + 핵심 마일스톤 일자(데뷔, 멤버 공개, MV 공개) 일별 추가.
- 270일 ÷ 7 ≈ 40 포인트 + 마일스톤 ~10 = **~50 행/그룹/지표 × 4그룹 × 2지표 ≈ 400 행**.
- DebutCurve의 `tension: 0.25` 보간 + `spanGaps: true`로 주간 포인트가 자연스러운 곡선으로 렌더.

### 5.3 검증 (각 그룹 백필 작성 직후)

1. **Cross-source 스폿체크** — Social Blade vs Playboard 같은 날짜에서 ±10% 이내인지. 벗어나면 SOURCES.md에 노트.
2. **데뷔일 ±7일 정확도** — 데뷔 직후 트래픽 폭증이 양 출처 모두에 보이는지.
3. **Naver 뉴스 keyword overcounting** — 동명이인/다른 의미 (e.g., "owis" → 무관 검색결과)를 30개 샘플 수동 점검.

### 5.4 출처 기록

`scripts/historical_backfill/SOURCES.md` (git-tracked) 에 다음을 기록:

- 그룹별 채널 핸들과 검색 쿼리
- Social Blade / Playboard URL
- 검증 노트 (Cross-source 일치 여부, 의심스러운 일자)
- 회수 불가 일자 및 사유

DB에 `source_url` 컬럼은 추가하지 않음 — 행마다 중복 텍스트, 부피만 키움.

## 6. UI 변경

### 6.1 API — `frontend/functions/api/debut-curve.ts`

현재 구현(line 58~67)의 SELECT에 `s.data_source AS source` 추가, `Row` 인터페이스(line 36~39)에 `source: string` 추가, 버킷팅(line 72~91)을 `Map<number, number>` → `Map<number, {value: number, source: string}>` 으로 확장. 출력(line 93~101) `points` 매핑에 `source` 동봉:

```ts
points: [...v.points.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([day, p]) => ({ day_offset: day, value: p.value, source: p.source })),
```

다중 스냅샷 동일 day 처리 룰("LAST 우선") 유지 — `Map.set`이 마지막 값을 덮어쓰므로 source도 동일 룰로 자동 정합.

### 6.2 `frontend/src/components/DebutCurve.tsx`

`Series.points` 타입 확장:

```ts
points: Array<{ day_offset: number; value: number; source: 'live' | 'backfill_exact' | 'backfill_estimate' }>;
```

데이터셋 빌드(line 178~200)에 `segment` 콜백 추가:

```ts
{
  // ... 기존 필드 ...
  segment: {
    borderDash: (ctx: any) => {
      const src = ctx.p1?.raw?.source;
      if (src === 'backfill_estimate') return [6, 4];
      if (src === 'backfill_exact')    return [2, 2];
      return undefined;  // live: 실선
    },
    borderColor: (ctx: any) => {
      const src = ctx.p1?.raw?.source;
      return src && src !== 'live'
        ? fillOf(s.group_key, 0.55)
        : colorOf(s.group_key);
    },
  },
}
```

차트 위에 범례 1줄 추가 (line 343 근처):

```tsx
<span class="text-[11px] text-zinc-500">
  ─── 실측 · ┄┄ 백필 추정 · ⋯ 백필 검증
</span>
```

### 6.3 `frontend/src/views/MiiWANBriefing.tsx`

코호트 비교 표(line 324~) 각 셀에:

- `value` 옆에 `data_source !== 'live'` 일 때 `est` 배지 (`text-[10px] text-zinc-500 ml-1 px-1 rounded bg-zinc-800/50`)
- 호버 툴팁: estimate면 "Social Blade 추정 (±5%)", exact면 "네이버 뉴스 검증"

벤치마크 API는 `frontend/functions/api/miiwan.ts` line 172~199 — D-30 시점 agg_summary 행을 그룹별로 집계해 `benchmarks` 배열을 반환. `benchmarks` 항목 푸시(line 199)에 `data_source` 필드 추가 + 클라이언트 타입 `Benchmark`(MiiWANBriefing line 36 인근)에 `data_source: string` 추가.

## 7. 이벤트 보충 — migration 0019

### 7.1 PLAVE 멤버 개별 공개

0017 시드에 `pre_debut`(2022-09-15)과 `debut`(2023-03-12)는 있으나, 멤버 4명 (예준/노아/밤비/하민) 개별 공개 이벤트는 없음. 공식 발표/보도자료 기준 일자로 4건 추가 — `member_reveal` 타입.

### 7.2 MYRAKL D-30 빌드업

0017에 `debut`(2026-01-26) 이후 single_release만 있음. 데뷔 D-180~D-1 이벤트 통째로 누락:

- ACCORD Entertainment 공식 론칭/발표
- 멤버 5명 공개
- 콘셉트 티저 / 트레일러
- 쇼케이스

리서치 단계에서 정확 일자/소스 URL 확정. ~5~7건 예상.

### 7.3 SKINZ / OWIS

0017 시드 충분 — 손대지 않음.

## 8. 검증

### 8.1 Worker 테스트

`worker/tests/test_yt_history_backfill.py`에 `data_source='backfill_estimate'` 어서션 추가. 신규 테스트는 없음 (마이그레이션 SQL은 D1 dry-run으로 검증).

### 8.2 수동 프론트 검증

```bash
cd frontend && wrangler d1 migrations apply idol-sight --local
pnpm dev
```

1. **DebutCurve / 메트릭=구독자 / 코호트=K-POP / 범위=D-60~D+90** — PLAVE/SKINZ/MYRAKL/OWIS 4개 라인이 점선(estimate)으로 그려지는지.
2. **DebutCurve / 메트릭=네이버 뉴스** — 백필 구간이 가는 점선(exact)으로 표시되는지.
3. **MiiWANBriefing → D-30 벤치마크 표** — PLAVE/SKINZ 셀이 채워지고 `est` 배지가 붙는지.
4. **PLAVE Spot-check** — 2024-03-06 첫 음방 1위 시점 ±7일에 구독자 곡선이 visible inflection (Social Blade에서 본 것과 일치).

## 9. 리스크 및 완화

| 리스크 | 완화 |
|---|---|
| Social Blade가 PLAVE 2022-09 데이터를 누락 | SOURCES.md에 명시, 해당 일자 NULL 유지 (데이터 없음) |
| Naver 뉴스 검색이 동명이인 결과 포함 | 30 샘플 수동 점검, 부정확 시 OR 쿼리 좁힘 |
| ON CONFLICT UPSERT가 의도치 않게 0을 덮어씀 | `naver_total_news`는 `CASE WHEN ... = 0` 가드 |
| migration 0018이 너무 큼 (~400 INSERT + UPDATE) | 0017이 이미 ~85 이벤트로 비슷한 규모 — 패턴 검증됨 |
| UI 점선이 색맹/저시력 사용자에게 부족 | `est` 배지 + 호버 툴팁 텍스트로 비-시각 보강 |

## 10. 비목표

- 디시/더쿠/인스티즈 게시글, 트위터 멘션 백필 — Q2에서 명시 제외
- 일자별 정확값 회수 — 주간 샘플 + 마일스톤 일별이면 곡선 모양 충분
- 자동 재백필 파이프라인 — 일회성 작업이므로 GitHub Actions cron 추가 안 함
- ISEDOL / STELLIVE 백필 — 서브컬처 코호트로 분리 운영 (Q1 합의)

## 11. 작업 순서 (구현 계획에서 상세화)

1. migration 0018 스키마 변경 (ALTER + 회고 UPDATE) 작성 + 로컬 적용
2. `yt_history_backfill.py`에 `data_source` 컬럼 추가
3. PLAVE 백필 데이터 리서치 → 0018에 INSERT 추가 → SOURCES.md 갱신
4. SKINZ / MYRAKL / OWIS 동일하게 반복
5. migration 0019 (PLAVE 멤버공개 + MYRAKL D-30) 리서치 + 작성
6. API (`debut-curve.ts`, MiiWAN 벤치마크) `data_source` 노출
7. DebutCurve segment.borderDash + 범례
8. MiiWANBriefing `est` 배지 + 툴팁
9. 로컬 검증 (§8.2)
10. PR + 원격 D1 적용 (사용자 확인 후)
