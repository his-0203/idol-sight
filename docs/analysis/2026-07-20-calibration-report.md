---
type: calibration-analysis
date: 2026-07-20
scope: health_score / awareness scoring formulas
status: analysis-only (산식 코드 변경 없음)
---

# idol-sight 스코어링 산식 캘리브레이션 분석 (2026-07-20)

프로덕션 D1 최신 스냅샷(`agg_summary` 2026-07-20T05:00Z, 13개 활성 그룹)을
입력으로, 워커의 **실제 순수 함수**(`idol_sight.analysis.health_score`,
`idol_sight.analysis.awareness`)를 그대로 import 해 재현·민감도 분석했다.
재현 검증: awareness 재계산값이 프로덕션 `agg_awareness` 원값과 정확히 일치
(예: bdawn 68.6=68.6, owis 79.8=79.8, plave 100=100). 산식 코드는 변경하지
않았다 — 본 문서는 분석·권고만 담는다.

**재현 스크립트**: 코호트 dict 구성은 `cli._recompute_health_scores`
(`worker/src/idol_sight/cli.py:1590-1749`)를 미러 — hanteo=`hanteo_weekly`
`MAX(sales)` GROUP BY(`cli.py:1622-1628`), music_show=`music_show_wins_log`
confirmed DISTINCT(`cli.py:1635-1646`), v90/v30=`youtube_videos` 카운트
(`cli.py:1691-1700`), loyalty=`agg_fan_loyalty` basis='scored' +
`COALESCE(score_ceiling, score)`(`cli.py:1654-1663`).

**입력 데이터 핵심 사실 (분석의 전제)**:
- `hanteo_weekly` : **전 그룹 0행** (컬렉터 산출물 없음)
- `melon_top100_peak/depth` : **PLAVE 1개 그룹만** 존재 (peak=95, depth=1)
- `music_show_wins_log` : confirmed 0건 (컬렉터 stub)
- `agg_fan_loyalty` basis='scored' : 6개 그룹(plave/skinz/myrakl/owis/miiwan/wegosix)
- 그룹 모델: kpop 10개=`corporate`, isedol·uryael=`segmentary`, stellive=`confederation`
  (`CLAUDE.md` V2.33 / `docs/analysis-formulas-reference.md:100-101` 확인)

> ⚠️ 캐비엇: D1의 `debut_date`/`debut_confirmed`는 본 분석 입력에 포함되지
> 않아 전 그룹을 `debut_confirmed=1`(과거 데뷔)로 두고 재계산했다. 프로덕션에서
> BTHD(선공개 임시 앵커)·BEGRITZ(YT 신호 0)는 PRE 게이트될 수 있어 그
> 두 그룹의 **절대 total**은 참고용이다. 변별력·팩터 구조 분석에는 영향 없다.

---

## A. Reach / Mobilization 변별력 (소형그룹 후한 경향)

### A-1. 실제 산출된 동적 REF (코호트 p75) — `health_score.py:380-421`, 상수 `:93`

| axis | p75 REF (실측) | MIN_REF(`:97-103`) | 바인딩? |
|---|---|---|---|
| subscribers | **93,200** (=BTHD/OWIS급) | 50,000 | p75 |
| views | **15,121,872** (=OWIS) | 1,000,000 | p75 |
| quality(engagement) | **0.0368** | 0.005 | p75 |
| community | **3,105** (≈PLAVE) | 1,000 | p75 |
| news | **39** | 10 | p75 |

코호트가 13그룹으로 충분히 커서 **MIN_REFS 플로어는 전혀 바인딩되지 않는다**
(모든 p75 > MIN_REF). → 현 시점 MIN_REFS 값은 점수에 무영향(빈 시장 방어용
으로만 잔존).

### A-2. 그룹별 축 정규화값 + 1.0 캡 (`_normalize` `:206`, `_normalize_log` `:217`)

