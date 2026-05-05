"""External cohort collector — YouTube Data API only.

Pulls public YouTube channel statistics (subscribers, total views) for
the curated benchmark roster (see migrations/0015_external_cohort.sql).
Writes one row per group into ``external_metrics`` with
``source='auto'``.

Scope note — why Spotify is NOT in this collector:
  Spotify changed their developer policy on 2026-02-06: Web API
  Development Mode now requires the app owner to hold a Spotify
  Premium subscription, and the Client Credentials flow that this
  module would have used is being deprecated for metadata endpoints.
  Scraping ``open.spotify.com`` is also brittle — the page is
  aggressively bot-protected. Until we add a reliable alternative
  (paid Premium, Last.fm proxy, or operator-supplied data export),
  the spotify_* columns on external_metrics are left NULL by the
  auto path and can be hand-populated via SQL when the operator
  cares to refresh them.

Why this is a global collector rather than per-group: external_groups
is a small table (single-digit rows). Batching the YT call (channels.list
accepts up to 50 channel IDs in one request) halves the API cost vs
the per-group orchestration path our internal collectors use.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from time import perf_counter
from typing import Any

import httpx

from idol_sight.collectors.base import CollectionResult

log = logging.getLogger(__name__)

YT_API = "https://www.googleapis.com/youtube/v3"
YT_CHANNELS_LIST_MAX = 50


@dataclass
class ExternalGroupRow:
    """Subset of external_groups columns that drive the collector."""
    key: str
    name: str
    yt_channel_id: str | None
    spotify_artist_id: str | None  # kept on the dataclass for forward-
    # compat; ignored by the current YouTube-only collector path.


class ExternalCohortCollector:
    """YouTube-API-driven collector for the external_groups roster."""

    source = "external-cohort"

    def __init__(
        self,
        *,
        yt_api_key: str | None,
        http_factory: Callable[[], httpx.Client] | None = None,
    ):
        self._yt_key = yt_api_key
        self._http_factory = http_factory or (lambda: httpx.Client(timeout=30.0))

    def collect(
        self,
        groups: list[ExternalGroupRow],
    ) -> CollectionResult:
        """Fetch latest YouTube stats for each group with a yt_channel_id
        and emit one ``external_metrics`` INSERT per group.

        Groups missing a yt_channel_id are skipped (no signal we can
        gather automatically). Spotify columns are left NULL — the
        operator can hand-populate them via SQL or a future collector.
        """
        started = perf_counter()
        if not groups:
            return CollectionResult(0, 0, runtime_ms=0)
        if not self._yt_key:
            return CollectionResult(
                0, 0,
                errors=["yt_api_key missing — external-cohort skipped"],
                runtime_ms=int((perf_counter() - started) * 1000),
            )

        snapshot_at = datetime.now(UTC).strftime("%Y-%m-%dT%H:00:00Z")
        statements: list[tuple[str, list[Any]]] = []
        errors: list[str] = []

        with self._http_factory() as http:
            yt_stats = self._fetch_yt_stats(http, groups, errors)

            for g in groups:
                yt = yt_stats.get(g.yt_channel_id or "")
                if not yt:
                    continue
                statements.append((
                    """
                    INSERT INTO external_metrics
                      (group_key, snapshot_at, yt_subscribers, yt_total_views,
                       spotify_monthly_listeners, spotify_followers, source)
                    VALUES (?, ?, ?, ?, NULL, NULL, 'auto')
                    ON CONFLICT(group_key, snapshot_at) DO UPDATE SET
                      yt_subscribers=excluded.yt_subscribers,
                      yt_total_views=excluded.yt_total_views,
                      source='auto'
                    """.strip(),
                    [
                        g.key, snapshot_at,
                        yt["subscribers"],
                        yt["views"],
                    ],
                ))

        runtime_ms = int((perf_counter() - started) * 1000)
        return CollectionResult(
            rows_inserted=len(statements), rows_updated=0,
            statements=statements, runtime_ms=runtime_ms,
            errors=errors,
        )

    def _fetch_yt_stats(
        self,
        http: httpx.Client,
        groups: list[ExternalGroupRow],
        errors: list[str],
    ) -> dict[str, dict[str, int]]:
        """Returns {channel_id: {"subscribers": N, "views": N}}.

        Note we deliberately do NOT raise on per-batch failures — a
        single bad channel ID shouldn't black out the whole roster.
        Failures are surfaced via the ``errors`` accumulator so the
        CLI prints them.
        """
        ids = [g.yt_channel_id for g in groups if g.yt_channel_id]
        if not ids:
            return {}

        out: dict[str, dict[str, int]] = {}
        for i in range(0, len(ids), YT_CHANNELS_LIST_MAX):
            chunk = ids[i:i + YT_CHANNELS_LIST_MAX]
            try:
                r = http.get(
                    f"{YT_API}/channels",
                    params={
                        "key": self._yt_key,
                        "id": ",".join(chunk),
                        "part": "statistics",
                    },
                )
                r.raise_for_status()
            except httpx.HTTPError as e:
                errors.append(f"youtube channels.list failed: {e}")
                continue
            for item in r.json().get("items", []):
                cid = item.get("id")
                stats = item.get("statistics") or {}
                if not cid:
                    continue
                out[cid] = {
                    "subscribers": int(stats.get("subscriberCount", 0) or 0),
                    "views": int(stats.get("viewCount", 0) or 0),
                }
        return out


def load_external_groups(client) -> list[ExternalGroupRow]:
    """Convenience loader used by the CLI command. Returns one
    ExternalGroupRow per active external_groups row."""
    rows = client.execute(
        "SELECT key, name, yt_channel_id, spotify_artist_id "
        "FROM external_groups WHERE is_active=1 ORDER BY key"
    )
    return [
        ExternalGroupRow(
            key=r["key"], name=r["name"],
            yt_channel_id=r.get("yt_channel_id"),
            spotify_artist_id=r.get("spotify_artist_id"),
        )
        for r in rows
    ]


__all__ = [
    "ExternalCohortCollector",
    "ExternalGroupRow",
    "load_external_groups",
]
