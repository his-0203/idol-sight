# IDOL-SIGHT Rebuild — Design Spec

- **Date**: 2026-05-04
- **Status**: Draft (awaiting user review)
- **Owner / Driver**: User (PM/Reviewer)
- **Implementer**: Claude Code (단독 진행)
- **Predecessor**: https://virtual-idol-radar.vercel.app/ (현행 IDOL-SIGHT)

---

## 1. Overview

8개 버추얼 아이돌 그룹(PLAVE, ISEDOL, STELLIVE, SKINZ, MY:RAKL, MiiWAN, OWIS, B:DAWN)을
유튜브·네이버 뉴스·디시·더쿠·인스티즈·트위터·한터차트 등 다중 소스에서 추적하는 사내+파트너용
BI 대시보드를 처음부터 다시 만든다.

현행 사이트의 분석에서 식별된 6개 결함 카테고리 중 본 스펙은 5개를 다룬다 (#7 거버넌스/저작권은
제외). 운영비는 영구 무료 티어로만 구성한다.

### 1.1 해결 대상 결함

| # | 카테고리 | 핵심 증상 (현행) |
|---|---|---|
| 1 | 데이터 신선도 | 그룹별 `collected_at` 9~28일 편차, deltas 전부 0 |
| 2 | 수집 정확도 | B:DAWN 2006년 기사 혼입, OWIS/PLAVE date 필드에 본문 혼입, 동명이인 미필터 |
| 3 | 분석 방식 | Health Score 산식 비공개, 데뷔 전 그룹 D등급 강제, MIIWAN HHI=1.0 오해 |
| 4 | UX | 17MB 페이로드, 검색 부재, CSV/PNG 내보내기 부재, 공유 링크 부재, 라이트 모드 부재 |
| 5 | 보안/인증 | 평문 비번 비교 + 위조 가능 고정 쿠키 |
| 6 | 비용 구조 | 정적 JSON egress 누적 + 매주 LLM 풀 재생성 |

