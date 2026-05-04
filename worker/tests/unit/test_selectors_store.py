from unittest.mock import MagicMock

from idol_sight.selectors_store import SelectorsStore


def test_store_upserts_via_d1():
    client = MagicMock()
    store = SelectorsStore(client)
    store.save("dc", "gallery_post", '{"selector": "div.gall_list"}')
    sql, params = client.execute.call_args[0]
    assert "selectors_cache" in sql
    assert "dc" in params
    assert "gallery_post" in params
    assert '{"selector": "div.gall_list"}' in params


def test_load_returns_none_when_missing():
    client = MagicMock()
    client.execute.return_value = []
    store = SelectorsStore(client)
    assert store.load("dc", "gallery_post") is None


def test_load_returns_serialized_when_present():
    client = MagicMock()
    client.execute.return_value = [{"serialized": "blob"}]
    store = SelectorsStore(client)
    assert store.load("dc", "gallery_post") == "blob"
