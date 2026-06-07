# Shorts organicity — 저댓글 balance 가드 (V2.39)

- 날짜: 2026-06-07
- 대상: `worker/src/idol_sight/analysis/debut_window.py` `compute_organic_score`
- 선행: V2.37 Shorts 비중 기반 재설계 (2026-06-05)
- 관련 스펙: `2026-05-12-debut-window-organicity-design.md`

## 배경 / 문제

운영자 확인 ground-truth: **MiiWAN Shorts 중 'PLUMA' MV Teaser만 유료 집행,
나머지는 전부 오가닉.** 따라서 티저 외 Short가 suspect/likely_paid 로 판정되면
전부 false positive 다.

V2.37 Shorts 채점은 사실상 balance(`like:comment` 비율) 신호가 지배한다
(weight 0.6, ER floor 0.5% 라 e_score 는 거의 항상 ≥0). 그런데
`like_comment_ratio = like_count / max(comment_count, 1)` 는 **댓글이 적을 때
±1 댓글 노이즈에 지배되어 의미 없이 폭발**한다.

V2.37 은 `comment_count == 0` 만 가드해 `b_score=100`(중립) 으로 처리했다.
그 결과 **댓글 1개부터 가드가 사라지는 절벽**이 생겼다. 실제 fixture
(조회 4,000 / 좋아요 300) 의 댓글 수만 바꿔 추적하면:

| 댓글 | like:comment | b_score | composite | verdict |
|---|---|---|---|---|
| 0 | (가드) | 100 | 93 | organic_strong |
| **1** | 300 | 11 | **39** | **likely_paid** |
| 2 | 150 | 71 | 76 | organic |
| 3 | 100 | 91 | 87 | organic_strong |
| 5 | 60 | 100 | 93 | organic_strong |

좋아요 300개짜리 건강한 오가닉 Short 가 댓글 1개라는 이유만으로 likely_paid
로 떨어진다. 데뷔 전 자사 Short 는 댓글이 한 자릿수인 소표본이 대부분이라
이 절벽이 ground-truth 위반(오가닉을 paid로)을 직접 유발한다.

## 설계

`comment_count == 0` 가드를 **저댓글 가드로 일반화**하되, **고조회는 예외**로
둔다. 가드 2단 구조:

```
# (1) 기존 V2.37 — 유지. 댓글 0개면 비율(likes/1)이 수학적으로 degenerate.
if is_short and comment_count == 0:
    b_score = 100 ; balance_basis = "zero_comment"

# (2) 신규. 댓글 N개 미만이면 like:comment 비율이 ±1 댓글 노이즈에 지배됨
#     → balance 판정 보류(중립). 단 고조회는 제외 — 고조회 + 소댓글 + 낮은 ER
#     은 진짜 cold-traffic/paid 시그니처라 farm 탐지를 살려둔다.
elif is_short and comment_count < BALANCE_MIN_COMMENTS_SHORT \
     and view_count < BALANCE_LOW_VIEW_CEIL_SHORT:
    b_score = 100 ; balance_basis = "insufficient_comments"
```

### 상수

- `BALANCE_MIN_COMMENTS_SHORT = 10` — 댓글이 통계적으로 의미 있는 비율을
  형성하기 시작하는 하한. 라이브 like:comment p90=78 기준 좋아요 100~300개
  소형 Short 가 like_farm 을 안 맞으려면 댓글 ≥ likes/78 ≈ 1.3~3.8 필요 →
  10 이면 소형 Short 절벽 구간을 충분히 덮으면서 티저(댓글 ~30)는 무영향.
- `BALANCE_LOW_VIEW_CEIL_SHORT = 50_000` — 이 미만이면 "소형 소표본"으로 보고
  보호. 티저(~20만), like_farm 케이스(10만)보다 낮고 소형 오가닉 Short(수천)
  보다 높아 둘을 깔끔히 분리.

### 투명성

breakdown 에 `balance_basis` 필드 추가:
- `"ratio"` — 기본, balance 를 비율로 정상 판정
- `"zero_comment"` — 댓글 0개로 중립화
- `"insufficient_comments"` — 저댓글+저조회로 판정 보류

프런트(`DebutWindowSignalPanel`) 가 "댓글 부족으로 balance 판정 보류" 를
안내할 수 있게 한다(프런트 반영은 후속, 선택).

### 고조회 예외의 boundary 처리

view 임계 근처의 cliff 는 의도된 동작이다 — 조회 5만 + 댓글 소수 + 낮은 ER 은
정상 오가닉이 아니라 cold-traffic 시그니처이므로 balance(farm) 판정을 받는 게
옳다. 소표본 보호는 어디까지나 "작아서 비율이 못 잡히는" 케이스 한정.

## 회귀 영향

기존 5개 Shorts 테스트 **전부 변경 없이 통과** (고조회 예외가 like_farm
fixture 를 보존):

| 테스트 | view / comment | 적용 가드 | 결과 |
|---|---|---|---|
| zero_comment | 4K / 0 | (1) zero_comment | 93 동일 |
| small_healthy | 1.8K / 5 | (2) 보호 → b=100 (원래도 100) | 86 동일 |
| like_farm_caught | 100K / 5 | 고조회 → 미보호, balance 판정 | 21 동일 |
| dead_teaser | 200K / 30 | 댓글≥10 → balance 판정 | 27 동일 |
| long_form | (long) | 미적용 | 100 동일 |

신규 테스트:
- **절벽 수정**: view 4K / like 300 / comment 1 → 기존 39 likely_paid →
  93 organic_strong (저조회+저댓글 보호)
- **고조회 보존**: view 80K / comment 2 → 미보호(balance 판정 유지) 회귀 가드
- **boundary**: view 49,999 보호 / 50,000 미보호, comment 9 보호 / 10 미보호

## 범위 밖 (의도적)

- **paid 탐지망이 balance 비대칭에만 의존** (dead-ER + 정상비율, 또는
  comment==0 + 고조회 paid 가 composite ≥60 으로 미탐지): V2.37 부터의
  트레이드오프. 본 변경이 악화시키지 않음. 별도 작업.
- **요약 view-weighted mean 이 단일 티저에 지배**: 요약/프런트 표시 이슈. 별도.
- long-form 미변경.
