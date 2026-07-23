"""
YouTube Downloader Module (yt-dlp based, production-ready)
===========================================================
Search YouTube/YouTube Music and download audio at best available native quality.

Features:
- Native bitrate selection (no unnecessary re-encoding)
- PO Token support for YouTube Music
- Cookie authentication
- SSAP (Server-Side Ads) workaround via multiple player clients
- Multiple extractor fallbacks (Invidious, Piped, YewTube)
- Format selection with quality preferences
"""

import os
import re
import time
import logging
import subprocess
from typing import Optional, Dict, List, Any, Callable, Literal
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass
class YouTubeTrack:
    """Represents a track from YouTube search results."""

    id: str
    title: str
    artist: str
    uploader: str
    url: str
    duration_ms: Optional[int] = None
    thumbnail: Optional[str] = None
    view_count: Optional[int] = None
    like_count: Optional[int] = None
    upload_date: Optional[str] = None
    is_music: bool = False
    album: Optional[str] = None

    @property
    def search_query(self) -> str:
        return f"{self.title} {self.artist}"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "artist": self.artist,
            "uploader": self.uploader,
            "url": self.url,
            "duration_ms": self.duration_ms,
            "duration_sec": round(self.duration_ms / 1000)
            if self.duration_ms
            else None,
            "thumbnail": self.thumbnail,
            "view_count": self.view_count,
            "is_music": self.is_music,
            "album": self.album,
            "search_query": self.search_query,
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
    source: str = "youtube"
    format_used: Optional[str] = None


