# 라이브 채팅 종료-후 긍/부정 분류 리포트 — 설계

- 날짜: 2026-06-16
- 범위(v1): **miiwan(미완소년)** 단일 그룹. 코드는 `group_key` 파라미터화하되 시드·테스트·UI는 miiwan 집중.
- 결과물: **방송 1건 단위 상세 리포트** (대표 긍/부정 멘트 + 비율 추정 + 핵심 테마).

## 배경 / 목표

미완소년의 YouTube 라이브 방송이 **끝난 뒤** 채팅을 수집해, 주요 긍정·부정 반응을 분류해서 방송별 리포트로 보여준다.

기존 자산:
- `collectors/live_ccv.py` — RSS + `videos.list(part=snippet,liveStreamingDetails)` 로 라이브 감지·동시시청자(CCV) 샘플링. `live_ccv_samples`(video_id+sampled_at PK) 시계열.
- `analysis/sentiment.py` — Gemini structured output 으로 커뮤니티 글 제목을 positive/negative/controversy/neutral 분류. 배치·상한으로 토큰을 의도적으로 싸게 유지.
- `llm/gemini.py` `GeminiClient` — `generate(system_prompt, context, response_schema)` 로 구조화 JSON 출력. DI 가능(테스트용 fake).
- 실행은 **GitHub Actions 에서 python CLI**(`collect-ccv.yml` 패턴)가 원격 D1 에 대해 동작 → CF Worker 런타임 제약 없음. httpx 스크레이핑 가능.

## 핵심 설계 결정 (확정)

1. **수집 시점/방식**: 방송 **종료 후** 채팅 **리플레이 비공식 스크레이핑**(`get_live_chat_replay` continuation). Data API 쿼터 0, "끝났을 때 수집" 요청에 정확히 부합, 기존 비공식 스크레이핑(DC·theqoo·RSS) 철학과 일치.
2. **오케스트레이션**: 독립 cron 명령 `collect-live-chat`(= `collect-ccv` 와 대칭). 종료 감지 → scrape → 분류 → 저장을 자기완결로 처리.
3. **분류 전략**: **대표 멘트 추출 + 비율 추정**. 전수 분류(수만 건) 대신 표본을 Gemini 1회 호출로 처리. 싸고 빠름.
4. **raw 저장**: 긁어온 채팅 **전부**를 `live_chat_messages` 에 적재(miiwan 은 방송 빈도가 낮아 볼륨 무리 없음 + 프롬프트 개선 시 재분석 가능). `community_posts → sentiment` 와 동일한 raw→분류 분리 패턴.

## 데이터 모델 — `migrations/0090_live_chat.sql`

```sql
-- raw 채팅: collector 가 적재. 재실행·재분석의 원천. video_id+msg_id 멱등.
CREATE TABLE IF NOT EXISTS live_chat_messages (
  video_id   TEXT NOT NULL,
  group_key  TEXT NOT NULL REFERENCES groups(key),
  msg_id     TEXT NOT NULL,        -- YouTube chat item id
  offset_ms  INTEGER,             -- videoOffsetTimeMsec (방송 시작 후 경과 ms)
  author     TEXT,
  message    TEXT NOT NULL,
  PRIMARY KEY (video_id, msg_id)
);
CREATE INDEX IF NOT EXISTS idx_lcm_video ON live_chat_messages(video_id);

-- 방송 1건 = 리포트 1행. video_id 존재 = 처리 완료(멱등·재시도 제어).
CREATE TABLE IF NOT EXISTS live_chat_reports (
  video_id       TEXT PRIMARY KEY,
  group_key      TEXT NOT NULL REFERENCES groups(key),
  title          TEXT,
  ended_at       TEXT,             -- actualEndTime ISO8601
  generated_at   TEXT NOT NULL,    -- 리포트 생성 시각 ISO8601 UTC
  total_messages INTEGER NOT NULL, -- 긁어온 전체 건수
  sampled        INTEGER NOT NULL, -- LLM 에 넣은 표본 수
  positive_ratio REAL,            -- 추정 0..1
  negative_ratio REAL,
  report_json    TEXT NOT NULL     -- 아래 스키마 직렬화
);
```

