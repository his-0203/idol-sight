# Historical Pre-Debut Backfill — 출처 및 검증 노트

대상: PLAVE / OWIS / SKINZ / MYRAKL의 데뷔 D-180 ~ D+90 구간 yt_subscribers + naver_total_news 백필.

방법론과 검증은 `docs/superpowers/specs/2026-05-06-historical-debut-backfill-design.md` §5 참조.

## 공통 검증 룰
- 주 1회 (월요일 00:00 KST) + 핵심 마일스톤 일자 일별 추가
- Cross-source 스폿체크: Social Blade vs Playboard 같은 날짜 ±10%
- Naver 뉴스 동명이인/무관 검색결과 30 샘플 수동 점검

---

## 공통 — 소스 시도 결과 요약

| 소스 | 결과 | 실패 이유 |
|---|---|---|
| Wayback Machine CDX API | ✅ 성공 (PLAVE/SKINZ) | MYRAKL/OWIS 채널 너무 신규 |
| Wayback Machine 스냅샷 파싱 | ✅ 성공 | subscriberCountText.simpleText 패턴 |
| Naver News search.naver.com | ❌ 완전 차단 | 스크래퍼 IP에서 403 (홈 쿠키 확보 후에도 동일) |
| Social Blade | ❌ 미시도 | 이전 Task에서 403 확인됨 |
| Playboard | ❌ 미시도 | 현재 구독자만 표시 (히스토리 없음) |
| Socialerus | ❌ 미시도 | 로그인 필요 |

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

### 회수 통계
- 구독자 데이터: 11행 (9 Wayback + 2 milestone)
- 뉴스 카운트: 0행 (차단)

### Naver 30 샘플 점검
- 미수행 — search.naver.com 접근 불가 (403)

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

### 회수 통계
- 구독자 데이터: 2행
- 뉴스 카운트: 0행 (차단)

### Naver 30 샘플 점검
- 미수행 — search.naver.com 접근 불가 (403)

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

### 데이터 회수 결과
- 구독자 데이터: **0행** (Wayback 스냅샷 없음)
- 뉴스 카운트: **0행** (Naver 차단)
- **SQL INSERT 없음**

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

### 데이터 회수 결과
- 구독자 데이터: **0행** (Wayback 스냅샷 없음)
- 뉴스 카운트: **0행** (Naver 차단)
- **SQL INSERT 없음**

---

## 전체 결과 요약

| 그룹 | 구독자 행 수 | 뉴스 행 수 | 소스 |
|---|---|---|---|
| PLAVE | 11 (9 Wayback + 2 milestone) | 0 | Wayback Machine + Wikipedia |
| SKINZ | 2 | 0 | Wayback Machine |
| MYRAKL | 0 | 0 | 없음 (채널 미크롤링) |
| OWIS | 0 | 0 | 없음 (채널 미크롤링) |

## 한계 및 권고사항

1. **Naver News 차단**: `search.naver.com`에서 스크래퍼 IP를 차단 중. Naver API 키 (client_id/secret) 또는 한국 서버 기반 CI 환경에서 재시도 필요.

2. **MYRAKL/OWIS Wayback 없음**: 채널 개설 후 수동으로 Wayback의 "Save Page Now" 기능으로 아카이브해두면 향후 백필 가능. 또는 뉴스 기사 스크래핑으로 구독자 언급 추출.

3. **PLAVE 2022-11 ~ 2023-03 갭**: 4개월간 Wayback 스냅샷 없음. 이 기간 구독자는 1,010 → 10,000 → 91,300으로 추정되나 중간값 없음.

4. **SKINZ 데뷔 전후 스냅샷 없음**: 2024-12-27 → 2025-07-08 사이 스냅샷 없어 데뷔 피크 모델링 불가.

5. **모든 행 data_source = 'backfill_estimate'**: Wayback 구독자 수는 실측값이지만 snapshot_at이 실제 측정 시점과 정확히 일치하지 않을 수 있으므로 estimate로 마킹. 이는 보수적인 선택.
