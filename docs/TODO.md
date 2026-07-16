# 프로젝트 To-Do

운영자 결정·외부 정보 공개를 기다리는 후속 작업. 완료 시 줄에 취소선 + `(done YYYY-MM-DD)`.

## 신규 그룹 온보딩 후속 — 홀린(hollin) · 비그릿츠(begritz)

2026-07-16 등록(migration 0104, prod 적용 완료). 두 팀 모두 **데뷔 전**이라 아래는
공개 후 처리. 절차는 [group-onboarding-checklist.md](group-onboarding-checklist.md) 참고.

- [ ] **멤버 라인업** — 공개 시 `INSERT INTO members (group_key, name, name_en, yt_channel_id)`
  후속 마이그레이션. 현재 두 팀 모두 members 미시드 → theqoo/instiz 멤버 중심 매칭·
  멤버 채널 지표 decompose 불가 상태.
- [ ] **전용 DC 갤러리** — 개설 시 `dc_gallery_id` 등록.
  - 홀린: 현재 `vboyband` supplemental 만. 전용 갤 열리면 primary 로 승격.
  - 비그릿츠: 성별 구성(보이/걸) 미공개라 supplemental 보류 중 → 확정 후 적합 허브
    (vboyband 등) 등록. 확정 전까지 naver primary.
- [ ] **공식 X/인스타 핸들** — 확보 시 `twitter_handles` 등록(현재 두 팀 NULL).
- [ ] **데뷔 형식 확정** — "정식 음원 데뷔" 여부 미확인.
  - 홀린: `debut_date=2026-09-01` 세팅됨. 채널/티저 데뷔로 판명되면 정정.
  - 비그릿츠: 8월 "론칭"·음원 데뷔일 미확정 → `debut_date` 현재 NULL. 확정 시 세팅.
- [ ] **음방 추적 후보 판정** — 실물 음방 활동 시 `collectors/music_show._GROUP_QUERY_ALIASES`
  **+** `llm/music_show.GROUP_KEY_ENUM` 둘 다 추가(test_music_show_collector 가드).
  현재 버추얼·프리데뷔라 미추가.
- [ ] **미완소년 비교 사다리 편입 검토(선택)** — 지표 축적 후 `frontend/functions/api/miiwan.ts`
  `BENCHMARK_GROUPS` 도장깨기 순서에 넣을지 판단(현재 큐레이션 6팀 유지).
