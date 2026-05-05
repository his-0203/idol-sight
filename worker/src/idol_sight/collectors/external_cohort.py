"""External cohort collector — Spotify Web API + YouTube Data API.

Pulls public metrics for a curated benchmark roster of K-pop newcomers
(see migrations/0015_external_cohort.sql for the seed). Two responsibilities:

  1. ``resolve()`` — for each row missing a ``spotify_artist_id``, run a
     Spotify Search API query (``q="<group name>"``, ``type=artist``,
     ``market=KR``) and pick the top hit. Idempotent: rows that already
     have an ID are left alone. Operator runs this ONCE after seeding.

  2. ``collect()`` — for every active row, fetch:
       - YouTube Data API channels.list?part=statistics → subscriberCount,
         viewCount.
       - Spotify Web API artists/{id} → followers.total + popularity.
     Optionally scrape ``open.spotify.com/artist/{id}`` for
     ``monthly_listeners`` (best-effort; left NULL on parse failure).
     Writes one row per group into ``external_metrics`` with
     ``source='auto'``. PK ``(group_key, snapshot_at)`` makes repeat
     runs within the same hour idempotent.

Why this is a global collector rather than per-group: external_groups
is a small table (single-digit rows). Batching the YT call (channels.list
accepts up to 50 channel IDs in one request) and amortising the Spotify
client_credentials token across groups halves the API cost vs the
per-group orchestration path our internal collectors use.
"""

from __future__ import annotations

import base64
import logging
import re
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

SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token"
SPOTIFY_API = "https://api.spotify.com/v1"

# Embed page is JS-light and exposes monthly_listeners in a JSON blob
# under <script id="initial-state">. We deliberately use the embed
# subdomain because the main artist page is heavily client-side
# rendered; embed is server-rendered and parses with a simple regex.
SPOTIFY_EMBED_URL = "https://open.spotify.com/embed/artist/{artist_id}"

_MONTHLY_LISTENERS_PATTERNS = (
    # Embed-page initial state — most stable.
    re.compile(r'"monthly_listeners"\s*:\s*(\d+)'),
    # Fallback: meta description on artist page ("X monthly listeners").
    re.compile(r"([\d,]+)\s*monthly listeners", re.IGNORECASE),
)


@dataclass
class ExternalGroupRow:
    """Subset of external_groups columns that drive the collector."""
    key: str
    name: str
    yt_channel_id: str | None
    spotify_artist_id: str | None


class SpotifyAuthError(RuntimeError):
    """Raised when client_credentials auth fails."""


class _SpotifyClient:
    """Thin wrapper around Spotify Web API with cached client_credentials
    token. Token lifetime is ~1h; we don't bother refreshing within a
    single collector run (which finishes in seconds), so a single token
    fetch suffices.
    """

    def __init__(
        self,
        client_id: str,
        client_secret: str,
        http: httpx.Client,
    ):
        self._client_id = client_id
        self._client_secret = client_secret
        self._http = http
        self._token: str | None = None

    def _ensure_token(self) -> str:
        if self._token:
            return self._token
        creds = f"{self._client_id}:{self._client_secret}".encode()
        auth = base64.b64encode(creds).decode()
        r = self._http.post(
            SPOTIFY_TOKEN_URL,
            headers={
                "Authorization": f"Basic {auth}",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            data={"grant_type": "client_credentials"},
        )
        if r.status_code != 200:
            raise SpotifyAuthError(
                f"spotify auth failed: {r.status_code} {r.text[:200]}"
            )
        data = r.json()
        token = data.get("access_token")
        if not token:
            raise SpotifyAuthError(f"spotify auth: no access_token in {data}")
        self._token = token
        return token

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._ensure_token()}"}

    def get_artist(self, artist_id: str) -> dict[str, Any] | None:
        r = self._http.get(
            f"{SPOTIFY_API}/artists/{artist_id}",
            headers=self._headers(),
        )
        if r.status_code == 404:
            log.warning("spotify artist %s not found", artist_id)
            return None
        r.raise_for_status()
        return r.json()

    def search_artist(self, query: str, *, market: str = "KR") -> dict[str, Any] | None:
        """Top artist hit for `query`, or None if no results."""
        r = self._http.get(
            f"{SPOTIFY_API}/search",
            headers=self._headers(),
            params={"q": query, "type": "artist", "market": market, "limit": 1},
        )
        r.raise_for_status()
        items = (r.json().get("artists", {}) or {}).get("items") or []
        return items[0] if items else None


def _scrape_monthly_listeners(
    artist_id: str,
    http: httpx.Client,
) -> int | None:
    """Best-effort scrape of monthly_listeners from the Spotify embed
    page. Returns None on any failure (network / parse / ToS-style HTML
    change). Callers should treat the missing value as "unknown",
    not zero, so we don't accidentally tank a group's perceived size.
    """
    try:
        r = http.get(
            SPOTIFY_EMBED_URL.format(artist_id=artist_id),
            headers={
                "User-Agent":
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/120.0 Safari/537.36",
                "Accept-Language": "en-US,en;q=0.9",
            },
            follow_redirects=True,
            timeout=15.0,
        )
        if r.status_code != 200:
            return None
        body = r.text
        for pat in _MONTHLY_LISTENERS_PATTERNS:
            m = pat.search(body)
            if m:
                raw = m.group(1).replace(",", "")
                try:
                    return int(raw)
                except ValueError:
                    continue
        return None
    except Exception as e:  # noqa: BLE001 — best-effort path
        log.warning("monthly_listeners scrape failed for %s: %s", artist_id, e)
        return None


