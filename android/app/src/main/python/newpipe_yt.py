"""
YouTube for the Android app, backed by NewPipeExtractor.
========================================================
The mobile YouTube source does NOT go through yt-dlp. Since late 2025 YouTube
gates its stream URLs behind a JS signature + throttling challenge, and yt-dlp
needs an external JS runtime (Deno) to solve it — there is none on Android.
Three attempts to graft a JS engine into yt-dlp's provider framework all failed
on-device.

NewPipeExtractor (the engine behind the NewPipe app) does the deobfuscation
itself with a bundled Rhino, in pure Java. This module is the thin Python side:
it calls YouTubeNP.kt over Chaquopy and hands back plain dicts.

Everything is guarded — any failure returns empty, which leaves YouTube simply
unavailable (the state the app is already in) and never disturbs JioSaavn or
SoundCloud.
"""

import json
import logging

log = logging.getLogger("newpipe_yt")


def _bridge():
    """The Kotlin YouTubeNP object, or None when not running inside the APK."""
    try:
        from java import jclass  # Chaquopy — only importable inside the APK

        return jclass("com.xmrnoobx.fixspotify.YouTubeNP")
    except Exception as e:  # pragma: no cover - desktop/test path
        log.debug("NewPipe bridge unavailable: %s", e)
        return None


def is_supported() -> bool:
    """True when NewPipeExtractor initialises on this device."""
    np = _bridge()
    if np is None:
        return False
    try:
        return bool(np.isSupported())
    except Exception as e:
        log.warning("NewPipe isSupported failed: %s", e)
        return False


def search(query: str, limit: int = 10):
    """-> [{title, artist, duration_ms, url, artwork}]. Empty list on failure."""
    np = _bridge()
    if np is None or not query:
        return []
    try:
        return json.loads(str(np.search(query, int(limit)))) or []
    except Exception as e:
        log.warning("NewPipe search failed (%s): %s", query, e)
        return []


def stream_url(video_url: str):
    """-> {url, bitrate_kbps, codec} for the best audio-only stream, or None.

    The URL NewPipe returns is already signature- and throttling-solved, so it
    can be handed straight to the audio proxy.
    """
    np = _bridge()
    if np is None or not video_url:
        return None
    try:
        data = json.loads(str(np.streamUrl(video_url))) or {}
        return data if data.get("url") else None
    except Exception as e:
        log.warning("NewPipe stream_url failed (%s): %s", video_url, e)
        return None


def self_test() -> bool:
    """Can we ACTUALLY resolve a playable YouTube audio URL on this device?

    Search is not enough — search works without solving anything. The stream URL
    is the part that requires the signature/throttling deobfuscation, so that is
    what we test.
    """
    if not is_supported():
        return False
    hits = search("lofi hip hop", 1)
    if not hits:
        return False
    return bool(stream_url(hits[0].get("url", "")))
