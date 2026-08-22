"""One pooled HTTP session for the whole backend.

Every module here used to call `requests.get(...)` on the bare module. That
builds a throwaway Session per call, so each one paid a full DNS + TCP + TLS
handshake — 300-900ms on a mobile carrier — to a host we had just finished
talking to. It is the same waste the audio proxy had, spread across the Home
feed, artist and album pages, playlists, radio, cover-art fetches and the
Spotify importer. Opening the Home screen alone made several of these calls.

Import SESSION from here and use it exactly like the module (`SESSION.get(...)`)
and the connection is reused instead.

Deliberately separate from mobile_server's `_stream_session`: a stalled artwork
or Last.fm lookup must never be able to hold a connection slot the audio path
needs.
"""

import requests
from requests.adapters import HTTPAdapter


def build_session(pool: int = 8, maxsize: int = 16) -> requests.Session:
    s = requests.Session()
    try:
        from urllib3.util.retry import Retry

        # One retry, and only on connect. A read that fails half way through has
        # already handed us a partial body; replaying it is not free and not
        # obviously correct, so that stays the caller's problem.
        retry = Retry(total=1, connect=1, read=0, status=0, backoff_factor=0.2,
                      allowed_methods=frozenset(["GET", "HEAD"]))
        adapter = HTTPAdapter(max_retries=retry,
                              pool_connections=pool, pool_maxsize=maxsize)
        s.mount("https://", adapter)
        s.mount("http://", adapter)
    except Exception:
        # urllib3 internals moved around between versions; a session with default
        # retries still pools connections, which is the point.
        pass
    return s


SESSION = build_session()

__all__ = ["SESSION", "build_session"]
