/**
 * One source of truth for colour, spacing and type. Screens read from here so
 * the app stays visually consistent as it grows — no per-file magic values.
 */
export const C = {
  bg: '#0b0c10',
  surface: '#15171d',
  surfaceHi: '#1c1f27',
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

export const T = {
  screenTitle: {fontSize: 26, fontWeight: '800' as const, letterSpacing: -0.5},
  rowTitle: {fontSize: 17, fontWeight: '700' as const, letterSpacing: -0.2},
  body: {fontSize: 14.5, fontWeight: '600' as const},
  sub: {fontSize: 12.5, fontWeight: '500' as const},
};
