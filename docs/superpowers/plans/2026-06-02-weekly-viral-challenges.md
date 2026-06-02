# 주간 바이럴 챌린지 리스트업 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 주 1회 Gemini Google Search grounding 으로 이번 주 바이럴 K-POP/Shorts 챌린지를 발굴하고 YouTube API 로 수치화해 D1 에 저장, `#tab=shorts` 페이지에 "이번 주 바이럴 챌린지" 섹션으로 노출.

**Architecture:** worker 의 신규 `challenge-scan` 잡이 ① grounded Gemini 로 발굴 → ② 비-grounded Gemini 로 JSON 구조화(+MiiWAN 적합도) → ③ YouTube search 로 측정 → ④ 랭크/태그 → ⑤ D1 `weekly_challenges` 에 주차 멱등 UPSERT. 프런트는 최신 주차를 읽어 섹션 렌더. 발굴(LLM)·측정(YouTube) 라벨 분리, 출처 URL·confidence 로 환각 가드.

**Tech Stack:** Python 3.12 / uv / typer / google-genai(>=0.8, `from google import genai`) / httpx / pytest + pytest-httpx; Cloudflare D1; Preact + Vite + vitest.

**근거 설계:** `docs/superpowers/specs/2026-06-02-weekly-viral-challenges-design.md`

**작업 디렉토리:** worker 작업은 `cd worker`, 테스트 `uv run pytest`. frontend 작업은 `cd frontend`, 테스트 `./node_modules/.bin/vitest run`(rtk 훅이 `npx vitest` 를 깨므로 직접 바이너리), 타입체크 `npx tsc -b --noEmit`.

---

## 파일 구조

| 파일 | 책임 | 신규/수정 |
|---|---|---|
| `migrations/0076_weekly_challenges.sql` | `weekly_challenges` 테이블 | 신규 |
| `worker/src/idol_sight/llm/prompts.py` | 발굴 프롬프트 + 구조화 시스템 프롬프트 + 스키마 | 수정 |
| `worker/src/idol_sight/llm/gemini.py` | `generate_grounded` (google_search tool) 메서드 | 수정 |
| `worker/src/idol_sight/collectors/youtube.py` | `search_shorts` / `fetch_stats` 키워드 검색 헬퍼 | 수정 |
| `worker/src/idol_sight/analysis/challenge_scan.py` | Challenge 모델 + 순수 헬퍼(파싱·랭크·UPSERT·시각) + 오케스트레이터 | 신규 |
| `worker/src/idol_sight/cli.py` | `challenge-scan` 커맨드 | 수정 |
| `.github/workflows/challenge-scan.yml` | 주간 cron | 신규 |
| `frontend/functions/api/shorts-trend.ts` | 응답에 `challenges` 추가 (table 부재 시 graceful) | 수정 |
| `frontend/src/components/WeeklyChallenges.tsx` | 챌린지 섹션 컴포넌트 | 신규 |
| `frontend/src/views/ShortsTrend.tsx` | 섹션 삽입 | 수정 |

worker 테스트는 `worker/tests/unit/test_*.py`. Preact 컴포넌트는 관례상 typecheck+build 로만 검증.

---

## Task 1: migration `weekly_challenges`

**Files:**
- Create: `migrations/0076_weekly_challenges.sql`

- [ ] **Step 1: 작성**

`migrations/0076_weekly_challenges.sql`:

```sql
-- migrations/0076_weekly_challenges.sql
-- 주간 바이럴 챌린지 리스트업 (설계: docs/superpowers/specs/2026-06-02-weekly-viral-challenges-design.md)
-- challenge-scan 잡이 week_start(KST 월요일) 단위로 멱등 교체(DELETE→INSERT).
CREATE TABLE weekly_challenges (
  week_start         TEXT NOT NULL,
  rank               INTEGER NOT NULL,
  name               TEXT NOT NULL,
  tag                TEXT NOT NULL,          -- 'kpop' | 'general'
  description        TEXT,
  origin             TEXT,
  hashtags           TEXT,                   -- JSON 배열
  example_video_ids  TEXT,                   -- JSON 배열 (YouTube video_id)
  yt_recent_shorts   INTEGER,                -- 최근 7일 매칭 샘플 수 (≤50, NULL=미측정)
  yt_total_views     INTEGER,               -- 샘플 합산 조회수 (NULL=미측정)
  miiwan_fit         TEXT,
  source_urls        TEXT,                   -- JSON 배열 (발굴 근거)
  confidence         TEXT,                   -- 'high' | 'medium' | 'low'
  generated_at       TEXT NOT NULL,
  PRIMARY KEY (week_start, rank)
);
CREATE INDEX idx_weekly_challenges_week ON weekly_challenges(week_start);
```

- [ ] **Step 2: SQL 문법 검증 (로컬, wrangler 불필요)**

Run: `sqlite3 ':memory:' ".read migrations/0076_weekly_challenges.sql" ".schema weekly_challenges"`
Expected: 에러 없이 `CREATE TABLE weekly_challenges ...` 스키마 출력.

- [ ] **Step 3: 커밋**

```bash
git add migrations/0076_weekly_challenges.sql
git commit -m "feat(weekly-challenges): weekly_challenges D1 테이블 migration"
```

> ⚠️ 원격 적용(`wrangler d1 migrations apply idol-sight --remote`)은 **운영자가 직접 실행**한다 (메모리 `feedback_d1_remote_apply_human_only`). 구현은 로컬 검증까지만.

---

## Task 2: 발굴/구조화 프롬프트 + 스키마

**Files:**
- Modify: `worker/src/idol_sight/llm/prompts.py` (파일 끝에 추가)
- Test: `worker/tests/unit/test_prompts_challenges.py`

- [ ] **Step 1: 실패 테스트 작성**

`worker/tests/unit/test_prompts_challenges.py`:

```python
from idol_sight.llm.prompts import (
    CHALLENGE_DISCOVERY_PROMPT,
    CHALLENGE_STRUCTURE_SYSTEM,
    CHALLENGE_SCHEMA,
)


def test_discovery_prompt_has_core_constraints():
    p = CHALLENGE_DISCOVERY_PROMPT
    assert "7일" in p            # 최근 7일 윈도우
    assert "출처" in p           # 출처 URL 필수 (환각 가드)
    assert "K-POP" in p          # K-POP 가중
    assert "챌린지" in p


def test_structure_system_mentions_miiwan_and_tag():
    s = CHALLENGE_STRUCTURE_SYSTEM
    assert "MiiWAN" in s         # 적합도 메모 관점
    assert "kpop" in s and "general" in s  # 태그 분류


def test_challenge_schema_shape():
    props = CHALLENGE_SCHEMA["properties"]["challenges"]["items"]["properties"]
    for key in ("name", "tag", "description", "hashtags",
                "source_urls", "confidence", "miiwan_fit"):
        assert key in props
    assert CHALLENGE_SCHEMA["properties"]["challenges"]["items"]["properties"]["tag"]["enum"] == ["kpop", "general"]
```

