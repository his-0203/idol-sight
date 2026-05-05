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
    discord_webhook: str
    yt_api_key: str | None
    gemini_api_key: str | None


def load_settings() -> Settings:
    return Settings(
        cf_account_id=_required("CF_ACCOUNT_ID"),
        cf_d1_db_id=_required("CF_D1_DB_ID"),
        cf_api_token=_required("CF_API_TOKEN"),
        discord_webhook=_required("DISCORD_WEBHOOK"),
        yt_api_key=_optional("YT_API_KEY"),
        gemini_api_key=_optional("GEMINI_API_KEY"),
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