| group | model | sub_n | view_n | comm_n | eng_n | news_n(log) | 1.0 캡 축 |
|---|---|---|---|---|---|---|---|
| plave | corp | **1.000** | **1.000** | **1.000** | **1.000** | **1.000** | 5축 전부 |
| stellive | conf | **1.000** | **1.000** | **1.000** | 0.747 | **1.000** | sub·view·comm·news |
| isedol | seg | **1.000** | **1.000** | **1.000** | **1.000** | 0.971 | sub·view·comm·eng |
| owis | corp | 0.951 | **1.000** | 0.108 | 0.264 | **1.000** | view·news |
| bthd | corp | **1.000** | 0.429 | 0.000 | 0.036 | 0.798 | sub |
| skinz | corp | 0.732 | 0.774 | 0.060 | 0.703 | 0.715 | — |
| wegosix | corp | 0.417 | 0.551 | 0.070 | **1.000** | 0.768 | eng |
| miiwan | corp | 0.307 | 0.209 | 0.031 | 0.398 | 0.873 | — |
| uryael | seg | 0.353 | 0.549 | **1.000** | 0.699 | 0.734 | comm |
| bdawn | corp | 0.097 | 0.511 | 0.005 | 0.160 | 0.850 | — |
| myrakl | corp | 0.060 | 0.006 | 0.073 | **1.000** | **1.000** | eng·news |
| hollin | corp | 0.000 | 0.000 | 0.000 | 0.557 | 0.971 | — |
| begritz | corp | 0.000 | 0.000 | 0.000 | 0.000 | 0.768 | — |

**핵심 관찰 — 변별력 손실은 "소형그룹 후함"이 아니라 상단 포화다:**
- **subs 축 상단 붕괴**: p75 REF=93.2K이라 93K↑ 전부 saturate. OWIS(88.6K)
  sub_n=0.951 ≈ PLAVE(1.19M) 1.000 — **구독자 13배 차이가 정규화 후 5%로
  압축**. BTHD(93.2K) 역시 1.000. 상위 4~5그룹이 subs 축에서 순위 정보 상실.
- **community 축**: p75 REF=3,105(=PLAVE 실측 3,104). PLAVE/ISEDOL/STELLIVE/
  URYAEL(mgallery 8,712) 4그룹이 1.0 포화, 나머지 9그룹은 <0.11로 바닥
  (OWIS 335→0.108, SKINZ 181→0.060). **중간이 없는 이봉분포**.
- **news 축은 log1p(`:217`)이라 반대로 지나치게 관대**: 소형 그룹도 0.7~1.0.
  myrakl(89건) 1.000, bdawn(22건) 0.850. reach 가중(0.05)이 낮아 총점 영향은
  제한적이나, ritual(0.10)에서는 소형그룹을 후하게 만든다(§C 참조).
- 결론: 변별력 문제는 하단이 아니라 **상단(top-4가 여러 축에서 동시 1.0
  포화)** 과 **중간 공백(community 이봉)** 이다. 하단은 오히려 news-log 때문에
  약간 관대.

### A-3. 민감도 — 총점·등급 변화 (p75 → p90 / max-relative / p75+2×MIN_REFS)

| group | p75(현행) | p90 | max-relative | p75+2×MIN |
|---|---|---|---|---|
| plave | **7.7 A** | 5.6 B | 4.6 C | 7.7 A |
| stellive | **7.7 A** | 7.2 A | 5.3 B | 7.7 A |
| owis | **6.4 B** | 2.5 D | 2.3 D | 6.3 B |
| isedol | **5.6 B** | 5.0 B | 4.1 C | 5.6 B |
| skinz | **5.6 B** | 2.5 D | 2.2 D | 5.6 B |
| wegosix | **5.0 B** | 3.0 C | 2.5 D | 5.0 B |
| bthd | 4.4 C | 1.8 D | 1.7 D | 4.3 C |
| uryael | 4.2 C | 3.1 C | 2.5 D | 4.2 C |
| bdawn | 3.7 C | 2.2 D | 2.1 D | 3.7 C |
| miiwan | 3.6 C | 2.5 D | 2.3 D | 3.6 C |
| myrakl | 2.9 D | 2.7 D | 2.7 D | 2.9 D |
| begritz | 2.0 D | 1.7 D | 1.4 D | 2.0 D |
| hollin | 1.4 D | 1.1 D | 0.6 D | 1.4 D |

- **p90 → 등급 변동 7건** (owis B→**D**, skinz B→**D**, wegosix B→C, miiwan C→D,
  bthd C→D, bdawn C→D, plave A→B). 정확히 V2.14 주석(`:87-92`)이 서술한
  "중위권이 D로 붕괴" 회귀를 재현.
- **max-relative(leader=1.0) → 등급 변동 10건**. PLAVE 외 전부 압축, PLAVE도
  A→C. 최악.
- **2×MIN_REFS → 변동 0건** (플로어 미바인딩 확인 §A-1).

