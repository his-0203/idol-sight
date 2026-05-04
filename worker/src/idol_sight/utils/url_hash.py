"""SHA-1 URL hash for primary-key columns in raw_* tables."""

from __future__ import annotations

import hashlib


def url_hash(url: str) -> str:
    """Return the lowercase hex SHA-1 of the (stripped) URL."""
    return hashlib.sha1(url.strip().encode("utf-8")).hexdigest()
