# IDOL-SIGHT 산식 레퍼런스 (Dashboard Formula Reference)

> **목적**: 대시보드가 계산하는 **모든 결정론적 산식**(가중치·임계값·정규화·분류 규칙)을 한 곳에 정리한 단일 참조 문서.
> **기준일**: 2026-06-09 (V2.47까지 반영).
> **출처**: `worker/src/idol_sight/analysis/*.py`, `worker/src/idol_sight/cli.py`, `frontend/src/lib/*.ts`, `frontend/functions/lib/*.ts`, `frontend/src/components/FanLoyaltyCard.tsx`. 각 산식에 `파일:라인` 명시.
> **갱신 규칙**: 산식/상수 변경 시 이 문서와 `CLAUDE.md` 체인지로그를 함께 갱신한다. 코드가 진실의 원천이며, 본 문서는 인용 라인이 drift할 수 있으니 의심되면 원본 확인.
> **비-결정론 제외**: LLM(Gemini) 판단에 의존하는 항목(감성 분류, weekly 인사이트 본문, 챌린지 LLM 분류)은 "산식"이 아니므로 규칙만 기술하고 수치 공식은 없음 — §13 참조.
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

---

## 0. 공통 빌딩블록

여러 산식이 공유하는 원자 함수.

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

### 1.1 총점 & 등급

**산식** (`compute_health_score`, `:604-704`):
1. **Pre-debut 게이트** (`:613-618`): `debut_date` 없음/미래 → `grade="PRE"`, `total=None`.
2. **effective live 메트릭** `L` (`:630`): 코호트 live ∩ 이 그룹 live (죽은 신호 제거).
3. **가중치 선택** (`:631`): `FACTOR_WEIGHTS[group_model]` (없으면 corporate).
4. **risk_factor** = `_controversy_factor(controversy_count)` (`:665`).
5. **팩터 점수** (`:667-670`): `factor_scores[name] = round(factor_input[name] * weight[name] * risk_factor, 2)` — risk가 4개 팩터 전부에 곱해짐.
6. **factor_base** = Σ factor_scores (`:671`).
7. **bonus** = `_recent_bonus(v90, v30)` (최대 10) (`:673`).
8. **total** (`:678`): `round((factor_base + bonus) / FACTOR_DENOM * 10.0, 1)`, **`FACTOR_DENOM = 110`** (100 + bonus_max 10).
9. **grade** (`:683`): `GRADE_THRESHOLDS`에서 `total >= thr` 첫 등급.

**출력**: total 0.0–10.0, grade ∈ {S,A,B,C,D,PRE}.

**상수**:
- `GRADE_THRESHOLDS` (`:105`): `(9.0,S)(7.0,A)(5.0,B)(3.0,C)(0.0,D)`.
- `FACTOR_BONUS_MAX=10`, `FACTOR_DENOM=110`, `DYNAMIC_REF_PERCENTILE=0.75`.

### 1.2 group_model별 4-Factor 가중치 (`FACTOR_WEIGHTS`, `:121-140`, 각 행 합=100)

| group_model | Reach | RitualVictory | Mobilization | Intimacy |
|---|---|---|---|---|
| **corporate** (PLAVE형, 기본) | 25 | 30 | 30 | 15 |
| **segmentary** (ISEDOL형) | 20 | 15 | 25 | 40 |
| **confederation** (STELLIVE형) | 15 | 10 | 20 | 55 |

### 1.3 팩터 입력값 (`_factor_inputs`, `:462-601`) — 각 0–1, `_wmean` 가중평균(dead 신호 재정규화)

**Reach (도달)** (`:569`):
`wmean[(sub_n,0.55,live), (view_n,0.40,live), (news_n,0.05,live)]`
- `sub_n=_normalize(subscribers, ref)`, `view_n=_normalize(views, ref)`, `news_n=_normalize_log(news, ref)`.

**RitualVictory (의례적 승리)** (`:581`, `redistribute=False` — dead 신호가 분모에 남아 실제 하락):
`wmean[(hanteo_n,0.50), (news_n,0.10), (music_show_n,0.20), (chart_peak_n,0.10), (chart_depth_n,0.10)]`
- `hanteo_n=min(hanteo_sales/1_000_000, 1)` (100만장 saturate).
- `music_show_n=_normalize(wins, ref=5.0)`.
- `chart_peak_n`: peak∈[1,100] → `(101-peak)/100` (1위=1.0), 아니면 0.
- `chart_depth_n`: `min(depth/depth_ref, 1)`, `depth_ref=ref or 5.0`.

