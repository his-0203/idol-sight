# 커뮤니티 검색·보조 게시판 collector (TheQoo / Instiz)

작성일: 2026-05-21 (검증 결과로 2026-05-21 본문 일부 갱신, §0 참고)
범위: 단일 PR (V2.28 — supplemental boards 인프라)
선행: V2.27.1 (`fix(dc): V2.27.1 supplemental 매칭 strict mode`)
선결 의존: 없음 (D1 스키마 / orchestrator 구조 그대로 재활용)

## 0. 2026-05-21 검증 결과 — 방향 전환 기록

spec §10 의 Rollout step 1 (fixture 캡처) 을 실제 진행한 결과, 두 사이트
모두 **검색 자동화가 차단**되어 있음을 확인했다.

| 사이트 | 시도 URL | 결과 | 분석 |
|---|---|---|---|
| TheQoo | `?mid=hot&search_target=title&search_keyword=미완소년` | HTTP 200 / 37KB / hot-board default | form `processBoardSearch()` JS-bind, query string 직접 호출은 검색 트리거 안 함 |
| TheQoo | `?act=IS&...` (XE Item Search action) | **HTTP 403** | 서버가 외부 검색 액션 차단 |
| Instiz | `/name?searchtype=title&stext=미완소년` | HTTP 200 / 115KB / `/name` default | form 진짜 action 은 `/bbs/list.php?k=…` |
| Instiz | `/bbs/list.php?k=미완소년` | HTTP 200 / **8KB 빈 결과** | 로그인 / 추가 cookie 요구 추정 |

→ spec §9 "Spec 가정 검증 실패 → 사이트별 대안 별도 spec 으로" 시나리오
   적중. step 1 이 stop 시그널로 의도대로 작동.

**방향 전환**: 검색 보조를 포기하고 **V2.27 디시 패턴 (supplemental
galleries) 을 더쿠 / 인스티즈로 옮기는 supplemental boards 패턴**을 채택.
즉:

- `groups.theqoo_supplemental_boards TEXT` (JSON 배열, e.g. `["kpop"]`)
- `groups.instiz_supplemental_boards TEXT` (JSON 배열, e.g. `["musicpd"]`)
- 두 collector 가 primary hot-board fetch 후 supplemental 게시판 각각에
  대해 fetch + `is_relevant(strict_generic_blocklist=True)` 필터링

본 spec §3 ~ §6 의 "검색 URL / 새 collector 클래스" 부분은 폐기. §0
의 supplemental boards 패턴이 정식이고, §10 Rollout 도 그에 맞춰
재정의(아래 §10 갱신본 참고).

캡처해둔 fixture (`theqoo_search.html`, `instiz_search.html`) 는 검증
실패 자료로 의미가 줄어들었고 크기 합 ~150KB 이므로 본 작업으로 폐기.

## 1. 배경

기존 `theqoo.py` / `instiz.py` collector 는 사이트 전체 핫보드 1개만
fetch + 그룹별 `context_keywords` 로 필터한다(`is_relevant`). 이 패턴은
PLAVE / ISEDOL / STELLIVE 같이 핫에 자주 오르는 그룹에는 충분하지만,
**MiiWAN 처럼 데뷔 전 그룹은 핫보드 진입 자체가 드물어 구조적 누락**
이 발생한다.

V2.26 ~ V2.27.1 에서 디시 쪽 누락은 (a) `dc_gallery_id` 등록, (b)
`dc_supplemental_galleries` 통합갤 fetch, (c) strict mode false positive
제거로 해결됐다. 더쿠 / 인스티즈 쪽은 사이트가 자체 검색 URL 을
제공하므로 동일한 누락을 검색 기반 보조 collector 로 메꿀 수 있다.

본 spec 은 검색 보조 collector 의 설계 / 데이터 모델 / 윤리 가이드라인
적합성을 정리한다. 실제 코드는 본 spec 승인 후 별도 PR 로 진행.

## 2. 범위

**포함**
- TheQoo 검색 보조 collector (`TheQooSearchCollector`, source 명
  `theqoo_search` 가칭). 사이트 검색 URL 패턴 발견 + fixture 캡처 +
  파서 + orchestrator 등록 + collect-6h.yml 매트릭스 확장
- Instiz 검색 보조 collector (`InstizSearchCollector`,
  source 명 `instiz_search`). 동일 패턴
- 적용 그룹: MiiWAN 만 시드(데뷔 전 핫보드 누락 위험 가장 큼). 다른
  그룹은 hot-board collector 가 잘 작동하므로 보조 검색은 비용/이득
  관점에서 제외
