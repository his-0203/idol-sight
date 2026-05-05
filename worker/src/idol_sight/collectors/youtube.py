"""YouTube Data API v3 collector. NOT a Scrapling collector.

Per-group pipeline:
  1. search.list?channelId=<id>&order=date -> recent video IDs
  2. videos.list?id=<csv> -> metadata + statistics for those IDs
  3. Emit youtube_videos INSERT (idempotent on video_id) +
     youtube_video_stats INSERT (composite PK on snapshot_at).

Quota cost: ~101 units per call (search=100, videos=1).
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import UTC, datetime
from time import perf_counter
from typing import Any

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

        now_iso = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
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
