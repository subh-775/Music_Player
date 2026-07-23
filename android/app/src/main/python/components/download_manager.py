"""
Download Manager Module
=======================
High-level download queue manager with progress tracking, resume support,
and metadata embedding.

Features:
- Async download queue with configurable concurrency
- Progress callbacks per download
- Resume support for interrupted downloads
- Metadata embedding (ID3v2.4 tags + cover art)
- Configurable retry logic with exponential backoff
- File naming with collision handling
"""

import time
import hashlib
import threading
import re
from queue import Queue, Empty
from pathlib import Path
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Optional, List, Dict, Any, Callable
from concurrent.futures import ThreadPoolExecutor, Future

try:
    import mutagen
    from mutagen.mp3 import MP3
    from mutagen.id3 import (
        ID3,
        TIT2,
        TPE1,
        TALB,
        TDRC,
        TCON,
        TRCK,
        TPOS,
        TYER,
        APIC,
        USLT,
        TPE2,
        TCOM,
    )
    from mutagen.flac import FLAC
    from mutagen.mp4 import MP4, MP4Cover

    MUTAGEN_AVAILABLE = True
except ImportError:
    MUTAGEN_AVAILABLE = False


class DownloadStatus(Enum):
    PENDING = "pending"
    QUEUED = "queued"
    DOWNLOADING = "downloading"
    PAUSED = "paused"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass
class DownloadTask:
    """Represents a single download task."""

    id: str
    url: str
    output_path: str
    track_info: Dict[str, Any]
    max_bitrate: int = 256
    status: DownloadStatus = DownloadStatus.PENDING
    progress: float = 0.0
    downloaded_bytes: int = 0
    total_bytes: int = 0
    speed: float = 0.0  # bytes/sec
    eta: float = 0.0  # seconds
    error: Optional[str] = None
    file_path: Optional[str] = None
    file_size: int = 0
    bitrate: int = 0
    codec: str = ""
    retries: int = 0
    created_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    completed_at: Optional[float] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "url": self.url,
            "output_path": self.output_path,
            "track_info": self.track_info,
            "max_bitrate": self.max_bitrate,
            "status": self.status.value,
            "progress": self.progress,
            "downloaded_bytes": self.downloaded_bytes,
            "total_bytes": self.total_bytes,
            "speed": self.speed,
            "eta": self.eta,
            "error": self.error,
            "file_path": self.file_path,
            "file_size": self.file_size,
            "bitrate": self.bitrate,
            "codec": self.codec,
            "retries": self.retries,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
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


@dataclass
class DownloadQueueConfig:
    """Configuration for download queue."""

    max_concurrent: int = 3
    max_retries: int = 3
    retry_delay: float = 2.0
    retry_backoff: float = 2.0
    max_retry_delay: float = 60.0
    timeout_seconds: float = 300.0
    chunk_size: int = 8192
    overwrite_existing: bool = False
    skip_existing: bool = False
    auto_start: bool = True


class ProgressCallback:
    """Type hint for progress callbacks."""

    def __call__(self, task: "DownloadTask") -> None:
        pass


