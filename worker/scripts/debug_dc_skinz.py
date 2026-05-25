"""Debug: SKINZ DC fetch — collector가 0행 parse하는 이유 진단.

Compares SKINZ vs PLAVE StealthyFetcher response to isolate whether:
  - StealthyFetcher receives a different (empty/challenge) page for SKINZ
  - DC mgallery markup for SKINZ differs from PLAVE
  - is_global_spam filter eats every row

Run: uv run python scripts/debug_dc_skinz.py
"""

from __future__ import annotations

from scrapling import StealthyFetcher
from idol_sight.collectors.dc import DcCollector, LIST_URL_TPL
from idol_sight.analysis.relevance import is_global_spam


def probe(gid: str) -> None:
    print(f"\n=== gid={gid} ===")
    url = LIST_URL_TPL.format(gallery_id=gid)
    print(f"url={url}")
    page = StealthyFetcher.fetch(
        url, headless=True, network_idle=True, solve_cloudflare=True,
    )
    html_size = len(page.html_content or "")
    print(f"html_size={html_size}")
    rows_table = page.css("table.gall_list tbody tr.us-post")
    rows_bare = page.css("tr.us-post")
    print(f"table.gall_list tr.us-post: {len(rows_table)}")
    print(f"tr.us-post (bare):          {len(rows_bare)}")

    parsed = DcCollector._parse(page)
    print(f"DcCollector._parse:         {len(parsed)} rows")
    if parsed:
        for r in parsed[:5]:
            spam = is_global_spam(r["title"])
            print(f"  - {'[SPAM]' if spam else '      '} {r['title'][:60]!r} posted={r['posted_at_raw']}")
        kept = [r for r in parsed if not is_global_spam(r["title"])]
        print(f"after is_global_spam filter: {len(kept)} rows")
    else:
        # Dump head of html for diagnosis
        head = (page.html_content or "")[:600]
        print(f"--- html head ---\n{head}\n--- end ---")


if __name__ == "__main__":
    for gid in ("skinz", "plave"):
        try:
            probe(gid)
        except Exception as e:  # noqa: BLE001
            print(f"ERROR for {gid}: {type(e).__name__}: {e}")
