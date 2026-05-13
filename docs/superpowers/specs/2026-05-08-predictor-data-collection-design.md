# 발행 전 시뮬레이터 + 멤버 출연 매핑 — 데이터 수집 설계

**작성일**: 2026-05-08
**상태**: 설계만, 구현 미착수 (참조용)
**관련 spec**: `2026-05-04-idol-sight-rebuild-design.md` (전체 시스템) / `2026-05-04-v2-roadmap.md` (V2 로드맵) / `2026-05-04-analysis-and-llm.md` (분석 산식)
**관련 외부 자산**: `~/Desktop/miiwan-dashboard/app/services/predictor.py`, `~/Desktop/miiwan-dashboard/app/config.py`

---

## 1. 의도 / 비목표

### 의도
miiwan-dashboard 의 두 자산을 idol-sight 로 흡수할 때 **데이터 수집 단계에서 무엇이 필요한가**를 사전 정리한다. 두 자산은:

1. **멤버 출연 매핑** — `video_id ↔ member_id` 다대다 매핑. 8개 그룹 × 평균 5~10명 멤버에 대해 영상별 출연자 정보를 갖는 데이터 레이어.
2. **발행 전 시뮬레이터** — `(members[], format, content_type, upload_hour)` → `predicted_views ± margin, S/A/B/C grade, reasoning[]` 산식. miiwan-dashboard 의 3-tier confidence (own≥10 HIGH / own>0+comp MED / comp only LOW / 둘다X 5000) 로직을 idol-sight 다중 그룹 환경에 재정의.

두 자산은 **데이터 의존 그래프상 멤버 매핑이 시뮬레이터의 선행 조건**이다 (시뮬레이터 입력에 멤버 조합이 들어가므로). 따라서 한 문서에서 같이 다룬다.

### 비목표
- **즉시 구현하지 않는다**. 본 문서는 데이터 인프라 요구사항을 미리 명세화해 추후 우선순위가 잡히면 사전 정보로 활용.
- **알고리즘 디자인은 다루지 않는다** (3-tier confidence 자체의 idol-sight 재정의는 별도 spec 에서). 본 문서는 **그 알고리즘에 어떤 데이터를 어디서 어떻게 모아 쓸 것인가**만 다룬다.
- **본체 정보 / 2차 창작 본문 수집은 절대 다루지 않는다** (윤리 가이드라인 §1·§2 절대 준수).

---

## 2. 데이터 의존 그래프 (요약)

```
                     ┌─────────────────────────────────────────┐
                     │ 발행 전 시뮬레이터                         │
                     │  predict(members[], format, hour, ...)   │
                     └─────────────┬───────────────────────────┘
                                   │ 의존
        ┌──────────────────────────┼──────────────────────────┐
        ▼                          ▼                          ▼
┌────────────────┐    ┌──────────────────────┐    ┌──────────────────────┐
│ 멤버 출연 매핑    │    │ 영상 메타 (있음/부족)  │    │ 도메인 휴리스틱 상수    │
│ video_member   │    │ format / upload_hour │    │ TIME_MULTIPLIER      │
│ _attribution   │    │ content_type / 24h   │    │ MILESTONES / etc.    │
└────────┬───────┘    │ velocity             │    └──────────────────────┘
         │            └──────────┬───────────┘
         ▼                       ▼
┌──────────────────────────────────────────┐
│ 원천 수집 (collectors/youtube.py 확장)      │
│ + 멤버 키워드 사전 + 매칭 알고리즘             │
│ + 수동 큐레이션 워크플로                      │
└──────────────────────────────────────────┘
```

**해석**: 시뮬레이터 = (멤버 매핑) ⊕ (영상 메타 보강) ⊕ (휴리스틱 상수) 의 합. 이 중 멤버 매핑이 가장 무거운 신규 데이터 작업이다.

---

## 3. 멤버 출연 매핑 — 데이터 수집

