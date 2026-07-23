"""
Radio / Autoplay
================
Given a seed (title + artist), return ~12 *similar* playable tracks.

Pipeline (all on-demand, nothing pre-loaded):
1. Last.fm `track.getSimilar` gives song NAMES similar to the seed
   (collaborative-filtering from real listening data — works well for both
   Western and Indian/Bollywood music).
2. Each similar name is resolved to a streamable track — JioSaavn first (cleanest
   catalogue, 320k), then SoundCloud and YouTube for the names it doesn't carry.

Resolution used to be JioSaavn-only, which quietly made the radio a mirror of
JioSaavn's catalogue rather than of what you were listening to: every similar
song missing from it was dropped, so seeding from anything outside its library
returned a few tracks and then ran dry. The other sources are only queried for
the names JioSaavn missed, and only while we're still short of `limit`, so the
common case costs exactly what it did before.
"""

import os
import threading
from concurrent.futures import ThreadPoolExecutor

import requests

from components.source_merger import SourceMerger

# ponytail: shared public Last.fm demo key. Ceiling: rate-limited/shared.
# Upgrade path: set LASTFM_API_KEY env var with your own free key.
LASTFM_KEY = os.getenv("LASTFM_API_KEY", "b25b959554ed76058ac220b7b2e0a026")
LASTFM_URL = "http://ws.audioscrobbler.com/2.0/"

_js_client = None
_js_lock = threading.Lock()


def _jiosaavn():
    global _js_client
    with _js_lock:
        if _js_client is None:
            from components.jiosaavn_downloader import JioSaavnClient
            _js_client = JioSaavnClient()
        return _js_client


def _primary_artist(artist):
    """Take the first/primary artist from a mashed credit string so Last.fm
    (which indexes by a single artist) can match. e.g.
    'Iravu, Pranathi Varma & Sruthi Dhulipala' -> 'Iravu'."""
    if not artist:
        return ""
    import re
    first = re.split(r"\s*[,&/]|\s+feat\.?\s+|\s+ft\.?\s+|\s+x\s+", artist, maxsplit=1, flags=re.IGNORECASE)[0]
    return first.strip()


def _lastfm(method, **kw):
    """Single Last.fm GET. Returns parsed JSON dict, or {} on any failure."""
    common = {"api_key": LASTFM_KEY, "format": "json", "autocorrect": 1}
    try:
        return requests.get(LASTFM_URL, params={**common, "method": method, **kw}, timeout=8).json()
    except Exception:
        return {}


def lastfm_similar(title, artist, limit=15):
    """Return (name, artist) tuples similar to the seed, blending multiple
    signals so the radio is both relevant AND keeps flowing for thin-data
    (new/regional) tracks:

      1. track.getSimilar  — tight, song-level similarity (best when present).
      2. artist.getSimilar → each similar artist's top tracks — discovery that
         fills the gap when track-level data is thin (e.g. brand-new songs that
         return nothing from track.getSimilar) and widens variety.
      3. seed artist's own top tracks — last resort so radio never dies.

    Insertion order preserves priority (tight matches first); the caller applies
    a diversity pass so one artist can't dominate the queue."""
    primary = _primary_artist(artist)
    pairs = []
    seen = set()

    def add(name, art):
        if not name:
            return
        key = (name.lower().strip(), (art or "").lower().strip())
        if key in seen:
            return
        seen.add(key)
        pairs.append((name, art or primary or artist))

    # 1. Tight song-level similarity.
    d = _lastfm("track.getsimilar", artist=primary or artist, track=title, limit=limit)
    for t in (d.get("similartracks", {}) or {}).get("track", []):
        add(t.get("name"), (t.get("artist") or {}).get("name"))

    # 2. Similar-artist discovery — top tracks of the closest artists. This is
    #    the fix for songs where track.getSimilar is empty: artist.getSimilar
    #    still returns strong neighbours, and their top tracks are real, playable
    #    similar music (not just "more of the same artist").
    d = _lastfm("artist.getsimilar", artist=primary or artist, limit=6)
    sim_artists = [a.get("name") for a in (d.get("similarartists", {}) or {}).get("artist", []) if a.get("name")][:4]

    def _top_tracks(a):
        dd = _lastfm("artist.gettoptracks", artist=a, limit=4)
        return [(t.get("name"), a) for t in (dd.get("toptracks", {}) or {}).get("track", []) if t.get("name")]

    if sim_artists:
        with ThreadPoolExecutor(max_workers=4) as ex:
            for lst in ex.map(_top_tracks, sim_artists):
                for name, a in lst:
                    add(name, a)

    # 3. Last resort: the seed artist's own top tracks.
    if len(pairs) < 5:
        d = _lastfm("artist.gettoptracks", artist=primary or artist, limit=limit)
        for t in (d.get("toptracks", {}) or {}).get("track", []):
            add(t.get("name"), primary or artist)

    return pairs


