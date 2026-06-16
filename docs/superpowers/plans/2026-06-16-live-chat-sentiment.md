# 라이브 채팅 종료-후 긍/부정 분류 리포트 — 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 미완소년(miiwan)의 YouTube 라이브가 끝난 뒤 그날 새벽에 채팅 리플레이를 스크레이핑해, 방송 1건당 대표 긍/부정 멘트와 비율 추정을 담은 리포트를 만든다.

**Architecture:** `live_ccv`가 밤새 기록한 `live_ccv_samples`를 신호로 삼아, 종료된 방송을 `videos.list(actualEndTime)`로 가려낸다. 채팅 리플레이를 비공식 `get_live_chat_replay` 스크레이핑으로 긁어 `live_chat_messages`(raw)에 적재하고, 표본을 Gemini structured output에 1회 넘겨 `live_chat_reports`(방송별 1행)를 생성한다. 독립 cron 명령 `collect-live-chat`이 종료 감지→scrape→분류→저장을 자기완결로 처리한다.

**Tech Stack:** Python 3.12, httpx, typer CLI, Cloudflare D1(원격), google-genai(`GeminiClient`), pytest, GitHub Actions, Cloudflare Pages Functions(TS), React.

**Spec:** `docs/superpowers/specs/2026-06-16-live-chat-sentiment-design.md`

---

## File Structure

- Create `migrations/0090_live_chat.sql` — `live_chat_messages`(raw) + `live_chat_reports`(방송별) 테이블.
- Create `worker/src/idol_sight/collectors/live_chat.py` — `LiveChatReplayScraper`(리플레이 스크레이핑) + `ended_broadcasts()`(종료 감지 헬퍼).
- Create `worker/src/idol_sight/analysis/live_chat_report.py` — `build_report()`(표본화 + Gemini 추출 분류 → 리포트 statement).
- Modify `worker/src/idol_sight/cli.py` — `collect-live-chat` 명령 + `_load_live_chat_candidates()` 헬퍼.
- Create `worker/tests/unit/test_live_chat_scraper.py`, `test_live_chat_report.py`, `test_live_chat_cli.py`, `test_live_chat_migration.py`.
- Create `.github/workflows/collect-live-chat.yml` — cron 워크플로(`collect-ccv.yml` 미러).
- Create `frontend/functions/api/miiwan-live-chat.ts` — 최근 리포트 조회 API.
- Modify `frontend/src/...MiiWANBriefing...` — "라이브 채팅 반응" 섹션(기존 카드 패턴 따름).

---

## Task 1: Migration — `live_chat_messages` + `live_chat_reports`

**Files:**
- Create: `migrations/0090_live_chat.sql`
- Test: `worker/tests/unit/test_live_chat_migration.py`

- [ ] **Step 1: Write the failing test**

```python
# worker/tests/unit/test_live_chat_migration.py
"""Live chat migration 0090 — smoke test."""
import sqlite3
from pathlib import Path

MIGRATIONS_DIR = Path(__file__).resolve().parents[3] / "migrations"


def _apply_all() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    for f in sorted(MIGRATIONS_DIR.glob("*.sql")):
        conn.executescript(f.read_text())
    return conn


def test_migration_creates_live_chat_tables():
    conn = _apply_all()
    tables = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    assert "live_chat_messages" in tables
    assert "live_chat_reports" in tables

    msg_cols = {r[1] for r in conn.execute("PRAGMA table_info(live_chat_messages)")}
    assert {"video_id", "group_key", "msg_id", "offset_ms", "author", "message"} <= msg_cols

    rep_cols = {r[1] for r in conn.execute("PRAGMA table_info(live_chat_reports)")}
    assert {"video_id", "group_key", "title", "ended_at", "generated_at",
            "total_messages", "sampled", "positive_ratio", "negative_ratio",
            "report_json"} <= rep_cols

    indexes = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='index' "
        "AND tbl_name='live_chat_messages'")}
    assert "idx_lcm_video" in indexes


def test_live_chat_messages_pk_is_idempotent():
    conn = _apply_all()
    conn.execute("INSERT INTO groups (key, name) VALUES ('miiwan', 'MiiWAN')"
                 if "name" in {r[1] for r in conn.execute("PRAGMA table_info(groups)")}
                 else "INSERT INTO groups (key) VALUES ('miiwan')")
    ins = ("INSERT INTO live_chat_messages "
           "(video_id, group_key, msg_id, offset_ms, author, message) "
           "VALUES ('v1','miiwan','m1',1000,'a','hi') "
           "ON CONFLICT(video_id, msg_id) DO NOTHING")
    conn.execute(ins)
    conn.execute(ins)  # duplicate — must not raise, must not double-insert
    n = conn.execute("SELECT COUNT(*) FROM live_chat_messages").fetchone()[0]
    assert n == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && uv run pytest tests/unit/test_live_chat_migration.py -v`
Expected: FAIL — `live_chat_messages` not in tables.

- [ ] **Step 3: Write the migration**

```sql
-- migrations/0090_live_chat.sql
-- 라이브 채팅 종료-후 수집·분류. live_chat_messages 는 방송별 raw 채팅(재분석
-- 원천), live_chat_reports 는 방송 1건당 대표 멘트+비율 추정 리포트.
-- video_id 가 live_chat_reports 에 있으면 "처리 완료" → 멱등·재시도 제어.

CREATE TABLE IF NOT EXISTS live_chat_messages (
  video_id   TEXT NOT NULL,
  group_key  TEXT NOT NULL REFERENCES groups(key),
  msg_id     TEXT NOT NULL,        -- YouTube chat item id
  offset_ms  INTEGER,             -- videoOffsetTimeMsec (방송 시작 후 경과 ms)
  author     TEXT,
  message    TEXT NOT NULL,
  PRIMARY KEY (video_id, msg_id)
);
CREATE INDEX IF NOT EXISTS idx_lcm_video ON live_chat_messages (video_id);

CREATE TABLE IF NOT EXISTS live_chat_reports (
  video_id       TEXT PRIMARY KEY,
  group_key      TEXT NOT NULL REFERENCES groups(key),
  title          TEXT,
  ended_at       TEXT,             -- actualEndTime ISO8601
  generated_at   TEXT NOT NULL,    -- 리포트 생성 시각 ISO8601 UTC
  total_messages INTEGER NOT NULL, -- 긁어온 전체 건수
  sampled        INTEGER NOT NULL, -- LLM 에 넣은 표본 수
  positive_ratio REAL,
  negative_ratio REAL,
  report_json    TEXT NOT NULL
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && uv run pytest tests/unit/test_live_chat_migration.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add migrations/0090_live_chat.sql worker/tests/unit/test_live_chat_migration.py
git commit -m "feat(live-chat): migration 0090 — live_chat_messages + live_chat_reports"
```

