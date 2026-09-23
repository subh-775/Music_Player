/**
 * The app-wide font has to be a DEFAULT: first in the style array, so a
 * component's own style — and a fontFamily set on purpose — still wins.
 */
import {expect, test} from '@jest/globals';
import React from 'react';
import {FONT, withDefaultFont} from '../src/font';

const probe = () => {
  const seen: unknown[] = [];
  const comp = React.forwardRef((props: {style?: unknown}) => {
    seen.push(props.style);
    return null;
  }) as unknown as {render: (p: object, r: unknown) => unknown};
  return {comp, seen};
};

test('the family goes first, the caller keeps the last word', () => {
  const {comp, seen} = probe();
  expect(withDefaultFont(comp)).toBe(true);
  const own = {fontSize: 14, fontFamily: 'monospace'};
  comp.render({style: own}, null);
  expect(seen[0]).toEqual([{fontFamily: FONT}, own]);
});

test('a text with no style still gets the family', () => {
  const {comp, seen} = probe();
  withDefaultFont(comp);
  comp.render({}, null);
  expect(seen[0]).toEqual([{fontFamily: FONT}, undefined]);
});

test('something that is not a forwardRef is left alone', () => {
  expect(withDefaultFont(() => null)).toBe(false);
  expect(withDefaultFont(null)).toBe(false);
});
