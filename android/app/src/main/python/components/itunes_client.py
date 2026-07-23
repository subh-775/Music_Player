"""
iTunes Search API Client
=========================
Metadata enrichment via Apple's iTunes Search API.

Features:
- No authentication required
- Worldwide access (no regional restrictions)
- 600x600 high-resolution artwork
- 30-second preview URLs
- Genre, release date, track pricing
- Global music catalog
- Rate limiting: ~20 requests/second (respectful)

API Docs: https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/
"""

import time
import requests
from typing import Optional, Dict, List, Any, Literal
from dataclasses import dataclass, field


@dataclass
class iTunesTrack:
    """Track metadata from iTunes Search API."""

    track_id: str
    name: str
    artist_name: str
    artist_id: str
    collection_name: str
    collection_id: str
    collection_type: str  # 'Album', 'Single', etc.
    artwork_url_100: str
    artwork_url_600: str  # Generated from 100
    artwork_url_300: str
    preview_url: Optional[str] = None
    track_time_ms: Optional[int] = None
    track_price: Optional[float] = None
    collection_price: Optional[float] = None
    currency: str = "USD"
    primary_genre_name: Optional[str] = None
    release_date: Optional[str] = None
    track_number: Optional[int] = None
    track_count: Optional[int] = None
    disc_number: Optional[int] = None
    disc_count: Optional[int] = None
    is_streamable: bool = True
    content_advisory_rating: Optional[str] = None  # 'Explicit' or 'Clean'
    country: str = "US"

    @property
    def search_query(self) -> str:
        return f"{self.name} {self.artist_name}"

    @property
    def duration_sec(self) -> Optional[int]:
        if self.track_time_ms:
            return round(self.track_time_ms / 1000)
        return None

    @property
    def duration_formatted(self) -> str:
        if self.track_time_ms:
            ms = self.track_time_ms
            m = ms // 60000
            s = (ms % 60000) // 1000
            return f"{m}:{s:02d}"
        return "?:??"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "track_id": self.track_id,
            "name": self.name,
            "artist_name": self.artist_name,
            "artist_id": self.artist_id,
            "album": self.collection_name,
            "album_id": self.collection_id,
            "duration_ms": self.track_time_ms,
            "duration_sec": self.duration_sec,
            "duration_formatted": self.duration_formatted,
            "artwork_100": self.artwork_url_100,
            "artwork_300": self.artwork_url_300,
            "artwork_600": self.artwork_url_600,
            "preview_url": self.preview_url,
            "price": self.track_price,
            "album_price": self.collection_price,
            "currency": self.currency,
            "genre": self.primary_genre_name,
            "release_date": self.release_date,
            "track_number": self.track_number,
            "explicit": self.content_advisory_rating == "Explicit",
            "country": self.country,
            "search_query": self.search_query,
        }


@dataclass
class iTunesArtist:
    """Artist info from iTunes."""

    artist_id: str
    name: str
    artist_link_url: str
    primary_genre_name: Optional[str] = None
    genres: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "artist_id": self.artist_id,
            "name": self.name,
            "link": self.artist_link_url,
            "primary_genre": self.primary_genre_name,
            "genres": self.genres,
        }


@dataclass
class iTunesAlbum:
    """Album info from iTunes."""

    collection_id: str
    name: str
    artist_name: str
    artist_id: str
    artwork_url_100: str
    artwork_url_600: str
    release_date: Optional[str] = None
    primary_genre_name: Optional[str] = None
    track_count: Optional[int] = None
    price: Optional[float] = None
    currency: str = "USD"
    copyright: Optional[str] = None
    release_year: Optional[int] = None

    @property
    def artwork_url_300(self) -> str:
        return self.artwork_url_100.replace("100x100", "300x300")

    def to_dict(self) -> Dict[str, Any]:
        return {
            "album_id": self.collection_id,
            "name": self.name,
            "artist_name": self.artist_name,
            "artist_id": self.artist_id,
            "artwork_100": self.artwork_url_100,
            "artwork_600": self.artwork_url_600,
            "release_date": self.release_date,
            "genre": self.primary_genre_name,
            "track_count": self.track_count,
            "price": self.price,
            "currency": self.currency,
        }