### 판정
현행 **p75 는 테스트한 대안 중 최선** — p90·max-relative 는 건강한 중위권
(OWIS/SKINZ/WEGOSIX)을 D로 붕괴시켜 V2.14 이전 상태로 회귀한다. MIN_REFS
2배는 무효과(현 코호트 규모에서 플로어 미작동). **하단 후함은 실측상 없음**
— 오히려 상단 포화가 진짜 변별력 손실 지점.

### 권고 (A)
1. **p75 유지, p90/max-relative 채택 반대** — 민감도가 회귀를 명확히 보여줌.
2. **상단 포화는 의도된 트레이드오프로 수용**: Health Score는 "절대 티어링"
   도구이고 상위권 미세 순위는 awareness 지표(§B)가 담당. OWIS≈PLAVE(subs)는
   "둘 다 top-quartile"이라는 올바른 의미.
3. (선택) 상단 순위까지 살리려면 **reach 축만** p75 초과 구간에 완만한 로그
   압축을 얹는 안이 있으나, 이는 산식 변경이며 §B awareness가 이미 그 역할을
   하므로 **낮은 우선순위**. 지금은 파라미터 무변경 권고.

---

## B. Awareness log 압축 (`awareness.py`)

산식(`awareness.py:135-144`): 신호를 **카테고리 리더 대비** `log1p` 정규화
(`:74-82`) 후 가중합 ×100. 가중치 sub 0.50 / view 0.35 / news 0.15
(`:43-47`). 리더 대비이므로 카테고리별 최댓값 그룹이 각 축 1.0.

### B-1. 원 규모 vs 정규화값 — 압축 정량화 (kpop 리더=PLAVE)

| group | sub_raw | view_raw | news | sub_n | view_n | news_n |
|---|---|---|---|---|---|---|
| plave | 1,190,000 | 846,755,718 | 177 | 1.000 | 1.000 | 1.000 |
| owis | 88,600 | 15,121,872 | 43 | 0.814 | 0.804 | 0.730 |
| bdawn | 9,040 | **7,733,082** | 22 | 0.651 | **0.772** | 0.605 |
| myrakl | 5,600 | 87,378 | 89 | 0.617 | 0.553 | 0.868 |

**압축 실측**: bdawn views **7.7M vs PLAVE 847M (110배 차)** → view_n
**0.772 vs 1.000** (격차 23%p). 구독자도 9K vs 1.19M(132배)이 sub_n
0.651 vs 1.0. → **자릿수 3~5개 차이가 정규화 후 20~35%p로 압축**, 소형
그룹이 리더의 65~80% "인지도"로 표시됨.

### B-2. 정규화 변형별 점수 (kpop, raw score) + 순위

| group | linear | sqrt | **log_leader(현행)** | log_band |
|---|---|---|---|---|
| plave | 100.0 | 100.0 | **100.0** | 100.0 |
| owis | 8.0 | 25.7 | **79.8** | 36.2 |
| bthd | 5.7 | 21.8 | **76.1** | 29.3 |
| skinz | 4.5 | 20.1 | **75.1** | 27.3 |
| wegosix | 3.3 | 17.0 | **73.1** | 19.4 |
| miiwan | 3.4 | 15.4 | **71.5** | 17.4 |
| bdawn | 2.6 | 13.0 | **68.6** | 7.6 |
| myrakl | 7.8 | 14.4 | **63.2** | 12.5 |
| hollin | 3.0 | 7.0 | **35.3** | 9.2 |
| begritz | 1.4 | 4.5 | **8.2** | 6.5 |

kpop 순위:
- linear : plave > owis > **myrakl** > bthd > skinz > miiwan > wegosix > … (myrakl 뉴스 과대)
- log_leader(현행) : plave > owis > bthd > skinz > wegosix > miiwan > bdawn > myrakl > hollin > begritz
- **log_band : 현행과 동일 순위** (bdawn↔myrakl 하위 스왑만)

### 판정
현행 **log_leader 는 순위는 타당하나 점수 크기가 오도**한다 — 구독 9K의
데뷔티어 bdawn 이 "인지도 68.6"(PLAVE의 69%)로 표시된다. 실제 보유청중은
PLAVE의 0.76%. log 압축이 소형그룹을 과대포장. linear 는 반대로 하단을
2~5로 뭉개고 순위도 흔듦(myrakl 뉴스 outlier로 3위). **log_band**(log1p 값을
`log1p(0.01·리더)`~`log1p(리더)` 구간으로 정규화·클램프)는 **현행과 동일
순위를 유지하면서 점수를 직관적 범위로 펼침**(bdawn 68.6→7.6, owis 79.8→36.2,
PLAVE 100). 트레이드오프: 리더의 1% 미만 그룹은 0으로 클램프(begritz 6.5).

