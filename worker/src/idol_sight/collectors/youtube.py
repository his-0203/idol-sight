"""YouTube Data API v3 collector. NOT a Scrapling collector.

Two modes:

**Recent mode (default, used by daily cron)**
  1. search.list?channelId=<id>&order=date&maxResults=50
     → up to 50 most recent video IDs per channel
  2. videos.list?id=<csv> → metadata + stats for that batch
  Quota: ~101 units per channel.

**Full-history mode (one-shot via `idol-sight backfill-yt-videos`)**
  1. channels.list?id=<id>&part=contentDetails
     → contentDetails.relatedPlaylists.uploads (the "uploads" playlist
       which YouTube auto-maintains with every video the channel ever
       posted, oldest to newest)
  2. playlistItems.list?playlistId=<uploads_pl>&maxResults=50&pageToken=…
     → paginate through ALL video IDs in the channel's history
  3. videos.list?id=<csv> for stats (batches of 50)
  Quota: 1 unit per channels.list + 1 per playlistItems.list + 1 per
  videos.list batch. PLAVE 1575 vids ≈ 32 playlistItems pages + 32
  videos batches = ~65 units (vs search.list pagination which would be
  100 × 32 = 3200).

Both modes:
  - Emit youtube_videos INSERT (idempotent on video_id) +
    youtube_video_stats INSERT (composite PK on snapshot_at).
  - All resulting rows are stamped with the same group_key, so member
    solo videos roll up into the group totals downstream (agg_summary,
    member_popularity). The actual ``channel_id`` of each video is
    preserved on ``youtube_videos.channel_id``.

Full-history mode is a one-time backfill — once run, subsequent recent-
mode runs only top up new videos (idempotent INSERTs). After backfill,
``yt_total_videos`` (count) and the synthesized cumulative-views series
in agg_summary become accurate over the channel's full lifetime.
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
PLAYLIST_ITEMS_MAX = 50      # max maxResults for playlistItems.list
# Hard cap on pagination depth — guards against accidental quota burn
# if a future channel has tens of thousands of videos. 200 pages ×
# 50 = 10K videos, easily covers any K-pop or VTuber channel today.
FULL_HISTORY_MAX_PAGES = 200


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

    def __init__(
        self,
        api_key: str,
        http_factory: Callable[[], Any] | None = None,
        members_loader: Callable[[str], list[dict]] | None = None,
    ):
        self._key = api_key
        self._http_factory = http_factory or (lambda: httpx.Client(timeout=30.0))
        # Returns a list of {"yt_channel_id": "..."} for the group's
        # active members that have a solo channel. Default = no members,
        # which keeps unit tests and one-off invocations simple.
        self._members_loader = members_loader or (lambda _: [])

    def _fetch_recent(self, client: Any, channel_ids: list[str]) -> list[str]:
        """search.list per channel — fast, capped at 50 latest videos.

        Default daily-cron path. Cheap-but-shallow; covers MVs/teasers/
        community uploads from the last few weeks for typical k-pop
        cadence.
        """
        ids: list[str] = []
        for ch_id in channel_ids:
            r = client.get(
                f"{API}/search",
                params={
                    "key": self._key,
                    "channelId": ch_id,
                    "order": "date",
                    "maxResults": SEARCH_LIST_MAX,
                    "type": "video",
                    "part": "id",
                },
            )
            r.raise_for_status()
            ids.extend(
                item["id"]["videoId"]
                for item in r.json().get("items", [])
                if item.get("id", {}).get("videoId")
            )
        # Dedupe while preserving order — collabs can appear under
        # multiple channels' search results.
        return list(dict.fromkeys(ids))

    def _fetch_all_uploads(self, client: Any, channel_ids: list[str]) -> list[str]:
        """Walk the channel's uploads playlist for FULL video history.

        For each channel:
          1. channels.list?id=…&part=contentDetails returns
             contentDetails.relatedPlaylists.uploads — a YouTube-managed
             playlist that contains every public video the channel ever
             posted, ordered newest-first.
          2. playlistItems.list?playlistId=…&maxResults=50&pageToken=…
             paginates through every video in that playlist (1 quota
             unit per page vs search.list's 100).

        Capped at FULL_HISTORY_MAX_PAGES per channel as a quota guard.
        """
        ids: list[str] = []
        for ch_id in channel_ids:
            uploads_pl = self._lookup_uploads_playlist(client, ch_id)
            if not uploads_pl:
                log.warning("no uploads playlist for channel_id=%s", ch_id)
                continue
            page_token: str | None = None
            for _ in range(FULL_HISTORY_MAX_PAGES):
                params: dict[str, Any] = {
                    "key": self._key,
                    "playlistId": uploads_pl,
                    "maxResults": PLAYLIST_ITEMS_MAX,
                    "part": "contentDetails",
                }
                if page_token:
                    params["pageToken"] = page_token
                r = client.get(f"{API}/playlistItems", params=params)
                r.raise_for_status()
                payload = r.json()
                for item in payload.get("items", []):
                    vid = (item.get("contentDetails") or {}).get("videoId")
                    if vid:
                        ids.append(vid)
                page_token = payload.get("nextPageToken")
                if not page_token:
                    break
        return list(dict.fromkeys(ids))

    def _lookup_uploads_playlist(self, client: Any, channel_id: str) -> str | None:
        """Resolve a channel's uploads playlist id (1 quota unit)."""
        r = client.get(
            f"{API}/channels",
            params={
                "key": self._key,
                "id": channel_id,
                "part": "contentDetails",
            },
        )
        r.raise_for_status()
        items = r.json().get("items", [])
        if not items:
            return None
        cd = items[0].get("contentDetails") or {}
        rp = cd.get("relatedPlaylists") or {}
        return rp.get("uploads")

    def collect(self, group: GroupConfig, since: str | None = None,
                full_history: bool = False) -> CollectionResult:
        """Collect recent (default) or full-history videos for the group.

        ``full_history=True`` paginates the channel's "uploads" playlist
        and walks every video the channel ever posted. Use sparingly
        (one-shot via the ``backfill-yt-videos`` CLI command); daily
        cron should leave it False.
        """
        if not group.yt_channel_id:
            return CollectionResult(0, 0, errors=[f"{group.key}: no yt_channel_id"])

        # Group channel + active member solo channels (deduped, order
        # preserved so the group channel is queried first).
        channel_ids: list[str] = [group.yt_channel_id]
        seen = {group.yt_channel_id}
        for m in self._members_loader(group.key):
            cid = m.get("yt_channel_id") if isinstance(m, dict) else None
            if cid and cid not in seen:
                seen.add(cid)
                channel_ids.append(cid)

        started = perf_counter()
        with self._http_factory() as client:
            if full_history:
                ids = self._fetch_all_uploads(client, channel_ids)
            else:
                ids = self._fetch_recent(client, channel_ids)
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