### 3.1 필요 데이터 인벤토리

| 데이터 | 형태 | 소스 | idol-sight 현재 상태 |
|---|---|---|---|
| 멤버 마스터 | (group_key, name, name_en, aliases[]) | `members` 테이블 + 신규 `member_aliases` | `members.name`, `name_en` 있음, **aliases 없음** |
| 영상 메타 | (video_id, title, channel_id, group_key) | YouTube Data API + `youtube_videos` | **있음** (title 500자, description/tags 미저장) |
| 멤버-영상 매핑 | (video_id, member_id, attribution_method, confidence) | 자동 매칭 + 수동 검증 | **없음** (신규 테이블) |
| 매칭 근거 (audit) | (video_id, member_id, matched_keyword, source_field) | 매칭 알고리즘 출력 | **없음** (신규 테이블) |

### 3.2 수집 소스 — 무엇을 어디서 가져오나

**A. YouTube 메타 (신규 수집 항목)**
- 현재 `collectors/youtube.py` 는 **title 만** 저장. 멤버 매핑 정밀도를 위해 다음을 추가 캡처:
  - `description` 의 **첫 200자만** + 키워드 매칭 결과 (본문 영구 저장 X — 매칭 종료 후 폐기)
  - `tags[]` (YouTube 메타 — 채널 운영자가 직접 단 라벨, 멤버명 포함 가능성 매우 높음)
- 수집 비용: 기존 `videos.list?part=snippet` 호출에서 이미 받음 (저장만 안 했을 뿐) — **API quota 추가 0**
- 변경 위치: `collectors/youtube.py` `_save_video()` 부근. tags 만 신규 컬럼 `youtube_videos.tags TEXT` (JSON array string) 으로 저장하고 description 은 매칭 결과만 보존.

**B. 멤버 키워드 사전 (수동 시드)**
- 8 그룹 × 멤버 = 약 50명. 각 멤버마다:
  - `primary` (예: "안석우"), `english` (예: "An Seokwoo"), `aliases` (예: ["석우", "Seokwoo", "AN"])
- **가상 캐릭터명만 등재** — 본체 정보 절대 X (윤리 §1)
- 저장: 신규 테이블 `member_aliases (member_id, alias TEXT, alias_type TEXT, lang TEXT)` 또는 `members.aliases JSON`
- 시드 작업: 1회 수동 (담당자 1명, 약 4~6시간)
- 유지보수: 새 별명 발견 시 admin endpoint 또는 SQL UPDATE

**C. 채널 메타 (이미 있음)**
- `groups`, `members.yt_channel_id` 가 채널-그룹 / 채널-멤버 매핑을 이미 제공
- 솔로 채널 영상은 **그 멤버가 100% 출연** 으로 자동 attribution (Pass 0)

**D. 외부 데이터 — 가져오지 말 것**
- 위키/팬위키 자동 크롤: 본체 정보 혼입 위험 (윤리 §1) → **금지**
- 디시/더쿠 게시물 본문: 윤리 §3 → **저장 금지** (idol-sight 는 양만 트래킹 중)
- 팬덤 메타데이터 사이트 (예: namuwiki, kpopwiki) API: 라이선스 불분명 + 본체 정보 혼입 → **금지**

### 3.3 매칭 알고리즘 (4-pass, 가벼운 → 무거운 순)

각 영상에 대해 다음 순서로 시도하고 매칭된 멤버 + 그 confidence를 기록한다. **여러 pass 결과를 OR로 합산** (한 영상에 여러 멤버 매칭 가능, 콜라보/단체 영상이 정상).