- 키워드 expansion: 핵심 토큰만 (`미완소년`, `MiiWAN`, `ㅁㅇㅅㄴ`).
  멤버명까지 확장은 검색 호출 수가 두 사이트 × 8~10 토큰 = 16~20
  req/cycle 로 과부하 → 본 spec 에서는 그룹 본명·약어 3개만

**제외**
- 검색 결과 본문 저장: `community_posts.title` + 표시용 URL 만. 본문
  스크래핑 / 댓글 / 작성자 정보는 윤리 가이드라인 §3 위반
- 다른 커뮤니티 (fmkorea / 네이트판 / 보배드림 / 디시 외 통갤 → 별도
  collector 설계 필요): 본 spec 외
- 검색 기반 backfill: 두 사이트 모두 페이지네이션 가능하지만 backfill
  은 별도 spec. 본 PR 은 현재 시각 ±24h window 의 최신 결과만
- LLM / 분석 파이프라인 변경: 새 source 의 데이터는 기존 community
  관련 분석(`community.py` 등)을 그대로 통과

## 3. 검색 URL 후보 (사전 조사 결과)

### 3.1 TheQoo

| 항목 | 값 |
|---|---|
| Base | `https://theqoo.net/index.php` |
| 핫보드 검색 추정 | `mid=hot&search_target=title&search_keyword=<query>` |
| Plain curl 검증 (2026-05-21) | HTTP 200, 응답 ~534 line, 결과 목록 마크업 미발견. **사용자 에이전트 / JS 렌더링 필요 시그널** |

→ 1차 가설: 검색 결과는 sketchbook5 ajax 로 hydration 됨. plain
   curl 로는 빈 shell 만 보임. **fixture 캡처는 반드시 StealthyFetcher
   network_idle=True 로**.

→ 백업 가설: 검색이 핫보드(`mid=hot`) scope 이 아니라 사이트 전체일 수
   있음. `mid=hot` 제거 + base path 변형 (`hot/<srl>` vs `square`) 도
   탐색 필요. **첫 구현 step 은 실제 캡처 + 마크업 분석.**

### 3.2 Instiz

| 항목 | 값 |
|---|---|
| Base | `https://www.instiz.net` |
| 일반 검색 추정 | `/name?searchtype=title&stext=<query>` |
| Plain curl 검증 (2026-05-21) | HTTP 200, 응답 ~1514 line, 마크업 일부 노출 (`searchtype` / `stext` 토큰 검출) |

→ 디시 / 더쿠 보다 친화적. 기존 `instiz.py` 의 legacy table fallback
   (`td.subject a` / `td.cnt` / `td.hit`) 가 검색 결과 페이지에도 그대로
   적용될 가능성. 그래도 fixture 캡처는 필수.

## 4. 설계

### 4.1 코드 구조 — 신규 vs 확장

선택지를 비교한 결과:

| 안 | 장점 | 단점 |
|---|---|---|
| **A. 신규 collector 클래스 (theqoo_search.py / instiz_search.py)** | 검색 URL 빌딩, 페이지네이션, 키워드 expansion 로직이 hot-board collector 와 분리되어 가독성 ↑. source name 으로 운영자가 두 채널을 구분 가능. fixture 별도 보관 → 회귀 격리 | 코드 중복 (parse 함수 재활용 가능) |
| B. 기존 `theqoo.py` / `instiz.py` 에 mode 추가 | 코드량 ↓ | 단일 클래스가 두 가지 URL 패턴 + 두 가지 결과 마크업을 다루면서 분기 폭발 |

→ **A 채택**. parse 함수만 모듈 함수로 추출해 재사용
   (`_parse_theqoo_list(page)`, `_parse_instiz_list(page)`).

### 4.2 source name / platform 컬럼

| 결정 사항 | 값 | 이유 |
|---|---|---|
| `Collector.source` (orchestrator dispatch key) | `theqoo_search`, `instiz_search` | hot-board 와 구분된 매트릭스 잡 — failure / runtime 통계 분리 |
| `community_posts.platform` (저장 값) | **`theqoo`, `instiz` 그대로 유지** | frontend 의 platform-별 집계 (`community.py` 등) 가 두 채널을 합쳐서 보이게. 운영자는 신호의 총량을 보고 싶지 source 를 구분하고 싶지 않음 |
| dedupe | `url_hash` 기준 ON CONFLICT UPDATE title (기존 동일) | hot-board 와 검색이 같은 글을 잡으면 두 번째 fetch 는 stat snapshot 만 추가 |

### 4.3 키워드 expansion

