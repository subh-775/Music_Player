/**
 * The one place the app talks to the embedded Python backend.
 *
 * Port and per-launch token come from the native side (NativeModules.Backend),
 * never hardcoded. The token rides in the query string — not a header — because
 * the same URL builder will feed a native <audio>/track-player source later, and
 * those can't attach headers. Centralising it here means no call site can forget
 * it and silently 403.
 */
import {NativeModules} from 'react-native';
import {toast} from './toast';

const {port, token, version} = (NativeModules.Backend ?? {}) as {
  port?: number;
  token?: string;
  version?: string;
};

const PORT = port ?? 8771;
const BASE = `http://127.0.0.1:${PORT}`;

/** Build an authenticated API URL: apiUrl('/home?x=1') -> BASE/api/home?x=1&_t=… */
export function apiUrl(path: string): string {
  const url = `${BASE}/api${path}`;
  if (!token) {
    return url;
  }
  return `${url}${url.includes('?') ? '&' : '?'}_t=${encodeURIComponent(
    token,
  )}`;
}

/**
 * Has the embedded backend stopped answering?
 *
 * Xiaomi, Oppo/Realme, Vivo and Samsung all kill background work harder than
 * stock Android, and the Python server has none of the protection the playback
 * service has. When it goes, every call fails at once and the app says things
 * like "couldn't load your library" — which sends people looking at their
 * network, at the source, at anything but the actual cause.
 *
 * One probe, rate limited, and it only ever says so: restarting Flask from
 * underneath a running app is not something to attempt blind.
 */
let lastEngineWarning = 0;

async function warnIfEngineStopped(): Promise<void> {
  if (Date.now() - lastEngineWarning < 60_000) {
    return;
  }
  try {
    const res = await fetch(`${BASE}/health`);
    if (res.ok) {
      return; // the backend is fine — that call failed for its own reasons
    }
  } catch {
    // fall through: no answer at all
  }
  lastEngineWarning = Date.now();
  toast('The music engine stopped. Close the app and open it again.');
}

