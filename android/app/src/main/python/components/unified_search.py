"""
Unified Search Service
======================
Main entry point for searching across all audio sources.

Features:
- Parallel search across all configured sources
- Automatic result merging and deduplication
- Async/await support for fast parallel execution
- Configurable source selection
- Result ranking and filtering
- Caching support
"""

import asyncio
import time
from typing import List, Dict, Any, Set
from dataclasses import dataclass, field
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading

from components.source_merger import SourceMerger, SourceType
from components.fuzzy_matcher import FuzzyMatcher
# Client imports are done lazily in _get_client() to avoid eagerly loading heavy modules


@dataclass
class SearchConfig:
    """Configuration for search behavior."""

    enabled_sources: Set[SourceType] = field(
        default_factory=lambda: {
            SourceType.JIOSAAVN,
            SourceType.SOUNDCLOUD,
            SourceType.YOUTUBE,
            SourceType.ITUNES,
            SourceType.MUSICBRAINZ,
        }
    )
    max_results_per_source: int = 10
    max_total_results: int = 50
    timeout_seconds: float = 30.0
    enable_fuzzy_matching: bool = True
    fuzzy_score_cutoff: float = 70.0
    enable_metadata_enrichment: bool = True
    parallel_search: bool = True
    max_parallel_workers: int = 6
    cache_ttl_seconds: int = 3600


@dataclass
class SearchContext:
    """Context for a search request."""

    query: str
    config: SearchConfig
    fuzzy_matcher = None
    results_cache: Dict[str, Any] = field(default_factory=dict)
    start_time: float = field(default_factory=time.time)

    def elapsed(self) -> float:
        return time.time() - self.start_time

    def is_timed_out(self) -> bool:
        return self.elapsed() > self.config.timeout_seconds