| Pass | 입력 | 신뢰도 | 비용 | 비고 |
|---|---|---|---|---|
| **0. 솔로 채널 자동** | `members.yt_channel_id == video.channel_id` | 1.00 | 무료 | ISEDOL/STELLIVE 솔로 영상 즉시 처리 |
| **1. title 정규식 매칭** | `member_aliases` 사전 vs `youtube_videos.title` (case-insensitive) | 0.85 | 무료 | 가장 직접적. false positive 위험 (예: "石雨" 같은 짧은 alias) |
| **2. tags 매칭** | `member_aliases` vs `tags[]` (YouTube tags) | 0.90 | 무료 | 채널 운영자가 직접 단 라벨이라 정확도 높음 |
| **3. description 키워드** | description 첫 200자에서 alias 등장 (본문 저장 X, 매칭 결과만) | 0.65 | 무료 | description 은 광고/SNS 링크 노이즈 큼 — 매칭 결과만 사용 |
| **4. (선택) thumbnail vision** | Gemini Vision에 (썸네일 URL, 멤버 캐릭터 표 한 장) 같이 보여주고 등장 멤버 분류 | 0.95 | $0.0001~0.0003 / 영상 | 비용 거의 무시할 수준이지만 캐릭터 일관성 유지 필요. **Phase 3 이후에만 검토** |

**재현률 vs 정확도 균형**: idol-sight 의 BI 사용자(50명+contractor)에게 노출되는 데이터라 false positive 리스크가 더 크다. 따라서:
- `attribution_method='auto'` + `confidence < 0.85` → UI에 "추정" 배지
- `attribution_method='manual'` + 검수자 ID 기록 → 신뢰 데이터
- 시뮬레이터 입력에는 `confidence ≥ 0.85` 만 사용 (콜드스타트 보수적 처리)

### 3.4 수동 큐레이션 워크플로

**필요한가**: 콘텐츠가 누적될수록 자동 매칭 정확도는 무한히 안 오른다. 다음 케이스에서 수동 검수가 필요:
- 신규 멤버 추가 (새 그룹 / 멤버 활동 시작)
- alias 신규 발견 (커뮤니티에서 새 별명 출현)
- 자동 매칭 실패 영상 (Pass 1~3 모두 0건 → 단체 콘텐츠로 fallback)

**도구 옵션 비교**:

| 옵션 | 장점 | 단점 |
|---|---|---|
| Cloudflare Pages admin 페이지 + RBAC | idol-sight 통합, 권한 분리 명확 | 개발 비용 (M, 2~3d) |
| 구글 시트 + 일별 sync 잡 | 즉시 가능, 마케터 친숙 | 권한 관리 약함, 동기화 충돌 |
| D1 직접 SQL (운영자 1~2명) | 0 개발비 | UX 없음, 실수 위험 |

**권장**: 초기에는 **D1 직접 SQL 1명 운영** (개발비 0). 매핑 데이터 1k행 도달 또는 수동 검수가 주 N건 발생 시 admin UI 도입. RBAC 의존성이 큼 — `2026-05-04-v2-roadmap.md` S급 RBAC 작업 후행.

### 3.5 API quota / 비용

YouTube Data API:
- 기존 `videos.list?part=snippet,statistics,contentDetails` 호출에 **이미 description/tags 포함**됨 (저장만 안 했을 뿐). **추가 quota 0**.
- 신규 영상 100/일 가정 시 일일 비용 변화 없음.

D1 저장:
- `youtube_videos.tags JSON` 추가: 영상당 평균 200B → 8그룹 × 1500편 = 12k 영상 × 200B ≈ 2.4MB. 무시 가능.
- `member_aliases`: 50명 × 평균 5 alias × 50B = 12.5kB. 무시 가능.
- `video_member_attribution`: 영상당 평균 3명 × 12k = 36k 행. 행당 100B ≈ 3.6MB. D1 5GB 무료 한도 충분.

수동 큐레이션 인건비 (초기 시드만):
- alias 사전 작성: 4~6시간 × 1명
- 자동 매칭 결과 검수 (sample 5%): 12k × 5% = 600영상 × 30초/영상 = 5시간 × 1명
- **합계 ≈ 1.5인일** (1회만)

