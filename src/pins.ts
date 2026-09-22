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

/**
 * Pins to the top in pin order; everything else below them, most recently
 * changed first.
 *
 * The second half is new. Unpinned rows used to compare equal, so the list kept
 * whatever order its store had — saved collections by when they were saved,
 * playlists by when they were created — and adding a song to a playlist moved
 * it nowhere. The one you are actually filling belongs directly under the pins,
 * which is the whole point of pinning only a handful.
 *
 * `recencyOf` is optional: callers with nothing to date by (the playlist picker
 * inside the add sheet, where the order is a menu rather than a library) pass
 * nothing and get the old stable behaviour. A row with no stamp sorts LAST
 * among the unpinned — "never touched" is older than any timestamp, and
 * treating a missing value as 0 rather than as now is what keeps an upgraded
 * library from shuffling itself.
 */
export function sortPinned<T>(
  rows: T[],
  pins: string[],
  idOf: (row: T) => string,
  recencyOf?: (row: T) => number | undefined,
): T[] {
  // Index, not indexOf-per-comparison: sort calls the comparator O(n log n)
  // times and each indexOf walked the pin list again.
  const rank = new Map(pins.map((id, i) => [id, i]));
  return [...rows].sort((a, b) => {
    const pa = rank.get(idOf(a)) ?? -1;
    const pb = rank.get(idOf(b)) ?? -1;
    if (pa !== -1 && pb !== -1) {
      return pa - pb; // earlier pins stay above later ones
    }
    if (pa !== -1) {
      return -1;
    }
    if (pb !== -1) {
      return 1;
    }
    if (!recencyOf) {
      return 0;
    }
    return (recencyOf(b) ?? 0) - (recencyOf(a) ?? 0);
  });
}

export function usePins(): string[] {
  return useStoreValue(store);
}
