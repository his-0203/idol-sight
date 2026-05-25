# 주간 인사이트 인과 진단 (Causal Diagnosis) — 설계

- **상태**: 설계 완료, 사용자 검토 대기 (2026-05-25, rev 2 — 수집 데이터 풀 전수 활용 반영)
- **선행 작업**: V2.5 4-factor Health Score, V2.22 debut_window_organicity, V2.20 ipx_action prompt hardening
- **후속 작업**: writing-plans → 구현 계획 → 마이그레이션 0066 + worker 모듈 + 프롬프트 업데이트

---

## 1. 동기

현 weekly LLM 시스템은 `agg_summary_last_7d` / `prev_7d` / hanteo / market_share / naver_news 를 LLM 에게 그대로 넘기고 4–8개 카드를 자유 추론하게 한다. 결과:

- "PLAVE 구독자 +24K, ISEDOL +6K" 류 *수치 나열* 카드가 다수.
- 변화의 *원인*은 LLM 자유 추론이라 환각·일관성 결여.
- 운영자는 "이게 광고 캠페인 결과인가, 컴백 효과인가, 자연 유입인가, sub 구매 흔적인가"를 *자기 머리로* 다시 판단해야 함 → BI 의 부가가치 손실.

목표: 매주 그룹별 변화에 대해 **검증 가능한 시그널 다발**을 worker 가 사전 진단하고, 그 위에서 LLM 이 **인과 가설(주가설 + 대안가설)** 을 자연어로 작성하게 한다.

debut_window_organicity 가 영상-단위에 대해 이미 같은 패턴 (per-video 0–100 score → 5-tier verdict → causes 태깅) 으로 작동한다. 이번 spec 은 그 패턴을 **주간·그룹-단위** 로 확장한다.

---

## 2. 비목표

- **봇 unique-source 분석** (community post 별 작성자 다양도, IP 패턴) — 별도 spec.
- **시계열 lag 자동 학습** — 휴리스틱 고정 윈도우로 시작; 학습형 lag detection 은 보류.
- **광고 채널 식별** (YouTube ads / GDN / Meta / 네이버 등) — 외부 지표만 보고 가설; ad-platform 직접 연동 없음.
- **본체 추적** — 가설은 모두 *그룹 단위 metric 변동* 만으로 도출. 멤버 본체 정보는 입력에서 제외 (CLAUDE.md §윤리 가이드라인).
- **`fan_milestone_event` 가설** — twitter `_classify_tweet` 분류가 현재 4종(controversy/news/event/content)뿐이라 milestone/love 분류 미흡 → V2 deferred.
- **`chart_long_tail` 가설** — 케이스 드물고 운영자 가치 낮음 → V2 deferred.

---

## 3. 가설 카탈로그

11개 enum + 1개 메타가드. 모든 시그널은 *주간 z-score 또는 비율 임계치* 로 정의되어 unit test 가능.

### 3.1 본 카탈로그 (11)

