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
