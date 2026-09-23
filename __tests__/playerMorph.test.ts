/**
 * The mini-player transition: the big cover has to land EXACTLY on the small
 * one, and the panel's surface has to land exactly on the bar's rectangle.
 *
 * This is geometry, so it either lines up or it does not — and the failure is
 * never a crash. It is a cover that stops a little short of the slot and sits
 * there as a second artwork off to one side, which is what shipped twice.
 *
 * ## Why `p` is a proportion
 *
 * The state used to be PIXELS, with progress worked out as `pixels / span`. The
 * closed position was therefore a pixel figure snapshotted when the dismissal
 * began, while the span kept being re-measured — so anything that relaid the
 * mini player out afterwards (a song change, a Bluetooth device appearing in
 * the bar) moved the finish line out from under a value already parked.
 * Progress settled at 0.93 instead of 1 and the cover stopped short.
 *
 * Every case below drives the transition by proportion, and the last group
 * pins the property that makes that class of bug impossible: the end state
 * does not depend on the measurements at all.
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
  MINI_BAR_RADIUS,
  miniBarOpacity,
  morphTransform,
  spanBetween,
  surfaceRect,
} from '../src/playerSheet';

/** A 400x880 phone: a 376px cover in the player, a 54px one in the bar. */
const big = {x: 12, y: 100, size: 376};
const mini = {x: 15, y: 753, size: 54};

/** The panel fills the window; the bar floats above the tab strip. */
const sheet = {x: 0, y: 0, w: 400, h: 880};
const bar = {x: 10, y: 748, w: 380, h: 67};

/** Where the cover actually ends up on screen at a given point, panel travel
 *  included — the panel carries it down by `span * p`. */
function onScreen(p: number) {
  const m = morphTransform(mini, big, p);
  const size = big.size * m.scale;
  // Scale is about the centre, so the edge is centre - size/2.
  const cx = big.x + big.size / 2 + m.dx;
  const cy = big.y + big.size / 2 + m.span * Math.min(1, Math.max(0, p)) + m.dy;
  return {x: cx - size / 2, y: cy - size / 2, size};
}

// ── The cover ──────────────────────────────────────────────────────────────

test('fully open, the cover is untouched', () => {
  const r = onScreen(0);
  expect(r.x).toBeCloseTo(big.x, 5);
  expect(r.y).toBeCloseTo(big.y, 5);
  expect(r.size).toBeCloseTo(big.size, 5);
  expect(morphTransform(mini, big, 0).radius).toBeCloseTo(BIG_ART_RADIUS, 5);
});

test('fully closed, it lands exactly on the mini cover', () => {
  const r = onScreen(1);
  expect(r.x).toBeCloseTo(mini.x, 5);
  expect(r.y).toBeCloseTo(mini.y, 5);
  expect(r.size).toBeCloseTo(mini.size, 5);
});

test('the corner radius reads as 6px on screen when it gets there', () => {
  const m = morphTransform(mini, big, 1);
  // radius is in the view's own units and scales with it — what the eye sees
  // is radius * scale, and that is what has to equal the bar's own corner.
  expect(m.radius * m.scale).toBeCloseTo(MINI_ART_RADIUS, 5);
});

test('halfway through, it is halfway between the two squares', () => {
  const r = onScreen(0.5);
  expect(r.size).toBeCloseTo((big.size + mini.size) / 2, 5);
  expect(r.y).toBeGreaterThan(big.y);
  expect(r.y).toBeLessThan(mini.y);
});

test('a proportion past either end is clamped, not extrapolated', () => {
  // A spring can overshoot. Past 1 the cover must stay ON the slot rather than
  // carrying past it; past 0 it must stay at full size.
  const end = onScreen(1);
  const over = onScreen(1.4);
  expect(over.y).toBeCloseTo(end.y, 5);
  expect(over.size).toBeCloseTo(end.size, 5);
  const start = onScreen(0);
  const under = onScreen(-0.4);
  expect(under.y).toBeCloseTo(start.y, 5);
  expect(under.size).toBeCloseTo(start.size, 5);
});

test('an unmeasured cover morphs not at all', () => {
  // The first frame after mount, and mid-rotation. A zero size must never
  // become a divide-by-zero or a fling to coordinate 0.
  const m = morphTransform({x: 0, y: 0, size: 0}, big, 0.4);
  expect(m.scale).toBe(1);
  expect(m.dx).toBe(0);
  expect(Number.isFinite(m.p)).toBe(true);
});

// ── The end state does not depend on the measurements ──────────────────────
//
// This is the group that matters. The stray-artwork bug was the closed state
// being a measured pixel figure that the measurements could then move away
// from. As a proportion it cannot drift, and these say so in three ways.

test('closed lands on the slot whatever the covers are measured as', () => {
  // The same p, wildly different geometry: the cover must sit on the mini
  // square every time, because `dx` is a centre-to-centre difference and the
  // panel's travel IS the span. Neither depends on what was measured earlier.
  for (const m of [
    {x: 15, y: 753, size: 54},
    {x: 0, y: 600, size: 40},
    {x: 300, y: 1200, size: 80},
  ]) {
    const t = morphTransform(m, big, 1);
    const size = big.size * t.scale;
    const cx = big.x + big.size / 2 + t.dx;
    const cy = big.y + big.size / 2 + t.span + t.dy;
    expect(cx - size / 2).toBeCloseTo(m.x, 5);
    expect(cy - size / 2).toBeCloseTo(m.y, 5);
    expect(size).toBeCloseTo(m.size, 5);
  }
});