| key | 의미 | 점등 조건 (요지) | 신뢰도 기여 |
|---|---|---|---|
| `organic_growth` | 자연 유입 | subs z≥1.5 ∧ views z≥1.5 ∧ engagement_rate 안정 ∧ community/news 동기 상승 ∧ market_share 동기 상승 | 시그널 4개 이상 점등 시 high |
| `paid_youtube_ads` | 유튜브 광고 | views z≥2.0 ∧ engagement_rate WoW −20% 이상 ∧ subs/views 비율 평탄 ∧ debut_window_video_organicity verdict=suspect+likely_paid 비중 ≥30% ∧ (보조) youtube_videos.tags 광고성 패턴 매칭 | 시그널 3+개 점등 시 high |
| `subscriber_purchase` | 구독자 구매 의심 | subs z≥2.5 ∧ views-per-sub WoW −30% 이상 ∧ engagement_rate WoW −25% 이상 ∧ community 활성 평탄 | 시그널 3+개 점등 시 medium (검증 어려움 — 항상 단정 회피) |
| `comeback_cycle` | 컴백 효과 | (hanteo_sales>0 ∨ music_show_wins>0 ∨ chart_peak≤30) ∧ naver_news z≥2 ∧ video_upload count z≥1.5 ∧ (보조) group_events 매칭 ∨ music_show_wins_log 연속 1위 | 시그널 2+개 점등 시 high; group_events 매칭 시 ground truth 부스트 |
| `broadcast_appearance` | 방송/외부 출연 | 특정 날짜에 naver_news spike (1일 z≥3) + 3–7일 lag 후 community/views 점진 상승 + community_keywords 에 방송명·프로그램명 키워드 등장 | lag 패턴 일치 시 medium |
| `community_word_of_mouth` | 입소문 | community 7d z≥2 ∧ 다음 주 동일 그룹 subs/views z≥1.5 (lag 1주) ∧ community_keywords 토픽이 자체 콘텐츠 (앨범명/멤버명/공식 콘텐츠) 우세 | medium |
| `controversy_spike` | 논란 | controversy_count z≥2 ∨ negative_sentiment_ratio z≥2 ∨ twitter type='controversy' spike ∨ community_keywords 에 부정 키워드 (논란/사과/의혹 등) 누적 z≥2 | 하나라도 점등 시 high (인간 검증 필수 강제 문구) |
| `platform_concentrated_promo` | 표적 플랫폼 캠페인 | reactivity_{single} ≥ 2.5 ∧ 다른 플랫폼 reactivity_* < 1.3 ∧ naver_news z 또는 해당 platform community z 단독 ≥ 2 | 단일 플랫폼 dominance + 외부 출처 미식별 시 medium-high |
| `member_centric_spike` | 멤버 중심 spike | top1_share WoW +10pt 이상 ∨ hhi_norm WoW +0.15 이상 ∧ 그룹-차원 subs/views z≥1.5 | top1_share 절대치 ≥0.6 시 high — segmentary/confederation 가설 우선 평가 |
| `organic_growth` 외 모든 가설은 `member_centric_spike` 와 직교 평가 | — | member-centric 점등 시 그룹-차원 paid/sub_purchase confidence 감점 (1명의 외부 출연/솔로 활동이 그룹 spike를 일으키는 일반적 패턴) | — |
| `insufficient_signal` | 노이즈 | 위 모든 가설 점등 안 됨 (모든 변화 z<1.5) | — diagnosis 카드 emit 금지 |

### 3.2 메타가드 — `data_credibility_warning`

별도 가설로 emit 하지 않고, 다른 모든 가설의 confidence 를 자동 감점하는 가드.

| 점등 조건 | 효과 |
|---|---|
| user_flagged_irrelevant 비율이 주간 community_posts 의 ≥ 15% | 모든 가설 confidence 한 단계 감점 |
| agg_summary `data_source='manual_seed'` 또는 backfill 행이 7d window 의 과반 | 모든 가설 confidence 한 단계 감점 |
| reactivity_sample < 3 (viral-driver 표본 부족) | platform_concentrated_promo 가설 자체 차단 |

메타가드 점등 시 diagnosis body 에 "데이터 신뢰성 주의 — [원인]" 한 줄 강제 첨부 (LLM 프롬프트에서 처리).

### 3.3 변별 키 정리

- **자연 유입이 가장 까다로움** (5개 동시 점등 요구) — 운영자가 "이건 자연 유입" 이라고 부를 만한 케이스는 정말 동시 상승 케이스만.
- **paid_ads vs sub_purchase 의 핵심 변별**: paid_ads는 *views 가 폭증하지만 sub 증가는 비례하지 않음* (광고 시청자는 구독하지 않음), sub_purchase는 *sub 만 폭증하고 view 는 따라오지 않음*. 둘 다 engagement rate 하락은 공통.
- **comeback_cycle 우선순위**: 가장 *겹치는 시그널* 이 많아서 우선 평가. group_events ground truth 가 매칭되면 다른 ambiguous 가설(paid/sub_purchase) confidence 한 단계 감점. 컴백 시즌에는 자연스럽게 광고도 같이 돌릴 가능성이 높지만, 그건 "광고 의심" 이 아니라 "컴백 캠페인" 으로 명명해야 옳음.
- **member_centric_spike 우선순위**: segmentary(ISEDOL)/confederation(STELLIVE) 그룹에서는 멤버 1명의 솔로 활동이 그룹 단위 spike 를 일으키는 패턴이 일상적. 그룹-차원 paid/sub_purchase 가설보다 먼저 평가하여 점등되면 다른 가설 감점.
- **platform_concentrated_promo 우선순위**: organic_growth 보다 먼저 평가. 한 플랫폼만 spike 면 organic 후보에서 자동 제외 (organic 은 정의상 다중 플랫폼 동기 상승).

---

## 4. 아키텍처

