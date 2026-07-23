"""
Fix_Spotify — on-device backend (Android / Chaquopy)
====================================================
A Flask port of api/main.py that runs INSIDE the APK.

Why Flask and not FastAPI
-------------------------
FastAPI depends on pydantic v2, whose `pydantic-core` is a compiled Rust
extension with no Android wheel. Flask + Werkzeug are pure Python, so Chaquopy
installs them straight from PyPI. Every route below keeps the EXACT request and
response shape of api/main.py, so frontend/src/api.js works unmodified.

Why the phone and not a server
------------------------------
JioSaavn geo-gates to India and YouTube bot-blocks datacenter IPs. Running the
backend on the handset means every outbound request carries the user's own
carrier/residential IP — the same IP the desktop app used. No proxies, no
hosting, no blocking.

Same-origin by design
---------------------
This server ALSO serves the React SPA. The WebView loads http://127.0.0.1:8765/,
so the app and the API share an origin: `apiUrl()` stays relative, CORS is moot,
and <audio src="/api/proxy_stream?..."> streams and seeks natively.

What is NOT here (vs. the desktop backend)
------------------------------------------
* YouTube    — needs Deno to solve the JS n-signature challenge; there is no
               Deno for Android. Disabled at the client factory (see below), so
               no YouTube result can ever reach the UI as an unplayable track.
* ffprobe    — /api/stream_info reported the true bitrate by shelling out to
               ffprobe. No ffmpeg on Android, so we report the bitrate the
               source advertises instead of probing the bytes.
"""

import hmac
import io
import json
import os
import re
import sys
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, is_dataclass, replace
from html import unescape
from pathlib import Path
from typing import Any, Dict, List, Optional

import android_env

import requests as http_requests
from requests.adapters import HTTPAdapter
from flask import Flask, Response, jsonify, request, send_file, send_from_directory
from werkzeug.serving import make_server

# On Android, Gradle's `syncPythonSources` task copies components/ next to this
# file, so it is importable straight off Chaquopy's sys.path.
#
# On a desktop test run (`python mobile_server.py`) it is not — the real
# components/ lives two directories up. Add the repo root BEFORE the imports
# below, not in __main__, which would run far too late.
if not (Path(__file__).parent / "components").is_dir():
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from components.unified_search import UnifiedSearchService
from components.source_merger import SourceType
from components.download_manager import DownloadManager, DownloadQueueConfig
from components.metadata_enricher import MetadataEnricher


# ──────────────────────────────────────────────────────────────────────────────
# YouTube kill-switch
# ──────────────────────────────────────────────────────────────────────────────
# components/ is vendored verbatim, and two places still ask for a YouTube
# client: unified_search's default `enabled_sources`, and profile.py's
# _fallback_search_service(), which hardcodes SourceType.YOUTUBE into a set
# literal we cannot override with config.
#
# Rather than fork those files, we neuter the one funnel they both go through.
# UnifiedSearchService._search_source() bails out with [] when _get_client()
# returns None, so refusing to build a YouTube client disables YouTube
# EVERYWHERE — search, radio, artist pages, album fallbacks — with one hook and
# zero edits to components/.
_DISABLED_SOURCES = {SourceType.YOUTUBE, SourceType.YOUTUBE_MUSIC}
_original_get_client = UnifiedSearchService._get_client

# YouTube via NewPipeExtractor (newpipe_yt). Off unless the user enables it in
# Settings AND an on-device self-test resolves a real stream. While False the
# kill-switch below is fully active and behaviour is identical to a build that
# never had this code — the default JioSaavn/SoundCloud path is untouched.
_youtube_enabled = False


def _yt_cookies_path() -> str:
    """Where the user-imported YouTube cookies.txt lives (app-private)."""
    return os.path.join(android_env.files_dir(), "youtube_cookies.txt")


def _drop_yt_client():
    """Forget the cached YouTube client so the next use picks up new cookies."""
    if _search_service is not None:
        for st in _DISABLED_SOURCES:
            _search_service._clients.pop(st, None)


class _NewPipeYouTubeClient:
    """Drop-in for YouTubeClient, backed by NewPipeExtractor instead of yt-dlp.

    unified_search only ever calls `.search(query, limit)` and reads `.to_dict()`
    off each hit, so duck-typing YouTubeTrack's shape is the whole contract — no
    change to components/unified_search.py.
    """

    def search(self, query: str, limit: int = 10):
        import newpipe_yt
        from components.youtube_downloader import YouTubeTrack

        out = []
        for r in newpipe_yt.search(query, limit):
            url = r.get("url") or ""
            if not url:
                continue
            out.append(
                YouTubeTrack(
                    # The watch URL is the id we resolve a stream from later.
                    id=url.rsplit("v=", 1)[-1],
                    title=r.get("title") or "",
                    artist=r.get("artist") or "",
                    uploader=r.get("artist") or "",
                    url=url,
                    duration_ms=int(r.get("duration_ms") or 0) or None,
                    thumbnail=r.get("artwork") or None,
                    is_music=True,
                )
            )
        return out


def _get_client_no_youtube(self, source_type):
    if source_type in _DISABLED_SOURCES:
        if not _youtube_enabled:
            return None
        with self._clients_lock:
            if source_type not in self._clients:
                self._clients[source_type] = _NewPipeYouTubeClient()
            return self._clients[source_type]
    return _original_get_client(self, source_type)


UnifiedSearchService._get_client = _get_client_no_youtube


# ──────────────────────────────────────────────────────────────────────────────
# YouTube downloads
# ──────────────────────────────────────────────────────────────────────────────
# DownloadManager sends every youtube.com URL to YouTubeClient, i.e. yt-dlp —
# which cannot extract YouTube on Android for the same reason searching couldn't:
# no JS runtime to solve the signature challenge. So "download" on a YouTube track
# just failed, even with the source enabled and playing fine.
#
# It plays because NewPipe hands us a direct, already-deobfuscated audio URL. That
# URL is an ordinary HTTP file — so downloading is a plain streamed GET. No yt-dlp,
# no ffmpeg (there is none on Android): we keep the container YouTube served, and
# the manager's existing tagging step embeds the metadata afterwards exactly as it
# does for JioSaavn.
_original_download_from_url = DownloadManager._download_from_url


def _is_youtube_url(url: str) -> bool:
    return any(d in url for d in ("youtube.com", "youtu.be", "music.youtube.com"))


def _download_from_url_android(self, url: str, task):
    if not _is_youtube_url(url):
        return _original_download_from_url(self, url, task)

    from components.download_manager import DownloadResult
    import newpipe_yt

    info = newpipe_yt.stream_url(url)
    if not info or not info.get("url"):
        return DownloadResult(success=False, error="Could not resolve a YouTube audio stream")

    # Opus in a .webm container is what YouTube serves for its best audio-only
    # track; m4a otherwise. Keeping the served container is what lets us skip
    # transcoding — and the tagger reads both.
    codec = (info.get("codec") or "").lower()
    ext = "webm" if "opus" in codec or "webm" in codec else "m4a"
    out_path = f"{task.output_path}.{ext}"

    try:
        with http_requests.get(info["url"], stream=True, timeout=60) as r:
            r.raise_for_status()
            total = int(r.headers.get("Content-Length") or 0)
            done = 0
            with open(out_path, "wb") as f:
                for chunk in r.iter_content(chunk_size=64 * 1024):
                    if not chunk:
                        continue
                    f.write(chunk)
                    done += len(chunk)
                    task.downloaded_bytes = done
                    task.total_bytes = total
                    if total:
                        task.progress = min(99.0, done / total * 100.0)
                    self._emit_progress(task)
    except Exception as e:
        # A half-written file is worse than none: the library would list a track
        # that cannot play.
        try:
            os.remove(out_path)
        except OSError:
            pass
        return DownloadResult(success=False, error=f"YouTube download failed: {e}")

    return DownloadResult(
        success=True,
        file_path=out_path,
        file_size=os.path.getsize(out_path),
        bitrate=info.get("bitrate_kbps") or None,
        codec=info.get("codec") or None,
        source="youtube",
    )


