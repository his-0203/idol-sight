# CLAUDE.md — IDOL-SIGHT 작업 가이드

이 문서는 Claude Code가 이 저장소에서 작업할 때 즉시 컨텍스트를 잡기 위한 프로젝트 가이드다. 다른 PC에서 `git pull` 후 바로 작업을 시작하려면 이 파일을 먼저 읽고, `docs/onboarding.md`로 환경 셋업을 진행하면 된다.

---

## 프로젝트 한 줄 정의

**어비스컴퍼니 사내 50명 + IPX contractor가 사용하는 8개 버추얼 아이돌 그룹 추적 BI**.
자사 데뷔 그룹은 **MiiWAN (2026-06)**, 경쟁/벤치마크 그룹은 PLAVE, ISEDOL, STELLIVE, SKINZ, MY:RAKL, OWIS, B:DAWN.

## 아키텍처 (3-tier)

```
GitHub Actions cron ──▶ worker/  (Python 3.12, uv)        ──▶ Cloudflare D1
                            │  collectors / analysis / llm / alerts
                            │
                            └──▶ Discord webhook (alerts)

Cloudflare D1 ◀── frontend/functions/api  (Pages Functions, TS)
                       ▲
Browser ◀── frontend/  (Vite + Preact SPA, deployed to Cloudflare Pages)
```