- [ ] **Step 2: 실패 확인**

Run: `cd worker && uv run pytest tests/unit/test_prompts_challenges.py -v`
Expected: FAIL (ImportError — 상수 없음).

- [ ] **Step 3: 구현 (prompts.py 끝에 추가)**

```python
# ── 주간 바이럴 챌린지 (설계 2026-06-02-weekly-viral-challenges) ──────────────
# grounded(google_search) 발굴용 프롬프트. 출처 URL 필수 + 최근 7일 + K-POP 가중.
CHALLENGE_DISCOVERY_PROMPT = (
    "당신은 K-POP/숏폼 트렌드 리서처다. Google 검색을 사용해 **최근 7일 이내** "
    "바이럴 중인 숏폼 '챌린지'를 조사해 정리하라.\n\n"
    "요구사항:\n"
    "- K-POP 아이돌 챌린지(타이틀곡 안무·아이돌 포맷)를 약 7개로 우선·다수 포함.\n"
    "- 그 외 일반 YouTube Shorts/숏폼 챌린지(밈·트렌드)를 약 3개 포함.\n"
    "- 각 챌린지마다: 이름, 한 줄 설명(무슨 동작/포맷), 원곡/아티스트/사운드 출처, "
    "대표 해시태그, 그리고 **반드시 검증 가능한 출처 URL**.\n"
    "- 최근 7일 내 실제 활동이 확인되는 것만. 확실치 않으면 제외.\n"
    "- 각 항목의 확신도(high/medium/low)를 함께 적어라.\n\n"
    "한국어로, 챌린지마다 항목을 구분해 서술하라. (이후 단계에서 JSON 으로 구조화됨)"
)

# grounded 텍스트 → JSON 구조화 + MiiWAN 적합도. 비-grounded generate() 로 호출.
CHALLENGE_STRUCTURE_SYSTEM = (
    "아래 리서치 텍스트를 JSON 으로 구조화하라. 텍스트에 없는 챌린지를 지어내지 말 것.\n"
    "- tag: K-POP 아이돌 챌린지는 'kpop', 그 외는 'general'.\n"
    "- source_urls: 텍스트에 등장한 출처 URL 만. 없으면 빈 배열.\n"
    "- confidence: 텍스트의 확신도(high/medium/low). 불명확하면 'low'.\n"
    "- miiwan_fit: 각 챌린지를 'MiiWAN'(2026-06 데뷔 직후의 버추얼 아이돌 그룹) 이 "
    "이번 주 따라 만들 때의 적합도·참여 난이도를 한 줄로. (예: '안무 단순, 즉시 가능' / "
    "'원곡 라이선스 필요, 난이도 높음')\n"
    "텍스트에 챌린지가 없으면 challenges: [] 를 반환하라."
)

CHALLENGE_SCHEMA = {
    "type": "object",
    "properties": {
        "challenges": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "tag": {"type": "string", "enum": ["kpop", "general"]},
                    "description": {"type": "string"},
                    "origin": {"type": "string"},
                    "hashtags": {"type": "array", "items": {"type": "string"}},
                    "source_urls": {"type": "array", "items": {"type": "string"}},
                    "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                    "miiwan_fit": {"type": "string"},
                },
                "required": ["name", "tag", "description", "hashtags",
                             "source_urls", "confidence", "miiwan_fit"],
            },
        }
    },
    "required": ["challenges"],
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd worker && uv run pytest tests/unit/test_prompts_challenges.py -v`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add worker/src/idol_sight/llm/prompts.py worker/tests/unit/test_prompts_challenges.py
git commit -m "feat(weekly-challenges): 발굴/구조화 프롬프트 + JSON 스키마"
```

---

## Task 3: Gemini grounded 생성 메서드

**Files:**
- Modify: `worker/src/idol_sight/llm/gemini.py`
- Test: `worker/tests/unit/test_gemini_grounded.py`

먼저 `gemini.py` 의 기존 `generate()` 메서드를 읽어 **모델 체인 fallback 루프와 내부 속성명(self._client / self._models 등)** 을 그대로 파악한 뒤, 같은 패턴으로 `generate_grounded` 를 작성하라. 아래 grounding config 와 source 추출 코드는 정확히 사용하되, 모델 순회/예외 fallback 구조는 `generate()` 와 동일하게 맞춘다.

- [ ] **Step 1: 실패 테스트 작성**

`worker/tests/unit/test_gemini_grounded.py`:

```python
from unittest.mock import MagicMock
from idol_sight.llm.gemini import GeminiClient


def _fake_client(text: str, uris: list[str]):
    resp = MagicMock()
    resp.text = text
    chunk = MagicMock()
    chunk.web.uri = uris[0] if uris else None
    cand = MagicMock()
    cand.grounding_metadata.grounding_chunks = [chunk] if uris else []
    resp.candidates = [cand]
    fake = MagicMock()
    fake.models.generate_content = MagicMock(return_value=resp)
    return fake


def test_generate_grounded_returns_text_and_sources():
    fake = _fake_client("리서치 결과 텍스트", ["https://example.com/a"])
    c = GeminiClient(api_key="x", client=fake)
    out = c.generate_grounded(prompt="조사해줘")
    assert out.text == "리서치 결과 텍스트"
    assert out.sources == ["https://example.com/a"]
    # google_search tool 이 config 에 실렸는지 (호출 인자 확인)
    _, kwargs = fake.models.generate_content.call_args
    assert kwargs["model"]  # 모델 지정됨
    assert kwargs["config"] is not None


def test_generate_grounded_handles_no_sources():
    fake = _fake_client("텍스트만", [])
    c = GeminiClient(api_key="x", client=fake)
    out = c.generate_grounded(prompt="조사")
    assert out.text == "텍스트만"
    assert out.sources == []
```

- [ ] **Step 2: 실패 확인**

Run: `cd worker && uv run pytest tests/unit/test_gemini_grounded.py -v`
Expected: FAIL (`generate_grounded` 없음).

- [ ] **Step 3: 구현**

`gemini.py` 상단 import 영역 근처에 dataclass 추가:

```python
from dataclasses import dataclass, field