```
agg_summary(7d, 14d) + reactivity_*       ┐
debut_window_video_organicity(주간 분포)  │
hanteo_weekly, music_show_wins_log, chart │
naver_articles(주간 분포)                 │
community_posts (+ user_flagged_*,        │  → analysis/weekly_diagnosis.py
                  sentiment)              │     compute_group_signals()
community_keywords (주간 토픽 분포)       │     classify_hypotheses()
twitter_posts (type 분류)                 │     apply_meta_guards()
agg_member_pop_meta                       │     ↓ signals dict (가설 + evidence + confidence)
  (hhi_norm, top1_share, top3_share)      │     ↓
group_events (ground truth)               │     ↓
agg_market_share                          │     ↓
youtube_videos.tags                       ┘     ↓
                                                ↓
                               llm/prompts.py PROMPT_WEEKLY (개정)
                               llm/weekly.py build_context() (signals 추가)
                                                ↓
                                           gemini.generate()
                                                ↓
                                     insights 테이블 INSERT
                                     (signals_json 컬럼 신설 — migration 0066)
```

### 4.1 `analysis/weekly_diagnosis.py` 모듈

```python
def compute_group_signals(
    *,
    db: _Executor,
    week_start: str,
    week_end: str,
) -> dict[str, GroupSignals]:
    """그룹키 → GroupSignals.

    GroupSignals 는 dataclass:
      group_key: str
      deltas: dict[str, float]              # subs/views/news/community WoW + z-score
      organicity: dict[str, float] | None   # 주간 신규 영상의 organicity 분포 요약
      hypotheses: list[Hypothesis]          # 점등된 가설 목록 (confidence 정렬)

    Hypothesis 는 dataclass:
      key: str           # 카탈로그 enum
      confidence: str    # 'high' | 'medium' | 'low'
      evidence: list[str]  # 점등된 시그널 라벨 (예: ['views_z=2.4', 'er_drop_28%', 'organicity_suspect_42%'])
    """
```

### 4.2 LLM 컨텍스트 확장

`llm/weekly.py build_context()` 에 `signals_by_group: dict[str, GroupSignals dict]` 키 추가.
LLM 은 시그널이 *점등된* 가설만 자연어로 옮길 수 있고, 시그널 없는 가설은 거론 금지 (프롬프트 강제).

### 4.3 프롬프트 변경 (`llm/prompts.py`)

새 섹션 `_DIAGNOSIS_GUIDELINES` 추가:

- `type='diagnosis'` 카드의 작성 규칙:
  - 시그널 dict 의 `hypotheses[0]` 가 *유력 가설*, `hypotheses[1]` (있으면) 가 *대안 가설*.
  - body 구조: "**[그룹] 주간 변화 요약 한 문장.** [시그널 점등 사실 인용]. [유력 가설 — '...일 가능성']. 대안: [대안 가설 — '... 가능성 중'].".
  - 단정 어조 금지 (`-이다`, `-임` 금지 → `-일 가능성`, `-로 시사`, `-의심`, `-신호`).
  - `controversy_spike` 가설 카드는 body 마지막에 "PR팀 검수 후 대응, 직접 삭제·정정 요청 금지 (Streisand 회피)" 강제 1줄.
  - `subscriber_purchase` 카드는 항상 confidence='medium' 로 캡 (단정 회피).
  - source_refs: 시그널이 인용한 행 (agg_summary, debut_window_video_organicity, naver_articles 등) 1–3개.
  - ai_comment 는 *운영자 함의 한 줄* — 기존 가이드라인 그대로.

- MiiWAN scope diagnosis 는 `type='ipx_action'` 으로 변환:
  - 경쟁사에서 `paid_youtube_ads` 점등 → "PLAVE 광고 캠페인 의심 — Abyss 마케팅팀 ↔ IPX MiiWAN D-30 광고 검토 회의 [날짜] 까지 소집" 류 액션.
  - 경쟁사에서 `organic_growth` 점등 → "콘텐츠 캘린더 벤치마킹 — [그룹] 주간 영상 캡처 및 콘텐츠팀 공유" 류.

### 4.4 데이터 모델 변경

migration 0066 (0065 는 `isedol_dc_gallery_fix` 가 선점):

```sql
ALTER TABLE insights ADD COLUMN signals_json TEXT;
-- NULL = legacy 카드 (기존 4-8개 그대로). NOT NULL = diagnosis 카드의 signals dump.
-- payload 형식: {"hypothesis_primary": "paid_youtube_ads", "hypothesis_alternative": "broadcast_appearance", "confidence": "high", "evidence": ["views_z=2.4", ...], "meta_guards": ["irrelevant_flagged_18%"]}
```

기존 type enum (`insight` / `weekly` / `ipx_action`) 에 `diagnosis` 추가. enum constraint 는 D1 에는 없으므로 코드 레벨 검증.