class ExternalCohortCollector:
    """Combined Spotify + YouTube collector for the external_groups roster."""

    source = "external-cohort"

    def __init__(
        self,
        *,
        yt_api_key: str | None,
        spotify_client_id: str | None = None,
        spotify_client_secret: str | None = None,
        scrape_monthly_listeners: bool = True,
        http_factory: Callable[[], httpx.Client] | None = None,
    ):
        self._yt_key = yt_api_key
        self._sp_id = spotify_client_id
        self._sp_secret = spotify_client_secret
        self._scrape_monthly = scrape_monthly_listeners
        self._http_factory = http_factory or (lambda: httpx.Client(timeout=30.0))

    def _has_spotify_creds(self) -> bool:
        return bool(self._sp_id and self._sp_secret)

    def resolve(
        self,
        groups: list[ExternalGroupRow],
    ) -> tuple[list[tuple[str, list[Any]]], dict[str, str]]:
        """Look up Spotify artist IDs for groups missing one. Returns
        (UPDATE statements, resolved_id_by_key). Skips groups whose
        ID is already set, so the operator can run resolve() repeatedly
        without overwriting hand-set rows.
        """
        if not self._has_spotify_creds():
            log.info("resolve: spotify credentials missing; nothing to do")
            return ([], {})
        statements: list[tuple[str, list[Any]]] = []
        resolved: dict[str, str] = {}
        with self._http_factory() as http:
            sp = _SpotifyClient(self._sp_id, self._sp_secret, http)  # type: ignore[arg-type]
            for g in groups:
                if g.spotify_artist_id:
                    continue
                hit = sp.search_artist(g.name)
                if not hit or not hit.get("id"):
                    log.warning("resolve: no spotify hit for %s (%s)", g.key, g.name)
                    continue
                aid = hit["id"]
                resolved[g.key] = aid
                statements.append((
                    "UPDATE external_groups SET spotify_artist_id=? WHERE key=?",
                    [aid, g.key],
                ))
        return (statements, resolved)

    def collect(
        self,
        groups: list[ExternalGroupRow],
    ) -> CollectionResult:
        """Fetch latest metrics for each group and emit one
        external_metrics INSERT per group. Groups missing both
        ``yt_channel_id`` and ``spotify_artist_id`` are skipped (no
        signal to record). Groups with one source missing emit a row
        with NULLs for the missing columns — half a snapshot is more
        useful than no snapshot.
        """
        started = perf_counter()
        if not groups:
            return CollectionResult(0, 0, runtime_ms=0)

        snapshot_at = datetime.now(UTC).strftime("%Y-%m-%dT%H:00:00Z")
        statements: list[tuple[str, list[Any]]] = []
        errors: list[str] = []

        with self._http_factory() as http:
            yt_stats = self._fetch_yt_stats(http, groups, errors)
            sp_stats = self._fetch_spotify_stats(http, groups, errors)

            for g in groups:
                yt = yt_stats.get(g.yt_channel_id or "")
                sp = sp_stats.get(g.spotify_artist_id or "")
                if not yt and not sp:
                    continue
                statements.append((
                    """
                    INSERT INTO external_metrics
                      (group_key, snapshot_at, yt_subscribers, yt_total_views,
                       spotify_monthly_listeners, spotify_followers, source)
                    VALUES (?, ?, ?, ?, ?, ?, 'auto')
                    ON CONFLICT(group_key, snapshot_at) DO UPDATE SET
                      yt_subscribers=excluded.yt_subscribers,
                      yt_total_views=excluded.yt_total_views,
                      spotify_monthly_listeners=excluded.spotify_monthly_listeners,
                      spotify_followers=excluded.spotify_followers,
                      source='auto'
                    """.strip(),
                    [
                        g.key, snapshot_at,
                        yt.get("subscribers") if yt else None,
                        yt.get("views") if yt else None,
                        sp.get("monthly_listeners") if sp else None,
                        sp.get("followers") if sp else None,
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
        """Returns {channel_id: {"subscribers": N, "views": N}}."""
        if not self._yt_key:
            errors.append("yt_api_key missing — YouTube stats skipped")
            return {}
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

    def _fetch_spotify_stats(
        self,
        http: httpx.Client,
        groups: list[ExternalGroupRow],
        errors: list[str],
    ) -> dict[str, dict[str, int | None]]:
        """Returns {artist_id: {"followers": N, "monthly_listeners": N|None}}."""
        artist_ids = [g.spotify_artist_id for g in groups if g.spotify_artist_id]
        if not artist_ids:
            return {}
        if not self._has_spotify_creds():
            errors.append("spotify credentials missing — Spotify stats skipped")
            return {}

        out: dict[str, dict[str, int | None]] = {}
        try:
            sp = _SpotifyClient(self._sp_id, self._sp_secret, http)  # type: ignore[arg-type]
            for aid in artist_ids:
                try:
                    artist = sp.get_artist(aid)
                except httpx.HTTPError as e:
                    errors.append(f"spotify artists/{aid} failed: {e}")
                    continue
                if not artist:
                    continue
                followers = (artist.get("followers") or {}).get("total")
                # Monthly listeners is NOT in the public Web API response.
                # Best-effort scrape from the embed page (gated by flag so
                # ops can disable if Spotify changes the embed shape).
                monthly = None
                if self._scrape_monthly:
                    monthly = _scrape_monthly_listeners(aid, http)
                out[aid] = {
                    "followers": int(followers) if followers is not None else None,
                    "monthly_listeners": monthly,
                }
        except SpotifyAuthError as e:
            errors.append(str(e))
        return out


def load_external_groups(client) -> list[ExternalGroupRow]:
    """Convenience loader used by the CLI commands. Returns one
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
    "SpotifyAuthError",
    "load_external_groups",
]
