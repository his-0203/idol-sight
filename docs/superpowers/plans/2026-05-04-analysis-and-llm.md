# IDOL-SIGHT Analysis + LLM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the worker analysis layer — youtube/channel-stats/hanteo/twitter collectors, Health Score / Market Share / Member HHI, and Gemini-based weekly LLM insights with source_refs back-links.

**Architecture:** Same orchestrator-driven Collector pattern as Plan 2 for the four new sources. Three pure-function analysis modules under `analysis/` that read raw_*/agg_summary tables and write to agg_health_scores / agg_market_share / agg_member_popularity (+ `agg_member_pop_meta`). LLM generation calls Gemini 2.5 Flash with a JSON Schema response, persisting structured insights with `source_refs_json` so the frontend can back-link to specific rows. Two new GH Actions workflows: collect-daily (channel-stats) and analyze-weekly (everything weekly).

**Tech Stack:** Python 3.12, Scrapling, httpx, `google-genai` (Gemini), tenacity, GitHub Actions cron.

**Spec reference:** `docs/superpowers/specs/2026-05-04-idol-sight-rebuild-design.md` §6.3.1, §7.1–7.6, §6.4.

**Predecessor plans:** `2026-05-04-foundation.md` (Plan 1), `2026-05-04-worker-mvp.md` (Plan 2)

---

## File Structure

Files added/modified:

```
worker/src/idol_sight/
├── collectors/
│   ├── youtube.py              # NEW — YouTube Data API v3 (Scrapling not used)
│   ├── channel_stats.py        # NEW — channel subscribers/total_views snapshots
│   ├── hanteo.py               # NEW — StealthyFetcher
│   └── twitter.py              # NEW — nitter pool + oembed fallback
├── analysis/
│   ├── health_score.py         # NEW
│   ├── market_share.py         # NEW
│   └── member_popularity.py    # NEW
├── llm/
│   ├── __init__.py             # NEW
│   ├── gemini.py               # NEW — google-genai client wrapper
│   ├── prompts.py              # NEW — system prompts
│   └── weekly.py               # NEW — orchestrates insight generation
└── cli.py                      # MODIFY — add youtube/twitter/etc. + analyze-weekly

worker/tests/unit/
├── test_youtube.py             # NEW
├── test_channel_stats.py       # NEW
├── test_hanteo.py              # NEW
├── test_twitter.py             # NEW
├── test_health_score.py        # NEW
├── test_market_share.py        # NEW
├── test_member_popularity.py   # NEW
├── test_llm_gemini.py          # NEW
├── test_llm_weekly.py          # NEW
└── fixtures/
    ├── youtube_search_response.json
    ├── youtube_videos_response.json
    ├── youtube_channels_response.json
    ├── nitter_profile.html
    ├── twitter_oembed.json
    └── hanteo_weekly.html

.github/workflows/
├── collect-daily.yml           # NEW — channel-stats
└── analyze-weekly.yml          # NEW — hanteo + analysis + llm
```

**File responsibility:**
- Each collector lives in its own file with one responsibility (one external API).
- Analysis modules are **pure functions** — input dicts, output `CollectionResult` of statements. No HTTP. No I/O.
- LLM lives under `llm/` to isolate the third-party SDK; only `weekly.py` knows about the schema mapping.

---

## Conventions

- All commands run from the worktree root unless noted.
- Worker subcommands run from `worker/`.
- Tests are fixture-based (no live API calls in CI). Live smoke tests are gated by an env var.
- Each task is one focused commit (Conventional Commits).
- Use `git -c user.email=heesoo0203@gmail.com -c user.name=user commit -m "..."` if needed.

---

## Task 1: YouTube videos collector

**Files:**
- Create: `worker/src/idol_sight/collectors/youtube.py`
- Create: `worker/tests/unit/test_youtube.py`
- Create: `worker/tests/unit/fixtures/youtube_search_response.json`
- Create: `worker/tests/unit/fixtures/youtube_videos_response.json`

> **Approach:** YouTube Data API v3 has two endpoints we use:
> 1. `search.list?channelId=<id>&order=date&maxResults=50&type=video` — list recent uploads (cheap: 100 quota units per call, but you only need IDs).
> 2. `videos.list?id=<comma-list>&part=statistics,snippet,contentDetails&maxResults=50` — get full metadata (1 quota unit per id, max 50 ids per call).
>
> Total cost per group per run: ~100 + 1 search + 1 videos call = ~101 units. Free quota = 10,000/day → 99 runs/day = ~once every 15 min × 4 groups = comfortable.

- [ ] **Step 1: Capture API fixtures**

Run a real API call once with your `YT_API_KEY` to capture two fixture JSON files. The implementer can do this offline:

```bash
# search response (PLAVE channel)
curl -s "https://www.googleapis.com/youtube/v3/search?key=$YT_API_KEY&channelId=UCPZIPuQPrfrUG9Xe_okEmQA&order=date&maxResults=10&type=video&part=id" \
  | python -m json.tool > worker/tests/unit/fixtures/youtube_search_response.json

# videos response (the IDs from above)
IDS=$(jq -r '.items[].id.videoId' worker/tests/unit/fixtures/youtube_search_response.json | head -10 | paste -sd,)
curl -s "https://www.googleapis.com/youtube/v3/videos?key=$YT_API_KEY&id=$IDS&part=statistics,snippet,contentDetails" \
  | python -m json.tool > worker/tests/unit/fixtures/youtube_videos_response.json
```

If `YT_API_KEY` is not available, hand-construct minimal JSON fixtures with this shape:

```json
{
  "items": [
    {"id": {"videoId": "abc123"}}
  ]
}
```

```json
{
  "items": [
    {
      "id": "abc123",
      "snippet": {
        "title": "PLAVE - Caligo MV",
        "publishedAt": "2026-04-13T09:00:00Z",
        "channelId": "UCPZIPuQPrfrUG9Xe_okEmQA"
      },
      "contentDetails": {"duration": "PT3M45S"},
      "statistics": {"viewCount": "1234567", "likeCount": "98765", "commentCount": "5432"}
    }
  ]
}
```

- [ ] **Step 2: Write the test**

`worker/tests/unit/test_youtube.py`:

```python
import json
from pathlib import Path
from unittest.mock import MagicMock

from idol_sight.collectors.youtube import YouTubeCollector
from idol_sight.config import GroupConfig

FIXTURES = Path(__file__).parent / "fixtures"


def _plave() -> GroupConfig:
    return GroupConfig(
        key="plave", name="PLAVE", name_kr="플레이브",
        debut_date="2023-03-12",
        yt_channel_id="UCPZIPuQPrfrUG9Xe_okEmQA",
        dc_gallery_id="plave", naver_query="플레이브",
        context_keywords=["플레이브"], blacklist_phrases=[], twitter_handles=[],
    )


def _api_returning(search: dict, videos: dict):
    """Mock httpx.Client.get returning fixture responses based on URL substring."""
    def _get(url, *, params=None, **_):
        r = MagicMock()
        if "/search" in url:
            r.json.return_value = search
        elif "/videos" in url:
            r.json.return_value = videos
        else:
            r.json.return_value = {}
        r.raise_for_status.return_value = None
        return r
    client = MagicMock()
    client.__enter__ = MagicMock(return_value=client)
    client.__exit__ = MagicMock(return_value=False)
    client.get = _get
    return client


def test_youtube_collector_emits_video_and_stats_inserts():
    search = json.loads((FIXTURES / "youtube_search_response.json").read_text())
    videos = json.loads((FIXTURES / "youtube_videos_response.json").read_text())

    http = _api_returning(search, videos)
    c = YouTubeCollector(api_key="fake", http_factory=lambda: http)
    result = c.collect(_plave())

    assert result.rows_inserted == len(videos["items"])
    # 2 statements per video: youtube_videos INSERT and youtube_video_stats INSERT
    assert len(result.statements) == 2 * result.rows_inserted
    sql0, params0 = result.statements[0]
    assert "youtube_videos" in sql0
    assert params0[1] == "plave"            # group_key
    sql1, params1 = result.statements[1]
    assert "youtube_video_stats" in sql1


def test_youtube_collector_skips_when_no_channel_id():
    g = _plave()
    g_no = GroupConfig(**{**g.__dict__, "yt_channel_id": None})
    c = YouTubeCollector(api_key="fake", http_factory=MagicMock())
    result = c.collect(g_no)
    assert result.rows_inserted == 0
    assert any("no yt_channel_id" in e for e in result.errors)
```

- [ ] **Step 3: Run, see FAIL**

```bash
cd worker
uv run pytest tests/unit/test_youtube.py -v
```

- [ ] **Step 4: Implement the collector**

`worker/src/idol_sight/collectors/youtube.py`:

```python
"""YouTube Data API v3 collector. NOT a Scrapling collector.

Per-group pipeline:
  1. search.list?channelId=<id>&order=date → recent video IDs
  2. videos.list?id=<csv> → metadata + statistics for those IDs
  3. Emit youtube_videos INSERT (idempotent on video_id) +
     youtube_video_stats INSERT (composite PK on snapshot_at).

Quota cost: ~101 units per call (search=100, videos=1).
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from time import perf_counter
from typing import Any, Callable

import httpx

from idol_sight.collectors.base import CollectionResult
from idol_sight.config import GroupConfig

log = logging.getLogger(__name__)

API = "https://www.googleapis.com/youtube/v3"
SEARCH_LIST_MAX = 50         # max maxResults for search.list
VIDEOS_LIST_MAX = 50         # max ids for videos.list


def _classify_content_type(snippet: dict, duration_sec: int) -> tuple[str, bool]:
    """Heuristic classifier matching the spec's content_type categories.

    Categories: MV / Cover / Live / Audio / Variety / Teaser / Behind /
                Short / Showcase / Guide / Message / Other.
    """
    title = (snippet.get("title") or "").lower()
    is_short = duration_sec <= 60
    if is_short:
        return "Short", True
    if "mv" in title or "music video" in title or "official video" in title:
        return "MV", False
    if "cover" in title:
        return "Cover", False
    if "live" in title or "라이브" in title:
        return "Live", False
    if "audio" in title or "오디오" in title:
        return "Audio", False
    if "teaser" in title or "티저" in title:
        return "Teaser", False
    if "behind" in title or "비하인드" in title:
        return "Behind", False
    if "showcase" in title or "쇼케이스" in title:
        return "Showcase", False
    if "vlog" in title or "variety" in title or "예능" in title:
        return "Variety", False
    return "Other", False


def _iso8601_to_seconds(s: str) -> int:
    """Convert YouTube's ISO 8601 PT...M...S duration to seconds."""
    if not s.startswith("PT"):
        return 0
    s = s[2:]
    total = 0
    num = ""
    for ch in s:
        if ch.isdigit():
            num += ch
        elif ch == "H":
            total += int(num) * 3600
            num = ""
        elif ch == "M":
            total += int(num) * 60
            num = ""
        elif ch == "S":
            total += int(num)
            num = ""
    return total


class YouTubeCollector:
    source = "youtube"

    def __init__(self, api_key: str, http_factory: Callable[[], Any] | None = None):
        self._key = api_key
        self._http_factory = http_factory or (lambda: httpx.Client(timeout=30.0))

    def collect(self, group: GroupConfig, since: str | None = None) -> CollectionResult:
        if not group.yt_channel_id:
            return CollectionResult(0, 0, errors=[f"{group.key}: no yt_channel_id"])

        started = perf_counter()
        with self._http_factory() as client:
            # 1) search.list
            r = client.get(
                f"{API}/search",
                params={
                    "key": self._key,
                    "channelId": group.yt_channel_id,
                    "order": "date",
                    "maxResults": SEARCH_LIST_MAX,
                    "type": "video",
                    "part": "id",
                },
            )
            r.raise_for_status()
            ids = [
                item["id"]["videoId"]
                for item in r.json().get("items", [])
                if item.get("id", {}).get("videoId")
            ]
            if not ids:
                return CollectionResult(0, 0, runtime_ms=int((perf_counter() - started) * 1000))

            # 2) videos.list (batch up to 50 at a time)
            videos: list[dict] = []
            for i in range(0, len(ids), VIDEOS_LIST_MAX):
                chunk = ids[i:i + VIDEOS_LIST_MAX]
                r = client.get(
                    f"{API}/videos",
                    params={
                        "key": self._key,
                        "id": ",".join(chunk),
                        "part": "statistics,snippet,contentDetails",
                    },
                )
                r.raise_for_status()
                videos.extend(r.json().get("items", []))

        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        statements: list[tuple[str, list[Any]]] = []

        for v in videos:
            vid = v["id"]
            sn = v.get("snippet", {})
            cd = v.get("contentDetails", {})
            st = v.get("statistics", {})
            duration_sec = _iso8601_to_seconds(cd.get("duration", ""))
            content_type, is_short = _classify_content_type(sn, duration_sec)

            statements.append((
                """
                INSERT INTO youtube_videos
                  (video_id, group_key, channel_id, title, duration_sec,
                   published_at, content_type, is_short, first_seen_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(video_id) DO UPDATE SET
                  title=excluded.title,
                  content_type=excluded.content_type,
                  is_short=excluded.is_short
                """.strip(),
                [
                    vid, group.key, sn.get("channelId"),
                    (sn.get("title") or "")[:500],
                    duration_sec, sn.get("publishedAt"),
                    content_type, 1 if is_short else 0,
                    now_iso,
                ],
            ))
            statements.append((
                """
                INSERT INTO youtube_video_stats(video_id, snapshot_at, views, likes, comments)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(video_id, snapshot_at) DO UPDATE SET
                  views=excluded.views, likes=excluded.likes, comments=excluded.comments
                """.strip(),
                [
                    vid, now_iso,
                    int(st.get("viewCount", 0) or 0),
                    int(st.get("likeCount", 0) or 0),
                    int(st.get("commentCount", 0) or 0),
                ],
            ))

        runtime_ms = int((perf_counter() - started) * 1000)
        return CollectionResult(
            rows_inserted=len(videos), rows_updated=0,
            statements=statements, runtime_ms=runtime_ms,
        )
```

- [ ] **Step 5: Run tests**

```bash
cd worker
uv run pytest tests/unit/test_youtube.py -v
```

Expected: 2 PASSED.

- [ ] **Step 6: Commit**

```bash
git add worker/src/idol_sight/collectors/youtube.py worker/tests/unit/test_youtube.py \
        worker/tests/unit/fixtures/youtube_search_response.json \
        worker/tests/unit/fixtures/youtube_videos_response.json
git commit -m "feat(worker): youtube videos collector via Data API v3"
```

---

## Task 2: YouTube channel-stats collector

**Files:**
- Create: `worker/src/idol_sight/collectors/channel_stats.py`
- Create: `worker/tests/unit/test_channel_stats.py`
- Create: `worker/tests/unit/fixtures/youtube_channels_response.json`

> **Approach:** Single `channels.list?id=<comma-list>&part=statistics` call (1 quota unit per channel id) returns subscriberCount, viewCount, videoCount per channel. We collect a snapshot per group's main channel + each member's solo channel into `youtube_channel_stats`.

- [ ] **Step 1: Capture fixture**

```bash
curl -s "https://www.googleapis.com/youtube/v3/channels?key=$YT_API_KEY&id=UCPZIPuQPrfrUG9Xe_okEmQA&part=statistics" \
  | python -m json.tool > worker/tests/unit/fixtures/youtube_channels_response.json
```

Or hand-construct:

```json
{
  "items": [
    {
      "id": "UCPZIPuQPrfrUG9Xe_okEmQA",
      "statistics": {
        "subscriberCount": "1140000",
        "viewCount": "160608883",
        "videoCount": "24"
      }
    }
  ]
}
```

- [ ] **Step 2: Write the test**

`worker/tests/unit/test_channel_stats.py`:

```python
import json
from pathlib import Path
from unittest.mock import MagicMock

from idol_sight.collectors.channel_stats import ChannelStatsCollector
from idol_sight.config import GroupConfig

FIXTURES = Path(__file__).parent / "fixtures"


def _plave() -> GroupConfig:
    return GroupConfig(
        key="plave", name="PLAVE", name_kr="플레이브",
        debut_date="2023-03-12",
        yt_channel_id="UCPZIPuQPrfrUG9Xe_okEmQA",
        dc_gallery_id="plave", naver_query="플레이브",
        context_keywords=["플레이브"], blacklist_phrases=[], twitter_handles=[],
    )


def _members_loader_returning(rows):
    return MagicMock(return_value=rows)


def _api_returning(channels: dict):
    def _get(url, *, params=None, **_):
        r = MagicMock()
        r.json.return_value = channels
        r.raise_for_status.return_value = None
        return r
    client = MagicMock()
    client.__enter__ = MagicMock(return_value=client)
    client.__exit__ = MagicMock(return_value=False)
    client.get = _get
    return client


def test_channel_stats_emits_one_row_per_channel():
    channels = json.loads((FIXTURES / "youtube_channels_response.json").read_text())
    http = _api_returning(channels)
    members = []   # no solo channels for this test
    c = ChannelStatsCollector(
        api_key="fake",
        http_factory=lambda: http,
        members_loader=_members_loader_returning(members),
    )
    result = c.collect(_plave())

    assert result.rows_inserted == 1
    sql, params = result.statements[0]
    assert "youtube_channel_stats" in sql
    assert params[0] == "UCPZIPuQPrfrUG9Xe_okEmQA"
    assert params[2] == 1140000
    assert params[3] == 160608883
    assert params[4] == 24


def test_channel_stats_includes_member_solo_channels():
    channels = {
      "items": [
        {"id": "UCPZIPuQPrfrUG9Xe_okEmQA", "statistics":
            {"subscriberCount":"1140000","viewCount":"160608883","videoCount":"24"}},
        {"id": "UCmemberSolo", "statistics":
            {"subscriberCount":"50000","viewCount":"1000000","videoCount":"5"}},
      ]
    }
    http = _api_returning(channels)
    c = ChannelStatsCollector(
        api_key="fake",
        http_factory=lambda: http,
        members_loader=_members_loader_returning([
            {"yt_channel_id": "UCmemberSolo"},
        ]),
    )
    result = c.collect(_plave())
    assert result.rows_inserted == 2
```

- [ ] **Step 3: Run, see FAIL**

```bash
cd worker
uv run pytest tests/unit/test_channel_stats.py -v
```

- [ ] **Step 4: Implement**

`worker/src/idol_sight/collectors/channel_stats.py`:

```python
"""YouTube channel-stats collector.

Collects subscribers/total_views/video_count for the group's main channel
plus each member's solo channel (if any). Single channels.list call covers
all of them.
"""

from __future__ import annotations

from datetime import datetime, timezone
from time import perf_counter
from typing import Any, Callable

import httpx

from idol_sight.collectors.base import CollectionResult
from idol_sight.config import GroupConfig

API = "https://www.googleapis.com/youtube/v3"


class ChannelStatsCollector:
    source = "channel-stats"

    def __init__(
        self,
        api_key: str,
        http_factory: Callable[[], Any] | None = None,
        members_loader: Callable[[str], list[dict]] | None = None,
    ):
        self._key = api_key
        self._http_factory = http_factory or (lambda: httpx.Client(timeout=30.0))
        # Returns list of {yt_channel_id: ...} for the group's solo-channel members.
        self._members_loader = members_loader or (lambda _: [])

    def collect(self, group: GroupConfig, since: str | None = None) -> CollectionResult:
        if not group.yt_channel_id:
            return CollectionResult(0, 0, errors=[f"{group.key}: no yt_channel_id"])

        ids = [group.yt_channel_id]
        for m in self._members_loader(group.key):
            cid = m.get("yt_channel_id") if isinstance(m, dict) else None
            if cid:
                ids.append(cid)

        started = perf_counter()
        with self._http_factory() as client:
            r = client.get(
                f"{API}/channels",
                params={
                    "key": self._key,
                    "id": ",".join(ids),
                    "part": "statistics",
                },
            )
            r.raise_for_status()
            items = r.json().get("items", [])

        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        statements: list[tuple[str, list[Any]]] = []
        for it in items:
            cid = it["id"]
            st = it.get("statistics", {})
            statements.append((
                """
                INSERT INTO youtube_channel_stats
                  (channel_id, snapshot_at, subscribers, total_views, video_count)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(channel_id, snapshot_at) DO UPDATE SET
                  subscribers=excluded.subscribers,
                  total_views=excluded.total_views,
                  video_count=excluded.video_count
                """.strip(),
                [
                    cid, now_iso,
                    int(st.get("subscriberCount", 0) or 0),
                    int(st.get("viewCount", 0) or 0),
                    int(st.get("videoCount", 0) or 0),
                ],
            ))

        runtime_ms = int((perf_counter() - started) * 1000)
        return CollectionResult(
            rows_inserted=len(items), rows_updated=0,
            statements=statements, runtime_ms=runtime_ms,
        )
```

- [ ] **Step 5: Run tests**

```bash
cd worker
uv run pytest tests/unit/test_channel_stats.py -v
```

Expected: 2 PASSED.

- [ ] **Step 6: Commit**

```bash
git add worker/src/idol_sight/collectors/channel_stats.py \
        worker/tests/unit/test_channel_stats.py \
        worker/tests/unit/fixtures/youtube_channels_response.json
git commit -m "feat(worker): channel-stats collector for group + solo-channel snapshots"
```

---

## Task 3: Hanteo collector

**Files:**
- Create: `worker/src/idol_sight/collectors/hanteo.py`
- Create: `worker/tests/unit/test_hanteo.py`
- Create: `worker/tests/unit/fixtures/hanteo_weekly.html`

