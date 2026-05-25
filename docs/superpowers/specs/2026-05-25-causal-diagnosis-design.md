# 주간 인사이트 인과 진단 (Causal Diagnosis) — 설계

- **상태**: 설계 완료, 사용자 검토 대기 (2026-05-25)
- **선행 작업**: V2.5 4-factor Health Score, V2.22 debut_window_organicity, V2.20 ipx_action prompt hardening
- **후속 작업**: writing-plans → 구현 계획 → 마이그레이션 0065 + worker 모듈 + 프롬프트 업데이트

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

---

## 3. 가설 카탈로그

8개 enum. 모든 시그널은 *주간 z-score 또는 비율 임계치* 로 정의되어 unit test 가능.

| key | 의미 | 점등 조건 (요지) | 신뢰도 기여 |
|---|---|---|---|
| `organic_growth` | 자연 유입 | subs z≥1.5 ∧ views z≥1.5 ∧ engagement_rate 안정 ∧ community/news 동기 상승 | 시그널 4개 모두 점등 시 high |
| `paid_youtube_ads` | 유튜브 광고 | views z≥2.0 ∧ engagement_rate WoW −20% 이상 ∧ subs/views 비율 평탄 ∧ debut_window_video_organicity verdict=suspect+likely_paid 비중 ≥30% | 시그널 3+개 점등 시 high |
| `subscriber_purchase` | 구독자 구매 의심 | subs z≥2.5 ∧ views-per-sub WoW −30% 이상 ∧ engagement_rate WoW −25% 이상 ∧ community 활성 평탄 | 시그널 3+개 점등 시 medium (검증 어려움 — 항상 단정 회피) |
| `comeback_cycle` | 컴백 효과 | (hanteo_sales>0 ∨ music_show_wins>0 ∨ chart_peak≤30) ∧ naver_news z≥2 ∧ video_upload count z≥1.5 | 시그널 2+개 점등 시 high |
| `broadcast_appearance` | 방송/외부 출연 | 특정 날짜에 naver_news spike (1일 z≥3) + 3–7일 lag 후 community/views 점진 상승 | lag 패턴 일치 시 medium |
| `community_word_of_mouth` | 입소문 | community 7d z≥2 ∧ 다음 주 동일 그룹 subs/views z≥1.5 (lag 1주) — *과거 데이터로 retroactive* | medium |
| `controversy_spike` | 논란 | controversy_count z≥2 ∨ negative_sentiment_ratio z≥2 ∨ twitter controversy type spike | 하나라도 점등 시 high (인간 검증 필수 강제 문구) |
| `insufficient_signal` | 노이즈 | 위 7개 중 어느 것도 점등 안 됨 (모든 변화 z<1.5) | — diagnosis 카드 emit 금지 |

**시그널의 *조합*이 카탈로그를 결정**:
- 자연 유입이 가장 까다로움 (4개 동시 점등 요구) — 운영자가 "이건 자연 유입" 이라고 부를 만한 케이스는 정말 동시 상승 케이스만.
- paid_ads vs sub_purchase 의 핵심 변별: paid_ads는 *views 가 폭증하지만 sub 증가는 비례하지 않음* (광고 시청자는 구독하지 않음), sub_purchase는 *sub 만 폭증하고 view 는 따라오지 않음*. 둘 다 engagement rate 하락은 공통.
- `comeback_cycle` 은 가장 *겹치는 시그널* 이 많아서 우선순위 부여: 컴백 시그널이 점등되면 다른 ambiguous 가설들 (paid/sub_purchase) 신뢰도를 한 단계 감점 (컴백 시즌에는 자연스럽게 광고도 같이 돌릴 가능성이 높지만, 그건 "광고 의심" 이 아니라 "컴백 캠페인" 으로 명명해야 옳음).

---

## 4. 아키텍처