@dataclass
class GroundedResult:
    text: str
    sources: list[str] = field(default_factory=list)
```

`GeminiClient` 에 메서드 추가 (모델 순회/fallback 은 기존 `generate()` 와 동일 구조로 맞추되, config 와 source 추출은 아래대로):

```python
    def generate_grounded(self, *, prompt: str) -> GroundedResult:
        """Google Search grounding 으로 prompt 를 조사해 텍스트+출처를 반환."""
        from google.genai.types import (
            GenerateContentConfig, Tool, GoogleSearch,
        )
        config = GenerateContentConfig(
            tools=[Tool(google_search=GoogleSearch())],
            temperature=0.3,
        )
        last_err: Exception | None = None
        for model in self._models:  # 기존 generate() 와 동일한 체인/속성명 사용
            try:
                resp = self._client.models.generate_content(
                    model=model, contents=prompt, config=config,
                )
                return GroundedResult(
                    text=resp.text or "",
                    sources=_extract_grounding_sources(resp),
                )
            except Exception as e:  # noqa: BLE001 — 모델 fallback
                last_err = e
                continue
        raise RuntimeError(f"grounded generation failed: {last_err}")
```

모듈 레벨 헬퍼 추가 (방어적 source 추출):

```python
def _extract_grounding_sources(resp: object) -> list[str]:
    out: list[str] = []
    cands = getattr(resp, "candidates", None) or []
    for cand in cands:
        gm = getattr(cand, "grounding_metadata", None)
        chunks = getattr(gm, "grounding_chunks", None) or []
        for ch in chunks:
            web = getattr(ch, "web", None)
            uri = getattr(web, "uri", None)
            if uri:
                out.append(uri)
    return out
```

> 주의: 위 코드는 `self._models`, `self._client` 라는 속성명을 가정한다. 기존 `generate()` 가 다른 이름(예: `self._model_chain`)을 쓰면 거기에 맞춰 수정하라.

- [ ] **Step 4: 통과 확인**

Run: `cd worker && uv run pytest tests/unit/test_gemini_grounded.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: 회귀 확인 + 커밋**

Run: `cd worker && uv run pytest -q`
Expected: 전체 PASS (기존 gemini 테스트 포함).

```bash
git add worker/src/idol_sight/llm/gemini.py worker/tests/unit/test_gemini_grounded.py
git commit -m "feat(weekly-challenges): GeminiClient.generate_grounded (google_search tool)"
```

---

## Task 4: YouTube 키워드 검색 헬퍼

**Files:**
- Modify: `worker/src/idol_sight/collectors/youtube.py`
- Test: `worker/tests/unit/test_youtube_search.py`

`YouTubeCollector` 에 채널 비의존 검색 메서드 2개를 추가한다. 기존 `self._key`, `self._http_factory`, 모듈 상수 `API`(YouTube API base URL) 를 재사용한다.

- [ ] **Step 1: 실패 테스트 작성**

`worker/tests/unit/test_youtube_search.py`:

```python
import httpx
from idol_sight.collectors.youtube import YouTubeCollector


class _StubHTTP:
    """httpx.Client 대체 — URL 경로별 고정 응답."""
    def __init__(self, routes):
        self._routes = routes  # {path_substr: json}
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def get(self, url, params=None):
        for needle, payload in self._routes.items():
            if needle in url:
                return httpx.Response(200, json=payload, request=httpx.Request("GET", url))
        return httpx.Response(200, json={"items": []}, request=httpx.Request("GET", url))


def _collector(routes):
    return YouTubeCollector(api_key="k", http_factory=lambda: _StubHTTP(routes))


def test_search_shorts_returns_video_ids():
    routes = {"/search": {"items": [
        {"id": {"videoId": "a1"}},
        {"id": {"videoId": "b2"}},
    ]}}
    yt = _collector(routes)
    ids = yt.search_shorts(query="#챌린지", published_after="2026-05-26T00:00:00Z")
    assert ids == ["a1", "b2"]


def test_fetch_stats_parses_views():
    routes = {"/videos": {"items": [
        {"id": "a1", "statistics": {"viewCount": "1000", "likeCount": "10",
                                    "commentCount": "2"},
         "snippet": {"title": "t"}},
    ]}}
    yt = _collector(routes)
    stats = yt.fetch_stats(["a1"])
    assert stats == [{"video_id": "a1", "views": 1000, "likes": 10, "comments": 2, "title": "t"}]


def test_fetch_stats_empty_ids_no_call():
    yt = _collector({})
    assert yt.fetch_stats([]) == []
```

- [ ] **Step 2: 실패 확인**

Run: `cd worker && uv run pytest tests/unit/test_youtube_search.py -v`
Expected: FAIL (`search_shorts`/`fetch_stats` 없음).

- [ ] **Step 3: 구현 (`YouTubeCollector` 클래스에 메서드 추가)**

```python
    def search_shorts(
        self, *, query: str, published_after: str, max_results: int = 50,
    ) -> list[str]:
        """임의 키워드로 최근 숏폼을 조회수순 검색해 video_id 목록 반환."""
        with self._http_factory() as client:
            r = client.get(
                f"{API}/search",
                params={
                    "key": self._key,
                    "q": query,
                    "type": "video",
                    "videoDuration": "short",     # < 4분 (숏폼 근사)
                    "order": "viewCount",
                    "publishedAfter": published_after,
                    "maxResults": max_results,
                    "part": "id",
                },
            )
            r.raise_for_status()
            items = r.json().get("items", [])
        ids: list[str] = []
        for it in items:
            vid = (it.get("id") or {}).get("videoId")
            if vid:
                ids.append(vid)
        return ids

    def fetch_stats(self, video_ids: list[str]) -> list[dict]:
        """video_id 목록의 통계(조회/좋아요/댓글)+제목 반환. 빈 입력은 호출 없이 []."""
        if not video_ids:
            return []
        with self._http_factory() as client:
            r = client.get(
                f"{API}/videos",
                params={
                    "key": self._key,
                    "id": ",".join(video_ids),
                    "part": "statistics,snippet",
                },
            )
            r.raise_for_status()
            items = r.json().get("items", [])
        out: list[dict] = []
        for it in items:
            stats = it.get("statistics") or {}
            snip = it.get("snippet") or {}
            out.append({
                "video_id": it.get("id"),
                "views": int(stats.get("viewCount") or 0),
                "likes": int(stats.get("likeCount") or 0),
                "comments": int(stats.get("commentCount") or 0),
                "title": snip.get("title"),
            })
        return out
```