DownloadManager._download_from_url = _download_from_url_android

# The sources a mobile search actually queries. iTunes/MusicBrainz are
# metadata-only (no stream URL) and would just slow the response down; clean
# metadata still arrives progressively through /api/enrich. YouTube is added
# only when the toggle turns it on (see /api/youtube/experimental).
PLAYABLE_SEARCH_SOURCES = {SourceType.JIOSAAVN, SourceType.SOUNDCLOUD}

# The same set, as the strings a track's `sources` dict is keyed by.
# _playable_source_name() gates on THIS one: a track whose only source isn't in
# here is treated as unplayable and dropped from the results entirely.
PLAYABLE_SOURCES = {"jiosaavn", "soundcloud"}


def _set_youtube(enabled: bool) -> None:
    """Turn the YouTube source on/off across EVERY switch that gates it.

    There are three, and they must move together:
      _youtube_enabled       — whether _get_client() will build a YouTube client
      PLAYABLE_SEARCH_SOURCES — whether search asks YouTube at all
      PLAYABLE_SOURCES        — whether a YouTube hit survives _playable_source_name

    Flipping the first two but not the third is exactly what "YouTube is on but no
    song ever shows a YouTube badge" was: search queried YouTube, got results, and
    then dropped every YouTube-only track on the floor on the way out — because
    the string set still said only JioSaavn and SoundCloud could play. Three call
    sites each flipped their own subset by hand; now they all come through here.
    """
    global _youtube_enabled
    _youtube_enabled = enabled
    for st, name in ((SourceType.YOUTUBE, "youtube"), (SourceType.YOUTUBE_MUSIC, "youtube_music")):
        if enabled:
            PLAYABLE_SOURCES.add(name)
        else:
            PLAYABLE_SOURCES.discard(name)
    if enabled:
        PLAYABLE_SEARCH_SOURCES.add(SourceType.YOUTUBE)
    else:
        PLAYABLE_SEARCH_SOURCES.discard(SourceType.YOUTUBE)


# ──────────────────────────────────────────────────────────────────────────────
# Globals
# ──────────────────────────────────────────────────────────────────────────────
_search_service: Optional[UnifiedSearchService] = None
_download_manager: Optional[DownloadManager] = None
_enricher: Optional[MetadataEnricher] = None
_server = None

_lyrics_cache: Dict[str, Dict[str, Any]] = {}
_lyrics_cache_lock = threading.Lock()
_LYRICS_CACHE_MAX = 1000


def _build_lyrics_session() -> http_requests.Session:
    """Pooled session for lrclib. Mobile networks make a cold TLS handshake even
    more expensive than on desktop, so connection reuse matters more here."""
    s = http_requests.Session()
    try:
        from urllib3.util.retry import Retry
        retry = Retry(total=1, connect=1, read=0, status=0, backoff_factor=0.2,
                      allowed_methods=frozenset(["GET"]))
        adapter = HTTPAdapter(max_retries=retry, pool_connections=4, pool_maxsize=8)
        s.mount("https://", adapter)
        s.mount("http://", adapter)
    except Exception:
        pass
    return s


_lyrics_session = _build_lyrics_session()


def get_default_download_dir() -> str:
    """The user's custom folder if set, else Downloads/Fix_Spotify/music, else
    the app-private dir. See android_env.downloads_dir() for why."""
    return android_env.downloads_dir()


# ──────────────────────────────────────────────────────────────────────────────
# Helpers (ported verbatim from api/main.py)
# ──────────────────────────────────────────────────────────────────────────────
def _clean_text(value: Optional[str]) -> Optional[str]:
    """Decode API/entity noise before it reaches the UI."""
    if value is None:
        return None
    cleaned = unescape(str(value))
    replacements = {
        "Â·": "·",
        "â€™": "'",
        "â€œ": '"',
        "â€": '"',
        "â€“": "-",
        "â€”": "-",
    }
    for bad, good in replacements.items():
        cleaned = cleaned.replace(bad, good)
    cleaned = cleaned.replace("Â·", "·")
    return " ".join(cleaned.split())


def _finalize_track_info(info: Dict[str, Any]) -> Dict[str, Any]:
    """FINAL clean metadata embedded into every downloaded file, regardless of
    which screen triggered the download. JioSaavn metadata is authoritative for
    its own catalog, so for a JioSaavn track we gap-fill only; artwork/genre/
    date/isrc always overlay (pure gain)."""
    if not isinstance(info, dict):
        return info
    out = dict(info)
    src = info.get("sources") if isinstance(info.get("sources"), dict) else {}
    from_jiosaavn = bool((src.get("jiosaavn") or {}).get("url")) \
        or info.get("playable_source") == "jiosaavn" \
        or info.get("primary_source") == "jiosaavn"
    try:
        meta = _enricher._lookup(
            info.get("title") or "",
            info.get("artist") or "",
            info.get("isrc"),
            info.get("duration_ms"),
        ) if _enricher else None
    except Exception:
        meta = None

    if meta:
        if meta.get("artist") and not (from_jiosaavn and out.get("artist")):
            out["artist"] = _clean_text(meta["artist"])
        if meta.get("album") and not (from_jiosaavn and out.get("album")):
            out["album"] = _clean_text(meta["album"])
        if meta.get("release_date"):
            out["release_date"] = meta["release_date"]
        if meta.get("genre"):
            out["genre"] = meta["genre"]
        if meta.get("isrc") and not out.get("isrc"):
            out["isrc"] = meta["isrc"]
        art = meta.get("artwork") or {}
        cover = art.get("600") or art.get("300") or art.get("100")
        if cover:
            au = dict(out.get("artwork_urls") or {})
            au["600"] = cover
            out["artwork_urls"] = au
            out["artwork_url"] = cover
    return out


def _source_to_dict(source: Any) -> Dict[str, Any]:
    if hasattr(source, "to_dict"):
        return source.to_dict()
    if is_dataclass(source):
        return asdict(source)
    if isinstance(source, dict):
        return source
    return {}


def _playable_source_name(track: Any) -> Optional[str]:
    primary = getattr(track, "primary_source", None)
    if primary and getattr(primary, "value", primary) in PLAYABLE_SOURCES:
        primary_name = getattr(primary, "value", primary)
        primary_data = _source_to_dict(getattr(track, "sources", {}).get(primary))
        if primary_data.get("url"):
            return primary_name

    for source_key, source in getattr(track, "sources", {}).items():
        source_name = getattr(source_key, "value", source_key)
        source_data = _source_to_dict(source)
        if source_name in PLAYABLE_SOURCES and source_data.get("url"):
            return source_name
    return None


def _clean_artwork_urls(artwork_urls: Dict[str, Any]) -> Dict[str, str]:
    return {
        str(size): url
        for size, url in (artwork_urls or {}).items()
        if isinstance(url, str) and url
    }


# Resolved stream URLs, cached briefly.
#
# Starting one song resolves its stream URL at least TWICE within a second:
# /api/stream_info (the quality badge) and /api/proxy_stream (the audio itself),
# plus once more per step if the proxy walks the bitrate ladder. Each resolve is
# a real network round trip — a JioSaavn auth-token call, or a full yt-dlp /
# NewPipe extraction for SoundCloud / YouTube — so the duplicate is pure latency
# on every play. The resolved URL is deterministic for a given (source, url,
# bitrate), so we memoise it.
#
# TTL, not permanent: these are time-limited signed CDN URLs. 5 minutes is far
# inside their real lifetime (hours) yet short enough that a much-later replay
# re-resolves a fresh one. On an upstream 4xx the proxy evicts the entry so a
# retry never re-serves a URL that has actually gone stale.
_STREAM_CACHE: Dict[tuple, tuple] = {}   # (source, url, bitrate) -> (stream_url, expires_at)
_STREAM_TTL = 300.0