def _diversify(tracks, limit, max_per_artist=3):
    """Interleave tracks across artists (round-robin) and cap how many come
    from any one artist, so the radio feels curated instead of looping a single
    artist. Preserves each artist's internal order (most-similar first)."""
    from collections import OrderedDict, defaultdict
    buckets = OrderedDict()
    for t in tracks:
        a = (_primary_artist(t.get("artist", "")) or "?").lower()
        buckets.setdefault(a, []).append(t)

    out = []
    counts = defaultdict(int)
    # Round-robin: one pass takes (up to) one track per artist each loop, so the
    # output alternates artists. Stops when full or every bucket is exhausted/capped.
    progressed = True
    while len(out) < limit and progressed:
        progressed = False
        for a in buckets:
            if buckets[a] and counts[a] < max_per_artist:
                out.append(buckets[a].pop(0))
                counts[a] += 1
                progressed = True
                if len(out) >= limit:
                    break
    return out[:limit]


_service = None


def _svc():
    """The shared search service.

    Radio goes through it rather than importing source clients directly, so it
    inherits whatever gating the host has applied — most importantly, the Android
    build swaps in a NewPipe-backed YouTube client and refuses to build one at all
    while the user has YouTube switched off. Reaching for YouTubeClient here
    directly would bypass both and fall back to yt-dlp, which cannot extract
    YouTube on a phone.
    """
    global _service
    if _service is None:
        from components.unified_search import UnifiedSearchService

        _service = UnifiedSearchService()
    return _service


def _resolve(pair):
    """Resolve one (name, artist) to a raw JioSaavn result dict, or None."""
    name, art = pair
    try:
        songs = _jiosaavn().search(f"{name} {art}".strip(), limit=1)
        if songs:
            return {"source_type": "jiosaavn", **songs[0].to_dict()}
    except Exception:
        pass
    return None


def _resolve_elsewhere(pair):
    """A name JioSaavn didn't have — try the other sources before giving up.

    This is the difference between a radio that reflects what you're listening to
    and one that reflects JioSaavn's catalogue. Last.fm's similar-track list is
    genuinely good across Western and Indian music, but every name missing from
    JioSaavn used to be dropped on the floor — so seeding from, say, a metal track
    returned a handful of songs and then dried up.

    SoundCloud is tried before YouTube: it's cheaper to search and its hits are
    already direct streams. Either returns None when the host has it disabled.
    """
    from components.source_merger import SourceType

    name, art = pair
    q = f"{name} {art}".strip()
    for source_type, label in (
        (SourceType.SOUNDCLOUD, "soundcloud"),
        (SourceType.YOUTUBE, "youtube"),
    ):
        try:
            client = _svc()._get_client(source_type)
            if client is None:
                continue          # source switched off on this device
            hits = client.search(q, 1)
            if hits:
                return {"source_type": label, **hits[0].to_dict()}
        except Exception:
            continue
    return None


