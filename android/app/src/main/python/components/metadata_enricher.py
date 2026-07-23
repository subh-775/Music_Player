"""
Metadata Enricher
=================
Overlays clean, real metadata (artist, album, artwork, release date, genre)
onto playable tracks using iTunes as the authoritative metadata source.

The playable audio still comes from JioSaavn/YouTube/SoundCloud — we only
replace the messy metadata those sources provide (e.g. YouTube "artist" =
channel name, JioSaavn "artist" = "Lyricist, Composer, Singer" mashup).

Strategy per track:
1. Search iTunes by "title artist", then by "title" alone (when the artist
   string is messy), and pick the best match — gated by title similarity +
   duration proximity so a wrong song is never applied.

Results are cached in-memory by a normalized title|artist key. Lookups are
called per-track (parallelised by the caller in /api/enrich).
"""

import re
import threading
from typing import Any, Dict, List, Optional

try:
    from rapidfuzz import fuzz
    _RAPIDFUZZ = True
except ImportError:  # pragma: no cover
    from difflib import SequenceMatcher
    _RAPIDFUZZ = False


def _ratio(a: str, b: str) -> float:
    if _RAPIDFUZZ:
        return fuzz.ratio(a, b)
    return SequenceMatcher(None, a, b).ratio() * 100


def _token_set_ratio(a: str, b: str) -> float:
    if _RAPIDFUZZ:
        return fuzz.token_set_ratio(a, b)
    return SequenceMatcher(None, a, b).ratio() * 100


class MetadataEnricher:
    """Enriches tracks with clean metadata from iTunes."""

    # Confidence gates
    TITLE_ACCEPT = 80.0           # title similarity to accept a match
    DURATION_TOLERANCE_MS = 4000  # ±4s counts as a duration match

    def __init__(self, timeout: int = 5):
        self._timeout = timeout
        self._itunes = None
        self._clients_lock = threading.Lock()
        self._cache: Dict[str, Optional[Dict[str, Any]]] = {}
        self._cache_lock = threading.Lock()

    def _get_itunes(self):
        with self._clients_lock:
            if self._itunes is None:
                from components.itunes_client import iTunesClient
                # Gentle rate limit (~10 req/s) to avoid iTunes 429 + backoff
                # storms when enriching many tracks concurrently.
                self._itunes = iTunesClient(timeout=self._timeout, rate_limit=0.1)
            return self._itunes

    @staticmethod
    def _norm(text: Optional[str]) -> str:
        if not text:
            return ""
        text = str(text).lower().strip()
        text = re.sub(r"[^\w\s]", " ", text)
        text = re.sub(r"\s+", " ", text).strip()
        return text

    def _cache_key(self, title: str, artist: str) -> str:
        return f"{self._norm(title)}|{self._norm(artist)}"

    @staticmethod
    def _query_variants(title: str, artist: str) -> List[str]:
        """Search queries, most-specific first. Title-only is the fallback for
        when the artist string is messy (channel names, comma mashups)."""
        title = (title or "").strip()
        artist = (artist or "").strip()
        variants = []
        if title and artist:
            variants.append(f"{title} {artist}")
        if title:
            variants.append(title)
        seen, out = set(), []
        for v in variants:
            if v.lower() not in seen:
                seen.add(v.lower())
                out.append(v)
        return out

    def _pick_best(self, q_title: str, q_artist: str, q_dur: Optional[int], results: List):
        """Score iTunes candidates; return the best that passes confidence gates."""
        nq_title = self._norm(q_title)
        nq_artist = self._norm(q_artist)
        best, best_score, best_pass = None, -1.0, False

        for r in results:
            try:
                c_title, c_artist, c_dur = r.name, r.artist_name, r.track_time_ms
            except Exception:
                continue

            title_score = _ratio(nq_title, self._norm(c_title))
            artist_score = _token_set_ratio(nq_artist, self._norm(c_artist)) if nq_artist else 0
            dur_match = bool(q_dur and c_dur and
                             abs(int(q_dur) - int(c_dur)) <= self.DURATION_TOLERANCE_MS)

            # Accept when: artist confirms it, OR a very strong title + duration,
            # OR a good title + duration (artist may be messy).
            passes = (
                (title_score >= self.TITLE_ACCEPT and artist_score >= 55) or
                (title_score >= 88 and dur_match) or
                (title_score >= self.TITLE_ACCEPT and dur_match)
            )
            composite = title_score + (artist_score * 0.4) + (20 if dur_match else 0)
            if composite > best_score:
                best, best_score, best_pass = r, composite, passes

        return best if best_pass else None

    @staticmethod
    def _to_meta(t) -> Dict[str, Any]:
        artwork = {}
        if t.artwork_url_600:
            artwork["600"] = t.artwork_url_600
        if t.artwork_url_300:
            artwork["300"] = t.artwork_url_300
        if t.artwork_url_100:
            artwork["100"] = t.artwork_url_100
        return {
            "artist": t.artist_name or "",
            "album": t.collection_name or "",
            "isrc": None,
            "release_date": t.release_date,
            "genre": t.primary_genre_name,
            "duration_ms": t.track_time_ms,
            "artwork": artwork,
        }

    def _lookup(self, title: str, artist: str, isrc: Optional[str],
                duration_ms: Optional[int]) -> Optional[Dict[str, Any]]:
        """Cached iTunes metadata lookup for a single (title, artist).
        `isrc` is accepted for signature stability but unused (iTunes has no
        ISRC search)."""
        key = self._cache_key(title, artist)
        with self._cache_lock:
            if key in self._cache:
                return self._cache[key]

        meta = None
        try:
            itunes = self._get_itunes()
            for query in self._query_variants(title, artist):
                results = []
                try:
                    results = itunes.search_tracks(query, limit=6)
                except Exception:
                    results = []
                best = self._pick_best(title, artist, duration_ms, results)
                if best:
                    meta = self._to_meta(best)
                    break
        except Exception:
            meta = None

        with self._cache_lock:
            self._cache[key] = meta
            if len(self._cache) > 1000:  # cap cache size
                for k in list(self._cache.keys())[:100]:
                    del self._cache[k]
        return meta
