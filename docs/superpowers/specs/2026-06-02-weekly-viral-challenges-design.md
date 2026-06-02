# 주간 바이럴 챌린지 리스트업 — 설계

- **기준일**: 2026-06-02
- **상태**: 설계 확정, 구현 계획 대기
- **접근법**: 하이브리드 (Gemini Google Search grounding 으로 발굴·명명 → YouTube Data API 로 수치화)
- **연관**: `2026-06-02-shorts-trend-and-miiwan-diagnostic-design.md` (같은 `#tab=shorts` 화면에 섹션으로 추가)

---

## 1. 목적

추적 채널 밖의 **이번 주(최근 7일) 바이럴 중인 챌린지**를 발굴해 한 화면에 리스트업한다. K-POP 아이돌 챌린지(타이틀곡 안무·아이돌 포맷)를 우선·다수로, 일반 YouTube Shorts 챌린지를 소수로 함께 싣고, 각 챌린지에 **YouTube 측정 근거**와 **MiiWAN 적합도 메모**를 붙여 "MiiWAN이 이번 주 무엇을 빠르게 따라 만들지" 판단을 돕는다.

배경: 챌린지는 TikTok 네이티브 개념(사운드+동작)이라 우리 DB·기존 collector(채널 전용 YouTube, 핸들 전용 Twitter, grounding 없는 Gemini)로는 발굴 불가. 따라서 신규 데이터 수급이 필요하다.

## 2. 비목표 (YAGNI)

- TikTok/Instagram API 직접 연동 (없음 — grounding 의 웹 검색으로 간접 포착).
- 챌린지 시계열 추적·생애주기 그래프 (1차는 주차별 스냅샷 리스트).
- 자동 영상 생성·대본화 (적합도 메모까지만).
- Discord push (이번 범위는 프런트 섹션 전용 — 1차 제외, 향후).
- 실시간/일간 갱신 (주 1회로 충분 — 챌린지는 주 단위로 움직임).

## 3. 아키텍처

```
GitHub Actions 주간 cron (challenge-scan.yml, 월요일 KST 오전)
        │
   worker: python -m idol_sight challenge-scan
   ① 발굴 (analysis/challenge_scan.py → llm/gemini.py grounded)
        Gemini 2.5 Flash + google_search tool 로 최근 7일 바이럴 챌린지
        후보를 이름·설명·원곡/사운드·대표 해시태그·출처URL 로 수집
   ② 측정 (analysis/challenge_scan.py → youtube search 헬퍼)
        각 후보의 대표 해시태그/이름으로
        search.list(q, type=video, videoDuration=short,
                    publishedAfter=now-7d, order=viewCount, maxResults=50)
        + videos.list(part=statistics) → 최근 숏폼 수·합산/대표 조회수·대표 영상 IDs
   ③ 랭크(측정+가중) + 태그(kpop|general) + MiiWAN 적합도 메모(LLM, 비-grounded)
   ④ UPSERT → D1 weekly_challenges (week_start 단위 멱등 교체)
        │
   Cloudflare D1  weekly_challenges
        ▲
   frontend/functions/api/shorts-trend.ts  (응답에 challenges 추가)
        ▼
   ShortsTrend.tsx → WeeklyChallenges 섹션
```

총 **10개** 목표: K-POP(tag=`kpop`) 약 7 + 일반(tag=`general`) 약 3. 상수로 둔다 (`TARGET_KPOP=7`, `TARGET_GENERAL=3`).

## 4. 데이터 모델

신규 migration (다음 순번). **D1 원격 apply 는 운영자 직접 실행** (메모리 `feedback_d1_remote_apply_human_only`).