class UnifiedSearchService:
    """
    Main service for unified audio search across all sources.

    Usage:
        service = UnifiedSearchService()
        results = service.search("believer imagine dragons")
    """

    # Cache configuration
    MAX_CACHE_SIZE = 100  # Maximum number of cached queries

    def __init__(self, config: SearchConfig = None):
        self.config = config or SearchConfig()
        self.fuzzy_matcher = FuzzyMatcher()
        self.source_merger = SourceMerger(fuzzy_matcher=self.fuzzy_matcher)

        # Initialize clients lazily
        self._clients: Dict[SourceType, Any] = {}
        self._clients_lock = threading.Lock()
        self._executor = ThreadPoolExecutor(max_workers=6)

        # Cache for search results
        self._cache: Dict[str, Dict] = {}
        self._cache_lock = threading.RLock()

    def _get_client(self, source_type: SourceType):
        """Lazily initialize and return client for source type."""
        with self._clients_lock:
            if source_type not in self._clients:
                if source_type == SourceType.JIOSAAVN:
                    from components.jiosaavn_downloader import JioSaavnClient

                    self._clients[source_type] = JioSaavnClient()
                elif source_type == SourceType.SOUNDCLOUD:
                    from components.soundcloud_downloader import SoundCloudClient

                    self._clients[source_type] = SoundCloudClient()
                elif source_type == SourceType.YOUTUBE:
                    from components.youtube_downloader import YouTubeClient

                    self._clients[source_type] = YouTubeClient()
                elif source_type == SourceType.ITUNES:
                    from components.itunes_client import iTunesClient

                    self._clients[source_type] = iTunesClient()
                elif source_type == SourceType.MUSICBRAINZ:
                    from components.musicbrainz_client import MusicBrainzClient

                    self._clients[source_type] = MusicBrainzClient()
        return self._clients.get(source_type)

    def _cleanup_cache(self, ttl_seconds: int):
        """Remove expired cache entries and enforce max cache size."""
        if ttl_seconds <= 0:
            return

        with self._cache_lock:
            now = time.time()
            # Remove expired entries
            expired_keys = [
                key
                for key, value in self._cache.items()
                if now >= value.get("expires", 0)
            ]
            for key in expired_keys:
                del self._cache[key]

            # Enforce max size (remove oldest by expiration time)
            if len(self._cache) >= self.MAX_CACHE_SIZE:
                # Sort by expiration time and remove oldest
                sorted_items = sorted(
                    self._cache.items(), key=lambda x: x[1].get("expires", 0)
                )
                # Keep only the newest MAX_CACHE_SIZE entries
                items_to_remove = len(self._cache) - self.MAX_CACHE_SIZE + 1
                for key, _ in sorted_items[:items_to_remove]:
                    del self._cache[key]

    def _search_source(
        self, source_type: SourceType, context: SearchContext
    ) -> List[Dict]:
        """Search a single source."""
        if context.is_timed_out():
            return []

        if source_type not in self.config.enabled_sources:
            return []

        client = self._get_client(source_type)
        if not client:
            return []

        try:
            query = context.query
            limit = context.config.max_results_per_source

            if source_type == SourceType.JIOSAAVN:
                client = self._clients[SourceType.JIOSAAVN]
                results = client.search(query, limit)
                # JioSaavn autocomplete is space-sensitive: "cold play" matches a
                # literal title ("A COLD PLAY") and MISSES the band "Coldplay",
                # losing our best (320k) source. Also query the de-spaced form
                # and merge (de-duped by id, original order first).
                squished = query.replace(" ", "")
                if squished and squished != query:
                    seen = {s.id for s in results}
                    try:
                        for s in client.search(squished, limit):
                            if s.id not in seen:
                                seen.add(s.id)
                                results.append(s)
                    except Exception:
                        pass
                # Convert to normalized format - JioSaavnSong has to_dict method
                return [
                    {"source_type": "jiosaavn", **song.to_dict()} for song in results
                ]

            elif source_type == SourceType.SOUNDCLOUD:
                client = self._clients[SourceType.SOUNDCLOUD]
                results = client.search(query, limit)
                return [
                    {"source_type": "soundcloud", **track.to_dict()}
                    for track in results
                ]

            elif source_type == SourceType.YOUTUBE:
                client = self._clients[SourceType.YOUTUBE]
                results = client.search(query, limit)
                # YouTubeTrack has to_dict method
                return [{"source_type": "youtube", **r.to_dict()} for r in results]

            elif source_type == SourceType.ITUNES:
                client = self._clients[SourceType.ITUNES]
                results = client.search_tracks(query, limit)
                return [
                    {"source_type": "itunes", **track.to_dict()} for track in results
                ]

            elif source_type == SourceType.MUSICBRAINZ:
                client = self._clients[SourceType.MUSICBRAINZ]
                results = client.search_recordings(query, limit)
                return [
                    {"source_type": "musicbrainz", **rec.to_dict()} for rec in results
                ]

        except Exception as e:
            # Log error but don't fail the whole search
            print(f"Error searching {source_type}: {e}")
            return []

        return []

    def search(self, query: str, config: SearchConfig = None) -> List:
        """
        Main search method.

        Args:
            query: Search query string
            config: Optional search configuration

        Returns:
            List of UnifiedTrack objects
        """
        config = config or self.config
        context = SearchContext(query=query, config=config)

        # Check cache. Repeat searches (same query + sources) return instantly.
        # The old code only cached the "comprehensive" path, so every search the
        # app actually ran (it always used the one "fast" mode) re-hit the
        # network even for an identical query.
        cache_key = (
            f"{query}:{hash(frozenset(config.enabled_sources))}:{config.max_total_results}"
        )
        if config.cache_ttl_seconds > 0:
            with self._cache_lock:
                if cache_key in self._cache:
                    cached = self._cache[cache_key]
                    if time.time() < cached.get("expires", 0):
                        return cached["results"]

        # Periodic cache cleanup (remove expired entries, enforce size limit)
        self._cleanup_cache(config.cache_ttl_seconds)

        all_results: Dict[SourceType, List[Dict]] = {}

        if config.parallel_search:
            # Parallel search across all sources
            futures = {}
            with ThreadPoolExecutor(
                max_workers=config.max_parallel_workers
            ) as executor:
                for source_type in config.enabled_sources:
                    future = executor.submit(self._search_source, source_type, context)
                    futures[future] = source_type

                for future in as_completed(futures):
                    if context.is_timed_out():
                        break
                    source_type = futures[future]
                    try:
                        results = future.result(timeout=config.timeout_seconds)
                        if results:
                            all_results[source_type] = results
                    except Exception as e:
                        print(f"Search failed for {source_type}: {e}")
        else:
            # Sequential search
            for source_type in config.enabled_sources:
                if context.is_timed_out():
                    break
                results = self._search_source(source_type, context)
                if results:
                    all_results[source_type] = results

        # Merge results
        if not any(all_results.values()):
            return []

        # ONE search algorithm: collect every source's hits, dedup to the best
        # entry per unique track (source priority JioSaavn → SoundCloud →
        # YouTube → …), then rank by relevance to the query. There used to be a
        # "fast" vs "comprehensive" split, but both took the SAME time (the cost
        # is the network wait for the sources, not the merge) and comprehensive's
        # only theoretical edge — merging one track across sources — never
        # actually fired in practice while it returned FEWER results. So there's
        # a single path now.
        merged = self._rank_by_relevance(self._merge_results(all_results), query)
        merged = merged[: config.max_total_results]

        if config.cache_ttl_seconds > 0:
            with self._cache_lock:
                self._cache[cache_key] = {
                    "results": merged,
                    "expires": time.time() + config.cache_ttl_seconds,
                }
        return merged

    def _rank_by_relevance(self, tracks: List, query: str) -> List:
        """Order results by a composite of: query relevance (primary) → source
        quality (JioSaavn 320k + cross-source corroboration preferred) → a
        query-aware junk penalty (derivative fan uploads sink). All CPU-only —
        no extra network — so the cleanest, most-correct result leads for free.
        """
        if not tracks or not query:
            return tracks

        # fuzz is rapidfuzz on desktop and a pure-Python equivalent on Android
        # (rapidfuzz is a C++ extension with no Android wheel). This used to bail
        # out on ImportError, which meant the APK returned results in raw source
        # order — unranked, and with the junk penalty below never applied.
        from components.fuzz_compat import fuzz

        import re as _re

        def norm(s: str) -> str:
            s = (s or "").lower()
            s = _re.sub(r"[^\w\s]", " ", s)
            return _re.sub(r"\s+", " ", s).strip()

        q = norm(query)
        qd = q.replace(" ", "")
        qtokens = set(q.split())

        # Markers of a derivative / low-fidelity fan upload. Penalized ONLY when
        # the user didn't ask for them (query lacks the word), so "clocks" ranks
        # the studio cut above "Clocks (slowed+reverb 8d)" while "clocks slowed"
        # still finds it.
        NOISE = {"slowed", "reverb", "reverbed", "sped", "lofi", "mashup", "megamix",
                 "nonstop", "karaoke", "8d", "boosted", "ringtone", "flip",
                 "refix", "bootleg", "remake", "instrumental", "remix", "remixed",
                 "nightcore", "chopped", "screwed"}
        HARD_JUNK = ("free download", "full album", "all songs", "jukebox",
                     "audio jukebox", "back to back")

        def relevance(title: str, artist: str, src_vals: set) -> float:
            if not title:
                return 0.0
            # Query IS an artist's name (space-insensitive) AND we trust the
            # artist (JioSaavn only — SC/YT artists are title-parsed/unreliable):
            # strongly prefer that artist's songs.
            if qd and len(qd) >= 4 and "jiosaavn" in src_vals:
                for part in _re.split(r"[,&/]|feat|ft| x ", artist):
                    if part.replace(" ", "").strip() == qd:
                        return 110.0
            s_title = fuzz.token_set_ratio(q, title)
            s_both = fuzz.token_set_ratio(q, f"{title} {artist}".strip())
            s_partial = fuzz.partial_ratio(q, title)
            return max(s_title, s_both, s_partial * 0.97)

        def composite(t) -> float:
            title = norm(getattr(t, "title", ""))
            artist = norm(getattr(t, "artist", ""))
            src_vals = {getattr(k, "value", k) for k in getattr(t, "sources", {})}
            base = relevance(title, artist, src_vals)
            if base <= 0:
                return -1.0
            # Source quality: JioSaavn (clean 320k catalog) >> SC/YT fan uploads;
            # a song corroborated across sources is more likely the real one.
            # Bonuses track RELIABILITY/cleanliness: JioSaavn > SoundCloud >
            # YouTube (heavier, more fan uploads), so a working clean source
            # leads — but YouTube is no longer hard-demoted (it plays fine now
            # that the EJS JS-challenge runtime is wired in, §28c).
            sb = 0.0
            if "jiosaavn" in src_vals:
                sb += 8.0
            if "soundcloud" in src_vals:
                sb += 4.0
            if "youtube" in src_vals or "youtube_music" in src_vals:
                sb += 1.0
            if len(src_vals) >= 2:
                sb += 4.0
            # Query-aware junk penalty.
            pen = 6.0 * len((set(title.split()) & NOISE) - qtokens)
            if any(h in title for h in HARD_JUNK):
                pen += 25.0
            return base + sb - pen

        scored = [(composite(t), getattr(t, "search_score", 0.0), t) for t in tracks]
        scored.sort(key=lambda x: (-x[0], -x[1]))
        return [t for _, _, t in scored]

    def _merge_results(self, all_results: Dict[SourceType, List[Dict]]) -> List:
        """Merge ALL sources into unified tracks so each song carries EVERY
        source it's available from (JioSaavn + SoundCloud + YouTube).

        The old version pre-deduped by raw title|artist and kept only the single
        highest-priority source, DROPPING the alternates — so a song whose
        SoundCloud copy is dead/DRM had no YouTube fallback, and the same song
        showed as several rows. SourceMerger groups by a cross-source key
        (artist-prefix/noise-stripped title + artist, album-agnostic), so those
        rows collapse into one multi-source track that can fall back at play
        time."""
        mapping = {
            SourceType.JIOSAAVN: "jiosaavn_results",
            SourceType.SOUNDCLOUD: "soundcloud_results",
            SourceType.YOUTUBE: "youtube_results",
            SourceType.DEEZER: "deezer_results",
            SourceType.ITUNES: "itunes_results",
            SourceType.MUSICBRAINZ: "musicbrainz_results",
        }
        kwargs = {mapping[k]: v for k, v in all_results.items() if v and k in mapping}
        return self.source_merger.merge_search_results(**kwargs)

    def shutdown(self):
        """Shutdown the thread pool executor."""
        if hasattr(self, "_executor") and self._executor:
            self._executor.shutdown(wait=True)
            self._executor = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.shutdown()
        return False

    def __del__(self):
        self.shutdown()


