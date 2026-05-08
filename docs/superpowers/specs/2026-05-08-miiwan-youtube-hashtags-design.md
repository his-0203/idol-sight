# 미완소년 공식 YouTube 해시태그 수집 (MiiWAN-only)

작성일: 2026-05-08
범위: 단일 PR

## 1. 배경

`worker/src/idol_sight/collectors/youtube.py`는 `videos.list?part=snippet,statistics,contentDetails`로 metadata를 받지만, `snippet.tags`(영상 태그 배열)와 `snippet.description`(설명란 `#해시태그`)는 모두 무시한다. `youtube_videos` 스키마에 보관 컬럼도 없다.

MiiWAN(자사 데뷔 그룹)은 데뷔 D-30 구간을 앞두고 콘텐츠 캠페인 태그가 핵심 자산이 되므로, 해시태그를 인덱싱해 향후 캠페인 추적·트렌딩 분석을 가능하게 한다. 경쟁/벤치마크 그룹은 스코프에서 제외(윤리 가이드라인 §4 — 자사 그룹 위주로 깊이).

## 2. 범위

**포함**
- MiiWAN 공식 채널(`group.key == "miiwan"`)의 영상에 한해 `snippet.tags`와 `snippet.description`의 `#해시태그` 통합 추출
- recent 모드(daily cron)와 full-history 모드(backfill CLI) 양쪽 모두 적용
- 기존 영상 소급 채움: `backfill-yt-videos --group miiwan` 1회 재실행으로 ON CONFLICT UPDATE 경유

**제외**
- MiiWAN 외 그룹(PLAVE/ISEDOL/STELLIVE/SKINZ/MY:RAKL/OWIS/B:DAWN/WEGOSIX): `tags` 컬럼은 NULL 유지
- 멤버 솔로 채널: 현재 MiiWAN에 등록된 솔로 채널 없음. `_members_loader`가 빈 리스트를 반환하므로 별도 분기 불필요
- 해시태그 분석 모듈(빈도/트렌딩/HHI 등): 본 스펙에서는 저장만, 분석은 후속 작업
- LLM 프롬프트 노출: 본 스펙 미포함

## 3. 데이터 모델

### Migration 0050: `youtube_videos.tags`

```sql
ALTER TABLE youtube_videos ADD COLUMN tags TEXT;
```

- 타입: `TEXT` (JSON array literal, 예: `["miiwan","마하진","kpop"]`)
- nullable. 기본값 NULL. 다른 그룹 / 추출 결과가 빈 배열인 경우 NULL 저장
- 인덱스 없음 (현 단계에서는 풀스캔으로도 무방. 트렌딩 쿼리 도입 시 GENERATED COLUMN + 인덱스 검토)

저장 형식 결정:
- 빈 배열 `[]` 대신 NULL: 분석 쿼리에서 `WHERE tags IS NOT NULL`로 빠르게 필터, COALESCE 단순화

## 4. 추출 로직

### `_extract_hashtags(snippet: dict) -> list[str]`

1. 입력
   - `snippet.tags` (list[str], YouTube가 명시적으로 받는 영상 태그)
   - `snippet.description` (str, `#xxx` 패턴 산재)
2. 정규식: `#([\w가-힣]+)` — 한글/영문/숫자/언더스코어 조합 토큰. `#` prefix는 capture에서 제외 (저장 시 prefix 없음)
3. 통합 규칙
   - 두 소스의 결과를 단일 리스트로 병합
   - dedupe key는 lowercase. 첫 등장 원본 케이스 유지 (한글은 case가 의미 없으므로 손실 없음)
   - 순서: snippet.tags 먼저, 그 뒤 description 순회 순서
