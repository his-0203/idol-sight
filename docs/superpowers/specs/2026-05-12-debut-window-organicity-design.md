# Debut Window Organicity 분석 — 설계서

**작성일**: 2026-05-12
**대상 버전**: V2.20 (가칭)
**자사 그룹 D-day**: MiiWAN 2026-06-16 (현재 D-35)

---

## §1 Problem & Scope

### 해결하려는 문제

K-pop 데뷔를 전후한 ±60일은 마케팅 화력이 집중되는 구간이다. 어느 그룹이 **자연 호응(organic)**을 받고 있는지, 어느 그룹이 **유료 바이럴 마케팅(paid viral)** — 조회수 부스팅 / 좋아요 농장 / 댓글 농장 — 으로 수치를 만들고 있는지 식별하는 것이 경쟁 분석의 핵심 신호다. 자사 그룹 MiiWAN의 사전 활동 평가 기준이자 경쟁사 동급 비교 지표로 사용한다.

### 범위

- **대상 그룹**: 9개 전체 (plave, isedol, stellive, skinz, myrakl, miiwan, owis, bdawn, wegosix)
- **시간 윈도우**: 각 그룹의 `groups.debut_date` 기준 **D-60 ~ D+60** 사이 `youtube_videos.published_at` 영상
- **영상 종류**: 롱폼 + 숏폼 모두 (`is_short` 컬럼으로 구분, 점수 식만 분기)
- **데이터 소스**: 기존 `youtube_videos` + `youtube_video_stats` + `channel_stats` (모두 이미 존재)
- **백필**: 이미 데뷔한 그룹들도 1회 백필. `backfill-yt-videos` 워크플로 재사용
- **알려진 한계**: 좋아요/댓글은 분석 시점의 **누적값**. 정확한 'D-day 당일 스냅샷'은 복구 불가, 신규 그룹일수록 정확도 높음

---

## §2 데이터 모델

신규 마이그레이션 **`migrations/0052_debut_window_organicity.sql`**:

```sql
-- 영상별 organicity 분석 결과
CREATE TABLE debut_window_video_organicity (
  video_id               TEXT PRIMARY KEY,
  group_key              TEXT NOT NULL,
  is_short               INTEGER NOT NULL,
  published_at           TEXT NOT NULL,
  days_relative_to_debut INTEGER NOT NULL,   -- 음수=데뷔 전, 양수=데뷔 후. -60 ~ +60
  window_bucket          TEXT NOT NULL,      -- 'D-60' | 'D-30' | 'D-Day' | 'D+30' | 'D+60'
  view_count             INTEGER,
  like_count             INTEGER,
  comment_count          INTEGER,
  engagement_rate        REAL,
  like_comment_ratio     REAL,
  velocity_ratio         REAL,
  organic_score          INTEGER NOT NULL,   -- 0~100
  verdict                TEXT NOT NULL,      -- 'organic' | 'suspect' | 'likely_paid'
  signal_breakdown       TEXT NOT NULL,      -- JSON (투명성)
  computed_at            TEXT NOT NULL,
  FOREIGN KEY (video_id) REFERENCES youtube_videos(video_id)
);
CREATE INDEX idx_dwo_group_bucket
  ON debut_window_video_organicity(group_key, window_bucket);

-- 그룹별 × 버킷별 집계 (대시보드 KPI용)
CREATE TABLE debut_window_organicity_summary (
  group_key             TEXT NOT NULL,
  window_bucket         TEXT NOT NULL,
  video_count           INTEGER NOT NULL,
  long_form_count       INTEGER NOT NULL,
  short_form_count      INTEGER NOT NULL,
  organic_score_mean    REAL,               -- view-weighted mean
  organic_ratio         REAL,
  suspect_ratio         REAL,
  likely_paid_ratio     REAL,
  total_views           INTEGER,
  total_engagement      INTEGER,
  computed_at           TEXT NOT NULL,
  PRIMARY KEY (group_key, window_bucket)
);
```

### 윈도우 버킷 정의 (5개 비중복, 총 121일)

