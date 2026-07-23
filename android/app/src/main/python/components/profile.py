"""
Artist & Album profiles
========================
Assemble RICH artist/album pages from multiple sources, best-effort merged.

Playable content comes JioSaavn-first (direct perma_urls — instantly playable).
When JioSaavn is thin (e.g. Western catalog where its artist/album lists come
back empty), we fall back to Last.fm top-tracks / iTunes discography and resolve
each name to a playable JioSaavn stream (the exact pattern radio.py uses).

Rich metadata (the "profile" feel) is merged across sources so a gap in one is
filled by another:
  - image  : TheAudioDB HD  > JioSaavn > iTunes
  - bio    : TheAudioDB EN  > Last.fm  > JioSaavn
  - genre  : TheAudioDB / Last.fm tags
  - founded/country : TheAudioDB
  - listeners / tags / similar artists : Last.fm
  - discography (albums grid) : JioSaavn topAlbums + iTunes albums

ponytail: networked best-effort assembly. Ceiling = source coverage gaps; every
field degrades to empty/None independently and never aborts the page. Upgrade
path: add a real ISRC/MusicBrainz link step for canonical discographies.
"""

import os
import re
import json
import html
import threading
import unicodedata
from concurrent.futures import ThreadPoolExecutor

import requests

from components.source_merger import SourceMerger
# Reuse the shared singletons + helpers radio already battle-tested.
from components.radio import _jiosaavn, _lastfm, _primary_artist, _resolve

# ponytail: TheAudioDB public test key "2". Ceiling: shared/rate-limited test key.
# Upgrade path: set TADB_API_KEY to a Patreon key for production.
TADB_KEY = os.getenv("TADB_API_KEY", "2")
TADB_URL = f"https://www.theaudiodb.com/api/v1/json/{TADB_KEY}"

_JS_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    "Referer": "https://www.jiosaavn.com/",
    "Accept": "application/json",
}
_JS_API = "https://www.jiosaavn.com/api.php"

# ponytail: simple in-memory profile cache — profiles barely change, so this
# makes repeat visits instant. Ceiling: unbounded + lost on restart; fine for a
# desktop app session. Upgrade path: TTL + size cap if it ever grows large.
_cache = {}
_cache_lock = threading.Lock()


def _clean(s):
    """Unescape HTML entities JioSaavn returns (&quot;, &amp;, ...)."""
    if not s:
        return ""
    return html.unescape(str(s)).strip()


def _js_bio(raw):
    """JioSaavn artist `bio` arrives as a JSON-encoded list of
    {text, title, sequence} sections (sometimes already a list) — NOT plain
    text. Flatten the section texts in order. Falls back to a plain unescaped
    string for non-JSON bios."""
    if not raw:
        return ""
    data = raw
    if isinstance(raw, str):
        s = raw.strip()
        if not s.startswith("[") and not s.startswith("{"):
            return _clean(s)
        try:
            data = json.loads(s)
        except (ValueError, TypeError):
            return _clean(s)
    if isinstance(data, dict):
        data = [data]
    if isinstance(data, list):
        parts = [_clean(sec.get("text")) for sec in data
                 if isinstance(sec, dict) and sec.get("text")]
        return "\n\n".join(p for p in parts if p)
    return _clean(data)


def _jcall(params):
    """Single JioSaavn api.php GET. Returns parsed dict/list or {} on failure."""
    import urllib.parse
    base = {"_format": "json", "_marker": "0", "ctx": "web6dot0"}
    url = f"{_JS_API}?{urllib.parse.urlencode({**base, **params})}"
    try:
        return requests.get(url, headers=_JS_HEADERS, timeout=12).json()
    except Exception:
        return {}


def _ratio(a, b):
    """Fuzzy similarity 0..100 between two names (token-set, case-insensitive)."""
    try:
        from rapidfuzz import fuzz
        return fuzz.token_set_ratio((a or "").lower(), (b or "").lower())
    except Exception:
        a, b = (a or "").lower(), (b or "").lower()
        return 100 if a and a == b else (60 if a and (a in b or b in a) else 0)


def _plain_ratio(a, b):
    """Length-sensitive ratio (penalizes extra words, unlike token_set)."""
    try:
        from rapidfuzz import fuzz
        return fuzz.ratio((a or "").lower(), (b or "").lower())
    except Exception:
        return _ratio(a, b)


def _score_artist(query, title):
    """Rank a JioSaavn artist hit against the query, penalizing collaborations
    so e.g. 'Arijit Singh' beats 'Pritam & Arijit Singh' and 'The Weeknd' beats
    'Gesaffelstein & The Weeknd'. token_set_ratio alone scores subsets as 100,
    which is exactly why the naive pick was wrong."""
    q = (query or "").lower().strip()
    t = (title or "").lower().strip()
    if not t:
        return -1
    if q == t:
        return 1000  # exact match always wins
    score = _plain_ratio(q, t)
    qtok, ttok = set(q.split()), set(t.split())
    if qtok and qtok <= ttok:
        score += 50  # all query words present (e.g. "the weeknd" ⊆ title)
    # Collaboration / extra-artist penalty: a "&" or "," in the title (but not
    # the query) signals a joint credit, rarely the canonical solo artist.
    collab = any(c in t for c in ["&", ",", " feat", " ft", " x "])
    q_collab = any(c in q for c in ["&", ",", " feat", " ft"])
    if collab and not q_collab:
        score -= 40
    return score


def _credits(name, artist_str):
    """True if `artist_str` plausibly credits the artist `name` (handles duets /
    multi-artist credit strings). Used to verify that resolved fallback songs
    actually belong to the artist: a SoundCloud uploader / compilation channel
    (e.g. "HouseNatic") resolves its scrobbled titles to real-but-unrelated
    JioSaavn songs whose credits never match the channel name, so they're
    correctly rejected instead of fabricating a profile from them."""
    a = (name or "").lower().strip()
    t = (artist_str or "").lower().strip()
    if not a or not t:
        return False
    if a in t or t in a:
        return True
    return _ratio(name, artist_str) >= 80


def _credits_exact(name, artist_str):
    """Strict version of _credits: one of the credited artists must BE the same
    artist (length-sensitive via _same_artist_name), not merely contain the name
    as a substring. Used for the Last.fm fallback blend so an ambiguous name
    ("Priya") can't be populated from a popular namesake's songs ("Priya
    Saraiya")."""
    for part in re.split(r"[,&/]| feat\.?| ft\.?| x ", artist_str or "", flags=re.IGNORECASE):
        if _same_artist_name(name, part.strip()):
            return True
    return False


def _strip_name(s):
    """Lowercase, strip diacritics, drop every non-alphanumeric char.
    'Beyoncé' → 'beyonce', 'A.R. Rahman' → 'arrahman', 'ColdPlay Wu' → 'coldplaywu'."""
    s = unicodedata.normalize("NFKD", (s or "").lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]", "", s)


def _same_artist_name(a, b):
    """True only if two names denote the SAME artist. Accent- and
    punctuation-insensitive, but otherwise EXACT — a one-letter difference is a
    DIFFERENT artist. This is the gate for resolving a credited name to a
    canonical artist (and for trusting a source's by-name lookup).

    Exactness matters: fuzzy matching merged distinct artists — "Codeplay",
    "Coolplay" and "ColdPlay Wu" all scored ~88 against "Coldplay" and wrongly
    inherited Coldplay's page/photo. "A.R. Rahman" == "AR Rahman" and "Beyoncé"
    == "Beyonce" still hold because diacritics/punctuation are normalized away."""
    na, nb = _strip_name(a), _strip_name(b)
    return bool(na) and na == nb


def _norm_title(t):
    """Aggressive title key for de-duping the SAME song repeated across
    compilations ('Oh! Carol' / 'Oh Carol' / 'Oh ! Carol' → 'ohcarol')."""
    return re.sub(r"[^a-z0-9]", "", (t or "").lower())


