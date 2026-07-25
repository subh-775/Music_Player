/**
 * One source of truth for colour, spacing and type. Screens read from here so
 * the app stays visually consistent as it grows — no per-file magic values.
 */
export const C = {
  bg: '#000000',   // true black: AMOLED pixels off, not near-black
  surface: '#121212',
  surfaceHi: '#1c1c1c',
  text: '#f4f5f7',
  sub: '#9096a2',
  faint: '#5c626e',
  /** Brand green. `accent` is the interactive/active colour; `accentBright` is
   *  for a filled glyph that needs to read against a dark surface. */
  accent: '#1db954',
  accentBright: '#1ed760',
  danger: '#ff6b6b',
  border: 'rgba(255,255,255,0.08)',
};

export const S = {
  gutter: 18,
  gap: 12,
  radius: 10,
};

/**
 * Type scale. Sizes are the base values put through [fs], which lifts
 * everything a couple of percent — enough to read easier on a phone without
 * reflowing any layout.
 */
export const TYPE_SCALE = 1.02;

/** Scale a font size by TYPE_SCALE, rounded to the nearest half point. */
export const fs = (size: number): number =>
  Math.round(size * TYPE_SCALE * 2) / 2;

// lineHeight is explicit on the title styles: Android crops the descender of a
// big bold letter (the 'g' in "Good morning" / "Settings") when a line is left
// to its default height, so every title gets ~1.3× breathing room.
export const T = {
  screenTitle: {
    fontSize: fs(26),
    lineHeight: fs(34),
    fontWeight: '800' as const,
    letterSpacing: -0.5,
  },
  rowTitle: {
    fontSize: fs(17),
    lineHeight: fs(23),
    fontWeight: '700' as const,
    letterSpacing: -0.2,
  },
  body: {fontSize: fs(14.5), fontWeight: '600' as const},
  sub: {fontSize: fs(12.5), fontWeight: '500' as const},
};
