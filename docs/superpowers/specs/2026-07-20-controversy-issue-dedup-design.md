# V2.55 — Controversy Issue Dedup + Cap 설계 (2026-07-20)

## 문제 (V2.54 사후 실증)

ISEDOL: 14일 윈도우 controversy 8건 → ×0.4 → 원점수 ~8.8이 4.1(C "초기 진입")로. 8건의 실체 = 실제 이슈 1개(재판, 3건) + 경계선 2건 + 구프롬프트 오분류 잡담 3건. 구조 결함: **같은 이슈를 글 N건으로 얘기하면 N번 감점** — 감점이 이슈 심각도가 아니라 커뮤니티 볼륨에 비례. 운영자 결정: ① 기존 라벨 재분류 ② 이슈 단위 dedup ③ 감점 하한 캡, 셋 다 진행.

## ① 기존 라벨 재분류 (코드 변경 없음, 운영자 SQL)

- `UPDATE community_posts SET sentiment=NULL WHERE sentiment='controversy' AND posted_at >= datetime('now','-14 days');`
- 원리: 분류기는 `sentiment IS NULL`만 집는다(sentiment.py `classify_for_group`) → 오늘 밤 analyze-weekly(일 23:00 KST final)가 V2.54 신프롬프트로 재분류. LIMIT 200/그룹 ≫ 대상 ~20건.
- 과도기: 리셋~23:00 사이 controversy_count=0 (21:30 collect-daily가 무감점 health를 한 번 쓰지만 23:00 analyze-weekly가 재계산) — 하룻저녁 과도 상태 수용.

## ② 이슈 클러스터링 (`analysis/controversy_issues.py` 신규)

- **입력**: 그룹별 14일 윈도우 controversy 글(url_hash, title). 글 ≥1인 그룹만 → 그룹당 Gemini 1회 (현재 코호트 기준 ~4콜/런, 비용 미미).
- **프롬프트**: 같은 실제 사건·의혹을 다루는 글들을 이슈로 묶기. 이슈마다 `label`(한 줄), `post_hashes`, `severity`:
  - `high` = 법적 분쟁·안전 사고·계약 파기·대형 폭로 (weight 3)
  - `medium` = 유출·표절 시비·운영 사고 (weight 2)
  - `low` = 팬덤 간 갈등·경미한 시비 (weight 1)
  - 실제 사건을 지칭하지 않는 글(잡담·밈)은 어떤 이슈에도 넣지 않는다 (2차 노이즈 필터).
- **산출**: `effective_weight = Σ severity weight`. 저장: 신규 테이블(mig **0108**) `controversy_issues(group_key TEXT PRIMARY KEY, computed_at TEXT, issue_count INTEGER, effective_weight REAL, issues_json TEXT)` — 그룹당 1행 최신만 (히스토리 불필요, replace).
- **배치**: `analyze_weekly` 내 감성 분류 직후·health 재계산(2.5단계) 직전. 글 0건 그룹은 행 DELETE(신호 소멸).
- 실패 시(Gemini 예외): 기존 행 유지(stale 가드가 처리), 로그 warning, analyze 전체는 계속.

## ③ health 산식 v3 (`_controversy_factor` → 이슈 기반 + 캡)

- **이슈 신호 있을 때**: `factor = max(0.6, 1 - effective_weight/10)` — high 1건=×0.9? 아니, weight 3 → ×0.7. 이슈 여러 개면 합산, 하한 0.6 (전 팩터 −40% 초과 금지).
- **폴백** (0108 미적용 / 행 없음 / `computed_at` > 8일 stale — analyze 2회 결번 시): V2.54 count 기반 `max(0.6, 1 - max(0, count-2)/10)` — 캡 0.6은 폴백에도 적용.
- `_recompute_health_scores`가 `controversy_issues`를 try/except로 로드(graceful), `compute_health_score`에 `controversy_weight` 신호로 전달. crisis alert·negative_ratio·agg_summary.controversy_count는 **불변**.
- ISEDOL 검산: 재판 1이슈 high(3) → ×0.7 → ≈6.4(B). 잡담 소멸 전제. STELLIVE 이슈 0~1 low → 0.9~1.0 → ≈7.5~7.9 유지.

## 문서·표시

- `docs/analysis-formulas-reference.md` risk 섹션 v3 갱신 (file:line 인용).
- 프론트 변경 없음 (breakdown risk 값은 자동 반영). 이슈 라벨 badge 노출은 후속 backlog.

## 검증

- TDD: 클러스터링 순수 로직(파싱·weight 합산·stale 가드)·factor v3·폴백 전부 단위 테스트. 기존 worker 898 유지.
- 반영 경로: push → 운영자 ① SQL → 오늘 밤 21:30 collect-daily + 23:00 analyze-weekly가 재분류→클러스터→health 순으로 자동 수렴. 내일 실측 확인.
