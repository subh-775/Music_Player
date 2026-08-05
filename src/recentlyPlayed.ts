/**
 * Recently played — the row at the top of Home.
 *
 * Recorded at play-START, before enrichment has had a chance to run, so a
 * track saved here can carry the source's raw metadata. [remember] re-writes
 * an existing entry rather than adding a second one, which is how a song
 * whose artist/artwork cleaned up a moment later shows the improved version
 * next time Home renders.
 */
import {createStore, asArray, useStoreValue} from './storage';
import {getTrackId} from './tracks';
import {recordPlay} from './stats';
import type {Track} from './backend';

const MAX = 20;

const store = createStore<Track[]>('mp.recent.v1', [], raw =>
  asArray<Track>(raw).slice(0, MAX),
);

/** Move a track to the front, replacing any older copy of the same song. */
export function remember(track: Track): void {
  const id = getTrackId(track);
  store.update(list => [track, ...list.filter(t => getTrackId(t) !== id)].slice(0, MAX));
  // The long-term counter rides along here rather than at every call site, so
  // "a song started" is recorded in exactly one place.
  recordPlay(track);
}

export function clearRecent(): void {
  store.set([]);
}

export function useRecentlyPlayed(): Track[] {
  return useStoreValue(store);
}