# ==================== HIGH-LEVEL API ====================


class MusicSearchAPI:
    """Simple synchronous API for common use cases."""

    def __init__(self, config: SearchConfig = None):
        self.service = UnifiedSearchService(config)

    def search(self, query: str, limit: int = 20) -> List:
        """Search for tracks and return simplified results."""
        config = self.service.config
        config.max_total_results = limit
        return self.service.search(query, config)

    def search_and_download(self, query: str, output_dir: str = ".") -> List[Dict]:
        """Search and download the best match."""
        results = self.search(query, limit=1)
        if not results:
            return []

        track = results[0]
        download_info = track.get_download_recommendations(
            [track], prefer_streaming=False
        )[0]

        if not download_info["url"]:
            return [{"error": "No download URL available"}]

        # Download using the appropriate client
        # (Implementation depends on source)
        return [
            {
                "track": track.to_dict(),
                "file_path": f"Downloads/{track.title}.mp3",
                "source": download_info["source"],
            }
        ]

    def get_track_by_isrc(self, isrc: str) -> Any:
        """Get full track metadata by ISRC."""
        # Search across all sources for this ISRC
        config = SearchConfig(
            enabled_sources=self.service.config.enabled_sources,
            max_results_per_source=1,
            max_total_results=5,
        )
        context = SearchContext(query=f"isrc:{isrc}", config=config)
        all_results = {}

        for source_type in config.enabled_sources:
            if source_type in [
                SourceType.JIOSAAVN,
                SourceType.SOUNDCLOUD,
                SourceType.MUSICBRAINZ,
                SourceType.ITUNES,
            ]:
                results = self.service._search_source(source_type, context)
                if results:
                    all_results[source_type] = [
                        r for r in results if r.get("isrc") == isrc
                    ]

        # Convert to merge_search_results kwargs
        source_mapping = {
            SourceType.JIOSAAVN: "jiosaavn_results",
            SourceType.SOUNDCLOUD: "soundcloud_results",
            SourceType.YOUTUBE: "youtube_results",
            SourceType.DEEZER: "deezer_results",
            SourceType.ITUNES: "itunes_results",
            SourceType.MUSICBRAINZ: "musicbrainz_results",
        }
        merge_kwargs = {
            source_mapping.get(k, k): v for k, v in all_results.items() if v
        }
        return self.service.source_merger.merge_search_results(**merge_kwargs)


