/**
 * User playlists: create, rename, re-cover, add/remove songs.
 *
 * A playlist is { id, name, tracks[], createdAt, image? }. Anything that
 * produces a list of songs — including a Spotify import — becomes one of these,
 * so there is exactly one kind of playlist in the app and it is editable
 * wherever it came from.
 */
import {createStore, asArray, useStoreValue} from './storage';
import {getTrackId, normalizeTrack} from './tracks';
import type {Track} from './backend';

export type Playlist = {
  id: string;
  name: string;
  tracks: Track[];
  createdAt: number;
  /** A data: URI, never a file path — a path breaks the moment the user moves
   *  or deletes the picture, and the cover has to outlive that. */
  image?: string;
  /**
   * When this playlist last CHANGED — a song added or removed, a rename, a new
   * cover. The library sorts unpinned rows by it, so the list you are actually
   * filling rises to the top instead of sitting wherever creation order left it.
   *
   * Optional because playlists stored before this existed have none. Readers
   * fall back to `createdAt`, which is the honest answer for a list nobody has
   * touched since, and keeps an existing library from scrambling on upgrade.
   */
  updatedAt?: number;
};

const store = createStore<Playlist[]>('mp.playlists.v1', [], raw =>
  asArray<Playlist>(raw).filter(p => p && typeof p.id === 'string'),
);

export const hydratePlaylists = store.hydrate;
export const readPlaylists = store.get;

export function createPlaylist(name: string): Playlist | null {
  const clean = (name || '').trim();
  if (!clean) {
    return null;
  }
  const playlist: Playlist = {
    id: `pl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: clean,
    tracks: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  store.update(list => [playlist, ...list]);
  return playlist;
}

export function deletePlaylist(id: string): void {
  store.update(list => list.filter(p => p.id !== id));
}

export function renamePlaylist(id: string, name: string): void {
  const clean = (name || '').trim();
  if (!clean) {
    return;
  }
  store.update(list =>
    list.map(p => (p.id === id ? {...p, name: clean, updatedAt: Date.now()} : p)),
  );
}

/** Pass null to clear, falling the cover back to the artwork mosaic. */
export function setPlaylistImage(id: string, image: string | null): void {
  store.update(list =>
    list.map(p =>
      p.id === id
        ? {...p, image: image || undefined, updatedAt: Date.now()}
        : p,
    ),
  );
}

/** Returns true if it was added, false if the song was already there. */
export function addTrackToPlaylist(id: string, track: Track): boolean {
  const t = normalizeTrack(track);
  if (!t) {
    return false;
  }
  const tid = getTrackId(t);
  let added = false;
  store.update(list =>
    list.map(p => {
      if (p.id !== id || (p.tracks || []).some(x => getTrackId(x) === tid)) {
        return p;
      }
      added = true;
      return {...p, tracks: [...(p.tracks || []), t], updatedAt: Date.now()};
    }),
  );
  return added;
}

/** Add many at once — one write and one re-render, not N of each. Used by the
 *  Spotify import, where N is up to 100. */
export function addTracksToPlaylist(id: string, tracks: Track[]): number {
  let added = 0;
  store.update(list =>
    list.map(p => {
      if (p.id !== id) {
        return p;
      }
      const have = new Set((p.tracks || []).map(getTrackId));
      const fresh: Track[] = [];
      for (const raw of tracks) {
        const t = normalizeTrack(raw);
        if (!t) {
          continue;
        }
        const tid = getTrackId(t);
        if (have.has(tid)) {
          continue;
        }
        have.add(tid);
        fresh.push(t);
      }
      added = fresh.length;
      return fresh.length
        ? {
            ...p,
            tracks: [...(p.tracks || []), ...fresh],
            updatedAt: Date.now(),
          }
        : p;
    }),
  );
  return added;
}

export function removeTrackFromPlaylist(id: string, track: Track): void {
  const tid = getTrackId(normalizeTrack(track));
  store.update(list =>
    list.map(p =>
      p.id === id
        ? {
            ...p,
            tracks: (p.tracks || []).filter(x => getTrackId(x) !== tid),
            updatedAt: Date.now(),
          }
        : p,
    ),
  );
}

/**
 * Which of these playlists already hold the track.
 *
 * Takes the list rather than reading the store, because every caller is a
 * component that has already subscribed to it — reading it again here would
 * give a second, independently-timed copy of the same answer.
 */
export function playlistsContaining(
  list: Playlist[],
  track: Track | null,
): Set<string> {
  const t = track ? normalizeTrack(track) : null;
  if (!t) {
    return new Set();
  }
  const tid = getTrackId(t);
  return new Set(
    list
      .filter(p => (p.tracks || []).some(x => getTrackId(x) === tid))
      .map(p => p.id),
  );
}

export function usePlaylists(): Playlist[] {
  return useStoreValue(store);
}
