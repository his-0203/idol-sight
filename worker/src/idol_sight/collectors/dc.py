"""dcinside gallery collector.

Each PLAVE/group has a dedicated dcinside *minor* gallery (mgallery)
listed at ``https://gall.dcinside.com/mgallery/board/lists/?id=<gid>``.
DC also accepts the canonical ``/board/lists/?id=<gid>`` form and
serves a JS redirect to the correct gallery type (board / mgallery /
minor / person) — ``StealthyFetcher`` runs a real browser so it follows
the JS redirect transparently. We use the canonical URL here.

Because every post inside a group's gallery is by definition about that
group, we do **not** filter by ``group.context_keywords`` — every parsed
row is emitted as a community_posts + community_post_stats pair.

DC blocks aggressive scraping (Cloudflare-style robot challenges, IP
rate-limiting), so this collector is **Tier 2 from the start**: it only
uses ``StealthyFetcher`` with ``solve_cloudflare=True``. There is no
plain-HTTP fallback — curl reliably returns either a 200 with a redirect
script (no posts) or a robot challenge page.

Markup notes (verified against a 2026-05-04 capture of the PLAVE
gallery — see ``tests/unit/fixtures/dc_gallery.html``):

- Posts live in ``table.gall_list tbody tr.us-post`` (the ``us-post``
  class distinguishes real posts from the survey/AD intro rows that
  share ``ub-content`` but have no ``data-no``).
- ``td.gall_tit a`` holds the title and the relative href
  (``/mgallery/board/view/?id=<gid>&no=<n>&page=...``). The anchor
  contains an icon ``<em>`` and may be followed by a sibling
  ``a.reply_numbox`` carrying ``[N]`` comment count — that sibling is
  *outside* the title anchor so ``a.get_all_text()`` cleanly returns
  only the title text.
- ``td.gall_count`` holds views (``"265"``); ``td.gall_recommend`` holds
  recommendations / 추천 (``"0"``) — both can be ``"-"`` for notice rows
  but those are excluded by the ``us-post`` filter when their data-type
  is ``icon_notice``. The ``int()`` cast falls back to ``None`` rather
  than raising on dashes / non-numeric values.
- ``td.gall_date`` carries the full timestamp on its ``title`` attribute
  (``"2026-05-04 15:33:15"``) and an abbreviated form
  (``"15:33"`` for today, ``"25.10.28"`` for older posts) as inner
  text. We prefer the ``title`` attribute since it is unambiguous and
  parse_safe handles ISO 8601 directly.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from time import perf_counter
from typing import Any

from scrapling import StealthyFetcher

from idol_sight.collectors.base import CollectionResult
from idol_sight.config import GroupConfig
from idol_sight.utils.dates import parse_safe
from idol_sight.utils.url_hash import url_hash

log = logging.getLogger(__name__)

LIST_URL_TPL = "https://gall.dcinside.com/board/lists/?id={gallery_id}"


class DcCollector:
    source = "dc"

    def __init__(self, stealthy: Any | None = None):
        self._stealthy = stealthy or StealthyFetcher

    def collect(
        self, group: GroupConfig, since: str | None = None
    ) -> CollectionResult:
        if not group.dc_gallery_id:
            return CollectionResult(
                rows_inserted=0,
                rows_updated=0,
                errors=[f"{group.key}: no dc_gallery_id"],
            )

        started = perf_counter()
        url = LIST_URL_TPL.format(gallery_id=group.dc_gallery_id)
        page = self._stealthy.fetch(
            url,
            headless=True,
            network_idle=True,
            block_resources=True,
            solve_cloudflare=True,
        )
        rows = self._parse(page)

        now_iso = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        statements: list[tuple[str, list[Any]]] = []

        for r in rows:
            uh = url_hash(r["url"])
            posted = parse_safe(r.get("posted_at_raw", ""))
            posted_iso = (
                posted.strftime("%Y-%m-%dT%H:%M:%SZ") if posted else None
            )
            statements.append((
                """
                INSERT INTO community_posts
                  (url_hash, platform, group_key, title, url, posted_at, collected_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(url_hash) DO UPDATE SET
                  title=excluded.title
                """.strip(),
                [
                    uh,
                    "dc",
                    group.key,
                    r["title"][:500],
                    r["url"],
                    posted_iso,
                    now_iso,
                ],
            ))
            statements.append((
                """
                INSERT INTO community_post_stats(url_hash, snapshot_at, views, likes, comments)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(url_hash, snapshot_at) DO UPDATE SET
                  views=excluded.views, likes=excluded.likes, comments=excluded.comments
                """.strip(),
                [uh, now_iso, r.get("views"), r.get("likes"), r.get("comments")],
            ))

        runtime_ms = int((perf_counter() - started) * 1000)
        return CollectionResult(
            rows_inserted=len(rows),
            rows_updated=0,
            statements=statements,
            runtime_ms=runtime_ms,
        )

    @staticmethod
    def _parse(page: Any) -> list[dict[str, Any]]:
        """Extract title/url/views/likes/posted_at from gall_list rows.

        Robustness: try ``table.gall_list tbody tr.us-post`` first; fall
        back to a bare ``tr.us-post`` scan if DC ever drops the wrapping
        ``table.gall_list``. Notice rows that share ``us-post`` but
        carry ``data-type="icon_notice"`` are kept — they still represent
        valid (pinned) posts under that gallery.
        """
        out: list[dict[str, Any]] = []

        rows = page.css("table.gall_list tbody tr.us-post")
        if not rows:
            rows = page.css("tr.us-post")

        for tr in rows:
            try:
                title_anchors = tr.css("td.gall_tit a")
                if not title_anchors:
                    continue
                # Pick the first anchor that is not the comment-count badge.
                a = None
                for cand in title_anchors:
                    cls = cand.attrib.get("class") or ""
                    if "reply_numbox" in cls:
                        continue
                    a = cand
                    break
                if a is None:
                    a = title_anchors[0]

                href = (a.attrib.get("href") or "").strip()
                if not href:
                    continue
                # Skip survey / javascript: anchors (intro rows that
                # somehow leaked past the us-post filter).
                if href.startswith("javascript:"):
                    continue

                title = " ".join(a.get_all_text().split())
                if not title:
                    continue
                if href.startswith("/"):
                    href = f"https://gall.dcinside.com{href}"

                # Views — td.gall_count.
                views: int | None = None
                view_nodes = tr.css("td.gall_count")
                if view_nodes:
                    raw = view_nodes[0].get_all_text().strip().replace(",", "")
                    try:
                        views = int(raw) if raw else None
                    except ValueError:
                        views = None

                # Likes / 추천 — td.gall_recommend.
                likes: int | None = None
                rec_nodes = tr.css("td.gall_recommend")
                if rec_nodes:
                    raw = rec_nodes[0].get_all_text().strip().replace(",", "")
                    try:
                        likes = int(raw) if raw else None
                    except ValueError:
                        likes = None

                # Posted-at — td.gall_date[title] preferred (full ISO),
                # fall back to the abbreviated inner text.
                posted = ""
                date_nodes = tr.css("td.gall_date")
                if date_nodes:
                    dn = date_nodes[0]
                    posted = (dn.attrib.get("title") or "").strip()
                    if not posted:
                        posted = " ".join(dn.get_all_text().split())

                out.append({
                    "title": title,
                    "url": href,
                    "views": views,
                    "likes": likes,
                    "comments": None,
                    "posted_at_raw": posted,
                })
            except Exception as e:  # noqa: BLE001
                log.warning("dc row skipped: %s", e)
        return out
