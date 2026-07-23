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

const {port, token} = (NativeModules.Backend ?? {}) as {
  port?: number;
  token?: string;
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
  playable_source?: string;
  primary_source?: string;
  sources?: Record<string, {url?: string}>;
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