class DownloadManager:
    """
    High-level download queue manager with progress tracking and metadata embedding.

    Usage:
        manager = DownloadManager()
        task_id = manager.add_download(url, output_dir, track_info)
        manager.start()

        # Progress callback
        manager.on_progress(lambda task: print(f"{task.progress:.1f}%"))
    """

    def __init__(
        self, config: Optional[DownloadQueueConfig] = None, download_dir: str = "."
    ):
        self.config = config or DownloadQueueConfig()
        self.download_dir = Path(download_dir).resolve()
        self.download_dir.mkdir(parents=True, exist_ok=True)

        self._queue: Queue = Queue()
        self._tasks: Dict[str, DownloadTask] = {}
        self._lock = threading.RLock()
        self._executor: Optional[ThreadPoolExecutor] = None
        self._running = False
        self._paused = False
        self._shutdown = False

        # Callbacks
        self._progress_callbacks: List[Callable[[DownloadTask], None]] = []
        self._completion_callbacks: List[Callable[[DownloadTask], None]] = []
        self._error_callbacks: List[Callable[[DownloadTask, str], None]] = []

        # Metadata embedder
        self._metadata_embedder = MetadataEmbedder() if MUTAGEN_AVAILABLE else None
        # Optional hook: fn(track_info) -> track_info that produces the final
        # clean/complete metadata to embed right before writing tags. Set by the
        # API layer so every download gets consistent metadata regardless of
        # which screen triggered it.
        self._finalizer: Optional[Callable[[Dict[str, Any]], Dict[str, Any]]] = None

        # Optional hook: fn() -> dict of YouTubeClient cookie kwargs
        # ({"cookies_file":..., "cookies_from_browser":...}). Read live at
        # download time so a YouTube download uses the same connected account as
        # streaming (bot-gated/age-restricted videos). Set by the API layer.
        self._yt_cookie_provider: Optional[Callable[[], Dict[str, Any]]] = None

    def set_finalizer(self, fn: Callable[[Dict[str, Any]], Dict[str, Any]]) -> None:
        """Register the metadata finalizer used right before embedding."""
        self._finalizer = fn

    def set_youtube_cookie_provider(self, fn: Callable[[], Dict[str, Any]]) -> None:
        """Register a provider returning the current YouTube cookie kwargs."""
        self._yt_cookie_provider = fn

    # ==================== CALLBACK REGISTRATION ====================

    def on_progress(
        self, callback: Callable[[DownloadTask], None]
    ) -> Callable[[], None]:
        """Register a progress callback. Returns unsubscribe function."""
        with self._lock:
            self._progress_callbacks.append(callback)
        return lambda: self._progress_callbacks.remove(callback)

    def on_complete(
        self, callback: Callable[[DownloadTask], None]
    ) -> Callable[[], None]:
        """Register a completion callback. Returns unsubscribe function."""
        with self._lock:
            self._completion_callbacks.append(callback)
        return lambda: self._completion_callbacks.remove(callback)

    def on_error(
        self, callback: Callable[[DownloadTask, str], None]
    ) -> Callable[[], None]:
        """Register an error callback. Returns unsubscribe function."""
        with self._lock:
            self._error_callbacks.append(callback)
        return lambda: self._error_callbacks.remove(callback)

    def _emit_progress(self, task: DownloadTask):
        """Emit progress to all registered callbacks."""
        for cb in self._progress_callbacks:
            try:
                cb(task)
            except Exception:
                pass

    def _emit_complete(self, task: DownloadTask):
        """Emit completion to all registered callbacks."""
        for cb in self._completion_callbacks:
            try:
                cb(task)
            except Exception:
                pass

    def _emit_error(self, task: DownloadTask, error: str):
        """Emit error to all registered callbacks."""
        for cb in self._error_callbacks:
            try:
                cb(task, error)
            except Exception:
                pass

    # ==================== QUEUE MANAGEMENT ====================

    def add_download(
        self,
        url: str,
        track_info: Dict[str, Any],
        output_path: Optional[str] = None,
        max_bitrate: int = 256,
    ) -> str:
        """
        Add a download to the queue.

        Args:
            url: Source URL to download
            track_info: Track metadata dict (title, artist, album, etc.)
            output_path: Output file path (without extension) or None for auto
            max_bitrate: Maximum bitrate in kbps

        Returns:
            Task ID
        """
        task_id = hashlib.md5(
            f"{track_info.get('title', '')}{track_info.get('artist', '')}{time.time()}".encode()
        ).hexdigest()[:12]

        # Generate output path if not provided
        if output_path is None:
            safe_title = re.sub(
                r'[<>:"/\\|?*]', "_", track_info.get("title", "unknown")
            )
            safe_artist = re.sub(
                r'[<>:"/\\|?*]', "_", track_info.get("artist", "unknown")
            )
            output_path = str(self.download_dir / f"{safe_title} - {safe_artist}")

        task = DownloadTask(
            id=task_id,
            url=url,
            output_path=output_path,
            track_info=track_info,
            max_bitrate=max_bitrate,
        )

        with self._lock:
            self._tasks[task_id] = task
            self._queue.put(task_id)

        return task_id

    def add_batch_downloads(
        self,
        tracks: List[Dict[str, Any]],
        output_dir: Optional[str] = None,
        max_bitrate: int = 256,
    ) -> List[str]:
        """Add multiple downloads at once."""
        task_ids = []
        for track_info in tracks:
            url = track_info.get("url") or track_info.get("url")
            if not url:
                continue
            task_id = self.add_download(
                url=url,
                track_info=track_info,
                output_path=None,
                max_bitrate=max_bitrate,
            )
            task_ids.append(task_id)
        return task_ids

    def get_task(self, task_id: str) -> Optional[DownloadTask]:
        """Get task by ID."""
        with self._lock:
            return self._tasks.get(task_id)

    def get_all_tasks(self) -> List[DownloadTask]:
        """Get all tasks."""
        with self._lock:
            return list(self._tasks.values())

    def get_tasks_by_status(self, status: DownloadStatus) -> List[DownloadTask]:
        """Get all tasks with a specific status."""
        with self._lock:
            return [t for t in self._tasks.values() if t.status == status]

    # ==================== QUEUE CONTROL ====================

    def start(self):
        """Start the download queue processor."""
        if self._running:
            return

        self._running = True
        self._paused = False
        self._shutdown = False

        self._executor = ThreadPoolExecutor(max_workers=self.config.max_concurrent)

        # Start queue processor thread
        self._processor_thread = threading.Thread(
            target=self._process_queue, daemon=True
        )
        self._processor_thread.start()

    def pause(self):
        """Pause the queue (finishes current downloads)."""
        self._paused = True

    def resume(self):
        """Resume the queue."""
        self._paused = False

    def stop(self, wait: bool = True):
        """Stop the queue processor."""
        self._shutdown = True
        self._paused = False

        if self._executor:
            self._executor.shutdown(wait=wait)

        if hasattr(self, "_processor_thread") and self._processor_thread.is_alive():
            self._processor_thread.join(timeout=5.0)

    def cancel_task(self, task_id: str) -> bool:
        """Cancel a pending or downloading task."""
        with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                return False

            if task.status in (
                DownloadStatus.PENDING,
                DownloadStatus.QUEUED,
                DownloadStatus.DOWNLOADING,
            ):
                task.status = DownloadStatus.CANCELLED
                task.error = "Cancelled by user"
                self._emit_error(task, "Cancelled by user")
                return True
            return False

    def retry_task(self, task_id: str) -> bool:
        """Retry a failed task."""
        with self._lock:
            task = self._tasks.get(task_id)
            if not task or task.status != DownloadStatus.FAILED:
                return False

            # Reset for retry
            task.status = DownloadStatus.PENDING
            task.error = None
            task.retries += 1
            self._queue.put(task.id)
            return True

    def retry_all_failed(self) -> int:
        """Retry all failed tasks."""
        count = 0
        with self._lock:
            for task in self._tasks.values():
                if task.status == DownloadStatus.FAILED:
                    task.status = DownloadStatus.PENDING
                    task.error = None
                    task.retries += 1
                    self._queue.put(task.id)
                    count += 1
        return count

    def clear_completed(self) -> int:
        """Remove completed tasks from queue."""
        count = 0
        with self._lock:
            to_remove = [
                tid
                for tid, t in self._tasks.items()
                if t.status == DownloadStatus.COMPLETED
            ]
            for tid in to_remove:
                del self._tasks[tid]
                count += 1
        return count

    # ==================== QUEUE PROCESSOR ====================

    def _process_queue(self):
        """Main queue processing loop."""
        while not self._shutdown:
            if self._paused:
                time.sleep(0.5)
                continue

            try:
                task_id = self._queue.get(timeout=0.5)
            except Empty:
                continue

            with self._lock:
                task = self._tasks.get(task_id)
                if not task or task.status == DownloadStatus.CANCELLED:
                    continue

                # Check retry limit
                if task.retries >= self.config.max_retries:
                    task.status = DownloadStatus.FAILED
                    task.error = f"Max retries ({self.config.max_retries}) exceeded"
                    self._emit_error(task, task.error)
                    continue

                task.status = DownloadStatus.DOWNLOADING
                task.started_at = time.time()

                # Emit initial progress
                self._emit_progress(task)

            # Execute download in thread pool. Bind `task` as a default arg so the
            # done-callback captures THIS task by value — capturing the loop
            # variable by reference applied completions to whatever task the
            # processor had moved on to, leaving the real one stuck at 99%.
            future = self._executor.submit(self._execute_download, task)
            future.add_done_callback(
                lambda f, t=task: self._handle_download_complete(t, f)
            )

    def _execute_download(self, task: DownloadTask) -> DownloadResult:
        """Download the track, trying its sources in quality order so a dead/DRM
        primary (e.g. a SoundCloud copy) falls back to a working one (e.g.
        YouTube) — mirrors the player's cross-source fallback (§23). The track's
        sources ride along in task.track_info; task.url is tried first.
        ponytail: sequential, no pre-probe — a source is only known dead after
        its client raises; acceptable since downloads aren't latency-critical."""
        last_error = "No downloadable source"
        for url in self._download_candidates(task):
            try:
                result = self._download_from_url(url, task)
            except Exception as e:
                # A client (e.g. SoundCloud on a DRM track) raises instead of
                # returning a failed result — treat it as a dead source and fall
                # through to the next one.
                last_error = str(e)
                continue
            if result.success:
                return result
            last_error = result.error or last_error
        return DownloadResult(success=False, error=last_error)

    def _download_candidates(self, task: DownloadTask) -> List[str]:
        """Ordered, de-duped download URLs: task.url first, then any other
        sources carried on track_info in quality order (matches the frontend's
        getPlayableSources)."""
        urls: List[str] = []
        if task.url:
            urls.append(task.url)
        sources = task.track_info.get("sources") if isinstance(task.track_info, dict) else None
        if isinstance(sources, dict):
            for key in ("jiosaavn", "soundcloud", "youtube_music", "youtube"):
                entry = sources.get(key)
                url = entry.get("url") if isinstance(entry, dict) else None
                if url and url not in urls:
                    urls.append(url)
        return urls

    def _download_from_url(self, url: str, task: DownloadTask) -> DownloadResult:
        """Execute a single-URL download using the client matching the URL."""
        # Progress hook → update the task so the frontend's polling shows a
        # moving bar (capped at 99% mid-download; 100% is set on completion).
        def _progress(downloaded: int, total: int):
            task.downloaded_bytes = downloaded or 0
            task.total_bytes = total or 0
            if total and total > 0:
                task.progress = min(99.0, downloaded / total * 100.0)
            self._emit_progress(task)

        if "jiosaavn.com" in url:
            from components.jiosaavn_downloader import JioSaavnClient

            client = JioSaavnClient()
            # JioSaavn expects full path with .m4a extension
            jiosaavn_output = f"{task.output_path}.m4a"
            return client.download_track(url, jiosaavn_output, task.max_bitrate, _progress)
        elif "soundcloud.com" in url:
            from components.soundcloud_downloader import SoundCloudClient

            client = SoundCloudClient()
            return client.download_track(url, task.output_path, task.max_bitrate, _progress)
        elif "youtube.com" in url or "youtu.be" in url or "music.youtube.com" in url:
            from components.youtube_downloader import YouTubeClient

            # Use the user's connected YouTube account (if any) so downloading a
            # bot-gated/age-restricted video works the same as streaming it.
            yt_kwargs = self._yt_cookie_provider() if self._yt_cookie_provider else {}
            client = YouTubeClient(**yt_kwargs)
            return client.download_track(url, task.output_path, task.max_bitrate, _progress)
        else:
            return DownloadResult(
                success=False, error=f"Unsupported source: {url}"
            )

    def _extract_cover_url(self, track_info: Dict[str, Any]) -> Optional[str]:
        """Pick the best available cover-art URL from a track_info dict.
        Handles the various shapes the frontend / merger may send."""
        if not isinstance(track_info, dict):
            return None

        # 1. Direct best-artwork field (set by frontend normalizeTrack)
        direct = track_info.get("artwork_url") or track_info.get("best_artwork")
        if isinstance(direct, str) and direct.startswith("http"):
            return direct

        # 2. artwork_urls dict — prefer highest resolution
        artwork_urls = track_info.get("artwork_urls") or track_info.get("artworkUrls")
        if isinstance(artwork_urls, dict) and artwork_urls:
            preferred = [
                "1200", "1000", "600", "500", "xl", "300", "large",
                "enriched", "source:jiosaavn", "source:youtube",
                "source:soundcloud", "100", "medium", "small",
            ]
            for key in preferred:
                url = artwork_urls.get(key)
                if isinstance(url, str) and url.startswith("http"):
                    return url
            for url in artwork_urls.values():
                if isinstance(url, str) and url.startswith("http"):
                    return url

        # 3. Other common single-field names
        for key in ("image_url", "thumbnail", "cover", "artwork_600", "artwork_300"):
            url = track_info.get(key)
            if isinstance(url, str) and url.startswith("http"):
                return url

        return None

    def _handle_download_complete(self, task: DownloadTask, future: Future):
        """Handle download completion."""
        try:
            result = future.result()
        except Exception as e:
            result = DownloadResult(success=False, error=str(e))

        if result.success:
            # Flip to COMPLETED under the lock (fast field writes only) so the
            # /api/downloads status endpoint and other workers see it instantly.
            with self._lock:
                task.status = DownloadStatus.COMPLETED
                task.completed_at = time.time()
                task.file_path = result.file_path
                task.file_size = result.file_size
                task.bitrate = result.bitrate
                task.codec = result.codec
                task.progress = 100.0

            # Embed metadata OUTSIDE the lock — the finalizer (iTunes enrichment)
            # and cover-art fetch are network-bound and slow, especially for a
            # bulk download-all. Holding the lock here blocked the status endpoint
            # and stalled the UI at 99% even though files had finished.
            if task.file_path and self._metadata_embedder:
                try:
                    info = task.track_info
                    if self._finalizer:
                        try:
                            info = self._finalizer(info) or task.track_info
                        except Exception:
                            info = task.track_info
                    task.track_info = info
                    cover_url = self._extract_cover_url(info)
                    self._metadata_embedder.embed_metadata(
                        task.file_path, info, cover_url
                    )
                except Exception as e:
                    print(f"Metadata embedding failed: {e}")

            self._emit_complete(task)
            self._emit_progress(task)
            return

        # Failure path. Decide retry-vs-fail under the lock, but never sleep or
        # emit while holding it.
        with self._lock:
            task.error = result.error
            task.progress = 0.0
            should_retry = task.retries < self.config.max_retries
            if should_retry:
                task.retries += 1
                delay = min(
                    self.config.max_retry_delay,
                    self.config.retry_delay * (self.config.retry_backoff ** task.retries),
                )
            else:
                task.status = DownloadStatus.FAILED

        if should_retry:
            time.sleep(delay)
            with self._lock:
                task.status = DownloadStatus.PENDING
                self._queue.put(task.id)
            return

        self._emit_error(task, result.error)
        self._emit_progress(task)

    # ==================== STATUS & STATS ====================

    def get_stats(self) -> Dict[str, Any]:
        """Get queue statistics."""
        with self._lock:
            total = len(self._tasks)
            by_status = {}
            for status in DownloadStatus:
                by_status[status.value] = sum(
                    1 for t in self._tasks.values() if t.status == status
                )

            active = sum(
                1
                for t in self._tasks.values()
                if t.status == DownloadStatus.DOWNLOADING
            )
            total_downloaded = sum(
                t.file_size
                for t in self._tasks.values()
                if t.status == DownloadStatus.COMPLETED
            )

            return {
                "total": total,
                "by_status": by_status,
                "active": active,
                "max_concurrent": self.config.max_concurrent,
                "total_downloaded_bytes": total_downloaded,
                "total_downloaded_mb": round(total_downloaded / 1024 / 1024, 2),
            }

    def get_queue_state(self) -> Dict[str, Any]:
        """Get serialized queue state for persistence."""
        with self._lock:
            return {
                "tasks": {tid: task.to_dict() for tid, task in self._tasks.items()},
                "config": asdict(self.config),
            }

    def load_queue_state(self, state: Dict[str, Any]):
        """Load queue state from persistence."""
        with self._lock:
            self.config = DownloadQueueConfig(**state.get("config", {}))
            for tid, task_data in state.get("tasks", {}).items():
                # Convert string status back to DownloadStatus enum
                if "status" in task_data and isinstance(task_data["status"], str):
                    try:
                        task_data["status"] = DownloadStatus(task_data["status"])
                    except ValueError:
                        task_data["status"] = DownloadStatus.FAILED
                task = DownloadTask(**task_data)
                # Reset running tasks to pending
                if task.status in (DownloadStatus.DOWNLOADING, DownloadStatus.QUEUED):
                    task.status = DownloadStatus.PENDING
                self._tasks[tid] = task
                if task.status == DownloadStatus.PENDING:
                    self._queue.put(tid)


