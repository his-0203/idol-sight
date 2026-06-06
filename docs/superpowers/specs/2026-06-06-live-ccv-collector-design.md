# Live CCV Collector — 설계 (v1)

데뷔-크리티컬 수집기. 라이브 방송 **동시 시청자(concurrent viewers, CCV)** 를 추적해
MiiWAN 데뷔 쇼케이스/라이브 반응을 측정하고 핵심 경쟁사와 벤치마크한다.

- **상태**: 설계 승인됨 (2026-06-06), 구현 전.
- **소스**: YouTube 만 (v1). 치지직은 후속.
- **타겟**: 설정 가능 — 초기 `MiiWAN / PLAVE / OWIS / wegosix`.
- **범위 밖**: 슈퍼챗 금액(3자 API 불가), 치지직, 티켓 매진속도(별도/후속), 방송별 집계 테이블·CCV 알림(v2), market overview/그룹상세 위젯(v2).

## §1 문제 & 비목표

- **문제**: 라이브 반응(동시 시청자)은 팬덤 동원력의 핵심 신호인데 현재 미수집. 데뷔 쇼케이스/라이브의 peak·평균 CCV, 경쟁사 대비 위치를 봐야 함.
- **비목표**: 슈퍼챗 *금액*(YouTube가 3자에 미노출 — Analytics OAuth 안 함 결정과 일관), 채팅 내용 저장(윤리 §2/§3), 실시간 알림.

## §2 데이터 소스 & 쿼터 (감지=RSS, 샘플=videos.list)

라이브 감지는 **YouTube Data API search(100유닛)를 쓰지 않는다.** 대신:

1. **RSS (쿼터 0)**: 타겟 채널의 `https://www.youtube.com/feeds/videos.xml?channel_id=<UC...>` 를 HTTP GET → 최근 ~15개 video ID. Data API 아님 → 쿼터 미소모.
2. **videos.list (1유닛/호출)**: 위 ID들을 50개 batch 로 `videos.list(part=snippet,liveStreamingDetails)` → `snippet.liveBroadcastContent=='live'` & `liveStreamingDetails.concurrentViewers` 존재 = 현재 라이브. 그 값이 CCV 샘플.

**쿼터 비용**: 사이클당 RSS 4건(무료) + videos.list ~1–2유닛. 30분 cadence(48사이클/일) ≈ **50–100유닛/일** (일일 한도 10,000 의 ~1%). 라이브 중 시간당 ~2유닛. → **YouTube 쿼터는 사실상 무료, 다른 수집과 합쳐도 한도 안전.**

**한계**: RSS는 신규 라이브 반영에 수 분 지연 가능, 비공개/언리스티드 라이브는 누락. 예고된 데뷔 쇼케이스(공개)엔 무방. 필요 시 운영자가 video_id 시드로 즉시 추적(v2).

## §3 실비용 — GitHub Actions 분 (유일한 실질 비용)

YouTube 쿼터·D1 비용은 무시 가능. **유일한 실비용은 Actions 분.** 30분 cron 전일 = ~48 run/일.
- **기본값(권고): 라이브 집중 시간대 윈도잉** — KST 17:00–익일 02:00(UTC 08:00–17:00) 30분 cron ≈ ~18 run/일. 비-라이브 사이클은 RSS만 돌고 거의 즉시 종료.
- **데뷔 당일**: `gh workflow run collect-ccv.yml` 수동 dispatch 로 촘촘히.
- repo 가 public 이거나 분 여유 충분하면 전일 30분도 가능 — cron 한 줄만 바꾸면 됨. (스펙 검토 시 확정)

## §4 데이터 모델 (migration, additive)