---

## Task 2: `LiveChatReplayScraper` — 부트스트랩 추출 + 리플레이 파싱

**Files:**
- Create: `worker/src/idol_sight/collectors/live_chat.py`
- Test: `worker/tests/unit/test_live_chat_scraper.py`

스크레이퍼는 작은 순수 함수로 쪼개 개별 테스트한다: `_extract_bootstrap(html)`(watch 페이지에서 api_key·client_version·첫 continuation 토큰), `_parse_replay(data)`(youtubei 응답 → 메시지 + 다음 토큰). `scrape()`는 이 둘을 httpx로 엮는다.

- [ ] **Step 1: Write the failing tests (pure parsers first)**

```python
# worker/tests/unit/test_live_chat_scraper.py
from idol_sight.collectors.live_chat import (
    _extract_bootstrap, _parse_replay, LiveChatReplayScraper,
)

WATCH_HTML = '''
<html><head></head><body>
<script>var ytcfg = {};ytcfg.set({"INNERTUBE_API_KEY":"AIza_TEST_KEY",
"INNERTUBE_CONTEXT":{"client":{"clientName":"WEB","clientVersion":"2.2024"}}});</script>
<script>var ytInitialData = {"contents":{"twoColumnWatchNextResults":
{"conversationBar":{"liveChatRenderer":{"continuations":[
{"reloadContinuationData":{"continuation":"CONT_TOKEN_0"}}]}}}}};</script>
</body></html>
'''


def test_extract_bootstrap_pulls_key_version_and_continuation():
    bs = _extract_bootstrap(WATCH_HTML)
    assert bs["api_key"] == "AIza_TEST_KEY"
    assert bs["client_version"] == "2.2024"
    assert bs["continuation"] == "CONT_TOKEN_0"


def test_extract_bootstrap_returns_none_continuation_when_no_replay():
    bs = _extract_bootstrap("<html><script>ytcfg.set({\"INNERTUBE_API_KEY\":\"K\","
                            "\"INNERTUBE_CONTEXT\":{\"client\":{\"clientVersion\":\"1\"}}});"
                            "</script></html>")
    assert bs["continuation"] is None  # 채팅 비활성/리플레이 미준비


def _replay_payload(next_token="CONT_TOKEN_1", items=None):
    items = items if items is not None else [
        {"replayChatItemAction": {"videoOffsetTimeMsec": "5000", "actions": [
            {"addChatItemAction": {"item": {"liveChatTextMessageRenderer": {
                "id": "msg1",
                "authorName": {"simpleText": "팬1"},
                "message": {"runs": [{"text": "무대 너무 좋았어 "}, {"text": "❤"}]},
            }}}}]}},
    ]
    conts = ([{"liveChatReplayContinuationData": {"continuation": next_token}}]
             if next_token else [])
    return {"continuationContents": {"liveChatContinuation": {
        "actions": items, "continuations": conts}}}


def test_parse_replay_extracts_messages_and_next_token():
    msgs, nxt = _parse_replay(_replay_payload())
    assert nxt == "CONT_TOKEN_1"
    assert len(msgs) == 1
    assert msgs[0]["msg_id"] == "msg1"
    assert msgs[0]["author"] == "팬1"
    assert msgs[0]["message"] == "무대 너무 좋았어 ❤"
    assert msgs[0]["offset_ms"] == 5000


def test_parse_replay_no_continuation_returns_none_next():
    _, nxt = _parse_replay(_replay_payload(next_token=None))
    assert nxt is None


def test_parse_replay_skips_non_text_items():
    payload = _replay_payload(items=[
        {"replayChatItemAction": {"actions": [
            {"addBannerToLiveChatCommand": {}}]}},  # not a text message
    ])
    msgs, _ = _parse_replay(payload)
    assert msgs == []
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && uv run pytest tests/unit/test_live_chat_scraper.py -v`
Expected: FAIL — `cannot import name '_extract_bootstrap'`.

- [ ] **Step 3: Implement the pure parsers + scraper skeleton**