| Bucket | `days_relative_to_debut` 범위 | 의미 |
|---|---|---|
| `D-60` | `-60 ~ -31` | 초기 빌드업 (티저, 멤버 공개) |
| `D-30` | `-30 ~ -2` | 최종 푸시 (M/V 티저, 콘셉트 필름) |
| `D-Day` | `-1 ~ +1` | 데뷔일 전후 ±1일 (M/V 본편, 데뷔 쇼케이스) |
| `D+30` | `+2 ~ +30` | 데뷔 첫 달 (음방 활동, 콘텐츠 폭주) |
| `D+60` | `+31 ~ +60` | 데뷔 후 정착기 |

상수는 `worker/src/idol_sight/analysis/debut_window.py` 한 곳에서 관리.

### 설계 이유

- **두 테이블 분리**: 영상별(drill-down) + 그룹×버킷별 집계(KPI). 매 렌더에 영상 합산 회피.
- **`signal_breakdown` JSON 저장**: 점수 형성 신호별 기여도를 보존하여 false-positive 사례 운영자가 직접 검증 가능 (윤리 §5 준수).
- **`days_relative_to_debut` 캐싱**: 매 쿼리마다 `julianday` 계산 회피.
- **별도 테이블 (기존 `youtube_videos` 확장 X)**: 분석 모듈 격리, nullable 컬럼 누적 회피.

---

## §3 Composite Score 알고리즘

영상 1개당 0–100 점수. 3개 신호의 가중 평균.

### 신호 1: Engagement Rate Score (가중치 0.5)

```
engagement_rate = (like_count + comment_count) / max(view_count, 1)
```

영상 종류별 baseline 분기:

| 영상 | 0점 (paid 의심) | 100점 (organic 정상) | 식 |
|---|---|---|---|
| Long-form | ≤ 0.5% | ≥ 5.5% | `clamp((er - 0.005) / 0.050 * 100, 0, 100)` |
| Shorts | ≤ 0.3% | ≥ 3.3% | `clamp((er - 0.003) / 0.030 * 100, 0, 100)` |

Shorts 기준이 낮은 이유: 자동재생/패시브 시청 비중이 높아 organic도 engagement가 낮게 나옴.

### 신호 2: Like-Comment Balance Score (가중치 0.3)

```
ratio = like_count / max(comment_count, 1)
```

K-pop 영상 정상 ratio = 15 ~ 80. 밖이면 비대칭 봇 활동 의심.

```python
if 15 <= ratio <= 80:
    return 100
elif ratio < 15:                                # comment-farm 의심
    return max(0, 100 - (15 - ratio) * 8)
else:  # ratio > 80                             # like-farm 의심
    return max(0, 100 - (ratio - 80) / 5)
```

- ratio = 5 → 20점
- ratio = 200 → 76점
- ratio = 500 → 16점

### 신호 3: Velocity-Engagement Coherence Score (가중치 0.2)

기존 `viral_velocity_ratio`(view_count_24h / 채널평균) 와 engagement_rate 교차 검증.

```python
if velocity_ratio is None or velocity_ratio < 1.5:
    return 50                                   # 중립 (바이럴 없음)
elif engagement_rate >= 0.03:
    return 100                                  # 진짜 viral
elif engagement_rate >= 0.015:
    return 60                                   # 약한 의심
else:
    return 20                                   # paid burst
```

### Composite

```python
organic_score = round(
    0.5 * engagement_score
  + 0.3 * balance_score
  + 0.2 * velocity_coherence_score
)
```

### Verdict 임계값

| organic_score | verdict | 의미 |
|---|---|---|
| (sample 부족) | `insufficient_data` | 분석 제외. `view_count < 1000` **AND** `(likes + comments) < 10`. organic_score는 NULL 처리 |
| ≥ 70 | `organic` | 자연 호응 |
| 40–69 | `suspect` | 일부 신호 비정상, 검토 필요 |
| < 40 | `likely_paid` | 유료 부스팅 강한 의심 |

