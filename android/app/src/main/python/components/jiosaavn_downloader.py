"""
JioSaavn Downloader Module
==========================
A clean, modular implementation for searching JioSaavn and downloading songs at 320kbps.

Features:
- Search/autocomplete via official API
- Song metadata extraction
- 320kbps AAC streaming URL generation
- Download with proper headers (bypasses 403)
- Progress tracking
- Error handling with retries
"""

import re
import os
import time
import requests
import urllib.parse
from typing import Optional, Dict, List, Any
from dataclasses import dataclass
from pathlib import Path


@dataclass
class JioSaavnSong:
    """Represents a song from JioSaavn search results."""

    id: str
    title: str
    artist: str
    album: str
    image_url: str
    url: str  # JioSaavn song page URL
    duration: Optional[int] = None  # seconds
    year: Optional[int] = None
    language: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "id": self.id,
            "title": self.title,
            "artist": self.artist,
            "album": self.album,
            "image_url": self.image_url,
            "url": self.url,
            "duration": self.duration,
            "duration_sec": self.duration,
            "year": self.year,
            "language": self.language,
        }


@dataclass
class DownloadResult:
    """Result of a download operation."""

    success: bool
    file_path: Optional[str] = None
    file_size: Optional[int] = None
    error: Optional[str] = None
    bitrate: Optional[int] = None
    codec: Optional[str] = None