> `videoDuration=short` 는 YouTube 기준 <4분 (숏폼 전용 필터는 API 에 없음 — 근사). `API` 상수가 모듈에 없으면 기존 호출부(`f"{API}/search"`)에서 쓰는 base URL 상수명을 그대로 사용하라.

- [ ] **Step 4: 통과 확인**

Run: `cd worker && uv run pytest tests/unit/test_youtube_search.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: 커밋**

```bash
git add worker/src/idol_sight/collectors/youtube.py worker/tests/unit/test_youtube_search.py
git commit -m "feat(weekly-challenges): YouTube 키워드 search_shorts/fetch_stats 헬퍼"
```

---

## Task 5: challenge_scan 순수 헬퍼 (모델·파싱·랭크·시각·UPSERT)

**Files:**
- Create: `worker/src/idol_sight/analysis/challenge_scan.py`
- Test: `worker/tests/unit/test_challenge_scan_helpers.py`

- [ ] **Step 1: 실패 테스트 작성**

`worker/tests/unit/test_challenge_scan_helpers.py`:

```python
import json
from idol_sight.analysis.challenge_scan import (
    Challenge, parse_structured_challenges, week_start_kst, iso_days_ago,
    select_and_rank, build_upsert_statements,
)


def test_parse_structured_challenges():
    payload = {"challenges": [
        {"name": "A", "tag": "kpop", "description": "d", "origin": "o",
         "hashtags": ["#a"], "source_urls": ["http://x"], "confidence": "high",
         "miiwan_fit": "쉬움"},
        {"name": "B", "tag": "general", "description": "", "hashtags": [],
         "source_urls": [], "confidence": "low", "miiwan_fit": ""},
    ]}
    chs = parse_structured_challenges(payload)
    assert len(chs) == 2
    assert chs[0].name == "A" and chs[0].tag == "kpop"
    assert chs[1].origin == ""        # 누락 필드는 안전 기본값
    assert parse_structured_challenges({}) == []
    assert parse_structured_challenges({"challenges": "nope"}) == []


def test_week_start_kst_monday():
    # 2026-06-02 는 화요일. KST 기준 그 주 월요일 = 2026-06-01.
    epoch = 1_780_000_000  # 임의 → 아래 assert 는 고정 입력으로 검증
    # 명시적 입력: 2026-06-02T05:00:00Z = KST 14:00 화요일 → 월요일 2026-06-01
    import datetime as dt
    e = dt.datetime(2026, 6, 2, 5, 0, tzinfo=dt.timezone.utc).timestamp()
    assert week_start_kst(e) == "2026-06-01"
    # 일요일 22:00 UTC = 월요일 07:00 KST → 그 주 월요일
    e2 = dt.datetime(2026, 6, 7, 22, 0, tzinfo=dt.timezone.utc).timestamp()
    assert week_start_kst(e2) == "2026-06-08"


def test_iso_days_ago():
    import datetime as dt
    e = dt.datetime(2026, 6, 8, 0, 0, tzinfo=dt.timezone.utc).timestamp()
    assert iso_days_ago(e, 7) == "2026-06-01T00:00:00Z"


def _ch(name, tag, views, shorts):
    c = Challenge(name=name, tag=tag, description="", origin="", hashtags=[],
                  source_urls=[], confidence="medium", miiwan_fit="")
    c.yt_total_views = views
    c.yt_recent_shorts = shorts
    return c


def test_select_and_rank_caps_per_tag_and_weights_kpop():
    chs = [
        _ch("k1", "kpop", 100, 10),
        _ch("k2", "kpop", 50, 5),
        _ch("g1", "general", 100, 10),
        _ch("g2", "general", 90, 9),
    ]
    sel = select_and_rank(chs, target_kpop=1, target_general=1)
    names = [c.name for c in sel]
    assert names == ["k1", "g1"]        # 각 태그 top1
    assert sel[0].rank == 1 and sel[1].rank == 2
    # kpop 가중: 동률 측정이면 kpop 이 위로
    tie = select_and_rank([_ch("k", "kpop", 100, 10), _ch("g", "general", 100, 10)],
                          target_kpop=1, target_general=1)
    assert tie[0].name == "k"


def test_select_and_rank_unmeasured_sinks():
    measured = _ch("m", "general", 100, 10)
    un = _ch("u", "general", None, None)
    sel = select_and_rank([un, measured], target_kpop=5, target_general=5)
    assert sel[0].name == "m"           # 측정된 것이 위로


def test_build_upsert_statements_leads_with_delete():
    c = _ch("A", "kpop", 100, 10)
    c.rank = 1
    c.example_video_ids = ["v1"]
    stmts = build_upsert_statements("2026-06-01", [c], "2026-06-01T00:00:00Z")
    assert stmts[0][0].strip().upper().startswith("DELETE")
    assert stmts[0][1] == ["2026-06-01"]
    assert "INSERT INTO weekly_challenges" in stmts[1][0]
    # hashtags/example/source 는 JSON 문자열
    params = stmts[1][1]
    assert json.loads(params[7]) == ["v1"]   # example_video_ids 위치
```

- [ ] **Step 2: 실패 확인**

Run: `cd worker && uv run pytest tests/unit/test_challenge_scan_helpers.py -v`
Expected: FAIL (모듈 없음).

- [ ] **Step 3: 구현 (`analysis/challenge_scan.py` — 이 Task 는 순수 헬퍼만)**

```python
"""주간 바이럴 챌린지 발굴+측정 오케스트레이션.
설계: docs/superpowers/specs/2026-06-02-weekly-viral-challenges-design.md
순수 헬퍼(파싱·랭크·시각·UPSERT)와 오케스트레이터(run_challenge_scan, Task 6)로 구성.
"""
from __future__ import annotations

import datetime as _dt
import json
import logging
from dataclasses import dataclass, field

log = logging.getLogger(__name__)

KPOP_WEIGHT = 1.3   # kpop 태그 랭크 가중


@dataclass
class Challenge:
    name: str
    tag: str
    description: str
    origin: str
    hashtags: list[str]
    source_urls: list[str]
    confidence: str
    miiwan_fit: str
    yt_recent_shorts: int | None = None
    yt_total_views: int | None = None
    example_video_ids: list[str] = field(default_factory=list)
    score: float = 0.0
    rank: int | None = None


