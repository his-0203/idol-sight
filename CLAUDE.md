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
- **V2.33 (2026-05-26)**: UR:L (유아렐) 그룹 신규 추적 추가 (migration 0069). 샌드박스네트워크 첫 버추얼 아이돌 4인 (모카/랑코/마냥/솜먕) — 2025-12-31 'Chemical Love' 데뷔 (멜론 Hot100 7위). group_model='segmentary' → **subculture cohort** 편입 (기존 ISEDOL/STELLIVE 와 z-score 비교). 5개 채널 ID 확보 (그룹 `UCLAA9TKj-EYf2RUl1gLB9pQ` + 멤버 4명). dc_gallery_id='sandboxurl' 은 dcinside **mini 갤러리** namespace — DcCollector 의 `/board/lists/` URL 패턴이 mini 에서 404. `dc.py` 에 `_fetch_list_with_fallback` 추가: /board/ 시도 후 us-post rows 0건이면 /mini/lists/ 재시도. mgallery (JS redirect) 케이스는 영향 없음. `GENERIC_KEYWORD_BLOCKLIST` 에 일반어 충돌 토큰 추가: "URL"/"url" (IT 용어), "모카"/"Mocha" (커피), "마냥"/"Manyang" (부사). SocialBlade history backfill 은 별도 옵션 (credential 미설정).
- **V2.34 (2026-05-27)**: Debut Window bucket 균등 20일 폭 통일 (migration 0073). 이전 V3.1 의 11 bucket 은 D-60/D+60 (30일), D-30~D+30 (10일), D-Day (3일) 의 비대칭 폭이라 그룹 간 점수 비교 시 표본 수 격차 (D-60 30일치 vs D-30 10일치) 발생, 또한 ±30 안쪽 D-20/D-10/D+10/D+20 가 5탭 UI (DebutWindowKPI / DebutWindowVideoTable) 에 비노출되어 연속 windowing 비교 불가했음. 신규 9 bucket = Pre / D-60 / D-40 / D-20 / D-Day / D+20 / D+40 / D+60 / Post (7 named × 20일 균등, D-Day 는 데뷔일 중심 ±10일). worker `WINDOW_BUCKETS` + `frontend/functions/lib/debutWindowBuckets.ts` `FRONTEND_BUCKET_MAP` (이전 union 매핑 폐지, 1:1 identity) + DebutWindowKPI / DebutWindowVideoTable / CompetitorOrganicityBar 의 BUCKETS 배열 모두 동기화. CompetitorOrganicityBar 의 `EXTENDED_BUCKETS` (D-60/D+60) / `extended` legacy stripe 로직 폐기 — 균등 폭 이후 V3 의 ±30/±60 비대칭 fallback hack 불필요. migration 0073 은 `debut_window_video_organicity.window_bucket` 을 days_relative_to_debut 기반으로 UPDATE in-place + `debut_window_organicity_summary` DELETE (다음 worker cron 의 build_summary 가 재집계). MiiWANBriefing 의 7-anchor cohort 탭은 별도 개념 (agg_summary 스냅샷 anchor) 이라 영향 없음. test_debut_window.py 의 11→9 회귀 + boundary parametrize 갱신.
- **V2.35 (2026-06-05)**: 운영자 전용 주간 접속 추적 (migration 0079). 단일 공유 비밀번호 구조상 진짜 직원 단위 식별은 불가 → **브라우저 단위 근사**. 첫 방문 시 `_middleware.ts` 가 무작위 `idol_radar_cid` 쿠키(1년) 발급, 로그인된 *문서 로드*(앱 열기/새로고침)마다 `access_log` 에 `ctx.waitUntil` 비차단 INSERT (정적자산·API·로그인화면 제외). 숨겨진 `/admin/access?key=<ADMIN_KEY>` (`functions/admin/access.ts`) 가 KST 기준 주별 요약(최근 8주 고유 방문자/총 접속) + 이번 주 cid별 횟수를 HTML 표로 반환, 키 불일치/미설정 시 404로 존재 은닉. 순수 로직은 `functions/lib/accessLog.ts` 로 분리해 단위 테스트. 신규 시크릿 `ADMIN_KEY` 는 Cloudflare Pages 환경변수 등록 필요.

