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
 * "End of track" needs no timer at all: it just marks the next track change as
 * the moment to stop, which native delivers whether or not JS is awake.
 */
import {useSyncExternalStore} from 'react';
import {pausePlayback} from './player';
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

async function fire(reason: string) {
  diag('sleep', `stopping playback (${reason})`);
  cancelSleepTimer();
  await pausePlayback();
}

/** Called on every engine track change, so the deadline is checked by a native
 *  event rather than only by a JS interval that the OS may have frozen. */
export function sleepTimerOnTrackChange(): void {
  if (state.mode === 'endOfTrack') {
    fire('end of track');
    return;
  }
  if (state.mode === 'clock' && Date.now() >= state.endsAt) {
    fire('deadline passed');
  }
}

export function startSleepTimer(minutes: number): void {
  stopTicker();
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
  state = {mode: 'endOfTrack', endsAt: 0, remaining: 0};
  emit();
  diag('sleep', 'will stop at end of track');
}

export function cancelSleepTimer(): void {
  stopTicker();
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
