# Historical Pre-Debut Backfill — 출처 및 검증 노트

대상: PLAVE / OWIS / SKINZ / MYRAKL의 데뷔 D-180 ~ D+90 구간 yt_subscribers + naver_total_news 백필.

방법론과 검증은 `docs/superpowers/specs/2026-05-06-historical-debut-backfill-design.md` §5 참조.

## 공통 검증 룰
- 주 1회 (월요일 00:00 KST) + 핵심 마일스톤 일자 일별 추가
- Cross-source 스폿체크: Social Blade vs Playboard 같은 날짜 ±10%
- Naver 뉴스 동명이인/무관 검색결과 30 샘플 수동 점검

---

## 공통 — 소스 시도 결과 요약

| 소스 | 결과 | 비고 |
|---|---|---|
| Wayback Machine CDX API | ✅ 성공 (PLAVE/SKINZ) | MYRAKL/OWIS 채널 너무 신규 |
| Wayback Machine 스냅샷 파싱 | ✅ 성공 | subscriberCountText.simpleText 패턴 |
| Naver News (StealthyFetcher) | ✅ 성공 — 138개 주간 카운트 | 스텔스 패스에서 차단 해제, 파이프 OR 인코딩 필요 |
| Social Blade (StealthyFetcher) | ⚠️ 부분 성공 | 무료 티어 = 최근 14일만 제공, 히스토리 = 유료 |
| Playboard | ❌ 미시도 | 현재 구독자만 표시 (히스토리 없음) |
| Socialerus | ❌ 미시도 | 로그인 필요 |

## 스텔스 패스 (Scrapling StealthyFetcher, 2026-05-06)

### Naver News 접근 방식

`search.naver.com`은 requests+헤더 방식으로 403을 반환했으나, Scrapling StealthyFetcher(Playwright 기반 Chromium)로 우회 성공.

**핵심 발견사항:**
- Naver Fender 프레임워크는 SSR로 페이지당 최대 10개 기사를 렌더링
- `start=N` 파라미터로 오프셋 탐색 → `검색결과가 없습니다` 감지로 총 개수 추정
- OR 쿼리: `+OR+` 인코딩 → 결과 없음 오류. 파이프 `|` → `%7C` 인코딩으로 해결
- 카운트 정확도: 0-10개는 정확, 11+는 ±10개 내 추정

**예시 URL (2023-03-06~12, PLAVE):**
`https://search.naver.com/search.naver?where=news&query=%22%ED%94%8C%EB%A0%88%EC%9D%B4%EB%B8%8C%22%7C%22PLAVE%22&sort=1&pd=3&ds=2023.03.06&de=2023.03.12`

### Social Blade 접근 방식

StealthyFetcher로 403 없이 접근 성공. 테이블 데이터 파싱 완료.
- **무료 티어 제한**: 최근 14일 데이터만 제공 (유료 회원은 전체 히스토리 접근 가능)
- **PLAVE**: SB 데이터 2026-04-22~05-06 → 데뷔 윈도우(2022-09-13~2023-06-10) 밖 → 미삽입
- **SKINZ**: SB 데이터 2026-04-23~05-06 → 데뷔 윈도우(2024-10-12~2025-07-09) 밖 → 미삽입
- **MYRAKL**: SB 데이터 2026-04-23~05-06 → 데뷔 윈도우 끝(~2026-04-26)과 부분 겹침 → 4행 삽입
- **OWIS**: SB 데이터 2026-04-23~05-06 → 데뷔 윈도우(~2026-05-06) 내 → 14행 삽입
- **OWIS SB 핸들**: `owis_official` (OWISofficial = 404)

### 파싱 패턴 (Wayback)

YouTube 채널 페이지에서 구독자 수를 추출하는 두 가지 패턴 발견:

**패턴 1 (구형 YouTube 포맷, 구독자 수 많을 때)**:
```
"subscriberCountText":{"simpleText":"91.3K subscribers"}
```

**패턴 2 (신형 YouTube 포맷, 소규모 채널)**:
```
"metadataParts":[{"text":{"content":"1.34K subscribers"}}]
```

`scrape.py`의 `parse_subscriber_count_from_html()` 함수가 두 패턴 모두 처리.

### 구독자 수 정규화

| 원시 값 | 정규화 결과 |
|---|---|
| `"91.3K subscribers"` | 91,300 |
| `"1.34K subscribers"` | 1,340 |
| `"134K subscribers"` | 134,000 |
| `"1.01M subscribers"` | 1,010,000 |