def _is_combo(name):
    """True if a name is a collaboration / combined credit ("A & B", "A, B",
    "A feat B", "A and B") rather than a standalone artist. Hyphenated duos like
    "Sachin-Jigar" are NOT combos (no separator below matches a bare hyphen)."""
    low = (name or "").lower()
    if any(sep in low for sep in [",", ";", "|", " & ", " feat", " ft.", " ft ", " x "]):
        return True
    # " and " usually joins two credited artists ("Hans Zimmer and Heitor
    # Pereira"), but it's also part of band names ("Florence and the Machine").
    # Treat as a combo only when the part after "and" is NOT an article-led band
    # fragment (the/his/her/their/los/las/le/la/der/die/das).
    # ponytail: word-level heuristic. Ceiling = article-less duos ("Hall and
    # Oates", "Simon and Garfunkel") are wrongly dropped; upgrade path is a
    # known-artist lookup to confirm both halves are real solo artists.
    m = re.search(r"\band\s+(.+)$", low)
    if m and not re.match(r"(the|his|her|their|los|las|le|la|der|die|das)\b", m.group(1).strip()):
        return True
    return False


def _token_from_url(url):
    """Last path segment of a JioSaavn entity URL = its API token."""
    return (url or "").rstrip("/").split("/")[-1]


def _song_to_raw(s):
    """Normalize a JioSaavn song object (from autocomplete / album-details /
    artist-topSongs — three different shapes) into the raw dict SourceMerger
    expects (JioSaavnSong.to_dict shape). Returns None if not a playable song."""
    if not isinstance(s, dict):
        return None
    mi = s.get("more_info") or {}
    am = mi.get("artistMap") or {}
    # title lives in 'title' (autocomplete/artist) or 'song' (album-details flat)
    title = _clean(s.get("title") or s.get("song"))
    album = _clean(s.get("album") or mi.get("album"))
    # Prefer explicit credits / artistMap. JioSaavn artist-page topSongs often
    # have NO primary_artists and only a 'subtitle' shaped "Artist - Album",
    # which previously polluted the artist field (e.g. "Neil Sedaka - Rockin'
    # With Sedaka") and broke "Go to artist". Use subtitle only as a last
    # resort, stripping a trailing "- <album>".
    map_artists = ", ".join(
        a.get("name", "") for a in (am.get("primary_artists") or am.get("artists") or [])
        if isinstance(a, dict) and a.get("name")
    )
    artist = _clean(
        s.get("primary_artists") or s.get("singers")
        or mi.get("primary_artists") or mi.get("artistMap_str") or map_artists
    )
    if not artist:
        sub = _clean(s.get("subtitle"))
        if album and sub.lower().endswith(album.lower()):
            sub = sub[: -len(album)].rstrip(" -–·\t").strip()
        artist = sub
    # Some JioSaavn titles carry a redundant leading "Artist - " prefix
    # ("Neil Sedaka - Oh Carol"). Strip it when it matches the credited artist
    # (also lets such entries de-dupe against the clean title).
    if artist and title.lower().startswith(artist.lower() + " - "):
        title = title[len(artist) + 3:].strip()
    url = s.get("perma_url") or s.get("url") or ""
    # Only /song/ URLs are directly playable; albums/playlists are not.
    if "/song/" not in url:
        return None
    duration = s.get("duration") or mi.get("duration")
    try:
        duration = int(duration) if duration is not None else None
    except (ValueError, TypeError):
        duration = None
    return {
        "source_type": "jiosaavn",
        "id": str(s.get("id", "")),
        "title": title,
        "artist": artist,
        "album": album,
        "image_url": s.get("image", ""),
        "url": url,
        "duration": duration,
        "duration_sec": duration,
        "year": s.get("year"),
        "language": s.get("language") or mi.get("language"),
    }


def _track_art(track):
    """Best artwork URL from a track dict (SourceMerger to_dict uses the
    `artwork_urls` size->URL map; there is no single `artwork_url` key)."""
    au = (track or {}).get("artwork_urls") or {}
    for v in au.values():
        if isinstance(v, str) and v:
            return v
    return (track or {}).get("artwork_url") or ""


def _make_playable(raw_songs):
    """Run raw JioSaavn song dicts through SourceMerger → frontend track dicts."""
    raw = [r for r in (raw_songs or []) if r]
    if not raw:
        return []
    merged = SourceMerger().merge_search_results(jiosaavn_results=raw)
    return [t.to_dict() for t in merged if getattr(t, "primary_source", None)]


# ── Multi-source fallback (used only AFTER a JioSaavn miss) ──────────────────
# A lazily-built search service restricted to the PLAYABLE sources, so a track
# JioSaavn doesn't have can still be found on SoundCloud / YouTube. YouTube
# *search* needs no cookies; streaming uses the user's connected cookies at
# playback time (see _resolve_stream_url) — so this works regardless.
_fb_service = None
_fb_lock = threading.Lock()


def _fallback_search_service():
    global _fb_service
    with _fb_lock:
        if _fb_service is None:
            from components.unified_search import UnifiedSearchService, SearchConfig
            from components.source_merger import SourceType
            cfg = SearchConfig(
                enabled_sources={SourceType.JIOSAAVN, SourceType.SOUNDCLOUD, SourceType.YOUTUBE},
                max_results_per_source=5,
                max_total_results=8,
                timeout_seconds=12.0,
            )
            _fb_service = UnifiedSearchService(config=cfg)
        return _fb_service


def _same_song(name, artist, d):
    """Guard against the fallback substituting a WRONG same-ish song: the found
    track's title must (fuzzily / by-substring) match the requested name AND,
    when both artists are known, share at least one word. Mirrors the frontend
    matchesTrack safety net so an album never fills with imposters."""
    title = d.get("title") or ""
    if _plain_ratio(name, title) < 80 and _norm_title(name) not in _norm_title(title):
        return False
    da = d.get("artist") or ""
    if not artist or not da:
        return True  # no artist to corroborate → trust the title match
    aw = {w for w in re.split(r"[^a-z0-9]+", artist.lower()) if len(w) > 1}
    dw = {w for w in re.split(r"[^a-z0-9]+", da.lower()) if len(w) > 1}
    return bool(aw & dw)


def _resolve_multi(name, artist):
    """Fallback resolver for ONE (name, artist) JioSaavn couldn't find: full
    multi-source search → the best PLAYABLE match as a finished frontend track
    dict, or None. Called only after _resolve (JioSaavn) misses."""
    q = f"{name} {artist}".strip()
    if not q:
        return None
    try:
        results = _fallback_search_service().search(q)
    except Exception:
        return None
    for t in results:
        d = t.to_dict() if hasattr(t, "to_dict") else t
        srcs = d.get("sources") or {}
        if not any((srcs.get(s) or {}).get("url")
                   for s in ("jiosaavn", "soundcloud", "youtube", "youtube_music")):
            continue
        if _same_song(name, artist, d):
            return d
    return None


