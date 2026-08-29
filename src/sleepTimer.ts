/**
 * Sleep timer: stop the music after N minutes, or at the end of this track.
 *
 * The countdown is a plain JS timer, which is fine for the DISPLAY, but the
 * stop itself must not depend on it — Android throttles JS timers once the
 * screen is off, which is precisely when a sleep timer matters. So the deadline
 * is stored as a wall-clock timestamp and checked on every tick AND on every
 * track change (an event that comes from native), and the fade-and-pause runs
 * through the player, not through a setTimeout that may never fire on time.
 *
 * "End of track" used to have no timer at all: it marked the next track change
 * as the moment to stop. That is reliable — native delivers it whether or not
 * JS is awake — but it is not PUNCTUAL, because the event fires once the next
 * track has already become active and started playing. The stop then landed one
 * to two seconds into a song nobody asked for.
 *
 * So end-of-track now has two paths. The primary one is a one-shot armed two
 * seconds out by the playback watcher, which lands on the boundary itself. The
 * track change stays exactly as it was, as the BACKSTOP: if JS was frozen and
 * the one-shot never ran, the event still stops playback — late, rather than
 * never.
 */
import {useSyncExternalStore} from 'react';
import {cancelCrossfade, fadeToPause} from './player';
import {diag} from './diag';

type Mode = 'off' | 'clock' | 'endOfTrack';

type State = {
  mode: Mode;
  /** Wall-clock ms when playback should stop (clock mode only). */
  endsAt: number;
  /** Seconds left, for the UI. */
  remaining: number;
};

let state: State = {mode: 'off', endsAt: 0, remaining: 0};
const listeners = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | null = null;
/** The punctual end-of-track stop. Null whenever one is not armed. */
let boundaryStop: ReturnType<typeof setTimeout> | null = null;

function emit() {
  state = {...state};
  listeners.forEach(l => l());
}

function stopTicker() {
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

function clearBoundaryStop() {
  if (boundaryStop) {
    clearTimeout(boundaryStop);
    boundaryStop = null;
  }
}

async function fire(reason: string) {
  diag('sleep', `stopping playback (${reason})`);
  cancelSleepTimer();
  // Not pausePlayback: this is someone falling asleep, and music stopping dead
  // is a worse way to end than music receding. Every other pause in the app is
  // a button press and stays instant.
  await fadeToPause();
}

/** What the timer is set to, for the parts of playback that have to behave
 *  differently while one is armed. */
export function sleepMode(): Mode {
  return state.mode;
}

/**
 * Arm the punctual stop, from the playback watcher's tick.
 *
 * Idempotent: the watcher calls this every second inside the window, and only
 * the first call arms anything. Two seconds of lead is deliberate — long
 * enough that a one-second tick cannot miss the window, short enough that the
 * OS has not yet had a reason to freeze us since the last time it saw us.
 */
export function scheduleEndOfTrackStop(remainingSeconds: number): void {
  if (state.mode !== 'endOfTrack' || boundaryStop) {
    return;
  }
  // A shade before the boundary rather than on it. Landing after the engine has
  // already moved on is the entire bug this replaces.
  const ms = Math.max(0, (remainingSeconds - 0.15) * 1000);
  boundaryStop = setTimeout(() => {
    boundaryStop = null;
    fire('track boundary');
  }, ms);
}

/**
 * Called on every engine track change, so the deadline is checked by a native
 * event rather than only by a JS interval that the OS may have frozen.
 *
 * `automatic` is false when the user pressed skip. An end-of-track timer means
 * "this song, then silence" — it is not a promise to stop at whatever track
 * change happens to come next, and consuming it on a manual skip stopped the
 * music the instant someone pressed next, which reads as a bug rather than as
 * a timer.
 */
export function sleepTimerOnTrackChange(automatic: boolean): void {
  if (state.mode === 'endOfTrack') {
    if (automatic) {
      fire('end of track');
    }
    return;
  }
  if (state.mode === 'clock' && Date.now() >= state.endsAt) {
    fire('deadline passed');
  }
}

export function startSleepTimer(minutes: number): void {
  stopTicker();
  clearBoundaryStop();
  state = {
    mode: 'clock',
    endsAt: Date.now() + minutes * 60_000,
    remaining: minutes * 60,
  };
  emit();
  diag('sleep', `timer set for ${minutes}m`);
  ticker = setInterval(() => {
    const left = Math.max(0, Math.round((state.endsAt - Date.now()) / 1000));
    state = {...state, remaining: left};
    emit();
    if (left <= 0) {
      fire('timer elapsed');
    }
  }, 1000);
}

export function sleepAtEndOfTrack(): void {
  stopTicker();
  clearBoundaryStop();
  state = {mode: 'endOfTrack', endsAt: 0, remaining: 0};
  emit();
  // An overlap may already be running when the timer is armed — a 12s crossfade
  // starts twelve seconds before the boundary. Left alone it would mix the next
  // song into the last seconds of the one you meant to fall asleep to.
  cancelCrossfade();
  diag('sleep', 'will stop at end of track');
}

export function cancelSleepTimer(): void {
  stopTicker();
  clearBoundaryStop();
  state = {mode: 'off', endsAt: 0, remaining: 0};
  emit();
}

/** "23 min", "45 sec", "End of track", or null when nothing is set. */
export function sleepLabel(s: State): string | null {
  if (s.mode === 'endOfTrack') {
    return 'End of track';
  }
  if (s.mode !== 'clock') {
    return null;
  }
  const m = Math.ceil(s.remaining / 60);
  return m > 1 ? `${m} min` : `${s.remaining} sec`;
}

export function useSleepTimer(): State {
  return useSyncExternalStore(
    l => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