`insufficient_data` 영상은 그룹 집계의 비율 계산에서 분모에서 빠짐 (false positive 방지). UI에서는 "데이터 부족" 회색 row로 표시 가능.

### Signal Breakdown JSON 예시

```json
{
  "engagement_rate": 0.012,
  "engagement_score": 14,
  "like_comment_ratio": 245.0,
  "balance_score": 67,
  "velocity_ratio": 4.2,
  "velocity_coherence_score": 20,
  "weights": {"engagement": 0.5, "balance": 0.3, "velocity": 0.2}
}
```

운영자가 점수 형성 과정을 100% 추적 가능. 대시보드 영상 row 클릭 시 panel에 노출.

### 그룹별 × 버킷별 집계

- **`organic_score_mean`**: view-weighted `Σ(score × views) / Σ(views)`
  - 이유: 1만 뷰와 500만 뷰를 동등 가중하면 시장 임팩트 왜곡됨.
- **`organic_ratio` / `suspect_ratio` / `likely_paid_ratio`**: 영상 수 기준 단순 비율.

### 한계 명시 (운영자 교육 메시지)

1. **누적값 기준**: 데뷔 후 시간이 지난 그룹은 organic 댓글 회복으로 paid 신호 희석. 신규 그룹일수록 정확도 높음.
2. **False positive 가능성**: 진짜 viral인데 댓글이 의외로 적은 경우 등. verdict는 추정이며 인간 판단 필수.
3. **임계값(70/40)과 가중치(0.5/0.3/0.2)**: v1 초기값. 실 데이터 분포 본 뒤 운영 중 calibrate.

---

## §4 대시보드 표시 (3곳)

### A. Market Overview 그룹 카드 KPI

위치: `frontend/src/views/MarketOverview.tsx`, 기존 그룹 카드 KPI 그리드에 추가.

```
┌─ STELLIVE ─────────────────────────────┐
│  Health Score: 84  (▲ 2)               │
│  ─────────────────────────────────     │
│  Debut Window Organicity:              │
│   D-60 D-30 D-Day D+30 D+60            │
│    78   65   72    88   84             │
│   (view-weighted mean per bucket)      │
└────────────────────────────────────────┘
```

- 5개 미니 숫자 인라인. 색상: organic=초록 / suspect=노랑 / likely_paid=빨강
- N/A 버킷(영상 0개) → 회색 dash `—`
- 호버 tooltip: 각 버킷별 영상 수 + organic/suspect/paid 분포

### B. GroupContent 페이지 — Debut Window 탭

위치: `frontend/src/views/GroupContent.tsx`, 신규 탭 "Debut Window".

탭 2차원 구조:

```
[D-60] [D-30] [D-Day] [D+30] [D+60]                          ← Primary: 시간 버킷
 ─────────────────────────────────────
 Filter:  ⦿ All   ○ Long-form   ○ Shorts                    ← Secondary: 종류

┌──────────────────────────────────────────────────────────────────────┐
│ D-day │ Title                  │ Type    │ Views │ ER    │ Score │ 판정       │
├───────┼────────────────────────┼─────────┼───────┼───────┼───────┼───────────┤
│  -45  │ "comeback teaser #1"   │ Shorts  │  1.8M │ 0.7%  │  18   │ 🔴 likely │
│  -38  │ "member ABC reveal"    │ Long    │  420K │ 6.1%  │  92   │ 🟢 organic│
└──────────────────────────────────────────────────────────────────────┘

Bucket 요약 (탭 하단):  14 videos · mean 68 · organic 8 / suspect 4 / likely 2
```

- URL deep-link: `?bucket=D-30&type=shorts`
- 행 클릭: 우측 panel에 signal_breakdown JSON + YouTube 원본 링크
- 미데뷔 그룹(MiiWAN): D-Day/D+30/D+60 탭 비활성, "Future" 표시

### C. MiiWAN Briefing — 경쟁사 비교 차트

위치: `frontend/src/views/MiiWANBriefing.tsx`, 신규 섹션 "Competitive Debut Window Posture".

