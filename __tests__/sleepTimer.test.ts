/**
 * The sleep timer's two failure modes, both of which sounded like bugs.
 *
 * 1. "End of track" stopped one to two seconds INTO the next song, because the
 *    only trigger was PlaybackActiveTrackChanged — an event that by definition
 *    fires once the next track is already active and playing.
 * 2. Pressing next with an end-of-track timer armed stopped the music
 *    immediately, because that skip's track change was consumed as if the song
 *    had ended.
 */
import {expect, jest, test, beforeEach} from '@jest/globals';

const paused: string[] = [];
jest.mock('../src/player', () => ({
  fadeToPause: async () => {
    paused.push('fade');
  },
  cancelCrossfade: () => undefined,
}));
jest.mock('../src/diag', () => ({diag: () => undefined}));

import {
  cancelSleepTimer,
  scheduleEndOfTrackStop,
  sleepAtEndOfTrack,
  sleepMode,
  sleepTimerOnTrackChange,
} from '../src/sleepTimer';

beforeEach(() => {
  paused.length = 0;
  cancelSleepTimer();
  jest.useFakeTimers();
});

test('a manual skip does not consume an armed end-of-track timer', () => {
  sleepAtEndOfTrack();
  sleepTimerOnTrackChange(false); // the user pressed next
  expect(paused).toEqual([]);
  expect(sleepMode()).toBe('endOfTrack');
});

test('an automatic advance still stops, as the backstop', () => {
  sleepAtEndOfTrack();
  sleepTimerOnTrackChange(true); // the song ended by itself
  expect(paused).toEqual(['fade']);
  expect(sleepMode()).toBe('off');
});

test('the punctual stop lands before the boundary, not after it', () => {
  sleepAtEndOfTrack();
  scheduleEndOfTrackStop(2); // two seconds of track left
  jest.advanceTimersByTime(1800);
  expect(paused).toEqual([]); // not yet
  jest.advanceTimersByTime(100); // 1850ms = 2s - 150ms
  expect(paused).toEqual(['fade']);
});

test('arming is idempotent — the watcher calls it every tick', () => {
  sleepAtEndOfTrack();
  scheduleEndOfTrackStop(2);
  scheduleEndOfTrackStop(1);
  scheduleEndOfTrackStop(0.5);
  jest.advanceTimersByTime(5000);
  expect(paused).toEqual(['fade']); // one stop, not three
});

test('cancelling clears a stop that was already armed', () => {
  sleepAtEndOfTrack();
  scheduleEndOfTrackStop(2);
  cancelSleepTimer();
  jest.advanceTimersByTime(5000);
  expect(paused).toEqual([]);
  expect(sleepMode()).toBe('off');
});

test('nothing is armed when no timer is set', () => {
  scheduleEndOfTrackStop(2);
  jest.advanceTimersByTime(5000);
  expect(paused).toEqual([]);
});