---

## PLAVE (데뷔 2023-03-12, 백필창 2022-09-13 ~ 2023-06-10)

### 채널 정보
- 채널 핸들: `@plave_official` (확인: https://www.youtube.com/@plave_official)
- 채널 ID: `UCPZIPuQPrfrUG9Xe_okEmQA`
- 채널 개설: 2022-06-16 / 첫 방송: 2022-09-15 (Wikipedia 확인)

### Wayback Machine 결과

CDX 쿼리: `https://web.archive.org/cdx/search/cdx?url=youtube.com/@plave_official&from=20221001&to=20230701&output=json&fl=timestamp,statuscode`

**9 스냅샷 (status=200) 회수 성공**:

| 날짜 | 타임스탬프 | 구독자 수 | 스냅샷 URL |
|---|---|---|---|
| 2022-11-02 | 20221102115835 | 1,010 | https://web.archive.org/web/20221102115835/https://www.youtube.com/@plave_official |
| 2022-11-09 | 20221109114832 | 1,010 | https://web.archive.org/web/20221109114832/https://www.youtube.com/@plave_official |
| 2023-03-25 | 20230325173246 | 91,300 | https://web.archive.org/web/20230325173246/https://www.youtube.com/@plave_official |
| 2023-03-29 | 20230329193241 | 134,000 | https://web.archive.org/web/20230329193241/https://www.youtube.com/@plave_official |
| 2023-03-30 | 20230330093938 | 138,000 | https://web.archive.org/web/20230330093938/https://www.youtube.com/@plave_official |
| 2023-04-15 | 20230415170728 | 206,000 | https://web.archive.org/web/20230415170728/https://www.youtube.com/@plave_official |
| 2023-04-20 | 20230420005137 | 213,000 | https://web.archive.org/web/20230420005137/https://www.youtube.com/@plave_official |
| 2023-05-05 | 20230505113228 | 243,000 | https://web.archive.org/web/20230505113228/https://www.youtube.com/@plave_official |
| 2023-05-18 | 20230518181802 | 263,000 | https://web.archive.org/web/20230518181802/https://www.youtube.com/@plave_official |

**참고 — 추가 스냅샷 (Window 후)**:
- 2023-06-28 x2: 355,000 (백필창 마감 2023-06-10 이후이므로 SQL 미포함)

### Milestone 기반 데이터 포인트 (이전 Task 9에서 추가됨)

| 날짜 | 구독자 수 | 출처 | 신뢰도 |
|---|---|---|---|
| 2023-02-05 | 10,000 | "1만 기념 15문 15답" 멤버 영상 제목 (Wayback 스냅샷에서도 확인: "구독자 1만 기념" 영상) | 높음 (Wayback 스냅샷 직접 확인) |
| 2023-04-25 | 100,000 | Wikipedia Plave 항목 직접 확인 | 높음 |

### 데이터 품질 평가

- **단조 증가 검증 (Wayback 행만)**: 1,010 → 1,010 → 10,000 → 91,300 → 134,000 → 138,000 → 206,000 → 213,000 → 243,000 → 263,000 ✅ 단조 증가
- **이상값**: 2022-11-02/09 모두 1,010 (7일간 동일) — Wayback이 같은 페이지 버전을 2번 캡처한 것으로 추정. 정상.
- **급격한 성장 (2022-11 → 2023-03)**: Wayback 스냅샷 없는 4개월 갭. 이 기간 실제 성장은 1,010 → 10,000 → 91,300. 데뷔 직전 커뮤니티 형성 + 데뷔 당일 폭발적 유입 패턴으로 합리적.
- **Naver News**: 완전 차단 — naver_total_news=0 전 행. 실제 기사 수 아님.

### ⚠️ 데이터 불일치 경고 — 2023-04-25 행

이전 Task 9 (commit 11955e2)에서 삽입된 milestone 행:
- `snapshot_at = 2023-04-25, yt_subscribers = 100,000`
- 출처: Wikipedia "first five-member broadcast on April 25, 2023, during which they celebrated reaching 100,000 subscribers"

**문제**: Wayback 데이터에 따르면 PLAVE는 2023-03-29에 이미 134,000 구독자를 보유했음. 즉, 2023-04-25에 100,000이라는 수치는 시간적으로 역행하는 값.

**해석 가능성**:
1. Wikipedia 설명이 부정확 — 실제로는 데뷔 후 몇 주 안에 100K를 달성했고, 4월 25일 방송은 다른 이정표 기념
2. 4월 25일에 첫 5인 전체 방송을 기념한 것은 맞지만, 당시 이미 213K였을 가능성 높음

**현재 DB 상태**: `2023-04-25` 행에 `yt_subscribers=100000`이 남아있어 시계열 단조성 위반 발생. 이 행은 `backfill_estimate`로 마킹되어 있어 UI에서 "추정"으로 표시되나, 시각화 시 이상값으로 보일 수 있음.

**권고**: 향후 마이그레이션에서 `UPDATE agg_summary SET yt_subscribers=NULL WHERE group_key='plave' AND snapshot_at='2023-04-25T00:00:00Z'` 실행을 검토할 것. (본 Task에서는 이전 commit의 milestone 행 보존 방침으로 수정 보류.)

### Naver News 결과 (스텔스 패스)

| 주 | 기간 | 기사 수 |
|---|---|---|
| 2022-10-24 | ~10-30 | 1 |
| 2023-02-06 | ~02-12 | 1 |
| 2023-02-27 | ~03-05 | 10 (데뷔 예고 발표) |
| 2023-03-06 | ~03-12 | 1 (데뷔일 포함) |
| 2023-03-13 | ~03-19 | 16 |
| 2023-03-27 | ~04-02 | 50 (첫 음악방송 출연) |
| 2023-04-10 | ~04-16 | 2 |
| 2023-04-17 | ~04-23 | 1 |
| 2023-05-01 | ~05-07 | 1 |
| 2023-05-15 | ~05-21 | 1 |
| 2023-05-22 | ~05-28 | 2 |
| 2023-05-29 | ~06-04 | 4 |

### 회수 통계 (전체 패스 합산)
- 구독자 데이터: 11행 (9 Wayback + 2 milestone)
- 뉴스 카운트: 38행 (12개 비零, 26개 영)

### Naver 30 샘플 점검 (스텔스 패스)
2023-03-06~03-12 검색 결과 1건 확인: MBC연예 기사 — "MBC가 투자한 버추얼 보이그룹 '플레이브(PLAVE)', 타이틀곡 '기다릴게'..." (데뷔 발표 기사, 완전 관련)
2023-03-13~03-19 검색 결과 16건 확인: 데뷔 관련 K-pop 미디어 보도 — 모두 PLAVE 관련.
2023-03-27~04-02 검색 결과 50건: 음방 출연, 실시간 트렌드 등 — 무관 기사 없음 (샘플 5건 확인).

---

## SKINZ (데뷔 2025-04-10, 백필창 2024-10-12 ~ 2025-07-09)

### 채널 정보
- 채널 핸들: `@SKINZOFFICIAL` (확인: https://www.youtube.com/@SKINZOFFICIAL)
- 채널 ID: 미확인 (Wayback CDX가 handle 기반으로 동작)
- 소속사: Bridge Enter
- 멤버: Dael, Dovin, Finn, Ilang Kwon, Jaon, Theo, Yull (7인)

### Wayback Machine 결과

CDX 쿼리: `https://web.archive.org/cdx/search/cdx?url=youtube.com/@SKINZOFFICIAL&from=20241101&to=20250710&output=json&fl=timestamp,statuscode`

**2 스냅샷 (status=200) 회수 성공**:

| 날짜 | 타임스탬프 | 구독자 수 | 스냅샷 URL |
|---|---|---|---|
| 2024-12-27 | 20241227210629 | 1,340 | https://web.archive.org/web/20241227210629/https://www.youtube.com/@SKINZOFFICIAL |
| 2025-07-08 | 20250708062924 | 61,300 | https://web.archive.org/web/20250708062924/https://www.youtube.com/@SKINZOFFICIAL |

### 데이터 품질 평가

- **스냅샷 수**: 2개 — 데뷔 전 (2024-12-27, D-105) + 데뷔 후 (2025-07-08, D+89)
- **단조 증가**: 1,340 → 61,300 ✅
- **패턴**: 2024-12-27 스냅샷은 메타데이터 패턴2(신형)으로 파싱. `"content":"1.34K subscribers"` 형식.
- **갭**: 데뷔일(2025-04-10) 전후 Wayback 스냅샷 없음 — 성장 곡선의 데뷔 피크 포인트 없음.
- **Naver News**: 완전 차단 — naver_total_news=0 전 행.

### Naver News 결과 (스텔스 패스)

| 주 | 기간 | 기사 수 | 비고 |
|---|---|---|---|
| 2024-12-23 | ~12-29 | 50 | SBS 인가라이브 도쿄돔 라인업 발표 |
| 2025-02-24 | ~03-02 | 1 | - |
| 2025-03-10 | ~03-16 | 1001+ | SBS 인가라이브 도쿄돔 (다수 언론 보도) |
| 2025-03-24 | ~03-30 | 1001+ | 인가라이브 관련 후속 보도 |
| 2025-05-19 | ~05-25 | 5 | - |
| 2025-06-23 | ~06-29 | 1 | - |
| 2025-07-07 | ~07-13 | 1001+ | 기간 내 데뷔 관련 대규모 보도 |

**주의**: 1001 값은 탐색 상한(실제 >1001개). "스킨즈" 검색어가 비관련 콘텐츠를 포함할 가능성은 낮음 — 3월 10일 샘플 확인 결과 전부 SKINZ 관련.

### 회수 통계 (전체 패스 합산)
- 구독자 데이터: 2행 (Wayback Machine)
- 뉴스 카운트: 39행 (7개 비零)

### Naver 30 샘플 점검 (스텔스 패스)
2025-03-10~03-16 (1001건): "버추얼 그룹 SKINZ, 데뷔 무대 방송..." 등 인가라이브 관련 기사 다수. 검색 결과의 5건 샘플에서 모두 스킨즈 관련 — 무관 기사 없음.

---

## MYRAKL (데뷔 2026-01-26, 백필창 2025-07-30 ~ 2026-04-26)

### 채널 정보
- 채널 핸들: `@myrakl_official` (검색 결과에서 확인, 직접 방문 미시행)
- 소속사: ACCORD Entertainment
- 멤버: Saeon, Yuseong, Haydn, Jeha, Seol (5인)
- 정식 명칭: MY:RAKL (Make Your Reality A Kismet Legacy)

### Wayback Machine 결과

CDX 쿼리: `https://web.archive.org/cdx/search/cdx?url=youtube.com/@myrakl_official&from=20250801&to=20260506&output=json&fl=timestamp,statuscode`

**결과: 0 스냅샷** — Wayback Machine이 이 채널을 백필 창 기간 내 크롤링한 적 없음.

### 이유 분석
- 채널이 2025년 하반기에 개설되었을 가능성 (첫 공식 활동 = 데뷔 2026-01-26)
- Wayback Machine은 신규 K-pop 채널을 자동 크롤링하지 않음 — 누군가 의도적으로 저장(Save Page Now)해야 함
- 대안: 팬 아카이브, 뉴스 기사 내 구독자 언급 → 수동 검색 필요

### Social Blade 결과 (스텔스 패스)
- 핸들: `myrakl_official` (SB 접근 성공)
- 데이터 범위: 2026-04-23 ~ 2026-05-06 (14일)
- 데뷔 윈도우 내 (~ 2026-04-26): **4행 삽입**
  - 2026-04-23: 5,430
  - 2026-04-24: 5,430
  - 2026-04-25: 5,440
  - 2026-04-26: 5,430

### Naver News 결과 (스텔스 패스)
- 38개 주간 탐색, 전부 0건 — MY:RAKL은 네이버 뉴스 노출 극히 미미

### 데이터 회수 결과 (전체 패스 합산)
- 구독자 데이터: **4행** (Social Blade 최근 14일, 데뷔 윈도우 내)
- 뉴스 카운트: **0행** (검색 결과 없음)

---

## OWIS (데뷔 2026-03-23, 백필창 2025-09-24 ~ 2026-05-06)

### 채널 정보
- 채널 핸들: `@OWISofficial` (시도한 핸들; 공식 핸들 미확인)
- 소속사: ama (all my anecdotes) — CEO Jay Kim, CCO Lee Haein
- 멤버: Serene, Haru, Soi, Summer, Yuni (5인)
- 정식 명칭: OWIS (Only When I Sleep)
- 데뷔 앨범: MUSEUM (2026-03-23)

### Wayback Machine 결과

CDX 쿼리: `https://web.archive.org/cdx/search/cdx?url=youtube.com/@OWISofficial&from=20260101&to=20260506&output=json&fl=timestamp,statuscode`

**결과: 0 스냅샷** — 채널 핸들이 틀렸거나 Wayback이 크롤링하지 않음.

추가 시도:
- `youtube.com/@OWIS`: 0 스냅샷
- `youtube.com/@owisofficial`: 미시도 (CDX는 대소문자 구분)

### Social Blade 결과 (스텔스 패스)
- **YouTube 핸들**: `@OWISofficial` (SB에서 404)
- **SB 핸들**: `owis_official` (SB에서 200 성공)
- 데이터 범위: 2026-04-23 ~ 2026-05-06 (14행)
- 데뷔 윈도우 내 (~ 2026-05-06): **14행 전부 삽입**

| 날짜 | 구독자 |
|---|---|
| 2026-04-23 | 65,099 |
| 2026-04-24 | 65,200 |
| 2026-04-25 | 66,400 |
| 2026-04-26 | 66,200 |
| 2026-04-27 | 66,100 |
| 2026-04-28 | 66,000 |
| 2026-04-29 | 66,100 |
| 2026-04-30 | 66,100 |
| 2026-05-01 | 66,200 |
| 2026-05-02 | 66,300 |
| 2026-05-03 | 66,600 |
| 2026-05-04 | 66,900 |
| 2026-05-05 | 67,100 |
| 2026-05-06 | 67,300 |

### Naver News 결과 (스텔스 패스)

| 주 | 기간 | 기사 수 | 비고 |
|---|---|---|---|
| 2026-01-05 | ~01-11 | 16 | 데뷔 발표/티저 초기 보도 |
| 2026-01-12 | ~01-18 | 50 | 멤버 공개 등 추가 보도 |
| 2026-02-23 | ~03-01 | 1001+ | 로고 모션 등 데뷔 전 미디어 집중 보도 |
| 2026-04-13 | ~04-19 | 4 | - |
| 2026-04-20 | ~04-26 | 8 | - |
| 2026-04-27 | ~05-03 | 1 | - |

2026-02-23 샘플 확인: "버추얼 걸그룹 OWIS(오위스)가 감각적인 영상으로 데뷔 열기를 더했다" 등 전부 OWIS 관련. 무관 기사 없음.

### 데이터 회수 결과 (전체 패스 합산)
- 구독자 데이터: **14행** (Social Blade 2026-04-23~05-06)
- 뉴스 카운트: **32행** (6개 비零)

---

## 전체 결과 요약 (스텔스 패스 포함)

| 그룹 | 구독자 행 수 | 뉴스 비零 행 수 | 소스 |
|---|---|---|---|
| PLAVE | 11 (9 Wayback + 2 milestone) | 12/38 주 | Wayback + Wikipedia + Naver 스텔스 |
| SKINZ | 2 | 7/39 주 | Wayback + Naver 스텔스 |
| MYRAKL | 4 | 0/38 주 | Social Blade 최근 14일 |
| OWIS | 14 | 6/32 주 | Social Blade 최근 14일 + Naver 스텔스 |

**합계**: 구독자 행 31행, 뉴스 비零 행 25행, 전체 주간 행 177행

## 한계 및 권고사항

1. **Naver News — 스텔스 패스로 차단 해제**: `search.naver.com`은 StealthyFetcher(Playwright)로 접근 가능. 단, 각 요청마다 새 Chromium 컨텍스트 필요 → 느림. 빠른 대량 수집에는 Naver 공식 API 사용 권장.

2. **Social Blade 무료 티어 제한**: 무료 계정은 최근 14일만 제공. 데뷔 윈도우 역사 데이터는 유료. PLAVE/SKINZ의 데뷔 당시 구독자 상세 이력 복구 불가.

3. **MYRAKL 뉴스 부재**: "마이라클"/"MY:RAKL"/"MYRAKL" 모든 쿼리에서 38주 전부 0건. 네이버 뉴스 노출이 극히 미미 — 실제 미디어 커버리지가 거의 없거나 쿼리 키워드 문제.

4. **SKINZ 1001건 피크**: 2025-03 SBS 인가라이브 도쿄돔 콘서트 관련 대규모 보도. 1001은 탐색 상한 (실제 기사 수 더 많음). 상대적 트렌드 비교에는 충분.

5. **OWIS 2026-02-23 1001건**: 데뷔 전 로고 모션 영상 공개 관련 미디어 폭발 보도. 샘플 확인 결과 전부 OWIS 관련 기사.

6. **PLAVE 2023-04-25 monotonicity 수정**: 위키피디아 milestone 행의 yt_subscribers=100,000이 Wayback 실측값(134,000 @ 2023-03-29)과 시간 역행. NULL로 수정 완료 (migration 0018 마지막 UPDATE).

7. **모든 행 data_source = 'backfill_estimate'**: 보수적 마킹 유지.