```sql
-- 타겟 토글
ALTER TABLE groups ADD COLUMN ccv_tracked INTEGER NOT NULL DEFAULT 0;
UPDATE groups SET ccv_tracked=1 WHERE key IN ('miiwan','plave','owis','wegosix');

-- CCV 시계열 (라이브 중에만 적재)
CREATE TABLE live_ccv_samples (
  video_id            TEXT NOT NULL,
  group_key           TEXT NOT NULL,
  sampled_at          TEXT NOT NULL,   -- ISO8601 UTC
  concurrent_viewers  INTEGER NOT NULL,
  title               TEXT,
  PRIMARY KEY (video_id, sampled_at)
);
CREATE INDEX idx_ccv_group_time ON live_ccv_samples (group_key, sampled_at);
```

- `ccv_tracked` 는 boolean(INT) — JSON 컬럼 아님 → `test_migrations_groups_json` 가드와 무관.
- CCV 는 집계 수치(시청자 수)라 윤리 OK — 내용·신상 저장 없음.
- 방송별 peak/avg 는 v1 에선 **쿼리 집계**(`MAX/AVG(concurrent_viewers) GROUP BY video_id`). 별도 집계 테이블은 v2.
- **보존**: 시계열이라 무한 누적 — governance-runbook 보존 표에 추가(예: 180일 후 다운샘플/삭제, 후속).

## §5 컴포넌트 & 데이터 흐름

```
collect-ccv.yml (cron, 윈도잉)
  └─ cli.py: collect-ccv
       └─ collectors/live_ccv.py: LiveCcvCollector
            1. ccv_tracked=1 그룹 + yt_channel_id 로드
            2. 각 채널 RSS GET → 최근 video IDs (쿼터 0)
            3. videos.list(part=snippet,liveStreamingDetails) batch → 라이브+CCV 추출
            4. 라이브인 영상마다 live_ccv_samples UPSERT (PK video_id+sampled_at)
       └─ D1Client.batch(statements)  (멱등 UPSERT)
```

- `collectors/base.py` 패턴 준수 (CollectionResult 반환, raise 안 함 — best-effort, orchestrator/CLI 가 실패 기록).
- RSS fetch 실패/라이브 없음 = 정상(빈 result). 전 타겟 fetch 실패 시 sentinel error.
- `cli.py` 에 `collect-ccv` command 등록.

## §6 노출 (frontend, v1 최소)

1. **`/api/live-ccv`** (Pages Function): 타겟별 *최근 방송*의 peak/avg CCV + 최근 N 샘플(스파크라인용) + last sampled_at. 사이트 인증 뒤(/api).
2. **MiiWANBriefing "라이브 반응" 카드**: MiiWAN 최근 방송 peak/avg CCV + 스파크라인 + 타겟 벤치마크(MiiWAN vs PLAVE/OWIS/wegosix 최근 peak 바). 라이브 이력 없으면 graceful "데이터 없음".
- market overview 칼럼·그룹상세 위젯은 v2.

## §7 테스트

- `LiveCcvCollector`: RSS 파싱(고정 XML fixture) → video IDs, videos.list 응답(mock)에서 라이브/CCV 추출, 비-라이브/빈 RSS 처리, UPSERT statement 형태.
- `/api/live-ccv`: mock DB 로 peak/avg 집계 + 빈 데이터 graceful.
- migration: `test_migrations_groups_json` 는 영향 없음(ccv_tracked 비-JSON) — 신규 테이블 적용만 전체 마이그레이션 가드가 자연 커버.

## §8 비용·충돌 요약 (PM 확인용)

| 항목 | 영향 |
|---|---|
| YouTube API 쿼터 | ~50–100유닛/일 (한도 10,000 의 ~1%). RSS=0, videos.list=1u. **무료 수준** |
| 다른 기능 충돌 | 없음 (격리 collector/migration/workflow, additive) |
| D1 비용 | 라이브 중 소량 UPSERT. 무시 가능 |
| **GitHub Actions 분** | **유일한 실비용.** 윈도잉 cron 으로 ~18 run/일 권고, 데뷔일 수동 dispatch |
| 데이터 누적 | live_ccv_samples 시계열 — 보존 정책 후속(governance-runbook) |
