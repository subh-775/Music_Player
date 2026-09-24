/**
 * Relaunching must reopen on the song you left, however deep into the queue.
 *
 * The saved queue used to be the FIRST 40 tracks paired with the engine's
 * absolute index, so anywhere past track 40 the index pointed off the end of
 * what was saved and restore clamped it to the last item: the wrong song, at
 * the right timestamp. Autoplay tops a queue up eight at a time, so any long
 * session got there.
 */
import {expect, jest, test} from '@jest/globals';

jest.mock('@react-native-async-storage/async-storage', () => ({}));

// NB: below the mock — jest hoists jest.mock().
import {resumeIndex, resumeWindow} from '../src/resume';

const queue = Array.from({length: 120}, (_, i) => ({
  title: `Song ${i}`,
  artist: 'A',
}));

test('the saved window contains the current track, at the saved index', () => {
  for (const at of [0, 5, 39, 40, 45, 100, 119]) {
    const w = resumeWindow(queue, at);
    expect(w.queue[w.index]).toBe(queue[at]);
    expect(w.queue.length).toBeLessThanOrEqual(40);
  }
});

test('the window keeps some history, so Previous still works', () => {
  const w = resumeWindow(queue, 45);
  expect(w.index).toBe(10);
});

test('an out-of-range index is clamped, never left dangling', () => {
  const w = resumeWindow(queue, 500);
  expect(w.queue[w.index]).toBe(queue[119]);
});

test('restore finds the track after unplayable ones were dropped', () => {
  // Saved: 0..4 with the current song at 3; entry 1 no longer plays, so
  // everything after it has shifted down one.
  const kept = [0, 2, 3, 4].map(from => ({...queue[from], from}));
  expect(
    resumeIndex(kept, {index: 3, track: {title: 'Song 3', artist: 'A'}}),
  ).toBe(2);
});

test('two copies of one song: the one nearest the saved position wins', () => {
  const kept = [
    {title: 'X', artist: 'A', from: 0},
    {title: 'Y', artist: 'A', from: 1},
    {title: 'X', artist: 'A', from: 2},
  ];
  expect(resumeIndex(kept, {index: 2, track: {title: 'X', artist: 'A'}})).toBe(
    2,
  );
});

test('with no title match, the next surviving track is used', () => {
  const kept = [0, 1, 4, 5].map(from => ({...queue[from], from}));
  expect(resumeIndex(kept, {index: 3, track: null})).toBe(2);
});