- **worker/**: Python collectors (YouTube, 디시, 더쿠, 네이버, 인스티즈, 한터, Twitter/X) + analysis 모듈 + Gemini LLM 인사이트 + Discord alerts.
- **frontend/**: Preact SPA + Pages Functions API + Cloudflare Access(추후) 인증.
- **migrations/**: D1 SQL migrations. `wrangler d1 migrations apply` 로 적용.
- **scripts/setup.sh**: 최초 1회 Cloudflare 리소스 프로비저닝 + `wrangler.toml` 패치.
- **docs/superpowers/specs/**: 기획·설계 명세서 (rebuild design, foundation, worker MVP, frontend UI, analysis/LLM, v2-roadmap).

## 빠른 명령

```bash
# Worker (로컬 dry-run, D1 쓰기 없음)
cd worker && uv sync && uv run python -m idol_sight --help

# Worker 단위 테스트
cd worker && uv run pytest

# Frontend (로컬 dev)
cd frontend && pnpm i && pnpm dev

# Migrations (로컬)
cd frontend && wrangler d1 migrations apply idol-sight --local

# Migrations (원격, 주의)
cd frontend && wrangler d1 migrations apply idol-sight --remote

# 배포 (보통 GitHub Actions가 자동)
cd frontend && wrangler pages deploy dist
```

## 다른 PC에서 작업 시작

1. `git clone https://github.com/his-0203/idol-sight.git && cd idol-sight`
2. `brew install gh jq uv && npm i -g wrangler pnpm`
3. `gh auth login` 후 `wrangler login` (Cloudflare 계정 본인 것)
4. `docs/onboarding.md` §2~§6 참고 — 시크릿(`CF_API_TOKEN`, `YT_API_KEY`, `GEMINI_API_KEY`, `DISCORD_WEBHOOK`, `SITE_PASSWORD_HASH`, `COOKIE_SECRET`)을 GitHub Secrets와 Cloudflare Pages 환경변수에 등록.
5. `cd worker && uv sync` / `cd frontend && pnpm i` 로 의존성 설치.
6. 로컬 dev 서버 실행 후 작업 시작.

> 시크릿은 절대 저장소에 커밋하지 않는다. `.gitignore`가 `.env*`, `.dev.vars`를 차단하지만 commit 전 `git diff` 확인.

## 핵심 명세 문서 (작업 전 읽기)

| 문서 | 용도 |
|---|---|
| `docs/superpowers/specs/2026-05-04-idol-sight-rebuild-design.md` | 전체 시스템 설계 (스키마, 인증, 비목표) |
| `docs/superpowers/specs/2026-05-04-v2-roadmap.md` | V2 로드맵 (Anthropologist + Trend Researcher + Analytics Reporter 합성) |
| `docs/superpowers/specs/2026-05-04-foundation.md` | 1단계 기반 구축 |
| `docs/superpowers/specs/2026-05-04-worker-mvp.md` | Worker MVP 상세 |
| `docs/superpowers/specs/2026-05-04-frontend-ui.md` | Frontend UI 상세 |
| `docs/superpowers/specs/2026-05-04-analysis-and-llm.md` | 분석 산식 + LLM 프롬프트 |
| `docs/superpowers/specs/2026-05-21-community-search-collectors-design.md` | TheQoo/Instiz 검색 보조 collector (V2.27 dc supplemental 후속, 미구현) |

## V2.5 현재 상태 (2026-05-05 기준)

**적용 완료**:
- Health Score 4-factor 분해 (Reach / RitualVictory / Mobilization / Intimacy) + ref 동적화 (percentile rank)
- Market Share → SOV (Share of Voice) z-score 단위 통일
- `agg_group_combined` dual entity 모델 (group_only / sum / weighted)
- ISEDOL/STELLIVE 멤버 솔로 채널 합산 (migration 0003)
- Engagement Rate, 24h Video Velocity, Member Popularity Normalized HHI, Platform Reactivity
- Sentiment 양극성 분류, 음원 dive curve, MiiWAN D-30 카운트다운, Discord 알림 임계값
- group_events 테이블 + ~85개 historical event seed (migration 0017)
- **V2.24 (2026-05-19)**: 멜론 일간차트 전환. realtime 폐기, `melon-chart` workflow가 일간차트만 fetch. `melon_chart_entries.chart_date` 컬럼 신설 (migration 0059) — fetch 시각(snapshot_at, UTC)과 차트 본 날짜(KST)를 분리. 1회성 백필은 `cli.py melon-chart-backfill` (guyso.me 아카이브 기반). source 필드는 신규 row 항상 'daily'.
- **V2.25 (2026-05-19)**: TOP100 차트 22 KST 1회 적재 복원 — 일간(06 KST)과 별도 trajectory. `chart_type` 컬럼 추가 (migration 0060, 'daily'|'top100'). `melon-chart --type top100` CLI + `melon-top100.yml` workflow (cron `0 13 * * *`). API `/api/melon/:key?type=daily|top100`. 프런트엔드 GroupContent에 탭 UI. agg_summary.melon_top100_peak/depth는 daily만 갱신 (V2.18→V2.19 union 회귀 방지).
- **V2.26 (2026-05-21)**: MiiWAN 디시 갤러리 등록 + 키워드 변형 보강 (migration 0061). `dc_gallery_id='miiwansonyeon'`, `context_keywords`에 `miiwan`/`MIIWAN`/`ㅁㅇㅅㄴ` 추가. 첫 dispatch에서 12행 적재 검증.
- **V2.27 (2026-05-21)**: DC 보조 갤러리 수집 — `groups.dc_supplemental_galleries` JSON 컬럼 신설 (migration 0062). DcCollector가 primary 후 supplemental 통합갤(예: vboyband)도 fetch + `is_relevant` 필터. MiiWAN 시드값 `["vboyband"]`.
- **V2.27.1 (2026-05-21)**: supplemental 매칭 strict mode — `analysis/relevance.py`로 `GENERIC_KEYWORD_BLOCKLIST` canonical 이동, `is_relevant(..., strict_generic_blocklist=True)` 옵션 추가. DcCollector supplemental 호출에만 적용 → '버추얼'/'IPX' 단독 매칭 차단. vboyband 신호/노이즈 33% → 100% 개선.
- **V2.28 (2026-05-21)**: 더쿠/인스티즈 보조 게시판 인프라 — V2.27 supplemental galleries 패턴을 두 사이트로 확장 (migration 0063). `theqoo_supplemental_boards` / `instiz_supplemental_boards` JSON 컬럼 신설. TheQoo `act=IS` 검색 + Instiz `/bbs/list.php` 검색이 자동화 차단되어 search collector 대신 supplemental 패턴으로 우회. 시드값은 NULL — 적합한 통합 게시판은 운영자 도메인 지식으로 후속 설정.
- **V2.29 (2026-05-21)**: 커뮤니티 글 정렬에 최신순/오래된순 + 플랫폼 필터 — 데뷔 전 그룹 운영(최근 1~2일 글 확인) 흐름 보완. `api/group/[key].ts` community_top SELECT에 `collected_at` 추가, Community.tsx `SortKey`에 latest/oldest 옵션 + posted_at NULL fallback. 플랫폼별 필터링도 추가.
- **V2.30 (2026-05-25)**: 그룹별 context_keywords 표기 변형 보강 + wegosix DC 갤러리 등록 (migration 0064). 8개 그룹 모두에 영문 대소문자/Title case / 콜론·하이픈·공백 변형 / 한글 초성 약자 추가 (예: WeGoSix → `wegosix`/`WeGoSix`/`wego6`/`we go six`/`ㅇㄱㅅㅅ` 등 10개 변형). MY:RAKL `ㅁㄹㅋ` + B:DAWN `ㅂㄷ`(2자 short-token, anchor 동반 시에만 매치) 사용자 명시 추가. wegosix mgallery 개설 확인 후 `dc_gallery_id='wegosix'` + `dc_supplemental_galleries=['vboyband']`. `is_relevant`의 short-token gate 가 일반어 충돌 자동 차단.
- **V2.31 (2026-05-26)**: insight/weekly LLM body 분석 깊이 강제 — `_ANALYSIS_DEPTH_GUIDELINES` 블록 신설. 운영자 피드백 ("미완소년 주간 구독자 약 3.3배 급증" 같은 단일 지표 카드는 보고서 가치 없음) 대응. 3-element rule (① 사실 ② cross-reference ③ 인과 추정) 강제. 신생 그룹 비율 환각 가드 (절대 수치/동급 D-N 베이스라인 동반 인용). body 길이도 1-3 → 2-4 문장으로 상향. MiiWAN scope coverage 규칙에 ANALYSIS DEPTH 준수 명시 추가. test_prompts.py 회귀 가드 (test_prompt_weekly_includes_analysis_depth_block) 추가.
- **V2.32 (2026-05-26)**: WE GO-6 (wegosix) 멤버 라인업 재설정 (migration 0068). 0034 시드 5인 중 해일/산호/진휘 완전 삭제 (`agg_member_popularity` orphan row 동반 정리). 신규 3인 INSERT — 쿠우타 (Kuta) / 제로 (Zero) / 태강 (Taegang). 현재 활동 5명 = 시우/우연/쿠우타/제로/태강. context_keywords 에 영문 표기 (Xiu/Wooyeon/Kuta/Kuuta/Zero/Taegang) 모두 시드 — 운영자 지시 "한국어/영어 둘 다 감지". "Zero" 영문은 일반어 충돌이 잦아 `analysis/relevance.py` 의 `GENERIC_KEYWORD_BLOCKLIST` 에 추가 (strict_generic_blocklist=True 인 DcCollector supplemental fetch 에서만 anchor-gated). 외부 검증: kprofiles.com/we-go-6-members-profile + dc wegosix 갤러리 글 확인.

**다음 단계 (우선순위)**: S급 5개 (RBAC + Cloudflare Access, 감사 로그, 본체 마스킹, 라이브 CCV/슈퍼챗 collector, 티켓 매진속도 collector). 자세한 우선순위는 대화 컨텍스트 또는 v2-roadmap.md 참고.

## 작업 시 주의사항

### 윤리 가이드라인 (`docs/superpowers/specs/2026-05-04-v2-roadmap.md` §7)

1. **본체 정보를 BI에 직접 저장 금지**. 위기 감지 키워드 알림은 OK, 신상은 X.
2. **2차 창작 트래킹은 "양"만**. 내용 본문 저장 금지.
3. **디시·더쿠 게시물 원문 저장 신중히**. 기본은 집계 결과만.
4. **자사 그룹(MiiWAN 등) 위주로 깊이, 경쟁사는 외형만**.
5. **위기 알림은 인간 검증 필수**. False positive로 인한 Streisand effect 회피.

### 데이터 / 분석 작업

- 새 collector는 `worker/src/idol_sight/collectors/base.py` 패턴을 따른다.
- 새 analysis 모듈은 `worker/src/idol_sight/analysis/` 에 추가하고 `cli.py`에 entry 등록.
- D1 schema 변경은 반드시 새 migration 파일로 (기존 migration 수정 금지).
- 산식 변경 시 `docs/superpowers/specs/2026-05-04-analysis-and-llm.md` 도 함께 업데이트.

### Frontend

- Preact + Vite. 컴포넌트는 `frontend/src/components/`, 페이지는 `frontend/src/views/`.
- 새 KPI 카드는 `KPI.tsx` 패턴 재사용. 산식 정의는 `HealthSpec.tsx` 모달에 추가.
- API 호출은 `frontend/src/api.ts` 통해. 인증은 `_middleware.ts`가 처리.

### 일반

- **편집 전 파일을 읽는다**. Edit 도구는 사전 Read를 요구.
- **commit message는 conventional commits**: `feat:`, `fix:`, `chore:`, `ci:`, `docs:`, `refactor:`.
- **PR 전 worker 테스트 실행**: `cd worker && uv run pytest`.
- **Cloudflare D1 원격 변경**은 항상 사용자 확인 후 진행.

## 디렉토리 트리 (요약)

```
idol-sight/
├── CLAUDE.md                      # 이 파일
├── README.md
├── docs/
│   ├── onboarding.md              # 최초 셋업 가이드
│   └── superpowers/specs/         # 명세 문서들
├── frontend/
│   ├── src/
│   │   ├── App.tsx, router.ts, api.ts
│   │   ├── components/            # KPI, Header, Sparkline, HealthSpec, ...
│   │   └── views/                 # MarketOverview, GroupContent, MiiWANBriefing, ...
│   ├── functions/                 # Pages Functions (api/, _middleware.ts, __auth.ts)
│   └── wrangler.toml
├── worker/
│   ├── pyproject.toml
│   └── src/idol_sight/
│       ├── cli.py, orchestrator.py, d1.py, config.py, notify.py
│       ├── collectors/            # youtube, dc, theqoo, naver, instiz, hanteo, twitter
│       ├── analysis/              # health_score, market_share, agg_summary, ...
│       ├── llm/                   # gemini, prompts, weekly
│       └── alerts/
├── migrations/                    # D1 SQL (sequential numbered files)
└── scripts/
    ├── setup.sh                   # 최초 1회 프로비저닝
    └── gen-password-hash.mjs
```