Vision (Pass 4, 선택):
- Gemini 1.5 Flash vision: $0.000075/이미지 + $0.00003/output_token ≈ 영상당 $0.0002
- 12k 영상 일괄 처리: $2.4 (전체 백필)
- 매월 신규 영상 ~3000편: $0.6/월
- **무시할 수준** — 단 활성화 시점은 자동 매칭 미달 영상이 충분히 누적된 후 (Phase 3)

### 3.6 윤리 가이드라인 점검

| 가이드 | 본 설계의 부합 여부 |
|---|---|
| §1 본체 정보 BI 저장 금지 | ✅ alias 사전은 가상 캐릭터명/캐릭터 영문명만. 위키/SNS 자동 크롤 금지 명시 |
| §2 2차 창작 양만 트래킹 | ✅ 영상 본문 저장 X (description은 매칭 후 폐기) |
| §3 디시/더쿠 본문 저장 신중 | ✅ 본 설계는 YouTube 채널 메타에만 한정 |
| §4 자사 깊이, 경쟁사 외형 | ⚠️ 8 그룹 모두 멤버 매핑 적용 시 경쟁사 멤버 단위 분석이 가능해짐 — **시뮬레이터(자사) vs 멤버 매핑(8그룹) 의 적용 범위를 명확히 분리해야 함**. 멤버 매핑 자체는 외형 데이터(공식 채널 메타)이므로 §4 위반 아님. 단 멤버 단위 health score 등은 자사만 적용 |
| §5 위기 알림 인간 검증 | N/A (본 설계 범위 밖) |

---

## 4. 발행 전 시뮬레이터 — 데이터 수집

### 4.1 predictor 산식 입력 인벤토리

miiwan-dashboard `predictor.predict_views()` 입력:

| 입력 | idol-sight 현재 상태 | 신규 수집 필요 여부 |
|---|---|---|
| `members[]` (멤버 조합) | 멤버 마스터는 `members` 테이블에 있음. 영상↔멤버 매핑은 **없음** | 위 §3 멤버 매핑 의존 |
| `format` (shorts/longform/live) | `youtube_videos.is_short` 있음. live 분류는 **없음** (현재 type-based) | live 판정 룰 추가 (`liveStreamingDetails` 응답) |
| `content_type` (MV/Cover/Dance/Vlog/...) | `youtube_videos.content_type` 있음, idol-sight 분류 카테고리 (MV/Cover/Live/Audio/Variety/Teaser/Behind/Short). miiwan은 6 카테고리 | **재매핑 필요** — idol-sight 분류 사전을 그대로 쓰되 시뮬 결과 카테고리만 통일 |
| `upload_hour` (0~23) | **없음** (`published_at` 에서 추출 가능) | 컬럼 신규 추가 (생성 컬럼 또는 백필 UPDATE) |
| `days_since_debut` | `groups.debut_date` 있음, 매번 계산 | 없음 (산출 가능) |
| `own_videos[]` (자체 채널 영상 평균) | `youtube_videos` + `youtube_video_stats` 에 있음 | 없음 |
| `competitor_baseline` (경쟁사 평균) | `external_cohort_*` 테이블에 있음 | percentile rank 재계산 (4.5) |

### 4.2 자체(MiiWAN) 데이터 누적 전략

**콜드스타트 임계** (`COLD_START_THRESHOLD = 10`): MiiWAN 자체 영상이 ≥10편 누적되어야 HIGH confidence. 데뷔 2026-06-01 기준:

- **D-30 ~ D-1** (2026-05-02 ~ 05-31): 티저/프리데뷔 콘텐츠. 보통 5~8편
- **D+0 ~ D+30** (2026-06-01 ~ 06-30): 데뷔곡 MV + 쇼케이스 + 활동영상. 보통 10~20편
- **추정 콜드스타트 도달**: **D+15 ~ D+30 사이**