class YouTubeClient:
    """
    YouTube/YouTube Music client using yt-dlp with production fixes.

    Features:
    - Native bitrate selection (no unnecessary re-encoding)
    - PO Token support (via cookies or extractor args)
    - Cookie jar authentication
    - SSAP workaround via player clients
    - Fallback extractors: Invidious, Piped, YewTube
    - Multiple format preferences
    - Automatic metadata extraction
    """

    # Known working Invidious instances (rotate if one fails)
    INVIDIOUS_INSTANCES = [
        "https://yewtu.be",
        "https://invidious.snopyta.org",
        "https://invidious.privacydev.net",
        "https://invidious.projectsegfau.lt",
        "https://inv.riverside.rocks",
    ]

    # Piped instances
    PIPED_INSTANCES = [
        "https://piped-api.kavin.rocks",
        "https://piped.kavin.rocks",
        "https://piped.projectsegfau.lt",
    ]

    def __init__(
        self,
        cookies_file: Optional[str] = None,
        cookies_from_browser: Optional[str] = None,
        po_token: Optional[str] = None,
        visitor_data: Optional[str] = None,
        timeout: int = 30,
        max_retries: int = 2,
        preferred_quality: int = 256,  # kbps (maximum bitrate)
    ):
        self.cookies_file = cookies_file
        # Name of the browser whose YouTube login cookies yt-dlp should read
        # (e.g. "chrome"/"edge"/"firefox"). Lets a signed-in user stream
        # bot-blocked YouTube videos. None = anonymous (default).
        self.cookies_from_browser = cookies_from_browser
        self.po_token = po_token
        self.visitor_data = visitor_data
        self.timeout = timeout
        self.max_retries = max_retries
        self.preferred_quality = preferred_quality
        self._invidious_idx = 0
        self._piped_idx = 0

    # ==================== YT-DLP OPTIONS ====================

    def _get_base_ydl_opts(
        self, quiet: bool = True, for_info: bool = False, **extra
    ) -> Dict[str, Any]:
        """Base yt-dlp options with anti-blocking measures.

        Args:
            quiet: Suppress output
            for_info: If True, skip player_client args (they break audio format extraction)
            **extra: Additional options to override
        """
        opts = {
            "quiet": quiet,
            "no_warnings": quiet,
            "socket_timeout": self.timeout,
            "retries": self.max_retries,
            "ignoreerrors": False,
            "extract_flat": False,
            # Format selection: prefer audio-only, high quality
            "format": f"bestaudio[abr<={self.preferred_quality}]/bestaudio/best",
            # YouTube now requires solving a JS "n-signature" challenge via an
            # external JS runtime (yt-dlp EJS); without it extraction returns
            # "No video formats found". Enable Deno (preferred, bundle in the
            # EXE) AND Node (present in dev) — yt-dlp uses the highest-priority
            # runtime that's actually available. Requires the `yt-dlp-ejs`
            # package (in requirements). This is the real fix for YouTube
            # playback; cookies only matter for bot-gated/age-restricted videos.
            "js_runtimes": {"deno": {}, "node": {}},
            **extra,
        }

        # Only add player_client args for actual downloads, not format extraction
        # player_client args break audio format extraction (filters out audio-only formats)
        if not for_info:
            opts["extractor_args"] = {
                "youtube": {
                    "player_client": ["android", "web", "tv_embedded", "mweb"],
                    "player_skip": ["configs", "webpage"],
                    "skip": [],  # keep dash + hls
                },
                "youtubemusic": {
                    "player_client": ["android_music", "web_music"],
                },
            }

        # Add cookies if provided
        if self.cookies_file and os.path.exists(self.cookies_file):
            opts["cookiefile"] = self.cookies_file
        # Or read cookies straight from the user's logged-in browser (yt-dlp
        # decrypts them itself). This is what unblocks "Sign in to confirm
        # you're not a bot" YouTube videos for signed-in users.
        elif self.cookies_from_browser:
            opts["cookiesfrombrowser"] = (self.cookies_from_browser,)

        # Add PO token if provided (for YouTube Music). setdefault BOTH levels —
        # on for_info paths there's no extractor_args["youtube"] yet (it's only
        # built when not for_info), so indexing it directly would KeyError.
        if self.po_token:
            opts.setdefault("extractor_args", {}).setdefault("youtube", {})["po_token"] = self.po_token
        if self.visitor_data:
            opts.setdefault("extractor_args", {}).setdefault("youtube", {})["visitor_data"] = (
                self.visitor_data
            )

        return opts

    def _get_ytdlp(self):
        """Import yt-dlp with version check."""
        import yt_dlp

        return yt_dlp

    # ==================== SEARCH ====================

    def search(
        self,
        query: str,
        limit: int = 20,
        search_type: Literal["youtube", "youtubemusic"] = "youtube",
    ) -> List[YouTubeTrack]:
        """
        Search YouTube or YouTube Music.

        Args:
            query: Search query
            limit: Maximum results
            search_type: 'youtube' or 'youtubemusic'

        Returns:
            List of YouTubeTrack objects
        """
        yt_dlp = self._get_ytdlp()

        # Use yt-dlp's native search prefixes
        if search_type == "youtubemusic":
            search_prefix = "yvsearch"
        else:
            search_prefix = "ytsearch"

        search_query = f"{search_prefix}{limit}:{query}"

        ydl_opts = self._get_base_ydl_opts(
            quiet=True,
            extract_flat="in_playlist",
            default_search=search_prefix,
        )

        tracks = []

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                result = ydl.extract_info(search_query, download=False)

                for entry in result.get("entries", []):
                    if not entry:
                        continue
                    try:
                        track_id = entry.get("id", "")
                        title = entry.get("title", "")
                        uploader = entry.get("uploader", "") or entry.get("channel", "")
                        url = entry.get("webpage_url") or entry.get("url", "")
                        duration = entry.get("duration")
                        thumbnail = entry.get("thumbnail")
                        # In extract_flat mode, yt-dlp puts thumbs in
                        # the `thumbnails` list, not the scalar field.
                        if not thumbnail:
                            thumbs = entry.get("thumbnails") or []
                            if thumbs:
                                thumbnail = max(
                                    thumbs,
                                    key=lambda t: (t.get("width", 0) or 0) * (t.get("height", 0) or 0),
                                ).get("url")
                        # Last-resort fallback: construct from video ID
                        if not thumbnail and entry.get("id"):
                            thumbnail = f"https://i.ytimg.com/vi/{entry['id']}/hqdefault.jpg"
                        view_count = entry.get("view_count")
                        like_count = entry.get("like_count")
                        upload_date = entry.get("upload_date")

                        # Try to extract artist from title/uploader
                        artist = self._extract_artist(title, uploader)

                        # Duration in ms
                        duration_ms = int(duration * 1000) if duration else None

                        track = YouTubeTrack(
                            id=track_id,
                            title=title,
                            artist=artist,
                            uploader=uploader,
                            url=url,
                            duration_ms=duration_ms,
                            thumbnail=thumbnail,
                            view_count=view_count,
                            like_count=like_count,
                            upload_date=upload_date,
                            is_music=(search_type == "youtubemusic"),
                        )
                        tracks.append(track)

                    except Exception:
                        continue

        except Exception:
            # Fallback to Invidious API
            tracks = self._search_invidious(query, limit)

        return tracks[:limit]

    def _extract_artist(self, title: str, uploader: str) -> str:
        """Extract artist from title and uploader."""
        # Common patterns: "Artist - Title", "Title - Artist", "Title (Artist)"
        patterns = [
            r"^(.+?)\s*[-–—]\s*.+$",  # Artist - Title
            r"^.+?\s*[-–—]\s*(.+?)(?:\s*[\(\[].*)?$",  # Title - Artist
            r"^(.+?)\s*[\(\[](.+?)[\)\]]",  # Title (Artist)
        ]

        for pattern in patterns:
            match = re.search(pattern, title)
            if match:
                return match.group(1).strip()

        # Fallback to uploader
        return uploader or "Unknown"

    def _search_invidious(self, query: str, limit: int) -> List[YouTubeTrack]:
        """Fallback search via Invidious API."""
        import requests

        for attempt in range(len(self.INVIDIOUS_INSTANCES)):
            instance = self.INVIDIOUS_INSTANCES[self._invidious_idx]
            self._invidious_idx = (self._invidious_idx + 1) % len(
                self.INVIDIOUS_INSTANCES
            )

            try:
                url = f"{instance}/api/v1/search"
                params = {"q": query, "type": "video", "page": 1}
                response = requests.get(url, params=params, timeout=10)
                response.raise_for_status()
                data = response.json()

                tracks = []
                for item in data[:limit]:
                    if item.get("type") != "video":
                        continue

                    video_id = item.get("videoId", "")
                    title = item.get("title", "")
                    author = item.get("author", "")
                    duration = item.get("lengthSeconds", 0)
                    thumbnails = item.get("videoThumbnails", [])
                    thumbnail = thumbnails[-1]["url"] if thumbnails else None
                    view_count = item.get("viewCount")

                    if not video_id:
                        continue

                    track = YouTubeTrack(
                        id=video_id,
                        title=title,
                        artist=self._extract_artist(title, author),
                        uploader=author,
                        url=f"https://youtube.com/watch?v={video_id}",
                        duration_ms=duration * 1000,
                        thumbnail=thumbnail,
                        view_count=view_count,
                        is_music=False,
                    )
                    tracks.append(track)

                if tracks:
                    return tracks

            except Exception:
                continue

        return []

    # ==================== GET TRACK INFO ====================

    def get_track_info(self, url: str) -> Optional[YouTubeTrack]:
        """Extract full track info from a YouTube URL."""
        yt_dlp = self._get_ytdlp()

        ydl_opts = self._get_base_ydl_opts(quiet=True)

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)

                return YouTubeTrack(
                    id=info.get("id", ""),
                    title=info.get("title", ""),
                    artist=self._extract_artist(
                        info.get("title", ""), info.get("uploader", "")
                    ),
                    uploader=info.get("uploader", ""),
                    url=info.get("webpage_url", url),
                    duration_ms=int(info.get("duration", 0) * 1000)
                    if info.get("duration")
                    else None,
                    thumbnail=info.get("thumbnail") or (
                        max(
                            info.get("thumbnails") or [{"url": ""}],
                            key=lambda t: (t.get("width", 0) or 0) * (t.get("height", 0) or 0),
                        ).get("url")
                    ) or (f"https://i.ytimg.com/vi/{info.get('id', '')}/hqdefault.jpg" if info.get("id") else None),
                    view_count=info.get("view_count"),
                    like_count=info.get("like_count"),
                    upload_date=info.get("upload_date"),
                    is_music="music.youtube.com" in url or "youtubemusic" in url,
                    album=info.get("album"),
                )
        except Exception:
            return None

    def get_streaming_url(self, url: str, bitrate: int = 256) -> Optional[str]:
        """Get a direct streaming URL for the best audio format without downloading."""
        yt_dlp = self._get_ytdlp()
        
        # bitrate is in kbps; yt-dlp abr is also in kbps
        target_kbps = bitrate
        ydl_info_opts = self._get_base_ydl_opts(
            quiet=True,
            for_info=True,
            format="bestaudio/best",
        )

        try:
            with yt_dlp.YoutubeDL(ydl_info_opts) as ydl:
                info = ydl.extract_info(url, download=False)

            formats = info.get("formats", [])
            audio_formats = [
                f for f in formats 
                if f.get("acodec") != "none" and f.get("vcodec") == "none"
            ]

            if not audio_formats:
                return None

            audio_formats.sort(key=lambda f: f.get("abr", 0) or 0)

            best_format = None
            for fmt in audio_formats:
                abr = fmt.get("abr", 0) or 0
                if abr <= target_kbps * 1.1:
                    best_format = fmt
                else:
                    break

            if not best_format:
                best_format = audio_formats[0]

            return best_format.get("url")
            
        except Exception as e:
            logger.error(f"Failed to get streaming URL for {url}: {e}")
            return None

    # ==================== DOWNLOAD ====================

    def download_track(
        self,
        track_or_url: Any,
        output_path: str,
        bitrate: Optional[int] = None,
        progress_callback: Optional[Callable[[int, int], None]] = None,
        prefer_music: bool = False,
    ) -> DownloadResult:
        """
        Download a YouTube track at the best available native quality up to the target bitrate.

        Args:
            track_or_url: YouTubeTrack object or direct URL string
            output_path: Output file path (without extension, or with extension)
            bitrate: Maximum bitrate in kbps (default: self.preferred_quality)
            progress_callback: Called with (downloaded_bytes, total_bytes)
            prefer_music: Try YouTube Music extractor first

        Returns:
            DownloadResult with success status and file info
        """
        self._get_ytdlp()

        # Resolve URL
        if isinstance(track_or_url, YouTubeTrack):
            url = track_or_url.url
            track = track_or_url
        else:
            url = str(track_or_url)
            track = self.get_track_info(url)

        if not url:
            return DownloadResult(success=False, error="Invalid track/URL")

        # Use provided bitrate or default
        target_bitrate = bitrate or self.preferred_quality

        # Ensure output path has no extension (yt-dlp adds .mp3)
        output_base = os.path.splitext(output_path)[0]
        Path(output_base).parent.mkdir(parents=True, exist_ok=True)

        # Try multiple strategies
        strategies = [
            self._download_native,
            self._download_with_music_extractor,
            self._download_invidious_fallback,
        ]

        if prefer_music:
            strategies = [self._download_with_music_extractor] + strategies

        # Internal progress hook wrapper
        def progress_hook(d):
            if d["status"] == "downloading" and progress_callback:
                downloaded = d.get("downloaded_bytes", 0)
                total = d.get("total_bytes") or d.get("total_bytes_estimate", 0)
                if total > 0:
                    progress_callback(downloaded, total)
            elif d["status"] == "finished" and progress_callback:
                total = d.get("total_bytes") or d.get("total_bytes_estimate", 0)
                if total > 0:
                    progress_callback(total, total)

        last_error = Exception("Request failed")

        for strategy in strategies:
            try:
                result = strategy(
                    url=url,
                    output_base=output_base,
                    bitrate=target_bitrate,
                    progress_hook=progress_hook if progress_callback else None,
                    track=track,
                )
                if result.success:
                    return result
                last_error = result.error
            except Exception as e:
                last_error = str(e)
                continue

        return DownloadResult(
            success=False,
            error=f"All download strategies failed. Last error: {last_error}",
        )

    def _download_native(
        self,
        url: str,
        output_base: str,
        bitrate: int,
        progress_hook: Optional[Callable],
        track: Optional[YouTubeTrack],
    ) -> DownloadResult:
        """
        Download the best available native format up to the target bitrate.
        Only re-encode if format conversion is needed (e.g., opus -> mp3).
        """
        import yt_dlp

        # First, get available formats to find the best native one
        ydl_info_opts = self._get_base_ydl_opts(
            quiet=True,
            for_info=True,
            format="bestaudio/best",  # Get all formats
        )

        with yt_dlp.YoutubeDL(ydl_info_opts) as ydl:
            info = ydl.extract_info(url, download=False)

        # Find best audio format up to target bitrate
        formats = info.get("formats", [])
        audio_formats = [
            f
            for f in formats
            if f.get("acodec") != "none" and f.get("vcodec") == "none"
        ]

        if not audio_formats:
            return DownloadResult(success=False, error="No audio formats found")

        # Sort by bitrate (kbps), prefer highest up to target
        audio_formats.sort(key=lambda f: f.get("abr", 0) or 0)

        # Find best format <= target bitrate (with some tolerance)
        # Note: yt-dlp's abr is in kbps, bitrate param is also in kbps
        target_kbps = bitrate
        best_format = None
        for fmt in audio_formats:
            abr = fmt.get("abr", 0) or 0
            if abr <= target_kbps * 1.1:  # 10% tolerance
                best_format = fmt
            else:
                break

        if not best_format:
            # Fallback to lowest bitrate format
            best_format = audio_formats[0]

        native_abr = best_format.get("abr", 0) or 0  # kbps
        native_ext = best_format.get("ext", "webm")
        native_acodec = best_format.get("acodec", "opus")
        format_id = best_format.get("format_id", "")

        logger.debug(
            f"Selected native format: {format_id} ({native_abr}kbps {native_acodec})"
        )

        # Determine if we need to transcode
        # Only transcode if format is not MP3/M4A or if bitrate exceeds target significantly
        needs_transcode = native_acodec not in ["mp3", "mp2"] or native_abr > 320

        if needs_transcode:
            # Transcode to MP3 at native bitrate (capped at target)
            target_abr_kbps = min(native_abr, target_kbps) or target_kbps
            format_spec = f"{format_id}/bestaudio/best"
            postprocessors = [
                {
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "mp3",
                    "preferredquality": str(int(target_abr_kbps)),
                }
            ]
            ext_out = "mp3"
        else:
            # Download native format, just remux if needed
            format_spec = f"{format_id}/bestaudio/best"
            postprocessors = []
            ext_out = (
                native_ext if native_ext != "webm" else "m4a"
            )  # webm audio often m4a container

        ydl_opts = self._get_base_ydl_opts(
            quiet=True,
            for_info=False,
            format=format_spec,
            outtmpl=f"{output_base}.%(ext)s",
            progress_hooks=[progress_hook] if progress_hook else [],
            postprocessors=postprocessors,
        )

        return self._execute_download(
            url, ydl_opts, output_base, bitrate, expected_ext=ext_out
        )

    def _download_with_music_extractor(
        self,
        url: str,
        output_base: str,
        bitrate: int,
        progress_hook: Optional[Callable],
        track: Optional[YouTubeTrack],
    ) -> DownloadResult:
        """Download using YouTube Music extractor with native quality."""
        import yt_dlp

        # Convert to music URL if needed
        video_id = self._extract_video_id(url)
        music_url = f"https://music.youtube.com/watch?v={video_id}"

        # Get available formats from YouTube Music
        ydl_info_opts = self._get_base_ydl_opts(
            quiet=True,
            for_info=True,
            format="bestaudio/best",
            extractor_args={
                "youtubemusic": {
                    "player_client": ["android_music", "web_music"],
                }
            },
        )

        with yt_dlp.YoutubeDL(ydl_info_opts) as ydl:
            info = ydl.extract_info(music_url, download=False)

        formats = info.get("formats", [])
        audio_formats = [
            f
            for f in formats
            if f.get("acodec") != "none" and f.get("vcodec") == "none"
        ]

        if not audio_formats:
            return DownloadResult(success=False, error="No audio formats found")

        target_kbps = bitrate
        audio_formats.sort(key=lambda f: f.get("abr", 0) or 0)

        best_format = None
        for fmt in audio_formats:
            abr = fmt.get("abr", 0) or 0
            if abr <= target_kbps * 1.1:
                best_format = fmt
            else:
                break

        if not best_format:
            best_format = audio_formats[0]

        native_abr = best_format.get("abr", 0) or 0  # kbps
        native_ext = best_format.get("ext", "webm")
        native_acodec = best_format.get("acodec", "opus")
        format_id = best_format.get("format_id", "")

        logger.debug(
            f"Selected native format (Music): {format_id} ({native_abr}kbps {native_acodec})"
        )

        needs_transcode = native_acodec not in ["mp3", "mp2"] or native_abr > 320

        if needs_transcode:
            target_abr_kbps = min(native_abr, target_kbps) or target_kbps
            format_spec = f"{format_id}/bestaudio/best"
            postprocessors = [
                {
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "mp3",
                    "preferredquality": str(int(target_abr_kbps)),
                }
            ]
            ext_out = "mp3"
        else:
            format_spec = f"{format_id}/bestaudio/best"
            postprocessors = []
            ext_out = native_ext if native_ext != "webm" else "m4a"

        ydl_opts = self._get_base_ydl_opts(
            quiet=True,
            for_info=False,
            format=format_spec,
            outtmpl=f"{output_base}.%(ext)s",
            progress_hooks=[progress_hook] if progress_hook else [],
            postprocessors=postprocessors,
        )

        return self._execute_download(
            music_url, ydl_opts, output_base, bitrate, expected_ext=ext_out
        )

    def _download_invidious_fallback(
        self,
        url: str,
        output_base: str,
        bitrate: int,
        progress_hook: Optional[Callable],
        track: Optional[YouTubeTrack],
    ) -> DownloadResult:
        """Fallback: Use Invidious instance to get direct stream URL, then download."""
        import requests

        self._get_ytdlp()

        video_id = self._extract_video_id(url)
        if not video_id:
            return DownloadResult(success=False, error="Could not extract video ID")

        # Try each Invidious instance
        for attempt in range(len(self.INVIDIOUS_INSTANCES)):
            instance = self.INVIDIOUS_INSTANCES[self._invidious_idx]
            self._invidious_idx = (self._invidious_idx + 1) % len(
                self.INVIDIOUS_INSTANCES
            )

            try:
                # Get stream info from Invidious
                api_url = f"{instance}/api/v1/videos/{video_id}"
                response = requests.get(api_url, timeout=10)
                response.raise_for_status()
                data = response.json()

                # Get adaptive formats (audio only)
                formats = data.get("adaptiveFormats", [])
                audio_formats = [
                    f for f in formats if f.get("type", "").startswith("audio/")
                ]

                if not audio_formats:
                    continue

                # Sort by bitrate, prefer target
                audio_formats.sort(
                    key=lambda f: abs(f.get("bitrate", 0) - bitrate * 1000)
                )
                best_format = audio_formats[0]
                stream_url = best_format.get("url")

                if not stream_url:
                    continue

                # Download via yt-dlp using direct URL
                ydl_opts = self._get_base_ydl_opts(
                    quiet=True,
                    outtmpl=f"{output_base}.%(ext)s",
                    progress_hooks=[progress_hook] if progress_hook else [],
                    postprocessors=[
                        {
                            "key": "FFmpegExtractAudio",
                            "preferredcodec": "mp3",
                            "preferredquality": str(bitrate),
                        }
                    ],
                )

                return self._execute_download(
                    stream_url, ydl_opts, output_base, bitrate
                )

            except Exception:
                continue

        return DownloadResult(success=False, error="Invidious fallback failed")

    def _execute_download(
        self,
        url: str,
        ydl_opts: Dict,
        output_base: str,
        bitrate: int,
        expected_ext: Optional[str] = None,
    ) -> DownloadResult:
        """Execute yt-dlp download and verify result."""
        import yt_dlp

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([url])

            # Find the actual output file - yt-dlp may save with video title instead of output_base
            actual_path = None

            # First try exact match with expected extension
            if expected_ext:
                test_path = f"{output_base}.{expected_ext}"
                if os.path.exists(test_path):
                    actual_path = test_path

            # Search for any file matching output_base with known extensions
            if not actual_path:
                for ext in [".mp3", ".m4a", ".webm", ".opus", ".flac", ".mka", ".mp4"]:
                    test_path = output_base + ext
                    if os.path.exists(test_path):
                        actual_path = test_path
                        break

            # If still not found, search directory for recently created files matching pattern
            if not actual_path:
                output_dir = os.path.dirname(output_base) or "."
                base_name = os.path.basename(output_base)
                for fname in os.listdir(output_dir):
                    fpath = os.path.join(output_dir, fname)
                    if os.path.isfile(fpath):
                        # Match by extension and check if recently modified
                        if any(
                            fname.endswith(ext)
                            for ext in [
                                ".mp3",
                                ".m4a",
                                ".webm",
                                ".opus",
                                ".flac",
                                ".mka",
                                ".mp4",
                            ]
                        ):
                            # Check if file contains base_name or was recently created
                            # Use absolute path comparison to avoid parent directory issues
                            abs_fpath = os.path.abspath(fpath)
                            abs_output_dir = os.path.abspath(output_dir)
                            if abs_fpath.startswith(abs_output_dir):
                                if (
                                    base_name in fname
                                    or (time.time() - os.path.getctime(fpath)) < 120
                                ):
                                    actual_path = fpath
                                    break

            if not actual_path:
                return DownloadResult(success=False, error="Downloaded file not found")

            file_size = os.path.getsize(actual_path)
            if file_size == 0:
                os.remove(actual_path)
                return DownloadResult(success=False, error="Downloaded file is empty")

            # Probe audio properties
            probe = self._probe_audio(actual_path)

            return DownloadResult(
                success=True,
                file_path=actual_path,
                file_size=file_size,
                bitrate=probe.get("bitrate"),
                codec=probe.get("codec"),
                format_used=probe.get("codec"),
            )

        except yt_dlp.utils.DownloadError as e:
            return DownloadResult(success=False, error=f"Download failed: {e}")
        except Exception as e:
            return DownloadResult(success=False, error=f"Unexpected error: {e}")

    def _extract_video_id(self, url: str) -> Optional[str]:
        """Extract YouTube video ID from various URL formats."""
        patterns = [
            r"(?:youtube\.com/watch\?v=|youtu\.be/|youtube\.com/embed/|youtube\.com/v/|music\.youtube\.com/watch\?v=)([^&\n?#]+)",
            r"youtube\.com/shorts/([^&\n?#]+)",
        ]

        for pattern in patterns:
            match = re.search(pattern, url)
            if match:
                return match.group(1)
        return None

    def _probe_audio(self, file_path: str) -> Dict[str, Any]:
        """Extract audio metadata using ffprobe."""
        try:
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
        except FileNotFoundError:
            logger.warning(
                "ffprobe not found. Please install ffmpeg to enable proper audio probing."
            )
        except Exception as e:
            logger.debug(f"ffprobe failed: {e}")
        return {}


