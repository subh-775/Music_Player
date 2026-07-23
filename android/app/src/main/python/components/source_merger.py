"""
Source Merger Module
====================
Merges and deduplicates search results from multiple sources.

Handles:
- ISRC-based exact matching (highest confidence)
- Fuzzy matching on title + artist + album
- Score-based ranking and ranking
- Source priority weighting
- Metadata enrichment from best available source
"""

from typing import Optional, List, Dict, Any
from dataclasses import dataclass, field
from enum import Enum
from collections import defaultdict

from components.fuzzy_matcher import FuzzyMatcher
from components.fuzz_compat import fuzz


class SourceType(Enum):
    """Supported audio sources."""

    JIOSAAVN = "jiosaavn"
    SOUNDCLOUD = "soundcloud"
    YOUTUBE = "youtube"
    YOUTUBE_MUSIC = "youtube_music"
    DEEZER = "deezer"
    ITUNES = "itunes"
    MUSICBRAINZ = "musicbrainz"
    UNKNOWN = "unknown"


@dataclass
class AudioSource:
    """Represents an available audio source for a track."""

    source: SourceType
    url: str
    bitrate: Optional[int] = None
    codec: Optional[str] = None
    quality_note: Optional[str] = None  # e.g., "320kbps AAC", "256kbps MP3"
    preview_url: Optional[str] = None
    requires_auth: bool = False
    is_playable: bool = True
    # Score for ranking this source
    priority: int = 0  # Higher = preferred

    def to_dict(self) -> Dict[str, Any]:
        return {
            "source": self.source.value,
            "url": self.url,
            "bitrate": self.bitrate,
            "codec": self.codec,
            "quality_note": self.quality_note,
            "preview_url": self.preview_url,
            "requires_auth": self.requires_auth,
            "is_playable": self.is_playable,
            "priority": self.priority,
        }


@dataclass
class UnifiedTrack:
    """
    Unified track representation with all available metadata
    and sources merged from all providers.
    """

    # Core identifiers
    title: str
    artist: str
    album: Optional[str] = None

    # Identifiers
    isrc: Optional[str] = None
    duration_ms: Optional[int] = None
    track_number: Optional[int] = None
    disc_number: Optional[int] = None

    # Metadata
    release_date: Optional[str] = None
    genre: Optional[str] = None
    explicit: bool = False

    # Artwork
    artwork_urls: Dict[str, str] = field(default_factory=dict)  # size -> URL
    fallback_artwork: Optional[str] = None

    # Sources
    sources: Dict[SourceType, AudioSource] = field(default_factory=dict)
    primary_source: Optional[SourceType] = None

    # Metadata sources (which provider contributed what)
    metadata_sources: Dict[str, SourceType] = field(
        default_factory=dict
    )  # field -> source

    # Search/ranking
    search_score: float = 0.0
    popularity: Optional[int] = None

    # Provider-specific IDs
    provider_ids: Dict[SourceType, str] = field(default_factory=dict)

    def get_best_artwork(self, preferred_sizes: List[str] = None) -> Optional[str]:
        """Get best available artwork URL."""
        if preferred_sizes is None:
            preferred_sizes = [
                "1200",
                "1000",
                "600",
                "500",
                "xl",
                "300",
                "large",
                "source:jiosaavn",
                "source:youtube",
                "source:soundcloud",
                "100",
                "medium",
                "small",
                "source:deezer",
                "source:itunes",
            ]

        for size in preferred_sizes:
            if size in self.artwork_urls and isinstance(self.artwork_urls[size], str):
                return self.artwork_urls[size]

        if self.artwork_urls:
            for url in self.artwork_urls.values():
                if isinstance(url, str) and url:
                    return url

        return self.fallback_artwork

    def get_best_audio_source(self) -> Optional[AudioSource]:
        """Get the highest priority available audio source."""
        if not self.sources:
            return None

        # Sort by priority (descending)
        sorted_sources = sorted(
            self.sources.items(), key=lambda x: x[1].priority, reverse=True
        )
        return sorted_sources[0][1] if sorted_sources else None

    def get_download_url(self) -> Optional[str]:
        """Get the best URL for downloading the full track."""
        source = self.get_best_audio_source()
        return source.url if source else None

    def get_stream_url(self) -> Optional[str]:
        """Get the best URL for streaming (prefers preview if no full track)."""
        # Try full download source first
        source = self.get_best_audio_source()
        if source and source.url:
            return source.url

        # Fallback to preview
        for source in self.sources.values():
            if source.preview_url:
                return source.preview_url

        return None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "title": self.title,
            "artist": self.artist,
            "album": self.album,
            "isrc": self.isrc,
            "duration_ms": self.duration_ms,
            "release_date": self.release_date,
            "genre": self.genre,
            "explicit": self.explicit,
            "artwork_urls": self.artwork_urls,
            "fallback_artwork": self.fallback_artwork,
            "sources": {k.value: v.to_dict() for k, v in self.sources.items()},
            "primary_source": self.primary_source.value
            if self.primary_source
            else None,
            "metadata_sources": {k: v.value for k, v in self.metadata_sources.items()},
            "search_score": self.search_score,
            "popularity": self.popularity,
            "provider_ids": {k.value: v for k, v in self.provider_ids.items()},
        }


