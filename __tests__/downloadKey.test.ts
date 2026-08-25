/**
 * The identity a downloaded file is matched by.
 *
 * This bug was invisible in every way that matters: nothing threw, nothing
 * logged, the download genuinely completed and the file was genuinely on disk.
 * The app simply computed one string when it saved and a different string when
 * it looked, so the tick never appeared, the remembered cover never matched,
 * and the same song could be downloaded forever.
 *
 * The whole failure is one asymmetry — a catalog track carries an ISRC and a
 * file on disk cannot — so that is what these pin.
 */
import {expect, test} from '@jest/globals';
import {getDownloadKey, getTrackId} from '../src/tracks';
import type {Track} from '../src/backend';

/** What a search/enrichment result looks like: ISRC and all. */
const catalog: Track = {
  title: 'Ordinary',
  artist: 'Alex Warren',
  isrc: 'USUG12500123',
  artwork_url: 'https://example.invalid/cover.jpg',
};

/** The same song as scan_downloads returns it: filename + tags, no ISRC. */
const scanned: Track = {
  title: 'Ordinary',
  artist: 'Alex Warren',
  file_path: '/storage/emulated/0/Music/Ordinary - Alex Warren.mp3',
};

test('the catalog track and its own downloaded file share a download key', () => {
  expect(getDownloadKey(scanned)).toBe(getDownloadKey(catalog));
});

test('getTrackId still separates them — which is exactly why it cannot be used here', () => {
  // Not a bug in getTrackId: the ISRC is what tells two different recordings of
  // the same name apart, and it must keep doing that everywhere else.
  expect(getTrackId(scanned)).not.toBe(getTrackId(catalog));
});

test('two genuinely different songs still get different keys', () => {
  expect(getDownloadKey({title: 'Ordinary', artist: 'Alex Warren'})).not.toBe(
    getDownloadKey({title: 'Ordinary', artist: 'Someone Else'}),
  );
});

test('case and surrounding whitespace do not change the key', () => {
  expect(getDownloadKey({title: '  ORDINARY ', artist: 'Alex WARREN'})).toBe(
    getDownloadKey(catalog),
  );
});

test('a missing track is a stable empty key, not a crash', () => {
  expect(getDownloadKey(null)).toBe(getDownloadKey(undefined));
});

test('an old stored id migrates to the new key by dropping its last segment', () => {
  // The migration `downloadedIds` performs on read. Written out here because if
  // it ever stops holding, every existing download silently reads as absent
  // until the next folder scan.
  const stored = getTrackId(catalog); // "ordinary|alex warren|USUG12500123"
  expect(stored.split('|').slice(0, 2).join('|')).toBe(getDownloadKey(catalog));

  // …and it is a no-op on a key already in the new form.
  const current = getDownloadKey(catalog);
  expect(current.split('|').slice(0, 2).join('|')).toBe(current);
});