def _resolve_names(pairs, limit):
    """Resolve (name, artist) pairs to playable tracks, preserving order.

    JioSaavn first (fast, our primary source — UNCHANGED happy path). For any
    pair JioSaavn can't find, fall back to a full multi-source search
    (SoundCloud/YouTube) — but ONLY after the JioSaavn miss, so tracks that ARE
    on JioSaavn pay zero extra latency. This is what lets Western/electronic
    albums whose songs aren't on JioSaavn (e.g. anjunadeep releases) resolve via
    YouTube/SoundCloud instead of coming back empty.

    ponytail: the fallback adds one multi-source search per missed track (capped
    by `limit + 6` and parallelized). Ceiling: a fully-non-JioSaavn album of N
    tracks does N searches (~slower first load, then cached). Happy path (all on
    JioSaavn) is byte-for-byte the old behavior plus a no-op empty-misses check."""
    if not pairs:
        return []
    sub = pairs[: limit + 6]
    with ThreadPoolExecutor(max_workers=8) as ex:
        js_raw = list(ex.map(_resolve, sub))   # raw jiosaavn dict | None, aligned with sub

    # Accept a JioSaavn hit ONLY if it's actually THIS song. JioSaavn's search
    # returns an arbitrary top match for off-catalog names (e.g. "In Peace /
    # Cold Blue" → "Blue Flags / Cold Like Minnesota"), which would silently fill
    # an album with imposters. A mismatch counts as a MISS → multi-source
    # fallback finds the real track on SoundCloud/YouTube.
    slots = [None] * len(sub)
    missed = []
    for i, (r, (name, artist)) in enumerate(zip(js_raw, sub)):
        if r:
            m = _make_playable([r])
            if m and _same_song(name, artist, m[0]):
                slots[i] = m[0]
                continue
        missed.append(i)

    # Multi-source fallback for the misses (parallel). Only runs AFTER JioSaavn
    # missed (or returned the wrong song), so on-JioSaavn tracks pay nothing.
    if missed:
        with ThreadPoolExecutor(max_workers=6) as ex:
            for i, d in zip(missed, ex.map(lambda i: _resolve_multi(*sub[i]), missed)):
                if d:
                    slots[i] = d

    # Preserve original (tracklist) order; drop unresolved slots.
    return [t for t in slots if t][:limit]


# ──────────────────────────── enrichment sources ────────────────────────────

def _audiodb_artist(name):
    """TheAudioDB artist lookup → HD images, bio, genre, founded year, country."""
    try:
        d = requests.get(f"{TADB_URL}/search.php", params={"s": name}, timeout=10).json()
    except Exception:
        return {}
    arts = (d or {}).get("artists") or []
    if not arts:
        return {}
    a = arts[0]
    return {
        "image": a.get("strArtistThumb") or "",
        "banner": a.get("strArtistFanart") or a.get("strArtistWideThumb") or "",
        "logo": a.get("strArtistLogo") or "",
        "bio": (a.get("strBiographyEN") or "").strip(),
        "genre": a.get("strGenre") or a.get("strStyle") or "",
        "founded": a.get("intFormedYear") or a.get("intBornYear") or "",
        "country": a.get("strCountry") or "",
    }


def _lastfm_artist(name):
    """Last.fm artist.getInfo → listeners, tags, bio, similar artists."""
    d = _lastfm("artist.getinfo", artist=name)
    a = (d or {}).get("artist") or {}
    if not a:
        return {}
    # Last.fm autocorrects "Codeplay" → "Coldplay" and returns a DIFFERENT
    # artist's bio/listeners/similar. Trust it only on an exact-name match.
    if not _same_artist_name(name, a.get("name", "")):
        return {}
    stats = a.get("stats") or {}
    tags = [t["name"] for t in (a.get("tags") or {}).get("tag", []) if t.get("name")]
    similar = [
        {"name": s.get("name", ""),
         "image": next((i.get("#text") for i in s.get("image", []) if i.get("size") == "large" and i.get("#text")), "")}
        for s in (a.get("similar") or {}).get("artist", []) if s.get("name")
    ]
    bio = ((a.get("bio") or {}).get("content") or "").split("<a ")[0].strip()
    return {
        "listeners": int(stats["listeners"]) if str(stats.get("listeners", "")).isdigit() else None,
        "tags": tags,
        "bio": bio,
        "similar": similar,
    }


def _lastfm_top_tracks(name, limit):
    """Last.fm artist.getTopTracks → (track, artist) name pairs (Western fallback)."""
    d = _lastfm("artist.gettoptracks", artist=name, limit=limit)
    return [(t.get("name"), name) for t in (d.get("toptracks", {}) or {}).get("track", []) if t.get("name")]


def _itunes_albums(name, limit=12):
    """iTunes artist→albums (clean Western discography). Returns album card dicts."""
    try:
        from components.itunes_client import iTunesClient
        c = iTunesClient()
        artists = c.search_artists(name, limit=1)
        if not artists:
            return []
        # Name-gate: iTunes fuzzy-matches "Codeplay"/"Coolplay" → "Coldplay" and
        # would return the WRONG artist's whole discography. Only trust an
        # exact-name match.
        if not _same_artist_name(name, artists[0].name):
            return []
        lk = c._lookup({"id": artists[0].artist_id, "entity": "album", "limit": limit})
        out = []
        for r in lk.get("results", []):
            if r.get("wrapperType") != "collection":
                continue
            art100 = r.get("artworkUrl100", "")
            out.append({
                "name": _clean(r.get("collectionName")),
                "artist": _clean(r.get("artistName")),
                "image": art100.replace("100x100", "600x600"),
                "album_id": "",  # iTunes id isn't a JioSaavn id; navigate by name
                "year": (r.get("releaseDate") or "")[:4],
                "source": "itunes",
            })
        return out
    except Exception:
        return []


def _url_ok(url):
    """True if an image URL is actually reachable. Some JioSaavn CDN cover
    links are dead 404s (e.g. older soundtracks), so we validate before trusting
    them. Fetches a single byte to stay cheap."""
    if not url:
        return False
    try:
        r = requests.get(url, headers={"User-Agent": "Mozilla/5.0", "Range": "bytes=0-0"},
                         timeout=5, stream=True)
        ok = r.status_code in (200, 206)
        r.close()
        return ok
    except Exception:
        return False


def _itunes_album_cover(name, artist=""):
    """Best 600px album cover from iTunes for (name, artist), or '' — a reliable
    fallback when JioSaavn returns a dead/low-res cover link. Name-match gated."""
    try:
        from components.itunes_client import iTunesClient
        c = iTunesClient()
        for al in c.search_albums(f"{name} {artist}".strip(), limit=5):
            if _ratio(name, al.name) >= 65 and al.artwork_url_100:
                return al.artwork_url_100.replace("100x100", "600x600")
    except Exception:
        pass
    return ""


# Derivative / not-the-artist names: tribute bands, karaoke, cover &
# instrumental renditions, etc. They have real catalog pages (a fan count alone
# won't filter them) but they're never the artist a user means when searching.
_NONARTIST_RE = re.compile(
    r"\b(tribute|karaoke|covers|cover band|instrumental|lullab(?:y|ies)|"
    r"piano (?:cover|version|tribute)|made famous|made popular|originally performed|"
    r"in the style of|8[\s-]?bit|ringtone|workout|meditation|mindfulness|"
    r"backing track|string quartet|"
    # Compilation / playlist / "various artists" accounts — real catalog
    # entities with fan counts, but NOT artists ("Pop Hits", "Top 40 Pop Hits",
    # "Ultimate Pop Hits", "Hits Variété Pop", "Various Artists", "Megamix"…).
    r"hits|various artists|compilation|mega ?mix|non[\s-]?stop|top \d+|"
    r"dance party|the collection)\b", re.I)


def _is_nonartist(name):
    """True for derivative 'artists' (tribute/karaoke/cover/instrumental/…) — real
    catalog entities, but never the artist the user searched for."""
    return bool(_NONARTIST_RE.search(name or ""))


def _jiosaavn_artist_real(name):
    """STRICT existence check: does JioSaavn list an artist whose name (near-)
    EQUALS `name`? Unlike _credits (which substring-matches both ways), this uses
    a length-sensitive ratio, so concatenated autocomplete junk like "Yellow
    Coldplay" / "Coldplay Chris Martin" — whose songs are merely credited
    "Coldplay" — is REJECTED, while a real artist JioSaavn lists by (almost) this
    exact name passes. ~1 network call; used to vet JioSaavn-only search hits."""
    name = (name or "").strip()
    if not name:
        return False
    sr = _jcall({"__call": "search.getResults", "q": name, "p": "1", "n": "4",
                 "api_version": "4"})
    results = sr.get("results", []) if isinstance(sr, dict) else []
    for s in results:
        mi = s.get("more_info") or {}
        am = mi.get("artistMap") or {}
        for a in (am.get("primary_artists") or am.get("artists") or []):
            if _plain_ratio(name, a.get("name", "")) >= 85:
                return True
    return False


