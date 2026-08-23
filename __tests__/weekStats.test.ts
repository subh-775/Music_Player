/**
 * The week reducer's arithmetic.
 *
 * summarizeWeek derives how long each song ran from WHEN THE NEXT ONE STARTED,
 * which is the whole reason nothing has to be written on pause/skip/end. That
 * derivation has two ways to be wrong and both of them are silent: it can
 * inflate (crediting a gap the user was not listening through) or it can
 * truncate (capping a play that really did run its length). These pin both.
 */
// Imported rather than global, so this typechecks without pulling in @types/jest.
import {expect, jest, test} from '@jest/globals';

// stats.ts pulls in the AsyncStorage-backed store at module load; the reducer
// under test touches none of it.
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: async () => null,
  setItem: async () => undefined,
  removeItem: async () => undefined,
}));

import {summarizeWeek, type Play} from '../src/stats';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// A fixed "now" so nothing here depends on when the suite runs.
const NOW = 1_700_000_000_000;

const play = (minutesAgo: number, fullSecs: number, src = 'jiosaavn'): Play => ({
  at: NOW - minutesAgo * MIN,
  full: fullSecs,
  src,
});

test('a song counts the gap until the next one, not its full length', () => {
  // Started 10 min ago, 200s long, but the next song began 2 min later — so
  // only 2 minutes of it were actually heard.
  const log: Play[] = [play(10, 200), play(8, 200)];
  const w = summarizeWeek(log, NOW);
  // 120s heard + the last one still running for 8 min, capped at its 200s.
  expect(w.minutes).toBe(Math.round((120 + 200) / 60));
  expect(w.songs).toBe(2);
});

test('a skipped song counts only the seconds it ran', () => {
  const log: Play[] = [
    {at: NOW - 5 * MIN, full: 300, src: 'jiosaavn'},
    {at: NOW - 5 * MIN + 5000, full: 300, src: 'jiosaavn'}, // 5s later
  ];
  const w = summarizeWeek(log, NOW);
  // 5s for the skipped one, then the second capped at its own 300s length
  // (it has been "running" for 4m55s, which is less than 300s).
  expect(w.minutes).toBe(Math.round((5 + (5 * 60 - 5)) / 60));
});

test('an app left closed overnight cannot report a night of listening', () => {
  // One song started 12 hours ago and nothing since. Uncapped this would be
  // 720 minutes; capped at the track length it is 4.
  const log: Play[] = [{at: NOW - 12 * HOUR, full: 240, src: 'jiosaavn'}];
  expect(summarizeWeek(log, NOW).minutes).toBe(4);
});

test('a play with no known length is still bounded', () => {
  // full: 0 — the backend gave no duration. Ten minutes is the ceiling.
  const log: Play[] = [{at: NOW - 12 * HOUR, full: 0, src: 'youtube'}];
  expect(summarizeWeek(log, NOW).minutes).toBe(10);
});

test('anything older than seven days is not counted at all', () => {
  const log: Play[] = [
    {at: NOW - 8 * DAY, full: 300, src: 'jiosaavn'},
    play(30, 180),
  ];
  const w = summarizeWeek(log, NOW);
  expect(w.songs).toBe(1);
  expect(w.sources).toEqual([{name: 'jiosaavn', songs: 1, share: 1}]);
});

test('sources are a share of the week, biggest first', () => {
  const log: Play[] = [
    play(60, 180, 'jiosaavn'),
    play(50, 180, 'jiosaavn'),
    play(40, 180, 'jiosaavn'),
    play(30, 180, 'youtube'),
  ];
  const w = summarizeWeek(log, NOW);
  expect(w.sources.map(s => s.name)).toEqual(['jiosaavn', 'youtube']);
  expect(w.sources[0].share).toBeCloseTo(0.75);
  expect(w.sources[1].share).toBeCloseTo(0.25);
});

test('perDay buckets today last and six days ago first', () => {
  const log: Play[] = [
    {at: NOW - 6 * DAY - HOUR, full: 180, src: 'jiosaavn'}, // just under 7 days
    {at: NOW - 2 * HOUR, full: 180, src: 'jiosaavn'}, // today
    {at: NOW - 3 * HOUR, full: 180, src: 'jiosaavn'}, // today
  ];
  const w = summarizeWeek(log, NOW);
  expect(w.perDay).toHaveLength(7);
  expect(w.perDay[0]).toBe(1);
  expect(w.perDay[6]).toBe(2);
});

test('an empty log is zeroes, not NaN', () => {
  const w = summarizeWeek([], NOW);
  expect(w).toEqual({
    minutes: 0,
    songs: 0,
    sources: [],
    perDay: [0, 0, 0, 0, 0, 0, 0],
  });
});
