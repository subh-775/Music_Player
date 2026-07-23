"""
SoundCloud Downloader Module (yt-dlp based, native bitrate)
============================================================
Search SoundCloud and download tracks at their native quality.

Features:
- Native bitrate selection (no unnecessary re-encoding)
- Works without API keys
- 256kbps MP3 native where available
- Automatic format selection
"""

import os
import re
import logging
import subprocess
from typing import Optional, Dict, List, Any, Callable
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass
class SoundCloudTrack:
    """Represents a track from SoundCloud search results."""

    id: str
    title: str
    artist: str
    url: str
    duration_ms: Optional[int] = None
    thumbnail: Optional[str] = None
    uploader: Optional[str] = None
    view_count: Optional[int] = None
    like_count: Optional[int] = None
    upload_date: Optional[str] = None

    @property
    def search_query(self) -> str:
        return f"{self.title} {self.artist}"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "artist": self.artist,
            "url": self.url,
            "duration_ms": self.duration_ms,
            "duration_sec": round(self.duration_ms / 1000)
            if self.duration_ms
            else None,
            "thumbnail": self.thumbnail,
            "uploader": self.uploader,
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
    source: str = "soundcloud"
    format_used: Optional[str] = None


# ─── Format selection ─────────────────────────────────────────────────────────
# SoundCloud offers several transcodings of the same track, and two kinds of
# them are traps. Picking purely on bitrate — which is what we used to do —
# walks into both, because the traps advertise the HIGHEST bitrates.
#
# 1. HLS (`protocol: m3u8_native`). The "url" is an .m3u8 PLAYLIST, not audio.
#    We hand that URL to an <audio> element via /api/proxy_stream, and Chromium
#    — so every Android WebView — has no HLS support at all. It fetches a few
#    hundred bytes of "#EXTM3U..." text and the track dies. A real example:
#    a track offering http_mp3_128 AND hls_aac_160k picked the HLS one purely
#    because 160 > 128.
#
# 2. `_preview` formats. Go+/monetized tracks expose only a 30-SECOND SNIPPET
#    (the URL says /preview/0/30/), while the track metadata still reports the
#    full 3:36 duration. We served that snippet as if it were the song.
#
# If neither trap leaves anything behind, we do NOT have the track: return None
# and let the caller fall back to another source, rather than half-play it.
_PROGRESSIVE_PROTOCOLS = ("http", "https")


def _is_preview(fmt: Dict[str, Any]) -> bool:
    return (
        "preview" in (fmt.get("format_id") or "").lower()
        or "/preview/" in (fmt.get("url") or "")
    )


def pick_audio_format(
    formats: List[Dict[str, Any]], max_bitrate: int
) -> Optional[Dict[str, Any]]:
    """The best full, progressive, audio-only format at or under max_bitrate.

    None means SoundCloud has nothing we can actually play end to end.
    """
    usable = [
        f
        for f in (formats or [])
        if f.get("acodec") != "none"
        and f.get("vcodec") == "none"
        and f.get("protocol") in _PROGRESSIVE_PROTOCOLS
        and not _is_preview(f)
    ]
    if not usable:
        return None

    within = [f for f in usable if (f.get("abr") or 0) <= max_bitrate * 1.1]
    if within:
        return max(within, key=lambda f: f.get("abr") or 0)
    # Everything is over the ceiling — the quietest is the closest to honouring
    # it, and is still a real stream.
    return min(usable, key=lambda f: f.get("abr") or 0)


