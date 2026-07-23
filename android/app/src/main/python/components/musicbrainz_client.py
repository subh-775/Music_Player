"""
MusicBrainz Client
===================
Metadata enrichment via MusicBrainz open database.

Features:
- ISRC → Recording/Release lookup
- Artist, Release, Recording search
- Release relationships (remix, cover, etc.)
- AcoustID integration ready
- No authentication required
- Rate limit: 1 request/second (respectful)

API Docs: https://musicbrainz.org/doc/Development/XML_Web_Service/Version_2
"""

import os
import time
import requests
from typing import Optional, Dict, List, Any
from dataclasses import dataclass, field
from xml.etree import ElementTree as ET


@dataclass
class MBRecording:
    """Recording (track) from MusicBrainz."""

    mbid: str
    title: str
    artist_name: str
    artist_mbids: List[str] = field(default_factory=list)
    releases: List[str] = field(default_factory=list)  # Release MBIDs
    isrcs: List[str] = field(default_factory=list)
    length_ms: Optional[int] = None
    video: bool = False
    relationships: List[Dict] = field(default_factory=list)

    @property
    def search_query(self) -> str:
        return f"{self.title} {self.artist_name}"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "mbid": self.mbid,
            "title": self.title,
            "artist": self.artist_name,
            "artist_mbids": self.artist_mbids,
            "releases": self.releases,
            "isrcs": self.isrcs,
            "length_ms": self.length_ms,
            "duration_sec": round(self.length_ms / 1000) if self.length_ms else None,
            "video": self.video,
            "relationships": self.relationships,
            "search_query": self.search_query,
        }


@dataclass
class MBRelease:
    """Release (album/single) from MusicBrainz."""

    mbid: str
    title: str
    artist_name: str
    artist_mbids: List[str] = field(default_factory=list)
    release_group_mbid: Optional[str] = None
    release_date: Optional[str] = None
    country: Optional[str] = None
    status: Optional[str] = None  # Official, Promotional, etc.
    barcode: Optional[str] = None
    packaging: Optional[str] = None
    media_count: int = 0
    track_count: int = 0
    cover_art_url: Optional[str] = None  # From Cover Art Archive
    tracks: List[MBRecording] = field(default_factory=list)

    @property
    def search_query(self) -> str:
        return f"{self.title} {self.artist_name}"

    @property
    def year(self) -> Optional[int]:
        if self.release_date:
            try:
                return int(self.release_date[:4])
            except ValueError:
                pass
        return None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "mbid": self.mbid,
            "title": self.title,
            "artist": self.artist_name,
            "artist_mbids": self.artist_mbids,
            "release_group_mbid": self.release_group_mbid,
            "release_date": self.release_date,
            "year": self.year,
            "country": self.country,
            "status": self.status,
            "barcode": self.barcode,
            "packaging": self.packaging,
            "cover_art": self.cover_art_url,
            "track_count": self.track_count,
            "tracks": [t.to_dict() for t in self.tracks],
            "search_query": self.search_query,
        }


@dataclass
class MBArtist:
    """Artist from MusicBrainz."""

    mbid: str
    name: str
    sort_name: str
    country: Optional[str] = None
    type: Optional[str] = None  # Person, Group, etc.
    gender: Optional[str] = None
    area: Optional[str] = None
    begin_area: Optional[str] = None
    end_area: Optional[str] = None
    life_span: Dict = field(default_factory=dict)
    aliases: List[str] = field(default_factory=list)
    tags: List[str] = field(default_factory=list)
    rating: Optional[int] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "mbid": self.mbid,
            "name": self.name,
            "sort_name": self.sort_name,
            "country": self.country,
            "type": self.type,
            "gender": self.gender,
            "area": self.area,
            "life_span": self.life_span,
            "aliases": self.aliases,
            "tags": self.tags,
            "rating": self.rating,
        }


@dataclass
class SearchResult:
    """Search results container."""

    recordings: List = field(default_factory=list)  # MBRecording
    releases: List = field(default_factory=list)  # MBRelease
    artists: List = field(default_factory=list)  # MBArtist