class JioSaavnClient:
    """
    Client for interacting with JioSaavn's unofficial APIs.

    API Endpoints used:
    - autocomplete.get: Search suggestions
    - webapi.get: Song metadata + encrypted media URL
    - song.generateAuthToken: Signed streaming URL (320kbps)
    """

    BASE_URL = "https://www.jiosaavn.com/api.php"

    # Default headers to mimic browser requests
    DEFAULT_HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.jiosaavn.com/",
        "Origin": "https://www.jiosaavn.com",
    }

    # Streaming download headers (critical for bypassing 403)
    STREAM_HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "audio/webm,audio/ogg,audio/wav,audio/*;q=0.9,application/ogg;q=0.7,video/*;q=0.6,*/*;q=0.5",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.jiosaavn.com/",
        "Origin": "https://www.jiosaavn.com",
        "Range": "bytes=0-",  # Enable partial content
    }

    def __init__(self, timeout: int = 15, max_retries: int = 3):
        self.timeout = timeout
        self.max_retries = max_retries
        self.session = requests.Session()
        self.session.headers.update(self.DEFAULT_HEADERS)

    def _request(self, method: str, url: str, **kwargs) -> requests.Response:
        """Make HTTP request with retry logic."""
        last_error = Exception("Request failed")
        for attempt in range(self.max_retries):
            try:
                response = self.session.request(
                    method, url, timeout=self.timeout, **kwargs
                )
                response.raise_for_status()
                return response
            except requests.RequestException as e:
                last_error = e
                if attempt < self.max_retries - 1:
                    time.sleep(2**attempt)  # Exponential backoff
        raise last_error

    # ==================== SEARCH ====================

    def search(self, query: str, limit: int = 10) -> List[JioSaavnSong]:
        """
        Search for songs using JioSaavn's full search (`search.getResults`).

        NOTE: this used to use `autocomplete.get` — a lightweight *suggestions*
        endpoint that returned NO duration and a worse top hit (e.g. a
        compilation/"Melodious …" pressing instead of the canonical album track).
        That caused the displayed duration (then filled from iTunes enrichment of
        a DIFFERENT pressing) to mismatch what actually streamed. `search.
        getResults` returns the canonical result WITH real duration + artistMap.

        Args:
            query: Search query (song name, artist, etc.)
            limit: Maximum number of results

        Returns:
            List of JioSaavnSong objects
        """
        params = {
            "__call": "search.getResults",
            "q": query,
            "p": "1",
            "n": str(limit),
            "api_version": "4",
            "_format": "json",
            "_marker": "0",
            "ctx": "wap6dot0",
        }

        url = f"{self.BASE_URL}?{urllib.parse.urlencode(params)}"
        response = self._request("GET", url)
        data = response.json()

        songs_data = data.get("results", []) if isinstance(data, dict) else []
        results = []

        for song in songs_data[:limit]:
            try:
                more_info = song.get("more_info", {}) or {}
                # Artist: prefer artistMap primary names (clean), then the
                # music-director string, then the subtitle.
                artist_map = more_info.get("artistMap", {}) or {}
                primary = ", ".join(
                    a.get("name", "")
                    for a in (artist_map.get("primary_artists") or [])
                    if isinstance(a, dict) and a.get("name")
                )
                artist = (
                    primary
                    or more_info.get("music")
                    or more_info.get("primary_artists")
                    or song.get("subtitle", "")
                    or ""
                )
                duration = more_info.get("duration")
                try:
                    duration = int(duration) if duration is not None else None
                except (TypeError, ValueError):
                    duration = None
                results.append(
                    JioSaavnSong(
                        id=song.get("id", ""),
                        title=song.get("title", ""),
                        artist=artist,
                        album=more_info.get("album", "") or song.get("album", ""),
                        image_url=song.get("image", ""),
                        # search.getResults uses `perma_url` (the streamable song
                        # page); autocomplete used `url`.
                        url=song.get("perma_url", "") or song.get("url", ""),
                        duration=duration,
                        year=song.get("year") or more_info.get("year"),
                        language=more_info.get("language"),
                    )
                )
            except (KeyError, IndexError):
                continue  # Skip malformed entries

        return results

    # ==================== STREAMING URL GENERATION ====================

    def _get_encrypted_media_url(self, song_token: str) -> Optional[str]:
        """
        Get encrypted media URL from webapi.get endpoint.

        Args:
            song_token: The token part from song URL (e.g., 'Mg0zcxdSYXg' from /song/title/Mg0zcxdSYXg)

        Returns:
            Encrypted media URL or None
        """
        params = {
            "__call": "webapi.get",
            "api_version": "4",
            "_format": "json",
            "_marker": "0",
            "ctx": "wap6dot0",
            "token": song_token,
            "type": "song",
        }

        url = f"{self.BASE_URL}?{urllib.parse.urlencode(params)}"
        response = self._request("GET", url)
        data = response.json()

        songs = data.get("songs", [])
        if songs and "more_info" in songs[0]:
            return songs[0]["more_info"].get("encrypted_media_url")
        return None

    def _generate_auth_token(
        self, encrypted_url: str, bitrate: int = 320
    ) -> Optional[str]:
        """
        Generate signed streaming URL using song.generateAuthToken.

        Args:
            encrypted_url: Encrypted media URL from webapi.get
            bitrate: Desired bitrate (320, 160, 96)

        Returns:
            Signed streaming URL or None
        """
        # URL encode the encrypted URL
        encoded_url = urllib.parse.quote(encrypted_url)

        params = {
            "__call": "song.generateAuthToken",
            "url": encoded_url,
            "bitrate": str(bitrate),
            "api_version": "4",
            "_format": "json",
            "ctx": "wap6dot0",
        }

        url = f"{self.BASE_URL}?{urllib.parse.urlencode(params)}"
        response = self._request("GET", url)
        data = response.json()

        if data.get("status") == "success" and "auth_url" in data:
            auth_url = data["auth_url"]
            # IMPORTANT: return the signed auth_url as-is.
            #
            # The previous implementation stripped the signature and ran a blind
            # `.replace("ac", "aac")` over the WHOLE url to "fix" the CDN host —
            # but that also corrupted any track whose URL hash contained "ac"
            # (e.g. 94e53ac57c... -> 94e53aac57c...), producing 404s for a large
            # fraction of tracks. The signed URL works directly on every track
            # and we proxy it immediately server-side, so expiry is a non-issue.
            if auth_url:
                return auth_url
        return None

    def get_streaming_url(self, song_url: str, bitrate: int = 320) -> Optional[str]:
        """
        Get direct streaming URL for a JioSaavn song.

        Args:
            song_url: Full JioSaavn song URL (e.g., 'https://www.jiosaavn.com/song/believer/Mg0zcxdSYXg')
            bitrate: Desired bitrate (320, 160, 96)

        Returns:
            Direct streaming URL or None
        """
        # Extract token from song URL
        match = re.search(r"song/(.*?)/(.*)", song_url)
        if not match:
            return None

        song_token = match.group(2)

        # Step 1: Get encrypted media URL
        encrypted_url = self._get_encrypted_media_url(song_token)
        if not encrypted_url:
            return None

        # Step 2: Generate auth token (signed URL)
        streaming_url = self._generate_auth_token(encrypted_url, bitrate)
        return streaming_url

    # ==================== DOWNLOAD ====================

    def download_song(
        self,
        song_url: str,
        output_path: str,
        bitrate: int = 320,
        progress_callback: Optional[callable] = None,
    ) -> DownloadResult:
        """
        Download a song from JioSaavn at specified bitrate.

        Args:
            song_url: JioSaavn song URL
            output_path: Local file path to save
            bitrate: Audio bitrate (320, 160, 96)
            progress_callback: Optional callback(bytes_downloaded, total_bytes)

        Returns:
            DownloadResult with success status and metadata
        """
        # Try up to 2 times with fresh streaming URLs
        for attempt in range(2):
            streaming_url = self.get_streaming_url(song_url, bitrate)
            if not streaming_url:
                if attempt == 0:
                    continue  # Try once more with fresh URL
                return DownloadResult(
                    success=False, error="Failed to generate streaming URL"
                )

            try:
                # Use stream headers for download
                response = self.session.get(
                    streaming_url,
                    headers=self.STREAM_HEADERS,
                    timeout=self.timeout,
                    stream=True,
                )

                if response.status_code == 404 and attempt == 0:
                    # URL expired, try once more with fresh token
                    continue

                response.raise_for_status()

                total_size = int(response.headers.get("Content-Length", 0))
                downloaded = 0

                # Ensure output directory exists
                Path(output_path).parent.mkdir(parents=True, exist_ok=True)

                with open(output_path, "wb") as f:
                    for chunk in response.iter_content(chunk_size=8192):
                        if chunk:
                            f.write(chunk)
                            downloaded += len(chunk)
                            if progress_callback and total_size > 0:
                                progress_callback(downloaded, total_size)

                # Verify file
                file_size = os.path.getsize(output_path)
                if file_size == 0:
                    os.remove(output_path)
                    if attempt == 0:
                        continue  # Try again
                    return DownloadResult(
                        success=False, error="Downloaded file is empty"
                    )

                # Probe audio properties with ffprobe if available
                probe_info = self._probe_audio(output_path)

                return DownloadResult(
                    success=True,
                    file_path=output_path,
                    file_size=file_size,
                    bitrate=probe_info.get("bitrate"),
                    codec=probe_info.get("codec"),
                )

            except requests.RequestException as e:
                if os.path.exists(output_path):
                    os.remove(output_path)
                if attempt == 0 and "404" in str(e):
                    continue  # Try once more with fresh URL
                return DownloadResult(success=False, error=f"Download failed: {str(e)}")
            except Exception:
                if os.path.exists(output_path):
                    os.remove(output_path)
                if attempt == 0:
                    continue
                return DownloadResult(
                    success=False, error="Unexpected error during download"
                )

        return DownloadResult(success=False, error="Download failed after retries")

    # Alias for compatibility with DownloadManager
    def download_track(
        self,
        url: str,
        output_path: str,
        max_bitrate: int = 320,
        progress_callback: Optional[callable] = None,
    ) -> DownloadResult:
        """Download a track using the JioSaavn client (alias for download_song)."""
        return self.download_song(url, output_path, max_bitrate, progress_callback)

    def _probe_audio(self, file_path: str) -> Dict[str, Any]:
        """Extract audio metadata using ffprobe."""
        try:
            import subprocess

            result = subprocess.run(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-select_streams",
                    "a:0",
                    "-show_entries",
                    "stream=bit_rate,codec_name,sample_rate,channels",
                    "-of",
                    "csv=p=0",
                    file_path,
                ],
                capture_output=True,
                text=True,
                timeout=10,
                # No console window flash on Windows
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )

            if result.returncode == 0 and result.stdout.strip():
                parts = result.stdout.strip().split(",")
                return {
                    "codec": parts[0] if len(parts) > 0 else None,
                    "sample_rate": int(parts[1])
                    if len(parts) > 1 and parts[1].isdigit()
                    else None,
                    "channels": int(parts[2])
                    if len(parts) > 2 and parts[2].isdigit()
                    else None,
                    "bitrate": int(parts[3])
                    if len(parts) > 3 and parts[3].isdigit()
                    else None,
                }
        except Exception:
            pass
        return {}


