# IDOL-SIGHT 산식 레퍼런스 (Dashboard Formula Reference)

> **목적**: 대시보드가 계산하는 **모든 결정론적 산식**(가중치·임계값·정규화·분류 규칙)을 한 곳에 정리한 단일 참조 문서.
> **기준일**: 2026-07-20 (V2.55 Controversy Issue Dedup까지 반영 — §1.6 `_controversy_factor` 이슈 가중 기반 v3 + §1.6.1 `controversy_issues.py` 클러스터링 모듈 신설). 이전 V2.54 Controversy Noise Guard 포함 범위: §1.6 노이즈 플로어(count 기반), §13 `PROMPT_SENTIMENT` controversy 분류 엄격화. 이전 V2.53 Organic Trust Layer 포함 범위: §16 Organic Confidence 신설, §1.1 `debut_confirmed` PRE 게이트, §15 인지도 adj, §14.5 추정 코어 adj. 이전 기준일 2026-06-27(P2c) 포함 범위: SOV 재정의·controversy 재소싱·ritual 조건부 재분배·velocity 보간·서브컬처 진단·live_activity·awareness.
> **읽는 법**: 각 항목은 두 겹이다 — **🟢 쉽게** = 수식 없이 비유로 "뭘 보는 건지", 그 아래 **산식** = 정확한 공식·상수·`파일:라인`. 비전문가는 🟢만 읽어도 되고, 구현/검증은 산식까지 본다.
> **출처**: `worker/src/idol_sight/analysis/*.py`, `worker/src/idol_sight/cli.py`, `frontend/src/lib/*.ts`, `frontend/functions/lib/*.ts`, `frontend/functions/api/*.ts`, `frontend/src/components/FanLoyaltyCard.tsx`, `frontend/src/views/MarketOverview.tsx`, `migrations/*.sql`.
> **갱신 규칙**: 산식/상수 변경 시 이 문서와 `CLAUDE.md` 체인지로그를 함께 갱신한다. 코드가 진실의 원천이며, 인용 라인은 drift할 수 있으니 의심되면 원본 확인.
> **비-결정론 제외**: LLM(Gemini) 판단 항목(감성 분류, weekly 본문, 챌린지 분류)은 "산식"이 아니므로 규칙만 — §13 참조.
> **윤리 주의**: 모든 지표는 공개 외형 신호 기반. 위기 알림(논란/본체노출)은 인간 검증 필수(`v2-roadmap.md §7`).

---

## 목차

