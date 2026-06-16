"""Environment + per-group configuration."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import datetime


class MissingEnv(RuntimeError):
    """Raised when a required environment variable is unset."""


def _required(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        raise MissingEnv(name)
    return v


def _optional(name: str) -> str | None:
    v = os.environ.get(name)
    return v if v else None


@dataclass(frozen=True)
class Settings:
    cf_account_id: str
    cf_d1_db_id: str
    cf_api_token: str
    # DISCORD_WEBHOOK 은 옵셔널 (2026-05-13~). backfill-targets 같이
    # D1 만 쓰고 알림 안 보내는 read-only CLI 가 webhook 없이도 동작해야
    # workflow setup job 에 불필요한 secret 노출 안 됨. notify_failure 가
    # None 이면 no-op 으로 fallback.
    discord_webhook: str | None
    yt_api_key: str | None
    gemini_api_key: str | None
    # 미완소년 소유자 OAuth (YouTube Analytics). 미완소년 채널에만 적용 —
    # 없으면 youtube-analytics 커맨드가 skip 한다. 다른 그룹은 OAuth 없음.
    miiwan_yt_oauth_client_id: str | None
    miiwan_yt_oauth_client_secret: str | None
    miiwan_yt_oauth_refresh_token: str | None


def load_settings() -> Settings:
    return Settings(
        cf_account_id=_required("CF_ACCOUNT_ID"),
        cf_d1_db_id=_required("CF_D1_DB_ID"),
        cf_api_token=_required("CF_API_TOKEN"),
        discord_webhook=_optional("DISCORD_WEBHOOK"),
        yt_api_key=_optional("YT_API_KEY"),
        gemini_api_key=_optional("GEMINI_API_KEY"),
        miiwan_yt_oauth_client_id=_optional("MIIWAN_YT_OAUTH_CLIENT_ID"),
        miiwan_yt_oauth_client_secret=_optional("MIIWAN_YT_OAUTH_CLIENT_SECRET"),
        miiwan_yt_oauth_refresh_token=_optional("MIIWAN_YT_OAUTH_REFRESH_TOKEN"),
    )


@dataclass(frozen=True)
class GroupConfig:
    key: str
    name: str
    name_kr: str
    debut_date: str | None
    yt_channel_id: str | None
    dc_gallery_id: str | None
    naver_query: str | None
    context_keywords: list[str] = field(default_factory=list)
    blacklist_phrases: list[str] = field(default_factory=list)
    twitter_handles: list[str] = field(default_factory=list)
    # Cross-group DC hub galleries (e.g. 'vboyband' 버추얼 보이그룹 통합갤)
    # where this group is mentioned alongside others. DcCollector fetches
    # each in addition to dc_gallery_id and filters by context_keywords —
    # primary gallery posts are kept unfiltered, supplemental posts must
    # pass is_relevant. Empty list = no supplemental fetches (default).
    dc_supplemental_galleries: list[str] = field(default_factory=list)
    # V2.28 — TheQoo / Instiz 의 supplemental boards. 사이트 검색이
    # 자동화 차단되어 V2.27 dc supplemental 패턴을 그대로 옮긴 인프라.
    # TheQoo 항목은 mid 값 (e.g. 'kpop'), Instiz 항목은 URL path
    # (e.g. 'musicpd'). 빈 리스트 = 보조 fetch 없음 (default).
    theqoo_supplemental_boards: list[str] = field(default_factory=list)
    instiz_supplemental_boards: list[str] = field(default_factory=list)

    def is_pre_debut(self, now_iso: str | None = None) -> bool:
        if not self.debut_date:
            return True
        if now_iso:
            now = datetime.fromisoformat(now_iso.replace("Z", "+00:00"))
        else:
            now = datetime.utcnow()
        try:
            debut = datetime.fromisoformat(self.debut_date)
        except ValueError:
            return True
        # Make both naive for comparison
        if now.tzinfo is not None and debut.tzinfo is None:
            now = now.replace(tzinfo=None)
        return now < debut