### 4.5 빈도와 트리거

- weekly cron 이 weekly_diagnosis → LLM 순으로 호출 (worker/cli.py 에 `weekly-diagnosis` 서브커맨드 추가).
- 일 단위 호출은 비목표 (시그널 자체가 7일 WoW z-score 기반).

---

## 4.6 Evidence 보강 매핑 (수집 중인 데이터 풀 전수 활용)

기존 weekly LLM 시스템이 사용하지 않던 수집 데이터를 가설 evidence 로 흡수.

| 가설 / 메타가드 | 추가 evidence 소스 | 활용 방식 |
|---|---|---|
| `comeback_cycle` | `group_events` (debut/comeback/album_release/show_win) | event_date ± 7d 윈도우 매칭 시 ground truth 부스트 (confidence 한 단계 상승) |
| `comeback_cycle` | `music_show_wins_log` 연속 1위 패턴 | 동일 곡 3회 이상 연속 1위 시 momentum 강신호로 표시 |
| `controversy_spike` | `community_keywords` 부정 키워드 (논란/사과/의혹/해명) | 키워드 카운트 z≥2 시 evidence 칩 추가 |
| `community_word_of_mouth` | `community_keywords` 토픽 분포 | 자체 콘텐츠 (앨범명/멤버명/공식 캠페인) 우세면 wom 가설 강화, 외부 키워드 (방송명) 우세면 broadcast_appearance 로 재라우팅 |
| `broadcast_appearance` | `community_keywords` 방송·프로그램명 키워드 | 외부 매체 키워드 spike 시 broadcast 가설 evidence |
| `paid_youtube_ads` | `youtube_videos.tags` (V2.50) | 영상 태그에 광고용 일반어 (예: 'shorts', 영문 generic), 스폰서 패턴 검출 시 evidence 칩 추가 (단 약신호 — 단독 확정 금지) |
| `organic_growth` | `agg_market_share` z-score | 자기 share 상승 + 시장 전체 share 분산 안 줄어듦 = 진짜 organic (시장 폭락 중 우리만 약진은 별도 신호) |
| `platform_concentrated_promo` | `reactivity_dc/theqoo/instiz/naver` | 단일 플랫폼 reactivity ≥2.5 ∧ 나머지 <1.3 시 점등. 0011 마이그레이션의 컬럼이 이미 채워져 있어 V1 즉시 활용 |
| `member_centric_spike` | `agg_member_pop_meta.hhi_norm / top1_share / top3_share` | top1_share WoW +10pt 또는 hhi_norm WoW +0.15 시 점등. segmentary/confederation 모델 그룹에서 우선 평가 |
| 메타가드 `data_credibility_warning` | `community_posts.user_flagged_irrelevant` | 주간 community_posts 중 flagged 비율 ≥15% 시 모든 가설 confidence 한 단계 감점 |
| 메타가드 | `agg_summary.data_source` (manual_seed / backfill) | 데이터가 자동 수집이 아닌 수동 시드/백필이면 메타가드 점등 |

### 4.7 evidence 칩 데이터 구조 (signals_json payload)

```json
{
  "hypothesis_primary": "paid_youtube_ads",
  "hypothesis_alternative": "broadcast_appearance",
  "confidence": "high",
  "evidence": [
    {"key": "views_z", "value": 2.4, "label": "주간 조회 z=2.4"},
    {"key": "engagement_rate_wow", "value": -0.28, "label": "ER −28%"},
    {"key": "organicity_paid_ratio", "value": 0.42, "label": "신규 영상 paid 의심 42%"},
    {"key": "subs_views_ratio_wow", "value": -0.05, "label": "subs/views 비율 평탄"},
    {"key": "ground_truth_event", "value": null, "label": "group_events 매칭 없음"}
  ],
  "meta_guards": []
}
```

frontend V2 가 이 payload 를 evidence 칩으로 렌더링 (V1 은 텍스트 body 만).

## 5. 신뢰도 (confidence) 계산

각 가설마다:

1. **시그널 카운트**: 점등된 시그널 수.
2. **z-score 크기**: 가장 큰 z 가 임계 대비 얼마나 큰가.
3. **가설 간 충돌 보정**: `comeback_cycle` 점등 시 `paid_youtube_ads` / `subscriber_purchase` 의 confidence 한 단계 감점 (컴백 시즌 자연 광고 동반 효과).
4. **MiiWAN 부스트**: scope=miiwan 이면 시그널 1개 기준치 완화 (자사는 더 적극적). 경쟁사는 보수적.