# ==================== METADATA EMBEDDER ====================


class MetadataEmbedder:
    """Embed metadata and cover art into audio files using mutagen."""

    def __init__(self):
        if not MUTAGEN_AVAILABLE:
            raise RuntimeError("mutagen not installed. pip install mutagen")

    def embed_metadata(
        self,
        file_path: str,
        track_info: Dict[str, Any],
        cover_art_url: Optional[str] = None,
    ) -> bool:
        """
        Embed metadata into audio file.

        Args:
            file_path: Path to audio file
            track_info: Track metadata dict
            cover_art_url: Optional cover art URL to download and embed

        Returns:
            True if successful
        """
        try:
            ext = Path(file_path).suffix.lower()

            if ext == ".mp3":
                return self._embed_mp3(file_path, track_info, cover_art_url)
            elif ext == ".flac":
                return self._embed_flac(file_path, track_info, cover_art_url)
            elif ext in [".m4a", ".mp4"]:
                return self._embed_m4a(file_path, track_info, cover_art_url)
            elif ext == ".opus":
                return self._embed_opus(file_path, track_info, cover_art_url)
            else:
                return False
        except Exception as e:
            print(f"Metadata embedding failed: {e}")
            return False

    def _embed_mp3(
        self, file_path: str, info: Dict, cover_url: Optional[str] = None
    ) -> bool:
        """Embed ID3v2.4 tags into MP3."""
        audio = MP3(file_path, ID3=ID3)

        # Ensure ID3 tags exist
        if audio.tags is None:
            audio.add_tags()

        tags = audio.tags

        # Clear existing tags we're going to set
        for frame_id in [
            "TIT2",
            "TPE1",
            "TALB",
            "TDRC",
            "TCON",
            "TRCK",
            "TPOS",
            "TYER",
            "TPE2",
            "TCOM",
            "WXXX",
            "COMM",
            "TXXX",
            "APIC",
            "USLT",
        ]:
            for frame in tags.getall(frame_id):
                tags.delall(frame_id)

        # Set standard tags
        if info.get("title"):
            tags.add(TIT2(encoding=3, text=info["title"]))
        if info.get("artist"):
            tags.add(TPE1(encoding=3, text=info["artist"]))
        if info.get("album"):
            tags.add(TALB(encoding=3, text=info["album"]))
        if info.get("release_date"):
            tags.add(TDRC(encoding=3, text=info["release_date"][:4]))
        if info.get("genre"):
            tags.add(TCON(encoding=3, text=info["genre"]))
        if info.get("track_number"):
            tags.add(TRCK(encoding=3, text=str(info["track_number"])))
        if info.get("disc_number"):
            tags.add(TPOS(encoding=3, text=str(info["disc_number"])))
        if info.get("year"):
            tags.add(TYER(encoding=3, text=str(info["year"])))
        if (
            info.get("artist")
            and info.get("album_artist")
            and info["album_artist"] != info["artist"]
        ):
            tags.add(TPE2(encoding=3, text=info["album_artist"]))
        if info.get("composer"):
            tags.add(TCOM(encoding=3, text=info["composer"]))

        # Add lyrics if available
        if info.get("lyrics"):
            tags.add(USLT(encoding=3, lang="eng", desc="", text=info["lyrics"]))

        # Add cover art
        if cover_url:
            try:
                import requests

                resp = requests.get(cover_url, timeout=10)
                if resp.status_code == 200:
                    mime = "image/jpeg"
                    if cover_url.lower().endswith(".png"):
                        mime = "image/png"
                    tags.add(
                        APIC(
                            encoding=3,
                            mime=mime,
                            type=3,
                            desc="Cover",
                            data=resp.content,
                        )
                    )
            except Exception:
                pass  # Cover art is optional

        audio.save(v2_version=3)
        return True

    def _embed_flac(
        self, file_path: str, info: Dict, cover_url: Optional[str] = None
    ) -> bool:
        """Embed Vorbis comments into FLAC."""
        audio = FLAC(file_path)

        tags = {
            "TITLE": info.get("title"),
            "ARTIST": info.get("artist"),
            "ALBUM": info.get("album"),
            "DATE": info.get("release_date"),
            "GENRE": info.get("genre"),
            "TRACKNUMBER": str(info.get("track_number", "")),
            "DISCNUMBER": str(info.get("disc_number", "")),
            "COMPOSER": info.get("composer"),
            "ALBUMARTIST": info.get("album_artist"),
        }

        for key, value in tags.items():
            if value:
                audio[key] = value

        # Lyrics
        if info.get("lyrics"):
            audio["LYRICS"] = info["lyrics"]

        # Cover art
        if cover_url:
            try:
                import requests

                resp = requests.get(cover_url, timeout=10)
                if resp.status_code == 200:
                    from mutagen.flac import Picture

                    pic = Picture()
                    pic.type = 3  # Front cover
                    pic.mime = (
                        "image/jpeg"
                        if not cover_url.lower().endswith(".png")
                        else "image/png"
                    )
                    pic.desc = "Cover"
                    pic.data = resp.content
                    audio.add_picture(pic)
            except Exception:
                pass

        audio.save()
        return True

    def _embed_m4a(
        self, file_path: str, info: Dict, cover_url: Optional[str] = None
    ) -> bool:
        """Embed metadata into M4A/MP4."""
        audio = MP4(file_path)

        # iTunes-style tags
        if info.get("title"):
            audio["\xa9nam"] = info["title"]
        if info.get("artist"):
            audio["\xa9ART"] = info["artist"]
        if info.get("album"):
            audio["\xa9alb"] = info["album"]
        if info.get("release_date"):
            audio["\xa9day"] = info["release_date"][:4]
        if info.get("genre"):
            audio["\xa9gen"] = info["genre"]
        if info.get("track_number"):
            audio["trkn"] = [(info["track_number"], 0)]
        if info.get("disc_number"):
            audio["disk"] = [(info["disc_number"], 0)]
        if info.get("composer"):
            audio["\xa9wrt"] = info["composer"]
        if info.get("album_artist"):
            audio["aART"] = info["album_artist"]

        # Cover art
        if cover_url:
            try:
                import requests

                resp = requests.get(cover_url, timeout=10)
                if resp.status_code == 200:
                    mime = (
                        "image/jpeg"
                        if not cover_url.lower().endswith(".png")
                        else "image/png"
                    )
                    cover = MP4Cover(
                        resp.content,
                        imageformat=MP4Cover.FORMAT_JPEG
                        if mime == "image/jpeg"
                        else MP4Cover.FORMAT_PNG,
                    )
                    audio["covr"] = [cover]
            except Exception:
                pass

        audio.save()
        return True

    def _embed_opus(
        self, file_path: str, info: Dict, cover_url: Optional[str] = None
    ) -> bool:
        """Embed metadata into Opus/OGG using Vorbis comments."""
        audio = mutagen.File(file_path)
        if audio is None:
            return False

        tags = {
            "TITLE": info.get("title"),
            "ARTIST": info.get("artist"),
            "ALBUM": info.get("album"),
            "DATE": info.get("release_date", "")[:4]
            if info.get("release_date")
            else None,
            "GENRE": info.get("genre"),
            "TRACKNUMBER": str(info.get("track_number", "")),
            "DISCNUMBER": str(info.get("disc_number", "")),
            "COMPOSER": info.get("composer"),
            "ALBUMARTIST": info.get("album_artist"),
        }

        for key, value in tags.items():
            if value:
                audio[key] = value

        # Cover art - Opus uses METADATA_BLOCK_PICTURE (base64 encoded)
        if cover_url:
            try:
                import requests
                import base64
                import struct

                resp = requests.get(cover_url, timeout=10)
                if resp.status_code == 200:
                    pic_data = resp.content
                    mime = (
                        b"image/jpeg"
                        if not cover_url.lower().endswith(".png")
                        else b"image/png"
                    )
                    # Build METADATA_BLOCK_PICTURE
                    pic = bytearray()
                    pic.extend(struct.pack(">I", 3))  # Picture type: 3 = front cover
                    pic.extend(struct.pack(">I", len(mime)))
                    pic.extend(mime)
                    pic.extend(struct.pack(">I", 0))  # description length
                    pic.extend(struct.pack(">I", 0))  # width
                    pic.extend(struct.pack(">I", 0))  # height
                    pic.extend(struct.pack(">I", 0))  # color depth
                    pic.extend(struct.pack(">I", 0))  # colors
                    pic.extend(struct.pack(">I", len(pic_data)))
                    pic.extend(pic_data)

                    import base64

                    audio["METADATA_BLOCK_PICTURE"] = [
                        base64.b64encode(pic).decode("ascii")
                    ]
            except Exception:
                pass

        audio.save()
        return True