```
agg_summary(7d, 14d)                     ┐
debut_window_video_organicity(주간 분포) │
hanteo_weekly, music_show, chart         │
naver_articles(주간 분포)                │  → analysis/weekly_diagnosis.py
community_posts(주간, platform별)        │     compute_group_signals()
twitter_posts(주간, type별)              │     classify_hypotheses()
sentiment polarity                       │     ↓ signals dict
                                         ┘     ↓
                                               ↓
                              llm/prompts.py PROMPT_WEEKLY (개정)
                              llm/weekly.py build_context() (signals 추가)
                                               ↓
                                          gemini.generate()
                                               ↓
                                    insights 테이블 INSERT
                                    (signals_json 컬럼 신설 — migration 0065)
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

migration 0065:

```sql
ALTER TABLE insights ADD COLUMN signals_json TEXT;
-- NULL = legacy 카드 (기존 4-8개 그대로). NOT NULL = diagnosis 카드의 signals dump.
-- payload 형식: {"hypothesis_primary": "paid_youtube_ads", "hypothesis_alternative": "broadcast_appearance", "confidence": "high", "evidence": ["views_z=2.4", ...]}
```

기존 type enum (`insight` / `weekly` / `ipx_action`) 에 `diagnosis` 추가. enum constraint 는 D1 에는 없으므로 코드 레벨 검증.

### 4.5 빈도와 트리거

- weekly cron 이 weekly_diagnosis → LLM 순으로 호출 (worker/cli.py 에 `weekly-diagnosis` 서브커맨드 추가).
- 일 단위 호출은 비목표 (시그널 자체가 7일 WoW z-score 기반).

---

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
| `migrations/0065_insights_signals_json.sql` | 컬럼 신설 | — | — |
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

- 카탈로그 8개 + insufficient 케이스, 총 9개 시나리오의 synthetic agg row pair (`last_7d` + `prev_7d`):
  - `test_organic_growth_all_signals_lit`: subs/views/community/news 모두 z≥1.5 → confidence=high
  - `test_paid_ads_views_no_sub_growth`: views z=3, subs z=0.3, ER drop 30% → paid_youtube_ads confidence=high
  - `test_sub_purchase_inverse`: subs z=3, views z=0.4, ER drop 35% → subscriber_purchase confidence=medium (캡 적용)
  - `test_comeback_full_cycle`: hanteo + chart + news + video upload spike → comeback_cycle confidence=high
  - `test_broadcast_appearance_lag`: 7일 전 news spike + 3일 후 community/view 점진 → broadcast_appearance confidence=medium
  - `test_community_wom_lag`: 전주 community spike + 이번 주 sub/view 상승 → community_word_of_mouth confidence=medium
  - `test_controversy_one_signal_high`: controversy_count z=2.1 단독 점등 → controversy_spike confidence=high (인간 검증 강제)
  - `test_insufficient_all_z_low`: 모든 z<1.5 → diagnosis emit 안 됨
  - `test_comeback_dampens_paid`: 컴백 시그널 + paid 시그널 동시 → paid confidence 한 단계 감점 (medium → low) 후 emit 차단

LLM 측 통합 테스트는 별도 — Gemini stub 으로 PROMPT_WEEKLY 가 signals 를 올바르게 인용하는지 확인.

---

## 9. 점진 도입

V1 (이번 spec 범위):
- migration 0065 적용.
- `weekly_diagnosis.py` + 단위 테스트.
- `prompts.py` `_DIAGNOSIS_GUIDELINES` 섹션 + 카탈로그 enum 블록 + few-shot exemplar 2개 (paid_ads, comeback).
- `weekly.py` build_context 에 signals 추가.
- `cli.py weekly-diagnosis` 서브커맨드.
- weekly cron 에 endpoint 연결.

V2 (다음 spec):
- community post 작성자 unique-source 분석 (봇 farm 직접 탐지).
- 시계열 lag 자동 학습 (현재 broadcast/wom 의 3–7일 lag 가 고정 — 그룹별 학습형 검출).
- frontend dashboard 에 signals_json 시각화 (가설별 evidence 칩, confidence 게이지).
- diagnosis 카드 위에 *human override* — 운영자가 가설을 confirm/reject 하면 다음 주 confidence 가중치 학습.

---

## 10. 회귀 방지

- 기존 `insight` / `weekly` / `ipx_action` 카드는 *signals_json 컬럼 NULL* 로 작성 — 기존 frontend 렌더링 무영향.
- `diagnosis` 카드는 새 type — frontend 가 모르면 plain insight 처럼 fallback 렌더링 (Whimsy 손실 없음).
- migration 0065 는 ADD COLUMN 한 줄 — rollback 시 컬럼 무시만 하면 됨.
- LLM 프롬프트 변경은 비파괴: 시그널 없는 케이스에는 `type='diagnosis'` 가 생성되지 않음 (insufficient_signal 이 강제 차단).
- weekly_diagnosis 가 빈 dict 반환 (시그널 데이터 미수집) 시 LLM 은 기존 4–8개 카드 모드로 폴백.

---

## 11. 운영자 UX (frontend 변경 없음, V1 한정)

V1 은 worker + 프롬프트만 변경. 카드는 기존 WeeklyUpdate/Insights/MiiWANBriefing 뷰에 그대로 표시되며, type='diagnosis' 카드의 body 가 "유력 가설 + 대안 가설" 형식이라는 것이 운영자 눈에 보이는 유일한 차이. ai_comment 한 줄로 함의 전달.

V2 에서 frontend 가 signals_json 를 읽어 evidence 칩/confidence 게이지를 렌더링하면 더 풍부해지지만, V1 은 텍스트로도 운영 가능하므로 frontend 작업 없이 가치 전달.

---

## 12. 후속

이 spec 이 승인되면 `superpowers:writing-plans` 로 단계별 구현 계획 작성:
1. migration 0065
2. weekly_diagnosis_signals 순수 함수 + 단위 테스트 (TDD)
3. weekly_diagnosis 오케스트레이션
4. cli.py 서브커맨드
5. prompts.py 가이드라인 + few-shot
6. weekly.py build_context 통합
7. weekly cron workflow 추가
8. end-to-end 통합 검증 (synthetic week)