**Mobilization (동원)** (`:592`):
`wmean[(view_n,0.40), (cadence_n,0.25,항상live), (hanteo_n,0.25), (sub_n,0.10)]`
- `cadence_n=min(v90_count/30, 1)` (90일 30영상 saturate).

**Intimacy (친밀도)** (`:546-561`): `intimacy_compression = max(0, 1 - negative_ratio)`를 곱함.
- **loyalty_score 있을 때 (V2.46, 3신호)**: `wmean[(eng_n,0.40), (comm_n,0.30), (loyalty_n,0.30,항상live)] * compression`, `loyalty_n=clamp(loyalty_score/100, 0, 1)`.
- **없을 때 (2신호)**: `wmean[(eng_n,0.55), (comm_n,0.45)] * compression` → 재정규화로 라이브 안 한 그룹 점수 불변(페널티 0).
- `eng_n=_normalize(engagement_rate, ref)`, `comm_n=_normalize(dc+theqoo+instiz posts, ref)`.

### 1.4 Engagement Rate (참여율)
**산식** (`engagement_rate`, `:425`): `(likes + 5*comments) / views`. **`COMMENT_WEIGHT=5`** (댓글이 좋아요보다 5배 의도 신호). views≤0 → 0.0.

### 1.5 Recent Bonus (`_recent_bonus`, `:455`)
`min(v90/30, 1)*7 + min(v30/10, 1)*3` → 0–10 가산 overlay (group_model 무관).

### 1.6 Controversy Factor (`_controversy_factor`, `:448`)
`count<=0 → 1.0`, 아니면 `max(0, 1 - count/10)`. 10건+ → 0. 4개 팩터 전부에 곱.

### 1.7 동적 REF (코호트 percentile)
`ref[dim] = max(_percentile(cohort_vals, 0.75), MIN_REFS[dim])` (`:373`). 1.0 = 코호트 p75 수준.
- `MIN_REFS` (`:97`): subscribers=50K, views=1M, quality=0.005, community=1K, news=10.
- `music_show_wins` ref=5.0 고정 (sparse).
- 바닥값 가드로 1-그룹 코호트/전부-0 컬럼의 분모 붕괴 방지.

---

## 2. SOV — Share of Voice

`market_share.py` · 코호트의 측정된 크로스플랫폼 관심 점유율(실제 시장점유 아님). z-score/percentile-rank 단위 통일.

**산식** (`_compute_sov`, `:120-167`):
1. 누적 신호 5종 각 `_percentile_rank`: yt_views, community, news, subscribers, twitter.
2. 모멘텀: yt_views/community/news는 `max(delta,0)`, subscribers·twitter는 미사용(0).
3. 그룹별 합성: `score = Σ SOV_WEIGHTS[k] * rank[k]`.
4. 0–100 정규화(코호트 합=100, zero-sum): `cum_pct = cum_score/cum_total*100`.
5. **`final = cum_pct*0.6 + mom_pct*0.4`** (`ALPHA_CUM=0.6`, `BETA_MOM=0.4`).

**`SOV_WEIGHTS`** (`:39`, 합=1.0, assert): yt_views=0.30, community=0.25, news=0.20, subscribers=0.15, twitter=0.10.

**출력**: cum/mom/final 각 0–100% (소수 2자리).
**가드**: 분모≤0 → pct=0. legacy 입력(신호 없음)은 raw-sum 정규화 fallback. 음수 델타 `max(.,0)` 클램프.

---

## 3. Member Popularity & Normalized HHI

`member_popularity.py` · 그룹 내 인기 집중도(그룹 크기 무관 비교).

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

채널별 최신 stats 집계 후 (`:125`):
- **group_only**: 그룹 채널값만.
- **sum**: `group + member_sum` (subs/views/videos).
- **weighted**: `group + int(member_sum * 0.7)`.

**가드**: 채널 stats 없으면 0. `or 0`으로 NULL 방어. (group, snapshot, method)당 1행 멱등 upsert.

---

## 5. Engagement / Velocity / Reactivity / Sentiment / agg_summary

### 5.1 agg_summary 집계 컬럼 (`agg_summary.py`)
대부분 카운트/합계 (산식 아님), `(group_key, snapshot_at)` 멱등 UPSERT.

