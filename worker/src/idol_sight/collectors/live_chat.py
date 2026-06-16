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
from datetime import UTC, datetime
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
VIDEOS_LIST_MAX = 50

_API_KEY_RE = re.compile(r'"INNERTUBE_API_KEY":"([^"]+)"')
_CLIENT_VER_RE = re.compile(r'"clientVersion":"([0-9][^"]*)"')


def _extract_bootstrap(html: str) -> dict[str, Any]:
    """watch 페이지에서 api_key, client_version, 첫 리플레이 continuation 토큰."""
    key = _API_KEY_RE.search(html)
    ver = _CLIENT_VER_RE.search(html)
    cont: str | None = None
    # ytInitialData 의 conversationBar.liveChatRenderer.continuations[0]
    # (실제 페이지는 한 줄로 minify 되지만 fixture/포맷 변형 대비 DOTALL)
    m = re.search(r'"liveChatRenderer":\{.*?"continuations":(\[.*?\])', html, re.DOTALL)
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
                "offset_ms": (int(offset)
                              if offset and str(offset).lstrip("-").isdigit()
                              else None),
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


def _parse_iso(s: str | None) -> datetime | None:
    try:
        return datetime.fromisoformat((s or "").replace("Z", "+00:00"))
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
    now = _parse_iso(now_iso) or datetime.now(UTC)
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
                log.info("live_chat %s: no replay continuation (chat off/not ready)",
                         video_id)
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