@dataclass
class SearchResult:
    """Generic search result container."""

    tracks: List = field(default_factory=list)  # iTunesTrack
    artists: List = field(default_factory=list)  # iTunesArtist
    albums: List = field(default_factory=list)  # iTunesAlbum
    total_results: int = 0


class iTunesClient:
    """
    iTunes Search API client for metadata enrichment.

    No authentication required, worldwide access, generous rate limits.
    """

    BASE_URL = "https://itunes.apple.com"
    SEARCH_URL = f"{BASE_URL}/search"
    LOOKUP_URL = f"{BASE_URL}/lookup"

    # Entity types for search
    ENTITY_TRACK = "musicTrack"
    ENTITY_ALBUM = "album"
    ENTITY_ARTIST = "musicArtist"
    ENTITY_MIX = "mix"
    ENTITY_SONG = "song"

    # Media types
    MEDIA_MUSIC = "music"
    MEDIA_PODCAST = "podcast"
    MEDIA_MUSIC_VIDEO = "musicVideo"

    # Attributes for search
    ATTRIBUTE_TRACK = "trackTerm"
    ATTRIBUTE_ARTIST = "artistTerm"
    ATTRIBUTE_ALBUM = "albumTerm"
    ATTRIBUTE_GENRE = "genreTerm"
    ATTRIBUTE_COMPOSER = "composerTerm"

    def __init__(
        self,
        default_country: str = "US",
        default_media: str = "music",
        timeout: int = 10,
        max_retries: int = 3,
        rate_limit: float = 0.05,  # ~20 req/sec
    ):
        self.default_country = default_country
        self.default_media = default_media
        self.timeout = timeout
        self.max_retries = max_retries
        self.rate_limit = rate_limit

        self.session = requests.Session()
        self.session.headers.update(
            {
                "User-Agent": "MusicDownloader/1.0 (iTunes Search API Client)",
                "Accept": "application/json",
            }
        )

        self._last_request_time = 0

    def _rate_limit_wait(self):
        """Enforce rate limiting."""
        elapsed = time.time() - self._last_request_time
        if elapsed < self.rate_limit:
            time.sleep(self.rate_limit - elapsed)

    def _request(
        self, endpoint: str, params: Optional[Dict] = None
    ) -> requests.Response:
        """Make HTTP request with retry logic and rate limiting."""
        self._rate_limit_wait()

        url = f"{self.BASE_URL}{endpoint}"

        last_error = Exception("Request failed")
        for attempt in range(3):
            try:
                self._last_request_time = time.time()
                response = self.session.get(url, params=params, timeout=self.timeout)

                if response.status_code == 429:
                    wait_time = 2**attempt
                    time.sleep(wait_time)
                    continue

                response.raise_for_status()
                return response

            except requests.RequestException as e:
                if attempt < 2:
                    time.sleep(2**attempt)
                else:
                    raise e

        raise last_error

    def _search(self, params: Dict) -> Dict[str, Any]:
        """Execute search request."""
        response = self._request("/search", params=params)
        return response.json()

    def _lookup(self, params: Dict) -> Dict[str, Any]:
        """Execute lookup request."""
        response = self._request("/lookup", params=params)
        return response.json()

    # ==================== SEARCH METHODS ====================

    def search_tracks(
        self,
        query: str,
        limit: int = 20,
        country: Optional[str] = None,
        attribute: Optional[str] = None,
        explicit: Literal["Yes", "No"] = "Yes",
    ) -> List:
        """
        Search for tracks.

        Args:
            query: Search query
            limit: Max results (1-200)
            country: Two-letter country code (default: US)
            attribute: Search attribute (trackTerm, artistTerm, etc.)
            explicit: "Yes" or "No" for explicit content

        Returns:
            List of iTunesTrack objects
        """
        params = {
            "term": query,
            "media": self.MEDIA_MUSIC,
            "entity": self.ENTITY_TRACK,
            "limit": min(limit, 200),
            "explicit": explicit,
        }

        if country:
            params["country"] = country
        else:
            params["country"] = self.default_country

        if attribute:
            params["attribute"] = attribute

        data = self._search(params)
        tracks = []

        for item in data.get("results", []):
            # iTunes returns kind="song" for tracks with wrapperType="track"
            if item.get("kind") != "song" or item.get("wrapperType") != "track":
                continue

            track = self._parse_track(item)
            if track:
                tracks.append(track)

        return tracks

    def search_artists(
        self,
        query: str,
        limit: int = 20,
        country: Optional[str] = None,
    ) -> List:
        """Search for artists."""
        params = {
            "term": query,
            "media": self.MEDIA_MUSIC,
            "entity": self.ENTITY_ARTIST,
            "limit": min(limit, 200),
            "country": country or self.default_country,
        }

        data = self._search(params)
        return [self._parse_artist(item) for item in data.get("results", [])]

    def search_albums(
        self,
        query: str,
        limit: int = 20,
        country: Optional[str] = None,
    ) -> List:
        """Search for albums."""
        params = {
            "term": query,
            "media": self.MEDIA_MUSIC,
            "entity": self.ENTITY_ALBUM,
            "limit": min(limit, 200),
            "country": country or self.default_country,
        }

        data = self._search(params)
        return [self._parse_album(item) for item in data.get("results", [])]

    def search_all(
        self,
        query: str,
        limit: int = 20,
        country: Optional[str] = None,
    ):
        """Search tracks, artists, and albums in parallel."""
        import concurrent.futures

        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
            future_tracks = executor.submit(self.search_tracks, query, limit, country)
            future_artists = executor.submit(self.search_artists, query, limit, country)
            future_albums = executor.submit(self.search_albums, query, limit, country)

            return {
                "tracks": future_tracks.result(),
                "artists": future_artists.result(),
                "albums": future_albums.result(),
            }

    # ==================== LOOKUP METHODS ====================

    def lookup_track(self, track_id: str, country: Optional[str] = None) -> Optional[Any]:
        """Get full track info by iTunes track ID."""
        params = {"id": track_id, "entity": "musicTrack"}
        if country:
            params["country"] = country

        data = self._lookup(params)
        results = data.get("results", [])
        if results:
            return self._parse_track(results[0])
        return None

    def lookup_artist(self, artist_id: str, country: Optional[str] = None) -> Optional[Any]:
        """Get artist details by ID."""
        params = {"id": artist_id, "entity": "musicArtist"}
        if country:
            params["country"] = country

        data = self._lookup(params)
        results = data.get("results", [])
        if results:
            return self._parse_artist(results[0])
        return None

    def lookup_album(
        self, album_id: str, country: Optional[str] = None, entity: str = "album"
    ) -> Optional[Any]:
        """Get album details by ID, optionally with tracks."""
        params = {"id": album_id, "entity": entity}
        if country:
            params["country"] = country

        data = self._lookup(params)
        results = data.get("results", [])
        if results:
            # First result is the album
            album = self._parse_album(results[0])
            if entity == "albumTrack":
                # Remaining results are tracks
                album.tracks = [
                    self._parse_track(t)
                    for t in results[1:]
                    if t.get("kind") == "track"
                ]
            return album
        return None

    def lookup_by_ids(
        self, ids: List[str], entity: str = "musicTrack", country: Optional[str] = None
    ) -> List:
        """Batch lookup multiple IDs (up to 50 at a time)."""
        if len(ids) > 50:
            raise ValueError("Maximum 50 IDs per request")

        params = {"id": ",".join(ids), "entity": entity}
        if country:
            params["country"] = country

        data = self._lookup(params)
        return data.get("results", [])

    # ==================== ENRICHMENT HELPERS ====================

    def enrich_track(
        self, title: str, artist: str, country: Optional[str] = None
    ) -> Optional[Any]:
        """
        Best-effort track enrichment from title + artist.
        """
        # Try exact match first
        query = f'"{title}" "{artist}"'
        tracks = self.search_tracks(query, limit=5, country=country)

        if tracks:
            # Return best match (first result for exact query)
            return tracks[0]

        # Fallback to loose search
        tracks = self.search_tracks(f"{title} {artist}", limit=10, country=country)
        if tracks:
            return tracks[0]

        return None

    def get_preview_url(
        self, track_id: str, country: Optional[str] = None
    ) -> Optional[str]:
        """Get 30-second preview URL for a track."""
        track = self.lookup_track(track_id, country)
        return track.preview_url if track else None

    def get_high_res_artwork(
        self, track_id: str, size: int = 600, country: Optional[str] = None
    ) -> Optional[str]:
        """Get high-resolution artwork URL (up to 1200x1200)."""
        track = self.lookup_track(track_id, country)
        if track:
            # iTunes artwork URLs follow pattern: .../WIDTHxHEIGHT/...
            # Replace 100x100 with desired size
            return track.artwork_url_100.replace("100x100", f"{size}x{size}")
        return None

    # ==================== PARSERS ====================

    def _parse_track(self, item: Dict) -> Optional[Any]:
        """Parse track from iTunes search result."""
        try:
            # Check if this is a track (kind=song, wrapperType=track)
            if item.get("kind") != "song" or item.get("wrapperType") != "track":
                return None

            # Get artwork URLs at different sizes
            artwork_100 = item.get("artworkUrl100", "")
            artwork_300 = artwork_100.replace("100x100", "300x300")
            artwork_600 = artwork_100.replace("100x100", "600x600")

            return iTunesTrack(
                track_id=str(item.get("trackId", "")),
                name=item.get("trackName", ""),
                artist_name=item.get("artistName", ""),
                artist_id=str(item.get("artistId", "")),
                collection_name=item.get("collectionName", ""),
                collection_id=str(item.get("collectionId", "")),
                collection_type=item.get("collectionType", ""),
                artwork_url_100=artwork_100,
                artwork_url_300=artwork_300,
                artwork_url_600=artwork_600,
                preview_url=item.get("previewUrl"),
                track_time_ms=item.get("trackTimeMillis"),
                track_price=item.get("trackPrice"),
                collection_price=item.get("collectionPrice"),
                currency=item.get("currency", "USD"),
                primary_genre_name=item.get("primaryGenreName"),
                release_date=item.get("releaseDate"),
                track_number=item.get("trackNumber"),
                track_count=item.get("trackCount"),
                disc_number=item.get("discNumber"),
                disc_count=item.get("discCount"),
                is_streamable=item.get("isStreamable", True),
                content_advisory_rating=item.get("contentAdvisoryRating"),
                country=item.get("country", "US"),
            )
        except Exception:
            return None

    def _parse_artist(self, item: Dict) -> Optional[Any]:
        """Parse artist from iTunes search result."""
        try:
            return iTunesArtist(
                artist_id=str(item.get("artistId", "")),
                name=item.get("artistName", ""),
                artist_link_url=item.get("artistLinkUrl", ""),
                primary_genre_name=item.get("primaryGenreName"),
            )
        except Exception:
            return None

    def _parse_album(self, item: Dict) -> Optional[Any]:
        """Parse album from iTunes search result."""
        try:
            artwork_100 = item.get("artworkUrl100", "")
            artwork_600 = artwork_100.replace("100x100", "600x600")

            release_year = None
            if item.get("releaseDate"):
                try:
                    release_year = int(item.get("releaseDate", "")[:4])
                except ValueError:
                    pass

            return iTunesAlbum(
                collection_id=str(item.get("collectionId", "")),
                name=item.get("collectionName", ""),
                artist_name=item.get("artistName", ""),
                artist_id=str(item.get("artistId", "")),
                artwork_url_100=artwork_100,
                artwork_url_600=artwork_600,
                release_date=item.get("releaseDate"),
                primary_genre_name=item.get("primaryGenreName"),
                track_count=item.get("trackCount"),
                price=item.get("collectionPrice"),
                currency=item.get("currency", "USD"),
                copyright=item.get("copyright"),
                release_year=release_year,
            )
        except Exception:
            return None