def _resolve_stream_url_cached(url: str, source: str, bitrate: int = 320) -> Optional[str]:
    key = (source, url, bitrate)
    now = time.monotonic()
    hit = _STREAM_CACHE.get(key)
    if hit and hit[1] > now:
        return hit[0]
    resolved = _resolve_stream_url(url, source, bitrate)
    if resolved:
        # ponytail: plain dict with a crude size cap, bounded mainly by the TTL.
        # A real LRU only if a single 5-min window ever resolves 256+ distinct
        # tracks, which no one listening to music does.
        if len(_STREAM_CACHE) > 256:
            _STREAM_CACHE.clear()
        _STREAM_CACHE[key] = (resolved, now + _STREAM_TTL)
    return resolved


def _evict_stream_url(url: str, source: str, bitrate: int) -> None:
    _STREAM_CACHE.pop((source, url, bitrate), None)


def _resolve_stream_url(url: str, source: str, bitrate: int = 320) -> Optional[str]:
    """Resolve a source page URL into a direct, playable stream URL."""
    if source in ("youtube", "youtube_music"):
        # NewPipeExtractor returns a URL with the signature and throttling
        # parameter already solved, so it plays directly. yt-dlp cannot do this
        # on Android (no JS runtime) — see mobile/python/newpipe_yt.py.
        import newpipe_yt

        info = newpipe_yt.stream_url(url)
        return info.get("url") if info else None
    if source == "jiosaavn":
        from components.jiosaavn_downloader import JioSaavnClient
        # JioSaavn serves discrete bitrates only: 320 / 160 / 96.
        js_bitrate = 320 if bitrate >= 320 else (160 if bitrate >= 160 else 96)
        return JioSaavnClient().get_streaming_url(url, js_bitrate)
    if source == "soundcloud":
        from components.soundcloud_downloader import SoundCloudClient
        return SoundCloudClient().get_streaming_url(url, bitrate)
    return None


def _parse_lrc(synced: str):
    """Parse an LRC synced-lyrics string into [{time, text}] sorted by time."""
    lines = []
    for raw in (synced or "").splitlines():
        stamps = re.findall(r"\[(\d+):(\d+(?:\.\d+)?)\]", raw)
        text = re.sub(r"\[\d+:\d+(?:\.\d+)?\]", "", raw).strip()
        for m, s in stamps:
            t = int(m) * 60 + float(s)
            lines.append({"time": round(t, 2), "text": text})
    lines.sort(key=lambda x: x["time"])
    return lines


def _arg(name: str, default: str = "") -> str:
    return (request.args.get(name) or default).strip()


def _int_arg(name: str, default: int = 0) -> int:
    try:
        return int(request.args.get(name, default))
    except (TypeError, ValueError):
        return default


def _body() -> Dict[str, Any]:
    return request.get_json(silent=True) or {}


# ──────────────────────────────────────────────────────────────────────────────
# App
# ──────────────────────────────────────────────────────────────────────────────
app = Flask(__name__, static_folder=None)

# Set by start_server() from Kotlin. Empty on a desktop test run, which disables
# the check below so `python mobile_server.py` still works.
_API_TOKEN = ""


@app.before_request
def _require_token():
    """Gate /api/* on the per-launch token.

    Loopback is NOT a security boundary on Android: every other app on the phone
    can reach 127.0.0.1:8765. Unguarded, any installed app could drive this
    server — enqueue downloads, read the local library, or (now that the app can
    hold All-files access) repoint downloads at an arbitrary path via
    /api/downloads/dir.

    Only /api/* is gated. The SPA's own HTML/JS/CSS stay open because they are
    just our static assets and carry no secret — in particular the token is NOT
    in them; it reaches the page over the Kotlin JS bridge instead.

    The token rides in the query string rather than a header because <audio
    src="/api/proxy_stream?..."> cannot set headers, and it must be authorised
    like everything else.
    """
    if not _API_TOKEN:
        return None                                  # desktop test run
    if not request.path.startswith("/api/"):
        return None                                  # SPA assets
    if request.method == "OPTIONS":
        return None                                  # CORS preflight

    supplied = request.args.get("_t") or request.headers.get("X-Fix-Token") or ""
    # compare_digest: constant-time, so a caller can't time-probe the token.
    if not hmac.compare_digest(supplied, _API_TOKEN):
        return jsonify({"error": "forbidden"}), 403
    return None


@app.after_request
def _cors(resp):
    # Same-origin in the WebView, so this is belt-and-braces — it also lets you
    # point a desktop browser at http://127.0.0.1:8765 over `adb forward` while
    # debugging the UI.
    resp.headers.setdefault("Access-Control-Allow-Origin", "*")
    resp.headers.setdefault("Access-Control-Allow-Headers", "*")
    resp.headers.setdefault("Access-Control-Allow-Methods", "*")
    return resp


@app.get("/health")
def health():
    return jsonify({"status": "healthy"})


@app.get("/api/connectivity")
def connectivity():
    """Distinguishes 'offline' from 'no results' for the UI's offline banner."""
    for url in ("https://www.google.com", "https://1.1.1.1"):
        try:
            http_requests.head(url, timeout=4, allow_redirects=False)
            return jsonify({"online": True})
        except Exception:
            continue
    return jsonify({"online": False})


# ─── Search ───────────────────────────────────────────────────────────────────
@app.post("/api/search")
def search_tracks():
    body = _body()
    query = (body.get("query") or "").strip()
    if not query:
        return jsonify({"results": [], "total": 0, "query": ""})
    limit = max(1, min(int(body.get("limit") or 20), 100))

    if _search_service is None:
        return jsonify({"error": "Search service not ready"}), 503

    try:
        # Per-request config copy — /api/search and /api/search/suggestions share
        # one service, and suggestions fire on every keystroke. replace() keeps
        # them from racing each other on the shared config object.
        req_config = replace(
            _search_service.config,
            max_total_results=limit,
            enabled_sources=PLAYABLE_SEARCH_SOURCES,
            timeout_seconds=12.0,
        )
        results = _search_service.search(query, req_config)

        out = []
        for track in results:
            playable_source = _playable_source_name(track)
            if not playable_source:
                continue
            out.append({
                "title": _clean_text(track.title) or "",
                "artist": _clean_text(track.artist) or "",
                "album": _clean_text(track.album),
                "duration_ms": track.duration_ms,
                "isrc": track.isrc,
                "sources": {k.value: _source_to_dict(v) for k, v in track.sources.items()},
                "primary_source": playable_source,
                "search_score": track.search_score,
                "artwork_url": track.get_best_artwork() if hasattr(track, "get_best_artwork") else None,
                "artwork_urls": _clean_artwork_urls(getattr(track, "artwork_urls", {})),
                "is_playable": True,
                "playable_source": playable_source,
            })

        return jsonify({"results": out, "total": len(out), "query": query})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.get("/api/search/suggestions")
def search_suggestions():
    q = _arg("q")
    limit = min(max(_int_arg("limit", 8), 1), 20)
    if len(q) < 2 or _search_service is None:
        return jsonify({"suggestions": []})

    try:
        # Suggestions must be CHEAP — they fire on every debounced keystroke.
        # JioSaavn only: it has the fastest autocomplete-grade index.
        req_config = replace(
            _search_service.config,
            max_total_results=limit,
            enabled_sources={SourceType.JIOSAAVN},
            max_results_per_source=limit,
            timeout_seconds=6.0,
        )
        results = _search_service.search(q, req_config)

        # While TYPING, what the user wants is almost always a completion of
        # what they've typed — so titles that start with the query outrank
        # titles that merely contain it, which outrank fuzzy-only hits.
        qn = q.lower().strip()
        results = sorted(results, key=lambda t: (
            0 if (t.title or "").lower().startswith(qn)
            else 1 if qn in (t.title or "").lower()
            else 2,
            len(t.title or ""),
        ))

        seen, suggestions = set(), []
        for track in results:
            key = f"{track.title.lower()}|{track.artist.lower()}"
            if key in seen:
                continue
            seen.add(key)
            suggestions.append({
                "title": track.title,
                "artist": track.artist,
                "album": track.album,
                "sources": [s.value for s in track.sources.keys()],
                "isrc": track.isrc,
            })
            if len(suggestions) >= limit:
                break
        return jsonify({"suggestions": suggestions})
    except Exception:
        return jsonify({"suggestions": []})


