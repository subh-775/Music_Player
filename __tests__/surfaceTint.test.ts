/**
 * The mini player takes its colour from the album cover, and it has to stay a
 * SURFACE while it does.
 *
 * The old helper only scaled the channels toward black, which lowers luminance
 * and leaves saturation exactly where it was. A neon cover therefore produced a
 * neon bar: #00FF3C halved is #007A1E, darker and every bit as saturated, and
 * against a true-black UI a fully saturated hue reads far louder than its
 * brightness suggests. Under a bright green album the bar became a green slab
 * that matched no other part of the app.
 *
 * Colour maths is the kind of thing that goes wrong quietly — nothing throws,
 * it just looks wrong on someone else's album — so the properties that matter
 * are pinned here rather than checked by eye against one cover.
 */
import {expect, jest, test} from '@jest/globals';

jest.mock('react-native', () => ({NativeModules: {}}));

// NB: this import must stay below the mock above — jest hoists jest.mock().
import {surfaceTint} from '../src/artworkColor';

const NEON = '#00ff3c';
const GREY = '#8a8a8a';

function hsl(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  /* eslint-disable no-bitwise */
  const r = ((n >> 16) & 0xff) / 255;
  const g = ((n >> 8) & 0xff) / 255;
  const b = (n & 0xff) / 255;
  /* eslint-enable no-bitwise */
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : l > 0.5 ? d / (2 - max - min) : d / (max + min);
  return {s, l};
}

test('always returns a parseable #rrggbb', () => {
  for (const c of [NEON, GREY, '#ffffff', '#000000', '#ff2d55', '#3b5bdb']) {
    expect(surfaceTint(c, 0.145)).toMatch(/^#[0-9a-f]{6}$/);
  }
});

test('lands on the lightness it was asked for, whatever went in', () => {
  for (const c of [NEON, GREY, '#ffffff', '#000000', '#ffd400']) {
    expect(hsl(surfaceTint(c, 0.145)).l).toBeCloseTo(0.145, 2);
    expect(hsl(surfaceTint(c, 0.075)).l).toBeCloseTo(0.075, 2);
  }
});

test('a neon cover comes back muted, not merely darkened', () => {
  // The whole bug in one assertion. The old helper preserved saturation at
  // 1.0 here; anything near that is a coloured slab rather than a surface.
  //
  // The bound is a little above the 0.34 ceiling on purpose: at a lightness of
  // 0.145 the channels land around 24-50/255, and rounding to 8 bits moves the
  // measured saturation by a percent or two. Pinning the exact figure would be
  // pinning the rounding, not the rule.
  expect(hsl(NEON).s).toBeGreaterThan(0.9);
  expect(hsl(surfaceTint(NEON, 0.145)).s).toBeLessThan(0.4);
});

test('saturation is a ceiling, not a scale', () => {
  // A nearly-grey cover must not be pushed UP to the cap — it keeps its own
  // restraint, so a muted album does not come back more colourful than it is.
  expect(hsl(surfaceTint(GREY, 0.145)).s).toBeLessThan(0.05);
});

test('greys stay neutral rather than picking up a hue', () => {
  const out = surfaceTint(GREY, 0.145);
  const n = parseInt(out.slice(1), 16);
  /* eslint-disable no-bitwise */
  const [r, g, b] = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  /* eslint-enable no-bitwise */
  expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(2);
});

test('the hue survives — the bar still belongs to the song', () => {
  // Muting is not greying out. A green cover must still read as green.
  const n = parseInt(surfaceTint(NEON, 0.145).slice(1), 16);
  /* eslint-disable no-bitwise */
  const [r, g, b] = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  /* eslint-enable no-bitwise */
  expect(g).toBeGreaterThan(r);
  expect(g).toBeGreaterThan(b);
});

test('every tint is dark enough to carry white text', () => {
  // The bar's label is C.text at full opacity. Relative luminance well under
  // the point where white stops being legible on it.
  for (const c of ['#ffffff', '#ffd400', NEON, '#ff2d55']) {
    const n = parseInt(surfaceTint(c, 0.145).slice(1), 16);
    /* eslint-disable no-bitwise */
    const [r, g, b] = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
    /* eslint-enable no-bitwise */
    expect((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255).toBeLessThan(0.25);
  }
});

test('nonsense input is black, not NaN', () => {
  expect(surfaceTint('not-a-colour', 0.145)).toBe('#000000');
});
