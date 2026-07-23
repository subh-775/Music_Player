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
  return `${url}${url.includes('?') ? '&' : '?'}_t=${encodeURIComponent(token)}`;
}

/** GET an /api endpoint as JSON. Throws on a non-2xx or a network error. */
export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(apiUrl(path));
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
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) {
        return true;
      }
    } catch {
      // not up yet
    }
    await new Promise(r => setTimeout(r, 500));
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
  isrc?: string;
  release_date?: string;
  genre?: string;
  /** Set once /api/enrich has been applied — the guard against re-enriching. */
  _enriched?: boolean;
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
export async function getLyrics(
  title: string,
  artist: string,
  durationMs?: number,
): Promise<Lyrics> {
  const q = new URLSearchParams({title, artist});
  if (durationMs) {
    q.set('duration', String(Math.round(durationMs / 1000)));
  }
  return apiGet<Lyrics>(`/lyrics?${q.toString()}`);
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

export type SourceStatus = {
  status: string;
  type: string;
  quality: string;
  error?: string;
};

export const getSourcesStatus = () =>
  apiGet<Record<string, SourceStatus>>('/sources/status');

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

// ─── Enrichment ─────────────────────────────────────────────────────────────

/**
 * Batch iTunes metadata lookup. Results come back in the SAME ORDER as the
 * tracks sent (the backend uses executor.map for exactly this), which is how
 * the caller aligns them without needing an id per row.
 *
 * Call this at most once per track — see applyEnrichment's `_enriched` flag.
 */
export async function enrichBatch(
  tracks: Track[],
): Promise<Array<Record<string, unknown> | null>> {
  if (!tracks.length) {
    return [];
  }
  const res = await fetch(apiUrl('/enrich'), {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      tracks: tracks.map(t => ({
        title: t.title,
        artist: t.artist,
        isrc: t.isrc,
        duration_ms: t.duration_ms,
      })),
    }),
  });
  if (!res.ok) {
    throw new Error(`enrich -> HTTP ${res.status}`);
  }
  const data = (await res.json()) as {results?: Array<Record<string, unknown> | null>};
  return Array.isArray(data.results) ? data.results : [];
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