```python
# worker/src/idol_sight/collectors/live_chat.py
"""Live chat replay scraper — 종료된 YouTube 라이브의 채팅 리플레이를
비공식 youtubei `get_live_chat_replay` 로 긁어온다 (Data API 쿼터 0).

종료 감지는 ended_broadcasts() 가 videos.list 의 actualEndTime 으로 수행.
파싱은 순수 함수(_extract_bootstrap / _parse_replay)로 분리해 테스트한다.
실제 YouTube 응답 구조는 바뀔 수 있어 모든 추출은 방어적으로 .get 체인을 쓴다.
"""
from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable
from typing import Any

import httpx

log = logging.getLogger(__name__)

WATCH_URL = "https://www.youtube.com/watch?v={vid}"
REPLAY_URL = "https://www.youtube.com/youtubei/v1/live_chat/get_live_chat_replay?key={key}"
VIDEOS_API = "https://www.googleapis.com/youtube/v3/videos"
USER_AGENT = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/124.0 Safari/537.36")

MAX_MESSAGES = 20000
MAX_PAGES = 400

_API_KEY_RE = re.compile(r'"INNERTUBE_API_KEY":"([^"]+)"')
_CLIENT_VER_RE = re.compile(r'"clientVersion":"([0-9][^"]*)"')


def _extract_bootstrap(html: str) -> dict[str, Any]:
    """watch 페이지에서 api_key, client_version, 첫 리플레이 continuation 토큰."""
    key = _API_KEY_RE.search(html)
    ver = _CLIENT_VER_RE.search(html)
    cont: str | None = None
    # ytInitialData 의 conversationBar.liveChatRenderer.continuations[0]
    m = re.search(r'"liveChatRenderer":\{.*?"continuations":(\[.*?\])', html)
    if m:
        try:
            for c in json.loads(m.group(1)):
                rcd = (c.get("reloadContinuationData")
                       or c.get("liveChatReplayContinuationData") or {})
                if rcd.get("continuation"):
                    cont = rcd["continuation"]
                    break
        except (json.JSONDecodeError, AttributeError):
            cont = None
    return {
        "api_key": key.group(1) if key else None,
        "client_version": ver.group(1) if ver else None,
        "continuation": cont,
    }


def _runs_to_text(message: dict[str, Any]) -> str:
    runs = (message or {}).get("runs") or []
    return "".join(r.get("text", "") for r in runs if isinstance(r, dict)).strip()


def _parse_replay(data: dict[str, Any]) -> tuple[list[dict[str, Any]], str | None]:
    """youtubei 응답 → ([{msg_id, offset_ms, author, message}], next_continuation)."""
    lcc = (((data or {}).get("continuationContents") or {})
           .get("liveChatContinuation") or {})
    out: list[dict[str, Any]] = []
    for action in lcc.get("actions") or []:
        rcia = action.get("replayChatItemAction") or {}
        offset = rcia.get("videoOffsetTimeMsec")
        for inner in rcia.get("actions") or []:
            item = ((inner.get("addChatItemAction") or {}).get("item") or {})
            r = item.get("liveChatTextMessageRenderer")
            if not r:
                continue
            text = _runs_to_text(r.get("message") or {})
            if not text:
                continue
            out.append({
                "msg_id": r.get("id"),
                "offset_ms": int(offset) if offset and str(offset).lstrip("-").isdigit() else None,
                "author": ((r.get("authorName") or {}).get("simpleText")),
                "message": text,
            })
    nxt: str | None = None
    for c in lcc.get("continuations") or []:
        rcd = c.get("liveChatReplayContinuationData") or {}
        if rcd.get("continuation"):
            nxt = rcd["continuation"]
            break
    return out, nxt


class LiveChatReplayScraper:
    source = "live_chat"

    def __init__(self, *, http_factory: Callable[[], Any] | None = None):
        self._http_factory = http_factory or (
            lambda: httpx.Client(timeout=30.0, headers={"User-Agent": USER_AGENT}))

    def scrape(self, video_id: str) -> list[dict[str, Any]]:
        """종료된 방송의 채팅 리플레이 전량(캡 내). 리플레이 없으면 []."""
        with self._http_factory() as client:
            r = client.get(WATCH_URL.format(vid=video_id))
            r.raise_for_status()
            bs = _extract_bootstrap(r.text)
            if not (bs["api_key"] and bs["continuation"]):
                log.info("live_chat %s: no replay continuation (chat off/not ready)", video_id)
                return []

            messages: list[dict[str, Any]] = []
            seen: set[str] = set()
            token: str | None = bs["continuation"]
            url = REPLAY_URL.format(key=bs["api_key"])
            body_client = {"clientName": "WEB",
                           "clientVersion": bs["client_version"] or "2.20240101"}
            pages = 0
            while token and pages < MAX_PAGES and len(messages) < MAX_MESSAGES:
                pages += 1
                resp = client.post(url, json={
                    "context": {"client": body_client},
                    "continuation": token,
                })
                resp.raise_for_status()
                batch, token = _parse_replay(resp.json())
                if not batch:
                    break
                for m in batch:
                    mid = m.get("msg_id")
                    if mid and mid not in seen:
                        seen.add(mid)
                        messages.append(m)
            return messages[:MAX_MESSAGES]
```

- [ ] **Step 4: Run parser tests to verify they pass**

Run: `cd worker && uv run pytest tests/unit/test_live_chat_scraper.py -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Add an end-to-end scrape test with a fake http client**

```python
# append to worker/tests/unit/test_live_chat_scraper.py
class _FakeResp:
    def __init__(self, text="", payload=None, status=200):
        self._text, self._payload, self.status_code = text, payload or {}, status

    @property
    def text(self):
        return self._text

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("err", request=None, response=None)


import httpx  # noqa: E402


class _FakeClient:
    def __init__(self, get_resp, post_responses):
        self._get_resp = get_resp
        self._post = list(post_responses)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get(self, url, **kw):
        return self._get_resp

    def post(self, url, **kw):
        return self._post.pop(0)


def test_scrape_follows_continuations_until_exhausted():
    get_resp = _FakeResp(text=WATCH_HTML)
    posts = [
        _FakeResp(payload=_replay_payload(next_token="CONT_TOKEN_1", items=[
            {"replayChatItemAction": {"videoOffsetTimeMsec": "1000", "actions": [
                {"addChatItemAction": {"item": {"liveChatTextMessageRenderer": {
                    "id": "a", "authorName": {"simpleText": "u"},
                    "message": {"runs": [{"text": "good"}]}}}}}]}}])),
        _FakeResp(payload=_replay_payload(next_token=None, items=[
            {"replayChatItemAction": {"videoOffsetTimeMsec": "2000", "actions": [
                {"addChatItemAction": {"item": {"liveChatTextMessageRenderer": {
                    "id": "b", "authorName": {"simpleText": "v"},
                    "message": {"runs": [{"text": "bad"}]}}}}}]}}])),
    ]
    scraper = LiveChatReplayScraper(http_factory=lambda: _FakeClient(get_resp, posts))
    msgs = scraper.scrape("vid")
    assert [m["msg_id"] for m in msgs] == ["a", "b"]


def test_scrape_returns_empty_when_no_continuation():
    scraper = LiveChatReplayScraper(
        http_factory=lambda: _FakeClient(_FakeResp(text="<html></html>"), []))
    assert scraper.scrape("vid") == []