4. 정상화
   - 양 끝 공백 제거. 공백 포함 토큰은 정규식이 자동 분리
   - 1자 이하 토큰 제외 (의미 없는 #x 방지)
5. 결과
   - 비어 있으면 None 반환 (caller가 NULL로 저장)
   - 그 외에는 `list[str]` (caller가 `json.dumps`로 직렬화)

### Collector 통합

`collect()` 안에서 영상 단위 INSERT 직전:

```python
tags_json: str | None = None
if group.key == "miiwan":
    extracted = _extract_hashtags(sn)
    if extracted:
        tags_json = json.dumps(extracted, ensure_ascii=False)
```

INSERT 변경:

```sql
INSERT INTO youtube_videos
  (video_id, group_key, channel_id, title, duration_sec,
   published_at, content_type, is_short, first_seen_at, tags)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(video_id) DO UPDATE SET
  title=excluded.title,
  content_type=excluded.content_type,
  is_short=excluded.is_short,
  tags=excluded.tags
```

ON CONFLICT 시 `tags=excluded.tags`도 갱신 → backfill 재실행으로 과거 영상 소급 보완.

## 5. 백필 절차

운영자 1회 실행:

```bash
cd worker
uv run idol-sight backfill-yt-videos --group miiwan
```

- `_fetch_all_uploads`로 MiiWAN 채널 uploads playlist 전체 페이지네이션
- 각 영상은 `videos.list?part=snippet,...`으로 받으며 새 collector 로직이 tags 추출
- ON CONFLICT UPDATE로 기존 row의 `tags` 컬럼 채움
- 데뷔 전 시점이라 영상 수 적음(추정 ≤ 50). 쿼터 10 단위 미만

## 6. 테스트

### Unit (`worker/tests/unit/test_youtube.py`)

1. `test_extract_hashtags_merges_snippet_tags_and_description`
   - 입력: `tags=["MiiWAN","kpop"]`, `description="첫 미완소년 무대 #miiwan #마하진 #데뷔"`
   - 기대: `["MiiWAN","kpop","마하진","데뷔"]` (miiwan은 case-insensitive dedupe로 제거)
2. `test_extract_hashtags_returns_none_when_empty`
   - 입력: 비어있는 snippet → None
3. `test_extract_hashtags_strips_short_tokens`
   - 입력: `description="#a #ab #가"` → `["ab"]` (1자 토큰 제외)
4. `test_youtube_collector_populates_tags_only_for_miiwan`
   - MiiWAN GroupConfig + tags/description 채워진 fixture → INSERT params에 JSON tags 포함
5. `test_youtube_collector_skips_tags_for_non_miiwan`
   - PLAVE GroupConfig + 동일 fixture → INSERT params의 tags 필드 None

### 회귀

- 기존 `test_youtube_collector_emits_video_and_stats_inserts`(PLAVE) → INSERT 컬럼 수 증가 / params 인덱스 변경에 맞춰 어서션 갱신
- 기존 `test_youtube_collector_fans_out_across_member_channels`(ISEDOL) → 동일

## 7. 변경 파일

| 파일 | 변경 |
|---|---|
| `migrations/0050_youtube_video_tags.sql` | 신규 |
| `worker/src/idol_sight/collectors/youtube.py` | `_extract_hashtags` 추가, INSERT 컬럼/파라미터, ON CONFLICT UPDATE |
| `worker/tests/unit/test_youtube.py` | 단위 5건 추가 + 기존 2건 어서션 보정 |
| `docs/superpowers/specs/2026-05-08-miiwan-youtube-hashtags-design.md` | 본 문서 |

## 8. 비목표 / 후속

- 해시태그 빈도/트렌딩 분석 모듈
- 음악쇼 / Discord alert 트리거에 연동
- LLM weekly 프롬프트에 캠페인 태그 노출
- 인덱스 최적화 (필요 시 GENERATED COLUMN + JSON index)
- 멤버 솔로 채널 등록 시 확장 (현재 미존재로 미구현)

## 9. 윤리 가이드라인 적합성

- §1 본체 정보 미저장: 해시태그는 공식 채널 발화이므로 무관
- §2 2차 창작 양만: 본 스펙은 공식 채널만 대상. 팬 측 해시태그 추적 아님
- §4 자사 그룹 위주 깊이: MiiWAN-only 분기로 명시 준수

---

## V2.5.2 후속 — 전 그룹 확장 (2026-05-08)

§9 윤리 가이드라인 §4 의 "MiiWAN-only" 분기는 **공식 채널 발화 해시태그 한정** 으로 완화한다. 변경 사항:

- `youtube.py` collector 의 `if group.key == "miiwan":` guard 제거 → 모든 그룹의 공식 채널에서 `tags` 수집
- 멤버 attribution SQL (`cli._MEMBER_POP_FETCH_SQL`) 의 `OR EXISTS(json_each(tags))` 절은 이미 group-agnostic 이라 자동으로 PLAVE / ISEDOL / STELLIVE / SKINZ / MY:RAKL / OWIS / B:DAWN / WEGOSIX 멤버 attribution 정확도가 함께 개선됨

**근거**:
1. 해시태그는 운영자가 공식 채널에 직접 입력한 메타데이터이므로 §1 (본체 정보) / §2 (2차 창작 본문) 와 무관
2. §4 "자사 그룹 위주 깊이" 의 의도는 위기 감지·신상 정보·팬 콘텐츠 본문 등 **민감 데이터** 의 비대칭이지, 공식 메타데이터는 아님
3. 경쟁사 멤버 attribution 정확도 개선 → SOV / Health Score 등 cohort-비교 KPI 의 정확도 동반 상승

**기존 영상 backfill**: 운영자 판단. 데이터 자연 누적을 기다리려면 daily cron 으로 충분. 정확도 즉시 개선이 필요하면:

```bash
uv run idol-sight backfill-yt-videos          # 전 그룹 walk
# 또는 그룹별 (PLAVE 1575편 가장 큼)
uv run idol-sight backfill-yt-videos --group plave
```

**테스트 변경**:
- `test_youtube_collector_skips_tags_for_non_miiwan` → `test_youtube_collector_populates_tags_for_non_miiwan_group` (의미 반전)
- `test_youtube_collector_tags_null_when_snippet_empty` 추가 — tags/description 양쪽 비면 NULL (그룹 무관)

`test_member_attribution.py` 의 10건은 SQL 자체 검증이라 변경 없음.