# ==================== CONVENIENCE FUNCTIONS ====================


def search_songs(query: str, limit: int = 10) -> List[JioSaavnSong]:
    """Quick search function using default client."""
    client = JioSaavnClient()
    return client.search(query, limit)


def download_song(
    song_url: str,
    output_dir: str = ".",
    bitrate: int = 320,
    progress_callback: Optional[callable] = None,
) -> DownloadResult:
    """Quick download function using default client."""
    client = JioSaavnClient()

    # Generate filename from song URL
    match = re.search(r"song/([^/]+)/", song_url)
    title = match.group(1) if match else "song"
    # Sanitize filename
    safe_title = re.sub(r'[<>:"/\\|?*]', "_", title)
    output_path = os.path.join(output_dir, f"{safe_title}_{bitrate}kbps.m4a")

    return client.download_song(song_url, output_path, bitrate, progress_callback)


# ==================== CLI ENTRY POINT ====================

if __name__ == "__main__":
    import sys

    def print_progress(downloaded: int, total: int):
        pct = (downloaded / total) * 100
        bar_len = 40
        filled = int(bar_len * downloaded / total)
        bar = "█" * filled + "░" * (bar_len - filled)
        sys.stdout.write(f"\r  [{bar}] {pct:.1f}% ({downloaded:,}/{total:,} bytes)")
        sys.stdout.flush()

    if len(sys.argv) < 2:
        print("Usage:")
        print('  python jiosaavn_downloader.py search "query"')
        print(
            '  python jiosaavn_downloader.py download "https://www.jiosaavn.com/song/..." [output_dir]'
        )
        sys.exit(1)

    command = sys.argv[1]

    if command == "search":
        query = sys.argv[2] if len(sys.argv) > 2 else "believer imagine dragons"
        print(f"\nSearching for: {query}")
        songs = search_songs(query)

        if not songs:
            print("No results found.")
        else:
            print(f"\nFound {len(songs)} results:\n")
            for i, song in enumerate(songs, 1):
                print(f"  {i}. {song.title} - {song.artist}")
                print(f"     Album: {song.album} | ID: {song.id}")
                print(f"     URL: {song.url}")
                print()

    elif command == "download":
        if len(sys.argv) < 3:
            print("Error: Song URL required")
            sys.exit(1)

        song_url = sys.argv[2]
        output_dir = sys.argv[3] if len(sys.argv) > 3 else "."

        print(f"\nDownloading: {song_url}")
        print(f"Output directory: {output_dir}")

        result = download_song(song_url, output_dir, progress_callback=print_progress)

        print()  # Newline after progress bar

        if result.success:
            print("✓ Success!")
            print(f"  File: {result.file_path}")
            print(
                f"  Size: {result.file_size:,} bytes ({result.file_size / 1024 / 1024:.2f} MB)"
            )
            if result.bitrate:
                print(f"  Bitrate: {result.bitrate // 1000} kbps")
            if result.codec:
                print(f"  Codec: {result.codec}")
        else:
            print(f"✗ Failed: {result.error}")

    else:
        print(f"Unknown command: {command}")
        sys.exit(1)