| 컬럼 | 산식 | 위치 |
|---|---|---|
| `yt_total_videos` | `COUNT(DISTINCT video_id)` | `:132` |
| `yt_likes_total`/`yt_comments_total` | `SUM(likes/comments)` — **영상별 최신 스냅샷만** JOIN(중복합산 방지) | `:133-139` |
| `yt_subscribers`/`yt_total_views` | distinct 채널별 최신 스냅샷 **SUM**(MAX 아님 — segmentary 멤버채널 합산용). 채널 stats 전무→NULL | `:152-173` |
| `dc_total_posts`/`theqoo_posts`/`instiz_posts` | `COUNT(*)` per platform — **누적 단조증가** | `:66-77` |
| `naver_total_news` | `COUNT(*) WHERE is_excluded=0` | `:80` |
| `twitter_posts`/`controversy_count` | `COUNT(*)`, `SUM(type='controversy')` | `:88-95` |

### 5.2 24h Video Velocity (`viral_velocity_ratio`)
`video_velocity.py` · 신규 영상 첫 24h 조회수가 같은 채널 평균 대비 몇 배.

- **Pass 1** (`:51`): `published_at+24h` ±`WINDOW_HOURS=18h` 이내 가장 가까운 stats → `view_count_24h`.
- **Pass 2** (`:85`): 채널별 누적, **n<2 채널 skip**, **leave-one-out 평균** `adjusted_mean=(Σ-v24)/(n-1)` (self-bias 방지), `ratio = round(v24/adjusted_mean, 3)`.
- **해석**: >5 viral · 2–5 strong · 1–2 solid · <1 underperform.
- **가드**: 30일 윈도 밖/근접row 없음/n<2/adjusted_mean≤0 → skip.

### 5.3 Platform Reactivity (`reactivity_dc/theqoo/instiz/naver`)
`platform_reactivity.py` · 바이럴 영상 발행 ±24h 동안 플랫폼 게시량 `after/before`.

- **상수**: `VIRAL_THRESHOLD=2.0`(샘플 영상 컷, **debut_window 1.5와 의도적 상이**), `WINDOW_DAYS=30`, `WINDOW_HOURS=24`.
- **산식** (`:47`): viral 영상별 before=`[pivot-24h, pivot)`, after=`[pivot, pivot+24h)` 카운트 → `_ratio`:
  - both 0 → None(평균 제외). before=0(after>0) → `min(5, after/1)`. else `min(after/before, 5.0)`.
- 플랫폼별 평균(`round(.,3)`, 기본 1.0, **상한 5.0**). `reactivity_sample = viral 영상 수`.
- **해석**: >2 strong reactive · 1.5–2 reactive · ~1 independent · <0.7 declining.
- 바이럴 영상 0개 → 전부 1.0, sample=0.

### 5.4 Sentiment & negative_ratio
- **분류**: **LLM(Gemini) 기반** (규칙 아님) — title만 입력, 4-클래스 {positive, negative, controversy, neutral}. 배치 `LIMIT_PER_GROUP=200`, `BATCH=50`. (§13 참조)
- **negative_ratio** (`sentiment.py:155`, 결정론): `(negative+controversy) / 분류된_글수`, `round(.,4)`. **분모는 분류된 글만**(전체 아님). classified≤0 → 0 유지.

---

## 6. Debut Window Organicity

`debut_window.py` + `frontend/src/lib/organicity.ts` + `debutWindow.ts` + `functions/lib/debutWindowBuckets.ts` · 데뷔 영상의 오가닉(진짜) vs paid 채점. **규모와 직교한 진정성 신호**. Shorts/Long-form 경로가 다름.

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
`er = (likes+comments)/max(views,1)`; `floor,ceil = (0.005,0.090) if short else (0.010,0.060)`;
`e_score = clamp(round((er-floor)/(ceil-floor)*100), 0, 100)`.

### 6.3 Balance sub-score (`_compute_balance_score`, `:160`) — 진정성(organic vs farm)
`r = likes/max(comments,1)`. SHORT `lo,hi=15,78; low_slope=5, high_slope=0.4` / LONG `lo,hi=10,50; low_slope=8, high_slope=0.5`.
- `lo≤r≤hi` → 100. `r<lo` → `max(0, 100-(lo-r)*low_slope)` (comment-farm). `r>hi` → `max(0, 100-(r-hi)*high_slope)` (like-farm).
- **Shorts 댓글 가드** (`balance_basis`, `:291`): `comment==0` → b=100(`zero_comment`); `comment<10 AND view<50K` → b=100(`insufficient_comments`). 고조회(≥50K)+소댓글은 farm 탐지 유지.

