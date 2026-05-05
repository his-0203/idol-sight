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