# ==================== CONVENIENCE FUNCTIONS ====================


def quick_download(
    url: str,
    track_info: Dict[str, Any],
    output_dir: str = ".",
    max_bitrate: int = 256,
    progress_callback: Optional[Callable[[DownloadTask], None]] = None,
) -> DownloadResult:
    """One-liner for quick single downloads."""
    # Use reasonable retries - YouTubeClient has its own fallback strategies
    # but DownloadManager retries are needed for network errors between strategies
    manager = DownloadManager(
        config=DownloadQueueConfig(max_retries=3), download_dir=output_dir
    )

    # Generate proper output path from track_info
    import re

    safe_title = re.sub(r'[<>:"/\\|?*]', "_", track_info.get("title", "unknown"))
    safe_artist = re.sub(r'[<>:"/\\|?*]', "_", track_info.get("artist", "unknown"))
    output_path = str(Path(output_dir) / f"{safe_title} - {safe_artist}")

    task_id = manager.add_download(url, track_info, output_path, max_bitrate)

    if progress_callback:
        manager.on_progress(progress_callback)

    manager.start()

    # Wait for completion with timeout (5 minutes max)
    task = None
    timeout_seconds = 300
    elapsed = 0.0
    poll_interval = 0.5
    while elapsed < timeout_seconds:
        task = manager.get_task(task_id)
        if task and task.status in (
            DownloadStatus.COMPLETED,
            DownloadStatus.FAILED,
            DownloadStatus.CANCELLED,
        ):
            break
        time.sleep(poll_interval)
        elapsed += poll_interval
    else:
        # Timeout reached — cancel the task
        manager.cancel_download(task_id)
        task = manager.get_task(task_id)

    manager.stop()

    return DownloadResult(
        success=task.status == DownloadStatus.COMPLETED,
        file_path=task.file_path,
        file_size=task.file_size,
        bitrate=task.bitrate,
        codec=task.codec,
        error=task.error,
    )