def parse_structured_challenges(payload: object) -> list[Challenge]:
    if not isinstance(payload, dict):
        return []
    items = payload.get("challenges")
    if not isinstance(items, list):
        return []
    out: list[Challenge] = []
    for it in items:
        if not isinstance(it, dict) or not it.get("name"):
            continue
        tag = it.get("tag")
        out.append(Challenge(
            name=str(it["name"]),
            tag="kpop" if tag == "kpop" else "general",
            description=str(it.get("description") or ""),
            origin=str(it.get("origin") or ""),
            hashtags=[str(h) for h in (it.get("hashtags") or []) if h],
            source_urls=[str(u) for u in (it.get("source_urls") or []) if u],
            confidence=str(it.get("confidence") or "low"),
            miiwan_fit=str(it.get("miiwan_fit") or ""),
        ))
    return out


def week_start_kst(now_epoch: float) -> str:
    """now(epoch sec) 가 속한 주의 KST 월요일 (YYYY-MM-DD)."""
    kst = _dt.datetime.fromtimestamp(now_epoch, tz=_dt.timezone.utc) + _dt.timedelta(hours=9)
    monday = kst.date() - _dt.timedelta(days=kst.weekday())
    return monday.isoformat()


def iso_days_ago(now_epoch: float, days: int) -> str:
    """RFC3339(UTC, Z) — YouTube publishedAfter 용."""
    t = _dt.datetime.fromtimestamp(now_epoch, tz=_dt.timezone.utc) - _dt.timedelta(days=days)
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def select_and_rank(
    challenges: list[Challenge], *, target_kpop: int, target_general: int,
) -> list[Challenge]:
    views = [c.yt_total_views or 0 for c in challenges]
    shorts = [c.yt_recent_shorts or 0 for c in challenges]
    mv = max(views) or 1
    ms = max(shorts) or 1
    for c in challenges:
        base = (c.yt_total_views or 0) / mv * 0.7 + (c.yt_recent_shorts or 0) / ms * 0.3
        c.score = base * (KPOP_WEIGHT if c.tag == "kpop" else 1.0)
    kpop = sorted([c for c in challenges if c.tag == "kpop"],
                  key=lambda c: c.score, reverse=True)[:target_kpop]
    general = sorted([c for c in challenges if c.tag == "general"],
                     key=lambda c: c.score, reverse=True)[:target_general]
    selected = sorted(kpop + general, key=lambda c: c.score, reverse=True)
    for i, c in enumerate(selected, 1):
        c.rank = i
    return selected


_INSERT_SQL = (
    "INSERT INTO weekly_challenges"
    " (week_start, rank, name, tag, description, origin, hashtags,"
    "  example_video_ids, yt_recent_shorts, yt_total_views, miiwan_fit,"
    "  source_urls, confidence, generated_at)"
    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
)


def build_upsert_statements(
    week_start: str, challenges: list[Challenge], generated_at: str,
) -> list[tuple[str, list]]:
    stmts: list[tuple[str, list]] = [
        ("DELETE FROM weekly_challenges WHERE week_start = ?", [week_start]),
    ]
    for c in challenges:
        stmts.append((_INSERT_SQL, [
            week_start, c.rank, c.name, c.tag, c.description, c.origin,
            json.dumps(c.hashtags, ensure_ascii=False),
            json.dumps(c.example_video_ids, ensure_ascii=False),
            c.yt_recent_shorts, c.yt_total_views, c.miiwan_fit,
            json.dumps(c.source_urls, ensure_ascii=False),
            c.confidence, generated_at,
        ]))
    return stmts
```

- [ ] **Step 4: 통과 확인**

Run: `cd worker && uv run pytest tests/unit/test_challenge_scan_helpers.py -v`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add worker/src/idol_sight/analysis/challenge_scan.py worker/tests/unit/test_challenge_scan_helpers.py
git commit -m "feat(weekly-challenges): challenge_scan 순수 헬퍼 (파싱·랭크·시각·UPSERT)"
```

---

## Task 6: challenge_scan 측정 + 오케스트레이터

**Files:**
- Modify: `worker/src/idol_sight/analysis/challenge_scan.py`
- Test: `worker/tests/unit/test_challenge_scan_run.py`

- [ ] **Step 1: 실패 테스트 작성**

`worker/tests/unit/test_challenge_scan_run.py`:

```python
from unittest.mock import MagicMock
import datetime as dt
from idol_sight.analysis.challenge_scan import run_challenge_scan
from idol_sight.llm.gemini import GroundedResult


def _now():
    return dt.datetime(2026, 6, 2, 5, 0, tzinfo=dt.timezone.utc).timestamp()


def _gemini(challenges):
    g = MagicMock()
    g.generate_grounded.return_value = GroundedResult(text="리서치", sources=["http://s"])
    g.generate.return_value = {"challenges": challenges}
    return g


def _yt(ids, stats):
    y = MagicMock()
    y.search_shorts.return_value = ids
    y.fetch_stats.return_value = stats
    return y


def test_run_writes_ranked_challenges():
    gemini = _gemini([
        {"name": "K", "tag": "kpop", "description": "d", "origin": "o",
         "hashtags": ["#k"], "source_urls": ["http://s"], "confidence": "high",
         "miiwan_fit": "쉬움"},
    ])
    yt = _yt(["v1", "v2"], [{"video_id": "v1", "views": 500, "likes": 1,
                             "comments": 0, "title": "t"}])
    d1 = MagicMock()
    n = run_challenge_scan(gemini, yt, d1, now_epoch=_now(),
                           target_kpop=7, target_general=3)
    assert n == 1
    # grounded → structure 2-step
    gemini.generate_grounded.assert_called_once()
    gemini.generate.assert_called_once()
    # 측정 호출됨
    yt.search_shorts.assert_called_once()
    # D1 batch 에 DELETE + INSERT
    stmts = d1.batch.call_args[0][0]
    assert stmts[0][0].strip().upper().startswith("DELETE")
    assert any("INSERT INTO weekly_challenges" in s for s, _ in stmts)


def test_run_skips_when_no_challenges():
    gemini = _gemini([])
    yt = _yt([], [])
    d1 = MagicMock()
    n = run_challenge_scan(gemini, yt, d1, now_epoch=_now(),
                           target_kpop=7, target_general=3)
    assert n == 0
    d1.batch.assert_not_called()        # 빈 주차는 기존 데이터 보존


def test_run_tolerates_measure_failure():
    gemini = _gemini([
        {"name": "K", "tag": "kpop", "description": "", "hashtags": ["#k"],
         "source_urls": [], "confidence": "low", "miiwan_fit": ""},
    ])
    yt = MagicMock()
    yt.search_shorts.side_effect = RuntimeError("quota")
    d1 = MagicMock()
    n = run_challenge_scan(gemini, yt, d1, now_epoch=_now(),
                           target_kpop=7, target_general=3)
    assert n == 1                       # 측정 실패해도 리스트 유지
    stmts = d1.batch.call_args[0][0]
    assert any("INSERT INTO weekly_challenges" in s for s, _ in stmts)
```