```sql
CREATE TABLE weekly_challenges (
  week_start         TEXT NOT NULL,   -- KST 월요일 (YYYY-MM-DD)
  rank               INTEGER NOT NULL,-- 1..N (태그 무관 통합 랭크)
  name               TEXT NOT NULL,   -- 챌린지 이름 (예: "Magnetic 챌린지")
  tag                TEXT NOT NULL,   -- 'kpop' | 'general'
  description        TEXT,            -- 한 줄 설명 (무슨 동작/포맷)
  origin             TEXT,            -- 원곡/아티스트/사운드 출처
  hashtags           TEXT,            -- JSON 배열
  example_video_ids  TEXT,            -- JSON 배열 (YouTube video_id)
  yt_recent_shorts   INTEGER,         -- 최근 7일 매칭 숏폼 수 (측정, NULL=미측정)
  yt_total_views     INTEGER,         -- 대표 샘플 합산 조회수 (측정, NULL=미측정)
  miiwan_fit         TEXT,            -- MiiWAN 적합도/참여 난이도 메모 (LLM)
  source_urls        TEXT,            -- JSON 배열 (발굴 근거 URL — 환각 가드)
  confidence         TEXT,            -- 'high' | 'medium' | 'low'
  generated_at       TEXT NOT NULL,   -- UTC ISO
  PRIMARY KEY (week_start, rank)
);
CREATE INDEX idx_weekly_challenges_week ON weekly_challenges(week_start);
```

`groups` 등 다른 테이블 변경 없음. JSON 컬럼 규약은 기존 패턴(메모리 `feedback_groups_json_columns`)과 동일하게 문자열 JSON.

## 5. 컴포넌트 / 파일

### Worker
- `worker/src/idol_sight/analysis/challenge_scan.py` (신규) — 오케스트레이션: 발굴 → 측정 → 랭크/태그 → UPSERT. 순수 로직(랭크·집계·파싱)은 테스트 가능하게 헬퍼 분리.
- `worker/src/idol_sight/llm/gemini.py` (수정) — grounded 생성 메서드 추가 (`generate_grounded(prompt) -> (text, sources)`), `tools=[google_search]`. 기존 `generate_json` 은 그대로(구조화는 2-step 폴백에서 재사용).
- `worker/src/idol_sight/llm/prompts.py` (수정) — `CHALLENGE_DISCOVERY_PROMPT`(K-POP 가중·출처 필수·최근 7일·검증가능만) + `CHALLENGE_STRUCTURE_PROMPT`(grounded 텍스트→JSON) + `MIIWAN_FIT_PROMPT`.
- `worker/src/idol_sight/collectors/youtube.py` (수정) — 임의 키워드 search 헬퍼 추출 (`search_shorts(query, published_after, order) -> [video_id...]` + `fetch_stats(ids)`), 기존 채널 수집과 공유. quota 코멘트 갱신.
- `worker/src/idol_sight/cli.py` (수정) — `challenge-scan` 커맨드 등록.
- `migrations/00NN_weekly_challenges.sql` (신규).
- `.github/workflows/challenge-scan.yml` (신규) — 주 1회 cron + workflow_dispatch. `GEMINI_API_KEY`, `YT_API_KEY`, `CF_*` env.

### Frontend
- `frontend/functions/api/shorts-trend.ts` (수정) — 최신 `week_start` 의 challenges SELECT → 응답에 `challenges` 추가.
- `frontend/src/components/WeeklyChallenges.tsx` (신규) — 섹션 렌더 (랭크·이름·태그칩·설명·원곡·해시태그·측정수치·MiiWAN fit·출처링크·confidence).
- `frontend/src/views/ShortsTrend.tsx` (수정) — 섹션 삽입 (진단 패널 아래, 트렌드 테이블 위 또는 아래).

## 6. 데이터 플로우 상세