```

- [ ] **Step 6: Run all scraper tests**

Run: `cd worker && uv run pytest tests/unit/test_live_chat_scraper.py -v`
Expected: PASS (7 tests).

- [ ] **Step 7: Commit**

```bash
git add worker/src/idol_sight/collectors/live_chat.py worker/tests/unit/test_live_chat_scraper.py
git commit -m "feat(live-chat): LiveChatReplayScraper — replay 스크레이핑 + 방어적 파싱"
```

---

## Task 3: `ended_broadcasts()` — videos.list 종료 감지 헬퍼

**Files:**
- Modify: `worker/src/idol_sight/collectors/live_chat.py`
- Test: `worker/tests/unit/test_live_chat_scraper.py`

- [ ] **Step 1: Write the failing test**

```python
# append to worker/tests/unit/test_live_chat_scraper.py
from idol_sight.collectors.live_chat import ended_broadcasts


class _FakeGetClient:
    def __init__(self, payload):
        self._payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get(self, url, **kw):
        return _FakeResp(payload=self._payload)


def test_ended_broadcasts_keeps_only_ended_old_enough():
    payload = {"items": [
        {"id": "ended_ok", "snippet": {"title": "끝난방송", "liveBroadcastContent": "none"},
         "liveStreamingDetails": {"actualEndTime": "2026-06-16T01:00:00Z"}},
        {"id": "still_live", "snippet": {"title": "진행중", "liveBroadcastContent": "live"},
         "liveStreamingDetails": {"actualStartTime": "2026-06-16T00:00:00Z"}},
        {"id": "just_ended", "snippet": {"title": "방금끝", "liveBroadcastContent": "none"},
         "liveStreamingDetails": {"actualEndTime": "2026-06-16T03:50:00Z"}},
    ]}
    out = ended_broadcasts(
        lambda: _FakeGetClient(payload),
        api_key="K", video_ids=["ended_ok", "still_live", "just_ended"],
        now_iso="2026-06-16T04:00:00Z", min_age_min=30,
    )
    assert set(out) == {"ended_ok"}          # still_live=라이브중, just_ended=10분전→제외
    assert out["ended_ok"]["title"] == "끝난방송"
    assert out["ended_ok"]["ended_at"] == "2026-06-16T01:00:00Z"


def test_ended_broadcasts_empty_input():
    assert ended_broadcasts(lambda: _FakeGetClient({"items": []}),
                            api_key="K", video_ids=[], now_iso="2026-06-16T04:00:00Z") == {}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && uv run pytest tests/unit/test_live_chat_scraper.py::test_ended_broadcasts_keeps_only_ended_old_enough -v`
Expected: FAIL — `cannot import name 'ended_broadcasts'`.

- [ ] **Step 3: Implement the helper**

```python
# append to worker/src/idol_sight/collectors/live_chat.py
from datetime import datetime, timezone  # add near top imports

VIDEOS_LIST_MAX = 50


def _parse_iso(s: str) -> datetime | None:
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


def ended_broadcasts(
    http_factory: Callable[[], Any],
    *,
    api_key: str,
    video_ids: list[str],
    now_iso: str,
    min_age_min: int = 30,
) -> dict[str, dict[str, Any]]:
    """video_ids 중 '종료됐고(actualEndTime) 종료 후 min_age_min 분 지난' 방송만
    {video_id: {title, ended_at}} 로 반환. 리플레이가 준비될 시간 여유를 보장한다.
    """
    if not video_ids:
        return {}
    now = _parse_iso(now_iso) or datetime.now(timezone.utc)
    out: dict[str, dict[str, Any]] = {}
    with http_factory() as client:
        for i in range(0, len(video_ids), VIDEOS_LIST_MAX):
            batch = video_ids[i:i + VIDEOS_LIST_MAX]
            r = client.get(VIDEOS_API, params={
                "key": api_key, "id": ",".join(batch),
                "part": "snippet,liveStreamingDetails",
            })
            r.raise_for_status()
            for item in r.json().get("items", []):
                sn = item.get("snippet") or {}
                lsd = item.get("liveStreamingDetails") or {}
                end = lsd.get("actualEndTime")
                if not end or sn.get("liveBroadcastContent") == "live":
                    continue
                end_dt = _parse_iso(end)
                if end_dt is None:
                    continue
                age_min = (now - end_dt).total_seconds() / 60.0
                if age_min < min_age_min:
                    continue
                out[item["id"]] = {"title": sn.get("title"), "ended_at": end}
    return out
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd worker && uv run pytest tests/unit/test_live_chat_scraper.py -v`
Expected: PASS (9 tests total).

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/collectors/live_chat.py worker/tests/unit/test_live_chat_scraper.py
git commit -m "feat(live-chat): ended_broadcasts() — videos.list actualEndTime 종료 감지"
```

---

## Task 4: `build_report()` — 표본화 + Gemini 추출 분류

**Files:**
- Create: `worker/src/idol_sight/analysis/live_chat_report.py`
- Test: `worker/tests/unit/test_live_chat_report.py`

- [ ] **Step 1: Write the failing tests**