```python
def confidence(hyp_key: str, signals_lit: int, max_z: float,
               comeback_active: bool, is_miiwan: bool) -> str:
    # 기본: 시그널 ≥3 ∧ max_z ≥ 2.5 → high
    #       시그널 ≥2 ∧ max_z ≥ 1.8 → medium
    #       나머지 → low
    # subscriber_purchase 는 항상 medium 캡 (검증 어려움 — 단정 회피).
    # controversy_spike 는 시그널 1개 점등 시에도 high (인간 검증 필수 강제).
    # comeback_active 면 paid/sub_purchase confidence 한 단계 감점.
```

`low` 가설은 LLM 컨텍스트에 *포함되지 않음* → 카드 emit 자체가 차단됨. 운영자 noise 방지.

---

## 6. 윤리 가드

CLAUDE.md §윤리 가이드라인 준수:

1. **본체 정보 미입력**: signals 계산에 사용하는 raw 입력은 모두 그룹-단위 집계 (subs, views, news 카운트, 영상 통계). 멤버 본체 키워드/이름은 입력에서 제외.
2. **2차 창작 트래킹 양만**: community count 만, 본문 내용은 LLM 에 노출 안 됨.
3. **controversy 가설**: 단정 어조 금지 + "PR팀 검수 후 대응, 직접 삭제·정정 요청 금지 (Streisand 회피)" 강제 1줄. False positive 가 인간 검증 없이 알림 채널로 새어나가지 않도록.
4. **자사 그룹 깊이, 경쟁사 외형**: 경쟁사 diagnosis 는 외형 신호 (subs/views/news/chart) 만, MiiWAN diagnosis 는 community/sentiment 까지 깊이 봄.

---

## 7. 컴포넌트 분리

| 모듈 | 책임 | 입력 | 출력 |
|---|---|---|---|
| `analysis/weekly_diagnosis.py` | 시그널 계산 + 가설 분류 + confidence | DB executor, week_start, week_end | `dict[group_key, GroupSignals]` |
| `analysis/weekly_diagnosis_signals.py` (내부) | 개별 시그널 함수 (`subs_z`, `views_z`, `er_wow_drop`, `organicity_suspect_ratio` 등) | raw row, prev row | 시그널 점등 여부 + 강도 |
| `llm/weekly.py` | 기존 build_context + signals 추가 | DB | 기존 + signals_by_group |
| `llm/prompts.py` | `_DIAGNOSIS_GUIDELINES` + canonical hypothesis enum block | — | PROMPT_WEEKLY |
| `migrations/0066_insights_signals_json.sql` | 컬럼 신설 | — | — |
| `cli.py` | `weekly-diagnosis` 서브커맨드 (run-once + cron 통합) | — | — |
| `tests/test_weekly_diagnosis.py` | 카탈로그 8개 점등 케이스 단위 테스트 | synthetic agg rows | 가설/confidence/evidence |

각 모듈의 단일 책임:
- `weekly_diagnosis_signals` 는 *순수 함수* (DB 의존 없음) — fixture 로 단위 테스트.
- `weekly_diagnosis` 는 *오케스트레이션* (DB → signals 호출 → 가설 매칭).
- `weekly.py` 는 *컨텍스트 빌더* (signals 를 LLM 입력으로 직렬화만).
- `prompts.py` 는 *프롬프트 카피라이팅* (시그널 → 카드 어조 변환 규칙).

---

## 8. 테스트 전략

`tests/test_weekly_diagnosis.py`:

- 카탈로그 11개 + insufficient + 메타가드 케이스, 총 13개 시나리오의 synthetic agg row pair (`last_7d` + `prev_7d`):
  - `test_organic_growth_all_signals_lit`: subs/views/community/news/market_share 모두 z≥1.5 → confidence=high
  - `test_paid_ads_views_no_sub_growth`: views z=3, subs z=0.3, ER drop 30% + organicity paid 비중 42% → paid_youtube_ads confidence=high
  - `test_paid_ads_with_ad_tags`: 위 + youtube_videos.tags 광고성 매칭 → evidence 칩 추가, confidence 유지
  - `test_sub_purchase_inverse`: subs z=3, views z=0.4, ER drop 35% → subscriber_purchase confidence=medium (캡 적용)
  - `test_comeback_full_cycle`: hanteo + chart + news + video upload spike → comeback_cycle confidence=high
  - `test_comeback_ground_truth_boost`: 위 + group_events 매칭 (event_date 윈도우 내) → confidence high 유지, evidence "group_events ground truth" 표시
  - `test_broadcast_appearance_lag`: 7일 전 news spike + 3일 후 community/view 점진 + community_keywords 방송명 키워드 → broadcast_appearance confidence=medium
  - `test_community_wom_lag`: 전주 community spike + 이번 주 sub/view 상승 + community_keywords 자체 콘텐츠 우세 → community_word_of_mouth confidence=medium
  - `test_controversy_one_signal_high`: controversy_count z=2.1 단독 점등 → controversy_spike confidence=high (인간 검증 강제)
  - `test_platform_concentrated_promo`: reactivity_naver=3.0, dc/theqoo/instiz <1.3, naver news z=2.5 → platform_concentrated_promo confidence=medium-high
  - `test_member_centric_spike_isedol`: ISEDOL top1_share +12pt, 그룹 subs z=2.0 → member_centric_spike confidence=high, 그룹-차원 paid 가설 자동 감점
  - `test_meta_guard_irrelevant_dampens`: organic 시그널 4개 점등 + user_flagged_irrelevant 18% → confidence high → medium 강제 감점, body 에 "데이터 신뢰성 주의" 첨부
  - `test_insufficient_all_z_low`: 모든 z<1.5 → diagnosis emit 안 됨
  - `test_comeback_dampens_paid`: 컴백 시그널 + paid 시그널 동시 → paid confidence 한 단계 감점 (medium → low) 후 emit 차단

LLM 측 통합 테스트는 별도 — Gemini stub 으로 PROMPT_WEEKLY 가 signals 를 올바르게 인용하는지 확인.

---

## 9. 점진 도입

V1 (이번 spec 범위):
- migration 0066 적용 (0065 충돌 회피).
- `weekly_diagnosis.py` + `weekly_diagnosis_signals.py` (순수 함수) + 단위 테스트.
- 가설 11개 + 메타가드.
- 활용 데이터: agg_summary(reactivity_* 포함), debut_window_video_organicity, hanteo, music_show_wins_log, melon_chart, naver_articles, community_posts(+user_flagged_irrelevant), community_keywords, twitter_posts, agg_member_pop_meta, group_events, agg_market_share, youtube_videos.tags.
- `prompts.py` `_DIAGNOSIS_GUIDELINES` 섹션 + 카탈로그 enum 블록 + few-shot exemplar 3개 (paid_ads, comeback w/ ground truth, member_centric_spike).
- `weekly.py` build_context 에 signals 추가.
- `cli.py weekly-diagnosis` 서브커맨드.
- weekly cron 에 endpoint 연결.

V2 (다음 spec):
- `fan_milestone_event` 가설 — twitter `_classify_tweet` 에 milestone/love 분류 추가 후 활성화.
- `chart_long_tail` 가설 — 운영자 가치 검증 후 결정.
- community post 작성자 unique-source 분석 (봇 farm 직접 탐지).
- 시계열 lag 자동 학습 (현재 broadcast/wom 의 3–7일 lag 가 고정 — 그룹별 학습형 검출).
- frontend dashboard 에 signals_json 시각화 (가설별 evidence 칩, confidence 게이지).
- diagnosis 카드 위에 *human override* — 운영자가 가설을 confirm/reject 하면 다음 주 confidence 가중치 학습.

---

## 10. 회귀 방지

- 기존 `insight` / `weekly` / `ipx_action` 카드는 *signals_json 컬럼 NULL* 로 작성 — 기존 frontend 렌더링 무영향.
- `diagnosis` 카드는 새 type — frontend 가 모르면 plain insight 처럼 fallback 렌더링 (Whimsy 손실 없음).
- migration 0066 은 ADD COLUMN 한 줄 — rollback 시 컬럼 무시만 하면 됨.
- LLM 프롬프트 변경은 비파괴: 시그널 없는 케이스에는 `type='diagnosis'` 가 생성되지 않음 (insufficient_signal 이 강제 차단).
- weekly_diagnosis 가 빈 dict 반환 (시그널 데이터 미수집) 시 LLM 은 기존 4–8개 카드 모드로 폴백.

---

## 11. 운영자 UX (frontend 변경 없음, V1 한정)

V1 은 worker + 프롬프트만 변경. 카드는 기존 WeeklyUpdate/Insights/MiiWANBriefing 뷰에 그대로 표시되며, type='diagnosis' 카드의 body 가 "유력 가설 + 대안 가설" 형식이라는 것이 운영자 눈에 보이는 유일한 차이. ai_comment 한 줄로 함의 전달.