class SoundCloudClient:
    """
    SoundCloud client using yt-dlp for search and download.

    Advantages:
    - No API keys required
    - Works on any hosting (residential IP for download)
    - Native bitrate selection (no unnecessary re-encoding)
    """

    def __init__(self, timeout: int = 30, max_retries: int = 2):
        self.timeout = timeout
        self.max_retries = max_retries

    def _get_ydl_opts(self, quiet: bool = True, **extra) -> Dict[str, Any]:
        """Base yt-dlp options for SoundCloud."""
        return {
            "quiet": quiet,
            "no_warnings": quiet,
            "socket_timeout": self.timeout,
            "retries": self.max_retries,
            "ignoreerrors": False,
            **extra,
        }

    # ==================== SEARCH ====================

    def search(self, query: str, limit: int = 20) -> List[SoundCloudTrack]:
        """
        Search SoundCloud using yt-dlp's scsearch extractor.

        Args:
            query: Search query
            limit: Maximum results

        Returns:
            List of SoundCloudTrack objects
        """
        import yt_dlp

        # Use scsearch{N}: prefix for limited results
        search_query = f"scsearch{limit}:{query}"

        ydl_opts = self._get_ydl_opts(
            quiet=True,
            extract_flat="in_playlist",
            default_search="scsearch",
        )

        tracks = []

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                result = ydl.extract_info(search_query, download=False)

                for entry in result.get("entries", []):
                    if not entry:
                        continue

                    try:
                        # yt-dlp SoundCloud entries have these fields
                        track_id = str(entry.get("id", ""))
                        title = entry.get("title", "")
                        uploader = entry.get("uploader", "")
                        url = entry.get("webpage_url") or entry.get("url", "")
                        duration = entry.get("duration")
                        thumbnail = entry.get("thumbnail")
                        # In extract_flat mode, yt-dlp puts thumbs in
                        # the `thumbnails` list, not the scalar field.
                        if not thumbnail:
                            thumbs = entry.get("thumbnails") or []
                            if thumbs:
                                # Prefer by preference field (SC provides it),
                                # then by resolution
                                thumbnail = max(
                                    thumbs,
                                    key=lambda t: (
                                        t.get("preference", 0) or 0,
                                        (t.get("width", 0) or 0) * (t.get("height", 0) or 0),
                                    ),
                                ).get("url")
                        view_count = entry.get("view_count")
                        like_count = entry.get("like_count")
                        upload_date = entry.get("upload_date")

                        # Skip if missing essentials
                        if not title or not url:
                            continue

                        # Duration in ms
                        duration_ms = int(duration * 1000) if duration else None

                        track = SoundCloudTrack(
                            id=track_id,
                            title=title,
                            artist=self._extract_artist(title, uploader),
                            url=url,
                            duration_ms=duration_ms,
                            thumbnail=thumbnail,
                            uploader=uploader,
                            view_count=view_count,
                            like_count=like_count,
                            upload_date=upload_date,
                        )
                        tracks.append(track)

                    except Exception:
                        continue

        except Exception as e:
            raise RuntimeError(f"SoundCloud search failed: {e}")

        return tracks

    @staticmethod
    def _extract_artist(title: str, uploader: str) -> str:
        """Derive the real artist from a SoundCloud upload. A dashed title is
        AMBIGUOUS — "Coldplay - The Scientist" is Artist-Title but "Clocks -
        Coldplay" is Title-Artist — so we DON'T blindly take the part before the
        dash (that read "Clocks" as the artist). Instead, use the uploader to
        disambiguate: pick whichever dash-part the uploader corroborates
        (channels are usually "<artist> songs/official/vevo"); otherwise fall
        back to the uploader. No false artist invented from a song title."""
        import re as _re
        up = (uploader or "").lower()
        m = _re.match(r"^\s*(.+?)\s*[-–—]\s*(.+?)\s*$", title or "")
        if m:
            for cand in (m.group(1).strip(), m.group(2).strip()):
                cl = cand.lower()
                if cl and 1 < len(cand) <= 40 and up and (cl in up or up in cl):
                    return cand
        return uploader or "Unknown"

    # ==================== GET TRACK INFO ====================

    def get_track_info(self, url: str) -> Optional[SoundCloudTrack]:
        """Extract full track info from a SoundCloud URL."""
        import yt_dlp

        ydl_opts = self._get_ydl_opts(quiet=True)

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)

                return SoundCloudTrack(
                    id=str(info.get("id", "")),
                    title=info.get("title", ""),
                    artist=info.get("uploader", ""),
                    url=info.get("webpage_url", url),
                    duration_ms=int(info.get("duration", 0) * 1000)
                    if info.get("duration")
                    else None,
                    thumbnail=info.get("thumbnail") or (
                        max(
                            info.get("thumbnails") or [{"url": ""}],
                            key=lambda t: (
                                t.get("preference", 0) or 0,
                                (t.get("width", 0) or 0) * (t.get("height", 0) or 0),
                            ),
                        ).get("url")
                    ) or None,
                    uploader=info.get("uploader"),
                    view_count=info.get("view_count"),
                    like_count=info.get("like_count"),
                    upload_date=info.get("upload_date"),
                )
        except Exception:
            return None

    def get_streaming_url(self, url: str, max_bitrate: int = 256) -> Optional[str]:
        """Get a direct streaming URL for the best audio format without downloading.

        Returns None when SoundCloud has no full, progressive stream for this
        track — see pick_audio_format(). The caller falls back to another source.
        """
        import yt_dlp

        ydl_opts = self._get_ydl_opts(quiet=True, extract_flat=False)

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)

            best_format = pick_audio_format(info.get("formats", []), max_bitrate)
            if not best_format:
                logger.info(
                    f"No full progressive audio stream for {url} "
                    "(HLS-only or preview-only) — caller should try another source"
                )
                return None
            return best_format.get("url")

        except Exception as e:
            logger.error(f"Failed to get streaming URL for {url}: {e}")
            return None

    # ==================== DOWNLOAD ====================

    def download_track(
        self,
        track_or_url: Any,
        output_base: str,
        max_bitrate: int = 256,
        progress_hook: Optional[Callable[[int, int], None]] = None,
    ) -> DownloadResult:
        """
        Download a SoundCloud track at the best available native quality up to max_bitrate.

        Args:
            track_or_url: SoundCloudTrack object or direct URL string
            output_base: Output file path (without extension)
            max_bitrate: Maximum bitrate in kbps (default: 256)
            progress_hook: Called with (downloaded_bytes, total_bytes)

        Returns:
            DownloadResult with success status and file info
        """
        import yt_dlp

        # Resolve URL
        if isinstance(track_or_url, SoundCloudTrack):
            url = track_or_url.url
            track = track_or_url
        else:
            url = str(track_or_url)
            track = self.get_track_info(url)

        if not url:
            return DownloadResult(success=False, error="Invalid track/URL")

        Path(output_base).parent.mkdir(parents=True, exist_ok=True)

        def _ydl_progress_hook(d):
            if d["status"] == "downloading" and progress_hook:
                downloaded = d.get("downloaded_bytes", 0)
                total = d.get("total_bytes") or d.get("total_bytes_estimate", 0)
                if total > 0:
                    progress_hook(downloaded, total)
            elif d["status"] == "finished" and progress_hook:
                total = d.get("total_bytes") or d.get("total_bytes_estimate", 0)
                if total > 0:
                    progress_hook(total, total)

        # Probe available formats first
        ydl_info_opts = self._get_ydl_opts(
            quiet=True,
            extract_flat=False,
        )

        with yt_dlp.YoutubeDL(ydl_info_opts) as ydl:
            info = ydl.extract_info(
                track.url if isinstance(track_or_url, SoundCloudTrack) else url,
                download=False,
            )

        best_format = pick_audio_format(info.get("formats", []), max_bitrate)

        if not best_format:
            # Same rule as streaming: a 30-second preview is not the track, and
            # HLS needs an ffmpeg that Android doesn't have. Failing here lets
            # the download manager try another source instead of writing a
            # snippet to disk under the full song's name.
            return DownloadResult(
                success=False,
                error="No full progressive audio stream (HLS-only or preview-only)",
            )

        native_abr = best_format.get("abr", 0) or 0
        native_ext = best_format.get("ext", "m4a")
        native_acodec = best_format.get("acodec", "aac")
        format_id = best_format.get("format_id", "")

        logger.debug(
            f"Selected native SoundCloud format: {format_id} ({native_abr}kbps {native_acodec})"
        )

        # Only transcode if not MP3/M4A or bitrate exceeds max
        needs_transcode = (
            native_acodec not in ["mp3", "mp2"] or native_abr > max_bitrate * 1.1
        )

        if needs_transcode:
            target_abr = min(native_abr, max_bitrate)
            format_spec = format_id
            postprocessors = [
                {
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "mp3",
                    "preferredquality": str(target_abr),
                }
            ]
            ext_out = "mp3"
        else:
            format_spec = format_id
            postprocessors = []
            ext_out = native_ext if native_ext != "webm" else "m4a"

        ydl_opts = self._get_ydl_opts(
            quiet=True,
            format=format_spec,
            outtmpl=f"{output_base}.%(ext)s",
            postprocessors=postprocessors,
        )

        return self._execute_download(
            track.url if isinstance(track, SoundCloudTrack) else track,
            ydl_opts,
            output_base,
            max_bitrate,
            expected_ext=ext_out,
        )

    def _execute_download(
        self,
        url: str,
        ydl_opts: Dict,
        output_base: str,
        max_bitrate: int,
        expected_ext: Optional[str] = None,
    ) -> DownloadResult:
        """Execute yt-dlp download and verify result."""
        import yt_dlp

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([url])

            # Find the actual output file
            actual_path = None
            if expected_ext:
                test_path = f"{output_base}.{expected_ext}"
                if os.path.exists(test_path):
                    actual_path = test_path

            if not actual_path:
                for ext in [".mp3", ".m4a", ".webm", ".opus", ".flac", ".mka", ".m4a"]:
                    test_path = output_base + ext
                    if os.path.exists(test_path):
                        actual_path = test_path
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
        except Exception:
            pass
        return {}