# ==================== CONVENIENCE FUNCTIONS ====================


def search_tracks(
    query: str,
    limit: int = 20,
    search_type: Literal["youtube", "youtubemusic"] = "youtube",
    cookies_file: Optional[str] = None,
    po_token: Optional[str] = None,
) -> List[YouTubeTrack]:
    """Quick search using default client."""
    client = YouTubeClient(cookies_file=cookies_file, po_token=po_token)
    return client.search(query, limit, search_type)


def download_track(
    track_or_url: Any,
    output_dir: str = ".",
    bitrate: int = 256,
    progress_callback: Optional[Callable[[int, int], None]] = None,
    cookies_file: Optional[str] = None,
    po_token: Optional[str] = None,
) -> DownloadResult:
    """Quick download using default client."""
    client = YouTubeClient(cookies_file=cookies_file, po_token=po_token)

    if isinstance(track_or_url, str):
        track = client.get_track_info(track_or_url)
        if not track:
            return DownloadResult(success=False, error="Track not found")
    else:
        track = track_or_url

    # Generate filename
    safe_title = re.sub(r'[<>:"/\\|?*]', "_", track.title)
    safe_artist = re.sub(r'[<>:"/\\|?*]', "_", track.artist)
    output_path = os.path.join(output_dir, f"{safe_title} - {safe_artist}")

    return client.download_track(track, output_path, bitrate, progress_callback)


