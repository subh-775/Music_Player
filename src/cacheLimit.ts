/**
 * The cache clears itself once it passes the size set in Settings.
 *
 * Checked at launch and on each return to the app, never while it is in the
 * background: leaving the app is also what the update installer does, and a
 * clear then would delete the downloaded APK while Android is still reading
 * it. Back in the foreground the installer has finished (or was dismissed).
 *
 * The clear is the backend's, the same one as the Settings button minus search
 * history: that is something the user built, not something re-fetchable.
 */
import {AppState} from 'react-native';
import {clearBackendCache, getCacheSize} from './backend';
import {diag} from './diag';
import {logEvent} from './analytics';
import {readSettings} from './store';

/** A directory walk per check; once a stretch is plenty for a cache limit. */
const MIN_GAP_MS = 10 * 60 * 1000;
let lastCheck = 0;

export async function enforceCacheLimit(force = false): Promise<void> {
  const limitMb = readSettings().cacheLimitMb;
  const now = Date.now();
  if (!limitMb || (!force && now - lastCheck < MIN_GAP_MS)) {
    return;
  }
  lastCheck = now;
  try {
    const {bytes} = await getCacheSize();
    if (bytes < limitMb * 1024 * 1024) {
      return;
    }
    const freed = await clearBackendCache();
    logEvent('cache_cleared', {auto: 1, freed_mb: Math.round(freed / 1048576)});
    diag(
      'cache',
      `auto-cleared ${Math.round(freed / 1048576)} MB (limit ${limitMb} MB)`,
    );
  } catch {
    // Backend not up yet: the next foreground return tries again.
    lastCheck = 0;
  }
}

/** Launch check (after cold start settles), then every return to the app. */
export function watchCacheLimit(): () => void {
  const t = setTimeout(() => enforceCacheLimit(), 8000);
  const sub = AppState.addEventListener('change', s => {
    if (s === 'active') {
      enforceCacheLimit();
    }
  });
  return () => {
    clearTimeout(t);
    sub.remove();
  };
}