# ==================== ASYNC VERSION ====================


class AsyncMusicSearchService:
    """Fully async version for high-performance concurrent searching."""

    def __init__(self, config: SearchConfig = None):
        self.sync_service = UnifiedSearchService(config)

    async def search(self, query: str, config: SearchConfig = None) -> List:
        """Async search using thread pool for blocking clients."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            None, lambda: self.sync_service.search(query, config)
        )

    async def search_multiple(
        self, queries: List[str], config: SearchConfig = None
    ) -> Dict[str, List]:
        """Search multiple queries in parallel."""
        tasks = [self.search(q, config) for q in queries]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        return {q: r for q, r in zip(queries, results) if not isinstance(r, Exception)}


# ==================== FACTORY FUNCTIONS ====================


def create_search_service(
    enabled_sources: Set[SourceType] = None,
    max_results: int = 20,
    timeout: float = 30.0,
) -> MusicSearchAPI:
    """Factory function to create a configured search service."""
    config = SearchConfig(
        enabled_sources=enabled_sources
        or {
            SourceType.JIOSAAVN,
            SourceType.SOUNDCLOUD,
            SourceType.YOUTUBE,
            SourceType.ITUNES,
            SourceType.MUSICBRAINZ,
        },
        max_total_results=max_results,
        timeout_seconds=timeout,
    )
    return MusicSearchAPI(config)


def quick_search(query: str, limit: int = 10) -> List:
    """One-liner for quick searches."""
    api = create_search_service(max_results=limit)
    return api.search(query, limit=limit)


def search_and_download(query: str, output_dir: str = ".") -> List[Dict]:
    """Search and download the best match."""
    api = create_search_service(max_results=1)
    return api.search_and_download(query, output_dir)


# ==================== CLI ====================

if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("Usage:")
        print('  python unified_search.py "query" [limit]')
        sys.exit(1)

    # Parse args
    query = sys.argv[1]
    limit = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else 20

    # Create service
    api = create_search_service(max_results=limit)

    print(f"Searching for: {query} (limit: {limit})")

    results = api.search(query, limit=limit)

    print(f"\nFound {len(results)} results:\n")
    for i, track in enumerate(results, 1):
        print(f"  {i}. {track.title} - {track.artist}")
        print(f"     Album: {track.album or 'N/A'}")
        print(
            f"     Duration: {track.duration_ms // 1000 // 60}:{track.duration_ms // 1000 % 60:02d}"
            if track.duration_ms
            else "     Duration: N/A"
        )
        if track.sources:
            sources = [s.value for s in track.sources.keys()]
            print(f"     Sources: {', '.join(sources)}")
        if track.isrc:
            print(f"     ISRC: {track.isrc}")
        print()