def _artist_has_content(name):
    """Quick single-call check: does JioSaavn have songs that actually credit
    this artist? A cheap proxy for "we can open a real profile" — used to gate
    'Fans also like' so we never show dead-end cards (a Last.fm similar-artist
    edge can name someone we have zero playable data for). ~1 network call;
    keeps faceless-but-playable artists (e.g. "TM3"), drops empty names."""
    name = (name or "").strip()
    if not name:
        return False
    sr = _jcall({"__call": "search.getResults", "q": name, "p": "1", "n": "4", "api_version": "4"})
    results = sr.get("results", []) if isinstance(sr, dict) else []
    for s in results:
        mi = s.get("more_info") or {}
        am = mi.get("artistMap") or {}
        cand = [a.get("name", "") for a in (am.get("primary_artists") or am.get("artists") or [])]
        cand.append((s.get("subtitle") or "").split(" - ")[0])
        if any(_credits(name, c) for c in cand):
            return True
    return False


def _deezer_search_artists(query, limit):
    """Deezer artist index → [{name, image, fans}] (Western coverage + photos)."""
    try:
        r = requests.get("https://api.deezer.com/search/artist",
                         params={"q": query, "limit": limit + 8}, timeout=8)
        data = (r.json() or {}).get("data", [])
    except Exception:
        return []
    out = []
    for a in data:
        nm = _clean(a.get("name"))
        if nm:
            out.append({
                "name": nm,
                "image": a.get("picture_xl") or a.get("picture_big") or a.get("picture_medium") or "",
                "fans": a.get("nb_fan"),
            })
    return out


def _jiosaavn_search_artists(query, limit):
    """JioSaavn autocomplete artists → [{name, image, fans=None}]. Indian-catalog
    coverage + typo tolerance (matches "Shankar–Ehsaan–Loy" for "shankar ehsan
    loy"). No fan counts here — ranking handles that."""
    ac = _jcall({"__call": "autocomplete.get", "query": query})
    hits = (ac.get("artists", {}) or {}).get("data", []) if isinstance(ac, dict) else []
    out = []
    for h in hits[: limit + 4]:
        nm = _clean(h.get("title"))
        if nm:
            out.append({"name": nm, "image": h.get("image", ""), "fans": None})
    return out


def search_artists(query, limit=10):
    """Real artist search for the search page's Artists section.

    Two complementary sources, merged + de-duped:
      • Deezer artist index — Western coverage, photos, fan counts.
      • JioSaavn autocomplete artists — Indian catalog + typo tolerance.
    Collaboration entities ("A & B") are dropped, and the SAME artist written
    with different punctuation ("Shankar Ehsaan Loy" / "Shankar-Ehsaan-Loy" /
    "Shankar - Ehsaan - Loy") is collapsed to one (normalized-name key). Ranked
    by popularity so the searched, real artist leads and low-fan tribute/cover
    accounts sink below the cut. Never raises."""
    query = (query or "").strip()
    if not query:
        return []
    with ThreadPoolExecutor(max_workers=2) as ex:
        f_dz = ex.submit(_deezer_search_artists, query, limit)
        f_js = ex.submit(_jiosaavn_search_artists, query, limit)
        dz, js = f_dz.result(), f_js.result()

    merged = {}
    _noise = lambda s: sum(1 for c in s if not c.isalnum() and not c.isspace())

    def _absorb(dst, a):
        """Fold variant `a` into kept entry `dst`: max fans, best image, and the
        more popular spelling (tie → the one with less punctuation)."""
        fa, fb = dst.get("fans"), a.get("fans")
        more_popular = (fb or 0) > (fa or 0)
        tie = (fb or 0) == (fa or 0)
        if more_popular or (tie and _noise(a["name"]) < _noise(dst["name"])):
            dst["name"] = a["name"]
        if not dst.get("image") and a.get("image"):
            dst["image"] = a["image"]
        if fa is None:
            dst["fans"] = fb
        elif fb is not None:
            dst["fans"] = max(fa, fb)

    for a in dz + js:  # Deezer first → its image/fans seed the entry
        nm = a["name"]
        if not nm or _is_combo(nm):
            continue
        key = re.sub(r"[^a-z0-9]", "", nm.lower())
        if not key:
            continue
        if key in merged:
            _absorb(merged[key], a)
        else:
            merged[key] = dict(a)

    # Collapse "First Middle Last" into an existing "First Last" — the same
    # person written with a middle name ("Hans Florian Zimmer" → "Hans Zimmer",
    # "John Towner Williams" → "John Williams"). Conservative: only when the
    # first+last of a 3+-token name exactly matches a kept 2-token artist.
    for key in list(merged.keys()):
        if key not in merged:
            continue
        toks = merged[key]["name"].split()
        if len(toks) >= 3:
            fl = re.sub(r"[^a-z0-9]", "", (toks[0] + toks[-1]).lower())
            if fl != key and fl in merged:
                _absorb(merged[fl], merged.pop(key))

    # ── Validate so we only surface REAL artists that open a profile with data
    # (the user's rule: no dead "Artist not available" cards). Three layers:
    #   1. combos ("A & B", "Berryman; …") and derivatives (tribute/karaoke/
    #      covers) are dropped by name.
    #   2. a famous Deezer artist is always kept (covers band members /
    #      "people also search", e.g. Chris Martin for "coldplay").
    #   3. everyone else must be RELEVANT to the query AND actually exist:
    #      Deezer entries already exist; JioSaavn-only hits (fans=None, the
    #      autocomplete junk like "Yellow Coldplay") are verified with a strict
    #      JioSaavn credit check that rejects concatenated non-artists.
    ql = query.lower()
    def _tok(s):
        return set(t for t in re.split(r"[^a-z0-9]+", (s or "").lower()) if t)
    qtok = _tok(query)
    FAME = 10000

    candidates = []  # (artist, needs_jiosaavn_check)
    for a in merged.values():
        name = a["name"]
        if _is_combo(name) or _is_nonartist(name):
            continue
        fans = a.get("fans") or 0
        # "Relevant" = the name actually CONTAINS the searched words — NOT a fuzzy
        # edit-distance lookalike. This separates "ColdPlay Wu" / "Arijit Singh"
        # (contain the query → keep) from "Coolplay" / "Codeplay" / "Coldgray"
        # (1-2 char misspellings of "coldplay" → drop). Those lookalikes are
        # often cover/sound-alike acts whose catalog mirrors the real artist's
        # titles, so they read as "wrong data". Searching an artist's REAL name
        # still shows them; misspellings of OTHER artists no longer pollute.
        contains_query = bool(qtok) and qtok <= _tok(name)
        if fans >= FAME:
            candidates.append((a, False))      # famous — survives a typo'd query too
        elif not contains_query:
            continue                           # low-fan lookalike → noise
        elif fans > 0:
            candidates.append((a, False))      # real Deezer artist that contains the query
        else:
            candidates.append((a, True))       # JioSaavn-only → verify it's real

    # Verify the JioSaavn-only candidates in parallel (cheap, ~1 call each).
    need_idx = [i for i, (_, need) in enumerate(candidates) if need]
    drop = set()
    if need_idx:
        with ThreadPoolExecutor(max_workers=min(6, len(need_idx))) as ex:
            oks = list(ex.map(lambda i: _jiosaavn_artist_real(candidates[i][0]["name"]), need_idx))
        drop = {need_idx[k] for k, ok in enumerate(oks) if not ok}
    final = [a for i, (a, _) in enumerate(candidates) if i not in drop]

    # Rank by popularity; fan-less (JioSaavn-only) entries get a relevance-based
    # pseudo-score so a strong name match isn't buried under a low-fan artist.
    def _eff_fans(a):
        f = a.get("fans")
        return f if f is not None else int(_plain_ratio(ql, a["name"].lower()) * 1000)
    return sorted(final, key=_eff_fans, reverse=True)[:limit]


