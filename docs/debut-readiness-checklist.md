# MiiWAN 데뷔 준비도 체크리스트 (2026-06)

이 프로젝트의 존재 이유 = MiiWAN 데뷔 지원. 데뷔 *전·당일·직후*에 반드시 봐야 할
것을 역산해 데뷔-크리티컬 기능을 그 외 백로그보다 먼저 배치한다.

## 데뷔 전 (D-30 ~ D-1)
- [ ] **D-N 카운트다운 / debut_milestone 알림** — D-30/D-7/D-1 밴드 발화 확인(rule_debut_milestone).
- [ ] **MiiWANBriefing** — 7-anchor 코호트 비교(D-30…D+30)가 경쟁사 대비 정상 렌더. 데뷔 전 그룹은 anchor 스냅샷 기준.
- [ ] **Debut Window organicity** — 자사 Short 들이 판정되는지(V2.37). 단 **추정**임을 전략팀이 인지(라벨 명시됨).
- [ ] **수집 신선도** — `⚙ 상태` 페이지에서 MiiWAN 의 youtube/dc/naver/community 잡이 전부 ok. 데뷔 직전 데이터 끊김 = 치명.
- [ ] **경영진 보고 프레임** — blended ER 폐기, organic/paid 퍼널 분리(소액 고효율 유료 집행 중). 덱은 `reports/`.

## 데뷔 당일 (D-Day)
- [ ] **위기 알림 대응 태세** — identity_leak/controversy_spike 가 발화 시 누가 인간 검증·대응하나(거버넌스 런북). 데뷔일 트래픽 급증 = 오탐·진성 둘 다 ↑.
- [ ] **수집 cadence** — collect-hourly 가 데뷔 모먼트를 충분히 촘촘히 잡는지(필요 시 일시 상향 검토).
- [x] **라이브 CCV collector (YouTube)** — 구현됨(v1). collect-ccv 워크플로 KST 17:00–02:00 30분 cron; 데뷔 당일은 `gh workflow run collect-ccv.yml` 로 촘촘히. MiiWANBriefing "라이브 반응" 카드. 슈퍼챗 금액·치지직·티켓은 후속.
- [ ] ⏳ **티켓 매진속도 collector** — 팬덤 동원력 핵심 지표. **미구현** → 동일.

## 데뷔 직후 (D+1 ~ D+30)
- [ ] **comeback_boost / 음방·차트** — hanteo 초동, melon TOP100, music_show 1위 신호가 들어오는지(이번 세션에 hanteo_sales/video_upload_z 와이어링).
- [ ] **debut-window 버킷 진행** — D+20/D+40 으로 자동 이동하며 경쟁사 trajectory 와 비교되는지.
- [ ] **organicity 재캘리브레이션** — 데뷔 후 자사 Short 표본이 쌓이면 V2.37 zone/weights 재검토(데이터 기반).

## 데뷔 전 결정 필요 (PM)
1. 라이브 CCV/슈퍼챗 + 티켓 매진속도 collector 를 데뷔 전에 구현할지(데뷔-크리티컬) vs 데뷔 후로 미룰지.
2. 데뷔일 collect-hourly cadence 일시 상향 여부.
3. 위기 대응 on-call(데뷔일 누가 Discord 알림 보고 판단).
