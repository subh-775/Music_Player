"""
Fuzzy Matcher Module
====================
Replaces LLM-based title matching with fast, local fuzzy string matching.

Uses rapidfuzz for high-performance approximate string matching.
Supports multiple algorithms: Levenshtein, Jaro-Winkler, Token Sort, Token Set.
"""

import re
from typing import Optional, List, Dict, Any
from dataclasses import dataclass
from enum import Enum

# rapidfuzz on desktop, a pure-Python equivalent on Android (rapidfuzz is a C++
# extension with no Android wheel). Either way `fuzz` honours the algorithm the
# caller selected — the old difflib fallback collapsed every algorithm into a
# plain character ratio, quietly discarding token-set and partial semantics.
from components.fuzz_compat import fuzz


class MatchAlgorithm(Enum):
    """Fuzzy matching algorithms available."""

    LEVENSHTEIN = "levenshtein"  # Classic edit distance
    JARO_WINKLER = "jaro_winkler"  # Good for short strings
    TOKEN_SORT = "token_sort"  # Token order independent
    TOKEN_SET = "token_set"  # Handles extra words well
    PARTIAL_RATIO = "partial_ratio"  # Substring matching
    WEIGHTED_RATIO = "weighted_ratio"  # Best overall (default)


@dataclass
class MatchResult:
    """Result of a fuzzy match operation."""

    matched_text: str
    score: float
    original_index: int
    metadata: Dict[str, Any] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "matched_text": self.matched_text,
            "score": self.score,
            "original_index": self.original_index,
            "metadata": self.metadata or {},
        }


@dataclass
class FuzzyMatchConfig:
    """Configuration for fuzzy matching behavior."""

    algorithm: MatchAlgorithm = MatchAlgorithm.WEIGHTED_RATIO
    score_cutoff: float = 60.0  # Minimum score (0-100)
    max_results: int = 5  # Max matches to return
    case_sensitive: bool = False
    ignore_punctuation: bool = True
    # Weights for multi-title matching
    title_weight: float = 1.0
    artist_weight: float = 0.8
    album_weight: float = 0.5