V2 에서 frontend 가 signals_json 를 읽어 evidence 칩/confidence 게이지를 렌더링하면 더 풍부해지지만, V1 은 텍스트로도 운영 가능하므로 frontend 작업 없이 가치 전달.

---

## 12. 후속

이 spec 이 승인되면 `superpowers:writing-plans` 로 단계별 구현 계획 작성:
1. migration 0066
2. weekly_diagnosis_signals 순수 함수 + 단위 테스트 (TDD)
3. weekly_diagnosis 오케스트레이션
4. cli.py 서브커맨드
5. prompts.py 가이드라인 + few-shot
6. weekly.py build_context 통합
7. weekly cron workflow 추가
8. end-to-end 통합 검증 (synthetic week)

---

## 13. rev 3 amendment — cohort 카테고리 분리 + temporal z + WoW% 신호 (2026-05-25)

### 13.1 동기

첫 production 운영 (week 2026-05-17~23) 에서 `causal_diagnosis: groups=9 hypotheses_lit=0` 발생. 진단:
- 9 그룹 cohort 가 **bimodal** — ISEDOL/STELLIVE/PLAVE (head) + 나머지 6 (tail).
- 표준편차가 거대해서 cross-sectional z-score 가 거의 모든 그룹에 대해 임계치 미달.
- 운영 데이터에서 자연 발생 spike (subs +5% 등) 가 시그널화 되지 않음.

근본 원인은 *측정 방향* 불일치:
- 현 z-score: "이번 주 cohort 중 큰 그룹인가" (절대 크기)
- 운영자가 원하는 신호: "이번 주 자기 history 대비 spike 인가" (변화)
- 그리고 K-POP 그룹 (corporate) 과 서브컬쳐 그룹 (segmentary/confederation) 은 *지표 스케일이 한 자릿수 다름* — 같은 cohort 에서 비교하면 항상 서브컬쳐가 outlier.

### 13.2 변경 사항

**A. cohort 카테고리 분리** (group_model 컬럼 재활용 — 새 migration 불필요)

```python
def _category_of(group_model: str) -> str:
    """K-POP/서브컬쳐 분류."""
    return "kpop" if group_model == "corporate" else "subculture"
```

- **kpop cohort**: PLAVE, MiiWAN, SKINZ, OWIS, MY:RAKL, B:DAWN, wegosix (7개)
- **subculture cohort**: ISEDOL, STELLIVE (2개)

cross-sectional z 는 *같은 카테고리 안에서* 만 계산. subculture cohort 가 2개라 stdev 변별력 약하므로 N<3 fallback (cross-sectional z=0, temporal+WoW 만 사용).

**B. temporal z-score** (`weekly_diagnosis_signals` 에 새 함수)

같은 그룹의 직전 N주 weekly snapshot 분포 대비 이번 주 z-score. N=8 (충분한 표본 + 너무 멀지 않은 history).

```python
def temporal_z_score(
    now_value: float, history: list[float],
) -> float:
    """동일 그룹의 historical 분포 대비 z. cohort_z_score 와 동일 계산, semantically 다름."""
    return cohort_z_score(now_value, history)
```

history 추출 SQL:
```sql
SELECT MAX(snapshot_at) AS week_last_snap, group_key, yt_subscribers, ...
FROM agg_summary
WHERE group_key = ? AND substr(snapshot_at,1,10) < ?
GROUP BY group_key, substr(snapshot_at,1,7)   -- 월 단위 last snap
ORDER BY week_last_snap DESC LIMIT 8
```

**C. WoW % change 임계** (`weekly_diagnosis_signals` 에 새 함수)

```python
def wow_pct(now_value: float | None, prev_value: float | None) -> float | None:
    """직전 주 대비 % 변화. prev=0/None 이면 None (dead signal)."""
```

임계치 (initial — 운영 데이터 보면서 calibration):
| 지표 | organic 점등 | paid/spike 점등 |
|---|---|---|
| subs WoW | ≥ 5% | (조정 안 함) |
| views WoW | ≥ 8% | ≥ 20% (paid_youtube_ads 의심 시) |
| news WoW | ≥ 30% | — |
| community WoW | ≥ 30% | — |

**D. 가설 점등 조건 — 세 신호 OR 결합**

각 시그널 (subs/views/news/community) 의 lit 판정:
```python
def _is_lit(z_category: float, z_temporal: float, wow: float | None, 
            *, z_threshold: float, wow_threshold: float) -> bool:
    return (
        z_category >= z_threshold
        or z_temporal >= z_threshold
        or (wow is not None and wow >= wow_threshold)
    )
```

