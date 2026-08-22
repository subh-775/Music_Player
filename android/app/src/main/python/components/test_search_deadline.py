"""Self-check for UnifiedSearchService.search's parallel deadline.

Run it directly:  python components/test_search_deadline.py

Guards the rewrite of the parallel block. The old code built a per-search
ThreadPoolExecutor inside a `with`, so its shutdown(wait=True) blocked until the
slowest source finished no matter what the timeout said — the timeout only ever
changed which results were kept, never how long the user waited. It also handed
EACH future the full timeout, making the worst case timeout x sources.

The two things that must stay true:
  1. A slow source cannot make the search outlast its deadline.
  2. The sources that DID answer in time are still returned.

Both are asserted against a real service with _search_source monkeypatched, so
this exercises the actual executor code rather than a copy of it.
"""

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from components.source_merger import SourceType  # noqa: E402
from components.unified_search import (  # noqa: E402
    SearchConfig,
    UnifiedSearchService,
)


def _row(title, source):
    """The dict shape _search_source is expected to return."""
    return {
        "title": title,
        "artist": "Test Artist",
        "album": "Test Album",
        "url": f"https://example.invalid/{source}/{title}",
        "duration_ms": 200000,
        "source": source,
    }


def main():
    service = UnifiedSearchService()

    SLOW = 6.0        # far beyond the deadline
    DEADLINE = 1.5

    def fake_search_source(source_type, context):
        if source_type == SourceType.SOUNDCLOUD:
            time.sleep(SLOW)          # the straggler
            return [_row("slow song", "soundcloud")]
        return [_row("fast song", "jiosaavn")]

    service._search_source = fake_search_source

    config = SearchConfig(
        enabled_sources={SourceType.JIOSAAVN, SourceType.SOUNDCLOUD},
        timeout_seconds=DEADLINE,
        max_total_results=10,
        cache_ttl_seconds=0,          # never serve this from cache
    )

    start = time.time()
    results = service.search("deadline probe", config)
    elapsed = time.time() - start

    # 1. The deadline is real. Generous headroom so a loaded CI box doesn't
    #    flake, but nowhere near the 6s the slow source takes.
    assert elapsed < DEADLINE + 2.0, (
        f"search took {elapsed:.1f}s against a {DEADLINE}s deadline — "
        "it is still blocking on the slow source"
    )

    # 2. Partial results still ship: the fast source made it.
    titles = [(t.title or "").lower() for t in results]
    assert any("fast" in t for t in titles), (
        f"the fast source's results were dropped: {titles}"
    )

    print(f"search deadline: OK ({elapsed:.2f}s for a {DEADLINE}s deadline, "
          f"{len(results)} result(s) from the source that answered)")


if __name__ == "__main__":
    main()
