/**
 * The common class. One shape for every list of songs in the app.
 *
 * An album, a JioSaavn playlist, a playlist you made, a Spotify import, Liked
 * Songs and your Downloads are all a `Collection`. One screen renders all six;
 * one play call plays all six. Without this, each of them grows its own screen
 * and its own play path, and they drift — which is exactly how you end up with
 * shuffle working in one place and not another.
 *
 * `kind` exists only for the things that genuinely differ: what the subtitle
 * says, whether the row can be pinned, and whether tracks can be removed.
 */
import {useMemo} from 'react';
import {createStore, asArray, useStoreValue} from './storage';
import {normalizeTracks} from './tracks';
import type {Track} from './backend';
import {type Playlist, usePlaylists} from './playlists';

export type CollectionKind =
  | 'album'
  | 'sourcePlaylist' // an album/playlist from JioSaavn et al, saved to library
  | 'userPlaylist' // one the user made — or imported from Spotify
  | 'liked'
  | 'downloads'
  | 'artist';

export type Collection = {
  id: string;
  kind: CollectionKind;
  name: string;
  artist?: string;
  image?: string;
  tracks: Track[];
  /** Handle to reopen/refresh from its origin (a perma_url or album id). */
  source?: string;
  /** When this collection last changed — see Playlist.updatedAt. Undefined on
   *  the two fixtures (Liked, Downloads), which never sort by it. */
  updatedAt?: number;
};

/** What the row under the title says, matching the library's own vocabulary. */
export function collectionSubtitle(c: Collection): string {
  const n = c.tracks.length;
  const count = `${n} song${n === 1 ? '' : 's'}`;
  switch (c.kind) {
    case 'downloads':
      return `Offline · ${count}`;
    case 'album':
      return c.artist ? `Album · ${c.artist}` : `Album · ${count}`;
    case 'artist':
      return 'Artist';
    default:
      return `Playlist · ${count}`;
  }
}

// ─── Saved collections (albums / source playlists added to the library) ──────

/**
 * ponytail: we snapshot the full tracklist per saved collection so the library
 * works without a network round-trip on open. Ceiling = storage size if someone
 * saves hundreds of large albums; upgrade path = store the reopen handle only
 * and refetch on demand.
 */
const saved = createStore<Collection[]>('mp.savedCollections.v1', [], raw =>
  asArray<Collection>(raw).filter(c => c && typeof c.id === 'string'),
);

/** Stable identity for something saved from a source. */
export function savedId(c: {
  source?: string;
  name?: string;
  artist?: string;
}): string {
  return String(c.source || `${c.name || ''}|${c.artist || ''}`).toLowerCase();
}

export function isSaved(c: Collection): boolean {
  const id = savedId(c);
  return saved.get().some(x => savedId(x) === id);
}

/** Toggle saved state. Returns the new state (true = now saved). */
export function toggleSaved(c: Collection): boolean {
  const id = savedId(c);
  const list = saved.get();
  if (list.some(x => savedId(x) === id)) {
    saved.set(list.filter(x => savedId(x) !== id));
    return false;
  }
  saved.set([
    ...list,
    {...c, id, tracks: normalizeTracks(c.tracks || []), updatedAt: Date.now()},
  ]);
  return true;
}

export function useSavedCollections(): Collection[] {
  return useStoreValue(saved);
}

// ─── Building collections from the app's other stores ───────────────────────

export const LIKED_ID = '__liked__';
export const DOWNLOADS_ID = '__downloads__';

export function playlistToCollection(p: Playlist): Collection {
  return {
    id: `pl:${p.id}`,
    kind: 'userPlaylist',
    name: p.name,
    image: p.image,
    tracks: p.tracks || [],
    // Falls back to createdAt for playlists stored before the stamp existed,
    // so an upgraded library keeps its old order instead of collapsing to one
    // undefined heap at the bottom.
    updatedAt: p.updatedAt ?? p.createdAt,
  };
}

export function likedCollection(tracks: Track[]): Collection {
  return {id: LIKED_ID, kind: 'liked', name: 'Liked Songs', tracks};
}

export function downloadsCollection(tracks: Track[]): Collection {
  return {id: DOWNLOADS_ID, kind: 'downloads', name: 'Downloads', tracks};
}

/**
 * Every collection in the library, in the order the library shows them:
 * Liked Songs and Downloads first (they always exist), then saved albums and
 * source playlists, then the user's own playlists.
 *
 * `likes` and `downloads` are passed in rather than read from their stores.
 * Downloads because disk is its source of truth (caching it here would go
 * stale when a file is deleted outside the app), and likes because reading it
 * here would make this module import store.ts, which imports this one back.
 */
export function useLibrary(likes: Track[], downloads: Track[]): Collection[] {
  const playlists = usePlaylists();
  const savedList = useSavedCollections();

  return useMemo(
    () => [
      likedCollection(likes),
      downloadsCollection(downloads),
      ...savedList,
      ...playlists.map(playlistToCollection),
    ],
    [likes, downloads, savedList, playlists],
  );
}
