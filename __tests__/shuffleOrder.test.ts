/**
 * Shuffle off must RESTORE, not reshuffle.
 *
 * The report was "each time shuffle is turned on or off, the songs are
 * randomized", and both halves of that were one bug. Turning shuffle on
 * snapshots the upcoming tracks so that turning it off can put them back — but
 * the queue keeps moving in between. Songs play and leave the upcoming list,
 * radio appends more, a swipe skips two at once. Re-adding the snapshot whole
 * put back songs that had already been heard and dropped ones added since, so
 * OFF produced an order every bit as arbitrary as ON. Neither direction ever
 * restored anything, which is why it read as a button that did not work.
 *
 * The rule is one sentence: keep the ORDER from the snapshot, keep the
 * MEMBERSHIP from the live queue.
 */
import {expect, jest, test} from '@jest/globals';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('react-native', () => ({
  NativeModules: {},
  AppState: {currentState: 'active', addEventListener: () => ({remove() {}})},
  Image: {prefetch: () => Promise.resolve()},
}));
jest.mock('react-native-track-player', () => ({
  __esModule: true,
  default: {},
  State: {},
  Event: {},
  RepeatMode: {Off: 0, Track: 1, Queue: 2},
}));

// NB: this import must stay below the mocks above — jest hoists jest.mock().
import {restoreOrder, shuffleUpcoming} from '../src/player';

const row = (qid: string) => ({_qid: qid, title: qid});

test('restores the original order of what is still ahead', () => {
  const snapshot = [row('a'), row('b'), row('c'), row('d')];
  // b and d are still upcoming, in whatever order the shuffle left them.
  const live = [row('d'), row('b')];
  expect(restoreOrder(snapshot, live).map(t => t._qid)).toEqual(['b', 'd']);
});

test('drops tracks that have already played', () => {
  const snapshot = [row('a'), row('b'), row('c')];
  // 'a' played while shuffle was on, so it must not come back.
  const live = [row('c'), row('b')];
  expect(restoreOrder(snapshot, live).map(t => t._qid)).toEqual(['b', 'c']);
});

test('never introduces a track the queue does not hold', () => {
  // Radio appended 'z' after the snapshot was taken. Restoring must not
  // remove it either — it simply is not this function's business, so it
  // must not appear in the output and the caller keeps it where it is.
  const snapshot = [row('a'), row('b')];
  const live = [row('b'), row('z')];
  expect(restoreOrder(snapshot, live).map(t => t._qid)).toEqual(['b']);
});

test('two copies of one song are two rows, and only one may be upcoming', () => {
  // `_qid` and not the track id, precisely for this: queue a song twice and
  // both rows claim the same song identity.
  const snapshot = [{_qid: 'q1', title: 'same'}, {_qid: 'q2', title: 'same'}];
  const live = [{_qid: 'q2', title: 'same'}];
  expect(restoreOrder(snapshot, live).map(t => t._qid)).toEqual(['q2']);
});

test('an unstamped row is dropped rather than matched to every other one', () => {
  // A queue item from an older build carries no _qid. `undefined === undefined`
  // would otherwise make every such row match every other.
  type Row = {_qid?: string; title: string};
  const snapshot: Row[] = [{title: 'old'}, row('b')];
  const live: Row[] = [{title: 'other'}, row('b')];
  expect(restoreOrder(snapshot, live).map(t => t._qid)).toEqual(['b']);
});

test('nothing still ahead restores nothing', () => {
  expect(restoreOrder([row('a'), row('b')], [])).toEqual([]);
});

test('shuffle keeps every track exactly once', () => {
  const rest = Array.from({length: 40}, (_, i) => row(`t${i}`));
  const out = shuffleUpcoming(rest);
  expect(out).toHaveLength(rest.length);
  expect(new Set(out.map(t => t._qid)).size).toBe(rest.length);
  expect(rest.map(t => t._qid)).toEqual(
    Array.from({length: 40}, (_, i) => `t${i}`), // the input is not mutated
  );
});

test('shuffle actually reorders a list of any size', () => {
  // Fisher-Yates can legitimately return the identity, so this checks that it
  // is not doing so every time rather than that one call moved something.
  const rest = Array.from({length: 12}, (_, i) => row(`t${i}`));
  const original = rest.map(t => t._qid).join();
  const moved = Array.from({length: 25}, () =>
    shuffleUpcoming(rest)
      .map(t => t._qid)
      .join(),
  ).filter(o => o !== original);
  expect(moved.length).toBeGreaterThan(20);
});
