/**
 * Playback speed: the range, the snapping, and how a slider position maps to it.
 *
 * Its own module rather than living inside SpeedSheet, because none of it is
 * about drawing anything — the player's button reads it to label itself, the
 * sheet reads it to place a thumb, and the test reads it without dragging a
 * gesture handler and a native module into a maths check.
 *
 * ## Why the slider goes further than the buttons
 *
 * The presets are the speeds people arrive wanting: normal, a bit quicker, half
 * again, double. The slider reaches down to a quarter speed, which no button
 * offers, because nobody arrives wanting exactly 0.4x — they arrive wanting
 * "slower than this", and that is a thing you find by dragging rather than by
 * picking off a list.
 *
 * Everything snaps to RATE_STEP. Float arithmetic on a slider is where a
 * control like this goes quietly wrong: 0.1 + 0.2 is not 0.3, so without
 * snapping the readout shows "1.1500000000000001x", two taps of + from 1.0 land
 * somewhere that is not 1.10, and a preset button fails to look selected
 * because the stored value is a hair off the number it is compared against.
 */

/** The range the SLIDER covers. The presets are a subset — see above. */
export const RATE_MIN = 0.25;
export const RATE_MAX = 2;
export const RATE_STEP = 0.05;

/** The speeds on buttons, in the order they are shown. */
export const RATE_PRESETS = [1, 1.25, 1.5, 2];

/** Half a step — the tolerance for "is this the same speed". Comparing floats
 *  with === is the other way this control goes wrong. */
export const RATE_EPSILON = RATE_STEP / 2;

/** Snap and clamp a rate arriving from anywhere: a preset, a +/- tap, or a
 *  value stored by a build that used a different range. */
export function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) {
    return 1;
  }
  const snapped = Math.round(rate / RATE_STEP) * RATE_STEP;
  return Math.min(RATE_MAX, Math.max(RATE_MIN, snapped));
}

/** Slider position (0..1) -> a real, snapped rate. */
export function rateAt(f: number): number {
  'worklet';
  const raw = RATE_MIN + (RATE_MAX - RATE_MIN) * Math.min(1, Math.max(0, f));
  return Math.round(raw / RATE_STEP) * RATE_STEP;
}

/** …and back, for placing the thumb when the sheet opens. */
export function fracOf(rate: number): number {
  'worklet';
  return Math.min(1, Math.max(0, (rate - RATE_MIN) / (RATE_MAX - RATE_MIN)));
}

/** True when this rate is the one on that button. */
export function isRate(rate: number, target: number): boolean {
  return Math.abs(rate - target) < RATE_EPSILON;
}

/**
 * "1.0x", "1.25x", "0.75x".
 *
 * A trailing zero is dropped but the first decimal is always kept, so the
 * presets read as the row in every other player does — 1.0 and 2.0, not 1 and
 * 2 — and the number does not change width as the slider crosses a round value.
 */
export function rateLabel(rate: number): string {
  const s = rate.toFixed(2);
  return `${s.endsWith('0') ? s.slice(0, -1) : s}x`;
}