# ==================== CONVENIENCE FUNCTIONS ====================


def search_tracks(query: str, limit: int = 20, country: str = "US") -> List:
    """Quick track search."""
    client = iTunesClient(default_country=country)
    return client.search_tracks(query, limit, country)


def enrich_track(title: str, artist: str, country: str = "US") -> Optional[Any]:
    """Quick track enrichment."""
    client = iTunesClient(default_country=country)
    return client.enrich_track(title, artist, country)


def get_track_by_id(track_id: str, country: str = "US") -> Optional[Any]:
    """Quick track lookup by iTunes ID."""
    client = iTunesClient(default_country=country)
    return client.lookup_track(track_id, country)


# ==================== CLI ====================

if __name__ == "__main__":
    import sys
    import json

    if len(sys.argv) < 2:
        print("Usage:")
        print('  python itunes_client.py search "query" [limit] [country]')
        print('  python itunes_client.py enrich "title" "artist" [country]')
        print("  python itunes_client.py track <track_id> [country]")
        print("  python itunes_client.py album <album_id> [country]")
        print('  python itunes_client.py enrich-full "title" "artist" [country]')
        sys.exit(1)

    command = sys.argv[1]
    country = sys.argv[-1] if len(sys.argv) > 3 and len(sys.argv[-1]) == 2 else "US"
    client = iTunesClient(default_country=country)

    if command == "search":
        query = sys.argv[2]
        limit = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3].isdigit() else 10

        print(f"\nSearching iTunes ({country}) for: {query}")
        tracks = client.search_tracks(query, limit)

        if not tracks:
            print("No results found.")
        else:
            print(f"\nFound {len(tracks)} tracks:\n")
            for i, track in enumerate(tracks, 1):
                print(f"  {i}. {track.name} - {track.artist_name}")
                print(
                    f"     Album: {track.collection_name} ({track.release_date[:10] if track.release_date else '?'})"
                )
                print(f"     Duration: {track.duration_formatted}")
                print(f"     Genre: {track.primary_genre_name or 'N/A'}")
                print(f"     Explicit: {track.content_advisory_rating or 'Clean'}")
                print(f"     Artwork (600x600): {track.artwork_url_600}")
                print(f"     Preview: {track.preview_url or 'N/A'}")
                print(f"     Track ID: {track.track_id}")
                print()

    elif command == "enrich":
        if len(sys.argv) < 4:
            print('Usage: python itunes_client.py enrich "title" "artist" [country]')
            sys.exit(1)

        title = sys.argv[2]
        artist = sys.argv[3]

        print(f"\nEnriching: {title} - {artist}")
        track = client.enrich_track(title, artist)

        if track:
            print(json.dumps(track.to_dict(), indent=2))
        else:
            print("No match found.")

    elif command == "track":
        if len(sys.argv) < 3:
            print("Usage: python itunes_client.py track <track_id> [country]")
            sys.exit(1)

        track_id = sys.argv[2]
        print(f"\nFetching track: {track_id} ({country})")
        track = client.lookup_track(track_id, country)

        if track:
            print(json.dumps(track.to_dict(), indent=2))
        else:
            print("Track not found.")

    elif command == "album":
        if len(sys.argv) < 3:
            print("Usage: python itunes_client.py album <album_id> [country]")
            sys.exit(1)

        album_id = sys.argv[2]
        print(f"\nFetching album with tracks: {album_id} ({country})")
        album = client.lookup_album(album_id, country, entity="albumTrack")

        if album:
            result = album.to_dict()
            result["tracks_count"] = len(getattr(album, "tracks", []))
            print(json.dumps(result, indent=2))

            if hasattr(album, "tracks") and album.tracks:
                print(f"\nTracks ({len(album.tracks)}):")
                for i, t in enumerate(album.tracks, 1):
                    print(f"  {i}. {t.name} ({t.duration_formatted})")
        else:
            print("Album not found.")

    else:
        print(f"Unknown command: {command}")
        sys.exit(1)
