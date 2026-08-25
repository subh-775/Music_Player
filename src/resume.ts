/**
 * Remember where you left off, and pick it up on the next launch.
 *
 * The WebView build saved the current song, its position, and the queue to
 * storage, and reopened on that exact song at that exact timestamp, paused,
 * with the queue intact. This is the RN equivalent, and the reason the mini
 * player is there the moment the app reopens instead of a blank home screen.
 *
 * AsyncStorage directly rather than a reactive store: this is written on a
 * throttle from the playback tick (a store's re-render-on-write would be waste)
 * and read exactly once, at boot.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {Track} from './backend';

const KEY = 'mp.resume.v1';
const QUEUE_MAX = 40;
const SAVE_EVERY_MS = 4000;

export type ResumeState = {
  track: Track;
  position: number;
  queue: Track[];
  index: number;
  savedAt: number;
};

let lastWrite = 0;

/**
 * Persist the session. Throttled so the per-second playback tick doesn't hammer
 * disk; `force` (used on track change / pause) bypasses the throttle so those
 * moments are never lost.
 */
export function saveResume(
  state: {track: Track | null; position: number; queue: Track[]; index: number},
  force = false,
): void {
  if (!state.track) {
    return;
  }
  const now = Date.now();
  if (!force && now - lastWrite < SAVE_EVERY_MS) {
    return;
  }
  lastWrite = now;
  const payload: ResumeState = {
    track: state.track,
    position: Math.max(0, Math.floor(state.position || 0)),
    queue: (state.queue || []).slice(0, QUEUE_MAX),
    index: Math.max(0, state.index || 0),
    savedAt: now,
  };
  AsyncStorage.setItem(KEY, JSON.stringify(payload)).catch(() => {
    // Storage full / unavailable — resume is a convenience, never fatal.
  });
}

export async function readResume(): Promise<ResumeState | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) {
      return null;
    }
    const s = JSON.parse(raw) as ResumeState;
    return s && s.track ? s : null;
  } catch {
    return null;
  }
}

export function clearResume(): void {
  lastWrite = 0;
  AsyncStorage.removeItem(KEY).catch(() => {});
}