class MusicBrainzClient:
    """
    MusicBrainz XML Web Service client.

    No authentication required. Rate limit: 1 req/sec (be respectful).
    Includes Cover Art Archive integration for cover art.
    """

    BASE_URL = "https://musicbrainz.org/ws/2"
    COVER_ART_URL = "https://coverartarchive.org"

    # User-Agent is REQUIRED by MusicBrainz
    DEFAULT_USER_AGENT = "MusicDownloader/1.0 (https://github.com/yourusername/music-downloader; contact@email.com)"

    def __init__(
        self,
        user_agent: Optional[str] = None,
        timeout: int = 15,
        max_retries: int = 3,
        rate_limit: float = 1.1,  # 1 req/sec + buffer
    ):
        self.timeout = timeout
        self.max_retries = max_retries
        self.rate_limit = rate_limit

        self.session = requests.Session()
        self.session.headers.update(
            {
                "User-Agent": user_agent
                or os.getenv("MB_USER_AGENT", self.DEFAULT_USER_AGENT),
                "Accept": "application/xml",
            }
        )

        self._last_request_time = 0

    def _rate_limit_wait(self):
        """Enforce 1 request/second rate limit."""
        elapsed = time.time() - self._last_request_time
        if elapsed < self.rate_limit:
            time.sleep(self.rate_limit - elapsed)

    def _request(self, endpoint: str, params: Optional[Dict] = None) -> ET.Element:
        """Make HTTP request and parse XML response."""
        self._rate_limit_wait()

        url = f"{self.BASE_URL}{endpoint}"
        params = params or {}
        params.setdefault("fmt", "xml")

        last_error = Exception("Request failed")
        for attempt in range(self.max_retries):
            try:
                self._last_request_time = time.time()
                response = self.session.get(url, params=params, timeout=self.timeout)

                if response.status_code == 503:  # Rate limited
                    wait_time = 2**attempt
                    time.sleep(wait_time)
                    continue
                if response.status_code == 429:
                    wait_time = 5 * (attempt + 1)
                    time.sleep(wait_time)
                    continue

                response.raise_for_status()
                return ET.fromstring(response.content)

            except (requests.RequestException, ET.ParseError) as e:
                if attempt < self.max_retries - 1:
                    time.sleep(2**attempt)
                else:
                    raise e

        raise last_error

    # ==================== SEARCH METHODS ====================

    def search_recordings(
        self,
        query: str,
        limit: int = 25,
        offset: int = 0,
        includes: Optional[List[str]] = None,
    ) -> List:
        """
        Search for recordings (tracks).

        Note: Search endpoint does NOT include ISRCs even with inc=isrcs.
        Use enrich_recordings_with_isrcs() after search to fetch ISRCs.

        Query syntax: https://musicbrainz.org/doc/Development/XML_Web_Service/Version_2/Search
        Examples:
          - "recording:believer AND artist:imagine dragons"
          - 'isrc:"USUG11700235"'
          - 'recording:believer artist:"imagine dragons"'
        """
        root = self._request(
            "/recording/", {"query": query, "limit": min(limit, 100), "offset": offset}
        )
        recordings = []

        for rec in self._findall_with_ns(root, ".//recording"):
            recordings.append(self._parse_recording(rec))

        return recordings

    def enrich_recordings_with_isrcs(
        self, recordings: List, batch_size: int = 25
    ) -> List:
        """
        Enrich a list of recordings with ISRCs using individual lookups.
        (Batch lookup endpoint not reliably available; falls back to individual lookups.)

        Args:
            recordings: List of MBRecording objects (must have mbid)
            batch_size: Max concurrent lookups (rate limited)

        Returns:
            Updated recordings list with ISRCs populated where available
        """
        mbids = [r.mbid for r in recordings if r.mbid]
        if not mbids:
            return recordings

        # Process sequentially with rate limiting
        for i, mbid in enumerate(mbids):
            try:
                rec = self.get_recording(mbid, includes=["isrcs"])
                if rec:
                    # Find and update matching recording
                    for recording in recordings:
                        if recording.mbid == mbid:
                            recording.isrcs = rec.isrcs
                            break
            except Exception:
                continue  # Skip failed lookups

        return recordings

    def search_releases(
        self,
        query: str,
        limit: int = 25,
        offset: int = 0,
    ):
        """Search for releases (albums/singles)."""
        root = self._request(
            "/release/", {"query": query, "limit": min(limit, 100), "offset": offset}
        )
        releases = []

        for rel in self._findall_with_ns(root, ".//release"):
            releases.append(self._parse_release(rel))

        return releases

    def search_artists(
        self,
        query: str,
        limit: int = 25,
        offset: int = 0,
    ):
        """Search for artists."""
        root = self._request(
            "/artist/", {"query": query, "limit": min(limit, 100), "offset": offset}
        )
        artists = []

        for art in self._findall_with_ns(root, ".//artist"):
            artists.append(self._parse_artist(art))

        return artists

    # ==================== LOOKUP BY ID/MBID ====================

    def get_recording(self, mbid: str, includes: Optional[List[str]] = None):
        """Get full recording details by MBID."""
        params = {"fmt": "xml"}
        if includes:
            params["inc"] = "+".join(includes)

        root = self._request(f"/recording/{mbid}", params)
        rec = root.find("./recording")
        if rec is not None:
            return self._parse_recording(rec, detailed=True)
        return None

    def get_recording_by_isrc(self, isrc: str) -> Optional[Any]:
        """Find recording by ISRC."""
        # Search by ISRC
        query = f'isrc:"{isrc}"'
        results = self.search_recordings(query, limit=1)
        if results:
            return results[0]
        return None

    def get_release(self, mbid: str, includes: Optional[List[str]] = None):
        """Get full release details by MBID."""
        params = {"fmt": "xml"}
        if includes:
            params["inc"] = "+".join(includes)

        root = self._request(f"/release/{mbid}", params)
        rel = root.find("./release")
        if rel is not None:
            return self._parse_release(rel, detailed=True)
        return None

    def get_release_by_barcode(self, barcode: str):
        """Find release by barcode."""
        query = f"barcode:{barcode}"
        results = self.search_releases(query, limit=1)
        if results:
            return results[0]
        return None

    def get_artist(self, mbid: str, includes: Optional[List[str]] = None):
        """Get full artist details by MBID."""
        params = {"fmt": "xml"}
        if includes:
            params["inc"] = "+".join(includes)

        root = self._request(f"/artist/{mbid}", params)
        art = root.find("./artist")
        if art is not None:
            return self._parse_artist(art, detailed=True)
        return None

    def get_release_group(self, mbid: str):
        """Get release group (album concept) by MBID."""
        root = self._request(f"/release-group/{mbid}", {"fmt": "xml"})
        rg = root.find("./release-group")
        if rg is not None:
            return self._parse_release_group(rg)
        return None

    # ==================== COVER ART ARCHIVE ====================

    def get_cover_art(self, release_mbid: str) -> Optional[str]:
        """
        Get cover art URL from Cover Art Archive.
        Returns the front cover image URL (500px).
        """
        url = f"{self.COVER_ART_URL}/release/{release_mbid}/front-500"
        try:
            response = requests.head(url, timeout=10, allow_redirects=True)
            if response.status_code == 200:
                return url
        except Exception:
            pass
        return None

    def get_cover_art_info(self, release_mbid: str) -> List[Dict]:
        """Get all cover art info for a release."""
        url = f"{self.COVER_ART_URL}/release/{release_mbid}"
        try:
            response = requests.get(url, timeout=10)
            if response.status_code == 200:
                return response.json().get("images", [])
        except Exception:
            pass
        return []

    # ==================== ENRICHMENT HELPERS ====================

    def enrich_track(self, title: str, artist: str) -> Optional[Any]:
        """Best-effort track enrichment from title + artist."""
        query = f'recording:"{title}" AND artist:"{artist}"'
        results = self.search_recordings(query, limit=5)
        return results[0] if results else None

    def enrich_from_isrc(self, isrc: str) -> Optional[Any]:
        """Enrich track metadata from ISRC."""
        return self.get_recording_by_isrc(isrc)

    def get_release_full(self, release_mbid: str) -> Optional[Any]:
        """Get release with tracks and cover art."""
        release = self.get_release(
            release_mbid, includes=["recordings", "artists", "labels", "release-groups"]
        )
        if release:
            # Add cover art
            release.cover_art_url = self.get_cover_art(release_mbid)
        return release

    # ==================== PARSERS ====================

    def _get_text(self, elem: ET.Element, tag: str) -> Optional[str]:
        """Safe get text from child element, handling namespace."""
        # Try with namespace first
        ns = "{http://musicbrainz.org/ns/mmd-2.0#}"
        child = elem.find(ns + tag)
        if child is not None and child.text:
            return child.text
        # Fallback without namespace
        child = elem.find(tag)
        if child is not None and child.text:
            return child.text
        return None

    def _find_with_ns(self, elem: ET.Element, tag: str) -> Optional[ET.Element]:
        """Find element with namespace handling.

        Supports paths like 'artist/name' by adding namespace to each component.
        """
        ns = "http://musicbrainz.org/ns/mmd-2.0#"
        ns_tag = "{" + ns + "}"

        # Add namespace to each path component
        parts = tag.split("/")
        ns_parts = [ns_tag + p for p in parts]
        ns_search = "/".join(ns_parts)

        # Try with namespace
        child = elem.find(ns_search)
        if child is not None:
            return child

        # Fallback without namespace
        child = elem.find(tag)
        return child

    def _findall_with_ns(self, elem: ET.Element, tag: str) -> List[ET.Element]:
        """Find all elements with namespace handling.

        ElementTree requires {namespace}tag format for namespaced elements.
        For paths like "a/b/c", we need to add namespace to each component.
        """
        ns = "http://musicbrainz.org/ns/mmd-2.0#"
        ns_tag = "{" + ns + "}"

        # Normalize tag - handle .// prefix
        if tag.startswith(".//"):
            search_tag = tag[3:]  # Remove .//
        else:
            search_tag = tag

        # Add namespace to each path component
        parts = search_tag.split("/")
        ns_parts = [ns_tag + p for p in parts]
        ns_search = ".//" + "/".join(ns_parts)

        # Try with namespace
        results = elem.findall(ns_search)
        if results:
            return results

        # Fallback: try without namespace
        results = elem.findall(".//" + search_tag)
        if results:
            return results

        return []

    def _parse_recording(self, elem: ET.Element, detailed: bool = False):
        """Parse recording from XML element."""
        mbid = elem.get("id", "")
        title = self._get_text(elem, "title")
        length = self._get_text(elem, "length")
        video = self._get_text(elem, "video") == "true"

        # Artist credits - from artist-credit/name-credit/artist/name
        artist_name = ""
        artist_mbids = []
        for credit in self._findall_with_ns(elem, "artist-credit/name-credit"):
            # Get artist name from artist/name
            artist = self._find_with_ns(credit, "artist/name")
            if artist is not None and artist.text:
                artist_name = artist.text
            # Get artist MBID
            artist_elem = self._find_with_ns(credit, "artist")
            if artist_elem is not None:
                artist_mbid = artist_elem.get("id", "")
                if artist_mbid:
                    artist_mbids.append(artist_mbid)

        # ISRCs - from isrc-list/isrc[@id]
        isrcs = []
        for isrc in self._findall_with_ns(elem, "isrc-list/isrc"):
            isrc_id = isrc.get("id", "")
            if isrc_id:
                isrcs.append(isrc_id)
            elif isrc.text:
                isrcs.append(isrc.text)

        # Releases
        releases = [
            rel.get("id") for rel in self._findall_with_ns(elem, "release-list/release")
        ]

        rec = MBRecording(
            mbid=mbid,
            title=title or "",
            artist_name=artist_name,
            artist_mbids=artist_mbids,
            releases=releases,
            isrcs=isrcs,
            length_ms=int(length) if length and length.isdigit() else None,
            video=video,
        )

        if detailed:
            # Parse relationships
            relationships = []
            for rel in self._findall_with_ns(elem, ".//relation"):
                relationships.append(
                    {
                        "type": rel.get("type", ""),
                        "direction": rel.get("direction", ""),
                        "target_type": rel.get("target-type", ""),
                        "target_id": rel.get("target", ""),
                    }
                )
            rec.relationships = relationships

        return rec

    def _parse_release(self, elem: ET.Element, detailed: bool = False):
        """Parse release from XML element."""
        elem.get("id", "")
        title = self._get_text(elem, "title")
        date = self._get_text(elem, "date")
        country = self._get_text(elem, "country")
        status = self._get_text(elem, "status")
        barcode = self._get_text(elem, "barcode")
        packaging = self._get_text(elem, "packaging")

        # Artist credits
        artist_name = ""
        artist_mbids = []
        for credit in elem.findall("./artist-credit/name-credit"):
            artist_name = (
                credit.find("artist/name").text
                if credit.find("artist/name") is not None
                else ""
            )
            artist_mbid = (
                credit.find("artist").get("id", "")
                if credit.find("artist") is not None
                else ""
            )
            if artist_mbid:
                artist_mbids.append(artist_mbid)

        # Release group
        rg_elem = elem.find("release-group")
        rg_mbid = rg_elem.get("id") if rg_elem is not None else None

        # Media/track counts
        media_count = len(elem.findall(".//medium"))
        track_count = len(elem.findall(".//track"))

        rel = MBRelease(
            mbid=elem.get("id", ""),
            title=title or "",
            artist_name=artist_name,
            artist_mbids=artist_mbids,
            release_group_mbid=rg_mbid,
            release_date=date,
            country=country,
            status=status,
            barcode=barcode,
            packaging=packaging,
            media_count=media_count,
            track_count=track_count,
        )

        if detailed:
            # Parse tracks and attach to release
            tracks = []
            for track in elem.findall(".//track"):
                rec = track.find("recording")
                if rec is not None:
                    tracks.append(self._parse_recording(rec))
            rel.tracks = tracks

        return rel

    def _parse_artist(self, elem: ET.Element, detailed: bool = False):
        """Parse artist from XML element."""
        mbid = elem.get("id", "")
        name = self._get_text(elem, "name")
        sort_name = self._get_text(elem, "sort-name")
        country = self._get_text(elem, "country")
        type_ = self._get_text(elem, "type")
        gender = self._get_text(elem, "gender")
        area = self._get_text(elem, "area/name")

        # Life span
        life_span = {}
        for f in ["begin", "end", "ended"]:
            val = self._get_text(elem, f"life-span/{f}")
            if val:
                life_span[f] = val

        # Aliases
        aliases = [a.text for a in elem.findall(".//alias") if a.text]

        # Tags
        tags = [tag.text for tag in elem.findall(".//tag") if tag.text]

        # Rating
        rating = self._get_text(elem, "rating")
        rating = int(rating) if rating and rating.isdigit() else None

        return MBArtist(
            mbid=mbid,
            name=name or "",
            sort_name=sort_name or "",
            country=country,
            type=type_,
            gender=gender,
            area=area,
            life_span=life_span,
            aliases=aliases,
            tags=tags,
            rating=rating,
        )

    def _parse_release_group(self, elem: ET.Element):
        """Parse release-group element."""
        return {
            "mbid": elem.get("id", ""),
            "title": self._get_text(elem, "title"),
            "type": elem.get("type", ""),
            "primary_type": self._get_text(elem, "primary-type"),
        }


