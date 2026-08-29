/**
 * The update prompt rendered `info.notes` raw, and CI writes release bodies
 * that are literally "Full Changelog: https://github.com/...". So the popup's
 * one piece of prose was a URL nobody can tap.
 */
import {expect, test} from '@jest/globals';
import {formatSize, readableNotes} from '../src/updateNotes';

test('a body that is only a compare link comes back empty', () => {
  expect(
    readableNotes(
      'Full Changelog: https://github.com/subh-775/Music_Player/compare/v1.0.15...v1.0.16',
    ),
  ).toBe('');
});

test('real notes survive, and the generated tail is stripped', () => {
  const body = [
    "What's Changed",
    '* Queue sheet scrolls with your finger',
    '- Crossfade no longer dips between tracks',
    '',
    'Full Changelog: https://github.com/x/y/compare/a...b',
  ].join('\n');
  expect(readableNotes(body)).toBe(
    '• Queue sheet scrolls with your finger\n• Crossfade no longer dips between tracks',
  );
});

test('a hand-written body is left alone', () => {
  expect(readableNotes('Fixes the sleep timer.')).toBe('Fixes the sleep timer.');
});

test('an empty or missing body is empty, not "undefined"', () => {
  expect(readableNotes('')).toBe('');
  expect(readableNotes(undefined as unknown as string)).toBe('');
});

test('size reads as a download, and an unknown size renders nothing', () => {
  expect(formatSize(49_876_543)).toBe('47.6 MB');
  expect(formatSize(0)).toBe('');
  expect(formatSize(undefined)).toBe('');
});