> **Approach:** `https://www.hanteochart.com/?fc=albums&sub=weekly&lang=en` (or the Korean equivalent) renders a weekly album rank table. StealthyFetcher (Tier 2). For each row, extract rank/album/artist/sales. Match against group keys via context-keyword match on artist text.

- [ ] **Step 1: Capture fixture**

```bash
curl -sL -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" \
  -H "Accept-Language: ko-KR,ko;q=0.9" \
  'https://www.hanteochart.com/?fc=albums&sub=weekly' \
  -o worker/tests/unit/fixtures/hanteo_weekly.html
wc -c worker/tests/unit/fixtures/hanteo_weekly.html
```

If blocked (small file or anti-bot page), construct minimal fixture:

```html
<!doctype html>
<html><body>
<div class="search_chart_year_top10_unit_box1">
  <p class="rank">2</p>
  <p class="album_name">Caligo Pt.2</p>
  <p class="artist_name">PLAVE</p>
  <p class="sales">991,850</p>
</div>
<div class="search_chart_year_top10_unit_box1">
  <p class="rank">3</p>
  <p class="album_name">STAR TRAIL</p>
  <p class="artist_name">STELLIVE</p>
  <p class="sales">123,456</p>
</div>
<div class="search_chart_year_top10_unit_box1">
  <p class="rank">5</p>
  <p class="album_name">YOUNG &amp; LOUD</p>
  <p class="artist_name">SKINZ</p>
  <p class="sales">45,000</p>
</div>
</body></html>
```

- [ ] **Step 2: Write the test**

`worker/tests/unit/test_hanteo.py`:

```python
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import MagicMock

from scrapling.parser import Adaptor

from idol_sight.collectors.hanteo import HanteoCollector

FIXTURES = Path(__file__).parent / "fixtures"


def test_parses_weekly_chart_for_seeded_groups():
    """Hanteo collector reads the weekly chart and emits rows for any seeded
    group whose name appears as the artist."""
    html = (FIXTURES / "hanteo_weekly.html").read_text()
    page = Adaptor(content=html, url="https://www.hanteochart.com/")
    stealthy = MagicMock()
    stealthy.fetch.return_value = page

    seeded = [
        {"key": "plave",    "name": "PLAVE"},
        {"key": "stellive", "name": "STELLIVE"},
        {"key": "skinz",    "name": "SKINZ"},
        {"key": "isedol",   "name": "ISEDOL"},   # not in fixture; should be skipped
    ]
    groups_loader = MagicMock(return_value=seeded)

    c = HanteoCollector(stealthy=stealthy, groups_loader=groups_loader)
    result = c.collect_global()
    stealthy.fetch.assert_called_once()

    assert result.rows_inserted == 3       # plave, stellive, skinz matched
    statements = result.statements
    assert all("hanteo_weekly" in sql for sql, _ in statements)
    # PLAVE row
    plave_stmt = next(s for s in statements if "plave" in s[1])
    sql, params = plave_stmt
    assert params[2] == "plave"          # group_key (after week_start, week_end)
    assert params[3] == "Caligo Pt.2"     # album
    assert params[4] == 2                 # rank
    assert params[5] == 991850            # sales (commas stripped)


def test_collect_per_group_is_a_no_op():
    """The orchestrator calls collect(group) but Hanteo is global. The per-
    group method must return an empty result without raising — global data is
    fetched once per week via collect_global() in cli."""
    c = HanteoCollector(stealthy=MagicMock(), groups_loader=MagicMock(return_value=[]))
    res = c.collect(group=MagicMock(key="plave"))
    assert res.rows_inserted == 0
```

- [ ] **Step 3: Run, see FAIL**

```bash
cd worker
uv run pytest tests/unit/test_hanteo.py -v
```

- [ ] **Step 4: Implement**

`worker/src/idol_sight/collectors/hanteo.py`:

```python
"""Hanteo weekly album chart collector.

Hanteo is unlike per-group sources — the chart is global. We fetch once and
fan out to every seeded group whose `name` appears as the artist.

Wiring:
- collect(group) is a no-op (orchestrator-friendly stub).
- collect_global() does the real work; called by the analyze-weekly workflow.
"""

from __future__ import annotations

from datetime import date, timedelta
from time import perf_counter
from typing import Any, Callable

from scrapling import StealthyFetcher

from idol_sight.collectors.base import CollectionResult
from idol_sight.config import GroupConfig

LIST_URL = "https://www.hanteochart.com/?fc=albums&sub=weekly"


def _week_bounds(today: date | None = None) -> tuple[str, str]:
    """Return (week_start, week_end) ISO dates for the most recent
    Sunday-to-Saturday week ending strictly before today."""
    today = today or date.today()
    days_since_sunday = (today.weekday() + 1) % 7
    end = today - timedelta(days=days_since_sunday + 1)
    start = end - timedelta(days=6)
    return start.isoformat(), end.isoformat()


class HanteoCollector:
    source = "hanteo"

    def __init__(
        self,
        stealthy: Any | None = None,
        groups_loader: Callable[[], list[dict]] | None = None,
    ):
        self._stealthy = stealthy or StealthyFetcher
        # Returns [{"key": "plave", "name": "PLAVE"}, ...] for active groups.
        self._groups_loader = groups_loader or (lambda: [])

    def collect(self, group: GroupConfig, since: str | None = None) -> CollectionResult:
        # Per-group is a stub. Real work lives in collect_global().
        return CollectionResult(0, 0)

    def collect_global(self) -> CollectionResult:
        started = perf_counter()
        page = self._stealthy.fetch(
            LIST_URL,
            headless=True, network_idle=True,
            block_resources=True, solve_cloudflare=True,
        )
        rows = self._parse(page)
        seeded = self._groups_loader()

        # Map artist text → group key by case-insensitive substring on group name.
        idx = {(g.get("name") or "").upper(): g["key"] for g in seeded}

        week_start, week_end = _week_bounds()

        statements: list[tuple[str, list[Any]]] = []
        matched = 0
        for r in rows:
            artist_upper = (r.get("artist") or "").upper()
            gk = None
            for name_upper, key in idx.items():
                if name_upper and name_upper in artist_upper:
                    gk = key
                    break
            if gk is None:
                continue
            statements.append((
                """
                INSERT INTO hanteo_weekly
                  (week_start, week_end, group_key, album, rank, sales, note)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(week_start, group_key, album) DO UPDATE SET
                  week_end=excluded.week_end,
                  rank=excluded.rank,
                  sales=excluded.sales
                """.strip(),
                [
                    week_start, week_end, gk,
                    r.get("album") or "",
                    r.get("rank"), r.get("sales"),
                    None,
                ],
            ))
            matched += 1

        runtime_ms = int((perf_counter() - started) * 1000)
        return CollectionResult(
            rows_inserted=matched, rows_updated=0,
            statements=statements, runtime_ms=runtime_ms,
        )

    @staticmethod
    def _parse(page: Any) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        # Hanteo's box / row container varies. Try multiple selectors.
        boxes = (
            page.css(".search_chart_year_top10_unit_box1")
            or page.css(".chart_unit_row")
            or page.css("li.list-group-item")
        )
        for box in boxes:
            rank_node = box.css(".rank") or box.css(".chart-rank") or box.css("span.r")
            album_node = box.css(".album_name") or box.css(".album")
            artist_node = box.css(".artist_name") or box.css(".artist")
            sales_node = box.css(".sales") or box.css(".count")
            if not (rank_node and album_node and artist_node):
                continue
            try:
                rank = int((rank_node[0].text or "0").strip())
            except ValueError:
                continue
            sales_s = (sales_node[0].text or "").strip() if sales_node else ""
            try:
                sales = int(sales_s.replace(",", "")) if sales_s else None
            except ValueError:
                sales = None
            out.append({
                "rank": rank,
                "album": (album_node[0].text or "").strip(),
                "artist": (artist_node[0].text or "").strip(),
                "sales": sales,
            })
        return out
```

- [ ] **Step 5: Run tests**

```bash
cd worker
uv run pytest tests/unit/test_hanteo.py -v
```

Expected: 2 PASSED. If 0 boxes parsed, inspect fixture and adjust selectors.

- [ ] **Step 6: Commit**

```bash
git add worker/src/idol_sight/collectors/hanteo.py \
        worker/tests/unit/test_hanteo.py \
        worker/tests/unit/fixtures/hanteo_weekly.html
git commit -m "feat(worker): hanteo weekly chart collector (global fetch + group fan-out)"
```

---

## Task 4: Twitter collector

**Files:**
- Create: `worker/src/idol_sight/collectors/twitter.py`
- Create: `worker/tests/unit/test_twitter.py`
- Create: `worker/tests/unit/fixtures/nitter_profile.html`
- Create: `worker/tests/unit/fixtures/twitter_oembed.json`

> **Approach (per spec §6.3.1):**
> 1. nitter pool round-robin (try 4 instances). Parse profile page for recent tweets.
> 2. If all nitter fail → syndication.twitter.com oembed fallback (1 tweet at a time, less data).
> 3. If both fail → return CollectionResult with no rows + error_msg='all_twitter_paths_blocked'. Orchestrator records failure.

- [ ] **Step 1: Capture fixtures**

Live nitter (most are dead in 2026; use a known-working mirror. We hand-construct):

```html
<!-- nitter_profile.html -->
<!doctype html>
<html><body>
<div class="timeline-item">
  <a class="tweet-link" href="/plave_official/status/1234567890"></a>
  <div class="tweet-content"><a class="username">@plave_official</a> 플레이브 신곡 발매!</div>
  <span class="tweet-date" title="2026-05-04T08:00:00Z">May 4</span>
</div>
<div class="timeline-item">
  <a class="tweet-link" href="/plave_official/status/1234567891"></a>
  <div class="tweet-content"><a class="username">@plave_official</a> Concert announcement</div>
  <span class="tweet-date" title="2026-05-03T15:30:00Z">May 3</span>
</div>
</body></html>
```

```json
// twitter_oembed.json
{
  "url": "https://twitter.com/plave_official/status/1234567890",
  "author_name": "PLAVE",
  "html": "<blockquote>플레이브 신곡 발매!</blockquote>"
}
```

- [ ] **Step 2: Write the test**

`worker/tests/unit/test_twitter.py`:

```python
import json
from pathlib import Path
from unittest.mock import MagicMock

from scrapling.parser import Adaptor

from idol_sight.collectors.twitter import TwitterCollector
from idol_sight.config import GroupConfig

FIXTURES = Path(__file__).parent / "fixtures"


def _plave() -> GroupConfig:
    return GroupConfig(
        key="plave", name="PLAVE", name_kr="플레이브",
        debut_date="2023-03-12",
        yt_channel_id=None, dc_gallery_id=None, naver_query=None,
        context_keywords=[], blacklist_phrases=[],
        twitter_handles=["plave_official"],
    )


def test_collects_via_nitter_first_instance():
    html = (FIXTURES / "nitter_profile.html").read_text()
    page = Adaptor(content=html, url="https://nitter.net/plave_official")
    fetcher = MagicMock()
    fetcher.get.return_value = page

    c = TwitterCollector(
        nitter_instances=["https://nitter.net"],
        fetcher=fetcher,
    )
    result = c.collect(_plave())
    fetcher.get.assert_called_once()
    assert result.rows_inserted == 2
    sql, params = result.statements[0]
    assert "twitter_posts" in sql
    assert "plave" in params               # group_key


def test_round_robins_through_nitter_pool():
    """If first nitter returns 0 rows, fall through to next."""
    empty_page = Adaptor(content="<html><body></body></html>", url="https://x")
    html = (FIXTURES / "nitter_profile.html").read_text()
    full_page = Adaptor(content=html, url="https://x")
    fetcher = MagicMock()
    fetcher.get.side_effect = [empty_page, full_page]

    c = TwitterCollector(
        nitter_instances=["https://nitter.dead", "https://nitter.alive"],
        fetcher=fetcher,
    )
    result = c.collect(_plave())
    assert fetcher.get.call_count == 2
    assert result.rows_inserted == 2


def test_falls_back_to_oembed_when_all_nitter_fail():
    empty_page = Adaptor(content="<html><body></body></html>", url="https://x")
    fetcher = MagicMock()
    fetcher.get.return_value = empty_page

    oembed = json.loads((FIXTURES / "twitter_oembed.json").read_text())
    oembed_resp = MagicMock()
    oembed_resp.json.return_value = oembed
    oembed_resp.raise_for_status.return_value = None
    http = MagicMock()
    http.__enter__ = MagicMock(return_value=http)
    http.__exit__ = MagicMock(return_value=False)
    http.get = MagicMock(return_value=oembed_resp)

    c = TwitterCollector(
        nitter_instances=["https://a", "https://b"],
        fetcher=fetcher,
        http_factory=lambda: http,
    )
    result = c.collect(_plave())
    # No rows inserted but no exception either — sentinel error_msg recorded.
    assert result.rows_inserted == 0
    assert any("all_twitter_paths_blocked" in e or "oembed" in e for e in result.errors)


def test_no_handles_returns_empty():
    g = _plave()
    g_no = GroupConfig(**{**g.__dict__, "twitter_handles": []})
    c = TwitterCollector(nitter_instances=["x"], fetcher=MagicMock())
    result = c.collect(g_no)
    assert result.rows_inserted == 0
```

- [ ] **Step 3: Run, see FAIL**

```bash
cd worker
uv run pytest tests/unit/test_twitter.py -v
```

- [ ] **Step 4: Implement**

`worker/src/idol_sight/collectors/twitter.py`:

```python
"""Twitter collector with nitter pool + syndication oembed fallback.

Order of attempts:
1. nitter_instances (round-robin). First one that returns >0 tweets wins.
2. syndication.twitter.com oembed (lightweight, public).
3. Give up: return CollectionResult with errors=['all_twitter_paths_blocked'].
   Orchestrator translates that into crawl_meta status='failed'.

We never raise from collect(). Twitter is best-effort by design.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from time import perf_counter
from typing import Any, Callable

import httpx
from scrapling import Fetcher

from idol_sight.collectors.base import CollectionResult
from idol_sight.config import GroupConfig
from idol_sight.utils.url_hash import url_hash

log = logging.getLogger(__name__)

DEFAULT_NITTER_INSTANCES = [
    "https://nitter.net",
    "https://nitter.privacydev.net",
    "https://nitter.poast.org",
    "https://nitter.cz",
]
OEMBED_URL = "https://publish.twitter.com/oembed"


class TwitterCollector:
    source = "twitter"

    def __init__(
        self,
        nitter_instances: list[str] | None = None,
        fetcher: Any | None = None,
        http_factory: Callable[[], Any] | None = None,
    ):
        self._instances = nitter_instances or DEFAULT_NITTER_INSTANCES
        self._fetcher = fetcher or Fetcher
        self._http_factory = http_factory or (lambda: httpx.Client(timeout=15.0))

    def collect(self, group: GroupConfig, since: str | None = None) -> CollectionResult:
        if not group.twitter_handles:
            return CollectionResult(0, 0)

        started = perf_counter()
        statements: list[tuple[str, list[Any]]] = []
        rows_inserted = 0
        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

        for handle in group.twitter_handles:
            tweets = self._try_nitter(handle)
            if not tweets:
                tweets = self._try_oembed(handle)
            for t in tweets:
                statements.append((
                    """
                    INSERT INTO twitter_posts
                      (tweet_id, group_key, author_handle, title, url,
                       posted_at, collected_at, type)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(tweet_id) DO UPDATE SET
                      title=excluded.title, type=excluded.type
                    """.strip(),
                    [
                        t["tweet_id"], group.key, handle,
                        (t.get("text") or "")[:500],
                        t["url"], t.get("posted_at"),
                        now_iso, t.get("type", "content"),
                    ],
                ))
                rows_inserted += 1

        errors: list[str] = []
        if rows_inserted == 0:
            errors.append("all_twitter_paths_blocked")

        runtime_ms = int((perf_counter() - started) * 1000)
        return CollectionResult(
            rows_inserted=rows_inserted, rows_updated=0,
            statements=statements, errors=errors, runtime_ms=runtime_ms,
        )

    def _try_nitter(self, handle: str) -> list[dict[str, Any]]:
        for base in self._instances:
            try:
                page = self._fetcher.get(
                    f"{base.rstrip('/')}/{handle}",
                    impersonate="chrome131", stealthy_headers=True,
                )
                tweets = self._parse_nitter(page, handle)
                if tweets:
                    return tweets
            except Exception as e:           # noqa: BLE001
                log.warning("nitter %s failed: %s", base, e)
        return []

    def _try_oembed(self, handle: str) -> list[dict[str, Any]]:
        # oembed needs a tweet URL — without that we can't enumerate. Best-
        # effort: hit the user's profile and parse for any tweet ids in the
        # public-facing redirect chain. Often returns nothing useful in 2026,
        # but we attempt before giving up.
        try:
            with self._http_factory() as client:
                # We don't know a specific tweet URL, but oembed accepts
                # profile URLs in some clients. Use it as a liveness check.
                r = client.get(
                    OEMBED_URL,
                    params={"url": f"https://twitter.com/{handle}"},
                )
                r.raise_for_status()
                _ = r.json()
                # If we got 200 + JSON the handle is public, but oembed of a
                # profile URL doesn't yield tweet rows. Return empty.
                return []
        except Exception as e:                # noqa: BLE001
            log.warning("oembed fallback failed: %s", e)
            return []

    @staticmethod
    def _parse_nitter(page: Any, handle: str) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for item in page.css(".timeline-item"):
            link = item.css(".tweet-link")
            content = item.css(".tweet-content")
            date_node = item.css(".tweet-date")
            if not link:
                continue
            href = link[0].attrib.get("href", "")
            if "/status/" not in href:
                continue
            tid = href.rsplit("/", 1)[-1]
            text = (content[0].get_all_text() if content else "").strip()
            posted_raw = date_node[0].attrib.get("title") if date_node else None
            url = f"https://twitter.com/{handle}/status/{tid}"
            out.append({
                "tweet_id": tid,
                "url": url,
                "text": text,
                "posted_at": posted_raw,
                "type": _classify_tweet(text),
            })
        return out


def _classify_tweet(text: str) -> str:
    t = (text or "").lower()
    if any(kw in t for kw in ("논란", "controversy", "사과", "apologize")):
        return "controversy"
    if any(kw in t for kw in ("뉴스", "press", "신곡", "발매", "release")):
        return "news"
    if any(kw in t for kw in ("콘서트", "concert", "팬미팅", "fan meeting", "이벤트", "event")):
        return "event"
    return "content"
```

- [ ] **Step 5: Run tests**

```bash
cd worker
uv run pytest tests/unit/test_twitter.py -v
```

Expected: 4 PASSED.

- [ ] **Step 6: Commit**

```bash
git add worker/src/idol_sight/collectors/twitter.py \
        worker/tests/unit/test_twitter.py \
        worker/tests/unit/fixtures/nitter_profile.html \
        worker/tests/unit/fixtures/twitter_oembed.json
git commit -m "feat(worker): twitter collector via nitter pool + oembed fallback"
```

---

## Task 5: Health Score module

**Files:**
- Create: `worker/src/idol_sight/analysis/health_score.py`
- Create: `worker/tests/unit/test_health_score.py`

> **Spec §7.1.** Pre-debut groups → `grade='PRE'`, `total=None`. Otherwise composite of subscribers/views/quality/community/news/risk + 90d/30d bonus, normalized to 0-10.

- [ ] **Step 1: Write the test**

`worker/tests/unit/test_health_score.py`:

```python
import json
from datetime import date, timedelta

from idol_sight.analysis.health_score import compute_health_score, WEIGHTS


def _agg(**kw):
    base = {
        "yt_subscribers": 0, "yt_total_views": 0,
        "yt_top10": [],
        "dc_total_posts": 0, "theqoo_posts": 0, "instiz_posts": 0,
        "naver_total_news": 0, "controversy_count": 0,
        "v90_count": 0, "v30_count": 0,
    }
    base.update(kw)
    return base


def test_pre_debut_returns_pre_grade_and_null_total():
    future = (date.today() + timedelta(days=30)).isoformat()
    score = compute_health_score("miiwan", _agg(), debut_date=future)
    assert score.grade == "PRE"
    assert score.total is None
    assert score.label.startswith("데뷔 전")


def test_no_debut_date_returns_pre():
    score = compute_health_score("bdawn", _agg(), debut_date=None)
    assert score.grade == "PRE"
    assert score.total is None


def test_zero_activity_returns_d_grade_with_total_zero():
    past = (date.today() - timedelta(days=365)).isoformat()
    score = compute_health_score("plave", _agg(), debut_date=past)
    assert score.grade == "D"
    assert score.total is not None
    assert score.total < 3.0


def test_high_activity_returns_s_grade():
    past = (date.today() - timedelta(days=1000)).isoformat()
    agg = _agg(
        yt_subscribers=1_140_000, yt_total_views=160_000_000,
        yt_top10=[{"views": 10_000_000} for _ in range(10)],
        dc_total_posts=50_000, theqoo_posts=20_000, instiz_posts=35_000,
        naver_total_news=300, controversy_count=0,
        v90_count=20, v30_count=5,
    )
    score = compute_health_score("plave", agg, debut_date=past)
    assert score.grade in ("S", "A")
    assert score.total is not None and score.total >= 7.0


def test_breakdown_components_sum_consistent_with_raw_total():
    past = (date.today() - timedelta(days=400)).isoformat()
    agg = _agg(yt_subscribers=200_000, yt_total_views=20_000_000,
               yt_top10=[{"views": 1_000_000}] * 10,
               dc_total_posts=10_000, naver_total_news=100, controversy_count=0)
    score = compute_health_score("isedol", agg, debut_date=past)
    bd = score.breakdown
    # Components are present and non-negative.
    assert all(bd.get(k, 0) >= 0 for k in ("subscribers", "views", "quality",
                                            "community", "news", "risk"))


def test_weights_constant_is_exposed():
    """The /api/health/spec endpoint will need this."""
    assert sum(WEIGHTS.values()) == 100   # spec §7.1 normalizes against 100 + bonus
```