```
queries = [group.name_kr, group.name, "ㅁㅇㅅㄴ"]   # MiiWAN 만 시드
queries = [q for q in queries if q]
```

- 그룹 본명 1~2개 + 1개의 약어. 호출 수 / 그룹 / 사이클 = 3.
- 5개 미만으로 제한 — 검색 호출은 fetch 단위로 시간 ↑ + 사이트
  rate-limit 위험 ↑.
- 멤버명 확장은 본 spec 외. 추후 필요 시 `dc_supplemental_galleries`
  처럼 그룹 단위 JSON 컬럼(`search_extra_queries TEXT`) 추가 검토.

### 4.4 결과 필터링

- 각 검색 결과 row 를 `is_relevant(title, group)` 통과시킴
  (`strict_generic_blocklist=False` — 검색이 이미 키워드 기반이라
  추가 strict 불필요. hot-board 와 일관)
- `is_global_spam` 도 `is_relevant` 내부에서 fire
- url_hash 기준 dedupe 후 INSERT

### 4.5 페이지네이션

- 검색 첫 페이지 (최신 30~50 건) 만. 페이지네이션은 backfill spec 으로
  분리.
- "since 시각 이후 글만" 필터는 page 첫 row 의 `posted_at_raw` ≥ since
  로 옵션 처리. 본 PR 은 단순 INSERT (ON CONFLICT 가 중복 흡수).

## 5. 데이터 모델

스키마 변경 없음. `community_posts` / `community_post_stats` 그대로
사용 (V2.27 dc supplemental 처럼 platform 컬럼 값만 'theqoo' /
'instiz' 로 통일).

선택적 추가 컬럼 후보 (본 spec 외):
- `community_posts.source_channel TEXT` — 'hot' / 'search' 구분.
  운영자가 hot 진입 비율 같은 메타 분석 시 유용. **본 spec 채택 시
  마이그레이션 1개 + frontend api 수정.** 현 시점에서는 비용/이득
  애매하여 보류, 필요 발생 시 별도 PR.

## 6. orchestrator / CLI / 워크플로우 통합

### 6.1 orchestrator

`orchestrator.py` 의 `DISPATCH` 매핑에 두 source 추가:

```python
DISPATCH = {
    ...,
    "theqoo_search": TheQooSearchCollector,
    "instiz_search": InstizSearchCollector,
}
```

### 6.2 CLI

`collect --source theqoo_search --group miiwan` 로 단일 실행 가능
(기존 collect 명령 그대로).

### 6.3 GitHub Actions

`collect-6h.yml` 매트릭스 확장:

```yaml
matrix:
  group:  [..., miiwan, ...]
  source: [dc, theqoo, instiz, theqoo_search, instiz_search]
```

- 단 그룹 × source 조합이 9 × 5 = 45 잡 → 비용 ↑. 더 깔끔한 길:
  **별도 잡 명시** — 검색 보조는 MiiWAN 만이라 매트릭스 expansion 대신
  steps 마지막에 하드코딩 1 step 추가:
  ```yaml
  - run: uv run python -m idol_sight collect --source theqoo_search --group miiwan
  - run: uv run python -m idol_sight collect --source instiz_search --group miiwan
  ```
  단 fail-fast=false 매트릭스 격리 이점이 사라짐.

→ **결정**: 매트릭스 expansion 채택하되 매트릭스 `include` 절로
   miiwan × {theqoo_search, instiz_search} 만 추가. 다른 그룹은 제외.

   ```yaml
   matrix:
     group:  [plave, isedol, stellive, skinz, myrakl, miiwan, owis, bdawn, wegosix]
     source: [dc, theqoo, instiz]
     include:
       - { group: miiwan, source: theqoo_search }
       - { group: miiwan, source: instiz_search }
   ```

   결과 잡 수: 9 × 3 + 2 = 29.

## 7. 윤리 가이드라인 적합성

| 조항 | 본 spec 처리 |
|---|---|
| §1 본체 정보 BI 직접 저장 금지 | 검색 결과의 `title` 만 저장. 본문 / 작성자 / 댓글 미수집 |
| §2 2차 창작 트래킹은 양만 | views / likes / comments 수치만. 본 spec 은 본문 미참조 |
| §3 디시·더쿠 게시물 원문 저장 신중히 | **원문 본문 미저장**. title 은 게시판 검색결과 목차로서 BI 신호로 필수 |
| §4 자사 그룹 위주 깊이 | 시드는 MiiWAN 단독. 경쟁사 확장은 별도 결정 |
| §5 위기 알림 인간 검증 필수 | 검색 보조 결과가 alert engine 에 들어가지 않음 (community_posts → agg_summary 까지만) |