(#7 거버넌스/저작권은 본 작업 범위 밖.)

---

## 2. Goals / Non-goals

### Goals
- 모든 데이터 소스를 동일한 신선도 모델·동일한 신뢰 모델로 통합한다.
- Health Score·시장점유율·멤버 HHI 산식을 코드와 화면에서 동시에 노출한다.
- deltas는 SQL window function으로 즉시 정확하게 계산된다.
- 한 화면 다운로드는 항상 5MB 이하로 유지된다.
- 영구 무료 티어로 운영 비용 0을 달성한다.
- 사용자 ~50명 (IPX 사내 + 어비스컴퍼니 등 파트너)의 BI 도구로 충분한 응답성을 가진다.

### Non-goals
- 사용자별 계정·역할·SSO 도입 (단일 비밀번호 유지).
- 게시물 본문·이미지의 영속 저장 (메타+URL만).
- 모바일 네이티브 앱.
- 모든 K-pop 그룹 확장 (8개 한정, 신규 추가는 `groups` 테이블에 row 추가로 해결).
- 실시간 스트리밍 (분 단위 갱신 불필요, 시간 단위로 충분).

### Success Criteria
- 갱신 실패 시 Discord 알림 도달 ≤ 5분.
- `/api/group/:key` 응답 P95 < 500ms.
- 첫 로딩 페이로드 ≤ 200KB(JS+CSS), 데이터 fetch 별도.
- Naver 뉴스 `is_excluded=1` 분류된 row의 수동 검증 정밀도 ≥ 90%.
- 운영비 월 $0.

---

## 3. Decisions Summary

| 영역 | 선택 | 이유 |
|---|---|---|
| 사용자 베이스 | ~50명 사내+파트너 | Q2 답변 |
| 인증 | 단일 비밀번호 (현 방식 + HMAC 서명 쿠키) | "보안 강하게 안 함" 요청 |
| 마감 | 압박 없음, 제대로 만들기 | Q3 답변 |
| 개발 주체 | Claude Code 단독 | Q4 답변 |
| 기존 코드 활용 | 없음 (분석한 JSON에서 역설계) | 사용자 미보유 |
| 크롤링 | Scrapling (3-tier) | 별도 검토 결과 |
| YouTube 수집 | YouTube Data API v3 (Scrapling 사용 안 함) | 공식 API 무료 10k unit/일 충분, ToS 준수 |
| 한터 차트 수집 | Phase 1: 사람이 `hanteo_weekly`에 직접 INSERT (주 1회) | 약관 회색지대, 자동화는 Phase 2 검토 |
| 워커 호스팅 | GitHub Actions cron, public repo | 비용 0 + 무제한 minutes |
| DB | Cloudflare D1 (SQLite, 5GB 무료) | 비용 0, Pages Functions 직결 |
| 프론트 호스팅 | Cloudflare Pages | 비용 0, 무제한 트래픽 |
| 프론트 스택 | Vite + Vanilla TS or Preact + Chart.js + Tailwind | SSR 불필요, 정적 SPA |
| LLM | Google Gemini API Free (`gemini-2.5-flash`) | 1M tokens/일 무료, JSON Schema 지원 |
| 트위터 | nitter mirror or 수동 입력 fallback | X API Basic은 비용 위배 |
| 관측 | Discord webhook + BetterStack Free + GH Actions UI | 비용 0 |
| 본문 보관 | 안 함 (메타+URL만) | 거버넌스 + 용량 절약 |
| 데뷔 전 그룹 | `grade='PRE'`, Health Score `null`, HHI 미계산 | 오해 방지 |
| Vercel | 사용하지 않음 | Hobby 약관 회색지대 |

---

## 4. System Architecture

```
┌────────────────────────────────────────────────────────────┐
│ GitHub Actions (public repo, 무제한 minutes)               │
│                                                            │
│ collect-hourly.yml   → naver, twitter                      │
│ collect-6h.yml       → dc, theqoo, instiz, youtube-videos  │
│ collect-daily.yml    → youtube-channel-stats               │
│ analyze-weekly.yml   → hanteo, market_share,               │
│                        member_popularity, llm_insights     │
│ test.yml             → PR 단위 테스트                       │
│ frontend-deploy.yml  → frontend → Cloudflare Pages         │
│ migrate.yml          → wrangler d1 migrations apply        │
│ health-check.yml     → 매시간 freshness audit              │
│                                                            │
│ Python 3.12 + Scrapling + uv (pkg mgr)                     │
│   └─ writes via Cloudflare D1 HTTP API                     │
└────────────────────────────────────────────────────────────┘
                            │
                            ▼
                ┌──────────────────────┐
                │ Cloudflare D1 (5GB)  │
                │   raw_*  / agg_*     │
                │   crawl_meta         │
                │   selectors_cache    │
                └──────────────────────┘
                            ▲
                            │
                ┌───────────┴────────────┐
                │ Cloudflare Pages       │
                │  + Pages Functions     │
                │  /  → SPA (정적)        │
                │  /__auth → 비번 검증    │
                │  /api/* → D1 SELECT    │
                └────────────────────────┘
                            ▲
                            │
                       [브라우저]

  [Discord Webhook] ◄── 잡 실패 / 데이터 품질 임계 / smoke 실패
  [BetterStack Free] ◄── 워커 stdout JSON 로그
```

### 4.1 핵심 결정

1. **워커가 D1에 직접 쓴다** — Cloudflare D1 HTTP API (`POST /accounts/.../d1/database/.../query`). 중간 서버 없음.
2. **잡 분할** — 그룹×소스 매트릭스. 한 잡 실패가 다른 데이터에 영향 없음.
3. **무거운 집계는 워커에서 미리 계산** → `agg_*` 테이블 적재. Pages Functions는 단순 SELECT만.
4. **`crawl_meta` + `/api/meta`** → 모든 카드에 신선도 배지.
5. **시계열 컬럼 `snapshot_at`이 기본 패턴** — deltas는 `LAG()` 한 줄로 계산.

---

## 5. Data Model (Cloudflare D1 / SQLite)

### 5.1 Conventions

- 모든 시각은 ISO 8601 UTC (`'2026-05-04T08:15:00Z'`).
- URL 식별은 `url_hash = sha1(url)`.
- 시계열은 `(entity_id, snapshot_at)` 복합 PK.
- raw_/agg_ 분리: 원천은 수집기가 채우고, 집계는 분석 모듈이 채운다.
- Schema 변경은 forward-only migration (`migrations/000X_*.sql`).

### 5.2 Schema

```sql
-- ─── 마스터 ──────────────────────────────────────
CREATE TABLE groups (
  key TEXT PRIMARY KEY,            -- 'plave', 'miiwan', ...
  name TEXT NOT NULL,              -- 'PLAVE'
  name_kr TEXT NOT NULL,           -- '플레이브'
  debut_date TEXT,                 -- '2023-03-12' (NULL: 데뷔 전)
  yt_channel_id TEXT,
  dc_gallery_id TEXT,
  naver_query TEXT,                -- 검색 쿼리
  context_keywords TEXT,           -- JSON array, 동명이인 필터
  blacklist_phrases TEXT,          -- JSON array
  twitter_handles TEXT,            -- JSON array
  is_active INTEGER DEFAULT 1
);

CREATE TABLE members (
  id INTEGER PRIMARY KEY,
  group_key TEXT REFERENCES groups(key),
  name TEXT,                       -- '노아'
  name_en TEXT,
  yt_channel_id TEXT,              -- 멤버 솔로 채널
  active INTEGER DEFAULT 1
);

-- ─── 원천: YouTube ──────────────────────────────
CREATE TABLE youtube_videos (
  video_id TEXT PRIMARY KEY,
  group_key TEXT REFERENCES groups(key),
  channel_id TEXT,
  title TEXT,
  duration_sec INTEGER,
  published_at TEXT,
  content_type TEXT,               -- MV/Cover/Live/Audio/Variety/Teaser/Short/...
  is_short INTEGER DEFAULT 0,
  first_seen_at TEXT NOT NULL
);

CREATE TABLE youtube_video_stats (
  video_id TEXT REFERENCES youtube_videos(video_id),
  snapshot_at TEXT NOT NULL,
  views INTEGER, likes INTEGER, comments INTEGER,
  PRIMARY KEY (video_id, snapshot_at)
);

CREATE TABLE youtube_channel_stats (
  channel_id TEXT, snapshot_at TEXT,
  subscribers INTEGER, total_views INTEGER, video_count INTEGER,
  PRIMARY KEY (channel_id, snapshot_at)
);

-- ─── 원천: 뉴스 ─────────────────────────────────
CREATE TABLE naver_articles (
  url_hash TEXT PRIMARY KEY,
  group_key TEXT REFERENCES groups(key),
  title TEXT, source TEXT, url TEXT,
  published_at TEXT,
  is_excluded INTEGER DEFAULT 0,
  exclude_reason TEXT,
  collected_at TEXT NOT NULL
);

-- ─── 원천: 커뮤니티 (통합) ─────────────────────
CREATE TABLE community_posts (
  url_hash TEXT PRIMARY KEY,
  platform TEXT NOT NULL,           -- 'dc' | 'theqoo' | 'instiz'
  group_key TEXT REFERENCES groups(key),
  title TEXT, url TEXT,
  posted_at TEXT,
  collected_at TEXT NOT NULL
);

CREATE TABLE community_post_stats (
  url_hash TEXT, snapshot_at TEXT,
  views INTEGER, likes INTEGER, comments INTEGER,
  PRIMARY KEY (url_hash, snapshot_at)
);

CREATE TABLE community_keywords (
  group_key TEXT, snapshot_at TEXT,
  keyword TEXT, count INTEGER,
  PRIMARY KEY (group_key, snapshot_at, keyword)
);

-- ─── 원천: 트위터 ──────────────────────────────
CREATE TABLE twitter_posts (
  tweet_id TEXT PRIMARY KEY,
  group_key TEXT REFERENCES groups(key),
  author_handle TEXT, title TEXT, url TEXT,
  posted_at TEXT, collected_at TEXT,
  type TEXT                          -- controversy/news/event/content
);

-- ─── 원천: 한터 ───────────────────────────────
CREATE TABLE hanteo_weekly (
  week_start TEXT, week_end TEXT,
  group_key TEXT REFERENCES groups(key),
  album TEXT, rank INTEGER, sales INTEGER, note TEXT,
  PRIMARY KEY (week_start, group_key, album)
);

-- ─── 집계 ───────────────────────────────────────
CREATE TABLE agg_summary (
  group_key TEXT, snapshot_at TEXT,
  yt_total_videos INTEGER, yt_total_views INTEGER, yt_subscribers INTEGER,
  dc_total_posts INTEGER, theqoo_posts INTEGER, instiz_posts INTEGER,
  naver_total_news INTEGER, twitter_posts INTEGER,
  controversy_count INTEGER,
  PRIMARY KEY (group_key, snapshot_at)
);

CREATE TABLE agg_health_scores (
  group_key TEXT, snapshot_at TEXT,
  total REAL,                          -- 0~10, NULL if PRE
  raw_total REAL, grade TEXT,          -- 'S'|'A'|'B'|'C'|'D'|'PRE'
  label TEXT,
  breakdown_json TEXT,
  bonus_json TEXT,
  quality_method TEXT,
  PRIMARY KEY (group_key, snapshot_at)
);

CREATE TABLE agg_market_share (
  week_start TEXT, week_end TEXT, group_key TEXT,
  cum REAL, mom REAL, final REAL,
  market_total INTEGER,
  PRIMARY KEY (week_start, group_key)
);

CREATE TABLE agg_member_popularity (
  group_key TEXT, snapshot_at TEXT, member_id INTEGER,
  yt_score REAL, community_score REAL, composite_score REAL,
  yt_videos INTEGER, yt_avg_views INTEGER, yt_sufficient INTEGER,
  community_mentions INTEGER,
  PRIMARY KEY (group_key, snapshot_at, member_id)
);

CREATE TABLE agg_member_pop_meta (
  group_key TEXT, snapshot_at TEXT,
  hhi REAL, evenness REAL, status TEXT,    -- 'ok' | 'insufficient'
  PRIMARY KEY (group_key, snapshot_at)
);

CREATE TABLE insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generated_at TEXT, week_start TEXT,
  scope TEXT,                              -- 'market' | group_key
  type TEXT,                               -- 'insight' | 'ipx_action' | 'weekly'
  title TEXT, body TEXT,
  source_refs_json TEXT
);

-- ─── 운영 메타 ──────────────────────────────
CREATE TABLE crawl_meta (
  job TEXT PRIMARY KEY,                    -- 'youtube:plave'
  group_key TEXT, source TEXT,
  expected_interval_h INTEGER,
  last_attempt_at TEXT, last_success_at TEXT,
  status TEXT,                             -- 'ok' | 'failed' | 'partial'
  error_msg TEXT, runtime_ms INTEGER,
  rows_inserted INTEGER, rows_updated INTEGER
);

CREATE TABLE selectors_cache (
  site TEXT, selector_key TEXT,
  serialized TEXT, updated_at TEXT,
  PRIMARY KEY (site, selector_key)
);

CREATE INDEX idx_yt_video_group ON youtube_videos(group_key);
CREATE INDEX idx_naver_group_date ON naver_articles(group_key, published_at);
CREATE INDEX idx_comm_platform_group_date
  ON community_posts(platform, group_key, posted_at);
CREATE INDEX idx_comm_stats_snap ON community_post_stats(snapshot_at);
CREATE INDEX idx_summary_snap ON agg_summary(snapshot_at);
CREATE INDEX idx_health_snap ON agg_health_scores(snapshot_at);
```

### 5.3 Retention Policy

- `community_post_stats`, `youtube_video_stats`, `agg_summary`, `agg_health_scores`:
  - 0~90일: full resolution (스냅샷마다 1행).
  - 90~365일: 일별 1행으로 down-sample (분석 워크플로 끝에 cleanup 단계).
  - 365일 이상: 주별 1행.
- `insights`: 영구 보관 (작은 용량).
- `crawl_meta`: 1행/잡, 갱신만.

용량 추정: 8그룹 × 100KB/일 × 365일 = ~290MB. 5GB 한도의 6% (충분 여유).

---

## 6. Worker

### 6.1 Directory Layout

```
worker/
├── pyproject.toml
├── src/idol_sight/
│   ├── __init__.py
│   ├── cli.py
│   ├── config.py
│   ├── d1.py
│   ├── meta.py
│   ├── selectors_store.py
│   ├── notify.py
│   ├── collectors/
│   │   ├── base.py
│   │   ├── youtube.py
│   │   ├── naver.py
│   │   ├── dc.py
│   │   ├── theqoo.py
│   │   ├── instiz.py
│   │   ├── twitter.py
│   │   └── hanteo.py
│   ├── analysis/
│   │   ├── health_score.py
│   │   ├── market_share.py
│   │   ├── member_popularity.py
│   │   ├── news_filter.py
│   │   └── delta.py
│   └── llm/
│       ├── gemini.py
│       └── prompts.py
└── tests/
    ├── unit/
    └── fixtures/
```

### 6.2 Collector Interface

```python
from typing import Protocol
from dataclasses import dataclass

@dataclass
class CollectionResult:
    rows_inserted: int
    rows_updated: int
    statements: list[tuple[str, list]]   # (sql, params) for D1 batch
    errors: list[str]
    runtime_ms: int

class Collector(Protocol):
    source: str

    def collect(self, group: GroupConfig, since: str | None) -> CollectionResult: ...
```

각 collector는 D1 writes를 직접 안 하고 `statements` 리스트만 반환한다. 워커 루트가
`crawl_meta` 업데이트와 함께 트랜잭션 단위로 실행해 부분 실패 시 일관성을 보장한다.

### 6.3 Scrapling 3-Tier 전략

> **Out of scope**: `youtube` collector는 YouTube Data API v3을 호출한다 (Scrapling 미사용).
> `hanteo` collector는 Phase 1에서 사람이 직접 `hanteo_weekly`에 INSERT 하며,
> 분석 워크플로는 그 데이터를 그대로 사용한다. (자동 수집은 Phase 2.)
> 아래 Tier 전략은 naver / dc / theqoo / instiz / twitter 5개 collector에 적용된다.

- **Tier 1 — `Fetcher`** (curl_cffi): naver, instiz(시도)
- **Tier 2 — `StealthyFetcher`** (Playwright + stealth): dc, theqoo, instiz(차단 시), twitter(nitter)
- **Tier 3 — `DynamicFetcher`**: 운영에서 사용 안 함 (PoC 한정)

```python
from scrapling import Fetcher, StealthyFetcher

# Tier 1
page = Fetcher.get(url, impersonate="chrome131", stealthy_headers=True)

# Tier 2
page = StealthyFetcher.fetch(url,
                              headless=True,
                              network_idle=True,
                              block_resources=True,
                              solve_cloudflare=True)

# Adaptive selectors
posts = page.css('div.gall_list_item', auto_save=True)
# auto_save 결과 → selectors_cache 테이블 동기화
```

### 6.4 GitHub Actions Workflows

#### `collect-6h.yml` (예시)

```yaml
name: collect-6h
on:
  schedule:
    - cron: '15 */6 * * *'
  workflow_dispatch:
    inputs:
      groups:  {description: '쉼표구분', default: 'all'}
      sources: {description: '쉼표구분', default: 'dc,theqoo,instiz,youtube'}

jobs:
  collect:
    strategy:
      fail-fast: false
      max-parallel: 8
      matrix:
        group:  [plave, isedol, stellive, skinz, myrakl, miiwan, owis, bdawn]
        source: [dc, theqoo, instiz, youtube]
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v3
      - run: uv sync --frozen
      - run: uv run scrapling install
      - run: |
          uv run python -m idol_sight collect \
            --source ${{ matrix.source }} \
            --group  ${{ matrix.group }}
        env:
          CF_ACCOUNT_ID:  ${{ secrets.CF_ACCOUNT_ID }}
          CF_D1_DB_ID:    ${{ secrets.CF_D1_DB_ID }}
          CF_API_TOKEN:   ${{ secrets.CF_API_TOKEN }}
          YT_API_KEY:     ${{ secrets.YT_API_KEY }}
          DISCORD_WEBHOOK: ${{ secrets.DISCORD_WEBHOOK }}
      - if: failure()
        run: uv run python -m idol_sight notify-fail
              --job '${{ matrix.source }}:${{ matrix.group }}'
```

#### Schedule Map

| Workflow | Cron | Sources | Expected Interval |
|---|---|---|---|
| `collect-hourly.yml` | `5 * * * *` | naver, twitter | 1h |
| `collect-6h.yml` | `15 */6 * * *` | dc, theqoo, instiz, youtube-videos | 6h |
| `collect-daily.yml` | `30 8 * * *` | youtube-channel-stats | 24h |
| `analyze-weekly.yml` | `0 9 * * 1` | market_share, member_pop, llm (※ hanteo는 수동 INSERT 후 사용) | 168h |
| `health-check.yml` | `0 * * * *` | freshness audit | 1h |

### 6.5 핵심 결정

1. `max-parallel: 8` — 한 사이트 동시 8요청 이상 자제.
2. cron 분 단위 jitter — GH cron 정시 큐 회피.
3. `fail-fast: false` — 한 잡 터져도 나머지 진행.
4. timeout-minutes 20 — 무한 대기 방지.
5. Discord 웹훅 + `crawl_meta` 동시 업데이트.

---

## 7. Analysis Layer

### 7.1 Health Score

```python
WEIGHTS = {
  'subscribers': 20,    # YT 구독자 ÷ 1,000,000
  'views':       20,    # YT 누적 ÷ 200,000,000
  'quality':     15,    # YT Top10 평균 조회수
  'community':   20,    # DC + TheQoo + Instiz 활동량 ÷ 200,000
  'news':        10,    # naver_total_news ÷ 500
  'risk':        15,    # 10 - controversy_penalty
}
BONUS_MAX = 10           # recent_90d + recent_30d

def compute_health_score(group, agg, debut_date) -> HealthScore:
    if debut_date is None or days_until(debut_date) > 0:
        return HealthScore(total=None, grade='PRE',
                           label='데뷔 전 (활동량 부족)',
                           breakdown={}, bonus={},
                           quality_method='n/a')

    base = (
        normalize(agg.yt_subscribers, 1_000_000)        * WEIGHTS['subscribers']
      + normalize(agg.yt_total_views, 200_000_000)      * WEIGHTS['views']
      + quality_score(agg.yt_top10)                     * WEIGHTS['quality']
      + normalize(comm_total(agg), 200_000)             * WEIGHTS['community']
      + normalize(agg.naver_total_news, 500)            * WEIGHTS['news']
      + (1 - controversy_penalty(agg.controversy_count))* WEIGHTS['risk']
    )
    bonus = recent_bonus_90d(agg) + recent_bonus_30d(agg)
    raw_total = base + bonus
    total = round(raw_total / (sum(WEIGHTS.values()) + BONUS_MAX) * 10, 1)
    grade = ('S' if total>=9 else 'A' if total>=7 else 'B' if total>=5
             else 'C' if total>=3 else 'D')
    return HealthScore(total=total, raw_total=raw_total, grade=grade,
                       label=label_for(grade),
                       breakdown=..., bonus=...,
                       quality_method='top10_avg')
```

가중치는 `config.py`에 단일 출처로 박고, 산식 회귀 테스트가 fixture와 비교한다.
`/api/health/spec` 엔드포인트가 가중치를 그대로 노출 → 프론트 산식 모달이 같은 값을 표시.

### 7.2 Market Share (Cum 60% + Mom 40%)

```python
def compute_market_share(week_start, week_end):
    rows = []
    cum_total = sum(group.cum_score for group in groups_active)
    mom_total = sum(group.mom_score(week_start) for group in groups_active)
    for g in groups_active:
        cum_share = g.cum_score / cum_total * 100
        mom_share = g.mom_score(week_start) / mom_total * 100
        final = cum_share*0.6 + mom_share*0.4
        rows.append((week_start, week_end, g.key,
                     cum_share, mom_share, final, mkt_total))
    return rows
```

13주 슬라이딩 윈도우. 화면에서는 PLAVE 비대칭 보완을 위해 "PLAVE 제외" 토글과 "로그 스케일"
토글을 §8에서 제공한다.

### 7.3 Member Popularity + HHI

```python
def compute_member_popularity(group_key) -> MemberPop:
    members = [m for m in members_of(group_key) if m.active]
    rows = []
    for m in members:
        yt_videos = count_solo_videos(m.yt_channel_id)
        yt_avg = avg_views_solo(m, last_90d=True)
        yt_sufficient = yt_videos >= 3
        yt_score = normalize_yt(yt_avg) if yt_sufficient else 0
        comm_mentions = count_member_mentions(m.name, last_30d=True)
        comm_score = normalize_comm(comm_mentions)
        composite = yt_score * 0.5 + comm_score * 0.5
        rows.append(MemberRow(m, yt_score, comm_score, composite,
                              yt_videos, yt_avg, yt_sufficient, comm_mentions))

    if sum(r.composite for r in rows) == 0:
        return MemberPop(rows=rows, hhi=None, evenness=None,
                         status='insufficient')

    shares = [r.composite / sum(r.composite for r in rows) * 100 for r in rows]
    hhi = sum(s*s for s in shares) / 10000
    return MemberPop(rows=rows, hhi=hhi, evenness=1.0 - hhi, status='ok')
```

활동량 0이거나 멤버 1명만 활성 → HHI=`null`로 명시. 화면은 "데이터 부족" 카드 표시.

### 7.4 News Filter

```python
class NewsFilter:
    def __init__(self, group_config):
        self.group = group_config
        self.allow_after = (parse(group_config.debut_date) - timedelta(days=365)).date() \
                           if group_config.debut_date else None

    def is_relevant(self, article) -> tuple[bool, str | None]:
        text = f"{article.title} {article.snippet}"
        if not any(kw in text for kw in self.group.context_keywords):
            return False, 'no_context_keyword'

        pub = parse_safe(article.published_at)
        if pub is None:
            return False, 'unparseable_date'
        if self.allow_after and pub.date() < self.allow_after:
            return False, 'before_debut_minus_year'

        for bl in self.group.blacklist_phrases:
            if bl in text:
                return False, f'blacklist:{bl}'
        return True, None
```

```python
DATE_PATTERNS = [
    r'(\d{4})-(\d{2})-(\d{2})[\sT](\d{2}):(\d{2})',
    r'(\d{4})\.(\d{1,2})\.(\d{1,2})\.?',
    r'(\d{4})/(\d{1,2})/(\d{1,2})',
    r'(\d{4})-(\d{2})-(\d{2})',
]
def parse_safe(s):
    if not s: return None
    s = s.strip()[:30]                        # 본문 혼합 방지
    for p in DATE_PATTERNS:
        m = re.search(p, s)
        if m:
            try:
                return datetime(*[int(g) for g in m.groups()[:6]])
            except ValueError:
                continue
    return None
```

`is_excluded` row는 **삭제하지 않고 보관** → 필터 룰 튜닝 후 재집계 가능.

### 7.5 Delta (window function)

```sql
SELECT
  group_key, snapshot_at,
  yt_total_views,
  yt_total_views - LAG(yt_total_views) OVER (
    PARTITION BY group_key ORDER BY snapshot_at) AS d_yt_views_1d,
  yt_total_views - LAG(yt_total_views, 7) OVER (
    PARTITION BY group_key ORDER BY snapshot_at) AS d_yt_views_7d
FROM agg_summary
WHERE snapshot_at = (SELECT MAX(snapshot_at) FROM agg_summary
                     WHERE group_key = agg_summary.group_key)
```

### 7.6 LLM Insight + source_refs

```python
def generate_weekly_insights():
    ctx = {
      'agg_summary_last_7d':  fetch_summary_window(7),
      'agg_summary_prev_7d':  fetch_summary_window(7, offset=7),
      'big_movers':           fetch_groups_with_delta_pct_above(20),
      'hanteo':               fetch_hanteo_latest(),
      'market_share':         fetch_market_share_latest(),
      'top_news_by_group':    fetch_top_news(7, k=5),
    }
    schema = INSIGHT_OUTPUT_SCHEMA   # JSON Schema
    resp = gemini.generate(model='gemini-2.5-flash',
                           system=PROMPT_WEEKLY,
                           contents=json.dumps(ctx),
                           response_schema=schema)
    insert_into_insights(resp.parsed)
```

- JSON Schema로 출력 형식 강제.
- 모든 주장에 `source_refs: [{table, pk, label}]` 의무.
- 프론트는 source_refs 클릭 시 해당 row를 inline 노출 (§8).

---

## 8. Frontend

### 8.1 Stack

- **Vite + Vanilla TS + Preact**
- **Chart.js v4**
- **TailwindCSS** + 다크/라이트 토글
- **Pages Functions** (TypeScript)

### 8.2 Directory

```
frontend/
├── functions/
│   ├── _middleware.ts
│   ├── __auth.ts
│   └── api/
│       ├── meta.ts
│       ├── groups.ts
│       ├── group/[key].ts
│       ├── market.ts
│       ├── market-share.ts
│       ├── weekly.ts
│       ├── insights.ts
│       ├── members/[key].ts
│       └── search.ts
├── src/
│   ├── main.ts
│   ├── router.ts
│   ├── api.ts
│   ├── views/
│   │   ├── MarketOverview.ts
│   │   ├── WeeklyUpdate.ts
│   │   ├── GroupContent.ts
│   │   ├── Members.ts
│   │   ├── Community.ts
│   │   ├── PRRisk.ts
│   │   └── Insights.ts
│   ├── components/
│   │   ├── FreshnessBadge.ts
│   │   ├── KPI.ts
│   │   ├── ExportMenu.ts
│   │   ├── ShareLink.ts
│   │   ├── HealthSpec.ts
│   │   └── SourceRef.ts
│   ├── styles/
│   └── theme.ts
├── public/
├── index.html
├── vite.config.ts
├── tailwind.config.ts
└── package.json
```

### 8.3 페이지/탭 구성 (현 7탭 유지 + 개선)

| 탭 | 변경점 |
|---|---|
| Market Overview | 신선도 배지, **PLAVE 제외 토글**, **로그 스케일 토글**, 산식 설명 링크 |
| Weekly Update | LLM 인사이트에 `SourceRef` 펼치기, 한터 데이터 수동 입력 표시 |
| Group Content | 탭 활성화 시 lazy fetch, 검색창 |
| Member View | 데뷔 전 그룹 → "데이터 부족" 카드, HHI 미표시 |
| Community | 기간 필터 일관, **CSV 내보내기**, 키워드→게시글 inline |
| PR & Risk | controversy 임계 도달 시 상단 배너 |
| Insights | source_refs 펼침 |

### 8.4 Freshness Badge

```ts
type Freshness = 'fresh' | 'stale' | 'broken';
function classify(last_success_at: string, expected_interval_h: number): Freshness {
  const age_h = (Date.now() - Date.parse(last_success_at)) / 3_600_000;
  if (age_h < expected_interval_h * 1.5) return 'fresh';
  if (age_h < expected_interval_h * 4)   return 'stale';
  return 'broken';
}
```

- 글로벌 배지 (헤더 우상단): "전체 데이터 최신: 2시간 전 ✓"
- 카드별 배지 (소스 단위)
- broken 상태면 카드 위에 노란 띠 + "마지막 성공 X일 전"

### 8.5 신규 인터랙션

- 전역 검색 (`Cmd/Ctrl+K`) → `/api/search?q=...`
- CSV 내보내기 (현재 표 → Blob URL)
- PNG 내보내기 (Chart.js `toBase64Image`)
- 공유 링크 (URL state: `#tab=...&group=...&period=...&theme=...`)
- 다크/라이트 토글
- 산식 설명 모달 (Health Score / Market Share / HHI)

### 8.6 API 응답 (예)

```json
// GET /api/meta
{
  "global_last_success_at": "2026-05-04T08:15:00Z",
  "by_job": [
    {"job":"dc:plave",
     "last_success_at":"2026-05-04T06:18:00Z",
     "expected_interval_h": 6, "status":"ok"},
    {"job":"twitter:bdawn",
     "last_success_at":"2026-05-01T03:00:00Z",
     "expected_interval_h": 24, "status":"failed",
     "error_msg":"X API 401"}
  ]
}
```

```json
// GET /api/group/plave?period=30
{
  "collected_at": "...",
  "summary": {...},
  "deltas": {
    "yt_total_views_1d": 145823,
    "yt_total_views_7d": 918222,
    "dc_total_posts_1d": 312
  },
  "freshness_by_source": [...],
  "health_score": {...},
  "yt_top15": [...],
  "yt_categories_full": {...},
  "dc_top_posts": [...]
}
```

페이로드는 요청 시점 기준 필요한 만큼만. 17MB 통째 JSON 폐기.

---

## 9. Authentication & Infra

### 9.1 단일 비밀번호 (HMAC 서명 쿠키)

```ts
// frontend/functions/__auth.ts
export const onRequestPost: PagesFunction = async ({request, env}) => {
  const fd = await request.formData();
  const pw = fd.get('password');
  if (!await pwMatch(pw, env.SITE_PASSWORD_HASH)) {
    return Response.redirect('/?err=1', 302);
  }
  const sig = await hmacSign(env.COOKIE_SECRET, `auth|${dayBucket()}`);
  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/',
      'Set-Cookie': `idol_radar_auth=${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`
    }
  });
};
```

```ts
// frontend/functions/_middleware.ts
export const onRequest: PagesFunction = async ({request, next, env}) => {
  if (new URL(request.url).pathname.startsWith('/__auth')) return next();
  const cookie = getCookie(request, 'idol_radar_auth');
  if (!cookie || !await hmacVerify(env.COOKIE_SECRET, cookie, `auth|${dayBucket()}`)) {
    return new Response('unauth', {status: 401});
  }
  return next();
};
```

`SITE_PASSWORD_HASH` (scrypt), `COOKIE_SECRET` (32B random) — Pages env에 저장.
비밀번호 회전 시 `COOKIE_SECRET` 같이 갱신하면 모든 세션 자동 무효화.

### 9.2 인프라 셋업 단계

1. Cloudflare 계정 (무료)
2. `wrangler d1 create idol-sight`
3. `wrangler d1 migrations apply idol-sight --remote`
4. Pages 프로젝트 생성, GitHub 연동
5. GitHub Secrets: `CF_ACCOUNT_ID`, `CF_D1_DB_ID`, `CF_API_TOKEN`,
   `YT_API_KEY`, `GEMINI_API_KEY`, `DISCORD_WEBHOOK`,
   `SITE_PASSWORD_HASH`, `COOKIE_SECRET`
6. Pages 환경변수: `SITE_PASSWORD_HASH`, `COOKIE_SECRET`, D1 binding
7. Actions enable

---

## 10. CI/CD & Migrations

- **PR**: `test.yml` — pytest + ruff + pyright + tsc. 실패 시 머지 차단.
- **main push**: Pages 자동 빌드+배포 (frontend), 워커는 다음 cron에 새 코드 사용.
- **마이그레이션**: `migrate.yml` (workflow_dispatch) — `wrangler d1 migrations apply`.
- **롤백 정책**: forward-only. 큰 변경은 (1) 추가 → (2) 컷오버 → (3) 제거 3단계 PR.

---

## 11. Testing & Observability

### 11.1 단위 테스트

- `analysis/`의 모든 함수 (산식 회귀 fixture).
- Date parser 회귀 — 현행에서 깨졌던 모든 케이스 fixture.
- News filter — 동명이인·블랙리스트 fixture.

### 11.2 콜렉터 테스트

- 실제 페이지 캡처 → `tests/fixtures/`.
- collector가 fixture를 받아 `CollectionResult` 반환 검증.
- **Live smoke** (`test-live.yml`, 주 1회): 실제 사이트 호출 → 셀렉터 깨졌는지 검증.

### 11.3 데이터 품질 검사

`analyze-weekly.yml` 끝에 sanity check:
- 그룹별 데이터 0건이 아닌지
- 뉴스 `published_at` NULL 비율 < 5%
- `is_excluded` 비율이 갑자기 50% 초과 → 필터 오작동 가능성

임계 도달 시 Discord `dq-alert`.

### 11.4 관측

- **Discord webhook** — 잡 실패, 데이터 품질 임계, smoke 실패.
- **BetterStack Free** — 워커 stdout JSON 로그 (1GB/월·3일 보관).
- **GitHub Actions UI** — 90일 보관 (무료).
- **Cloudflare Analytics** — Pages·D1 사용량 무료 대시보드.

### 11.5 헬스 체크

`health-check.yml` (매시간):
- `/api/meta` 호출 → `expected_interval_h*4` 초과한 잡 발견 시 Discord 알림.

---

## 12. Open Items / Phase 2

- 트위터/X 안정 수집: nitter 인스턴스가 다 막히면 X API Basic($100/월) 검토. 현재는 비용 0 우선 → fallback 수동 입력.
- 한터차트 자동 수집: 약관 회색지대. 현재는 사람이 주 1회 입력 (`hanteo_weekly`에 직접 INSERT 또는 운영자 콘솔). Phase 2에서 공식 파트너십 검토.
- 사용자별 계정·역할: 사용자 베이스가 50명 초과하면 도입.
- 본문 보관·검색: 거버넌스 정책 결정 후 별도 과제.
- 대시보드 모바일 네이티브: 필요성 확인 후 결정.

---

## 13. Appendix

### 13.1 Required GitHub Secrets

| Key | 용도 |
|---|---|
| `CF_ACCOUNT_ID` | Cloudflare account |
| `CF_D1_DB_ID` | D1 database id |
| `CF_API_TOKEN` | D1 write 권한 토큰 |
| `YT_API_KEY` | YouTube Data API v3 |
| `GEMINI_API_KEY` | Google Gemini API |
| `DISCORD_WEBHOOK` | 알림 채널 |
| `SITE_PASSWORD_HASH` | 사이트 비밀번호 scrypt 해시 |
| `COOKIE_SECRET` | 쿠키 서명용 32B random |

### 13.2 Required Pages Environment Variables

| Key | 용도 |
|---|---|
| `SITE_PASSWORD_HASH` | 비밀번호 검증 |
| `COOKIE_SECRET` | 쿠키 서명 검증 |
| `DB` (D1 binding) | D1 연결 |

### 13.3 Command Cheatsheet

```bash
# 워커 로컬 실행
cd worker
uv sync
uv run python -m idol_sight collect --source dc --group plave

# D1 마이그레이션
cd frontend
wrangler d1 migrations apply idol-sight --remote

# 프론트 로컬 미리보기
cd frontend
pnpm dev

# 프론트 배포 (자동, main push 시)
git push origin main
```

### 13.4 Initial `groups` 데이터 (예)

```sql
INSERT INTO groups VALUES
('plave',    'PLAVE',    '플레이브',     '2023-03-12', 'UC...', 'plave',    '플레이브',
   '["플레이브","PLAVE","노아","예준","하민","밤비","은호","버추얼"]',
   '[]', '["@plave_official"]', 1),
('miiwan',   'MiiWAN',   '미완소년',     '2026-06-01', 'UC...', 'miiwan',   '미완소년',
   '["미완소년","MiiWAN","나이선","임온","마하진","안석우","원주율","IPX","어비스컴퍼니","버추얼"]',
   '[]', '["@miiwan_official"]', 1),
-- ... 나머지 6 그룹
;
```

(완전한 시드는 `migrations/0002_seed.sql`로 별도 PR.)
