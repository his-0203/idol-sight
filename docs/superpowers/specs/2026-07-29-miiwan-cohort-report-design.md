# MiiWAN 브리핑 — "동시기 성과 증명" 섹션 설계 (코호트 비교 교체)

날짜: 2026-07-29
상태: 승인됨 (사용자 확인)

## 배경 / 목적

리드 피드백: 다음 달 투자사 보고에서 "미완이가 왜 잘되는지"를 자체 리서치 데이터로 증명해야 한다.
현재 브리핑 탭의 "코호트 비교 — 데뷔 타임라인 벤치마크" 섹션은 D±30 앵커 시점의 **절대값**을
나란히 보여줘서, 절대 수치가 작은 미완이가 오히려 초라해 보인다. 이를 삭제하고
"절대값은 작지만 **동시기(데뷔일 정렬) 대비** 잘하고 있다"를 논증하는 보고서형 섹션으로 교체한다.

원칙: **가짜 수치 없음.** 데이터가 없으면 순위 모수에서 제외하고 명시한다. 열세 지표도 숨기지 않는다.

## 삭제 범위

### 프론트 (`frontend/src/views/MiiWANBriefing.tsx`)
- 코호트 비교 섹션 (`:552-666` 인라인 `<section>` + IIFE)
- 전용 코드: `type Benchmark`(:49), `type AnchorKey`(:61), `ANCHOR_TABS`(:65-83),
  `MiiwanData.benchmarks_by_anchor` 필드(:115), `anchorTab` state(:357),
  `relativeRatio`(:306), `EstBadge`(:313), `PLACEHOLDER_ZERO_KEYS`(:331), `fmtBench`(:336)
  - 단 `EstBadge`는 신규 섹션에서 재사용 가능하면 유지
- `SummaryShape`/`fmt`/`EmptyState`/`colorOf`/`formatKSTDate`는 타 섹션 공용 — 유지
- 바로 아래 "코호트 유기성 비교" 섹션(:673-687)의 "위 표의 조회·구독" 참조 문구 수정

### 백엔드 (`frontend/functions/api/miiwan.ts`)
- `BENCHMARK_GROUPS`(:84), `AnchorKey`/`ANCHORS`/`BenchmarkRow`/`benchmarksByAnchor`/
  `anchorQuery`/`AnchorTask` 블록(:355-480 전후), 응답 `benchmarks_by_anchor` 키
- 효과: D1 왕복 ~42개 제거

## 신규 백엔드: `GET /api/miiwan-cohort`

Cloudflare Pages Function + D1 (추가 비용 없음, LLM·외부 API 호출 없음).

### 코호트 구성
- **순위 산정 코호트**: `myrakl`, `owis`, `bdawn`, `bthd`, `skinz` (K-POP 버추얼, 유사 데뷔 시기)
- **참조선**: `plave` — 순위 제외, `reference: true`, 초기 데이터 sparse하므로 est 배지 전제
- 서브컬처(uryael 등) 제외 — 도메인 분리 규칙 준수
- 기준 그룹: `miiwan` (데뷔 2026-06-16)

### 계산 (전부 서버 사이드)
- `debut-curve.ts`의 day_offset 정렬 로직(`julianday(snapshot_at) - julianday(debut_date)`)을
  공유 모듈로 추출해 양쪽에서 재사용 (기존 `/api/debut-curve` 동작 불변)
- `as_of_day`: 오늘 기준 미완이 D+N (동적 계산)
- **인덱스 곡선**: 그룹×지표별 D0~D+N 시계열을 D-day 값=100으로 정규화.
  D-day 값은 D0에 가장 가까운 스냅샷(±윈도우) 사용. D-day 값이 0 또는 결측이면
  해당 그룹×지표는 곡선에서 제외하고 `excluded`에 사유 기록
- **스코어카드**: 같은 D+N 시점(각 그룹의 데뷔일 + as_of_day에 가장 가까운 스냅샷)의
  값·성장배수(D+N값/D0값)·미완이 순위. 지표별 산출
- **유기성**: `debut_window_organicity_summary`의 D0~D+60 버킷 organic score 그룹 비교
- 지표 4종: `yt_subscribers`, `yt_total_views`, `naver_total_news`, `dc_total_posts`
- 각 값에 `data_source`(live/backfill_exact/backfill_estimate) 동반 → 프론트 est 배지

### 응답 형태 (개념)
```
{
  as_of_day: number,
  metrics: ["yt_subscribers", ...],
  curves: { [metric]: { [group_key]: [{ day, index, data_source }] } },
  scorecard: { [metric]: { rows: [{ group_key, value_at_day, growth_multiple, data_source }],
                           miiwan_rank: number|null, cohort_size: number } },
  organicity: [{ group_key, score, window }],
  reference: { plave: { curves..., scorecard_rows... } },
  excluded: [{ group_key, metric, reason }]
}
```

## 신규 프론트 섹션 (브리핑 탭, 기존 코호트 비교 자리)

섹션 제목: **"동시기 성과 — 데뷔 코호트 벤치마크"**. 기존 UI 관례
(`section-title`, `.card`, tablist pill, `EmptyState`, `fmt`, `tabular-nums`, `colorOf`) 준수.

1. **결론 헤드라인 카드** — 스코어카드에서 자동 산출한 한 줄 결론
   ("D+43 기준, 동시기 코호트 대비 구독자 성장률 N위 · 조회수 성장배수 X.X배").
   열세 지표도 함께 표기 (숨김 금지)
2. **인덱스 성장곡선** — Chart.js, `DebutCurve.tsx` 패턴 준용.
   x=데뷔 후 경과일, y=D-day=100 인덱스. 미완이 `#75d7d1` 굵은 선,
   코호트는 `groups.ts` 팔레트 얇은 선, 플레이브 점선 참조선. 지표 전환 pill 탭
3. **동시기 스코어카드 표** — 지표별 D+N 값·성장배수·순위, 미완이 행 강조,
   est 배지, 결측 그룹은 "데이터 없음"으로 명시
4. **질적 지표 미니 블록** — 동시기(D0~D+60) 유기성 점수 비교.
   기존 "코호트 유기성 비교" 섹션(전체 기간)과 기준이 다름을 문구로 구분
5. **각주** — 데이터 출처(`DataSourceDetails` 패턴), est 배지 설명,
   "데뷔일 정렬(D+N) 기준" 방법론 한 줄

## 테스트

- vitest, 기존 `frontend/tests/functions/api_miiwan_*.test.ts` 관례 준수
- 신규 엔드포인트: 인덱스 정규화, 성장배수, 순위 계산, D-day 결측 시 제외 처리,
  plave가 순위에 포함되지 않는 것, 코호트 그룹 데이터 전무 시 응답 형태
- 기존 miiwan API 테스트가 `benchmarks_by_anchor` 제거 후에도 통과하는지 확인

## 비범위 (YAGNI)

- 인쇄/PDF 내보내기 (추후 필요 시 별도)
- 시장 분석 탭·MarketOverview의 기존 `DebutCurve` 변경
- DB 마이그레이션 (기존 테이블만 사용)