### 권고 (B)
1. **awareness 정규화를 log-within-band 로 전환** — 순위 불변, 점수 크기가
   실제 규모차를 정직하게 전달. 파라미터: `lo=log1p(0.01·leader)`,
   `hi=log1p(leader)`, `n=clamp((log1p(v)-lo)/(hi-lo), 0, 1)`. 가중치
   0.50/0.35/0.15 유지(`:43-47`).
2. 변경 부담 최소화를 원하면 **현행 log_leader 유지 + 라벨을 "인지도 %"가
   아닌 "티어/순위"로 재표기**(점수 절대값 오해 차단). awareness 는 표시 지표
   (산식 아님)라 리스크 낮음.

---

## C. Ritual 축 진단 (실측)

### C-1. hanteo_weekly 실측 내용

**`hanteo_weekly` 전 그룹 0행.** 앨범·주차·판매 어떤 행도 없다. 따라서
`cli.py:1622-1628`의 `MAX(sales)` 조인 결과 **전 그룹 hanteo_sales=0** →
`hanteo_n = min(0/1e6, 1) = 0`(`health_score.py:533-535`). 코호트 live_metrics
에서 `hanteo` 제외됨.

### C-2. 그룹별 ritual 팩터 입력 재구성 (`_factor_inputs` `:627-640`)

ritual 은 `_wmean(..., redistribute=False)`(`:343-377`, `:639`) — **죽은 신호의
가중치가 분모에 잔존**(재분배 안 함). 단 music_show 는 코호트-dead 시 part
자체를 제외(`:634-638`).

| group | news_n | peak_n | depth_n | hanteo_n | ritual(raw) | ritual×wt |
|---|---|---|---|---|---|---|
| plave | 1.000 | 0.060 | 0.200 | 0 | 0.1575 | **4.72**/30 |
| owis | 1.000 | 0 | 0 | 0 | 0.1250 | 3.75/30 |
| myrakl | 1.000 | 0 | 0 | 0 | 0.1250 | 3.75/30 |
| miiwan | 0.873 | 0 | 0 | 0 | 0.1091 | 3.27/30 |
| skinz | 0.715 | 0 | 0 | 0 | 0.0894 | 2.68/30 |
| stellive | 1.000 | 0 | 0 | 0 | 0.1250 | 1.25/10(conf) |
| isedol | 0.971 | 0 | 0 | 0 | 0.1214 | 1.82/15(seg) |

### C-3. PLAVE ritual 이 4.72/30 인 이유 (수치)

PLAVE ritual parts (redistribute=False, `:627-640`):

```
hanteo     value=0     weight=0.50  alive=False  (컬렉터 0행 → 죽음)
news       value=1.00  weight=0.10  alive=True   → 0.100
chart_peak value=0.06  weight=0.10  alive=True   → 0.006  (멜론 peak 95위, (101-95)/100)
chart_depth value=0.20 weight=0.10  alive=True   → 0.020  (1곡 / ref 5)
music_show  (코호트-dead → part 제외, `:634-638`)
ritual = (0 + 0.100 + 0.006 + 0.020) / (0.50+0.10+0.10+0.10=0.80) = 0.1575
       × 30 = 4.72
```

**결정적 사실**: hanteo 가 죽어도 그 **0.50 가중치가 분모에 남는다**
(redistribute=False). 따라서 hanteo=0인 한, 나머지(news·peak·depth)를
전부 1.0로 채워도 ritual 최대 = 0.30/0.80 = 0.375 → **×30 = 11.25/30 이
corporate ritual 의 구조적 상한**. PLAVE 는 그 상한의 42%(4.72)에 있고,
그것도 peak(0.06)·depth(0.20)가 얇아서다. 즉 문제는 산식 설계가 아니라
**hanteo_weekly 가 비어 ritual 의 절반 가중치가 죽은 채 분모에 박혀 있는 것**.

### C-4. 판정 — 운영자 제안(한터 초동 standing value + 180d 반감기)이 맞나?

- **반감기 감쇠 아이디어는 방향상 맞고 필요하다** — hanteo_weekly 는 주차
  스냅샷이라 컴백 주 이후엔 자연히 신호가 사라진다(초동은 1회성). standing
  value + `0.5^(days_since_release/180)` 감쇠는 "컴백 사이 구간에 ritual 이
  0으로 붕괴"하는 문제를 정확히 겨눈다.