- [ ] **Step 2: 실패 확인**

Run: `cd worker && uv run pytest tests/unit/test_challenge_scan_run.py -v`
Expected: FAIL (`run_challenge_scan` 없음).

- [ ] **Step 3: 구현 (`challenge_scan.py` 에 측정 + 오케스트레이터 추가)**

파일 상단 import 에 프롬프트 추가:

```python
from idol_sight.llm.prompts import (
    CHALLENGE_DISCOVERY_PROMPT, CHALLENGE_STRUCTURE_SYSTEM, CHALLENGE_SCHEMA,
)
```

파일 끝에 추가:

```python
def measure_challenge(yt, ch: Challenge, published_after: str) -> None:
    """YouTube 키워드 검색으로 ch 의 측정 필드를 in-place 채움. 실패는 무시(미측정)."""
    query = ch.hashtags[0] if ch.hashtags else ch.name
    try:
        ids = yt.search_shorts(query=query, published_after=published_after)
        if not ids:
            return
        stats = yt.fetch_stats(ids[:10])
        ch.yt_recent_shorts = len(ids)
        ch.yt_total_views = sum((s.get("views") or 0) for s in stats)
        ch.example_video_ids = [s["video_id"] for s in stats[:3] if s.get("video_id")]
    except Exception as e:  # noqa: BLE001 — 후보별 측정 실패는 치명적이지 않음
        log.warning("measure failed for %r: %s", ch.name, e)


def run_challenge_scan(
    gemini, yt, d1, *, now_epoch: float, target_kpop: int = 7, target_general: int = 3,
) -> int:
    """발굴→구조화→측정→랭크→UPSERT. 저장한 챌린지 수 반환."""
    grounded = gemini.generate_grounded(prompt=CHALLENGE_DISCOVERY_PROMPT)
    structured = gemini.generate(
        system_prompt=CHALLENGE_STRUCTURE_SYSTEM,
        context={"grounded_text": grounded.text, "sources": grounded.sources},
        response_schema=CHALLENGE_SCHEMA,
    )
    challenges = parse_structured_challenges(structured)
    if not challenges:
        log.warning("challenge-scan: no challenges discovered; preserving prior week")
        return 0
    published_after = iso_days_ago(now_epoch, 7)
    for ch in challenges:
        measure_challenge(yt, ch, published_after)
    selected = select_and_rank(challenges, target_kpop=target_kpop,
                               target_general=target_general)
    week_start = week_start_kst(now_epoch)
    generated_at = _dt.datetime.fromtimestamp(now_epoch, tz=_dt.timezone.utc)\
        .strftime("%Y-%m-%dT%H:%M:%SZ")
    d1.batch(build_upsert_statements(week_start, selected, generated_at))
    return len(selected)
```

- [ ] **Step 4: 통과 확인**

Run: `cd worker && uv run pytest tests/unit/test_challenge_scan_run.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: 커밋**

```bash
git add worker/src/idol_sight/analysis/challenge_scan.py worker/tests/unit/test_challenge_scan_run.py
git commit -m "feat(weekly-challenges): challenge_scan 측정 + run 오케스트레이터"
```

---

## Task 7: CLI `challenge-scan` 커맨드

**Files:**
- Modify: `worker/src/idol_sight/cli.py`
- Test: `worker/tests/unit/test_cli_challenge_scan.py`

- [ ] **Step 1: 실패 테스트 작성**

`worker/tests/unit/test_cli_challenge_scan.py`:

```python
from unittest.mock import patch, MagicMock
from typer.testing import CliRunner
from idol_sight.cli import app

runner = CliRunner()


@patch("idol_sight.cli.run_challenge_scan", return_value=5)
@patch("idol_sight.cli._make_d1_client")
@patch("idol_sight.cli.YouTubeCollector")
@patch("idol_sight.cli.GeminiClient")
def test_challenge_scan_invokes_run(gem, yt, d1, run, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "g")
    monkeypatch.setenv("YT_API_KEY", "y")
    res = runner.invoke(app, ["challenge-scan"])
    assert res.exit_code == 0, res.output
    assert "5" in res.output
    run.assert_called_once()
```

- [ ] **Step 2: 실패 확인**

Run: `cd worker && uv run pytest tests/unit/test_cli_challenge_scan.py -v`
Expected: FAIL (커맨드/심볼 없음).

- [ ] **Step 3: 구현**

`cli.py` 상단 import 에 추가 (기존 import 그룹에 맞춰):

```python
import time
from idol_sight.llm.gemini import GeminiClient
from idol_sight.collectors.youtube import YouTubeCollector
from idol_sight.analysis.challenge_scan import run_challenge_scan
```

> `GeminiClient` / `YouTubeCollector` 가 이미 import 되어 있으면 중복 추가하지 말 것. 테스트가 `idol_sight.cli.GeminiClient` 등을 patch 하므로 cli 모듈 네임스페이스에 이 심볼들이 있어야 한다.

커맨드 추가:

```python
@app.command(name="challenge-scan", help="주간 바이럴 챌린지 발굴+측정 후 D1 저장.")
def challenge_scan() -> None:
    settings = load_settings()
    if not settings.gemini_api_key:
        raise typer.BadParameter("GEMINI_API_KEY required")
    if not settings.yt_api_key:
        raise typer.BadParameter("YT_API_KEY required")
    client = _make_d1_client(settings)
    gemini = GeminiClient(api_key=settings.gemini_api_key)
    yt = YouTubeCollector(api_key=settings.yt_api_key)
    n = run_challenge_scan(gemini, yt, client, now_epoch=time.time())
    typer.echo(f"challenge-scan: wrote {n} challenges")
```

- [ ] **Step 4: 통과 확인**

Run: `cd worker && uv run pytest tests/unit/test_cli_challenge_scan.py -v`
Expected: PASS.

- [ ] **Step 5: 전체 회귀 + 커밋**

Run: `cd worker && uv run pytest -q`
Expected: 전체 PASS.

```bash
git add worker/src/idol_sight/cli.py worker/tests/unit/test_cli_challenge_scan.py
git commit -m "feat(weekly-challenges): cli challenge-scan 커맨드"
```

---

## Task 8: 주간 워크플로

**Files:**
- Create: `.github/workflows/challenge-scan.yml`

- [ ] **Step 1: 작성**

`.github/workflows/challenge-scan.yml`:

```yaml
name: challenge-scan
on:
  schedule:
    # 월요일 KST 10:00 (UTC 01:00) — 주초 트렌드 정리.
    - cron: '0 1 * * 1'
  workflow_dispatch:

jobs:
  scan:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    defaults: { run: { working-directory: worker } }
    steps:
      - uses: actions/checkout@v5
      - uses: astral-sh/setup-uv@v7
      - run: uv sync --frozen
      - run: uv run python -m idol_sight challenge-scan
        env:
          CF_ACCOUNT_ID:   ${{ secrets.CF_ACCOUNT_ID }}
          CF_D1_DB_ID:     ${{ secrets.CF_D1_DB_ID }}
          CF_API_TOKEN:    ${{ secrets.CF_API_TOKEN }}
          GEMINI_API_KEY:  ${{ secrets.GEMINI_API_KEY }}
          YT_API_KEY:      ${{ secrets.YT_API_KEY }}
          DISCORD_WEBHOOK: ${{ secrets.DISCORD_WEBHOOK }}
```

- [ ] **Step 2: YAML 검증**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/challenge-scan.yml')); print('OK')"`
Expected: `OK`.

- [ ] **Step 3: 커밋**

```bash
git add .github/workflows/challenge-scan.yml
git commit -m "ci(weekly-challenges): challenge-scan 주간 워크플로 (월 KST 10:00)"
```

---

## Task 9: 프런트엔드 API — challenges 추가

**Files:**
- Modify: `frontend/functions/api/shorts-trend.ts`
- Test: `frontend/tests/functions/api_shorts_trend.test.ts`

- [ ] **Step 1: 테스트에 challenges 분기/검증 추가**

`frontend/tests/functions/api_shorts_trend.test.ts` 의 `baseEnv` mock 안, `agg_member_popularity` 분기 위에 추가:

```ts
    if (sql.includes("FROM weekly_challenges")) {
      return over.challenges ?? [
        { week_start: "2026-06-01", rank: 1, name: "Magnetic 챌린지", tag: "kpop",
          description: "포인트 안무", origin: "ILLIT - Magnetic",
          hashtags: '["#Magnetic"]', example_video_ids: '["v1"]',
          yt_recent_shorts: 42, yt_total_views: 1000000, miiwan_fit: "안무 단순",
          source_urls: '["http://s"]', confidence: "high",
          generated_at: "2026-06-01T01:00:00Z" },
      ];
    }
```

그리고 첫 `it(...)` 블록 끝에 assert 추가:

```ts
    expect(body.challenges).toHaveLength(1);
    expect(body.challenges[0].name).toBe("Magnetic 챌린지");
    expect(body.challenges[0].hashtags).toEqual(["#Magnetic"]);  // JSON 파싱됨
```

빈/부재 케이스 테스트 추가 (describe 안에):

```ts
  it("weekly_challenges 테이블 부재/에러 시 challenges 빈 배열", async () => {
    const env = {
      DB: { prepare: vi.fn((sql: string) => ({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn(async () => {
          if (sql.includes("FROM weekly_challenges")) throw new Error("no such table");
          if (sql.includes("FROM groups")) return { results: [
            { key: "miiwan", name: "MiiWAN", name_kr: "미완소년", context_keywords: "[]" }] };
          return { results: [] };
        }),
        first: vi.fn(async () => null),
      })) },
    } as any;
    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    const body = await res.json() as any;
    expect(body.challenges).toEqual([]);
  });
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && ./node_modules/.bin/vitest run api_shorts_trend`
Expected: FAIL (challenges 없음 / 테이블 에러 시 크래시).

- [ ] **Step 3: 구현 (`shorts-trend.ts`)**

`SummaryRow` interface 아래에 추가:

```ts
interface ChallengeRow {
  week_start: string; rank: number; name: string; tag: string;
  description: string | null; origin: string | null;
  hashtags: string | null; example_video_ids: string | null;
  yt_recent_shorts: number | null; yt_total_views: number | null;
  miiwan_fit: string | null; source_urls: string | null;
  confidence: string | null; generated_at: string;
}
```

`members` 쿼리 다음(= diagnostic input 만들기 전)에 challenges 조회 추가:

```ts
  // 최신 주차 챌린지. 테이블 미적용(원격 migration 전) 이면 graceful 빈 배열.
  let challenges: Array<Record<string, unknown>> = [];
  try {
    const rows = await d1Query<ChallengeRow>(env.DB,
      `SELECT * FROM weekly_challenges
        WHERE week_start = (SELECT MAX(week_start) FROM weekly_challenges)
        ORDER BY rank`);
    challenges = rows.map((r) => ({
      rank: r.rank, name: r.name, tag: r.tag, description: r.description,
      origin: r.origin, hashtags: parseJsonArr(r.hashtags),
      example_video_ids: parseJsonArr(r.example_video_ids),
      yt_recent_shorts: r.yt_recent_shorts, yt_total_views: r.yt_total_views,
      miiwan_fit: r.miiwan_fit, source_urls: parseJsonArr(r.source_urls),
      confidence: r.confidence, week_start: r.week_start,
      generated_at: r.generated_at,
    }));
  } catch (e) {
    challenges = [];
  }
```

`jsonResponse({...})` 에 `challenges` 추가:

```ts
    diagnostic: buildDiagnostic(input),
    challenges,
```

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && ./node_modules/.bin/vitest run api_shorts_trend` (PASS)
Run: `cd frontend && npx tsc -b --noEmit` (exit 0)

- [ ] **Step 5: 커밋**

```bash
git add frontend/functions/api/shorts-trend.ts frontend/tests/functions/api_shorts_trend.test.ts
git commit -m "feat(weekly-challenges): /api/shorts-trend 에 최신 주차 challenges 추가 (table 부재 graceful)"
```

---

## Task 10: 프런트엔드 섹션 컴포넌트 + 뷰 삽입

**Files:**
- Create: `frontend/src/components/WeeklyChallenges.tsx`
- Modify: `frontend/src/views/ShortsTrend.tsx`

- [ ] **Step 1: 컴포넌트 작성**

`frontend/src/components/WeeklyChallenges.tsx`:

```tsx
import { fmt } from "../format";

export interface ChallengeItem {
  rank: number;
  name: string;
  tag: string;                 // 'kpop' | 'general'
  description: string | null;
  origin: string | null;
  hashtags: string[];
  example_video_ids: string[];
  yt_recent_shorts: number | null;
  yt_total_views: number | null;
  miiwan_fit: string | null;
  source_urls: string[];
  confidence: string | null;
  week_start?: string;
  generated_at?: string;
}

