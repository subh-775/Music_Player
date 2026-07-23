/**
 * Pinned library rows — the handful you keep at the top.
 *
 * Stores IDS ONLY, never copies of the playlist or album. A pin has to survive
 * the thing it points at being renamed, re-covered, or having tracks added, and
 * a snapshot would go stale the moment any of that happened. The library row
 * stays the source of truth; a pin only reorders it.
 */
import {createStore, asArray, useStoreValue} from './storage';

/** Spotify caps its own pins around here. Past this, "pinned" is just "the
 *  list again", which defeats the point. */
export const MAX_PINS = 5;

const store = createStore<string[]>('mp.pins.v1', [], raw =>
  asArray<string>(raw)
    .filter(x => typeof x === 'string')
    .slice(0, MAX_PINS),
);

export const hydratePins = store.hydrate;

export function isPinned(id: string): boolean {
  return !!id && store.get().includes(id);
}

export type PinResult = 'pinned' | 'unpinned' | 'full';

/**
 * Toggle a pin. Returns 'full' when already at MAX_PINS so the caller can say
 * WHY nothing happened, rather than silently doing nothing.
 */
export function togglePin(id: string): PinResult {
  if (!id) {
    return 'full';
  }
  const pins = store.get();
  if (pins.includes(id)) {
    store.set(pins.filter(x => x !== id));
    return 'unpinned';
  }
  if (pins.length >= MAX_PINS) {
    return 'full';
  }
  store.set([...pins, id]);
  return 'pinned';
}

/**
 * Stable id for a library row. Playlists carry their own; saved albums and
 * artists don't, so they key on kind+name+artist — the same triple the library
 * itself de-dupes on.
 */
export function rowId(
  kind: string,
  item: {id?: string; name?: string; artist?: string},
): string {
  if (kind === 'playlist' && item.id) {
    return `pl:${item.id}`;
  }
  return `${kind}:${(item.name || '').toLowerCase()}:${(
    item.artist || ''
  ).toLowerCase()}`;
}

/** Pinned rows to the top, each group keeping its own order otherwise. */
export function sortPinned<T>(
  rows: T[],
  pins: string[],
  idOf: (row: T) => string,
): T[] {
  return [...rows].sort((a, b) => {
    const pa = pins.indexOf(idOf(a));
    const pb = pins.indexOf(idOf(b));
    if (pa === -1 && pb === -1) {
      return 0;
    }
    if (pa === -1) {
      return 1;
    }
    if (pb === -1) {
      return -1;
    }
    return pa - pb; // earlier pins stay above later ones
  });
}

export function usePins(): string[] {
  return useStoreValue(store);
}