def _jiosaavn_search_albums(query, limit):
    """JioSaavn album search → [{name, artist, image, album_id, perma_url, year}].
    Uses `search.getAlbumResults` (richer than autocomplete: it carries the
    artistMap, perma_url and 150x150 art, and already disambiguates editions like
    "Cocktail" vs "Cocktail 2"). `album_id` lets the click resolve the EXACT
    release (no name re-guessing)."""
    sr = _jcall({"__call": "search.getAlbumResults", "q": query, "p": "1",
                 "n": str(limit + 4), "api_version": "4"})
    hits = sr.get("results", []) if isinstance(sr, dict) else []
    out = []
    for h in hits:
        title = _clean(h.get("title"))
        if not title:
            continue
        mi = h.get("more_info") or {}
        am = mi.get("artistMap") or {}
        names = ", ".join(a.get("name", "") for a in (am.get("primary_artists") or [])
                          if isinstance(a, dict) and a.get("name"))
        out.append({
            "name": title,
            "artist": _clean(names or mi.get("music") or h.get("subtitle")),
            "image": (h.get("image") or "").replace("150x150", "500x500"),
            "album_id": str(h.get("id", "")),
            "perma_url": h.get("perma_url", ""),
            "year": str(h.get("year") or ""),
            "source": "jiosaavn",
        })
    return out


def _itunes_search_albums(query, limit):
    """iTunes album search → same card shape (Western coverage + reliable 600px
    art). No JioSaavn album_id — the click resolves these by name+artist (JioSaavn
    first, iTunes fallback), exactly like the existing "Go to album" path."""
    try:
        from components.itunes_client import iTunesClient
        albums = iTunesClient().search_albums(query, limit=limit + 4)
    except Exception:
        return []
    out = []
    for a in albums:
        nm = _clean(getattr(a, "name", ""))
        if not nm:
            continue
        art = getattr(a, "artwork_url_100", "") or ""
        out.append({
            "name": nm,
            "artist": _clean(getattr(a, "artist_name", "")),
            "image": art.replace("100x100", "600x600"),
            "album_id": "",
            "perma_url": "",
            "year": str(getattr(a, "release_year", "") or ""),
            "source": "itunes",
        })
    return out


def _jiosaavn_song_albums(query, limit):
    """Albums that actually CONTAIN songs matching the query (from JioSaavn SONG
    search). For a SONG-title query like "Naam Hai Tera" this surfaces the real
    parent album ("Aap Kaa Surroor") that a pure album-title search CANNOT find
    (the album title doesn't contain the song name — it returns only same-titled
    devotional covers). Each card carries `_rel` = how well its (top) song's
    TITLE matches the query, so it's scored on the same scale as a title match."""
    sr = _jcall({"__call": "search.getResults", "q": query, "p": "1",
                 "n": str(limit + 6), "api_version": "4"})
    results = sr.get("results", []) if isinstance(sr, dict) else []
    out, seen = [], set()
    for s in results:
        mi = s.get("more_info") or {}
        aid = str(mi.get("album_id") or "")
        aname = _clean(mi.get("album"))
        if not aid or aid in seen or not aname:
            continue
        seen.add(aid)
        am = mi.get("artistMap") or {}
        names = ", ".join(a.get("name", "") for a in (am.get("primary_artists") or [])
                          if isinstance(a, dict) and a.get("name"))
        out.append({
            "name": aname,
            "artist": _clean(names or mi.get("music") or s.get("subtitle")),
            "image": (s.get("image") or "").replace("150x150", "500x500"),
            "album_id": aid,
            "perma_url": "",        # album_id resolves it on click
            "year": str(s.get("year") or ""),
            "source": "jiosaavn",
            "_rel": _plain_ratio(query, _clean(s.get("title"))),  # song-title match
        })
    return out


def search_albums(query, limit=10):
    """Real album search for the search page's Albums section. THREE sources,
    merged + de-duped:
      • JioSaavn SONG search → the album each matching song belongs to. This is
        what makes a SONG-title query ("Naam Hai Tera") surface its REAL album
        ("Aap Kaa Surroor"); a pure album-title search returns only same-titled
        covers because the parent album's title doesn't contain the song name.
      • JioSaavn album-title search (`search.getAlbumResults`) — genuine
        album-name queries ("Cocktail").
      • iTunes album search — Western coverage + reliable art.
    Ranking is on ONE scale: how well the album matches the query by its BEST
    available title — the matching song's title for a song-album, or the album's
    own title for a title-album (whichever is higher). So "Naam Hai Tera" →
    "Aap Kaa Surroor" leads (its song is an exact match) while "Cocktail" →
    "Cocktail" leads (exact album title) over promo-single song-albums. De-duped
    by JioSaavn album_id (else name+artist). Compilations dropped. Never raises."""
    query = (query or "").strip()
    if not query:
        return []
    with ThreadPoolExecutor(max_workers=3) as ex:
        f_song = ex.submit(_jiosaavn_song_albums, query, limit)
        f_alb = ex.submit(_jiosaavn_search_albums, query, limit)
        f_it = ex.submit(_itunes_search_albums, query, limit)
        song, alb, it = f_song.result(), f_alb.result(), f_it.result()

    def _key(a):
        return ("id:" + a["album_id"]) if a.get("album_id") else \
            re.sub(r"[^a-z0-9]", "", (a["name"] + "|" + (a.get("artist") or "")).lower())

    merged = {}
    for a in song + alb + it:  # song-albums first → they seed the _rel signal
        nm = a["name"]
        if not nm or _is_nonartist(a.get("artist", "")):
            continue
        k = _key(a)
        if not k or k == "id:":
            continue
        if k in merged:
            dst = merged[k]
            if a.get("_rel") is not None:
                dst["_rel"] = max(dst.get("_rel") or 0, a["_rel"])
            if not dst.get("album_id") and a.get("album_id"):
                dst["album_id"], dst["perma_url"] = a["album_id"], a.get("perma_url", "")
            if not dst.get("image") and a.get("image"):
                dst["image"] = a["image"]
            if not dst.get("artist") and a.get("artist"):
                dst["artist"] = a["artist"]
            if not dst.get("year") and a.get("year"):
                dst["year"] = a["year"]
        else:
            merged[k] = dict(a)

    def _score(a):
        # Best of: how well the matched SONG's title fits the query (song-album)
        # vs how well the ALBUM's own title fits — same 0..100 scale. A direct
        # album-title match beats an equal indirect song-contains match (a small
        # -3 discount on the song signal), so query "Cocktail" prefers the
        # "Cocktail" album over an album that merely has a song named "Cocktail".
        title_score = _plain_ratio(query, a["name"])
        rel = a.get("_rel")
        score = (rel - 3) if (rel is not None and rel - 3 > title_score) else title_score
        return score + (20 if a.get("album_id") else 0)

    out = sorted(merged.values(), key=_score, reverse=True)[:limit]
    for a in out:
        a.pop("_rel", None)  # internal ranking signal — don't leak to the API
    return out


def _deezer_artist(name):
    """Deezer artist search → HD image (picture_xl) + fan count. Deezer's track
    search is geo-blocked for us, but artist search works and has the best free
    artist photos — so we use it purely for imagery + fan stats. Cached."""
    key = ("deezer", (name or "").lower().strip())
    with _cache_lock:
        if key in _cache:
            return _cache[key]
    out = {}
    try:
        r = requests.get("https://api.deezer.com/search/artist",
                         params={"q": name, "limit": 5}, timeout=8)
        for a in (r.json() or {}).get("data", [])[:5]:
            # Strict same-artist name match (length-sensitive) so an ambiguous
            # bare name ("Priya") never borrows the popular namesake's photo
            # ("Priya Saraiya").
            if _same_artist_name(name, a.get("name", "")):
                out = {
                    "image": a.get("picture_xl") or a.get("picture_big") or "",
                    "fans": a.get("nb_fan"),
                }
                break
    except Exception:
        pass
    with _cache_lock:
        _cache[key] = out
    return out


