/**
 * The sleep timer's end-of-track failure modes, all of which sounded like bugs.
 *
 * 1. "End of track" let the next song start and then stopped it a moment in:
 *    the old JS one-shot began a 2.5s fade 0.15s before the end, and with the
 *    screen off it never ran at all. ExoPlayer now pauses on the last frame
 *    itself, so arming and cancelling the timer must flip that switch.
 * 2. Pressing next with an end-of-track timer armed stopped the music
 *    immediately, because that skip's track change was consumed as if the song
 *    had ended.
 */
import {expect, jest, test, beforeEach} from '@jest/globals';

const paused: string[] = [];
const pauseAtEnd: boolean[] = [];
jest.mock('../src/player', () => ({
  fadeToPause: async () => {
    paused.push('fade');
  },
  cancelCrossfade: () => undefined,
}));
jest.mock('../src/audioEffects', () => ({
  setPauseAtEndOfTrack: async (on: boolean) => {
    pauseAtEnd.push(on);
    return true;
  },
}));
jest.mock('../src/diag', () => ({diag: () => undefined}));

import {
  cancelSleepTimer,
  sleepAtEndOfTrack,
  sleepMode,
  sleepTimerOnPause,
  sleepTimerOnTrackChange,
  startSleepTimer,
} from '../src/sleepTimer';

beforeEach(() => {
  cancelSleepTimer();
  paused.length = 0;
  pauseAtEnd.length = 0;
  jest.useFakeTimers();
});

test('arming end of track tells the engine to pause on the last frame', () => {
  sleepAtEndOfTrack();
  expect(pauseAtEnd).toEqual([true]);
});

test('cancelling, or switching to a clock timer, turns it back off', () => {
  sleepAtEndOfTrack();
  cancelSleepTimer();
  sleepAtEndOfTrack();
  startSleepTimer(15);
  expect(pauseAtEnd).toEqual([true, false, true, false]);
});

test('the pause at the end clears the timer, so play carries on', () => {
  sleepAtEndOfTrack();
  sleepTimerOnPause(true);
  expect(sleepMode()).toBe('off');
  expect(pauseAtEnd).toEqual([true, false]);
  expect(paused).toEqual([]); // already stopped — no second fade
});

test('pausing by hand mid-song keeps the timer armed', () => {
  sleepAtEndOfTrack();
  sleepTimerOnPause(false);
  expect(sleepMode()).toBe('endOfTrack');
});

test('a manual skip does not consume an armed end-of-track timer', () => {
  sleepAtEndOfTrack();
  sleepTimerOnTrackChange(false); // the user pressed next
  expect(paused).toEqual([]);
  expect(sleepMode()).toBe('endOfTrack');
});

test('an automatic advance still stops, as the backstop', () => {
  sleepAtEndOfTrack();
  sleepTimerOnTrackChange(true); // the engine refused the switch and moved on
  expect(paused).toEqual(['fade']);
  expect(sleepMode()).toBe('off');
});