### 6.4 Velocity coherence (`_compute_velocity_coherence`, `:179`) — **Long-form 전용**
`velocity<1.5 → 50`(중립); `er≥0.03 → 100`(real); `er≥0.015 → 60`(weak); else `20`(paid burst). velocity=None → None(가중치 재분배). **Shorts는 v_score=None 강제**(`:321`, 분모 아티팩트 제거).

### 6.5 Composite (`compute_organic_score`, `:269`)
- **base 게이트**: `view<1000 AND eng_total<10` → `None`(`insufficient_data`).
- **Shorts** (`:316`): `round(0.4*e + 0.6*b)` (balance 우위).
- **Long, velocity 有** (`:337`): `round(0.5*e + 0.3*b + 0.2*v)`.
- **Long, velocity NULL**: `round(0.625*e + 0.375*b)`.

### 6.6 Verdict (`_classify_verdict`, `:202`; 프런트 `organicity.ts:16` 미러)
`≥85 organic_strong · ≥70 organic · ≥55 borderline · ≥40 suspect · <40 likely_paid`. (null/insufficient → 회색 neutral)

### 6.7 Cause 태그 (`_compute_causes`, `:226`)
`v==100→viral_real`(verdict 무관). verdict이 borderline 이하일 때: `e<40→engagement_weak`; `b<60`이면 r<lo→`comment_farm` / r>hi→`like_farm`; `v≤20→paid_burst`.

### 6.8 윈도우 버킷 (`WINDOW_BUCKETS`, `:49`; V2.34 균등 20일)
9개: `Pre(≤-71) · D-60(-70~-51) · D-40(-50~-31) · D-20(-30~-11) · D-Day(-10~+9) · D+20(10~29) · D+40(30~49) · D+60(50~69) · Post(≥70)`. 7 named × 20일, D-Day는 데뷔일 ±10. `days_relative = (published_date - debut_date).days`.
- **Undated** (V2.42, `:135`): `debut_date` 없는 그룹은 점수만 산정(산식은 데뷔일 미사용) → `"Undated"` 버킷.
- 프런트 탭은 `DISPLAY_BUCKETS` 7 named만 (`debutWindow.ts:9`); Pre/Post/Undated 비노출.
- ⚠️ `debutWindowBuckets.ts:3-7` 주석의 "15일 폭/9 named"는 **stale** — 실제는 20일 폭 7 named + Pre/Post.

### 6.9 요약 집계 (`build_summary`, `:539`)
(group, bucket)별: `organic_score_mean`(view-weighted, scored만), `organic_score_mean_simple`(count 기반 simple), long/short 별도 mean, 5종 verdict 비율(분모=scored 수), total_views/engagement(insufficient 포함).
- **헤드라인 렌즈** (V2.40, `organicity.ts:53`): `DEFAULT_ORGANICITY_MODE="all_simple"` → `organic_score_mean_simple`(고조회 아웃라이어 1개가 버킷 지배하는 것 방지). view-weighted는 toggle.
- `insufficient_data`는 video_count/total엔 포함, mean·비율 분모엔 제외. 요약은 full DELETE 후 재집계.

---

## 7. Growth Trajectory (성장 궤적)

`growth_trajectory.py` · V2.43~. 모든 그룹 자기-과거-대비 4 기둥(누적은 weekly flow로 차분, KST 일별 리샘플).

### 7.1 핵심 함수
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
- `CLIMB_THRESHOLD=0.05` (`classify_direction` %/주 경계), `COMPARE_THRESHOLD=0.10` (`_compare_direction` 7d 비교, 실제 pillar 사용).
- `ACCEL_DEADBAND_FRAC=0.02` (`|accel| < |mean|*2%` → flat).
- **calibration 가드** (V2.43.3~4): `REACH_NOISE_FLOOR=0.02`(reach 4주변동<2% → plateau/flat 강제, 구독자 양자화 방어), `MIN_COMMUNITY_VOLUME=5`, `MIN_COMMUNITY_ACTIVE_DAYS=14`(미만 → community direction=unknown).

