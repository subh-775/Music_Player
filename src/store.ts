/**
 * Liked songs and user settings.
 *
 * Identity comes from tracks.ts — this file used to carry its own `trackKey`
 * (lowercased title+artist, no ISRC, no cleanText), which meant likes and
 * playlist dedup were judging "the same song" by two different rules. One rule
 * now, in one place.
 */
import {useCallback, useSyncExternalStore} from 'react';
import {createStore, asArray, hydrateAll, useStoreValue} from './storage';
import {getTrackId} from './tracks';
import type {Track} from './backend';
// Imported for side effect: creating a store registers it for hydration, so a
// store no screen has rendered yet is still loaded at startup.
import './playlists';
import './pins';
import './searchHistory';
import './collections';
import './artists';

export type Settings = {
  audioQuality: number; // 0 = auto, else kbps
  showSourceBadge: boolean;
  showQualityBadge: boolean;
  autoplay: boolean;
  crossfadeDuration: number; // seconds; 0 = off
  normalizeVolume: boolean;
  eqEnabled: boolean;
  eqPreset: string;
  eqGains: number[] | null;
};

export const DEFAULT_SETTINGS: Settings = {
  audioQuality: 320,
  showSourceBadge: true,
  showQualityBadge: true,
  autoplay: true,
  crossfadeDuration: 0,
  normalizeVolume: false,
  // Off by default: an untouched signal path is the one guaranteed to play
  // everywhere, and an effect the user didn't ask for is a bug report.
  eqEnabled: false,
  eqPreset: 'flat',
  eqGains: null,
};

const likesStore = createStore<Track[]>('mp.likes.v1', [], asArray);
const settingsStore = createStore<Settings>(
  'mp.settings.v1',
  DEFAULT_SETTINGS,
  raw => ({...DEFAULT_SETTINGS, ...(raw as Partial<Settings>)}),
);

// ─── Likes ──────────────────────────────────────────────────────────────────

export function isLiked(t: Track): boolean {
  const k = getTrackId(t);
  return likesStore.get().some(x => getTrackId(x) === k);
}

/** Returns the new state (true = now liked). Newest likes go on top. */
export function toggleLike(t: Track): boolean {
  const k = getTrackId(t);
  const list = likesStore.get();
  const had = list.some(x => getTrackId(x) === k);
  likesStore.set(had ? list.filter(x => getTrackId(x) !== k) : [t, ...list]);
  return !had;
}

// ─── Settings ───────────────────────────────────────────────────────────────

export function writeSetting<K extends keyof Settings>(
  key: K,
  value: Settings[K],
): void {
  settingsStore.update(s => ({...s, [key]: value}));
}

export function writeSettings(patch: Partial<Settings>): void {
  settingsStore.update(s => ({...s, ...patch}));
}

export function resetSettings(): void {
  settingsStore.set({...DEFAULT_SETTINGS});
}

export const readSettings = settingsStore.get;

/** Effective streaming bitrate. "Auto" (0) resolves to 320 — the backend walks
 *  its own ladder down from there if the source can't serve it. */
export function currentQuality(): number {
  const q = settingsStore.get().audioQuality;
  return q && q > 0 ? q : 320;
}

// ─── Hydration + hooks ──────────────────────────────────────────────────────

/**
 * Load everything persisted, once, at startup.
 *
 * Stores register themselves with the storage registry when created, so this
 * doesn't need to know which stores exist — which is what keeps store.ts from
 * having to import collections.ts, which imports store.ts right back.
 *
 * Importing the modules for side effect is what puts them in that registry;
 * without these, a store nothing has rendered yet would never be loaded.
 */
export async function hydrate(): Promise<void> {
  await hydrateAll();
}

export const useSettings = () => useStoreValue(settingsStore);
export const useLikes = () => useStoreValue(likesStore);

/** Both halves at once, for screens that need them together. */
export function useStore(): {likes: Track[]; settings: Settings} {
  const likes = useSyncExternalStore(likesStore.subscribe, likesStore.get);
  const settings = useSyncExternalStore(
    settingsStore.subscribe,
    settingsStore.get,
  );
  return {likes, settings};
}

/** Liked state for one track, plus a toggle bound to it. */
export function useLike(track: Track | null) {
  const likes = useLikes();
  const liked = track
    ? likes.some(x => getTrackId(x) === getTrackId(track))
    : false;
  const toggle = useCallback(() => {
    if (track) {
      toggleLike(track);
    }
  }, [track]);
  return {liked, toggle};
}