0. [공통 빌딩블록](#0-공통-빌딩블록)
1. [Health Score (건강 점수)](#1-health-score-건강-점수)
2. [SOV — Share of Voice (영향력 점유율)](#2-sov--share-of-voice)
3. [Member Popularity & Normalized HHI](#3-member-popularity--normalized-hhi)
4. [Combined Dual-Entity 모델](#4-combined-dual-entity-모델)
5. [Engagement / Velocity / Reactivity / Sentiment / agg_summary](#5-engagement--velocity--reactivity--sentiment--agg_summary)
6. [Debut Window Organicity (오가닉 채점)](#6-debut-window-organicity)
7. [Growth Trajectory (성장 궤적)](#7-growth-trajectory-성장-궤적)
8. [Fan Loyalty — 라이브 CCV 충성도](#8-fan-loyalty--라이브-ccv-충성도)
9. [Weekly Causal Diagnosis (가설 점등)](#9-weekly-causal-diagnosis-가설-점등)
10. [Challenge Scan (주간 바이럴 챌린지)](#10-challenge-scan)
11. [Relevance / News Filter 게이트](#11-relevance--news-filter-게이트)
12. [클라이언트 계산 (shortsTrend / alerts / shortsDiagnostic)](#12-클라이언트-계산)
13. [LLM 기반(비-결정론) 항목](#13-llm-기반-항목)

**부록**
- [§14. Live Activity — 찐팬 활동량 (P2a)](#14-live-activity--찐팬-활동량-p2a)
- [§15. Awareness Index — 인지도 지수 (P2b)](#15-awareness-index--인지도-지수-p2b)
- [§16. Organic Confidence — Organicity 신뢰 계수 (V2.53)](#16-organic-confidence--organicity-신뢰-계수-v253)

---

## 0. 공통 빌딩블록

여러 산식이 공유하는 원자 함수.

> 🟢 **쉽게**: 모든 점수가 쓰는 '계산 부품'들. 값을 0~1 점수로 바꾸거나, 또래와 비교하거나, 한가운데 값을 뽑는 도구.
> - **정규화(`_normalize`)**: 어떤 값을 *기준치 대비 0~1*로 환산. 기준 넘으면 만점(1), 0이면 0. (키를 "반에서 큰 편?" 0~1로 바꾸기)
> - **로그 정규화(`_normalize_log`)**: 값 차이가 너무 클 때(100 vs 100만) 로그로 눌러 공정 비교. 뉴스 건수처럼 격차 큰 데 씀.
> - **percentile / rank**: 줄 세웠을 때 몇 등쯤인지 0~1로.
> - **z-score(`cohort_z_score`)**: 또래(경쟁사) 평균에서 몇 칸(표준편차) 벗어났나. +면 평균 위, −면 아래.
> - **중앙값(`median`)**: 줄 세운 한가운데 값. 평균과 달리 튀는 값에 안 휘둘림.
> - **NULL vs 0**: 구독자 수는 '아직 못 가져옴'이면 빈칸(NULL)으로 두고 최근 값으로 메움. 댓글 0개는 진짜 0.

| 함수 | 정의 | 위치 |
|---|---|---|
| `_normalize(v, ref)` | `min(max(v/ref, 0), 1)`. v=None 또는 ref≤0 → 0 | `health_score.py:199` |
| `_normalize_log(v, ref)` | `min(log1p(v)/log1p(ref), 1)`. (네이버 뉴스 전용, 영/한 그룹명 비대칭 압축) | `health_score.py:210` |
| `_percentile(vals, p)` | 선형보간 percentile. 빈→0, 단일→그 값 | `health_score.py:230` |
| `_percentile_rank(vals)` | [0,1] 랭크, tie=평균. n=1→[1.0] | `market_share.py:49` |
| `cohort_z_score(v, cohort)` | `(v - mean)/stdev`. cohort<2 또는 stdev=0 → 0.0 | `weekly_diagnosis_signals.py:22` |
| `median(list)` | 정렬 후 중앙값. 짝수→두 중앙 평균. 빈 리스트→ValueError | `loyalty.py:43` |
| `_kst_day(iso)` | UTC ISO → `+9h` → `YYYY-MM-DD` (KST 달력일) | `growth_trajectory.py:35` |
| `formatKSTMonthDayWeekday(iso)` | UTC → KST `MM/DD 요일` (프런트, V2.47) | `datetime.ts` |

**NULL vs 0 정책** (`agg_summary.py:54-63`): `yt_views`/`yt_subscribers`는 stats row 없으면 **NULL**(0 아님) → API가 최신 non-null로 forward-fill. 반면 좋아요/댓글/영상수/커뮤니티/뉴스 카운트는 **0** 기본값(실제 "0건"이 정확한 신호). `music_show_wins`/`melon_top100_*`는 UPSERT 시 `COALESCE(excluded, 기존)`로 보존(별도 collector가 후속 UPDATE).

---

## 1. Health Score (건강 점수)

`health_score.py` · V2.5 4-Factor 모델 (`group_model`별 가중치 + 동적 ref + recency 보너스).

> 🟢 **쉽게**: 그룹이 전반적으로 얼마나 잘 나가는지 **0~10점 + S~D 등급**으로 요약한 종합 성적표. 4개 영역(도달·성과·동원·친밀도) 점수를 그룹 유형별 비중으로 합치고, 최근 영상 많으면 가산점, 논란 있으면 깎는다.

### 1.1 총점 & 등급

> 🟢 **쉽게**: 네 영역 점수 합 + 최근활동 보너스 → 10점 만점으로 환산 → 점수대로 S/A/B/C/D 등급. 데뷔 전 그룹은 아직 "PRE"(점수 없음). **정식 데뷔 미확정(잠정 앵커) 포함** — 선공개 싱글 등으로 `debut_date`는 있어도 정식 데뷔가 아직이면(V2.53) 마찬가지로 PRE.

**산식** (`compute_health_score`, `:634-744`):
1. **Pre-debut/미확정 게이트** (`:653`): `debut_date` 없음/미래(`_is_pre_debut`, `:189-196`) **또는** `debut_confirmed ∈ (0, False)` → `grade="PRE"`, `total=None`.
   - **`debut_confirmed` (V2.53)**: `groups.debut_confirmed` 컬럼(`migrations/0105_debut_confirmed.sql`, 기본값 1). `debut_date`는 있으나 정식 데뷔가 아직 미확정인 "잠정 앵커" 케이스를 잡는다(예: BTHD — `debut_date='2026-06-26'`은 선공개 싱글일이고 정식 데뷔는 10월 초 예정이라 mig 0105가 `debut_confirmed=0`으로 시딩). `None`/`1`/미전달(mig 0105 미적용 D1, `cli.py:1715-1725` SELECT가 예외 시 컬럼 없이 폴백) → 확정 취급(하위 호환). 호출부 `cli.py:1678`: `debut_confirmed=g.get("debut_confirmed", 1)`.
   - **소비처는 이 게이트뿐** — `debut_date` 자체는 organicity 윈도우 버킷(§6.8)·Debut Window 표시·인지도(§15, 데뷔 전도 포함)에서 그대로 쓰이고 `debut_confirmed`의 영향을 받지 않는다.
2. **effective live 메트릭** `L` (`:670`): 코호트 live ∩ 이 그룹 live (죽은 신호 제거).
3. **가중치 선택** (`:671-672`): `FACTOR_WEIGHTS[group_model]` (없으면 corporate).
4. **risk_factor** = `_controversy_factor(controversy_count)` (`:705`).
5. **팩터 점수** (`:707-710`): `factor_scores[name] = round(factor_input[name] * weight[name] * risk_factor, 2)` — risk가 4개 팩터 전부에 곱해짐.
6. **factor_base** = Σ factor_scores (`:711`).
7. **bonus** = `_recent_bonus(v90, v30)` (최대 10) (`:713-715`).
8. **total** (`:717-718`): `round((factor_base + bonus) / FACTOR_DENOM * 10.0, 1)`, **`FACTOR_DENOM = 110`** (100 + bonus_max 10).
9. **grade** (`:723`): `GRADE_THRESHOLDS`에서 `total >= thr` 첫 등급.

**출력**: total 0.0–10.0, grade ∈ {S,A,B,C,D,PRE}.

**상수**:
- `GRADE_THRESHOLDS` (`:105`): `(9.0,S)(7.0,A)(5.0,B)(3.0,C)(0.0,D)`.
- `FACTOR_BONUS_MAX=10`, `FACTOR_DENOM=110`, `DYNAMIC_REF_PERCENTILE=0.75`.

### 1.2 group_model별 4-Factor 가중치 (`FACTOR_WEIGHTS`, `:121-140`, 각 행 합=100)

> 🟢 **쉽게**: 그룹 유형마다 '중요한 것'이 다르다. 회사형(PLAVE)은 차트 성과·팬 동원을 크게, 버튜버 연합형(STELLIVE)은 팬과의 친밀도를 가장 크게 본다.

| group_model | Reach | RitualVictory | Mobilization | Intimacy |
|---|---|---|---|---|
| **corporate** (PLAVE형, 기본) | 25 | 30 | 30 | 15 |
| **segmentary** (ISEDOL형) | 20 | 15 | 25 | 40 |
| **confederation** (STELLIVE형) | 15 | 10 | 20 | 55 |

### 1.3 팩터 입력값 (`_factor_inputs`, `:462-601`) — 각 0–1, `_wmean` 가중평균(dead 신호 재정규화)

> 🟢 **쉽게**: 네 영역이 각각 뭘 보는지 —
> - **Reach(도달)**: 얼마나 많은 사람에게 닿나 (구독자·조회수·뉴스).
> - **RitualVictory(성과)**: "이겼다"는 증거 (음반 판매·음방 1위·차트 순위).
> - **Mobilization(동원)**: 팬을 실제로 움직이게 하나 (조회수·꾸준한 업로드·음반 구매).
> - **Intimacy(친밀도)**: 팬과 얼마나 끈끈한가 (댓글 참여·커뮤 글·라이브 충성도). 부정 여론 있으면 깎임.

**Reach (도달)** (`:569`):
`wmean[(sub_n,0.55,live), (view_n,0.40,live), (news_n,0.05,live)]`
- `sub_n=_normalize(subscribers, ref)`, `view_n=_normalize(views, ref)`, `news_n=_normalize_log(news, ref)`.

**RitualVictory (의례적 승리)** (`:604-616`, `redistribute=False` 기본 — dead 신호가 분모에 남아 실제 하락):
`wmean[(hanteo_n,0.50), (news_n,0.10), (music_show_n,0.20), (chart_peak_n,0.10), (chart_depth_n,0.10)]`
- `hanteo_n=min(hanteo_sales/1_000_000, 1)` (100만장 saturate).
- `music_show_n=_normalize(wins, ref=5.0)`.
- `chart_peak_n`: peak∈[1,100] → `(101-peak)/100` (1위=1.0), 아니면 0.
- `chart_depth_n`: `min(depth/depth_ref, 1)`, `depth_ref=ref or 5.0`.
- **`music_show_wins` 예외 (P1, `:595-616`)**: 코호트 전체 dead(stub collector로 전원 0) → `music_show` part를 리스트에서 제거해 0.20 weight 재분배(페널티 0). 코호트 live인데 이 그룹만 0승이면 part 유지(genuine penalty). 나머지(hanteo/news/chart_peak/chart_depth)는 `redistribute=False` 유지.

**Mobilization (동원)** (`:592`):
`wmean[(view_n,0.40), (cadence_n,0.25,항상live), (hanteo_n,0.25), (sub_n,0.10)]`
- `cadence_n=min(v90_count/30, 1)` (90일 30영상 saturate).

**Intimacy (친밀도)** (`:546-561`): `intimacy_compression = max(0, 1 - negative_ratio)`를 곱함.
- **loyalty_score 있을 때 (V2.46, 3신호)**: `wmean[(eng_n,0.40), (comm_n,0.30), (loyalty_n,0.30,항상live)] * compression`, `loyalty_n=clamp(loyalty_score/100, 0, 1)`.
- **없을 때 (2신호)**: `wmean[(eng_n,0.55), (comm_n,0.45)] * compression` → 재정규화로 라이브 안 한 그룹 점수 불변(페널티 0).
- `eng_n=_normalize(engagement_rate, ref)`, `comm_n=_normalize(dc+theqoo+instiz posts, ref)`.

### 1.4 Engagement Rate (참여율)
> 🟢 **쉽게**: 조회수 대비 좋아요+댓글이 얼마나 달리나. 댓글은 좋아요보다 '진짜 관심'이라 **5배**로 쳐준다.

**산식** (`engagement_rate`, `:425`): `(likes + 5*comments) / views`. **`COMMENT_WEIGHT=5`** (댓글이 좋아요보다 5배 의도 신호). views≤0 → 0.0.

### 1.5 Recent Bonus (`_recent_bonus`, `:455`)
> 🟢 **쉽게**: 최근(90일/30일) 영상 많이 올렸으면 가산점(최대 10). 부지런하면 +.

`min(v90/30, 1)*7 + min(v30/10, 1)*3` → 0–10 가산 overlay (group_model 무관).

### 1.6 Controversy Factor (`_controversy_factor`, `health_score.py:466-482`)
> 🟢 **쉽게**: 논란이 전체 점수에 곱하는 '깎임 배수'. V2.55부터는 **글 건수가 아니라 이슈 심각도**로 깎는다 — 같은 사건을 두고 글이 10개 올라와도 이슈는 1개면 감점은 1개분. 어느 경로든 최대 −40%(배수 0.6)까지만 깎이고 그 밑으론 안 내려간다.

**V2.55 이슈 가중 기반(우선 경로)** — `controversy_weight`(effective_weight)가 주어지면: `max(0.6, 1 - effective_weight/10)` (`CONTROVERSY_FACTOR_FLOOR = 0.6`, `health_score.py:463`).
- `effective_weight` = 그룹의 클러스터링된 이슈들의 `Σ SEVERITY_WEIGHTS` — `SEVERITY_WEIGHTS = {low: 1, medium: 2, high: 3}` (`controversy_issues.py:39`).
- 예: high 이슈 1건(weight 3) → factor `1 - 3/10 = 0.7`. medium 2건(weight 4) → `1 - 4/10 = 0.6`(이미 플로어). weight ≥ 4부터는 이슈가 더 쌓여도 0.6에 고정.

**폴백(count 기반, weight 신호 없을 때)** — `controversy_issues` 테이블 미적용/그룹 행 없음/`computed_at`이 stale이면 count로 폴백: `max(0.6, 1 - max(0, count - CONTROVERSY_NOISE_FLOOR) / 10)`, `CONTROVERSY_NOISE_FLOOR = 2`(`health_score.py:457`). count 0/1/2 → 1.0(무감점), count 3 → 0.9, count 6 이상 → 0.6에서 고정(`(6-2)/10=0.4` → `1-0.4=0.6`이 플로어와 같아지는 지점).
- **V2.54 대비 변경점**: V2.54는 하한이 0이라 count 12+에서 factor가 0(전 팩터 전멸)까지 갔다. V2.55는 폴백 경로에도 0.6 플로어가 적용돼 **count가 아무리 커도 0에 도달할 수 없다** — count≥6부터는 사실상 0.6 고정.

**신호 소스** (§1.6.1 참조): `controversy_issues` 테이블(`migrations/0108_controversy_issues.sql`, `group_key` PK, 그룹당 최신 1행) — `analyze-weekly` 4.5단계(`cli.py:1488-1511`)가 감성 분류 직후 채운다. `_recompute_health_scores`(`cli.py:1665-1684`)가 이 테이블을 조회해 `is_stale(computed_at, max_age_days=STALE_DAYS=8)`(`controversy_issues.py:35, 149`)로 8일 초과 행을 걸러내고 살아있는 행만 `controversy_weight_by_key`에 담아 `compute_health_score(..., controversy_weight=...)`(`cli.py:1725`)로 넘긴다. 테이블 미적용/조회 실패는 통째로 try/except 폴백(`cli.py:1682-1684`).
- **순서 주의(다음 런 수렴)**: `analyze_weekly` 안에서 Health Score 재계산(`cli.py:1411`, "2.5.")이 controversy 클러스터링(`cli.py:1488`, "4.5.")보다 **먼저** 실행된다. 즉 같은 런에서 갓 계산된 `effective_weight`는 그 런의 Health Score에 반영되지 않고, 다음 `analyze_weekly` 또는 다음 일간 `aggregate`(둘 다 `_recompute_health_scores` 호출)에서 읽혀 수렴한다.
- **배경**: PLAVE 2026-08-15 — 디시 잡담 글 2건("슬리퍼놀란"=놀란→논란 오독, "부동산 이슈 괜찮음?"='이슈' 마커 오분류)만으로 `controversy_count=2` → 구 산식(`1 - count/10`)에서 factor 0.8 → 전 팩터 −20% → 등급 A(7.7)→B(6.3)로 밀림(V2.54 노이즈 플로어 도입 배경). V2.55는 그 위에 "이슈 심각도가 아니라 커뮤니티 볼륨(글 N건)에 비례해 깎이던" 구조 결함(ISEDOL 실증 — controversy_count 8건 → factor 0.4 → 등급 붕괴)을 교정한다.
- **분류 엄격화** (`sentiment.py:65-84`의 `PROMPT_SENTIMENT`): controversy 버킷 정의를 "논란/이슈/의혹 등 마커 단어"에서 "제목이 구체적 사건·의혹을 명시(학폭/표절/사생활 폭로/계약 분쟁/법적 문제/기술 유출/운영 사고 등)"로 강화. Rules에 마커 단어만으로는 불충분(NOT sufficient)함과, 사건을 특정하지 않는 잡담("부동산 이슈 괜찮음?")·유사 형태 오독(놀란≠논란) 배제 규칙을 명문화. 기존 분류 데이터는 재분류하지 않음(14일 윈도우로 자연 소멸 + 플로어가 즉시 상쇄) — 신규 분류부터 적용.

### 1.6.1 Controversy Issue Clustering (`controversy_issues.py`, V2.55)
> 🟢 **쉽게**: 논란 글 여러 개를 AI가 읽고 "이거 같은 사건이네"로 묶어주는 전처리 단계. 묶은 이슈 단위로만 심각도를 매기니까 같은 사건 재탕 글이 감점을 여러 번 먹지 않는다.

`analyze_weekly` 4.5단계(`cli.py:1488-1511`)에서 활성 그룹마다 `build_for_group`(`controversy_issues.py:170`)을 호출한다.

1. **입력**: 그룹별 최근 `WINDOW_DAYS=14`일(`:30`) `community_posts` 중 `sentiment='controversy'`, 최대 `LIMIT_PER_GROUP=200`건(`:31`), title만(`:187-194`).
2. **글 0건** → 기존 `controversy_issues` 행을 `DELETE`(`:195-200`) — 신호 소멸을 즉시 반영, health가 옛 weight를 계속 깎지 않게 함.
3. **Gemini 호출은 그룹당 1회**(`_call_gemini`, `:225-239`) — 그룹의 전체 controversy 글 목록을 한 번에 넣어 `ISSUE_SCHEMA`(`:42-65`) 구조화 출력으로 이슈 리스트를 받는다.
4. **이슈 = 같은 실제 사건 단위**: 프롬프트(`PROMPT_CONTROVERSY`, `:67-92`)가 "같은 사건/의혹/분쟁을 다루는 제목은 표현이 달라도 한 이슈로, 무관한 사건은 별개 이슈로" 클러스터링을 지시. 이슈마다 `label`(한 줄 요약)·`severity`(high/medium/low)·`post_hashes`(소속 글).
5. **잡담 제외(2차 노이즈 필터)**: 프롬프트 Rules(`:86-91`) — 구체적 실제 사건을 가리키지 않는 잡담/밈/막연한 질문은 어느 이슈에도 넣지 말고 통째로 제외. `sentiment.py`의 1차 controversy 분류 위에 얹는 2차 필터. severity 모호 시 낮은 tier 선택 규칙도 포함.
6. **응답 검증** (`parse_issues`, `:111-141`): severity가 `SEVERITY_WEIGHTS` 밖이거나 `post_hashes`/`label`이 비면 해당 항목을 버림(유령 이슈 방어).
7. **effective_weight 합산** (`effective_weight`, `:144-146`): `Σ SEVERITY_WEIGHTS[severity]` — `low=1, medium=2, high=3`(`:39`).
8. **저장**: `controversy_issues`(`migrations/0108_controversy_issues.sql`, `group_key` PK) UPSERT — 그룹당 최신 1행만(히스토리 없음), `computed_at`/`issue_count`/`effective_weight`/`issues_json`(`:211-222`).
9. **가드**: Gemini 예외 시 빈 리스트 반환 → 기존 행 유지 + warning 로그, 그룹 스킵하고 나머지는 계속(`:202-207`). 클러스터링 단계 전체도 `cli.py`에서 try/except로 감싸 `analyze_weekly`를 죽이지 않음(`:1494-1511`).
10. **stale 판정**: `is_stale(computed_at, max_age_days=STALE_DAYS=8)`(`:35, 149-164`) — 파싱 실패/None도 stale 취급(안전측). Health 쪽 소비는 §1.6 참조.

### 1.7 동적 REF (코호트 percentile)
> 🟢 **쉽게**: 만점 기준을 고정하지 않고 '경쟁사들 중 상위 25% 수준'을 매번 기준으로 잡는다. 1.0 = 상위권. (반 평균이 바뀌면 'A 받는 점수'도 바뀌는 셈)

`ref[dim] = max(_percentile(cohort_vals, 0.75), MIN_REFS[dim])` (`:373`). 1.0 = 코호트 p75 수준.
- `MIN_REFS` (`:97`): subscribers=50K, views=1M, quality=0.005, community=1K, news=10.
- `music_show_wins` ref=5.0 고정 (sparse).
- 바닥값 가드로 1-그룹 코호트/전부-0 컬럼의 분모 붕괴 방지.

---

## 2. SOV — Share of Voice

`market_share.py` · 코호트의 측정된 크로스플랫폼 관심 점유율(실제 시장점유 아님). **percentile-rank 단위**(z-score는 `weekly_diagnosis`의 `market_share_z`에만 존재, 이 지표와 무관).

> 🟢 **쉽게**: 경쟁사들 사이에서 우리가 **'관심을 몇 % 차지'**하나. 신호 4종(조회·커뮤·뉴스·구독) 신호를 등수로 바꿔 합치고, 누적 60% + 최근 모멘텀 40%로 섞는다. 코호트 전체를 더하면 100%(누가 오르면 누구는 내림). *Twitter는 수집 종료로 완전 제거(P2c).*

**산식** (`_compute_sov`, `:150-196`):
1. 누적 신호 4종 각 `_percentile_rank`: yt_views, community, news, subscribers. (Twitter 제거 — 수집 영구 종료)
2. 모멘텀: yt_views/community/news는 `max(delta,0)`, subscribers만 미사용(0).
3. 그룹별 합성: `score = Σ SOV_WEIGHTS[k] * rank[k]`.
4. 0–100 정규화(코호트 합=100, zero-sum): `cum_pct = cum_score/cum_total*100`.
5. **`final = cum_pct*0.6 + mom_pct*0.4`** (`ALPHA_CUM=0.6`, `BETA_MOM=0.4`).

**`SOV_WEIGHTS`** (`:47-52`, 합=1.0, assert): yt_views=0.33, community=0.28, news=0.22, subscribers=0.17.

**출력**: cum/mom/final 각 0–100% (소수 2자리).
**가드**: 분모≤0 → pct=0. legacy 입력(신호 없음)은 raw-sum 정규화 fallback. 음수 델타 `max(.,0)` 클램프.

---

## 3. Member Popularity & Normalized HHI

`member_popularity.py` · 그룹 내 인기 집중도(그룹 크기 무관 비교).

> 🟢 **쉽게**: 그룹 인기가 **한 멤버에게 쏠렸나, 고르게 퍼졌나**. evenness 0 = 한 명 독식, 1 = 완전 균등. 멤버 수가 달라도 공정 비교되게 보정. (top1/top3 = 1·3등이 차지하는 비중)

- **멤버 composite** (`:61`): `yt_score*0.5 + community_score*0.5`.
- **share %** (`:80`): `composite_i / total * 100`.
- **raw HHI** (`:81`): `Σ(share_pct²) / 10000` (범위 [1/N, 1]).
- **normalized HHI** (n>1, `:86`): `floor=1/n`; `hhi_norm = max((hhi-floor)/(1-floor), 0)`; **`evenness = 1 - hhi_norm`**.
- **Pareto** (`:95`): `top1 = max_share/100`, `top3 = sum(top3_shares)/100`.

**출력**: hhi_norm/evenness ∈ [0,1] (0=완전 균등, 1=완전 독점).
**가드**: total=0 또는 n=0 → insufficient(None). 단일 멤버(n=1) → hhi_norm=None.

---

## 4. Combined Dual-Entity 모델

`group_combined.py` · 그룹당 3가지 합산 뷰. **`MEMBER_WEIGHT=0.7`** (멤버 솔로채널 할인, collab 중복계산 완화).

> 🟢 **쉽게**: 구독자/조회수를 **세 가지로** 보여준다 — ① 회사 채널만 ② 멤버 솔로채널까지 다 합산 ③ 멤버는 0.7배만 합산(콜라보 중복 부풀리기 완화). 그룹 유형 따라 어느 뷰가 맞는지 다름.

채널별 최신 stats 집계 후 (`:125`):
- **group_only**: 그룹 채널값만.
- **sum**: `group + member_sum` (subs/views/videos).
- **weighted**: `group + int(member_sum * 0.7)`.

**가드**: 채널 stats 없으면 0. `or 0`으로 NULL 방어. (group, snapshot, method)당 1행 멱등 upsert.

---

## 5. Engagement / Velocity / Reactivity / Sentiment / agg_summary

### 5.1 agg_summary 집계 컬럼 (`agg_summary.py`)
대부분 카운트/합계 (산식 아님), `(group_key, snapshot_at)` 멱등 UPSERT.

> 🟢 **쉽게**: 매일 원천 데이터를 그룹별로 더하고 세는 '기본 집계'(조회수·좋아요·게시글 수 등). 영상별 최신 스냅샷만 합쳐 중복 합산을 막고, 멤버 솔로채널은 합산(SUM)해 연합형 그룹의 실제 규모를 반영.

| 컬럼 | 산식 | 위치 |
|---|---|---|
| `yt_total_videos` | `COUNT(DISTINCT video_id)` | `:132` |
| `yt_likes_total`/`yt_comments_total` | `SUM(likes/comments)` — **영상별 최신 스냅샷만** JOIN(중복합산 방지) | `:133-139` |
| `yt_subscribers`/`yt_total_views` | distinct 채널별 최신 스냅샷 **SUM**(MAX 아님 — segmentary 멤버채널 합산용). 채널 stats 전무→NULL | `:152-173` |
| `dc_total_posts`/`theqoo_posts`/`instiz_posts` | `COUNT(*)` per platform — **누적 단조증가** | `:66-77` |
| `naver_total_news` | `COUNT(*) WHERE is_excluded=0` | `:80` |
| `controversy_count` | `COUNT(*)` FROM `community_posts` WHERE `sentiment='controversy'` AND `posted_at >= now - CONTROVERSY_WINDOW_DAYS(=14)` — 트레일링 **14일 윈도(누적 아님)**. 누적 시 `_controversy_factor → 0` 고착 방지 | `agg_summary.py:106-115` |

### 5.2 24h Video Velocity (`viral_velocity_ratio`)
`video_velocity.py` · 신규 영상 첫 24h 조회수가 같은 채널 평균 대비 몇 배.

> 🟢 **쉽게**: 새 영상이 첫 24시간에 **그 채널 평소보다 몇 배** 봤나. 5배↑면 컴백 대박 신호. (자기 자신은 평균에서 빼고 비교)

- **Pass 1** (`:53-101`): `published_at+24h` 마크를 bracket하는 전·후 스냅샷(각 `±WINDOW_HOURS=18h` 내)을 시간가중 **선형보간**(`_interpolate_v24`) → `view_count_24h`. 한쪽만 존재 시 그 raw값 폴백(`interpolated=False`, 저신뢰). 보간 성공 여부는 `view_count_24h_interpolated` 컬럼(1=보간/0=폴백/NULL=미산정, migration 0098).
- **Pass 2** (`:85`): 채널별 누적, **n<2 채널 skip**, **leave-one-out 평균** `adjusted_mean=(Σ-v24)/(n-1)` (self-bias 방지), `ratio = round(v24/adjusted_mean, 3)`.
- **해석**: >5 viral · 2–5 strong · 1–2 solid · <1 underperform.
- **가드**: 30일 윈도 밖/근접row 없음/n<2/adjusted_mean≤0 → skip.

### 5.3 Platform Reactivity (`reactivity_dc/theqoo/instiz/naver`)
`platform_reactivity.py` · 바이럴 영상 발행 ±24h 동안 플랫폼 게시량 `after/before`.

> 🟢 **쉽게**: 영상이 터지면 커뮤니티 글이 **평소보다 늘어나나**(발행 전 24h vs 후 24h). 2배↑면 팬덤이 그 플랫폼에서 강하게 반응한다는 뜻. 1 근처면 영상과 무관하게 굴러감.

- **상수**: `VIRAL_THRESHOLD=2.0`(샘플 영상 컷, **debut_window 1.5와 의도적 상이**), `WINDOW_DAYS=30`, `WINDOW_HOURS=24`.
- **산식** (`:47`): viral 영상별 before=`[pivot-24h, pivot)`, after=`[pivot, pivot+24h)` 카운트 → `_ratio`:
  - both 0 → None(평균 제외). before=0(after>0) → `min(5, after/1)`. else `min(after/before, 5.0)`.
- 플랫폼별 평균(`round(.,3)`, 기본 1.0, **상한 5.0**). `reactivity_sample = viral 영상 수`.
- **해석**: >2 strong reactive · 1.5–2 reactive · ~1 independent · <0.7 declining.
- 바이럴 영상 0개 → 전부 1.0, sample=0.

### 5.4 Sentiment & negative_ratio
> 🟢 **쉽게**: 커뮤니티 글의 분위기를 AI가 긍정/부정/논란/중립으로 분류. **negative_ratio** = 분류된 글 중 (부정+논란) 비율 — 분모는 '분류된 글'만(전체 글 아님).

- **분류**: **LLM(Gemini) 기반** (규칙 아님) — title만 입력, 4-클래스 {positive, negative, controversy, neutral}. 배치 `LIMIT_PER_GROUP=200`, `BATCH=50`. (§13 참조)
- **negative_ratio** (`sentiment.py:155`, 결정론): `(negative+controversy) / 분류된_글수`, `round(.,4)`. **분모는 분류된 글만**(전체 아님). classified≤0 → 0 유지.

---

## 6. Debut Window Organicity

`debut_window.py` + `frontend/src/lib/organicity.ts` + `debutWindow.ts` + `functions/lib/debutWindowBuckets.ts` · 데뷔 영상의 오가닉(진짜) vs paid 채점. **규모와 직교한 진정성 신호**. Shorts/Long-form 경로가 다름.

> 🟢 **쉽게**: 데뷔 영상이 **'진짜 인기'인지 '돈 써서 띄운 건지'**를 0~100점으로. 조회수 규모와 무관하게, 좋아요·댓글 패턴이 자연스러운지(진정성)만 본다. 초록(진짜) ↔ 빨강(유료의심) 5단계. *주의: '진짜'라고 '인기/충분'은 아님 — 규모는 별개.*

### 6.1 상수 전표

| 상수 | 값 | 위치 |
|---|---|---|
| `LONG_ER_FLOOR / CEIL` | `0.010 / 0.060` | `:63` |
| `SHORT_ER_FLOOR / CEIL` | `0.005 / 0.090` | `:71` |
| `BALANCE_NORMAL_LONG` (lo,hi) | `10.0, 50.0` | `:79` |
| `BALANCE_NORMAL_SHORT` (lo,hi) | `15.0, 78.0` | `:80` |
| Long penalty/unit (low,high) | `8.0, 0.5` | `:81-82` |
| Short penalty/unit (low,high) | `5.0, 0.4` | `:83-84` |
| `BALANCE_MIN_COMMENTS_SHORT` | `10` | `:95` |
| `BALANCE_LOW_VIEW_CEIL_SHORT` | `50_000` | `:96` |
| `VIRAL_VELOCITY_THRESHOLD` | `1.5` | `:105` |
| `VIRAL_ER_REAL / WEAK` | `0.03 / 0.015` | `:106-107` |
| Long weights (velocity 有) | eng `0.5` / bal `0.3` / vel `0.2` | `:112` |
| Long weights (velocity NULL) | eng `0.625` / bal `0.375` | `:113` |
| **Short weights** | eng `0.4` / bal `0.6` | `:125` |

### 6.2 Engagement sub-score (`_compute_engagement_score`, `:149`)
> 🟢 **쉽게**: 반응의 **세기** — 조회수 대비 좋아요+댓글이 얼마나 달리나. 바닥~천장 사이를 0~100점으로. (Shorts는 피드 특성상 바닥을 낮게 잡음)

`er = (likes+comments)/max(views,1)`; `floor,ceil = (0.005,0.090) if short else (0.010,0.060)`;
`e_score = clamp(round((er-floor)/(ceil-floor)*100), 0, 100)`.
> ⚠️ **ER 정의 3종 (의도적 상이, 통일 금지)**: organicity ER = **무가중** `(likes+comments)/views` (이 §, calibration이 이 정의 기준) / Health·진단 ER = **댓글 ×5 가중** `(likes+5·comments)/views` (§1.4, COMMENT_WEIGHT=5) / shortsDiagnostic avg_er = `(likes+comments)/views×100`. 같은 "ER"여도 패널 간 수치가 다름 — 비교 시 주의.

### 6.3 Balance sub-score (`_compute_balance_score`, `:160`) — 진정성(organic vs farm)
> 🟢 **쉽게**: 좋아요와 댓글 **비율이 자연스러운가** = 조작 여부 신호. 정상 구간 벗어나 한쪽으로 쏠리면(댓글만 많음=댓글농장 / 좋아요만 많음=좋아요농장) 감점. Shorts는 댓글이 너무 적으면(노이즈) 판단 보류.

`r = likes/max(comments,1)`. SHORT `lo,hi=15,78; low_slope=5, high_slope=0.4` / LONG `lo,hi=10,50; low_slope=8, high_slope=0.5`.
- `lo≤r≤hi` → 100. `r<lo` → `max(0, 100-(lo-r)*low_slope)` (comment-farm). `r>hi` → `max(0, 100-(r-hi)*high_slope)` (like-farm).
- **Shorts 댓글 가드** (`balance_basis`, `:291`): `comment==0` → b=100(`zero_comment`); `comment<10 AND view<50K` → b=100(`insufficient_comments`). 고조회(≥50K)+소댓글은 farm 탐지 유지.

### 6.4 Velocity coherence (`_compute_velocity_coherence`, `:179`) — **Long-form 전용**
> 🟢 **쉽게**: 급상승했는데 **반응이 따라오나**(롱폼만). 빠르게 떴는데 좋아요·댓글이 없으면 = 돈으로 조회수만 산 'paid burst' 의심. (Shorts는 분모 왜곡이 심해 이 신호 안 씀)

`velocity<1.5 → 50`(중립); `er≥0.03 → 100`(real); `er≥0.015 → 60`(weak); else `20`(paid burst). velocity=None → None(가중치 재분배). **Shorts는 v_score=None 강제**(`:321`, 분모 아티팩트 제거).

### 6.5 Composite (`compute_organic_score`, `:269`)
> 🟢 **쉽게**: 위 세기·진정성·(롱폼)일관성 점수를 가중합한 **종합 0~100**. Shorts는 진정성(균형)을 더 무겁게(6:4) 본다. 조회·반응이 거의 없으면 채점 보류(insufficient).

- **base 게이트**: `view<1000 AND eng_total<10` → `None`(`insufficient_data`).
- **Shorts** (`:316`): `round(0.4*e + 0.6*b)` (balance 우위).
- **Long, velocity 有** (`:337`): `round(0.5*e + 0.3*b + 0.2*v)`.
- **Long, velocity NULL**: `round(0.625*e + 0.375*b)`.

### 6.6 Verdict (`_classify_verdict`, `:202`; 프런트 `organicity.ts:16` 미러)
> 🟢 **쉽게**: 종합 점수를 5단계 판정으로 — 진짜강함 / 진짜 / 애매 / 의심 / 유료의심.

`≥85 organic_strong · ≥70 organic · ≥55 borderline · ≥40 suspect · <40 likely_paid`. (null/insufficient → 회색 neutral)

### 6.7 Cause 태그 (`_compute_causes`, `:226`)
> 🟢 **쉽게**: 왜 의심받는지 자동 꼬리표 — 반응약함 / 댓글농장 / 좋아요농장 / 유료버스트 / (반대로) 진짜바이럴.

`v==100→viral_real`(verdict 무관). verdict이 borderline 이하일 때: `e<40→engagement_weak`; `b<60`이면 r<lo→`comment_farm` / r>hi→`like_farm`; `v≤20→paid_burst`.

### 6.8 윈도우 버킷 (`WINDOW_BUCKETS` + 산술, `:45`; V2.49 롤링 윈도우)
> 🟢 **쉽게**: 영상을 **데뷔일 기준 20일 단위 시기**로 묶음. 데뷔 후에는 D+80, D+100… 새 시기가 계속 생기고, 화면은 그중 "지금(MiiWAN 기준)까지의 최근 7칸"만 보여줌 — 시간이 가면 오래된 칸이 한 칸씩 밀려남. 데뷔일 없는 그룹은 'Undated'로 점수만.

고정 5개: `Pre(≤-71) · D-60(-70~-51) · D-40(-50~-31) · D-20(-30~-11) · D-Day(-10~+9)` + **산술 무한** `d≥10 → D+20k (k=(d-10)//20+1)` — D+20(10~29) · D+40(30~49) · D+60(50~69) · D+80(70~89) · … (Post catch-all 은 V2.49 에서 폐기, migration 0085 재배치). `days_relative = (published_date - debut_date).days`.
- **Undated** (V2.42, `UNDATED_BUCKET`): `debut_date` 없는 그룹은 점수만 산정(산식은 데뷔일 미사용) → `"Undated"` 버킷.
- **표시 창** (V2.49, `debutWindowBuckets.ts displayBuckets`): MiiWAN 데뷔 경과일(KST)이 속한 버킷을 오른쪽 끝으로 한 연속 7버킷, 오른쪽 끝 최소 D+60 (데뷔 전~D+69 는 종전 D-60~D+60 고정 창과 동일, D+70 에 첫 슬라이드). summary API 가 `window.buckets`/`current_bucket` 메타로 내려주고 프런트 3 컴포넌트가 렌더 (fallback = `DEFAULT_DISPLAY_BUCKETS`). Pre/Undated 탭 비노출(Undated 는 KPI 배지).
- worker↔functions 경계 동일성: `debutWindowBuckets.test.ts` BOUNDARY_FIXTURE ↔ `test_debut_window.py` parametrize 가 양쪽 핀.

### 6.9 요약 집계 (`build_summary`, `:539`)
> 🟢 **쉽게**: 시기(버킷)별 평균 오가닉 점수. 기본은 **'영상 한 개씩 평균(simple)'** — 고조회 영상 1개가 평균을 좌우하지 못하게(view-weighted는 토글로). 채점 보류 영상은 평균에서 제외.

(group, bucket)별: `organic_score_mean`(view-weighted, scored만), `organic_score_mean_simple`(count 기반 simple), long/short 별도 mean, 5종 verdict 비율(분모=scored 수), total_views/engagement(insufficient 포함).
- **헤드라인 렌즈** (V2.40, `organicity.ts:53`): `DEFAULT_ORGANICITY_MODE="all_simple"` → 실제 표시는 V2.50 의 `organic_score_mean_shrunk`(simple mean 의 thin-sample 수축, pre-0092 행은 simple 로 폴백). 고조회 아웃라이어 1개가 버킷 지배하는 것 방지. view-weighted는 toggle.
- **thin-sample 수축** (V2.50): `scored_video_count`(scored 표본 수) 저장 + `organic_score_mean_shrunk = (n·simple + k·55)/(n+k)`, k=3, prior=55. scored 1~2개 버킷이 자신만만한 organic_strong 을 못 내게 중립으로 당김 — 볼륨 늘면 자동 소멸(n≫k → raw). raw mean 은 보존. `scored < 3` 은 프런트 `*` 배지. organicity 는 진정성 축이라 성장/볼륨 판정은 성장 탭 소관.
- `insufficient_data`는 video_count/total엔 포함, mean·비율 분모엔 제외. 요약은 full DELETE 후 재집계.

---

## 7. Growth Trajectory (성장 궤적)

`growth_trajectory.py` · V2.43~. 모든 그룹 자기-과거-대비 4 기둥(누적은 weekly flow로 차분, KST 일별 리샘플).

> 🟢 **쉽게**: 각 그룹이 **'자기 과거보다 성장 중인지'**를 4개 기둥으로 본다 — 새 팬 유입(reach)·반응 진정성(engagement)·커뮤 활기(community)·여론(sentiment). 각 기둥이 오르나/유지/둔화인지 + 가속/감속인지 묶어 한마디(posture)로.

### 7.1 핵심 함수
> 🟢 **쉽게**: 추세를 재는 도구들 — 기울기(상승 속도), 가속도(빨라지나 느려지나), 주간 증분(누적값을 '이번 주 늘어난 양'으로 차분), 증분 ER(새로 늘어난 조회에 반응이 따라오나).

| 함수 | 산식 | 위치 |
|---|---|---|
| `resample_daily` | 같은 KST일 다중 스냅샷 → 최신 1개 | `:46` |
| `_ols_slope(ys)` | OLS per-step 기울기. n<2 또는 den=0 → 0 | `:55` |
| `relative_slope(values, 28)` | `_ols_slope(window) * 7 / |mean|`. <2점 또는 mean=0 → None | `:68` |
| `weekly_flow(levels, 7)` | `levels[i]-levels[i-7]` (누적→주간 증분). ≤7점 → [] | `:82` |
| `acceleration(series, 14)` | `mean(최근14) - mean(직전14)` | `:93` |
| `incremental_er(daily, 7)` | `Δ(likes+comments)/Δviews`. Δviews<1000 또는 er>0.30 → None | `:128` |
| `community_activity_series` | 각 일자의 trailing **7일 게시량**(누적 아님, posted_at 기반) | `:172` |
| `_change_4w(series, relative)` | 28일 전 대비 (level=상대%, ratio=절대델타) | `:194` |
| `_compare_direction(prev, recent, invert)` | prev 7d→recent 7d %변화 분류(실사용 경로) | `:212` |

### 7.2 분류 상수
> 🟢 **쉽게**: '얼마나 변해야 상승/둔화로 칠지' 문턱값들 + 데이터 품질 가드(구독자가 반올림돼 멈춰 보이거나, 커뮤 글이 너무 적으면 섣불리 판단 안 함).

- `CLIMB_THRESHOLD=0.05` (`classify_direction` %/주 경계), `COMPARE_THRESHOLD=0.10` (`_compare_direction` 7d 비교, 실제 pillar 사용).
- `ACCEL_DEADBAND_FRAC=0.02` (`|accel| < |mean|*2%` → flat).
- **calibration 가드** (V2.43.3~4): `REACH_NOISE_FLOOR=0.02`(reach 4주변동<2% → plateau/flat 강제, 구독자 양자화 방어), `MIN_COMMUNITY_VOLUME=5`, `MIN_COMMUNITY_ACTIVE_DAYS=14`(미만 → community direction=unknown).

### 7.3 4 기둥 (`compute_pillars`, `:313`)
> 🟢 **쉽게**: ① **reach** 새 팬 유입(구독자 4주 변화, 멈춰 보이면 조회수 속도로 대체) ② **engagement** 새로 늘어난 조회에 반응이 비례하나 ③ **community** 최근 7일 글이 늘었나 ④ **sentiment** 부정 여론이 줄면 '건강 호전'으로(뒤집어 해석).

1. **reach (도달 성장)**: `subs_change=_change_4w(subs, rel)`. **|change|<0.02 또는 None → 조회수 velocity로 fallback**(`source="views"`), 아니면 구독자(`source="subscribers"`, noise_floor 적용).
2. **engagement (호응 품질)**: `incremental_er` prefix series → `_pillar_from_values`.
3. **community (커뮤니티 모멘텀)**: trailing 7일 게시량 series. 침묵/onset 가드 → unknown.
4. **sentiment (여론)**: `negative_ratio` series, **invert=True**(하락=climbing=건강). negative_ratio 전부 ~0 → plateau remap(死신호 오플래그 방지).
- level 기둥(`_pillar_from_levels`): wow_growth=상대%. ratio 기둥(`_pillar_from_values`): wow_growth=절대 델타(pp).

### 7.4 Posture 합성 (`synthesize_posture`, `:373`)
> 🟢 **쉽게**: 4기둥 방향·가속을 가중 합산해 **'성장 가속/확대/유지/둔화/둔화 심화'** 한마디 + 가장 약한 기둥 한 개. (전부 누적 기반이라 음수는 '절대 하락'이 아니라 '성장 둔화'를 뜻함 — 그래서 "하락" 라벨 없음)

- `PILLAR_WEIGHTS = reach 0.4 / engagement 0.3 / community 0.2 / sentiment 0.1`.
- `_DIR_SCORE = climbing+1/plateau0/declining-1/unknown0`, `_ACCEL_SCORE = accel+1/flat0/decel-1`.
- `dir_sum = Σ weight*dir_score`, `acc_sum = Σ weight*accel_score`. 임계 ±0.15.
- **라벨 6종** (V2.43.1, "하락/악화" 제거 — flow 기반이라 음수=둔화지 절대하락 아님): dir_sum>0.15 → 성장 가속/확대/확대(둔화 조짐); dir_sum<-0.15 → 성장 둔화 심화/둔화; else 성장 유지.
- **weakest**: unknown 제외 + `_pillar_score<0`인 최저 기둥, 없으면 None.

### 7.5 빌드 (`build_growth_trajectory`, `:449`)
> 🟢 **쉽게**: 데이터가 2주(14일) 안 모인 그룹은 '데이터 축적 중'으로 보류.

`MIN_HISTORY_DAYS=14` 미만 → `insufficient_history`(빈 pillars). full DELETE+rebuild, 그룹당 1행.

---

## 8. Fan Loyalty — 라이브 CCV 충성도

`loyalty.py` + `FanLoyaltyCard.tsx` (V2.46~V2.47) · **CCV 절대값=규모 / 충성도=peak CCV÷구독자 전환율(규모와 직교)**.

> 🟢 **쉽게**: 라이브 켜면 **구독자 중 몇 %가 실제로 보러 오나**(전환율) = 충성도 0~100점. 구독자가 많고 적고와 무관한 '끈끈함' 지표. 동접 절대수는 규모, 충성도는 비율.

### 8.1 상수
`WINDOW_DAYS=56`; `LOYALTY_ANCHORS=[(0.005,20),(0.015,50),(0.03,70),(0.06,88),(0.12,100)]`; `TREND_FLAT_BAND=0.10`; `MIN_BROADCASTS_FOR_TREND=4`.

### 8.2 Conversion Rate (`:121`, V2.48 시점 매칭)
> 🟢 **쉽게**: 방송별 '최고 동접 ÷ **그 방송 당시** 구독자'로 전환율을 내고 그 중앙값. (예전엔 *오늘* 구독자로 나눠서, 데뷔기처럼 구독자가 급증한 그룹은 과거 방송이 손해봤음 → V2.48에서 방송 시점 구독자로 맞춤)

방송별 peak = `MAX(concurrent_viewers)` (video_id별, 56일 윈도). **방송별 전환율 = peak ÷ `subscribers_at(방송 시점)`** → `rate = median(방송별 전환율)`. `subscribers_at(series, at)`는 그 방송 시점(`first_at`) 기준 **가장 최근(≤at) 구독자 스냅샷**(이전이면 최초, 이력 없으면 최신 폴백). 표시용 `peak_ccv_median = median(peaks)`(규모 신호), `subscribers` = 최신 non-null(표시·폴백). subs≤0/None 또는 전 방송 분모 결측 → insufficient. *subs_at 미제공 시 median(peaks)/subscribers 와 동일(하위호환).*

### 8.3 Score 0–100 (`score_from_conversion`, `:55`)
> 🟢 **쉽게**: 전환율을 점수표로 환산(0.5%=20점 … 6%=88점 … 12%=100점, 사이는 직선보간). *임계값은 first-pass — 라이브 데이터 쌓이면 보정 예정.*

`LOYALTY_ANCHORS` 구간 선형보간: `rate≤0.005 → 20`; `rate≥0.12 → 100`; 내부 `s0 + (rate-r0)/(r1-r0)*(s1-s0)`. `round(.,2)`.
- 해석: <0.5% 매우낮음, 1.5% 보통, 6%+ 매우높음. **first-pass, 라이브 분포로 보정 예정**.

### 8.4 basis (`:114-127`)
> 🟢 **쉽게**: 방송 0회 = 데이터없음('축적 중'), 1회 = 참고만(저신뢰), 2회+ = 정식 점수.

`broadcast_count(distinct video_id)`: 0 또는 subs≤0 → **insufficient**(score=None); ==1 → **low_confidence**; ≥2 → **scored**. 모든 tracked 그룹에 insufficient 행이라도 기록(카드 "축적 중").

### 8.5 ccv_trend_pct / trend_basis (`ccv_trend`, `:68`) — **표시 전용, 점수 미반영**
> 🟢 **쉽게**: 최근 방송 시청자가 늘었나/줄었나(앞·뒤 절반 비교). 화면 표시만, 충성도 점수엔 안 들어감.

시간순 peak를 반으로 갈라 `pct=(median(후반)-median(전반))/median(전반)`. n<4 또는 first≤0 → unknown. `|pct|<0.10` → flat. else rising/falling.

### 8.6 Health Intimacy 주입 (V2.46)
> 🟢 **쉽게**: 충성도 점수가 '정식(scored)'인 그룹만 Health의 친밀도 영역에 반영(라이브 안 한 그룹은 페널티 없음).

주입 게이트 (`cli.py:1263`): `WHERE basis='scored' AND score IS NOT NULL`만 `loyalty_score` 주입(low_confidence/insufficient 제외 → 2신호 경로 → 점수 불변). `_factor_inputs`에서 `loyalty_n=clamp(score/100, 0, 1)`, Intimacy 3신호 `(eng 0.40, comm 0.30, loyalty 0.30)`.

### 8.7 프런트 헬퍼 (`FanLoyaltyCard.tsx`)
> 🟢 **쉽게**: 카드 표시용 — 전환율 %, 추세 화살표, 호가창 막대 폭, 중앙값 행 강조, 점수대 색(초록↔빨강).

- `fmtPct(rate)`: `(rate*100).toFixed(1)+"%"`, null→`—`.
- `trendLabel`: unknown/null→`추세 보류`, flat→`→ 유지`, rising/falling→`▲/▼ ±round(pct*100)%`.
- `barWidthPct(peak, max)`: `max≤0→0`, else `peak/max*100` (호가창 깊이 막대, V2.47).
- `medianRowIndex(broadcasts, peakMedian)`: peakMedian 최근접 행. **<3 방송 또는 None → null**(동률은 최신 행).
- `scoreColor`: **≥88 emerald / ≥70 lime / ≥50 amber / <50 red** / null zinc — 밴드가 LOYALTY_ANCHORS 점수(88=6%, 70=3%, 50=1.5%)와 정렬.

> **방송수 임계 3종 주의**: basis는 `==1`에서 분기, trend는 `<4`(MIN_BROADCASTS_FOR_TREND), medianRowIndex는 `<3`.

---

## 9. Weekly Causal Diagnosis (가설 점등)

`weekly_diagnosis.py` + `weekly_diagnosis_signals.py` · 주간 신호로 인과 가설 점등(휴리스틱, 인간 검증 전제).

> 🟢 **쉽게**: 지난주 숫자 변화로 **'왜 이렇게 됐나'를 자동 추정**(유료광고? 구독자구매? 컴백? 논란?). 단서 여러 개가 모여야 점등하고, 자연스러운 이유(컴백 등)가 있으면 의심 가설은 낮춘다. **최종 판단은 사람** — false positive(괜한 의심)로 인한 역효과 회피.

### 9.1 공통 임계 (`:65-71`, `:365`)
> 🟢 **쉽게**: '평소보다 튀었다'를 가르는 문턱값 모음(z 1.5/2.0, ER 급락 -20% 등).

`Z_PRIMARY=1.5`, `Z_STRONG=2.0`, `ER_DROP_PAID=-0.20`, `ER_DROP_SUB_PURCHASE=-0.25`, `VPS_DROP_SUB_PURCHASE=-0.30`, `ORGANICITY_PAID=0.30`, `SUBS_Z_SUB_PURCHASE=2.5`, `CONTROVERSY_Z=2.0`.

### 9.2 `_is_lit` — 3축 OR 점등 (`:86`)
> 🟢 **쉽게**: 한 신호가 '튀었나'를 세 잣대(또래 대비 / 자기 과거 대비 / 주간 변화율) 중 **하나라도** 넘으면 점등.

`category_z ≥ th` OR `temporal_z ≥ th` OR (`wow_pct ≥ wow_th`). 기본 th=1.5.
- **서브컬처 예외 (`:74-98`)**: `category=='subculture'`이면 `category_z` 축을 점등 판정에서 제외(코호트 2개라 cross-sectional z가 구조적 노이즈; `CATEGORY_COHORT_MIN=3` 미달 시 category_z=0 fallback). `temporal_z + wow_pct`로만 판정. K-POP은 3축 전부 사용.

### 9.3 가설별 점등 규칙 (요약)
> 🟢 **쉽게**: 각 가설은 '단서 점수'가 일정 개수 이상 모여야 켜진다. 예: 유료광고 = 조회수만 급등+구독 비례 안 함+ER 급락+오가닉 낮음 중 3개↑.

| 가설 | confidence | 핵심 규칙 |
|---|---|---|
| organic_growth | high | `|er_wow|<0.15` & lit 신호(subs/views/news/community/market_share_z≥1.5) **≥4** |
| paid_youtube_ads | high | 점수 누적 ≥3: views lit(z2.0/wow0.20)+1, views z≥1.5 & subs z<1.5 +1, er_wow≤-0.20 +1, organicity_paid≥0.30 +1 |
| subscriber_purchase | medium 캡 | 점수 ≥3: subs lit(z2.5/wow0.15)+1, vps_wow≤-0.30 +1, er_wow≤-0.25 +1. vps_wow=None → 차단 |
| comeback_cycle | high/medium | 점수 ≥2: hanteo>0/chart≤30/streak≥3/news lit(z2.0)/upload_z≥1.5/event_match. score≥3 또는 event → high |
| controversy_spike | high | `controversy_count_z` / `negative_ratio_z` / `keyword_z` 중 하나 ≥2.0 (OR), 인간검증 강제. twitter_z 없음(Twitter 제거) (`:372-396`) |
| platform_concentrated | high/medium | reactivity dominant + support lit(z2.0). max_z≥2.5 → high |
| member_centric_spike | high/medium | top1_wow≥0.10 또는 hhi_wow≥0.15, 그룹 subs/views lit 동반. top1≥0.60 → high |
| broadcast_appearance | medium | news_z_prev≥3.0 & community lit |
| community_word_of_mouth | medium | community_z_prev≥2.0 & (subs 또는 views) lit |

### 9.4 메타 가드 / dampen
> 🟢 **쉽게**: 컴백/멤버 이슈처럼 자연스러운 이유가 동시에 켜지면 '유료의심'을 한 단계 낮춘다. 무관글 비율↑·백필 데이터 많음 등 신뢰 떨어지면 전체를 한 단계 하향.

- `_confidence_dampen`: high→medium→low (1단계).
- comeback 또는 member_centric 점등 시 paid_youtube_ads/subscriber_purchase를 **1단계** 감점(이유 수 무관).
- `apply_meta_guards` (`:490`): `irrelevant_ratio≥0.15` 또는 `data_source_backfill>0.5` → 모든 가설 1단계 감점.

### 9.5 순수 시그널 함수 (`weekly_diagnosis_signals.py`)
> 🟢 **쉽게**: 위 규칙이 쓰는 개별 단서들 — ER 급락률, 구독자당 조회수 변화, 오가닉 유료비율, 멤버 쏠림 변화, 음방 연속 1위, 부정 키워드 급증 등. (`wow`는 전주 대비 변화율; 전주가 0이면 계산 불가라 None — 데이터 갭 위 발사 방지)

- `engagement_rate_from_agg`: `(likes+5*comments)/views` (health_score 단일출처).
- `er_wow` / `vps_wow`: `(now-prev)/prev`, prev=0 → None.
- `organicity_paid_ratio`: `count(verdict∈{suspect,likely_paid}) / scored수`.
- `reactivity_dominant_platform`: `DOMINANCE=2.5`, `OTHER_MAX=1.3`, `MIN_SAMPLE=3`.
- `member_centric_signals`: `TOP1_WOW=0.10`, `HHI_WOW=0.15`, `TOP1_ABS_HIGH=0.60`.
- `music_show_consecutive_wins`: streak ≥3 (`MUSIC_SHOW_STREAK_THRESHOLD`).
- `negative_keyword_z` / `community_keyword_topic`: NEGATIVE/EXTERNAL/SELF 키워드 셋 + `cohort_z` / `min_hits=2`.
- `irrelevant_flag_ratio`: `count(user_flagged) / posts`. `data_source_warning`: backfill/manual_seed 비율 >0.5.
- rev3 cohort: `TEMPORAL_HISTORY_WEEKS=8`, `CATEGORY_COHORT_MIN=3`. WoW lit: `SUBS=0.05, VIEWS=0.08, VIEWS_PAID=0.20, SUBS_SUB_PURCHASE=0.15, NEWS=0.30, COMMUNITY=0.30`.

---

## 10. Challenge Scan

`challenge_scan.py` · 주간 바이럴 챌린지 발굴. (LLM 분류는 §13)

> 🟢 **쉽게**: 이번 주 **뜨는 챌린지**를 찾아 점수(조회수 0.7 + 숏츠 수 0.3)로 줄 세움. 실제 바이럴 풀에 있는 것만 남겨 환각/니치 챌린지를 거른다.

- 상수: `POOL_CAP=150`, `SEED_QUERIES` 5개, 최근 7일·`order=viewCount`·조회수 상위.
- **`select_and_rank` 점수** (`:162`): `score = (views/max_views)*0.7 + (recent_shorts/max_shorts)*0.3`. meme(비-댄스)은 상위 `min_meme=3` 보장, 나머지 score순으로 `total=10`개.
- `measure_challenge`: 해시태그 블라인드 검색 → `yt_recent_shorts=len(ids)`, `yt_total_views=sum(views)`.
- pool-grounded 필터: candidate id가 viral pool에 1개+ 있어야 유지(환각 차단). example clips 상위 3개.

---

## 11. Relevance / News Filter 게이트

분류 게이트(boolean), 수치 산식 아님.

> 🟢 **쉽게**: 이 글/기사가 **정말 이 그룹 얘긴지** 거르는 문지기. 스팸(양도·광고)·무관 글·데뷔 1년보다 오래된 기사는 버린다. 짧은 약칭(초성 등)은 그룹명이 같이 있을 때만 인정.

### 11.1 `is_relevant` (`relevance.py:121`)
순서: ① `is_global_spam` → False. ② **long-token fast path**: context keyword 중 `len≥3 & not blocked & in title` → True. ③ **short-token anchor gate**: short token + `_has_anchor`(그룹명 영/한 in title) → True. else False.
- `SHORT_TOKEN_THRESHOLD=3`. `GENERIC_KEYWORD_BLOCKLIST`(버추얼/virtual/IPX/ABYSS/Zero/URL/모카/마냥 등)는 strict 모드에서 길이 무관 anchor 강제(DcCollector supplemental 전용).
- `is_global_spam`: {양도, 팝니다, 삽니다, 단톡, [광고], 굿즈 거래, 택포…} substring.

### 11.2 `NewsFilter.evaluate` (`news_filter.py:42`)
순서: context keyword 없음 → 거부. 날짜 파싱 불가 → 거부. **`_allow_after = debut - 365일`보다 이른 기사 → 거부**. blacklist phrase → 거부. else 통과. (배제도 is_excluded=1+reason 저장)

---

## 12. 클라이언트 계산

### 12.1 shortsTrend.ts
> 🟢 **쉽게**: 최근 14일 안 올라온 + 급상승(velocity 2배↑) 숏폼에 🔥 배지. 최신순/조회순/속도순/신선순 정렬.

`FRESH_DAYS=14`, `FRESH_VELOCITY=2.0`(🔥 배지), `MIN_VIEWS_FLOOR=5000`(velocity 랭킹 floor).
- `isFresh`: `daysSince≤14 & velocity≥2.0`. `velocityEligible`: `views≥5000 & velocity!=null`.
- 정렬: recent(일수↑) / views(↓) / velocity(eligible 먼저) / fresh(isFresh 먼저).

### 12.2 alerts.ts
> 🟢 **쉽게**: 논란 글이 전주의 2배↑이고 최소 5건 이상이면 '논란 급증' 알림(소수 노이즈는 무시).

`CONTROVERSY_SPIKE_MULTIPLIER=2.0`(전주 2배), `CONTROVERSY_SPIKE_MIN_COUNT=5`(floor). worker `alerts/`와 미러링(drift 테스트 가드). 나머지는 라벨/톤 매핑(산식 아님).

### 12.3 shortsDiagnostic.ts (MiiWAN Shorts 운영 진단 — organicity와 별개)
> 🟢 **쉽게**: MiiWAN 숏폼 운영 **건강검진** — 터짐 비율·조회 균일도·해시태그 커버리지 등 8개 지표를 good/warn/bad 신호등으로. (오가닉 채점과는 별개 도구)

- 임계 `T` (`:174`): breakout(good10/warn3↑), cv(0.8/0.4↑), band(0.4/0.7↓), coverage(80/40↑), decoration(20/50↓), hashtag(50/20↑), er(4/2↑), velocity(2/1↑). `SMALL_SAMPLE=5`.
- 지표: `breakoutRatio=max/median`, `bandConcentration`=median±40% 비중, `coefficientOfVariation=stdev/mean`, `normalizedHHI=(hhi-1/n)/(1-1/n)`, `cadenceDays`=인접 gap 중앙값, `avg_er=(likes+comments)/views*100` 평균, `ceiling_vs_subs=median(views)/subs`.
- `statusByThresholds`: higher면 `≥good→good/≥warn→warn/else bad`, lower면 부등호 반대.

---

## 13. LLM 기반(비-결정론) 항목

> 🟢 **쉽게**: 여기는 '공식'이 아니라 **AI(Gemini)가 판단**하는 부분. 같은 입력이라도 결과가 달라질 수 있어 산식으로 못 적는다.

다음은 Gemini 판단에 의존 — 결정론 산식 아님(프롬프트 엔지니어링·환각 가드만 존재):
- **Sentiment 4-클래스 분류** (`sentiment.py`) — title만 입력, {positive/negative/controversy/neutral}. *negative_ratio 산식 자체는 결정론(§5.4).*
- **Weekly 인사이트 본문** (`llm/weekly.py`, `prompts.py`) — D-N 카운트다운/코호트 베이스라인은 결정론 컨텍스트 주입(`_debut_countdown`), 본문 서술은 LLM. ANALYSIS DEPTH/환각 가드 적용(V2.31/2.45).
- **Challenge 분류** (`challenge_scan.py`의 `CHALLENGE_CLASSIFY`) — meme/dance·momentum 판정. *측정 점수(§10)는 결정론.*
- **Music show 파싱** (`llm/music_show.py`).

---

---

## 14. Live Activity — 찐팬 활동량 (P2a)

`live_activity.py` · 라이브 채팅 측정(measured) + 영상 참여 추정(estimated) 두 축의 합성 지표. 신규 수집 0 — 기존 `live_chat_messages`·`youtube_video_stats`를 재가공.

> 🟢 **쉽게**: **라이브에서 실제로 활발히 반응하는 팬이 몇 명인지**를 추정. 채팅 집계(측정값)와 영상 좋아요·댓글(외형 추정)은 서로 다른 참여 표면이라 결합하지 않고 병렬 제공. Heuristic, not ground-truth.

### 14.1 상수

| 상수 | 값 | 위치 |
|---|---|---|
| `WINDOW_DAYS` | 56 | `live_activity.py:34` |
| `MIN_WINDOW_VIDEOS` | 3 (윈도 내 영상 < 3 → 최신 12건 폴백) | `:35` |
| `VIDEO_FALLBACK_LIMIT` | 12 | `:36` |
| `MS_PER_MINUTE` | 60,000 | `:37` |

### 14.2 (A) Measured — 라이브 채팅 집계 (`compute_broadcast_activity`, `:45-100`)

방송 1회 분 `live_chat_messages` → per-broadcast 지표:

| 지표 | 정의 |
|---|---|
| `unique_chatters` | 고유 author 수(author NULL/'') 제외) |
| `msgs_per_chatter` | `total_messages / unique_chatters`. unique=0 → None |
| `peak_msgs_per_min` | 1분 버킷 중 최대 메시지 수. offset_ms NULL 메시지는 버킷에서 제외 |
| `returning_rate` | 직전 방송 chatters 집합과의 교집합 비율. 최초 방송 → None |

**코어팬 (`window_core_fans`, `:103-121`)**: 56일 윈도 내 ≥2개 방송에 등장한 고유 챗터 → `core_fan_count`, `core_fan_share`. 방송 1건 이하 → 계산 안 함.

### 14.3 (B) Estimated — 영상 참여 추정 (`estimate_video_engagement`, `:124-182`)

최근 `WINDOW_DAYS` 내 영상 최신 스냅샷 (MIN_WINDOW_VIDEOS 미달 시 최신 VIDEO_FALLBACK_LIMIT건 폴백). 신뢰 구간 낮음(공개 외형 신호).

| 지표 | 산식 |
|---|---|
| `est_engaged_fans` | `median(likes)` (라이브 유사 참여 팬 규모 추정) |
| `est_active_core` | `median(comments)` (더 깊은 참여 코어 추정) |
| `view_through` | `median(views)` (도달) |
| `like_rate` | `median(likes/max(views,1))` (좋아요 전환율 중앙값) |
| `comment_rate` | `median(comments/max(views,1))` (댓글 전환율 중앙값) |

### 14.4 Summary Basis (`compute_live_activity`, `:185-299`)

| 방송 수 | basis |
|---|---|
| 0 | `insufficient` |
| 1 | `low_confidence` (core_fan 미계산) |
| ≥2 | `scored` |

Per-broadcast basis: `unique_chatters==0 → insufficient`; `returning_rate is None (첫 방송) → low_confidence`; else `scored`.

Full DELETE rebuild 패턴(loyalty.py 미러). `basis='scored'`인 summary만 Health Intimacy 주입 경로에 진입(미구현, 향후 연결 예정).

### 14.5 전 그룹 추정 코어 (`core_fan_estimate.py`, MarketOverview 카드)

`core_fan_estimate.py` · §14.3 (B) Estimated(`estimate_video_engagement`)를 MiiWAN 전용에서 **전 그룹**으로 확대. 신규 수집 0 — youtube_videos/youtube_video_stats 재가공. 정렬/순위 키 아님, 카드 참고 표기 전용(Heuristic, not ground-truth).

> 🟢 **쉽게**: MiiWAN만 보여주던 "추정 코어팬"(최근 영상 좋아요·댓글 중앙값)을 전 그룹 카드에 확대 적용. §14.3과 같은 산식, 대상만 확장.

- **영상 표본** (`build_core_fan_estimate`, `:183-241`): 그룹당 최근 `_WINDOW_DAYS=56`일 영상. `< _MIN_WINDOW_VIDEOS=3`편이면 최신 `_VIDEO_FALLBACK_LIMIT=12`편 폴백(§14.1 live_activity.py 상수를 module-private라 로컬 복제).
- **산식** (`compute_core_fan_estimate`, `:111-164`): 표본을 `estimate_video_engagement`(§14.3)에 그대로 전달 → `est_engaged_fans=median(likes)`, `est_active_core=median(comments)`, `like_rate`/`comment_rate`.
- **basis**: `videos` 빈 리스트 → `insufficient`(원값·adj 전부 None). 그 외는 §16.3 참조(V2.53 adj 필터 결과에 따라 `scored`/`insufficient_organic`).
- **저장**: 스냅샷별 멱등(`DELETE WHERE snapshot_at=?` 선두), 그룹당 1행.

---

## 15. Awareness Index — 인지도 지수 (P2b)

`awareness.py` · 카테고리별 상대 인지도 지수(0–100). 신규 수집 0 — `agg_summary` 최신 신호(구독·조회·뉴스) 재가공. **데뷔 전 그룹 포함**(데뷔 전에도 구독·조회로 인지도 존재).

> 🟢 **쉽게**: "버추얼 아이돌 인지도 순위"에 직접 답하는 1차원 지표. SOV와 달리 zero-sum이 아님(점유가 아니라 리더 대비 상대값). **V2.53**: 화면 표시는 원값이 아니라 organicity 신뢰 계수로 할인한 보정값(adj)이 기본 — 유료 의심 영상 비중이 높은 그룹은 인지도가 깎여 보인다(§16).

### 15.1 상수

**`AWARENESS_WEIGHTS`** (`awareness.py:35-39`, 합=1.0, assert):

| 신호 | 가중치 | 근거 |
|---|---|---|
| `sub` (구독자) | 0.50 | 현 인지도 최강 신호(보유 청중) |
| `view` (조회수) | 0.35 | 도달(접촉 횟수) |
| `news` (뉴스) | 0.15 | 언론 노출(표기 비대칭 편향 고려해 낮춤) |

검색량(`search_n`)은 후속 플러그인 자리만 비워 둠 — 추가 시 가중치 재배분.

### 15.2 산식 (`compute_awareness`, `:77-155`)

1. **카테고리 분류** (`_category_of`, `:43-54`): `corporate → kpop`, `segmentary/confederation → subculture`. **3곳 미러** — `awareness.py` / `weekly_diagnosis_signals._category_of` / `frontend MarketOverview.categoryOf`: 매핑 변경 시 세 곳 동시 갱신.
2. **리더 대비 log1p 정규화** (`_normalize_log`): `신호 값 → log1p(value) / log1p(category_max)`. 리더 = 카테고리 내 해당 신호 최댓값(기준 1.0). min-max 대신 리더 대비 채택 이유 — min-max는 카테고리 최하위를 강제로 0으로 만들어(SOV의 "최하위 0%" 문제) 실측 청중 보유 그룹이 0으로 깔린다.
3. **가중합**: `score_raw = Σ AWARENESS_WEIGHTS[k] * norm[k]`.
4. **0–100 스케일링**: `score = round(score_raw * 100, 1)`.
5. **카테고리별 분리 랭킹**: kpop/subculture 내에서 `score` 내림차순. 동점 tiebreak → `yt_subscribers` 큰 쪽 우선.
6. **basis**: `yt_subscribers`와 `yt_total_views` 모두 None/0 → `insufficient`(score=None); else `scored`.
7. **`awareness_score_adj` / `category_rank_adj` (V2.53, `:99-103, 146-160, 175-182`)**: §16 Organic Confidence 계수(`conf`, 그룹별 0~1)로 원값을 곱만 하는 **추가** 산출값 — 원값(`awareness_score`/`category_rank`) 자체는 불변.
   - `awareness_score_adj = round(awareness_score * conf, 1)` (`:148`). `basis='insufficient'`(score=None) → adj도 None.
   - `category_rank_adj`: adj 점수 기준으로 카테고리 내 **재랭킹**(`:177-181`) — 원값 랭킹과 독립적으로 다시 정렬. tiebreak은 원값과 동일(`yt_subscribers` 내림차순, `:179`).
   - `conf` 부재 그룹(organicity 채점 영상 0) → 1.0 무할인(`:105, 147`).
   - **저장**: mig 0106(`migrations/0106_awareness_adj.sql`) 적용 D1만 adj 3컬럼 INSERT(`_INSERT_SQL_ADJ`, `:217-223`); 미적용이면 `_has_adj_columns`(`:226-232`)가 감지해 기존 10컬럼 INSERT로 graceful 폴백.

### 15.3 SOV와의 차이

| | SOV | Awareness |
|---|---|---|
| 성격 | zero-sum 점유율(코호트 합=100%) | 리더 대비 절대값(합≠100%) |
| 범위 | 코호트 전체 통합 | 카테고리별 분리 랭킹 |
| 신호 수 | 4종 + 모멘텀 | 3종(구독·조회·뉴스) |
| 데뷔 전 | 포함(agg_summary 있으면) | 포함 |
| 목적 | "이번 주 이 그룹이 주목 많이 받았나" | "이 그룹이 카테고리 리더 대비 얼마나 알려졌나" |

---

## 16. Organic Confidence — Organicity 신뢰 계수 (V2.53)

`organic_confidence.py` · Debut Window Organicity(§6)의 영상별 verdict 분포를 그룹당 0~1 계수 하나로 압축해, 인지도(§15)·추정 코어(§14.5)가 유료 의심 할인에 공용으로 쓰는 신호. Health Score PRE 게이트(§1.1의 `debut_confirmed`)와는 별개 축(신뢰 vs 데뷔 확정).

> 🟢 **쉽게**: 그룹의 데뷔 영상들이 대체로 "진짜"인지 "유료로 띄운 것"인지를 점수 하나(0~1)로 압축한 신뢰도. 1에 가까우면 그대로 믿고, 낮으면 인지도·추정 코어 숫자를 깎아서 보여준다. 판정할 영상이 아예 없으면 의심할 근거가 없으니 깎지 않는다(1.0).

### 16.1 상수 & 계수 산식

| 상수 | 값 | 위치 |
|---|---|---|
| `VERDICT_WEIGHTS` | organic_strong/organic=1.0, borderline=0.7, suspect=0.4, likely_paid=0.15 | `organic_confidence.py:22-28` |
| `CONFIDENCE_PRIOR` | 0.75 | `:29` |
| `CONFIDENCE_SHRINKAGE_K` | 3 | `:30` |

**산식** (`compute_organic_confidence`, `:39-49`):
1. 그룹의 §6.6 verdict 리스트에서 `insufficient_data`(판정 불가) 제외(SQL `:32-36`, 함수 내 필터 `:41`) — 판정 근거 없이 유료 의심으로 몰지 않는다.
2. `n=0`(채점 영상 없음) → **`conf=1.0`**(무할인, `:43-44`). *prior(0.75)로 수렴시키지 않는 이유(모듈 docstring `:6-8`): 미채점 그룹 전원이 25% 감점되는 부작용 방지.*
3. `n>0`: **단순(count 기반) 평균** `mean = Σ VERDICT_WEIGHTS[v] / n`(`:45`) — 조회수 가중 아님(§6.9 V2.40 simple-mean 원칙과 동일 사상).
4. **thin-sample shrinkage**(§6.9 `organic_score_mean_shrunk`와 같은 패턴, `:46-49`): `conf = (n·mean + K·PRIOR) / (n+K)`, `round(.,3)`.

**BTHD 검산 예** — verdict 분포 organic(+strong) 3편 / borderline 6편 / suspect 5편 / likely_paid 8편(n=22):
`mean = (3·1.0 + 6·0.7 + 5·0.4 + 8·0.15) / 22 = 10.4/22 ≈ 0.4727`
`conf = (22·0.4727 + 3·0.75) / (22+3) = 12.65/25 = 0.506`.

### 16.2 그룹별 로딩 (`load_organic_confidence`, `:56-61`)

`debut_window_video_organicity` 전 영상을 `WHERE verdict != 'insufficient_data'`로 조회(`_VERDICTS_SQL`, `:33-36`) → 그룹별 verdict 리스트로 묶어 `compute_organic_confidence` 적용. **채점 영상이 아예 없는 그룹은 dict에 키가 없다** — 호출부(§15.2 step 7, §16.3/§16.4)가 `.get(key, 1.0)`로 무할인 처리.

### 16.3 적용처 A — 인지도 곱셈 할인 (§15.2 step 7 상세)

`awareness.py`: `awareness_score_adj = round(awareness_score * conf, 1)`(`:148`). 원값(`awareness_score`/`category_rank`) 불변, adj는 추가 컬럼. `category_rank_adj`는 adj 기준 재랭킹(동일 tiebreak). mig 0106(`migrations/0106_awareness_adj.sql`) 미적용 D1은 adj 컬럼 없이 기존 INSERT로 graceful 폴백(`_has_adj_columns`, `awareness.py:226-232`).

### 16.4 적용처 B — 추정 코어 median 제외 필터 (`core_fan_estimate.py`)

원값 경로(§14.5)는 불변. V2.53은 데뷔윈도우 영상 organicity 판정 중 **`suspect`/`likely_paid`** verdict 영상만 표본에서 제외하고 median을 다시 낸 보정값을 추가 산출한다(§6.6의 organic_strong/organic/borderline과 **미채점** 영상은 그대로 포함 — 배제 대상이 아님).

- **필터** (`select_organic_videos`, `:91-108`): 윈도우 영상에서 suspect_ids 제외 → `< _MIN_WINDOW_VIDEOS(=3)`편이면 폴백(최신 12편)에도 **동일 필터** 적용 → 그래도 부족하면 `None`.
- **suspect 셋 로딩** (`_SUSPECT_SQL`, `:85-88`): `SELECT video_id FROM debut_window_video_organicity WHERE verdict IN ('suspect','likely_paid')`. 테이블 이상/미적용 시 빈 셋(전부 organic 취급, graceful).
- **basis** (`compute_core_fan_estimate`, `:144-151`): 원값 표본(`videos`) 있고 필터 후 표본(`videos_adj`)이 `None`(< 3편) → **`basis='insufficient_organic'`**(adj 전부 None, 원값은 그대로 유지 저장). 둘 다 있으면 `'scored'`. `videos` 자체가 없으면 `'insufficient'`(§14.5).
- **저장**: mig 0107(`migrations/0107_core_fan_adj.sql`) 적용 D1만 adj 3컬럼(`est_engaged_fans_adj`/`est_active_core_adj`/`organic_video_count`) INSERT, 미적용이면 `_has_adj_columns`(`:173-180`) 감지로 기존 9컬럼 INSERT 폴백.

### 16.5 Health PRE 게이트와의 관계

Organic Confidence는 인지도·추정 코어에만 곱해지는 **신뢰 할인**이고, §1.1의 `debut_confirmed` PRE 게이트는 별개로 "정식 데뷔 확정 여부"만 본다 — 서로 다른 축(신뢰 vs 확정)이라 한 그룹에 동시에 적용될 수 있다. 예: BTHD는 `debut_confirmed=0`으로 Health가 PRE인 것과 무관하게, 채점된 영상이 있으면 organic_confidence도 별도로(낮게) 계산될 수 있다.

### 16.6 프런트 표시 (`frontend/src/views/MarketOverview.tsx`)

- **adj-first**: `awarenessDisplay()`(`:83-91`)는 `score_adj ?? score`, `category_rank_adj ?? category_rank`를 표시값으로 쓰고 `discounted = score_adj != null`을 함께 반환. `coreDisplay()`(`:93-97`)는 `est_engaged_fans_adj ?? est_engaged_fans`(단 `basis='insufficient_organic'`이면 `value=null`). 할인된 셀은 원값 + `organic_confidence`를 툴팁에 노출(`title="원값 {score} · 신뢰 계수 {organic_confidence} — 유료 의심 영상 비중만큼 할인"`, `:468` 부근).
- **사분면(quadrant)은 원값 유지** — 광고형(넓지만 얕음) 패턴 탐지가 사분면의 목적이라, 할인하면 그 패턴 자체가 지워진다. `x=g.awareness?.score`, `y=g.core_fan_estimate?.est_active_core` 모두 원값(`:397-404`). 도움말 문구(`HELP.quad`, `:134`): "사분면의 인지도는 할인 전 원값 — '넓지만 얕음(광고형)' 패턴 탐지가 목적."
- **API 노출** (`frontend/functions/api/market.ts`): adj 컬럼은 원값 쿼리와 **분리된 쿼리**로 조회(`:141-151`, 각각 `.catch(()=>[])`로 mig 0106/0107 미적용 D1에서도 원값 응답은 절대 깨지지 않게 graceful), 응답 조립 시 `awareness.score_adj`/`category_rank_adj`/`organic_confidence`(`:214-216`), `core_fan_estimate.est_engaged_fans_adj`/`est_active_core_adj`(`:224-225`)로 병합.

---

*문서 끝. 🟢는 직관용 요약일 뿐, 정확도가 의심되면 항상 인용된 `파일:라인`의 코드를 진실의 원천으로 확인할 것.*