**필요 작업**:
1. MiiWAN 채널 ID 등록 (현재 등록 상태인지 확인 필요 — `groups` 테이블에서 group_key='miiwan' 채널 ID 점검)
2. 데뷔 전부터 매일 cron 으로 신규 영상 자동 캡처 (idol-sight orchestrator 에 이미 패턴 있음 — config 만 ON)
3. 자체 영상 ≥10편 도달 전까지는 시뮬레이터를 **LOW confidence 모드만** 노출 (또는 disabled). UI에 "데이터 누적 중 D+N/10편" 진행 바

### 4.3 TIME_MULTIPLIER — 휴리스틱 → 데이터 회귀

miiwan-dashboard `config.py` 의 `TIME_MULTIPLIER` 24-key dict:
- 04시 0.45 (최저), 19~20시 1.00 (최고), 00~03시 0.55, 12~14시 0.85
- **출처**: 마케팅 직관 (한국 유튜브 저녁 피크 가정)
- **검증되지 않음**: 데이터 기반 회귀 학습 결과가 아님

idol-sight 통합 시 **두 단계** 권장:

**Stage A (시뮬레이터 v0)**: miiwan dict 그대로 도입, **시드 데이터**로 기록
- 위치: `analysis_constants(key, json_value, updated_at, source)` 또는 코드 상수
- 사용자에게 "휴리스틱 기반" 라벨 명시 (UI 'est' 배지 패턴 재사용)

**Stage B (back-fit, Phase 2 이후)**: 8 그룹 × 모든 영상 데이터로 회귀
- 입력: `(group_key, format, content_type, upload_hour, days_since_debut)` → 24h velocity
- 모델: 다중회귀 또는 mixed-effect (그룹 random intercept) — 단 idol-sight 에 ML 인프라 없음
- 단순화: **시간대별 평균 24h velocity / 전체 평균** 비율을 그대로 사용 (그룹×포맷별 분리)
- 데이터 충분 시점: 그룹당 ≥50 영상 (대부분 충족), 시간대 전체 커버 (24h 분산 검증 필요)
- 신규 테이블 불필요 — `youtube_videos` + `youtube_video_stats` 조인으로 충분

### 4.4 `upload_hour` 컬럼 + 백필

**왜 필요**: 현재 `youtube_videos.published_at` 은 ISO8601 timestamp. 시간대 분석은 매번 SQL `strftime('%H', published_at, '+9 hours')` 호출이 가능하나, **D1 의 generated stored column 지원이 제한적** (cf. 데이터 엔지니어 보고). 인덱스 활용을 위해 물리 컬럼이 안전.

**구현**:
- migration 신규: `ALTER TABLE youtube_videos ADD COLUMN upload_hour INTEGER`
- 백필: `UPDATE youtube_videos SET upload_hour = CAST(strftime('%H', published_at, '+9 hours') AS INTEGER)`
- 신규 INSERT: collector 코드에서 채우기 (`collectors/youtube.py`)
- KST 타임존 가정 명시 (한국 채널 99% — 글로벌 시청자 시간대는 시뮬레이터 v0 범위 밖)

비용: ALTER + UPDATE 12k 행 → D1에서 1초 미만, 1회만.

### 4.5 Confidence Interval — `0.03` 매직넘버 대체

miiwan `_competitor_baseline = avg_total_view_count * 0.03` ("채널 누적의 3%가 영상 1개 평균") 가정은 단일 그룹 운영 도구라 가능했음. idol-sight 8 그룹 분산 (PLAVE 40만+ subs ↔ B:DAWN 소규모) 에 그대로 적용하면 편향 큼.

**재정의**:
- 그룹별 24h velocity 분포 (`youtube_videos` × `youtube_video_stats` 조인)에서:
  - p25 → LOW bound
  - p50 → median 예측
  - p75 → HIGH bound