def _vet_similar(similar):
    """Filter 'Fans also like' to artists we can actually open + give a photo.

    Each similar artist gets a quick existence check (so we never show dead-end
    cards — a Last.fm similar edge can name someone with no openable profile)
    and, if it survives, its photo is filled from Deezer (Last.fm artist images
    are deprecated placeholders). Both run in one parallel pass. A faceless but
    playable artist (e.g. "TM3") is KEPT — we only drop the truly empty ones."""
    if not similar:
        return []
    def _vet(s):
        if not _artist_has_content(s["name"]):
            return None
        if not s.get("image"):
            s["image"] = _deezer_artist(s["name"]).get("image", "")
        return s
    with ThreadPoolExecutor(max_workers=8) as ex:
        return [r for r in ex.map(_vet, similar) if r]


# ──────────────────────────── public: ARTIST ────────────────────────────────

def _jiosaavn_artist_token(name):
    """Find the CANONICAL JioSaavn artist token for `name`.

    JioSaavn's autocomplete artist results are unreliable — they return
    collaboration entities ("Pritam & Arijit Singh" for "Arijit Singh",
    "Sunidhi Chauhan & Neeraj Shridhar" for "Neeraj Shridhar"). But a SONG
    search returns `more_info.artistMap` with each artist's real canonical id +
    perma_url. So we search songs and pull the best-matching artist's token.
    Returns '' when no confident match is found."""
    sr = _jcall({"__call": "search.getResults", "q": name, "p": "1", "n": "8", "api_version": "4"})
    results = sr.get("results", []) if isinstance(sr, dict) else []
    best_tok, best_name, best_score = "", "", -1
    for s in results:
        am = (s.get("more_info") or {}).get("artistMap") or {}
        candidates = (am.get("primary_artists") or []) + (am.get("artists") or [])
        for a in candidates:
            sc = _score_artist(name, a.get("name", ""))
            if sc > best_score:
                best_score = sc
                best_tok = _token_from_url(a.get("perma_url", ""))
                best_name = a.get("name", "")
    # Accept only a same-artist NAME match (length-sensitive). A bare "Priya"
    # must never resolve to a different, longer "Priya Saraiya" just because it's
    # a subset — that opened a stranger's profile. The credited name we navigate
    # from is JioSaavn's own, so the real artist matches near-exactly.
    if best_score >= 85 and _same_artist_name(name, best_name):
        return best_tok
    return ""


def _fetch_jiosaavn_artist(name):
    """Resolve `name` to its canonical JioSaavn artist page dict (or {}).
    Tries the reliable song→artistMap token first, then autocomplete."""
    token = _jiosaavn_artist_token(name)
    if not token:
        ac = _jcall({"__call": "autocomplete.get", "query": name})
        hits = (ac.get("artists", {}) or {}).get("data", []) if isinstance(ac, dict) else []
        if hits:
            best = max(hits, key=lambda h: _score_artist(name, h.get("title", "")))
            # Same strict same-artist-name gate as the song path — never accept a
            # subset/collab autocomplete hit ("Priya Saraiya" for "Priya",
            # "Pritam & Arijit Singh" for "Arijit Singh").
            if _same_artist_name(name, best.get("title", "")):
                token = _token_from_url(best.get("url", ""))
    if not token:
        return {}
    d = _jcall({
        "__call": "webapi.get", "token": token, "type": "artist",
        "p": "0", "n_song": "15", "n_album": "20", "api_version": "4",
    })
    return d if isinstance(d, dict) else {}


def _parse_albums(raw_albums):
    """JioSaavn topAlbums entries → album card dicts."""
    out = []
    for al in raw_albums or []:
        if not isinstance(al, dict):
            continue
        url = al.get("perma_url") or ""
        out.append({
            "name": _clean(al.get("title")),
            "artist": _clean(al.get("subtitle") or al.get("primary_artists")),
            "image": al.get("image", ""),
            "album_id": str(al.get("id", "")),
            "year": al.get("year") or "",
            "perma_url": url,
            "source": "jiosaavn",
        })
    return out


def get_artist(name):
    """Cached artist profile (see _build_artist)."""
    key = ("artist", (name or "").strip().lower())
    with _cache_lock:
        if key in _cache:
            return _cache[key]
    result = _build_artist(name)
    if result.get("name"):  # cache any real profile (incl. data-less ones); skip empty failures
        with _cache_lock:
            _cache[key] = result
    return result