- **그러나 단독으로는 불충분하다** — 지금은 감쇠 이전에 **원천 데이터가 0행**
  이다. 빈 데이터에 반감기를 곱해도 0이다. 진짜 1차 문제는 **컬렉터가 hanteo
  행을 전혀 못 만들고 있다는 것**(수집 실패/미가동). melon 도 PLAVE 1그룹만,
  music_show 도 stub. ritual 축 전체가 **데이터 기근**이 근본 원인이지 산식
  파라미터가 아니다.
- 부차 문제: hanteo 0.50 가중치 + redistribute=False 조합은 **컬렉터 하나가
  죽으면 ritual 절반이 분모에 죽은 채 남아** 전 corporate 그룹을 상한 11.25로
  묶는다. hanteo 가 상시가 아니라 컴백 윈도우에만 채워질 신호라면, 비-컴백
  구간엔 music_show 처럼 **재분배(redistribute)** 로 돌리거나 가중치를 낮추는
  판단이 필요(그러면 news 단독이 ritual 을 지배하는 V2.16이 우려한 부작용과
  트레이드오프).

### C-5. 수정안 하의 기대 점수 (PLAVE 초동 seed 시뮬레이션)

hanteo 를 live 로 살리고 PLAVE 초동을 주입했을 때(감쇠 계수=1.0 가정, 컴백 직후):

| 초동(hanteo_sales) | hanteo_n | ritual/30 | total | grade |
|---|---|---|---|---|
| 0 (현행) | 0.000 | 4.72 | 7.7 | A |
| 100,000 | 0.100 | 6.60 | 7.2 | A |
| 300,000 | 0.300 | 10.35 | 7.7 | A |
| 500,000 | 0.500 | 14.10 | 8.2 | A |
| 1,000,000 | 1.000 | 23.47 | 9.4 | **S** |

PLAVE 실제 앨범 초동은 대략 50만~100만+ 규모 → ritual 14~23, total 8.2~9.4
(A상단~S). "PLAVE=플래그십인데 ritual 4.72로 저평가"라는 운영자 직관과 부합.

### 권고 (C)
1. **(근본·최우선) hanteo_weekly 를 실제로 채워라** — 컬렉터 복구 또는 PLAVE
   기지의 앨범 초동 수동 seed. 데이터가 0행인 한 감쇠 설계는 무의미
   (`cli.py:1622-1628` 조인이 빈 결과).
2. **초동 standing-value + 180d 반감기 채택** — 감쇠식 `0.5^(days/180)`,
   `hanteo_n = min(standing/1e6, 1)`(`:535` 상수 유지). 컴백 사이 ritual
   붕괴 방지. 단 (1)과 반드시 병행.
3. **비-컴백 구간 hanteo 처리 결정** — 상시 sparse 가 예상되면 hanteo 를
   music_show 처럼 코호트-dead 시 **redistribute=True** 로 돌릴지, 아니면
   0.50 가중치를 낮춰 단일 컬렉터 장애가 ritual 절반을 죽이지 않게 할지 결정.
   근거: 비-hanteo 신호 만점으로도 현재 ritual 상한 11.25/30.

---

## 결정 필요 사항 (운영자 개별 승인/반려)

1. **[A] p75 동적 REF 유지 · p90/max-relative 반려** — 민감도상 중위권 붕괴
   회귀(각각 7·10건 등급 하락). *권고: 유지.*
2. **[A] 상단 포화(OWIS≈PLAVE subs) 수용** vs reach 축 상단 로그 압축 도입.
   *권고: 수용(미세 순위는 awareness가 담당), 산식 무변경.*
3. **[B] awareness 정규화 log-within-band 전환** (순위 불변·점수 정직화) vs
   현행 log_leader 유지+라벨을 "티어"로 재표기. *권고: log-within-band.*
4. **[C] hanteo_weekly 데이터 채우기** (컬렉터 복구 / PLAVE 초동 수동 seed).
   *권고: 최우선 — 산식 이전에 데이터 문제.*
5. **[C] 초동 standing-value + 180d 반감기 채택 + 비-컴백 hanteo 재분배 여부**
   결정(redistribute vs 가중치 하향). *권고: 감쇠 채택하되 (4)와 병행, 재분배는
   sparse 확정 후.*

---
*재현 코드·전체 수치 로그: 세션 스크래치패드 `calib.py`. 인용 라인은 2026-07-20
`worker/src/idol_sight/` 기준.*
