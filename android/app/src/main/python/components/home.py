"""
Home feed + JioSaavn playlist resolver
=======================================
Spotify-like dynamic Home rows assembled from JioSaavn's REAL homepage data.
`webapi.getLaunchData` is one call that returns charts, trending, new albums and
top playlists — so the whole feed is a single network round-trip, then cached.

Reuses profile.py's battle-tested JioSaavn helpers (`_jcall`, `_clean`,
`_song_to_raw`, `_make_playable`, `_token_from_url`) — no duplicated client or
merge code (ponytail rung 2: it already exists here).

Each row is `{title, items: [...]}`; each item is a self-describing card:
  - {"type": "track",    "track": <playable frontend track dict>, ...}
  - {"type": "album",    "name", "artist", "image", "perma_url"}
  - {"type": "playlist", "name", "image", "subtitle", "perma_url"}
so the frontend stays dumb and dispatches a click by `item.type`.

ponytail: in-memory cache (the feed barely changes within a session); a failed
or empty module is simply omitted, the page never aborts. Ceiling: unbounded +
lost on restart (fine for a desktop session); upgrade path = TTL + size cap.
"""

import threading
import time

from components.profile import (
    _jcall, _clean, _song_to_raw, _make_playable, _token_from_url,
)

_cache = {}
_cache_lock = threading.Lock()

# ponytail: the Home feed (trending / new / charts / playlists) is TIME-SENSITIVE
# — JioSaavn refreshes it ~daily. Unlike static artist/album profiles, caching it
# for the whole process lifetime would freeze "Trending now" until a backend
# restart (in the EXE that's the entire app session). So entries carry a 6h TTL.
# Ceiling: a feed up to 6h stale; upgrade path = a daily cron / push refresh.
_TTL_SECONDS = 6 * 3600


def _cache_get(key):
    with _cache_lock:
        ent = _cache.get(key)
        if ent and (time.time() - ent[0] < _TTL_SECONDS):
            return ent[1]
    return None


def _cache_put(key, value):
    with _cache_lock:
        _cache[key] = (time.time(), value)


def _img(url):
    """Upscale JioSaavn's 150x150 thumbnails to 500x500 by URL swap."""
    return (url or "").replace("150x150", "500x500")


def _artist_of(it):
    """Best artist/owner string from a launch-data entry (album/song/playlist)."""
    mi = it.get("more_info") or {}
    am = mi.get("artistMap") or {}
    names = ", ".join(
        a.get("name", "") for a in (am.get("artists") or am.get("primary_artists") or [])
        if isinstance(a, dict) and a.get("name")
    )
    sub = _clean(it.get("subtitle"))
    return _clean(names or mi.get("music") or mi.get("primary_artists") or sub)


def _card(it):
    """Normalize one JioSaavn entry (launch-data module item OR a trending
    {type, details} wrapper) into a Home card. Returns None if unrenderable."""
    if not isinstance(it, dict):
        return None
    # content.getTrending wraps the real object under "details".
    if isinstance(it.get("details"), dict):
        det = it["details"]
        it = {**det, "type": it.get("type") or det.get("type")}

    typ = (it.get("type") or "").lower()
    url = it.get("perma_url") or it.get("url") or ""
    title = _clean(it.get("title") or it.get("song") or it.get("listname"))
    image = _img(it.get("image"))
    if not title:
        return None

    if typ == "song" or "/song/" in url:
        raw = _song_to_raw(it)
        playable = _make_playable([raw]) if raw else []
        if not playable:
            return None
        t = playable[0]
        return {"type": "track", "track": t,
                "title": t.get("title") or title,
                "subtitle": t.get("artist", ""),
                "image": image or t.get("image", "")}

    if typ == "album" or "/album/" in url:
        return {"type": "album", "name": title, "artist": _artist_of(it),
                "image": image, "perma_url": url,
                "subtitle": _artist_of(it)}

    if typ == "playlist" or "/featured/" in url or "/playlist/" in url:
        mi = it.get("more_info") or {}
        cnt = mi.get("song_count") or it.get("count")
        sub = _clean(it.get("subtitle")) or (f"{cnt} songs" if cnt else "Playlist")
        return {"type": "playlist", "name": title, "image": image,
                "subtitle": sub, "perma_url": url}

    return None


def _row(title, items, limit=20):
    """Build a row, dropping unrenderable items; None if the row is empty."""
    cards = [c for c in (_card(i) for i in (items or [])) if c][:limit]
    return {"title": title, "items": cards} if cards else None


def _build_home(language="hindi,english"):
    data = _jcall({
        "__call": "webapi.getLaunchData",
        "language": language,
        "api_version": "4",
    })
    if not isinstance(data, dict) or data.get("error"):
        return {"rows": []}

    rows = []
    for title, key in [
        ("Trending now", "new_trending"),
        ("New releases", "new_albums"),
        ("Charts", "charts"),
        ("Top playlists", "top_playlists"),
    ]:
        r = _row(title, data.get(key))
        if r:
            rows.append(r)
    return {"rows": rows}