def _build_artist(name):
    """Assemble a rich artist profile. Returns a dict (never raises).

    Strategy (rebuilt on real data): the canonical JioSaavn artist — resolved via
    song→artistMap tokens, NOT the unreliable autocomplete — is the primary
    source for playable top songs + albums and works great for Indian artists.
    Deezer provides the best free artist photos (incl. for "fans also like",
    where Last.fm images are dead). TheAudioDB/Last.fm fill bio + genre +
    similar-artist names + listeners. Western artists fall back to Last.fm top
    tracks resolved to playable streams. Every field degrades independently."""
    name = (name or "").strip()
    if not name:
        return {}

    # Fetch all sources in parallel — JioSaavn page, Deezer image/fans,
    # TheAudioDB bio, Last.fm info + top tracks, and iTunes discography. iTunes
    # doesn't depend on the JioSaavn result, so running it here (rather than
    # after) makes its richer data free latency-wise.
    with ThreadPoolExecutor(max_workers=6) as ex:
        f_js = ex.submit(_fetch_jiosaavn_artist, name)
        f_dz = ex.submit(_deezer_artist, name)
        f_tadb = ex.submit(_audiodb_artist, name)
        f_lfm = ex.submit(_lastfm_artist, name)
        f_top = ex.submit(_lastfm_top_tracks, name, 18)
        f_it = ex.submit(_itunes_albums, name, 14)
        js, dz, tadb, lfm, lfm_top, itunes_albums = (
            f_js.result(), f_dz.result(), f_tadb.result(),
            f_lfm.result(), f_top.result(), f_it.result())

    display_name = _clean(js.get("name")) or _clean(name)

    # ── playable top songs ──────────────────────────────────────
    # Primary: canonical JioSaavn topSongs (correct + directly playable, fast).
    js_top_raw = js.get("topSongs")
    js_top_raw = js_top_raw if isinstance(js_top_raw, list) else (js_top_raw or {}).get("songs", []) if isinstance(js_top_raw, dict) else []
    page_songs = _make_playable([_song_to_raw(s) for s in js_top_raw])
    # A canonical JioSaavn artist page is proof this is a real artist; its songs
    # are the artist's by definition (incl. music-director pages credited to the
    # singers), so they are NOT credit-filtered below.
    canonical = bool(page_songs)

    # De-dupe the SAME song repeated across compilations (normalized title key).
    # Some entities return 15× "Oh Carol" from different hits albums — collapse
    # them so the page isn't all one song.
    top_songs, seen_titles = [], set()
    for t in page_songs:
        k = _norm_title(t["title"])
        if k and k not in seen_titles:
            seen_titles.add(k)
            top_songs.append(t)

    # If the canonical page is thin OR collapsed to a few distinct songs (junk /
    # compilation entity like Neil Sedaka's), blend Last.fm popularity (resolved
    # to playable JioSaavn) for real variety. Credit-filtered so a mis-scrobbled
    # name (e.g. the "HouseNatic" channel) can't sneak unrelated songs in.
    if len(top_songs) < 8 and lfm_top:
        for t in _resolve_names(lfm_top, 16):
            k = _norm_title(t["title"])
            if k and k not in seen_titles and _credits_exact(display_name, t.get("artist")):
                seen_titles.add(k)
                top_songs.append(t)
    top_songs = top_songs[:16]

    # Identity gate: no canonical JioSaavn artist AND nothing we resolved
    # actually credits this name. Before giving up, check for a CONFIDENT
    # real-artist identity: an EXACT-name Deezer artist with a real fanbase
    # (e.g. "ColdPlay Wu", an independent act we have no playable songs for).
    # If present, fall through and return a minimal profile (name + photo +
    # followers) so the artist is still browsable. Otherwise it's an
    # unverifiable name (a SoundCloud uploader / compilation channel) → return
    # empty so the UI shows "Artist not available".
    # ponytail: trusts a canonical JioSaavn token OR an exact-name Deezer artist
    # as proof-of-real. Ceiling: a real artist absent from BOTH JioSaavn and
    # Deezer reads as unavailable. Upgrade path: a MusicBrainz existence check.
    if not canonical and not top_songs:
        if not (dz.get("image") and (dz.get("fans") or 0) > 0):
            return {}

    # ── albums (discography): JioSaavn canonical + iTunes (clean) ──
    js_alb = js.get("topAlbums")
    js_alb = js_alb if isinstance(js_alb, list) else (js_alb or {}).get("albums", []) if isinstance(js_alb, dict) else []
    albums = _parse_albums(js_alb)
    # Always merge iTunes' clean discography (fetched in parallel above → no
    # extra latency): richer covers + Western releases JioSaavn misses.
    seen = {a["name"].lower() for a in albums}
    for a in itunes_albums:
        if a["name"].lower() not in seen:
            seen.add(a["name"].lower())
            albums.append(a)

    # ── merged header metadata (best of each source) ────────────
    bios = [b for b in (tadb.get("bio"), lfm.get("bio"), _js_bio(js.get("bio"))) if b and len(b) > 5]
    bio = max(bios, key=len) if bios else ""

    # Image: JioSaavn first — its artist page is resolved via song→artistMap
    # tokens, so the identity is CERTAIN; Deezer/TheAudioDB match by NAME and
    # can borrow a same-named artist's photo (seen with "Aditya Rikhari").
    image = (js.get("image") or dz.get("image") or tadb.get("image")
             or _track_art(top_songs[0] if top_songs else None))

    # Similar artists: Last.fm names, JioSaavn fallback; images filled via Deezer.
    similar = lfm.get("similar") or []
    if not similar:
        for sa in (js.get("similarArtists") or [])[:10]:
            if isinstance(sa, dict) and sa.get("name"):
                similar.append({"name": _clean(sa.get("name")), "image": sa.get("image", "")})
    similar = similar[:10]
    # Drop combined / collaboration entries ("A & B", "A, B", "A feat B") and
    # derivative pages (tribute/karaoke/covers): they aren't standalone artists,
    # and clicking one opened a fabricated / empty page.
    similar = [s for s in similar
               if not _is_combo(s.get("name")) and not _is_nonartist(s.get("name"))]
    # Last.fm images are dead placeholders — drop them (filled from Deezer in
    # the vet step below).
    for s in similar:
        if "lastfm" in (s.get("image") or "") or "2a96cbd8b46e442fc41c2b" in (s.get("image") or ""):
            s["image"] = ""
    similar = _vet_similar(similar)

    genre = tadb.get("genre") or (lfm.get("tags") or [""])[0] or ""

    return {
        "name": display_name,
        "image": image,
        "banner": tadb.get("banner") or "",
        "bio": bio,
        "genre": genre,
        "country": tadb.get("country") or "",
        "founded": tadb.get("founded") or "",
        "verified": bool(js.get("isVerified")),
        "followers": dz.get("fans") if dz.get("fans") else (int(js["follower_count"]) if str(js.get("follower_count", "")).isdigit() else None),
        "listeners": lfm.get("listeners"),
        "tags": (lfm.get("tags") or [])[:6],
        "top_songs": top_songs,
        "albums": albums[:20],
        "similar_artists": similar,
    }


# ──────────────────────────── public: ALBUM ─────────────────────────────────

def _find_jiosaavn_album(name, artist):
    """Find best-matching JioSaavn album id for name(+artist). Returns id or ''.

    Title score (length-sensitive + exact-title bonus) picks the right release
    of a given title ("Sky High" beats "Sky High pt.II"). But title alone is not
    enough: a fuzzy NEAR-title by a DIFFERENT artist must never win ("Winter" by
    Cold Blue was grabbing "Blue Winter" by Urban Concept). So when an artist is
    known we verify the candidate's primary_artists actually credits them and
    return '' if none does — the caller then falls back to iTunes / shows the
    album as unavailable rather than opening a stranger's record."""
    q = f"{name} {artist}".strip()
    ac = _jcall({"__call": "autocomplete.get", "query": q})
    hits = (ac.get("albums", {}) or {}).get("data", []) if isinstance(ac, dict) else []
    if not hits:
        return ""
    nkey = _strip_name(name)

    def title_score(h):
        title = h.get("title", "")
        s = _plain_ratio(name, title)               # penalizes "... pt.II" / "... 2"
        if _strip_name(title) == nkey:
            s += 200                                 # exact title is a near-sure win
        return s

    hits = sorted(hits, key=title_score, reverse=True)

    # No artist to corroborate → trust the title alone.
    if not artist:
        return str(hits[0].get("id", ""))

    # With an artist: verify the candidate is actually theirs. Check exact-title
    # candidates first (the usual case), else the top few fuzzy ones; accept the
    # best whose album artist credits the requested artist. (ponytail: up to a
    # few extra detail calls — album views aren't a hot path.)
    exact = [h for h in hits if _strip_name(h.get("title", "")) == nkey]
    pool = (exact or hits)[:4]
    best_id, best = "", -1.0
    for h in pool:
        aid = str(h.get("id", ""))
        if not aid:
            continue
        d = _jcall({"__call": "content.getAlbumDetails", "albumid": aid})
        alb_artist = (d or {}).get("primary_artists") or (d or {}).get("subtitle") or ""
        if not _credits(artist, alb_artist):
            continue                                 # wrong artist — skip it
        sc = _ratio(artist, alb_artist) + title_score(h)
        if sc > best:
            best, best_id = sc, aid
    return best_id                                   # '' if nobody credits the artist


def _album_id_from_song(song_url):
    """A JioSaavn song page URL → the exact id of the album it belongs to (or '').

    This is the RELIABLE path for "Go to album": the track string carries the
    album NAME, which for variant releases is ambiguous ("Memory Reboot" the
    track is tagged album "Memory Reboot (Slowed)"), so resolving by name opened
    the wrong release. The song's own details point at exactly one album id."""
    if "/song/" not in (song_url or ""):
        return ""
    d = _jcall({"__call": "webapi.get", "token": _token_from_url(song_url),
                "type": "song", "api_version": "4"})
    songs = d.get("songs") if isinstance(d, dict) else None
    if songs:
        mi = songs[0].get("more_info") or {}
        return str(mi.get("album_id") or mi.get("albumid") or "")
    return ""


def get_album(name, artist="", song_url="", album_id=""):
    """Cached album profile (see _build_album)."""
    if album_id:
        key = ("album", "id:" + str(album_id))
    elif song_url:
        key = ("album", (song_url or "").strip())
    else:
        key = ("album", (name or "").strip().lower(), (artist or "").strip().lower())
    with _cache_lock:
        if key in _cache:
            return _cache[key]
    result = _build_album(name, artist, song_url, album_id)
    if result.get("tracks"):  # don't cache empty failures
        with _cache_lock:
            _cache[key] = result
    return result