class SourceMerger:
    """
    Merges search results from multiple audio sources into unified tracks.

    Process:
    1. Collect results from all sources
    2. Group by ISRC (exact match) → highest confidence
    3. Fuzzy match remaining by title + artist + album
    4. Score and rank merged tracks
    5. Assign best sources for each track
    """

    # Default source priorities (higher = preferred for audio)
    DEFAULT_PRIORITIES = {
        SourceType.JIOSAAVN: 100,  # 320kbps AAC, direct download
        SourceType.SOUNDCLOUD: 80,  # 256kbps MP3
        SourceType.YOUTUBE_MUSIC: 70,  # High quality, but requires PO tokens
        SourceType.YOUTUBE: 60,  # Variable quality
        SourceType.DEEZER: 50,  # 30s preview only
        SourceType.ITUNES: 40,  # 30s preview, metadata only
        SourceType.MUSICBRAINZ: 30,  # Metadata only
    }

    PLAYABLE_SOURCES = {
        SourceType.JIOSAAVN,
        SourceType.SOUNDCLOUD,
        SourceType.YOUTUBE,
        SourceType.YOUTUBE_MUSIC,
    }

    def __init__(
        self,
        fuzzy_matcher=None,
        source_priorities: Dict[SourceType, int] = None,
        fuzzy_config=None,
    ):
        self.fuzzy_matcher = fuzzy_matcher or FuzzyMatcher()
        self.priorities = source_priorities or self.DEFAULT_PRIORITIES
        self.fuzzy_config = fuzzy_config

    def _normalize_text(self, text: str) -> str:
        """Normalize text for comparison."""
        if not text:
            return ""
        text = str(text).lower().strip()
        # Remove common punctuation
        import re

        text = re.sub(r"[^\w\s]", " ", text)
        text = re.sub(r"\s+", " ", text).strip()
        return text

    def _key_title(self, title: str, artist_norm: str) -> str:
        """Title normalized for CROSS-SOURCE matching: drop a leading
        '<artist> ' prefix (YouTube names songs 'Artist - Title') and
        identity-neutral noise ('official', 'video', 'lyrics', 'hd', ...). Version
        words (remix/mix/live/slowed/acoustic) are KEPT so a remix stays a
        distinct track. This is what lets the SoundCloud 'In Peace' and the
        YouTube 'Cold Blue - In Peace' merge into ONE track with both sources."""
        import re
        t = self._normalize_text(title)
        if artist_norm and t.startswith(artist_norm + " "):
            t = t[len(artist_norm) + 1:].strip()
        t = re.sub(r"\b(official|music|video|lyrics?|audio|hd|4k|visuali[sz]er|mv)\b", " ", t)
        return re.sub(r"\s+", " ", t).strip()

    def _generate_key(self, track: Dict) -> str:
        """Generate a normalized key for deduplication."""
        # Use ISRC if available (most reliable)
        isrc = track.get("isrc") or track.get("isrc_id")
        if isrc:
            return f"isrc:{isrc.lower()}"

        # Fallback to normalized title + artist. Album is deliberately EXCLUDED:
        # sources rarely agree on album text (often empty), which used to split
        # the SAME song across sources — so a dead SoundCloud copy had no YouTube
        # fallback. Title (artist-prefix/noise-stripped) + artist is the
        # cross-source identity.
        artist = self._normalize_text(track.get("artist", ""))
        title = self._key_title(track.get("title", ""), artist)
        return f"{title}|{artist}"

    # Sources whose `artist` field is a real artist credit. SoundCloud and
    # YouTube report the UPLOADER instead — "Blinding Lights" comes back credited
    # to "Minh Prime" or "8DZone" — so their artist string can never be used to
    # decide whether two rows are the same song.
    TRUSTED_ARTIST_SOURCES = {
        SourceType.JIOSAAVN,
        SourceType.ITUNES,
        SourceType.MUSICBRAINZ,
    }

    TITLE_MATCH_THRESHOLD = 88.0    # token_set_ratio, 0-100
    ARTIST_MATCH_THRESHOLD = 80.0
    DURATION_TOLERANCE_SEC = 15     # same song, different master/encode

    def _duration_sec(self, track: Dict) -> Optional[int]:
        ms = track.get("duration_ms")
        if ms:
            return int(ms) // 1000
        sec = track.get("duration_sec") or track.get("duration")
        return int(sec) if sec else None

    def _resolve_key(
        self, track: Dict, source_type: SourceType, buckets: List[Dict[str, Any]]
    ) -> str:
        """Find which existing song this row belongs to, or start a new bucket.

        The old code keyed on an EXACT normalized `title|artist`, so the same song
        from two sources only merged if both agreed on the artist string
        character-for-character. They never do — SoundCloud names the uploader —
        so one song showed up as three rows. This matches fuzzily instead.
        """
        # ISRC is authoritative. Never fuzzy-merge across a known ISRC boundary.
        isrc = track.get("isrc") or track.get("isrc_id")
        if isrc:
            return f"isrc:{str(isrc).lower()}"

        artist = self._normalize_text(track.get("artist", ""))
        title = self._key_title(track.get("title", ""), artist)
        trusted = source_type in self.TRUSTED_ARTIST_SOURCES
        duration = self._duration_sec(track)

        for b in buckets:
            if fuzz.token_set_ratio(title, b["title"]) < self.TITLE_MATCH_THRESHOLD:
                continue

            # Same title — but is it the same recording? Duration is the cheapest
            # honest signal, and it's what stops a 3-minute single from absorbing
            # a 60-minute mix that happens to share the title.
            if duration and b["duration"]:
                if abs(duration - b["duration"]) > self.DURATION_TOLERANCE_SEC:
                    continue

            # Only compare artists when BOTH sides actually report an artist.
            # If either is an uploader handle, a title+duration match is all the
            # evidence available — and it's the evidence we want to act on.
            if trusted and b["trusted"]:
                if (
                    fuzz.token_set_ratio(artist, b["artist"])
                    < self.ARTIST_MATCH_THRESHOLD
                ):
                    continue

            # A trusted source joining an uploader-named bucket upgrades it: the
            # real artist credit wins for any later comparison.
            if trusted and not b["trusted"]:
                b["artist"], b["trusted"] = artist, True
            if duration and not b["duration"]:
                b["duration"] = duration
            return b["key"]

        key = f"{title}|{artist}"
        buckets.append(
            {
                "key": key,
                "title": title,
                "artist": artist,
                "trusted": trusted,
                "duration": duration,
            }
        )
        return key

    def merge_results(
        self,
        source_results: Dict[SourceType, List[Dict]],
        enrich_metadata: bool = True,
    ) -> List:
        """
        Merge results from multiple sources into unified tracks.

        Args:
            source_results: Dict mapping SourceType -> list of raw result dicts
            enrich_metadata: Whether to fill missing metadata from other sources

        Returns:
            List of UnifiedTrack objects, sorted by relevance
        """
        # Collect all tracks with source attribution
        all_tracks: Dict[str, List[tuple]] = defaultdict(
            list
        )  # key -> [(source, track_dict), ...]

        # Buckets for the fuzzy pass — one per distinct song found so far.
        buckets: List[Dict[str, Any]] = []

        # Process each source's results
        for source_type, results in source_results.items():
            self.priorities.get(source_type, 0)

            for raw in results:
                # Normalize the raw result
                track = self._normalize_result(raw, source_type)
                key = self._resolve_key(track, source_type, buckets)
                all_tracks[key].append((source_type, track))

        # Merge tracks with same key
        merged = []
        for key, entries in all_tracks.items():
            merged_track = self._merge_entries(key, entries)
            merged.append(merged_track)

        # Rank and sort
        merged.sort(key=lambda t: -t.search_score)

        return merged

    def _normalize_result(self, raw: Dict, source_type: SourceType) -> Dict:
        """Normalize a raw source result into a standard format."""
        # This should be customized per source type
        normalized = {
            "source": raw.get("source_type", source_type),
            "source_priority": self.priorities.get(source_type, 0),
        }

        # Preserve provider artwork dictionaries before flat field mapping.
        if isinstance(raw.get("artwork"), dict):
            normalized["artwork"] = raw["artwork"]

        # Map common fields
        field_mapping = {
            "title": ["title", "name", "track_name"],
            "artist": ["artist", "artist_name", "uploader"],
            "album": ["album", "collection_name", "album_name"],
            "duration_ms": ["duration_ms", "length_ms"],
            "isrc": ["isrc", "isrc_id"],
            "release_date": ["release_date", "date", "first_release_date"],
            "genre": ["genre", "primary_genre_name", "tag"],
            "explicit": ["explicit", "explicit_lyrics"],
            "artwork_url": [
                "artwork_url",
                "cover_art",
                "thumbnail",
                "image_url",
                "best_artwork",
                "artworkUrl100",
                "artworkUrl300",
                "artworkUrl600",
                "artwork_url_100",
                "artwork_url_300",
                "artwork_url_600",
                "artwork_100",
                "artwork_300",
                "artwork_600",
                "cover_small",
                "cover_medium",
                "cover_large",
                "cover_xl",
            ],
            "preview_url": ["preview_url", "preview"],
            "url": ["url", "stream_url", "download_url", "link"],
            "bitrate": ["bitrate", "quality"],
            "codec": ["codec", "format"],
            "duration_sec": ["duration", "duration_sec", "length"],
            "release_year": ["release_year", "year"],
            "track_number": ["track_number", "track"],
            "popularity": ["popularity", "rank", "score"],
        }

        for std_field, possible_keys in field_mapping.items():
            for key in possible_keys:
                if key in raw and raw[key] is not None:
                    normalized[std_field] = raw[key]
                    break

        # Ensure duration is in ms
        if "duration_sec" in normalized and "duration_ms" not in normalized:
            normalized["duration_ms"] = int(normalized["duration_sec"] * 1000)

        # Set source-specific IDs
        for f in ["id", "track_id", "video_id", "mbid"]:
            if f in raw:
                normalized[f"provider_id:{f}"] = raw[f]

        return normalized

    def _merge_entries(self, key: str, entries: List[tuple]) -> UnifiedTrack:
        """Merge multiple entries for the same track key."""
        if not entries:
            raise ValueError("Cannot merge empty entries")

        # Sort entries by priority (descending)
        entries.sort(key=lambda x: x[1].get("source_priority", 0), reverse=True)

        # Primary entry (highest priority)
        primary_source, primary_data = entries[0]

        # Create unified track
        track = UnifiedTrack(
            title=primary_data.get("title", ""),
            artist=primary_data.get("artist", ""),
            album=primary_data.get("album"),
            isrc=primary_data.get("isrc"),
            duration_ms=primary_data.get("duration_ms"),
            release_date=primary_data.get("release_date"),
            genre=primary_data.get("genre"),
            explicit=primary_data.get("explicit", False),
            search_score=100.0,  # Will be updated after merge
        )

        # Track metadata sources
        for f in [
            "title",
            "artist",
            "album",
            "isrc",
            "duration_ms",
            "release_date",
            "genre",
            "explicit",
        ]:
            value = primary_data.get(f)
            if value is not None:
                track.metadata_sources[f] = primary_source

        # Process all entries (including primary) to ensure sources and artwork are properly aggregated
        for source_type, data in entries:
            source_url = data.get("url") or ""
            if source_type not in self.PLAYABLE_SOURCES:
                source_url = ""
            is_playable = bool(source_url) and source_type in self.PLAYABLE_SOURCES

            # Add source
            track.sources[source_type] = AudioSource(
                source=source_type,
                url=source_url,
                bitrate=data.get("bitrate"),
                codec=data.get("codec"),
                preview_url=data.get("preview_url"),
                is_playable=is_playable,
                priority=self.priorities.get(source_type, 0),
            )
            track.provider_ids[source_type] = str(
                data.get("id") or data.get("provider_id") or ""
            )

            # Fill missing metadata from this source
            # Only set attributes that actually exist on UnifiedTrack
            direct_fields = [
                "album",
                "release_date",
                "genre",
                "explicit",
                "isrc",
                "track_number",
                "disc_number",
                "popularity",
            ]
            for attr_name in direct_fields:
                if getattr(track, attr_name, None) is None:
                    value = data.get(attr_name)
                    if value is not None:
                        setattr(track, attr_name, value)
                        track.metadata_sources[attr_name] = source_type

            # Duration: take the LONGEST across sources, not the primary's value.
            # JioSaavn (highest priority) reports a 30s preview-snippet length for
            # some licensed Western tracks even though the full recording streams,
            # so trusting the primary alone showed "0:30" for a full song. The real
            # recording length is the longest any source reports.
            # ponytail ceiling: a genuinely longer alternate edit merged under the
            # same recording key would win — acceptable; the merge key strips
            # version words so merged entries are the same recording.
            cand_ms = data.get("duration_ms")
            if cand_ms is None and data.get("duration_sec"):
                cand_ms = int(data["duration_sec"] * 1000)
            if cand_ms and (track.duration_ms is None or cand_ms > track.duration_ms):
                track.duration_ms = cand_ms
                track.metadata_sources["duration_ms"] = source_type

            # Update source bitrate/codec if available
            if data.get("bitrate") and track.sources[source_type].bitrate is None:
                track.sources[source_type].bitrate = data["bitrate"]
            if data.get("codec") and track.sources[source_type].codec is None:
                track.sources[source_type].codec = data["codec"]

            # Merge artwork URLs - preserve size information
            # iTunes: artwork_100, artwork_300, artwork_600
            # Deezer: artwork dict with small, medium, large, xl
            # JioSaavn: image_url (single)
            # SoundCloud/YouTube: thumbnail (single)
            if "artwork_url" in data:
                artwork_url = data["artwork_url"]
                if isinstance(artwork_url, str) and artwork_url:
                    track.artwork_urls[f"source:{source_type.value}"] = artwork_url

            # Single-image sources: JioSaavn (image_url) and SoundCloud/YouTube
            # (thumbnail). These were documented but never actually captured —
            # so JioSaavn profile/radio tracks silently lost their cover art.
            for single_key in ("image_url", "thumbnail", "image"):
                val = data.get(single_key)
                if isinstance(val, str) and val and f"source:{source_type.value}" not in track.artwork_urls:
                    track.artwork_urls[f"source:{source_type.value}"] = val

            # Handle iTunes multiple artwork sizes
            for size_key in [
                "artwork_100",
                "artwork_300",
                "artwork_600",
                "artworkUrl100",
                "artworkUrl300",
                "artworkUrl600",
                "artwork_url_100",
                "artwork_url_300",
                "artwork_url_600",
            ]:
                if size_key in data and data[size_key]:
                    size = (
                        size_key.replace("artwork_", "")
                        .replace("artworkUrl", "")
                        .replace("artwork_url_", "")
                    )
                    track.artwork_urls[size] = data[size_key]

            # Handle Deezer artwork dict
            if "artwork" in data and isinstance(data["artwork"], dict):
                for size, url in data["artwork"].items():
                    if url:
                        track.artwork_urls[size] = url

            # Handle cover sizes from other sources
            for size_key in ["cover_small", "cover_medium", "cover_large", "cover_xl"]:
                if size_key in data and data[size_key]:
                    track.artwork_urls[size_key.replace("cover_", "")] = data[size_key]

            # Preserve preview URLs for future preview support, but don't treat them
            # as full playable streams in the main player.
            if data.get("preview_url") and not track.sources[source_type].preview_url:
                track.sources[source_type].preview_url = data["preview_url"]

        # Set primary source (highest priority with a full stream-capable URL)
        full_sources = [
            (s, src)
            for s, src in track.sources.items()
            if src.url and src.is_playable and not src.requires_auth
        ]
        if full_sources:
            full_sources.sort(key=lambda x: -x[1].priority)
            track.primary_source = full_sources[0][0]

        # Set best artwork
        self._select_best_artwork(track)

        # Calculate final search score
        track.search_score = self._calculate_search_score(track)

        return track

    def _select_best_artwork(self, track: UnifiedTrack):
        """Select the highest resolution artwork available."""
        # Prefer iTunes/Apple (600x600), then Deezer (500x500), then JioSaavn
        # Artwork is now stored with size keys: "600", "300", "100", "xl", "large", "medium", "small"
        # get_best_artwork will pick the best size automatically

        # Set fallback_artwork to the highest resolution available
        if track.artwork_urls:
            # Priority order: 600 > xl/500 > 300 > large > 100 > medium > small
            size_priority = [
                "1200",
                "1000",
                "600",
                "500",
                "xl",
                "300",
                "large",
                "source:jiosaavn",
                "source:youtube",
                "source:soundcloud",
                "100",
                "medium",
                "small",
                "source:deezer",
                "source:itunes",
            ]
            for size in size_priority:
                if size in track.artwork_urls and isinstance(track.artwork_urls[size], str):
                    track.fallback_artwork = track.artwork_urls[size]
                    break
            else:
                # Use any available
                for url in track.artwork_urls.values():
                    if isinstance(url, str) and url:
                        track.fallback_artwork = url
                        break

    def _calculate_search_score(self, track: UnifiedTrack) -> float:
        """Calculate relevance score for ranking."""
        score = 100.0

        # Penalize missing metadata
        if not track.album:
            score -= 5
        if not track.release_date:
            score -= 3
        if not track.isrc:
            score -= 10
        if not track.duration_ms:
            score -= 5
        if not track.genre:
            score -= 2

        # Bonus for ISRC (exact match capability)
        if track.isrc:
            score += 15

        # Bonus for multiple sources
        score += min(len(track.sources) * 5, 20)

        # Primary source quality bonus
        if track.primary_source:
            priority = self.priorities.get(track.primary_source, 0)
            score += priority * 0.1

        return max(0, score)

    # ==================== PUBLIC API ====================

    def merge_search_results(
        self,
        jiosaavn_results: List[Dict] = None,
        soundcloud_results: List[Dict] = None,
        youtube_results: List[Dict] = None,
        deezer_results: List[Dict] = None,
        itunes_results: List[Dict] = None,
        musicbrainz_results: List[Dict] = None,
        **other_results,
    ) -> List[UnifiedTrack]:
        """
        Convenience method to merge results from all known sources.
        """
        source_results = {}

        if jiosaavn_results:
            source_results[SourceType.JIOSAAVN] = jiosaavn_results
        if soundcloud_results:
            source_results[SourceType.SOUNDCLOUD] = soundcloud_results
        if youtube_results:
            source_results[SourceType.YOUTUBE] = youtube_results
        if deezer_results:
            source_results[SourceType.DEEZER] = deezer_results
        if itunes_results:
            source_results[SourceType.ITUNES] = itunes_results
        if musicbrainz_results:
            source_results[SourceType.MUSICBRAINZ] = musicbrainz_results

        # Add any additional sources
        for source_str, results in other_results.items():
            try:
                source_type = SourceType(source_str)
                source_results[source_type] = results
            except ValueError:
                # Unknown source type, use UNKNOWN
                if SourceType.UNKNOWN not in source_results:
                    source_results[SourceType.UNKNOWN] = []
                source_results[SourceType.UNKNOWN].extend(results)

        return self.merge_results(source_results)

    def find_track_by_isrc(
        self,
        isrc: str,
        source_results: Dict[SourceType, List[Dict]],
    ) -> Optional[Any]:
        """Find a track by ISRC across all source results."""
        for source_type, results in source_results.items():
            for raw in results:
                if raw.get("isrc") == isrc or raw.get("isrc_id") == isrc:
                    return self._merge_entries(
                        "isrc:" + isrc,
                        [(source_type, self._normalize_result(raw, source_type))],
                    )
        return None

    def get_download_recommendations(
        self,
        tracks: List[UnifiedTrack],
        prefer_streaming: bool = False,
    ) -> List[Dict]:
        """Get download/stream recommendations for a list of tracks."""
        recommendations = []

        for track in tracks:
            source = track.get_best_audio_source()

            if prefer_streaming:
                url = track.get_stream_url()
                url_type = "stream"
            else:
                url = track.get_download_url()
                url_type = "download"

            if url:
                recommendations.append(
                    {
                        "track": track.to_dict(),
                        "url": url,
                        "type": url_type,
                        "source": source.source.value if source else None,
                        "bitrate": source.bitrate if source else None,
                        "codec": source.codec if source else None,
                    }
                )

        return recommendations


