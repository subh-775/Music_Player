/**
 * The order of the Library list.
 *
 * Two rules stacked, and getting either one wrong is silent: pins keep their
 * pin order at the top, and everything below them sorts by when it last
 * changed. The failure mode is not a crash — it is a library that looks
 * subtly reshuffled after an upgrade, which is the kind of thing nobody
 * reports as a bug and everybody notices.
 *
 * The missing-stamp case is the one worth pinning hardest. Every playlist
 * stored before `updatedAt` existed has none, and a comparator that reads
 * `undefined` as "now" would float all of them above the ones the user has
 * actually been using.
 */
import {expect, jest, test} from '@jest/globals';

// pins.ts reaches storage.ts, which reaches AsyncStorage's native module. The
// sort itself touches none of it — this is only here so the import resolves.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// NB: this import must stay below the mock above — jest hoists jest.mock().
import {sortPinned} from '../src/pins';

type Row = {id: string; updatedAt?: number};
const idOf = (r: Row) => r.id;
const recency = (r: Row) => r.updatedAt;
const ids = (rows: Row[]) => rows.map(r => r.id);

const rows: Row[] = [
  {id: 'old', updatedAt: 100},
  {id: 'newest', updatedAt: 900},
  {id: 'pinB', updatedAt: 200},
  {id: 'never'}, // stored before the stamp existed
  {id: 'mid', updatedAt: 500},
  {id: 'pinA', updatedAt: 1},
];

test('pins come first, in pin order, whatever their dates say', () => {
  const out = sortPinned(rows, ['pinA', 'pinB'], idOf, recency);
  expect(ids(out).slice(0, 2)).toEqual(['pinA', 'pinB']);
});

test('the rest sort newest-changed first', () => {
  const out = sortPinned(rows, ['pinA', 'pinB'], idOf, recency);
  expect(ids(out).slice(2)).toEqual(['newest', 'mid', 'old', 'never']);
});

test('a row with no stamp sorts last, not first', () => {
  const out = sortPinned(rows, [], idOf, recency);
  expect(ids(out)[ids(out).length - 1]).toBe('never');
});

test('with no recency function the old stable order is kept', () => {
  // The add-to-playlist sheet relies on this: it is a menu, not a library.
  const out = sortPinned(rows, ['pinB'], idOf);
  expect(ids(out)).toEqual(['pinB', 'old', 'newest', 'never', 'mid', 'pinA']);
});

test('an unknown pin id is ignored rather than ranking everything', () => {
  const out = sortPinned(rows, ['ghost', 'pinA'], idOf, recency);
  expect(ids(out)[0]).toBe('pinA');
});
