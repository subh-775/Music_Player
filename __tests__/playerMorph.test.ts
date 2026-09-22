/**
 * The mini-player morph: the big cover has to land EXACTLY on the small one.
 *
 * This is geometry, so it either lines up or it does not — and the failure is
 * not a crash, it is a cover that jumps a few pixels at the moment the sheet
 * unmounts and the real mini player takes over. That reads as a glitch and it
 * is invisible in review, because every term in it looks plausible on its own.
 *
 * The invariant worth pinning is one sentence: at the end of the travel, the
 * transformed big square occupies the same rect as the mini square. Everything
 * else here is a boundary — nothing measured yet, a drag past the end, a drag
 * back the other way.
 */
import {expect, jest, test} from '@jest/globals';

// playerSheet reads Dimensions at module load and holds Reanimated shared
// values. Neither matters to the arithmetic; these only make the import work.
jest.mock('react-native', () => ({
  Dimensions: {get: () => ({width: 400, height: 880})},
}));
jest.mock('react-native-reanimated', () => ({
  Easing: {out: () => null, cubic: null},
  makeMutable: (v: unknown) => ({value: v}),
  runOnJS: (f: unknown) => f,
  withTiming: (v: unknown) => v,
}));

// NB: this import must stay below the mocks above — jest hoists jest.mock().
import {
  BIG_ART_RADIUS,
  MINI_ART_RADIUS,
  morphTransform,
  spanBetween,
} from '../src/playerSheet';

/** A 400x880 phone: a 376px cover in the player, a 54px one in the bar. */
const big = {x: 12, y: 100, size: 376};
const mini = {x: 15, y: 753, size: 54};

/** Where the cover actually ends up on screen, sheet travel included. */
function onScreen(sheetY: number) {
  const m = morphTransform(mini, big, sheetY);
  const size = big.size * m.scale;
  // The sheet carries the artwork down by sheetY; the morph adds its own
  // offsets on top. Scale is about the centre, so the edge is centre - size/2.
  const cx = big.x + big.size / 2 + m.dx;
  const cy = big.y + big.size / 2 + sheetY + m.dy;
  return {x: cx - size / 2, y: cy - size / 2, size};
}

test('fully open, the cover is untouched', () => {
  const r = onScreen(0);
  expect(r.x).toBeCloseTo(big.x, 5);
  expect(r.y).toBeCloseTo(big.y, 5);
  expect(r.size).toBeCloseTo(big.size, 5);
  expect(morphTransform(mini, big, 0).radius).toBeCloseTo(BIG_ART_RADIUS, 5);
});

test('at the end of the travel it lands exactly on the mini cover', () => {
  const r = onScreen(spanBetween(mini, big));
  expect(r.x).toBeCloseTo(mini.x, 5);
  expect(r.y).toBeCloseTo(mini.y, 5);
  expect(r.size).toBeCloseTo(mini.size, 5);
});

test('the corner radius reads as 6px on screen when it gets there', () => {
  const m = morphTransform(mini, big, spanBetween(mini, big));
  // radius is in the view's own units and scales with it — what the eye sees
  // is radius * scale, and that is what has to equal the bar's own corner.
  expect(m.radius * m.scale).toBeCloseTo(MINI_ART_RADIUS, 5);
});

test('dragging past the end parks the cover instead of dropping it further', () => {
  const span = spanBetween(mini, big);
  const parked = onScreen(span);
  const further = onScreen(span + 400);
  expect(further.y).toBeCloseTo(parked.y, 5);
  expect(further.size).toBeCloseTo(parked.size, 5);
});

test('halfway through, it is halfway between the two squares', () => {
  const r = onScreen(spanBetween(mini, big) / 2);
  expect(r.size).toBeCloseTo((big.size + mini.size) / 2, 5);
  expect(r.y).toBeGreaterThan(big.y);
  expect(r.y).toBeLessThan(mini.y);
});

test('an unmeasured cover morphs not at all', () => {
  // The first frame after mount, and mid-rotation. A zero size must never
  // become a divide-by-zero or a fling to coordinate 0.
  const m = morphTransform({x: 0, y: 0, size: 0}, big, 300);
  expect(m.scale).toBe(1);
  expect(m.dx).toBe(0);
  expect(Number.isFinite(m.p)).toBe(true);
});

test('a negative sheet position (overscroll past open) clamps to open', () => {
  const m = morphTransform(mini, big, -80);
  expect(m.p).toBe(0);
  expect(m.scale).toBe(1);
});