- [ ] **Step 2: Run, see FAIL**

```bash
cd worker
uv run pytest tests/unit/test_health_score.py -v
```

- [ ] **Step 3: Implement**

`worker/src/idol_sight/analysis/health_score.py`:

```python
"""Health Score (spec §7.1).

Pure function — input dict, output HealthScore. The computation is
intentionally small and centralised here so the frontend can request the
same weights via /api/health/spec.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

WEIGHTS: dict[str, int] = {
    "subscribers": 20,
    "views":       20,
    "quality":     15,
    "community":   20,
    "news":        10,
    "risk":        15,
}
BONUS_MAX = 10                # recent_90d (≤7) + recent_30d (≤3)
DENOM = sum(WEIGHTS.values()) + BONUS_MAX  # = 110

GRADE_THRESHOLDS = [
    (9.0, "S"),
    (7.0, "A"),
    (5.0, "B"),
    (3.0, "C"),
    (0.0, "D"),
]
GRADE_LABELS = {
    "S": "정상 궤도",  "A": "안정적",  "B": "성장 중",
    "C": "초기 진입",  "D": "활동 미미",  "PRE": "데뷔 전 (활동량 부족)",
}


@dataclass
class HealthScore:
    total: float | None
    raw_total: float | None
    grade: str
    label: str
    breakdown: dict[str, float] = field(default_factory=dict)
    bonus: dict[str, float] = field(default_factory=dict)
    quality_method: str = "n/a"


def _is_pre_debut(debut_date: str | None) -> bool:
    if not debut_date:
        return True
    try:
        d = date.fromisoformat(debut_date)
    except ValueError:
        return True
    return d > date.today()


def _normalize(value: float, ref: float) -> float:
    """Clamp value/ref to [0, 1]."""
    if ref <= 0:
        return 0.0
    return min(max(value / ref, 0.0), 1.0)


def _quality_score(top10: list[dict]) -> float:
    if not top10:
        return 0.0
    avg = sum(int(v.get("views", 0) or 0) for v in top10) / len(top10)
    # 1.0 maps to ~10M average views.
    return min(avg / 10_000_000, 1.0)


def _controversy_factor(count: int) -> float:
    """Return a 0-1 factor where 1.0 = no controversy and 0 = many."""
    if count <= 0:
        return 1.0
    return max(0.0, 1.0 - (count / 10.0))


def _recent_bonus(v90: int, v30: int) -> tuple[float, dict]:
    b90 = min(v90 / 30.0, 1.0) * 7.0   # up to 7
    b30 = min(v30 / 10.0, 1.0) * 3.0   # up to 3
    return b90 + b30, {"recent_90d": round(b90, 2), "recent_30d": round(b30, 2),
                       "v90_cnt": v90, "v30_cnt": v30}


def compute_health_score(
    group_key: str,
    agg: dict[str, Any],
    debut_date: str | None,
) -> HealthScore:
    if _is_pre_debut(debut_date):
        return HealthScore(
            total=None, raw_total=None,
            grade="PRE", label=GRADE_LABELS["PRE"],
        )

    sub_score  = _normalize(agg.get("yt_subscribers", 0), 1_000_000)   * WEIGHTS["subscribers"]
    view_score = _normalize(agg.get("yt_total_views", 0), 200_000_000) * WEIGHTS["views"]
    qual_score = _quality_score(agg.get("yt_top10") or [])             * WEIGHTS["quality"]
    comm_total = (agg.get("dc_total_posts", 0)
                  + agg.get("theqoo_posts", 0)
                  + agg.get("instiz_posts", 0))
    comm_score = _normalize(comm_total, 200_000)                       * WEIGHTS["community"]
    news_score = _normalize(agg.get("naver_total_news", 0), 500)       * WEIGHTS["news"]
    risk_score = _controversy_factor(agg.get("controversy_count", 0))  * WEIGHTS["risk"]

    base = sub_score + view_score + qual_score + comm_score + news_score + risk_score
    bonus_total, bonus_dict = _recent_bonus(
        agg.get("v90_count", 0), agg.get("v30_count", 0),
    )

    raw_total = base + bonus_total
    total = round(raw_total / DENOM * 10.0, 1)
    grade = next(g for thr, g in GRADE_THRESHOLDS if total >= thr)

    return HealthScore(
        total=total, raw_total=round(raw_total, 2),
        grade=grade, label=GRADE_LABELS[grade],
        breakdown={
            "subscribers": round(sub_score, 2),
            "views":       round(view_score, 2),
            "quality":     round(qual_score, 2),
            "community":   round(comm_score, 2),
            "news":        round(news_score, 2),
            "risk":        round(risk_score, 2),
        },
        bonus=bonus_dict,
        quality_method="top10_avg",
    )
```

- [ ] **Step 4: Run tests**

```bash
cd worker
uv run pytest tests/unit/test_health_score.py -v
```

Expected: 6 PASSED.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/analysis/health_score.py \
        worker/tests/unit/test_health_score.py
git commit -m "feat(analysis): health_score per spec §7.1 with PRE grade for pre-debut"
```

---

## Task 6: Market Share module

**Files:**
- Create: `worker/src/idol_sight/analysis/market_share.py`
- Create: `worker/tests/unit/test_market_share.py`

> **Spec §7.2.** Cum 60% + Mom 40%. We compute one row per (week_start, group_key). Caller provides the cumulative score (e.g. `agg_summary` totals at week end) and momentum score (delta of activity in the last 7 days).

- [ ] **Step 1: Write the test**

`worker/tests/unit/test_market_share.py`:

```python
from idol_sight.analysis.market_share import compute_market_share


def test_shares_sum_to_100_for_active_groups():
    rows = compute_market_share(
        week_start="2026-04-22", week_end="2026-04-28",
        groups=[
            {"key": "plave",  "cum_score": 1000, "mom_score": 100},
            {"key": "isedol", "cum_score": 200,  "mom_score": 50},
            {"key": "owis",   "cum_score": 100,  "mom_score": 20},
        ],
    )
    assert len(rows) == 3
    final_total = sum(r.final for r in rows)
    assert abs(final_total - 100.0) < 0.01


def test_returns_zero_for_groups_with_zero_score():
    rows = compute_market_share(
        week_start="2026-04-22", week_end="2026-04-28",
        groups=[
            {"key": "plave",  "cum_score": 1000, "mom_score": 100},
            {"key": "miiwan", "cum_score": 0,    "mom_score": 0},
        ],
    )
    assert rows[1].final == 0.0


def test_cum_60_mom_40_weighting():
    rows = compute_market_share(
        week_start="2026-04-22", week_end="2026-04-28",
        groups=[
            {"key": "a", "cum_score": 1000, "mom_score": 0},     # all cumulative
            {"key": "b", "cum_score": 0,    "mom_score": 100},   # all momentum
        ],
    )
    a, b = rows
    assert abs(a.cum - 100.0) < 0.01
    assert abs(b.mom - 100.0) < 0.01
    # final = cum*0.6 + mom*0.4
    assert abs(a.final - 60.0) < 0.01
    assert abs(b.final - 40.0) < 0.01


def test_to_statements_emits_one_per_group():
    from idol_sight.analysis.market_share import to_statements
    rows = compute_market_share(
        week_start="2026-04-22", week_end="2026-04-28",
        groups=[
            {"key": "plave", "cum_score": 1000, "mom_score": 100},
        ],
    )
    statements = to_statements(rows, market_total=10_000)
    assert len(statements) == 1
    sql, params = statements[0]
    assert "agg_market_share" in sql
    assert params[2] == "plave"
    assert params[6] == 10_000