def get_home(language="hindi,english"):
    """Cached Home feed (6h TTL — see _TTL_SECONDS). See _build_home."""
    key = ("home", language)
    hit = _cache_get(key)
    if hit is not None:
        return hit
    result = _build_home(language)
    if result.get("rows"):
        _cache_put(key, result)
    return result


def _build_playlist(url):
    """Resolve a JioSaavn playlist (perma_url or token) to an album-shaped dict
    {name, image, subtitle, tracks[]} so the frontend reuses AlbumView."""
    token = _token_from_url(url)
    if not token:
        return {"name": "", "tracks": []}
    d = _jcall({
        "__call": "webapi.get", "token": token, "type": "playlist",
        "p": "1", "n": "100", "api_version": "4",
    })
    if not isinstance(d, dict) or d.get("error"):
        return {"name": "", "tracks": []}
    songs = d.get("songs") or d.get("list") or []
    tracks = _make_playable([_song_to_raw(s) for s in songs])
    mi = d.get("more_info") or {}
    return {
        "name": _clean(d.get("title") or d.get("listname")),
        "artist": "",  # playlists have no single artist
        "subtitle": _clean(d.get("subtitle")) or mi.get("firstname") or "Playlist",
        "image": _img(d.get("image")),
        "year": "",
        "tracks": tracks,
    }


def get_playlist(url):
    """Cached playlist resolution (6h TTL — charts refresh daily). See
    _build_playlist."""
    key = ("playlist", (url or "").strip())
    hit = _cache_get(key)
    if hit is not None:
        return hit
    result = _build_playlist(url)
    if result.get("tracks"):
        _cache_put(key, result)
    return result


def _build_genres(language="hindi,english", limit=50):
    """Browse tiles = JioSaavn's curated FEATURED PLAYLISTS (genre / mood /
    decade themed). Deliberately NOT a text search (a junk magnet) and NOT the
    `browse_discover` channels (type=channel — they have no public tracklist
    endpoint, so a tile click would dead-end). Featured playlists are
    `type=playlist`, so each tile reuses `_card` and resolves through the exact
    same `get_playlist` → AlbumView path the Home charts already use."""
    d = _jcall({
        "__call": "content.getFeaturedPlaylists",
        "language": language,
        "p": "1", "n": str(limit),
        "api_version": "4",
    })
    items = d.get("data") if isinstance(d, dict) else None
    if not isinstance(items, list):
        return {"tiles": []}
    tiles = [c for c in (_card(it) for it in items)
             if c and c.get("type") == "playlist"]
    return {"tiles": tiles}


def get_genres(language="hindi,english"):
    """Cached browse/genre tiles (6h TTL — curated feed refreshes ~daily). See
    _build_genres."""
    key = ("genres", language)
    hit = _cache_get(key)
    if hit is not None:
        return hit
    result = _build_genres(language)
    if result.get("tiles"):
        _cache_put(key, result)
    return result


# ──────────────────────────── self-check ────────────────────────────
if __name__ == "__main__":
    home = get_home()
    rows = home["rows"]
    print(f"home rows: {[r['title'] + ':' + str(len(r['items'])) for r in rows]}")
    assert rows, "home feed returned no rows"
    types = {c["type"] for r in rows for c in r["items"]}
    assert types <= {"track", "album", "playlist"}, f"unexpected card types: {types}"
    # Every card has a title + (a playable track | an openable name/url).
    for r in rows:
        for c in r["items"]:
            assert c.get("title") or c.get("name"), f"card missing label: {c}"
            if c["type"] == "track":
                assert c["track"].get("title") and c["track"].get("sources"), \
                    f"track card not playable: {c}"
            else:
                assert c.get("perma_url"), f"{c['type']} card has no perma_url: {c}"

    # Resolve the first playlist/chart we find end to end.
    purl = next((c["perma_url"] for r in rows for c in r["items"]
                 if c["type"] == "playlist"), None)
    if purl:
        pl = get_playlist(purl)
        print(f"playlist '{pl['name']}' -> {len(pl['tracks'])} tracks")
        assert pl["tracks"], "playlist resolved to zero tracks"

    # Browse/genre tiles: curated featured playlists, every tile resolvable.
    genres = get_genres()
    tiles = genres["tiles"]
    print(f"genre tiles: {len(tiles)} -> {[t['name'] for t in tiles[:6]]}")
    assert tiles, "genre tiles returned empty"
    for t in tiles:
        assert t["type"] == "playlist" and t.get("perma_url") and t.get("name"), \
            f"unrenderable/unresolvable genre tile: {t}"
    gl = get_playlist(tiles[0]["perma_url"])
    print(f"first genre '{tiles[0]['name']}' -> {len(gl['tracks'])} tracks")
    assert gl["tracks"], "genre tile resolved to zero tracks"
    print("home self-check OK")