# ─── Streaming ────────────────────────────────────────────────────────────────
@app.post("/api/stream_url")
def get_stream_url():
    body = _body()
    url, source = body.get("url") or "", body.get("source") or ""
    try:
        stream_url = _resolve_stream_url(url, source, 320)
        if stream_url:
            return jsonify({"stream_url": stream_url})
        return jsonify({
            "stream_url": None,
            "error": f"Could not extract streaming URL for source: {source}",
        })
    except Exception as e:
        return jsonify({"stream_url": None, "error": str(e)}), 500


@app.get("/api/stream_info")
def stream_info():
    """Live quality readout for the player.

    The desktop build shelled out to ffprobe to read the true bitrate off the
    wire. Android has no ffmpeg, so we report what the source advertises. For
    JioSaavn that IS the real value (we request a specific bitrate and it serves
    that exact file); SoundCloud transcodes are ~128k MP3.
    """
    source = _arg("source")
    bitrate = _int_arg("bitrate", 320)
    try:
        # Cached: proxy_stream is about to resolve the very same URL a beat later.
        stream_url = _resolve_stream_url_cached(_arg("url"), source, bitrate)
        if not stream_url:
            return jsonify({"bitrate_kbps": None, "codec": None,
                            "error": "Could not resolve stream"})
        if source == "jiosaavn":
            served = 320 if bitrate >= 320 else (160 if bitrate >= 160 else 96)
            return jsonify({"bitrate_kbps": served, "codec": "aac"})
        if source == "soundcloud":
            codec = "mp3" if ".mp3" in stream_url or "mp3" in stream_url else "opus"
            return jsonify({"bitrate_kbps": 128, "codec": codec})
        return jsonify({"bitrate_kbps": None, "codec": None})
    except Exception as e:
        return jsonify({"bitrate_kbps": None, "codec": None, "error": str(e)})


@app.get("/api/proxy_stream")
def proxy_stream():
    """Stream audio through the local server so <audio> can play and SEEK it.

    Forwards the browser's Range header upstream and mirrors the 206 +
    Content-Range back, which is what makes the seek bar work.
    """
    url, source = _arg("url"), _arg("source")
    bitrate = _int_arg("bitrate", 320)

    # JioSaavn doesn't hold every track at every bitrate — a 320 file may 404
    # while 160/96 exist. Walk down from what was asked for.
    if source == "jiosaavn":
        ladder, seen = [], set()
        for b in (bitrate, 320, 160, 96):
            if b <= bitrate and b not in seen:
                seen.add(b)
                ladder.append(b)
        ladder = ladder or [bitrate]
    else:
        ladder = [bitrate]

    range_header = request.headers.get("Range", "bytes=0-")

    def resolve_and_fetch(br):
        s_url = _resolve_stream_url_cached(url, source, br)
        if not s_url:
            # Distinct from an upstream rejection: here the source had no full,
            # progressive stream to hand us (SoundCloud HLS/preview-only, or a
            # dead page). Logged so a 502 in the field is self-explaining.
            print(f"[proxy] {source} could not resolve a stream for {url} (br={br})")
            return None, None
        headers = {
            "User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36",
            "Accept": "*/*",
            "Range": range_header,
        }
        if source == "jiosaavn":
            headers["Referer"] = "https://www.jiosaavn.com/"
        # Split timeout: 6s to CONNECT, 30s to read. A dead/blocked host used to
        # hang the whole 30s on connect, freezing the player on a track that was
        # never going to play; now it fails in ~6s and the caller can move on.
        # The 30s read budget is untouched, so a slow-but-valid stream is fine.
        r = http_requests.get(s_url, headers=headers, stream=True, timeout=(6, 30))
        if r.status_code in (403, 404, 410, 500, 502, 503):
            code = r.status_code
            r.close()
            # A cached URL that upstream now rejects is stale — drop it so the
            # next attempt (next ladder step, or a replay) re-resolves fresh
            # instead of serving the same dead URL from cache.
            _evict_stream_url(url, source, br)
            print(f"[proxy] {source} upstream {code} for {url} (br={br})")
            return None, code
        return r, None

    upstream, last_status = None, None
    try:
        for br in ladder:
            upstream, last_status = resolve_and_fetch(br)
            if upstream is not None:
                break
    except Exception as e:
        return jsonify({"detail": str(e)}), 500

    if upstream is None:
        detail = (f"Stream unavailable (upstream status {last_status})"
                  if last_status else "Could not resolve streaming URL")
        return jsonify({"detail": detail}), 502

    resp_headers = {"Accept-Ranges": "bytes", "Cache-Control": "no-cache"}
    if upstream.status_code == 206:
        cr = upstream.headers.get("content-range")
        if cr:
            resp_headers["Content-Range"] = cr
    cl = upstream.headers.get("content-length")
    if cl:
        resp_headers["Content-Length"] = cl

    def stream_chunks():
        try:
            for chunk in upstream.iter_content(chunk_size=8192):
                if chunk:
                    yield chunk
        finally:
            upstream.close()

    return Response(
        stream_chunks(),
        status=upstream.status_code,  # 200 or 206
        mimetype=upstream.headers.get("content-type", "audio/mp4"),
        headers=resp_headers,
        direct_passthrough=True,
    )


# ─── Downloads ────────────────────────────────────────────────────────────────
@app.post("/api/download")
def download_track():
    if not _download_manager:
        return jsonify({"detail": "Download manager not initialized"}), 500
    body = _body()
    url = (body.get("url") or "").strip()
    if not url:
        return jsonify({"detail": "URL must not be empty"}), 400

    track_info = body.get("track_info") or {}
    max_bitrate = max(64, min(int(body.get("max_bitrate") or 256), 320))

    # Android has no user-chosen output folder (scoped storage), so `output_dir`
    # from the frontend is ignored and everything lands in the app's Music dir.
    out_dir_path = Path(get_default_download_dir())
    try:
        out_dir_path.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass

    safe_title = re.sub(r'[<>:"/\\|?*]', "_", track_info.get("title", "unknown")).strip() or "unknown"
    safe_artist = re.sub(r'[<>:"/\\|?*]', "_", track_info.get("artist", "unknown")).strip() or "unknown"
    output_path = str(out_dir_path / f"{safe_title} - {safe_artist}")

    try:
        task_id = _download_manager.add_download(
            url=url,
            track_info=track_info,
            output_path=output_path,
            max_bitrate=max_bitrate,
        )
        return jsonify({"task_id": task_id, "status": "queued",
                        "message": "Download started in background"})
    except Exception as e:
        return jsonify({"detail": str(e)}), 500


@app.get("/api/download/<task_id>")
def get_download_status(task_id):
    if not _download_manager:
        return jsonify({"detail": "Download manager not initialized"}), 500
    task = _download_manager.get_task(task_id)
    if not task:
        return jsonify({"detail": "Task not found"}), 404
    return jsonify({
        "task_id": task.id,
        "status": task.status.value,
        "progress": task.progress,
        "downloaded_bytes": task.downloaded_bytes,
        "total_bytes": task.total_bytes,
        "file_path": task.file_path,
        "error": task.error,
    })


@app.get("/api/downloads")
def list_downloads():
    if not _download_manager:
        return jsonify({"tasks": []})
    tasks = _download_manager.get_all_tasks()
    tasks.sort(key=lambda t: t.created_at, reverse=True)
    return jsonify({"tasks": [t.to_dict() for t in tasks]})


@app.get("/api/downloads/info")
def downloads_info():
    # `download_dir` stays for the existing frontend contract; the rest tells the
    # Settings screen whether we actually landed in the folder the user asked for.
    return jsonify({
        "download_dir": get_default_download_dir(),
        **android_env.downloads_status(),
    })


