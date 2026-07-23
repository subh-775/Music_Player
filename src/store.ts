/**
 * Persisted app state: liked songs and user settings.
 *
 * A tiny module-level store with a subscribe/snapshot pair, so state survives a
 * screen unmounting and every screen sees the same values. Writes are mirrored
 * to AsyncStorage; reads come from memory, so the UI never waits on disk.
 */
import {useCallback, useSyncExternalStore} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {Track} from './backend';

const LIKES_KEY = 'mp.likes.v1';
const SETTINGS_KEY = 'mp.settings.v1';

export type Settings = {
  audioQuality: number; // 0 = auto, else kbps
  showSourceBadge: boolean;
  showQualityBadge: boolean;
  autoplay: boolean;
  eqEnabled: boolean;
  eqPreset: string;
  eqGains: number[] | null;
};

export const DEFAULT_SETTINGS: Settings = {
  audioQuality: 320,
  showSourceBadge: true,
  showQualityBadge: true,
  autoplay: true,
  eqEnabled: false,
  eqPreset: 'flat',
  eqGains: null,
};

type StoreState = {likes: Track[]; settings: Settings; hydrated: boolean};

let state: StoreState = {
  likes: [],
  settings: {...DEFAULT_SETTINGS},
  hydrated: false,
};
const listeners = new Set<() => void>();

function emit() {
  state = {...state};
  listeners.forEach(l => l());
}

/** Load once at startup. Corrupt or missing values fall back to defaults. */
export async function hydrate(): Promise<void> {
  try {
    const [rawLikes, rawSettings] = await AsyncStorage.multiGet([
      LIKES_KEY,
      SETTINGS_KEY,
    ]);
    const likes = rawLikes[1] ? JSON.parse(rawLikes[1]) : [];
    const settings = rawSettings[1] ? JSON.parse(rawSettings[1]) : {};
    state = {
      likes: Array.isArray(likes) ? likes : [],
      settings: {...DEFAULT_SETTINGS, ...settings},
      hydrated: true,
    };
  } catch {
    state = {...state, hydrated: true};
  }
  emit();
}

function persistLikes() {
  AsyncStorage.setItem(LIKES_KEY, JSON.stringify(state.likes)).catch(() => {});
}
function persistSettings() {
  AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)).catch(
    () => {},
  );
}

/** Identity for a track across sources — title+artist is what the user means
 *  by "the same song", and it survives a different source serving it. */
export function trackKey(t: Track): string {
  return `${(t.title || '').toLowerCase()}|${(t.artist || '').toLowerCase()}`;
}

export function isLiked(t: Track): boolean {
  const k = trackKey(t);
  return state.likes.some(x => trackKey(x) === k);
}

export function toggleLike(t: Track): boolean {
  const k = trackKey(t);
  const had = state.likes.some(x => trackKey(x) === k);
  state = {
    ...state,
    likes: had
      ? state.likes.filter(x => trackKey(x) !== k)
      : [t, ...state.likes],
  };
  persistLikes();
  emit();
  return !had;
}

export function writeSetting<K extends keyof Settings>(
  key: K,
  value: Settings[K],
): void {
  state = {...state, settings: {...state.settings, [key]: value}};
  persistSettings();
  emit();
}

export function resetSettings(): void {
  state = {...state, settings: {...DEFAULT_SETTINGS}};
  persistSettings();
  emit();
}

/** Effective streaming bitrate. "Auto" (0) resolves to 320 — the backend walks
 *  its own ladder down from there if the source can't serve it. */
export function currentQuality(): number {
  const q = state.settings.audioQuality;
  return q && q > 0 ? q : 320;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
const snapshot = () => state;

export function useStore(): StoreState {
  return useSyncExternalStore(subscribe, snapshot);
}

/** Convenience: liked state for one track, plus a toggle bound to it. */
export function useLike(track: Track | null) {
  const {likes} = useStore();
  const liked = track
    ? likes.some(x => trackKey(x) === trackKey(track))
    : false;
  const toggle = useCallback(() => {
    if (track) {
      toggleLike(track);
    }
  }, [track]);
  return {liked, toggle};
}