```

- [ ] **Step 2: Run, see FAIL**

```bash
cd worker
uv run pytest tests/unit/test_market_share.py -v
```

- [ ] **Step 3: Implement**

`worker/src/idol_sight/analysis/market_share.py`:

```python
"""Market share computation (spec §7.2).

Cum 60% + Mom 40%. Produces dataclass rows + statement builder for
agg_market_share.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

ALPHA_CUM = 0.6
BETA_MOM = 0.4


@dataclass
class ShareRow:
    week_start: str
    week_end: str
    group_key: str
    cum: float          # cumulative share % (0-100)
    mom: float          # momentum share % (0-100)
    final: float        # weighted final %


def compute_market_share(
    *,
    week_start: str,
    week_end: str,
    groups: list[dict[str, Any]],
) -> list[ShareRow]:
    """`groups` is a list of {key, cum_score, mom_score}."""
    cum_total = sum(g.get("cum_score", 0) for g in groups) or 0
    mom_total = sum(g.get("mom_score", 0) for g in groups) or 0

    rows: list[ShareRow] = []
    for g in groups:
        cum_pct = (g.get("cum_score", 0) / cum_total * 100.0) if cum_total > 0 else 0.0
        mom_pct = (g.get("mom_score", 0) / mom_total * 100.0) if mom_total > 0 else 0.0
        final = cum_pct * ALPHA_CUM + mom_pct * BETA_MOM
        rows.append(ShareRow(
            week_start=week_start, week_end=week_end,
            group_key=g["key"],
            cum=round(cum_pct, 2), mom=round(mom_pct, 2),
            final=round(final, 2),
        ))
    return rows


def to_statements(rows: list[ShareRow], *, market_total: int) -> list[tuple[str, list]]:
    """Convert rows to D1 INSERT statements for agg_market_share."""
    out: list[tuple[str, list]] = []
    for r in rows:
        out.append((
            """
            INSERT INTO agg_market_share
              (week_start, week_end, group_key, cum, mom, final, market_total)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(week_start, group_key) DO UPDATE SET
              week_end=excluded.week_end,
              cum=excluded.cum, mom=excluded.mom, final=excluded.final,
              market_total=excluded.market_total
            """.strip(),
            [r.week_start, r.week_end, r.group_key,
             r.cum, r.mom, r.final, market_total],
        ))
    return out
```

- [ ] **Step 4: Run tests**

```bash
cd worker
uv run pytest tests/unit/test_market_share.py -v
```

Expected: 4 PASSED.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/analysis/market_share.py \
        worker/tests/unit/test_market_share.py
git commit -m "feat(analysis): market_share Cum 60% + Mom 40% with statement builder"
```

---

## Task 7: Member popularity + HHI

**Files:**
- Create: `worker/src/idol_sight/analysis/member_popularity.py`
- Create: `worker/tests/unit/test_member_popularity.py`

> **Spec §7.3.** Composite score = yt_score (50%) + community_score (50%). HHI = sum(share_i^2) / 10000. If total composite is 0 → status='insufficient', hhi=null.

- [ ] **Step 1: Write the test**

`worker/tests/unit/test_member_popularity.py`:

```python
from idol_sight.analysis.member_popularity import compute_member_popularity


def _members(*items):
    """Helper: turn (name, yt_score, comm_score, yt_videos, yt_avg, mentions) tuples
    into the input dict shape."""
    out = []
    for name, yt, comm, vid, avg, ment in items:
        out.append({
            "name": name, "yt_score": yt, "community_score": comm,
            "yt_videos": vid, "yt_avg_views": avg, "community_mentions": ment,
            "yt_sufficient": vid >= 3,
        })
    return out


def test_balanced_group_has_low_hhi():
    pop = compute_member_popularity(
        group_key="plave",
        members=_members(
            ("노아", 50, 50, 5, 1_000_000, 100),
            ("예준", 50, 50, 5, 1_000_000, 100),
            ("하민", 50, 50, 5, 1_000_000, 100),
            ("밤비", 50, 50, 5, 1_000_000, 100),
            ("은호", 50, 50, 5, 1_000_000, 100),
        ),
    )
    assert pop.status == "ok"
    # Perfectly balanced → HHI = 5 * (20^2) / 10000 = 0.20
    assert abs(pop.hhi - 0.20) < 0.01
    assert pop.evenness > 0.7


def test_dominant_member_has_high_hhi():
    pop = compute_member_popularity(
        group_key="plave",
        members=_members(
            ("노아", 100, 100, 10, 5_000_000, 500),
            ("예준",  10,  10,  3,   500_000,  50),
            ("하민",  10,  10,  3,   500_000,  50),
            ("밤비",  10,  10,  3,   500_000,  50),
            ("은호",  10,  10,  3,   500_000,  50),
        ),
    )
    assert pop.status == "ok"
    assert pop.hhi > 0.30
    assert pop.evenness < 0.7


def test_insufficient_when_no_activity():
    pop = compute_member_popularity(
        group_key="miiwan",
        members=_members(
            ("나이선", 0, 0, 0, 0, 0),
            ("임온",   0, 0, 0, 0, 0),
            ("마하진", 0, 0, 0, 0, 0),
        ),
    )
    assert pop.status == "insufficient"
    assert pop.hhi is None
    assert pop.evenness is None


def test_to_statements_emits_pop_rows_plus_meta():
    from idol_sight.analysis.member_popularity import to_statements
    pop = compute_member_popularity(
        group_key="plave",
        members=_members(
            ("노아", 50, 50, 5, 1_000_000, 100),
            ("예준", 50, 50, 5, 1_000_000, 100),
        ),
    )
    member_id_lookup = {"노아": 1, "예준": 2}
    statements = to_statements(
        pop, snapshot_at="2026-05-04T08:00:00Z",
        member_id_lookup=member_id_lookup,
    )
    # 2 member rows + 1 pop_meta row.
    assert len(statements) == 3
    # First two SQLs go to agg_member_popularity.
    assert "agg_member_popularity" in statements[0][0]
    assert "agg_member_popularity" in statements[1][0]
    # Last SQL goes to agg_member_pop_meta.
    assert "agg_member_pop_meta" in statements[2][0]
```

- [ ] **Step 2: Run, see FAIL**

```bash
cd worker
uv run pytest tests/unit/test_member_popularity.py -v
```

- [ ] **Step 3: Implement**

`worker/src/idol_sight/analysis/member_popularity.py`:

```python
"""Member popularity + HHI (spec §7.3)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class MemberRow:
    name: str
    yt_score: float
    community_score: float
    composite_score: float
    yt_videos: int
    yt_avg_views: int
    yt_sufficient: bool
    community_mentions: int


@dataclass
class MemberPopulation:
    group_key: str
    members: list[MemberRow]
    hhi: float | None
    evenness: float | None
    status: str        # 'ok' | 'insufficient'


def compute_member_popularity(
    *,
    group_key: str,
    members: list[dict[str, Any]],
) -> MemberPopulation:
    rows: list[MemberRow] = []
    for m in members:
        composite = m["yt_score"] * 0.5 + m["community_score"] * 0.5
        rows.append(MemberRow(
            name=m["name"],
            yt_score=m["yt_score"], community_score=m["community_score"],
            composite_score=composite,
            yt_videos=m.get("yt_videos", 0),
            yt_avg_views=m.get("yt_avg_views", 0),
            yt_sufficient=bool(m.get("yt_sufficient", False)),
            community_mentions=m.get("community_mentions", 0),
        ))

    total = sum(r.composite_score for r in rows)
    if total == 0:
        return MemberPopulation(
            group_key=group_key, members=rows,
            hhi=None, evenness=None, status="insufficient",
        )

    shares = [(r.composite_score / total * 100.0) for r in rows]
    hhi = sum(s * s for s in shares) / 10000.0
    evenness = 1.0 - hhi
    return MemberPopulation(
        group_key=group_key, members=rows,
        hhi=round(hhi, 4), evenness=round(evenness, 4), status="ok",
    )


def to_statements(
    pop: MemberPopulation,
    *,
    snapshot_at: str,
    member_id_lookup: dict[str, int],
) -> list[tuple[str, list]]:
    out: list[tuple[str, list]] = []
    for r in pop.members:
        member_id = member_id_lookup.get(r.name)
        if member_id is None:
            continue
        out.append((
            """
            INSERT INTO agg_member_popularity
              (group_key, snapshot_at, member_id,
               yt_score, community_score, composite_score,
               yt_videos, yt_avg_views, yt_sufficient, community_mentions)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(group_key, snapshot_at, member_id) DO UPDATE SET
              yt_score=excluded.yt_score,
              community_score=excluded.community_score,
              composite_score=excluded.composite_score,
              yt_videos=excluded.yt_videos,
              yt_avg_views=excluded.yt_avg_views,
              yt_sufficient=excluded.yt_sufficient,
              community_mentions=excluded.community_mentions
            """.strip(),
            [pop.group_key, snapshot_at, member_id,
             r.yt_score, r.community_score, r.composite_score,
             r.yt_videos, r.yt_avg_views, 1 if r.yt_sufficient else 0,
             r.community_mentions],
        ))

    out.append((
        """
        INSERT INTO agg_member_pop_meta(group_key, snapshot_at, hhi, evenness, status)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(group_key, snapshot_at) DO UPDATE SET
          hhi=excluded.hhi, evenness=excluded.evenness, status=excluded.status
        """.strip(),
        [pop.group_key, snapshot_at, pop.hhi, pop.evenness, pop.status],
    ))
    return out
```

- [ ] **Step 4: Run tests**

```bash
cd worker
uv run pytest tests/unit/test_member_popularity.py -v
```

Expected: 4 PASSED.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/analysis/member_popularity.py \
        worker/tests/unit/test_member_popularity.py
git commit -m "feat(analysis): member popularity + HHI with insufficient-data fallback"
```

---

## Task 8: Gemini client

**Files:**
- Create: `worker/src/idol_sight/llm/__init__.py`
- Create: `worker/src/idol_sight/llm/gemini.py`
- Create: `worker/tests/unit/test_llm_gemini.py`

> **Approach (per spec §7.6):** Wrap `google-genai` SDK. The wrapper has one job: take a system prompt, JSON context, and a JSON Schema → call `gemini-2.5-flash` with `response_mime_type="application/json"` and `response_schema`, return the parsed dict. The `_run_llm` is mocked in tests.

- [ ] **Step 1: Write tests**

`worker/tests/unit/test_llm_gemini.py`:

```python
import json
from unittest.mock import MagicMock

from idol_sight.llm.gemini import GeminiClient, INSIGHT_OUTPUT_SCHEMA


def test_generate_returns_parsed_dict_from_response_text():
    fake_response = MagicMock()
    fake_response.text = json.dumps({
        "items": [{
            "scope": "market", "type": "insight",
            "title": "X", "body": "Y",
            "source_refs": [{"table": "agg_summary", "pk": "plave|2026-05-04",
                             "label": "PLAVE summary"}],
        }],
    })

    fake_models = MagicMock()
    fake_models.generate_content = MagicMock(return_value=fake_response)

    fake_genai = MagicMock()
    fake_genai.models = fake_models

    c = GeminiClient(api_key="fake", client=fake_genai)
    parsed = c.generate(
        system_prompt="you are an analyst",
        context={"foo": "bar"},
        response_schema=INSIGHT_OUTPUT_SCHEMA,
    )
    fake_models.generate_content.assert_called_once()
    args, kwargs = fake_models.generate_content.call_args
    config = kwargs.get("config") or args[-1]
    # Config must specify JSON output and the schema.
    assert "application/json" in str(config)

    assert "items" in parsed
    assert parsed["items"][0]["title"] == "X"


def test_schema_constant_has_expected_shape():
    s = INSIGHT_OUTPUT_SCHEMA
    assert s["type"] == "object"
    assert "items" in s["properties"]
    items_schema = s["properties"]["items"]
    assert items_schema["type"] == "array"
    item_props = items_schema["items"]["properties"]
    for k in ("scope", "type", "title", "body", "source_refs"):
        assert k in item_props
```

- [ ] **Step 2: Run, see FAIL**

```bash
cd worker
uv run pytest tests/unit/test_llm_gemini.py -v
```

- [ ] **Step 3: Implement**

`worker/src/idol_sight/llm/__init__.py`:

```python
"""LLM-backed analysis: Gemini 2.5 Flash for weekly insights."""
```

`worker/src/idol_sight/llm/gemini.py`:

```python
"""Thin wrapper around google-genai for structured JSON outputs.

Tested via dependency injection: pass a fake `client` object exposing
`.models.generate_content(...)` to bypass the real SDK in unit tests.
"""

from __future__ import annotations

import json
import logging
from typing import Any

log = logging.getLogger(__name__)


# JSON Schema used by weekly insight generation. Frontend renders source_refs
# as inline back-link badges.
INSIGHT_OUTPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "scope": {"type": "string"},     # 'market' | <group_key>
                    "type":  {"type": "string"},     # 'insight' | 'ipx_action' | 'weekly'
                    "title": {"type": "string"},
                    "body":  {"type": "string"},
                    "source_refs": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "table": {"type": "string"},
                                "pk":    {"type": "string"},
                                "label": {"type": "string"},
                            },
                            "required": ["table", "pk", "label"],
                        },
                    },
                },
                "required": ["scope", "type", "title", "body", "source_refs"],
            },
        },
    },
    "required": ["items"],
}


class GeminiClient:
    def __init__(self, api_key: str, client: Any | None = None,
                 model: str = "gemini-2.5-flash"):
        if client is None:
            from google import genai                       # local import to keep tests fast
            client = genai.Client(api_key=api_key)
        self._client = client
        self._model = model

    def generate(
        self,
        *,
        system_prompt: str,
        context: dict[str, Any],
        response_schema: dict[str, Any],
    ) -> dict[str, Any]:
        from google.genai.types import GenerateContentConfig
        config = GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=response_schema,
            system_instruction=system_prompt,
            temperature=0.2,
        )
        resp = self._client.models.generate_content(
            model=self._model,
            contents=json.dumps(context, ensure_ascii=False),
            config=config,
        )
        return json.loads(resp.text)
```