- **V2.36 (2026-06-05)** *(⚠️ V2.37 에서 폐기 — SHORT_MIN_SCORABLE_VIEWS 절대 게이트는 비중 기반 채점으로 대체됨, 아래 이력 보존)*: Debut Window organicity 의 Shorts 저용량 false-positive 차단. 운영자 보고 — MiiWAN `꿍싯꿍싯` Short(광고 미집행)가 `likely_paid`(score 31)로 오판. D1 실데이터: view 38K / like 328 / comment 19 / **velocity_ratio 18.565** → e_score 0(ER 0.91% < SHORT_ER_FLOOR 1.5%) + velocity_coherence 20(`paid_burst`) = 31. 둘 다 오가닉 바이럴 Short의 정상 시그니처(velocity_ratio 가 데뷔 전 소형 채널의 ~0 baseline 때문에 폭발한 분모 아티팩트 + Shorts ER 이 피드 스와이프로 구조적 저ER). `debut_window.py` `compute_organic_score` 에 Shorts 한정 scale gate 추가 — `is_short AND view_count < SHORT_MIN_SCORABLE_VIEWS(100K)` → `insufficient_data`(reason=`low_volume_short`, score=NULL). 기존 insufficient_data 플러밍 재사용으로 프런트 bar 회색 + summary mean/*_ratio + weekly_diagnosis `organicity_paid_ratio` 분모에서 자동 제외 (거짓 paid 단정 대신 판정 보류, 윤리 §7). 경쟁사 대형 채널 Short 는 100K 초과로 무영향, MiiWAN pre-debut Short 는 판정 보류 (자사는 ad spend 내부 인지 + 후속 YouTube Analytics traffic-source ground-truth 가 본 해결책). long-form 은 scope 제외(후속). 임계값 first-pass — 실 Short 분포로 calibrate 필요. test_debut_window.py 회귀 3종 추가 (꿍싯꿍싯 exact-value pin + boundary 38K/99999/100K/500K + long-form 비게이트).

- **V2.37 (2026-06-05)**: Debut Window organicity **Shorts 비중 기반 재설계** (V2.36 절대 게이트 폐기). 운영자 피드백("조회 적든 많든 좋아요·댓글 비중으로 organic/paid 판단 가능") + 실측 칼리브레이션. 라이브 6,258 Short 분포(ER p10=2.65%/p50=4.81%/p90=10.74%, like:comment p10=15/p50=41/p90=78) + MiiWAN Short 직접 조사로 검증: 작은 MiiWAN Short(~60개, <100K)는 ER 3~9%·균형 정상의 건강한 오가닉인데 V2.36 게이트가 다 버리고 있었고, 반대로 고조회 PLUMA 티저·Piece(130~200K)는 ER 0.08~0.13%로 진짜 유료(운영자 confirm). 핵심 개념 수정: "낮은 ER=paid" 단정 폐기 → **ER=세기 / like:comment=진정성(organic vs 조작)** 역할 분리. Shorts 전용 (long-form 미변경): 절대 게이트 제거(base `view<1000 AND eng<10` insufficient 만 유지), `SHORT_ER_FLOOR/CEIL` 1.5%/8.0%→**0.5%/9.0%**, `BALANCE_NORMAL_SHORT` 20/150→**15/78** (slope 4/0.1→5/0.4), **velocity 제거**(아티팩트 원인) + `SHORT_WEIGHTS=engagement 0.4/balance 0.6`(balance 우위로 "약하지만 균형정상" Short 는 borderline, farm/dead 만 paid). 프런트 `DebutWindowSignalPanel` 3-tier→5-tier 정비 + cause 기반 "조작 vs engagement 약함" 안내. 회귀 fixture: 꿍싯꿍싯→62 borderline(engagement_weak) / 티저→27 likely_paid(comment_farm) / 소형 건강→86 organic_strong / like-farm→21 likely_paid. worker 575 + frontend 154 통과.

- **V2.38 (2026-06-06)**: 라이브 CCV collector v1 (데뷔-크리티컬). YouTube 동시 시청자(concurrentViewers)를 **쿼터 거의 0**으로 수집 — 채널 RSS(`feeds/videos.xml`, Data API 아님 → 0유닛)로 최근 video ID → `videos.list(part=snippet,liveStreamingDetails)`(50개 batch=1유닛)로 라이브 여부+CCV 동시 획득. migration 0080: `groups.ccv_tracked` 토글(시드 MiiWAN/PLAVE/OWIS/wegosix) + `live_ccv_samples`(video_id+sampled_at PK, 멱등 UPSERT) 시계열 테이블. `collectors/live_ccv.py` `LiveCcvCollector.collect_global(now_iso=)` (MelonChartCollector 글로벌 패턴, 비-digit CCV 가드, 전체-RSS-실패 sentinel). `cli.py collect-ccv` + `_load_ccv_targets`(ccv_tracked=1). `collect-ccv.yml` cron `*/30 8-17 * * *`(KST 17:00–02:00 윈도, Actions 분 절약; 데뷔 당일 수동 dispatch). `/api/live-ccv`(최근 방송 peak/avg + 스파크라인, 테이블 없으면 `.catch(()=>[])` graceful) + MiiWANBriefing "라이브 반응" 카드(MiiWAN + 경쟁사 벤치마크). 슈퍼챗 금액(3자 API 불가)·치지직·티켓·방송별 집계테이블·CCV알림·crawl_meta 노출·보존 cron 은 v2 후속. 스펙 `docs/superpowers/specs/2026-06-06-live-ccv-collector-design.md`, 플랜 `docs/superpowers/plans/2026-06-06-live-ccv-collector.md`. worker 624 + frontend 171 통과. migration 0080 원격 적용 완료(2026-06-06).

- **V2.38.1 (2026-06-08)**: 라이브 CCV **수집 커버리지 재설계 — cron 다중 tick → 단일 self-loop 잡**. 운영자 보고 — OWIS가 06-07 라이브(`I0ovkjR5rR8` `[Archel.raw]`, RSS published 06-08 00:53 KST)를 했는데 CCV 0건. 진단: 수집 경로·RSS·채널 시드(`UC7nzgwXgrT4Po0OEqERZ3vQ`)는 정상, **타이밍 커버리지**가 원인. 두 구조적 결함 — ① 기존 cron `*/30 8-17`은 명목 30분이나 **GitHub이 `schedule` tick을 전역 deprioritize해 실측 ~1.5–2h 간격**(06-07 실제 실행 UTC 10:33/12:24/14:30/16:23/17:48, 5회뿐)으로 드롭, ② CCV는 `liveBroadcastContent=="live"` 동안만 읽히는 **휘발성**이라 폴링이 라이브와 겹쳐야만 적재(사후 백필 불가). `*/5`로 조밀화해도 GitHub이 더 깎아 비례 개선 안 됨. **저장소가 PUBLIC → Actions 분 무제한**이 핵심 — 단일 트리거 1회(`cron 45 9 * * *` = KST 18:45) 후 잡 내부에서 `bash while + sleep 300`으로 **5분마다 ~4.5h 자체 반복**(KST 18:45→23:15, 방송 주 시간대 19–23 커버). GitHub tick 드롭과 무관(트리거 1회, cadence는 sleep이 보장). `uv run … collect-ccv || echo WARN`로 개별 샘플 실패가 루프를 안 죽임, `timeout-minutes: 290` ceiling, 데뷔 당일 `workflow_dispatch` 수동(언제 dispatch하든 그 시점부터 4.5h). videos.list ~51유닛/일(무시 가능). 워크플로 전용 변경 — Python/migration/배포 gate 무관, worker/frontend 코드·테스트 불변. **관찰(미수정)**: 단일 잡이 4.5h 중간 크래시 시 잔여 윈도우 손실(재시도 없음) — 필요 시 겹치는 2차 트리거로 후속 보강 가능.

- **V2.39 (2026-06-07)**: Debut Window organicity **Shorts 저댓글 balance 가드** (V2.37 후속). 운영자 ground-truth — MiiWAN Shorts 중 'PLUMA' MV Teaser만 유료, 나머지 전부 오가닉 → 티저 외 paid/suspect 판정은 전부 false positive. V2.37 Shorts 채점은 balance(`like_comment_ratio`=likes/max(comments,1), weight 0.6) 가 지배하는데 이 비율은 **댓글이 적을 때 ±1 댓글 노이즈에 폭발**. V2.37 의 `comment==0` 가드(b=100 중립)만으로는 **댓글 1개부터 절벽** 발생 — 동일 Short(4K뷰/300좋아요)가 댓글0→93 organic_strong, 댓글1→ratio300→like-farm 페널티→39 likely_paid 로 추락. `compute_organic_score` 에 가드 2단화: `comment==0`(degenerate, basis=`zero_comment`) 유지 + 신규 `comment_count<BALANCE_MIN_COMMENTS_SHORT(10) AND view_count<BALANCE_LOW_VIEW_CEIL_SHORT(50_000)` → b=100(basis=`insufficient_comments`). **고조회 예외** 핵심 — 고조회+소댓글+near-dead ER 은 진짜 cold-traffic/paid 시그니처라 farm 탐지 유지(기존 like_farm fixture 100K뷰/댓글5 → 미보호, 21 likely_paid 불변). breakdown 에 `balance_basis`(ratio|zero_comment|insufficient_comments) 필드 신설(프런트 "댓글 부족으로 판정 보류" 안내용, 프런트 반영은 후속/선택). 기존 Shorts fixture 5개 전부 불변 통과(고조회 예외 덕). 신규 회귀: 절벽수정(4K/300/댓글1→93) + 고조회보존 + boundary(view 49999/50000, comment 9/10) + balance_basis. **범위 밖**(의도): Finding 2(dead-ER+정상비율/comment0+고조회 paid 가 composite≥60 미탐지, V2.37부터의 탐지망 협소) + Finding 3(요약 view-weighted mean 이 단일 티저에 지배) — 둘 다 별도 작업. 스펙 `docs/superpowers/specs/2026-06-07-organicity-shorts-low-comment-guard-design.md`. worker 631 통과. (worker 전용 변경, migration·배포 불필요 — 다음 organicity cron 재집계 시 자동 반영.)

- **V2.40 (2026-06-07)**: Debut Window organicity **요약 mean 기본값 = count 기반 simple mean** (V2.39 검토의 Finding 3). view-weighted `organic_score_mean` 은 고조회 아웃라이어 1개(운영자 confirm 유료 PLUMA 티저)가 버킷 점수를 지배해, count 상 99% 오가닉인 카탈로그를 paid스럽게 과대표시했음. 렌즈 결정을 `frontend/src/lib/organicity.ts` 에 중앙화(`DEFAULT_ORGANICITY_MODE='all_simple'` + `headlineOrganicScore()`) — 두 소비처(DebutWindowKPI 헤드라인 + CompetitorOrganicityBar 기본 모드)가 silent desync 못 하게(파일 헤더가 경고하는 그 위험). DebutWindowKPI 헤드라인 → simple mean, reach-weighted 는 툴팁 병기. CompetitorOrganicityBar 기본 → all_simple(토글 유지). "도달이 얼마나 오가닉인가"(view-weighted) 는 한 클릭 거리에 보존. frontend 174 통과 + tsc clean. **Finding 2(paid 탐지망 협소)는 운영자 결정으로 미변경**(false positive 재발 리스크 + 휴리스틱-only 유지, backlog 문서화만). 순수 프런트 read 경로, migration·worker 불필요.

- **V2.41 (2026-06-08)**: Debut Window organicity **해석층 카피/UX 개선** (산식·임계값·데이터 미변경, frontend only). 운영자 점검 — "인지도 다른 그룹인데 점수가 비슷"·"오가닉 정상이면 건강한가"를 화면만 보고는 판단 못 함. 실데이터 검증으로 진단 확정: ① organicity composite 가 전부 비율(ER·like:comment·velocity)이라 **규모와 직교**(조회수 10K wegosix 84.4 > 276K stellive 65.4, 상관≈0), ② 변별력은 이미 데이터에 있음(그룹 점수 범위 42~92, 영상 단위 분산 큼) — 카드의 버킷 simple-mean 한 숫자가 산포를 뭉개는 표시 artifact, ③ 사이트는 mechanics·과잉단정 회피는 잘 전달하나 "진짜(organicity) ≠ 충분(reach)"·"초록 Strong ≠ 건강"·"건강은 organic floor 가 데뷔 전 baseline 위 유지로 판단" 같은 **결정용 해석이 비어있음**. 4-fix 카피 삽입: (1) `DebutWindowKPI` note + `CompetitorOrganicityBar` footer 에 "organicity=진정성(비율) 신호·조회수 규모와 무관" 1줄, (2) `MiiWANBriefing` posture 섹션 헤더에 "이 막대='진짜인가'(규모 무관) vs 위 표 조회·구독='충분한가'(규모)·별개" 2축 구분, (3) `DebutWindowVideoTable` Help 모달 + `DebutWindowSignalPanel` verdict pill 아래에 "초록=조작 신호 없음(진짜)일 뿐 인기·규모·건강 보장 아님·작은 채널도 비율 깨끗하면 Strong" valence 오독 방지, (4) posture 섹션 하단에 "데뷔 후 유료 축소 → 조회수 피크 대비 하락은 정상 가능·건강은 organic floor 가 baseline 위 유지/상승하는가로 판단·organicity 정상='진짜'지만 '충분·지속' 증거 아님" floor 프레임. **범위 밖**(운영자 결정): 산식 재보정, organic floor vs baseline 실측 viz, 2D(품질×규모) 패널, verdict 리라벨/공용 범례 컴포넌트 — 전부 카피 외 작업이라 별도. 스펙 `docs/superpowers/specs/2026-06-08-organicity-interpretation-copy-design.md`. frontend 174 통과 + tsc clean. 순수 카피 변경 — migration·worker·배포 cron 영향 0.

- **V2.42 (2026-06-08)**: 데뷔일 없는 그룹 organicity 채점 (**Undated 버킷**) + KPI 카드 note 삭제. 운영자 점검 — BTHD(비더후드, 경쟁사)가 Debut Window Organicity 카드에서 전부 "—". 원인: `groups.debut_date IS NULL` → 빌더 `build_video_organicity` 의 `WHERE g.debut_date IS NOT NULL` 게이트가 통째로 스킵(채널·영상 5개 정상 수집되나 organicity 행 0). 핵심 통찰: **organic 점수 산식은 데뷔일을 안 씀**(조회/좋아요/댓글/ER/balance/velocity 만) — 데뷔일은 ①게이트 ②버킷 배치(`days_relative`→`bucket_for`)에만. 앵커 없이 점수는 산정 가능, 버킷만 배치 불가. 해법(**migration 0** — `window_bucket TEXT NOT NULL` 에 CHECK 없어 새 라벨 삽입 자유): worker 게이트를 `WHERE v.published_at IS NOT NULL` 로 완화 + `UNDATED_BUCKET="Undated"` 신설, `build_video_organicity` 가 `debut_date` 없으면 `days_rel=0`(센티넬, 미렌더) + bucket="Undated" 로 채점. `build_summary` 는 (group,bucket) 제너릭이라 무변경(`(bthd,"Undated")` 요약 자동 생성). summary API(`functions/api/debut-window/summary.ts`): `buildBucketCase` 에 Undated passthrough + **bucket 필터 없을 때만**(카드 fetch) IN 목록에 'Undated' 포함(posture bar 의 `?bucket=X` 경로는 미포함, `FRONTEND_BUCKET_MAP` 무변경이라 탭 비노출). `DebutWindowKPI`: Undated 요약 있으면 7-버킷 행 아래 **pre-debut 배지**(`pre-debut · N개 영상 · 평균 X점`, 색 scoreColor, insufficient만이면 "판정 보류"). **무변경 확인**: `videos-all.ts`(bucket 필터 없는 LEFT JOIN → "전체 기간" 탭에 Undated 점수 자동 노출), `DebutWindowVideoTable`(전체기간 뷰는 Published 날짜·bucket 컬럼 없음 → days0/"Undated" 미렌더), `CompetitorOrganicityBar`(클라가 `DISPLAY_BUCKETS` 필터 → Undated 자동 제외). D1 확인: NULL-debut 그룹은 BTHD 단 하나(5영상 전부 stats 존재 → 실점수, k3_qxUaax3w 106K뷰 short ER 0.15% → paid 시그니처 예상). **동시 작업**: 운영자 요청으로 `DebutWindowKPI` 의 `kpi-debutwin-note`(V2.41 "규모 무관" 1줄 + 기존 "simple mean…" 캡션) **삭제** — 카드가 번잡하다는 피드백. (같은 "규모 무관" 문구는 posture bar 푸터·MiiWAN 섹션엔 유지.) 스펙 `docs/superpowers/specs/2026-06-08-undated-organicity-scoring-design.md`. worker 633 + frontend 174 통과, tsc clean. 다음 organicity cron(21:30 KST)이 BTHD 자동 채점 → 배지·전체기간 노출. migration·배포 gate 무관.

- **V2.43 (2026-06-08)**: 성장 궤적 레이어 Phase 1 (모든 그룹 `성장` 탭). 대시보드가 상태 진단(organicity/건전성/멤버비중)엔 강하나 "건강히 성장하는가/어디가 부족한가"가 약했음 — 바이탈 패널이 "안정"과 "정체"를 구분 못 함(데뷔 그룹 Health "B" 8주 횡보 = 정체인데 초록). Frame A(자기 과거 대비) 원천 기둥 궤적: 도달 성장(Δsubs/주)·호응 품질(증분 ER=Δ(likes+comments)/Δviews)·커뮤니티 모멘텀(Δposts/주)·여론(negative_ratio invert→climbing=호전). 누적 컬럼은 주간 flow(Δ7)로 차분, KST 일별 리샘플(스냅샷 여러 개→최신). WoW + 4주 상대기울기 + 가속 → climbing/plateau/declining × accel/decel, posture 라벨(상승·가속 등 7종) + 약점 플래그(등급 아닌 방향 사실, 휴리스틱 추정·인간검증). worker `analysis/growth_trajectory.py`(순수함수 분해 resample/slope/flow/accel/classify/incremental_er/compute_pillars/synthesize_posture + `build_growth_trajectory` full DELETE+rebuild, `cli.py aggregate` 등록) → migration 0081 `group_growth_trajectory`(그룹당 1행, pillars JSON) → `/api/growth-trajectory`(graceful no_data — 테이블 없으면 빈 응답) → `GroupGrowth` 탭 뷰(`GroupTabs` 5번째 "성장", 모든 그룹 — 궤적은 전부 공개 외형 지표라 §4 위배 없음). <14일 history(BTHD)는 insufficient_history "데이터 축적 중". pillar별 wow_growth 단위 상이(level 기둥=비율, ratio 기둥=절대 델타) — 프런트 fmtWoW가 기둥별 렌더(reach %/주, ER %p, 여론 %p+arrow=건강방향). 처방·깔때기 전환(stage 간 누수)·기대대비갭(Frame B/C)·카드 축약 배지·임계값 calibration은 Phase 2+. 스펙/플랜 `docs/superpowers/{specs,plans}/2026-06-08-growth-trajectory*`. worker 659 + frontend 174 통과. **migration 0081 운영자 원격 apply 필요**(`gh workflow run migrate.yml`), 이후 다음 aggregate cron(21:30 KST)이 테이블 채움.

- **V2.43.1 (2026-06-08)**: V2.43 라이브 적재 후 분포 점검에서 드러난 2건 수정 + 패널 가독성 재설계. ① **valence 정직화**: 기둥이 전부 누적(flow 기반)이라 slope 음수=성장 *둔화*지 절대 하락 아님 → posture 라벨을 `상승·가속/정체/하락·가속(악화)` → **성장 가속/확대/확대(둔화 조짐)/유지/둔화/둔화 심화** 로 교체("하락"·"악화" 제거, PLAVE가 "하락·가속(악화)"→"성장 둔화"로). ② **weakest 정상화**: `negative_ratio=0`(최건강)이 sentiment unknown→weakest 오플래그되던 것 — sentiment-zero→plateau remap + weakest는 unknown 제외 & 점수<0(실제 둔화)일 때만, 아니면 None(MiiWAN="신경 쓸 약점 없음"). ③ **패널 재설계**(평이·절제 톤): 평이 이름(새 팬 유입/팬 반응 진정성/커뮤니티 활기/평판) + 상태 말+색점(빠른 증가/안정/둔화/양호) + 모순 화살표 제거 + 숫자 보조(muted) + posture 한 줄 gloss + chip + 짧은 평이 disclaimer. worker 668 + frontend 174, subagent 코드리뷰 통과. **재집계 필요**: 테이블의 기존 라벨은 구 코드 산출이라, 다음 aggregate cron(또는 수동 collect-daily) 후 새 라벨·weakest 반영됨.

- **V2.43.2 (2026-06-08)**: 성장 궤적 — ① 단어=숫자 4주 지평 정렬(`change_4w` 필드 추가, reach 숫자를 noisy 1주 wow→"최근 4주 +X%", engagement 상태어 방향 명시 "약화"→"약해지는 중", "팬 반응 진정성"→"팬 반응"). ② **커뮤니티 기둥 재정의** — 운영자 점검: agg_summary `dc_total_posts`가 누적 COUNT(*)라 단조 증가, "커뮤니티 탭엔 새 글 없는데 활발해지는 중" 오표시. 누적은 재발견·백필·보조갤·저관련 글까지 포함하고 거의 안 내려감(climbing 편향). → `community_posts.posted_at`(DC 100% 커버리지) 기반 **"최근 7일 게시량" value 기둥**으로 전환: `community_activity_series`(trailing-window posting volume, posted_at 일별 카운트를 daily 타임라인에 정렬) 신설, `compute_pillars(daily, community_series)` 시그니처 변경, build 가 community_posts 별도 fetch. 죽은 `_community_series`/`_COMMUNITY_COLS` 제거. 프런트 community 숫자 "최근 7일 N건". theqoo/instiz(posted_at 0%, 행 4·22개)·twitter(별도 테이블)는 recent-volume 범위 밖(무시 가능/후속). worker 674 + frontend 174. **재집계 필요**(다음 collect-daily/cron 후 반영). 남은 calibration(임계값 size 편향 등)은 Phase 2.

- **V2.43.3 (2026-06-08)**: 성장 궤적 — 전체 그룹 감사 후 데이터 품질 가드 2종. 운영자 "전 그룹 재검토" 요청 → 원천 신호 점검에서 발견: ① **reach가 구독자 양자화/동결에 취약** — YouTube가 대형 채널 구독자를 반올림(PLAVE는 60일간 distinct 3개·14일 변동 0으로 사실상 동결, isedol/skinz 거침, myrakl 14일 +50로 평탄)해서 `relative_slope`가 미세 움직임을 "빠른 증가"로 증폭(MyRAKL "+0% 빠른 증가"의 진짜 뿌리). → `REACH_NOISE_FLOOR=0.02`: reach 4주 상대변동 <2%면 climbing/declining 단정 대신 **plateau("유지")+flat** 강제(`_pillar_from_levels` noise_floor 파라미터). ② **커뮤니티 onset/희소 아티팩트** — bdawn은 글 5개뿐(死신호), uryael은 99.7%가 최근 28일(수집 개시 버스트). → `MIN_COMMUNITY_VOLUME=5`(최근 7일 <5건)·`MIN_COMMUNITY_ACTIVE_DAYS=14`(게시 있는 날 <14) 미만이면 community direction=**unknown**(추세 보류, posture/weakest 제외). 프런트 reach plateau 단어 "꾸준"→"유지"(frozen +0%와 정합). ③ **관찰(미수정)**: sentiment는 11그룹 중 7곳이 negative_ratio 한 번도 >0(死신호, skinz만 0.32로 실제 부정 이력 큼) — 0=건강 유지가 맞아 보류. worker 680 + frontend 174. 임계값 first-pass(라이브 분포로 후속 보정). **재집계 필요**. 남은 calibration은 Phase 2.

- **V2.43.4 (2026-06-08)**: ① 성장 궤적 **reach 조회수 보조 신호**(Phase 2) — 대형 채널 구독자 반올림으로 reach가 noise-floor에 걸려 "유지"로만 나오던 것 보완. 구독자 4주 변동 <`REACH_NOISE_FLOOR`(양자화/동결)면 **정확한 누적 조회수 velocity로 reach 계산** + pillar에 `source`('subscribers'|'views') 표기, 프런트 "· 조회 기준" 병기. 실데이터 검증: plave/isedol/skinz/myrakl 조회수 velocity는 추세 신호 보유(반올림 구독자가 못 잡음). ② **커뮤니티 글 표시 버그 수정** — 운영자 보고 "OWIS 최근 글이 대시보드에 안 보이고 최신=5/30". 진단: **크롤은 정상**(전 그룹 6/8까지 수집, community_post_stats도 신선) — `api/group/[key].ts` commTop 쿼리가 `ORDER BY views DESC LIMIT 30`이라 조회수 0인 최근 글이 상위 30에서 밀려 풀에 부재했음. → `ORDER BY COALESCE(posted_at,collected_at) DESC LIMIT 50` + Community 뷰 기본 정렬 views→latest. worker 682 + frontend 174. **미해결(도메인 판단 필요)**: bdawn DC 갤러리 'bdawn'은 무관 노이즈 다수(동명/통합갤 유입)+실제 비던 글 5/28이 최신 → 갤러리 ID 재검토 또는 비활성 인정 필요. posted_at이 KST-naive 저장(타임존 불일치)도 후속.

- **V2.43.5 (2026-06-08)**: ① **커뮤니티 posted_at 타임존 수정** — `community_posts.posted_at`이 KST 값을 Z(UTC)로 잘못 저장(collector가 parse_safe 결과에 변환 없이 `Z` 부착) → 프런트 `formatKST`가 +9h 추가 → 게시시각 9시간 늦게 표시. `kst_to_utc()` 헬퍼 + dc/theqoo/instiz collector가 저장 전 -9h, migration 0082가 기존 row 백필(posted_at은 insert 1회만 쓰여 재이동 없음, datetime() 가드). 프런트 무변경(formatKST가 이미 UTC→KST). naver는 date-only(00:00Z=KST 09:00 같은날)라 무영향. ② **"데이터 있는데 표기 안 됨" 전수 감사** — 실제 버그는 커뮤니티 2건뿐(ORDER BY views→최신순, tz, 둘 다 수정 완료). 점검 결과 무이상: naver date-only 정확 / members JOIN orphan 없음 / melon JOIN은 self-derived(드랍 없음) / shorts-trend LEFT JOIN / 비활성 그룹·고아 group_key 없음 / twitter_posts 빈 테이블. worker 683. migration 0082 운영자 apply 필요.

- **V2.44 (2026-06-08)**: weekly 분석 보고 **주 2회 전환** (수=중간점검 / 일=결산). 기존 `analyze-weekly` 는 월요일 09 KST 주 1회(`cron 0 0 * * 1`)로 직전 완결 일~토 주만 분석 — 운영자가 한 주 흐름을 너무 늦게 봄. → cron `0 14 * * 0,3`(일·수 **23:00 KST**) + `bounds` 스텝 요일 분기: 일(weekday 6)→**final**(직전 완결 일~토, 현행), 그 외(수)→**interim**(이번 주 일~오늘, 4일 미완결). 두 보고는 같은 week_start 를 공유(수 06-10 interim 과 그 주 일 06-14 final 둘 다 ws=06-07)하므로 `insights.report_kind`('final'|'interim', migration 0083 `NOT NULL DEFAULT 'final'`) 신설 + `generate_weekly` 의 per-week DELETE 를 **kind 스코프**(`WHERE week_start=? AND report_kind=?`)로 좁혀 공존 보장(일요일 final 이 수요일 interim 카드를 안 지움). `report_kind` 가 워크플로 요일 → CLI `--kind`(click.Choice 검증) → `generate_weekly` → `build_context` LLM 컨텍스트 + INSERT 컬럼 → 프런트 피드 필터 + 배지까지 흐름. 부분 주 프레이밍: `prompts.py` 에 `_INTERIM_FRAMING_GUIDELINES` 블록(interim 일 때 "주중 중간(일~수) 미완결" 명시, 전주 같은 4일과 비교, 한터 mid-week 미집계 환각 금지 — V2.31 가드 연장). 전주 대비는 `build_context` 가 ws/we 각각 −7일 시프트라 4일 윈도가 전주 같은 4일과 자동 정합(왜곡 없음). 수요일도 **전체 파이프라인**(hanteo·SOV·health·멤버·감성·LLM) 실행 → SOV(`agg_market_share`)에 week_end=수 부분 주 행이 써지므로 트렌드 차트(`market-share.ts`)에 `strftime('%w',week_end)='6'`(토요일 완결주만) 가드 추가(기존 데이터 전부 토요일이라 무영향, 부분 주 행은 다음 일요일 final UPSERT 가 week_end 토요일로 덮어써 self-healing). 프런트 인사이트 피드(`insights.ts`): final 영구 노출 + interim **최근 3주**(`week_start >= date('now','-21 days')`)만, `?week=` 명시 조회는 둘 다. migration 0083 미적용 대비 **graceful degradation**(report_kind 참조 쿼리 throw 시 컬럼 없는 legacy 쿼리로 fallback — CLAUDE.md 배포↔마이그레이션 규칙). `Insights.tsx` interim 카드에 amber "중간점검" 배지. 스펙/플랜 `docs/superpowers/{specs,plans}/2026-06-08-weekly-report-twice-weekly*`. worker 699 + frontend 174 + tsc clean. **migration 0083 운영자 원격 apply 필요**(적용 대기 0082 와 함께 `gh workflow run migrate.yml`) — `insights.ts` 가 report_kind SELECT 하므로 배포 전 적용 권장(graceful fallback 이 갭 방어). 적용 후 다음 일·수 23 KST cron(또는 수동 `gh workflow run analyze-weekly.yml`)이 interim/final 생성. **범위 밖**(후속): interim 처방·Frame B/C 기대대비갭, 프런트 SQL 필터 단위 테스트(Pages Functions SQL 실행 테스트 인프라 부재).

- **V2.45 (2026-06-08)**: weekly LLM **데뷔 D-N 환각 근본 해결**. 운영자 발견 — MiiWAN 브리핑의 IPX 권고 카드가 "데뷔 D-24 (6/30)" 표기(실제 데뷔 2026-06-16=D-8). 진단: 문제 텍스트는 `insights` 테이블의 LLM 생성 `ipx_action` 카드(week 05-31, scope=miiwan)였고, 주차별 D-N 이 D-30/D-20/D-24 로 제멋대로 환각. 두 뿌리 — ① `build_context`(`weekly.py`)가 LLM 컨텍스트에 **데뷔일을 전혀 안 넘김**, ② `PROMPT_WEEKLY` few-shot 예시가 **"D-30/총 30건/6-30" 하드코딩** → ground-truth 없는 LLM 이 예시 패턴을 모방해 발명. (데이터·결정론 경로 `groups.debut_date=2026-06-16`·`/api/miiwan` days_to_debut·`MiiWANBriefing` 배지 = D-8 정확, 문제는 LLM 카드뿐.) 해결: `weekly.py` 순수함수 `_debut_countdown(rows, today)`(debut_date→`{debut_date,days_to_debut,label}`, 데뷔 전 `D-N`/당일 `D-DAY`/후 `D+N`) + `build_context` 가 활성 그룹 debut_date 조회해 **생성 시각 KST** 기준 `debut_countdown` 컨텍스트 키 주입(forward-looking "오늘부터" 라 분석 주 아닌 now 기준, interim/final 각자 생성시각 D-N 보유). `prompts.py` `_DEBUT_COUNTDOWN_GUARD` 블록 신설(데뷔 D-N·데뷔일·건수는 `debut_countdown` 값만, 추정·발명 절대 금지, 없는 그룹은 언급 금지, 코호트 비교 베이스라인은 별개 허용 — V2.31 환각 가드 연장) + forward-looking 하드코딩 앵커 4곳 중성화(`D-30`→`D-{N}`/`총 30건`→`총 N건`, 코호트 비교 D-30 예시는 보존). 경쟁사도 D+N label 주입돼 코호트 cross-ref 도 정확. 오염 카드 정리: 데뷔 환각 4건 **id 단위**(105/117/191/201) DELETE(05-03 정상 멤버티저 카드 보존), 운영자 원격 실행. 수정 push 후 `gh workflow run analyze-weekly.yml` 수동 디스패치로 D-8 올바른 카드 재생성. 스펙/플랜 `docs/superpowers/{specs,plans}/2026-06-08-weekly-llm-debut-countdown-fix*`. worker 704 통과(신규 5 테스트). 순수 worker 변경 — migration·프런트·배포 gate 무관. **잔여**(비차단, hard 가드로 봉쇄): 프롬프트의 코호트/포맷팅/coverage 블록에 D-30·"debut 2026-06" 리터럴 잔존(데뷔 D-N 발명 불가, 콘텐츠 가드와 무관 위치).

- **V2.46 (2026-06-08)**: 라이브 CCV 기반 **팬 충성도 점수화** (데뷔-크리티컬 후속). V2.38 CCV 수집이 MiiWAN 브리핑 1곳에서만 노출되고 평가에 미반영이었던 것을 확장 — 운영자 요청으로 그룹 상세페이지 기록 + 충성도 점수화 + 추적 그룹 확대. 핵심 개념: **CCV 절대값 = 규모 신호, 충성도 = peak CCV/구독자 전환율(규모와 직교)** — organicity의 "규모와 직교한 진정성"(V2.40~2.43) 철학 계승. 추적 확대: migration 0084가 `ccv_tracked=1`을 skinz/myrakl/bdawn/bthd에 추가 → corporate 8개 전부(segmentary ISEDOL/STELLIVE/UR:L 는 운영자 결정으로 제외). collector/CLI/cron 무변경(`_load_ccv_targets`가 자동 확대). 산식(`analysis/loyalty.py`, `build_fan_loyalty` → `agg_fan_loyalty` 그룹당 1행 full rebuild, `cli.py aggregate` 등록): 최근 56일 방송별 peak CCV의 **중앙값** ÷ 구독자 = 전환율 → 고정 벤치마크 임계값(`LOYALTY_ANCHORS`, 구간 선형보간, <0.5%~6%+)으로 0~100 점수. 결측 가드: 0방송=insufficient(score NULL), 1방송=low_confidence, 구독자 0/결측=insufficient(V2.43.3 동결 방어). 임계값은 first-pass — 라이브 데이터 축적 후 보정. 시청자 증감율(`ccv_trend_pct`/`trend_basis`): 윈도우 전·후반 median peak 비교, 4방송 미만 unknown, |Δ|<10% flat. **표시용, score 미반영**(레벨/모멘텀 분리, growth 철학). Health 통합(`health_score.py _factor_inputs`): Intimacy에 충성도를 3번째 신호로(eng 0.40/comm 0.30/loyalty 0.30), **데이터 있는 그룹만**(`basis='scored'`만 `_recompute_health_scores`가 주입) — 없으면 기존 2신호(0.55/0.45) 재정규화로 점수 불변(라이브 안 한 그룹 페널티 0). 단발(low_confidence)은 Health 미반영(thin data 보류), 카드엔 표시. 프런트: `group/[key]` 응답에 `fan_loyalty`(+방송별 peak 90일, graceful null) → content 탭 `FanLoyaltyCard`(점수/전환율/증감율/스파크라인, insufficient "축적 중"·low_confidence "단발 기준" 배지, "충성도=전환율 규모무관" 캡션). 비-tracked 그룹은 null → 미렌더. MiiWANBriefing `LiveCcvCard` 유지(역할 다름). 테스트: worker loyalty 13 + health intimacy 3, frontend FanLoyaltyCard 헬퍼 2. 스펙/플랜 `docs/superpowers/{specs,plans}/2026-06-08-fan-loyalty-ccv-scoring*`. **migration 0084 운영자 원격 apply 필요**(`gh workflow run migrate.yml`) — `group/[key].ts` graceful null이라 적용 전 갭 방어. 적용 후 다음 aggregate cron이 agg_fan_loyalty 채움. collect-ccv가 8개 그룹 수집 → 56일 축적되며 안정화. 윤리: CCV·구독자·전환율 모두 공개 외형 지표 → §4 위배 없음(growth 탭 동일 논리). worker 720 + frontend 176 통과. **범위 밖(후속)**: 임계값 실측 보정, segmentary CCV 추적, 재시청/지속력 기반 충성도(V2 산식), weekly LLM 충성도 주입, loyalty scoreColor 임계값 중앙화(두 번째 소비처 생길 때 lib 분리).

- **V2.47 (2026-06-09)**: 팬 충성도 카드 **방송별 peak CCV 호가창 사다리** (V2.46 후속, 프런트 전용). 운영자 요청 — V2.46 `FanLoyaltyCard` 의 방송별 peak CCV 가 `Sparkline` 으로 **모양(추세)만** 렌더되고 실수치·날짜는 버려졌음, "주식 호가창처럼" 최고 동시 시청자 **실값**을 보고 싶다. 핵심: 필요한 데이터가 **이미 응답에 다 있음** — `api/group/[key].ts` 가 `fan_loyalty.broadcasts[]={video_id,peak,last_at}`(최근 56일·최대 12개·오래된→최신) + `peak_ccv_median` 을 내려주므로 **worker·migration·API 변경 0**, 렌더만 교체. 사다리 = 시간순(최신 위, API 역순 렌더) · 깊이 막대 폭=`peak/max(peak)` 자기집합 정규화(`barWidthPct`, max≤0 가드) · 우측 콤마 숫자(`tabular-nums`). 강조 2종: 최신 행 teal 배경+진한 막대+강조 텍스트 / **중앙값 행**(점수 산식 `중앙값 peak÷구독자` 기준점) 회색 좌측 인셋 보더+`중앙값` 라벨 — `medianRowIndex`(`peak_ccv_median` 최근접, 동률 시 최신 행, **방송 3회 미만이면 null**=마킹 생략, 1~2회는 중앙값이 최신/유일값과 겹쳐 무의미). 상태별: scored(2회+)=풀 사다리 / low_confidence(1회)=1행+기존 amber `단발 방송 기준` 배지(중앙값 마킹 없음) / insufficient(0회)=사다리 없이 기존 `라이브 데이터 축적 중`. 날짜는 `datetime.ts` 신규 `formatKSTMonthDayWeekday`(UTC→KST `MM/DD 요일`, ko-KR weekday short=1자, null→`—`) — KST 포맷 단일 출처 유지. 제외(YAGNI·운영자 결정): YouTube 링크/행별 전환율/'LIVE' 뱃지(`last_at` 으로 현재 라이브 단정 불가). MiiWANBriefing `LiveCcvCard` 는 역할 달라 무관. 윤리: peak CCV·구독자·전환율 공개 외형 지표 → §4 위배 없음. 순수 헬퍼 TDD(`barWidthPct`/`medianRowIndex`/`formatKSTMonthDayWeekday`), 실물 컴포넌트 esbuild 브라우저 렌더로 시각 검증. 스펙 `docs/superpowers/specs/2026-06-09-fan-loyalty-ccv-ladder-design.md`. frontend 184 통과 + tsc clean. 프런트 전용 — migration·배포 gate 무관(main push 자동 배포).

**다음 단계 (우선순위)**: S급 (RBAC + Cloudflare Access, 감사 로그, 본체 마스킹, **티켓 매진속도 collector** — 다음 데뷔-크리티컬, 별도 brainstorm 필요). **알려진 잔여**: bdawn DC 갤러리 노이즈(갤러리 ID 도메인 재검토), twitter 수집 비활성. 라이브 CCV 는 V2.38 로 완료. 자세한 우선순위는 대화 컨텍스트 또는 v2-roadmap.md 참고.

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
- **배포 ↔ 마이그레이션 순서**: `frontend-deploy.yml` 은 main push 에 *자동*이지만 `migrate.yml` 은 *수동*(workflow_dispatch, D1 원격 apply 는 human-gated)이다. 따라서 새 컬럼/테이블을 읽는 코드는 마이그레이션이 운영자 손으로 적용되기 *전에* 먼저 배포될 수 있다. 두 가지로 방어한다: (1) 새 컬럼/테이블 읽는 코드를 push 하면 운영자가 **즉시 `gh workflow run migrate.yml` (또는 `wrangler d1 migrations apply --remote`)** 로 스키마부터 적용. (2) 새 스키마 의존 엔드포인트는 **graceful degradation** (테이블/컬럼 없으면 빈 결과 — 예: shorts-trend.ts 의 weekly_challenges try/catch) 로 작성해 적용 전 500 대신 빈 응답이 나가게 한다.
- **groups 의 JSON 컬럼**(blacklist_phrases / context_keywords / *_supplemental_* / twitter_handles)은 반드시 **JSON 배열 리터럴**로 시드한다 (CSV `'a,b,c'` 금지 — SQL 은 통과하나 런타임 json.loads 가 죽음, 0034/0069/0075 에서 3번 재발). `tests/unit/test_migrations_groups_json.py` 가 전체 마이그레이션 적용 후 전수 가드한다.

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

## SecondBrain 로그
작업 로그는 프로젝트명 `idol-sight`로 기록한다 (전역 규칙 `~/.claude/SecondBrainLog.md` 참조).