# ==================== COOKIE HELPERS ====================


def export_browser_cookies(
    browser: str = "chrome", output_file: str = "youtube_cookies.txt"
):
    """
    Export YouTube cookies from browser for yt-dlp authentication.

    Run once to create cookies file, then use with YouTubeClient.

    Args:
        browser: 'chrome', 'firefox', 'edge', 'safari', 'brave', 'vivaldi'
        output_file: Path to save cookies
    """
    # Extract using yt-dlp first
    try:
        import yt_dlp

        ydl_opts = {
            "cookiesfrombrowser": (browser,),
            "skip_download": True,
            "quiet": True,
        }
        with yt_dlp.YoutubeDL(ydl_opts):
            # This will extract cookies into yt-dlp's internal state
            pass
    except Exception:
        pass

    # Better: use browser_cookie3 or browsercookie
    try:
        try:
            import browser_cookie3

            cj = getattr(browser_cookie3, browser.lower())(domain_name="youtube.com")
        except ImportError:
            import browsercookie

            cj = getattr(browsercookie, browser.lower())()

        with open(output_file, "w") as f:
            f.write("# Netscape HTTP Cookie File\n")
            for cookie in cj:
                if cookie.domain.endswith("youtube.com") or cookie.domain.endswith(
                    "google.com"
                ):
                    f.write(
                        f"{cookie.domain}\tTRUE\t{cookie.path}\t{'TRUE' if cookie.secure else 'FALSE'}\t"
                        f"{int(cookie.expires) if cookie.expires else 0}\t{cookie.name}\t{cookie.value}\n"
                    )
        print(f"Cookies exported to {output_file}")
    except ImportError:
        print("Install browser_cookie3 or browsercookie: pip install browser-cookie3")
    except Exception as e:
        print(f"Failed to export cookies: {e}")