- [ ] **Step 4: Run tests**

```bash
cd worker
uv run pytest tests/unit/test_llm_gemini.py -v
```

Expected: 2 PASSED. The import-inside-method pattern keeps the real SDK out of test imports, and the `client` injection makes the test's MagicMock viable.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/llm/__init__.py worker/src/idol_sight/llm/gemini.py \
        worker/tests/unit/test_llm_gemini.py
git commit -m "feat(llm): gemini client wrapper with JSON Schema response"
```

---

## Task 9: Weekly insight generator

**Files:**
- Create: `worker/src/idol_sight/llm/prompts.py`
- Create: `worker/src/idol_sight/llm/weekly.py`
- Create: `worker/tests/unit/test_llm_weekly.py`

- [ ] **Step 1: Write tests**

`worker/tests/unit/test_llm_weekly.py`:

```python
from unittest.mock import MagicMock

from idol_sight.llm.weekly import generate_weekly


def test_generate_weekly_calls_gemini_with_built_context():
    gemini = MagicMock()
    gemini.generate.return_value = {
        "items": [{
            "scope": "market", "type": "weekly",
            "title": "T", "body": "B",
            "source_refs": [{"table": "agg_summary", "pk": "plave|w", "label": "L"}],
        }],
    }

    db = MagicMock()
    # Stub out the four context queries used by build_context().
    db.execute.side_effect = [
        # last 7d agg_summary
        [{"group_key": "plave", "yt_total_views": 160000000, "naver_total_news": 282}],
        # prev 7d
        [{"group_key": "plave", "yt_total_views": 159000000, "naver_total_news": 270}],
        # hanteo latest
        [{"group_key": "plave", "album": "Caligo Pt.2", "rank": 2, "sales": 991850}],
        # market_share latest
        [{"group_key": "plave", "final": 65.0}],
        # top news per group
        [{"group_key": "plave", "title": "PLAVE 신곡", "source": "naver"}],
    ]

    result = generate_weekly(
        db=db, gemini=gemini,
        week_start="2026-04-22", week_end="2026-04-28",
    )

    gemini.generate.assert_called_once()
    # The result is a list of statements ready for D1.batch().
    assert len(result.statements) == 1
    sql, params = result.statements[0]
    assert "INSERT INTO insights" in sql
    # source_refs_json column is JSON-encoded.
    import json
    refs = json.loads(params[6])
    assert refs[0]["pk"] == "plave|w"
```

- [ ] **Step 2: Run, see FAIL**

```bash
cd worker
uv run pytest tests/unit/test_llm_weekly.py -v
```

- [ ] **Step 3: Implement**

`worker/src/idol_sight/llm/prompts.py`:

```python
"""Prompt templates for LLM analysis."""