```
View bucket: [D-60 | D-30 ▼ | D-Day | D+30 | D+60]

┌─ Debut Window Organicity at D-30 (view-weighted) ────┐
│   ISEDOL    ████████████████████  87                │
│   PLAVE     ██████████████████░░  82                │
│   STELLIVE  ███████████████░░░░░  68                │
│   SKINZ     ████████████░░░░░░░░  56                │
│   B:DAWN    ████████░░░░░░░░░░░░  41  ← likely paid │
│   OWIS      ██████████░░░░░░░░░░  48                │
│   MY:RAKL   N/A                                     │
│   MiiWAN    ███████████████████░  78  ← ours        │
└─────────────────────────────────────────────────────┘
   Showing 8 of 9 groups with D-30 data
```

- 기본 보기 = `D-30` (MiiWAN 현재 시점과 동시간대)
- MiiWAN 강조 (`← ours`), N/A 회색 처리
- 모바일: 가로 막대 → 세로 stacked bar로 자동 전환

### D. API 엔드포인트 (Pages Functions)

| 엔드포인트 | 반환 | 사용처 |
|---|---|---|
| `GET /api/debut-window/summary?bucket={X}` | 그룹 × 버킷 집계 (bucket 미지정 시 5버킷 전체) | A, C |
| `GET /api/debut-window/videos?group={key}&bucket={X}&type={shorts/long}` | 영상 list + signal_breakdown | B |

응답 캐싱: `Cache-Control: public, max-age=600` (10분). aggregate cron(일 1회) 갱신 주기에 맞춤.

---

## §5 구현 단계 + 파일 구조

### Phase 1 — DB 스키마

| 파일 | 역할 |
|---|---|
| `migrations/0052_debut_window_organicity.sql` | §2 두 테이블 + 인덱스 |

배포: `wrangler d1 migrations apply idol-sight --remote` (사용자 확인 후).

### Phase 2 — 분석 모듈 + TDD

```
worker/src/idol_sight/analysis/debut_window.py     # 신규
worker/tests/unit/test_debut_window.py             # 신규 (TDD RED first)
```

`debut_window.py` 공개 인터페이스:
```python
WINDOW_BUCKETS = [
    ("D-60", -60, -31),
    ("D-30", -30, -2),
    ("D-Day", -1, +1),
    ("D+30", +2, +30),
    ("D+60", +31, +60),
]

def bucket_for(days_relative: int) -> str | None: ...
def compute_engagement_score(er: float, is_short: bool) -> int: ...
def compute_balance_score(ratio: float) -> int: ...
def compute_velocity_coherence(velocity_ratio: float | None, er: float) -> int: ...
def compute_organic_score(video: dict) -> tuple[int, dict]: ...
def classify_verdict(score: int) -> str: ...
def build_video_organicity(client) -> BuildResult: ...
def build_summary(client) -> BuildResult: ...
```

테스트 케이스 (RED first):
- 각 sub-score 함수 경계값 (engagement 0%/5.5%/12%; ratio 5/15/80/200/500; velocity 1.0/2.5/5.0)
- `bucket_for(-31) == "D-30"`, `bucket_for(0) == "D-Day"`, `bucket_for(-99) is None`
- Zero views/zero comments division-by-zero 안전성
- Long-form vs Shorts 분기 차이
- Verdict 임계값 70/40 경계
- view-weighted mean 계산 검증

### Phase 3 — Aggregate 파이프라인 통합

`cli.py:_run_aggregate` 의 `if not skip_derived:` 분기 안에 추가 (melon UPDATE에 의존하지 않으므로):

```python
if not skip_derived:
    # ... existing combined/velocity/reactivity ...

    # NEW: debut window organicity
    from idol_sight.analysis.debut_window import (
        build_video_organicity, build_summary,
    )
    video_org = build_video_organicity(client)
    if video_org.statements:
        client.batch(video_org.statements)
    typer.echo(f"debut_window_videos: wrote {len(video_org.statements)} rows")

    summary_org = build_summary(client)
    if summary_org.statements:
        client.batch(summary_org.statements)
    typer.echo(f"debut_window_summary: wrote {len(summary_org.statements)} rows")
```