def resolve_radio(title, artist, limit=12):
    """Return up to `limit` playable similar tracks as plain dicts
    (UnifiedTrack.to_dict shape, ready for the frontend to queue)."""
    pairs = lastfm_similar(title, artist, limit + 12)  # over-fetch for skips + diversity

    with ThreadPoolExecutor(max_workers=8) as ex:
        resolved = list(ex.map(_resolve, pairs)) if pairs else []

    raw = [r for r in resolved if r]

    # Only the names JioSaavn missed go to the slower sources, and only when we're
    # actually short — searching SoundCloud/YouTube for 20 names we don't need
    # would add seconds to every radio fetch for nothing.
    if len(raw) < limit:
        missed = [p for p, r in zip(pairs, resolved) if not r]
        need = limit - len(raw)
        if missed and need > 0:
            with ThreadPoolExecutor(max_workers=6) as ex:
                for extra in ex.map(_resolve_elsewhere, missed[: need + 4]):
                    if extra:
                        raw.append(extra)

    # Fallback: Last.fm had nothing (obscure/regional track). Pull more songs
    # by the same primary artist straight from JioSaavn so radio still flows.
    if len(raw) < 3:
        primary = _primary_artist(artist)
        if primary:
            try:
                extra = _jiosaavn().search(primary, limit=limit + 4)
                have = {r.get("url") for r in raw}
                for s in extra:
                    d = s.to_dict()
                    # skip the seed song itself and dups
                    if d.get("url") in have or (d.get("title", "").lower() == (title or "").lower()):
                        continue
                    raw.append({"source_type": "jiosaavn", **d})
            except Exception:
                pass

    if not raw:
        return []

    # The merger takes one list per source, so bucket by where each hit came from.
    # Passing a SoundCloud dict in as jiosaavn_results would mis-key its URL and
    # the track would come out unplayable.
    buckets = {}
    for r in raw:
        buckets.setdefault(f"{r.get('source_type', 'jiosaavn')}_results", []).append(r)

    merged = SourceMerger().merge_search_results(**buckets)
    # Keep only tracks that ended up with a real playable source
    out = [t.to_dict() for t in merged if getattr(t, "primary_source", None)]
    # Interleave artists + cap per-artist so the radio doesn't loop one artist.
    return _diversify(out, limit)


if __name__ == "__main__":
    # Runnable self-check for the non-trivial transform: a raw JioSaavn result
    # must merge into a playable track dict (no network needed).
    raw = [{
        "source_type": "jiosaavn",
        "id": "abc", "title": "Channa Mereya", "artist": "Arijit Singh",
        "album": "Ae Dil Hai Mushkil",
        "image_url": "https://c.saavncdn.com/x/Channa-500x500.jpg",
        "url": "https://www.jiosaavn.com/song/channa-mereya/xyz",
        "duration": 289, "duration_sec": 289,
    }]
    merged = SourceMerger().merge_search_results(jiosaavn_results=raw)
    dicts = [t.to_dict() for t in merged if getattr(t, "primary_source", None)]
    assert dicts, "merge produced no playable track"
    t = dicts[0]
    assert t["sources"].get("jiosaavn", {}).get("url"), "missing jiosaavn stream url"
    assert t["primary_source"] == "jiosaavn", "primary_source not set"
    print("radio self-check OK:", t["title"], "-", t["artist"])

    # _diversify: must interleave artists and cap per-artist (no network).
    sample = (
        [{"title": f"A{i}", "artist": "Artist A"} for i in range(5)] +
        [{"title": f"B{i}", "artist": "Artist B"} for i in range(5)] +
        [{"title": f"C{i}", "artist": "Artist C"} for i in range(5)]
    )
    div = _diversify(sample, limit=9, max_per_artist=3)
    assert len(div) == 9, f"expected 9, got {len(div)}"
    from collections import Counter as _C
    counts = _C(_primary_artist(x["artist"]) for x in div)
    assert all(v <= 3 for v in counts.values()), f"per-artist cap violated: {counts}"
    assert div[0]["artist"] != div[1]["artist"], "not interleaved"
    print("diversify self-check OK:", [x["title"] for x in div])