@app.post("/api/downloads/dir")
def set_downloads_dir():
    """Choose a custom download folder (or clear it, restoring the default).

    Refuses a folder we cannot actually write to, rather than accepting it and
    letting every later download fail with no explanation.
    """
    path = (_body().get("path") or "").strip()

    settings = android_env.read_settings()
    if not path:
        settings.pop("download_dir", None)
        android_env.write_settings(settings)
        return jsonify({"ok": True, **android_env.downloads_status()})

    if not android_env.is_writable(path):
        return jsonify({
            "ok": False,
            "error": "Can't write to that folder. Grant “All files access” in "
                     "Android Settings, or pick a different folder.",
        }), 400

    settings["download_dir"] = path
    android_env.write_settings(settings)
    return jsonify({"ok": True, **android_env.downloads_status()})


@app.get("/api/downloads/local")
def scan_local_downloads():
    """Rebuild the offline library from the tags embedded in each file on disk.
    Disk is the source of truth, so downloads survive a cleared frontend registry
    or an app restart."""
    from components.download_manager import scan_downloads
    directory = get_default_download_dir()
    try:
        tracks = scan_downloads(directory)
    except Exception:
        tracks = []
    return jsonify({"tracks": tracks, "download_dir": directory})


@app.post("/api/downloads/delete")
def delete_download_file():
    """Delete a downloaded file from disk (not just the app's registry).

    Guards against path traversal: the resolved target MUST sit inside the
    active download directory, so a caller can't ask us to delete arbitrary
    files elsewhere on the phone.
    """
    raw = (_body().get("path") or "").strip()
    if not raw:
        return jsonify({"ok": False, "error": "no path"}), 400

    directory = Path(get_default_download_dir()).resolve()
    try:
        target = Path(raw).resolve()
        # target must be within the download directory (Python 3.9+: is_relative_to)
        inside = str(target).startswith(str(directory))
        if not inside or not target.is_file():
            return jsonify({"ok": False, "error": "not a managed download"}), 400
        target.unlink()
        # Clean up an emptied album subfolder, but never the root itself.
        parent = target.parent
        if parent != directory and parent.is_dir() and not any(parent.iterdir()):
            parent.rmdir()
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.post("/api/download/<task_id>/cancel")
def cancel_download(task_id):
    if not _download_manager:
        return jsonify({"cancelled": False})
    return jsonify({"cancelled": _download_manager.cancel_task(task_id)})


@app.post("/api/download/<task_id>/retry")
def retry_download(task_id):
    if not _download_manager:
        return jsonify({"retried": False})
    return jsonify({"retried": _download_manager.retry_task(task_id)})


@app.post("/api/downloads/clear")
def clear_completed_downloads():
    if not _download_manager:
        return jsonify({"cleared": 0})
    return jsonify({"cleared": _download_manager.clear_completed()})


_LOCAL_AUDIO_EXTS = {".m4a", ".mp3", ".flac", ".opus", ".ogg", ".wav", ".aac", ".mp4"}


@app.get("/api/local")
def serve_local_file():
    """Serve a downloaded file for offline playback.

    Confined to the downloads directory and to audio extensions. The path comes
    from our own records, but it arrives over HTTP from the WebView, so it is
    still treated as untrusted input.
    """
    path = request.args.get("path") or ""
    try:
        real = Path(path).expanduser().resolve(strict=True)
    except Exception:
        return jsonify({"detail": "File not found"}), 404

    root = Path(get_default_download_dir()).resolve()
    if root not in real.parents:
        return jsonify({"detail": "Path not allowed"}), 403
    if real.suffix.lower() not in _LOCAL_AUDIO_EXTS:
        return jsonify({"detail": "Unsupported file type"}), 403
    if not real.is_file():
        return jsonify({"detail": "File not found"}), 404

    # conditional=True gives us Range/206 handling, so seeking works offline.
    return send_file(str(real), conditional=True)