# ==================== CLI ====================

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
        print('  python youtube_downloader.py search "query" [--music]')
        print('  python youtube_downloader.py download "URL" [output_dir]')
        print("  python youtube_downloader.py export-cookies [browser]")
        sys.exit(1)

    command = sys.argv[1]

    if command == "search":
        query = sys.argv[2] if len(sys.argv) > 2 else "believer imagine dragons"
        search_type = "youtubemusic" if "--music" in sys.argv else "youtube"

        print(f"\nSearching {search_type} for: {query}")
        tracks = search_tracks(query, 10, search_type)

        if not tracks:
            print("No results found.")
        else:
            print(f"\nFound {len(tracks)} results:\n")
            for i, track in enumerate(tracks, 1):
                duration = ""
                if track.duration_ms:
                    m = track.duration_ms // 60000
                    s = (track.duration_ms % 60000) // 1000
                    duration = f" ({m}:{s:02d})"
                music_badge = " 🎵" if track.is_music else ""
                print(f"  {i}. {track.title} - {track.artist}{duration}{music_badge}")
                print(f"     URL: {track.url}")
                print()

    elif command == "download":
        if len(sys.argv) < 3:
            print("Error: URL required")
            sys.exit(1)

        url = sys.argv[2]
        output_dir = sys.argv[3] if len(sys.argv) > 3 else "."
        bitrate = 320 if "--320" in sys.argv else 256

        print(f"\nDownloading: {url}")
        print(f"Output directory: {output_dir}")
        print(f"Target bitrate: {bitrate}kbps")

        result = download_track(
            url, output_dir, bitrate, progress_callback=print_progress
        )
        print()

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

    elif command == "export-cookies":
        browser = sys.argv[2] if len(sys.argv) > 2 else "chrome"
        export_browser_cookies(browser)

    else:
        print(f"Unknown command: {command}")
        sys.exit(1)