```python
# worker/tests/unit/test_live_chat_report.py
import json
from idol_sight.analysis.live_chat_report import build_report, _sample, SAMPLE


class _FakeGemini:
    def __init__(self, payload):
        self.payload = payload
        self.calls = []

    def generate(self, *, system_prompt, context, response_schema):
        self.calls.append(context)
        return self.payload


def _msgs(n):
    return [{"msg_id": f"m{i}", "offset_ms": i * 1000, "author": "u",
             "message": f"msg {i}"} for i in range(n)]


def test_sample_dedups_and_caps():
    raw = [{"message": "같은말"}, {"message": "같은말"}, {"message": " 같은말 "},
           {"message": "ㅋ"}, {"message": "다른말"}]
    s = _sample(raw)
    texts = sorted(m["message"].strip() for m in s)
    assert texts == ["다른말", "같은말"]  # dedup(normalize) + 너무 짧은 'ㅋ' 제외


def test_sample_strides_when_over_cap():
    s = _sample(_msgs(SAMPLE * 3))
    assert len(s) == SAMPLE


def test_build_report_returns_insert_statement_with_counts():
    gem = _FakeGemini({
        "positive_ratio": 0.7, "negative_ratio": 0.2,
        "positive_quotes": [{"quote": "최고"}], "negative_quotes": [{"quote": "별로"}],
        "themes": [{"label": "무대", "polarity": "positive"}],
        "summary": "대체로 호평",
    })
    stmt = build_report(
        gem, video_id="vid", group_key="miiwan", group_name_kr="미완소년",
        title="첫 라이브", ended_at="2026-06-16T01:00:00Z", messages=_msgs(10),
        now_iso="2026-06-16T04:00:00Z",
    )
    assert stmt is not None
    sql, params = stmt
    assert sql.startswith("INSERT INTO live_chat_reports")
    assert "ON CONFLICT(video_id)" in sql
    # params order: video_id, group_key, title, ended_at, generated_at,
    #               total_messages, sampled, positive_ratio, negative_ratio, report_json
    assert params[0] == "vid" and params[1] == "miiwan"
    assert params[5] == 10                # total_messages
    assert params[6] == 10                # sampled (<= cap)
    assert params[7] == 0.7 and params[8] == 0.2
    rj = json.loads(params[9])
    assert rj["positive"][0]["quote"] == "최고"
    assert rj["summary"] == "대체로 호평"


def test_build_report_none_on_empty_messages():
    gem = _FakeGemini({})
    assert build_report(gem, video_id="v", group_key="miiwan", group_name_kr="미완소년",
                        title=None, ended_at=None, messages=[],
                        now_iso="2026-06-16T04:00:00Z") is None
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && uv run pytest tests/unit/test_live_chat_report.py -v`
Expected: FAIL — module `live_chat_report` not found.

- [ ] **Step 3: Implement**

```python
# worker/src/idol_sight/analysis/live_chat_report.py
"""라이브 채팅 리포트 빌더 — raw 채팅을 표본화해 Gemini 1회 호출로
대표 긍/부정 멘트 + 비율 추정 + 핵심 테마를 추출, live_chat_reports
INSERT statement 를 반환한다. sentiment.py 의 _Gemini DI 패턴을 따른다.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Protocol

log = logging.getLogger(__name__)

SAMPLE = 500          # LLM 에 넣을 최대 표본 수
MIN_LEN = 2           # 이보다 짧은 메시지(ㅋ, ! 등)는 노이즈로 제외

_REPEAT_RE = re.compile(r"(.)\1{4,}")   # 5자 이상 반복(도배) 감지


class _Gemini(Protocol):
    def generate(
        self, *, system_prompt: str, context: dict[str, Any],
        response_schema: dict[str, Any],
    ) -> dict[str, Any]: ...


REPORT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "positive_ratio": {"type": "number"},
        "negative_ratio": {"type": "number"},
        "positive_quotes": {"type": "array", "items": {"type": "object", "properties": {
            "quote": {"type": "string"}, "note": {"type": "string"}}, "required": ["quote"]}},
        "negative_quotes": {"type": "array", "items": {"type": "object", "properties": {
            "quote": {"type": "string"}, "note": {"type": "string"}}, "required": ["quote"]}},
        "themes": {"type": "array", "items": {"type": "object", "properties": {
            "label": {"type": "string"}, "polarity": {"type": "string"}},
            "required": ["label", "polarity"]}},
        "summary": {"type": "string"},
    },
    "required": ["positive_ratio", "negative_ratio",
                 "positive_quotes", "negative_quotes", "summary"],
}

PROMPT = """\
You are analysing the live-chat of a Korean K-pop group's YouTube live
broadcast. Messages are casual fan chat — slang, abbreviations, emoji,
and spam/repeats are common.

From the SAMPLE of chat messages, produce:
  - positive_ratio / negative_ratio: your best estimate of the share of
    the chat that is clearly positive vs clearly negative, as fractions
    of 0..1 (the rest is neutral/noise; the two need not sum to 1).
  - positive_quotes / negative_quotes: the 3-5 MOST representative real
    messages for each side. Quote them VERBATIM from the sample; do not
    invent or paraphrase.
  - themes: a few recurring topics, each tagged polarity
    positive|negative|neutral.
  - summary: one or two Korean sentences capturing the overall reaction.

Judge by the most likely fan reading. When ambiguous, treat as neutral
(exclude from both ratios)."""


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "")).strip()


def _sample(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """중복(정규화 기준)·도배·너무 짧은 메시지 제거 후, 시간순 균등 stride 로 SAMPLE 캡."""
    seen: set[str] = set()
    cleaned: list[dict[str, Any]] = []
    for m in messages:
        norm = _normalize(m.get("message", ""))
        if len(norm) < MIN_LEN or _REPEAT_RE.search(norm):
            continue
        if norm in seen:
            continue
        seen.add(norm)
        cleaned.append(m)
    if len(cleaned) <= SAMPLE:
        return cleaned
    step = len(cleaned) / SAMPLE
    return [cleaned[int(i * step)] for i in range(SAMPLE)]


def build_report(
    gemini: _Gemini,
    *,
    video_id: str,
    group_key: str,
    group_name_kr: str,
    title: str | None,
    ended_at: str | None,
    messages: list[dict[str, Any]],
    now_iso: str,
) -> tuple[str, list[Any]] | None:
    """표본 → Gemini 추출 → live_chat_reports UPSERT statement. 메시지 없으면 None."""
    if not messages:
        return None
    sample = _sample(messages)
    if not sample:
        return None
    context = {
        "group": group_name_kr,
        "messages": [_normalize(m.get("message", "")) for m in sample],
    }
    parsed = gemini.generate(
        system_prompt=PROMPT, context=context, response_schema=REPORT_SCHEMA)
    report = {
        "positive": parsed.get("positive_quotes") or [],
        "negative": parsed.get("negative_quotes") or [],
        "themes": parsed.get("themes") or [],
        "summary": parsed.get("summary") or "",
    }
    sql = (
        "INSERT INTO live_chat_reports "
        "(video_id, group_key, title, ended_at, generated_at, total_messages, "
        " sampled, positive_ratio, negative_ratio, report_json) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(video_id) DO UPDATE SET "
        "generated_at=excluded.generated_at, total_messages=excluded.total_messages, "
        "sampled=excluded.sampled, positive_ratio=excluded.positive_ratio, "
        "negative_ratio=excluded.negative_ratio, report_json=excluded.report_json"
    )
    params = [
        video_id, group_key, title, ended_at, now_iso,
        len(messages), len(sample),
        _as_ratio(parsed.get("positive_ratio")),
        _as_ratio(parsed.get("negative_ratio")),
        json.dumps(report, ensure_ascii=False),
    ]
    return (sql, params)


def _as_ratio(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return round(max(0.0, min(1.0, f)), 4)


__all__ = ["build_report", "REPORT_SCHEMA", "PROMPT", "SAMPLE"]
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd worker && uv run pytest tests/unit/test_live_chat_report.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/analysis/live_chat_report.py worker/tests/unit/test_live_chat_report.py
git commit -m "feat(live-chat): build_report — 표본화 + Gemini 추출 분류 → 리포트 statement"
```