collect-daily 의 sandwich 1차 aggregate에서만 실행 (2차는 `--skip-derived`로 자연 스킵).

### Phase 4 — 기존 데이터 백필 (1회성)

이미 데뷔한 그룹의 D-60~D+60 영상 메타데이터/통계를 채워야 함:

1. **`backfill-yt-videos.yml` 워크플로**: 9개 그룹 순회 (workflow_dispatch 9회 또는 워크플로에 'all' 옵션 추가)
2. 완료 후 `aggregate` 1회 실행 → `debut_window_*` 테이블 자동 채워짐
3. 정상 가동 후 일일 cron이 신선도 유지

`docs/onboarding.md` 에 1회성 백필 절차 명시.

### Phase 5 — API 엔드포인트

```
frontend/functions/api/debut-window/summary.ts     # 신규
frontend/functions/api/debut-window/videos.ts      # 신규
```

기존 `frontend/functions/api/` 패턴 그대로 — D1 query + JSON + `Cache-Control` + `_middleware.ts` 인증 자동 적용.

### Phase 6 — Frontend

```
frontend/src/api.ts                                # 함수 2개 추가
frontend/src/components/DebutWindowKPI.tsx         # 신규 (A)
frontend/src/components/DebutWindowVideoTable.tsx  # 신규 (B)
frontend/src/components/DebutWindowSignalPanel.tsx # 신규 (B 우측 패널)
frontend/src/components/CompetitorOrganicityBar.tsx # 신규 (C)
frontend/src/views/MarketOverview.tsx              # 수정 (A 삽입)
frontend/src/views/GroupContent.tsx                # 수정 (B 탭 추가)
frontend/src/views/MiiWANBriefing.tsx              # 수정 (C 섹션 추가)
```

기존 `KPI.tsx` 디자인 토큰 따름. 색상 매핑: organic=초록 `#22c55e`, suspect=노랑 `#eab308`, likely_paid=빨강 `#ef4444`.

### Phase 7 — LLM 인사이트 (별도 PR, v1.1)

`insights.ai_comment` 인프라에 'organicity_compare' 프롬프트 추가 — `analyze-weekly` cron에서 §4-C 차트 하단 코멘트 자동 생성. v1 출시 시점에 같이 갈 필요 없음.

### 커밋 순서 (6개)

1. `feat(db): 0052 debut_window_organicity migration`
2. `feat(analysis): debut_window organic score module + tests`
3. `feat(cli): wire debut_window into aggregate pipeline`
4. `chore(backfill): run backfill-yt-videos for all groups + docs`
5. `feat(api): debut-window summary/videos endpoints`
6. `feat(frontend): debut window KPI + video table + competitor compare`

### 재계산 전략

매 일일 aggregate에서 윈도우(D-60~D+60) 내 영상 전수 재계산. 9그룹 × 평균 30~60영상/버킷 × 5버킷 ≈ 1350~2700 row. D1 batch write로 ~10초 내 완료 예상. 별도 인크리멘털 로직 불필요 (전수 재계산이 가장 단순하고 새 stats 반영 즉시).

### 리스크 / 한계

1. **YouTube API quota**: 백필 1회 + 일일 갱신은 기존 collector 부하 내. `youtube_video_stats`는 이미 6h마다 갱신.
2. **점수 calibration**: 임계값/가중치 모두 v1 초기값. 한 달치 실 데이터 본 뒤 분포 보고 조정 권장.
3. **윤리 §5 준수**: `likely_paid` verdict는 자동 추정. UI에 `"v1 heuristic — verify manually before external use"` 디스클레이머 표시. Discord 자동 알림은 v1에서 의도적 제외.
4. **MiiWAN 미데뷔 그룹**: D-Day/D+30/D+60 버킷 데이터 없음 — UI에서 "Future" 회색 상태, 데뷔일 자동 활성화.