/** GET an /api endpoint as JSON. Throws on a non-2xx or a network error. */
export async function apiGet<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path));
  } catch (e) {
    warnIfEngineStopped().catch(() => {});
    throw e;
  }
  if (!res.ok) {
    throw new Error(`${path} -> HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/**
 * Poll /health until the backend has finished booting (Chaquopy start + warm-up
 * is a few seconds cold), giving up after ~timeoutMs. /health is unauthenticated.
 */
export async function waitForBackend(timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // Backing off, not a flat 500ms.
  //
  // The flat interval meant up to 60 fetches during the exact window Chaquopy
  // is extracting the stdlib and importing Flask — so the poll was competing
  // for CPU with the thing it was waiting for. Start tight (the backend is
  // often up in a few hundred ms on a warm launch, and that case should feel
  // instant), then widen fast so a genuinely slow start is polled a handful of
  // times instead of dozens.
  let delay = 100;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) {
        return true;
      }
    } catch {
      // not up yet
    }
    await new Promise(r => setTimeout(r, delay));
    delay = Math.min(delay * 2, 1000);
  }
  return false;
}

export const backendPort = PORT;
export const appVersion = version ?? '';

// ─── Domain types + calls ────────────────────────────────────────────────────

/** A Home card: a track, album or playlist, already shaped for display. */
export type HomeItem = {
  type: 'track' | 'album' | 'playlist' | string;
  title?: string;
  name?: string;
  subtitle?: string;
  image?: string;
  perma_url?: string;
  track?: Track;
};
export type HomeRow = {title: string; items: HomeItem[]};

/** A playable search result. */
export type Track = {
  title: string;
  artist: string;
  album?: string;
  duration_ms?: number;
  artwork_url?: string;
  artwork_urls?: Record<string, string>;
  playable_source?: string;
  primary_source?: string;
  sources?: Record<string, {url?: string; bitrate?: number}>;
  is_playable?: boolean;
  /** Only on tracks scanned from disk — the real file, needed to delete it. */
  file_path?: string;
  /**
   * Disk scan only: whether the file has a cover embedded in its tags.
   *
   * Undefined on an older backend, which is why every read of it tests for
   * `!== false` rather than truthiness — absent means "unknown, try anyway".
   */
  has_embedded_art?: boolean;
  isrc?: string;
  release_date?: string;
  genre?: string;
  /** Set on autoplay/radio picks, so the queue can label them "Recommended". */
  _autoplay?: boolean;
};

export async function getHome(language = 'hindi,english'): Promise<HomeRow[]> {
  const data = await apiGet<{rows?: HomeRow[]}>(
    `/home?language=${encodeURIComponent(language)}`,
  );
  return Array.isArray(data.rows) ? data.rows : [];
}

/** POST a search. Returns playable tracks across all enabled sources. */
export async function search(query: string, limit = 25): Promise<Track[]> {
  const res = await fetch(apiUrl('/search'), {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({query, limit}),
  });
  if (!res.ok) {
    throw new Error(`search -> HTTP ${res.status}`);
  }
  const data = (await res.json()) as {results?: Track[]};
  return Array.isArray(data.results) ? data.results : [];
}

export type StreamInfo = {
  url?: string;
  bitrate_kbps?: number;
  source?: string;
  error?: string;
};

/**
 * Resolve a track to a real, playable stream URL. This is the same call the
 * player makes a beat before audio starts, so a success here means the whole
 * chain (source lookup -> signed CDN URL) is working for this track.
 */
export async function getStreamInfo(
  track: Track,
  bitrate = 320,
): Promise<StreamInfo> {
  const source = track.playable_source || track.primary_source || '';
  const url = source ? track.sources?.[source]?.url : undefined;
  if (!url) {
    throw new Error('This track has no playable source.');
  }
  return apiGet<StreamInfo>(
    `/stream_info?url=${encodeURIComponent(url)}&source=${encodeURIComponent(
      source,
    )}&bitrate=${bitrate}`,
  );
}

// ─── Lyrics ─────────────────────────────────────────────────────────────────

export type SyncedLine = {time: number; text: string};
export type Lyrics = {
  plain?: string;
  synced?: SyncedLine[];
  source?: string;
};

/** Synced lyrics (lrclib) with a plain-text fallback. The backend gates matches
 *  on artist + duration, so passing duration materially improves accuracy. */
/**
 * YouTube titles carry video cruft — "(Official Music Video)", "[Lyrics]",
 * "| Channel", "ft. X", "4K" — that a lyrics database will never match. Strip it
 * so a YT-sourced track looks up the same as a clean JioSaavn one. Left alone,
 * every YouTube song read "No lyrics found".
 */
function cleanForLyrics(title: string): string {
  return (
    title
      // bracketed / parenthesised video tags
      .replace(
        /[([]\s*(official|lyric|lyrics|audio|video|music video|visuali[sz]er|hd|4k|mv|full song|slowed|reverb)[^)\]]*[)\]]/gi,
        '',
      )
      // trailing "| channel name" or "- Topic"
      .replace(/\s*[|]\s*.*$/, '')
      .replace(/\s*-\s*Topic\s*$/i, '')
      // feat./ft. tails
      .replace(/\s*(feat\.?|ft\.?|featuring)\s+.*$/i, '')
      .replace(/\s{2,}/g, ' ')
      .trim() || title
  );
}

export async function getLyrics(
  title: string,
  artist: string,
  durationMs?: number,
): Promise<Lyrics> {
  // Hand-built query, NOT URLSearchParams: Hermes ships a stub whose
  // .toString() throws "not implemented", which made every lyrics call fail
  // before the request even left the app — "No lyrics found" for every song.
  const cleanTitle = cleanForLyrics(title);
  let q = `title=${encodeURIComponent(cleanTitle)}&artist=${encodeURIComponent(
    artist,
  )}`;
  if (durationMs) {
    q += `&duration=${Math.round(durationMs / 1000)}`;
  }
  return apiGet<Lyrics>(`/lyrics?${q}`);
}

// ─── Collections (album / playlist) ─────────────────────────────────────────

export type Collection = {name: string; tracks: Track[]; error?: string};

/** Open an album or playlist by its source page URL. */
export async function getCollection(url: string): Promise<Collection> {
  const data = await apiGet<Collection>(
    `/playlist?url=${encodeURIComponent(url)}`,
  );
  return {
    name: data.name || '',
    tracks: Array.isArray(data.tracks) ? data.tracks : [],
    error: data.error,
  };
}

/**
 * Open an album by name+artist. Some album perma_urls do not resolve through
 * /api/playlist, so this is the second attempt before giving up - which is
 * what left a few Home cards opening empty.
 */
export async function getAlbum(
  name: string,
  artist = '',
  songUrl = '',
): Promise<Collection> {
  // Hand-built for the same Hermes reason as getLyrics — the stub
  // URLSearchParams broke every album-by-name open (artist page albums).
  let q = `name=${encodeURIComponent(name)}&artist=${encodeURIComponent(
    artist,
  )}`;
  if (songUrl) {
    q += `&song_url=${encodeURIComponent(songUrl)}`;
  }
  const data = await apiGet<Partial<Collection>>(`/album?${q}`);
  return {
    name: data.name || name,
    tracks: Array.isArray(data.tracks) ? data.tracks : [],
    error: data.error,
  };
}

// ─── Library (downloaded / offline) ─────────────────────────────────────────

export type LocalLibrary = {tracks: Track[]; download_dir: string};

/** Offline library, rebuilt from the tags on disk — disk is the source of
 *  truth, so files added or removed outside the app are picked up. */
export async function getLocalLibrary(): Promise<LocalLibrary> {
  const data = await apiGet<Partial<LocalLibrary>>('/downloads/local');
  return {
    tracks: Array.isArray(data.tracks) ? data.tracks : [],
    download_dir: data.download_dir || '',
  };
}

// ─── Settings ───────────────────────────────────────────────────────────────

export type DownloadsInfo = {
  download_dir?: string;
  path?: string;
  using_fallback?: boolean;
  custom?: boolean;
};

export const getDownloadsInfo = () => apiGet<DownloadsInfo>('/downloads/info');

/** Set (or clear, with '') the custom download folder. The backend refuses a
 *  folder it can't actually write to. */
export async function setDownloadsDir(
  path: string,
): Promise<{ok: boolean; error?: string} & DownloadsInfo> {
  const res = await fetch(apiUrl('/downloads/dir'), {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({path}),
  });
  return (await res.json()) as {ok: boolean; error?: string} & DownloadsInfo;
}

/** Browse tiles — the genre grid Search shows before you've typed anything.
 *  They're HomeItem-shaped, so they open through the same path as a Home card. */
export async function getGenres(
  language = 'hindi,english',
): Promise<HomeItem[]> {
  const data = await apiGet<{tiles?: HomeItem[]}>(
    `/genres?language=${encodeURIComponent(language)}`,
  );
  return Array.isArray(data.tiles) ? data.tiles : [];
}

// ─── Cache ──────────────────────────────────────────────────────────────────

/** How much re-fetchable scratch data is on disk. Downloads are NOT counted —
 *  they're the user's files, not cache. */
export const getCacheSize = () => apiGet<{bytes: number}>('/cache');

/** Drop resolved stream URLs, lyrics, home rows and cached files. Returns the
 *  bytes reclaimed. Never touches downloads, playlists or likes. */
export async function clearBackendCache(): Promise<number> {
  const res = await fetch(apiUrl('/cache/clear'), {method: 'POST'});
  if (!res.ok) {
    throw new Error(`clear cache -> HTTP ${res.status}`);
  }
  const data = (await res.json()) as {freed?: number};
  return data.freed ?? 0;
}

/** Songs similar to a seed — what keeps playback going when the queue ends. */
export async function getRadio(
  title: string,
  artist: string,
  limit = 12,
): Promise<Track[]> {
  const data = await apiGet<{tracks?: Track[]}>(
    `/radio?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(
      artist,
    )}&limit=${limit}`,
  );
  return Array.isArray(data.tracks) ? data.tracks : [];
}

export type SourceStatus = {
  status: string;
  type: string;
  quality: string;
  error?: string;
};

/**
 * Per-source availability.
 *
 * The endpoint wraps its payload: {"sources": {...}}. Reading the top level
 * instead gave a single "sources" key whose value has no `type`, so the
 * Settings filter matched nothing and the Sources section rendered EMPTY —
 * which in turn meant the YouTube toggle was never reachable, which is why
 * YouTube never appeared in search results.
 */
export async function getSourcesStatus(): Promise<
  Record<string, SourceStatus>
> {
  const data = await apiGet<{sources?: Record<string, SourceStatus>}>(
    '/sources/status',
  );
  return data.sources ?? {};
}

export type YouTubeExperimental = {supported: boolean; enabled: boolean};

export const getYouTubeExperimental = () =>
  apiGet<YouTubeExperimental>('/youtube/experimental');

export async function setYouTubeExperimental(
  enabled: boolean,
): Promise<{ok: boolean; enabled: boolean; error?: string}> {
  const res = await fetch(apiUrl('/youtube/experimental'), {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({enabled}),
  });
  return (await res.json()) as {ok: boolean; enabled: boolean; error?: string};
}

// ─── Search suggestions ─────────────────────────────────────────────────────

export type Suggestion = {
  title: string;
  artist: string;
  album?: string;
  sources?: string[];
  isrc?: string;
  artwork_url?: string;
};

/** Autocomplete for the search field. Cheap by design — the backend restricts
 *  this to JioSaavn and ranks prefix matches above contains above fuzzy. */
export async function getSuggestions(
  q: string,
  limit = 8,
): Promise<Suggestion[]> {
  if (q.trim().length < 2) {
    return [];
  }
  const data = await apiGet<{suggestions?: Suggestion[]}>(
    `/search/suggestions?q=${encodeURIComponent(q)}&limit=${limit}`,
  );
  return Array.isArray(data.suggestions) ? data.suggestions : [];
}

// ─── Spotify import ─────────────────────────────────────────────────────────

export type ImportSnapshot = {
  name: string;
  image: string;
  total: number;
  done: number;
  matched: number;
  tracks: Track[];
  missing: string[];
  finished: boolean;
  error: string | null;
};

/** Poll (and on the first call, start) the background import job for `url`.
 *  The job lives in the server process, so it survives the screen closing. */
export const importSpotify = (url: string) =>
  apiGet<ImportSnapshot>(`/spotify/import?url=${encodeURIComponent(url)}`);

// ─── Artists ────────────────────────────────────────────────────────────────

export type ArtistCard = {name: string; image?: string; listeners?: number};

export type ArtistProfile = {
  name: string;
  image?: string;
  bio?: string;
  followers?: number | null;
  listeners?: number | null;
  top_songs: Track[];
  albums: Array<{name: string; image?: string; year?: string | number}>;
  error?: string;
};

/** Photos for a set of credited names, used by the multi-artist picker. */
export async function searchArtists(
  q: string,
  limit = 10,
): Promise<ArtistCard[]> {
  const data = await apiGet<{artists?: ArtistCard[]}>(
    `/search/artists?q=${encodeURIComponent(q)}&limit=${limit}`,
  );
  return Array.isArray(data.artists) ? data.artists : [];
}

export async function getArtist(name: string): Promise<ArtistProfile> {
  const data = await apiGet<Partial<ArtistProfile>>(
    `/artist?name=${encodeURIComponent(name)}`,
  );
  return {
    name: data.name || name,
    image: data.image,
    bio: data.bio,
    followers: data.followers ?? null,
    listeners: data.listeners ?? null,
    top_songs: Array.isArray(data.top_songs) ? data.top_songs : [],
    albums: Array.isArray(data.albums) ? data.albums : [],
    error: data.error,
  };
}

// ─── Downloads ──────────────────────────────────────────────────────────────

export type DownloadTask = {
  task_id?: string;
  status?: string;
  progress?: number;
  error?: string;
  filepath?: string;
};

/**
 * Queue a download. The backend wants the SOURCE page url plus the catalog
 * metadata separately — it names the file "{title} - {artist}" from track_info
 * and embeds those tags, which is what makes the offline library readable back
 * off disk later. Android ignores any output_dir: scoped storage means
 * everything lands in the app's Music directory.
 */
export async function startDownload(
  track: Track,
  bitrate = 320,
): Promise<DownloadTask> {
  const source = track.playable_source || track.primary_source || '';
  const url = source ? track.sources?.[source]?.url : undefined;
  if (!url) {
    throw new Error('This track has no downloadable source.');
  }
  const res = await fetch(apiUrl('/download'), {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      url,
      track_info: {
        title: track.title,
        artist: track.artist,
        album: track.album,
        duration_ms: track.duration_ms,
        artwork_url: track.artwork_url,
      },
      // The backend clamps to 64..320 anyway; clamping here keeps the value
      // we report to the user honest.
      max_bitrate: Math.max(64, Math.min(bitrate, 320)),
    }),
  });
  return (await res.json()) as DownloadTask;
}

export const getDownloadStatus = (taskId: string) =>
  apiGet<DownloadTask>(`/download/${encodeURIComponent(taskId)}`);

/**
 * Delete a downloaded file from the phone's storage.
 *
 * Takes the real `file_path` from /downloads/local — the backend refuses any
 * path that doesn't resolve inside the managed download directory, so this
 * can't be pointed at arbitrary files. It also removes an album subfolder once
 * emptied.
 */
export async function deleteDownload(path: string): Promise<boolean> {
  if (!path) {
    return false;
  }
  const res = await fetch(apiUrl('/downloads/delete'), {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({path}),
  });
  const data = (await res.json()) as {ok?: boolean};
  return !!data.ok;
}

/** mm:ss for a duration in milliseconds. */
export function formatDuration(ms?: number): string {
  if (!ms || ms <= 0) {
    return '';
  }
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}