def batch_download(
    tracks: List[Dict[str, Any]],
    output_dir: str = ".",
    max_bitrate: int = 256,
    max_concurrent: int = 3,
    progress_callback: Optional[Callable[[DownloadTask], None]] = None,
) -> List[DownloadResult]:
    """Batch download multiple tracks."""
    manager = DownloadManager(
        config=DownloadQueueConfig(max_concurrent=max_concurrent),
        download_dir=output_dir,
    )

    manager.add_batch_downloads(tracks, output_dir, max_bitrate)

    if progress_callback:
        manager.on_progress(progress_callback)

    manager.start()

    # Wait for all to complete with timeout (10 minutes max)
    timeout_seconds = 600
    elapsed = 0.0
    poll_interval = 0.5
    all_tasks = []
    while elapsed < timeout_seconds:
        all_tasks = manager.get_all_tasks()
        if all_tasks and all(
            t.status
            in (
                DownloadStatus.COMPLETED,
                DownloadStatus.FAILED,
                DownloadStatus.CANCELLED,
            )
            for t in all_tasks
        ):
            break
        time.sleep(poll_interval)
        elapsed += poll_interval
    else:
        # Timeout — get final state
        all_tasks = manager.get_all_tasks()

    manager.stop()

    return [
        DownloadResult(
            success=t.status == DownloadStatus.COMPLETED,
            file_path=t.file_path,
            file_size=t.file_size,
            bitrate=t.bitrate,
            codec=t.codec,
            error=t.error,
        )
        for t in all_tasks
    ]