### 7.3 4 기둥 (`compute_pillars`, `:313`)
1. **reach (도달 성장)**: `subs_change=_change_4w(subs, rel)`. **|change|<0.02 또는 None → 조회수 velocity로 fallback**(`source="views"`), 아니면 구독자(`source="subscribers"`, noise_floor 적용).
2. **engagement (호응 품질)**: `incremental_er` prefix series → `_pillar_from_values`.
3. **community (커뮤니티 모멘텀)**: trailing 7일 게시량 series. 침묵/onset 가드 → unknown.
4. **sentiment (여론)**: `negative_ratio` series, **invert=True**(하락=climbing=건강). negative_ratio 전부 ~0 → plateau remap(死신호 오플래그 방지).
- level 기둥(`_pillar_from_levels`): wow_growth=상대%. ratio 기둥(`_pillar_from_values`): wow_growth=절대 델타(pp).

### 7.4 Posture 합성 (`synthesize_posture`, `:373`)
- `PILLAR_WEIGHTS = reach 0.4 / engagement 0.3 / community 0.2 / sentiment 0.1`.
- `_DIR_SCORE = climbing+1/plateau0/declining-1/unknown0`, `_ACCEL_SCORE = accel+1/flat0/decel-1`.
- `dir_sum = Σ weight*dir_score`, `acc_sum = Σ weight*accel_score`. 임계 ±0.15.
- **라벨 6종** (V2.43.1, "하락/악화" 제거 — flow 기반이라 음수=둔화지 절대하락 아님): dir_sum>0.15 → 성장 가속/확대/확대(둔화 조짐); dir_sum<-0.15 → 성장 둔화 심화/둔화; else 성장 유지.
- **weakest**: unknown 제외 + `_pillar_score<0`인 최저 기둥, 없으면 None.

### 7.5 빌드 (`build_growth_trajectory`, `:449`)
`MIN_HISTORY_DAYS=14` 미만 → `insufficient_history`(빈 pillars). full DELETE+rebuild, 그룹당 1행.

---

## 8. Fan Loyalty — 라이브 CCV 충성도

`loyalty.py` + `FanLoyaltyCard.tsx` (V2.46~V2.47) · **CCV 절대값=규모 / 충성도=peak CCV÷구독자 전환율(규모와 직교)**.

### 8.1 상수
`WINDOW_DAYS=56`; `LOYALTY_ANCHORS=[(0.005,20),(0.015,50),(0.03,70),(0.06,88),(0.12,100)]`; `TREND_FLAT_BAND=0.10`; `MIN_BROADCASTS_FOR_TREND=4`.

### 8.2 Conversion Rate (`:121`)
방송별 peak = `MAX(concurrent_viewers)` (video_id별, 56일 윈도). `peak_med = median(방송별 peak)`. **`rate = peak_med / subscribers`**. subscribers는 최신 non-null `yt_subscribers`. subs≤0/None → insufficient.

### 8.3 Score 0–100 (`score_from_conversion`, `:55`)
`LOYALTY_ANCHORS` 구간 선형보간: `rate≤0.005 → 20`; `rate≥0.12 → 100`; 내부 `s0 + (rate-r0)/(r1-r0)*(s1-s0)`. `round(.,2)`.
- 해석: <0.5% 매우낮음, 1.5% 보통, 6%+ 매우높음. **first-pass, 라이브 분포로 보정 예정**.

### 8.4 basis (`:114-127`)
`broadcast_count(distinct video_id)`: 0 또는 subs≤0 → **insufficient**(score=None); ==1 → **low_confidence**; ≥2 → **scored**. 모든 tracked 그룹에 insufficient 행이라도 기록(카드 "축적 중").

### 8.5 ccv_trend_pct / trend_basis (`ccv_trend`, `:68`) — **표시 전용, 점수 미반영**
시간순 peak를 반으로 갈라 `pct=(median(후반)-median(전반))/median(전반)`. n<4 또는 first≤0 → unknown. `|pct|<0.10` → flat. else rising/falling.

### 8.6 Health Intimacy 주입 (V2.46)
주입 게이트 (`cli.py:1263`): `WHERE basis='scored' AND score IS NOT NULL`만 `loyalty_score` 주입(low_confidence/insufficient 제외 → 2신호 경로 → 점수 불변). `_factor_inputs`에서 `loyalty_n=clamp(score/100, 0, 1)`, Intimacy 3신호 `(eng 0.40, comm 0.30, loyalty 0.30)`.