# ─── Lyrics ───────────────────────────────────────────────────────────────────
@app.get("/api/lyrics")
def get_lyrics():
    """Synced lyrics from lrclib, with a JioSaavn plain-text fallback.

    The matching gate is the important part: lrclib's fuzzy search happily
    returns a DIFFERENT song that merely shares a title. Wrong lyrics are worse
    than no lyrics, so a candidate must clear an artist + duration confidence
    check before we accept it.
    """
    title = _arg("title")
    artist = _arg("artist")
    duration = _int_arg("duration", 0)

    cache_key = f"{title.lower()}|{artist.lower()}"
    with _lyrics_cache_lock:
        hit = _lyrics_cache.get(cache_key)
    if hit is not None:
        return jsonify(hit)

    def _clean_for_search(text: str) -> str:
        cleaned = re.sub(r'\s*[\(\[\{].*?[\)\]\}]', '', text)
        cleaned = re.sub(r'\s*[-|].*(?:official|video|audio|lyric|full|hd|4k|visuali).*$',
                         '', cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r'\s+(?:feat\.|ft\.).*$', '', cleaned, flags=re.IGNORECASE)
        return cleaned.strip()

    def _fetch():
        headers = {"User-Agent": "Fix_Spotify/1.0 (music player)"}
        clean_title = _clean_for_search(title)
        clean_artist = _clean_for_search(artist)

        # A total miss can otherwise stack many slow calls; on a mobile network
        # those add up fast. Bound the whole lookup.
        start = time.monotonic()
        deadline = start + 20      # hard cap for the entire lookup
        ll_deadline = start + 12   # favour lrclib (our only SYNCED source)

        def _http_get(url, *, timeout, **kw):
            left = deadline - time.monotonic()
            if left < 1.5:
                return None
            try:
                return _lyrics_session.get(url, timeout=min(timeout, left), **kw)
            except Exception:
                return None

        # Indian tracks often arrive credited as "Lyricist, Composer, Singer"
        # ("Sayeed Quadri, Pritam, KK") but lrclib indexes ONE artist name, so we
        # try each component separately.
        artist_candidates = []
        if clean_artist:
            artist_candidates.append(clean_artist)
            for sep in (",", "&", "feat.", "ft.", " x ", "/"):
                if sep in clean_artist.lower():
                    for part in re.split(r'[,&/]| feat\.| ft\.| x ', clean_artist,
                                         flags=re.IGNORECASE):
                        part = part.strip()
                        if part and part not in artist_candidates:
                            artist_candidates.append(part)
                    break
        if not artist_candidates:
            artist_candidates = [""]

        plain_fallback = {"value": None}

        # rapidfuzz has no Android wheel, so this always takes the difflib branch
        # on-device. Kept identical to the desktop code so behaviour matches when
        # rapidfuzz IS importable (e.g. running this file on a PC).
        try:
            from rapidfuzz import fuzz as _fuzz

            def _sim(a, b):
                return max(_fuzz.token_set_ratio(a, b), _fuzz.partial_ratio(a, b))

            def _artist_cmp(a, b):
                # No partial_ratio here: it spuriously matches long multi-artist
                # credit strings.
                return max(_fuzz.token_set_ratio(a, b),
                           _fuzz.ratio(a.replace(" ", ""), b.replace(" ", "")))
        except ImportError:
            from difflib import SequenceMatcher as _SM

            def _sim(a, b):
                return _SM(None, a, b).ratio() * 100

            def _artist_cmp(a, b):
                return max(_SM(None, a, b).ratio() * 100,
                           _SM(None, a.replace(" ", ""), b.replace(" ", "")).ratio() * 100)

        def _norm(s):
            s = re.sub(r"[^\w\s]", " ", (s or "").lower())
            return re.sub(r"\s+", " ", s).strip()

        def _artist_score(cand_artist):
            if not clean_artist or not cand_artist:
                return 0.0
            cand = _norm(cand_artist)
            best = _artist_cmp(_norm(clean_artist), cand)
            for part in re.split(r'[,&/]| feat\.| ft\.| x ', clean_artist, flags=re.IGNORECASE):
                part = part.strip()
                if len(part) >= 2:
                    best = max(best, _artist_cmp(_norm(part), cand))
            return best

        def _is_valid(item):
            title_score = _sim(_norm(clean_title), _norm(item.get("trackName") or ""))
            if title_score < 65:
                return False
            cand_dur = item.get("duration") or 0
            dur_known = bool(duration and duration > 0 and cand_dur)
            # Same title, far-off length = a different recording. Hard veto.
            if dur_known and abs(duration - float(cand_dur)) > 25:
                return False
            dur_ok = dur_known and abs(duration - float(cand_dur)) <= 8
            if clean_artist:
                # A tight duration match alone is NOT enough — different songs
                # share a title AND a runtime. Require artist corroboration.
                return _artist_score(item.get("artistName") or "") >= 55
            if dur_known:
                return title_score >= 80 and dur_ok
            return title_score >= 90

        # lrclib often hosts several uploads of one song with slightly different
        # masters. A set of timestamps only lines up with audio of the SAME
        # length, so collect every valid synced hit and take the closest duration.
        synced_candidates = []

        def _consider(item):
            if not _is_valid(item) or item.get("instrumental"):
                return
            synced = item.get("syncedLyrics") or ""
            plain = item.get("plainLyrics") or ""
            if synced:
                parsed = _parse_lrc(synced)
                if parsed:
                    cand_dur = item.get("duration") or 0
                    delta = abs(duration - float(cand_dur)) if duration and cand_dur else 1e9
                    synced_candidates.append(
                        (delta, {"plain": plain, "synced": parsed, "source": "lrclib"})
                    )
                    return
            if plain and plain_fallback["value"] is None:
                plain_fallback["value"] = {"plain": plain, "synced": [], "source": "lrclib"}

        def _best_synced():
            if not synced_candidates:
                return None
            synced_candidates.sort(key=lambda x: x[0])
            return synced_candidates[0][1]

        # Strategy 1 — fuzzy search: one call returns many ranked candidates, and
        # its queries cover multi-artist credits a single exact lookup can't.
        search_queries = []
        if clean_artist:
            search_queries.append(f"{clean_title} {artist_candidates[-1]}".strip())
            search_queries.append(f"{clean_title} {clean_artist}".strip())
        search_queries.append(clean_title)

        seen_queries = set()
        for q in search_queries:
            if not q or q in seen_queries or time.monotonic() > ll_deadline:
                continue
            seen_queries.add(q)
            r = _http_get("https://lrclib.net/api/search",
                          params={"q": q}, headers=headers, timeout=8)
            if r is not None and r.status_code == 200:
                try:
                    items = r.json()
                except Exception:
                    items = None
                if isinstance(items, list):
                    for item in items[:15]:
                        _consider(item)
                    best = _best_synced()
                    if best:
                        return best

        # Strategy 2 — exact /api/get per artist candidate, for songs whose fuzzy
        # ranking buries the right match.
        for art in artist_candidates[:4]:
            if time.monotonic() > ll_deadline:
                break
            r = _http_get("https://lrclib.net/api/get",
                          params={"track_name": clean_title, "artist_name": art},
                          headers=headers, timeout=8)
            if r is not None and r.status_code == 200:
                try:
                    _consider(r.json())
                except Exception:
                    pass
        best = _best_synced()
        if best:
            return best

        if plain_fallback["value"]:
            return plain_fallback["value"]

        # Strategy 3 — JioSaavn plain lyrics. Strong coverage for Indian/
        # Bollywood/regional tracks. Direct request so lrclib's deadline can't
        # starve it.
        try:
            js_base = "https://www.jiosaavn.com/api.php"
            js_headers = {
                "User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36",
                "Referer": "https://www.jiosaavn.com/",
                "Accept": "application/json",
            }

            def _js_get(params):
                qs = urllib.parse.urlencode(
                    {**params, "_format": "json", "_marker": "0", "ctx": "web6dot0"}
                )
                r = http_requests.get(f"{js_base}?{qs}", headers=js_headers, timeout=8)
                return r.json() if r.status_code == 200 else {}

            ac_data = _js_get({"__call": "autocomplete.get",
                               "query": f"{clean_title} {clean_artist}".strip()})
            song_id = None
            for hit in (ac_data.get("songs", {}) or {}).get("data", [])[:5]:
                if _sim(_norm(clean_title), _norm(hit.get("title", ""))) < 55:
                    continue
                # Verify the ARTIST too — title-only matching served a different
                # song's lyrics. With no corroboration we'd rather show nothing.
                if clean_artist:
                    mi = hit.get("more_info") or {}
                    hit_artist = mi.get("primary_artists") or mi.get("singers") or ""
                    if _artist_score(hit_artist) < 55:
                        continue
                song_id = hit.get("id")
                break

            if song_id:
                lyr_data = _js_get({"__call": "lyrics.getLyrics", "lyrics_id": song_id})
                raw_lyrics = lyr_data.get("lyrics", "")
                if raw_lyrics and len(raw_lyrics) > 20:
                    plain = (raw_lyrics.replace("<br>", "\n")
                                       .replace("<br/>", "\n")
                                       .replace("<br />", "\n"))
                    plain = re.sub(r"<[^>]+>", "", plain).strip()
                    if plain:
                        return {"plain": plain, "synced": [], "source": "jiosaavn"}
        except Exception:
            pass  # best-effort; never block on failure

        return {"plain": "", "synced": [], "source": None}

    try:
        result = _fetch()
        # Cache only real hits, so a transient miss can retry later.
        if result and result.get("source"):
            with _lyrics_cache_lock:
                if len(_lyrics_cache) >= _LYRICS_CACHE_MAX:
                    _lyrics_cache.pop(next(iter(_lyrics_cache)))
                _lyrics_cache[cache_key] = result
        return jsonify(result)
    except Exception as e:
        return jsonify({"plain": "", "synced": [], "source": None, "error": str(e)})


# ─── Discovery / profiles ─────────────────────────────────────────────────────
@app.get("/api/artwork")
def get_artwork():
    try:
        from components.itunes_client import iTunesClient
        results = iTunesClient().search(f"{_arg('title')} {_arg('artist')}".strip(), limit=1)
        if results:
            art = getattr(results[0], "artwork_urls", {}) or {}
            return jsonify({"artwork_url": art.get("600") or art.get("300") or ""})
        return jsonify({"artwork_url": ""})
    except Exception as e:
        return jsonify({"artwork_url": "", "error": str(e)})


@app.get("/api/radio")
def radio():
    try:
        from components.radio import resolve_radio
        limit = min(max(_int_arg("limit", 12), 1), 20)
        return jsonify({"tracks": resolve_radio(_arg("title"), _arg("artist"), limit)})
    except Exception as e:
        return jsonify({"tracks": [], "error": str(e)})


@app.get("/api/artist")
def artist_profile():
    name = _arg("name")
    try:
        from components.profile import get_artist
        return jsonify(get_artist(name))
    except Exception as e:
        return jsonify({"name": name, "top_songs": [], "albums": [], "error": str(e)})


@app.get("/api/search/artists")
def search_artists_ep():
    try:
        from components.profile import search_artists
        return jsonify({"artists": search_artists(_arg("q"), _int_arg("limit", 10))})
    except Exception as e:
        return jsonify({"artists": [], "error": str(e)})


@app.get("/api/album")
def album_profile():
    name, artist = _arg("name"), _arg("artist")
    try:
        from components.profile import get_album
        return jsonify(get_album(name, artist, _arg("song_url"), _arg("album_id")))
    except Exception as e:
        return jsonify({"name": name, "artist": artist, "tracks": [], "error": str(e)})


@app.get("/api/search/albums")
def search_albums_ep():
    try:
        from components.profile import search_albums
        return jsonify({"albums": search_albums(_arg("q"), _int_arg("limit", 10))})
    except Exception as e:
        return jsonify({"albums": [], "error": str(e)})


@app.get("/api/home")
def home_feed():
    try:
        from components.home import get_home
        return jsonify(get_home(_arg("language", "hindi,english")))
    except Exception as e:
        return jsonify({"rows": [], "error": str(e)})


@app.get("/api/playlist")
def playlist_detail():
    try:
        from components.home import get_playlist
        return jsonify(get_playlist(_arg("url")))
    except Exception as e:
        return jsonify({"name": "", "tracks": [], "error": str(e)})


