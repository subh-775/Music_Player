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

export type HomeItem = {
  type: string;
  title?: string;
  name?: string;
  artist?: string;
};
export type HomeRow = {title: string; items: HomeItem[]};

export async function getHome(
  language = 'hindi,english',
): Promise<HomeRow[]> {
  const data = await apiGet<{rows?: HomeRow[]}>(
    `/home?language=${encodeURIComponent(language)}`,
  );
  return Array.isArray(data.rows) ? data.rows : [];
}