### 8.7 프런트 헬퍼 (`FanLoyaltyCard.tsx`)
- `fmtPct(rate)`: `(rate*100).toFixed(1)+"%"`, null→`—`.
- `trendLabel`: unknown/null→`추세 보류`, flat→`→ 유지`, rising/falling→`▲/▼ ±round(pct*100)%`.
- `barWidthPct(peak, max)`: `max≤0→0`, else `peak/max*100` (호가창 깊이 막대, V2.47).
- `medianRowIndex(broadcasts, peakMedian)`: peakMedian 최근접 행. **<3 방송 또는 None → null**(동률은 최신 행).
- `scoreColor`: **≥88 emerald / ≥70 lime / ≥50 amber / <50 red** / null zinc — 밴드가 LOYALTY_ANCHORS 점수(88=6%, 70=3%, 50=1.5%)와 정렬.

> **방송수 임계 3종 주의**: basis는 `==1`에서 분기, trend는 `<4`(MIN_BROADCASTS_FOR_TREND), medianRowIndex는 `<3`.

---

## 9. Weekly Causal Diagnosis (가설 점등)

`weekly_diagnosis.py` + `weekly_diagnosis_signals.py` · 주간 신호로 인과 가설 점등(휴리스틱, 인간 검증 전제).

### 9.1 공통 임계 (`:65-71`, `:365`)
`Z_PRIMARY=1.5`, `Z_STRONG=2.0`, `ER_DROP_PAID=-0.20`, `ER_DROP_SUB_PURCHASE=-0.25`, `VPS_DROP_SUB_PURCHASE=-0.30`, `ORGANICITY_PAID=0.30`, `SUBS_Z_SUB_PURCHASE=2.5`, `CONTROVERSY_Z=2.0`.

### 9.2 `_is_lit` — 3축 OR 점등 (`:86`)
`category_z ≥ th` OR `temporal_z ≥ th` OR (`wow_pct ≥ wow_th`). 기본 th=1.5.

### 9.3 가설별 점등 규칙 (요약)
| 가설 | confidence | 핵심 규칙 |
|---|---|---|
| organic_growth | high | `|er_wow|<0.15` & lit 신호(subs/views/news/community/market_share_z≥1.5) **≥4** |
| paid_youtube_ads | high | 점수 누적 ≥3: views lit(z2.0/wow0.20)+1, views z≥1.5 & subs z<1.5 +1, er_wow≤-0.20 +1, organicity_paid≥0.30 +1 |
| subscriber_purchase | medium 캡 | 점수 ≥3: subs lit(z2.5/wow0.15)+1, vps_wow≤-0.30 +1, er_wow≤-0.25 +1. vps_wow=None → 차단 |
| comeback_cycle | high/medium | 점수 ≥2: hanteo>0/chart≤30/streak≥3/news lit(z2.0)/upload_z≥1.5/event_match. score≥3 또는 event → high |
| controversy_spike | high | controversy_z/negative_z/twitter_z/keyword_z 중 하나 ≥2.0 (OR), 인간검증 강제 |
| platform_concentrated | high/medium | reactivity dominant + support lit(z2.0). max_z≥2.5 → high |
| member_centric_spike | high/medium | top1_wow≥0.10 또는 hhi_wow≥0.15, 그룹 subs/views lit 동반. top1≥0.60 → high |
| broadcast_appearance | medium | news_z_prev≥3.0 & community lit |
| community_word_of_mouth | medium | community_z_prev≥2.0 & (subs 또는 views) lit |

### 9.4 메타 가드 / dampen
- `_confidence_dampen`: high→medium→low (1단계).
- comeback 또는 member_centric 점등 시 paid_youtube_ads/subscriber_purchase를 **1단계** 감점(이유 수 무관).
- `apply_meta_guards` (`:490`): `irrelevant_ratio≥0.15` 또는 `data_source_backfill>0.5` → 모든 가설 1단계 감점.

### 9.5 순수 시그널 함수 (`weekly_diagnosis_signals.py`)
- `engagement_rate_from_agg`: `(likes+5*comments)/views` (health_score 단일출처).
- `er_wow` / `vps_wow`: `(now-prev)/prev`, prev=0 → None. (⚠️ docstring "max(prev,1)"과 코드 불일치 — 실제 `/prev`.)
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