- 포맷별/콘텐츠 타입별 분산이 크면 (group_key, format) 별 percentile
- 데이터 요구: 그룹당 ≥30 영상의 24h 시점 view 데이터. **이미 충족** (idol-sight V2.5 video_velocity 모듈이 같은 데이터 사용 중)

**신규 테이블 없음** — analysis 모듈에서 SELECT 로 산출.

### 4.6 Back-test (시뮬레이터 검증)

**목적**: 시뮬레이터 결과가 실제 조회수와 얼마나 일치하는지 정량 측정. v0 출시 전 1회, 그 후 분기별.

**데이터셋**:
- 8 그룹 × 과거 1년 영상 = 약 5~8k 영상
- 각 영상에 대해 `predict_views()` 입력 (당시 시점 own/comp data 만 가지고) → 예측치 vs 실제 24h views 비교

**메트릭**:
- MAPE (Mean Absolute Percentage Error)
- 등급 정확도 (실제 등급 분포 vs 예측 등급 분포 — 등급은 후행 산출이지만 검증 가능)

**저장 위치**: `analysis/predictor_backtest.py` 모듈 + `predictor_backtest_runs(run_id, run_at, mape, sample_size, ...)` 테이블 (선택).

**비용**: 일회성 SQL+분석. 추가 데이터 수집 필요 없음 (이미 있는 데이터 재사용).

---

## 5. 통합 의존 그래프 + 단계별 로드맵

### 의존 그래프

```
Phase 0: 인프라
  ├── upload_hour 컬럼 + 백필           [무이슈, S]
  ├── tags 컬럼 추가 + 신규 영상 캡처     [무이슈, S]
  ├── member_aliases 사전 시드          [수동 1.5인일, S]
  └── live 판정 룰 (liveStreamingDetails) [무이슈, S]
            │
            ▼
Phase 1: 멤버 매핑 v0 (자동만)
  ├── video_member_attribution 테이블   [migration 1개]
  ├── 4-pass 매칭 알고리즘               [worker 신규 모듈, M]
  ├── 자동 attribution 백필 (1회)       [12k 영상, ~1시간]
  └── confidence 배지 UI                [frontend, S]
            │
            ▼
Phase 2: 멤버 매핑 v1 (수동 검수)
  ├── 검수 워크플로 (D1 SQL → admin UI) [RBAC 의존]
  ├── attribution_method='manual' 트래킹
  └── alias 사전 보강 (CommunityWatch)
            │
            ▼
Phase 3: 발행 전 시뮬레이터 v0 (MiiWAN 한정)
  ├── MiiWAN 자체 영상 ≥10편 누적         [데뷔 D+15~D+30 자동 도달]
  ├── 3-tier predictor 산식 idol-sight 재정의 [analysis/predictor.py 신규]
  ├── TIME_MULTIPLIER 시드 (Stage A)
  ├── confidence interval percentile 산식 (4.5)
  ├── /api/predict Pages Function       [신규 endpoint]
  └── MiiWANPredictor 신규 view + RBAC   [frontend, L]
            │
            ▼
Phase 4: 시뮬레이터 v1 (정밀화)
  ├── TIME_MULTIPLIER 데이터 회귀 (Stage B)
  ├── back-test 모듈 + 분기별 recalibration
  ├── (선택) Vision Pass 4 활성화
  └── 멤버 조합별 percentile baseline
```

### 단계별 일정 (권고, 우선순위 결정 시점에 재검토)

| Phase | 시점 | 노력 | 선결 조건 |
|---|---|---|---|
| Phase 0 | 즉시~D-DAY (2026-06-01) | S+S+S+S = 1~2d | 없음 |
| Phase 1 | Phase 0 직후 | M+S = 2~3d | Phase 0 |
| Phase 2 | RBAC 도입 후 | M | Phase 1 + RBAC (S급) |
| Phase 3 | MiiWAN D+30 이후 | L = 5d+ | Phase 1 + RBAC + 자체영상 ≥10편 |
| Phase 4 | Phase 3 운영 1~2개월 후 | M | Phase 3 + 데이터 누적 |

