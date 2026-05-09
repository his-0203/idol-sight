import httpx
import pytest
from pytest_httpx import HTTPXMock

from idol_sight.d1 import D1Client, D1Error


@pytest.fixture
def client():
    return D1Client(account_id="acc", db_id="db", api_token="tok")


@pytest.fixture
def no_sleep(monkeypatch):
    """Make backoff retry instant in tests."""
    import time
    monkeypatch.setattr(time, "sleep", lambda *_: None)


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
    assert req is not None
    body = req.read()
    assert b'"plave"' in body


def test_execute_raises_on_api_failure(client, httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        json={"success": False, "errors": [{"message": "syntax error"}]},
    )
    with pytest.raises(D1Error, match="syntax error"):
        client.execute("BORK")


def test_batch_returns_full_summary(client, httpx_mock: HTTPXMock):
    # batch sends one HTTP request per statement (sequential). Each returns
    # a standard envelope with one result entry.
    httpx_mock.add_response(json={"success": True,
        "result": [{"results": [], "meta": {"changes": 1}}]})
    httpx_mock.add_response(json={"success": True,
        "result": [{"results": [], "meta": {"changes": 2}}]})
    summary = client.batch([
        ("INSERT INTO groups(key,name,name_kr) VALUES(?,?,?)", ["plave", "PLAVE", "플레이브"]),
        ("UPDATE groups SET is_active=1 WHERE key=?", ["plave"]),
    ])
    assert summary.statements_sent == 2
    assert summary.statements_executed == 2
    assert summary.total_changes == 3


def test_batch_raises_on_first_statement_error(client, httpx_mock: HTTPXMock):
    # If a statement fails mid-batch, raise — the orchestrator will record
    # it as a partial failure via crawl_meta.
    httpx_mock.add_response(json={"success": True,
        "result": [{"results": [], "meta": {"changes": 1}}]})
    httpx_mock.add_response(json={"success": False,
        "errors": [{"message": "constraint violation"}]})
    with pytest.raises(D1Error, match="constraint violation"):
        client.batch([
            ("INSERT INTO groups(key,name,name_kr) VALUES(?,?,?)",
             ["plave", "PLAVE", "플레이브"]),
            ("INSERT INTO groups(key,name,name_kr) VALUES(?,?,?)",
             ["isedol", "ISEDOL", "이세계아이돌"]),
        ])


# ---- retry behavior on transient Cloudflare statuses --------------------
# D1's REST endpoint occasionally returns 429 (rate limiting) or 5xx under
# load — particularly when collect-hourly fans out 9 group jobs in
# parallel. Without retry, a single transient throttle fails the whole
# matrix slot (root cause of 2026-05-09 collect-hourly failure).

def test_execute_retries_on_429(client, httpx_mock: HTTPXMock, no_sleep):
    httpx_mock.add_response(status_code=429, text="rate limited")
    httpx_mock.add_response(json={
        "success": True,
        "result": [{"results": [{"x": 1}], "meta": {}}],
    })
    rows = client.execute("SELECT 1 AS x")
    assert rows == [{"x": 1}]
    assert len(httpx_mock.get_requests()) == 2


def test_execute_retries_on_503(client, httpx_mock: HTTPXMock, no_sleep):
    httpx_mock.add_response(status_code=503, text="unavailable")
    httpx_mock.add_response(json={
        "success": True,
        "result": [{"results": [], "meta": {}}],
    })
    client.execute("SELECT 1")
    assert len(httpx_mock.get_requests()) == 2


def test_execute_gives_up_after_max_attempts(
    client, httpx_mock: HTTPXMock, no_sleep,
):
    # Hard-cap: 6 attempts (1 initial + 5 retries). Mocking exactly 6
    # responses double-checks the cap — pytest_httpx fails teardown if
    # any extra response goes unconsumed.
    for _ in range(6):
        httpx_mock.add_response(status_code=429, text="rate limited")
    with pytest.raises(httpx.HTTPStatusError):
        client.execute("SELECT 1")
    assert len(httpx_mock.get_requests()) == 6


def test_execute_does_not_retry_on_400(
    client, httpx_mock: HTTPXMock, no_sleep,
):
    httpx_mock.add_response(status_code=400, text="bad request")
    with pytest.raises(httpx.HTTPStatusError):
        client.execute("SELECT 1")
    # Client errors other than 429 are not transient — fail fast.
    assert len(httpx_mock.get_requests()) == 1


def test_batch_retries_transient_per_statement(
    client, httpx_mock: HTTPXMock, no_sleep,
):
    httpx_mock.add_response(json={
        "success": True,
        "result": [{"results": [], "meta": {"changes": 1}}],
    })
    httpx_mock.add_response(status_code=429)
    httpx_mock.add_response(json={
        "success": True,
        "result": [{"results": [], "meta": {"changes": 2}}],
    })
    summary = client.batch([
        ("INSERT INTO t(x) VALUES(?)", [1]),
        ("INSERT INTO t(x) VALUES(?)", [2]),
    ])
    assert summary.statements_executed == 2
    assert summary.total_changes == 3
    assert len(httpx_mock.get_requests()) == 3