# ==================== CLI ====================

if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("Usage:")
        print('  python download_manager.py "url" "title" "artist" [output_dir]')
        print("  python download_manager.py batch <tracks.json> [output_dir]")
        sys.exit(1)

    if sys.argv[1] == "batch":
        # Batch mode from JSON file
        import json

        json_file = sys.argv[2]
        output_dir = sys.argv[3] if len(sys.argv) > 3 else "."

        with open(json_file) as f:
            tracks = json.load(f)

        def progress(task):
            if task.total_bytes > 0:
                print(
                    f"\r  {task.track_info.get('title', 'Unknown'):.40s} {task.progress:.1f}%",
                    end="",
                )

        results = batch_download(
            tracks,
            output_dir=output_dir,
            max_bitrate=256,
            progress_callback=progress,
        )

        print()
        for r in results:
            status = "✓" if r.success else "✗"
            print(f"  {status} {r.file_path or r.error}")

    else:
        # Single download
        url = sys.argv[1]
        title = sys.argv[2]
        artist = sys.argv[3] if len(sys.argv) > 3 else "Unknown"
        output_dir = sys.argv[4] if len(sys.argv) > 4 else "."

        track_info = {
            "title": title,
            "artist": artist,
        }

        def progress(task):
            if task.total_bytes > 0:
                pct = (task.downloaded_bytes / task.total_bytes) * 100
                sys.stdout.write(
                    f"\r  {pct:.1f}% ({task.downloaded_bytes:,}/{task.total_bytes:,} bytes)"
                )
                sys.stdout.flush()

        result = quick_download(
            url,
            {"title": title, "artist": artist},
            output_dir,
            progress_callback=progress,
        )
        print()

        if result.success:
            print("✓ Success!")
            print(f"  File: {result.file_path}")
            print(f"  Size: {result.file_size:,} bytes")
            if result.bitrate:
                print(f"  Bitrate: {result.bitrate // 1000} kbps")
            if result.codec:
                print(f"  Codec: {result.codec}")
        else:
            print(f"✗ Failed: {result.error}")