- 상수: `POOL_CAP=150`, `SEED_QUERIES` 5개, 최근 7일·`order=viewCount`·조회수 상위.
- **`select_and_rank` 점수** (`:162`): `score = (views/max_views)*0.7 + (recent_shorts/max_shorts)*0.3`. meme(비-댄스)은 상위 `min_meme=3` 보장, 나머지 score순으로 `total=10`개.
- `measure_challenge`: 해시태그 블라인드 검색 → `yt_recent_shorts=len(ids)`, `yt_total_views=sum(views)`.
- pool-grounded 필터: candidate id가 viral pool에 1개+ 있어야 유지(환각 차단). example clips 상위 3개.

---

## 11. Relevance / News Filter 게이트

분류 게이트(boolean), 수치 산식 아님.

### 11.1 `is_relevant` (`relevance.py:121`)
순서: ① `is_global_spam` → False. ② **long-token fast path**: context keyword 중 `len≥3 & not blocked & in title` → True. ③ **short-token anchor gate**: short token + `_has_anchor`(그룹명 영/한 in title) → True. else False.
- `SHORT_TOKEN_THRESHOLD=3`. `GENERIC_KEYWORD_BLOCKLIST`(버추얼/virtual/IPX/ABYSS/Zero/URL/모카/마냥 등)는 strict 모드에서 길이 무관 anchor 강제(DcCollector supplemental 전용).
- `is_global_spam`: {양도, 팝니다, 삽니다, 단톡, [광고], 굿즈 거래, 택포…} substring.

### 11.2 `NewsFilter.evaluate` (`news_filter.py:42`)
순서: context keyword 없음 → 거부. 날짜 파싱 불가 → 거부. **`_allow_after = debut - 365일`보다 이른 기사 → 거부**. blacklist phrase → 거부. else 통과. (배제도 is_excluded=1+reason 저장)

---

## 12. 클라이언트 계산

### 12.1 shortsTrend.ts
`FRESH_DAYS=14`, `FRESH_VELOCITY=2.0`(🔥 배지), `MIN_VIEWS_FLOOR=5000`(velocity 랭킹 floor).
- `isFresh`: `daysSince≤14 & velocity≥2.0`. `velocityEligible`: `views≥5000 & velocity!=null`.
- 정렬: recent(일수↑) / views(↓) / velocity(eligible 먼저) / fresh(isFresh 먼저).

### 12.2 alerts.ts
`CONTROVERSY_SPIKE_MULTIPLIER=2.0`(전주 2배), `CONTROVERSY_SPIKE_MIN_COUNT=5`(floor). worker `alerts/`와 미러링(drift 테스트 가드). 나머지는 라벨/톤 매핑(산식 아님).

### 12.3 shortsDiagnostic.ts (MiiWAN Shorts 운영 진단 — organicity와 별개)
- 임계 `T` (`:174`): breakout(good10/warn3↑), cv(0.8/0.4↑), band(0.4/0.7↓), coverage(80/40↑), decoration(20/50↓), hashtag(50/20↑), er(4/2↑), velocity(2/1↑). `SMALL_SAMPLE=5`.
- 지표: `breakoutRatio=max/median`, `bandConcentration`=median±40% 비중, `coefficientOfVariation=stdev/mean`, `normalizedHHI=(hhi-1/n)/(1-1/n)`, `cadenceDays`=인접 gap 중앙값, `avg_er=(likes+comments)/views*100` 평균, `ceiling_vs_subs=median(views)/subs`.
- `statusByThresholds`: higher면 `≥good→good/≥warn→warn/else bad`, lower면 부등호 반대.

---

## 13. LLM 기반(비-결정론) 항목

다음은 Gemini 판단에 의존 — 결정론 산식 아님(프롬프트 엔지니어링·환각 가드만 존재):
- **Sentiment 4-클래스 분류** (`sentiment.py`) — title만 입력, {positive/negative/controversy/neutral}. *negative_ratio 산식 자체는 결정론(§5.4).*
- **Weekly 인사이트 본문** (`llm/weekly.py`, `prompts.py`) — D-N 카운트다운/코호트 베이스라인은 결정론 컨텍스트 주입(`_debut_countdown`), 본문 서술은 LLM. ANALYSIS DEPTH/환각 가드 적용(V2.31/2.45).
- **Challenge 분류** (`challenge_scan.py`의 `CHALLENGE_CLASSIFY`) — meme/dance·momentum 판정. *측정 점수(§10)는 결정론.*
- **Music show 파싱** (`llm/music_show.py`).

---

*문서 끝. 정확도가 의심되면 항상 인용된 `파일:라인`의 코드를 진실의 원천으로 확인할 것.*
