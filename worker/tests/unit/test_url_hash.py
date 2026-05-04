from idol_sight.utils.url_hash import url_hash


def test_url_hash_is_stable_sha1_hex():
    h = url_hash("https://example.com/x")
    assert isinstance(h, str)
    assert len(h) == 40
    assert all(c in "0123456789abcdef" for c in h)
    # Stable
    assert url_hash("https://example.com/x") == h


def test_different_urls_different_hashes():
    assert url_hash("https://a/") != url_hash("https://b/")


def test_normalizes_trailing_whitespace():
    assert url_hash("https://example.com/x") == url_hash("https://example.com/x\n")
    assert url_hash("https://example.com/x") == url_hash("  https://example.com/x  ")