# ==================== CONVENIENCE FUNCTIONS ====================


def search_tracks(query: str, limit: int = 20) -> List[SoundCloudTrack]:
    """Quick search using default client."""
    client = SoundCloudClient()
    return client.search(query, limit)


def download_track(
    track_or_url: Any,
    output_dir: str = ".",
    max_bitrate: int = 256,
    progress_callback: Optional[Callable[[int, int], None]] = None,
) -> DownloadResult:
    """Quick download using default client."""
    client = SoundCloudClient()

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

    return client.download_track(track, output_path, max_bitrate, progress_callback)


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
        print('  python soundcloud_downloader.py search "query"')
        print(
            '  python soundcloud_downloader.py download "https://soundcloud.com/..." [output_dir]'
        )
        sys.exit(1)

    command = sys.argv[1]

    if command == "search":
        query = sys.argv[2] if len(sys.argv) > 2 else "believer imagine dragons"
        print(f"\nSearching SoundCloud for: {query}")
        tracks = search_tracks(query, 10)

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
                print(f"  {i}. {track.title} - {track.artist}{duration}")
                print(f"     URL: {track.url}")
                print()

    elif command == "download":
        if len(sys.argv) < 3:
            print("Error: URL required")
            sys.exit(1)

        url = sys.argv[2]
        output_dir = sys.argv[3] if len(sys.argv) > 3 else "."

        print(f"\nDownloading: {url}")
        print(f"Output directory: {output_dir}")

        result = download_track(url, output_dir, progress_callback=print_progress)
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

    else:
        print(f"Unknown command: {command}")
        sys.exit(1)