# ==================== CONVENIENCE FUNCTIONS ====================


def merge_sources(
    jiosaavn_results: List[Dict] = None,
    soundcloud_results: List[Dict] = None,
    youtube_results: List[Dict] = None,
    deezer_results: List[Dict] = None,
    itunes_results: List[Dict] = None,
    musicbrainz_results: List[Dict] = None,
) -> List:
    """Convenience function to merge results from all sources."""
    merger = SourceMerger()
    return merger.merge_search_results(
        jiosaavn_results=jiosaavn_results,
        soundcloud_results=soundcloud_results,
        youtube_results=youtube_results,
        deezer_results=deezer_results,
        itunes_results=itunes_results,
        musicbrainz_results=musicbrainz_results,
    )


# ==================== CLI ====================

if __name__ == "__main__":
    import sys
    import json

    if len(sys.argv) < 2:
        print("Usage: python source_merger.py <command> [args]")
        print("Commands:")
        print("  merge <source1.json> <source2.json> ... - Merge result files")
        print("  demo - Run demo with sample data")
        sys.exit(1)

    command = sys.argv[1]

    if command == "demo":
        # Create sample data
        merger = SourceMerger()

        # Sample JioSaavn results
        jiosaavn = [
            {
                "title": "Believer",
                "artist": "Imagine Dragons",
                "album": "Evolve",
                "isrc": "USUG11700235",
                "duration_ms": 204386,
                "release_date": "2017-07-23",
                "genre": "Alternative",
                "artwork_url": "https://c.saavncdn.com/248/Evolve-English-2018-20260605220036-500x500.jpg",
                "url": "https://example.com/jiosaavn/believer.mp4",
                "bitrate": 320000,
                "codec": "aac",
            }
        ]

        # Sample SoundCloud results
        soundcloud = [
            {
                "title": "Believer",
                "artist": "Imagine Dragons",
                "album": "Evolve",
                "isrc": "USUG11700235",
                "duration_ms": 204386,
                "url": "https://soundcloud.com/...",
                "bitrate": 256,
                "codec": "mp3",
            }
        ]

        # Sample iTunes results
        itunes = [
            {
                "title": "Believer",
                "artist": "Imagine Dragons",
                "album": "Evolve",
                "isrc": "USUG11700235",
                "release_date": "2017-07-23",
                "artwork_url": "https://is1-ssl.mzstatic.com/image/thumb/...100x100bb.jpg",
                "preview_url": "https://audio-ssl.itunes.apple.com/...mzaf_12345.plus.aac.p.m4a",
            }
        ]

        # Sample MusicBrainz
        musicbrainz = [
            {
                "title": "Believer",
                "artist": "Imagine Dragons",
                "isrc": "USUG11700235",
                "release_date": "2017-07-23",
                "genre": "alternative rock",
            }
        ]

        # Merge
        merged = merge_sources(
            jiosaavn_results=jiosaavn,
            soundcloud_results=soundcloud,
            itunes_results=itunes,
            musicbrainz_results=[],
        )

        print(f"Merged {len(merged)} tracks:\n")
        for track in merged:
            print(json.dumps(track.to_dict(), indent=2))
            print()

    else:
        print("Unknown command")
        sys.exit(1)