# ==================== OFFLINE LIBRARY SCAN ====================

# Audio extensions we recognise as downloaded tracks.
_SCAN_AUDIO_EXTS = {".mp3", ".flac", ".m4a", ".mp4", ".opus", ".ogg", ".wav"}


def scan_downloads(directory: str) -> List[Dict[str, Any]]:
    """Scan a folder (recursively) for downloaded audio files and read their
    embedded tags. The DISK is the source of truth for the offline library — it
    survives a cleared localStorage, a reinstall, or a backend restart, unlike
    the in-memory task list / the frontend registry.

    Reuses mutagen (already a dependency, used to WRITE these same tags on
    download). Falls back to the "Title - Artist" download filename when a file
    has no tags. Cover art is intentionally not returned (would be heavy per
    file); the matched catalog track supplies artwork.
    ponytail: tag read only, no audio hashing/dedupe — fast startup scan.
    """
    out: List[Dict[str, Any]] = []
    base = Path(directory).expanduser()
    if not base.is_dir():
        return out

    for p in sorted(base.rglob("*")):
        if not p.is_file() or p.suffix.lower() not in _SCAN_AUDIO_EXTS:
            continue

        title = artist = album = ""
        duration_ms = 0
        bitrate = 0

        # Read tags for album/duration/bitrate (and as a title/artist fallback).
        if MUTAGEN_AVAILABLE:
            try:
                audio = mutagen.File(str(p), easy=True)
            except Exception:
                audio = None
            if audio is not None:
                def _first(key):
                    v = audio.get(key)
                    if isinstance(v, list):
                        return v[0] if v else ""
                    return v or ""
                album = _first("album")
                tag_title = _first("title")
                tag_artist = _first("artist")
                info = getattr(audio, "info", None)
                if info is not None:
                    if getattr(info, "length", None):
                        duration_ms = int(info.length * 1000)
                    if getattr(info, "bitrate", None):
                        bitrate = int(info.bitrate / 1000)
            else:
                tag_title = tag_artist = ""
        else:
            tag_title = tag_artist = ""

        # PREFER the download filename ("{title} - {artist}") for title/artist:
        # it's the ORIGINAL requested catalog metadata — exactly what played
        # tracks are matched against — and it's immune to a mis-embedded tag (an
        # earlier completion bug embedded some files with the wrong track's
        # metadata; the filename was always correct). Tags fill the gap only when
        # the name has no " - " separator.
        stem = p.stem
        if " - " in stem:
            f_title, f_artist = stem.split(" - ", 1)
            title, artist = f_title.strip(), f_artist.strip()
        else:
            title, artist = (tag_title or stem), tag_artist

        try:
            size = p.stat().st_size
        except Exception:
            size = 0

        out.append({
            "title": title,
            "artist": artist,
            "album": album,
            "duration_ms": duration_ms,
            "bitrate": bitrate,
            "codec": p.suffix.lower().lstrip("."),
            "file_size": size,
            "file_path": str(p),
        })

    return out