---

## Task 5: CLI `collect-live-chat` 명령

**Files:**
- Modify: `worker/src/idol_sight/cli.py` (새 명령 + `_load_live_chat_candidates` 헬퍼; `collect-ccv`(라인 ~850) 바로 아래에 배치)
- Test: `worker/tests/unit/test_live_chat_cli.py`

후보 선별 SQL 로직만 헬퍼로 떼어 단위 테스트한다(전체 명령은 I/O 가 많아 헬퍼 + 수동 검증으로 분리).

- [ ] **Step 1: Write the failing test**

```python
# worker/tests/unit/test_live_chat_cli.py
from idol_sight.cli import _load_live_chat_candidates


class _FakeD1:
    def __init__(self, rows):
        self.rows = rows
        self.queries = []

    def execute(self, sql, params=None):
        self.queries.append((sql, params))
        return self.rows


def test_candidates_query_filters_group_window_and_done():
    d1 = _FakeD1([{"video_id": "a"}, {"video_id": "b"}])
    out = _load_live_chat_candidates(d1, group_key="miiwan", since="2026-06-13T04:00:00Z")
    assert out == ["a", "b"]
    sql, params = d1.queries[0]
    assert "live_ccv_samples" in sql
    assert "NOT IN (SELECT video_id FROM live_chat_reports)" in sql
    assert params == ["miiwan", "2026-06-13T04:00:00Z"]
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && uv run pytest tests/unit/test_live_chat_cli.py -v`
Expected: FAIL — `cannot import name '_load_live_chat_candidates'`.

- [ ] **Step 3: Implement helper + command in `cli.py`**

`_load_live_chat_candidates` 헬퍼(다른 `_load_*` 헬퍼 근처, 예: `_load_ccv_targets` 아래):

```python
def _load_live_chat_candidates(client, *, group_key: str, since: str) -> list[str]:
    """since 이후 CCV 가 기록한 group_key 의 방송 중, 아직 리포트 없는 video_id."""
    rows = client.execute(
        "SELECT DISTINCT video_id FROM live_ccv_samples "
        "WHERE group_key=? AND sampled_at >= ? "
        "  AND video_id NOT IN (SELECT video_id FROM live_chat_reports)",
        [group_key, since],
    )
    return [r["video_id"] for r in rows if r.get("video_id")]
```

명령(`collect-ccv` 함수 바로 아래):

```python
@app.command("collect-live-chat",
             help="종료된 라이브 방송의 채팅 리플레이를 긁어 긍/부정 리포트 생성.")
def collect_live_chat(
    group: str = typer.Option("miiwan", "--group", help="대상 group_key."),
    now: str | None = typer.Option(None, "--now", help="ISO8601 UTC 기준 시각."),
    window_days: int = typer.Option(3, "--window-days", help="후보 탐색 윈도(재시도 상한)."),
    min_age_min: int = typer.Option(30, "--min-age-min", help="종료 후 최소 경과(분)."),
) -> None:
    from datetime import timedelta

    from idol_sight.analysis.live_chat_report import build_report
    from idol_sight.collectors.live_chat import (
        LiveChatReplayScraper, ended_broadcasts,
    )
    from idol_sight.llm.gemini import GeminiClient

    settings = load_settings()
    if not settings.yt_api_key:
        typer.echo("YT_API_KEY unset", err=True)
        raise typer.Exit(code=2)
    if not settings.gemini_api_key:
        typer.echo("GEMINI_API_KEY unset", err=True)
        raise typer.Exit(code=2)

    client = _make_d1_client(settings)
    now_dt = (datetime.fromisoformat(now.replace("Z", "+00:00")) if now
              else datetime.now(UTC))
    now_iso = now_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    since = (now_dt - timedelta(days=window_days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    grp = _load_group(client, group)

    candidates = _load_live_chat_candidates(client, group_key=group, since=since)
    if not candidates:
        typer.echo("collect-live-chat: no candidate broadcasts")
        raise typer.Exit(code=0)

    ended = ended_broadcasts(
        lambda: __import__("httpx").Client(timeout=30.0),
        api_key=settings.yt_api_key, video_ids=candidates,
        now_iso=now_iso, min_age_min=min_age_min,
    )

    scraper = LiveChatReplayScraper()
    gemini = GeminiClient(api_key=settings.gemini_api_key)
    reports = 0
    errors: list[str] = []
    for vid, meta in ended.items():
        try:
            msgs = scraper.scrape(vid)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"scrape {vid}: {exc}")
            continue
        if not msgs:
            continue
        raw_stmts = [(
            "INSERT INTO live_chat_messages "
            "(video_id, group_key, msg_id, offset_ms, author, message) "
            "VALUES (?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(video_id, msg_id) DO NOTHING",
            [vid, group, m["msg_id"], m["offset_ms"], m["author"], m["message"]],
        ) for m in msgs if m.get("msg_id")]
        if raw_stmts:
            client.batch(raw_stmts)
        try:
            stmt = build_report(
                gemini, video_id=vid, group_key=group,
                group_name_kr=grp.name_kr or grp.name, title=meta["title"],
                ended_at=meta["ended_at"], messages=msgs, now_iso=now_iso)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"report {vid}: {exc}")
            continue
        if stmt:
            client.batch([stmt])
            reports += 1

    for e in errors:
        typer.echo(f"WARN: {e}", err=True)
    typer.echo(f"collect-live-chat: {reports} report(s) from "
               f"{len(ended)} ended / {len(candidates)} candidate broadcasts")
    # 후보가 있었는데 전부 실패한 경우에만 비-0 (live_ccv sentinel 패턴)
    raise typer.Exit(code=1 if (ended and reports == 0 and errors) else 0)
```