@app.get("/api/genres")
def genre_tiles():
    try:
        from components.home import get_genres
        return jsonify(get_genres(_arg("language", "hindi,english")))
    except Exception as e:
        return jsonify({"tiles": [], "error": str(e)})


@app.post("/api/enrich")
def enrich_batch():
    """Batch iTunes enrichment. Called AFTER search results render, so search
    stays instant while clean metadata fills in a moment later."""
    tracks = (_body().get("tracks") or [])
    if _enricher is None or not tracks:
        return jsonify({"results": [None] * len(tracks)})

    def lookup_one(item):
        try:
            meta = _enricher._lookup(
                item.get("title") or "",
                item.get("artist") or "",
                item.get("isrc"),
                item.get("duration_ms"),
            )
        except Exception:
            meta = None
        if not meta:
            return None
        return {
            "artist": _clean_text(meta.get("artist")) or None,
            "album": _clean_text(meta.get("album")) or None,
            "isrc": meta.get("isrc"),
            "release_date": meta.get("release_date"),
            "genre": meta.get("genre"),
            "duration_ms": meta.get("duration_ms"),
            "artwork": meta.get("artwork") or {},
        }

    try:
        # executor.map preserves input order, which the frontend relies on to
        # align results with the tracks it sent.
        with ThreadPoolExecutor(max_workers=6) as executor:
            results = list(executor.map(lookup_one, tracks))
        return jsonify({"results": results})
    except Exception as e:
        return jsonify({"results": [None] * len(tracks), "error": str(e)})


# ─── Spotify playlist import ──────────────────────────────────────────────────
# Spotify itself is NOT a playable source — we never stream from it. We only read
# a public playlist's TRACK LIST (title + artist), then find each song on
# JioSaavn/SoundCloud so it becomes playable here.
#
# Spotify fetch (URL parsing + embed scrape) lives in components/spotify_import.py.
from components.spotify_import import (
    parse_url as parse_spotify_url,
    fetch_tracklist as _spotify_tracklist,
    is_good_match as _title_artist_ok,   # title + artist + duration gate
)


def _match_track(item: Dict[str, str]) -> Optional[Dict[str, Any]]:
    """Find a PLAYABLE version of one Spotify track on our own sources."""
    if _search_service is None:
        return None
    query = f"{item['title']} {item['artist']}".strip()
    try:
        cfg = replace(
            _search_service.config,
            max_total_results=5,           # look past a wrong #1 to a right #2
            max_results_per_source=5,
            enabled_sources=PLAYABLE_SEARCH_SOURCES,
            timeout_seconds=10.0,
        )
        for track in _search_service.search(query, cfg):
            source = _playable_source_name(track)
            if not source:
                continue
            if not _title_artist_ok(item, track):
                continue               # nearest hit but not the right song — skip
            return {
                "title": _clean_text(track.title) or item["title"],
                "artist": _clean_text(track.artist) or item["artist"],
                "album": _clean_text(track.album),
                "duration_ms": track.duration_ms,
                "isrc": track.isrc,
                "sources": {k.value: _source_to_dict(v) for k, v in track.sources.items()},
                "primary_source": source,
                "playable_source": source,
                "artwork_url": track.get_best_artwork() if hasattr(track, "get_best_artwork") else None,
                "artwork_urls": _clean_artwork_urls(getattr(track, "artwork_urls", {})),
                "is_playable": True,
            }
    except Exception:
        pass
    return None


# ─── Spotify import as a background job ───────────────────────────────────────
# Matching a long playlist takes a while (a real search per track). Running it in
# a thread keyed by URL means the work CONTINUES even if the user leaves the
# import screen — the WebView can unmount and come back and pick up exact
# progress, because the job lives here in the server process, not in the page.
#
# The client polls /api/spotify/import for a snapshot; the first call starts the
# job. Desktop passes wait=1 to block for the finished result (its old one-shot
# behaviour, unchanged).
_import_jobs: Dict[str, Dict[str, Any]] = {}
_import_lock = threading.Lock()
_IMPORT_JOBS_MAX = 8


def _import_snapshot(job: Dict[str, Any]) -> Dict[str, Any]:
    with _import_lock:
        return {
            "name": job["name"], "image": job["image"],
            "total": job["total"], "done": job["done"], "matched": job["matched"],
            "tracks": job["tracks"], "missing": job["missing"],
            "finished": job["finished"], "error": job["error"],
        }


def _run_import(kind: str, sid: str, job: Dict[str, Any]) -> None:
    try:
        meta = _spotify_tracklist(kind, sid)
    except Exception as e:
        with _import_lock:
            job["error"] = f"Could not read that playlist: {e}"
            job["finished"] = True
        return
    if not meta:
        with _import_lock:
            job["error"] = "Could not read that playlist — is it public?"
            job["finished"] = True
        return

    items = meta["tracks"][:100]   # cap the work: a real search per track
    with _import_lock:
        job["name"] = meta["name"]
        job["image"] = meta.get("image", "")
        job["total"] = len(items)

    matched: List[Optional[Dict[str, Any]]] = [None] * len(items)
    with ThreadPoolExecutor(max_workers=6) as ex:
        fut_to_i = {ex.submit(_match_track, it): i for i, it in enumerate(items)}
        for fut in as_completed(fut_to_i):
            i = fut_to_i[fut]
            try:
                matched[i] = fut.result()
            except Exception:
                matched[i] = None
            with _import_lock:
                job["done"] += 1

    with _import_lock:
        job["tracks"] = [t for t in matched if t]          # original order preserved
        job["missing"] = [f"{items[i]['title']} — {items[i]['artist']}"
                          for i, t in enumerate(matched) if not t]
        job["matched"] = len(job["tracks"])
        job["finished"] = True


@app.get("/api/spotify/import")
def spotify_import():
    """Resolve a public Spotify playlist/album URL into playable tracks.

    Runs as a background job so progress survives the user leaving the screen.
    Returns a snapshot; the first call starts the job. `wait=1` blocks for the
    finished result (desktop's original one-shot behaviour).
    """
    url = _arg("url")
    kind, sid = parse_spotify_url(url)
    if not kind:
        return jsonify({"error": "Not a Spotify playlist or album link"}), 400

    with _import_lock:
        job = _import_jobs.get(url)
        # Start a fresh job if none exists, or if the last attempt failed (retry).
        if job is None or (job["finished"] and job["error"]):
            job = {"name": "", "image": "", "total": 0, "done": 0, "matched": 0,
                   "tracks": [], "missing": [], "finished": False, "error": None}
            _import_jobs[url] = job
            # Evict oldest finished jobs so the dict can't grow without bound.
            if len(_import_jobs) > _IMPORT_JOBS_MAX:
                for k in [k for k, v in list(_import_jobs.items())
                          if v["finished"] and k != url][: len(_import_jobs) - _IMPORT_JOBS_MAX]:
                    _import_jobs.pop(k, None)
            threading.Thread(target=_run_import, args=(kind, sid, job), daemon=True).start()

    if _arg("wait"):
        deadline = time.monotonic() + 120
        while not _import_snapshot(job)["finished"] and time.monotonic() < deadline:
            time.sleep(0.2)

    return jsonify(_import_snapshot(job))


@app.get("/api/sources/status")
def sources_status():
    sources = {
        "jiosaavn": {"status": "ready", "type": "audio", "quality": "320kbps AAC"},
        "soundcloud": {"status": "ready", "type": "audio", "quality": "128kbps MP3"},
        "itunes": {"status": "ready", "type": "metadata", "quality": "artwork/tags"},
        "musicbrainz": {"status": "ready", "type": "metadata", "quality": "ISRC/lookup"},
        "youtube": {
            "status": "unavailable",
            "type": "audio",
            "quality": "n/a",
            "error": "YouTube needs a JavaScript runtime (Deno) to solve its "
                     "signature challenge; none exists for Android.",
        },
    }
    return jsonify({"sources": sources})


# ─── YouTube endpoints: permanent stubs ───────────────────────────────────────
# SettingsView still calls these. They must answer (never 404) or the settings
# screen shows a spinner forever — but they always report "not connected".
@app.get("/api/youtube/status")
def youtube_status():
    return jsonify({"connected": False, "method": None, "browser": None,
                    "browsers": [], "supported": False,
                    "reason": "YouTube is not supported on mobile."})


