# 그룹 온보딩 체크리스트

새 그룹 추가는 migration·collector·relevance·UI 의 **여러 이음매**를 건드려 매번
사고가 났다 (blacklist CSV-vs-JSON 3회 재발, alias↔enum drift 등). 이 순서대로.

## 1. Migration (`migrations/00NN_add_<group>.sql`)
- `INSERT INTO groups` — **JSON 컬럼은 반드시 JSON 배열 리터럴** (CSV 금지):
  - `context_keywords` `'["...","..."]'` — 영문 대/소문자·Title·콜론/하이픈/공백 변형·한글 초성 약자 모두 (예: WeGoSix → wegosix/WeGoSix/wego6/we go six/ㅇㄱㅅㅅ)
  - `blacklist_phrases`, `twitter_handles`, `dc_supplemental_galleries`,
    `theqoo_supplemental_boards`, `instiz_supplemental_boards` — JSON 배열(없으면 `'[]'` 또는 NULL)
  - `group_model` (corporate / segmentary), `dc_gallery_id`, `naver_query`, `debut_date`(있으면 `yt_channel_id` UC… 24자)
- 멤버는 `INSERT INTO members` (라인업 공개 시).
- **가드**: `cd worker && uv run pytest tests/unit/test_migrations_groups_json.py` — 전체 마이그레이션 적용 후 JSON 컬럼 전수 검증. 통과해야 함.
- 적용: **운영자 직접** `gh workflow run migrate.yml`(또는 `wrangler d1 migrations apply idol-sight --remote`). 자동 아님(human-gated).

## 2. Relevance / 일반어 충돌 (`analysis/relevance.py`)
- 짧은 토큰(한글 초성 2자, 영문 일반어)은 `GENERIC_KEYWORD_BLOCKLIST` + anchor gate 로 안전. 일반어 충돌 토큰(예 "Zero","URL","모카") 추가 검토.
- short-token anchor gate 가 일반어 자동 차단 — 초성도 적극 시드 가능.

## 3. 수집 매트릭스 (workflows)
- collect-hourly / collect-6h / collect-daily 의 그룹 매트릭스에 편입(어느 cadence로 수집할지).
- `cli.py _INTERVALS_H` ↔ cron 정렬 확인(test_cli_intervals 가드).

## 4. 음방 추적 후보면 (선택)
- `collectors/music_show._GROUP_QUERY_ALIASES` **와** `llm/music_show.GROUP_KEY_ENUM` **둘 다** 추가(검색↔emit 일치, test_music_show_collector 가드). 후보 아니면 둘 다 미추가.

## 5. 검증
- 첫 dispatch 후 **`⚙ 상태` 페이지**에서 해당 그룹 잡이 ok 로 뜨는지, 수집 행이 적재됐는지 확인.
- DC mgallery/mini 갤러리 namespace 차이 주의(`dc.py` fallback). 갤러리 미개설이면 supplemental 만.

## 6. 문서/메모리
- CLAUDE.md V2.x changelog 한 줄. 도메인 결정(호명·일반어 가드 등)은 메모리에.

> 자주 나는 실수: ① JSON 컬럼 CSV 시드 ② music_show alias만 추가하고 enum 누락(검색만 하고 emit 못 함) ③ migrate 수동 적용 누락 → 새 컬럼 읽는 API 500.
