/**
 * "Listen up Buddy" takes a new colour pair on each arrival at Home. The new
 * pair must always be a real change (never the pair just shown), and every
 * pair must be available to a launch.
 */
import {expect, jest, test} from '@jest/globals';

jest.mock('react-native', () => ({
  Animated: {Value: class {}, View: 'View'},
  Easing: {},
  StyleSheet: {create: (s: unknown) => s},
  Text: 'Text',
  View: 'View',
}));

// NB: below the mock — jest hoists jest.mock().
import {PAIRS, nextPair} from '../src/components/Greeting';

const RANDS = [0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 0.9999];

test('the next pair is never the current one, and always in range', () => {
  for (let current = 0; current < PAIRS.length; current++) {
    for (const r of RANDS) {
      const next = nextPair(current, PAIRS.length, () => r);
      expect(next).not.toBe(current);
      expect(next).toBeGreaterThanOrEqual(0);
      expect(next).toBeLessThan(PAIRS.length);
    }
  }
});

test('a launch can start on any pair', () => {
  const seen = new Set(
    PAIRS.map((_, i) => nextPair(-1, PAIRS.length, () => i / PAIRS.length)),
  );
  expect(seen.size).toBe(PAIRS.length);
});

test('every pair is two different colours', () => {
  for (const [a, b] of PAIRS) {
    expect(a).not.toBe(b);
  }
});
