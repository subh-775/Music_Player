/**
 * "Listen" and "Buddy" each wear one colour that keeps changing. A change must
 * always be visible (never the colour the word already has) and the two words
 * must never end up wearing the same colour.
 */
import {expect, jest, test} from '@jest/globals';

jest.mock('react-native', () => ({
  Animated: {Value: class {}, Text: 'Text', View: 'View'},
  Easing: {},
  StyleSheet: {create: (s: unknown) => s},
  View: 'View',
}));

// NB: below the mock — jest hoists jest.mock().
import {WORD_PALETTE, nextColor} from '../src/components/Greeting';

test('a new colour is never the current one, nor the other word’s', () => {
  for (const current of WORD_PALETTE) {
    for (const other of WORD_PALETTE) {
      for (const r of [0, 0.25, 0.5, 0.75, 0.9999]) {
        const c = nextColor(current, other, WORD_PALETTE, () => r);
        expect(WORD_PALETTE).toContain(c);
        expect(c).not.toBe(current);
        expect(c).not.toBe(other);
      }
    }
  }
});

test('the first colour of a launch can be any in the palette', () => {
  const seen = new Set(
    [0, 0.12, 0.23, 0.34, 0.45, 0.56, 0.67, 0.78, 0.99].map(r =>
      nextColor(null, null, WORD_PALETTE, () => r),
    ),
  );
  expect(seen.size).toBe(WORD_PALETTE.length);
});
