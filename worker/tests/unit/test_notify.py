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


def test_notify_failure_swallows_5xx_after_retries(httpx_mock: HTTPXMock):
    for _ in range(3):
        httpx_mock.add_response(url="https://discord.test/hook", status_code=500)
    # Must not raise — notification failure should never break the worker.
    notify_failure(webhook_url="https://discord.test/hook",
                   job="dc:plave",
                   error="x")
