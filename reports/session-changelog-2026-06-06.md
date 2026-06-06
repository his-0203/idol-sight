# IDOL-SIGHT 세션 변경 요약 리포트 (2026-06-05 ~ 06-06)

**상태: 세션 종료 (최종본)**
**규모**: 25 커밋(24 작업 + 본 리포트) · 62 파일 · **+2,156 / −684** · 전부 `main` 직접 push
**테스트**: worker 575 → **616** (+41), frontend 154 → **165** (+11) · 매 변경 회귀 테스트 동반, ruff/tsc clean
**배포·데이터**: frontend 변경은 frontend-deploy 자동 배포 / worker는 cron 적용 / D1 원격 쓰기는 운영자 게이트(직접 안 함, recompute는 collect-daily dispatch로)

커밋 범위: `57736a5` (세션 시작 직전) .. `9458d82` (HEAD)

---

## 1. 발단 → organicity Shorts 유료광고 오판 (V2.36 → V2.37)

운영자 보고: MiiWAN `꿍싯꿍싯`(광고 미집행)이 `likely_paid`로 오판.

| 커밋 | 내용 |
|---|---|
| `963e21f` | V2.36 — 저용량 Short scale gate (임시) |
| `0cfe2e1` | **V2.37 — 비중 기반 재설계** (게이트 폐기). 실측 6,258 Short 분포로 재보정: ER=세기 / like:comment=진정성 분리, velocity 제거, 절대 게이트 제거. 진단: velocity가 소형채널 baseline에서 폭발 + Shorts 구조적 저ER. 운영자 직관(비중 판단) 검증됨, 티저 유료집행 confirm으로 모델 정답성 검증 |
| `1661273` | 도움말 모달을 V2.37 임계값으로 동기화 |
| `b12def7` | KPI 툴팁 5-tier 분포 노출 |

## 2. D1 인프라

| 커밋 | 내용 |
|---|---|
| `1ae9d36` | **D1 진짜 chunked batch** — 행당 POST 1회(순차) → `{batch:[...]}` 100개씩. aggregate **~82분 → 9분** (실측), 400 fallback 안전망 |
| `75be823` | aggregate timeout 90→20분 (batch 속도 기반) |

## 3. 전체 repo 아키텍처 감사 (멀티 에이전트 워크플로)

14 에이전트 병렬 읽기 전용 감사 → **110 발견 → 11 테마**. 총평: 아키텍처는 건강, 부채는 "터지기 전 안 보이는" **레이어 간 조용한 drift** + 일부 silent-fail 버그.

## 4. 감사 후속 (우선순위별)

### P0 — silent-fail 배관 (`a21a25a`, 6건)
- 전 사용자 일일 강제 로그아웃(쿠키 날짜서명 vs 30일 Max-Age)
- orchestrator `client.batch()` 예외 누수 → crawl_meta 'running' 멈춤
- alerts.yml / health-check.yml 실패 알림 부재
- music_show `refresh_confirmation_status` `rows_written` 항상 0
- twitter tweet_id가 fragment/param으로 PK·dedup 깨짐
- 5개 view fetch `.catch` 없어 무한 스피너

### P1 — 중복 상수 공유 소스화 (`7f26bc4` / `0667c43` / `fdf946c` / `96e556e`)
- verdict 색·임계값(85/70/55/40) → `src/lib/organicity.ts`
- debut-window 표시 bucket → `src/lib/debutWindow.ts`
- 알림 라벨·톤·controversy 임계값 → `src/lib/alerts.ts`
- worker 내부: engagement 산식(health_score.engagement_rate), music_show GROUP alias↔enum 일치, viral 임계값 교차주석, _INTERVALS_H 커버리지 가드
- **cross-language 가드 테스트**: 재보정 시 조용한 drift 대신 테스트 실패

### P2 — 정확성 / 비용
- `36022b3` 알림 오탐(Streisand): controversy 전역→그룹별 직전 스냅샷, model_theft no-baseline floor, identity_leak "중인" 제거+benign 마스킹, hanteo 다그룹 오귀속, 0-comment Short like-farm 오탐
- `e91a09b` viral_velocity 1사이클 stale 해소(in-memory 머지), 24h alert 하한
- `47dd7a1` D1 비용: miiwan ~65 직렬 RTT→~4 (Promise.all + IN), shorts-trend 행당 3 상관 서브쿼리→MAX-snapshot JOIN

### health 정합 (`5ec3e58`)
- `_recompute_health_scores`가 snap 아닌 MAX 읽던 백필/리플레이 오염 버그 → `read_snap` 분리

### dead-wired 기능 (`37380f9` / `3265c24` / `b18f778` / `aea8343`)
- twitter oembed dead code 제거
- organicity type-split(long/short/simple) 모드 API 노출 → 4-mode picker 활성화
- weekly_challenges.example_video_ids 채움 (pool-grounded candidate→top3)
- paid_youtube_ads 죽은 'medium' 분기 정리
- **comeback_boost**: hanteo_sales(hanteo_weekly) + video_upload_z(주간 업로드 z, zero-fill)
- **community_keywords_topic**: first-pass lexicon(external/self/negative) 분류
- video_tags_paid_match: **보류**(경쟁사 youtube_videos.tags 수집 선행)