class FuzzyMatcher:
    """
    High-performance fuzzy string matching for music metadata.

    Replaces LLM-based matching with local algorithms:
    - 1000x faster than LLM calls
    - No API keys or network required
    - Works offline
    - Deterministic results
    """

    def __init__(self, config: Optional[FuzzyMatchConfig] = None):
        self.config = config or FuzzyMatchConfig()

    def _normalize_text(self, text: str) -> str:
        """Normalize text for comparison."""
        if not text:
            return ""

        text = str(text)

        if not self.config.case_sensitive:
            text = text.lower()

        if self.config.ignore_punctuation:
            # Remove punctuation but keep spaces
            text = re.sub(r"[^\w\s]", " ", text)
            # Normalize whitespace
            text = re.sub(r"\s+", " ", text).strip()

        return text

    def _calculate_score(self, query: str, candidate: str) -> float:
        """Calculate similarity score using configured algorithm."""
        query_norm = self._normalize_text(query)
        candidate_norm = self._normalize_text(candidate)

        if not query_norm or not candidate_norm:
            return 0.0

        return self._get_scorer()(query_norm, candidate_norm)

    def _get_scorer(self):
        """Get the scorer for the configured algorithm."""
        if self.config.algorithm == MatchAlgorithm.LEVENSHTEIN:
            return fuzz.ratio
        elif self.config.algorithm == MatchAlgorithm.JARO_WINKLER:
            return fuzz.jaro_winkler
        elif self.config.algorithm == MatchAlgorithm.TOKEN_SORT:
            return fuzz.token_sort_ratio
        elif self.config.algorithm == MatchAlgorithm.TOKEN_SET:
            return fuzz.token_set_ratio
        elif self.config.algorithm == MatchAlgorithm.PARTIAL_RATIO:
            return fuzz.partial_ratio
        elif self.config.algorithm == MatchAlgorithm.WEIGHTED_RATIO:
            return fuzz.WRatio
        else:
            return fuzz.WRatio

    # ==================== SINGLE MATCH ====================

    def match_one(self, query: str, candidates: List[str]) -> Optional[MatchResult]:
        """
        Find the best match for a query among candidates.

        Args:
            query: Search query string
            candidates: List of candidate strings

        Returns:
            MatchResult with best match, or None if below cutoff
        """
        if not query or not candidates:
            return None

        best_match = None
        best_score = 0.0
        best_index = -1

        for i, candidate in enumerate(candidates):
            score = self._calculate_score(query, candidate)
            if score > best_score:
                best_score = score
                best_match = candidate
                best_index = i

        if best_score >= self.config.score_cutoff:
            return MatchResult(
                matched_text=best_match,
                score=best_score,
                original_index=best_index,
            )

        return None

    def match_multi(self, query: str, candidates: List[str]) -> List[MatchResult]:
        """
        Find multiple matches for a query among candidates.

        Args:
            query: Search query string
            candidates: List of candidate strings

        Returns:
            List of MatchResult sorted by score (highest first)
        """
        if not query or not candidates:
            return []

        results = []

        for i, candidate in enumerate(candidates):
            score = self._calculate_score(query, candidate)
            if score >= self.config.score_cutoff:
                results.append(
                    MatchResult(
                        matched_text=candidate,
                        score=score,
                        original_index=i,
                    )
                )

        # Sort by score descending
        results.sort(key=lambda r: r.score, reverse=True)

        return results[: self.config.max_results]

    # ==================== STRUCTURED MATCH (Music) ====================

    def match_track(
        self,
        query_title: str,
        query_artist: str = "",
        query_album: str = "",
        candidates: List[Dict[str, Any]] = None,
    ) -> Optional[MatchResult]:
        """
        Match a track query against structured track candidates.

        Candidates should be dicts with: title, artist, album (optional)

        Args:
            query_title: Title to search for
            query_artist: Artist to search for
            query_album: Album to search for (optional)
            candidates: List of dicts with title, artist, album keys

        Returns:
            Best matching candidate with score
        """
        if not candidates:
            return None

        best_score = 0.0
        best_index = -1
        best_candidate = None

        for i, candidate in enumerate(candidates):
            # Calculate weighted scores
            title_score = (
                self._calculate_score(query_title, candidate.get("title", ""))
                if query_title
                else 0
            )
            artist_score = (
                self._calculate_score(query_artist, candidate.get("artist", ""))
                if query_artist
                else 0
            )
            album_score = (
                self._calculate_score(query_album, candidate.get("album", ""))
                if query_album
                else 0
            )

            # Weighted combination
            total_score = (
                title_score * self.config.title_weight
                + artist_score * self.config.artist_weight
                + album_score * self.config.album_weight
            ) / (
                self.config.title_weight
                + self.config.artist_weight
                + self.config.album_weight
            )

            if total_score > best_score:
                best_score = total_score
                best_index = i
                best_candidate = candidate

        if best_score >= self.config.score_cutoff:
            return MatchResult(
                matched_text=best_candidate.get("title", ""),
                score=best_score,
                original_index=best_index,
                metadata=best_candidate,
            )

        return None

    def match_tracks_multi(
        self,
        query_title: str,
        query_artist: str = "",
        candidates: List[Dict[str, Any]] = None,
    ) -> List[MatchResult]:
        """Find multiple track matches with structured candidates."""
        if not candidates:
            return []

        results = []

        for i, candidate in enumerate(candidates):
            title_score = (
                self._calculate_score(query_title, candidate.get("title", ""))
                if query_title
                else 0
            )
            artist_score = (
                self._calculate_score(query_artist, candidate.get("artist", ""))
                if query_artist
                else 0
            )

            total_score = (
                title_score * self.config.title_weight
                + artist_score * self.config.artist_weight
            ) / (self.config.title_weight + self.config.artist_weight)

            if total_score >= self.config.score_cutoff:
                results.append(
                    MatchResult(
                        matched_text=candidate.get("title", ""),
                        score=total_score,
                        original_index=i,
                        metadata=candidate,
                    )
                )

        results.sort(key=lambda r: r.score, reverse=True)
        return results[: self.config.max_results]

    # ==================== UTILITY ====================

    def extract_best_match(
        self, query: str, candidates: List[str], default: str = None
    ) -> str:
        """
        Extract best match string or return default.

        Convenience method for simple use cases.
        """
        result = self.match_one(query, candidates)
        return result.matched_text if result else default

    def deduplicate(self, items: List[str], threshold: float = 85.0) -> List[str]:
        """
        Remove near-duplicates from a list of strings.

        Keeps the first occurrence of each group of similar strings.

        Args:
            items: List of strings to deduplicate
            threshold: Similarity threshold (0-100)

        Returns:
            Deduplicated list
        """
        if not items:
            return []

        unique = []
        seen = []

        for item in items:
            match = self.match_one(item, seen)
            if match and match.score >= threshold:
                continue  # Skip duplicate
            unique.append(item)
            seen.append(item)

        return unique

    def cluster_similar(
        self, items: List[str], threshold: float = 80.0
    ) -> List[List[str]]:
        """
        Group similar strings into clusters.

        Args:
            items: List of strings to cluster
            threshold: Minimum similarity to cluster together

        Returns:
            List of clusters (each cluster is a list of similar strings)
        """
        if not items:
            return []

        clusters = []
        remaining = list(items)

        while remaining:
            seed = remaining.pop(0)
            cluster = [seed]

            # Find all similar items
            i = 0
            while i < len(remaining):
                item = remaining[i]
                match = self.match_one(seed, [item])
                if match and match.score >= threshold:
                    cluster.append(item)
                    remaining.pop(i)
                else:
                    i += 1

            clusters.append(cluster)

        return clusters