`report_json` 형태:
```json
{
  "positive": [{"quote": "...", "note": "..."}],
  "negative": [{"quote": "...", "note": "..."}],
  "themes":   [{"label": "무대 칭찬", "polarity": "positive"}],
  "summary":  "한두 문장 총평"
}
```

## 컴포넌트 (3개, 단일 책임)

### A. `collectors/live_chat.py` → `LiveChatReplayScraper`
- 입력: `video_id`. 출력: `list[dict]` (`{msg_id, offset_ms, author, message}`).
- 흐름:
  1. `GET https://www.youtube.com/watch?v={video_id}` → `ytInitialData` / `INNERTUBE_API_KEY` / `INNERTUBE_CONTEXT.client.clientVersion` 추출. 리플레이 continuation 토큰은 `ytInitialData` 의 `contents...conversationBar.liveChatRenderer.continuations` 또는 player response 의 라이브챗 endpoint 에서 획득.
  2. `POST https://www.youtube.com/youtubei/v1/live_chat/get_live_chat_replay?key={API_KEY}` body `{"context":{"client":{"clientName":"WEB","clientVersion":...}},"continuation":<token>}` 페이지네이션.
  3. 각 응답의 `continuationContents.liveChatContinuation.actions[].replayChatItemAction.actions[].addChatItemAction.item.liveChatTextMessageRenderer` → `{id, authorName.simpleText, message.runs[].text 합성, videoOffsetTimeMsec}`.
  4. 다음 continuation 토큰으로 반복.
- 가드: `MAX_MESSAGES`(예 20000), `MAX_PAGES` 로 런타임 한정. continuation 미발견 → `[]` 반환(채팅 비활성/리플레이 미준비 → graceful). 페이지 간 소폭 지연 + 현실적 User-Agent.
- `http_factory: Callable[[], httpx.Client] | None` 주입(live_ccv 와 동일, 테스트용).

### B. `analysis/live_chat_report.py` → `build_report`
- 입력: `video_id`, `group_name_kr`, `messages`(또는 D1 에서 조회), `gemini`(`_Gemini` 프로토콜).
- 전처리: 완전 동일 문구 중복 제거, 도배(짧은 반복)·이모티콘-only·공백 정리, 타임라인 균등 + 빈도가중으로 최대 `SAMPLE=500` 표본.
- Gemini **1회** 호출(structured output, 아래 스키마) → `{positive_ratio, negative_ratio, positive_quotes[], negative_quotes[], themes[], summary}`.
- 출력: `live_chat_reports` UPSERT statement (`sentiment.py` 가 statement 리스트를 반환하는 패턴 동일). `total_messages`/`sampled` 채워서 반환.
- 실패(예외) → 호출부에서 warn·skip(리포트 미작성 → 다음 run 재시도).

분류 스키마(예):
```json
{
  "type": "object",
  "properties": {
    "positive_ratio": {"type": "number"},
    "negative_ratio": {"type": "number"},
    "positive_quotes": {"type": "array", "items": {"type": "object",
      "properties": {"quote": {"type":"string"}, "note": {"type":"string"}},
      "required": ["quote"]}},
    "negative_quotes": {"type": "array", "items": {"type": "object",
      "properties": {"quote": {"type":"string"}, "note": {"type":"string"}},
      "required": ["quote"]}},
    "themes": {"type": "array", "items": {"type": "object",
      "properties": {"label": {"type":"string"}, "polarity": {"type":"string"}},
      "required": ["label", "polarity"]}},
    "summary": {"type": "string"}
  },
  "required": ["positive_ratio", "negative_ratio", "positive_quotes", "negative_quotes", "summary"]
}
```
프롬프트 핵심: 한국어 K-pop 라이브 채팅(슬랭·도배·이모티콘 다수) 표본을 보고 ① 전체 긍/부정 비율을 **표본 기준으로 추정**, ② 가장 대표성 있는 긍정·부정 멘트 각 3~5개를 **원문 그대로** 발췌, ③ 핵심 테마 도출. 애매하면 중립으로 보고 비율에서 제외.

