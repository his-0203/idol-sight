# Organicity 해석층 카피/UX 개선 (V2.41)

날짜: 2026-06-08
범위: **frontend 카피/UX only** — 산식·verdict 임계값·데이터·컴포넌트 신규 없음. cron 영향 0, frontend 빌드만.

## 배경 (진단)

실데이터 점검 결과:

1. **점수는 규모와 무관 (구조적)** — organicity composite 는 전부 비율(ER·like:comment·velocity). 조회수 10K WE GO-6(84.4) > 276K STELLIVE(65.4). 규모↔점수 상관 ≈ 0. 의도된 직교 축.
2. **변별력은 이미 데이터에 있음** — 그룹별 점수 범위 42~92, 영상 단위도 잘 퍼짐. 카드의 "버킷 simple-mean 한 숫자"가 산포를 뭉개는 표시 artifact.
3. **비는 건 "해석층"** — 사이트는 "이 숫자가 어떻게 만들어졌나(mechanics)"와 과잉단정 회피("휴리스틱 추정", "유료 단정 아님")는 잘 전달하지만, **결정에 필요한 해석**은 사용자에게 맡겨둠:
   - organicity 가 비율 지표(규모 무관)라는 안내 **없음**
   - "진짜인가(organicity) vs 충분한가(reach)" 2축 구분 **없음**
   - 데뷔 후 유료 축소로 인한 조회수 하락의 맥락화 / organic floor 프레임 **없음**
   - verdict 색(Strong=초록)이 "건강"으로 오독되도록 살짝 유도 (작은 베이스 위 깨끗한 ER 도 Strong)

## 비목표 (의도적 제외)

- 산식·임계값 변경 없음 (점수 분포 재보정은 별도 작업)
- 새 데이터 viz(organic floor vs baseline 실측 차트), 2D 패널, verdict 리라벨/공용 범례 컴포넌트 — 운영자 결정으로 이번 범위 밖 (카피만)

## 변경 (4-fix)

### Fix 1 — "규모 무관" 1줄
organicity 가 비율 지표라 조회수 크기와 무관함을 always-on 캡션에 명시.
- `DebutWindowKPI.tsx` `kpi-debutwin-note`: 기존 캡션에 절 추가 — `organicity = 진정성(비율) 신호 · 조회수 규모와 무관(작아도 비율 정상이면 높음)`
- `CompetitorOrganicityBar.tsx` `cob-footer`: 같은 취지 1줄.

### Fix 2 — "진짜 vs 충분" 2축 구분
`MiiWANBriefing.tsx` 코호트 도달 표 ↔ `CompetitorOrganicityBar` 사이(posture 섹션 헤더)에 muted 1줄 — `이 막대 = '진짜인가'(진정성, 규모 무관) · 위 표의 조회·구독 = '충분한가'(규모) · 두 축은 별개`.

### Fix 3 — 'Strong=건강' 오독 방지
verdict 색 valence 를 명시적으로 분리.
- `DebutWindowVideoTable.tsx` Help 모달 Verdict 임계값 박스에 주석 추가 — 초록 = 조작 신호 없음(진짜)일 뿐 인기·규모·건강 보장 아님 / 작은 채널도 비율 깨끗하면 Strong.
- `DebutWindowSignalPanel.tsx` Verdict pill 아래 1줄 동일 취지(짧게).

### Fix 4 — floor 해석 노트
`MiiWANBriefing.tsx` posture 섹션 하단에 muted 노트 — 데뷔 후 유료 축소로 조회수 피크 대비 하락은 정상 가능 · 건강은 '피크 대비'가 아니라 organic 도달 floor 가 데뷔 전 baseline 위에서 유지/상승하는가로 판단 · organicity 정상 = '진짜'지만 '충분·지속'의 증거 아님.

## 검증

- `cd frontend && pnpm test` + `tsc` clean.
- 산식/worker 미변경이므로 worker pytest 무관(스모크만).