### P1 프로세스 갭 (`db19a17`)
- blacklist CSV-vs-JSON 시드 버그(0034/0069/0075 3회 재발) → 전체 마이그레이션 적용 후 groups JSON 컬럼 전수 가드(`test_migrations_groups_json`)
- 배포↔마이그레이션 순서 규약 + JSON 배열 시드 규칙 CLAUDE.md 문서화

### D1 batch 멱등성/계약 (`0289523`)
- insights 가 순수 append → 재실행/부분쓰기 재시도 시 중복 → 선행 `DELETE FROM insights WHERE week_start=?` rebuild(items 있을 때만, 빈 LLM run wipe 방지). 전 INSERT 감사 결과 비-UPSERT는 challenge_scan(이미 DELETE)·insights 둘뿐
- batch() 청크 간 비원자성 명시(caller 멱등 필수) + success-under-count 시 raise("정상 return=전량 적용" 보장)

### 마무리 — 문서·검색 (`d50b11b`, `9458d82`)
- organicity 설계 스펙 §3 본문을 V2.37 현 모델로 정비(옛 3-tier·구 ER/balance/가중치 → Long/Shorts 분리)
- /api/search 사용자 q의 LIKE 와일드카드(%·_) 이스케이프 + ESCAPE 절

## 5. 주요 판단 (정직성)

- **"틀린 것을 안 고침"**: viral 임계값 2.0 vs 1.5는 의도적 차이 → 합치지 않고 문서화 · negative_ratio 무윈도는 community 누적집계와 일관 → 단독 윈도 안 함(설계 결정 필요) · 상대시각은 이미 UTC 정확 → TZ skew는 절대시각만(저영향, 보류) · 자동 스키마-먼저-적용은 D1 human-gated 원칙과 충돌 → 문서 규약으로
- **lexicon/heuristic은 지어내 ship 안 함** — video_tags는 운영자 결정으로 보류, community topic은 first-pass lexicon으로 명시 구현(calibratable)

## 6. 남은 백로그 (저가치 / 차단 / 결정필요 — 세션 종료 시점)

- **video_tags_paid_match** — 차단: 경쟁사 youtube_videos.tags 수집 선행
- **누적-vs-윈도 결정** (negative_ratio + community 집계가 둘 다 무윈도 누적) — 설계 결정 필요
- **전용 TZ 패스** (절대 KST 타임스탬프) — worker↔frontend 결합 + 저영향(상대시각은 이미 정확), 실데이터 검증 동반
- **news_filter substring** — relevance.py 경유 라우팅(중간 가치, 더 큰 변경)
- **인덱스 무력화 쿼리**(access_log/melon) — 인덱스=migration(human-gated)+저영향
- **P3 잔여 버전 스탬프**(HealthSpec/GroupContent 주석) — cosmetic
- **자사 채널 YouTube Analytics traffic-source ground-truth 연동** — organicity 추정의 본 해결책(별도 spec)

---

## 부록 — 커밋 목록 (최신순)

```
9458d82 fix(search): escape LIKE wildcards in user query
d50b11b docs(organicity): rewrite design spec §3 to the current V2.37 model
0289523 fix(d1): make insights writes idempotent + tighten batch() partial-write contract
26d194a docs(reports): add 2026-06-06 session changelog
db19a17 test(migrations): guard groups JSON columns; document deploy↔migrate ordering
aea8343 feat(diagnosis): implement community_keywords_topic (first-pass lexicon)
b18f778 feat(diagnosis): wire comeback_boost signals (hanteo_sales + video_upload_z)
3265c24 feat(dead-wire): populate weekly_challenges.example_video_ids; drop dead paid confidence branch
37380f9 refactor(dead-wire): drop Twitter oembed dead code; expose organicity type-split means
5ec3e58 fix(health): read the health-score cohort at the snapshot being written
47dd7a1 perf(api): cut D1 round-trips in miiwan + shorts-trend endpoints
e91a09b fix(velocity): use this-cycle v24 for ratios + lower-bound the 24h alert join
36022b3 fix(alerts): kill Streisand-sensitive false positives + Shorts 0-comment flag
96e556e refactor(worker): de-duplicate internal constants + add drift guards
fdf946c refactor(alerts): single-source alert labels/tones + controversy thresholds
0667c43 refactor(debut-window): single-source the display-tab bucket list
7f26bc4 refactor(organicity): single-source the 5-tier verdict color/threshold scale
a21a25a fix: resolve P0 audit findings (silent-fail plumbing)
b12def7 feat(organicity): expose full 5-tier distribution in Debut Window KPI tooltip
1661273 docs(organicity): fix Debut Window help modal to match V2.37 Shorts model
75be823 ci(collect-daily): aggregate timeout 90 -> 20 min after D1 batch speedup
1ae9d36 perf(d1): real chunked batch writes via /query {batch:[...]} (was sequential)
0cfe2e1 feat(organicity): scale-invariant ratio-based Shorts scoring (V2.37, supersedes V2.36 gate)
963e21f fix(organicity): hold low-volume Shorts as insufficient_data (paid false-positive)
```