const TAG_LABEL: Record<string, string> = { kpop: "K-POP", general: "일반" };
const CONF_COLOR: Record<string, string> = {
  high: "#22c55e", medium: "#eab308", low: "#6b7280",
};

export function WeeklyChallenges({ items }: { items: ChallengeItem[] }) {
  if (items.length === 0) {
    return (
      <section class="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <h2 class="text-lg font-bold">이번 주 바이럴 챌린지</h2>
        <p class="mt-2 text-zinc-400">이번 주 챌린지 데이터가 아직 없습니다.</p>
      </section>
    );
  }
  const week = items[0]?.week_start;
  return (
    <section class="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div class="mb-1 flex items-center justify-between">
        <h2 class="text-lg font-bold">이번 주 바이럴 챌린지</h2>
        <span class="text-hint text-zinc-500">{week ? `${week} 주` : ""}</span>
      </div>
      <p class="mb-3 text-hint text-zinc-600">발굴(AI 웹검색) + YouTube 측정 · MiiWAN 적합도 제안</p>
      <ol class="space-y-2">
        {items.map((c) => (
          <li key={c.rank} class="rounded-ctrl border border-zinc-800 p-3">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-bold tabular-nums text-zinc-300">#{c.rank}</span>
              <span class="font-semibold">{c.name}</span>
              <span class="rounded-full bg-zinc-800 px-2 py-0.5 text-hint text-zinc-300">
                {TAG_LABEL[c.tag] ?? c.tag}
              </span>
              {c.confidence && (
                <span class="inline-flex items-center gap-1 text-hint text-zinc-500">
                  <span class="inline-block h-1.5 w-1.5 rounded-full"
                    style={{ background: CONF_COLOR[c.confidence] ?? "#6b7280" }} />
                  {c.confidence}
                </span>
              )}
            </div>
            {c.description && <div class="mt-1 text-data text-zinc-300">{c.description}</div>}
            <div class="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-hint text-zinc-500">
              {c.origin && <span>원곡: {c.origin}</span>}
              {c.hashtags.length > 0 && <span>{c.hashtags.join(" ")}</span>}
              <span>
                측정: {c.yt_recent_shorts == null ? "미측정"
                  : `숏폼 ${c.yt_recent_shorts}+ · 조회 ${fmt(c.yt_total_views)}`}
              </span>
            </div>
            {c.miiwan_fit && (
              <div class="mt-1 text-hint text-brand-fg">MiiWAN: {c.miiwan_fit}</div>
            )}
            <div class="mt-1 flex flex-wrap gap-3 text-hint">
              {c.example_video_ids.map((v) => (
                <a key={v} class="text-zinc-400 hover:underline" target="_blank" rel="noreferrer"
                  href={`https://www.youtube.com/shorts/${v}`}>예시 ↗</a>
              ))}
              {c.source_urls.map((u, i) => (
                <a key={u} class="text-zinc-600 hover:underline" target="_blank" rel="noreferrer"
                  href={u}>출처{c.source_urls.length > 1 ? i + 1 : ""} ↗</a>
              ))}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
```

- [ ] **Step 2: 뷰에 삽입 (`ShortsTrend.tsx`)**

import 추가:

```tsx
import { WeeklyChallenges, type ChallengeItem } from "../components/WeeklyChallenges";
```

`Payload` interface 에 필드 추가:

```tsx
  challenges: ChallengeItem[];
```

렌더에서 진단 패널과 트렌드 테이블 사이에 삽입:

```tsx
      <MiiwanShortsDiagnostic data={data.diagnostic} />
      <WeeklyChallenges items={data.challenges ?? []} />
      <ShortsTrendTable
```

- [ ] **Step 3: 검증**

Run: `cd frontend && npx tsc -b --noEmit` (exit 0)
Run: `cd frontend && ./node_modules/.bin/vite build` (성공)
Run: `cd frontend && ./node_modules/.bin/vitest run` (전체 PASS)

- [ ] **Step 4: 커밋**

```bash
git add frontend/src/components/WeeklyChallenges.tsx frontend/src/views/ShortsTrend.tsx
git commit -m "feat(weekly-challenges): 이번 주 바이럴 챌린지 섹션 컴포넌트 + 뷰 삽입"
```

---

## Self-Review 결과 (작성자 체크)

**Spec 커버리지:**
- 아키텍처(§3) → Task 5/6 오케스트레이터 + Task 2/3/4 구성요소. ✓
- 데이터 모델(§4) → Task 1 migration. ✓
- 컴포넌트/파일(§5) → Task 2~10 매핑. ✓ (단, 적합도는 별도 MIIWAN_FIT_PROMPT 가 아니라 **구조화 단계에 통합** — 호출 1회 절약, spec §5 의 의도 충족)
- 데이터 플로우(§6) 발굴→구조화→측정→랭크→저장 → Task 6 `run_challenge_scan`. ✓
- 에러 처리(§7): 발굴 0건 스킵(Task 6 test), 측정 실패 tolerate(Task 6 test), 테이블 부재 graceful(Task 9 test), 멱등 DELETE(Task 5/6). ✓
- 기술 리스크(§8): 2-step(grounded→structure) 구현(Task 6), SDK grounding 검증(Task 3 에서 실제 호출 형태 + 기존 generate 패턴 확인 지시), 환각 가드(출처/confidence 필드 Task 2·9·10, 발굴/측정 라벨 Task 10). ✓
- 프런트 표시(§9) → Task 10. ✓
- 테스트(§10) → 각 Task TDD + frontend api 테스트. ✓
- 윤리(§11): 공개 트렌드·집계만. ✓

**Placeholder 스캔:** 모든 코드 스텝 실제 코드 포함. `0076` 번호 확정. TBD 없음. ✓

**타입 일관성:** `Challenge`(Task5) ↔ parse/select/build(Task5) ↔ measure/run(Task6) 일치. `GroundedResult`(Task3) ↔ run 사용(Task6) 일치. `generate_grounded(prompt=)`/`generate(system_prompt=,context=,response_schema=)` 시그니처 Task3·6 일치. API `ChallengeRow`(Task9) ↔ 프런트 `ChallengeItem`(Task10) JSON 형태 1:1(hashtags/example/source 파싱 후 배열). cli patch 심볼(`GeminiClient`/`YouTubeCollector`/`run_challenge_scan`/`_make_d1_client`)이 Task7 import 와 일치. ✓
- 주의: Task3 는 `gemini.py` 의 실제 내부 속성명(self._models/self._client)을 기존 `generate()` 확인 후 맞출 것 — 추정 불일치 시 거기서 조정.