1. **발굴**: grounded Gemini 호출 1회. 출력은 자유 텍스트 + 근거(검색 결과). 프롬프트가 "최근 7일 / K-POP 약 7 + 일반 약 3 / 각 항목 출처 URL 필수 / 검증 가능한 최근 활동만".
2. **구조화**: grounded 텍스트를 비-grounded `generate_json`(response_schema)로 JSON 배열화. (grounding+schema 동시 제약 회피 — §8.)
3. **측정**: 각 후보의 `hashtags[0]`/`name` 으로 `search_shorts` → video_ids → `fetch_stats` → `yt_recent_shorts`(반환 수), `yt_total_views`(샘플 합산), `example_video_ids`(상위 3). 실패/0건이면 측정 필드 NULL 유지(드롭 금지).
4. **랭크**: 측정값(yt_total_views, yt_recent_shorts) 정규화 + tag=kpop 가중으로 통합 랭크 1..N. 측정 NULL 은 하위.
5. **적합도**: 후보 묶음을 비-grounded LLM 으로 MiiWAN(버추얼 아이돌, 데뷔 직후) 관점 참여 난이도/적합도 한 줄 메모.
6. **저장**: `week_start`(KST 월요일) 기준 기존 행 DELETE 후 INSERT (멱등).

## 7. 에러 처리

- 발굴 0건/ grounding 실패 → 그 주 UPSERT 스킵(이전 주 유지), 잡 로그 + 비-치명 종료. 프런트는 최신 주차가 오래됐으면 `generated_at` 으로 노출.
- 구조화 JSON 파싱 실패 → 재시도 1회 후 스킵.
- 측정 실패(후보별) → 해당 후보 측정 NULL, 리스트 유지.
- YouTube quota 초과 → 측정 중단·남은 후보 미측정 처리, 로그.
- 프런트 challenges 빈 배열 → 섹션 "이번 주 챌린지 데이터가 아직 없습니다".
- 멱등: 같은 주 재실행 시 해당 week_start 행 교체.

## 8. 핵심 기술 리스크 / 결정

- **grounding + 강제 JSON schema 동시 제약**: google_search tool 과 `response_schema` 강제가 함께 안 될 수 있음 → **2-step**(grounded 자유텍스트 → 별도 호출 JSON 구조화). 구현 1단계에서 grounding 단독 동작부터 검증.
- **google-genai SDK 의 grounding 지원 확인**: 현재 worker 가 쓰는 SDK 버전이 `google_search` tool 을 지원하는지 1단계에서 확인, 미지원 시 SDK 업그레이드 또는 REST 직접 호출.
- **환각 가드**: 항목마다 `source_urls` 필수, `confidence` 표기, "검증 가능한 최근 활동만". UI 에 발굴(LLM) vs 측정(YouTube) 라벨 분리.
- **freshness**: grounding 의 웹 인덱스 신선도에 의존 — "최근 7일" 은 best-effort, generated_at 명시.

## 9. 프런트엔드 표시 (섹션)

- 제목 "이번 주 바이럴 챌린지" + `week_start` + "발굴(AI) + YouTube 측정" 라벨.
- 각 카드/행: 통합랭크 · 이름 · 태그칩(K-POP/일반) · 한 줄 설명 · 원곡 · 해시태그 · 측정(최근 숏폼 수·조회수, 미측정시 "—") · MiiWAN fit · 출처 링크(↗) · confidence 점.
- 대표 영상 IDs → `https://www.youtube.com/shorts/<id>` 링크.
- 빈 상태 처리.

## 10. 테스트

- **worker pytest**:
  - 랭크/집계 로직(정규화+kpop 가중) 순수 함수.
  - YouTube 측정 파서(search.list/videos.list mock → recent_shorts·total_views·example_ids).
  - 2-step 구조화 파서(grounded 텍스트 mock → JSON, 실패 재시도).
  - 프롬프트 회귀(CHALLENGE_DISCOVERY_PROMPT 에 "최근 7일"·"출처"·"K-POP" 토큰 존재).
  - grounding/Gemini 호출 자체는 mock.
  - UPSERT 멱등(같은 week_start 재실행 → 행 수 동일).
- **frontend**:
  - `api/shorts-trend` 테스트에 challenges 분기(D1 mock) 추가 → 응답에 challenges 포함.
  - WeeklyChallenges 컴포넌트 typecheck + build (컴포넌트 단위테스트는 코드베이스 관례상 생략).

