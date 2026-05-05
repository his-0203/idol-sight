import pytest

from idol_sight.config import (
    GroupConfig,
    MissingEnv,
    load_settings,
)


def test_settings_loads_required_env(monkeypatch):
    for k, v in {
        "CF_ACCOUNT_ID": "a",
        "CF_D1_DB_ID": "b",
        "CF_API_TOKEN": "c",
        "DISCORD_WEBHOOK": "https://d/",
    }.items():
        monkeypatch.setenv(k, v)
    s = load_settings()
    assert s.cf_account_id == "a"
    assert s.cf_d1_db_id == "b"
    assert s.cf_api_token == "c"
    assert s.discord_webhook == "https://d/"


def test_settings_missing_env_raises(monkeypatch):
    monkeypatch.delenv("CF_ACCOUNT_ID", raising=False)
    with pytest.raises(MissingEnv, match="CF_ACCOUNT_ID"):
        load_settings()


def test_optional_env_falls_back(monkeypatch):
    for k in ("CF_ACCOUNT_ID", "CF_D1_DB_ID", "CF_API_TOKEN", "DISCORD_WEBHOOK"):
        monkeypatch.setenv(k, "x")
    monkeypatch.delenv("YT_API_KEY", raising=False)
    s = load_settings()
    assert s.yt_api_key is None


def test_groupconfig_parses_json_lists():
    g = GroupConfig(
        key="plave", name="PLAVE", name_kr="플레이브", debut_date="2023-03-12",
        yt_channel_id="UCx",
        dc_gallery_id="plave",
        naver_query="플레이브",
        context_keywords=["플레이브", "PLAVE"],
        blacklist_phrases=[],
        twitter_handles=["@plave_official"],
    )
    assert "PLAVE" in g.context_keywords
    assert g.is_pre_debut(now_iso="2026-05-04T00:00:00Z") is False