### C. CLI `collect-live-chat` (cli.py, `collect-ccv` 와 대칭)
- settings: `yt_api_key`(종료 감지용 videos.list), `gemini_api_key`.
- 후보 선별:
  ```sql
  SELECT DISTINCT video_id FROM live_ccv_samples
  WHERE group_key='miiwan'
    AND sampled_at >= :since   -- 최근 3일
    AND video_id NOT IN (SELECT video_id FROM live_chat_reports)
  ```
- `videos.list(part=snippet,liveStreamingDetails)` 배치 호출 → `liveStreamingDetails.actualEndTime` 존재(=종료) AND `snippet.liveBroadcastContent != 'live'` AND 종료 후 `MIN_AGE`(예 30분) 경과한 것만 선택(리플레이 준비 여유).
- 각 종료 방송:
  1. `LiveChatReplayScraper.scrape` → messages.
  2. messages 0건 → skip(리포트 미작성, 3일 윈도 안에서 재시도하다 윈도 벗어나면 자연 종료).
  3. raw batch insert(`live_chat_messages`, 멱등 UPSERT).
  4. `build_report` → `live_chat_reports` insert.
- 멱등: `live_chat_reports.video_id` PK + 후보 쿼리의 `NOT IN`.
- 결과 요약 echo + live_ccv 와 동일한 sentinel(전 후보 실패 시 비-0 종료).

## 프론트

- `/api/miiwan-live-chat` (Cloudflare Pages Function, `frontend/functions/api/`): D1 에서 최근 리포트 N건(`video_id, title, ended_at, total_messages, positive_ratio, negative_ratio, report_json`) 반환. 데이터 없으면 빈 배열(`miiwan.ts` 의 partial-friendly 패턴).
- `MiiWANBriefing` 에 **"라이브 채팅 반응"** 섹션: 방송 카드마다 긍/부정 비율 바 + 대표 멘트 각 3~5개 + 테마 칩. v1 은 최근 방송 리스트 + 펼침 수준으로 최소화.

## 실행 / cron

- 새 워크플로 `collect-live-chat.yml`: GitHub Actions, python CLI `collect-live-chat`.
- 빈도: **하루 2회**(라이브가 KST 심야에 끝나는 점 반영) — KST 04:00 / 12:00 ≈ UTC `0 19 * * *`, `0 3 * * *`. 데뷔 당일 등은 `gh workflow run collect-live-chat.yml` 수동 dispatch.

## 에러 처리

- 스크레이핑 구조 변경/실패 → 해당 video 만 warn·skip. 전 후보 실패 시에만 sentinel(비-0) → notify-fail.
- 리플레이 미준비/채팅off → 빈 결과 graceful skip.
- Gemini 실패 → 해당 리포트만 skip(다음 run 재시도).
- 차단 완화: 현실적 User-Agent + 페이지 간 지연.

## 테스트 (기존 `test_live_ccv.py`/`test_dc.py` 스타일)

- 스크레이퍼: fixture(watch 페이지 + get_live_chat_replay 응답)로 토큰 추출·메시지 파싱·continuation 추적·`MAX_MESSAGES` cap·빈 continuation graceful.
- 리포트 빌더: fake Gemini 로 dedup·표본 상한·스키마→row 매핑·ratio passthrough·statement 형태.
- CLI 후보 선별: fake D1 + fake videos.list 로 종료 감지(actualEndTime)·`MIN_AGE`·멱등(`NOT IN`) 검증.

## 리스크 / 한계

- 채팅 리플레이는 **VOD 가 채팅을 보존한 경우에만** 가능(멤버십/채팅off → 빈 결과, graceful).
- YouTube 가 Actions IP 를 스로틀/차단할 수 있음 — v1 허용 리스크(UA·지연으로 완화). 깨지면 스크레이퍼만 교체.
- 비율은 **표본 기반 추정치**(전수 아님) — UI 에 "추정"임을 명시.

## 비범위 (후속)

- 치지직(Chzzk) 등 타 플랫폼 라이브 채팅.
- 전수 분류·시간대별 추이 그래프(raw 는 적재하므로 추후 가능).
- ccv_tracked 전체 그룹 확대(plave/owis/wegosix).
- 슈퍼챗 금액 집계.