test('re-measuring mid-transition cannot leave it short of the end', () => {
  // The exact failure that shipped: the bar is relaid out (a Bluetooth device
  // appears) AFTER the dismissal started, so the span changes under it. With
  // pixels that stranded progress at 0.93; with a proportion, 1 is still 1.
  const before = morphTransform(mini, big, 1);
  const moved = {x: 15, y: 690, size: 54}; // bar 63px higher than measured
  const after = morphTransform(moved, big, 1);
  expect(before.p).toBe(1);
  expect(after.p).toBe(1);
  // …and it lands on the NEW position, which is where the bar now is.
  const size = big.size * after.scale;
  expect(big.x + big.size / 2 + after.dx - size / 2).toBeCloseTo(moved.x, 5);
});

test('a closed panel reads as closed even before anything is measured', () => {
  // The v1.2.4 regression: the unmeasured branch returned `p: 0`, reading "no
  // morph" as "fully open". The mini player fades in on `p`, so on a fresh
  // launch the bar computed zero opacity and vanished — taking the only
  // control that opens the panel with it.
  const none = {x: 0, y: 0, size: 0};
  expect(morphTransform(none, none, 1).p).toBe(1);
  expect(morphTransform(none, big, 1).p).toBe(1);
  expect(morphTransform(mini, none, 1).p).toBe(1);
});

// ── The mini player's own visibility ───────────────────────────────────────

test('the mini player is never invisible while the player is closed', () => {
  const none = {x: 0, y: 0, size: 0};
  // Nothing measured: the bar MUST be on screen whatever p says — it is the
  // only way to open the panel whose layout would measure it.
  expect(miniBarOpacity(none, 1)).toBe(1);
  expect(miniBarOpacity(none, 0)).toBe(1);
  expect(miniBarOpacity(big, 1)).toBe(1);
});

test('the mini player is hidden only while the full player is actually up', () => {
  expect(miniBarOpacity(big, 0)).toBe(0); // fully open
  expect(miniBarOpacity(big, 0.5)).toBe(0); // mid-transition
  // Still hidden while the panel's surface is larger than the bar — that
  // overlap is what used to read as two players on screen at once.
  expect(miniBarOpacity(big, 0.8)).toBe(0);
  // Fades in over the last 12%, once the surface has become bar-shaped.
  const tail = miniBarOpacity(big, 0.94);
  expect(tail).toBeGreaterThan(0);
  expect(tail).toBeLessThan(1);
});

// ── The surface: the panel's boundary becoming the bar's ───────────────────

test('fully open, the surface is the whole panel', () => {
  const r = surfaceRect(sheet, bar, 0, 0);
  expect(r.left).toBeCloseTo(0, 5);
  expect(r.top).toBeCloseTo(0, 5);
  expect(r.width).toBeCloseTo(sheet.w, 5);
  expect(r.height).toBeCloseTo(sheet.h, 5);
  expect(r.radius).toBeCloseTo(0, 5);
});

test('fully closed, the surface IS the bar, in window space', () => {
  const span = spanBetween(mini, big);
  const r = surfaceRect(sheet, bar, span, 1);
  // The panel is translated down by `span`, so add it back to get where this
  // rectangle actually lands on screen.
  expect(r.left + sheet.x).toBeCloseTo(bar.x, 5);
  expect(r.top + sheet.y + span).toBeCloseTo(bar.y, 5);
  expect(r.width).toBeCloseTo(bar.w, 5);
  expect(r.height).toBeCloseTo(bar.h, 5);
  expect(r.radius).toBeCloseTo(MINI_BAR_RADIUS, 5);
});

test('the surface tracks the panel rather than sliding away with it', () => {
  // Half way: whatever the panel's own offset is, the surface's window
  // position must be the half-way point between the two rectangles — not the
  // panel's position, which is what it would be without the -offsetY term.
  const span = spanBetween(mini, big);
  const r = surfaceRect(sheet, bar, span / 2, 0.5);
  expect(r.top + sheet.y + span / 2).toBeCloseTo((sheet.y + bar.y) / 2, 5);
  expect(r.height).toBeCloseTo((sheet.h + bar.h) / 2, 5);
});

test('an unmeasured surface fills the window, never zero', () => {
  // Falling back to `sheet.w` would be falling back to 0, and a zero-width
  // background is a player with no surface at all.
  for (const r of [
    surfaceRect({x: 0, y: 0, w: 0, h: 0}, bar, 0, 0),
    surfaceRect(sheet, {x: 0, y: 0, w: 0, h: 0}, 0, 0),
    surfaceRect({x: 0, y: 0, w: 0, h: 0}, {x: 0, y: 0, w: 0, h: 0}, 300, 0.5),
  ]) {
    expect(r.width).toBeGreaterThan(0);
    expect(r.height).toBeGreaterThan(0);
  }
});

test('the bar and the panel agree on their final corner', () => {
  // PlayerBar builds its own corner from MINI_BAR_RADIUS for exactly this
  // reason: the surface interpolates to that number, and a bar rounded
  // differently would finish the transition with a visible step.
  expect(MINI_BAR_RADIUS).toBe(11);
  // Concentric with the artwork inside it: PAD (5) + the cover's own radius.
  expect(MINI_BAR_RADIUS).toBe(5 + MINI_ART_RADIUS);
});
