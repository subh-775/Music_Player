/**
 * Followed artists.
 *
 * Stored as name + photo only, never a snapshot of their songs: an artist's
 * catalogue changes and a cached tracklist would go stale, whereas the profile
 * is re-fetched on open anyway.
 */
import {createStore, asArray, useStoreValue} from './storage';

export type SavedArtist = {name: string; image?: string; savedAt: number};

const store = createStore<SavedArtist[]>('mp.artists.v1', [], raw =>
  asArray<SavedArtist>(raw).filter(a => a && typeof a.name === 'string'),
);

const key = (name: string) => name.trim().toLowerCase();

export function isFollowing(name: string): boolean {
  return store.get().some(a => key(a.name) === key(name));
}

/** Returns the new state (true = now following). */
export function toggleFollow(name: string, image?: string): boolean {
  const list = store.get();
  if (list.some(a => key(a.name) === key(name))) {
    store.set(list.filter(a => key(a.name) !== key(name)));
    return false;
  }
  store.set([{name, image, savedAt: Date.now()}, ...list]);
  return true;
}

export function useFollowedArtists(): SavedArtist[] {
  return useStoreValue(store);
}