# ==================== CONVENIENCE FUNCTIONS ====================


def enrich_from_isrc(isrc: str) -> Optional[Any]:
    """Quick ISRC enrichment."""
    client = MusicBrainzClient()
    return client.enrich_from_isrc(isrc)


def enrich_track(title: str, artist: str) -> Optional[Any]:
    """Quick track enrichment."""
    client = MusicBrainzClient()
    return client.enrich_track(title, artist)


def search_by_isrc(isrc: str) -> Optional[Any]:
    """Quick ISRC search."""
    client = MusicBrainzClient()
    return client.get_recording_by_isrc(isrc)


# ==================== CLI ====================

if __name__ == "__main__":
    import sys
    import json

    if len(sys.argv) < 2:
        print("Usage:")
        print('  python musicbrainz_client.py isrc "ISRC_CODE"')
        print('  python musicbrainz_client.py enrich "title" "artist"')
        print(
            '  python musicbrainz_client.py search "query" [recordings|releases|artists]'
        )
        print("  python musicbrainz_client.py release <mbid>")
        print("  python musicbrainz_client.py cover <release_mbid>")
        sys.exit(1)

    command = sys.argv[1]
    client = MusicBrainzClient()

    if command == "isrc":
        if len(sys.argv) < 3:
            print('Usage: python musicbrainz_client.py isrc "ISRC_CODE"')
            sys.exit(1)

        isrc = sys.argv[2]
        print(f"\nLooking up ISRC: {isrc}")
        rec = client.get_recording_by_isrc(isrc)

        if rec:
            import json

            print(json.dumps(rec.to_dict(), indent=2))
        else:
            print("No recording found for this ISRC.")

    elif command == "enrich":
        if len(sys.argv) < 4:
            print('Usage: python musicbrainz_client.py enrich "title" "artist"')
            sys.exit(1)

        title = sys.argv[2]
        artist = sys.argv[3]

        print(f"\nEnriching: {title} - {artist}")
        rec = client.enrich_track(title, artist)

        if rec:
            import json

            print(json.dumps(rec.to_dict(), indent=2))
        else:
            print("No match found.")

    elif command == "search":
        if len(sys.argv) < 3:
            print(
                'Usage: python musicbrainz_client.py search "query" [recordings|releases|artists]'
            )
            sys.exit(1)

        query = sys.argv[2]
        search_type = sys.argv[3] if len(sys.argv) > 3 else "recordings"

        print(f"\nSearching {search_type}: {query}")

        if search_type == "recordings":
            results = client.search_recordings(query, 10)
            for i, r in enumerate(results, 1):
                print(
                    f"  {i}. {r.title} - {r.artist_name} (ISRCs: {', '.join(r.isrcs) or 'N/A'})"
                )
        elif search_type == "releases":
            results = client.search_releases(query, 10)
            for i, r in enumerate(results, 1):
                print(f"  {i}. {r.title} - {r.artist_name} ({r.release_date or '?'})")
        elif search_type == "artists":
            results = client.search_artists(query, 10)
            for i, r in enumerate(results, 1):
                print(f"  {i}. {r.name} ({r.country or '?'})")

    elif command == "release":
        if len(sys.argv) < 3:
            print("Usage: python musicbrainz_client.py release <mbid>")
            sys.exit(1)

        mbid = sys.argv[2]
        print(f"\nFetching release: {mbid}")
        release = client.get_release(mbid, includes=["recordings", "artists"])

        if release:
            import json

            print(json.dumps(release.to_dict(), indent=2))
        else:
            print("Release not found.")

    elif command == "cover":
        if len(sys.argv) < 3:
            print("Usage: python musicbrainz_client.py cover <release_mbid>")
            sys.exit(1)

        mbid = sys.argv[2]
        print(f"\nFetching cover art for release: {mbid}")
        url = client.get_cover_art(mbid)

        if url:
            print(f"Cover art URL: {url}")
            # Also show all cover art info
            images = client.get_cover_art_info(mbid)
            for img in images:
                print(f"  {img.get('types', [])} - {img.get('image')}")
        else:
            print("No cover art found.")

    else:
        print(f"Unknown command: {command}")
        sys.exit(1)