# ==================== CONVENIENCE FUNCTIONS ====================

_default_matcher = None


def get_default_matcher() -> FuzzyMatcher:
    """Get or create default fuzzy matcher instance."""
    global _default_matcher
    if _default_matcher is None:
        _default_matcher = FuzzyMatcher()
    return _default_matcher


def match_songs(query: str, candidates: List[Dict]) -> Optional[Dict]:
    """Quick song matching using default matcher."""
    matcher = get_default_matcher()
    result = matcher.match_track(query_title=query, candidates=candidates)
    return result.metadata if result else None


def find_best_match(query: str, candidates: List[str]) -> Optional[str]:
    """Quick best match using default matcher."""
    matcher = get_default_matcher()
    result = matcher.match_one(query, candidates)
    return result.matched_text if result else None


def deduplicate_tracks(tracks: List[str], threshold: float = 85.0) -> List[str]:
    """Deduplicate track list using default matcher."""
    matcher = get_default_matcher()
    return matcher.deduplicate(tracks, threshold)


# ==================== CLI ====================

if __name__ == "__main__":
    import sys

    if len(sys.argv) < 3:
        print("Usage:")
        print('  python fuzzy_matcher.py match "query" "candidate1" "candidate2" ...')
        print('  python fuzzy_matcher.py multi "query" "candidate1" "candidate2" ...')
        print('  python fuzzy_matcher.py dedup "threshold" "item1" "item2" ...')
        sys.exit(1)

    command = sys.argv[1]

    if command == "match":
        if len(sys.argv) < 4:
            print(
                'Usage: python fuzzy_matcher.py match "query" "candidate1" "candidate2" ...'
            )
            sys.exit(1)

        query = sys.argv[2]
        candidates = sys.argv[3:]

        matcher = FuzzyMatcher()
        result = matcher.match_one(query, candidates)

        if result:
            print(f"Best match: {result.matched_text} (score: {result.score:.1f})")
        else:
            print("No match found above cutoff.")

    elif command == "multi":
        if len(sys.argv) < 4:
            print(
                'Usage: python fuzzy_matcher.py multi "query" "candidate1" "candidate2" ...'
            )
            sys.exit(1)

        query = sys.argv[2]
        candidates = sys.argv[3:]

        matcher = FuzzyMatcher()
        results = matcher.match_multi(query, candidates)

        if results:
            print(f"Top {len(results)} matches:")
            for r in results:
                print(f"  {r.matched_text} (score: {r.score:.1f})")
        else:
            print("No matches found above cutoff.")

    elif command == "dedup":
        if len(sys.argv) < 4:
            print(
                'Usage: python fuzzy_matcher.py dedup "threshold" "item1" "item2" ...'
            )
            sys.exit(1)

        threshold = float(sys.argv[2])
        items = sys.argv[3:]

        matcher = FuzzyMatcher()
        unique = matcher.deduplicate(items, threshold)

        print(f"Original: {len(items)} items")
        print(f"Deduplicated: {len(unique)} items")
        print("Unique items:")
        for item in unique:
            print(f"  {item}")

    else:
        print(f"Unknown command: {command}")
        sys.exit(1)
