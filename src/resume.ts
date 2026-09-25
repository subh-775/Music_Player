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

/** How many tracks of history to keep behind the current one, so Previous
 *  still has somewhere to go after a restore. */
const KEEP_BEHIND = 10;

/**
 * The slice of the queue worth saving, and where the current track sits in it.
 *
 * It used to be the FIRST 40 tracks paired with the engine's absolute index.
 * Past track 40 — a long playlist, or any session autoplay had topped up a few
 * times — the index pointed beyond the saved list, restore clamped it to the
 * last item, and the app reopened on the wrong song at the right timestamp.
 * A window AROUND the current track keeps the index inside what was saved.
 *
 * Exported for the test.
 */
export function resumeWindow<T>(
  queue: T[],
  index: number,
): {queue: T[]; index: number} {
  const at = Math.max(0, Math.min(queue.length - 1, index));
  const start = Math.max(0, at - KEEP_BEHIND);
  return {queue: queue.slice(start, start + QUEUE_MAX), index: at - start};
}

/**
 * Where to resume, after restore has dropped any tracks that are no longer
 * playable. Found by the saved track itself first — dropping an unplayable
 * track shifts every later index by one — and by the index only when the track
 * is not in the list at all.
 *
 * Exported for the test.
 */
export function resumeIndex(
  /** The tracks that survived, each with its position in the SAVED list. */
  kept: {title?: string; artist?: string; from: number}[],
  saved: {index: number; track?: {title?: string; artist?: string} | null},
): number {
  const t = saved.track;
  if (t) {
    let best = -1;
    kept.forEach((k, i) => {
      // The same song can be queued twice; take the copy that was saved
      // nearest the current position.
      if (
        k.title === t.title &&
        k.artist === t.artist &&
        (best < 0 ||
          Math.abs(k.from - saved.index) <
            Math.abs(kept[best].from - saved.index))
      ) {
        best = i;
      }
    });
    if (best >= 0) {
      return best;
    }
  }
  // No title match: the first survivor at or after the saved position.
  const next = kept.findIndex(k => k.from >= saved.index);
  return next >= 0 ? next : Math.max(0, kept.length - 1);
}

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
  const win = resumeWindow(state.queue || [], Math.max(0, state.index || 0));
  const payload: ResumeState = {
    track: state.track,
    position: Math.max(0, Math.floor(state.position || 0)),
    queue: win.queue,
    index: win.index,
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