@app.post("/api/youtube/connect")
@app.post("/api/youtube/connect_file")
def youtube_connect():
    return jsonify({"connected": False,
                    "error": "YouTube is not supported on the mobile build."})


@app.post("/api/youtube/disconnect")
def youtube_disconnect():
    return jsonify({"connected": False})


# ─── YouTube via NewPipeExtractor ─────────────────────────────────────────────
@app.get("/api/youtube/experimental")
def youtube_experimental_status():
    """Report whether YouTube extraction is available on this device, and whether
    it is currently enabled. Cheap — no extraction — so Settings shows it live."""
    try:
        import newpipe_yt
        supported = newpipe_yt.is_supported()
    except Exception:
        supported = False
    return jsonify({
        "supported": supported,
        "enabled": _youtube_enabled,
        "saved": bool(android_env.read_settings().get("youtube_experimental")),
    })


@app.post("/api/youtube/experimental")
def youtube_experimental_toggle():
    """Turn experimental YouTube on/off.

    Turning ON runs a real on-device self-test (extract a known video). Only if
    that SUCCEEDS do we flip the source on — so the UI can honestly say whether
    it works on THIS phone rather than promising something that silently fails.
    """
    want = bool(_body().get("enabled"))

    settings = android_env.read_settings()

    if not want:
        _set_youtube(False)
        settings["youtube_experimental"] = False
        android_env.write_settings(settings)
        return jsonify({"enabled": False, "ok": True})

    try:
        import newpipe_yt
        if not newpipe_yt.is_supported():
            return jsonify({"enabled": False, "ok": False,
                            "error": "The YouTube extractor could not start on "
                                     "this device."}), 200
        # Resolves a REAL audio URL — the step that needs the signature and
        # throttling deobfuscation. Searching alone would prove nothing.
        passed = newpipe_yt.self_test()
    except Exception as e:
        return jsonify({"enabled": False, "ok": False, "error": str(e)}), 200

    if not passed:
        return jsonify({"enabled": False, "ok": False,
                        "error": "Couldn't get a playable YouTube stream on this "
                                 "device. Leaving YouTube off."}), 200

    _set_youtube(True)
    settings["youtube_experimental"] = True
    android_env.write_settings(settings)
    return jsonify({"enabled": True, "ok": True})


@app.get("/api/youtube/cookies")
def youtube_cookies_status():
    return jsonify({"present": os.path.exists(_yt_cookies_path())})


@app.post("/api/youtube/cookies")
def youtube_cookies_set():
    """Import (or remove, with empty content) the user's YouTube cookies.txt.

    Cookies are the auth fallback for "sign in to confirm you're not a bot" —
    exported from a logged-in browser on a PC. Stored app-private; never leaves
    the device (yt-dlp sends them to YouTube only).
    """
    content = (_body().get("content") or "").strip()
    path = _yt_cookies_path()
    if not content:
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
        _drop_yt_client()
        return jsonify({"present": False, "ok": True})
    if "youtube.com" not in content:
        return jsonify({"ok": False, "present": os.path.exists(path),
                        "error": "That file has no YouTube cookies — export "
                                 "cookies.txt from a browser signed in to YouTube."})
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    _drop_yt_client()   # rebuilt with cookies on next use
    return jsonify({"present": True, "ok": True})


# ─── SPA ──────────────────────────────────────────────────────────────────────
# Serving the React bundle from the SAME origin as the API is what lets
# frontend/src/utils/config.js keep its relative base: fetch('/api/...') and
# <audio src="/api/proxy_stream?..."> both resolve here with no CORS and with
# working Range requests.
@app.get("/")
def spa_index():
    return send_from_directory(android_env.web_dir(), "index.html")


@app.get("/<path:filename>")
def spa_assets(filename):
    root = android_env.web_dir()
    if os.path.isfile(os.path.join(root, filename)):
        return send_from_directory(root, filename)
    # Unknown non-API path → let the client-side router handle it.
    return send_from_directory(root, "index.html")


# ──────────────────────────────────────────────────────────────────────────────
# Lifecycle — called from Kotlin
# ──────────────────────────────────────────────────────────────────────────────
def _warm_up():
    """Pay the cold-start costs in the background so the user's FIRST search and
    FIRST lyrics lookup are already warm (lazy imports, SoundCloud client_id
    resolution, TLS handshakes). Best-effort; never blocks startup."""
    try:
        _lyrics_session.get("https://lrclib.net/api/search",
                            params={"q": "hello"}, timeout=10)
    except Exception:
        pass
    try:
        cfg = replace(
            _search_service.config, max_total_results=5,
            enabled_sources=PLAYABLE_SEARCH_SOURCES, timeout_seconds=15.0,
        )
        _search_service.search("hello", cfg)
    except Exception:
        pass

    # Restore experimental YouTube if the user had it on. We trust the previous
    # on-device self-test rather than re-running it at every boot (it's slow),
    # and register the provider here. Fully guarded: if the engine is gone, the
    # source is simply added but returns nothing — never a crash.
    try:
        if android_env.read_settings().get("youtube_experimental"):
            import newpipe_yt
            if newpipe_yt.is_supported():
                _set_youtube(True)
                print("[backend] YouTube restored")
    except Exception as e:
        print(f"[backend] YouTube restore skipped: {e}")


def start_server(files_dir: str, downloads_dir: str, web_dir: str,
                 cache_dir: str, port: int = 8765, public_dir: str = "",
                 api_token: str = "") -> int:
    """Entry point invoked from BackendService.kt.

    Blocks forever serving requests, so Kotlin must call it on a background
    thread. Returns only if the server is shut down.
    """
    global _search_service, _download_manager, _enricher, _server

    global _API_TOKEN
    _API_TOKEN = api_token or ""

    android_env.configure(files_dir, downloads_dir, web_dir, cache_dir, public_dir)
    android_env.install_stdio_logging()

    print(f"[backend] starting on 127.0.0.1:{port}")
    print(f"[backend] downloads -> {android_env.downloads_dir()}")
    print(f"[backend] web root  -> {android_env.web_dir()}")

    _search_service = UnifiedSearchService()
    # 2 concurrent downloads, not the desktop's 3: phones have less bandwidth
    # headroom and Android is quicker to throttle a chatty background process.
    _download_manager = DownloadManager(
        config=DownloadQueueConfig(max_concurrent=2),
        download_dir=get_default_download_dir(),
    )
    _download_manager.start()
    _enricher = MetadataEnricher()
    _download_manager.set_finalizer(_finalize_track_info)

    threading.Thread(target=_warm_up, daemon=True).start()

    # Werkzeug's production-grade WSGI server. Threaded so a long proxy_stream
    # (which holds its connection open for the whole song) can't block search,
    # lyrics, or the download queue.
    _server = make_server("127.0.0.1", port, app, threaded=True)
    print(f"[backend] ready on 127.0.0.1:{port}")
    _server.serve_forever()
    return port


def stop_server() -> None:
    global _server
    if _server is not None:
        _server.shutdown()
        _server = None
    if _download_manager:
        _download_manager.stop()
    if _search_service:
        _search_service.shutdown()


if __name__ == "__main__":
    # Desktop smoke test:
    #   cd mobile/python && python mobile_server.py [--port 8765]
    # Serves the mobile UI + API on localhost using throwaway local folders, so
    # you can iterate on the whole app in a browser without an emulator.
    import argparse

    parser = argparse.ArgumentParser(description="Fix_Spotify mobile backend")
    parser.add_argument("--port", type=int, default=8765)
    args, _ = parser.parse_known_args()

    base = Path(__file__).resolve().parent / ".devroot"
    web = Path(__file__).resolve().parents[2] / "frontend" / "dist-mobile"
    start_server(
        files_dir=str(base / "files"),
        downloads_dir=str(base / "downloads"),
        web_dir=str(web),
        cache_dir=str(base / "cache"),
        port=args.port,
    )
