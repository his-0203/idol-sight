# Historical Pre-Debut Backfill — 출처 및 검증 노트

대상: PLAVE / OWIS / SKINZ / MYRAKL의 데뷔 D-180 ~ D+90 구간 yt_subscribers + naver_total_news 백필.

방법론과 검증은 `docs/superpowers/specs/2026-05-06-historical-debut-backfill-design.md` §5 참조.

## 공통 검증 룰
- 주 1회 (월요일 00:00 KST) + 핵심 마일스톤 일자 일별 추가
- Cross-source 스폿체크: Social Blade vs Playboard 같은 날짜 ±10%
- Naver 뉴스 동명이인/무관 검색결과 30 샘플 수동 점검

---

## PLAVE (데뷔 2023-03-12, 백필창 2022-09-13 ~ 2023-06-10)
- 채널 핸들: @plave_official (확보 출처: YouTube 검색결과, https://www.youtube.com/@plave_official)
- 채널 ID: UCPZIPuQPrfrUG9Xe_okEmQA
- 채널 개설: 2022-06-16 (socialerus.com 표시) / 첫 방송: 2022-09-15 (Wikipedia, EnVi Media)
- Social Blade: 403 Forbidden — 회수 불가 (모든 historical 탭 포함)
- Playboard: 현재 구독자 1,160,000 표시만 (https://playboard.co/en/channel/UCPZIPuQPrfrUG9Xe_okEmQA) — 히스토리 탭 접근 불가
- Socialerus: 최근 5일치만 공개; 2022-2023 데이터 로그인 필요 (https://socialerus.com/Ranking/Detail?id=UCPZIPuQPrfrUG9Xe_okEmQA)
- SocialCounts: 최근 1달치만 표시 (https://socialcounts.org/youtube-live-subscriber-count/UCPZIPuQPrfrUG9Xe_okEmQA)
- News 기반 milestone 출처 (백필 창 내):
  - 2023-02-05: 10,000 — "1만 기념 15문 15답" 멤버 5편 인터뷰 업로드일. 출처: 웹검색 AI 요약 (Wikipedia 편집 이력에서 언급, 직접 URL 없음). 신뢰도: 중.
  - 2023-04-25: 100,000 — 첫 5인 전체 라이브 방송에서 10만 달성 기념. 출처: Wikipedia Plave (https://en.wikipedia.org/wiki/Plave) "inaugural five-member broadcast on April 25, 2023, during which they celebrated reaching 100,000 subscribers". 신뢰도: 높음.
- News 기반 milestone 출처 (백필 창 외, 참고용):
  - 2023-09-01: ~300,000 — ardentnews.co.kr 기사 "구독자 수 30만 돌파" 언급 (날짜 불명확, 첫 미니 앨범 발매 2023-08-24 전후로 추정). https://www.ardentnews.co.kr/news/articleView.html?idxno=1238
  - 2023-11-14: ~500,000 — 웹검색 AI 요약 (직접 URL 미확인). 신뢰도: 낮음 (미삽입).
  - 2024-05-19: 700,000 — Nate 기사 "구독자 70만 돌파" 제목. https://m.news.nate.com/view/20240520n28037
  - 2025-02-06: 891,000 — Korea Herald 기사 직접 언급. https://www.koreaherald.com/article/10413755
  - 2025-03-12: ~983,000 — BNT뉴스 2주년 기사 "98.3만 명". https://www.bntnews.co.kr/article/view/bnt202503120125
  - 2025-03-23: 1,000,000 — 다수 출처 확인. https://namu.wiki/w/PLAVE/%EC%9C%A0%ED%8A%9C%EB%B8%8C 등
- Naver News 쿼리: `"플레이브" OR "PLAVE"`, ds/de 방식 주간 검색 시도
  - 결과: search.naver.com WebFetch 완전 차단 ("Claude Code is unable to fetch from search.naver.com")
  - naver_total_news = 0 (전 행) — 회수 불가 gap으로 문서화
- 회수 일자 수: 2 (구독자: 2, 뉴스: 0)
- Cross-source 검증: 2023-04-25 100K는 Wikipedia에서 직접 확인. 2023-02-05 10K는 웹검색 AI 요약 기반으로 신뢰도 중간 (직접 기사 URL 없음).
- Naver 30 샘플 점검: 미수행 (naver.com 접근 불가)
- 회수 실패 사유:
  - Social Blade / Playboard / Socialerus: 인증 필요 또는 최근 데이터만 공개
  - Naver News: WebFetch 차단
  - Wayback Machine: WebFetch 차단 ("Claude Code is unable to fetch from web.archive.org")
- 비고: 백필 창 (D-180~D+90) 내 회수 가능 구독자 데이터 포인트는 2건뿐. 그 외 마일스톤 (D+170 이후)은 참고용으로 SOURCES.md에만 기록하고 SQL에는 미삽입 (백필 창 벗어남). 10K (2023-02-05) 데이터 포인트는 신뢰도 중간이므로 backfill_estimate로 마킹됨.

## SKINZ (데뷔 2025-04-10, 백필창 2024-10-12 ~ 2025-07-09)
TBD — Task 10에서 채움

## MYRAKL (데뷔 2026-01-26, 백필창 2025-07-30 ~ 2026-04-26)
TBD — Task 11에서 채움

## OWIS (데뷔 2026-03-23, 백필창 2025-09-24 ~ 현재)
TBD — Task 12에서 채움
