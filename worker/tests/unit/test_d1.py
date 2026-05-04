import pytest
from pytest_httpx import HTTPXMock

from idol_sight.d1 import D1Client, D1Error


@pytest.fixture
def client():
    return D1Client(account_id="acc", db_id="db", api_token="tok")


def test_execute_sends_correct_request(client, httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        url="https://api.cloudflare.com/client/v4/accounts/acc/d1/database/db/query",
        method="POST",
        json={"success": True, "result": [{"results": [{"x": 1}], "meta": {}}]},
    )
    rows = client.execute("SELECT 1 AS x")
    assert rows == [{"x": 1}]
    req = httpx_mock.get_request()
    assert req is not None
    assert req.headers["Authorization"] == "Bearer tok"
    assert req.headers["Content-Type"] == "application/json"


def test_execute_with_params(client, httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        json={"success": True, "result": [{"results": [], "meta": {}}]},
    )
    client.execute("SELECT * FROM groups WHERE key=?", ["plave"])
    req = httpx_mock.get_request()
    body = req.read()
    assert b'"plave"' in body


def test_execute_raises_on_api_failure(client, httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        json={"success": False, "errors": [{"message": "syntax error"}]},
    )
    with pytest.raises(D1Error, match="syntax error"):
        client.execute("BORK")


def test_batch_returns_full_summary(client, httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        json={"success": True, "result": [
            {"results": [], "meta": {"changes": 1}},
            {"results": [], "meta": {"changes": 2}},
        ]},
    )
    summary = client.batch([
        ("INSERT INTO groups(key,name,name_kr) VALUES(?,?,?)", ["plave", "PLAVE", "플레이브"]),
        ("UPDATE groups SET is_active=1 WHERE key=?", ["plave"]),
    ])
    assert summary.statements_sent == 2
    assert summary.statements_executed == 2
    assert summary.total_changes == 3


def test_batch_detects_partial_failure(client, httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        json={"success": True, "result": [
            {"results": [], "meta": {"changes": 1}},
        ]},
    )
    summary = client.batch([
        ("INSERT INTO groups(key,name,name_kr) VALUES(?,?,?)", ["plave", "PLAVE", "플레이브"]),
        ("INSERT INTO groups(key,name,name_kr) VALUES(?,?,?)", ["isedol", "ISEDOL", "이세계아이돌"]),
    ])
    assert summary.statements_sent == 2
    assert summary.statements_executed == 1   # cloudflare returned only 1 result
    assert summary.total_changes == 1