**중요**: Phase 0 의 4개 항목은 Phase 1~4 의 모든 후속 작업의 비차단 prerequisite 이므로, 본 통합 작업이 어느 우선순위로 결정되든 **Phase 0 만은 미리 박아두는 게 비용 대비 효율** 가장 큼.

---

## 6. 미해결 결정 (open questions)

본 설계가 구현으로 갈 때 풀어야 할 결정들. 현 시점 결정 X.

1. **alias 사전 저장 형태**: 별도 `member_aliases` 테이블 vs `members.aliases JSON` 컬럼 중 어느 쪽? — 초기엔 JSON이 단순, 검수 워크플로 도입 시 정규 테이블이 유리
2. **수동 큐레이션 도구**: D1 직접 SQL (0개발비) vs admin UI (M 노력) 의 전환 시점은 매핑 1k행? 검수 주 N건? — 데이터 누적 보고 결정
3. **Vision Pass 4 활성화 시점**: 자동 매칭 unmatched 영상이 몇 % 이상일 때? 윤리 가이드 §1 재점검 필요 (썸네일에 본체 사진이 들어가는 경우 — 가상 아이돌 특성상 거의 없겠지만 확인)
4. **시뮬레이터 적용 범위**: MiiWAN 한정 vs 8 그룹 전체 — §4 자사 깊이/경쟁사 외형 가이드라인상 **MiiWAN 한정 권장** (멤버 매핑 자체는 외형이라 8그룹 OK, 시뮬레이터는 전략적 자산이라 자사만)
5. **TIME_MULTIPLIER Stage B 회귀 모델 선택**: 단순 시간대별 평균 비율 vs 다중회귀 — 데이터 충분성 확인 후
6. **콜드스타트 시뮬레이터 노출 정책**: own≤9 시 `/api/predict` 자체 비활성? LOW confidence 결과 + 강력한 경고? — Cloudflare Access 그룹별 분기?

---

## 7. 참고 파일

**miiwan-dashboard 쪽**:
- `~/Desktop/miiwan-dashboard/app/services/predictor.py` (3-tier confidence + grade)
- `~/Desktop/miiwan-dashboard/app/config.py` (TIME_MULTIPLIER, MEMBERS, FORMATS)
- `~/Desktop/miiwan-dashboard/scripts/import_videos.py` (`detect_format`, `detect_content_type`, `MEMBER_KEYWORDS`)
- `~/Desktop/miiwan-dashboard/app/models.py` (VideoPerformance video×member 다중 행 패턴 — **idol-sight는 채택 X**)

**idol-sight 쪽**:
- `migrations/0001_init.sql` (`youtube_videos`, `members`, `youtube_video_stats` 스키마)
- `migrations/0003_seed_member_channels.sql` (멤버 솔로 채널 ID 시드)
- `migrations/0010_member_pop_normalized.sql` (멤버 popularity HHI 분석)
- `worker/src/idol_sight/collectors/youtube.py` (현재 영상 수집 + content_type 분류기)
- `worker/src/idol_sight/analysis/video_velocity.py` (24h velocity — 시뮬레이터 검증 데이터 소스)
- `worker/src/idol_sight/analysis/health_score.py` (4-factor health — 시뮬레이터와 후행 결합 가능)
- `frontend/src/views/MiiWANBriefing.tsx` (시뮬레이터 신규 view 의 별도 라우트화 정책 근거)
- `docs/superpowers/specs/2026-05-04-v2-roadmap.md` (RBAC S급 의존)
- `docs/superpowers/specs/2026-05-04-analysis-and-llm.md` (산식 변경 시 동시 갱신 대상)

---

## 8. 변경 이력

- 2026-05-08: 초안 작성. 즉시 착수 X, 우선순위 결정 시 본 문서 참조용.
