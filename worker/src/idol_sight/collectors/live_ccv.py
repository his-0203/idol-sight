"""Live CCV collector — YouTube concurrent-viewers for ccv_tracked groups.

Detection is quota-cheap: channel RSS feed (no Data API → 0 quota) yields recent
video IDs, then a single videos.list(part=snippet,liveStreamingDetails) batch
(1 unit) identifies the currently-live ones and their concurrentViewers. Emits
idempotent UPSERTs into live_ccv_samples; never writes D1 directly.
"""
from __future__ import annotations

import logging
import re
from collections.abc import Callable
from typing import Any

import httpx

from idol_sight.collectors.base import CollectionResult

log = logging.getLogger(__name__)

API = "https://www.googleapis.com/youtube/v3"
RSS_URL = "https://www.youtube.com/feeds/videos.xml?channel_id={cid}"
VIDEOS_LIST_MAX = 50
_VIDEO_ID_RE = re.compile(r"<yt:videoId>([\w-]{11})</yt:videoId>")

_UPSERT = (
    "INSERT INTO live_ccv_samples "
    "(video_id, group_key, sampled_at, concurrent_viewers, title) "
    "VALUES (?, ?, ?, ?, ?) "
    "ON CONFLICT(video_id, sampled_at) DO UPDATE SET "
    "concurrent_viewers=excluded.concurrent_viewers, title=excluded.title"
)


class LiveCcvCollector:
    source = "live_ccv"

    def __init__(
        self,
        *,
        api_key: str,
        groups_loader: Callable[[], list[dict]],
        http_factory: Callable[[], Any] | None = None,
    ):
        self._key = api_key
        self._groups_loader = groups_loader   # () -> [{key, yt_channel_id}]
        self._http_factory = http_factory or (lambda: httpx.Client(timeout=30.0))

    def _rss_video_ids(self, client: Any, channel_id: str) -> list[str]:
        r = client.get(RSS_URL.format(cid=channel_id))
        r.raise_for_status()
        return list(dict.fromkeys(_VIDEO_ID_RE.findall(r.text)))

    def _live_samples(self, client: Any, video_ids: list[str]) -> dict[str, dict]:
        """video_id -> {"ccv": int, "title": str} for currently-live videos."""
        out: dict[str, dict] = {}
        for i in range(0, len(video_ids), VIDEOS_LIST_MAX):
            batch = video_ids[i:i + VIDEOS_LIST_MAX]
            r = client.get(
                f"{API}/videos",
                params={
                    "key": self._key,
                    "id": ",".join(batch),
                    "part": "snippet,liveStreamingDetails",
                },
            )
            r.raise_for_status()
            for item in r.json().get("items", []):
                sn = item.get("snippet") or {}
                lsd = item.get("liveStreamingDetails") or {}
                ccv = lsd.get("concurrentViewers")
                if (sn.get("liveBroadcastContent") == "live"
                        and ccv is not None and str(ccv).isdigit()):
                    out[item["id"]] = {
                        "ccv": int(ccv),
                        "title": sn.get("title"),
                    }
        return out

    def collect_global(self, *, now_iso: str) -> CollectionResult:
        targets = [t for t in self._groups_loader() if t.get("yt_channel_id")]
        errors: list[str] = []
        vid_to_group: dict[str, str] = {}
        statements: list[tuple[str, list[Any]]] = []

        with self._http_factory() as client:
            for t in targets:
                try:
                    ids = self._rss_video_ids(client, t["yt_channel_id"])
                except (httpx.HTTPError, httpx.TimeoutException) as exc:
                    errors.append(f"rss {t['key']}: {exc}")
                    continue
                for vid in ids:
                    vid_to_group.setdefault(vid, t["key"])

            if vid_to_group:
                try:
                    live = self._live_samples(client, list(vid_to_group))
                except (httpx.HTTPError, httpx.TimeoutException) as exc:
                    errors.append(f"videos.list: {exc}")
                    live = {}
                for vid, info in live.items():
                    statements.append((_UPSERT, [
                        vid, vid_to_group[vid], now_iso,
                        info["ccv"], info["title"],
                    ]))

        # Every target's RSS failed and nothing was sampled → sentinel error so
        # the CLI exits non-zero and the workflow's notify-fail fires.
        if targets and not statements and len(errors) >= len(targets):
            return CollectionResult(0, 0, statements=[],
                                    errors=errors or ["live_ccv: all targets failed"])
        return CollectionResult(
            rows_inserted=len(statements), rows_updated=0,
            statements=statements, errors=errors,
        )