`_check_*` 함수들이 이 helper 를 호출. 셋 중 *하나만* 점등이어도 그 시그널은 lit. routine 변동 (1-2%) 은 모두 미달, 진짜 spike 는 어느 한 축에서 잡힘.

**E. evidence chip 풍부화**

기존 evidence 는 한 가지 z 값만. rev 3 에서는 어느 축에서 점등됐는지 명시:
```python
Evidence("subs", value, label="구독 spike — kpop z=2.1, temporal z=1.8, WoW +6.2%")
```

LLM 이 이 라벨을 그대로 카드에 인용 가능. signals_json payload 에도 반영.

### 13.3 영향 받는 가설

| 가설 | rev 2 (cross-sectional only) | rev 3 (3 신호 OR) |
|---|---|---|
| organic_growth | subs/views/news/community/market_share z ≥ 1.5 가 4개+ | 같은 5개 시그널이 *(category z OR temporal z OR WoW%)* OR 점등이 4개+ |
| paid_youtube_ads | views_z ≥ 2.0 + ER drop + organicity + subs/views gap | views: category z ≥ 2.0 OR temporal z ≥ 2.0 OR WoW ≥ 20%; 나머지 동일 |
| subscriber_purchase | subs_z ≥ 2.5 + vps drop + ER drop | subs: category z ≥ 2.5 OR temporal z ≥ 2.5 OR WoW ≥ 15%; 나머지 동일 (medium 캡 유지) |
| comeback_cycle | hanteo + chart + news z + video upload z + group_events | news: 3-축 OR; group_events 매칭은 그대로 |
| broadcast_appearance | news_z_prev_week + community z | rev 2 의 V1 stub 그대로 (변경 없음) |
| community_word_of_mouth | community_z_prev_week + subs/views z | 동일 |
| controversy_spike | 4 시그널 (keyword/twitter/count/sentiment z) | controversy_count_z + negative_ratio_z 는 *카테고리 z 만* (시그널 의미가 자기 history 보다 cohort 비교가 더 의미) |
| platform_concentrated_promo | reactivity dominance + 보조 z | 보조 z 는 카테고리 z OR temporal z |
| member_centric_spike | top1_share WoW + hhi_norm WoW + 그룹 spike | 그룹 spike 부분이 (category OR temporal OR WoW) OR |

### 13.4 회귀 방지

- 기존 28 단위 테스트는 *cross-sectional z 가 충분히 큰 case* 라 그대로 통과 (signals dict 의 z 값이 같은 keyword "subs_z" 로 들어오기 때문).
- 다만 spec rev 3 에서는 시그널 dict 키가 변경됨: `subs_z` → `subs` (dict with sub-keys: `category_z`, `temporal_z`, `wow_pct`). 기존 테스트의 `_base_signal_bundle()` 를 rev 3 shape 로 업데이트 필요.
- compute_group_signals 의 cohort 빌드 부분이 카테고리 분기 + temporal history 쿼리 추가 → 11개 SQL 쿼리 (기존 10 + temporal history 1).
- e2e mock test 는 추가 fixture row (8주 history) 필요.

### 13.5 새 test 시나리오

| test | 의도 |
|---|---|
| `test_temporal_z_score_basic` | history list 분포 대비 z 정확 계산 |
| `test_wow_pct_basic` / `test_wow_pct_prev_zero_none` | 비율 함수 + dead signal |
| `test_category_cohort_kpop_only` | kpop cohort 안에서 z 계산, subculture 그룹은 다른 cohort |
| `test_subculture_cohort_too_small_falls_back_to_temporal` | subculture N<3 일 때 category z=0, temporal/WoW 만으로 lit 가능 |
| `test_organic_growth_lit_via_wow_only` | category z 모두 0 + temporal z 모두 0 + WoW% 모두 임계치 통과 → organic lit |
| `test_organic_growth_lit_via_temporal_only` | category 분포 비대칭이라 z=0 + 자기 history 대비 큰 spike → lit |
| `test_paid_ads_stricter_wow_threshold` | views WoW 8% (normal) → paid 안 점등, WoW 25% → paid 점등 |

### 13.6 점진 도입

rev 3 변경은 spec rev 2 의 *모든 시그널 모듈을 인터페이스 호환 유지* — 새 함수 추가 + 기존 함수 의미 보강이지 함수 제거 없음. classify_hypotheses 의 dampen 체인 / meta_guards 적용 / GroupSignals dataclass / signals_json payload 모두 변경 없음. 사실상 *compute_group_signals 의 sig dict 빌드만* 큰 변경.

migration 없음. 코드 변경만.
