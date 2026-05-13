from pytest_httpx import HTTPXMock

from idol_sight.notify import notify_failure


def test_notify_failure_posts_to_webhook(httpx_mock: HTTPXMock):
    httpx_mock.add_response(url="https://discord.test/hook", status_code=204)
    notify_failure(webhook_url="https://discord.test/hook",
                   job="dc:plave",
                   error="cloudflare 403")
    req = httpx_mock.get_request()
    assert req is not None
    assert req.method == "POST"
    body = req.read()
    assert b"dc:plave" in body
    assert b"cloudflare 403" in body


def test_notify_failure_retries_on_5xx(httpx_mock: HTTPXMock):
    httpx_mock.add_response(url="https://discord.test/hook", status_code=500)
    httpx_mock.add_response(url="https://discord.test/hook", status_code=500)
    httpx_mock.add_response(url="https://discord.test/hook", status_code=204)
    notify_failure(webhook_url="https://discord.test/hook",
                   job="dc:plave",
                   error="x")
    requests = httpx_mock.get_requests()
    assert len(requests) == 3   # retried twice, succeeded on third


def test_notify_failure_does_not_retry_on_4xx(httpx_mock: HTTPXMock):
    httpx_mock.add_response(url="https://discord.test/hook", status_code=404)
    notify_failure(webhook_url="https://discord.test/hook",
                   job="dc:plave",
                   error="x")
    requests = httpx_mock.get_requests()
    assert len(requests) == 1   # 4xx is permanent — no retry


def test_notify_failure_swallows_persistent_5xx(httpx_mock: HTTPXMock):
    for _ in range(3):
        httpx_mock.add_response(url="https://discord.test/hook", status_code=500)
    notify_failure(webhook_url="https://discord.test/hook",
                   job="dc:plave",
                   error="x")
    # Must not raise even after retry exhaustion.


def test_notify_failure_no_op_on_none_webhook(httpx_mock: HTTPXMock):
    """webhook_url=None → silent return, no HTTP request.

    Settings.discord_webhook 이 옵셔널이라 read-only CLI 가 webhook 없이
    notify_failure 를 호출할 수 있다. 무음 fallback 이 계약.
    """
    notify_failure(webhook_url=None, job="dc:plave", error="x")
    # No request was attempted.
    assert httpx_mock.get_requests() == []


def test_notify_failure_no_op_on_empty_webhook(httpx_mock: HTTPXMock):
    """webhook_url='' (빈 문자열) 도 no-op."""
    notify_failure(webhook_url="", job="dc:plave", error="x")
    assert httpx_mock.get_requests() == []