def _build_album(name, artist="", song_url="", album_id=""):
    """Assemble an album profile with playable tracks. Returns dict (never raises).

    Album identity is, in priority order: an explicit JioSaavn `album_id` (exact —
    from a search-result card); else the SONG when a song_url is supplied (exact —
    handles variant releases like "... (Slowed)"); else a name+artist search
    (artist-disambiguated)."""
    name = (name or "").strip()
    if not name and not song_url and not album_id:
        return {}

    album_id = str(album_id or "") or _album_id_from_song(song_url) or (_find_jiosaavn_album(name, artist) if name else "")
    if album_id:
        d = _jcall({"__call": "content.getAlbumDetails", "albumid": album_id})
        if isinstance(d, dict) and (d.get("songs") or d.get("list")):
            songs = d.get("songs") or d.get("list") or []
            tracks = _make_playable([_song_to_raw(s) for s in songs])
            if tracks:
                # JioSaavn sometimes hands back a dead cover link (404). Validate
                # it; if broken/missing, fall back to iTunes' reliable 600px art
                # and stamp it onto every track so now-playing / recently-played
                # show a cover too (all album tracks share the album cover).
                js_img = _clean(d.get("image") or "")
                img = js_img if _url_ok(js_img) else ""
                if not img:
                    img = _itunes_album_cover(name or d.get("title", ""), artist or d.get("primary_artists", ""))
                    if img:
                        for t in tracks:
                            t.setdefault("artwork_urls", {})["600"] = img
                            t["artwork_url"] = img
                if not img and tracks:
                    img = tracks[0].get("artwork_url", "")
                return {
                    "name": _clean(d.get("title") or d.get("name")) or name,
                    "artist": _clean(d.get("primary_artists") or d.get("subtitle")) or artist,
                    "image": img,
                    "year": d.get("year") or "",
                    "release_date": d.get("release_date") or "",
                    "tracks": tracks,
                    "track_count": len(tracks),
                    "source": "jiosaavn",
                }

    # Western fallback: iTunes album tracklist → resolve each to playable.
    try:
        from components.itunes_client import iTunesClient
        c = iTunesClient()
        albums = c.search_albums(f"{name} {artist}".strip(), limit=1)
        if albums:
            full = c.lookup_album(albums[0].collection_id, entity="albumTrack")
            it_tracks = getattr(full, "tracks", []) if full else []
            pairs = [(t.name, t.artist_name) for t in it_tracks if getattr(t, "name", None)]
            tracks = _resolve_names(pairs, max(len(pairs), 20))
            if tracks:
                art100 = albums[0].artwork_url_100 or ""
                return {
                    "name": _clean(albums[0].name) or name,
                    "artist": _clean(albums[0].artist_name) or artist,
                    "image": art100.replace("100x100", "600x600"),
                    "year": str(albums[0].release_year or ""),
                    "release_date": albums[0].release_date or "",
                    "tracks": tracks,
                    "track_count": len(tracks),
                    "source": "itunes",
                }
    except Exception:
        pass

    return {"name": name, "artist": artist, "image": "", "tracks": [], "track_count": 0}


if __name__ == "__main__":
    # Self-check (no network): the 3-shape song normalizer must produce a
    # playable merged track from the flat album-details shape.
    album_song = {  # flat legacy shape from content.getAlbumDetails
        "id": "x1", "song": "Zara Sa", "primary_artists": "KK",
        "album": "Jannat", "image": "https://c.saavncdn.com/x/Zara-150x150.jpg",
        "perma_url": "https://www.jiosaavn.com/song/zara-sa/JjkbABFoQlQ",
        "duration": "303", "year": "2008", "language": "hindi",
    }
    raw = _song_to_raw(album_song)
    assert raw and raw["title"] == "Zara Sa" and raw["artist"] == "KK", raw
    assert "/song/" in raw["url"], "playable url missing"
    tracks = _make_playable([raw])
    assert tracks and tracks[0]["sources"].get("jiosaavn", {}).get("url"), "not playable"

    # artist-topSong shape (title + subtitle) and a non-playable album url.
    assert _song_to_raw({"title": "X", "subtitle": "Y", "perma_url": "https://www.jiosaavn.com/song/x/abc"})["artist"] == "Y"
    assert _song_to_raw({"title": "A", "perma_url": "https://www.jiosaavn.com/album/a/1"}) is None, "album url must not be playable"

    # Artist-field pollution: subtitle "Artist - Album" must not leak the album
    # into the artist (this broke "Go to artist" for Neil Sedaka's topSongs).
    polluted = _song_to_raw({
        "song": "Oh Carol", "subtitle": "Neil Sedaka - Rockin' With Sedaka",
        "album": "Rockin' With Sedaka",
        "perma_url": "https://www.jiosaavn.com/song/oh-carol/x",
    })
    assert polluted["artist"] == "Neil Sedaka", polluted["artist"]
    # Normalized title de-dup collapses the same song across compilations.
    assert _norm_title("Oh! Carol") == _norm_title("Oh Carol") == "ohcarol"
    # Combo detector: collabs are combos, solo / hyphenated duos are not.
    assert _is_combo("Hans Zimmer & Lorne Balfe") and not _is_combo("Hans Zimmer")
    assert not _is_combo("Sachin-Jigar"), "hyphenated duo is not a combo"
    assert _is_combo("Hans Zimmer and Heitor Pereira"), "'and' collab is a combo"
    assert not _is_combo("Florence and the Machine"), "article-led band is not a combo"
    assert _is_combo("Berryman; Chris Martin; Coldplay"), "';' joins a combo"
    # Derivative / non-artist names (tribute, karaoke, covers) are filtered.
    assert _is_nonartist("Coldplay Metal Tribute") and _is_nonartist("Karaoke - Coldplay")
    assert _is_nonartist("Coldplay Piano Covers") and not _is_nonartist("Coldplay")
    assert not _is_nonartist("Chris Martin"), "a real artist is not a non-artist"
    # Compilation / playlist accounts are not artists.
    assert _is_nonartist("Pop Hits") and _is_nonartist("Top 40 Pop Hits")
    assert _is_nonartist("Various Artists") and _is_nonartist("Hits Variété Pop")
    # Same-artist name gate: a bare first name is NOT a longer different name.
    assert _same_artist_name("Priya", "Priya") and not _same_artist_name("Priya", "Priya Saraiya")
    assert _same_artist_name("A.R. Rahman", "AR Rahman"), "punctuation-insensitive"
    assert _same_artist_name("Beyonce", "Beyoncé"), "diacritic-insensitive"
    # One-letter-off names are DIFFERENT artists (no fuzzy merge).
    assert not _same_artist_name("Codeplay", "Coldplay")
    assert not _same_artist_name("Coolplay", "Coldplay")
    assert not _same_artist_name("ColdPlay Wu", "Coldplay")
    assert _credits_exact("Arijit Singh", "Pritam, Arijit Singh"), "exact credit in a list"
    assert not _credits_exact("Priya", "Priya Saraiya"), "namesake must not credit"

    # Variant merge: middle-name collapse reduces "Hans Florian Zimmer" to the
    # same first+last key as "Hans Zimmer" (so they merge into one artist).
    _toks = "Hans Florian Zimmer".split()
    assert re.sub(r"[^a-z0-9]", "", (_toks[0] + _toks[-1]).lower()) == "hanszimmer"

    # Identity-gate helper: real credits pass, unrelated channel names fail.
    assert _credits("The Weeknd", "The Weeknd"), "exact credit must pass"
    assert _credits("Pritam", "Pritam, Arijit Singh"), "duet credit must pass"
    assert not _credits("HouseNatic", "Some Real Artist"), "channel name must not match unrelated song"
    print("profile self-check OK:", tracks[0]["title"], "-", tracks[0]["artist"])

    # Live (network) check for album search — skipped silently if offline.
    try:
        _albums = search_albums("cocktail", limit=8)
    except Exception:
        _albums = None
    if _albums:
        assert all(a.get("name") for a in _albums), "album card missing name"
        assert all("album_id" in a for a in _albums), "album card missing album_id field"
        _keys = [re.sub(r"[^a-z0-9]", "", (a["name"] + "|" + (a.get("artist") or "")).lower())
                 for a in _albums]
        assert len(_keys) == len(set(_keys)), "duplicate albums in results"
        print("search_albums live check OK:", len(_albums), "albums; top:", _albums[0]["name"])