## 8. 검증 계획

1. **fixture 캡처** — 첫 step. 실제 사이트에 StealthyFetcher 로
   접근해 `미완소년` 검색 결과 HTML 을 `tests/unit/fixtures/`
   에 저장 (`theqoo_search.html`, `instiz_search.html`)
2. **파서 단위 테스트** — 캡처 fixture 로 row 추출 + 빈 결과 / 검색
   no-match 케이스 분리
3. **`is_relevant` 매칭 검증** — 결과의 일부가 V2.26 키워드 (`미완소년`,
   `MiiWAN`, `ㅁㅇㅅㄴ`) 로 통과하는지 확인
4. **integration smoke** — `collect --source theqoo_search --group miiwan`
   을 GitHub Actions 환경에서 1회 수동 dispatch, community_posts 신규
   row 발생 확인
5. **신호/노이즈 측정** — 첫 dispatch 결과의 title 5~10건을 수동
   분류해서 V2.27.1 vboyband (100%) 같은 비율을 목표. 미달 시 키워드
   조정 또는 strict mode 적용 검토

## 9. 비용 / 리스크

| 항목 | 영향 |
|---|---|
| GitHub Actions 잡 수 | +2 / cycle (miiwan 만), 각 ~30s |
| D1 행 증가 | 추정 MiiWAN ~5~20 / 사이클. 시계열 부담 작음 |
| 사이트 rate-limit | TheQoo / Instiz 검색은 documented quota 없음. 3 query × 30s 간격 사이에 자체 throttling 없으면 robot challenge 위험 → fetch 사이 1~2s sleep 권장 |
| MiiWAN 외 그룹 확장 결정 | 본 spec 후속 데이터로 신호량 측정 후 재평가 |
| Spec 가정 검증 실패 (예: TheQoo 검색이 ajax 라 StealthyFetcher 로도 빈 결과) | 본 spec 의 step 1 (fixture 캡처) 실패가 곧 stop 시그널. 그 경우 사이트별 대안 (sitemap / RSS / 외부 검색 API) 별도 spec 으로 |

## 10. Rollout 순서 (2026-05-21 갱신본 — supplemental boards 패턴)

§0 의 검증 결과에 따라 검색 URL 기반 Rollout 은 폐기. 다음이 정식.

1. **인프라 마이그레이션 0063 + GroupConfig 확장 (V2.28)**
   - `theqoo_supplemental_boards`, `instiz_supplemental_boards` 두
     컬럼 신설. 시드는 모두 NULL. 컬럼만 존재하면 추후 운영자가 1줄
     UPDATE 로 보조 게시판 추가 가능.
2. **theqoo.py / instiz.py supplemental loop 추가**
   - V2.27 dc.py 패턴 그대로 재활용. primary URL fetch 후
     supplemental boards 각각에 대해 fetch + `is_relevant(...,
     strict_generic_blocklist=True)` + url_hash dedupe.
   - errors 격리 (per-board try/except).
3. **테스트 보강** — 각 collector 의 supplemental 매칭 / primary-only /
   strict 모드 동작.
4. **D1 적용 + commit + push + dispatch + 회귀 검증**
   - 시드 NULL 이라 dispatch 시 supplemental 행 0. primary hot-board
     동작 회귀만 확인.
5. **운영자 도메인 지식 기반 시드** (별도 PR)
   - 더쿠 / 인스티즈에 미완소년 또는 다른 그룹이 자주 언급되는 통합
     게시판 발견 시 1줄 UPDATE 마이그레이션. 발견될 때까지 컬럼은
     NULL — 즉 V2.28 자체는 인프라만 깐다.
6. **(선택) 신호량 측정** — 통합 게시판 시드 후 신호/노이즈 비율을
   디시 vboyband (V2.27.1 100%) 와 비교, 부족 시 strict mode 보강 또는
   해당 게시판 제외 결정.

## 11. 비목표 (재확인)

- TheQoo / Instiz 본문 / 댓글 / 작성자 트래킹 — 본 spec 없음 / 향후
  세션에서도 윤리 가이드라인 §3 로 금지
- 검색 결과의 LLM 요약 — 본 spec 외
- 한 PR 안에서 두 사이트 모두 — 사이트별 분리 PR 권장 (fixture 검증
  실패 / 마크업 차이 대응)
- spec 의 모든 가정이 실제로 통과한다는 보장 — 4의 첫 step (fixture
  캡처) 결과에 따라 spec 본문이 일부 수정될 수 있음