> `grp.name_kr`/`grp.name` 는 `_load_group` 가 돌려주는 `GroupConfig` 필드. 존재 확인: `worker/src/idol_sight/config.py` 의 `GroupConfig`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd worker && uv run pytest tests/unit/test_live_chat_cli.py -v`
Expected: PASS.

- [ ] **Step 5: Verify the command registers (no D1 calls)**

Run: `cd worker && uv run python -m idol_sight --help | grep collect-live-chat`
Expected: `collect-live-chat` 행 출력.

- [ ] **Step 6: Run the full unit suite (no regressions)**

Run: `cd worker && uv run pytest -q`
Expected: 기존 통과 수 + 신규 테스트 모두 PASS.

- [ ] **Step 7: Commit**

```bash
git add worker/src/idol_sight/cli.py worker/tests/unit/test_live_chat_cli.py
git commit -m "feat(live-chat): collect-live-chat 명령 — 종료 감지→scrape→분류→저장"
```

---

## Task 6: GitHub Actions cron `collect-live-chat.yml`

**Files:**
- Create: `.github/workflows/collect-live-chat.yml`
- Reference: `.github/workflows/collect-ccv.yml` (env/secret/uv 설정을 그대로 미러)

- [ ] **Step 1: Read the existing workflow to mirror exactly**

Run: `cat .github/workflows/collect-ccv.yml`
목적: python 버전, `uv` 설치, `working-directory`, 시크릿 주입(`YT_API_KEY`, `GEMINI_API_KEY`, D1 자격), notify-fail 단계의 정확한 형태를 복사하기 위함.

- [ ] **Step 2: Write the workflow (collect-ccv 를 베이스로, 명령·cron 만 교체)**

```yaml
# .github/workflows/collect-live-chat.yml
name: collect-live-chat
on:
  schedule:
    - cron: "0 19 * * *"   # KST 04:00 — 정상 경로(그날 밤 종료분 수집)
    - cron: "0 3 * * *"    # KST 12:00 — 안전망(리플레이 미준비분 재시도)
  workflow_dispatch: {}

concurrency:
  group: collect-live-chat
  cancel-in-progress: false