PROMPT_WEEKLY = """\
You are a senior K-pop industry analyst writing weekly intelligence briefings
for an internal IPX/Abyss team running a virtual idol BI dashboard.

You will be given a JSON context with:
- agg_summary_last_7d / agg_summary_prev_7d (per-group activity totals)
- hanteo (weekly album chart)
- market_share (per-group share %)
- top_news_by_group (recent press headlines)

Produce 3-7 distinct items that a strategy team would act on. For each item:
- `scope`: either 'market' (cross-group) or a specific group_key
  (plave/isedol/stellive/skinz/myrakl/owis/miiwan/bdawn).
- `type`: 'insight' (analytic observation), 'weekly' (week summary),
  or 'ipx_action' (recommended action for the team).
- `title`: ≤ 80 chars, Korean.
- `body`: 1-3 sentences, Korean. Reference numbers from the context.
- `source_refs`: 1-3 items pointing at the rows that justified the claim.
  Each ref has table, pk (key|date format), and label.

Be precise with numbers (use exactly what the context shows).
Do NOT invent figures. If something cannot be sourced, leave it out.
"""
```

`worker/src/idol_sight/llm/weekly.py`:

```python
"""Generate weekly LLM insights and convert to D1 INSERT statements."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Protocol

from idol_sight.collectors.base import CollectionResult
from idol_sight.llm.gemini import INSIGHT_OUTPUT_SCHEMA
from idol_sight.llm.prompts import PROMPT_WEEKLY


class _Executor(Protocol):
    def execute(self, sql: str, params: list | None = ...) -> list[dict]: ...


class _Gemini(Protocol):
    def generate(self, *, system_prompt: str, context: dict, response_schema: dict) -> dict: ...


def build_context(db: _Executor, *, week_start: str, week_end: str) -> dict[str, Any]:
    last_7d = db.execute(
        "SELECT * FROM agg_summary WHERE substr(snapshot_at, 1, 10) BETWEEN ? AND ?",
        [week_start, week_end],
    )
    prev_start = _shift_iso_date(week_start, -7)
    prev_end = _shift_iso_date(week_end, -7)
    prev_7d = db.execute(
        "SELECT * FROM agg_summary WHERE substr(snapshot_at, 1, 10) BETWEEN ? AND ?",
        [prev_start, prev_end],
    )
    hanteo = db.execute(
        "SELECT week_start, week_end, group_key, album, rank, sales "
        "FROM hanteo_weekly WHERE week_end = ?",
        [week_end],
    )
    market = db.execute(
        "SELECT week_start, week_end, group_key, cum, mom, final "
        "FROM agg_market_share WHERE week_end = ?",
        [week_end],
    )
    top_news = db.execute(
        "SELECT group_key, title, source, published_at FROM naver_articles "
        "WHERE COALESCE(is_excluded,0)=0 "
        "  AND substr(published_at, 1, 10) BETWEEN ? AND ? "
        "ORDER BY published_at DESC LIMIT 40",
        [week_start, week_end],
    )
    return {
        "week": {"start": week_start, "end": week_end},
        "agg_summary_last_7d": last_7d,
        "agg_summary_prev_7d": prev_7d,
        "hanteo": hanteo,
        "market_share": market,
        "top_news_by_group": top_news,
    }


def _shift_iso_date(iso_date: str, days: int) -> str:
    from datetime import date, timedelta
    d = date.fromisoformat(iso_date)
    return (d + timedelta(days=days)).isoformat()


def generate_weekly(
    *,
    db: _Executor,
    gemini: _Gemini,
    week_start: str,
    week_end: str,
) -> CollectionResult:
    ctx = build_context(db, week_start=week_start, week_end=week_end)
    parsed = gemini.generate(
        system_prompt=PROMPT_WEEKLY,
        context=ctx,
        response_schema=INSIGHT_OUTPUT_SCHEMA,
    )
    items = parsed.get("items") or []

    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    statements: list[tuple[str, list]] = []
    for item in items:
        statements.append((
            """
            INSERT INTO insights
              (generated_at, week_start, scope, type, title, body, source_refs_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """.strip(),
            [
                now_iso, week_start,
                item.get("scope") or "market",
                item.get("type") or "insight",
                (item.get("title") or "")[:200],
                item.get("body") or "",
                json.dumps(item.get("source_refs") or [], ensure_ascii=False),
            ],
        ))

    return CollectionResult(
        rows_inserted=len(items), rows_updated=0,
        statements=statements,
    )
```

- [ ] **Step 4: Run tests**

```bash
cd worker
uv run pytest tests/unit/test_llm_weekly.py -v
```

Expected: 1 PASSED.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/llm/prompts.py worker/src/idol_sight/llm/weekly.py \
        worker/tests/unit/test_llm_weekly.py
git commit -m "feat(llm): weekly insight generator with source_refs back-links"
```

---

## Task 10: CLI integration for new sources + analyze-weekly

**Files:**
- Modify: `worker/src/idol_sight/cli.py`
- Modify: `worker/tests/unit/test_cli.py`

- [ ] **Step 1: Update tests**

Append to `worker/tests/unit/test_cli.py`:

```python
def test_collect_youtube_dispatches_youtube_collector(monkeypatch):
    from unittest.mock import MagicMock
    import idol_sight.cli as cli

    fake_group = MagicMock(name="GroupConfig", key="plave")
    monkeypatch.setattr(cli, "_load_group", lambda c, k: fake_group)
    monkeypatch.setattr(cli, "_make_d1_client", lambda s: MagicMock())
    monkeypatch.setattr(cli, "_make_collector", lambda src: MagicMock(source=src))

    fake_summary = MagicMock(status="ok", rows_inserted=10, rows_updated=0,
                             runtime_ms=200, error_msg=None)
    monkeypatch.setattr(cli, "run_collector", lambda *a, **kw: fake_summary)

    res = runner.invoke(app, ["collect", "--source", "youtube", "--group", "plave"])
    assert res.exit_code == 0


def test_analyze_weekly_subcommand_present():
    res = runner.invoke(app, ["analyze-weekly", "--help"])
    assert res.exit_code == 0
    assert "weekly" in res.output.lower()
```

- [ ] **Step 2: Run, see FAIL**

```bash
cd worker
uv run pytest tests/unit/test_cli.py -v
```

- [ ] **Step 3: Update `cli.py`**

Edit `worker/src/idol_sight/cli.py` — find the `_COLLECTORS` dict and add the four new entries. Then add the `analyze-weekly` subcommand.

Replace the existing `_COLLECTORS` mapping with:

```python
from idol_sight.collectors.channel_stats import ChannelStatsCollector
from idol_sight.collectors.hanteo import HanteoCollector
from idol_sight.collectors.twitter import TwitterCollector
from idol_sight.collectors.youtube import YouTubeCollector

_COLLECTORS = {
    "naver": NaverCollector,
    "instiz": InstizCollector,
    "theqoo": TheQooCollector,
    "dc": DcCollector,
    "youtube": YouTubeCollector,
    "channel-stats": ChannelStatsCollector,
    "hanteo": HanteoCollector,
    "twitter": TwitterCollector,
}
```

Update `_make_collector(source)`:

```python
def _make_collector(source: str):
    cls = _COLLECTORS.get(source)
    if cls is None:
        raise NotImplementedError(f"unknown source {source!r}")
    settings = load_settings()
    if cls is YouTubeCollector or cls is ChannelStatsCollector:
        if not settings.yt_api_key:
            raise RuntimeError(f"{source} requires YT_API_KEY env")
        return cls(api_key=settings.yt_api_key)
    return cls()
```

Append a new subcommand:

```python
@app.command("analyze-weekly", help="Run weekly analysis: hanteo, market_share, member_pop, llm.")
def analyze_weekly(
    week_start: str = typer.Option(..., "--week-start", help="YYYY-MM-DD (Sunday)"),
    week_end: str   = typer.Option(..., "--week-end",   help="YYYY-MM-DD (Saturday)"),
) -> None:
    settings = load_settings()
    client = _make_d1_client(settings)
    snap = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:00:00Z")

    # 1. Hanteo (global fetch)
    hanteo_collector = HanteoCollector(
        groups_loader=lambda: _load_active_groups(client),
    )
    hanteo_result = hanteo_collector.collect_global()
    if hanteo_result.statements:
        client.batch(hanteo_result.statements)
    typer.echo(f"hanteo: matched {hanteo_result.rows_inserted} groups")

    # 2. Market share — read agg_summary windows + write agg_market_share
    from idol_sight.analysis.market_share import compute_market_share, to_statements
    rows_last = client.execute(
        "SELECT group_key, yt_total_views, dc_total_posts, theqoo_posts, "
        "  instiz_posts, naver_total_news "
        "FROM agg_summary WHERE substr(snapshot_at,1,10)=?", [week_end])
    rows_prev = client.execute(
        "SELECT group_key, yt_total_views, dc_total_posts FROM agg_summary "
        "WHERE substr(snapshot_at,1,10)=?", [_shift_date(week_end, -7)])
    cum_by = {r["group_key"]: (r["yt_total_views"] or 0) + (r["dc_total_posts"] or 0)
              + (r.get("theqoo_posts") or 0) + (r.get("instiz_posts") or 0)
              + (r.get("naver_total_news") or 0) * 100
              for r in rows_last}
    prev_by = {r["group_key"]: (r["yt_total_views"] or 0) + (r["dc_total_posts"] or 0)
               for r in rows_prev}
    groups = [{"key": k, "cum_score": cum_by[k],
               "mom_score": max(cum_by[k] - prev_by.get(k, 0), 0)}
              for k in cum_by]
    share_rows = compute_market_share(week_start=week_start, week_end=week_end,
                                       groups=groups)
    market_total = sum(g["cum_score"] for g in groups)
    market_stmts = to_statements(share_rows, market_total=market_total)
    if market_stmts:
        client.batch(market_stmts)
    typer.echo(f"market_share: wrote {len(market_stmts)} rows")

    # 3. Member popularity (one per active group)
    from idol_sight.analysis.member_popularity import (
        compute_member_popularity, to_statements as mp_to_statements,
    )
    member_stmts: list = []
    for g in _load_active_groups(client):
        members_raw = client.execute(
            "SELECT m.id, m.name, "
            "  COALESCE(MAX(c.subscribers),0) AS yt_score, "
            "  COALESCE((SELECT COUNT(*) FROM community_posts cp "
            "             WHERE cp.group_key = m.group_key "
            "               AND cp.title LIKE '%' || m.name || '%'), 0) AS comm_mentions, "
            "  COUNT(DISTINCT v.video_id) AS yt_videos, "
            "  COALESCE(AVG(s.views), 0) AS yt_avg_views "
            "FROM members m "
            "LEFT JOIN youtube_videos v ON v.channel_id = m.yt_channel_id "
            "LEFT JOIN youtube_video_stats s ON s.video_id = v.video_id "
            "LEFT JOIN youtube_channel_stats c ON c.channel_id = m.yt_channel_id "
            "WHERE m.group_key = ? AND m.active = 1 "
            "GROUP BY m.id",
            [g["key"]],
        )
        members = [
            {
                "name": m["name"],
                "yt_score": min(m["yt_score"] / 10_000, 100),
                "community_score": min(m["comm_mentions"], 100),
                "yt_videos": m["yt_videos"],
                "yt_avg_views": int(m["yt_avg_views"]),
                "yt_sufficient": m["yt_videos"] >= 3,
                "community_mentions": m["comm_mentions"],
            }
            for m in members_raw
        ]
        if not members:
            continue
        pop = compute_member_popularity(group_key=g["key"], members=members)
        id_lookup = {m["name"]: m["id"] for m in members_raw}
        member_stmts.extend(mp_to_statements(pop, snapshot_at=snap, member_id_lookup=id_lookup))
    if member_stmts:
        client.batch(member_stmts)
    typer.echo(f"member_popularity: wrote {len(member_stmts)} rows")

    # 4. LLM weekly insights
    if settings.gemini_api_key:
        from idol_sight.llm.gemini import GeminiClient
        from idol_sight.llm.weekly import generate_weekly
        gemini = GeminiClient(api_key=settings.gemini_api_key)
        weekly = generate_weekly(db=client, gemini=gemini,
                                  week_start=week_start, week_end=week_end)
        if weekly.statements:
            client.batch(weekly.statements)
        typer.echo(f"llm: wrote {weekly.rows_inserted} insights")
    else:
        typer.echo("llm: skipped (GEMINI_API_KEY unset)")


def _load_active_groups(client) -> list[dict]:
    return client.execute("SELECT key, name FROM groups WHERE is_active=1")


def _shift_date(iso_date: str, days: int) -> str:
    from datetime import date, timedelta
    return (date.fromisoformat(iso_date) + timedelta(days=days)).isoformat()
```

- [ ] **Step 4: Run tests**

```bash
cd worker
uv run pytest tests/unit/test_cli.py -v
uv run python -m idol_sight --help
```

Expected: existing tests + 2 new pass. `--help` shows 5 commands: collect, notify-fail, aggregate, health-check, analyze-weekly.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/cli.py worker/tests/unit/test_cli.py
git commit -m "feat(worker): CLI registers 4 new collectors + analyze-weekly subcommand"
```

---

## Task 11: collect-daily workflow

**Files:**
- Create: `.github/workflows/collect-daily.yml`

- [ ] **Step 1: Create the workflow**

```yaml
name: collect-daily
on:
  schedule:
    - cron: '30 8 * * *'    # daily 08:30 UTC
  workflow_dispatch:

jobs:
  collect:
    strategy:
      fail-fast: false
      max-parallel: 4
      matrix:
        group:  [plave, isedol, stellive, skinz, myrakl, miiwan, owis, bdawn]
        source: [channel-stats, youtube]
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v3
      - run: uv sync --frozen
        working-directory: worker
      - run: |
          uv run python -m idol_sight collect \
            --source ${{ matrix.source }} \
            --group  ${{ matrix.group }}
        working-directory: worker
        env:
          CF_ACCOUNT_ID:   ${{ secrets.CF_ACCOUNT_ID }}
          CF_D1_DB_ID:     ${{ secrets.CF_D1_DB_ID }}
          CF_API_TOKEN:    ${{ secrets.CF_API_TOKEN }}
          YT_API_KEY:      ${{ secrets.YT_API_KEY }}
          DISCORD_WEBHOOK: ${{ secrets.DISCORD_WEBHOOK }}
      - if: failure()
        working-directory: worker
        run: |
          uv run python -m idol_sight notify-fail \
            --job '${{ matrix.source }}:${{ matrix.group }}'
        env:
          DISCORD_WEBHOOK: ${{ secrets.DISCORD_WEBHOOK }}

  aggregate:
    needs: collect
    if: always()
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v3
      - run: uv sync --frozen
        working-directory: worker
      - run: uv run python -m idol_sight aggregate
        working-directory: worker
        env:
          CF_ACCOUNT_ID:   ${{ secrets.CF_ACCOUNT_ID }}
          CF_D1_DB_ID:     ${{ secrets.CF_D1_DB_ID }}
          CF_API_TOKEN:    ${{ secrets.CF_API_TOKEN }}
          DISCORD_WEBHOOK: ${{ secrets.DISCORD_WEBHOOK }}
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/collect-daily.yml
git commit -m "ci: collect-daily workflow for youtube videos and channel-stats"
```

---

## Task 12: analyze-weekly workflow

**Files:**
- Create: `.github/workflows/analyze-weekly.yml`

> **Approach:** Single workflow, single job, runs Mondays at 09:00 UTC. Computes the previous Sunday-to-Saturday week and runs `analyze-weekly --week-start ... --week-end ...`.

- [ ] **Step 1: Create the workflow**

```yaml
name: analyze-weekly
on:
  schedule:
    - cron: '0 9 * * 1'        # Monday 09:00 UTC
  workflow_dispatch:
    inputs:
      week_start: {description: 'YYYY-MM-DD (Sunday)', required: false}
      week_end:   {description: 'YYYY-MM-DD (Saturday)', required: false}

jobs:
  analyze:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v3
      - run: uv sync --frozen
        working-directory: worker
      - run: uv run scrapling install
        working-directory: worker
      - name: Compute week bounds (if not provided)
        id: bounds
        run: |
          if [[ -n "${{ inputs.week_start }}" && -n "${{ inputs.week_end }}" ]]; then
            echo "ws=${{ inputs.week_start }}" >> "$GITHUB_OUTPUT"
            echo "we=${{ inputs.week_end }}"   >> "$GITHUB_OUTPUT"
          else
            # Most recent Sunday-to-Saturday strictly before today.
            we=$(python3 -c "
import datetime as d
t = d.date.today()
end = t - d.timedelta(days=((t.weekday() + 1) % 7) + 1)
print(end.isoformat())
")
            ws=$(python3 -c "
import datetime as d
end = d.date.fromisoformat('$we')
print((end - d.timedelta(days=6)).isoformat())
")
            echo "ws=$ws" >> "$GITHUB_OUTPUT"
            echo "we=$we" >> "$GITHUB_OUTPUT"
          fi
      - run: |
          uv run python -m idol_sight analyze-weekly \
            --week-start ${{ steps.bounds.outputs.ws }} \
            --week-end   ${{ steps.bounds.outputs.we }}
        working-directory: worker
        env:
          CF_ACCOUNT_ID:   ${{ secrets.CF_ACCOUNT_ID }}
          CF_D1_DB_ID:     ${{ secrets.CF_D1_DB_ID }}
          CF_API_TOKEN:    ${{ secrets.CF_API_TOKEN }}
          GEMINI_API_KEY:  ${{ secrets.GEMINI_API_KEY }}
          DISCORD_WEBHOOK: ${{ secrets.DISCORD_WEBHOOK }}
      - if: failure()
        working-directory: worker
        run: |
          uv run python -m idol_sight notify-fail --job 'analyze-weekly'
        env:
          DISCORD_WEBHOOK: ${{ secrets.DISCORD_WEBHOOK }}
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/analyze-weekly.yml
git commit -m "ci: analyze-weekly workflow for hanteo + analysis + LLM insights"
```

---

## Final verification

- [ ] **Step 1: Full local check**

```bash
( cd worker && uv run ruff check && uv run pyright && uv run pytest -q )
```

Expected: green.

- [ ] **Step 2: Inspect commit log**

```bash
git log --oneline | head -15
```

Expected: 12 new commits on top of Plan 2 history.

---

## Out of Scope (Plan 4)

- Frontend UI (all 7 tabs, charts, search, exports, freshness badges)
- Live smoke tests against production data
- Member solo channel discovery / auto-population
- Twitter via X API Basic ($100/mo) — current solution is best-effort nitter+oembed
- Hanteo selector hardening if site redesigns
- Migration follow-up: NOT NULL on composite PK columns (deferred from Plan 1 reviewer)
