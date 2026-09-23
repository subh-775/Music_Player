/**
 * The playback-speed maths.
 *
 * Float arithmetic on a slider is where a control like this goes quietly
 * wrong: 0.1 + 0.2 is not 0.3, so a readout can show "1.1500000000000001x", two
 * taps of + from 1.0 can land somewhere that is not 1.10, and a preset button
 * can fail to look selected because the stored value is a hair off the number
 * it is compared against. None of that throws; it just looks broken.
 *
 * The slider deliberately reaches further than the buttons — the presets are
 * 1.0 to 2.0, the range goes down to 0.25 — so the two ends are pinned
 * separately.
 */
import {expect, test} from '@jest/globals';
import {
  RATE_MAX,
  RATE_MIN,
  RATE_STEP,
  clampRate,
  fracOf,
  rateAt,
  rateLabel,
} from '../src/playbackRate';

test('the slider spans the whole range, ends included', () => {
  expect(rateAt(0)).toBeCloseTo(RATE_MIN, 6);
  expect(rateAt(1)).toBeCloseTo(RATE_MAX, 6);
});

test('the slider reaches below the slowest button', () => {
  // The point of the slider: 0.25x exists and no button offers it.
  expect(RATE_MIN).toBeLessThan(1);
  expect(rateAt(0)).toBeLessThan(1);
});

test('position and rate round-trip', () => {
  for (const r of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]) {
    expect(rateAt(fracOf(r))).toBeCloseTo(r, 6);
  }
});

test('every value off the slider is a clean step', () => {
  for (let i = 0; i <= 100; i++) {
    const r = rateAt(i / 100);
    // No 1.1500000000000001. The remainder against the step must vanish.
    const steps = r / RATE_STEP;
    expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9);
  }
});

test('the presets are all reachable exactly', () => {
  // A preset that cannot be produced by the slider would light up its button
  // and then refuse to match it back.
  for (const p of [1, 1.25, 1.5, 2]) {
    expect(clampRate(p)).toBeCloseTo(p, 6);
    expect(rateAt(fracOf(p))).toBeCloseTo(p, 6);
  }
});

test('stepping with + and - lands on round numbers', () => {
  let r = 1;
  for (let i = 0; i < 4; i++) {
    r = clampRate(r + RATE_STEP);
  }
  expect(r).toBeCloseTo(1.2, 6);
  for (let i = 0; i < 4; i++) {
    r = clampRate(r - RATE_STEP);
  }
  expect(r).toBeCloseTo(1, 6);
});

test('the ends cannot be stepped past', () => {
  expect(clampRate(RATE_MAX + 1)).toBe(RATE_MAX);
  expect(clampRate(RATE_MIN - 1)).toBe(RATE_MIN);
  expect(clampRate(0)).toBe(RATE_MIN);
  expect(clampRate(-3)).toBe(RATE_MIN);
});

test('a position outside 0..1 is clamped, not extrapolated', () => {
  expect(rateAt(-0.5)).toBeCloseTo(RATE_MIN, 6);
  expect(rateAt(9)).toBeCloseTo(RATE_MAX, 6);
  expect(fracOf(99)).toBe(1);
  expect(fracOf(-99)).toBe(0);
});

test('the label reads the way the buttons do', () => {
  expect(rateLabel(1)).toBe('1.0x');
  expect(rateLabel(1.25)).toBe('1.25x');
  expect(rateLabel(1.5)).toBe('1.5x');
  expect(rateLabel(2)).toBe('2.0x');
  expect(rateLabel(0.25)).toBe('0.25x');
  // …and never leaks a float artefact.
  expect(rateLabel(rateAt(0.37))).toMatch(/^\d\.\d{1,2}x$/);
});