jobs:
  collect:
    runs-on: ubuntu-latest
    steps:
      # ↓ collect-ccv.yml 의 checkout/uv/python 설정을 그대로 복사
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v5
      - name: Run collector
        working-directory: worker
        env:
          YT_API_KEY: ${{ secrets.YT_API_KEY }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
          # ↓ collect-ccv.yml 과 동일한 D1 시크릿(CF account/db/token) 키 이름으로 채울 것
          CF_ACCOUNT_ID: ${{ secrets.CF_ACCOUNT_ID }}
          CF_D1_DATABASE_ID: ${{ secrets.CF_D1_DATABASE_ID }}
          CF_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
        run: uv run python -m idol_sight collect-live-chat --group miiwan
```

> **중요:** Step 1 에서 본 `collect-ccv.yml` 의 실제 시크릿 키 이름·스텝 구성이 위 placeholder 와 다르면 **그쪽을 정본으로** 맞춘다(이 프로젝트의 D1 자격 주입 방식이 정답).

- [ ] **Step 3: Validate YAML locally**

Run: `cd worker && uv run python -c "import yaml,sys; yaml.safe_load(open('../.github/workflows/collect-live-chat.yml')); print('ok')"`
Expected: `ok`

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/collect-live-chat.yml
git commit -m "ci(live-chat): collect-live-chat cron (KST 04:00 정상 / 12:00 안전망)"
```

---

## Task 7: 프론트 API `/api/miiwan-live-chat`

**Files:**
- Create: `frontend/functions/api/miiwan-live-chat.ts`
- Reference: `frontend/functions/api/miiwan.ts`(d1 헬퍼·jsonResponse·partial-friendly 패턴), `frontend/functions/lib/d1.ts`, `lib/jsonResponse.ts`

- [ ] **Step 1: Read the reference endpoint + d1 lib signatures**

Run: `sed -n '1,40p' frontend/functions/api/groups.ts && grep -nE "export (async )?function|d1Query|jsonResponse" frontend/functions/lib/d1.ts frontend/functions/lib/jsonResponse.ts`
목적: `d1Query`/`jsonResponse` 의 정확한 시그니처와 `onRequest` export 형태 확인.

- [ ] **Step 2: Write the endpoint (시그니처는 Step 1 확인값에 맞춰 조정)**

```typescript
// frontend/functions/api/miiwan-live-chat.ts
// /api/miiwan-live-chat — 최근 라이브 채팅 리포트(방송별). 데이터 없으면 빈 배열.
import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";

const TARGET = "miiwan";
const LIMIT = 10;

export const onRequest: PagesFunction<{ DB: D1Database }> = async (ctx) => {
  let reports: unknown[] = [];
  try {
    reports = await d1Query(
      ctx.env.DB,
      "SELECT video_id, title, ended_at, generated_at, total_messages, " +
        "sampled, positive_ratio, negative_ratio, report_json " +
        "FROM live_chat_reports WHERE group_key=? " +
        "ORDER BY ended_at DESC LIMIT ?",
      [TARGET, LIMIT],
    );
  } catch {
    reports = []; // 테이블 미적용/빈 데이터 → graceful (miiwan.ts partial 패턴)
  }
  // report_json 은 문자열 → 파싱해서 내려보냄(프론트 편의)
  const parsed = (reports as Record<string, unknown>[]).map((r) => ({
    ...r,
    report: safeParse(r.report_json as string),
  }));
  return jsonResponse({ reports: parsed });
};

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
```

> `PagesFunction`/`env.DB` 바인딩 이름·`d1Query`/`jsonResponse` 시그니처가 Step 1 확인값과 다르면 그쪽에 맞춘다.

- [ ] **Step 3: Typecheck**

Run: `cd frontend && pnpm exec tsc --noEmit`
Expected: 에러 없음.

- [ ] **Step 4: Commit**

```bash
git add frontend/functions/api/miiwan-live-chat.ts
git commit -m "feat(live-chat): /api/miiwan-live-chat — 최근 방송별 리포트 조회"
```

---

## Task 8: 프론트 "라이브 채팅 반응" 섹션

**Files:**
- Modify: MiiWANBriefing 컴포넌트 (위치 확인: `grep -rl "라이브 반응\|MiiWANBriefing\|live-ccv" frontend/src`)
- Reference: 같은 파일의 "라이브 반응"(CCV) 카드 — 동일한 카드/스타일 패턴을 재사용

- [ ] **Step 1: Locate the component and the existing CCV card**

Run: `grep -rln "라이브 반응" frontend/src && grep -rln "live-ccv\|liveCcv\|api/miiwan" frontend/src`
목적: 데이터 패칭 훅 패턴(예: `/api/miiwan` 호출부)과 카드 마크업을 그대로 따르기 위함.

- [ ] **Step 2: Add a fetch + "라이브 채팅 반응" section**

기존 CCV "라이브 반응" 카드 바로 아래에 새 섹션을 추가한다. 데이터 패칭은 Step 1 에서 확인한 훅 패턴을 따르되 `/api/miiwan-live-chat` 를 호출하고, 각 리포트를 카드로 렌더한다:
- 헤더: `title` + `ended_at`(날짜) + `총 {total_messages}건` 배지.
- 비율 바: 긍정/부정 두 색 막대(`positive_ratio`/`negative_ratio`), 옆에 "추정" 라벨.
- 본문: `report.positive`(👍)·`report.negative`(👎) 각 3~5개 인용 + `report.themes` 칩.
- `report.summary` 한 줄.
- 빈 배열이면 "아직 분석된 라이브가 없어요" empty-state(다른 카드의 빈 상태 패턴 따름).

> 정확한 JSX/CSS 클래스는 기존 카드에서 복사한다. 새 디자인을 발명하지 말 것 — 같은 카드 컨테이너·타이포·색 토큰을 재사용한다.

- [ ] **Step 3: Typecheck + build**

Run: `cd frontend && pnpm exec tsc --noEmit && pnpm build`
Expected: 에러 없음, 빌드 성공.

- [ ] **Step 4: Frontend tests (있으면)**

Run: `cd frontend && pnpm test`
Expected: PASS(또는 관련 테스트 없음).

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "feat(live-chat): MiiWANBriefing '라이브 채팅 반응' 섹션"
```

---

## Task 9: 원격 마이그레이션 적용 + 마무리

**Files:** 없음(운영 단계)

- [ ] **Step 1: Apply migration 0090 to remote D1**

이 프로젝트의 마이그레이션 적용 방식 확인 후 실행: `grep -rn "wrangler d1 migrations\|0089\|d1 execute" .github docs scripts README.md` 로 기존 절차를 찾아 동일하게 0090 적용. (예: `wrangler d1 migrations apply <DB> --remote` 또는 프로젝트 표준 스크립트.)
Expected: `live_chat_messages`/`live_chat_reports` 원격 생성 확인.

- [ ] **Step 2: Smoke-run the collector against remote (수동)**

Run: `cd worker && uv run python -m idol_sight collect-live-chat --group miiwan`
Expected: `collect-live-chat: N report(s) from ...` — 최근 종료 라이브가 있으면 리포트 생성, 없으면 `no candidate broadcasts`. (시크릿이 로컬에 없으면 이 단계는 CI 의 `workflow_dispatch` 로 대체.)

- [ ] **Step 3: Trigger the workflow once manually**

Run: `gh workflow run collect-live-chat.yml && sleep 5 && gh run list --workflow collect-live-chat.yml --limit 1`
Expected: run 생성·성공.

- [ ] **Step 4: Update CLAUDE.md changelog**

CLAUDE.md 상단 변경 로그에 live-ccv 항목과 동일한 형식으로 1줄 추가(버전·날짜·테이블·명령·cron·스펙/플랜 경로·테스트 통과 수). 기존 V2.38 라인을 템플릿으로 사용.

```bash
git add CLAUDE.md && git commit -m "docs(live-chat): CLAUDE.md changelog"
```

- [ ] **Step 5: Open PR**

```bash
git push -u origin feat/live-chat-sentiment
gh pr create --title "feat(live-chat): 미완소년 라이브 채팅 종료-후 긍/부정 분류 리포트" \
  --body "스펙 docs/superpowers/specs/2026-06-16-live-chat-sentiment-design.md / 플랜 docs/superpowers/plans/2026-06-16-live-chat-sentiment.md"
```

---

## Self-Review 체크 결과

- **스펙 커버리지**: 데이터모델(T1)·스크레이퍼(T2)·종료감지(T3)·분류(T4)·CLI(T5)·cron(T6)·API(T7)·UI(T8)·운영(T9) — 스펙 전 섹션 매핑됨.
- **타입 일관성**: 스크레이퍼 출력 `{msg_id, offset_ms, author, message}` → CLI raw insert·`build_report` 입력 동일 키. `build_report` 반환 `(sql, params)` 10개 컬럼 순서 = 마이그레이션 컬럼 순서 일치.
- **플레이스홀더**: cron/시크릿·프론트 시그니처·마이그레이션 적용 절차는 "기존 파일에서 확인해 맞춤"으로 명시(발명 금지). 코드 스텝은 실제 코드 포함.
