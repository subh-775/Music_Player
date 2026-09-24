/**
 * "Listen up Buddy" is coloured letter by letter, freshly per launch — and it
 * must never put the same colour on two neighbouring letters, or the line
 * reads as blocks of colour instead of a run of it.
 */
import {expect, jest, test} from '@jest/globals';

jest.mock('react-native', () => ({
  Animated: {Value: class {}},
  Easing: {},
  StyleSheet: {create: (s: unknown) => s},
  Text: 'Text',
}));

// NB: below the mock — jest hoists jest.mock().
import {letterColors} from '../src/components/Greeting';

const PALETTE = ['#a', '#b', '#c', '#d', '#e', '#f', '#g', '#h', '#i'];

test('every letter is coloured, spaces are not, neighbours always differ', () => {
  for (let seed = 1; seed <= 200; seed++) {
    let x = seed;
    const rand = () => ((x = (x * 16807) % 2147483647) - 1) / 2147483646;
    const colors = letterColors('Listen up Buddy', PALETTE, rand);
    const letters = colors.filter((c, i) => 'Listen up Buddy'[i] !== ' ');
    expect(letters.every(c => PALETTE.includes(c))).toBe(true);
    expect(colors[6]).toBe('');
    expect(colors[9]).toBe('');
    for (let i = 1; i < letters.length; i++) {
      expect(letters[i]).not.toBe(letters[i - 1]);
    }
  }
});

test('different launches get different arrangements', () => {
  const a = letterColors('Listen up Buddy', PALETTE, () => 0.1).join();
  const b = letterColors('Listen up Buddy', PALETTE, () => 0.9).join();
  expect(a).not.toBe(b);
});