## 11. 윤리 (CLAUDE.md / v2-roadmap §7)

- 공개 트렌드·집계 정보만 저장. 본체/신상 무관. 2차 창작 "양"이 아니라 공개 챌린지 메타데이터.
- MiiWAN 액션 중심(자사 깊이), 경쟁사·일반은 외형(트렌드명·수치)만.
- 발굴 결과는 인간 검증 전제(적합도 메모는 제안, confidence 표기).

## 12. 향후 확장

- Discord push(주간 챌린지 알림).
- 챌린지 생애주기 추적(주차 간 등장/소멸/지속).
- TikTok/Reels 신호 추가(가능 시).
- 적합도 → 구체 기획(대본/캐스팅) 제안.

---

## 13. 풍부화 V2 (2026-06-03) — 분류 단계 집중 + 관측성

### 배경 / 진단

측정 기반 발굴(B) 전환 후 실제 cron 에서 **주당 3건**만 적재되는 문제. run 26835124659 로그 분석:

- discover 5시드 전부 200 (429 없음 — 429 재시도+시드 딜레이 fix 이후 풀 수집은 정상).
- 측정 search 가 정확히 3건(`#LE_SSERAFIM…`/`#XLOV…`/`#StrayKids…`)만 발생 → **최종 challenges = 3, 전부 dance, meme 0**.
- 즉 병목은 **풀 수집이 아니라 LLM 분류**: `CHALLENGE_CLASSIFY_SYSTEM` 에 개수 목표가 없어 LLM 이 확신 높은 메가히트만 보수적으로 추출.

목표(운영자): **양 7~10개 + 롱테일(중소·신생 그룹 신곡) 포착**. 밈/장르 균형은 이번 비목표.

### 전략 — 단계적(Approach 1 먼저)

추가 YouTube search 호출 **0**(429 무위험)으로 분류 단계만 손본 뒤, 카운트 로그로 효과를 측정하고 부족하면 풀 다양화(V3, 정렬 다양화+시드 확장)로.

### 변경

1. **`llm/prompts.py` — `CHALLENGE_CLASSIFY_SYSTEM`**
   - 개수 목표: "근거 있는 한 **최대 10개**까지. 메가히트뿐 아니라 **떠오르는 중소·신생 그룹 챌린지**도 포함 — 조회수 절대값이 낮아도 풀에 있으면 후보."
   - 최신성 게이트 완화: 기존 "약 1개월 이상 전 제외" → **"원곡이 약 3개월 이상 전이면 제외"**. 7일 윈도우가 최근성을 보장하므로 롱테일을 깎던 1개월 게이트를 3개월로 완화(분기 컴백곡은 살리고 작년 곡 재탕만 배제).

2. **`analysis/challenge_scan.py`**
   - `POOL_CAP` 80 → **150**: 이미 모은 풀을 더 많이 LLM 에 전달(brief = title/channel/views/id 만이라 토큰 부담 적음, 추가 API 호출 0).
   - `run_challenge_scan` 카운트 로그 1줄: `pool=N classified=N pool_grounded=N selected=N`. 다음 run 에서 어느 단계가 깎는지 확정 — V3(풀 다양화) 필요 여부 판단 근거.

3. **테스트**
   - `test_prompts_challenges.py`: 개수목표("최대 10")·최신성("3개월") 토큰 회귀 가드.
   - `test_challenge_scan_run.py`: `POOL_CAP == 150` + 카운트 로그 호출 확인.

### 측정 루프 (수용 기준)

적용 → push → dispatch → 카운트 로그 판독:

- **selected 7~10** → 완료.
- pool 큼 · classified 적음 → 프롬프트 추가 튜닝.
- classified 많음 · pool_grounded 에서 급감 → pool-grounded 필터 완화(`example_video_ids` 정확도).
- pool 자체 빈약 → **V3 풀 다양화**(각 시드 `viewCount`+`date` 2정렬, 신곡/컴백 시드 추가). search 호출↑ 이므로 429 효과 확인 후 진행.
